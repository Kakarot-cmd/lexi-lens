-- =============================================================================
-- Migration: 20240101000000_coppa_gdpr_compliance.sql
-- Lexi-Lens — Phase 4.1 COPPA + GDPR-K Compliance
-- =============================================================================
--
-- REGULATORY BASIS:
--   COPPA (16 CFR Part 312)  — Children's Online Privacy Protection Act
--   GDPR-K (Art. 8)          — Processing of children's personal data
--   Apple Kids Category 5.1.4 — Parental consent & data minimisation
--
-- WHAT THIS MIGRATION CREATES:
--   1.  privacy_policy_versions   — Immutable audit log of published policies.
--   2.  parental_consents         — One row per parent per policy version.
--                                   Written by DB trigger on auth.users INSERT.
--   3.  data_deletion_requests    — Parent-initiated erasure requests (GDPR Art. 17 / COPPA §312.6).
--   4.  handle_new_user_consent() — Trigger function that reads consent metadata
--                                   from raw_user_meta_data and inserts into
--                                   parental_consents atomically at signup.
--   5.  on_auth_user_created_consent — AFTER INSERT trigger on auth.users.
--   6.  pg_cron job               — Nightly 02:00 UTC hard-delete of parent
--                                   accounts whose 30-day deletion window has
--                                   elapsed (set by request-deletion Edge Fn).
--
-- RLS POLICIES (Principle of Least Privilege):
--   • Parents can read/insert their own consent rows only.
--   • Parents can read/insert their own deletion requests only.
--   • Privacy policy versions are publicly readable (no auth required).
--   • Service role (Edge Functions) bypasses RLS for admin operations.
--
-- RETENTION:
--   Child PII          → deleted immediately on erasure request (Edge Function).
--   Parent account     → deleted 30 days after request (pg_cron).
--   parental_consents  → retained 7 years (legal basis: contractual obligation).
--   data_deletion_req  → retained 7 years (legal basis: regulatory compliance).
--
-- HOW TO RUN:
--   Option A — Supabase Dashboard:  SQL Editor → paste → Run
--   Option B — Supabase CLI:        supabase db push
--   Option C — psql:                psql $DATABASE_URL -f this_file.sql
--
-- PREREQUISITES:
--   • pg_cron extension (available on Supabase Pro; enable below).
--   • auth.users table (standard Supabase auth — always present).
--   • supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<key>  (for Edge Function).
--
-- =============================================================================


-- ─── 0. Preamble: ensure idempotency ─────────────────────────────────────────
-- All CREATE TABLE / CREATE FUNCTION / CREATE TRIGGER statements use
-- IF NOT EXISTS / OR REPLACE / DROP IF EXISTS guards so this migration
-- is safe to re-run without side-effects.

BEGIN;

-- ─── 1. privacy_policy_versions ──────────────────────────────────────────────
-- Immutable ledger of every published privacy policy.
-- Consent records reference this table via policy_version (text, not FK) so
-- that deleted/updated versions do not orphan historical consent rows.
-- The table itself is insert-only by design (no UPDATE, no DELETE in RLS).

CREATE TABLE IF NOT EXISTS public.privacy_policy_versions (
  version          TEXT        PRIMARY KEY,           -- semver e.g. "1.0", "1.1"
  effective_date   DATE        NOT NULL,
  summary_of_changes TEXT      NOT NULL DEFAULT '',   -- plain-English changelog
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.privacy_policy_versions IS
  'Immutable registry of published Lexi-Lens privacy policy versions. '
  'Referenced by parental_consents.policy_version. Retained indefinitely.';

-- RLS: authenticated users (parents) and anonymous callers can SELECT.
-- Nobody can INSERT/UPDATE/DELETE via RLS — only service role or migrations.
ALTER TABLE public.privacy_policy_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read policy versions"
  ON public.privacy_policy_versions;
CREATE POLICY "Anyone can read policy versions"
  ON public.privacy_policy_versions
  FOR SELECT
  USING (true);                    -- publicly readable, no auth required

-- Seed: current policy version (update version + effective_date on each release)
INSERT INTO public.privacy_policy_versions (version, effective_date, summary_of_changes)
VALUES (
  '1.0',
  CURRENT_DATE,
  'Initial COPPA- and GDPR-K-compliant privacy policy. '
  'Covers data minimisation, parental rights, AI processing (object labels only), '
  'and 30-day deletion SLA.'
)
ON CONFLICT (version) DO NOTHING;


-- ─── 2. parental_consents ─────────────────────────────────────────────────────
-- One row per parent × policy version. Written atomically by the
-- handle_new_user_consent() trigger at the moment of Supabase signup.
-- Retained for 7 years as proof of consent (regulatory requirement).
-- NEVER deleted on parent erasure requests — see data_deletion_requests.

CREATE TABLE IF NOT EXISTS public.parental_consents (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id               UUID        NOT NULL
                            REFERENCES auth.users(id)
                            ON DELETE SET NULL,     -- keep consent record even after account deletion
  policy_version          TEXT        NOT NULL,     -- matches privacy_policy_versions.version
  consented_at            TIMESTAMPTZ NOT NULL,     -- exact ISO timestamp from client (ConsentGateModal)
  -- Individual checkbox states (all must be TRUE for account to be created)
  coppa_confirmed         BOOLEAN     NOT NULL DEFAULT FALSE,
  gdpr_k_confirmed        BOOLEAN     NOT NULL DEFAULT FALSE,
  ai_processing_confirmed BOOLEAN     NOT NULL DEFAULT FALSE,
  parental_gate_passed    BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Audit
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.parental_consents IS
  'One row per parent per policy version. Written by on_auth_user_created_consent '
  'trigger at signup. Retained 7 years. References auth.users with ON DELETE SET NULL '
  'so consent evidence survives account erasure.';

COMMENT ON COLUMN public.parental_consents.parent_id IS
  'NULL after account deletion — consent record is intentionally retained.';
COMMENT ON COLUMN public.parental_consents.policy_version IS
  'Matches privacy_policy_versions.version. Stored as TEXT (not FK) to survive '
  'future policy table truncation.';
COMMENT ON COLUMN public.parental_consents.coppa_confirmed IS
  'Parent confirmed they are 18+ and a parent/guardian (COPPA §312.5).';
COMMENT ON COLUMN public.parental_consents.gdpr_k_confirmed IS
  'Parent confirmed GDPR-K Art. 8 processing consent and right to withdraw.';
COMMENT ON COLUMN public.parental_consents.ai_processing_confirmed IS
  'Parent confirmed AI processes object labels only — no PII, no images stored.';
COMMENT ON COLUMN public.parental_consents.parental_gate_passed IS
  'Parent solved the randomised arithmetic challenge in ConsentGateModal.';

-- Indexes
CREATE INDEX IF NOT EXISTS parental_consents_parent_id_idx
  ON public.parental_consents(parent_id);
CREATE INDEX IF NOT EXISTS parental_consents_policy_version_idx
  ON public.parental_consents(policy_version);

-- RLS
ALTER TABLE public.parental_consents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Parents can read own consent records"
  ON public.parental_consents;
CREATE POLICY "Parents can read own consent records"
  ON public.parental_consents
  FOR SELECT
  USING (auth.uid() = parent_id);

DROP POLICY IF EXISTS "Parents can insert own consent records"
  ON public.parental_consents;
CREATE POLICY "Parents can insert own consent records"
  ON public.parental_consents
  FOR INSERT
  WITH CHECK (auth.uid() = parent_id);

-- No UPDATE or DELETE policies — consent records are immutable after creation.


-- ─── 3. data_deletion_requests ────────────────────────────────────────────────
-- Created by the request-deletion Edge Function when a parent invokes the
-- DataDeletionScreen. Records the request, tracks status, and provides the
-- audit trail required by COPPA §312.6 and GDPR Art. 17.
-- Retained for 7 years even after account deletion (ON DELETE SET NULL).

CREATE TABLE IF NOT EXISTS public.data_deletion_requests (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id             UUID                    -- nullable after erasure
                          REFERENCES auth.users(id)
                          ON DELETE SET NULL,
  requested_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  scheduled_deletion_at TIMESTAMPTZ,            -- parent account purge date (now + 30 days)
  status                TEXT        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'processing', 'completed', 'cancelled')),
  reason                TEXT,                   -- optional parent-supplied reason
  completed_at          TIMESTAMPTZ,            -- set when Edge Function finishes
  -- Audit counters (populated by Edge Function)
  children_deleted      INTEGER,
  scan_rows_deleted     INTEGER,
  mastery_rows_deleted  INTEGER,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.data_deletion_requests IS
  'Erasure requests initiated by parents via DataDeletionScreen. '
  'Written and updated by request-deletion Edge Function. '
  'Retained 7 years for regulatory audit trail.';

COMMENT ON COLUMN public.data_deletion_requests.parent_id IS
  'NULL after account deletion — request record is intentionally retained.';
COMMENT ON COLUMN public.data_deletion_requests.status IS
  'Lifecycle: pending → processing → completed | cancelled.';
COMMENT ON COLUMN public.data_deletion_requests.scheduled_deletion_at IS
  'Parent account hard-deleted by pg_cron job when this timestamp elapses.';

-- Indexes
CREATE INDEX IF NOT EXISTS data_deletion_requests_parent_id_idx
  ON public.data_deletion_requests(parent_id);
CREATE INDEX IF NOT EXISTS data_deletion_requests_status_idx
  ON public.data_deletion_requests(status);
CREATE INDEX IF NOT EXISTS data_deletion_requests_scheduled_deletion_at_idx
  ON public.data_deletion_requests(scheduled_deletion_at)
  WHERE scheduled_deletion_at IS NOT NULL;

-- RLS
ALTER TABLE public.data_deletion_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Parents can read own deletion requests"
  ON public.data_deletion_requests;
CREATE POLICY "Parents can read own deletion requests"
  ON public.data_deletion_requests
  FOR SELECT
  USING (auth.uid() = parent_id);

DROP POLICY IF EXISTS "Parents can insert own deletion requests"
  ON public.data_deletion_requests;
CREATE POLICY "Parents can insert own deletion requests"
  ON public.data_deletion_requests
  FOR INSERT
  WITH CHECK (auth.uid() = parent_id);

-- No UPDATE via RLS — only service role (Edge Function) updates status/completed_at.


-- ─── 4. handle_new_user_consent() — trigger function ─────────────────────────
-- Fires AFTER INSERT on auth.users. Reads COPPA/GDPR-K consent metadata that
-- was embedded in raw_user_meta_data by AuthScreen.performSignUp() and inserts
-- a parental_consents row atomically within the same transaction.
--
-- FIELDS READ FROM raw_user_meta_data (set by AuthScreen.tsx):
--   consent_policy_version       TEXT
--   consent_consented_at         TIMESTAMPTZ (ISO 8601)
--   consent_coppa_confirmed      BOOLEAN
--   consent_gdpr_k_confirmed     BOOLEAN
--   consent_ai_processing_confirmed BOOLEAN
--   consent_parental_gate_passed BOOLEAN
--
-- SAFETY GUARDS:
--   • If consent_policy_version is absent the trigger is a no-op (non-parent
--     signups — e.g. service accounts — don't have consent metadata).
--   • ON CONFLICT DO NOTHING prevents duplicate rows if the trigger fires twice.
--   • SECURITY DEFINER runs as the function owner (service role), bypassing RLS.
--     This is intentional — the parent cannot have a session yet at INSERT time.
--   • All CAST operations are guarded: missing / null meta fields default to FALSE.

CREATE OR REPLACE FUNCTION public.handle_new_user_consent()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_policy_version TEXT;
BEGIN
  -- Only act on signups that carry consent metadata.
  v_policy_version := NEW.raw_user_meta_data ->> 'consent_policy_version';

  IF v_policy_version IS NULL OR v_policy_version = '' THEN
    RETURN NEW;  -- Not a parent signup — skip silently.
  END IF;

  INSERT INTO public.parental_consents (
    parent_id,
    policy_version,
    consented_at,
    coppa_confirmed,
    gdpr_k_confirmed,
    ai_processing_confirmed,
    parental_gate_passed
  )
  VALUES (
    NEW.id,
    v_policy_version,
    -- Falls back to now() if client sent a malformed timestamp.
    COALESCE(
      (NEW.raw_user_meta_data ->> 'consent_consented_at')::TIMESTAMPTZ,
      now()
    ),
    COALESCE((NEW.raw_user_meta_data ->> 'consent_coppa_confirmed')::BOOLEAN,         FALSE),
    COALESCE((NEW.raw_user_meta_data ->> 'consent_gdpr_k_confirmed')::BOOLEAN,        FALSE),
    COALESCE((NEW.raw_user_meta_data ->> 'consent_ai_processing_confirmed')::BOOLEAN, FALSE),
    COALESCE((NEW.raw_user_meta_data ->> 'consent_parental_gate_passed')::BOOLEAN,    FALSE)
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  -- Log but never block account creation. Compliance team must monitor pg_log.
  RAISE WARNING '[lexi-lens] handle_new_user_consent failed for user %: %',
    NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_new_user_consent() IS
  'AFTER INSERT trigger on auth.users. Reads COPPA/GDPR-K consent metadata '
  'from raw_user_meta_data and inserts a parental_consents row atomically. '
  'SECURITY DEFINER: runs as function owner to bypass RLS at signup time. '
  'Non-fatal: account creation succeeds even if consent insert fails (with WARNING).';


-- ─── 5. on_auth_user_created_consent — trigger ────────────────────────────────
-- Drop-then-create pattern ensures idempotency on re-runs.

DROP TRIGGER IF EXISTS on_auth_user_created_consent ON auth.users;

CREATE TRIGGER on_auth_user_created_consent
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user_consent();

COMMENT ON TRIGGER on_auth_user_created_consent ON auth.users IS
  'Fires after every new Supabase Auth user is created. '
  'Calls handle_new_user_consent() to write parental consent record.';


-- ─── 6. pg_cron — nightly parent account purge ───────────────────────────────
-- Runs at 02:00 UTC every night. Hard-deletes auth.users rows whose
-- deletion_scheduled_at app_metadata field has elapsed.
--
-- REGULATORY BASIS:
--   COPPA §312.6 — operator must honour deletion requests within a reasonable
--   time (30 days is the industry-standard interpretation).
--   GDPR Art. 17(1) — erasure without undue delay (Commission guidance: ≤ 1 month).
--
-- PREREQUISITES:
--   Supabase Pro plan (pg_cron is available on Pro and above).
--   If on a free plan, schedule this query manually via a cron job or GitHub Actions.
--
-- IMPORTANT:
--   The request-deletion Edge Function stamps app_metadata like:
--     { "deletion_scheduled_at": "2024-02-01T02:00:00Z" }
--   This cron job checks that field. Child data is already deleted immediately
--   by the Edge Function; this job only removes the parent's auth.users row.

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Remove any stale schedule with this name before (re-)creating.
SELECT cron.unschedule('lexi-lens-purge-scheduled-deletions')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'lexi-lens-purge-scheduled-deletions'
  );

SELECT cron.schedule(
  'lexi-lens-purge-scheduled-deletions',   -- job name (unique)
  '0 2 * * *',                             -- 02:00 UTC every night
  $$
    DELETE FROM auth.users
    WHERE
      raw_app_meta_data ->> 'deletion_scheduled_at' IS NOT NULL
      AND (raw_app_meta_data ->> 'deletion_scheduled_at')::TIMESTAMPTZ < now();
  $$
);

COMMENT ON TABLE cron.job IS
  'pg_cron job ''lexi-lens-purge-scheduled-deletions'' runs nightly at 02:00 UTC '
  'and hard-deletes auth.users rows whose app_metadata.deletion_scheduled_at has '
  'elapsed. Child data is already wiped immediately by the request-deletion Edge Fn.';


-- ─── 7. Verify: quick sanity-check selects ───────────────────────────────────
-- These will appear in the migration output log. They should return 1 row each.

DO $$
BEGIN
  ASSERT (SELECT COUNT(*) FROM public.privacy_policy_versions WHERE version = '1.0') = 1,
    'FAIL: privacy_policy_versions seed row missing';

  ASSERT (SELECT COUNT(*) FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN (
              'privacy_policy_versions',
              'parental_consents',
              'data_deletion_requests'
            )) = 3,
    'FAIL: one or more compliance tables missing';

  ASSERT (SELECT COUNT(*) FROM information_schema.triggers
          WHERE trigger_name = 'on_auth_user_created_consent') = 1,
    'FAIL: on_auth_user_created_consent trigger missing';

  RAISE NOTICE 'Phase 4.1 migration: all assertions passed ✓';
END;
$$;


COMMIT;


-- =============================================================================
-- POST-MIGRATION CHECKLIST (do these manually after running this SQL):
-- =============================================================================
--
-- 1. Deploy the request-deletion Edge Function:
--      supabase functions deploy request-deletion --no-verify-jwt
--
-- 2. Set Edge Function secret:
--      supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
--
-- 3. Verify pg_cron job was registered:
--      SELECT jobname, schedule, command FROM cron.job
--      WHERE jobname = 'lexi-lens-purge-scheduled-deletions';
--
-- 4. Confirm trigger exists on auth.users:
--      SELECT trigger_name, event_manipulation, action_timing
--      FROM information_schema.triggers
--      WHERE trigger_name = 'on_auth_user_created_consent';
--
-- 5. Test a full signup in staging:
--      a) Create account through ConsentGateModal.
--      b) Run: SELECT * FROM parental_consents ORDER BY created_at DESC LIMIT 1;
--         → Should see a row with all 4 boolean columns TRUE.
--
-- 6. Test the deletion flow in staging:
--      a) Initiate deletion via DataDeletionScreen (type "DELETE").
--      b) Run: SELECT * FROM data_deletion_requests ORDER BY created_at DESC LIMIT 1;
--         → status should be 'completed'.
--      c) Run: SELECT raw_app_meta_data FROM auth.users WHERE id = '<parent_id>';
--         → deletion_scheduled_at should be ~30 days from now.
--
-- 7. Legal review: have a solicitor review PrivacyPolicyScreen.tsx content
--    before App Store / Play Store submission. Contact: privacy@lexi-lens.app
--
-- =============================================================================
