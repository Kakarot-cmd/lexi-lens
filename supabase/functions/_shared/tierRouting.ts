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
  /**
   * v6.3 — true if `adapter` matches the configured primary provider
   * (evaluate_primary_provider). False when routed to fallback. Used by
   * evaluate to write scan_attempts.is_primary_call, which feeds back into
   * get_evaluate_context.primary_calls_today. NOT a tautology: the
   * kill-switch can pick a fallback-class adapter (e.g. Gemini) even though
   * the configured primary is Mistral — that's isPrimary=false.
   */
  isPrimary: boolean;
  /** Effective cap and current count for log line / response telemetry. */
  primaryCallsPerDay: number;
  primaryCallsToday:  number;
}

// ─── Internal: feature_flags reader (generic, per-key cached) ────────────────
//
// 60s in-process cache per key. Doesn't reuse the model factory's
// getModelAdapter because that would couple the cold-start cache to
// per-request routing in confusing ways. Three keys read per request:
//   - evaluate_model_provider     (kill-switch — overrides both primary and fallback)
//   - evaluate_primary_provider   (which adapter to use for primary slot)
//   - evaluate_fallback_provider  (which adapter to use for fallback slot)

const FLAG_TTL_MS = 60_000;
const flagCache = new Map<string, { value: string | null; expiresAt: number }>();

async function readFlag(
  supabase: SupabaseClient,
  key:      string,
): Promise<string | null> {
  const now    = Date.now();
  const cached = flagCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  try {
    const { data, error } = await supabase
      .from("feature_flags")
      .select("value")
      .eq("key", key)
      .maybeSingle();

    if (error) {
      flagCache.set(key, { value: null, expiresAt: now + FLAG_TTL_MS });
      return null;
    }

    const raw   = (data as { value?: unknown } | null)?.value;
    const value = typeof raw === "string" ? raw.trim().toLowerCase() : null;
    flagCache.set(key, { value, expiresAt: now + FLAG_TTL_MS });
    return value;
  } catch {
    flagCache.set(key, { value: null, expiresAt: now + FLAG_TTL_MS });
    return null;
  }
}

// ─── Internal: provider string → adapter mapping ─────────────────────────────
//
// Centralised in one place so primary/fallback/kill-switch all interpret the
// same vocabulary identically. Returns null on unknown values; callers default
// to mistralAdapter (primary) or geminiAdapter (fallback) when null comes back.

function providerToAdapter(provider: string | null): ModelAdapter | null {
  const p = (provider ?? "").trim().toLowerCase();
  if (p === "mistral")   return mistralAdapter;
  if (p === "gemini")    return geminiAdapter;
  if (p === "anthropic") return anthropicHaikuAdapter;
  return null;
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
 *                           Source: get_evaluate_context RPC's
 *                           primary_calls_today field (v6.3 rename from
 *                           haiku_calls_today). Counts scan_attempts rows
 *                           with is_primary_call=true.
 */
export async function pickAdapterForRequest(
  supabase:           SupabaseClient,
  subscriptionTier:   string,
  primaryCallsToday:  number,
): Promise<RoutingDecision> {
  const limits = await getTierLimits(supabase, subscriptionTier);

  // Read all three routing flags in parallel. Each is independently cached
  // 60s; first call after deploy reads from DB, rest hit the in-process map.
  const [killSwitch, primaryFlag, fallbackFlag] = await Promise.all([
    readFlag(supabase, "evaluate_model_provider"),
    readFlag(supabase, "evaluate_primary_provider"),
    readFlag(supabase, "evaluate_fallback_provider"),
  ]);

  const primaryAdapter  = providerToAdapter(primaryFlag)  ?? mistralAdapter;
  const fallbackAdapter = providerToAdapter(fallbackFlag) ?? geminiAdapter;

  // 1. Global kill switch — overrides primary/fallback flags entirely.
  // isPrimary is true ONLY if the kill-switch happens to land on the same
  // adapter the primary flag would have picked. Usually false.
  if (killSwitch === "anthropic") {
    return finalize({
      adapter:            anthropicHaikuAdapter,
      reason:             "kill-switch-anthropic",
      isPrimary:          anthropicHaikuAdapter.id === primaryAdapter.id,
      primaryCallsPerDay: limits.primaryCallsPerDay,
      primaryCallsToday,
    });
  }
  if (killSwitch === "gemini") {
    return finalize({
      adapter:            geminiAdapter,
      reason:             "kill-switch-gemini",
      isPrimary:          geminiAdapter.id === primaryAdapter.id,
      primaryCallsPerDay: limits.primaryCallsPerDay,
      primaryCallsToday,
    });
  }
  // killSwitch === "mistral", "" or null → continue with normal routing.

  // 2. Tier explicitly configured for zero primary calls — always fallback.
  if (limits.primaryCallsPerDay === 0) {
    return finalize({
      adapter:            fallbackAdapter,
      reason:             "tier-primary-zero",
      isPrimary:          false,
      primaryCallsPerDay: limits.primaryCallsPerDay,
      primaryCallsToday,
    });
  }

  // 3. Parent's daily primary budget exhausted — fallback for the rest of the day.
  if (primaryCallsToday >= limits.primaryCallsPerDay) {
    return finalize({
      adapter:            fallbackAdapter,
      reason:             "primary-exhausted",
      isPrimary:          false,
      primaryCallsPerDay: limits.primaryCallsPerDay,
      primaryCallsToday,
    });
  }

  // 4. Within primary budget — route to the configured primary.
  return finalize({
    adapter:            primaryAdapter,
    reason:             "primary-budget",
    isPrimary:          true,
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

/** Test-only helper: reset the flag cache. */
export function _resetTierRoutingCacheForTests(): void {
  flagCache.clear();
}
