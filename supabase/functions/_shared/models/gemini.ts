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
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: opts.systemPrompt }] },
          contents:          [{ role: "user", parts }],
          generationConfig,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      throw new ModelCallError(
        modelId,
        null,
        String(err instanceof Error ? err.message : err).slice(0, 200),
        "Gemini transport error or timeout",
      );
    }
    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text().catch(() => "(unreadable)");
      throw new ModelCallError(
        modelId,
        response.status,
        errText.slice(0, 500),
        `Gemini API error ${response.status}`,
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
      throw new ModelCallError(
        modelId,
        200,
        JSON.stringify(apiResponse).slice(0, 500),
        `Gemini returned no candidate (finishReason=${candidate?.finishReason ?? "unknown"})`,
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
