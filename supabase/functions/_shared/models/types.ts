/**
 * supabase/functions/_shared/models/types.ts
 * Lexi-Lens — Model Provider Abstraction (v5.4-eval, 2026-05-09)
 *
 * v5.4-eval — ModelId union extended for the Phase 4.10b model evaluation.
 *   Adds:
 *     • "gemini-2-5-flash"      — stable GA mid-tier
 *     • "gemini-2-5-flash-lite" — stable GA, replaces 3.1-preview as fallback
 *     • "gpt-4-1-nano"          — OpenAI's cheap vision model
 *     • "gpt-4-1-mini"          — OpenAI mid-tier (eval-only, not for prod)
 *     • "gpt-5-4-nano"          — OpenAI's newest cheap (text-first, eval-only)
 *     • "mistral-small-4"       — Pixtral merged into Small 4
 *
 * v5.1.2 — Gemini 3.1 Flash family added
 * v5.1.1 — Gemma 4 26B added
 * v5.1   — Initial provider abstraction
 */

// ─── Identity ────────────────────────────────────────────────────────────────

export type ModelId =
  | "claude-haiku-4-5"          // claude-haiku-4-5-20251001
  | "gemma-4-26b"               // google/gemma-4-26b-a4b-it (MoE)
  | "gemma-4-31b"               // google/gemma-4-31b-it (dense)
  | "gemini-3-1-flash"          // gemini-3.1-flash-preview
  | "gemini-3-1-flash-lite"     // gemini-3.1-flash-lite-preview
  | "gemini-2-5-flash"          // gemini-2.5-flash (stable GA)
  | "gemini-2-5-flash-lite"     // gemini-2.5-flash-lite (stable GA, recommended fallback)
  | "gpt-4-1-nano"              // gpt-4.1-nano
  | "gpt-4-1-mini"              // gpt-4.1-mini
  | "gpt-5-4-nano"              // gpt-5.4-nano
  | "mistral-small-4";          // mistral-small-2603 (Small 4 with Pixtral)

export const SUPPORTED_MODELS: readonly ModelId[] = [
  "claude-haiku-4-5",
  "gemma-4-26b",
  "gemma-4-31b",
  "gemini-3-1-flash",
  "gemini-3-1-flash-lite",
  "gemini-2-5-flash",
  "gemini-2-5-flash-lite",
  "gpt-4-1-nano",
  "gpt-4-1-mini",
  "gpt-5-4-nano",
  "mistral-small-4",
] as const;

// ─── Per-model approximate price (USD per million tokens) ────────────────────
// Used by the eval harness for cost estimation. Production code should NOT
// read from here for billing; these are best-effort book-keeping values.
//
// Values current as of May 2026. Source: official provider pricing pages.
// Update when re-running the eval if the market has moved.

export interface ModelPricing {
  inputPerMillion:  number;
  outputPerMillion: number;
  /** Effective date for this pricing snapshot (ISO date string). */
  pricedAt: string;
  /** Notes about the pricing (preview rates, batch discounts, etc). */
  note?: string;
}

export const MODEL_PRICING: Record<ModelId, ModelPricing> = {
  "claude-haiku-4-5":      { inputPerMillion: 1.00, outputPerMillion: 5.00, pricedAt: "2026-05-09" },
  "gemma-4-26b":           { inputPerMillion: 0.00, outputPerMillion: 0.00, pricedAt: "2026-05-09", note: "Google AI Studio free tier" },
  "gemma-4-31b":           { inputPerMillion: 0.00, outputPerMillion: 0.00, pricedAt: "2026-05-09", note: "Google AI Studio free tier" },
  "gemini-3-1-flash":      { inputPerMillion: 0.30, outputPerMillion: 2.50, pricedAt: "2026-05-09", note: "Preview rates" },
  "gemini-3-1-flash-lite": { inputPerMillion: 0.10, outputPerMillion: 0.40, pricedAt: "2026-05-09", note: "Preview rates" },
  "gemini-2-5-flash":      { inputPerMillion: 0.30, outputPerMillion: 2.50, pricedAt: "2026-05-09" },
  "gemini-2-5-flash-lite": { inputPerMillion: 0.10, outputPerMillion: 0.40, pricedAt: "2026-05-09" },
  "gpt-4-1-nano":          { inputPerMillion: 0.10, outputPerMillion: 0.40, pricedAt: "2026-05-09" },
  "gpt-4-1-mini":          { inputPerMillion: 0.40, outputPerMillion: 1.60, pricedAt: "2026-05-09" },
  "gpt-5-4-nano":          { inputPerMillion: 0.20, outputPerMillion: 1.25, pricedAt: "2026-05-09" },
  "mistral-small-4":       { inputPerMillion: 0.15, outputPerMillion: 0.60, pricedAt: "2026-05-09" },
};

// ─── Input shape ─────────────────────────────────────────────────────────────

export interface ModelCallOptions {
  /** Top-level instruction set (formerly the Anthropic `system` field). */
  systemPrompt: string;
  /** The user's text prompt — property requirements, mastery context, etc. */
  userText: string;
  /** Optional image as base64 JPEG. Same encoding all providers accept. */
  imageBase64?: string;
  /** Output token cap. Defaults per-call site (evaluate uses 700). */
  maxTokens?: number;
  /**
   * Strict JSON mode. When true, the adapter sets the provider's native
   * JSON-mode flag (responseMimeType for Gemini, response_format for OpenAI/
   * Mistral, prompt-only for Anthropic). Caller still parses the result text.
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
  /**
   * Token usage. Optional because not every provider returns it the same way;
   * adapters fill in what they can. Used by the eval harness for cost math.
   */
  usage?: {
    inputTokens?:  number;
    outputTokens?: number;
  };
}

// ─── Adapter interface ───────────────────────────────────────────────────────

export interface ModelAdapter {
  /** Stable model id; used in logs, cache `_modelId` stamps, and SQL filters. */
  readonly id: ModelId;
  /** Whether the adapter has its required env vars set. */
  isConfigured(): boolean;
  /** Make one model call. May throw ModelCallError on transport / 4xx / 5xx. */
  call(opts: ModelCallOptions): Promise<ModelCallResult>;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class ModelCallError extends Error {
  constructor(
    public modelId:    ModelId,
    public httpStatus: number | null,
    public bodyText:   string,
    message:           string,
  ) {
    super(message);
    this.name = "ModelCallError";
  }
}
