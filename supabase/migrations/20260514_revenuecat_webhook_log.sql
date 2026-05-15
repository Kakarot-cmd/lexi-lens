-- ============================================================================
-- 20260514_revenuecat_webhook_log.sql
-- Lexi-Lens — Phase 4.4 RevenueCat webhook idempotency log.
--
-- ─── What this migration does ──────────────────────────────────────────────
--
-- Creates public.revenuecat_webhook_log — a small append-only log used by the
-- revenuecat-webhook Edge Function to deduplicate retried events.
--
-- RC retries webhooks on non-2xx responses for up to ~24h. Without an
-- idempotency check, a retried INITIAL_PURCHASE would re-apply tier changes;
-- a retried EXPIRATION followed by a RENEWAL with reordering could flap a
-- parent free→paid→free incorrectly. The log catches all of this.
--
-- ─── Schema ────────────────────────────────────────────────────────────────
--
--   event_id         — RC's UUID for this event. PRIMARY KEY. Webhook upserts
--                      with ON CONFLICT DO NOTHING; if the row already exists,
--                      the event is a duplicate and is short-circuited.
--   event_type       — INITIAL_PURCHASE, RENEWAL, EXPIRATION, etc. Indexed for
--                      operational queries like "how many BILLING_ISSUE events
--                      this week".
--   app_user_id      — the RC app_user_id (= Supabase parent UUID in our setup,
--                      but stored as text since RC may also send anonymous IDs
--                      like `$RCAnonymousID:...`).
--   product_id       — store product identifier (lexilens_premium_monthly, etc).
--   received_at      — when the webhook arrived (set by DEFAULT now()).
--   processed_at     — when the webhook handler finished processing this event.
--                      NULL means the handler crashed mid-processing — useful
--                      for forensics if we ever see ghost rows.
--   processing_note  — short status like "applied:tier1", "ignored",
--                      "duplicate", "anonymous_user". Aids debugging without
--                      having to re-parse raw_payload.
--   raw_payload      — entire webhook body. Stored for debugging and audit.
--                      Don't index. Don't query at high volume — for forensics
--                      only.
--
-- ─── Retention ─────────────────────────────────────────────────────────────
--
-- For now: keep everything. Volume is bounded by purchase activity (orders
-- of magnitude lower than scan_attempts). At 10k MAU with 5% paid and
-- monthly events ≈ 500/month, the table grows ~6k rows/year. Not worth
-- auto-purging until 100k rows / 1 year of data.
--
-- ─── RLS ───────────────────────────────────────────────────────────────────
--
-- Webhook uses the service role key (bypasses RLS). No client should ever
-- read this table. We enable RLS with NO policies → effectively locked to
-- service role only.
--
-- ─── Apply ─────────────────────────────────────────────────────────────────
--
--   supabase db push                 (or run SQL via Dashboard)
--
-- The webhook Edge Function will fail with "table not found" if deployed
-- before this migration applies. Apply migration BEFORE deploying the
-- function.
-- ============================================================================

BEGIN;

-- ─── 1. Table ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.revenuecat_webhook_log (
  event_id         text        PRIMARY KEY,
  event_type       text        NOT NULL,
  app_user_id      text,
  product_id       text,
  received_at      timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  processing_note  text,
  raw_payload      jsonb       NOT NULL
);

COMMENT ON TABLE public.revenuecat_webhook_log IS
  'RevenueCat webhook idempotency log (Phase 4.4). Append-only. event_id is '
  'the dedupe key — the webhook function upserts with ON CONFLICT DO NOTHING '
  'to skip duplicate retries.';

COMMENT ON COLUMN public.revenuecat_webhook_log.processing_note IS
  'Short status for forensics. Values: applied:<tier>, ignored, duplicate, '
  'anonymous_user, no_parent_row, no_user, unknown_type, transfer:<tier>.';

-- ─── 2. Indexes ────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS revenuecat_webhook_log_event_type_idx
  ON public.revenuecat_webhook_log (event_type, received_at DESC);

CREATE INDEX IF NOT EXISTS revenuecat_webhook_log_app_user_idx
  ON public.revenuecat_webhook_log (app_user_id, received_at DESC)
  WHERE app_user_id IS NOT NULL;

-- ─── 3. RLS — service role only ────────────────────────────────────────────

ALTER TABLE public.revenuecat_webhook_log ENABLE ROW LEVEL SECURITY;

-- No policies defined = no role except service role can read or write.
-- Re-confirm by selecting as authenticated user → 0 rows.

-- ─── 4. Verification queries (run manually after apply) ────────────────────
--
--   -- 1. Table is in place:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name = 'revenuecat_webhook_log';
--
--   -- 2. Indexes:
--   SELECT indexname, indexdef
--   FROM pg_indexes
--   WHERE schemaname = 'public' AND tablename = 'revenuecat_webhook_log';
--
--   -- 3. RLS enabled + zero policies:
--   SELECT relrowsecurity, relforcerowsecurity
--   FROM pg_class WHERE relname = 'revenuecat_webhook_log';
--   -- expect: true, false
--   SELECT count(*) FROM pg_policy
--   WHERE polrelid = 'public.revenuecat_webhook_log'::regclass;
--   -- expect: 0
--
--   -- 4. Insert a test row as service role and confirm anonymous can't see it:
--   --    (run this via the dashboard SQL editor as service role)
--   INSERT INTO public.revenuecat_webhook_log
--     (event_id, event_type, app_user_id, product_id, raw_payload)
--   VALUES ('test-' || gen_random_uuid(), 'TEST', NULL, NULL, '{}'::jsonb);
--   -- then as authenticated:
--   SELECT count(*) FROM public.revenuecat_webhook_log;
--   -- expect: 0 (RLS blocks)

COMMIT;
