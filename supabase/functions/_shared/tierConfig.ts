/**
 * supabase/functions/_shared/tierConfig.ts
 * Lexi-Lens — tier_config reader (Phase 4.10b).
 *
 * Reads the public.tier_config table for the given subscription tier and
 * returns daily scan cap + Haiku-call cap. Same in-process caching pattern
 * as supabase/functions/_shared/models/index.ts (60s TTL, one DB read per
 * cold container per tier).
 *
 * ─── Resolution order (first hit wins) ────────────────────────────────────
 *
 *   1. tier_config row (cached in-process)
 *      Read at request time, cached for TIER_CONFIG_TTL_MS.
 *
 *   2. Legacy feature_flags fallback
 *      Reads daily_scan_limit_<tier> from feature_flags. haiku_calls_per_day
 *      defaults to the cap (i.e. always-Haiku) so the routing path keeps
 *      working until tier_config rows are seeded.
 *
 *   3. Hardcoded floor
 *      free → cap=5,  haiku=3   (matrix v2.2)
 *      paid → cap=50, haiku=25  (legacy default with 50% Haiku ratio)
 *      Final safety. Never throws.
 *
 * ─── Why a fallback chain ─────────────────────────────────────────────────
 *
 *   tier_config is a new table. During the rollout window between when
 *   the column-add migration applies and the seed lands, OR if the table
 *   gets accidentally truncated, evaluate must keep working with safe
 *   defaults. The fallback chain ensures evaluate NEVER throws on tier
 *   config resolution; the worst outcome is "we use yesterday's defaults"
 *   which is recoverable.
 *
 * ─── Tier vocabulary ──────────────────────────────────────────────────────
 *
 *   Accepts any tier string the caller passes; tier_config CHECK constraint
 *   validates at write time. Unknown tiers fall through the chain to the
 *   hardcoded floor for 'free'. This means a malformed parents.subscription_tier
 *   value yields conservative free-tier limits — the safe direction.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TierLimits {
  capScansPerDay:   number;
  haikuCallsPerDay: number;
  /** "tier_config" | "feature_flags" | "default" — lineage for logging. */
  source: "tier_config" | "feature_flags" | "default";
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TIER_CONFIG_TTL_MS = 60_000; // 60 seconds, mirrors model factory

// Hardcoded floors. Used only if both tier_config AND feature_flags fail.
// Values mirror the v2.2 matrix screenshot where applicable; legacy 'paid'
// uses the previous feature_flags default with a 50% Haiku ratio.
const HARDCODED_FLOOR: Record<string, { cap: number; haiku: number }> = {
  free:   { cap:  5, haiku:  3 },
  tier1:  { cap: 20, haiku:  7 },
  tier2:  { cap: 45, haiku: 14 },
  family: { cap: 60, haiku: 21 },
  paid:   { cap: 50, haiku: 25 }, // legacy
};

// Clamp ranges. Match the safety bounds the original feature_flags
// migration documented (free [1,200], paid [1,500]). Apply same range
// to all paid tiers since none of them legitimately exceed 200/day under
// the v2.2 matrix.
const CAP_MIN = 1;
const CAP_MAX = 1000;

// ─── In-process cache ────────────────────────────────────────────────────────

interface CachedEntry {
  limits:    TierLimits;
  expiresAt: number;
}

const tierCache = new Map<string, CachedEntry>();
const loggedTiers = new Set<string>();

// ─── tier_config row reader ──────────────────────────────────────────────────

async function readTierConfigRow(
  supabase: SupabaseClient,
  tier:     string,
): Promise<TierLimits | null> {
  try {
    const { data, error } = await supabase
      .from("tier_config")
      .select("cap_scans_per_day, haiku_calls_per_day")
      .eq("tier", tier)
      .maybeSingle();

    if (error) {
      console.error(`[tierConfig] tier_config read error (tier=${tier}):`, error.message);
      return null;
    }

    const row = data as { cap_scans_per_day?: unknown; haiku_calls_per_day?: unknown } | null;
    if (!row) return null;

    const cap   = typeof row.cap_scans_per_day   === "number" ? row.cap_scans_per_day   : NaN;
    const haiku = typeof row.haiku_calls_per_day === "number" ? row.haiku_calls_per_day : NaN;
    if (!Number.isFinite(cap) || !Number.isFinite(haiku)) {
      console.warn(`[tierConfig] tier_config row for tier=${tier} has non-numeric values, falling through`);
      return null;
    }

    return {
      capScansPerDay:   clampInt(cap,   CAP_MIN, CAP_MAX),
      haikuCallsPerDay: clampInt(haiku, 0,       CAP_MAX),
      source:           "tier_config",
    };
  } catch (e) {
    console.error(`[tierConfig] tier_config read threw (tier=${tier}):`, e);
    return null;
  }
}

// ─── feature_flags fallback reader ───────────────────────────────────────────

async function readFeatureFlagFallback(
  supabase: SupabaseClient,
  tier:     string,
): Promise<TierLimits | null> {
  // Map tier to the legacy flag key. Tier1/tier2/family didn't exist in
  // the legacy scheme, so they have no fallback path here — they just
  // fall through to the hardcoded floor.
  const flagKey = tier === "free" ? "daily_scan_limit_free"
                : tier === "paid" ? "daily_scan_limit_paid"
                : null;
  if (!flagKey) return null;

  try {
    const { data, error } = await supabase
      .from("feature_flags")
      .select("value")
      .eq("key", flagKey)
      .maybeSingle();

    if (error) return null;

    const raw = (data as { value?: unknown } | null)?.value;
    if (typeof raw !== "string") return null;

    const cap = parseInt(raw, 10);
    if (!Number.isFinite(cap)) return null;

    // No legacy haiku threshold existed; default to cap (always-Haiku) so
    // the routing path remains a no-op until tier_config seeds catch up.
    return {
      capScansPerDay:   clampInt(cap, CAP_MIN, CAP_MAX),
      haikuCallsPerDay: clampInt(cap, 0,       CAP_MAX),
      source:           "feature_flags",
    };
  } catch {
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns the effective TierLimits for the given subscription tier.
 * Never throws. Logs once per cold start per tier.
 */
export async function getTierLimits(
  supabase: SupabaseClient,
  tier:     string,
): Promise<TierLimits> {
  const now = Date.now();
  const cached = tierCache.get(tier);
  if (cached && cached.expiresAt > now) return cached.limits;

  // 1. tier_config row (preferred)
  const fromTable = await readTierConfigRow(supabase, tier);
  if (fromTable) {
    return cacheAndLog(tier, fromTable);
  }

  // 2. Legacy feature_flags fallback
  const fromFlag = await readFeatureFlagFallback(supabase, tier);
  if (fromFlag) {
    return cacheAndLog(tier, fromFlag);
  }

  // 3. Hardcoded floor (per tier; falls through to free if tier unknown)
  const floor = HARDCODED_FLOOR[tier] ?? HARDCODED_FLOOR.free;
  const limits: TierLimits = {
    capScansPerDay:   floor.cap,
    haikuCallsPerDay: floor.haiku,
    source:           "default",
  };
  return cacheAndLog(tier, limits);
}

/**
 * Test-only helper: clear the in-process cache.
 */
export function _resetTierConfigCacheForTests(): void {
  tierCache.clear();
  loggedTiers.clear();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clampInt(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}

function cacheAndLog(tier: string, limits: TierLimits): TierLimits {
  tierCache.set(tier, { limits, expiresAt: Date.now() + TIER_CONFIG_TTL_MS });
  if (!loggedTiers.has(tier)) {
    console.log(
      `[tierConfig] tier=${tier} cap=${limits.capScansPerDay} haiku=${limits.haikuCallsPerDay} source=${limits.source}`
    );
    loggedTiers.add(tier);
  }
  return limits;
}
