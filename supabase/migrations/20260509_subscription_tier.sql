-- ============================================================================
-- supabase/migrations/20260509_subscription_tier.sql
-- Lexi-Lens — Phase 4.10: Free-tier scan cap differential
-- ============================================================================
--
-- Adds the per-parent subscription tier and the runtime-configurable scan
-- caps that depend on it. Three additive changes (none drop or rename anything
-- existing, so this migration is reversible by hand if needed):
--
--   1. parents.subscription_tier  (new column, NOT NULL DEFAULT 'free')
--   2. get_daily_scan_status      (new RPC; returns scans_today + tier together)
--   3. feature_flags rows         (daily_scan_limit_free, daily_scan_limit_paid)
--
-- The existing get_daily_scan_count RPC is intentionally LEFT IN PLACE so a
-- mid-deploy state where the migration has applied but the v5.2.2 evaluate
-- Edge Function has not yet rolled out does not break scans. A later
-- migration may drop it once we are confident nothing else calls it.
--
-- ─── Why this matters (Phase 4.10) ─────────────────────────────────────────
--
-- Today the evaluate Edge Function caps every child at 50 scans/day uniformly
-- (cache hits excluded). Pre-launch we want a smaller cap on free-tier
-- households to anchor the upgrade story, but we also do not yet know what
-- "smaller" should mean — 5? 10? 15? — and we will not know until PROD
-- conversion data exists. Hardcoding the values means a code deploy every
-- time we want to test a new number. Putting them in feature_flags lets the
-- solo dev flip via Supabase Dashboard → SQL Editor with ~60s propagation.
--
-- ─── Naming notes ──────────────────────────────────────────────────────────
--
-- Column is `subscription_tier`, NOT `tier`, deliberately. The schema already
-- has `quests.tier` (quest_tier ENUM: apprentice|scholar|sage|archmage) and
-- `quest_sessions.tier` derived from it. Reusing the bare name `tier` on the
-- parents table would make joined queries ambiguous to read. Eat the extra
-- syllables now; thank yourself later.
--
-- Type is `text` with CHECK constraint, NOT a new ENUM. ENUMs are awkward to
-- extend in Postgres (need ALTER TYPE … ADD VALUE in its own transaction).
-- text+check costs nothing and keeps the door open for a future 'family' tier
-- without a schema dance.
--
-- ─── Cache hits, again ─────────────────────────────────────────────────────
--
-- The new RPC inherits the same `cache_hit = false` filter as the old one.
-- This is load-bearing for free-tier UX viability: a kid rescanning known
-- objects (which ML Kit's deduplicated labels make extremely common) does
-- not burn their quota. The 10-scan cap only bites on novel-object
-- exploration — which is also where the model spend lives. Do not "fix"
-- this filter; it is the design.
--
-- ─── RevenueCat sync timing ────────────────────────────────────────────────
--
-- `subscription_tier` is the denormalised projection of RevenueCat
-- entitlement state. RevenueCat is Phase 4.4, blocked on env split, so:
--   • Pre-launch: every parent stays 'free'. Manual UPDATE if you need to
--     test the paid path against a specific account.
--   • Post-RC: a webhook handler (not in this migration) updates this
--     column on entitlement changes. The handle_new_user trigger does not
--     need updating — DEFAULT 'free' covers all new signups.
--
-- ─── Apply order ───────────────────────────────────────────────────────────
--
-- Apply BEFORE deploying the v5.2.2 evaluate Edge Function. Applying after
-- still works (the Edge Function falls back to the old RPC + hardcoded 50
-- on RPC error), but produces avoidable warning logs. The strict ordering
-- requirement from 20260508_feature_flags.sql also applies — that table
-- must already exist.
-- ============================================================================

BEGIN;

-- ─── 1. Column ──────────────────────────────────────────────────────────────

ALTER TABLE public.parents
  ADD COLUMN IF NOT EXISTS subscription_tier text NOT NULL DEFAULT 'free';

-- Drop-then-add to be re-runnable; the constraint name is stable so a second
-- run is a no-op net of the trip through DROP/ADD.
ALTER TABLE public.parents
  DROP CONSTRAINT IF EXISTS parents_subscription_tier_check;

ALTER TABLE public.parents
  ADD CONSTRAINT parents_subscription_tier_check
  CHECK (subscription_tier IN ('free', 'paid'));

COMMENT ON COLUMN public.parents.subscription_tier IS
  'Per-parent subscription tier for scan-quota differential. Values: ''free'' (default) | ''paid''. '
  'Pre-RevenueCat: maintained manually via SQL UPDATE. Post-RevenueCat: updated by webhook. '
  'Note: separate from quests.tier (the quest_tier ENUM). Do not conflate the two in joined queries.';

-- ─── 2. RPC: get_daily_scan_status ──────────────────────────────────────────
--
-- Returns scans-today (excluding cache hits and rate-limited rows) AND the
-- owning parent's subscription tier in a single round-trip. Edge Function
-- consumes both to pick the right daily limit.

CREATE OR REPLACE FUNCTION public.get_daily_scan_status(p_child_id uuid)
RETURNS TABLE(scans_today integer, subscription_tier text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT
    COALESCE((
      SELECT COUNT(*)::integer
      FROM public.scan_attempts sa
      WHERE sa.child_id     = p_child_id
        AND sa.rate_limited = false
        AND sa.cache_hit    = false
        AND sa.created_at  >= date_trunc('day', now() AT TIME ZONE 'UTC')
        AND sa.created_at  <  date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day'
    ), 0) AS scans_today,
    COALESCE((
      SELECT p.subscription_tier
      FROM public.child_profiles cp
      JOIN public.parents        p ON p.id = cp.parent_id
      WHERE cp.id = p_child_id
      LIMIT 1
    ), 'free') AS subscription_tier;
$$;

COMMENT ON FUNCTION public.get_daily_scan_status(uuid) IS
  'Returns (scans_today, subscription_tier) for the given child in one round-trip. '
  'Replaces get_daily_scan_count for tier-aware quota enforcement (Phase 4.10). '
  'Cache hits are excluded from the count by design (see migration header). '
  'Called by the evaluate Edge Function via service_role; not granted to authenticated.';

-- Like get_daily_scan_count: NO grant to authenticated. Service role bypasses.
-- If a future client-side caller ever needs this, add the grant here.

-- ─── 3. Feature flags (configurable limits) ─────────────────────────────────

INSERT INTO public.feature_flags (key, value, description) VALUES
  ('daily_scan_limit_free',
   '10',
   'Daily scan cap for free-tier parents. Edge Function clamps reads to [1, 200] '
   'so a fat-finger UPDATE here cannot blow up cost. Cache hits do NOT count toward '
   'this limit; only fresh model calls do. See Roadmap v5.2.1 § 4.10.'),
  ('daily_scan_limit_paid',
   '50',
   'Daily scan cap for paid-tier parents. Edge Function clamps reads to [1, 500]. '
   'Cache hits do NOT count toward this limit. See Roadmap v5.2.1 § 4.10.')
ON CONFLICT (key) DO NOTHING;

-- ─── 4. Sanity-check log ────────────────────────────────────────────────────

DO $$
DECLARE
  free_parents int;
  paid_parents int;
  flag_count   int;
BEGIN
  SELECT count(*) INTO free_parents FROM public.parents WHERE subscription_tier = 'free';
  SELECT count(*) INTO paid_parents FROM public.parents WHERE subscription_tier = 'paid';
  SELECT count(*) INTO flag_count
    FROM public.feature_flags
    WHERE key IN ('daily_scan_limit_free', 'daily_scan_limit_paid');

  RAISE NOTICE
    'subscription_tier migration applied. parents.free=%, parents.paid=%, flag rows present=%/2',
    free_parents, paid_parents, flag_count;
END $$;

COMMIT;

-- ============================================================================
-- POST-RUN VERIFICATION
-- ============================================================================
--
--   -- 1. Column exists and is NOT NULL with default:
--   SELECT column_name, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_schema = 'public'
--      AND table_name   = 'parents'
--      AND column_name  = 'subscription_tier';
--   -- expect: NOT NULL, default ''free''::text
--
--   -- 2. RPC exists and is SECURITY DEFINER:
--   SELECT proname, prosecdef
--     FROM pg_proc
--    WHERE pronamespace = 'public'::regnamespace
--      AND proname = 'get_daily_scan_status';
--   -- expect: prosecdef = true
--
--   -- 3. Feature flags seeded:
--   SELECT key, value FROM public.feature_flags
--    WHERE key LIKE 'daily_scan_limit_%' ORDER BY key;
--   -- expect: daily_scan_limit_free=10, daily_scan_limit_paid=50
--
--   -- 4. Smoke test against a real child id (replace placeholder):
--   SELECT * FROM public.get_daily_scan_status('00000000-0000-0000-0000-000000000000'::uuid);
--   -- expect: one row, scans_today >= 0, subscription_tier in ('free','paid')
--
-- ============================================================================
