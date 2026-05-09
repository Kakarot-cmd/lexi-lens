-- ============================================================================
-- 20260510_mistral_swap_and_cache_v6.sql
-- Lexi-Lens v6.0 — Mistral primary swap + cache v6 schema preparation.
--
-- This migration is the DB side of three coupled changes that ship together:
--
--   1. Provider hierarchy flip
--      Primary  : Mistral Small 4 (was: Anthropic Haiku 4.5)
--      Fallback : Gemini 2.5 Flash-Lite
--      Deeper   : Anthropic Haiku 4.5 (now reserved as outage backup)
--
--   2. tier_config rename: haiku_calls_per_day → primary_calls_per_day.
--      The original column existed to throttle expensive Haiku per tier.
--      With Mistral primary at ~9× lower cost the throttle is mostly
--      decorative, but renaming gives us a model-agnostic column that
--      doesn't lie about what it gates. Existing values are preserved
--      verbatim; semantically they now mean "primary-model calls before
--      fallback to Gemini".
--
--   3. Feature flag audit trail
--      An UPDATE-trigger on public.feature_flags writes a row to
--      public.admin_audit_log on every value change. Captures the old
--      value, new value, and time. Action='feature_flag_change'.
--      Required because feature_flags is the production kill switch and
--      we want forensics on every flip.
--
--   4. quests.feedback_flavor_template (new column)
--      Per-quest atmospheric suffix appended to passing childFeedback.
--      Nullable; NULL means "no flavor". Replaces the v5 attempt to put
--      questId in the cache key. Verdict stays universal; flavor is
--      composed at read time from a tiny per-quest template, costing
--      zero cache space.
--
-- ─── Coupled deploy ──────────────────────────────────────────────────────────
--
-- This migration MUST land in the same operation as the matching Edge
-- Function deploy. If you apply this first and the old code is still
-- running, the old tierConfig.ts will read tier_config and look for
-- haiku_calls_per_day which no longer exists; it'll fall through to the
-- hardcoded floor and behave (cap=5/haiku=3 for free, cap=50/haiku=25
-- for paid) — survivable but noisy. If you deploy code first and old DB
-- is still in place, new tierConfig.ts looks for primary_calls_per_day
-- which doesn't exist yet; same hardcoded-floor behaviour.
--
-- The safe sequence is: open a Supabase Dashboard SQL Editor tab with
-- this migration ready, open a terminal with `supabase functions deploy
-- evaluate` ready, run them within ~30 seconds of each other. Either
-- order works; transient hardcoded-floor mode is safe.
--
-- ─── ⚠ BREAKING NAMING CHANGE (intentional) ─────────────────────────────────
--
-- get_evaluate_context RPC still returns a field literally named
-- haiku_calls_today. The Edge Function maps this to its internal
-- primaryCallsToday parameter on the way into pickAdapterForRequest. The
-- count itself is correct (it's just "scans with cache_hit=false today")
-- so the residual name is cosmetic. Renaming the RPC return field is a
-- separate optional cleanup not in scope here.
--
-- Rollback note: see end of file for the inverse migration.
-- ============================================================================

BEGIN;

-- ─── 1. tier_config column rename ─────────────────────────────────────────────

-- The CHECK constraint references the old column name, so we drop it before
-- the rename and recreate it under the new name. Both as ALTER TABLE
-- statements so PG's catalog rewrites cleanly.

ALTER TABLE public.tier_config
  DROP CONSTRAINT IF EXISTS tier_config_haiku_le_cap;

ALTER TABLE public.tier_config
  RENAME COLUMN haiku_calls_per_day TO primary_calls_per_day;

ALTER TABLE public.tier_config
  ADD CONSTRAINT tier_config_primary_le_cap
  CHECK (primary_calls_per_day <= cap_scans_per_day);

COMMENT ON COLUMN public.tier_config.primary_calls_per_day IS
  'v6.0. Number of primary-model-routed scans per parent per day before '
  'the evaluate function falls back to Gemini for the rest of the day. '
  'Cache hits do not count. Reset at UTC midnight. 0 = always Gemini, '
  'equal-to-cap = always primary. Renamed from haiku_calls_per_day in '
  'the Mistral swap; existing values preserved verbatim.';

-- ─── 2. Quest atmospheric flavor template ─────────────────────────────────────

ALTER TABLE public.quests
  ADD COLUMN IF NOT EXISTS feedback_flavor_template text;

COMMENT ON COLUMN public.quests.feedback_flavor_template IS
  'v6.0. Optional atmospheric suffix appended to passing childFeedback at '
  'compose-time. Surfaces quest atmosphere (e.g., "❄ The Ice Dragon shimmers '
  'as you find another truth.") without polluting the model-agnostic '
  'verdict cache. Empty/NULL means no flavor. Always omitted on failing '
  'verdicts — the dragon does not celebrate when the kid is struggling. '
  'Length cap is advisory, not enforced: 120 chars is the sweet spot.';

-- Optional: seed a couple of templates for existing quests so the feature
-- is observable on day one. Only updates rows where the column is currently
-- NULL — won't clobber any post-migration manual edits.
--
-- Leaving these commented out by default; uncomment per-environment.
--
-- UPDATE public.quests
--    SET feedback_flavor_template = '🐉 The dragon nods, recognising your insight.'
--  WHERE name ILIKE '%dragon%'
--    AND feedback_flavor_template IS NULL;

-- ─── 3. Feature flag audit trail ──────────────────────────────────────────────

-- Trigger function lives in public; service role and superuser only execute
-- it. SECURITY DEFINER not needed — the trigger fires under the same role
-- doing the UPDATE, which is service_role for any flip via the Dashboard
-- SQL Editor.

CREATE OR REPLACE FUNCTION public.feature_flags_audit_trigger_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only log when the value actually changed. Idempotent UPDATE statements
  -- (e.g. retries from the runbook) shouldn't pollute the audit log.
  IF NEW.value IS DISTINCT FROM OLD.value THEN
    INSERT INTO public.admin_audit_log (
      admin_id,
      action,
      target_id,
      payload,
      created_at
    ) VALUES (
      NULL,                              -- service_role triggers have no auth user
      'feature_flag_change',
      NULL,                              -- feature_flags has no UUID PK; key in payload
      jsonb_build_object(
        'key',        NEW.key,
        'old_value',  OLD.value,
        'new_value',  NEW.value,
        'changed_by', current_user      -- which DB role; usually 'service_role'
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
  'Used to reconstruct who flipped what when, and to verify post-incident '
  'that an unintended flip was not the cause of a regression. Skips no-op '
  'UPDATEs (where NEW.value = OLD.value).';

-- ─── 4. Provider switch ──────────────────────────────────────────────────────

-- This UPDATE actually flips production from Anthropic primary to Mistral
-- primary the moment the migration commits. The audit trigger above also
-- fires, leaving a row in admin_audit_log proving the transition happened.

-- The new code in tierRouting.ts treats 'mistral' as the canonical primary
-- and only routes to the kill-switch path on 'anthropic' or 'gemini'. So
-- setting 'mistral' here matches what the Edge Function expects.

UPDATE public.feature_flags
SET    value      = 'mistral',
       updated_at = now()
WHERE  key        = 'evaluate_model_provider'
   -- Only flip if not already on Mistral; lets the migration be re-run
   -- safely without spurious audit log entries.
   AND value <> 'mistral';

-- ─── 5. Verification queries (manual, run after apply) ───────────────────────
--
-- 5a. Confirm the column rename:
--   \d public.tier_config
--   (expect column primary_calls_per_day, NOT haiku_calls_per_day)
--
-- 5b. Confirm the constraint rename:
--   SELECT conname FROM pg_constraint
--   WHERE conrelid = 'public.tier_config'::regclass;
--   (expect tier_config_primary_le_cap)
--
-- 5c. Confirm the flag flip:
--   SELECT key, value, updated_at FROM public.feature_flags
--   WHERE key = 'evaluate_model_provider';
--   (expect value='mistral', updated_at = now-ish)
--
-- 5d. Confirm the audit row was written:
--   SELECT created_at, action, payload FROM public.admin_audit_log
--   WHERE action = 'feature_flag_change'
--   ORDER BY created_at DESC
--   LIMIT 1;
--   (expect payload.old_value='anthropic' (or 'gemini'), new_value='mistral')
--
-- 5e. Confirm the new column on quests:
--   \d public.quests
--   (expect column feedback_flavor_template TEXT, nullable)

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
-- COMMIT;
