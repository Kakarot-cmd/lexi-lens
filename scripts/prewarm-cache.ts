/**
 * scripts/prewarm-cache.ts
 * Lexi-Lens — cache pre-warm runner.
 *
 * v2 (2026-05-09): adds long-TTL writes + Postgres seed-table durability.
 *
 *   • --prewarm-ttl-days N (default 365) — TTL written into Upstash. Free-tier
 *     dungeon entries should survive far longer than the 14-day production
 *     default. Production's user-write path still uses 14d; only the prewarm
 *     script writes long.
 *
 *   • Postgres seed table writes (cache_prewarm_seed) — every successful
 *     warm row is also persisted to Postgres in the same Supabase project.
 *     This is the durable source of truth: if Upstash is lost, drained, or
 *     migrated, restore-prewarm.ts replays from Postgres at $0 cost.
 *     Use --skip-pg to opt out (rare; mostly for debugging).
 *
 *   • cache_env column on the seed table mirrors --env, so a single seed
 *     table cleanly serves both staging and prod from one Supabase project.
 *
 * Walks the curated PREWARM_CORPUS, calls the same model adapter that
 * production uses, and writes the results directly to Upstash with the
 * v5.2 per-property cache key format + the v5.2.1 per-label resolved-name
 * cache key format. By design this BYPASSES the evaluate Edge Function so
 * it does not consume per-IP rate limits, per-child daily quotas, or
 * generate scan_attempts rows.
 *
 * Imports evaluateObject and the model adapters directly from the Edge
 * Function source tree, so the prewarmed entries are byte-for-byte
 * indistinguishable from organically-warmed ones (same prompt, same
 * normalisation, same cache schema, same _modelId stamp).
 *
 * ─── Run ───────────────────────────────────────────────────────────────────
 *
 *   # Free-dungeon block, staging, with Postgres seed-table writes
 *   deno run -A scripts/prewarm-cache.ts \
 *     --provider anthropic \
 *     --env staging \
 *     --category free_dungeon \
 *     --skip-cached \
 *     --max-cost 0.50
 *
 *   # Override TTL (default is 365 days for prewarm)
 *   deno run -A scripts/prewarm-cache.ts --env staging --prewarm-ttl-days 730
 *
 *   See scripts/README.md for the full operator runbook.
 *
 * ─── Required env vars ─────────────────────────────────────────────────────
 *
 *   UPSTASH_REDIS_REST_URL    — same value the target Supabase project uses
 *   UPSTASH_REDIS_REST_TOKEN  — read+write token
 *   ANTHROPIC_API_KEY         — when --provider=anthropic (default)
 *   GOOGLE_AI_STUDIO_KEY      — when --provider=gemini
 *
 *   SUPABASE_URL              — Postgres seed table writes (unless --skip-pg)
 *   SUPABASE_SERVICE_ROLE_KEY — same. Service-role required (RLS bypass on
 *                               cache_prewarm_seed).
 *
 *   CACHE_ENV_NAMESPACE is set via the --env CLI flag, NOT read from the
 *   shell, to make accidental prod writes harder.
 */

import {
  evaluateObject,
  type EvaluationResult,
  type PropertyRequirement,
  type PropertyScore,
} from "../supabase/functions/evaluate/evaluateObject.ts";
import { anthropicHaikuAdapter } from "../supabase/functions/_shared/models/anthropic.ts";
import { geminiAdapter }         from "../supabase/functions/_shared/models/gemini.ts";
import type { ModelAdapter }     from "../supabase/functions/_shared/models/types.ts";

import {
  PREWARM_CORPUS,
  CATEGORIES,
  TOTAL_ROWS,
  FREE_DUNGEON_STATS,
  type PrewarmEntry,
  type PrewarmProperty,
} from "./prewarm-corpus.ts";

// ─── Property normalisation helpers ──────────────────────────────────────────
//
// PrewarmEntry.properties is `Array<string | PrewarmProperty>`. Strings are
// unambiguous properties ("round", "soft"). Objects are hint-anchored
// properties — the model gets extra evaluationHints text to anchor judgement
// at the category level (e.g. "Accept PASS for any object with raised pile,
// plush, or fleece-like texture..."). The downstream cache code uses the
// word as a key, but the hint must flow through to the model when present
// so cache writes capture the hint-anchored verdict, not a hint-free one.

function propWord(p: string | PrewarmProperty): string {
  return typeof p === "string" ? p : p.word;
}

function propHint(p: string | PrewarmProperty): string | undefined {
  return typeof p === "string" ? undefined : p.evaluationHints;
}

// ─── Constants ───────────────────────────────────────────────────────────────

// Production write path uses 14d. The prewarm script defaults to 365d so
// free-tier dungeon entries don't silently age out. Override with
// --prewarm-ttl-days. Production's cacheSetProp is unchanged.
const DEFAULT_PREWARM_TTL_DAYS = 365;
const PREWARM_CHILD_AGE        = 6;     // mid-range; property scores are largely age-invariant
const COST_PER_HAIKU_CALL      = 0.0040;
const COST_PER_GEMINI_CALL     = 0.0010;

// Property-word definitions for the prompt. Production reads these from
// `quests.required_properties.definition`, but the prewarm corpus has no
// quest context. A short curated glossary keeps prompts clean for the
// most common property words; everything else falls through to the word
// itself as a self-definition (the model still infers correctly for
// simple sensory adjectives like "red" or "round").
const DEFINITIONS: Record<string, string> = {
  // colors
  red: "the color red", blue: "the color blue", green: "the color green",
  yellow: "the color yellow", orange: "the color orange", purple: "the color purple",
  pink: "the color pink", brown: "the color brown", white: "the color white",
  black: "the color black", colorful: "having many bright colors",
  // sizes
  big: "large in size", small: "little in size", tall: "high or long vertically",
  short: "not tall or long", long: "extending a great distance",
  thin: "not thick", thick: "wide from one side to the other",
  // textures
  soft: "easy to press or squish", hard: "firm and not easy to press",
  smooth: "having an even surface with no bumps",
  rough: "having a bumpy or uneven surface",
  fluffy: "soft and full of light bits like feathers or fur",
  bumpy: "having small raised parts on the surface",
  sticky: "tending to stick to other things",
  slippery: "easy to slide on or hard to grip",
  stretchy: "able to be pulled and bounce back",
  // shapes
  round: "shaped like a circle or ball", square: "shaped like a box with four equal sides",
  flat: "having a level surface, not bumpy or curved",
  pointy: "having a sharp tip", curved: "bending like part of a circle",
  oval: "shaped like a flattened circle, like an egg",
  rectangular: "shaped like a rectangle, with four corners and longer than it is wide",
  cylindrical: "shaped like a tube or can",
  // materials
  wooden: "made of wood", plastic: "made of plastic", metal: "made of metal",
  paper: "made of paper", glass: "made of glass", rubber: "made of rubber",
  cloth: "made of fabric or material",  ceramic: "made of fired clay, like a mug or plate",
  leather: "made of treated animal hide", waxy: "made of or feeling like wax",
  // properties
  heavy: "weighing a lot", light: "weighing very little",
  bright: "giving out a lot of light", shiny: "reflecting light, glossy",
  dull: "not shiny", transparent: "you can see through it",
  warm: "slightly hot to touch", cool: "slightly cold to touch",
  sharp: "with a fine edge or point", fragile: "easy to break",
  hollow: "empty inside", solid: "filled in, not hollow",
  flexible: "easy to bend without breaking",
  rigid: "completely stiff and impossible to bend",
  bouncy: "able to bounce back when dropped",
  // tastes / sensations
  sweet: "tastes like sugar", sour: "tastes sharp like lemon",
  // misc
  fruit: "a sweet plant food, usually with seeds", wet: "covered in water",
};

// ─── CLI parsing ─────────────────────────────────────────────────────────────

interface Cli {
  provider:       "anthropic" | "gemini";
  env:            string;
  dryRun:         boolean;
  skipCached:     boolean;
  skipPg:         boolean;
  prewarmTtlDays: number;
  maxCost:        number;
  limit:          number | null;
  categories:     string[] | null;
  concurrency:    number;
  manifest:       string | null;
  verbose:        boolean;
}

function parseCli(args: string[]): Cli {
  const cli: Cli = {
    provider:       "anthropic",
    env:            "",
    dryRun:         false,
    skipCached:     false,
    skipPg:         false,
    prewarmTtlDays: DEFAULT_PREWARM_TTL_DAYS,
    maxCost:        5,
    limit:          null,
    categories:     null,
    concurrency:    4,
    manifest:       null,
    verbose:        false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];

    switch (a) {
      case "--provider":         cli.provider = next() as Cli["provider"]; break;
      case "--env":              cli.env = next(); break;
      case "--dry-run":          cli.dryRun = true; break;
      case "--skip-cached":      cli.skipCached = true; break;
      case "--skip-pg":          cli.skipPg = true; break;
      case "--prewarm-ttl-days": cli.prewarmTtlDays = parseInt(next(), 10); break;
      case "--max-cost":         cli.maxCost = parseFloat(next()); break;
      case "--limit":            cli.limit = parseInt(next(), 10); break;
      case "--category":         cli.categories = next().split(",").map((s) => s.trim()); break;
      case "--concurrency":      cli.concurrency = parseInt(next(), 10); break;
      case "--manifest":         cli.manifest = next(); break;
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
  if (cli.provider !== "anthropic" && cli.provider !== "gemini") {
    console.error(`ERROR: --provider must be "anthropic" or "gemini" (got "${cli.provider}")`);
    Deno.exit(1);
  }
  if (cli.prewarmTtlDays < 1 || cli.prewarmTtlDays > 3650) {
    console.error(`ERROR: --prewarm-ttl-days must be between 1 and 3650 (got ${cli.prewarmTtlDays})`);
    Deno.exit(1);
  }
  if (cli.categories) {
    // CATEGORIES is typed as the literal union; .includes accepts only those
    // literals under strict TS. Cast to string[] for the membership check
    // since cli.categories is plain string[] from CLI parsing.
    const known = CATEGORIES as readonly string[];
    const unknown = cli.categories.filter((c) => !known.includes(c));
    if (unknown.length > 0) {
      console.error(`ERROR: unknown categories: ${unknown.join(", ")}`);
      console.error(`       Available: ${CATEGORIES.join(", ")}`);
      Deno.exit(1);
    }
  }
  if (cli.concurrency < 1 || cli.concurrency > 16) {
    console.error("ERROR: --concurrency must be between 1 and 16");
    Deno.exit(1);
  }

  return cli;
}

function printHelp(): void {
  console.log(`
Lexi-Lens cache pre-warm runner.

Usage:
  deno run -A scripts/prewarm-cache.ts --env <staging|prod> [options]

Required:
  --env staging|prod        Sets CACHE_ENV_NAMESPACE for cache key prefix.
                            No default (prevents accidental prod writes).

Common options:
  --provider anthropic|gemini   Model provider. Default: anthropic.
  --dry-run                     No model calls, no cache writes; report only.
  --skip-cached                 Skip entries already cached. Highly recommended on re-runs.
  --skip-pg                     Skip Postgres seed-table writes (Upstash only).
                                Default: write to both. Use only for debugging.
  --prewarm-ttl-days N          TTL for cache writes, in days. Default: ${DEFAULT_PREWARM_TTL_DAYS}.
                                Production's organic write path uses 14 days.
  --max-cost N                  Abort if estimated spend exceeds $N. Default 5.
  --limit N                     Process only first N entries.
  --category food,toys          Run only matching categories. Default: all.
                                Available: ${CATEGORIES.join(", ")}.
  --concurrency N               Parallel model calls, 1-16. Default 4.
  --manifest path/to/file.json  Write JSON manifest of all writes.
  --verbose                     Per-property log lines (default: per-entry).
  --help, -h                    Show this help.

Required env vars:
  UPSTASH_REDIS_REST_URL    UPSTASH_REDIS_REST_TOKEN
  ANTHROPIC_API_KEY         (anthropic provider)
  GOOGLE_AI_STUDIO_KEY      (gemini provider)
  SUPABASE_URL              (Postgres seed-table writes; --skip-pg disables)
  SUPABASE_SERVICE_ROLE_KEY (same; service role required)
`);
}

// ─── Cache key builders (must match production byte-for-byte) ────────────────

/**
 * IMPORTANT: this normalize() must match
 *   supabase/functions/evaluate/index.ts → normalize()
 * exactly. If production's normalisation rules ever change, mirror them here
 * and re-run the prewarm against the changed corpus.
 */
function normalize(s: string): string {
  return s.toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/([a-z]{2,})([^se])s\b/g, "$1$2");
}

function buildPerPropCacheKey(envNs: string, label: string, word: string): string {
  const raw = `${normalize(label)}::${normalize(word)}`;
  return `${envNs}:lexi:eval:prop:${btoa(raw).replace(/=/g, "")}`;
}

function buildResolvedNameCacheKey(envNs: string, label: string): string {
  const raw = normalize(label);
  return `${envNs}:lexi:eval:resolved:${btoa(raw).replace(/=/g, "")}`;
}

// ─── Upstash helpers (raw REST, matches production transport) ────────────────

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

async function cacheGetRaw(cfg: UpstashCfg, key: string): Promise<string | null> {
  try {
    const res = await fetch(`${cfg.url}/get/${key}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    if (!res.ok) return null;
    const json = await res.json() as { result?: string | null };
    return json.result ?? null;
  } catch {
    return null;
  }
}

async function cacheHasValidProp(cfg: UpstashCfg, key: string): Promise<boolean> {
  const raw = await cacheGetRaw(cfg, key);
  if (raw === null) return false;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    return (
      typeof p.word      === "string" &&
      typeof p.score     === "number" &&
      typeof p.reasoning === "string" &&
      typeof p.passes    === "boolean"
    );
  } catch {
    return false;
  }
}

async function cacheSetWithTtl(
  cfg:      UpstashCfg,
  key:      string,
  value:    string,
  ttlSecs:  number,
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

// ─── Postgres seed-table helpers ─────────────────────────────────────────────
//
// Writes to public.cache_prewarm_seed via the Supabase REST API. Same
// pattern as the rest of your Edge Functions: native fetch, no SDK.
// Service-role required (RLS denies anon/authenticated; this is admin-only data).

interface PgCfg { url: string; serviceKey: string; }

function readPgCfg(): PgCfg | null {
  const url        = Deno.env.get("SUPABASE_URL")?.trim();
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (!url || !serviceKey) {
    console.error("WARN: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — Postgres seed writes disabled");
    console.error("      (set both, or pass --skip-pg to silence this)");
    return null;
  }
  return { url, serviceKey };
}

interface SeedRow {
  cache_env:    string;
  label:        string;
  word:         string;
  cache_key:    string;
  response:     {
    word:      string;
    score:     number;
    reasoning: string;
    passes:    boolean;
    _modelId:  string;
  };
  model_id:     string;
}

async function pgUpsertSeedRow(cfg: PgCfg, row: SeedRow): Promise<boolean> {
  try {
    // POST with Prefer: resolution=merge-duplicates → upsert via the
    // (cache_env, label, word) unique index defined in the migration.
    const res = await fetch(`${cfg.url}/rest/v1/cache_prewarm_seed`, {
      method: "POST",
      headers: {
        apikey:           cfg.serviceKey,
        Authorization:    `Bearer ${cfg.serviceKey}`,
        "Content-Type":   "application/json",
        Prefer:           "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(row),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Adapter selection ───────────────────────────────────────────────────────

function pickAdapter(provider: Cli["provider"]): ModelAdapter {
  const adapter: ModelAdapter = provider === "anthropic"
    ? anthropicHaikuAdapter
    : geminiAdapter;

  if (!adapter.isConfigured()) {
    const expectedKey = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "GOOGLE_AI_STUDIO_KEY";
    console.error(`ERROR: provider=${provider} but ${expectedKey} is not set`);
    Deno.exit(1);
  }
  return adapter;
}

// ─── Cost estimation ─────────────────────────────────────────────────────────

function estimateCost(entries: readonly PrewarmEntry[], provider: Cli["provider"]): number {
  const perCall = provider === "anthropic" ? COST_PER_HAIKU_CALL : COST_PER_GEMINI_CALL;
  return entries.length * perCall;
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

// ─── Per-entry processor ─────────────────────────────────────────────────────

interface EntryOutcome {
  entry:           PrewarmEntry;
  status:          "warmed" | "skipped-cached" | "failed";
  reason?:         string;
  modelLatencyMs?: number;
  modelId?:        string;
  resolvedName?:   string;
  perProperty:     Array<{
    word:      string;
    cacheKey:  string;
    status:    "wrote" | "skipped-cached" | "skipped-missing-from-response" | "skipped-bad-shape" | "failed";
    score?:    number;
    passes?:   boolean;
    pgWrote?:  boolean;
  }>;
}

async function processEntry(
  entry:    PrewarmEntry,
  cli:      Cli,
  adapter:  ModelAdapter,
  upstash:  UpstashCfg,
  pg:       PgCfg | null,
  envNs:    string,
  ttlSecs:  number,
): Promise<EntryOutcome> {
  const out: EntryOutcome = { entry, status: "warmed", perProperty: [] };

  // Normalize entry.properties (Array<string | PrewarmProperty>) → string[]
  // for cache key construction and Set membership checks. Hints are kept
  // in a side-channel Map so they can flow through to the model call.
  const propWords: string[]               = entry.properties.map(propWord);
  const hintByWord: Map<string, string>   = new Map();
  for (const p of entry.properties) {
    const h = propHint(p);
    if (h) hintByWord.set(propWord(p).toLowerCase(), h);
  }

  const preflightKeys = propWords.map((word) => ({
    word,
    key:  buildPerPropCacheKey(envNs, entry.label, word),
  }));

  let cachedSet = new Set<string>();
  if (cli.skipCached) {
    const checks = await Promise.all(
      preflightKeys.map(async ({ word, key }) => ({
        word,
        cached: await cacheHasValidProp(upstash, key),
      }))
    );
    cachedSet = new Set(checks.filter((c) => c.cached).map((c) => c.word));

    if (cachedSet.size === propWords.length) {
      out.status = "skipped-cached";
      out.reason = "all properties already cached";
      out.perProperty = preflightKeys.map(({ word, key }) => ({
        word,
        cacheKey: key,
        status:   "skipped-cached",
      }));
      return out;
    }
  }

  const missingProperties: string[] = propWords.filter((w) => !cachedSet.has(w));
  for (const word of propWords) {
    if (cachedSet.has(word)) {
      out.perProperty.push({
        word,
        cacheKey: buildPerPropCacheKey(envNs, entry.label, word),
        status:   "skipped-cached",
      });
    }
  }

  if (cli.dryRun) {
    out.status = "warmed";
    out.reason = `dry-run (would warm ${missingProperties.length}/${propWords.length} props)`;
    for (const word of missingProperties) {
      out.perProperty.push({
        word,
        cacheKey: buildPerPropCacheKey(envNs, entry.label, word),
        status:   "wrote",
      });
    }
    return out;
  }

  const requiredProperties: PropertyRequirement[] = missingProperties.map((word) => ({
    word,
    definition:      DEFINITIONS[word.toLowerCase()] ?? word,
    evaluationHints: hintByWord.get(word.toLowerCase()),
  }));

  let result: EvaluationResult;
  const startedAt = Date.now();
  try {
    // v6.0 note: evaluateObject's return shape is { result, freshProperties,
    // resolvedObjectName }. We destructure `result` for verdict + properties
    // (the v5-shaped PropertyScore[]) and ignore `freshProperties` (the v6
    // shape with kid_msg/nudge) and the outer resolvedObjectName.
    //
    // This means the cache values this script writes are v5-shaped — they
    // will be rejected by v6 evaluate's strict shape validator with the
    // CACHE_SHAPE_INVALID prefix, treated as miss. If/when prewarm is
    // revived post-launch, switch this to use freshProperties and write
    // the v6 shape (kid_msg.young/older, nudge, meta block). See the
    // outstanding-from-v6.0-PR list in the roadmap.
    const evalOutput = await evaluateObject(
      {
        detectedLabel:     entry.label,
        confidence:        1.0,
        frameBase64:       null,
        requiredProperties,
        childAge:          PREWARM_CHILD_AGE,
        failedAttempts:    0,
        questName:         undefined,
        masteryProfile:    undefined,
        alreadyFoundWords: [],
      },
      adapter,
    );
    result = evalOutput.result;
    out.modelLatencyMs = Date.now() - startedAt;
    out.modelId        = adapter.id;
    out.resolvedName   = evalOutput.resolvedObjectName;
  } catch (e) {
    out.status = "failed";
    out.reason = e instanceof Error ? e.message : String(e);
    return out;
  }

  const responseByWord = new Map<string, PropertyScore>();
  for (const p of result.properties) {
    if (typeof p.word === "string") responseByWord.set(p.word.toLowerCase(), p);
  }

  for (const word of missingProperties) {
    const key          = buildPerPropCacheKey(envNs, entry.label, word);
    const fromResponse = responseByWord.get(word.toLowerCase());

    if (!fromResponse) {
      out.perProperty.push({ word, cacheKey: key, status: "skipped-missing-from-response" });
      continue;
    }
    if (
      typeof fromResponse.score     !== "number" ||
      typeof fromResponse.reasoning !== "string" ||
      typeof fromResponse.passes    !== "boolean" ||
      Number.isNaN(fromResponse.score) ||
      fromResponse.score < 0 || fromResponse.score > 1
    ) {
      out.perProperty.push({ word, cacheKey: key, status: "skipped-bad-shape" });
      continue;
    }

    const valueObj = {
      word:      fromResponse.word,
      score:     fromResponse.score,
      reasoning: fromResponse.reasoning,
      passes:    fromResponse.passes,
      _modelId:  adapter.id,
    };
    const value = JSON.stringify(valueObj);

    // 1. Upstash write (long TTL)
    const ok = await cacheSetWithTtl(upstash, key, value, ttlSecs);

    // 2. Postgres seed-table write (no TTL — durable source of truth)
    let pgOk: boolean | undefined;
    if (ok && pg && !cli.skipPg) {
      pgOk = await pgUpsertSeedRow(pg, {
        cache_env: envNs,
        label:     entry.label,
        word,
        cache_key: key,
        response:  valueObj,
        model_id:  adapter.id,
      });
    }

    out.perProperty.push({
      word,
      cacheKey: key,
      status:   ok ? "wrote" : "failed",
      score:    fromResponse.score,
      passes:   fromResponse.passes,
      pgWrote:  pgOk,
    });
  }

  // ── Write per-label resolved-name cache (mirror production guards) ───────
  const resolved = result.resolvedObjectName?.trim() ?? "";
  if (resolved.length > 0 && normalize(resolved) !== normalize(entry.label)) {
    const resolvedKey = buildResolvedNameCacheKey(envNs, entry.label);
    const resolvedValue = JSON.stringify({ name: resolved, _modelId: adapter.id });
    await cacheSetWithTtl(upstash, resolvedKey, resolvedValue, ttlSecs);
  }

  return out;
}

// ─── Logging helpers ─────────────────────────────────────────────────────────

function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

function logEntry(o: EntryOutcome, verbose: boolean): void {
  const tag = o.status === "warmed" ? "WARM"
            : o.status === "skipped-cached" ? "SKIP"
            : "FAIL";
  const wrote = o.perProperty.filter((p) => p.status === "wrote").length;
  const total = o.perProperty.length;
  const meta  = o.modelLatencyMs ? ` ${o.modelLatencyMs}ms` : "";
  const note  = o.reason ? ` (${o.reason})` : "";
  console.log(`  [${tag}] ${o.entry.label.padEnd(20)} ${wrote}/${total} props${meta}${note}`);
  if (verbose) {
    for (const p of o.perProperty) {
      const bit = p.score !== undefined
        ? ` score=${p.score.toFixed(2)} passes=${p.passes}${p.pgWrote === false ? " pg=FAIL" : p.pgWrote ? " pg=ok" : ""}`
        : "";
      console.log(`         · ${p.word.padEnd(14)} ${p.status}${bit}`);
    }
  }
}

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
  const pg      = cli.skipPg ? null : readPgCfg();
  const adapter = cli.dryRun
    ? anthropicHaikuAdapter
    : pickAdapter(cli.provider);
  const envNs   = cli.env;
  const ttlSecs = cli.prewarmTtlDays * 24 * 60 * 60;

  let entries: readonly PrewarmEntry[] = PREWARM_CORPUS;
  if (cli.categories) {
    entries = entries.filter((e) => cli.categories!.includes(e.category));
  }
  if (cli.limit !== null && cli.limit > 0) {
    entries = entries.slice(0, cli.limit);
  }

  const totalProps = entries.reduce((n, e) => n + e.properties.length, 0);
  const estCost    = estimateCost(entries, cli.provider);

  console.log("");
  console.log("Lexi-Lens cache pre-warm");
  console.log("────────────────────────");
  console.log(`  env namespace : ${envNs}`);
  console.log(`  provider      : ${cli.provider}  (modelId: ${adapter.id})`);
  console.log(`  TTL (Upstash) : ${cli.prewarmTtlDays} days  (${ttlSecs.toLocaleString()}s)`);
  console.log(`  Postgres seed : ${pg ? "yes (cache_prewarm_seed)" : "DISABLED (no creds or --skip-pg)"}`);
  console.log(`  entries       : ${entries.length}/${PREWARM_CORPUS.length} corpus rows`);
  console.log(`  cache rows    : ${totalProps}/${TOTAL_ROWS} (per-property writes)`);
  console.log(`  free-dungeon  : ${FREE_DUNGEON_STATS.entries} entries / ${FREE_DUNGEON_STATS.rows} rows in corpus`);
  console.log(`  est. cost     : ${fmtCost(estCost)} ${cli.dryRun ? "(no charge — dry run)" : ""}`);
  console.log(`  concurrency   : ${cli.concurrency}`);
  console.log(`  skip-cached   : ${cli.skipCached ? "yes" : "no"}`);
  console.log(`  dry-run       : ${cli.dryRun ? "yes" : "no"}`);
  console.log("");

  if (!cli.dryRun && estCost > cli.maxCost) {
    console.error(`Estimated cost ${fmtCost(estCost)} exceeds --max-cost ${fmtCost(cli.maxCost)}.`);
    console.error(`Either raise --max-cost or narrow with --limit / --category.`);
    Deno.exit(1);
  }

  if (!cli.dryRun && /prod/i.test(envNs)) {
    const ok = await confirm(`About to write to PROD cache namespace "${envNs}". Proceed?`);
    if (!ok) {
      console.log("Aborted.");
      Deno.exit(0);
    }
  }

  const startedAt = Date.now();
  const results = await runWithConcurrency(
    entries,
    (entry) => processEntry(entry, cli, adapter, upstash, pg, envNs, ttlSecs),
    cli.concurrency,
  );

  console.log("Results:");
  results.forEach((r) => logEntry(r as EntryOutcome, cli.verbose));

  const summary = {
    warmed:  0,
    skipped: 0,
    failed:  0,
    rowsWritten:    0,
    rowsSkipped:    0,
    rowsFailed:     0,
    pgRowsWritten:  0,
    pgRowsFailed:   0,
  };
  for (const r of results) {
    const o = r as EntryOutcome;
    if (o.status === "warmed")          summary.warmed++;
    if (o.status === "skipped-cached")  summary.skipped++;
    if (o.status === "failed")          summary.failed++;
    for (const p of o.perProperty) {
      if (p.status === "wrote")          summary.rowsWritten++;
      if (p.status === "skipped-cached") summary.rowsSkipped++;
      if (p.status === "failed")         summary.rowsFailed++;
      if (p.pgWrote === true)            summary.pgRowsWritten++;
      if (p.pgWrote === false)           summary.pgRowsFailed++;
    }
  }

  const elapsedS = (Date.now() - startedAt) / 1000;
  const actualCost = cli.dryRun
    ? 0
    : (summary.warmed * (cli.provider === "anthropic" ? COST_PER_HAIKU_CALL : COST_PER_GEMINI_CALL));

  console.log("");
  console.log("────────────────────────");
  console.log(`  warmed entries:     ${summary.warmed}`);
  console.log(`  skipped (cached):   ${summary.skipped}`);
  console.log(`  failed entries:     ${summary.failed}`);
  console.log(`  cache rows wrote:   ${summary.rowsWritten}`);
  console.log(`  cache rows skip:    ${summary.rowsSkipped}`);
  console.log(`  cache rows fail:    ${summary.rowsFailed}`);
  if (pg) {
    console.log(`  pg seed rows ok:    ${summary.pgRowsWritten}`);
    console.log(`  pg seed rows fail:  ${summary.pgRowsFailed}`);
  }
  console.log(`  elapsed:            ${elapsedS.toFixed(1)}s`);
  console.log(`  actual cost:        ~${fmtCost(actualCost)}`);
  console.log("────────────────────────");
  console.log("");

  if (cli.manifest) {
    const manifest = {
      runAt:        new Date().toISOString(),
      env:          envNs,
      provider:     cli.provider,
      modelId:      adapter.id,
      ttlDays:      cli.prewarmTtlDays,
      pgSeedWrites: pg !== null && !cli.skipPg,
      dryRun:       cli.dryRun,
      summary,
      elapsedMs:    Date.now() - startedAt,
      estCostUsd:   estCost,
      actualCostUsd: actualCost,
      entries: results.map((r) => {
        const o = r as EntryOutcome;
        return {
          label:          o.entry.label,
          category:       o.entry.category,
          status:         o.status,
          reason:         o.reason,
          modelLatencyMs: o.modelLatencyMs,
          modelId:        o.modelId,
          resolvedName:   o.resolvedName,
          properties:     o.perProperty.map((p) => ({
            word:     p.word,
            cacheKey: p.cacheKey,
            status:   p.status,
            score:    p.score,
            passes:   p.passes,
            pgWrote:  p.pgWrote,
          })),
        };
      }),
    };
    await Deno.writeTextFile(cli.manifest, JSON.stringify(manifest, null, 2));
    console.log(`  manifest written to: ${cli.manifest}`);
    console.log("");
  }

  if (summary.failed > 0) {
    console.error(`Exiting with code 1 — ${summary.failed} entries failed.`);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Unhandled error:", e);
    Deno.exit(2);
  });
}
