-- ════════════════════════════════════════════════════════════════════════════
-- 20260511_actual_age_required.sql
-- Lexi-Lens v6.1 — Make child age a UI-required field, not silently defaulted
-- ════════════════════════════════════════════════════════════════════════════
--
-- WHY:
--   Pre-v6.1, child_profiles.age had DEFAULT 8 with NOT NULL. The UI
--   captured age_band only and never set the actual age field, so every
--   child silently received age=8. Worse, ScanScreen.tsx derived childAge
--   from `parseInt(age_band.split("-")[1])`, meaning the model also
--   received the band's UPPER bound — effectively age=6, 8, 10, or 12 was
--   the only resolution any child could ever have. A 5-year-old got the
--   model treatment of a 6-year-old; a 7-year-old got the model treatment
--   of an 8-year-old — and that 7→8 transition crosses our age band
--   threshold (kid_msg.young vs kid_msg.older), so it actually changed
--   model output register.
--
--   This migration removes the misleading default. The UI must now supply
--   an actual age (5–12). The age_band column is preserved (existing
--   sync_age_band trigger continues working from age → age_band) so all
--   downstream consumers (quest min_age_band gating, cohort queries) keep
--   working.
--
-- IDEMPOTENT.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- Drop the misleading default. Existing rows are unaffected — they keep
-- whatever age value they already have (which, for pre-v6.1 rows, is 8
-- because that was the silent default). UI fix in v6.1 + a one-time
-- backfill (commented at the bottom of this file) addresses existing rows.

ALTER TABLE public.child_profiles
  ALTER COLUMN age DROP DEFAULT;

COMMENT ON COLUMN public.child_profiles.age IS
  'v6.1. Actual child age in years (5-12, enforced by check constraint). '
  'Required: UI must capture and supply this. Pre-v6.1 rows have age=8 from '
  'the previous silent default — re-prompt parents to confirm/correct on '
  'next session. The sync_age_band trigger derives age_band from this '
  'value, so age is the source of truth and age_band is derived.';

COMMENT ON COLUMN public.child_profiles.age_band IS
  'v6.1. Derived from `age` by the sync_age_band trigger. Preserved as a '
  'denormalised column for cohort queries and quest min_age_band gating. '
  'Do not write directly — write to age and let the trigger update this.';

-- ─── Optional one-time backfill for known-bad rows ──────────────────────────
--
-- Pre-v6.1 silent default left every row at age=8. If you want to force a
-- re-prompt for parents on next session (so they correct rather than
-- assume the default was right), set a flag column or just rely on parents
-- noticing the model voice is wrong and updating.
--
-- For staging/dev, the cleanest backfill is to NULL out the age field on
-- rows where it equals the old default exactly AND created_at predates
-- this migration. But we can't make age NULL because of NOT NULL. Two
-- options:
--   (a) Add a separate boolean flag `age_confirmed_at_v6_1 boolean DEFAULT
--       false`, and prompt the UI to re-confirm when false. Clean.
--   (b) Just leave existing rows at age=8 and let parents update via the
--       (existing) edit-profile path. Pragmatic for a beta with a small
--       user base.
--
-- We're going with (b) because v6.1 staging has only the dev's own test
-- profiles. For a wider beta, switch to (a) before relying on the data.

COMMIT;

-- ─── Rollback ───────────────────────────────────────────────────────────────
-- BEGIN;
-- ALTER TABLE public.child_profiles ALTER COLUMN age SET DEFAULT 8;
-- COMMIT;
