/**
 * supabase/functions/_shared/models/openai.ts
 * Lexi-Lens — OpenAI ModelAdapter (Phase 4.10b eval).
 *
 * Wraps OpenAI's Chat Completions API for vision-capable models in the GPT-4.1
 * and GPT-5.4 families. Same interface contract as anthropic.ts and gemini.ts —
 * call shape is hidden behind ModelAdapter so evaluateObject() doesn't need
 * to know which provider it's hitting.
 *
 * ─── Variant selection ────────────────────────────────────────────────────
 *
 * Reads OPENAI_MODEL_ID env var; falls back to DEFAULT_MODEL_VARIANT below.
 * Maps wire-format variant strings to stable dot-free ModelIds via
 * VARIANT_TO_MODEL_ID. Adding a new variant is a one-line entry.
 *
 *   gpt-4.1-nano        → gpt-4-1-nano        (cheapest vision-capable; default)
 *   gpt-4.1-mini        → gpt-4-1-mini        (mid-tier; eval comparison)
 *   gpt-5.4-nano        → gpt-5-4-nano        (newest cheap; text-first)
 *
 * ─── Wire format notes ────────────────────────────────────────────────────
 *
 *   • System prompt goes in messages[0] with role="system" — NOT a top-level
 *     field like Anthropic's API.
 *   • Vision input is `image_url` content blocks with data URIs:
 *       { type: "image_url", image_url: { url: "data:image/jpeg;base64,..." } }
 *     Gemini uses inline_data; Anthropic uses image content blocks; same data
 *     different envelope.
 *   • Strict JSON mode via response_format: { type: "json_object" }. Caller
 *     still must parse the string itself — this just constrains the model to
 *     produce valid JSON.
 *   • GPT-4.1 family uses `max_tokens`; GPT-5+ uses `max_completion_tokens`.
 *     Adapter detects the family and sends the right field.
 */

import {
  ModelCallError,
  type ModelAdapter,
  type ModelCallOptions,
  type ModelCallResult,
  type ModelId,
} from "./types.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL_VARIANT = "gpt-4.1-nano";
const DEFAULT_TIMEOUT_MS = 30_000;

// Variants whose token cap field is `max_completion_tokens` (GPT-5+).
// GPT-4.1 family uses the legacy `max_tokens`.
const COMPLETION_TOKENS_VARIANTS = new Set<string>([
  "gpt-5.4-nano",
  "gpt-5.4-mini",
  "gpt-5",
  "gpt-5.4",
]);

// ─── Variant → stable id mapping ─────────────────────────────────────────────

const VARIANT_TO_MODEL_ID: Record<string, ModelId> = {
  "gpt-4.1-nano": "gpt-4-1-nano",
  "gpt-4.1-mini": "gpt-4-1-mini",
  "gpt-5.4-nano": "gpt-5-4-nano",
};

function resolveVariant(): { variant: string; modelId: ModelId } {
  const fromEnv = Deno.env.get("OPENAI_MODEL_ID")?.trim();
  const variant = fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_MODEL_VARIANT;
  const modelId = VARIANT_TO_MODEL_ID[variant];
  if (!modelId) {
    throw new ModelCallError(
      "gpt-4-1-nano",
      null,
      "",
      `Unknown OPENAI_MODEL_ID "${variant}". Add it to VARIANT_TO_MODEL_ID in openai.ts.`,
    );
  }
  return { variant, modelId };
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export const openaiAdapter: ModelAdapter = {
  get id(): ModelId {
    try { return resolveVariant().modelId; } catch { return "gpt-4-1-nano"; }
  },

  isConfigured(): boolean {
    return Boolean(Deno.env.get("OPENAI_API_KEY"));
  },

  async call(opts: ModelCallOptions): Promise<ModelCallResult> {
    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      throw new ModelCallError(
        "gpt-4-1-nano",
        null,
        "",
        "OPENAI_API_KEY not set in Edge Function environment",
      );
    }

    const { variant, modelId } = resolveVariant();

    // ── Build user content (text + optional image) ───────────────────────────
    const userContent: Array<Record<string, unknown>> = [
      { type: "text", text: opts.userText },
    ];
    if (opts.imageBase64) {
      userContent.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${opts.imageBase64}` },
      });
    }

    // ── Build request body ───────────────────────────────────────────────────
    const useCompletionTokens = COMPLETION_TOKENS_VARIANTS.has(variant);
    const tokenCap = opts.maxTokens ?? 700;

    const body: Record<string, unknown> = {
      model: variant,
      messages: [
        { role: "system", content: opts.systemPrompt },
        { role: "user",   content: userContent },
      ],
      temperature: 0.2,        // low but non-zero; matches the determinism we want
    };

    if (useCompletionTokens) {
      body.max_completion_tokens = tokenCap;
    } else {
      body.max_tokens = tokenCap;
    }

    if (opts.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    // ── Make the call ────────────────────────────────────────────────────────
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    const start = Date.now();
    let res: Response;
    try {
      res = await fetch(OPENAI_API_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type":  "application/json",
        },
        body:    JSON.stringify(body),
        signal:  controller.signal,
      });
    } catch (e) {
      clearTimeout(timeoutId);
      const msg = e instanceof Error ? e.message : "fetch failed";
      throw new ModelCallError(modelId, null, "", `OpenAI request failed: ${msg}`);
    } finally {
      clearTimeout(timeoutId);
    }

    const latencyMs = Date.now() - start;

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw new ModelCallError(
        modelId,
        res.status,
        bodyText,
        `OpenAI ${variant} returned ${res.status}: ${bodyText.slice(0, 200)}`,
      );
    }

    // ── Parse response ───────────────────────────────────────────────────────
    let parsed: Record<string, unknown>;
    try {
      parsed = await res.json();
    } catch (e) {
      throw new ModelCallError(
        modelId,
        res.status,
        "",
        `OpenAI returned non-JSON: ${e instanceof Error ? e.message : "parse error"}`,
      );
    }

    const choices = (parsed.choices as Array<Record<string, unknown>> | undefined) ?? [];
    const firstChoice = choices[0];
    const message = firstChoice?.message as Record<string, unknown> | undefined;
    const rawText = typeof message?.content === "string" ? message.content : "";

    if (!rawText) {
      throw new ModelCallError(
        modelId,
        res.status,
        JSON.stringify(parsed).slice(0, 500),
        `OpenAI ${variant} returned empty content`,
      );
    }

    const usage = parsed.usage as Record<string, unknown> | undefined;
    const inputTokens  = typeof usage?.prompt_tokens     === "number" ? usage.prompt_tokens     : undefined;
    const outputTokens = typeof usage?.completion_tokens === "number" ? usage.completion_tokens : undefined;

    return {
      rawText,
      modelId,
      latencyMs,
      usage: { inputTokens, outputTokens },
    };
  },
};
