/**
 * supabase/functions/_shared/models/index.ts
 * Lexi-Lens — Model Provider Factory (v5.1)
 *
 * Returns a configured ModelAdapter for a given Edge Function scope.
 *
 * ─── Flag resolution order (first hit wins) ──────────────────────────────────
 *
 *   1. Database row in `feature_flags`
 *      key = "{scope}_model_provider", e.g. "evaluate_model_provider"
 *      Cached in-process for FLAG_CACHE_TTL_MS (60 s) so steady-state
 *      requests pay zero DB cost. A flip via SQL UPDATE takes effect
 *      within ~60 s across all warm Edge Function containers.
 *
 *   2. Environment variable
 *      EVALUATE_MODEL_PROVIDER (per scope) or MODEL_PROVIDER (global).
 *      Used when the flag table is unavailable (DB down, row missing,
 *      malformed value). Functions as the failsafe baseline that survives
 *      total DB outage.
 *
 *   3. Hardcoded default: "anthropic"
 *      Final safety. Only reached if both the DB and env are unusable.
 *
 * ─── Why a DB row, not just an env var ──────────────────────────────────────
 *
 *   Solo-dev workflow: flip via Supabase Dashboard → SQL Editor
 *
 *     UPDATE feature_flags
 *     SET    value = 'gemini', updated_at = now()
 *     WHERE  key   = 'evaluate_model_provider';
 *
 *   No code change. No redeploy. No CI. ~60 s to take effect; rollback is
 *   the same UPDATE in reverse. Audit trail in updated_at.
 *
 *   The env-var path remains as a hard backstop — if you ever need to flip
 *   a model when Supabase itself is unreachable, set the secret and redeploy.
 *
 * ─── Why not a per-request DB read ──────────────────────────────────────────
 *
 *   At v5.0 launch scale (<1K concurrent) the 60 s in-process cache means
 *   a typical hour does ~60 DB reads total across all Edge Function
 *   containers, not per-scan. Per-request reads would add ~30 ms latency
 *   on every scan to no benefit. The cache TTL is the operational knob —
 *   shorten if you ever need faster flips.
 *
 * ─── Failure modes ──────────────────────────────────────────────────────────
 *
 *   DB read errors are logged and treated as "no override" — the env-var
 *   chain takes over. Model-provider selection NEVER throws to the caller;
 *   the worst outcome is "we run on Anthropic when you wanted Gemini",
 *   which is recoverable. The opposite (throwing on selection) would mean
 *   one bad flag value takes the whole evaluate path down.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

import { anthropicHaikuAdapter } from "./anthropic.ts";
import { geminiAdapter }         from "./gemini.ts";
import type { ModelAdapter }     from "./types.ts";

// ─── Provider keys ───────────────────────────────────────────────────────────

export type ProviderKey = "anthropic" | "gemini";

const ADAPTERS: Record<ProviderKey, ModelAdapter> = {
  anthropic: anthropicHaikuAdapter,
  gemini:    geminiAdapter,
};

// Functions that may have their own provider override.
// Add a new scope by adding a row here and a row to SCOPE_ENV_VAR.
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
//
// Module-level cache shared by all requests hitting this Edge Function
// container. Cold-start does one DB read per scope; subsequent requests
// within FLAG_CACHE_TTL_MS reuse the cached value.

const FLAG_CACHE_TTL_MS = 60_000; // 60 seconds

interface CachedFlag {
  value:     ProviderKey | null; // null = explicitly resolved as "no DB override"
  expiresAt: number;
}

const flagCache = new Map<FunctionScope, CachedFlag>();
const loggedScopes = new Set<FunctionScope>();

function isProviderKey(v: unknown): v is ProviderKey {
  return v === "anthropic" || v === "gemini";
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

  // 3. Final default
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

  // One log line per cold start per scope, so logs show which model is live
  // without spamming every request.
  if (!loggedScopes.has(scope)) {
    console.log(`[models] scope=${scope} provider=${chosen} model=${adapter.id} source=${source}`);
    loggedScopes.add(scope);
  }

  return adapter;
}

/**
 * Test-only helper: clear the in-process flag cache. Useful when toggling
 * the DB row in integration tests and you don't want to wait 60 s for the
 * cache to expire.
 */
export function _resetFlagCacheForTests(): void {
  flagCache.clear();
  loggedScopes.clear();
}
