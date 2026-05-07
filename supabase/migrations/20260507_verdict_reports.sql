-- =============================================================================
-- Migration: 20260507_verdict_reports.sql
-- Lexi-Lens — Phase 4.6 Compliance polish: in-app verdict reporting
-- =============================================================================
--
-- WHY THIS MIGRATION EXISTS
--   Apple's App Store Review Guideline 1.3 (Kids Category) and Google's
--   Designed-for-Families policy both expect that an LLM-driven app aimed
--   at children provides a one-tap path for users (or supervising adults)
--   to flag any AI-generated output that seems inappropriate, factually
--   wrong, or off-topic.
--
--   Lexi-Lens already has Sentry crash reporting and a parental-consent
--   flow, but until v4.7 there was no structured way for a household to
--   report a specific verdict ("the magic lens said this stick was metal,
--   but it's wood" or "the feedback used a word my child shouldn't see").
--   This migration adds the storage layer for that path.
--
-- WHAT IT CREATES
--   1. verdict_reports — one row per user-filed report.
--   2. RLS: parents can read AND insert ONLY reports for their own children.
--   3. Indexes for the two queries we care about: by reason (admin review
--      dashboard) and by scan_attempt_id (cross-reference with the original
--      verdict).
--   4. ON DELETE CASCADE so reports vanish when the underlying scan_attempt
--      or child_profile is deleted (preserves the COPPA/GDPR-K erasure
--      guarantee — no orphaned reports referencing erased data).
--
-- WHAT IT DOES NOT CREATE
--   • The Edge Function (supabase/functions/report-verdict/) — separate
--     deploy; service-role write path so we don't need a permissive
--     INSERT RLS.
--   • Any admin dashboard. Reports are reviewed via SQL until volume
--     justifies a UI (data-gated post-launch item).
--
-- HOW TO RUN
--   Option A — Supabase Dashboard:  SQL Editor → paste → Run
--   Option B — Supabase CLI:        supabase db push
--   Option C — psql:                psql $DATABASE_URL -f this_file.sql
--
-- IDEMPOTENCY
--   Every CREATE uses IF NOT EXISTS / OR REPLACE. Safe to re-run.
--
-- =============================================================================

BEGIN;

-- ─── 1. Reason enum (using a CHECK constraint for forward-compat) ───────────
-- Using TEXT + CHECK rather than a Postgres ENUM type. Reasons:
--   • ENUMs are a pain to add values to — every new reason needs a
--     `ALTER TYPE ... ADD VALUE` that can't run inside a transaction on
--     older Postgres versions.
--   • TEXT + CHECK lets us add reasons by replacing the constraint.
--   • The set of reasons is small and stable enough that the lookup-table
--     overhead is unjustified.

CREATE TABLE IF NOT EXISTS public.verdict_reports (
  id                uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),

  -- Foreign keys ↓
  scan_attempt_id   uuid NOT NULL,
  child_id          uuid NOT NULL,
  parent_id         uuid NOT NULL,    -- denormalised for cheap parent-scoped queries

  -- Report content ↓
  reason            text NOT NULL,
  -- Optional 200-char free-text note. Truncated client-side; the CHECK
  -- enforces the cap in case the client misbehaves. NEVER include this
  -- value in any non-RLS-protected query path.
  note              text,

  -- Provenance for spike investigation ↓
  detected_label    text,
  resolved_name     text,
  cache_hit         boolean NOT NULL DEFAULT false,
  app_variant       text,             -- 'production' | 'staging' | 'development'
  app_version       text,             -- e.g. '1.0.12'

  created_at        timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT verdict_reports_reason_check
    CHECK (reason IN (
      'wrong_object',          -- Lens identified the wrong physical thing
      'wrong_property',        -- Property judgement was incorrect
      'feels_inappropriate',   -- Content is not child-appropriate
      'too_hard',              -- Vocabulary above the child's level
      'too_easy',              -- Below the child's level
      'other'                  -- Catch-all; note field is recommended
    )),

  CONSTRAINT verdict_reports_note_length_check
    CHECK (note IS NULL OR char_length(note) <= 200)
);

COMMENT ON TABLE public.verdict_reports IS
  'In-app reports filed by a parent or child against a specific verdict. RLS restricts both SELECT and INSERT to rows whose child_id belongs to the auth.uid() parent. Cascade-deletes with scan_attempts and child_profiles to maintain COPPA/GDPR-K erasure guarantees.';

COMMENT ON COLUMN public.verdict_reports.note IS
  'Optional free-text up to 200 chars. Sensitive — never project into Sentry events, error messages, or any non-RLS-protected query result.';

-- ─── 2. Foreign keys ─────────────────────────────────────────────────────────
-- Both ON DELETE CASCADE. When the scan_attempt is purged (deletion request
-- or rare admin op), the report goes too. When the child_profile is purged
-- (parent erases child), the report goes too.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'verdict_reports_scan_attempt_id_fkey'
  ) THEN
    ALTER TABLE public.verdict_reports
      ADD CONSTRAINT verdict_reports_scan_attempt_id_fkey
      FOREIGN KEY (scan_attempt_id)
      REFERENCES public.scan_attempts(id)
      ON DELETE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'verdict_reports_child_id_fkey'
  ) THEN
    ALTER TABLE public.verdict_reports
      ADD CONSTRAINT verdict_reports_child_id_fkey
      FOREIGN KEY (child_id)
      REFERENCES public.child_profiles(id)
      ON DELETE CASCADE;
  END IF;
END$$;

-- parent_id references auth.users — no FK because Supabase manages that
-- table's lifecycle and FKs across the auth boundary are fragile. We rely
-- on the child_id CASCADE chain instead (child → parent via child_profiles).

-- ─── 3. Indexes ─────────────────────────────────────────────────────────────
-- Two query paths:
--   a) admin review:    SELECT ... ORDER BY created_at DESC LIMIT N (latest)
--   b) admin spike:     SELECT count(*) ... WHERE reason=$1 GROUP BY date_trunc

CREATE INDEX IF NOT EXISTS verdict_reports_created_idx
  ON public.verdict_reports USING btree (created_at DESC);

CREATE INDEX IF NOT EXISTS verdict_reports_reason_created_idx
  ON public.verdict_reports USING btree (reason, created_at DESC);

CREATE INDEX IF NOT EXISTS verdict_reports_child_idx
  ON public.verdict_reports USING btree (child_id);

CREATE INDEX IF NOT EXISTS verdict_reports_scan_attempt_idx
  ON public.verdict_reports USING btree (scan_attempt_id);

-- ─── 4. RLS ────────────────────────────────────────────────────────────────
-- Parents can SELECT and INSERT only for their own children. The Edge
-- Function uses the service role and bypasses these — see report-verdict
-- index.ts for the parent-ownership check that guards the insert.

ALTER TABLE public.verdict_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "verdict_reports: parent reads own children" ON public.verdict_reports;
CREATE POLICY "verdict_reports: parent reads own children"
  ON public.verdict_reports
  FOR SELECT
  USING (
    child_id IN (
      SELECT child_profiles.id
      FROM public.child_profiles
      WHERE child_profiles.parent_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "verdict_reports: parent inserts own children" ON public.verdict_reports;
CREATE POLICY "verdict_reports: parent inserts own children"
  ON public.verdict_reports
  FOR INSERT
  WITH CHECK (
    parent_id = auth.uid()
    AND child_id IN (
      SELECT child_profiles.id
      FROM public.child_profiles
      WHERE child_profiles.parent_id = auth.uid()
    )
  );

-- ─── 5. Permissions ────────────────────────────────────────────────────────
-- authenticated role gets standard SELECT/INSERT (gated by RLS above).
-- service_role gets full access (Edge Function path).

GRANT SELECT, INSERT ON public.verdict_reports TO authenticated;
GRANT ALL            ON public.verdict_reports TO service_role;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- POST-MIGRATION CHECKLIST
-- ════════════════════════════════════════════════════════════════════════════
--
-- 1. Verify table created:
--      SELECT count(*) FROM verdict_reports;     -- expect 0
--
-- 2. Verify RLS active:
--      SELECT relname, relrowsecurity FROM pg_class WHERE relname = 'verdict_reports';
--      -- expect relrowsecurity = true
--
-- 3. Smoke-test as a logged-in parent (Supabase SQL Editor with JWT):
--      INSERT INTO verdict_reports (scan_attempt_id, child_id, parent_id, reason)
--      VALUES ('<your scan>', '<your child>', '<your parent uid>', 'wrong_object');
--      -- expect: 1 row inserted (RLS passes)
--
-- 4. Smoke-test as a different parent — INSERT for someone else's child should fail.
--
-- ════════════════════════════════════════════════════════════════════════════
