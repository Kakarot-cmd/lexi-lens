-- ============================================================================
-- 20260518_parents_rc_event_watermark.sql
-- Lexi-Lens — RC webhook ordering guard: per-parent event watermark (PU-3)
--
-- HISTORY: applied to live staging + prod 2026-05-17 during the premium-unlock
-- investigation; never committed to the repo. Companion to the patched
-- supabase/functions/revenuecat-webhook/index.ts which only writes a tier
-- if the incoming RC event_timestamp_ms is >= the stored watermark, then
-- advances tier + watermark atomically in a single .update().
--
-- WHY ms-timestamp on parents (not events table): the guard runs in the
-- hot webhook path and must be a single round-trip atomic compare-and-set;
-- joining to a separate events table per webhook would double the latency
-- and reintroduce a TOCTOU race. The denormalized column trades a tiny
-- amount of duplication for a clean atomic guard.
--
-- WHY nullable: NULL means "no event has flowed through the patched code
-- yet for this parent." First event always lands (NULL is treated as
-- "infinitely old"), advances the watermark, and from then on the guard
-- is active. No backfill needed; no existing parent gets stuck.
--
-- WHY BIGINT: RC event_timestamp_ms is a Unix epoch in milliseconds
-- (currently ~17.3 trillion, well within BIGINT range until year 292277).
--
-- REVERSIBILITY: fully additive. Drop the column to revert; the webhook
-- will then fail open and apply every event in arrival order (pre-PU-3
-- behaviour, which had the race but is functionally correct on in-order
-- traffic — i.e. 99%+ of real deliveries).
-- ============================================================================

ALTER TABLE public.parents
    ADD COLUMN IF NOT EXISTS last_rc_event_ts_ms bigint;

COMMENT ON COLUMN public.parents.last_rc_event_ts_ms IS
    'RevenueCat event_timestamp_ms watermark. Webhook handler writes tier '
    'only when incoming event_timestamp_ms >= this value, then advances '
    'both atomically. NULL = no event seen yet (first event always lands).';

-- ── Sanity log ──────────────────────────────────────────────────────────────
DO $$
DECLARE
    col_type text;
BEGIN
    SELECT data_type INTO col_type
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'parents'
       AND column_name = 'last_rc_event_ts_ms';
    RAISE NOTICE 'parents_rc_event_watermark: column type = %', col_type;
END $$;
