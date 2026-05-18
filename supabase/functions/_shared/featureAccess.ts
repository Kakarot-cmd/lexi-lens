/**
 * _shared/featureAccess.ts — access control for the two user-triggered AI
 * Edge Functions (generate-quest, export-word-tome).
 *
 * One call resolves all three controls server-side, atomically:
 *   1. Premium gate   — feature_flags.<feat>_premium_only + parent_has_premium
 *   2. Free-taste grant — feature_flags.<feat>_free_lifetime_grant (lifetime)
 *   3. Monthly cap     — feature_flags.<feat>_monthly_cap (per UTC month)
 *
 * All flag values come via getNumericFlag / a tiny string-flag read (60s
 * cache, clamp, fall-back-to-default). The decision + dual-counter
 * increment is the consume_feature_quota RPC (single round-trip, race-safe).
 *
 * Fail policy — deliberately asymmetric:
 *   • Cost/abrasion controls (cap, counter) FAIL OPEN: a counter/flag DB
 *     hiccup must never block a legitimate parent. One extra Haiku call is
 *     cheaper than a false wall on a paying customer.
 *   • The premium GATE fails CLOSED only when premium_only is ON and we
 *     genuinely cannot identify the caller. If the RPC itself errors we
 *     fail OPEN (treat as allowed) — an internal outage should not paywall
 *     paying users; the entitlement is re-checked next call.
 *
 * Why shared: the two functions are otherwise unrelated; copy-pasting the
 * gate would drift. One helper, two callers.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getNumericFlag } from "./featureFlags.ts";

export type GatedFeature = "generate_quest" | "export_word_tome";

interface FeatureFlagKeys {
  premiumOnly:   string;
  freeGrant:     string;
  monthlyCap:    string;
  defaultCap:    number;
}

const FLAGS: Record<GatedFeature, FeatureFlagKeys> = {
  generate_quest: {
    premiumOnly: "generate_quest_premium_only",
    freeGrant:   "generate_quest_free_lifetime_grant",
    monthlyCap:  "generate_quest_monthly_cap",
    defaultCap:  15,
  },
  export_word_tome: {
    premiumOnly: "export_word_tome_premium_only",
    freeGrant:   "export_word_tome_free_lifetime_grant",
    monthlyCap:  "export_word_tome_monthly_cap",
    defaultCap:  12,
  },
};

const CAP_MIN = 1;
const CAP_MAX = 100_000;
const GRANT_MIN = 0;
const GRANT_MAX = 50;

export type AccessOutcome =
  | "allow"
  | "need_premium"   // → HTTP 402, client routes to Paywall
  | "monthly_cap"    // → HTTP 429, friendly "try next month"
  | "fail_open";     // internal error; allowed anyway (logged)

export interface AccessResult {
  outcome:    AccessOutcome;
  allowed:    boolean;
  monthUsed:  number;
  cap:        number;
}

const loggedFailOpen = new Set<GatedFeature>();

/** Read a boolean string flag ("true"/"false"). Missing/invalid → fallback. */
async function getBoolFlag(
  admin: SupabaseClient,
  key: string,
  fallback: boolean,
): Promise<boolean> {
  try {
    const { data, error } = await admin
      .from("feature_flags")
      .select("value")
      .eq("key", key)
      .maybeSingle();
    if (error || !data) return fallback;
    const v = String((data as { value?: unknown }).value).trim().toLowerCase();
    if (v === "true")  return true;
    if (v === "false") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

/**
 * Resolve access for `feature` and, if allowed, atomically consume one unit.
 *
 * @param admin     SERVICE-ROLE client (RLS-bypassing).
 * @param parentId  auth.users.id of the authenticated parent. Pass null when
 *                  the caller could not be authenticated — handled per the
 *                  fail policy above.
 */
export async function resolveFeatureAccess(
  admin:    SupabaseClient,
  parentId: string | null,
  feature:  GatedFeature,
): Promise<AccessResult> {
  const f = FLAGS[feature];

  const [premiumOnly, cap, grant] = await Promise.all([
    getBoolFlag(admin, f.premiumOnly, true),
    getNumericFlag(admin, f.monthlyCap, f.defaultCap, CAP_MIN, CAP_MAX),
    getNumericFlag(admin, f.freeGrant, 0, GRANT_MIN, GRANT_MAX),
  ]);

  // No identifiable parent.
  if (!parentId) {
    if (premiumOnly) {
      // Entitlement gate ON + unknown caller → fail CLOSED.
      return { outcome: "need_premium", allowed: false, monthUsed: 0, cap };
    }
    // Gate OFF and we can't attribute a counter → fail OPEN (un-capped).
    return failOpen(feature, cap, "no parentId, premium_only=false");
  }

  try {
    const { data, error } = await admin.rpc("consume_feature_quota", {
      p_parent_id:   parentId,
      p_feature_key: feature,
      p_monthly_cap: cap,
      p_free_grant:  premiumOnly ? grant : GRANT_MAX, // gate off ⇒ grant irrelevant
    });

    if (error) return failOpen(feature, cap, `rpc error: ${error.message}`);

    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.decision !== "string") {
      return failOpen(feature, cap, "rpc returned unexpected shape");
    }

    const monthUsed = typeof row.month_used === "number" ? row.month_used : 0;
    const outcome = row.decision as AccessOutcome;
    return {
      outcome,
      allowed:   outcome === "allow",
      monthUsed,
      cap:       typeof row.monthly_cap === "number" ? row.monthly_cap : cap,
    };
  } catch (e) {
    return failOpen(feature, cap, `rpc threw: ${(e as Error)?.message ?? e}`);
  }
}

function failOpen(feature: GatedFeature, cap: number, why: string): AccessResult {
  if (!loggedFailOpen.has(feature)) {
    console.warn(
      `[featureAccess] FAIL-OPEN for "${feature}" (cap=${cap}) — ${why}. ` +
      `Allowing the call (intentional: cost controls fail open).`,
    );
    loggedFailOpen.add(feature);
  }
  return { outcome: "fail_open", allowed: true, monthUsed: 0, cap };
}

/** HTTP status for a blocked outcome. */
export function statusFor(outcome: AccessOutcome): number {
  if (outcome === "need_premium") return 402;
  if (outcome === "monthly_cap")  return 429;
  return 200;
}

/**
 * Client-facing copy. The client maps these by HTTP status:
 *   402 → route to Paywall (the `reason` field tells it which trigger)
 *   429 → show the message in an Alert (no paywall — they ARE paid)
 */
export function messageFor(feature: GatedFeature, outcome: AccessOutcome): {
  error: string;
  reason?: string;
} {
  if (outcome === "need_premium") {
    return feature === "generate_quest"
      ? { error: "Custom AI quests are a Premium feature.", reason: "generate-quest-locked" }
      : { error: "PDF portfolio export is a Premium feature.", reason: "export-tome-locked" };
  }
  if (outcome === "monthly_cap") {
    return feature === "generate_quest"
      ? { error: "You've created a lot of custom quests this month. The limit " +
                 "resets next month — your existing quests are still here." }
      : { error: "You've exported the Word Tome several times this month. The " +
                 "limit resets next month. Nothing is lost." };
  }
  return { error: "" };
}
