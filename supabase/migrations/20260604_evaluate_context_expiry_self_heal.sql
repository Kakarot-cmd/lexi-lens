-- ============================================================================
-- 20260604_evaluate_context_expiry_self_heal.sql
--
-- RECONSTRUCTED FROM THE LIVE DATABASE (pg_get_functiondef). This change was
-- applied directly to staging + prod and never committed; this file closes that
-- reproducibility gap so a fresh project matches what's deployed.
--
-- Re-creates get_evaluate_context, adding the EXPIRY SELF-HEAL branch on top of
-- the rolling-window version from 20260604_daily_quest_rolling_window.sql:
-- a lapsed paid parent (subscription_expires_at in the past, EXPIRATION webhook
-- not yet processed) resolves to 'free' at the evaluate boundary, mirroring
-- parent_has_premium(). This restores the play-gate self-heal the dropped
-- quests_select_with_tier_gate RLS policy used to provide implicitly
-- (see 20260604_quests_select_visibility_not_tier.sql).
--
-- ORDER: must run AFTER 20260604_daily_quest_rolling_window.sql (filename sorts
-- after it: d < e). CREATE OR REPLACE => the full live body below wins.
-- Body is verbatim from the live function.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_evaluate_context(p_child_id uuid, p_quest_id uuid)
 RETURNS TABLE(scans_today integer, primary_calls_today integer, subscription_tier text, quest_min_tier text, quest_exists boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    -- EXPIRY SELF-HEAL (20260604): a lapsed paid parent (subscription_expires_at
    -- in the past, EXPIRATION webhook not yet processed) resolves to 'free' so
    -- the evaluate tier check 403s them on paid quests. NULL = legacy/never-set
    -- = pass-through, matching parent_has_premium(). This is the play-gate that
    -- the dropped quests RLS tier gate used to provide implicitly.
    COALESCE((
      SELECT CASE
               WHEN p.subscription_expires_at IS NULL
                 OR p.subscription_expires_at > now()
                 THEN p.subscription_tier
               ELSE 'free'
             END
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
$function$;
