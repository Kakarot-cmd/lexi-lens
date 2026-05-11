-- ============================================================================
-- 20260512_routing_v6_3.sql
-- Lexi-Lens — v6.3 routing cleanup (Session E).
--
-- Completes the v6.0 model-swap rename that 20260510_mistral_swap_and_cache_v6
-- left in a half-broken state. Five coordinated changes:
--
--   1. scan_attempts.is_primary_call boolean — set by evaluate at write time
--      based on the routing decision. Replaces the broken hardcoded
--      model_id='claude-haiku-4-5' filter as the source-of-truth for
--      "how many primary-model calls did this parent make today".
--
--   2. get_evaluate_context RPC return field renamed:
--      haiku_calls_today → primary_calls_today (counter now reads is_primary_call).
--
--   3. Two new feature_flag rows for configurable routing:
--      - evaluate_primary_provider  (default 'mistral')
--      - evaluate_fallback_provider (default 'gemini')
--      evaluate_model_provider retained as kill-switch override.
--
--   4. is_paid_tier(t text) SQL helper for application-layer "is this parent
--      paid?" checks. Returns true for tier1|tier2|family.
--
--   5. Backfill: existing scan_attempts rows get is_primary_call populated
--      heuristically from model_id (Mistral/Haiku → true, Gemini → false,
--      NULL/cache-hit/rate-limited → NULL).
--
-- ─── Apply order vs evaluate Edge Function deploy ─────────────────────────────
--
-- This migration is BACKWARD-INCOMPATIBLE with the v6.2.x evaluate code:
-- the RPC return field haiku_calls_today is gone. The old evaluate code will
-- destructure undefined into ctx.haiku_calls_today and the primary-budget
-- check will degenerate to "0 >= primary_cap" which silently always falls
-- through to primary-budget branch (no fallback). Same failure mode as before
-- this migration, so no new regression in the brief migrate-before-deploy gap.
--
-- Correct deploy order:
--   1. Apply this migration (psql / Supabase Dashboard SQL Editor).
--   2. Deploy the new evaluate Edge Function (supabase functions deploy evaluate).
--   3. Set feature flags (kill-switch off, primary='mistral', fallback='gemini').
--   4. Migrate test parent from subscription_tier='paid' to 'tier1'.
-- ============================================================================

BEGIN;

-- ─── 1. is_primary_call column on scan_attempts ────────────────────────────

ALTER TABLE public.scan_attempts
  ADD COLUMN IF NOT EXISTS is_primary_call boolean;

COMMENT ON COLUMN public.scan_attempts.is_primary_call IS
  'v6.3. True if this scan was routed to the configured primary model '
  '(evaluate_primary_provider). False if routed to fallback. NULL when '
  'cache_hit=true or rate_limited=true (no routing decision was made). '
  'Source of truth for get_evaluate_context.primary_calls_today, replacing '
  'the hardcoded model_id filter from v6.0.';

-- ─── 2. Backfill is_primary_call from existing model_id values ─────────────
--
-- Heuristic: any row with a real model_id was routed by the v6.x code. Based
-- on the provider hierarchy at the time (Mistral primary or Haiku-kill-switch,
-- Gemini fallback), Mistral/Haiku rows get true, Gemini rows get false. Rows
-- without a model_id (cache hits, rate limits) stay NULL.

UPDATE public.scan_attempts
SET is_primary_call = CASE
  WHEN model_id IS NULL                              THEN NULL
  WHEN model_id LIKE 'claude-haiku-%'                THEN true
  WHEN model_id LIKE 'mistral-%'                     THEN true
  WHEN model_id LIKE 'gemini-%' OR model_id LIKE 'gemma-%' THEN false
  ELSE NULL
END
WHERE is_primary_call IS NULL;

-- ─── 3. Replace haiku index with primary-call index ────────────────────────

DROP INDEX IF EXISTS public.scan_attempts_haiku_count_idx;

CREATE INDEX IF NOT EXISTS scan_attempts_primary_count_idx
  ON public.scan_attempts (created_at, is_primary_call)
  WHERE rate_limited = false AND cache_hit = false;

-- ─── 4. RPC rewrite — primary_calls_today (replaces haiku_calls_today) ─────

DROP FUNCTION IF EXISTS public.get_evaluate_context(uuid, uuid);

CREATE OR REPLACE FUNCTION public.get_evaluate_context(
  p_child_id uuid,
  p_quest_id uuid
)
RETURNS TABLE(
  scans_today         integer,
  primary_calls_today integer,   -- v6.3: renamed from haiku_calls_today
  subscription_tier   text,
  quest_min_tier      text,
  quest_exists        boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH parent_lookup AS (
    SELECT cp.parent_id
    FROM public.child_profiles cp
    WHERE cp.id = p_child_id
    LIMIT 1
  ),
  sibling_children AS (
    SELECT cp2.id
    FROM parent_lookup pl
    JOIN public.child_profiles cp2 ON cp2.parent_id = pl.parent_id
  ),
  todays_scans AS (
    SELECT
      count(*) FILTER (
        WHERE rate_limited = false AND cache_hit = false
      )::integer AS scans_count,
      count(*) FILTER (
        WHERE rate_limited     = false
          AND cache_hit        = false
          AND is_primary_call  = true   -- v6.3: dynamic via boolean, no hardcoded model_id
      )::integer AS primary_count
    FROM public.scan_attempts sa
    WHERE sa.child_id    IN (SELECT id FROM sibling_children)
      AND sa.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
      AND sa.created_at <  date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day'
  )
  SELECT
    COALESCE((SELECT scans_count   FROM todays_scans), 0)  AS scans_today,
    COALESCE((SELECT primary_count FROM todays_scans), 0)  AS primary_calls_today,
    COALESCE((
      SELECT p.subscription_tier
      FROM parent_lookup pl
      JOIN public.parents p ON p.id = pl.parent_id
      LIMIT 1
    ), 'free')                                              AS subscription_tier,
    COALESCE((
      SELECT q.min_subscription_tier
      FROM public.quests q
      WHERE q.id = p_quest_id AND q.is_active = true
      LIMIT 1
    ), 'free')                                              AS quest_min_tier,
    EXISTS(
      SELECT 1 FROM public.quests q
      WHERE q.id = p_quest_id AND q.is_active = true
    )                                                       AS quest_exists;
$$;

COMMENT ON FUNCTION public.get_evaluate_context(uuid, uuid) IS
  'v6.3. Single round-trip context fetch for the evaluate Edge Function. '
  'Returns parent-level scan and primary-model counts for today (cache hits '
  'and rate-limited rows excluded), the parent''s subscription tier, the '
  'requested quest''s min_subscription_tier, and whether the quest exists. '
  'primary_calls_today renamed from v5 haiku_calls_today and now counts '
  'scan_attempts.is_primary_call=true rather than hardcoded model_id. '
  'Service role only; SECURITY DEFINER runs as table owner so RLS is bypassed.';

REVOKE ALL ON FUNCTION public.get_evaluate_context(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_evaluate_context(uuid, uuid) TO service_role;

-- ─── 5. Feature flags for configurable primary + fallback ──────────────────

INSERT INTO public.feature_flags (key, value, description) VALUES
  ('evaluate_primary_provider',  'mistral',
   'v6.3. Provider used for the PRIMARY model in tier-based routing. '
   'Valid: "mistral" | "gemini" | "anthropic". Routed to when '
   'primary_calls_today < tier_config.primary_calls_per_day. '
   'Bypassed when evaluate_model_provider kill-switch is set.'),
  ('evaluate_fallback_provider', 'gemini',
   'v6.3. Provider used for the FALLBACK model in tier-based routing. '
   'Valid: "mistral" | "gemini" | "anthropic". Routed to when '
   'tier_config.primary_calls_per_day exhausted or = 0. '
   'Bypassed when evaluate_model_provider kill-switch is set.')
ON CONFLICT (key) DO NOTHING;

-- ─── 6. is_paid_tier helper function ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_paid_tier(t text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT t IN ('tier1', 'tier2', 'family');
$$;

COMMENT ON FUNCTION public.is_paid_tier(text) IS
  'v6.3 helper. Returns true if the given subscription_tier represents a '
  'paying customer. Use in RLS policies and application code instead of '
  'subscription_tier=''paid'' to support the 4-tier post-v6.0 system. '
  'Returns false for ''free'' AND for the legacy ''paid'' value (which is in '
  'transition; existing parents on ''paid'' should be migrated to one of the '
  '4 specific tiers).';

GRANT EXECUTE ON FUNCTION public.is_paid_tier(text) TO public;

COMMIT;

-- ─── 7. Verification ───────────────────────────────────────────────────────

DO $$
DECLARE
  col_exists       boolean;
  func_get_ctx     boolean;
  fn_paid_exists   boolean;
  idx_exists       boolean;
  flag_primary     integer;
  flag_fallback    integer;
  backfilled_true  integer;
  backfilled_false integer;
  backfilled_null  integer;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='scan_attempts' AND column_name='is_primary_call'
  ) INTO col_exists;

  SELECT EXISTS(
    SELECT 1 FROM pg_proc
    WHERE pronamespace='public'::regnamespace AND proname='get_evaluate_context'
  ) INTO func_get_ctx;

  SELECT EXISTS(
    SELECT 1 FROM pg_proc
    WHERE pronamespace='public'::regnamespace AND proname='is_paid_tier'
  ) INTO fn_paid_exists;

  SELECT EXISTS(
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND tablename='scan_attempts'
      AND indexname='scan_attempts_primary_count_idx'
  ) INTO idx_exists;

  SELECT count(*) INTO flag_primary  FROM public.feature_flags WHERE key='evaluate_primary_provider';
  SELECT count(*) INTO flag_fallback FROM public.feature_flags WHERE key='evaluate_fallback_provider';

  SELECT count(*) INTO backfilled_true  FROM public.scan_attempts WHERE is_primary_call = true;
  SELECT count(*) INTO backfilled_false FROM public.scan_attempts WHERE is_primary_call = false;
  SELECT count(*) INTO backfilled_null  FROM public.scan_attempts WHERE is_primary_call IS NULL;

  RAISE NOTICE
    'v6.3 routing migration: is_primary_call_col=% get_eval_ctx=% is_paid_tier_fn=% idx=% flag_primary=% flag_fallback=% backfill_true=% backfill_false=% backfill_null=%',
    col_exists, func_get_ctx, fn_paid_exists, idx_exists, flag_primary, flag_fallback,
    backfilled_true, backfilled_false, backfilled_null;
END $$;
