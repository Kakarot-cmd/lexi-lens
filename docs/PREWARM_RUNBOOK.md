# Lexi-Lens cache prewarm runbook

Operator runbook for the free-tier dungeon prewarm: schema migrations, staging test, production rollout, and recovery.

---

## Why this exists

The free tier's daily scan cap is 5 model calls per child per day, but **cache hits don't count** (v5.2.2 design). A child who scans repeatedly against prewarmed objects effectively has unlimited play; the 5-call cap only bites on truly novel objects. Prewarm is what makes the free tier playable, not just cheap.

The three free dungeons (Plushy Pixie's Bedroom, Hollow Hippo's Kitchen, Bookbound Banshee's Library) use 12 disjoint property words across 3 disjoint pools:

- Pool A (textures): `soft, fluffy, smooth, stretchy`
- Pool B (shape-3D): `round, hollow, cylindrical, curved`
- Pool C (flatness): `flat, rectangular, rigid, thin`

The prewarm corpus targets these 12 words against ~40 high-likelihood scan objects. ~$0.16 to warm, persists for 365 days, durable-backed in Postgres.

---

## File inventory

After applying everything, your repo should have:

```
supabase/migrations/
├── 20260509_cache_prewarm_seed.sql      ← Postgres seed table (durable backup)
├── 20260509_quest_subscription_tier.sql  ← min_subscription_tier column + RLS
├── 20260509_seed_free_dungeons.sql       ← inserts the 3 free dungeons
└── 20260509_tier_config.sql              ← 4-tier scan caps + Haiku fallback config

scripts/
├── prewarm-cache.ts      ← writes the corpus to Upstash + Postgres seed
├── prewarm-corpus.ts     ← the curated corpus (3-pool design)
└── restore-prewarm.ts    ← Postgres → Upstash replay (zero model cost)

docs/
└── PREWARM_RUNBOOK.md    ← this file
```

---

## Apply order (one-time, both staging and prod)

Migrations apply alphabetically. The names sort to the right order:

1. `20260509_cache_prewarm_seed.sql` (independent)
2. `20260509_quest_subscription_tier.sql` (independent — adds the column)
3. `20260509_seed_free_dungeons.sql` (depends on #2)
4. `20260509_tier_config.sql` (independent)

Apply normally via `supabase db push`, or manually in SQL Editor in this order. Each is wrapped in `BEGIN/COMMIT` so a failure rolls back cleanly.

**⚠ BEFORE APPLYING TO PROD:** the `quest_subscription_tier` migration is a breaking product change. Until `seed_free_dungeons` lands in the same session, free-tier users see zero quests. Apply both back-to-back; do not pause between them.

### Verification queries (run after each apply)

After `cache_prewarm_seed`:
```sql
SELECT count(*) FROM public.cache_prewarm_seed;        -- expect 0
```

After `quest_subscription_tier`:
```sql
SELECT min_subscription_tier, count(*)
FROM public.quests GROUP BY 1;                         -- all rows 'paid'
```

After `seed_free_dungeons`:
```sql
SELECT id, name, room_label, min_subscription_tier, sort_order
FROM public.quests
WHERE min_subscription_tier = 'free'
ORDER BY sort_order;                                   -- expect 3 rows
```

After `tier_config`:
```sql
SELECT tier, cap_scans_per_day, haiku_calls_per_day FROM public.tier_config
ORDER BY CASE tier
  WHEN 'free' THEN 1 WHEN 'tier1' THEN 2
  WHEN 'tier2' THEN 3 WHEN 'family' THEN 4 END;
-- expect: free(5,3) tier1(20,7) tier2(45,14) family(60,21)
```

### Pool-disjointness sanity check (run once, in either env)

```sql
WITH all_words AS (
  SELECT q.name, jsonb_array_elements(props) ->> 'word' AS word
  FROM public.quests q,
       jsonb_each(q.age_band_properties) AS bands(age_band, props)
  WHERE q.id IN (
    '11111111-aaaa-4ccc-8ddd-000000000001'::uuid,
    '22222222-aaaa-4ccc-8ddd-000000000002'::uuid,
    '33333333-aaaa-4ccc-8ddd-000000000003'::uuid
  )
)
SELECT word, count(DISTINCT name) AS dungeon_count
FROM all_words GROUP BY word HAVING count(DISTINCT name) > 1;
-- expect: 0 rows. If non-empty, a property word leaked across pools.
```

---

## Staging test (run before prod)

### Prerequisites

Set in your shell (or use Doppler / direnv):

```bash
export SUPABASE_URL=https://<staging-project>.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=<staging-service-role-key>
export UPSTASH_REDIS_REST_URL=<staging-upstash-url>
export UPSTASH_REDIS_REST_TOKEN=<staging-upstash-token>
export ANTHROPIC_API_KEY=<your-key>
```

The Upstash credentials must match what the staging Edge Function uses. Mismatch = the prewarm writes to the wrong namespace and your test will silently fail.

### Step 1 — Dry run (no model calls, no writes)

```bash
deno run -A scripts/prewarm-cache.ts --env staging --dry-run
```

Confirms the corpus loads, namespace is right, and counts look sane. Should report `~40 entries / ~200 cache rows in free_dungeon`. Cost: $0.

### Step 2 — Smallest real run (5 entries, ~$0.02)

```bash
deno run -A scripts/prewarm-cache.ts --env staging \
  --category free_dungeon --limit 5
```

Confirms Upstash writes work, value shape matches what `cacheGetProp` validates, Postgres seed-table writes work.

### Step 3 — Manual verification (load-bearing)

In the staging app, log in as a test child, open one of the warmed objects' dungeon (e.g. Plushy Pixie's Bedroom), scan a `pillow`. Tail Edge Function logs in the Supabase dashboard for:

```
[evaluate] per-property: cached=N missing=0 (FULL HIT)
```

If you see this, the warm took. If you see `cached=0 missing=N`, something is wrong — the cache key shape has drifted between script and production. Stop and reconcile before continuing.

### Step 4 — Full free-dungeon warm (~$0.16, ~3 minutes)

```bash
mkdir -p manifests
deno run -A scripts/prewarm-cache.ts --env staging \
  --category free_dungeon \
  --skip-cached \
  --manifest manifests/staging-$(date +%Y-%m-%d).json
```

`--skip-cached` skips the 5 entries warmed in step 2; only the remaining ~35 cost money. The manifest is your audit log.

### Step 5 — Hit-rate observability

After ~24h of mixed staging traffic, run the cache-hit query from `lexi-lens-monitor_v5_3.html`:

```sql
SELECT
  date_trunc('day', created_at) AS day,
  count(*) FILTER (WHERE cache_hit) AS full_hits,
  count(*) FILTER (WHERE NOT cache_hit) AS model_calls,
  count(*) AS total,
  round(100.0 * count(*) FILTER (WHERE cache_hit) / NULLIF(count(*), 0), 1) AS full_hit_pct
FROM scan_attempts
WHERE created_at > now() - interval '7 days'
  AND detected_label NOT IN ('object', 'Object')
GROUP BY 1 ORDER BY 1 DESC;
```

Expect `full_hit_pct` to climb noticeably as soon as anyone plays a free dungeon. Pre-prewarm baseline at the same scan volume was near 0% on iOS, single-digits on Android.

### Step 6 — Restore-script smoke test

Verify the Postgres → Upstash recovery path works in staging before you ever need it in prod:

```bash
# Dry-run — should report the 200-ish seed rows
deno run -A scripts/restore-prewarm.ts --env staging --dry-run

# Real replay — overwrites the same Upstash entries with their seed-table values
deno run -A scripts/restore-prewarm.ts --env staging --verbose
```

If both succeed, you have a working disaster-recovery path. **Never ship to prod without testing this first.**

---

## Production rollout

After staging passes all 6 steps:

```bash
# 1. Apply migrations (in order, in SQL Editor or via supabase db push)
#    against the prod Supabase project.

# 2. Switch shell env to prod
export SUPABASE_URL=https://<prod-project>.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=<prod-service-role-key>
export UPSTASH_REDIS_REST_URL=<prod-upstash-url>     # may be same as staging during single-Upstash-DB phase
export UPSTASH_REDIS_REST_TOKEN=<prod-upstash-token>

# 3. Dry-run first
deno run -A scripts/prewarm-cache.ts --env prod --dry-run

# 4. Full free-dungeon warm with manifest. The script will prompt for
#    confirmation before any prod write.
deno run -A scripts/prewarm-cache.ts --env prod \
  --category free_dungeon \
  --skip-cached \
  --max-cost 0.50 \
  --manifest manifests/prod-$(date +%Y-%m-%d).json
```

The interactive prompt (`About to write to PROD cache namespace "prod". Proceed?`) only fires when `--env prod`. There's no `--yes` bypass on purpose.

### Optional: warm the wider corpus too

```bash
deno run -A scripts/prewarm-cache.ts --env prod \
  --category general_household \
  --skip-cached \
  --max-cost 0.50
```

Adds ~$0.21 of broader coverage for paid-tier scans. Skip until you have prod data showing what paid users actually scan.

---

## Recovery scenarios

### Upstash data loss / accidental FLUSHDB / regional incident

```bash
deno run -A scripts/restore-prewarm.ts --env prod
```

Replays everything in `cache_prewarm_seed.cache_env = 'prod'` back to Upstash. Zero model calls. ~30 seconds for 200 rows. Interactive confirm before any prod write.

### Migrating to a new Upstash account or region

Same script, point at the new Upstash:

```bash
export UPSTASH_REDIS_REST_URL=<new-upstash-url>
export UPSTASH_REDIS_REST_TOKEN=<new-upstash-token>
deno run -A scripts/restore-prewarm.ts --env prod
```

Old Upstash entries naturally expire; new instance is populated immediately.

### Selective re-warm after a model swap

If you flip `evaluate_model_provider` from anthropic to gemini and want only the Haiku-produced cache entries replaced (fresh Gemini verdicts for cache misses, but kept Haiku-produced entries until they re-warm naturally):

```bash
# Restore only Gemini entries (assumes some prior Gemini warm exists)
deno run -A scripts/restore-prewarm.ts --env prod \
  --model-id gemini-3.1-flash-lite

# Or, replay everything EXCEPT Haiku entries, leaving them to re-warm via prod traffic
deno run -A scripts/restore-prewarm.ts --env prod \
  --model-id-not claude-haiku-4-5
```

---

## Maintenance

### When to re-run prewarm

- **Corpus update** — added new objects to `prewarm-corpus.ts`. Re-run with `--skip-cached`; only new entries cost money.
- **Property changes** — if you edit `age_band_properties` on the 3 free dungeons, the `FREE_DUNGEON_POOL_*` constants in `prewarm-corpus.ts` must be updated to match. The corpus has a load-time assertion that catches pool-overlap typos. Re-run prewarm if any pool changes.
- **Model swap** — the cache key has no model dimension, so a swap doesn't invalidate entries. Old verdicts still serve. If you want fresh verdicts in the new model's voice, delete `--model-id-not <new-model>` rows and re-run prewarm without `--skip-cached`.
- **Annual TTL approaching** — entries written with the default `--prewarm-ttl-days 365` will start expiring around day 360. Re-run prewarm with `--skip-cached --prewarm-ttl-days 365`. The Postgres seed table is unaffected by TTL; only Upstash needs the refresh.

### Tuning tier config

To change any tier's daily cap or Haiku threshold:

```sql
UPDATE public.tier_config SET cap_scans_per_day = 7   WHERE tier = 'free';
UPDATE public.tier_config SET haiku_calls_per_day = 5 WHERE tier = 'free';
```

Changes propagate to warm Edge Function containers in ~60s (in-process flag cache TTL). Safe to do live.

---

## Known gaps closed by next-turn work

This runbook covers what's deployable now. Two things are still incoming:

1. **`parents.subscription_tier` extension.** The column currently allows only `('free', 'paid')`. To assign test users to `'tier1'`, `'tier2'`, or `'family'`, a small follow-up migration extends the CHECK constraint. Until that lands, all parents stay at 'free' (default) or 'paid' (legacy), and `tier_config` rows for tier1/tier2/family exist but aren't queried by any parent.

2. **Edge Function Haiku→Gemini routing.** The `tier_config.haiku_calls_per_day` value is read but not yet acted on. The evaluate Edge Function continues to use the global `evaluate_model_provider` flag for all calls. The routing logic (track Haiku calls per parent per day, fall back to Gemini once exhausted) lands in a follow-up turn.

3. **Quest tier validation in evaluate.** The Edge Function bypasses RLS via service_role. RLS today filters quest *listing* but doesn't validate (parent_tier, quest_min_tier) on every scan. A free-tier child passing a paid quest_id directly to the API would currently get evaluated. Closed by the same Edge Function update as #2 — adds a `(parent.subscription_tier, quest.min_subscription_tier)` check before calling the model.

None of these block the prewarm itself. They're the next session's work.
