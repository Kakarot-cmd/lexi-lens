-- ============================================================================
-- 20260509_tier_config.sql
-- Lexi-Lens — table-driven per-tier configuration.
--
-- ⚠ THIS REPLACES THE TURN-2 VERSION OF THIS MIGRATION.
--    The earlier version seeded only ('free', 'paid') rows. This version
--    seeds the full 4-tier set per the v2.2 economics matrix screenshot.
--    If you already applied the earlier version: this version is idempotent
--    via ON CONFLICT (tier) DO UPDATE — it'll fix in place. Otherwise apply
--    fresh.
--
-- ─── What this migration does ──────────────────────────────────────────────
--
-- Creates public.tier_config — a structured, per-tier configuration table.
-- Replaces the scattered feature_flags rows (daily_scan_limit_free,
-- daily_scan_limit_paid) with a row-per-tier model matching the v2.2
-- economics matrix.
--
-- Two configurable values per tier:
--
--   • cap_scans_per_day      Total daily scan cap (cache hits excluded —
--                            same load-bearing rule as v5.2.2).
--
--   • haiku_calls_per_day    Number of Haiku-routed calls per parent per
--                            day before the evaluate Edge Function falls
--                            back to Gemini for the rest of the day.
--
-- Seeded values mirror the matrix screenshot exactly:
--
--   ┌─────────┬─────────────────┬────────────────────┐
--   │ tier    │ cap_scans/day   │ haiku_calls/day    │
--   ├─────────┼─────────────────┼────────────────────┤
--   │ free    │  5              │  3                 │
--   │ tier1   │ 20              │  7                 │
--   │ tier2   │ 45              │ 14                 │
--   │ family  │ 60              │ 21                 │
--   └─────────┴─────────────────┴────────────────────┘
--
-- All values are configurable via simple SQL UPDATE — no migration needed
-- to tune limits post-launch.
--
-- ─── Coordination with parents.subscription_tier ──────────────────────────
--
-- The existing parents.subscription_tier CHECK constraint allows only
-- ('free', 'paid'). A separate next-turn migration extends it to allow
-- ('free', 'tier1', 'tier2', 'family') so you can manually assign test
-- users to a specific paid tier.
--
-- Pre-extension: tier_config rows for tier1/tier2/family exist but no
-- parent ever queries them (because no parent.subscription_tier value
-- matches). The Edge Function falls back to feature_flags.daily_scan_limit_paid
-- (=50) for any parent on 'paid' tier. This works fine during transition.
--
-- Post-extension: Edge Function reads tier_config rows for the parent's
-- actual tier. The legacy 'paid' value disappears from production once
-- RevenueCat starts populating tier1/tier2/family via webhook (Phase 4.4).
--
-- ─── Edge Function compatibility (next-turn work) ─────────────────────────
--
-- The Edge Function update will:
--   • Read tier_config first; fall back to feature_flags.daily_scan_limit_*
--     if no row matches.
--   • Track Haiku calls per parent per day (UTC midnight reset).
--   • Route to Gemini once haiku_calls_per_day is exhausted.
--
-- Cache hits do NOT count toward either cap. This is the v5.2.2 design
-- carried forward.
--
-- ─── RLS ───────────────────────────────────────────────────────────────────
--
-- Service role only, same as feature_flags. Anon and authenticated read
-- nothing. Configuration is admin/ops; no client should ever touch it.
-- ============================================================================

BEGIN;

-- ─── 1. Table ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tier_config (
  -- 4-tier vocabulary matching the v2.2 economics matrix.
  tier text PRIMARY KEY,

  cap_scans_per_day integer NOT NULL
    CHECK (cap_scans_per_day >= 1 AND cap_scans_per_day <= 1000),

  haiku_calls_per_day integer NOT NULL
    CHECK (haiku_calls_per_day >= 0 AND haiku_calls_per_day <= 1000),

  description text,
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tier_config_haiku_le_cap CHECK (haiku_calls_per_day <= cap_scans_per_day)
);

-- CHECK constraint as a separate ALTER so re-running this migration after
-- the turn-2 version cleanly upgrades the constraint vocabulary.
ALTER TABLE public.tier_config
  DROP CONSTRAINT IF EXISTS tier_config_tier_check;

ALTER TABLE public.tier_config
  ADD CONSTRAINT tier_config_tier_check
  CHECK (tier IN ('free', 'tier1', 'tier2', 'family'));

COMMENT ON TABLE  public.tier_config IS
  'Per-subscription-tier configuration. Daily scan caps and Haiku→Gemini '
  'fallback thresholds. Read by the evaluate Edge Function once per cold '
  'container with ~60s in-process cache (same pattern as feature_flags). '
  'Service role only.';

COMMENT ON COLUMN public.tier_config.cap_scans_per_day IS
  'Total daily scan cap excluding cache hits. Replaces '
  'feature_flags.daily_scan_limit_<tier>. Edge Function will fall back to '
  'the old flag if the matching tier_config row is missing.';

COMMENT ON COLUMN public.tier_config.haiku_calls_per_day IS
  'Phase 4.10b. Number of Haiku-routed scans per parent per day before the '
  'evaluate function falls back to Gemini for the remainder of the day. '
  'Cache hits do not count. Reset at UTC midnight. 0 = always Gemini. '
  'Equal-to-cap = always Haiku.';

-- ─── 2. updated_at trigger ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tier_config_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tier_config_updated_at_trg ON public.tier_config;
CREATE TRIGGER tier_config_updated_at_trg
  BEFORE UPDATE ON public.tier_config
  FOR EACH ROW
  EXECUTE FUNCTION public.tier_config_set_updated_at();

-- ─── 3. Seed values (from v2.2 matrix screenshot) ──────────────────────────

-- ON CONFLICT DO UPDATE makes this idempotent — re-running the migration
-- after the turn-2 version cleanly overwrites the older free/paid seeds
-- without leaving stale rows behind.

INSERT INTO public.tier_config (tier, cap_scans_per_day, haiku_calls_per_day, description) VALUES
  ('free',   5,  3,
   'Free tier (matrix v2.2). 5 scans/day total, first 3 Haiku, remainder Gemini.'),
  ('tier1', 20,  7,
   'Tier 1 paid (matrix v2.2). 20 scans/day, first 7 Haiku, remainder Gemini. ₹349/mo Android, ₹399/mo iOS.'),
  ('tier2', 45, 14,
   'Tier 2 paid (matrix v2.2). 45 scans/day, first 14 Haiku, remainder Gemini. ₹599/mo Android, ₹699/mo iOS.'),
  ('family', 60, 21,
   'Family tier (matrix v2.2). 60 scans/day, first 21 Haiku, remainder Gemini. ₹749/mo Android, ₹999/mo iOS.')
ON CONFLICT (tier) DO UPDATE SET
  cap_scans_per_day   = EXCLUDED.cap_scans_per_day,
  haiku_calls_per_day = EXCLUDED.haiku_calls_per_day,
  description         = EXCLUDED.description,
  updated_at          = now();

-- Clean up the stale 'paid' row from the turn-2 version of this migration,
-- if it's still there. No-op if never seeded.
DELETE FROM public.tier_config WHERE tier = 'paid';

-- ─── 4. RLS ─────────────────────────────────────────────────────────────────

ALTER TABLE public.tier_config ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.tier_config FROM anon, authenticated;
GRANT  ALL ON public.tier_config TO   service_role;

-- ─── 5. Helper RPC for the Edge Function ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_tier_config(p_tier text)
RETURNS TABLE(cap_scans_per_day integer, haiku_calls_per_day integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT cap_scans_per_day, haiku_calls_per_day
  FROM public.tier_config
  WHERE tier = p_tier
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_tier_config(text) IS
  'Returns (cap_scans_per_day, haiku_calls_per_day) for the given tier. '
  'Service role only; not granted to authenticated.';

-- ─── 6. Verification queries (run manually after apply) ────────────────────
--
-- Expect 4 rows in matrix order:
--   SELECT tier, cap_scans_per_day, haiku_calls_per_day FROM public.tier_config
--   ORDER BY CASE tier
--     WHEN 'free' THEN 1 WHEN 'tier1' THEN 2 WHEN 'tier2' THEN 3 WHEN 'family' THEN 4 END;
--
-- To adjust any tier later (e.g. drop tier1 cap to 15):
--   UPDATE public.tier_config SET cap_scans_per_day = 15 WHERE tier = 'tier1';
--   -- propagation to warm Edge Function containers: ~60s

COMMIT;
