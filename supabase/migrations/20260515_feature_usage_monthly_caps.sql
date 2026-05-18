-- ============================================================================
-- 20260515_feature_usage_monthly_caps.sql
-- Lexi-Lens — access + usage control for the two user-triggered AI features
-- that previously had NO gating of any kind:
--
--   • generate-quest    (parent taps "Generate" custom quest)
--   • export-word-tome  (parent taps "Export PDF" portfolio)
--
-- This single migration delivers THREE coordinated controls. All are
-- SQL-tunable via feature_flags (≈60s propagation, no redeploy):
--
--   1. PAID-ONLY GATE   — both features become premium-only (the product
--                          decision from this session).
--   2. FREE-TASTE GRANT — an optional small lifetime allowance for free
--                          users, OFF by default (grant = 0). This is the
--                          conversion-safety valve (see the long note below).
--   3. MONTHLY CAP      — a per-parent monthly ceiling that still applies
--                          *to paid users* as an abuse / cost brake.
--
-- ─── Why a new table and NOT tier_config ───────────────────────────────────
--
-- tier_config is keyed by `tier` and is read on the hot scan path with a
-- tight cache + a CHECK(primary_calls_per_day <= cap_scans_per_day)
-- invariant. These monthly controls are (a) not per-tier (the cap is flat),
-- (b) not on the scan path, and (c) need a per-PARENT counter, not a
-- per-tier constant. Bolting them onto tier_config couples unrelated
-- concerns and risks the scan loop. The established knob pattern here is
-- feature_flags + getNumericFlag(); the cap *values* live there, and the
-- per-parent *counter* gets its own tiny table.
--
-- ─── The paid-only decision — and the conversion caveat (READ THIS) ─────────
--
-- export-word-tome paid-only: unambiguously right. A polished PDF portfolio
-- is a classic premium artifact, parent-facing, off the core loop.
--
-- generate-quest fully paid-only: implemented as requested, but flagged.
-- The custom-quest generator is the single strongest "aha" that converts a
-- free parent ("I typed dinosaurs and it built a dinosaur dungeon"). Hard-
-- locking it means free users never feel the thing that makes them pay —
-- you hide your best sales pitch behind the paywall.
--
-- The reversible hedge: generate_quest_free_lifetime_grant. Default 0
-- (= pure paid-only, exactly as asked). Set it to e.g. 2 and free users get
-- 2 custom quests EVER, then the wall — they've felt the magic, the paywall
-- lands when they want MORE, not when they want ANY. That is almost
-- certainly the higher-converting model, but it should be an A/B decision
-- once PROD funnel data exists, not a guess now. The flag exists so that
-- A/B is a one-line SQL UPDATE, no redeploy, no code change. RECOMMENDATION:
-- ship with grant=0 as requested; revisit grant=1..3 the moment you have
-- real free→paid funnel numbers.
--
-- export_word_tome_free_lifetime_grant also exists, default 0. Recommend
-- leaving it 0 — a PDF export has no "taste" value the way a generated
-- quest does, so a free sample mostly just costs a Haiku call.
--
-- ─── Correctness: the paid check MUST use is_paid_tier() ────────────────────
--
-- parents.subscription_tier can be 'free' | 'paid' | 'tier1' | 'tier2' |
-- 'family'. A naive subscription_tier = 'paid' check would WRONGLY lock out
-- every tier1/tier2/family parent — the exact foot-gun that
-- 20260512_routing_v6_3_followup_paid_tier.sql was written to fix. The
-- canonical predicate is public.is_paid_tier(t) → true for
-- paid|tier1|tier2|family. The Edge Functions call a thin RPC
-- (parent_has_premium) that wraps it, so the gate stays correct even if the
-- tier vocabulary changes again.
--
-- ─── Monthly cap still applies to paid ──────────────────────────────────────
--
-- Paid-only does not mean unlimited. A flat monthly ceiling per parent
-- remains as an abuse/cost brake (15 quests, 12 exports — generous; a real
-- parent rarely exceeds 3–4). 15 is calibrated for generate-quest ON HAIKU;
-- if it moves to Gemini (~20x cheaper) the cap is then purely an abuse brake
-- and can rise to 30–50 via the same flag.
--
-- ─── Reversibility ─────────────────────────────────────────────────────────
--
-- Fully additive. To disable paid-only: set <feature>_premium_only = false.
-- To disable the cap: set <feature>_monthly_cap = 100000. To remove
-- entirely: DROP TABLE feature_usage_monthly + DELETE the flag rows. The
-- Edge Function guards FAIL OPEN on any internal error (a counter/flag DB
-- hiccup never blocks a legitimate parent) — but the PAID gate fails CLOSED
-- by design (an unverifiable caller is treated as not-premium) since it is
-- an entitlement control, not a cost brake.
-- ============================================================================

BEGIN;

-- ─── 1. Per-parent monthly usage counter ────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.feature_usage_monthly (
  parent_id    uuid        NOT NULL
                 REFERENCES auth.users(id) ON DELETE CASCADE,

  feature_key  text        NOT NULL
                 CHECK (feature_key IN ('generate_quest', 'export_word_tome')),

  -- First day of the UTC month. e.g. 2026-05-01 for May 2026. Used for the
  -- monthly cap window (resets at UTC month boundary, no cron).
  period_month date        NOT NULL,

  usage_count  integer     NOT NULL DEFAULT 0 CHECK (usage_count >= 0),

  -- Lifetime total across ALL months for this (parent, feature). Drives the
  -- free-taste grant ("2 ever"), which must NOT reset monthly.
  lifetime_count integer   NOT NULL DEFAULT 0 CHECK (lifetime_count >= 0),

  updated_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (parent_id, feature_key, period_month)
);

COMMENT ON TABLE public.feature_usage_monthly IS
  'Per-parent, per-feature usage counters for user-triggered AI Edge '
  'Functions. usage_count is the current-UTC-month tally (monthly cap). '
  'lifetime_count is the all-time tally (free-taste grant). Service role '
  'only; no client reads or writes this directly.';

CREATE INDEX IF NOT EXISTS feature_usage_monthly_period_idx
  ON public.feature_usage_monthly (period_month);

-- ─── 2. Premium check RPC (wraps is_paid_tier — single source of truth) ─────

CREATE OR REPLACE FUNCTION public.parent_has_premium(p_parent_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT COALESCE(
    (SELECT public.is_paid_tier(p.subscription_tier)
       FROM public.parents p
      WHERE p.id = p_parent_id),
    false
  );
$$;

COMMENT ON FUNCTION public.parent_has_premium(uuid) IS
  'True iff the parent currently has premium entitlement. Wraps '
  'is_paid_tier() so paid|tier1|tier2|family all count and the gate stays '
  'correct if the tier vocabulary changes. Returns false for unknown '
  'parents (fail closed — this is an entitlement control).';

-- ─── 3. Atomic access-decision RPC ──────────────────────────────────────────
--
-- One round-trip. Resolves: premium status, free-taste grant remaining,
-- monthly cap. Increments BOTH counters only when the call is allowed and
-- under cap. Returns a structured decision so the Edge Function can pick the
-- right HTTP status + message without extra queries.
--
-- decision values:
--   'allow'           → proceed (counters incremented)
--   'need_premium'    → not premium AND free grant exhausted → 402-ish
--   'monthly_cap'     → premium but hit the monthly ceiling   → 429
--
-- A blocked call does NOT increment (no counter inflation under hammering).

CREATE OR REPLACE FUNCTION public.consume_feature_quota(
  p_parent_id      uuid,
  p_feature_key    text,
  p_monthly_cap    integer,
  p_free_grant     integer
)
RETURNS TABLE(decision text, month_used integer, lifetime_used integer, monthly_cap integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_period   date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  v_premium  boolean;
  v_month    integer;
  v_life     integer;
BEGIN
  v_premium := public.parent_has_premium(p_parent_id);

  -- Ensure a row exists for this (parent, feature, month), then lock it.
  INSERT INTO public.feature_usage_monthly
    (parent_id, feature_key, period_month, usage_count, lifetime_count)
  VALUES (p_parent_id, p_feature_key, v_period, 0,
          COALESCE((SELECT max(lifetime_count)
                      FROM public.feature_usage_monthly
                     WHERE parent_id = p_parent_id
                       AND feature_key = p_feature_key), 0))
  ON CONFLICT (parent_id, feature_key, period_month) DO NOTHING;

  SELECT usage_count, lifetime_count INTO v_month, v_life
  FROM public.feature_usage_monthly
  WHERE parent_id    = p_parent_id
    AND feature_key  = p_feature_key
    AND period_month = v_period
  FOR UPDATE;

  -- Gate 1: entitlement. Non-premium may proceed only while the lifetime
  -- free-taste grant is not yet exhausted.
  IF NOT v_premium AND v_life >= GREATEST(p_free_grant, 0) THEN
    RETURN QUERY SELECT 'need_premium', v_month, v_life, p_monthly_cap;
    RETURN;
  END IF;

  -- Gate 2: monthly cap (applies to premium AND to free-taste users).
  IF v_month >= p_monthly_cap THEN
    RETURN QUERY SELECT 'monthly_cap', v_month, v_life, p_monthly_cap;
    RETURN;
  END IF;

  UPDATE public.feature_usage_monthly
  SET usage_count    = usage_count + 1,
      lifetime_count = lifetime_count + 1,
      updated_at     = now()
  WHERE parent_id    = p_parent_id
    AND feature_key  = p_feature_key
    AND period_month = v_period
  RETURNING usage_count, lifetime_count INTO v_month, v_life;

  RETURN QUERY SELECT 'allow', v_month, v_life, p_monthly_cap;
END;
$$;

COMMENT ON FUNCTION public.consume_feature_quota(uuid, text, integer, integer) IS
  'Atomic access decision + dual-counter increment for the gated AI '
  'features. decision ∈ {allow, need_premium, monthly_cap}. Increments only '
  'on allow. Service role only.';

-- ─── 4. Optional housekeeping ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.prune_feature_usage_monthly(p_keep_months integer DEFAULT 6)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_cutoff  date := (date_trunc('month', now() AT TIME ZONE 'UTC')
                      - (GREATEST(p_keep_months, 1) || ' months')::interval)::date;
  v_deleted integer;
BEGIN
  -- NOTE: pruning old months also discards the lifetime tally carried on
  -- those rows. Keep p_keep_months generous, or skip pruning entirely —
  -- rows are tiny. (Lifetime is reconstructed via max() on insert, so as
  -- long as ANY row for the pair survives, the grant accounting holds.)
  DELETE FROM public.feature_usage_monthly fum
  WHERE fum.period_month < v_cutoff
    AND EXISTS (  -- never delete the last surviving row for a (parent,feature)
      SELECT 1 FROM public.feature_usage_monthly o
      WHERE o.parent_id = fum.parent_id
        AND o.feature_key = fum.feature_key
        AND o.period_month >= v_cutoff
    );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION public.prune_feature_usage_monthly(integer) IS
  'Manual housekeeping. Deletes feature_usage_monthly rows older than '
  'p_keep_months, but never the last surviving row for a (parent,feature) '
  'pair so the lifetime free-grant tally is preserved. Not cron-wired.';

-- ─── 5. RLS — service role only ─────────────────────────────────────────────

ALTER TABLE public.feature_usage_monthly ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.feature_usage_monthly FROM anon, authenticated;
GRANT  ALL ON public.feature_usage_monthly TO   service_role;

REVOKE ALL ON FUNCTION public.parent_has_premium(uuid)                              FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.parent_has_premium(uuid)                            TO service_role;
REVOKE ALL ON FUNCTION public.consume_feature_quota(uuid, text, integer, integer)   FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.consume_feature_quota(uuid, text, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.prune_feature_usage_monthly(integer)                  FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.prune_feature_usage_monthly(integer)                TO service_role;

-- ─── 6. Flags: access + cap values, AND model-provider knobs ────────────────
--
-- The two *_model_provider flags activate the existing _shared/models
-- factory for these scopes (it already knows generate-quest + export-word-
-- tome as FunctionScopes). 'anthropic' = Haiku, preserving today's behaviour
-- until you deliberately flip to 'gemini'/'mistral'. ON CONFLICT DO NOTHING
-- so re-running never clobbers a value you've since tuned in SQL.

INSERT INTO public.feature_flags (key, value, description) VALUES
  -- Access gate
  ('generate_quest_premium_only',          'true',
   'When true, generate-quest requires premium (is_paid_tier). Set false to '
   'reopen to all. The product decision from 2026-05 session.'),
  ('export_word_tome_premium_only',        'true',
   'When true, export-word-tome requires premium (is_paid_tier).'),

  -- Free-taste grant (lifetime, NOT monthly). 0 = pure paid-only.
  ('generate_quest_free_lifetime_grant',   '0',
   'Lifetime free custom-quest generations a NON-premium parent gets before '
   'the paywall. 0 = pure paid-only (as requested). Set 1–3 to A/B the '
   'higher-converting freemium-taste model — no redeploy. Clamp [0,50].'),
  ('export_word_tome_free_lifetime_grant', '0',
   'Lifetime free PDF exports for non-premium parents. Recommend leaving 0 — '
   'a PDF has no demo value the way a generated quest does. Clamp [0,50].'),

  -- Monthly cap (applies to premium + free-taste users alike)
  ('generate_quest_monthly_cap',           '15',
   'Max custom quests per parent per UTC month (flat, abuse/cost brake — '
   'still applies to paid). Calibrated for Haiku; raise to 30–50 if '
   'generate-quest moves to Gemini. Clamp [1,100000].'),
  ('export_word_tome_monthly_cap',         '12',
   'Max PDF exports per parent per UTC month. Clamp [1,100000].'),

  -- Model-provider control (activates the existing _shared/models factory)
  ('generate_quest_model_provider',        'anthropic',
   'Model provider for generate-quest: anthropic|gemini|mistral. anthropic '
   '= Haiku (current). Flip to gemini ONLY after a quest-quality A/B — '
   'quest text is user-facing. ≈60s propagation, no redeploy.'),
  ('export_word_tome_model_provider',      'anthropic',
   'Model provider for export-word-tome: anthropic|gemini|mistral. The '
   'portfolio summary is low-stakes prose — gemini is safe here and ~20x '
   'cheaper. Recommended flip to gemini after one spot-check.')
ON CONFLICT (key) DO NOTHING;

-- ─── 7. Sanity log ──────────────────────────────────────────────────────────

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.feature_flags WHERE key IN (
    'generate_quest_premium_only','export_word_tome_premium_only',
    'generate_quest_free_lifetime_grant','export_word_tome_free_lifetime_grant',
    'generate_quest_monthly_cap','export_word_tome_monthly_cap',
    'generate_quest_model_provider','export_word_tome_model_provider');
  RAISE NOTICE 'feature_usage_monthly migration: flags=%/8 table=% premium_rpc=% quota_rpc=%',
    n,
    (to_regclass('public.feature_usage_monthly') IS NOT NULL),
    EXISTS(SELECT 1 FROM pg_proc WHERE proname='parent_has_premium'    AND pronamespace='public'::regnamespace),
    EXISTS(SELECT 1 FROM pg_proc WHERE proname='consume_feature_quota' AND pronamespace='public'::regnamespace);
END $$;

COMMIT;

-- ============================================================================
-- POST-RUN VERIFICATION (run on BOTH staging + prod after apply)
-- ============================================================================
--
--   -- All 8 flags present:
--   SELECT key, value FROM public.feature_flags
--    WHERE key LIKE 'generate_quest_%' OR key LIKE 'export_word_tome_%'
--    ORDER BY key;
--
--   -- is_paid_tier wrapper correct (expect t for a tier1/family parent):
--   SELECT public.parent_has_premium('<a-paid-parent-uuid>'::uuid);
--   SELECT public.parent_has_premium('<a-free-parent-uuid>'::uuid);   -- f
--
--   -- Decision RPC, free parent, grant=0  → need_premium, no increment:
--   SELECT * FROM public.consume_feature_quota(
--     '<free-parent-uuid>'::uuid, 'generate_quest', 15, 0);
--   -- expect decision='need_premium', month_used=0
--
--   -- Same parent with grant=2 (simulate the freemium A/B):
--   SELECT * FROM public.consume_feature_quota(
--     '<free-parent-uuid>'::uuid, 'generate_quest', 15, 2);  -- allow (1)
--   --  run again → allow (2) → third call → need_premium
--
--   -- Premium parent: allow until monthly_cap, then monthly_cap:
--   SELECT * FROM public.consume_feature_quota(
--     '<paid-parent-uuid>'::uuid, 'generate_quest', 15, 0);  -- allow
--
--   -- Cleanup smoke rows:
--   DELETE FROM public.feature_usage_monthly
--    WHERE parent_id IN ('<free-parent-uuid>'::uuid,'<paid-parent-uuid>'::uuid);
-- ============================================================================
