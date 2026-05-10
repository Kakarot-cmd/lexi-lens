/**
 * scripts/purge-cache.ts
 * Lexi-Lens — operator script to purge v6 Upstash entries by layer.
 *
 * Use this BEFORE the next dev session if you've shipped a fix that
 * invalidates previously-cached values (e.g. the v6.1.1 article-stripping
 * fix that obsoletes any "a-chair" / "the-bottle" canonicals).
 *
 * ─── What it does ──────────────────────────────────────────────────────
 *
 * Scans Upstash for keys matching the v6 namespace and DELs them in
 * batches. Four layers can be purged independently:
 *
 *   alias    — "{env}:lexi:v6:alias:*"     polluted ML-Kit→canonical map
 *   verdict  — "{env}:lexi:v6:verdict:*:*" per-property cached verdicts
 *   resolved — "{env}:lexi:v6:resolved:*"  per-canonical resolved-name cache
 *   legacy   — "{env}:lexi:eval:*" + "lexi:eval:*" + cache:* variants —
 *              v5-and-earlier zombie entries that v6 evaluate never reads.
 *              Pure quota waste; safe to delete.
 *
 * Aggregate selectors:
 *
 *   --layer=all   = alias + verdict + resolved (all v6 layers)
 *   --layer=nuke  = alias + verdict + resolved + legacy (full clean slate)
 *
 * Default mode is DRY RUN — counts and lists keys without deleting.
 * Pass `--apply` to actually delete.
 *
 * ─── When to use which layer ───────────────────────────────────────────
 *
 *   alias only       Most pollution is here. Verdict entries under junk
 *                    canonicals become orphans (nothing reads them) and
 *                    TTL out in 14 days. Cheapest cleanup.
 *
 *   verdict + alias  Faster cleanup of orphans. Use when you want zero
 *                    waste in Upstash before a prewarm run.
 *
 *   all              Full v6 reset. Use after schema changes that change
 *                    the value shape of cached entries.
 *
 *   legacy           One-shot cleanup of pre-v6 zombie entries. Run once
 *                    after migrating to v6; v6 evaluate code never reads
 *                    these keys, so deleting them frees Upstash quota
 *                    with zero behavioral impact.
 *
 *   nuke             Everything Lexi-touched. Use for a true clean slate
 *                    before launch or before a major architecture change.
 *
 * ─── Usage ─────────────────────────────────────────────────────────────
 *
 *   # Dry run — show what would be deleted, no changes
 *   deno run --allow-net --allow-env scripts/purge-cache.ts --layer=alias
 *
 *   # Actually delete the alias layer
 *   deno run --allow-net --allow-env scripts/purge-cache.ts --layer=alias --apply
 *
 *   # Nuke verdict + alias (orphans + their roots)
 *   deno run --allow-net --allow-env scripts/purge-cache.ts --layer=verdict --layer=alias --apply
 *
 *   # Wipe pre-v6 zombie entries (v5 lexi:eval:* etc — safe, never read)
 *   deno run --allow-net --allow-env scripts/purge-cache.ts --layer=legacy --apply
 *
 *   # FULL RESET — every Lexi-touched key in Upstash
 *   deno run --allow-net --allow-env scripts/purge-cache.ts --layer=nuke --apply
 *
 * ─── Env required ──────────────────────────────────────────────────────
 *
 *   UPSTASH_REDIS_REST_URL   = https://<your-instance>.upstash.io
 *   UPSTASH_REDIS_REST_TOKEN = <token>
 *   ENV_NAME                 = "staging" | "prod" (matches Edge Function ENV_NAME)
 *
 * On Windows CMD set them inline:
 *   set UPSTASH_REDIS_REST_URL=https://...
 *   set UPSTASH_REDIS_REST_TOKEN=...
 *   set ENV_NAME=staging
 *   deno run --allow-net --allow-env scripts\purge-cache.ts --layer=alias --apply
 */

// ─── Env (defensively unquoted — Windows CMD preserves wrapping quotes) ────
//
// `set FOO="bar"` on Windows CMD stores the value literally as `"bar"`
// including quotes. URL parsing then fails with "Invalid URL: '\"https://...\"'".
// We strip a single layer of wrapping single or double quotes so the script
// works regardless of which shell set the env var.
function unquote(s: string | undefined): string | undefined {
  if (!s) return s;
  const m = s.match(/^(['"])(.*)\1$/);
  return m ? m[2] : s;
}

const REDIS_URL   = unquote(Deno.env.get("UPSTASH_REDIS_REST_URL"));
const REDIS_TOKEN = unquote(Deno.env.get("UPSTASH_REDIS_REST_TOKEN"));
const ENV_NAME    = unquote(Deno.env.get("ENV_NAME")) ?? "staging";

if (!REDIS_URL || !REDIS_TOKEN) {
  console.error("Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN");
  Deno.exit(1);
}

// ─── Args ──────────────────────────────────────────────────────────────────

const args   = Deno.args;
const apply  = args.includes("--apply");
const layers = args
  .filter((a) => a.startsWith("--layer="))
  .map((a) => a.replace("--layer=", ""));

if (layers.length === 0) {
  console.error("No --layer specified. Use --layer=alias|verdict|resolved|legacy|all|nuke (repeatable).");
  Deno.exit(1);
}

// v6 layers — the current cache architecture
const V6_LAYERS = ["alias", "verdict", "resolved"];

// v6.2 — "legacy" wipes pre-v6 cache namespaces that are no longer read
// by the evaluate function (lexi:eval:* from v5 and earlier). These are
// zombie entries that just consume Upstash quota. Safe to delete; v6 code
// never touches them.
//
// "nuke" = v6 + legacy combined. Use when starting from a true clean slate.
//
// Only "all" and explicit layer names match V6_LAYERS. "legacy" and "nuke"
// are special markers handled in the layer expansion below.
const allLayers = [...V6_LAYERS, "legacy"];
const targetLayers =
  layers.includes("nuke") ? [...V6_LAYERS, "legacy"]
  : layers.includes("all") ? V6_LAYERS
  : layers;

for (const l of targetLayers) {
  if (!allLayers.includes(l)) {
    console.error(`Unknown layer: "${l}". Valid: ${allLayers.join(", ")}, "all", or "nuke".`);
    Deno.exit(1);
  }
}

console.log(`MODE:    ${apply ? "APPLY (will delete)" : "DRY RUN (no deletes)"}`);
console.log(`ENV:     ${ENV_NAME}`);
console.log(`LAYERS:  ${targetLayers.join(", ")}`);
console.log("");

// ─── Upstash REST helpers ──────────────────────────────────────────────────

interface ScanResult { cursor: string; keys: string[] }

async function scan(cursor: string, pattern: string, count: number): Promise<ScanResult> {
  // Upstash supports SCAN with MATCH and COUNT via positional args
  const res = await fetch(REDIS_URL!, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      Authorization:   `Bearer ${REDIS_TOKEN}`,
    },
    body: JSON.stringify(["SCAN", cursor, "MATCH", pattern, "COUNT", String(count)]),
  });
  if (!res.ok) throw new Error(`SCAN failed: ${res.status} ${await res.text()}`);
  const j = await res.json() as { result: [string, string[]] };
  return { cursor: j.result[0], keys: j.result[1] };
}

async function delMany(keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  // Upstash supports variadic DEL
  const res = await fetch(REDIS_URL!, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      Authorization:   `Bearer ${REDIS_TOKEN}`,
    },
    body: JSON.stringify(["DEL", ...keys]),
  });
  if (!res.ok) throw new Error(`DEL failed: ${res.status} ${await res.text()}`);
  const j = await res.json() as { result: number };
  return j.result;
}

// ─── Per-layer purge ───────────────────────────────────────────────────────

/**
 * Pattern resolver. v6 layers live under {ENV}:lexi:v6:{layer}:*.
 * Legacy entries are pre-v6 cache (v5 lexi:eval:* and friends) that the
 * current evaluate function does not read; we wipe them in two passes
 * to catch both env-prefixed and bare forms that may have accumulated.
 */
function patternsFor(layer: string): string[] {
  if (layer === "legacy") {
    // Match every pre-v6 lexi cache key, both with and without env prefix.
    // Defensive: cover all observed legacy shapes (lexi:eval:*, lexi:cache:*).
    return [
      `${ENV_NAME}:lexi:eval:*`,
      `${ENV_NAME}:lexi:cache:*`,
      `lexi:eval:*`,                   // bare (un-env-namespaced) — older deployments
      `lexi:cache:*`,
    ];
  }
  return [`${ENV_NAME}:lexi:v6:${layer}:*`];
}

async function purgeLayer(layer: string): Promise<{ scanned: number; deleted: number; sampleKeys: string[] }> {
  const patterns = patternsFor(layer);
  console.log(`─── ${layer.toUpperCase()} ─── patterns=${JSON.stringify(patterns)}`);

  let cursor       = "0";
  let scanned      = 0;
  let deleted      = 0;
  const sampleKeys: string[] = [];

  for (const pattern of patterns) {
    cursor = "0";
    do {
      const r = await scan(cursor, pattern, 200);
      cursor   = r.cursor;
      scanned += r.keys.length;

      // Show first 10 keys per layer for sanity
      for (const k of r.keys) {
        if (sampleKeys.length < 10) sampleKeys.push(k);
      }

      if (apply && r.keys.length > 0) {
        // DEL in chunks to keep payloads bounded
        const CHUNK = 100;
        for (let i = 0; i < r.keys.length; i += CHUNK) {
          deleted += await delMany(r.keys.slice(i, i + CHUNK));
        }
      }
    } while (cursor !== "0");
  }

  return { scanned, deleted, sampleKeys };
}

// ─── Run ───────────────────────────────────────────────────────────────────

let totalScanned = 0;
let totalDeleted = 0;

for (const layer of targetLayers) {
  const { scanned, deleted, sampleKeys } = await purgeLayer(layer);
  console.log(`  scanned: ${scanned}`);
  console.log(`  deleted: ${apply ? deleted : "(dry run — 0)"}`);
  if (sampleKeys.length > 0) {
    console.log(`  sample (first ${sampleKeys.length}):`);
    for (const k of sampleKeys) console.log(`    ${k}`);
  }
  console.log("");
  totalScanned += scanned;
  totalDeleted += deleted;
}

console.log("─── Summary ───");
console.log(`Total scanned: ${totalScanned}`);
console.log(`Total deleted: ${apply ? totalDeleted : "(dry run — 0)"}`);

if (!apply) {
  console.log("");
  console.log("Re-run with --apply to actually delete.");
}
