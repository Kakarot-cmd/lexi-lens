/**
 * scripts/eval-adapters.ts
 * Lexi-Lens — Phase 4.10b model evaluation harness.
 *
 * Iterates the prewarm corpus, calls evaluateObject() against each configured
 * model adapter, and produces a JSON manifest + console summary so you can
 * decide which model should be primary based on data instead of vibes.
 *
 * ─── This script does NOT ─────────────────────────────────────────────────
 *
 *   • Write to the response cache (Upstash).
 *   • Write to scan_attempts or cache_prewarm_seed.
 *   • Mutate any production state.
 *
 * Pure observation. The output JSON is the analytical artefact. The chosen
 * winner gets cached separately by re-running the existing prewarm-cache.ts
 * script with the appropriate provider flag.
 *
 * ─── Usage ────────────────────────────────────────────────────────────────
 *
 *   deno run --allow-env --allow-net --allow-read --allow-write \
 *     scripts/eval-adapters.ts \
 *       --corpus free_dungeon \
 *       --providers anthropic,gemini,openai,mistral \
 *       --out eval-results.json
 *
 *   Required env vars (only for the providers you actually pass):
 *     ANTHROPIC_API_KEY        — Haiku 4.5
 *     GOOGLE_AI_STUDIO_KEY     — Gemini family
 *     OPENAI_API_KEY           — GPT-4.1 nano family
 *     MISTRAL_API_KEY          — Mistral Small 4
 *
 *   Variant overrides (optional, default sensibly):
 *     GEMINI_MODEL_ID          — e.g. "gemini-2.5-flash-lite" (vs default 3.1 preview)
 *     OPENAI_MODEL_ID          — e.g. "gpt-4.1-nano"
 *     MISTRAL_MODEL_ID         — e.g. "mistral-small-2603"
 *     MISTRAL_REASONING_EFFORT — "none" | "low" | "medium" | "high"
 *
 * ─── Cost ceiling ─────────────────────────────────────────────────────────
 *
 *   ~$0.36 for free_dungeon × 4 providers (40 entries).
 *   ~$0.85 for full corpus × 4 providers (92 entries).
 *
 *   Run with --dry-run first to confirm setup before spending real money.
 */

import { evaluateObject } from "../supabase/functions/evaluate/evaluateObject.ts";
import { ADAPTERS, type ProviderKey } from "../supabase/functions/_shared/models/index.ts";
import { MODEL_PRICING, type ModelId } from "../supabase/functions/_shared/models/types.ts";
import { PREWARM_CORPUS, type PrewarmEntry } from "./prewarm-corpus.ts";

// ─── Inline progress writer (Deno-native, not process.stdout) ───────────────
const stdoutEncoder = new TextEncoder();
function writeStdout(s: string): void {
  try { Deno.stdout.writeSync(stdoutEncoder.encode(s)); } catch { /* non-fatal */ }
}

// ─── CLI parsing ─────────────────────────────────────────────────────────────

interface Args {
  corpus:       "free_dungeon" | "general_household" | "all";
  providers:    ProviderKey[];
  limit:        number | null;
  out:          string | null;
  concurrency:  number;
  delayMs:      number;
  dryRun:       boolean;
  showSamples:  number;
}

function parseArgs(): Args {
  const argv = Deno.args;
  const get = (k: string): string | undefined => {
    const idx = argv.findIndex((a) => a === `--${k}`);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const flag = (k: string): boolean => argv.includes(`--${k}`);

  const corpusArg = (get("corpus") ?? "free_dungeon").toLowerCase();
  if (!["free_dungeon", "general_household", "all"].includes(corpusArg)) {
    console.error(`Unknown --corpus "${corpusArg}". Use free_dungeon | general_household | all.`);
    Deno.exit(2);
  }

  const providersArg = (get("providers") ?? "anthropic,gemini,openai,mistral")
    .split(",").map((s) => s.trim().toLowerCase());
  const providers: ProviderKey[] = [];
  for (const p of providersArg) {
    if (p === "anthropic" || p === "gemini" || p === "openai" || p === "mistral") {
      providers.push(p);
    } else {
      console.error(`Unknown provider "${p}". Skipping.`);
    }
  }

  if (providers.length === 0) {
    console.error("No valid providers given. Aborting.");
    Deno.exit(2);
  }

  return {
    corpus:       corpusArg as Args["corpus"],
    providers,
    limit:        get("limit") ? parseInt(get("limit")!, 10) : null,
    out:          get("out") ?? null,
    concurrency:  get("concurrency") ? parseInt(get("concurrency")!, 10) : 3,
    delayMs:      get("delay-ms") ? parseInt(get("delay-ms")!, 10) : 0,
    dryRun:       flag("dry-run"),
    showSamples:  get("show-samples") ? parseInt(get("show-samples")!, 10) : 5,
  };
}

// ─── Corpus filtering ────────────────────────────────────────────────────────

function selectCorpus(args: Args): PrewarmEntry[] {
  let entries = PREWARM_CORPUS;
  if (args.corpus !== "all") {
    entries = entries.filter((e) => e.category === args.corpus);
  }
  if (args.limit !== null) {
    entries = entries.slice(0, args.limit);
  }
  return entries;
}

// ─── Age band → numeric child age ────────────────────────────────────────────

function ageFromBand(band: string | undefined | null): number {
  // Pick the upper bound of the band — gives the model the more challenging
  // end of the developmental range. Defaults to 8 if no band is provided
  // (corpus may use a flat structure without ageBand).
  if (!band || typeof band !== "string") return 8;
  const m = band.match(/(\d+)\s*-\s*(\d+)/);
  if (!m) return 8;
  return parseInt(m[2], 10);
}

// ─── Corpus entry normalisation ──────────────────────────────────────────────
//
// Supports two corpus shapes:
//
//   Rich (older PrewarmEntry):
//     { detectedLabel: "pillow", ageBand: "5-6", category: "free_dungeon",
//       questName: "...", properties: [{ word: "soft", definition: "...", evaluationHints?: "..." }, ...] }
//
//   Simple (current corpus):
//     { label: "pillow", category: "free_dungeon",
//       properties: ["soft", "fluffy", "smooth", "stretchy"] }
//
// Returns a normalized shape that evaluateObject() understands. Throws clearly
// when the entry can't be normalized — never silently passes broken data through.

interface NormalizedEntry {
  label:      string;
  category:   string;
  ageBand?:   string;
  questName?: string;
  requiredProperties: Array<{ word: string; definition: string; evaluationHints?: string }>;
}

function normalizeEntry(entry: unknown, idx: number): NormalizedEntry {
  if (!entry || typeof entry !== "object") {
    throw new Error(`Corpus entry ${idx} is not an object`);
  }
  const e = entry as Record<string, unknown>;

  const label = typeof e.label === "string" ? e.label
              : typeof e.detectedLabel === "string" ? e.detectedLabel
              : "";
  if (!label) {
    throw new Error(`Corpus entry ${idx} has no 'label' or 'detectedLabel' field. Got keys: ${Object.keys(e).join(", ")}`);
  }

  const category = typeof e.category === "string" ? e.category : "uncategorized";

  const propsRaw = e.properties;
  if (!Array.isArray(propsRaw) || propsRaw.length === 0) {
    throw new Error(`Corpus entry ${idx} (label="${label}") has no 'properties' array`);
  }

  const requiredProperties = propsRaw.map((p: unknown, pi: number) => {
    if (typeof p === "string") {
      // Simple shape: property is just a word. Use the word itself as a
      // minimal definition — the model knows what "soft" means without us
      // spelling it out, and this affects all candidate models equally so
      // the comparison stays fair.
      return { word: p, definition: p };
    }
    if (p && typeof p === "object") {
      const po = p as Record<string, unknown>;
      const word = typeof po.word === "string" ? po.word : "";
      if (!word) throw new Error(`Corpus entry ${idx} property ${pi} has no 'word'`);
      return {
        word,
        definition:      typeof po.definition      === "string" ? po.definition      : word,
        evaluationHints: typeof po.evaluationHints === "string" ? po.evaluationHints : undefined,
      };
    }
    throw new Error(`Corpus entry ${idx} property ${pi} is neither string nor object`);
  });

  return {
    label,
    category,
    ageBand:   typeof e.ageBand   === "string" ? e.ageBand   : undefined,
    questName: typeof e.questName === "string" ? e.questName : undefined,
    requiredProperties,
  };
}

// ─── Per-call result type ────────────────────────────────────────────────────

interface CallResult {
  success:            boolean;
  latencyMs?:         number;
  modelId?:           string;
  error?:             string;
  // EvaluationResult fields (when success):
  resolvedObjectName?: string;
  properties?:         Array<{ word: string; score: number; reasoning: string; passes: boolean }>;
  childFeedback?:      string;
  overallMatch?:       boolean;
  xpAwarded?:          number;
  // Cost / usage:
  estimatedCost?:      number;
  usage?:              { inputTokens?: number; outputTokens?: number };
}

// ─── Cost estimation ─────────────────────────────────────────────────────────

function estimateCost(modelId: ModelId, usage: { inputTokens?: number; outputTokens?: number } | undefined): number | undefined {
  if (!usage || (usage.inputTokens === undefined && usage.outputTokens === undefined)) return undefined;
  const pricing = MODEL_PRICING[modelId];
  if (!pricing) return undefined;
  const inCost  = (usage.inputTokens  ?? 0) / 1_000_000 * pricing.inputPerMillion;
  const outCost = (usage.outputTokens ?? 0) / 1_000_000 * pricing.outputPerMillion;
  return inCost + outCost;
}

// ─── Single (entry, provider) call ───────────────────────────────────────────

async function runOne(
  entry:    PrewarmEntry,
  idx:      number,
  provider: ProviderKey,
): Promise<CallResult> {
  const adapter = ADAPTERS[provider];
  if (!adapter.isConfigured()) {
    return { success: false, error: `Adapter ${provider} not configured (missing API key)` };
  }

  // Normalize the corpus entry up front. If the shape is wrong we want to
  // fail loudly with a clear error, not silently send junk to the model.
  let normalized: NormalizedEntry;
  try {
    normalized = normalizeEntry(entry, idx);
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }

  // Capture usage + latency from the adapter via a thin wrapper. Production
  // path is unaffected — this only exists for the eval's cost reporting.
  let capturedUsage: { inputTokens?: number; outputTokens?: number } | undefined;
  let capturedLatencyMs = 0;
  const wrappedAdapter = {
    get id() { return adapter.id; },
    isConfigured: () => adapter.isConfigured(),
    async call(opts: Parameters<typeof adapter.call>[0]) {
      const r = await adapter.call(opts);
      capturedUsage     = r.usage;
      capturedLatencyMs = r.latencyMs;
      return r;
    },
  };

  const start = Date.now();
  try {
    const { result } = await evaluateObject(
      {
        detectedLabel:      normalized.label,
        confidence:         0.85,
        frameBase64:        null,
        requiredProperties: normalized.requiredProperties,
        childAge:           ageFromBand(normalized.ageBand),
        failedAttempts:     0,
        questName:          normalized.questName,
        alreadyFoundWords:  [],
        xpRates:            { firstTry: 40, secondTry: 25, thirdPlus: 10 },
      },
      // deno-lint-ignore no-explicit-any
      wrappedAdapter as any,
    );

    const totalLatencyMs = capturedLatencyMs > 0 ? capturedLatencyMs : (Date.now() - start);
    const modelId = adapter.id;
    return {
      success:            true,
      latencyMs:          totalLatencyMs,
      modelId,
      resolvedObjectName: result.resolvedObjectName,
      properties:         result.properties,
      childFeedback:      result.childFeedback,
      overallMatch:       result.overallMatch,
      xpAwarded:          result.xpAwarded,
      usage:              capturedUsage,
      estimatedCost:      estimateCost(modelId as ModelId, capturedUsage),
    };
  } catch (e) {
    return {
      success:   false,
      latencyMs: Date.now() - start,
      modelId:   adapter.id,
      error:     e instanceof Error ? e.message : String(e),
    };
  }
}

// ─── Main loop with bounded concurrency per provider ─────────────────────────

async function runWithConcurrency<T, R>(
  items:       T[],
  worker:      (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function take() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, take));
  return results;
}

// ─── Aggregations ────────────────────────────────────────────────────────────

interface ProviderSummary {
  provider:           ProviderKey;
  modelId:            string;
  calls:              number;
  successes:          number;
  latencyP50:         number;
  latencyP95:         number;
  latencyMean:        number;
  totalCost:          number;
  verdictAgreement?:  number; // 0..1, % of properties where this provider's `passes` matches Haiku's
  resolveAgreement?:  number; // 0..1, % of entries where resolvedObjectName matches Haiku's (normalized)
}

function pct(n: number, d: number): number {
  return d > 0 ? n / d : 0;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function normalizeName(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ").replace(/s\b/g, "");
}

function summarize(
  providers:    ProviderKey[],
  perEntry:     Array<{ entry: PrewarmEntry; perProvider: Record<string, CallResult> }>,
): ProviderSummary[] {
  const summaries: ProviderSummary[] = [];
  const haikuKey: ProviderKey = "anthropic";
  const haikuPresent = providers.includes(haikuKey);

  for (const provider of providers) {
    const calls     = perEntry.length;
    const succ      = perEntry.filter((r) => r.perProvider[provider]?.success);
    const latencies = succ.map((r) => r.perProvider[provider]!.latencyMs ?? 0);
    const totalCost = succ.reduce((sum, r) => sum + (r.perProvider[provider]!.estimatedCost ?? 0), 0);

    let verdictAgreement: number | undefined;
    let resolveAgreement: number | undefined;

    if (haikuPresent && provider !== haikuKey) {
      let propMatches = 0, propTotal = 0, nameMatches = 0, nameTotal = 0;
      for (const row of perEntry) {
        const haiku = row.perProvider[haikuKey];
        const cand  = row.perProvider[provider];
        if (!haiku?.success || !cand?.success) continue;

        // Resolved-name agreement
        if (haiku.resolvedObjectName && cand.resolvedObjectName) {
          nameTotal++;
          if (normalizeName(haiku.resolvedObjectName) === normalizeName(cand.resolvedObjectName)) {
            nameMatches++;
          }
        }

        // Per-property agreement on `passes`
        const haikuByWord = new Map((haiku.properties ?? []).map((p) => [p.word.toLowerCase(), p]));
        for (const cp of cand.properties ?? []) {
          const hp = haikuByWord.get(cp.word.toLowerCase());
          if (!hp) continue;
          propTotal++;
          if (hp.passes === cp.passes) propMatches++;
        }
      }
      verdictAgreement = pct(propMatches, propTotal);
      resolveAgreement = pct(nameMatches, nameTotal);
    }

    summaries.push({
      provider,
      modelId:     ADAPTERS[provider].id,
      calls,
      successes:   succ.length,
      latencyP50:  percentile(latencies, 0.50),
      latencyP95:  percentile(latencies, 0.95),
      latencyMean: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
      totalCost,
      verdictAgreement,
      resolveAgreement,
    });
  }

  return summaries;
}

// ─── Disagreement extraction (for human review) ──────────────────────────────

interface Disagreement {
  detectedLabel:    string;
  propertyWord:     string;
  verdicts:         Record<string, { passes: boolean; score: number; reasoning: string }>;
}

function extractDisagreements(
  perEntry: Array<{ entry: PrewarmEntry; perProvider: Record<string, CallResult> }>,
  providers: ProviderKey[],
  limit: number,
): Disagreement[] {
  const out: Disagreement[] = [];
  for (const row of perEntry) {
    // deno-lint-ignore no-explicit-any
    const e = row.entry as any;
    const entryLabel = e.label ?? e.detectedLabel ?? "?";
    const propByWord: Map<string, Record<string, { passes: boolean; score: number; reasoning: string }>> = new Map();
    for (const provider of providers) {
      const r = row.perProvider[provider];
      if (!r?.success) continue;
      for (const p of r.properties ?? []) {
        const key = p.word.toLowerCase();
        if (!propByWord.has(key)) propByWord.set(key, {});
        propByWord.get(key)![provider] = { passes: p.passes, score: p.score, reasoning: p.reasoning };
      }
    }
    for (const [word, verdicts] of propByWord) {
      const passesValues = Object.values(verdicts).map((v) => v.passes);
      const allSame = passesValues.every((v) => v === passesValues[0]);
      if (!allSame) {
        out.push({ detectedLabel: entryLabel, propertyWord: word, verdicts });
      }
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// ─── Pretty print ────────────────────────────────────────────────────────────

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function fmtMs(ms: number): string { return `${Math.round(ms)}ms`; }
function fmt$(usd: number): string { return `$${usd.toFixed(4)}`; }
function fmtPct(p: number | undefined): string { return p === undefined ? "—" : `${(p * 100).toFixed(1)}%`; }

function printSummary(summaries: ProviderSummary[], totalEntries: number): void {
  console.log("");
  console.log(`═══ Eval summary (${totalEntries} corpus entries) ═══`);
  console.log("");
  console.log(
    pad("provider", 22) + pad("modelId", 26) + pad("ok", 8) +
    pad("p50 lat", 10) + pad("p95 lat", 10) +
    pad("cost", 12) + pad("verdict", 10) + pad("resolve", 10),
  );
  console.log("─".repeat(108));
  for (const s of summaries) {
    console.log(
      pad(s.provider, 22) +
      pad(s.modelId, 26) +
      pad(`${s.successes}/${s.calls}`, 8) +
      pad(fmtMs(s.latencyP50), 10) +
      pad(fmtMs(s.latencyP95), 10) +
      pad(fmt$(s.totalCost), 12) +
      pad(fmtPct(s.verdictAgreement), 10) +
      pad(fmtPct(s.resolveAgreement), 10),
    );
  }
  console.log("");
}

function printDisagreements(disagreements: Disagreement[]): void {
  if (disagreements.length === 0) {
    console.log("No verdict disagreements found.");
    return;
  }
  console.log(`═══ Verdict disagreements (sample of ${disagreements.length}) ═══`);
  console.log("");
  for (const d of disagreements) {
    console.log(`▸ ${d.detectedLabel} × ${d.propertyWord}`);
    for (const [provider, v] of Object.entries(d.verdicts)) {
      const flag = v.passes ? "PASS" : "FAIL";
      console.log(`  ${pad(provider, 14)} ${flag}  score=${v.score.toFixed(2)}  "${v.reasoning.slice(0, 80)}${v.reasoning.length > 80 ? "…" : ""}"`);
    }
    console.log("");
  }
}

function printChildFeedbackSamples(
  perEntry: Array<{ entry: PrewarmEntry; perProvider: Record<string, CallResult> }>,
  providers: ProviderKey[],
  count: number,
): void {
  console.log(`═══ childFeedback samples (${count} per provider, for tone review) ═══`);
  console.log("");
  for (const provider of providers) {
    const ok = perEntry.filter((r) => r.perProvider[provider]?.success && r.perProvider[provider]!.childFeedback);
    if (ok.length === 0) continue;
    console.log(`── ${provider} (${ADAPTERS[provider].id}) ──`);
    for (let i = 0; i < Math.min(count, ok.length); i++) {
      const idx = Math.floor(i * ok.length / count);
      const r = ok[idx];
      // Read label OR detectedLabel — corpus may use either field name.
      // deno-lint-ignore no-explicit-any
      const e = r.entry as any;
      const label = e.label ?? e.detectedLabel ?? "?";
      console.log(`  [${label}] ${r.perProvider[provider]!.childFeedback}`);
    }
    console.log("");
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  const corpus = selectCorpus(args);

  console.log(`[eval] corpus=${args.corpus} entries=${corpus.length} providers=${args.providers.join(",")} concurrency=${args.concurrency} delay=${args.delayMs}ms`);

  // Configuration check
  for (const p of args.providers) {
    const a = ADAPTERS[p];
    const ok = a.isConfigured();
    console.log(`[eval] adapter=${p.padEnd(10)} model=${a.id.padEnd(26)} configured=${ok}`);
    if (!ok) {
      console.error(`[eval] ${p} is missing its API key env var. Either remove from --providers or set the key.`);
    }
  }

  if (args.dryRun) {
    console.log("[eval] --dry-run flag set; not making any API calls.");
    return;
  }

  const startedAt = new Date().toISOString();
  console.log("");
  console.log(`[eval] running ${corpus.length} entries × ${args.providers.length} providers = ${corpus.length * args.providers.length} calls`);
  console.log("");

  // Run each provider's batch with bounded concurrency, but providers run sequentially
  // (avoids burst-rate-limit hits across providers — each provider gets clean throughput).
  const perEntry: Array<{ entry: PrewarmEntry; perProvider: Record<string, CallResult> }> =
    corpus.map((entry) => ({ entry, perProvider: {} }));

  for (const provider of args.providers) {
    const t0 = Date.now();
    writeStdout(`[eval] ${provider}: `);
    const callResults = await runWithConcurrency(
      perEntry.map((row, idx) => ({ row, idx })),
      async ({ row, idx }) => {
        if (args.delayMs > 0 && idx > 0) {
          await new Promise((r) => setTimeout(r, args.delayMs));
        }
        const r = await runOne(row.entry, idx, provider);
        writeStdout(r.success ? "." : "x");
        return { idx, result: r };
      },
      args.concurrency,
    );
    callResults.forEach(({ idx, result }) => { perEntry[idx].perProvider[provider] = result; });
    const elapsed = Date.now() - t0;
    const succ = callResults.filter((r) => r.result.success).length;
    writeStdout(`\n[eval] ${provider}: ${succ}/${callResults.length} ok in ${(elapsed / 1000).toFixed(1)}s\n`);
  }

  const summaries     = summarize(args.providers, perEntry);
  const disagreements = extractDisagreements(perEntry, args.providers, 10);
  const finishedAt    = new Date().toISOString();

  printSummary(summaries, corpus.length);
  printDisagreements(disagreements);
  printChildFeedbackSamples(perEntry, args.providers, args.showSamples);

  // ── Manifest output ──────────────────────────────────────────────────────
  if (args.out) {
    const manifest = {
      startedAt,
      finishedAt,
      args: {
        corpus:      args.corpus,
        providers:   args.providers,
        limit:       args.limit,
        concurrency: args.concurrency,
      },
      providers: args.providers.map((p) => ({
        provider:   p,
        modelId:    ADAPTERS[p].id,
        configured: ADAPTERS[p].isConfigured(),
      })),
      results: perEntry,
      summary: { perProvider: summaries, disagreements },
    };
    await Deno.writeTextFile(args.out, JSON.stringify(manifest, null, 2));
    console.log(`[eval] manifest written to ${args.out}`);
  }

  // ── Decision hint ────────────────────────────────────────────────────────
  console.log("");
  console.log("═══ Decision hint ═══");
  const haikuSummary = summaries.find((s) => s.provider === "anthropic");
  if (!haikuSummary) {
    console.log("Anthropic not in --providers list; can't anchor verdict agreement. Re-run with anthropic included.");
  } else {
    const ranked = summaries
      .filter((s) => s.provider !== "anthropic" && s.verdictAgreement !== undefined)
      .sort((a, b) => (b.verdictAgreement ?? 0) - (a.verdictAgreement ?? 0));
    if (ranked.length === 0) {
      console.log("No comparison data available.");
    } else {
      const best = ranked[0];
      const costRatio = haikuSummary.totalCost > 0 ? best.totalCost / haikuSummary.totalCost : 0;
      console.log(`Best non-Haiku: ${best.provider} (${best.modelId})`);
      console.log(`  • Verdict agreement vs Haiku: ${fmtPct(best.verdictAgreement)}`);
      console.log(`  • Resolve agreement vs Haiku: ${fmtPct(best.resolveAgreement)}`);
      console.log(`  • Cost ratio vs Haiku: ${(costRatio * 100).toFixed(1)}% (lower=cheaper)`);
      console.log(`  • Latency p50: ${fmtMs(best.latencyP50)} (Haiku: ${fmtMs(haikuSummary.latencyP50)})`);
      console.log("");
      if ((best.verdictAgreement ?? 0) >= 0.93) {
        console.log("→ Verdict agreement ≥93%. Strong candidate for primary; review childFeedback samples for tone before deciding.");
      } else if ((best.verdictAgreement ?? 0) >= 0.85) {
        console.log("→ Verdict agreement 85-93%. Viable as fallback; review disagreements to understand failure modes.");
      } else {
        console.log("→ Verdict agreement <85%. Likely not ready as fallback, let alone primary. Stay on Haiku.");
      }
    }
  }
}

if (import.meta.main) {
  await main();
}
