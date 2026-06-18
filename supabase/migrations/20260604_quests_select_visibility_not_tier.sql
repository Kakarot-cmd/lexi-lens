-- ============================================================================
-- 20260604_quests_select_visibility_not_tier.sql
--
-- RECONSTRUCTED FROM THE LIVE DATABASE (pg_policies). Applied directly to
-- staging + prod, never committed; this file closes that reproducibility gap.
--
-- Premium discovery funnel pivot: free users SEE paid quests as locked cards
-- instead of having them hidden. Drops the tier-predicated SELECT policy and
-- replaces it with a visibility-only SELECT policy. The PLAY gate moves entirely
-- to get_evaluate_context (403 'tier_required') + its expiry self-heal in
-- 20260604_evaluate_context_expiry_self_heal.sql.
--
-- Policy body is verbatim from live pg_policies. Idempotent (drop-then-create;
-- CREATE POLICY has no OR REPLACE).
-- ============================================================================

ALTER TABLE public.quests ENABLE ROW LEVEL SECURITY;  -- no-op if already enabled

-- Remove the tier-gating SELECT policy the funnel replaced.
DROP POLICY IF EXISTS quests_select_with_tier_gate ON public.quests;

-- (Re)create the visibility-only SELECT policy.
DROP POLICY IF EXISTS quests_select_visibility ON public.quests;
CREATE POLICY quests_select_visibility ON public.quests AS PERMISSIVE FOR SELECT TO authenticated
  USING (((is_active = true) AND ((visibility = 'public'::text) OR (created_by = auth.uid()))));
