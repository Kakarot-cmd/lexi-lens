-- ============================================================================
-- 20260618_quests_parent_visibility_hardening.sql
--
-- SECURITY HARDENING + finally committing two parent quest policies that were
-- live-only (never in a migration). The loose policies below only checked
-- created_by, so a parent could craft a direct API insert/update setting
-- visibility='public' and — via quests_select_visibility — publish a quest to
-- ALL families' children with no admin approval. This adds a visibility
-- constraint (allow 'private'/'pending_approval', block 'public').
--
-- SAFE FOR THE APP: the client saves custom quests as visibility='private'
-- (QuestGeneratorScreen) and never updates/deletes quests; AI generation runs
-- through the service role (RLS-exempt). Verified against the repo.
--
-- DO NOT blind-run on prod. Apply on STAGING first, then create a custom quest
-- in-app (must still succeed) and confirm a direct insert with
-- visibility='public' is now rejected. Then prod.
--
-- Idempotent: drop-then-create. On a fresh project these CREATE the policies in
-- their hardened form (they were never committed, so nothing is lost).
-- ============================================================================

-- INSERT: parents may only create non-public quests.
DROP POLICY IF EXISTS "Parents can create quests" ON public.quests;
CREATE POLICY "Parents can create quests" ON public.quests AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (
    (created_by = auth.uid())
    AND (visibility = ANY (ARRAY['private'::text, 'pending_approval'::text]))
  );

-- UPDATE: parents may edit their own quests but cannot flip them to 'public'.
-- (The app performs no quest updates today; this only closes the API surface.)
DROP POLICY IF EXISTS "Parents can update own quests" ON public.quests;
CREATE POLICY "Parents can update own quests" ON public.quests AS PERMISSIVE FOR UPDATE TO public
  USING (created_by = auth.uid())
  WITH CHECK (
    (created_by = auth.uid())
    AND (visibility = ANY (ARRAY['private'::text, 'pending_approval'::text]))
  );

-- Verify: both parent policies now carry the visibility constraint.
SELECT policyname, cmd, with_check
FROM pg_policies
WHERE schemaname='public' AND tablename='quests'
  AND policyname IN ('Parents can create quests', 'Parents can update own quests')
ORDER BY policyname;
