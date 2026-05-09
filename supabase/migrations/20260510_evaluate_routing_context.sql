-- ============================================================================
-- 20260510_evaluate_routing_context.sql
-- Lexi-Lens — schema support for tier-aware Haiku→Gemini routing.
--
-- ─── What this migration does ──────────────────────────────────────────────
--
-- Three coordinated changes that together let the evaluate Edge Function
-- make per-parent, per-day adapter routing decisions:
--
--   1. New scan_attempts.model_id column (text, nullable). Populated with
--      the producing model's stable id ('claude-haiku-4-5',
--      'gemini-3-1-flash-lite', etc.) when cache_hit=false. NULL for
--      cache hits and rate-limited rows.
--
--   2. New RPC `get_evaluate_context(p_child_id, p_quest_id)` returning
--      EVERYTHING the evaluate Edge Function needs in one round trip:
--        - scans_today (parent-level, cache-misses only)
--        - haiku_calls_today (parent-level, cache-misses produced by Haiku)
--        - subscription_tier (the parent's tier)
--        - quest_min_tier (the requested quest's gate)
--        - quest_exists (false if questId not found / not active)
--
--   3. Index on (created_at, model_id) for the Haiku-count query.
--
-- ─── Why a new model_id column ─────────────────────────────────────────────
--
-- Earlier design (v5.1) deliberately omitted this column: "Edge Function
-- logs and feature_flags audit trail are sufficient at solo-dev scale."
-- That call was correct AT THE TIME because the only thing we needed to
-- know was "which model is currently live" (one global flag).
--
-- Per-parent Haiku→Gemini routing changes the requirement: now we need
-- per-row attribution to know whether a given scan deducted from this
-- parent's daily Haiku budget. That's per-row data, not per-flag.
--
-- The walk-back is intentional and the column is small (text, nullable,
-- no constraint). Cost: a few bytes per scan_attempts row. Benefit: the
-- routing decision is auditable and the per-tier model split (monitor v5.4)
-- becomes a trivial GROUP BY.
--
-- ─── Why parent-level counts, not child-level ──────────────────────────────
--
-- The economics matrix v2.2 specifies caps PER PARENT (per household), not
-- per child. A free-tier parent with 3 children should still hit the cap
-- at 5 total scans, not 5 per child × 3 = 15.
--
-- The existing get_daily_scan_status RPC counts at child level. The new
-- get_evaluate_context RPC counts at parent level — joining scan_attempts
-- to child_profiles to find ALL of the same parent's children, then
-- counting today's rows across all of them.
--
-- The old RPC stays in place as a safety net during deploy windows.
--
-- ─── Failure modes ─────────────────────────────────────────────────────────
--
-- The new RPC errs on the side of "free tier with conservative caps":
--   • Quest not found → quest_exists=false, evaluate returns 404.
--   • Parent not found → tier='free' (deny paid quests, restrictive caps).
--   • Quest min_tier missing/null → 'free' (open access — fail open for
--     quest visibility, since the column was just added and pre-existing
--     rows may not have been backfilled if the previous migration hasn't
--     applied yet).
-- ============================================================================

BEGIN;

-- ─── 1. New column on scan_attempts ────────────────────────────────────────

ALTER TABLE public.scan_attempts
  ADD COLUMN IF NOT EXISTS model_id text;

COMMENT ON COLUMN public.scan_attempts.model_id IS
  'Stable id of the model that produced this verdict. Populated with values '
  'like ''claude-haiku-4-5'' or ''gemini-3-1-flash-lite'' on cache_hit=false '
  'rows. NULL when cache_hit=true (no model called) or rate_limited=true. '
  'Used by get_evaluate_context() to count today''s Haiku calls per parent '
  'for Phase 4.10b Haiku→Gemini routing.';

-- ─── 2. Index for the Haiku-count subquery ─────────────────────────────────
--
-- Composite index on (created_at, model_id) accelerates the WHERE
-- clause in get_evaluate_context's haiku_calls_today computation:
--   ... AND created_at >= today AND created_at < tomorrow
--       AND model_id IN ('claude-haiku-4-5')

CREATE INDEX IF NOT EXISTS scan_attempts_haiku_count_idx
  ON public.scan_attempts (created_at, model_id)
  WHERE rate_limited = false AND cache_hit = false;

-- ─── 3. New RPC: get_evaluate_context ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_evaluate_context(
  p_child_id uuid,
  p_quest_id uuid
)
RETURNS TABLE(
  scans_today        integer,
  haiku_calls_today  integer,
  subscription_tier  text,
  quest_min_tier     text,
  quest_exists       boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  -- Resolve the parent for this child (or NULL if child not found).
  WITH parent_lookup AS (
    SELECT cp.parent_id
    FROM public.child_profiles cp
    WHERE cp.id = p_child_id
    LIMIT 1
  ),
  -- All children belonging to the same parent (1+ rows).
  sibling_children AS (
    SELECT cp2.id
    FROM parent_lookup pl
    JOIN public.child_profiles cp2 ON cp2.parent_id = pl.parent_id
  ),
  -- Today's scans, parent-aggregated.
  todays_scans AS (
    SELECT
      count(*) FILTER (
        WHERE rate_limited = false AND cache_hit = false
      )::integer AS scans_count,
      count(*) FILTER (
        WHERE rate_limited = false
          AND cache_hit    = false
          AND model_id     = 'claude-haiku-4-5'
      )::integer AS haiku_count
    FROM public.scan_attempts sa
    WHERE sa.child_id    IN (SELECT id FROM sibling_children)
      AND sa.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
      AND sa.created_at <  date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day'
  )
  SELECT
    COALESCE((SELECT scans_count FROM todays_scans), 0)  AS scans_today,
    COALESCE((SELECT haiku_count FROM todays_scans), 0)  AS haiku_calls_today,
    COALESCE((
      SELECT p.subscription_tier
      FROM parent_lookup pl
      JOIN public.parents p ON p.id = pl.parent_id
      LIMIT 1
    ), 'free')                                            AS subscription_tier,
    COALESCE((
      SELECT q.min_subscription_tier
      FROM public.quests q
      WHERE q.id = p_quest_id AND q.is_active = true
      LIMIT 1
    ), 'free')                                            AS quest_min_tier,
    EXISTS(
      SELECT 1 FROM public.quests q
      WHERE q.id = p_quest_id AND q.is_active = true
    )                                                     AS quest_exists;
$$;

COMMENT ON FUNCTION public.get_evaluate_context(uuid, uuid) IS
  'Single round-trip context fetch for the evaluate Edge Function. Returns '
  'parent-level scan and Haiku counts for today (cache hits and rate-limited '
  'rows excluded), the parent''s subscription tier, the requested quest''s '
  'min_subscription_tier, and whether the quest exists/is active. Service '
  'role only; SECURITY DEFINER runs as table owner so RLS is bypassed.';

-- service_role bypasses RLS; not granted to authenticated.
REVOKE ALL ON FUNCTION public.get_evaluate_context(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_evaluate_context(uuid, uuid) TO service_role;

-- ─── 4. Sanity-check log ───────────────────────────────────────────────────

DO $$
DECLARE
  col_exists       boolean;
  func_exists      boolean;
  haiku_idx_exists boolean;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'scan_attempts'
      AND column_name  = 'model_id'
  ) INTO col_exists;

  SELECT EXISTS(
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname      = 'get_evaluate_context'
  ) INTO func_exists;

  SELECT EXISTS(
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename  = 'scan_attempts'
      AND indexname  = 'scan_attempts_haiku_count_idx'
  ) INTO haiku_idx_exists;

  RAISE NOTICE
    'evaluate routing context migration applied: column=% rpc=% index=%',
    col_exists, func_exists, haiku_idx_exists;
END $$;

-- ─── 5. Verification queries (run manually after apply) ────────────────────
--
--   -- 1. Column exists, NULL by default for existing rows:
--   SELECT count(*) FILTER (WHERE model_id IS NULL) AS null_rows,
--          count(*) FILTER (WHERE model_id IS NOT NULL) AS stamped_rows
--   FROM public.scan_attempts;
--   -- expect: null_rows = (existing total), stamped_rows = 0
--
--   -- 2. Smoke test the RPC against a real (child_id, quest_id):
--   SELECT * FROM public.get_evaluate_context(
--     '<some-child-uuid>'::uuid,
--     '<some-quest-uuid>'::uuid
--   );
--   -- expect: one row, scans_today >= 0, haiku_calls_today >= 0,
--   --         subscription_tier in (free, paid, tier1, tier2, family),
--   --         quest_min_tier in (free, paid),
--   --         quest_exists = true
--
--   -- 3. Index used? (after some traffic, EXPLAIN should show it):
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT count(*) FROM public.scan_attempts
--   WHERE created_at >= now() - interval '1 day'
--     AND model_id = 'claude-haiku-4-5'
--     AND rate_limited = false AND cache_hit = false;

COMMIT;
