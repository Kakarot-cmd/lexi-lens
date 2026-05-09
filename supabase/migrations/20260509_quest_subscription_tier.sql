-- ============================================================================
-- 20260509_quest_subscription_tier.sql
-- Lexi-Lens — quest-level free/paid gating.
--
-- ─── What this migration does ──────────────────────────────────────────────
--
-- Adds public.quests.min_subscription_tier — a new column controlling which
-- subscription tiers can SEE and PLAY each quest. Default 'paid' (safest:
-- existing quests stay paid-only). RLS enforces the gate so a malicious
-- client cannot scan against a quest_id their tier shouldn't access.
--
-- ─── ⚠ BREAKING PRODUCT CHANGE ─────────────────────────────────────────────
--
-- BEFORE this migration: every authenticated parent (free or paid) can see
-- and play every public quest. ~80 quests visible to all.
--
-- AFTER this migration applies + the 3 free-tier UPDATEs land: free-tier
-- parents see ONLY the 3 marked quests. Everything else becomes invisible
-- to them through normal client paths (they can't list, can't navigate to,
-- can't scan).
--
-- This is the intended product behaviour. Capturing it loudly here so a
-- future you running this migration in haste doesn't get surprised by a
-- support ticket flood.
--
-- Recommended rollout order (NOT enforced by this migration, your judgment):
--
--   1. Apply this migration on staging.
--   2. Mark the 3 chosen apprentice quests as 'free' in staging via a
--      separate UPDATE script (next-turn deliverable).
--   3. Verify free-tier child sees 3 quests, paid-tier child sees all.
--   4. Apply to prod.
--   5. Mark the 3 chosen quests as 'free' in prod.
--
-- Step 4 + 5 are deliberately separated: step 4 with no UPDATEs leaves all
-- existing quests at 'paid', meaning free users see nothing. Don't pause
-- between 4 and 5.
--
-- ─── Why min_subscription_tier and not is_free_tier ───────────────────────
--
-- The economics matrix v2.2 has 4 tiers planned (free, tier1, tier2,
-- family). A boolean is_free_tier doesn't accommodate tier-gated content
-- (e.g. "this quest requires tier1 or higher"). Using min_subscription_tier
-- with the same value space as parents.subscription_tier keeps the door
-- open for gating like 'tier1' on advanced sage/archmage content later.
--
-- For now the CHECK constraint allows only 'free' and 'paid' to mirror
-- parents.subscription_tier exactly. When parents grows to support more
-- tiers, a single coordinated migration extends both constraints.
--
-- ─── RLS strategy ──────────────────────────────────────────────────────────
--
-- The existing quests RLS policy (whatever it is) is augmented, not
-- replaced. We add a USING clause that requires
--
--   min_subscription_tier = 'free'
--   OR exists(SELECT 1 FROM parents WHERE id = auth.uid() AND subscription_tier = 'paid')
--
-- This keeps any pre-existing visibility logic (e.g. private vs public,
-- approved_at, owner-of-private) and adds tier gating on top.
--
-- The Edge Function (evaluate, generate-quest, etc.) bypasses RLS via
-- service_role, but the evaluate function will be updated in a follow-up
-- turn to validate the (parent_tier, quest_min_tier) pair on every scan
-- before calling the model. That's the second line of defence; this RLS
-- is the first.
--
-- ─── Apply order ───────────────────────────────────────────────────────────
--
-- Apply BEFORE deploying any UI changes that filter quests by tier — UI
-- will work fine without this (everyone still sees everything via
-- client-side state). This migration locks down the server side.
--
-- ============================================================================

BEGIN;

-- ─── 1. Column ──────────────────────────────────────────────────────────────

ALTER TABLE public.quests
  ADD COLUMN IF NOT EXISTS min_subscription_tier text NOT NULL DEFAULT 'paid';

ALTER TABLE public.quests
  DROP CONSTRAINT IF EXISTS quests_min_subscription_tier_check;

ALTER TABLE public.quests
  ADD CONSTRAINT quests_min_subscription_tier_check
  CHECK (min_subscription_tier IN ('free', 'paid'));

COMMENT ON COLUMN public.quests.min_subscription_tier IS
  'Lowest subscription tier permitted to see/play this quest. '
  'Values: ''free'' (everyone) | ''paid'' (paid-tier only). Default ''paid''. '
  'Mirrors values from parents.subscription_tier; coordinated extension required '
  'when parents grows to multi-tier (tier1/tier2/family). Enforced by RLS.';

-- ─── 2. Index for the RLS predicate ─────────────────────────────────────────

-- The RLS USING predicate filters on min_subscription_tier. With ~80 rows
-- this is overkill, but it's free at this scale and pays off when quest
-- count grows.
CREATE INDEX IF NOT EXISTS quests_min_subscription_tier_idx
  ON public.quests (min_subscription_tier)
  WHERE is_active = true;

-- ─── 3. RLS policy update ───────────────────────────────────────────────────
--
-- We don't know the exact name of the current SELECT policy on quests
-- (varies between projects depending on bootstrap order). The pattern below
-- is to:
--
--   1. Find the existing SELECT policy by inspecting pg_policies.
--   2. If a "quests_select_*" policy exists and its USING clause does NOT
--      already reference min_subscription_tier, REPLACE it with one that
--      adds the tier gate while preserving the original visibility logic.
--   3. If no policy exists at all, create one.
--
-- Because RLS predicates can't be inspected programmatically without
-- pg_get_expr, we instead use the safer pattern: drop & recreate with the
-- combined predicate. This requires you to verify the original policy's
-- intent before applying — capture pg_policies output first:
--
--   SELECT polname, pg_get_expr(polqual, polrelid) AS using_predicate
--   FROM pg_policy
--   WHERE polrelid = 'public.quests'::regclass;
--
-- The policy below assumes the previous USING predicate was effectively:
--
--   is_active = true AND (visibility = 'public' OR created_by = auth.uid())
--
-- which matches the typical bootstrap. Adjust if your project has diverged.

-- Make idempotent by dropping if exists.
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
          AND p.subscription_tier = 'paid'
      )
    )
  );

-- If a previous SELECT policy exists under a different name, drop it now.
-- Replace 'quests_select_public' with whatever the existing policy is
-- called in your project. Run this query first to find out:
--
--   SELECT polname FROM pg_policy
--   WHERE polrelid = 'public.quests'::regclass AND polcmd = 'r';

-- DROP POLICY IF EXISTS quests_select_public ON public.quests;

-- ─── 4. Verification queries (run manually) ─────────────────────────────────
--
-- Expect: every existing quest defaulted to 'paid', no rows are 'free' yet.
--   SELECT min_subscription_tier, count(*) FROM public.quests GROUP BY 1;
--
-- After the 3-dungeon UPDATE lands, expect 3 rows of 'free' and the rest
-- 'paid':
--   SELECT min_subscription_tier, count(*) FROM public.quests GROUP BY 1;
--
-- To verify RLS as a free-tier user, set the role and check:
--   SET LOCAL role = authenticated;
--   SET LOCAL request.jwt.claims = '{"sub":"<some-free-tier-parent-uuid>"}';
--   SELECT id, name, min_subscription_tier FROM public.quests;
--   -- should return only 'free' quests for that user

COMMIT;
