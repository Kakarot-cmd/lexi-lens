-- ============================================================================
-- 20260510_parents_tier_extension.sql
-- Lexi-Lens — extend parents.subscription_tier to 4-tier vocabulary.
--
-- ─── What this migration does ──────────────────────────────────────────────
--
-- Drops the existing CHECK constraint on parents.subscription_tier (which
-- allowed only 'free' and 'paid') and replaces it with one that accepts
-- the full 4-tier set from the v2.2 economics matrix:
--
--   'free'   — default for all signups. Corresponds to tier_config.tier='free'.
--   'tier1'  — entry paid tier (₹349/mo Android, ₹399/mo iOS).
--   'tier2'  — mid paid tier   (₹599 / ₹699).
--   'family' — top paid tier   (₹749 / ₹999).
--
-- The default stays 'free'. Existing rows are unaffected: any parent
-- currently at 'free' or 'paid' keeps that value. The 'paid' value remains
-- legal during transition so live RevenueCat-naive parents don't break,
-- but new tier assignments should use one of the 4 specific values.
--
-- ─── Why now ────────────────────────────────────────────────────────────────
--
-- The 20260509_tier_config.sql migration seeded tier_config rows for free,
-- tier1, tier2, family — but parents.subscription_tier couldn't actually
-- HOLD those values until this constraint extension landed.
--
-- After this migration:
--   • You can manually assign test users to any of the 4 tiers via
--     UPDATE parents SET subscription_tier = 'tier1' WHERE id = '...';
--   • The RevenueCat webhook (Phase 4.4, when it lands) writes one of the
--     4 specific values based on the entitlement.
--   • The evaluate Edge Function reads tier_config rows correctly for
--     parents on tier1/tier2/family.
--
-- ─── Coordination with quests.min_subscription_tier ────────────────────────
--
-- quests.min_subscription_tier stays binary 'free'/'paid'. That column is
-- a binary access flag ("is this quest paid-gated?") not a tier-specific
-- gate. The RLS predicate translates: a parent is "paid" iff their
-- subscription_tier IS NOT 'free' — i.e. tier1, tier2, or family all
-- count as paid for the purpose of quest visibility.
--
-- ─── Backward compatibility ────────────────────────────────────────────────
--
-- The constraint accepts 'paid' AS WELL as the four tiers. This lets
-- legacy parents (set before tier_config existed) stay valid. New rows
-- should use one of the 4 specific values; the 'paid' string is kept
-- only for the transition period and can be removed in a future migration
-- once all live rows are migrated.
-- ============================================================================

BEGIN;

-- ─── 1. Drop the old constraint ────────────────────────────────────────────

ALTER TABLE public.parents
  DROP CONSTRAINT IF EXISTS parents_subscription_tier_check;

-- ─── 2. Add the new constraint ─────────────────────────────────────────────

ALTER TABLE public.parents
  ADD CONSTRAINT parents_subscription_tier_check
  CHECK (subscription_tier IN ('free', 'paid', 'tier1', 'tier2', 'family'));

COMMENT ON COLUMN public.parents.subscription_tier IS
  'Per-parent subscription tier. Values: free (default), tier1, tier2, family. '
  'The legacy ''paid'' value is accepted during transition; new assignments '
  'should use one of the 4 specific tiers. Mirrors tier_config.tier vocabulary. '
  'Pre-RevenueCat: maintained manually via SQL UPDATE for test users. '
  'Post-RevenueCat: updated by webhook on entitlement changes.';

-- ─── 3. Sanity-check log ───────────────────────────────────────────────────

DO $$
DECLARE
  free_count   int;
  paid_count   int;
  tier1_count  int;
  tier2_count  int;
  family_count int;
  other_count  int;
BEGIN
  SELECT count(*) INTO free_count   FROM public.parents WHERE subscription_tier = 'free';
  SELECT count(*) INTO paid_count   FROM public.parents WHERE subscription_tier = 'paid';
  SELECT count(*) INTO tier1_count  FROM public.parents WHERE subscription_tier = 'tier1';
  SELECT count(*) INTO tier2_count  FROM public.parents WHERE subscription_tier = 'tier2';
  SELECT count(*) INTO family_count FROM public.parents WHERE subscription_tier = 'family';
  SELECT count(*) INTO other_count
    FROM public.parents
    WHERE subscription_tier NOT IN ('free', 'paid', 'tier1', 'tier2', 'family');

  RAISE NOTICE
    'parents.subscription_tier: free=% paid=% tier1=% tier2=% family=% other=%',
    free_count, paid_count, tier1_count, tier2_count, family_count, other_count;

  IF other_count > 0 THEN
    RAISE WARNING
      'Found % parents with subscription_tier outside the 5 accepted values. '
      'These rows would have failed the new constraint — investigate before '
      'they cause downstream errors.',
      other_count;
  END IF;
END $$;

-- ─── 4. Verification queries (run manually after apply) ────────────────────
--
--   -- 1. Constraint is in place:
--   SELECT con.conname, pg_get_constraintdef(con.oid) AS definition
--   FROM pg_constraint con
--   JOIN pg_class      cls ON cls.oid = con.conrelid
--   WHERE cls.relname = 'parents' AND con.conname = 'parents_subscription_tier_check';
--
--   -- 2. Distribution of tiers in production:
--   SELECT subscription_tier, count(*) FROM public.parents GROUP BY 1 ORDER BY 2 DESC;
--
--   -- 3. Promote a test parent to tier1 for testing the routing path:
--   UPDATE public.parents SET subscription_tier = 'tier1' WHERE id = '<test-parent-uuid>';

COMMIT;
