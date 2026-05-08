-- ============================================================================
-- supabase/migrations/20260508_feature_flags.sql
-- Lexi-Lens — v5.1 runtime feature flags (model provider switch)
-- ============================================================================
--
-- Creates a key/value flag table the Edge Functions read at request time
-- (with a 60-second in-process cache) so configuration values like
-- "which model provider should evaluate use" can be changed at runtime
-- without redeploying any Edge Function.
--
-- ─── Why this table exists ─────────────────────────────────────────────────
--
-- See supabase/functions/_shared/models/index.ts for the consumer.
--
-- The model-provider abstraction supports a chain of selection sources:
--
--     feature_flags row  →  env var  →  hardcoded default
--
-- The DB row is the operator-visible knob. Solo-dev expectation: flip via
-- the Supabase Dashboard → SQL Editor when you want to swap providers.
-- The env-var path remains as a backstop for the case where Supabase itself
-- is having a bad day and you still need to force a specific provider via
-- a redeploy.
--
-- ─── Security model ────────────────────────────────────────────────────────
--
-- This table contains operational configuration, not user data. RLS is
-- ENABLED with NO POLICIES — that means:
--   • Service role (Edge Functions): full access (RLS bypass).
--   • Authenticated app users: zero access (no SELECT, no UPDATE).
--   • Anonymous / public: zero access.
--   • Solo dev via SQL Editor: full access (uses service role).
--
-- The key/value rows here are NOT sensitive (they're just words like
-- "anthropic" / "gemini") but locking them down by default keeps internal
-- config out of accidental client-side queries.
--
-- ─── Apply order ───────────────────────────────────────────────────────────
--
-- Apply this BEFORE deploying the v5.1 evaluate Edge Function. The new
-- factory reads from this table on cold start; if the table is missing it
-- logs an error and silently falls back to the env-var chain, so the
-- reverse order is recoverable but produces noisy logs.
-- ============================================================================

-- ─── 1. Table ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.feature_flags (
    key         text                     PRIMARY KEY,
    value       text                     NOT NULL,
    description text,
    updated_at  timestamp with time zone NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.feature_flags        IS
  'Runtime configuration flags read by Edge Functions. '
  'Read by supabase/functions/_shared/models/index.ts (60s in-process cache). '
  'Edits via SQL Editor; flip propagates within ~60 seconds to all warm Edge Function containers.';

COMMENT ON COLUMN public.feature_flags.key         IS
  'Lookup key. Convention: "<scope>_<setting>" e.g. "evaluate_model_provider". Use snake_case.';
COMMENT ON COLUMN public.feature_flags.value       IS
  'Flag value as text. Adapter validates the value before applying — invalid values fall back to env var.';
COMMENT ON COLUMN public.feature_flags.description IS
  'Free-form note for the next person (or future you) reading the table. Document accepted values here.';
COMMENT ON COLUMN public.feature_flags.updated_at  IS
  'Audit trail: when this flag was last changed. Set via the trigger below; never manually.';

-- ─── 2. updated_at trigger ───────────────────────────────────────────────────
--
-- Refreshes updated_at on every UPDATE so the value reflects the actual
-- last-modified time. (DEFAULT now() handles initial INSERT only.)

CREATE OR REPLACE FUNCTION public.feature_flags_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feature_flags_touch_updated_at ON public.feature_flags;

CREATE TRIGGER feature_flags_touch_updated_at
  BEFORE UPDATE ON public.feature_flags
  FOR EACH ROW
  EXECUTE FUNCTION public.feature_flags_touch_updated_at();

-- ─── 3. Row Level Security ───────────────────────────────────────────────────
--
-- Enable RLS, define no policies. Service role bypasses RLS automatically;
-- authenticated and anon roles get zero access.

ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;

-- ─── 4. Initial flag rows ────────────────────────────────────────────────────
--
-- ON CONFLICT DO NOTHING so re-running the migration is idempotent. To
-- change a value after launch, use UPDATE — never DELETE-then-INSERT.

INSERT INTO public.feature_flags (key, value, description) VALUES
  ('evaluate_model_provider',
   'anthropic',
   'Provider for the evaluate Edge Function. Valid: "anthropic" | "gemini". '
   'Anthropic = Haiku 4.5 (~$0.0040/scan). Gemini = Gemma 4 26B via AI Studio (~$0.0004/scan).')
ON CONFLICT (key) DO NOTHING;

-- ─── 5. Sanity-check log ─────────────────────────────────────────────────────
--
-- Visible in the migration output. Non-failing — purely informational.

DO $$
DECLARE
  flag_count int;
BEGIN
  SELECT count(*) INTO flag_count FROM public.feature_flags;
  RAISE NOTICE 'feature_flags table ready. Rows: %', flag_count;
END $$;
