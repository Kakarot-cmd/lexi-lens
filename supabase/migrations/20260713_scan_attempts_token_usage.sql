-- ═══════════════════════════════════════════════════════════════════════════
-- 20260713 — scan_attempts: real per-scan token usage
--
-- WHY
--   Every per-scan cost number this project has ever used was reverse-engineered
--   from the Google Cloud billing dashboard by dividing a weekly rupee total by
--   a bar-chart request count. That produced two contradictory figures
--   ($0.0001 and $0.0015-0.002 in economics_v3_8_9.html) and neither was right.
--   The provider hands us exact counts in usageMetadata on every single call and
--   we were throwing them away. These three columns stop that.
--
--   cached_tokens is the load-bearing one. Gemini 2.5+/3.x implicitly caches a
--   repeated request PREFIX and discounts it, but the discount is opportunistic,
--   the per-model minimum token floor is undocumented for flash-lite, and
--   Google's own docs disagree on whether 3.x passes the saving on. The v7.1
--   static-SYSTEM_PROMPT refactor is the necessary precondition for a hit; this
--   column is the only way to find out whether it was also sufficient.
--
-- SEMANTICS
--   input_tokens   = usageMetadata.promptTokenCount     (TOTAL input; includes cached)
--   output_tokens  = usageMetadata.candidatesTokenCount
--   cached_tokens  = usageMetadata.cachedContentTokenCount
--                    NULL => provider did not report the field at all
--                    0    => provider reported a cache MISS
--                    These are DIFFERENT. Do not COALESCE them together.
--
--   Billed input   = (input_tokens - COALESCE(cached_tokens,0)) at full rate
--                  + COALESCE(cached_tokens,0)                  at cached rate
--
-- ROLLBACK
--   ALTER TABLE scan_attempts DROP COLUMN input_tokens, DROP COLUMN output_tokens,
--                             DROP COLUMN cached_tokens;
--
-- RUN VIA: Supabase Dashboard -> SQL Editor. Never `supabase db push`.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.scan_attempts
  ADD COLUMN IF NOT EXISTS input_tokens  integer,
  ADD COLUMN IF NOT EXISTS output_tokens integer,
  ADD COLUMN IF NOT EXISTS cached_tokens integer;

COMMENT ON COLUMN public.scan_attempts.input_tokens  IS
  'Provider promptTokenCount. TOTAL input tokens incl. any cached prefix. NULL on cache-hit rows (no model call was made) and on providers that do not report usage.';
COMMENT ON COLUMN public.scan_attempts.output_tokens IS
  'Provider candidatesTokenCount. Billed at the output rate (~6x input on Gemini Flash-Lite).';
COMMENT ON COLUMN public.scan_attempts.cached_tokens IS
  'Gemini usageMetadata.cachedContentTokenCount — implicit-cache hit size, a SUBSET of input_tokens. NULL = not reported by provider; 0 = reported cache MISS.';

-- Partial index: only rows that actually made a model call carry token data.
-- Keeps the cost-analysis queries below off a full scan once volume arrives.
CREATE INDEX IF NOT EXISTS scan_attempts_token_usage_idx
  ON public.scan_attempts (created_at DESC)
  WHERE input_tokens IS NOT NULL;
