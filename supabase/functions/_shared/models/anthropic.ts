/**
 * supabase/functions/_shared/models/anthropic.ts
 * Lexi-Lens — Anthropic adapter (Haiku 4.5)
 *
 * Wraps the Claude messages API behind the ModelAdapter interface.
 * Behaviour is identical to the v5.0 inline call in evaluateObject.ts —
 * this is purely a refactor extraction.
 *
 * Notes:
 *   • Native fetch (NOT the Anthropic SDK — esm.sh times out at bundle time;
 *     this is a hard-won lesson from v3.5 — see roadmap v4.0 for the postmortem).
 *   • Image block uses media_type "image/jpeg" — matches useObjectScanner's encoding.
 *   • Anthropic does NOT have a native strict-JSON mode at this Haiku version.
 *     jsonMode is a no-op for this adapter; caller still strips ```json fences.
 *
 * Required Edge Function secret:
 *   ANTHROPIC_API_KEY  (set via `supabase secrets set` per project)
 */

import type {
  ModelAdapter,
  ModelCallOptions,
  ModelCallResult,
  ModelId,
} from "./types.ts";
import { ModelCallError } from "./types.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const MODEL_VERSION       = "claude-haiku-4-5-20251001";
const ANTHROPIC_API_URL   = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION   = "2023-06-01";
const DEFAULT_MAX_TOKENS  = 700;
const DEFAULT_TIMEOUT_MS  = 30_000;

// ─── Adapter ─────────────────────────────────────────────────────────────────

export const anthropicHaikuAdapter: ModelAdapter = {
  id: "claude-haiku-4-5",

  isConfigured(): boolean {
    return Boolean(Deno.env.get("ANTHROPIC_API_KEY"));
  },

  async call(opts: ModelCallOptions): Promise<ModelCallResult> {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new ModelCallError(
        "claude-haiku-4-5",
        null,
        "",
        "ANTHROPIC_API_KEY not set in Edge Function environment",
      );
    }

    // ── Build content blocks ────────────────────────────────────────────────
    // Anthropic accepts an array of content blocks. Image (if present) goes
    // before text — matches Anthropic best practice for vision evaluation.

    const content: Array<unknown> = [];
    if (opts.imageBase64) {
      content.push({
        type: "image",
        source: {
          type:       "base64",
          media_type: "image/jpeg",
          data:       opts.imageBase64,
        },
      });
    }
    content.push({ type: "text", text: opts.userText });

    // ── Request ─────────────────────────────────────────────────────────────

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    let response: Response;
    try {
      response = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type":      "application/json",
          "x-api-key":         apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model:      MODEL_VERSION,
          max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
          system:     opts.systemPrompt,
          messages:   [{ role: "user", content }],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      throw new ModelCallError(
        "claude-haiku-4-5",
        null,
        String(err instanceof Error ? err.message : err).slice(0, 200),
        "Anthropic transport error or timeout",
      );
    }
    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text().catch(() => "(unreadable)");
      throw new ModelCallError(
        "claude-haiku-4-5",
        response.status,
        errText.slice(0, 500),
        `Anthropic API error ${response.status}`,
      );
    }

    // ── Parse response ──────────────────────────────────────────────────────

    type AnthropicResponse = {
      content: Array<{ type: string; text?: string }>;
      usage?:  { input_tokens?: number; output_tokens?: number };
    };

    const apiResponse = await response.json() as AnthropicResponse;
    const rawText = apiResponse.content
      .filter((b) => b.type === "text")
      .map((b)   => b.text ?? "")
      .join("");

    return {
      rawText,
      modelId:   "claude-haiku-4-5" as ModelId,
      latencyMs: Date.now() - startedAt,
      usage: {
        inputTokens:  apiResponse.usage?.input_tokens  ?? null,
        outputTokens: apiResponse.usage?.output_tokens ?? null,
      },
    };
  },
};
