-- ============================================================================
-- 20260510_mistral_swap_and_cache_v6.sql  (CORRECTED — supersedes original)
-- Lexi-Lens v6.0 — Mistral primary swap + cache v6 schema preparation.
--
-- ─── What changed vs. the original ─────────────────────────────────────────
--
--   (a) Added section 0: ALTER admin_audit_log.admin_id DROP NOT NULL.
--       The original migration's design notes called this out as part of
--       the v6.0 change set, but the SQL file never actually did it.
--       Without it, the audit trigger added in section 3 INSERTs admin_id
--       = NULL when service_role flips a flag — and section 4 immediately
--       does exactly that. The first run hits the NOT NULL violation and
--       rolls back the entire transaction, leaving the DB unchanged
--       while production EF code is already on v6.
--
--   (b) Wrapped the tier_config rename + constraint add in DO/IF blocks
--       so the file is fully idempotent. Re-runnable against a fresh DB,
--       a partially-migrated DB, or one that's already at v6.
--
-- All other behaviour matches the original v6.0 migration verbatim.
--
-- ─── Original design summary (preserved) ───────────────────────────────────
--
--   1. Provider hierarchy flip: Mistral primary, Gemini fallback,
--      Anthropic deeper fallback.
--   2. tier_config rename: haiku_calls_per_day → primary_calls_per_day
--      (model-agnostic name; values preserved verbatim).
--   3. Audit trigger on feature_flags writes admin_audit_log rows on
--      every value change (action='feature_flag_change').
--   4. quests.feedback_flavor_template — per-quest atmospheric suffix
--      appended to passing childFeedback at compose-time.
--
-- ─── Coupled deploy reminder ───────────────────────────────────────────────
-- Apply this within ~30s of `supabase functions deploy evaluate`. Either
-- order works; transient hardcoded-floor mode is safe.
-- ============================================================================

BEGIN;

-- ─── 0. admin_audit_log.admin_id → nullable (NEW — was missing) ────────────

ALTER TABLE public.admin_audit_log
  ALTER COLUMN admin_id DROP NOT NULL;

COMMENT ON COLUMN public.admin_audit_log.admin_id IS
  'v6.0. NULL when the action was performed by service_role (e.g. an '
  'audit row written by feature_flags_audit_trigger_fn during a Dashboard '
  'SQL Editor flag flip, where there is no auth.uid()). Populated with '
  'the admin user id only when an authenticated admin performed the '
  'action via the admin dashboard.';

-- ─── 1. tier_config column rename (idempotent) ────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'tier_config'
      AND column_name  = 'haiku_calls_per_day'
  ) THEN
    ALTER TABLE public.tier_config
      DROP CONSTRAINT IF EXISTS tier_config_haiku_le_cap;
    ALTER TABLE public.tier_config
      RENAME COLUMN haiku_calls_per_day TO primary_calls_per_day;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.tier_config'::regclass
      AND conname  = 'tier_config_primary_le_cap'
  ) THEN
    ALTER TABLE public.tier_config
      ADD CONSTRAINT tier_config_primary_le_cap
      CHECK (primary_calls_per_day <= cap_scans_per_day);
  END IF;
END $$;

COMMENT ON COLUMN public.tier_config.primary_calls_per_day IS
  'v6.0. Number of primary-model-routed scans per parent per day before '
  'the evaluate function falls back to Gemini for the rest of the day. '
  'Cache hits do not count. Reset at UTC midnight. 0 = always Gemini, '
  'equal-to-cap = always primary. Renamed from haiku_calls_per_day in '
  'the Mistral swap; existing values preserved verbatim.';

-- ─── 2. Quest atmospheric flavor template (idempotent) ────────────────────

ALTER TABLE public.quests
  ADD COLUMN IF NOT EXISTS feedback_flavor_template text;

COMMENT ON COLUMN public.quests.feedback_flavor_template IS
  'v6.0. Optional atmospheric suffix appended to passing childFeedback at '
  'compose-time. Surfaces quest atmosphere (e.g., "❄ The Ice Dragon '
  'shimmers as you find another truth.") without polluting the model-'
  'agnostic verdict cache. NULL means no flavor. Always omitted on '
  'failing verdicts. Length cap is advisory: 120 chars is the sweet spot.';

-- ─── 3. Feature flag audit trigger (CREATE OR REPLACE — idempotent) ──────

CREATE OR REPLACE FUNCTION public.feature_flags_audit_trigger_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only log when the value actually changed. Idempotent UPDATE statements
  -- shouldn't pollute the audit log.
  IF NEW.value IS DISTINCT FROM OLD.value THEN
    INSERT INTO public.admin_audit_log (
      admin_id,
      action,
      target_id,
      payload,
      created_at
    ) VALUES (
      NULL,                              -- service_role has no auth.uid()
      'feature_flag_change',
      NULL,                              -- feature_flags has no UUID PK
      jsonb_build_object(
        'key',        NEW.key,
        'old_value',  OLD.value,
        'new_value',  NEW.value,
        'changed_by', current_user      -- DB role; usually 'service_role'
      ),
      now()
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feature_flags_audit_trg ON public.feature_flags;

CREATE TRIGGER feature_flags_audit_trg
  AFTER UPDATE ON public.feature_flags
  FOR EACH ROW
  EXECUTE FUNCTION public.feature_flags_audit_trigger_fn();

COMMENT ON FUNCTION public.feature_flags_audit_trigger_fn() IS
  'v6.0. Writes an admin_audit_log row on every feature_flags value change. '
  'Skips no-op UPDATEs (where NEW.value = OLD.value). Sets admin_id=NULL '
  'because service_role has no auth.uid() — see admin_id column comment.';

-- ─── 4. Provider switch (idempotent via WHERE clause) ─────────────────────

UPDATE public.feature_flags
SET    value      = 'mistral',
       updated_at = now()
WHERE  key        = 'evaluate_model_provider'
   AND value <> 'mistral';

-- ─── 5. Verification queries (manual, run after apply) ────────────────────
--
-- 5a. admin_id is now nullable:
--   SELECT is_nullable FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='admin_audit_log'
--     AND column_name='admin_id';
--   (expect 'YES')
--
-- 5b. Column rename applied:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name='tier_config' AND column_name='primary_calls_per_day';
--   (expect one row)
--
-- 5c. Constraint renamed:
--   SELECT conname FROM pg_constraint
--   WHERE conrelid='public.tier_config'::regclass;
--   (expect tier_config_primary_le_cap, NOT tier_config_haiku_le_cap)
--
-- 5d. Flag flipped:
--   SELECT key, value, updated_at FROM public.feature_flags
--   WHERE key='evaluate_model_provider';
--   (expect value='mistral', updated_at within seconds of apply)
--
-- 5e. Audit row written:
--   SELECT created_at, payload FROM public.admin_audit_log
--   WHERE action='feature_flag_change' ORDER BY created_at DESC LIMIT 1;
--   (expect payload.old_value='gemini' or 'anthropic', new_value='mistral',
--    admin_id=NULL)
--
-- 5f. Flavor template column exists:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name='quests' AND column_name='feedback_flavor_template';
--   (expect one row)

COMMIT;

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK SCRIPT (run as a separate migration if needed)
-- ────────────────────────────────────────────────────────────────────────────
-- BEGIN;
-- UPDATE public.feature_flags SET value='anthropic', updated_at=now()
--   WHERE key='evaluate_model_provider';
-- ALTER TABLE public.tier_config DROP CONSTRAINT IF EXISTS tier_config_primary_le_cap;
-- ALTER TABLE public.tier_config RENAME COLUMN primary_calls_per_day TO haiku_calls_per_day;
-- ALTER TABLE public.tier_config ADD CONSTRAINT tier_config_haiku_le_cap
--   CHECK (haiku_calls_per_day <= cap_scans_per_day);
-- DROP TRIGGER IF EXISTS feature_flags_audit_trg ON public.feature_flags;
-- DROP FUNCTION IF EXISTS public.feature_flags_audit_trigger_fn();
-- ALTER TABLE public.quests DROP COLUMN IF EXISTS feedback_flavor_template;
-- ALTER TABLE public.admin_audit_log ALTER COLUMN admin_id SET NOT NULL;
-- COMMIT;
