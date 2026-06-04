-- ============================================================================
-- 20260604_daily_quest_rolling_window.sql
-- Skanlore — daily quests become a rolling 3-day free window.
--
-- RULE: the daily quest for today + the 2 prior UTC dates is FREE for everyone;
-- older daily quests revert to their stored tier (premium). The 5 curated free
-- quests (min_subscription_tier='free') are unaffected and stay free always.
--
-- ENFORCEMENT BOUNDARY: this is enforced where it actually matters — the
-- evaluate Edge Function's tier check (evaluate/index.ts ~L1119) reads
-- quest_min_tier from get_evaluate_context and returns 403 'tier_required'
-- when subscription_tier < quest_min_tier. By making the RPC return an
-- EFFECTIVE tier ('free' for an in-window daily, else the stored tier), the
-- window is enforced server-side regardless of the client. The QuestMap lock
-- is cosmetic and is handled in a separate client change.
--
-- WHAT THIS MIGRATION DOES:
--   1. CREATE OR REPLACE get_evaluate_context — quest_min_tier now computes a
--      rolling-window effective tier. Everything else is byte-for-byte the
--      v6.3 definition.
--   2. Flip feature_flags.daily_quest_min_tier 'free' -> 'paid', so NEW daily
--      quests are stored at 'paid' (base) and the window grants the 3-day free
--      access. (ensure-daily-quest already reads this flag + pins apprentice
--      difficulty; no Edge Function code change needed.)
--   3. Index daily_quests(quest_id) for the EXISTS subquery.
--
-- DELIBERATELY NOT DOING: a backfill of existing daily quests to 'paid'.
-- The old flag value 'free' means dailies created so far are stored 'free'
-- (free forever) AND the fallback selector may have reused a curated FREE
-- dungeon as a daily. Blindly flipping "any quest with a daily_quests row" to
-- 'paid' would wrongly lock the curated free dungeons. So the rolling window
-- applies to dailies created from this flip onward; existing dailies keep
-- their stored tier. A careful one-time backfill (excluding free dungeons +
-- reused curated quests) can be done later if retroactive behaviour is wanted.
--
-- WINDOW MATH: quest_date >= (UTC today - 2) = {today, yesterday, day-before}
-- = 3 calendar dates. UTC is used to match todays_scans and ensure-daily-quest,
-- both of which date in UTC.
--
-- REVERSIBILITY: re-apply 20260512_routing_v6_3.sql to restore the old RPC;
-- UPDATE the flag back to 'free'; DROP the index. Fully reversible.
-- ============================================================================

-- ─── 1. RPC: rolling-window effective quest_min_tier ────────────────────────
CREATE OR REPLACE FUNCTION public.get_evaluate_context(
  p_child_id uuid,
  p_quest_id uuid
)
RETURNS TABLE(
  scans_today         integer,
  primary_calls_today integer,
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
          AND is_primary_call  = true
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
    -- ROLLING-WINDOW EFFECTIVE TIER (20260604):
    -- A daily quest whose quest_date is within the last 3 UTC dates resolves
    -- to 'free' so free-tier parents pass the evaluate tier check. Older
    -- dailies fall through to their stored min_subscription_tier (premium).
    COALESCE((
      SELECT CASE
               WHEN EXISTS (
                 SELECT 1
                 FROM public.daily_quests dq
                 WHERE dq.quest_id   = q.id
                   AND dq.quest_date >= ((now() AT TIME ZONE 'UTC')::date - 2)
               ) THEN 'free'
               ELSE q.min_subscription_tier
             END
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
  'v6.4 (20260604). Single round-trip context fetch for the evaluate Edge '
  'Function. quest_min_tier now returns a ROLLING-WINDOW effective tier: '
  '''free'' when the requested quest is the daily quest for today or either '
  'of the 2 prior UTC dates, otherwise the quest''s stored '
  'min_subscription_tier. Enforces the 3-day free daily-quest window at the '
  'evaluate boundary (403 tier_required for aged-out dailies on free tier). '
  'All other columns identical to v6.3. Service role only; SECURITY DEFINER.';

REVOKE ALL ON FUNCTION public.get_evaluate_context(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_evaluate_context(uuid, uuid) TO service_role;

-- ─── 2. Flip the daily-quest base tier to 'paid' ────────────────────────────
-- New dailies are now stored 'paid'; the rolling window above grants the
-- 3-day free access. ensure-daily-quest reads this flag (fails open to 'free')
-- and pins the daily to apprentice difficulty when 'paid'.
UPDATE public.feature_flags
   SET value = 'paid'
 WHERE key   = 'daily_quest_min_tier';

-- ─── 3. Index for the EXISTS subquery ───────────────────────────────────────
CREATE INDEX IF NOT EXISTS daily_quests_quest_id_idx
  ON public.daily_quests (quest_id);

-- ─── Sanity log ─────────────────────────────────────────────────────────────
DO $$
DECLARE
    v text;
BEGIN
    SELECT value INTO v FROM public.feature_flags WHERE key = 'daily_quest_min_tier';
    RAISE NOTICE 'daily_quest_rolling_window: daily_quest_min_tier = % (expect paid)', v;
END $$;
