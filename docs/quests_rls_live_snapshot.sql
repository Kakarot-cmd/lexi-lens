-- ============================================================================
-- quests_rls_live_snapshot.sql   (REFERENCE — do NOT run as a migration)
--
-- Full live RLS policy set on public.quests, captured from pg_policies on
-- 2026-06-18 (staging == prod). These policies were applied ad-hoc and are NOT
-- all represented in committed migrations. Kept here as the authoritative record
-- of deployed state. The parent INSERT/UPDATE hardening is committed separately
-- as 20260618_quests_parent_visibility_hardening.sql.
-- ============================================================================

CREATE POLICY "Admins delete quests" ON public.quests AS PERMISSIVE FOR DELETE TO authenticated
  USING (is_admin());

CREATE POLICY "Admins insert quests" ON public.quests AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (is_admin());

CREATE POLICY "Admins read all quests" ON public.quests AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_admin());

CREATE POLICY "Admins update quests" ON public.quests AS PERMISSIVE FOR UPDATE TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

CREATE POLICY "Parents can create quests" ON public.quests AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((created_by = auth.uid()));

CREATE POLICY "Parents can update own quests" ON public.quests AS PERMISSIVE FOR UPDATE TO public
  USING ((created_by = auth.uid()));

CREATE POLICY "Parents insert own quests" ON public.quests AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((created_by = auth.uid()) AND (visibility = 'pending_approval'::text) AND (approved_at IS NULL)));

CREATE POLICY "Parents update own quests" ON public.quests AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((created_by = auth.uid()) AND (visibility <> 'public'::text)))
  WITH CHECK (((created_by = auth.uid()) AND (approved_at IS NULL) AND (visibility = ANY (ARRAY['private'::text, 'pending_approval'::text]))));

CREATE POLICY quests_select_visibility ON public.quests AS PERMISSIVE FOR SELECT TO authenticated
  USING (((is_active = true) AND ((visibility = 'public'::text) OR (created_by = auth.uid()))));
