/**
 * scripts/restore-prewarm.ts
 * Lexi-Lens — restore the Upstash cache from the cache_prewarm_seed table.
 *
 * ─── What this script does ────────────────────────────────────────────────
 *
 * Reads rows from public.cache_prewarm_seed (filtered by --env) and writes
 * them back into Upstash with the same key, value, and TTL semantics that
 * prewarm-cache.ts uses. Zero model calls; zero API spend on the AI side.
 *
 * Use cases:
 *
 *   1. Upstash data loss (provider incident, accidental FLUSHDB, plan
 *      change drops the database) — replay this script and the hot cache
 *      is back where it was, instantly.
 *
 *   2. Cache provider migration — moving from Free to PAYG, or to a
 *      different region. Point this script at the new Upstash URL and
 *      replay.
 *
 *   3. Selective re-warm by model lineage — when you swap from Haiku to
 *      Gemini (or vice versa) and want only entries from the old model
 *      replaced, use --model-id-not to filter.
 *
 *   4. Testing — populate a fresh Upstash instance from a snapshot of an
 *      existing seed table for staging or load tests.
 *
 * Imports nothing from the Edge Function source. Self-contained. Designed
 * to be runnable even if the supabase/functions/ tree is broken or
 * mid-migration.
 *
 * ─── Run ───────────────────────────────────────────────────────────────────
 *
 *   # Restore the staging cache from staging seed rows
 *   deno run -A scripts/restore-prewarm.ts --env staging
 *
 *   # Dry-run first — verifies counts without writing to Upstash
 *   deno run -A scripts/restore-prewarm.ts --env staging --dry-run
 *
 *   # Restore prod with the full default 365d TTL (interactive confirm)
 *   deno run -A scripts/restore-prewarm.ts --env prod --prewarm-ttl-days 365
 *
 *   # Replay only entries produced by Haiku (e.g. after a model swap)
 *   deno run -A scripts/restore-prewarm.ts --env prod \
 *     --model-id claude-haiku-4-5
 *
 * ─── Required env vars ─────────────────────────────────────────────────────
 *
 *   UPSTASH_REDIS_REST_URL    UPSTASH_REDIS_REST_TOKEN
 *   SUPABASE_URL              SUPABASE_SERVICE_ROLE_KEY
 */

const DEFAULT_PREWARM_TTL_DAYS = 365;
const PG_PAGE_SIZE             = 200;   // PostgREST default cap

// ─── CLI parsing ─────────────────────────────────────────────────────────────

interface Cli {
  env:            string;
  dryRun:         boolean;
  prewarmTtlDays: number;
  limit:          number | null;
  modelId:        string | null;     // filter: only entries from this model
  modelIdNot:     string | null;     // filter: only entries NOT from this model
  concurrency:    number;
  verbose:        boolean;
}

function parseCli(args: string[]): Cli {
  const cli: Cli = {
    env:            "",
    dryRun:         false,
    prewarmTtlDays: DEFAULT_PREWARM_TTL_DAYS,
    limit:          null,
    modelId:        null,
    modelIdNot:     null,
    concurrency:    8,
    verbose:        false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];

    switch (a) {
      case "--env":              cli.env = next(); break;
      case "--dry-run":          cli.dryRun = true; break;
      case "--prewarm-ttl-days": cli.prewarmTtlDays = parseInt(next(), 10); break;
      case "--limit":            cli.limit = parseInt(next(), 10); break;
      case "--model-id":         cli.modelId = next(); break;
      case "--model-id-not":     cli.modelIdNot = next(); break;
      case "--concurrency":      cli.concurrency = parseInt(next(), 10); break;
      case "--verbose":          cli.verbose = true; break;
      case "--help": case "-h":
        printHelp();
        Deno.exit(0);
      default:
        console.error(`Unknown flag: ${a}`);
        printHelp();
        Deno.exit(1);
    }
  }

  if (!cli.env) {
    console.error("ERROR: --env is required (no default to prevent accidental prod writes)");
    console.error("       Use:  --env staging  or  --env prod");
    Deno.exit(1);
  }
  if (cli.prewarmTtlDays < 1 || cli.prewarmTtlDays > 3650) {
    console.error(`ERROR: --prewarm-ttl-days must be between 1 and 3650 (got ${cli.prewarmTtlDays})`);
    Deno.exit(1);
  }
  if (cli.concurrency < 1 || cli.concurrency > 32) {
    console.error("ERROR: --concurrency must be between 1 and 32");
    Deno.exit(1);
  }
  if (cli.modelId && cli.modelIdNot) {
    console.error("ERROR: --model-id and --model-id-not are mutually exclusive");
    Deno.exit(1);
  }

  return cli;
}

function printHelp(): void {
  console.log(`
Lexi-Lens cache prewarm restore.

Usage:
  deno run -A scripts/restore-prewarm.ts --env <staging|prod> [options]

Required:
  --env staging|prod        Filter cache_prewarm_seed.cache_env. No default.

Common options:
  --dry-run                     Read seed rows; do not write to Upstash.
  --prewarm-ttl-days N          TTL on Upstash writes, in days. Default: ${DEFAULT_PREWARM_TTL_DAYS}.
  --limit N                     Restore only first N rows.
  --model-id ID                 Only restore rows where model_id = ID.
  --model-id-not ID             Only restore rows where model_id != ID.
                                  (Use after a model swap to replace stale entries.)
  --concurrency N               Parallel Upstash writes, 1-32. Default 8.
  --verbose                     Per-row log lines.
  --help, -h                    Show this help.

Required env vars:
  UPSTASH_REDIS_REST_URL    UPSTASH_REDIS_REST_TOKEN
  SUPABASE_URL              SUPABASE_SERVICE_ROLE_KEY
`);
}

// ─── Upstash helpers ─────────────────────────────────────────────────────────

interface UpstashCfg { url: string; token: string; }

function readUpstashCfg(): UpstashCfg {
  const url   = Deno.env.get("UPSTASH_REDIS_REST_URL")?.trim();
  const token = Deno.env.get("UPSTASH_REDIS_REST_TOKEN")?.trim();
  if (!url || !token) {
    console.error("ERROR: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set in env");
    Deno.exit(1);
  }
  return { url, token };
}

async function cacheSetWithTtl(
  cfg:     UpstashCfg,
  key:     string,
  value:   string,
  ttlSecs: number,
): Promise<boolean> {
  try {
    const res = await fetch(cfg.url, {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["SET", key, value, "EX", ttlSecs]),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Postgres helpers ────────────────────────────────────────────────────────

interface PgCfg { url: string; serviceKey: string; }

function readPgCfg(): PgCfg {
  const url        = Deno.env.get("SUPABASE_URL")?.trim();
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (!url || !serviceKey) {
    console.error("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in env");
    Deno.exit(1);
  }
  return { url, serviceKey };
}

interface SeedRow {
  cache_env: string;
  label:     string;
  word:      string;
  cache_key: string;
  response:  Record<string, unknown>;
  model_id:  string;
}

/**
 * Page through cache_prewarm_seed via PostgREST. Filters by env and
 * optionally by model_id. Stops when a page returns fewer than the page
 * size, indicating the end of results.
 */
async function fetchSeedRows(
  cfg:        PgCfg,
  env:        string,
  filter:     { modelId?: string; modelIdNot?: string },
  limit:      number | null,
): Promise<SeedRow[]> {
  const all: SeedRow[] = [];
  let offset = 0;

  while (true) {
    if (limit !== null && all.length >= limit) break;
    const remaining = limit === null ? PG_PAGE_SIZE : Math.min(PG_PAGE_SIZE, limit - all.length);

    const params = new URLSearchParams({
      select:    "cache_env,label,word,cache_key,response,model_id",
      cache_env: `eq.${env}`,
      order:     "id.asc",
      limit:     String(remaining),
      offset:    String(offset),
    });
    if (filter.modelId)    params.append("model_id", `eq.${filter.modelId}`);
    if (filter.modelIdNot) params.append("model_id", `neq.${filter.modelIdNot}`);

    const res = await fetch(`${cfg.url}/rest/v1/cache_prewarm_seed?${params}`, {
      headers: {
        apikey:        cfg.serviceKey,
        Authorization: `Bearer ${cfg.serviceKey}`,
        Accept:        "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Postgres fetch failed (${res.status}): ${body}`);
    }
    const page = await res.json() as SeedRow[];
    all.push(...page);
    if (page.length < remaining) break;
    offset += page.length;
  }

  return all;
}

// ─── Worker pool ─────────────────────────────────────────────────────────────

async function runWithConcurrency<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (e) {
        results[idx] = e as R;
      }
    }
  });

  await Promise.all(workers);
  return results;
}

// ─── Confirmation prompt ─────────────────────────────────────────────────────

async function confirm(prompt: string): Promise<boolean> {
  const buf = new Uint8Array(8);
  Deno.stdout.writeSync(new TextEncoder().encode(prompt + " [y/N] "));
  const n = await Deno.stdin.read(buf);
  if (n === null) return false;
  const s = new TextDecoder().decode(buf.subarray(0, n)).trim().toLowerCase();
  return s === "y" || s === "yes";
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cli     = parseCli(Deno.args);
  const upstash = readUpstashCfg();
  const pg      = readPgCfg();
  const ttlSecs = cli.prewarmTtlDays * 24 * 60 * 60;

  console.log("");
  console.log("Lexi-Lens cache prewarm restore");
  console.log("───────────────────────────────");
  console.log(`  source        : Postgres cache_prewarm_seed (cache_env='${cli.env}')`);
  console.log(`  target        : Upstash (${new URL(upstash.url).hostname})`);
  console.log(`  TTL (Upstash) : ${cli.prewarmTtlDays} days`);
  if (cli.modelId)    console.log(`  filter        : model_id = ${cli.modelId}`);
  if (cli.modelIdNot) console.log(`  filter        : model_id != ${cli.modelIdNot}`);
  if (cli.limit)      console.log(`  limit         : ${cli.limit} rows`);
  console.log(`  concurrency   : ${cli.concurrency}`);
  console.log(`  dry-run       : ${cli.dryRun ? "yes" : "no"}`);
  console.log("");

  // Fetch seed rows
  console.log("Fetching seed rows from Postgres...");
  const fetchedAt = Date.now();
  const rows = await fetchSeedRows(
    pg, cli.env,
    { modelId: cli.modelId ?? undefined, modelIdNot: cli.modelIdNot ?? undefined },
    cli.limit,
  );
  console.log(`  fetched ${rows.length} rows in ${((Date.now() - fetchedAt) / 1000).toFixed(1)}s`);
  console.log("");

  if (rows.length === 0) {
    console.log("Nothing to restore. Exiting.");
    return;
  }

  // Production-write confirmation
  if (!cli.dryRun && /prod/i.test(cli.env)) {
    const ok = await confirm(
      `About to write ${rows.length} entries to PROD Upstash. Existing keys will be overwritten with TTL ${cli.prewarmTtlDays}d. Proceed?`
    );
    if (!ok) {
      console.log("Aborted.");
      Deno.exit(0);
    }
  }

  // Replay
  const startedAt = Date.now();
  const results = await runWithConcurrency(
    rows,
    async (row, idx) => {
      if (cli.dryRun) {
        if (cli.verbose) console.log(`  [DRY] ${row.label.padEnd(20)} :: ${row.word.padEnd(14)} → ${row.cache_key.slice(0, 60)}...`);
        return { ok: true, row, idx };
      }
      const value = JSON.stringify(row.response);
      const ok = await cacheSetWithTtl(upstash, row.cache_key, value, ttlSecs);
      if (cli.verbose) {
        const tag = ok ? "OK " : "FAIL";
        console.log(`  [${tag}] ${row.label.padEnd(20)} :: ${row.word.padEnd(14)}`);
      }
      return { ok, row, idx };
    },
    cli.concurrency,
  );

  // Summary
  let okCount   = 0;
  let failCount = 0;
  const failures: Array<{ label: string; word: string; key: string }> = [];
  for (const r of results) {
    const x = r as { ok: boolean; row: SeedRow };
    if (x.ok) okCount++;
    else {
      failCount++;
      failures.push({ label: x.row.label, word: x.row.word, key: x.row.cache_key });
    }
  }

  const elapsedS = (Date.now() - startedAt) / 1000;
  console.log("");
  console.log("───────────────────────────────");
  console.log(`  rows attempted: ${rows.length}`);
  console.log(`  ok:             ${okCount}`);
  console.log(`  failed:         ${failCount}`);
  console.log(`  elapsed:        ${elapsedS.toFixed(1)}s`);
  console.log("───────────────────────────────");
  console.log("");

  if (failures.length > 0) {
    console.error("Failures:");
    for (const f of failures.slice(0, 20)) {
      console.error(`  ${f.label} :: ${f.word}`);
    }
    if (failures.length > 20) console.error(`  ... and ${failures.length - 20} more`);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Unhandled error:", e);
    Deno.exit(2);
  });
}
