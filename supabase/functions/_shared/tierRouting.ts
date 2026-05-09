/**
 * supabase/functions/_shared/tierRouting.ts
 * Lexi-Lens — per-parent Haiku→Gemini adapter routing (Phase 4.10b).
 *
 * Picks the model adapter for a single evaluate call based on:
 *
 *   1. The global feature_flags.evaluate_model_provider kill switch.
 *      If 'gemini', everyone gets Gemini regardless of tier (cost
 *      emergency / Anthropic outage).
 *
 *   2. The parent's tier_config.haiku_calls_per_day budget.
 *      If 0, this tier never uses Haiku.
 *
 *   3. Today's Haiku call count for this parent.
 *      If exhausted, fall back to Gemini for the rest of the day.
 *
 *   4. Adapter availability (isConfigured()).
 *      If Gemini is selected but GOOGLE_AI_STUDIO_KEY is missing,
 *      fall back to Anthropic with a warn log. Same defensive
 *      pattern as the main model factory.
 *
 * ─── Why a separate file from _shared/models/index.ts ─────────────────────
 *
 *   The existing factory (getModelAdapter) is cold-start cached and
 *   returns ONE adapter for the whole container's lifetime. It's right
 *   for the global-flag use case but wrong for per-request routing.
 *
 *   This helper is per-request and stateless. It reads cached values
 *   (tierConfig, model factory) but the routing decision itself happens
 *   on every evaluate call.
 *
 * ─── Cache hits don't count ───────────────────────────────────────────────
 *
 *   The Haiku count this routing logic checks excludes cache hits, by
 *   construction (the count comes from get_evaluate_context which filters
 *   cache_hit=false). This means a parent who scans 50 prewarmed objects
 *   plus 3 novel ones has "3 Haiku calls today", not 53. Consistent with
 *   the v5.2.2 cap design.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

import { anthropicHaikuAdapter } from "./models/anthropic.ts";
import { geminiAdapter }         from "./models/gemini.ts";
import type { ModelAdapter }     from "./models/types.ts";
import { getTierLimits }         from "./tierConfig.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RoutingDecision {
  adapter: ModelAdapter;
  /** Why this adapter was picked. Surface in logs for observability. */
  reason:
    | "global-kill-switch"     // feature_flags.evaluate_model_provider = 'gemini'
    | "tier-haiku-zero"        // haiku_calls_per_day = 0 for this tier
    | "haiku-exhausted"        // today's count >= haiku_calls_per_day
    | "haiku-budget"           // within budget, route to Haiku
    | "gemini-not-configured"; // Gemini selected but key missing → fallback
  /** Effective cap and current count for log line / response telemetry. */
  haikuCallsPerDay: number;
  haikuCallsToday:  number;
}

// ─── Internal: feature_flags.evaluate_model_provider read ────────────────────
//
// Lightweight standalone read; doesn't reuse the model factory's getModelAdapter
// because that would couple cold-start cache to per-request routing in
// confusing ways. 60s in-process cache, same pattern as elsewhere.

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

    const raw = (data as { value?: unknown } | null)?.value;
    const value = typeof raw === "string" ? raw.trim().toLowerCase() : null;
    cachedFlag = { value, expiresAt: now + FLAG_TTL_MS };
    return value;
  } catch {
    cachedFlag = { value: null, expiresAt: now + FLAG_TTL_MS };
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Decide which adapter to use for one evaluate request.
 *
 * @param supabase         Service-role Supabase client.
 * @param subscriptionTier Parent's tier (free | tier1 | tier2 | family | paid).
 * @param haikuCallsToday  Already-used Haiku calls (parent-aggregated).
 */
export async function pickAdapterForRequest(
  supabase:         SupabaseClient,
  subscriptionTier: string,
  haikuCallsToday:  number,
): Promise<RoutingDecision> {
  const limits = await getTierLimits(supabase, subscriptionTier);

  // 1. Global kill switch — overrides everything except adapter availability.
  const globalFlag = await readGlobalProviderFlag(supabase);
  if (globalFlag === "gemini") {
    return finalize({
      adapter:           geminiAdapter,
      reason:            "global-kill-switch",
      haikuCallsPerDay:  limits.haikuCallsPerDay,
      haikuCallsToday,
    });
  }

  // 2. Tier explicitly configured for zero Haiku calls.
  if (limits.haikuCallsPerDay === 0) {
    return finalize({
      adapter:           geminiAdapter,
      reason:            "tier-haiku-zero",
      haikuCallsPerDay:  limits.haikuCallsPerDay,
      haikuCallsToday,
    });
  }

  // 3. Parent's daily Haiku budget exhausted.
  if (haikuCallsToday >= limits.haikuCallsPerDay) {
    return finalize({
      adapter:           geminiAdapter,
      reason:            "haiku-exhausted",
      haikuCallsPerDay:  limits.haikuCallsPerDay,
      haikuCallsToday,
    });
  }

  // 4. Within Haiku budget.
  return finalize({
    adapter:           anthropicHaikuAdapter,
    reason:            "haiku-budget",
    haikuCallsPerDay:  limits.haikuCallsPerDay,
    haikuCallsToday,
  });
}

/**
 * Test-only helper: reset the global flag cache.
 */
export function _resetTierRoutingCacheForTests(): void {
  cachedFlag = null;
}

// ─── Internal: adapter availability final check ──────────────────────────────

function finalize(decision: RoutingDecision): RoutingDecision {
  if (!decision.adapter.isConfigured()) {
    // Fallback: if the picked adapter has no API key, use the other one.
    // Anthropic is the safest default since it's the original primary.
    const fallback = decision.adapter.id === "claude-haiku-4-5"
      ? geminiAdapter
      : anthropicHaikuAdapter;

    if (fallback.isConfigured()) {
      console.warn(
        `[tierRouting] picked=${decision.adapter.id} but not configured; ` +
        `falling back to ${fallback.id} (reason was ${decision.reason})`
      );
      return {
        ...decision,
        adapter: fallback,
        reason:  "gemini-not-configured",
      };
    }

    // Both unconfigured — surface the original decision; the eventual
    // adapter.call() will throw a clear error which evaluate logs and
    // returns 500 on. Better than swallowing the misconfiguration here.
    console.error(
      `[tierRouting] no adapter is configured. Set ANTHROPIC_API_KEY or ` +
      `GOOGLE_AI_STUDIO_KEY in Edge Function secrets.`
    );
  }
  return decision;
}
