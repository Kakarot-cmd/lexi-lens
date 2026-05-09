/**
 * supabase/functions/_shared/models/index.ts
 * Lexi-Lens — Model Provider Factory (v5.4-eval, 2026-05-09)
 *
 * v5.4-eval — Adds openai and mistral adapters to ADAPTERS map for the
 *   Phase 4.10b model evaluation. Both are wired through the same
 *   feature_flags + env-var resolution chain as anthropic/gemini.
 *   Production routing in tierRouting.ts still only knows about anthropic
 *   and gemini for now — flipping evaluate to OpenAI or Mistral as primary
 *   requires updating tierRouting.ts and is intentionally NOT wired here
 *   until the eval results justify it.
 *
 * v5.1 — Initial provider abstraction with Anthropic + Gemini.
 *
 * ─── Flag resolution order (first hit wins) ──────────────────────────────────
 *
 *   1. Database row in `feature_flags`
 *      key = "{scope}_model_provider", e.g. "evaluate_model_provider"
 *      Cached in-process for FLAG_CACHE_TTL_MS (60 s).
 *
 *   2. Environment variable
 *      EVALUATE_MODEL_PROVIDER (per scope) or MODEL_PROVIDER (global).
 *
 *   3. Hardcoded default: "anthropic"
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

import { anthropicHaikuAdapter } from "./anthropic.ts";
import { geminiAdapter }         from "./gemini.ts";
import { openaiAdapter }         from "./openai.ts";
import { mistralAdapter }        from "./mistral.ts";
import type { ModelAdapter }     from "./types.ts";

// ─── Provider keys ───────────────────────────────────────────────────────────

export type ProviderKey = "anthropic" | "gemini" | "openai" | "mistral";

const ADAPTERS: Record<ProviderKey, ModelAdapter> = {
  anthropic: anthropicHaikuAdapter,
  gemini:    geminiAdapter,
  openai:    openaiAdapter,
  mistral:   mistralAdapter,
};

// Functions that may have their own provider override.
export type FunctionScope =
  | "evaluate"
  | "classify"
  | "generate-quest"
  | "retire-word"
  | "export-word-tome";

const SCOPE_ENV_VAR: Record<FunctionScope, string> = {
  "evaluate":         "EVALUATE_MODEL_PROVIDER",
  "classify":         "CLASSIFY_MODEL_PROVIDER",
  "generate-quest":   "GENERATE_QUEST_MODEL_PROVIDER",
  "retire-word":      "RETIRE_WORD_MODEL_PROVIDER",
  "export-word-tome": "EXPORT_WORD_TOME_MODEL_PROVIDER",
};

// Map scope → DB feature_flags.key.
function flagKey(scope: FunctionScope): string {
  return `${scope.replace(/-/g, "_")}_model_provider`;
}

// ─── In-process flag cache ───────────────────────────────────────────────────

const FLAG_CACHE_TTL_MS = 60_000;

interface CachedFlag {
  value:     ProviderKey | null;
  expiresAt: number;
}

const flagCache = new Map<FunctionScope, CachedFlag>();
const loggedScopes = new Set<FunctionScope>();

function isProviderKey(v: unknown): v is ProviderKey {
  return v === "anthropic" || v === "gemini" || v === "openai" || v === "mistral";
}

function readProviderEnv(name: string): ProviderKey | null {
  const raw = Deno.env.get(name)?.trim().toLowerCase();
  return isProviderKey(raw) ? raw : null;
}

// ─── DB flag reader ──────────────────────────────────────────────────────────

async function readFlagFromDb(
  supabase: SupabaseClient,
  scope:    FunctionScope,
): Promise<ProviderKey | null> {
  try {
    const { data, error } = await supabase
      .from("feature_flags")
      .select("value")
      .eq("key", flagKey(scope))
      .maybeSingle();

    if (error) {
      console.error(`[models] feature_flags read error (scope=${scope}):`, error.message);
      return null;
    }

    const value = (data as { value?: unknown } | null)?.value;
    if (typeof value !== "string") return null;

    const normalized = value.trim().toLowerCase();
    if (isProviderKey(normalized)) return normalized;

    console.warn(`[models] feature_flags has unknown value "${value}" for ${flagKey(scope)} — falling back to env`);
    return null;
  } catch (e) {
    console.error(`[models] feature_flags read threw (scope=${scope}):`, e);
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function getModelAdapter(
  scope:    FunctionScope,
  supabase: SupabaseClient,
): Promise<ModelAdapter> {
  const now    = Date.now();
  const cached = flagCache.get(scope);
  let dbValue: ProviderKey | null;

  if (cached && cached.expiresAt > now) {
    dbValue = cached.value;
  } else {
    dbValue = await readFlagFromDb(supabase, scope);
    flagCache.set(scope, { value: dbValue, expiresAt: now + FLAG_CACHE_TTL_MS });
  }

  const envScoped = readProviderEnv(SCOPE_ENV_VAR[scope]);
  const envGlobal = readProviderEnv("MODEL_PROVIDER");

  const chosen: ProviderKey = dbValue ?? envScoped ?? envGlobal ?? "anthropic";
  const source: string =
      dbValue   !== null ? "feature_flags"
    : envScoped !== null ? `env:${SCOPE_ENV_VAR[scope]}`
    : envGlobal !== null ? "env:MODEL_PROVIDER"
    : "default";

  let adapter = ADAPTERS[chosen];

  if (!adapter.isConfigured()) {
    console.warn(
      `[models] Adapter "${chosen}" (source=${source}) is selected for scope ` +
      `"${scope}" but its API key is missing. Falling back to anthropic.`,
    );
    adapter = ADAPTERS.anthropic;
  }

  if (!loggedScopes.has(scope)) {
    console.log(`[models] scope=${scope} provider=${chosen} model=${adapter.id} source=${source}`);
    loggedScopes.add(scope);
  }

  return adapter;
}

export function _resetFlagCacheForTests(): void {
  flagCache.clear();
  loggedScopes.clear();
}

// ─── Adapter registry export ─────────────────────────────────────────────────
// Exposed for the eval harness, which needs direct access to all adapters
// regardless of feature_flags state. Production code should use
// getModelAdapter() instead.

export { ADAPTERS };
