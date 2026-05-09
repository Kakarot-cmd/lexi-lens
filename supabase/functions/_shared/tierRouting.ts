/**
 * supabase/functions/_shared/tierRouting.ts
 * Lexi-Lens — per-request adapter routing (v6.0).
 *
 * Picks the model adapter for one evaluate call based on:
 *
 *   1. The global feature_flags.evaluate_model_provider kill switch.
 *      If 'anthropic' → force Haiku for everyone (cost emergency rollback).
 *      If 'gemini'    → force Gemini for everyone.
 *      If 'mistral' or unset/null → normal tier routing below.
 *
 *   2. The parent's tier_config.primary_calls_per_day budget.
 *      If 0 → this tier never uses primary; route to Gemini fallback.
 *
 *   3. Today's primary call count for this parent.
 *      If exhausted → fall back to Gemini for the rest of the day.
 *
 *   4. Adapter availability (isConfigured()).
 *      Walks an explicit fallback chain (mistral → gemini → anthropic).
 *
 * ─── Provider hierarchy (locked in v6.0) ──────────────────────────────────
 *
 *   Primary  : Mistral Small 4
 *   Fallback : Gemini 2.5 Flash-Lite  (cost throttle, primary outage)
 *   Deeper   : Anthropic Haiku 4.5    (Mistral + Gemini both down)
 *
 *   Order rationale:
 *     - Gemini second: faster (1.77s vs 2.99s median), cheaper than Haiku,
 *       same vendor diversity benefit
 *     - Haiku last: highest verdict quality but slowest and most expensive;
 *       reserved for "primary AND fallback both broken" scenarios
 *
 * ─── What changed from v5.4 ───────────────────────────────────────────────
 *
 *   • haikuCallsPerDay → primaryCallsPerDay (DB column rename + code)
 *   • haikuCallsToday  → primaryCallsToday  (parameter rename only;
 *                                            RPC still returns the old
 *                                            field name — see the
 *                                            evaluate/index.ts call site)
 *   • Reasons enum reworked around the new hierarchy
 *   • New 'mistral' value path; old 'gemini'/'anthropic' kept for kill-switch
 *
 * ─── Cache hits don't count ───────────────────────────────────────────────
 *
 *   The primary count this routing logic checks excludes cache hits, by
 *   construction (the count comes from get_evaluate_context which filters
 *   cache_hit=false). A parent who scans 50 prewarmed objects plus 3
 *   novel ones has "3 primary calls today", not 53.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

import { anthropicHaikuAdapter } from "./models/anthropic.ts";
import { geminiAdapter }         from "./models/gemini.ts";
import { mistralAdapter }        from "./models/mistral.ts";
import type { ModelAdapter }     from "./models/types.ts";
import { getTierLimits }         from "./tierConfig.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export type RoutingReason =
  | "kill-switch-anthropic"     // global flag = 'anthropic' (force Haiku for all)
  | "kill-switch-gemini"        // global flag = 'gemini' (force Gemini for all)
  | "tier-primary-zero"         // primary_calls_per_day = 0 for this tier
  | "primary-exhausted"         // today's count >= primary_calls_per_day
  | "primary-budget"            // within budget, route to Mistral
  | "fallback-not-configured";  // picked adapter has no key, walked chain

export interface RoutingDecision {
  adapter: ModelAdapter;
  reason:  RoutingReason;
  /** Effective cap and current count for log line / response telemetry. */
  primaryCallsPerDay: number;
  primaryCallsToday:  number;
}

// ─── Internal: feature_flags.evaluate_model_provider read ────────────────────
//
// 60s in-process cache. Doesn't reuse the model factory's getModelAdapter
// because that would couple the cold-start cache to per-request routing
// in confusing ways.

const FLAG_TTL_MS = 60_000;
let cachedFlag: { value: string | null; expiresAt: number } | null = null;

async function readGlobalProviderFlag(
  supabase: SupabaseClient,
): Promise<string | null> {
  const now = Date.now();
  if (cachedFlag && cachedFlag.expiresAt > now) return cachedFlag.value;

  try {
    const { data, error } = await supabase
      .from("feature_flags")
      .select("value")
      .eq("key", "evaluate_model_provider")
      .maybeSingle();

    if (error) {
      cachedFlag = { value: null, expiresAt: now + FLAG_TTL_MS };
      return null;
    }

    const raw   = (data as { value?: unknown } | null)?.value;
    const value = typeof raw === "string" ? raw.trim().toLowerCase() : null;
    cachedFlag  = { value, expiresAt: now + FLAG_TTL_MS };
    return value;
  } catch {
    cachedFlag = { value: null, expiresAt: now + FLAG_TTL_MS };
    return null;
  }
}

// ─── Internal: fallback chain ────────────────────────────────────────────────
//
// Order matters. When the picked adapter is unconfigured, finalize() walks
// this list in order, skipping the picked one, and returns the first that's
// configured. If nothing's configured, returns the original decision and the
// eventual .call() throws — better than swallowing a misconfiguration.

const FALLBACK_CHAIN: readonly ModelAdapter[] = [
  mistralAdapter,         // primary (preferred fallback if Gemini also down)
  geminiAdapter,          // fallback
  anthropicHaikuAdapter,  // deeper fallback
] as const;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Decide which adapter to use for one evaluate request.
 *
 * @param supabase           Service-role Supabase client.
 * @param subscriptionTier   Parent's tier (free | tier1 | tier2 | family | paid).
 * @param primaryCallsToday  Already-used primary calls today (parent-aggregated).
 *                           Source: get_evaluate_context RPC's haiku_calls_today
 *                           field; the field name is residual from v5 and
 *                           is corrected by the caller's variable name.
 */
export async function pickAdapterForRequest(
  supabase:           SupabaseClient,
  subscriptionTier:   string,
  primaryCallsToday:  number,
): Promise<RoutingDecision> {
  const limits = await getTierLimits(supabase, subscriptionTier);

  // 1. Global kill switch — overrides everything except adapter availability.
  const globalFlag = await readGlobalProviderFlag(supabase);
  if (globalFlag === "anthropic") {
    return finalize({
      adapter:            anthropicHaikuAdapter,
      reason:             "kill-switch-anthropic",
      primaryCallsPerDay: limits.primaryCallsPerDay,
      primaryCallsToday,
    });
  }
  if (globalFlag === "gemini") {
    return finalize({
      adapter:            geminiAdapter,
      reason:             "kill-switch-gemini",
      primaryCallsPerDay: limits.primaryCallsPerDay,
      primaryCallsToday,
    });
  }
  // globalFlag === "mistral" or null → continue with normal routing.

  // 2. Tier explicitly configured for zero primary calls.
  if (limits.primaryCallsPerDay === 0) {
    return finalize({
      adapter:            geminiAdapter,
      reason:             "tier-primary-zero",
      primaryCallsPerDay: limits.primaryCallsPerDay,
      primaryCallsToday,
    });
  }

  // 3. Parent's daily primary budget exhausted.
  if (primaryCallsToday >= limits.primaryCallsPerDay) {
    return finalize({
      adapter:            geminiAdapter,
      reason:             "primary-exhausted",
      primaryCallsPerDay: limits.primaryCallsPerDay,
      primaryCallsToday,
    });
  }

  // 4. Within primary budget — route to Mistral.
  return finalize({
    adapter:            mistralAdapter,
    reason:             "primary-budget",
    primaryCallsPerDay: limits.primaryCallsPerDay,
    primaryCallsToday,
  });
}

// ─── Internal: adapter availability final check + fallback walk ──────────────

function finalize(decision: RoutingDecision): RoutingDecision {
  if (decision.adapter.isConfigured()) return decision;

  // Walk the fallback chain in order, skipping the original (broken) pick.
  for (const candidate of FALLBACK_CHAIN) {
    if (candidate.id === decision.adapter.id) continue;
    if (candidate.isConfigured()) {
      console.warn(
        `[tierRouting] picked=${decision.adapter.id} not configured; ` +
        `falling back to ${candidate.id} (original reason: ${decision.reason})`
      );
      return {
        ...decision,
        adapter: candidate,
        reason:  "fallback-not-configured",
      };
    }
  }

  console.error(
    `[tierRouting] no adapter is configured. Set MISTRAL_API_KEY, ` +
    `GOOGLE_AI_STUDIO_KEY, or ANTHROPIC_API_KEY in Edge Function secrets. ` +
    `Original pick: ${decision.adapter.id}, reason: ${decision.reason}`
  );
  return decision; // .call() will throw a clear ModelCallError
}

/** Test-only helper: reset the global flag cache. */
export function _resetTierRoutingCacheForTests(): void {
  cachedFlag = null;
}
