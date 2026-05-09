/**
 * supabase/functions/_shared/tierConfig.ts
 * Lexi-Lens — tier_config reader (v6.0).
 *
 * Reads the public.tier_config table for the given subscription tier and
 * returns daily scan cap + primary-model call cap. Same in-process caching
 * pattern as supabase/functions/_shared/models/index.ts (60s TTL, one DB
 * read per cold container per tier).
 *
 * v6.0 (2026-05-10): renamed haikuCallsPerDay → primaryCallsPerDay
 * throughout. The DB column was also renamed in the matching migration.
 * Existing values are preserved; semantically the field now means
 * "primary-model calls before fallback" rather than "Haiku calls". The
 * primary today is Mistral; the fallback is Gemini.
 *
 * ─── Resolution order (first hit wins) ────────────────────────────────────
 *
 *   1. tier_config row (cached in-process)
 *      Read at request time, cached for TIER_CONFIG_TTL_MS.
 *
 *   2. Legacy feature_flags fallback
 *      Reads daily_scan_limit_<tier> from feature_flags. primaryCallsPerDay
 *      defaults to the cap (i.e. always-primary) so the routing path keeps
 *      working until tier_config rows are seeded.
 *
 *   3. Hardcoded floor
 *      free   → cap=5,  primary=3
 *      tier1  → cap=20, primary=7
 *      tier2  → cap=45, primary=14
 *      family → cap=60, primary=21
 *      paid   → cap=50, primary=25  (legacy)
 *      Final safety. Never throws.
 *
 * ─── Why a fallback chain ─────────────────────────────────────────────────
 *
 *   tier_config rows can be missing during the rollout window between
 *   when the column-rename migration applies and the seed lands, OR if
 *   the table gets accidentally truncated. The Edge Function MUST keep
 *   working with safe defaults — the worst outcome is "we use yesterday's
 *   defaults" which is recoverable. Throwing here would take the whole
 *   evaluate path down and it's not worth the strictness.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TierLimits {
  capScansPerDay:     number;
  primaryCallsPerDay: number;
  /** "tier_config" | "feature_flags" | "default" — lineage for logging. */
  source: "tier_config" | "feature_flags" | "default";
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TIER_CONFIG_TTL_MS = 60_000; // 60 seconds, mirrors model factory

// Hardcoded floors. Used only if both tier_config AND feature_flags fail.
// Values mirror the v2.2 economics matrix where applicable; legacy 'paid'
// uses the previous feature_flags default with a 50% primary ratio.
const HARDCODED_FLOOR: Record<string, { cap: number; primary: number }> = {
  free:   { cap:  5, primary:  3 },
  tier1:  { cap: 20, primary:  7 },
  tier2:  { cap: 45, primary: 14 },
  family: { cap: 60, primary: 21 },
  paid:   { cap: 50, primary: 25 }, // legacy
};

// Clamp ranges. Match the safety bounds the original feature_flags
// migration documented (free [1,200], paid [1,500]). Apply same range to
// all tiers since none of them legitimately exceed 1000/day.
const CAP_MIN = 1;
const CAP_MAX = 1000;

// ─── In-process cache ────────────────────────────────────────────────────────

interface CachedEntry {
  limits:    TierLimits;
  expiresAt: number;
}

const tierCache   = new Map<string, CachedEntry>();
const loggedTiers = new Set<string>();

// ─── tier_config row reader ──────────────────────────────────────────────────

async function readTierConfigRow(
  supabase: SupabaseClient,
  tier:     string,
): Promise<TierLimits | null> {
  try {
    const { data, error } = await supabase
      .from("tier_config")
      .select("cap_scans_per_day, primary_calls_per_day")
      .eq("tier", tier)
      .maybeSingle();

    if (error) {
      console.error(`[tierConfig] tier_config read error (tier=${tier}):`, error.message);
      return null;
    }

    const row = data as { cap_scans_per_day?: unknown; primary_calls_per_day?: unknown } | null;
    if (!row) return null;

    const cap     = typeof row.cap_scans_per_day     === "number" ? row.cap_scans_per_day     : NaN;
    const primary = typeof row.primary_calls_per_day === "number" ? row.primary_calls_per_day : NaN;
    if (!Number.isFinite(cap) || !Number.isFinite(primary)) {
      console.warn(`[tierConfig] tier_config row for tier=${tier} has non-numeric values, falling through`);
      return null;
    }

    return {
      capScansPerDay:     clampInt(cap,     CAP_MIN, CAP_MAX),
      primaryCallsPerDay: clampInt(primary, 0,       CAP_MAX),
      source:             "tier_config",
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
  // the legacy scheme, so they have no fallback path here — they fall
  // through to the hardcoded floor.
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

    if (error || !data) return null;

    const cap = parseInt(String((data as { value?: unknown }).value ?? ""), 10);
    if (!Number.isFinite(cap) || cap < 1) return null;

    return {
      capScansPerDay:     clampInt(cap, CAP_MIN, CAP_MAX),
      primaryCallsPerDay: clampInt(cap, 0,       CAP_MAX),  // always-primary in legacy mode
      source:             "feature_flags",
    };
  } catch {
    return null;
  }
}

// ─── Hardcoded floor ─────────────────────────────────────────────────────────

function hardcodedFloor(tier: string): TierLimits {
  const f = HARDCODED_FLOOR[tier] ?? HARDCODED_FLOOR.free;
  return {
    capScansPerDay:     f.cap,
    primaryCallsPerDay: f.primary,
    source:             "default",
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns scan cap + primary-call cap for the given subscription tier.
 * Cached in-process for TIER_CONFIG_TTL_MS. Never throws.
 */
export async function getTierLimits(
  supabase: SupabaseClient,
  tier:     string,
): Promise<TierLimits> {
  const now    = Date.now();
  const cached = tierCache.get(tier);
  if (cached && cached.expiresAt > now) return cached.limits;

  const limits =
        (await readTierConfigRow(supabase, tier))
    ?? (await readFeatureFlagFallback(supabase, tier))
    ??  hardcodedFloor(tier);

  tierCache.set(tier, { limits, expiresAt: now + TIER_CONFIG_TTL_MS });

  if (!loggedTiers.has(tier)) {
    console.log(
      `[tierConfig] tier=${tier} cap=${limits.capScansPerDay} ` +
      `primary=${limits.primaryCallsPerDay} source=${limits.source}`
    );
    loggedTiers.add(tier);
  }

  return limits;
}

/** Test-only helper: clear the in-process cache. */
export function _resetTierConfigCacheForTests(): void {
  tierCache.clear();
  loggedTiers.clear();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return Math.floor(n);
}
