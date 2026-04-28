/**
 * cache.ts
 * Lexi-Lens — Phase 3.4: Upstash Redis verdict caching
 *
 * Cache strategy:
 *   • Cache key  = sha256(detectedLabel + questId + sortedPropertyWords)
 *   • Only cache first-attempt (failedAttempts === 0) verdicts.
 *     Nudge hints on attempt 2+ are session-specific — not worth caching.
 *   • TTL = 7 days (604 800 s). A sofa is still a sofa next week.
 *   • Cached payload = CachedVerdict (no xpAwarded — server always recomputes).
 *
 * Env vars required in Supabase dashboard:
 *   UPSTASH_REDIS_REST_URL   — https://your-endpoint.upstash.io
 *   UPSTASH_REDIS_REST_TOKEN — your Upstash REST token
 *
 * Upstash free tier: 10 000 commands/day, 256 MB — more than enough for MVP.
 */

import type { EvaluationResult, PropertyScore } from "./evaluateObject.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * What we actually persist. We omit xpAwarded because XP is computed
 * from failedAttempts at call time — a cache hit always implies attempt 0,
 * so XP_FIRST_TRY (40) is applied by the caller, not stored here.
 *
 * We DO store childFeedback. It won't be mastery-personalised on a cache hit,
 * but for common objects (sofa, cup, window) the trade-off is worth it.
 * Mastery-dependent responses happen only when the word is first being learned
 * anyway — repeated scans of the same object for the same quest are rare.
 */
export interface CachedVerdict {
  resolvedObjectName: string;
  properties:         PropertyScore[];
  overallMatch:       boolean;
  childFeedback:      string;
  nudgeHint:          string | null;
  /** ISO timestamp — lets us log how old a hit is */
  cachedAt:           string;
}

// ─── Cache key ────────────────────────────────────────────────────────────────

/**
 * Build a deterministic, human-debuggable cache key.
 *
 * We include sortedPropertyWords so that if a quest is ever updated with
 * different property words, the old cached result is automatically bypassed
 * (different hash → cache miss → fresh Claude call).
 *
 * Format: lexi:eval:v1:<hex>
 */
export async function buildCacheKey(
  detectedLabel:      string,
  questId:            string,
  requiredProperties: Array<{ word: string }>
): Promise<string> {
  const sortedWords = requiredProperties
    .map((p) => p.word.toLowerCase())
    .sort()
    .join(",");

  const raw    = `${detectedLabel.toLowerCase()}:${questId}:${sortedWords}`;
  const bytes  = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex    = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `lexi:eval:v1:${hex}`;
}

// ─── Redis client (REST-based, no npm — works in Deno) ───────────────────────

interface UpstashResponse<T> {
  result: T | null;
  error?:  string;
}

class UpstashRedis {
  private url:   string;
  private token: string;

  constructor(url: string, token: string) {
    this.url   = url.replace(/\/$/, ""); // strip trailing slash
    this.token = token;
  }

  private async command<T>(args: unknown[]): Promise<T | null> {
    const res = await fetch(`${this.url}/pipeline`, {
      method:  "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([args]),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Upstash HTTP ${res.status}: ${text}`);
    }

    const json: Array<UpstashResponse<T>> = await res.json();
    if (json[0]?.error) throw new Error(`Upstash error: ${json[0].error}`);
    return json[0]?.result ?? null;
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.command<string>(["GET", key]);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.command(["SET", key, JSON.stringify(value), "EX", ttlSeconds]);
  }

  async incr(key: string): Promise<number> {
    const result = await this.command<number>(["INCR", key]);
    return result ?? 0;
  }
}

// ─── Cache TTL ────────────────────────────────────────────────────────────────

const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

// ─── Exported cache layer ─────────────────────────────────────────────────────

export class VerdictCache {
  private redis: UpstashRedis;

  constructor() {
    const url   = Deno.env.get("UPSTASH_REDIS_REST_URL");
    const token = Deno.env.get("UPSTASH_REDIS_REST_TOKEN");

    if (!url || !token) {
      throw new Error(
        "Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN env vars"
      );
    }

    this.redis = new UpstashRedis(url, token);
  }

  /**
   * Try to return a cached verdict.
   * Returns null on miss or any Redis error (fail-open — never block a scan).
   */
  async get(key: string): Promise<CachedVerdict | null> {
    try {
      return await this.redis.get<CachedVerdict>(key);
    } catch (err) {
      console.error("[VerdictCache] GET failed (fail-open):", err);
      return null;
    }
  }

  /**
   * Store a verdict. Silently swallows errors — a write failure must never
   * surface to the child.
   */
  async set(key: string, verdict: CachedVerdict): Promise<void> {
    try {
     
      await this.redis.set(key, verdict, CACHE_TTL_SECONDS);
     
    } catch (err) {
      console.error("[VerdictCache] SET failed:", err);
    }
  }

  /**
   * Increment a counter key — used for hit/miss telemetry.
   * The Edge Function logs these to stdout → visible in Supabase Edge logs.
   */
  async increment(key: string): Promise<void> {
    try {
      await this.redis.incr(key);
    } catch {
      // telemetry is best-effort
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert a full EvaluationResult to the cacheable subset.
 * xpAwarded is intentionally stripped — always recomputed on retrieval.
 */
export function toCachedVerdict(result: EvaluationResult): CachedVerdict {
  return {
    resolvedObjectName: result.resolvedObjectName,
    properties:         result.properties,
    overallMatch:       result.overallMatch,
    childFeedback:      result.childFeedback,
    nudgeHint:          result.nudgeHint ?? null,
    cachedAt:           new Date().toISOString(),
  };
}

/**
 * Reconstruct a full EvaluationResult from a cached verdict.
 * Since we only cache failedAttempts === 0 calls, XP is always XP_FIRST_TRY
 * for a match, 0 for a non-match.
 */
export function fromCachedVerdict(cached: CachedVerdict): EvaluationResult {
  const XP_FIRST_TRY = 40;
  return {
    resolvedObjectName: cached.resolvedObjectName,
    properties:         cached.properties,
    overallMatch:       cached.overallMatch,
    childFeedback:      cached.childFeedback,
    nudgeHint:          cached.nudgeHint ?? undefined,
    xpAwarded:          cached.overallMatch ? XP_FIRST_TRY : 0,
  };
}
