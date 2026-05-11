-- ============================================================================
-- 20260513_daily_quest_auto_gen.sql
-- Lexi-Lens — v6.4 daily quest auto-generation flag.
--
-- Adds the kill-switch feature flag for ensure-daily-quest (Session F).
--
--   daily_quest_auto_gen_enabled
--     'true'  → ensure-daily-quest invokes Haiku to generate a fresh quest
--               with name + property-set uniqueness checks and 2 retries.
--     'false' → ensure-daily-quest skips generation and falls back to
--               deterministic round-robin selection from existing free
--               quests. Same row in daily_quests is still written so all
--               users see the same global daily quest.
--
-- "One global daily quest" invariant is preserved regardless of the flag —
-- only the SOURCE of that quest changes (generated vs. existing).
-- ============================================================================

BEGIN;

INSERT INTO public.feature_flags (key, value, description) VALUES
  ('daily_quest_auto_gen_enabled', 'true',
   'v6.4. Kill-switch for ensure-daily-quest auto-generation. When ''true'' '
   '(default), the Edge Function invokes Haiku 4.5 to generate a fresh quest '
   'with name and full-property-set uniqueness checks and up to 2 retries. '
   'When ''false'', skips generation entirely and falls back to deterministic '
   'round-robin selection from existing free quests. Either way, exactly one '
   'row is written to daily_quests per quest_date (UTC), preserving the '
   '"one global daily quest" invariant. Flip to ''false'' if you ever need '
   'to halt Haiku spend or stop new quest accumulation; keep at ''true'' for '
   'fresh daily content.')
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- ─── Verification ──────────────────────────────────────────────────────────

DO $$
DECLARE
  flag_exists boolean;
  flag_value  text;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM public.feature_flags WHERE key = 'daily_quest_auto_gen_enabled'
  ) INTO flag_exists;

  SELECT value INTO flag_value FROM public.feature_flags WHERE key = 'daily_quest_auto_gen_enabled';

  RAISE NOTICE
    'v6.4 daily-quest flag: exists=% value=%',
    flag_exists, flag_value;
END $$;
