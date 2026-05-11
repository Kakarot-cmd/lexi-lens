-- ============================================================================
-- 20260513_drop_legacy_scan_limit_flags.sql
-- Lexi-Lens — v6.4 cleanup.
--
-- Removes the obsolete feature_flags rows that were superseded by tier_config
-- in v6.0. Specifically:
--   • daily_scan_limit_free  (value 10)
--   • daily_scan_limit_paid  (value 50)
--
-- WHY THIS IS SAFE
--
-- Edge Functions read tier limits via _shared/tierConfig.ts which falls back
-- in this order:
--     1. tier_config row for the tier (PRIMARY)
--     2. feature_flags.daily_scan_limit_<tier> (LEGACY FALLBACK)
--     3. HARDCODED_FLOOR constant in code (ULTIMATE FLOOR)
--
-- tier_config has rows for free / tier1 / tier2 / family — all of which
-- short-circuit at step 1 before the feature_flags fallback can fire. The
-- only tier that lacked a tier_config row was legacy 'paid', which fell to
-- step 2; deleting that flag pushes 'paid' to step 3 (HARDCODED_FLOOR.paid
-- = cap 50 / primary 25), which is identical to the flag value (50). No
-- behavior change for any tier.
--
-- The dead readFeatureFlagFallback() function in tierConfig.ts is harmless
-- (it just returns null faster after deletion) and can be removed in a
-- later code-only cleanup pass without urgency.
-- ============================================================================

BEGIN;

DELETE FROM public.feature_flags
WHERE key IN ('daily_scan_limit_free', 'daily_scan_limit_paid');

COMMIT;

-- ─── Verification ──────────────────────────────────────────────────────────

DO $$
DECLARE
  remaining_free  integer;
  remaining_paid  integer;
BEGIN
  SELECT count(*) INTO remaining_free
  FROM public.feature_flags WHERE key = 'daily_scan_limit_free';

  SELECT count(*) INTO remaining_paid
  FROM public.feature_flags WHERE key = 'daily_scan_limit_paid';

  RAISE NOTICE
    'v6.4 legacy flag cleanup: daily_scan_limit_free remaining=% daily_scan_limit_paid remaining=%',
    remaining_free, remaining_paid;
END $$;
