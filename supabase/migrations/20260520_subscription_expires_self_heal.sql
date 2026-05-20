-- supabase/migrations/20260520_subscription_expires_self_heal.sql
-- Lexi-Lens — server-side entitlement expiration tracking + inline self-heal.
--
-- Why this exists
-- ───────────────
-- The system was previously entirely event-driven: parent_has_premium() and
-- the quests RLS tier gate both consulted ONLY parents.subscription_tier,
-- which is updated solely by RC webhook events (revenuecat-webhook fn). If
-- an EXPIRATION webhook is delayed, dropped, partitioned, or simply never
-- arrives (RC outage, our function 5xx-storming, Apple/Google upstream
-- delays), a lapsed paying user retains premium with no self-healing path.
-- "Trust the webhook absolutely" is a defensible posture but it's a
-- choice-by-omission today, not a deliberate decision.
--
-- What this migration does
-- ────────────────────────
--   1. parents.subscription_expires_at  (new NULLABLE timestamptz column)
--      Written by the RC webhook on every entitlement event (grant /
--      revoke / billing-issue-grace). NULL = legacy parent (pre-this-
--      migration) — passes through the gate so we don't auto-revoke
--      existing testers. Once their next webhook fires, they get a
--      concrete expiration and join the self-heal pool.
--
--   2. parent_has_premium(p_parent_id uuid) RPC — adds the time check:
--          AND (subscription_expires_at IS NULL OR subscription_expires_at > now())
--      This is the inline self-heal. Every feature gate that uses this
--      RPC (consume_feature_quota, etc.) now auto-revokes lapsed parents
--      with zero latency, no cron required.
--
--   3. quests_select_with_tier_gate RLS policy — same time check pushed
--      in, so the read-side gate also self-heals. (Otherwise an expired
--      tier1 parent could still SEE tier-gated quest content even though
--      every action gate would correctly block them.)
--
-- What this migration does NOT do
-- ───────────────────────────────
-- We deliberately add ONLY subscription_expires_at, not the wider
-- {subscription_status, subscription_renews_at} suggested in v2.1 audit
-- notes. Reasoning:
--   • subscription_status — derivable from (tier, expires_at, last event
--     in revenuecat_webhook_log). Adding it would double the webhook's
--     write surface for no architectural gain pre-launch. Revisit when
--     we have a real analytics need ("how many parents in grace right
--     now?").
--   • subscription_renews_at — equal to subscription_expires_at on
--     auto-renewing subscriptions. Pure UI sugar. Revisit if/when we
--     ship a "your subscription renews on X" parent-side surface.
--
-- Backfill
-- ────────
-- None executed here. Existing premium parents will have NULL
-- subscription_expires_at until their next RC event (RENEWAL is normally
-- monthly/annual so the wait is bounded). The NULL fallthrough in the
-- RPC and RLS policy means they retain entitlement during the gap.
-- Post-PROD-data: if we ever need to force-backfill, hit RC's
-- GET /v1/subscribers/{app_user_id} for each tier!=free parent and
-- populate from the subscription object's expires_date. Out of scope
-- for now (no PROD users yet).
--
-- Companion webhook deploy
-- ────────────────────────
-- This migration is INERT until supabase/functions/revenuecat-webhook is
-- redeployed with the matching change (writes subscription_expires_at on
-- grant/revoke; writes grace_period_expiration_at_ms on BILLING_ISSUE).
-- Deploy order MUST be: migration FIRST, function SECOND. The function
-- deploy will fail closed if the column is missing (Postgres rejects the
-- UPDATE), which is the safe direction.

BEGIN;

-- ─── 1. Add subscription_expires_at column ─────────────────────────────────

ALTER TABLE public.parents
  ADD COLUMN IF NOT EXISTS subscription_expires_at timestamptz;

COMMENT ON COLUMN public.parents.subscription_expires_at IS
  'Server-side mirror of the RC subscription expiration (or grace-period '
  'end during BILLING_ISSUE). Written by revenuecat-webhook on every '
  'entitlement event. Used by parent_has_premium() and the quests RLS '
  'tier gate as a self-heal: if this is in the past, the parent loses '
  'entitlement without waiting for the (possibly delayed) EXPIRATION '
  'webhook. NULL = legacy parent pre-2026-05-20; treated as pass-through '
  'until their next webhook lands a concrete value.';

-- ─── 2. Rewrite parent_has_premium with inline self-heal ───────────────────

CREATE OR REPLACE FUNCTION public.parent_has_premium(p_parent_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT COALESCE(
    (SELECT public.is_paid_tier(p.subscription_tier)
        AND (p.subscription_expires_at IS NULL
             OR p.subscription_expires_at > now())
       FROM public.parents p
      WHERE p.id = p_parent_id),
    false
  );
$$;

COMMENT ON FUNCTION public.parent_has_premium(uuid) IS
  'True iff the parent currently has premium entitlement, with inline '
  'self-heal: a paid tier AND a non-expired subscription_expires_at (or '
  'NULL, treated as pass-through for legacy parents). Wraps is_paid_tier '
  'so paid|tier1|tier2|family all count. Returns false for unknown '
  'parents (fail closed — this is an entitlement control). Single source '
  'of truth for every feature-side gate (consume_feature_quota etc.).';

-- ─── 3. Rewrite quests_select_with_tier_gate RLS with self-heal ────────────
--
-- Pre-migration the read gate was time-blind: an expired tier1 parent
-- could still SELECT tier-gated quest rows. Action gates (feature_quota
-- etc.) would still correctly block them, but exposing the content in
-- the UI of someone whose subscription has lapsed is the wrong default.
-- We push the same time check into the RLS USING clause.

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
           AND (p.subscription_expires_at IS NULL
                OR p.subscription_expires_at > now())
      )
    )
  );

COMMENT ON POLICY quests_select_with_tier_gate ON public.quests IS
  'v6.3.1 + self-heal (2026-05-20). SELECT gate: authenticated users see '
  'active public quests OR ones they created. Paid-tier quests require '
  'parent to pass is_paid_tier() AND have a non-expired '
  'subscription_expires_at (or NULL for legacy pre-self-heal parents). '
  'Matches parent_has_premium semantics so read-side and action-side '
  'gates self-heal together if a webhook drops.';

COMMIT;

-- ─── 4. Verification ───────────────────────────────────────────────────────
--
-- Run as plain SQL after migration to confirm shape.

DO $verify$
DECLARE
  v_col_exists            boolean;
  v_rpc_uses_expires      boolean;
  v_policy_uses_expires   boolean;
BEGIN
  -- Column exists
  SELECT EXISTS(
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'parents'
       AND column_name  = 'subscription_expires_at'
  ) INTO v_col_exists;

  -- RPC body references subscription_expires_at
  SELECT EXISTS(
    SELECT 1 FROM pg_proc
     WHERE proname     = 'parent_has_premium'
       AND pronamespace = 'public'::regnamespace
       AND prosrc LIKE '%subscription_expires_at%'
  ) INTO v_rpc_uses_expires;

  -- Policy USING clause references subscription_expires_at
  SELECT EXISTS(
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'quests'
       AND policyname = 'quests_select_with_tier_gate'
       AND qual LIKE '%subscription_expires_at%'
  ) INTO v_policy_uses_expires;

  RAISE NOTICE
    '20260520 self_heal: col=% rpc=% policy=%',
    v_col_exists, v_rpc_uses_expires, v_policy_uses_expires;

  IF NOT (v_col_exists AND v_rpc_uses_expires AND v_policy_uses_expires) THEN
    RAISE EXCEPTION
      'Self-heal migration verification failed. col=% rpc=% policy=%',
      v_col_exists, v_rpc_uses_expires, v_policy_uses_expires;
  END IF;
END
$verify$;

-- ─── 5. Manual probes (commented for reference) ────────────────────────────
--
-- After deploying both migration and updated webhook:
--
--   -- Drift sensor (cron candidate; OBSERVABILITY only — not self-heal):
--   SELECT id, subscription_tier, subscription_expires_at, last_rc_event_ts_ms
--     FROM public.parents
--    WHERE subscription_tier <> 'free'
--      AND subscription_expires_at IS NOT NULL
--      AND subscription_expires_at < now() - interval '1 day';
--
--   -- Force-revoke a stale tester (rare; usually webhook handles it):
--   UPDATE public.parents
--      SET subscription_tier        = 'free',
--          last_rc_event_ts_ms      = NULL
--    WHERE id = '<parent-uuid>';
--
--   -- Spot-check the gate for a parent:
--   SELECT public.parent_has_premium('<parent-uuid>'::uuid);
