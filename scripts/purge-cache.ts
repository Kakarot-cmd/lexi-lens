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
 * batches. Three layers can be purged independently:
 *
 *   alias    — "{env}:lexi:v6:alias:*"     polluted ML-Kit→canonical map
 *   verdict  — "{env}:lexi:v6:verdict:*:*" per-property cached verdicts
 *   resolved — "{env}:lexi:v6:resolved:*"  per-canonical resolved-name cache
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
 *   all three        Full reset. Use after schema changes that change
 *                    the value shape of cached entries.
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
 *   # Full reset
 *   deno run --allow-net --allow-env scripts/purge-cache.ts --layer=all --apply
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
  console.error("No --layer specified. Use --layer=alias|verdict|resolved|all (repeatable).");
  Deno.exit(1);
}

const allLayers = ["alias", "verdict", "resolved"];
const targetLayers = layers.includes("all") ? allLayers : layers;

for (const l of targetLayers) {
  if (!allLayers.includes(l)) {
    console.error(`Unknown layer: "${l}". Valid: ${allLayers.join(", ")} or "all".`);
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

async function purgeLayer(layer: string): Promise<{ scanned: number; deleted: number; sampleKeys: string[] }> {
  const pattern = `${ENV_NAME}:lexi:v6:${layer}:*`;
  console.log(`─── ${layer.toUpperCase()} ─── pattern="${pattern}"`);

  let cursor       = "0";
  let scanned      = 0;
  let deleted      = 0;
  const sampleKeys: string[] = [];

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
