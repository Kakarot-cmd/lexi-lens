/**
 * supabase/functions/cc1/index.ts
 * Lexi-Lens — Canonical Classifier 1 Edge Function (v6.2 Phase 2)
 *
 * ─── Purpose ───────────────────────────────────────────────────────────────
 *
 * Takes a scan frame, returns a canonical object name + a few synonyms.
 * Used by the evaluate Edge Function as the cache lookup key — replacing
 * the now-always-"object" detectedLabel that arrives post-MLKill.
 *
 *   Request:  { childId, frameBase64, probe? }
 *   Response: { canonical, aliases, modelId, latencyMs }      ← success
 *             { disabled: true }                              ← flag off
 *             { enabled: true|false }                         ← probe response
 *             { error: string }                               ← failure
 *
 * On any non-2xx response, the client falls through to direct evaluate.
 * That's the contract — CC1 is best-effort, never blocking.
 *
 * ─── What CC1 does NOT do ──────────────────────────────────────────────────
 *
 * - Does NOT log scan_attempts rows. evaluate is the single source of
 *   truth for scan counts; CC1 success/failure is recorded in the
 *   eventual evaluate row's cc1_model_id / cc1_latency_ms fields.
 * - Does NOT cache its own results. The verdict cache (per-property,
 *   keyed on canonical) is where caching happens. Image-hash caching CC1
 *   results adds <2% benefit at high complexity cost — deferred.
 * - Does NOT enforce the daily scan cap. CC1 + evaluate together count as
 *   one scan, and evaluate is the one that increments. CC1 honours the
 *   IP rate limit only (cheap defense against retry storms).
 *
 * ─── Provider selection ────────────────────────────────────────────────────
 *
 * Reads feature_flags.cc1_model_provider directly. Does NOT go through the
 * shared getModelAdapter('evaluate', ...) chain — CC1's prompt and cost
 * shape are different, and conflating them would couple CC1's provider
 * choice to evaluate's. Default 'gemini' (Gemini 2.5 Flash-Lite — fastest
 * vision-capable provider at this prompt size).
 *
 * ─── Safety ────────────────────────────────────────────────────────────────
 *
 * The CC1 prompt explicitly instructs the model to return canonical="object"
 * for any image of people / faces / body parts. We also enforce this
 * server-side via HUMAN_BODY_BLOCKLIST — defense in depth. If the model
 * ever ignores the prompt rule and returns "child" or "face", the response
 * is rewritten to canonical="object" before returning to the client.
 *
 * Same guard applies to GENERIC_LABELS — if CC1 returns "thing" or "unknown"
 * we surface that as canonical="object" so the evaluate cache lookup behaves
 * consistently (existing generic-label bypass kicks in).
 *
 * ─── Flag propagation ──────────────────────────────────────────────────────
 *
 * The cc1_enabled flag is read on every cold container with a 60s
 * in-process cache. Worst-case server-side propagation: 60s. Client-side
 * propagation is piggybacked on evaluate responses (see useLexiEvaluate's
 * cc1Enabled cache). The client uses ?probe=1 to refresh its cached view
 * without paying for a model call.
 */

import { serve }        from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

import { anthropicHaikuAdapter } from "../_shared/models/anthropic.ts";
import { geminiAdapter }         from "../_shared/models/gemini.ts";
import { mistralAdapter }        from "../_shared/models/mistral.ts";
import type { ModelAdapter }     from "../_shared/models/types.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const IP_LIMIT_PER_MINUTE = 20;
const IP_WINDOW_MS        = 60_000;
const DEFAULT_TIMEOUT_MS  = 3_000;
const MAX_ALIASES         = 3;
const MAX_TOKENS          = 80;

// Mirrors evaluate/index.ts. Keep the two lists in sync.
const GENERIC_LABELS = new Set(["", "object", "unknown", "thing", "item"]);

// Defense-in-depth blocklist for human-body terms the prompt should have
// already redirected to "object". If the model slips, we rewrite here.
const HUMAN_BODY_BLOCKLIST = new Set([
  "person", "people", "human", "child", "kid", "baby", "infant", "toddler",
  "adult", "man", "woman", "boy", "girl",
  "face", "head", "neck", "shoulder", "shoulders",
  "hair", "skin", "flesh", "hand", "hands", "finger", "fingers",
  "arm", "arms", "leg", "legs", "foot", "feet", "knee",
  "eye", "eyes", "nose", "mouth", "lip", "lips", "ear", "ears",
  "chest", "stomach", "back",
]);

// ─── Types ───────────────────────────────────────────────────────────────────

interface Cc1Result {
  canonical: string;
  aliases:   string[];
  modelId:   string;
  latencyMs: number;
}

interface ModelOutput {
  canonical: string;
  aliases:   string[];
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// ─── IP rate limit (mirrors evaluate) ────────────────────────────────────────

async function hashIp(ip: string): Promise<string> {
  const data   = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function extractIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return headers.get("x-real-ip") ?? "unknown";
}

async function checkIpRateLimit(
  supabase: SupabaseClient,
  ipHash:   string,
): Promise<{ allowed: boolean }> {
  const since = new Date(Date.now() - IP_WINDOW_MS).toISOString();
  const { count } = await supabase
    .from("scan_attempts")
    .select("id", { count: "exact", head: true })
    .eq("ip_hash", ipHash)
    .gte("created_at", since);
  return { allowed: (count ?? 0) < IP_LIMIT_PER_MINUTE };
}

// ─── Flag reader (60s in-process cache) ──────────────────────────────────────

const FLAG_TTL_MS = 60_000;
const flagCache = new Map<string, { value: string | null; expiresAt: number }>();

async function readFlag(supabase: SupabaseClient, key: string): Promise<string | null> {
  const now = Date.now();
  const cached = flagCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  try {
    const { data, error } = await supabase
      .from("feature_flags")
      .select("value")
      .eq("key", key)
      .maybeSingle();

    if (error) {
      flagCache.set(key, { value: null, expiresAt: now + FLAG_TTL_MS });
      return null;
    }

    const raw   = (data as { value?: unknown } | null)?.value;
    const value = typeof raw === "string" ? raw.trim() : null;
    flagCache.set(key, { value, expiresAt: now + FLAG_TTL_MS });
    return value;
  } catch {
    flagCache.set(key, { value: null, expiresAt: now + FLAG_TTL_MS });
    return null;
  }
}

// ─── Adapter pick ────────────────────────────────────────────────────────────

const ADAPTER_BY_NAME: Record<string, ModelAdapter> = {
  gemini:    geminiAdapter,
  mistral:   mistralAdapter,
  anthropic: anthropicHaikuAdapter,
};

const FALLBACK_ORDER: readonly ModelAdapter[] = [
  geminiAdapter,
  mistralAdapter,
  anthropicHaikuAdapter,
];

async function pickAdapter(supabase: SupabaseClient): Promise<ModelAdapter> {
  // 1. DB flag
  const flagValue = await readFlag(supabase, "cc1_model_provider");
  const normalized = flagValue?.toLowerCase() ?? null;
  let picked: ModelAdapter | null = normalized && ADAPTER_BY_NAME[normalized]
    ? ADAPTER_BY_NAME[normalized]
    : null;

  // 2. Env fallback
  if (!picked) {
    const envVal = Deno.env.get("CC1_MODEL_PROVIDER")?.trim().toLowerCase();
    if (envVal && ADAPTER_BY_NAME[envVal]) picked = ADAPTER_BY_NAME[envVal];
  }

  // 3. Hard default
  if (!picked) picked = geminiAdapter;

  if (picked.isConfigured()) return picked;

  // 4. Walk fallback
  for (const candidate of FALLBACK_ORDER) {
    if (candidate.id === picked.id) continue;
    if (candidate.isConfigured()) {
      console.warn(`[cc1] picked=${picked.id} not configured; falling back to ${candidate.id}`);
      return candidate;
    }
  }

  return picked; // .call() will throw a clear error
}

// ─── Prompt ──────────────────────────────────────────────────────────────────
//
// Short by design. ~120 input tokens. Image is the bulk of the cost but
// vision-input-tokens are flat per provider regardless of prompt length.
//
// Strictness order (most → least important):
//   1. Strict JSON (no prose, no markdown fences)
//   2. canonical lowercase, no articles, simple noun phrase
//   3. aliases empty array allowed; cap at 3
//   4. Safety: refuse people / body parts (also enforced server-side)

const CC1_SYSTEM_PROMPT = `You are a vision labeling system for a children's vocabulary game.

Look at the image. Identify the single primary object as a young child would name it.

Return STRICT JSON only — no preamble, no markdown, no commentary:
{"canonical":"<lowercase common noun phrase, no articles>","aliases":["<up to 3 alternate names>"]}

Rules:
- canonical: the simplest noun a 5–9 year old would use. Examples: "apple", "water bottle", "wooden spoon", "teddy bear"
- No articles. NOT "an apple" or "the bottle" — just "apple", "bottle"
- aliases: 0–3 common alternate names (synonyms or near-synonyms). Empty array is fine.
- If the image shows a person, face, or any body part: return {"canonical":"object","aliases":[]}
- If the image is too blurry, dark, or unidentifiable: return {"canonical":"object","aliases":[]}
- Never return brand names, never describe the scene — only the primary object.`;

const CC1_USER_TEXT = "What is the primary object in this image?";

// ─── Response parsing + validation ───────────────────────────────────────────

function tryParseJson(rawText: string): ModelOutput | null {
  // Strip common markdown fences the model sometimes adds despite the prompt.
  const cleaned = rawText
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  try {
    const obj = JSON.parse(cleaned);
    if (typeof obj !== "object" || obj === null) return null;
    const canonical = typeof obj.canonical === "string" ? obj.canonical : "";
    const rawAliases = Array.isArray(obj.aliases) ? obj.aliases : [];
    const aliases    = rawAliases
      .filter((a: unknown): a is string => typeof a === "string")
      .map((a: string) => a.toLowerCase().trim())
      .filter((a: string) => a.length > 0)
      .slice(0, MAX_ALIASES);
    return { canonical: canonical.toLowerCase().trim(), aliases };
  } catch {
    return null;
  }
}

function sanitizeOutput(parsed: ModelOutput): ModelOutput {
  // Strip leading articles defensively — prompt forbids them but models sometimes ignore.
  const stripArticles = (s: string): string =>
    s.replace(/^(a|an|the)\s+/i, "").trim();

  let canonical = stripArticles(parsed.canonical);

  // Empty / generic → "object"
  if (canonical.length === 0 || GENERIC_LABELS.has(canonical)) {
    canonical = "object";
  }

  // Human-body safety override — keep this even though prompt forbids it.
  if (HUMAN_BODY_BLOCKLIST.has(canonical)) {
    console.warn(`[cc1] safety override: model returned human-body canonical="${canonical}" → "object"`);
    canonical = "object";
  }

  // When canonical lands on "object" the aliases lose meaning — drop them.
  const aliases = canonical === "object"
    ? []
    : parsed.aliases
        .map(stripArticles)
        .filter((a) => a.length > 0)
        .filter((a) => !GENERIC_LABELS.has(a))
        .filter((a) => !HUMAN_BODY_BLOCKLIST.has(a))
        .filter((a) => a !== canonical);

  return { canonical, aliases };
}

// ─── Server ──────────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // ── 1. Parse body ──────────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  const isProbe = body.probe === true;
  const { childId, frameBase64 } = body as { childId?: string; frameBase64?: string };

  // ── 2. Flag check ──────────────────────────────────────────────────────────
  const enabledFlag = await readFlag(supabase, "cc1_enabled");
  const cc1Enabled  = enabledFlag === "true";

  if (isProbe) {
    // Probe path: return flag state only. No rate-limit charge, no body needed.
    return jsonResponse({ enabled: cc1Enabled });
  }

  if (!cc1Enabled) {
    return jsonResponse({ disabled: true });
  }

  // ── 3. Validate inputs (only after we know flag is on) ─────────────────────
  if (typeof childId !== "string" || childId.length === 0) {
    return jsonResponse({ error: "Missing childId" }, 400);
  }
  if (typeof frameBase64 !== "string" || frameBase64.length === 0) {
    return jsonResponse({ error: "Missing frameBase64" }, 400);
  }

  // ── 4. IP rate limit (shared with evaluate via ip_hash on scan_attempts) ──
  //
  // CC1 doesn't log scan_attempts itself, so it can't directly increment the
  // counter — but it CAN consult the same count. This means CC1 rejects
  // before evaluate would, protecting against retry storms specifically on
  // the CC1 endpoint.
  const ip     = extractIp(req.headers);
  const ipHash = await hashIp(ip);
  const ipRl   = await checkIpRateLimit(supabase, ipHash);
  if (!ipRl.allowed) {
    return jsonResponse({
      error: "rate_limited_ip",
      childFriendly: "Whoa! Too many quick scans. Take a breath and try again in a minute.",
    }, 429);
  }

  // ── 5. Read timeout flag (default 3000ms) ─────────────────────────────────
  const timeoutFlag  = await readFlag(supabase, "cc1_timeout_ms");
  const timeoutMs    = (() => {
    const parsed = timeoutFlag ? parseInt(timeoutFlag, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 30_000
      ? parsed
      : DEFAULT_TIMEOUT_MS;
  })();

  // ── 6. Pick adapter ────────────────────────────────────────────────────────
  const adapter = await pickAdapter(supabase);
  if (!adapter.isConfigured()) {
    console.error("[cc1] no adapter configured");
    return jsonResponse({ error: "cc1_not_configured" }, 500);
  }

  // ── 7. Call model ──────────────────────────────────────────────────────────
  const callStart = Date.now();
  let rawText: string;
  let modelId: string;
  let latencyMs: number;

  try {
    const result = await adapter.call({
      systemPrompt: CC1_SYSTEM_PROMPT,
      userText:     CC1_USER_TEXT,
      imageBase64:  frameBase64,
      maxTokens:    MAX_TOKENS,
      jsonMode:     true,
      timeoutMs,
    });
    rawText   = result.rawText;
    modelId   = result.modelId;
    latencyMs = result.latencyMs;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "CC1 model call failed";
    const elapsed = Date.now() - callStart;
    console.error(
      `[cc1] model call failed adapter=${adapter.id} elapsed_ms=${elapsed} ` +
      `timeoutMs=${timeoutMs} childId=${childId} error="${msg}"`,
    );
    // Returning 500 — client falls through to direct evaluate.
    return jsonResponse({ error: msg }, 500);
  }

  // ── 8. Parse + sanitize ────────────────────────────────────────────────────
  const parsed = tryParseJson(rawText);
  if (!parsed) {
    console.warn(
      `[cc1] parse failed modelId=${modelId} latencyMs=${latencyMs} ` +
      `childId=${childId} raw="${rawText.slice(0, 200)}"`,
    );
    // Treat as "object" rather than failing the request — gives evaluate
    // a clean signal (the generic bucket). Better UX than fallthrough on
    // a parse error since the model DID respond.
    return jsonResponse({
      canonical: "object",
      aliases:   [],
      modelId,
      latencyMs,
    } satisfies Cc1Result);
  }

  const sanitized = sanitizeOutput(parsed);

  console.log(
    `[cc1] ok model=${modelId} latency_ms=${latencyMs} ` +
    `canonical="${sanitized.canonical}" aliases=${JSON.stringify(sanitized.aliases)} ` +
    `childId=${childId}`,
  );

  return jsonResponse({
    canonical: sanitized.canonical,
    aliases:   sanitized.aliases,
    modelId,
    latencyMs,
  } satisfies Cc1Result);
});
