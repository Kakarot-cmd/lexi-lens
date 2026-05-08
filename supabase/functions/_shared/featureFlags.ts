/**
 * supabase/functions/_shared/featureFlags.ts
 * Lexi-Lens — generic feature flag reader (v5.2.2)
 *
 * Sibling to _shared/models/index.ts. Same `feature_flags` table, same 60s
 * in-process cache pattern, but for *numeric* runtime knobs rather than
 * provider keys.
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 *
 * Phase 4.10 introduces tier-differentiated daily scan caps (10 free / 50
 * paid as starting values). Pre-launch we cannot know whether those numbers
 * are right. Hardcoding them means a code deploy every time we want to
 * test a new value. Hosting them in feature_flags lets the solo dev flip
 * via Supabase Dashboard → SQL Editor with ~60s propagation across warm
 * Edge Function containers.
 *
 * Future numeric knobs (per-parent quota, quest gen meter, etc.) reuse this
 * helper rather than copy-pasting the cache machinery.
 *
 * ─── Resolution chain ──────────────────────────────────────────────────────
 *
 *     feature_flags row → defaultValue
 *
 * No env-var fallback (unlike the model factory) because numeric ops knobs
 * have a built-in safe default and there is no "Supabase is down so I need
 * to force a different number via redeploy" use case for them — if Supabase
 * is down, the Edge Function cannot serve scans anyway.
 *
 * ─── Clamping ──────────────────────────────────────────────────────────────
 *
 * Every call passes [min, max]. Out-of-range DB values are clamped, NOT
 * rejected — the goal is "a fat-finger UPDATE in SQL Editor should not blow
 * up cost", not "fail loudly". The clamp is logged once per cold start per
 * key so it is visible without spamming.
 *
 * Non-numeric values (NaN, garbage strings) fall through to defaultValue
 * with a warn log. Same rationale.
 *
 * ─── Failure modes ─────────────────────────────────────────────────────────
 *
 * DB read errors are logged and the call returns defaultValue. Selection
 * NEVER throws. Worst outcome: "we ran on the default when the operator
 * wanted a different number", which is recoverable. Same philosophy as the
 * model factory.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Cache ────────────────────────────────────────────────────────────────────

const FLAG_CACHE_TTL_MS = 60_000; // 60 seconds — matches _shared/models/index.ts

interface CachedNumericFlag {
  value:     number;
  expiresAt: number;
}

const numericCache = new Map<string, CachedNumericFlag>();
const loggedClampedKeys = new Set<string>();
const loggedFallbackKeys = new Set<string>();

// ─── DB read ──────────────────────────────────────────────────────────────────

async function readNumericFromDb(
  supabase: SupabaseClient,
  key:      string,
): Promise<number | null> {
  try {
    const { data, error } = await supabase
      .from("feature_flags")
      .select("value")
      .eq("key", key)
      .maybeSingle();

    if (error) {
      console.error(`[featureFlags] read error for "${key}":`, error.message);
      return null;
    }

    const raw = (data as { value?: unknown } | null)?.value;
    if (typeof raw !== "string") return null;

    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;

    // Number.parseInt allows "10abc" → 10; we want strict numeric strings only.
    if (!/^-?\d+$/.test(trimmed)) {
      console.warn(`[featureFlags] non-integer value "${raw}" for "${key}" — falling back to default`);
      return null;
    }

    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch (e) {
    console.error(`[featureFlags] read threw for "${key}":`, e);
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns a numeric feature flag value, clamped to [min, max].
 *
 * @param supabase     Service-role client (bypasses RLS on feature_flags).
 * @param key          feature_flags.key to read.
 * @param defaultValue Returned when the row is missing, malformed, or
 *                     unreachable. Should also be in [min, max].
 * @param min          Inclusive lower clamp.
 * @param max          Inclusive upper clamp.
 *
 * Cache: 60s in-process per key, shared across requests in the same Edge
 * Function container. A flip via SQL UPDATE takes effect within ~60s.
 *
 * Logging: one warn line per cold start per key in two cases —
 *   • DB value out of [min, max] (clamped)
 *   • DB value missing/malformed (fell back to default)
 * Steady-state requests are silent.
 */
export async function getNumericFlag(
  supabase:     SupabaseClient,
  key:          string,
  defaultValue: number,
  min:          number,
  max:          number,
): Promise<number> {
  // Defensive: callers should pass sane bounds, but if they do not, do not
  // silently return nonsense.
  if (min > max) {
    console.error(`[featureFlags] getNumericFlag("${key}") called with min=${min} > max=${max}; returning default`);
    return defaultValue;
  }
  const safeDefault = Math.max(min, Math.min(max, defaultValue));

  const now    = Date.now();
  const cached = numericCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const dbValue = await readNumericFromDb(supabase, key);
  let resolved: number;

  if (dbValue === null) {
    resolved = safeDefault;
    if (!loggedFallbackKeys.has(key)) {
      console.warn(`[featureFlags] "${key}" missing or invalid in DB — using default ${safeDefault}`);
      loggedFallbackKeys.add(key);
    }
  } else if (dbValue < min || dbValue > max) {
    resolved = Math.max(min, Math.min(max, dbValue));
    if (!loggedClampedKeys.has(key)) {
      console.warn(`[featureFlags] "${key}"=${dbValue} out of range [${min}, ${max}] — clamped to ${resolved}`);
      loggedClampedKeys.add(key);
    }
  } else {
    resolved = dbValue;
    // Reset the warn-once memory if the operator fixed the value — next time
    // the key goes bad we want a fresh log line.
    loggedClampedKeys.delete(key);
    loggedFallbackKeys.delete(key);
  }

  numericCache.set(key, { value: resolved, expiresAt: now + FLAG_CACHE_TTL_MS });
  return resolved;
}

/**
 * Test-only helper: clear the in-process numeric flag cache. Useful when
 * toggling DB rows in integration tests and you do not want to wait 60s.
 */
export function _resetNumericFlagCacheForTests(): void {
  numericCache.clear();
  loggedClampedKeys.clear();
  loggedFallbackKeys.clear();
}
