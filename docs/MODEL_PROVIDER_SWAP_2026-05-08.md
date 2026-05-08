# Model Provider Swap — Drop-in Runbook
**Lexi-Lens v5.1 · 2026-05-08**

This is the operator's guide for shipping the model-provider abstraction with
runtime DB-flag switching. Seven files. No patches — every existing file you
edit gets replaced wholesale by the drop-in version.

---

## File map — what goes where

| File | Status | Repo path |
|---|---|---|
| `types.ts` | NEW | `supabase/functions/_shared/models/types.ts` |
| `anthropic.ts` | NEW | `supabase/functions/_shared/models/anthropic.ts` |
| `gemini.ts` | NEW | `supabase/functions/_shared/models/gemini.ts` |
| `index.ts` (factory) | NEW | `supabase/functions/_shared/models/index.ts` |
| `20260508_feature_flags.sql` | NEW | `supabase/migrations/20260508_feature_flags.sql` |
| `evaluateObject.ts` | REPLACE | `supabase/functions/evaluate/evaluateObject.ts` |
| `index.ts` (Edge Function) | REPLACE | `supabase/functions/evaluate/index.ts` |

The first four files are net-new under a fresh `_shared/models/` directory you don't have yet — drop them in, no conflicts. The last two replace existing files in `evaluate/`. Everything else in your repo is untouched: `useLexiEvaluate.ts`, `ScanScreen`, `VerdictCard`, `scan_attempts`, RLS policies, the four other Claude-using Edge Functions (`classify-words`, `generate-quest`, `retire-word`, `export-word-tome`) — all unchanged.

---

## Deploy order

The order matters because the new factory expects the `feature_flags` table to exist. Reverse order works (the factory logs an error and falls back to the env var) but produces noisy logs you don't need.

```bash
# 1 — Apply the migration on the active Supabase project
#     (staging first, then prod when staging is happy)
supabase migration up --project-ref <ref>

# 2 — Set the new Google AI Studio secret (only needed if you actually plan
#     to flip to Gemma; setting it ahead of time costs nothing).
supabase secrets set --project-ref <ref> \
  GOOGLE_AI_STUDIO_KEY="<your_aistudio_key>"

# 3 — Deploy the evaluate Edge Function
supabase functions deploy evaluate --project-ref <ref>
```

After step 3 the system is functionally identical to v5.0 — `feature_flags` row defaults to `'anthropic'`, so Haiku 4.5 keeps serving every scan. Nothing changed for users yet. The infrastructure is just *ready* to flip.

---

## Flipping the model — the daily-driver workflow

**Supabase Dashboard → SQL Editor**, run this:

```sql
UPDATE public.feature_flags
SET    value = 'gemini'
WHERE  key   = 'evaluate_model_provider';
```

That's it. Within ~60 seconds (the in-process flag cache TTL) every warm Edge Function container picks up the new value. No deploy, no CI, no restart.

**Rollback** is the same query in reverse:

```sql
UPDATE public.feature_flags
SET    value = 'anthropic'
WHERE  key   = 'evaluate_model_provider';
```

**Verify which model is currently live** by tailing Edge Function logs in the Supabase Dashboard. Each cold-started container logs one line:

```
[models] scope=evaluate provider=gemini model=gemma-4-26b source=feature_flags
```

If `source=feature_flags`, the DB row is in charge. If `source=env:...` the DB read failed or the row is missing — investigate before assuming the flip worked.

---

## Cache design — shared across model regimes

**Cache key shape** (unchanged from v5.0):

```
<env>:lexi:eval:<hash>
```

There is no model dimension in the key. Haiku-cached verdicts and Gemma-cached verdicts share a single namespace. A cache hit is served regardless of which model produced the entry.

**Why this is the right design for Lexi-Lens:**

The cache content is a verdict about the world (e.g. "this glass is translucent"), not a verdict about the model that made it. As long as you only flip to a model you've validated, cached entries from the previous regime remain useful. This matters increasingly as you push TTL beyond 14 days and as you pre-warm the free-quest cache — a pre-warm investment now serves multiple model regimes without re-warming.

**Where model identity lives instead — the cache VALUE:**

Every cache entry written by v5.1 carries a `_modelId` field stamped from the producing adapter. Cache reads return the value as-is. The Edge Function logs the producing model on every hit:

```
[evaluate] cache hit: producedBy=claude-haiku-4-5 currentAdapter=gemma-4-26b childId=...
```

This gives you observability ("which model made this verdict?") without coupling cache *lookup* to the active model. Pre-v5.1 entries don't carry `_modelId` — they're logged as `producedBy=unknown` and treated normally.

**Trade-offs you're accepting:**

1. **Voice drift across regimes.** Haiku and Gemma write `childFeedback` in subtly different prose. Post-flip, ~80% of scans hit cache (i.e. the previous model's voice); the new model's voice only appears on cache misses. Real, but bounded — both stay within the system prompt's age-band constraints.

2. **Silent regression masking.** If you ever flip to a worse model, pre-existing high-quality cached entries hide the regression. You won't see it in `verdict_reports` rate until cache misses force fresh calls. **Mitigation:** test with a fresh-cache scratch profile before flipping production, never on your own household's existing profile.

3. **Selective purge requires scripting, not `FLUSHDB`.** See next section.

---

## Selective purge by model — when you'll need it

You won't need this often. But if you ever realize a specific model produced bad verdicts during a known window and you want them gone:

```bash
# Pseudocode — adapt to your Upstash REST API of choice.
# 1. SCAN all keys matching the eval prefix.
# 2. GET each value, parse, check _modelId.
# 3. DEL keys whose _modelId matches the regime to purge.

CURSOR=0
TARGET_MODEL="gemma-4-26b"  # the regime you want gone

while true; do
  result=$(curl -s -H "Authorization: Bearer $UPSTASH_TOKEN" \
    "$UPSTASH_URL/scan/$CURSOR/match/prod:lexi:eval:*/count/100")
  CURSOR=$(echo "$result" | jq -r '.result[0]')
  for key in $(echo "$result" | jq -r '.result[1][]'); do
    val=$(curl -s -H "Authorization: Bearer $UPSTASH_TOKEN" "$UPSTASH_URL/get/$key" | jq -r '.result')
    if [ "$(echo "$val" | jq -r '._modelId')" = "$TARGET_MODEL" ]; then
      curl -s -H "Authorization: Bearer $UPSTASH_TOKEN" "$UPSTASH_URL/del/$key"
    fi
  done
  [ "$CURSOR" = "0" ] && break
done
```

Run this against staging first to validate. Production purges should be done during low-traffic windows since they generate bursts of fresh model calls as users hit the now-empty entries.

If you don't need surgical purge — for example, you simply want a clean slate after a bad model period — `FLUSHDB` on the Upstash database wipes everything, and the cache rebuilds organically from the next model's calls.

---

## What "broken" looks like, and what to do

| Symptom | Cause | Fix |
|---|---|---|
| Logs show `source=env:...` after flip | DB read failed or `feature_flags` row missing | Re-run the migration on the project. Run `SELECT * FROM feature_flags;` to confirm the row exists. |
| Logs show `source=default` | Both DB read and env var unusable | Check that the migration ran. Check service-role key is intact in Edge Function secrets. |
| Logs show `Adapter "gemini" ... API key is missing. Falling back to anthropic.` | `GOOGLE_AI_STUDIO_KEY` not set on the project | `supabase secrets set GOOGLE_AI_STUDIO_KEY=...` then redeploy evaluate |
| Verdicts feel wrong after flip | New model's quality on your task is below threshold | Roll back via SQL UPDATE, then test with a scratch parent account in staging |
| 502 errors from evaluate | Upstream provider outage (could be either) | Roll back to whichever provider is healthy via SQL UPDATE |
| Cache hit logs show all `producedBy=unknown` | Pre-v5.1 entries; expected immediately after deploy | Will phase out as v5.1-written entries replace them over TTL window |

---

## What to watch when you flip

You said you'd test rigorously yourself. Things to look at when running scans post-flip:

- **`childFeedback` text** — Gemma writes differently from Haiku. Slightly different cadence in the kid-coach voice. Check that nothing reads as off-tone for the age band.
- **Property scoring** — particularly the borderline 0.6–0.75 range. The negative-phrase + hedging validators in `evaluateObject.ts` post-process both providers identically, so structurally-bad verdicts get caught the same way. What might differ is the underlying judgement.
- **`resolvedObjectName`** — Gemma's vision encoder uses different ViT pretraining; it may name objects slightly differently than Haiku.
- **Latency** — should be similar (~1–3s), but Gemma TTFT via AI Studio has more variance than Anthropic. If p95 climbs above 6s, something's wrong on Google's side; flip back.
- **`_cacheHit` rate** — does NOT drop after flip (this is the whole point of shared cache). What WILL change is the `producedBy` distribution in cache-hit logs — old Haiku entries will dominate for weeks until natural TTL expiry, then progressively give way to Gemma entries on writes. Use `producedBy` log breadcrumbs as the signal for "is the new model actually being exercised?" instead of expecting cache hit rate to drop.

---

## What this doesn't do (yet)

- **The other four Edge Functions stay on Haiku 4.5.** `classify-words`, `generate-quest`, `retire-word`, `export-word-tome` are not in scope for v5.1. The factory supports them (their scopes are pre-declared in `SCOPE_ENV_VAR`) and you can migrate them later by changing one import line each + adding their `feature_flags` rows.

- **No model-name column on `scan_attempts`.** Per your call. The Edge Function logs (cache-hit `producedBy` lines + cold-start `[models] ...` lines) and the `feature_flags.updated_at` audit trail are sufficient at solo-dev scale.

- **No client-side feature flag UI.** Flipping is via SQL Editor only. A tiny admin dashboard reading/writing `feature_flags` is straightforward later if you ever need it.

- **No automatic A/B routing.** `feature_flags` is a single value, not a percentage split. If you want canary rollouts later, replace the `value` column read with a hash-of-childId-mod-100 split inside `getModelAdapter`. ~30 lines, fully backward-compatible.

---

## File checksums (paste into your commit message if you want)

| File | LOC (approx) | Exports |
|---|---|---|
| `types.ts` | ~120 | `ModelId`, `ModelCallOptions`, `ModelCallResult`, `ModelAdapter`, `ModelCallError` |
| `anthropic.ts` | ~140 | `anthropicHaikuAdapter` |
| `gemini.ts` | ~190 | `geminiAdapter` |
| `_shared/models/index.ts` | ~190 | `ProviderKey`, `FunctionScope`, `getModelAdapter`, `_resetFlagCacheForTests` |
| `feature_flags.sql` | ~115 | Table + trigger + RLS-on (no policies) + seed row |
| `evaluateObject.ts` | ~370 | `evaluateObject`, `applyNegativePhraseValidation`, `computeXp` (+ types) |
| `evaluate/index.ts` | ~410 | (Edge Function entry — no exports) |

---

## Pre-flight checklist before flipping in production

Before flipping the flag in production for the first time, do this dry run in staging:

1. Migration applied: `SELECT * FROM feature_flags;` returns one row.
2. Both API keys set: `ANTHROPIC_API_KEY` and `GOOGLE_AI_STUDIO_KEY` in staging Edge Function secrets.
3. Deploy evaluate. Run a scan from a **fresh scratch profile** (cache-cold). Logs show `[models] ... provider=anthropic ... source=feature_flags`. ✓
4. Run the SQL UPDATE to flip to gemini. Wait 70 seconds.
5. Run another scan from the **same scratch profile** with a **new object** (forces cache miss). Logs show `[models] ... provider=gemini ...` and the verdict is genuinely Gemma's. ✓
6. Run a scan against the SAME object you scanned in step 3 — expect `cache hit: producedBy=claude-haiku-4-5 currentAdapter=gemma-4-26b`. ✓ This confirms shared cache is working.
7. Run the SQL UPDATE to flip back to anthropic. Wait 70 seconds.
8. Run another scan. Logs show `[models] ... provider=anthropic ...`. ✓

If all log lines look right, the system is working. Then you can flip in production with confidence.

The critical step is #5 — testing the new model on a cache-cold scan. If you skip that and only test on objects that were already cached, you'll be evaluating Haiku's cached verdicts, not Gemma's. That's exactly the silent-regression-masking risk this design accepts.
