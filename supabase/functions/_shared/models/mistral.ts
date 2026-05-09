/**
 * supabase/functions/_shared/models/mistral.ts
 * Lexi-Lens — Mistral ModelAdapter (Phase 4.10b eval).
 *
 * Wraps Mistral's chat completion API. As of March 2026, Mistral Small 4
 * unifies what were three previously separate models — Magistral (reasoning),
 * Pixtral (vision), Devstral (coding) — into one configurable system. So a
 * single adapter covers vision + reasoning out of the box.
 *
 * Mistral's API is OpenAI-compatible; the wire format is nearly identical
 * to openai.ts. Two notable differences:
 *
 *   1. Different base URL (api.mistral.ai/v1).
 *   2. `reasoning_effort` parameter ("none" | "low" | "medium" | "high")
 *      controls Magistral-style step-by-step reasoning. We default to
 *      "none" because the evaluate prompt is concrete and answer-shape
 *      constrained — extra reasoning costs tokens without quality gain
 *      on a property-classification task at this scale. Override per-call
 *      via opts (extend ModelCallOptions if needed) or globally via env.
 *
 * ─── Variant selection ────────────────────────────────────────────────────
 *
 * Reads MISTRAL_MODEL_ID env var; falls back to DEFAULT_MODEL_VARIANT.
 * Currently only Small 4 is wired (mistral-small-2603), since that's the
 * vision-capable cheap-end variant. Add new mappings to VARIANT_TO_MODEL_ID
 * to extend.
 */

import {
  ModelCallError,
  type ModelAdapter,
  type ModelCallOptions,
  type ModelCallResult,
  type ModelId,
} from "./types.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const MISTRAL_API_URL       = "https://api.mistral.ai/v1/chat/completions";
const DEFAULT_MODEL_VARIANT = "mistral-small-2603";   // Mistral Small 4 (vision + reasoning)
const DEFAULT_TIMEOUT_MS    = 30_000;
const DEFAULT_REASONING     = "none";                 // dial up to "low"/"medium" if quality eval shows need

// ─── Variant → stable id mapping ─────────────────────────────────────────────

const VARIANT_TO_MODEL_ID: Record<string, ModelId> = {
  "mistral-small-2603": "mistral-small-4",
};

function resolveVariant(): { variant: string; modelId: ModelId } {
  const fromEnv = Deno.env.get("MISTRAL_MODEL_ID")?.trim();
  const variant = fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_MODEL_VARIANT;
  const modelId = VARIANT_TO_MODEL_ID[variant];
  if (!modelId) {
    throw new ModelCallError(
      "mistral-small-4",
      null,
      "",
      `Unknown MISTRAL_MODEL_ID "${variant}". Add it to VARIANT_TO_MODEL_ID in mistral.ts.`,
    );
  }
  return { variant, modelId };
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export const mistralAdapter: ModelAdapter = {
  get id(): ModelId {
    try { return resolveVariant().modelId; } catch { return "mistral-small-4"; }
  },

  isConfigured(): boolean {
    return Boolean(Deno.env.get("MISTRAL_API_KEY"));
  },

  async call(opts: ModelCallOptions): Promise<ModelCallResult> {
    const apiKey = Deno.env.get("MISTRAL_API_KEY");
    if (!apiKey) {
      throw new ModelCallError(
        "mistral-small-4",
        null,
        "",
        "MISTRAL_API_KEY not set in Edge Function environment",
      );
    }

    const { variant, modelId } = resolveVariant();

    // ── Build user content (text + optional image) ───────────────────────────
    // OpenAI-compatible content blocks; Mistral accepts the same shape.
    const userContent: Array<Record<string, unknown>> = [
      { type: "text", text: opts.userText },
    ];
    if (opts.imageBase64) {
      userContent.push({
        type:      "image_url",
        image_url: `data:image/jpeg;base64,${opts.imageBase64}`,
      });
    }

    const reasoningEffort = Deno.env.get("MISTRAL_REASONING_EFFORT")?.trim() || DEFAULT_REASONING;

    const body: Record<string, unknown> = {
      model: variant,
      messages: [
        { role: "system", content: opts.systemPrompt },
        { role: "user",   content: userContent },
      ],
      max_tokens:       opts.maxTokens ?? 700,
      temperature:      0.2,
      reasoning_effort: reasoningEffort,
    };

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
      res = await fetch(MISTRAL_API_URL, {
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
      throw new ModelCallError(modelId, null, "", `Mistral request failed: ${msg}`);
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
        `Mistral ${variant} returned ${res.status}: ${bodyText.slice(0, 200)}`,
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
        `Mistral returned non-JSON: ${e instanceof Error ? e.message : "parse error"}`,
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
        `Mistral ${variant} returned empty content`,
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
