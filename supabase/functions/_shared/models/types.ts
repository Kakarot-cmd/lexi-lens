/**
 * supabase/functions/_shared/models/types.ts
 * Lexi-Lens — Model Provider Abstraction (v5.1.2, 2026-05-08)
 *
 * Defines the model-agnostic interface that every Edge Function uses to
 * call an LLM. The actual call shape (Anthropic vs Gemini vs whatever next)
 * is hidden behind ModelAdapter.
 *
 * v5.1.2 — Gemini 3.1 Flash family added to ModelId union
 *   New stable ids: "gemini-3-1-flash" and "gemini-3-1-flash-lite". The
 *   wire-format names ("gemini-3.1-flash-lite-preview" etc.) live in
 *   gemini.ts's VARIANT_TO_MODEL_ID; the union here uses dot-free ids so
 *   the values round-trip cleanly through cache keys and log lines.
 *
 * v5.1.1 — Gemma 4 26B added (variant fix)
 * v5.1   — Initial provider abstraction
 */

// ─── Identity ────────────────────────────────────────────────────────────────
//
// Stable identifiers used in:
//   • Cache value's `_modelId` field
//   • Edge Function logs
//   • Adapter id property
//
// These are dot-free for safe round-tripping through cache keys, log lines,
// and any future SQL filtering.

export type ModelId =
  | "claude-haiku-4-5"       // claude-haiku-4-5-20251001
  | "gemma-4-26b"            // google/gemma-4-26b-a4b-it (MoE)
  | "gemma-4-31b"            // google/gemma-4-31b-it (dense)
  | "gemini-3-1-flash"       // gemini-3.1-flash-preview (mid-tier, fast)
  | "gemini-3-1-flash-lite"; // gemini-3.1-flash-lite-preview (latency-optimized)

export const SUPPORTED_MODELS: readonly ModelId[] = [
  "claude-haiku-4-5",
  "gemma-4-26b",
  "gemma-4-31b",
  "gemini-3-1-flash",
  "gemini-3-1-flash-lite",
] as const;

// ─── Input shape ─────────────────────────────────────────────────────────────

export interface ModelCallOptions {
  /** Top-level instruction set (formerly the Anthropic `system` field). */
  systemPrompt: string;
  /** The user's text prompt — property requirements, mastery context, etc. */
  userText: string;
  /** Optional image as base64 JPEG. Same encoding both providers accept. */
  imageBase64?: string;
  /** Output token cap. Defaults per-call site (evaluate uses 700). */
  maxTokens?: number;
  /**
   * Strict JSON mode. When true, the adapter sets the provider's native
   * JSON-mode flag (responseMimeType for Gemini; prompt-only for Anthropic).
   * Caller still parses the result text — the flag just reduces the chance
   * of markdown fences and prose preambles.
   */
  jsonMode?: boolean;
  /**
   * Optional request-side timeout (ms). Adapter aborts if the provider
   * exceeds this. Defaults to 30s, matching current Anthropic behaviour.
   */
  timeoutMs?: number;
}

// ─── Output shape ────────────────────────────────────────────────────────────

export interface ModelCallResult {
  /** The raw text output. Caller is responsible for JSON parsing. */
  rawText: string;
  /** Which model produced this result (logged + stamped into cache value). */
  modelId: ModelId;
  /** Total wall-clock latency including network + provider compute. */
  latencyMs: number;
  /** Token usage from the provider — null if the provider didn't return it. */
  usage: {
    inputTokens:  number | null;
    outputTokens: number | null;
  };
}

// ─── The adapter contract ────────────────────────────────────────────────────

export interface ModelAdapter {
  readonly id: ModelId;
  /** Hard fail if the adapter is missing critical config (e.g. API key). */
  isConfigured(): boolean;
  /** Single-shot call. Throws on transport error or non-2xx response. */
  call(opts: ModelCallOptions): Promise<ModelCallResult>;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Thrown when a provider returns a 4xx/5xx response or the request aborts.
 * Caller (evaluateObject.ts) catches this and surfaces a generic 502 to
 * the client — the actual provider name is NOT leaked to user-facing copy.
 */
export class ModelCallError extends Error {
  constructor(
    public readonly modelId: ModelId,
    public readonly status: number | null,
    public readonly bodyExcerpt: string,
    message: string,
  ) {
    super(message);
    this.name = "ModelCallError";
  }
}
