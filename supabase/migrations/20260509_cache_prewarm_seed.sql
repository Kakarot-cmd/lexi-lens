-- ============================================================================
-- 20260509_cache_prewarm_seed.sql
-- Lexi-Lens — durable seed table for the Upstash cache prewarm.
--
-- ─── Why this table exists ─────────────────────────────────────────────────
--
-- Upstash Redis is the hot cache layer (~14d TTL on user writes, ~365d TTL on
-- prewarm writes). It's fast and cheap but ephemeral by design — provider
-- migrations, regional incidents, plan changes (Free → PAYG), or accidental
-- FLUSHDB can drop the lot.
--
-- The prewarm corpus represents real money and real time spent calling the
-- model. ~$0.30 + 3 minutes for the free-dungeon block; more if/when the
-- corpus grows. Losing it means re-spending. That's avoidable.
--
-- This table is the durable side of a hot-cache + cold-truth pattern:
--
--   Postgres (cache_prewarm_seed)  ←  the canonical seeds, no TTL
--          │  prewarm-cache.ts writes both
--          │  restore-prewarm.ts reads from here, writes to Upstash ($0)
--          ▼
--   Upstash (lexi:eval:prop:*)     ←  fast read path, hot copy, has TTL
--
-- restore-prewarm.ts (separate script, lands next) does NOT call any model.
-- It iterates this table and rewrites Upstash. Free, fast, idempotent.
--
-- ─── Single table, dual environment ────────────────────────────────────────
--
-- The cache_env column mirrors the --env flag passed to prewarm-cache.ts
-- (typically "staging" or "prod"). One table, two environments. Restore
-- targets the matching env namespace by filtering this column.
--
-- This is consistent with how Upstash itself is shared: the v5.3 stack uses
-- ONE Upstash Free DB partitioned by CACHE_ENV_NAMESPACE key prefix. The
-- seed table follows the same partitioning model.
--
-- ─── RLS ───────────────────────────────────────────────────────────────────
--
-- Service role only. Anon and authenticated roles get nothing. This is
-- admin/ops data; no client should ever read or write it. RLS enabled with
-- no policies = blanket deny for non-service-role (matches feature_flags
-- pattern from 20260508).
--
-- ─── Apply order ───────────────────────────────────────────────────────────
--
-- Apply BEFORE the first run of prewarm-cache.ts v2. Earlier runs won't
-- write to this table (they predate the seed-write path). Use --skip-pg
-- on prewarm-cache.ts if running it before this migration is applied.
-- ============================================================================

BEGIN;

-- ─── 1. Table ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.cache_prewarm_seed (
  id            bigserial   PRIMARY KEY,

  -- Environment namespace this seed belongs to. Mirrors CACHE_ENV_NAMESPACE
  -- and the prewarm-cache.ts --env flag. One table cleanly serves both
  -- staging and prod.
  cache_env     text        NOT NULL CHECK (cache_env IN ('staging', 'prod', 'default')),

  -- The (label, word) pair, lower-cased and pre-normalisation. The cache_key
  -- column below is the byte-for-byte key written to Upstash; this pair is
  -- the human-readable form, used for queries like "show me all warmed
  -- pillow entries".
  label         text        NOT NULL,
  word          text        NOT NULL,

  -- The exact Upstash key. Lets restore-prewarm.ts SET back without
  -- recomputing — and immediately surfaces any mismatch between what was
  -- written and what production is reading.
  cache_key     text        NOT NULL,

  -- The full cached value. Schema must match what
  -- evaluate/index.ts → cacheGetProp() validates:
  --   { word: string, score: number, reasoning: string, passes: boolean,
  --     _modelId: string }
  -- Stored as jsonb so we can index / query individual fields.
  response      jsonb       NOT NULL,

  -- Lineage. Mirrors the _modelId field inside response, denormalised here
  -- so a future "selectively re-warm only Haiku-produced entries" query
  -- doesn't have to dig into jsonb.
  model_id      text        NOT NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- One row per (env, label, word). Re-running prewarm-cache.ts upserts
  -- via this constraint (REST API: Prefer: resolution=merge-duplicates).
  CONSTRAINT cache_prewarm_seed_unique UNIQUE (cache_env, label, word)
);

COMMENT ON TABLE  public.cache_prewarm_seed IS
  'Durable seed source for the Upstash cache prewarm. Written by '
  'scripts/prewarm-cache.ts; read by scripts/restore-prewarm.ts to rebuild '
  'Upstash without re-spending model calls. Service role only.';

COMMENT ON COLUMN public.cache_prewarm_seed.cache_env IS
  'Environment namespace, mirrors CACHE_ENV_NAMESPACE and the --env flag. '
  '"staging" | "prod" | "default".';

COMMENT ON COLUMN public.cache_prewarm_seed.cache_key IS
  'The byte-for-byte Upstash key. Reconstructable from (cache_env, label, '
  'word) via the prewarm script''s buildPerPropCacheKey, but storing it '
  'avoids drift if the key format ever changes.';

COMMENT ON COLUMN public.cache_prewarm_seed.response IS
  'Cached value as written to Upstash. Must match the shape that '
  'evaluate/index.ts → cacheGetProp validates: '
  '{ word, score, reasoning, passes, _modelId }.';

-- ─── 2. updated_at trigger ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.cache_prewarm_seed_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cache_prewarm_seed_updated_at_trg ON public.cache_prewarm_seed;
CREATE TRIGGER cache_prewarm_seed_updated_at_trg
  BEFORE UPDATE ON public.cache_prewarm_seed
  FOR EACH ROW
  EXECUTE FUNCTION public.cache_prewarm_seed_set_updated_at();

-- ─── 3. Indexes ─────────────────────────────────────────────────────────────

-- Restore script filters by cache_env.
CREATE INDEX IF NOT EXISTS cache_prewarm_seed_env_idx
  ON public.cache_prewarm_seed (cache_env);

-- Selective-purge-by-model queries: "re-warm everything Haiku produced".
CREATE INDEX IF NOT EXISTS cache_prewarm_seed_model_idx
  ON public.cache_prewarm_seed (model_id);

-- ─── 4. RLS ─────────────────────────────────────────────────────────────────

ALTER TABLE public.cache_prewarm_seed ENABLE ROW LEVEL SECURITY;

-- No policies. Service role bypasses RLS; anon/authenticated get nothing.
-- This is the same pattern as feature_flags — admin/ops data, never read
-- by the client.

REVOKE ALL ON public.cache_prewarm_seed FROM anon, authenticated;
GRANT  ALL ON public.cache_prewarm_seed TO   service_role;
GRANT  USAGE, SELECT ON SEQUENCE public.cache_prewarm_seed_id_seq TO service_role;

-- ─── 5. Verification (run manually after apply) ─────────────────────────────
--
-- Expect: empty result set initially.
--   SELECT cache_env, count(*) FROM public.cache_prewarm_seed GROUP BY 1;
--
-- After first prewarm run on staging, expect free_dungeon corpus row count
-- (~36 entries × ~5-6 props each ≈ 200 rows for cache_env='staging').
--   SELECT cache_env, count(*) FROM public.cache_prewarm_seed GROUP BY 1;

COMMIT;
