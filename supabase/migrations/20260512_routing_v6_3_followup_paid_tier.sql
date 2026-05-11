-- ============================================================================
-- 20260512_routing_v6_3_followup_paid_tier.sql
-- Lexi-Lens — v6.3.1 follow-up: paid-equivalent tier handling.
--
-- Two coordinated fixes for incomplete tier coverage in the v6.3 migration:
--
--   1. is_paid_tier(t text) — widened to include the legacy 'paid' value
--      during the transition window. Original v6.3 definition excluded 'paid'
--      to force migration to tier1/tier2/family, but that creates a foot-gun:
--      any parent still on legacy 'paid' silently loses premium access.
--
--      New semantic: "does this parent have premium access RIGHT NOW?"
--      Returns true for: paid | tier1 | tier2 | family
--      Returns false for: free | NULL | anything else
--
--      Once all parents are migrated off legacy 'paid', this can be tightened
--      back to (tier1, tier2, family) only.
--
--   2. quests_select_with_tier_gate RLS — rewrites the SELECT policy on
--      public.quests to use is_paid_tier(). The original 20260509 migration
--      hardcoded `p.subscription_tier = 'paid'`, which rejects parents on
--      tier1/tier2/family. Fixing here so authenticated SELECTs honor the
--      4-tier system.
--
-- Idempotent: drops and recreates both objects. Safe to re-run.
-- ============================================================================

BEGIN;

-- ─── 1. Widen is_paid_tier to include legacy 'paid' ─────────────────────────

CREATE OR REPLACE FUNCTION public.is_paid_tier(t text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  -- Include legacy 'paid' alongside the 4 v6.0 tiers. Drop 'paid' from this
  -- list once all parents are migrated.
  SELECT t IN ('paid', 'tier1', 'tier2', 'family');
$$;

COMMENT ON FUNCTION public.is_paid_tier(text) IS
  'v6.3.1 helper. Returns true if the given subscription_tier represents a '
  'paying customer with premium access RIGHT NOW. Includes the legacy ''paid'' '
  'value for backward compatibility during the v6.0 → v6.3 tier transition. '
  'Use in RLS policies and any server-side application code instead of '
  'subscription_tier=''paid'' literal checks. Once legacy ''paid'' rows are '
  'fully migrated to one of the 4 specific tiers, this function can be '
  'tightened to exclude ''paid''.';

-- ─── 2. Rewrite quests_select_with_tier_gate RLS to use is_paid_tier ───────

DROP POLICY IF EXISTS quests_select_with_tier_gate ON public.quests;

CREATE POLICY quests_select_with_tier_gate
  ON public.quests
  FOR SELECT
  TO authenticated
  USING (
    is_active = true
    AND (visibility = 'public' OR created_by = auth.uid())
    AND (
      min_subscription_tier = 'free'
      OR EXISTS (
        SELECT 1
        FROM public.parents p
        WHERE p.id = auth.uid()
          AND public.is_paid_tier(p.subscription_tier)
      )
    )
  );

COMMENT ON POLICY quests_select_with_tier_gate ON public.quests IS
  'v6.3.1. SELECT gate: authenticated users see active public quests OR ones '
  'they created. Paid-tier quests require parent to pass is_paid_tier(), '
  'which accepts paid | tier1 | tier2 | family. Updated from the v6.0 version '
  'which hardcoded subscription_tier=''paid'' and rejected the 4 specific tiers.';

COMMIT;

-- ─── 3. Verification ───────────────────────────────────────────────────────

DO $$
DECLARE
  fn_def_includes_paid   boolean;
  policy_uses_helper     boolean;
  free_tier_check        boolean;
  tier1_check            boolean;
BEGIN
  -- Spot-check is_paid_tier returns correct values
  SELECT public.is_paid_tier('paid')  AND
         public.is_paid_tier('tier1') AND
         public.is_paid_tier('tier2') AND
         public.is_paid_tier('family')
  INTO fn_def_includes_paid;

  SELECT public.is_paid_tier('free') = false INTO free_tier_check;
  SELECT public.is_paid_tier('tier1') = true INTO tier1_check;

  -- Verify policy references is_paid_tier (substring match on pg_policy)
  SELECT pol.polqual::text LIKE '%is_paid_tier%'
  INTO policy_uses_helper
  FROM pg_policy pol
  WHERE pol.polrelid = 'public.quests'::regclass
    AND pol.polname  = 'quests_select_with_tier_gate';

  RAISE NOTICE
    'v6.3.1 paid-tier fixup: is_paid_tier_covers_4=% free=false_ok=% tier1=true_ok=% rls_uses_helper=%',
    fn_def_includes_paid, free_tier_check, tier1_check, policy_uses_helper;
END $$;
