-- ============================================================================
-- supabase/migrations/20260511_cc1_prep.sql
-- Lexi-Lens — v6.2 Phase 2 prep: CC1 (canonical-classifier 1) schema
-- ============================================================================
--
-- Adds the columns and feature flag rows the cc1 Edge Function and the
-- modified evaluate Edge Function need. Apply BEFORE deploying either
-- function — both read these columns at request time.
--
-- ─── What CC1 is ────────────────────────────────────────────────────────────
--
-- CC1 = "Canonical Classifier 1". A tiny, fast model call (Gemini 2.5
-- Flash-Lite by default) that takes the scan frame and returns a canonical
-- object name + a few synonyms. The evaluate Edge Function uses that
-- canonical as the cache lookup key — replacing the now-always-"object"
-- detectedLabel that arrives post-MLKill.
--
-- Pre-CC1 (v6.2 Phase 1 / current main):
--   Client → evaluate(frame, detectedLabel="object")
--     ML Kit gone → detectedLabel useless for cache lookup
--     → cache reads bypassed for ~all scans
--     → every scan is a full model call
--
-- Post-CC1 (v6.2 Phase 2 / this migration):
--   Client → cc1(frame)        → {canonical, aliases}
--          → evaluate(frame, cc1Result)
--               cache lookup keyed on canonical → real hit rate
--
-- See the Session B brief and roadmap_v6_2.html for the larger context.
--
-- ─── Compatibility with existing rows ───────────────────────────────────────
--
-- All new scan_attempts columns are NULL on legacy rows by design. Reports
-- that bucket by "CC1 was used" should explicitly filter
-- `cc1_skipped IS NOT NULL` to exclude pre-CC1 history rather than
-- treating NULL as "CC1 ran". The cc1_skipped column distinguishes:
--
--   cc1_skipped = NULL    → pre-CC1 row (rolled out before this migration)
--   cc1_skipped = TRUE    → cc1_enabled flag was OFF at scan time
--   cc1_skipped = FALSE   → CC1 ran; success or fallthrough indicated by
--                           cc1_model_id (populated on success, NULL on
--                           CC1 error → direct-evaluate fallthrough)
--
-- ─── Apply order ────────────────────────────────────────────────────────────
--
-- 1. Apply this migration.
-- 2. Deploy supabase/functions/cc1 (new).
-- 3. Deploy supabase/functions/evaluate (modified).
-- 4. Deploy client build with CC1-aware useLexiEvaluate hook.
-- 5. Flip cc1_enabled='true' when ready to roll forward.
--
-- Steps 1–4 are safe with cc1_enabled='false' (default). The modified
-- evaluate accepts an optional cc1Result; absence is the existing path.
-- ============================================================================

-- ─── 1. scan_attempts columns ────────────────────────────────────────────────

ALTER TABLE public.scan_attempts
  ADD COLUMN IF NOT EXISTS cc1_model_id  text,
  ADD COLUMN IF NOT EXISTS cc1_latency_ms integer,
  ADD COLUMN IF NOT EXISTS cc1_skipped   boolean,
  ADD COLUMN IF NOT EXISTS cc1_canonical text;

COMMENT ON COLUMN public.scan_attempts.cc1_model_id IS
  'Stable id of the CC1 model used for this scan (e.g. ''gemini-2-5-flash-lite'', '
  '''mistral-small-4''). Populated when CC1 ran successfully. NULL when '
  'cc1_skipped=true (flag off) or when CC1 ran but errored (fallthrough). '
  'Compare with model_id (evaluate''s model) for cost/latency split.';

COMMENT ON COLUMN public.scan_attempts.cc1_latency_ms IS
  'Wall-clock latency of the CC1 call in ms. Populated whenever cc1_model_id '
  'is populated. The total scan latency for CC1-on rows is '
  'cc1_latency_ms + claude_latency_ms (claude_latency_ms named for legacy '
  'reasons but holds the evaluate model''s latency regardless of provider).';

COMMENT ON COLUMN public.scan_attempts.cc1_skipped IS
  'TRUE when CC1 was disabled at scan time (feature_flags.cc1_enabled=false). '
  'FALSE when CC1 was attempted (success or error-fallthrough). NULL on '
  'pre-CC1-rollout rows — distinguishes legacy data from "CC1 turned off". '
  'Reports should use `cc1_skipped IS FALSE` (not just truthy) to count '
  'CC1-attempted scans.';

COMMENT ON COLUMN public.scan_attempts.cc1_canonical IS
  'The canonical object name CC1 returned. Useful for CC1-vs-evaluate '
  'agreement analysis: rows where cc1_canonical != resolved_name signal '
  'either CC1 over-generalised or evaluate disagreed at full-evaluate time. '
  'Populated whenever cc1_model_id is populated.';

-- ─── 2. Indexes ──────────────────────────────────────────────────────────────
--
-- CC1-success rate and latency analysis queries filter on cc1_model_id; an
-- index on (cc1_model_id, created_at) makes the typical hourly-rollup
-- queries (see Session B verification queries) responsive even at PROD volume.

CREATE INDEX IF NOT EXISTS scan_attempts_cc1_model_created_idx
  ON public.scan_attempts (cc1_model_id, created_at DESC)
  WHERE cc1_model_id IS NOT NULL;

COMMENT ON INDEX public.scan_attempts_cc1_model_created_idx IS
  'Partial index for CC1 latency and hit-rate queries. WHERE clause keeps '
  'index small — only rows where CC1 actually ran are included.';

-- ─── 3. Feature flag rows ────────────────────────────────────────────────────
--
-- cc1_enabled is the global kill switch. Default FALSE so this migration
-- can ship ahead of the Edge Function and client deploys without behavior
-- change. Flip to 'true' to roll CC1 forward.
--
-- cc1_model_provider picks the CC1 model. Default 'gemini' (fastest, cheap
-- enough at CC1's tiny prompt size). Valid values: 'gemini' | 'mistral' |
-- 'anthropic'. CC1 reads this directly — it does NOT go through the shared
-- model factory's evaluate_model_provider chain because CC1's latency
-- profile and cost shape differ.
--
-- cc1_timeout_ms is the wall-clock limit before CC1 gives up and the
-- client falls through to direct evaluate. Default 3000 (3s). Tune after
-- a week of PROD latency data — see Session B verification queries.

INSERT INTO public.feature_flags (key, value, description) VALUES
  ('cc1_enabled',
   'false',
   'Master kill switch for the CC1 (canonical-classifier) Edge Function. '
   'When ''true'', the client invokes CC1 before evaluate, supplying the '
   'returned canonical as the cache lookup key. When ''false'' (default), '
   'the client calls evaluate directly (current v6.2 Phase 1 behavior). '
   'Flip flow: false → true → observe ~24h → revert to false on regression. '
   'Propagation: ~60s server-side flag cache + the client-side cache '
   'piggybacked on the next evaluate response. Worst-case client lag ~5min.'),

  ('cc1_model_provider',
   'gemini',
   'Which provider CC1 uses. Valid: ''gemini'' | ''mistral'' | ''anthropic''. '
   'Default ''gemini'' for latency. CC1 reads this flag directly (does NOT '
   'go through the evaluate factory chain — CC1''s prompt and cost shape '
   'are different). Resolution: feature_flags row → CC1_MODEL_PROVIDER env '
   'var → hardcoded ''gemini''.'),

  ('cc1_timeout_ms',
   '3000',
   'Wall-clock timeout (ms) for the CC1 call before the client falls '
   'through to direct evaluate. Default 3000. Tune after a week of PROD '
   'data showing the actual CC1 latency distribution. Too tight → high '
   'fallthrough rate; too loose → bad UX on CC1 stalls.')

ON CONFLICT (key) DO NOTHING;

-- ─── 4. Sanity-check log ─────────────────────────────────────────────────────

DO $$
DECLARE
  cc1_col_count int;
  cc1_flag_count int;
BEGIN
  SELECT count(*) INTO cc1_col_count
    FROM information_schema.columns
   WHERE table_schema='public'
     AND table_name='scan_attempts'
     AND column_name LIKE 'cc1_%';

  SELECT count(*) INTO cc1_flag_count
    FROM public.feature_flags
   WHERE key LIKE 'cc1_%';

  RAISE NOTICE 'CC1 prep complete. scan_attempts.cc1_* columns: % (expected 4). feature_flags.cc1_* rows: % (expected 3).',
    cc1_col_count, cc1_flag_count;

  IF cc1_col_count < 4 THEN
    RAISE WARNING 'Expected 4 cc1_* columns on scan_attempts, found %. Investigate.', cc1_col_count;
  END IF;
END $$;
