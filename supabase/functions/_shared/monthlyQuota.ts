/**
 * _shared/monthlyQuota.ts — per-parent monthly cap enforcement
 *
 * Used by the two user-triggered AI Edge Functions that previously had NO
 * rate limiting at all:
 *
 *   • generate-quest    (feature_key "generate_quest")
 *   • export-word-tome  (feature_key "export_word_tome")
 *
 * Design contract
 * ───────────────
 *   1. The cap VALUE comes from feature_flags via getNumericFlag (60s
 *      in-process cache, clamped, falls back to a sane default). Flat —
 *      identical for free and paid. SQL-tunable with ~60s propagation,
 *      no redeploy.
 *
 *   2. The COUNTER is public.feature_usage_monthly, mutated atomically by
 *      the consume_feature_quota(parent_id, feature_key, cap) RPC. One
 *      round-trip, race-safe, increments only when under cap.
 *
 *   3. FAIL OPEN. This is an abuse brake, not a security control — a parent
 *      must never be blocked from a legitimate action because the counter
 *      table had a hiccup. Any error reading the flag or the RPC → allow
 *      the call (and log once). The real cost ceiling is the cap value;
 *      a transient DB error letting one extra call through is cheaper than
 *      a false 429 on a paying customer.
 *
 *   4. Returns a structured result; the caller decides the HTTP shape so
 *      each function keeps its own response/CORS conventions.
 *
 * Why a shared module: generate-quest and export-word-tome are otherwise
 * unrelated. Copy-pasting the guard would drift. One helper, two callers.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getNumericFlag } from "./featureFlags.ts";

export type QuotaFeature = "generate_quest" | "export_word_tome";

interface QuotaFlagSpec {
  flagKey:      string;
  defaultCap:   number;
}

// Keep flag keys + defaults in ONE place. Defaults here are the safety net
// if the feature_flags row is missing; the migration seeds the real values.
const FEATURE_FLAGS: Record<QuotaFeature, QuotaFlagSpec> = {
  generate_quest:   { flagKey: "generate_quest_monthly_cap",   defaultCap: 15 },
  export_word_tome: { flagKey: "export_word_tome_monthly_cap", defaultCap: 12 },
};

// Clamp bounds for the cap flag. Upper bound doubles as the "effectively
// unlimited" escape hatch (set the flag to 100000 to disable the cap with
// no redeploy).
const CAP_MIN = 1;
const CAP_MAX = 100_000;

export interface QuotaResult {
  /** True → the caller may proceed. */
  allowed:   boolean;
  /** Post-increment count (or current count if blocked / fail-open). */
  used:      number;
  /** The cap that was applied. */
  cap:       number;
  /** True when we allowed the call because of an internal error, not quota. */
  failOpen:  boolean;
}

// Warn-once memory so a persistent DB problem doesn't spam logs every call.
const loggedFailOpen = new Set<QuotaFeature>();

/**
 * Atomically consume one unit of the parent's monthly quota for `feature`.
 *
 * @param admin   A SERVICE-ROLE Supabase client (RLS-bypassing). The
 *                feature_usage_monthly table + consume_feature_quota RPC
 *                are service-role only.
 * @param parentId  auth.users.id of the authenticated parent.
 * @param feature   Which quota bucket.
 */
export async function consumeMonthlyQuota(
  admin:    SupabaseClient,
  parentId: string,
  feature:  QuotaFeature,
): Promise<QuotaResult> {
  const spec = FEATURE_FLAGS[feature];

  // 1. Resolve the cap (flag → default). getNumericFlag never throws.
  const cap = await getNumericFlag(
    admin,
    spec.flagKey,
    spec.defaultCap,
    CAP_MIN,
    CAP_MAX,
  );

  // 2. Atomic check-and-increment. Fail OPEN on any error.
  try {
    const { data, error } = await admin.rpc("consume_feature_quota", {
      p_parent_id:   parentId,
      p_feature_key: feature,
      p_cap:         cap,
    });

    if (error) {
      return failOpen(feature, cap, `rpc error: ${error.message}`);
    }

    // rpc() returns an array of rows for a TABLE-returning function.
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.allowed !== "boolean") {
      return failOpen(feature, cap, "rpc returned unexpected shape");
    }

    return {
      allowed:  row.allowed === true,
      used:     typeof row.new_count === "number" ? row.new_count : 0,
      cap:      typeof row.cap === "number" ? row.cap : cap,
      failOpen: false,
    };
  } catch (e) {
    return failOpen(feature, cap, `rpc threw: ${(e as Error)?.message ?? e}`);
  }
}

function failOpen(feature: QuotaFeature, cap: number, why: string): QuotaResult {
  if (!loggedFailOpen.has(feature)) {
    console.warn(
      `[monthlyQuota] FAIL-OPEN for "${feature}" (cap=${cap}) — ${why}. ` +
      `Allowing the call. This is intentional: the quota is an abuse brake, ` +
      `not a security gate.`,
    );
    loggedFailOpen.add(feature);
  }
  return { allowed: true, used: 0, cap, failOpen: true };
}

/**
 * Friendly, child-safe over-cap message for the client. Kept here so both
 * functions surface identical, on-brand copy. Returned as the `error` field
 * with HTTP 429 — the client already shows `error` text in an Alert.
 */
export function quotaExceededMessage(feature: QuotaFeature): string {
  switch (feature) {
    case "generate_quest":
      return "You've created a lot of custom quests this month. The counter " +
             "resets at the start of next month — your existing quests are " +
             "still here and playable.";
    case "export_word_tome":
      return "You've exported the Word Tome several times this month. The " +
             "limit resets next month. Your child's progress is safe and " +
             "nothing is lost.";
  }
}
