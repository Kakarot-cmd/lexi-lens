/**
 * supabase/functions/_shared/models/gemini.ts
 * Lexi-Lens — Google AI Studio adapter
 *
 * Wraps the Google AI Studio REST API behind the ModelAdapter interface.
 * Supports two model families via the GEMINI_MODEL_ID env var override:
 *
 *   • Gemma 4 (open-weights, MoE):
 *       - "gemma-4-26b-a4b-it"  → ModelId "gemma-4-26b"  (default if no env var)
 *       - "gemma-4-31b-it"      → ModelId "gemma-4-31b"
 *
 *   • Gemini 3.1 Flash family (proprietary, latency-optimized):
 *       - "gemini-3.1-flash-preview"      → ModelId "gemini-3-1-flash"
 *       - "gemini-3.1-flash-lite-preview" → ModelId "gemini-3-1-flash-lite"
 *
 * Latency reality check (May 2026, ap-south-1, free tier):
 *   • Gemma 4 26B observed p50 ~13s, p95 ~24s. Good for batch / non-realtime.
 *   • Gemini 3.1 Flash-Lite designed for real-time UX, expect p50 ~1-2s.
 *   • Gemini 3.1 Flash p50 typically ~2-4s.
 *
 * v5.1.2 — Gemini 3.1 Flash family added
 *   When you need Gemma-class cost with Haiku-class latency, switch by
 *   setting `GEMINI_MODEL_ID=gemini-3.1-flash-lite-preview` in Edge
 *   Function secrets. No code change needed.
 *
 * v5.1.1 — Variant string fix (gemma-4-26b-a4b-it, not gemma-4-26b-it)
 * v5.1   — Initial adapter
 *
 * Why AI Studio not Vertex AI:
 *   • Single API key auth (no service account JSON juggling)
 *   • Free tier exists for staging smoke tests
 *   • Same wire format as Vertex (one-line move later if needed)
 *
 * Required Edge Function secret:
 *   GOOGLE_AI_STUDIO_KEY
 *
 * Optional secrets:
 *   GEMINI_MODEL_ID — wire-format model variant override
 */

import type {
  ModelAdapter,
  ModelCallOptions,
  ModelCallResult,
  ModelId,
} from "./types.ts";
import { ModelCallError } from "./types.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_MODEL_VARIANT = "gemini-2.5-flash-lite";
const API_BASE              = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MAX_TOKENS    = 700;
const DEFAULT_TIMEOUT_MS    = 30_000;
// v7.x — transient Gemini errors (503/UNAVAILABLE, overloaded) are Google-side
// capacity blips. We retry with backoff, but the WHOLE retry sequence must
// finish inside the client's hard 15s evaluate cutoff
// (EVALUATE_ATTEMPT_TIMEOUT_MS) — a child must never watch an indefinite
// spinner. So retries are gated on a wall-clock budget: we only start another
// attempt while time remains, and we shrink the per-attempt timeout to the
// budget left. Fast blips (503 in 1–2s) get retried-to-success well within
// budget; a slow first failure gives up cleanly (no wasted in-flight call)
// and the child's existing manual "tap to retry" prompt takes over.
const RETRY_ATTEMPT_TIMEOUT_MS = 9_000;   // per-attempt cap (healthy scan ~7s)
const TOTAL_RETRY_BUDGET_MS    = 13_000;  // wall-clock ceiling, < client 15s
const MIN_ATTEMPT_MS           = 2_500;   // don't start an attempt with less left
const MAX_MODEL_ATTEMPTS       = 3;
const RETRYABLE_STATUS         = new Set([408, 429, 500, 502, 503, 504]);

// Exponential backoff with jitter. attempt is 1-based: ~400ms, ~800ms (+ up
// to 250ms jitter) before attempts 2 and 3.
function sleepBackoff(attempt: number): Promise<void> {
  const base   = 400 * Math.pow(2, attempt - 1);
  const jitter = Math.floor(Math.random() * 250);
  return new Promise((r) => setTimeout(r, base + jitter));
}

// ─── Native safety filters (v6.9) ────────────────────────────────────────────
//
// Gemini's REST API exposes a `safetySettings` array that runs alongside the
// system-prompt safety prefix in childSafety.ts. The two layers are
// independent: the prefix shapes what the model TRIES to output, the
// safetySettings score the output and block delivery if a HARM_CATEGORY
// probability crosses the threshold.
//
// When omitted, Gemini uses ITS OWN defaults (typically MEDIUM_AND_ABOVE),
// which are tuned for general consumer apps — NOT for a Designed-for-Families
// product under-13. BLOCK_LOW_AND_ABOVE is the strictest configurable
// threshold for these four categories (core child-safety filters in the
// underlying model stay on regardless and cannot be lowered).
//
// What happens when Gemini refuses on safety grounds:
//   • API returns candidates[] empty (or candidate.finishReason="SAFETY")
//   • gemini.ts line ~205 throws ModelCallError (existing path)
//   • evaluate/index.ts catches it and returns HTTP 500 to the client
//   • Client (useLexiEvaluate) sets status="error"
//   • StatusBanner shows "Lens flickered"
//   • No unsafe content reaches the child; no echo of the unsafe input
//
// Refusal rate impact: in normal household-object scans, none. Could fire
// on a sharp knife (HARM_CATEGORY_DANGEROUS_CONTENT), images with people,
// medical/medication scans, etc. — all of which we WANT to block in a
// child product.
//
// NOTE: Categories are hard-coded category constants in Gemini's API. Spelling
// is exact and case-sensitive; see https://ai.google.dev/api/generate-content#harmcategory
const SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_LOW_AND_ABOVE" },
  { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_LOW_AND_ABOVE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_LOW_AND_ABOVE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_LOW_AND_ABOVE" },
] as const;

// Maps the wire-format model variant string back to our stable ModelId.
// Add a new variant by appending a row here AND a corresponding entry to
// the ModelId union in types.ts.
//
// Naming notes:
//   • Gemma variants embed the architecture in the name: -a4b- = MoE with
//     4B active params. The literal string "gemma-4-26b-it" returns 404.
//   • Gemini 3.1 Flash variants are still in -preview; check the Google
//     release notes if you see deprecation 410s.
const VARIANT_TO_MODEL_ID: Record<string, ModelId> = {
  "gemma-4-26b-a4b-it":              "gemma-4-26b",
  "gemma-4-31b-it":                  "gemma-4-31b",
  "gemini-3.1-flash-preview":        "gemini-3-1-flash",
  "gemini-3.1-flash-lite-preview":   "gemini-3-1-flash-lite",
  "gemini-2.5-flash":                "gemini-2-5-flash",
  "gemini-2.5-flash-lite":           "gemini-2-5-flash-lite",
};

function resolveVariant(): { variant: string; modelId: ModelId } {
  const fromEnv = Deno.env.get("GEMINI_MODEL_ID")?.trim();
  const variant = fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_MODEL_VARIANT;
  const modelId = VARIANT_TO_MODEL_ID[variant];
  if (!modelId) {
    throw new ModelCallError(
      "gemma-4-26b",
      null,
      "",
      `Unknown GEMINI_MODEL_ID "${variant}". Add it to VARIANT_TO_MODEL_ID in gemini.ts.`,
    );
  }
  return { variant, modelId };
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export const geminiAdapter: ModelAdapter = {
  // Initial id — overwritten per-call below since it depends on env at call time.
  // Factory uses this only for the "default" advertised id; actual logged
  // model_name comes from the call result.
  get id(): ModelId {
    try { return resolveVariant().modelId; } catch { return "gemma-4-26b"; }
  },

  isConfigured(): boolean {
    return Boolean(Deno.env.get("GOOGLE_AI_STUDIO_KEY"));
  },

  async call(opts: ModelCallOptions): Promise<ModelCallResult> {
    const apiKey = Deno.env.get("GOOGLE_AI_STUDIO_KEY");
    if (!apiKey) {
      throw new ModelCallError(
        "gemma-4-26b",
        null,
        "",
        "GOOGLE_AI_STUDIO_KEY not set in Edge Function environment",
      );
    }

    const { variant, modelId } = resolveVariant();

    // ── Build parts ─────────────────────────────────────────────────────────
    // Gemini API: contents[0].parts is an array of { text } or { inline_data }
    // blocks. Image goes before text — same convention as Anthropic.

    const parts: Array<unknown> = [];
    if (opts.imageBase64) {
      parts.push({
        inline_data: {
          mime_type: "image/jpeg",
          data:      opts.imageBase64,
        },
      });
    }
    parts.push({ text: opts.userText });

    // generationConfig — strict JSON mode is supported natively here.
    // Setting responseMimeType cuts the markdown-fence cleanup the Anthropic
    // path needs.
    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature:     0.2, // matches the deterministic-eval bias we want
    };
    if (opts.jsonMode) {
      generationConfig.responseMimeType = "application/json";
    }

    // ── Request ─────────────────────────────────────────────────────────────

    const url = `${API_BASE}/${variant}:generateContent?key=${apiKey}`;
    const startedAt = Date.now();

    // v7.x — A 503 ("model is overloaded") and other transient statuses from
    // the Gemini endpoint are Google-side capacity blips, not our bug. Per
    // Google's guidance the fix is bounded exponential-backoff retry on the
    // SAME model (a 503 is rejected before generation, so a retried-then-
    // failed attempt costs ~0 output tokens). The whole retry sequence is
    // wall-clock-bounded to TOTAL_RETRY_BUDGET_MS so it always finishes inside
    // the client's hard 15s cutoff — fast blips get retried-to-success, a slow
    // first failure gives up cleanly (no wasted in-flight call), and the
    // child's manual retry prompt covers sustained outages.
    const budgetLeft = () => TOTAL_RETRY_BUDGET_MS - (Date.now() - startedAt);
    const canRetry   = (attempt: number) =>
      attempt < MAX_MODEL_ATTEMPTS && budgetLeft() >= MIN_ATTEMPT_MS;

    let response!: Response;
    for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt++) {
      // Per-attempt timeout = min(cap, budget remaining). First attempt gets
      // the full cap; later attempts shrink to whatever budget is left.
      const perAttemptTimeoutMs = Math.min(
        opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        RETRY_ATTEMPT_TIMEOUT_MS,
        Math.max(budgetLeft(), MIN_ATTEMPT_MS),
      );
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), perAttemptTimeoutMs);

      let transportErr: unknown = null;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: opts.systemPrompt }] },
            contents:          [{ role: "user", parts }],
            generationConfig,
            // v6.9 — strictest configurable thresholds. See SAFETY_SETTINGS
            // block at the top of this file for rationale and refusal-path
            // notes. Independent of CHILD_SAFETY_PREFIX in the system
            // prompt; the two are belt-and-braces.
            safetySettings: SAFETY_SETTINGS,
          }),
          signal: controller.signal,
        });
      } catch (err) {
        transportErr = err;
      } finally {
        clearTimeout(timeout);
      }

      // Transport error / aborted attempt — retry if budget allows, else give up.
      if (transportErr) {
        if (canRetry(attempt)) { await sleepBackoff(attempt); continue; }
        throw new ModelCallError(
          modelId,
          null,
          String(transportErr instanceof Error ? transportErr.message : transportErr).slice(0, 200),
          "Gemini transport error or timeout (after retries)",
        );
      }

      if (response.ok) break; // success — leave the retry loop

      // Non-OK. Retry transient server-side statuses; surface everything else.
      const errText = await response.text().catch(() => "(unreadable)");
      if (RETRYABLE_STATUS.has(response.status) && canRetry(attempt)) {
        console.warn(
          `[gemini] ${response.status} on attempt ${attempt}/${MAX_MODEL_ATTEMPTS} ` +
          `(${modelId}) — retrying (≈${Math.max(budgetLeft(), 0)}ms budget left)`,
        );
        await sleepBackoff(attempt);
        continue;
      }
      throw new ModelCallError(
        modelId,
        response.status,
        errText.slice(0, 500),
        `Gemini API error ${response.status}${attempt > 1 ? ` (after ${attempt} attempts)` : ""}`,
      );
    }

    // ── Parse response ──────────────────────────────────────────────────────

    type GeminiResponse = {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
      usageMetadata?: {
        promptTokenCount?:     number;
        candidatesTokenCount?: number;
      };
    };

    const apiResponse = await response.json() as GeminiResponse;
    const candidate   = apiResponse.candidates?.[0];

    // Defensive: a missing candidate or empty parts array means Gemini
    // refused to produce output (safety filter, length cap, etc.). Treat as
    // a soft error — caller falls back to its own error path.
    if (!candidate || !candidate.content?.parts) {
      // v6.9 — finishReason="SAFETY" is the explicit signal that
      // safetySettings blocked the response. Surface it cleanly in logs
      // since it's now a routine (and expected) occurrence after the
      // BLOCK_LOW_AND_ABOVE move.
      const reason = candidate?.finishReason ?? "unknown";
      const detail = reason === "SAFETY"
        ? `Gemini blocked response on safety policy (finishReason=SAFETY)`
        : `Gemini returned no candidate (finishReason=${reason})`;
      throw new ModelCallError(
        modelId,
        200,
        JSON.stringify(apiResponse).slice(0, 500),
        detail,
      );
    }

    const rawText = candidate.content.parts
      .map((p) => p.text ?? "")
      .join("");

    return {
      rawText,
      modelId,
      latencyMs: Date.now() - startedAt,
      usage: {
        inputTokens:  apiResponse.usageMetadata?.promptTokenCount,
        outputTokens: apiResponse.usageMetadata?.candidatesTokenCount,
      },
    };
  },
};
