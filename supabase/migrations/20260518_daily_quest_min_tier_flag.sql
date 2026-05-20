-- ============================================================================
-- 20260518_daily_quest_min_tier_flag.sql
-- Lexi-Lens — daily-quest tier becomes a runtime flag (PU-2, premium-unlock chat)
--
-- HISTORY: applied to live staging + prod 2026-05-17 during the premium-unlock
-- investigation; never committed to the repo. Companion to the patched
-- ensure-daily-quest/index.ts which reads this flag for BOTH the
-- generated-quest insert tier and the fallback selection filter.
--
-- DEFAULT 'free' is intentional: zero behaviour change on deploy. Future
-- experiments (e.g. flipping the daily quest to a paid perk) become a
-- one-line UPDATE, no redeploy.
--
-- REVERSIBILITY: fully additive. DELETE the row to revert; the Edge
-- Function fails open to 'free' (per ensure-daily-quest/index.ts).
-- ============================================================================

INSERT INTO public.feature_flags (key, value, description) VALUES
  ('daily_quest_min_tier',
   'free',
   'Tier the auto-provisioned daily quest is created/selected at. '
   '''free'' (default) = daily quest is free for everyone. '
   '''paid'' = daily quest becomes a premium perk (ensure-daily-quest '
   'will additionally constrain the fallback selection to the apprentice '
   'difficulty so a paid daily never lands as an archmage quest). '
   'Read by supabase/functions/ensure-daily-quest/index.ts. '
   'Unknown values fail open to ''free'' to preserve the CHECK constraint '
   'on quests.min_subscription_tier.')
ON CONFLICT (key) DO NOTHING;

-- ── Sanity log ──────────────────────────────────────────────────────────────
DO $$
DECLARE
    v text;
BEGIN
    SELECT value INTO v FROM public.feature_flags WHERE key = 'daily_quest_min_tier';
    RAISE NOTICE 'daily_quest_min_tier_flag: post-migration value = %', v;
END $$;
