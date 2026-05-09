/**
 * supabase/functions/_shared/models/index.ts
 * Lexi-Lens — Model Provider Factory (v6.0)
 *
 * Returns a configured ModelAdapter for a given Edge Function scope.
 *
 * v6.0 changes vs v5.4-eval:
 *   • Hardcoded default flipped: 'anthropic' → 'mistral' (Mistral primary)
 *   • Production fallback chain (mistral → gemini → anthropic) preferred
 *     over always-anthropic when picked adapter is unconfigured
 *   • ADAPTERS exported (eval harness in scripts/eval-adapters.ts imports it)
 *   • OpenAI kept in ProviderKey + ADAPTERS for eval harness use even though
 *     production routing never picks it (the kill-switch values written by
 *     the runbook are only 'mistral' | 'gemini' | 'anthropic')
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
 *   3. Hardcoded default: "mistral"
 *
 * ─── How this differs from tierRouting.ts ───────────────────────────────────
 *
 *   This factory returns a single adapter for a whole cold-container's
 *   lifetime. Right for scopes that don't need per-request budgeting
 *   (generate-quest, classify-words, retire-word, export-word-tome).
 *
 *   The evaluate Edge Function uses tierRouting.pickAdapterForRequest()
 *   instead, which makes a fresh routing decision per scan based on the
 *   parent's tier and today's primary-call count.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

import { anthropicHaikuAdapter } from "./anthropic.ts";
import { geminiAdapter }         from "./gemini.ts";
import { mistralAdapter }        from "./mistral.ts";
import { openaiAdapter }         from "./openai.ts";
import type { ModelAdapter }     from "./types.ts";

// ─── Provider keys ───────────────────────────────────────────────────────────

export type ProviderKey = "mistral" | "anthropic" | "gemini" | "openai";

// EXPORTED so scripts/eval-adapters.ts can iterate the full adapter set.
// Production routing never reads this map directly — it goes through
// pickAdapterForRequest() in tierRouting.ts, which knows about the
// production-validated subset.
export const ADAPTERS: Record<ProviderKey, ModelAdapter> = {
  mistral:   mistralAdapter,
  anthropic: anthropicHaikuAdapter,
  gemini:    geminiAdapter,
  openai:    openaiAdapter,
};

// Production fallback order — mirror this in tierRouting.ts. Note that
// openai is intentionally NOT in the fallback chain. It was eval'd but not
// validated against the production prompt + corpus the way mistral/gemini
// were, so we don't fall to it when the picked adapter is unconfigured.
const FALLBACK_ORDER: readonly ProviderKey[] = ["mistral", "gemini", "anthropic"];

function isProviderKey(value: string): value is ProviderKey {
  return value === "mistral"
      || value === "anthropic"
      || value === "gemini"
      || value === "openai";
}

// ─── Function scopes ─────────────────────────────────────────────────────────

export type FunctionScope =
  | "evaluate"
  | "generate-quest"
  | "classify-words"
  | "retire-word"
  | "export-word-tome";

const SCOPE_ENV_VAR: Record<FunctionScope, string> = {
  "evaluate":         "EVALUATE_MODEL_PROVIDER",
  "generate-quest":   "GENERATE_QUEST_MODEL_PROVIDER",
  "classify-words":   "CLASSIFY_WORDS_MODEL_PROVIDER",
  "retire-word":      "RETIRE_WORD_MODEL_PROVIDER",
  "export-word-tome": "EXPORT_WORD_TOME_MODEL_PROVIDER",
};

function flagKey(scope: FunctionScope): string {
  return `${scope.replace(/-/g, "_")}_model_provider`;
}

// ─── In-process cache ────────────────────────────────────────────────────────

const FLAG_CACHE_TTL_MS = 60_000;
const flagCache         = new Map<FunctionScope, { value: ProviderKey | null; expiresAt: number }>();
const loggedScopes      = new Set<FunctionScope>();

// ─── Env-var reader ──────────────────────────────────────────────────────────

function readProviderEnv(varName: string): ProviderKey | null {
  const raw = Deno.env.get(varName)?.trim().toLowerCase();
  if (!raw) return null;
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

/**
 * Returns a configured ModelAdapter for the given scope.
 *
 * `supabase` is required so the factory can read the live feature_flags row.
 * Pass the same service-role client the Edge Function already uses for
 * scan_attempts inserts — service role bypasses RLS, so no policy work is
 * needed.
 */
export async function getModelAdapter(
  scope:    FunctionScope,
  supabase: SupabaseClient,
): Promise<ModelAdapter> {
  // 1. DB row (cached in process)
  const now    = Date.now();
  const cached = flagCache.get(scope);
  let dbValue: ProviderKey | null;

  if (cached && cached.expiresAt > now) {
    dbValue = cached.value;
  } else {
    dbValue = await readFlagFromDb(supabase, scope);
    flagCache.set(scope, { value: dbValue, expiresAt: now + FLAG_CACHE_TTL_MS });
  }

  // 2. Env-var fallback chain
  const envScoped = readProviderEnv(SCOPE_ENV_VAR[scope]);
  const envGlobal = readProviderEnv("MODEL_PROVIDER");

  // 3. Final default (v6.0: mistral, was anthropic)
  const chosen: ProviderKey = dbValue ?? envScoped ?? envGlobal ?? "mistral";
  const source: string =
      dbValue   !== null ? "feature_flags"
    : envScoped !== null ? `env:${SCOPE_ENV_VAR[scope]}`
    : envGlobal !== null ? "env:MODEL_PROVIDER"
    : "default";

  let adapter      = ADAPTERS[chosen];
  let usedFallback = false;

  if (!adapter.isConfigured()) {
    // Walk fallback order, skip the broken pick.
    for (const candidate of FALLBACK_ORDER) {
      if (candidate === chosen) continue;
      const candidateAdapter = ADAPTERS[candidate];
      if (candidateAdapter.isConfigured()) {
        console.warn(
          `[models] Adapter "${chosen}" (source=${source}) is selected for scope ` +
          `"${scope}" but its API key is missing. Falling back to "${candidate}".`,
        );
        adapter      = candidateAdapter;
        usedFallback = true;
        break;
      }
    }
    if (!usedFallback) {
      console.error(
        `[models] No adapter is configured for scope "${scope}". ` +
        `Set at least one of MISTRAL_API_KEY, GOOGLE_AI_STUDIO_KEY, ANTHROPIC_API_KEY.`,
      );
    }
  }

  // One log line per cold start per scope.
  if (!loggedScopes.has(scope)) {
    console.log(
      `[models] scope=${scope} provider=${chosen} model=${adapter.id} ` +
      `source=${source}${usedFallback ? " (via fallback)" : ""}`,
    );
    loggedScopes.add(scope);
  }

  return adapter;
}

/** Test-only helper: clear the in-process flag cache. */
export function _resetFlagCacheForTests(): void {
  flagCache.clear();
  loggedScopes.clear();
}
