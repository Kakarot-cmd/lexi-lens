/**
 * supabase/functions/classify-words/index.ts
 * Lexi-Lens — N3: Mastery Radar Chart
 *
 * Classifies vocabulary words by sensory domain using Claude.
 * Writes results to the global `word_domains` lookup table, so each unique
 * word is classified ONCE across the entire user base — subsequent calls
 * for the same word are free database reads.
 *
 * Input:  { words: Array<{ word: string; definition: string }> }
 * Output: {
 *   classifications: Array<{ word: string; domain: Domain; confidence: 'high'|'medium'|'low' }>,
 *   classified: number,   // newly classified by this call
 *   cached:     number,   // already in DB before this call
 *   skipped:    number,   // empty/invalid input rows
 * }
 *
 * Conventions matched against retire-word/index.ts and generate-quest/index.ts:
 *   • Direct fetch() to Anthropic API — NEVER the SDK (esm.sh times out at bundle).
 *   • Deno.env.get for ANTHROPIC_API_KEY (not process.env — that's Node).
 *   • std@0.168.0/http/server — same version as other deployed EFs.
 *   • Same CORS_HEADERS shape, same anthropic-version header.
 *   • Model: claude-haiku-4-5-20251001 — bucketing into 6 domains is exactly
 *     the kind of simple eval Haiku 4.5 was designed for. ~65% cheaper than
 *     Sonnet for this task.
 *
 * Deploy:
 *   supabase functions deploy classify-words --no-verify-jwt
 *
 * Required environment variables (set via Supabase Dashboard → Edge Functions
 * → classify-words → Secrets):
 *   ANTHROPIC_API_KEY            — your Anthropic API key
 *   SUPABASE_URL                 — auto-provided by Supabase runtime
 *   SUPABASE_SERVICE_ROLE_KEY    — auto-provided by Supabase runtime
 *
 * Cost notes:
 *   At Haiku 4.5 prices (~$1/$5 per MTok), classifying 100 unique words costs
 *   ~$0.005. Across 1,000 children with ~50 words each averaging 70%
 *   cross-child reuse, total cost is roughly $1.50 for the entire user base.
 *   Re-classification never happens — once in word_domains, always in word_domains.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.0";

// ─── Constants ────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

const MODEL              = "claude-haiku-4-5-20251001";
const ANTHROPIC_API_URL  = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION  = "2023-06-01";

const VALID_DOMAINS = [
  "texture", "colour", "structure", "sound", "shape", "material", "other",
] as const;
type Domain = typeof VALID_DOMAINS[number];

const VALID_CONFIDENCE = ["high", "medium", "low"] as const;
type Confidence = typeof VALID_CONFIDENCE[number];

/** Hard cap on words processed per request — protects against runaway calls. */
const MAX_INPUT_WORDS = 200;

/** Words per Claude batch — small enough to fit context comfortably, big
 *  enough that overhead per word is negligible. */
const BATCH_SIZE = 25;

/** max_tokens budget per batch. ~25 classifications × ~40 tokens each + slack. */
const MAX_TOKENS_PER_BATCH = 1500;

// ─── Types ────────────────────────────────────────────────────────────────

interface InputWord  { word: string; definition: string; }
interface Classification {
  word:       string;
  domain:     Domain;
  confidence: Confidence;
}

// ─── Server ───────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST")    return jsonResponse({ error: "Method not allowed" }, 405);

  // ── Parse + validate input ──────────────────────────────────────────────
  let body: { words?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Body must be valid JSON" }, 400);
  }

  if (!Array.isArray(body.words)) {
    return jsonResponse({ error: "Body must include `words: Array<{word, definition}>`" }, 400);
  }

  const cleaned = sanitizeInput(body.words);
  if (cleaned.length === 0) {
    return jsonResponse({ classifications: [], classified: 0, cached: 0, skipped: body.words.length });
  }

  // ── Wire up clients ─────────────────────────────────────────────────────
  const anthropicKey  = Deno.env.get("ANTHROPIC_API_KEY");
  const supabaseUrl   = Deno.env.get("SUPABASE_URL");
  const serviceKey    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!anthropicKey || !supabaseUrl || !serviceKey) {
    console.error("[classify-words] missing required env vars");
    return jsonResponse({ error: "Server configuration error" }, 500);
  }
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── Skip already-classified words (the cache) ───────────────────────────
  const inputWords = cleaned.map((w) => w.word);
  const { data: existing, error: lookupErr } = await supabase
    .from("word_domains")
    .select("word")
    .in("word", inputWords);

  if (lookupErr) {
    console.error("[classify-words] cache lookup failed:", lookupErr.message);
    // Don't fail the request — just skip the cache and classify everything.
  }

  const cachedSet = new Set((existing ?? []).map((r) => r.word as string));
  const toClassify = cleaned.filter((w) => !cachedSet.has(w.word));

  if (toClassify.length === 0) {
    return jsonResponse({
      classifications: [],
      classified: 0,
      cached:     cleaned.length,
      skipped:    body.words.length - cleaned.length,
    });
  }

  // ── Classify in batches ─────────────────────────────────────────────────
  const allClassifications: Classification[] = [];

  for (let i = 0; i < toClassify.length; i += BATCH_SIZE) {
    const batch = toClassify.slice(i, i + BATCH_SIZE);
    try {
      const result = await classifyBatch(batch, anthropicKey);
      allClassifications.push(...result);
    } catch (e) {
      console.error("[classify-words] batch failed:", (e as Error).message);
      // Continue with the next batch; partial progress is better than none.
    }
  }

  // ── Persist (idempotent — ON CONFLICT DO NOTHING) ───────────────────────
  if (allClassifications.length > 0) {
    const rows = allClassifications.map((c) => ({
      word:       c.word,
      domain:     c.domain,
      confidence: c.confidence,
    }));
    const { error: upsertErr } = await supabase
      .from("word_domains")
      .upsert(rows, { onConflict: "word", ignoreDuplicates: true });

    if (upsertErr) {
      console.error("[classify-words] upsert failed:", upsertErr.message);
      // Still return what we classified so the caller has the data even if
      // persistence had a transient issue.
    }
  }

  return jsonResponse({
    classifications: allClassifications,
    classified:      allClassifications.length,
    cached:          cleaned.length - toClassify.length,
    skipped:         body.words.length - cleaned.length,
  });
});

// ─── Input sanitisation ───────────────────────────────────────────────────

function sanitizeInput(rawWords: unknown[]): InputWord[] {
  const out: InputWord[] = [];
  const seen = new Set<string>();

  for (const raw of rawWords.slice(0, MAX_INPUT_WORDS)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { word?: unknown; definition?: unknown };
    const word = typeof r.word === "string" ? r.word.toLowerCase().trim() : "";
    const def  = typeof r.definition === "string" ? r.definition.trim() : "";
    if (!word || word.length > 50) continue;        // sanity bounds
    if (seen.has(word)) continue;                   // dedupe within request
    seen.add(word);
    out.push({ word, definition: def });
  }
  return out;
}

// ─── Claude call ──────────────────────────────────────────────────────────

async function classifyBatch(
  batch: InputWord[],
  apiKey: string
): Promise<Classification[]> {
  const wordList = batch
    .map((w, i) => `${i + 1}. "${w.word}"${w.definition ? ` — ${w.definition}` : ""}`)
    .join("\n");

  const systemPrompt = `You classify English vocabulary words by their primary sensory domain for a children's vocabulary game.

Domains (assign each word to EXACTLY ONE):
- texture:   how it feels to touch (fuzzy, smooth, rough, soft, hard, slippery, sticky, bumpy)
- colour:    visual hue, brightness, or saturation (red, vivid, pale, dim, transparent, opaque)
- shape:     2D or 3D geometric form (round, square, curved, pointed, flat, angular, oval)
- structure: physical configuration or arrangement (tall, hollow, layered, solid, dense, woven, branched)
- sound:     auditory quality (loud, quiet, sharp, dull, melodic, harsh, echoing)
- material:  what something is made of (metal, wood, plastic, fabric, glass, stone, paper, rubber)
- other:     abstract qualities or words that don't fit the above (heavy, useful, ancient, strong)

Rules:
1. Pick the SINGLE most appropriate domain. If a word could fit two, pick the most concrete/sensory one.
2. "heavy" is OTHER (it's a force/effect, not a sensory category above).
3. "shiny" is COLOUR (it's a brightness quality), not texture.
4. "warm" is OTHER (it's temperature, not above).
5. Confidence: "high" if the word obviously belongs to that domain; "medium" if reasonable but ambiguous; "low" if you're guessing.

Output STRICT JSON only, no commentary, no markdown fences:
{"classifications":[{"word":"<lowercase>","domain":"<domain>","confidence":"high|medium|low"}, ...]}

Include every input word exactly once. Preserve the lowercase form.`;

  const response = await fetch(ANTHROPIC_API_URL, {
    method:  "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: MAX_TOKENS_PER_BATCH,
      system:     systemPrompt,
      messages: [
        { role: "user", content: `Classify these words:\n\n${wordList}` },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "(unreadable)");
    throw new Error(`Anthropic ${response.status}: ${errText.slice(0, 200)}`);
  }

  const apiResponse = await response.json() as {
    content: Array<{ type: string; text?: string }>;
  };

  const rawText = apiResponse.content
    .filter((b) => b.type === "text")
    .map((b)   => b.text ?? "")
    .join("");

  return parseClassifications(rawText, batch);
}

// ─── Output parsing + validation ──────────────────────────────────────────

function parseClassifications(rawText: string, batch: InputWord[]): Classification[] {
  const cleaned = rawText.replace(/```json|```/g, "").trim();

  let parsed: { classifications?: unknown };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.error("[classify-words] non-JSON response:", cleaned.slice(0, 300));
    return [];
  }

  if (!parsed || !Array.isArray(parsed.classifications)) return [];

  const inputWordSet = new Set(batch.map((w) => w.word));
  const validated: Classification[] = [];
  const seen = new Set<string>();

  for (const raw of parsed.classifications) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { word?: unknown; domain?: unknown; confidence?: unknown };

    const word = typeof r.word === "string" ? r.word.toLowerCase().trim() : "";
    if (!word || !inputWordSet.has(word) || seen.has(word)) continue;

    const domain = typeof r.domain === "string"
      ? r.domain.toLowerCase().trim() as Domain
      : "other" as Domain;
    const safeDomain: Domain = (VALID_DOMAINS as readonly string[]).includes(domain)
      ? domain : "other";

    const confidence = typeof r.confidence === "string"
      ? r.confidence.toLowerCase().trim() as Confidence
      : "medium" as Confidence;
    const safeConfidence: Confidence = (VALID_CONFIDENCE as readonly string[]).includes(confidence)
      ? confidence : "medium";

    validated.push({ word, domain: safeDomain, confidence: safeConfidence });
    seen.add(word);
  }

  // Any input words Claude omitted get a fallback "other" with low confidence
  // — better than nothing, parents will see them as an "other" sliver.
  for (const w of batch) {
    if (!seen.has(w.word)) {
      validated.push({ word: w.word, domain: "other", confidence: "low" });
    }
  }

  return validated;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
