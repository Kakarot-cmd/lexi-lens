/**
 * evaluateHandler.ts — pure helpers extracted from
 * supabase/functions/evaluate/index.ts
 *
 * Production-faithful. Deno globals replaced with Node equivalents:
 *   Deno.env.get(k) → process.env[k]
 *   crypto.subtle   → globalThis.crypto.subtle (built-in on Node 20+)
 *   btoa            → globalThis.btoa (built-in on Node 16+)
 *
 * v4.7 changes:
 *   • buildCacheKey gained pendingWords parameter (was 2-arg, now 3-arg)
 *   • Cache key prefix now includes ENV_NAME from CACHE_ENV_NAMESPACE
 *   • buildCacheKey normalisation expanded: case + whitespace + plural rule
 *   • CACHE_TTL_S widened from 7 days → 14 days to match prod
 *   • Added _resetEnvNameForTests helper for test-time env mutation
 */

// ─── Constants (verbatim from production) ─────────────────────────────────────

export const DAILY_SCAN_LIMIT    = 50;
export const ALERT_THRESHOLD_PCT = 0.80;
export const IP_LIMIT_PER_MINUTE = 20;
export const IP_WINDOW_MS        = 60_000;

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   ?? "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? "";
const CACHE_TTL_S = 14 * 24 * 60 * 60;  // v4.5 — 14 days

// ─── Cache env namespace (v4.7) ──────────────────────────────────────────────
//
// Read at module load. Tests that need to alter this should mutate
// process.env.CACHE_ENV_NAMESPACE then call _resetEnvNameForTests().
//
// Fail-safe: an unset / invalid value lands in the "default" namespace —
// distinct from both "staging" and "prod" — so a misconfigured project at
// least doesn't collide with either real env.

let ENV_NAME: string = resolveEnvName();

function resolveEnvName(): string {
  const fromEnv = process.env.CACHE_ENV_NAMESPACE?.trim().toLowerCase();
  if (fromEnv && /^[a-z0-9_-]+$/.test(fromEnv)) return fromEnv;
  return "default";
}

/**
 * Test-only helper: re-read CACHE_ENV_NAMESPACE from process.env.
 * Allows tests to mutate the env var, call this, and exercise the
 * prefix logic without resetting the module.
 */
export function _resetEnvNameForTests(): void {
  ENV_NAME = resolveEnvName();
}

// ─── buildCacheKey (v4.7 — 3-arg, env-prefixed, normalised) ──────────────────
//
// Mirrors supabase/functions/evaluate/index.ts buildCacheKey verbatim except
// for the Deno→Node globals. Plural rule is conservative: only strips
// trailing 's' when preceded by a letter that is NOT 's' and NOT 'e':
//   "rings"   → "ring"     ✓ (g before s)
//   "books"   → "book"     ✓ (k before s)
//   "glass"   → "glass"    ✓ (ss preserved)
//   "glasses" → "glasses"  ✓ (es preserved)
//   "phones"  → "phones"   ✓ (e before s blocks — miss, accepted cost)

export function buildCacheKey(
  detectedLabel: string,
  questId:       string,
  pendingWords:  string[] = []
): string {
  const normalize = (s: string) =>
    s.toLowerCase()
     .trim()
     .replace(/\s+/g, " ")
     .replace(/([a-z]{2,})([^se])s\b/g, "$1$2");

  const sortedWords = [...pendingWords].map(normalize).sort().join(",");
  const raw         = `${normalize(detectedLabel)}::${questId}::${sortedWords}`;
  return `${ENV_NAME}:lexi:eval:${btoa(raw).replace(/=/g, "")}`;
}

// ─── utcMidnight (verbatim) ───────────────────────────────────────────────────

export function utcMidnight(): string {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

// ─── jsonResponse + CORS_HEADERS (verbatim) ───────────────────────────────────

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// ─── hashIp (verbatim with process.env) ───────────────────────────────────────

export async function hashIp(ip: string): Promise<string> {
  const encoded = new TextEncoder().encode(
    ip + (process.env.IP_HASH_SALT ?? "lexi-lens")
  );
  const buf = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

// ─── Cache shape validation ──────────────────────────────────────────────────
// Production fix: cache entries missing the three required fields are
// treated as misses so broken-format entries don't render an empty card.

export function isValidCacheShape(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const p = parsed as Record<string, unknown>;
  return (
    typeof p.resolvedObjectName === "string" &&
    Array.isArray(p.properties) &&
    typeof p.childFeedback === "string"
  );
}

// ─── XP rates body extractor (verbatim from main handler) ────────────────────

export function extractXpRates(body: Record<string, unknown>): {
  firstTry: number; secondTry: number; thirdPlus: number;
} {
  const { xp_reward_first_try, xp_reward_retry, xp_reward_third_plus } = body;
  return {
    firstTry:  typeof xp_reward_first_try  === "number" ? xp_reward_first_try  : 40,
    secondTry: typeof xp_reward_retry      === "number" ? xp_reward_retry      : 25,
    thirdPlus: typeof xp_reward_third_plus === "number" ? xp_reward_third_plus : 10,
  };
}

// ─── 429 response builders (extracted for shape-test) ────────────────────────

export function buildIpLimitResponseBody() {
  return {
    error:      "rate_limit_exceeded",
    code:       "IP_LIMIT",
    message:    "Too many requests. Please wait a moment before scanning again.",
    retryAfter: 60,
  };
}

export function buildDailyQuotaResponseBody(scansToday: number) {
  return {
    error:      "rate_limit_exceeded",
    code:       "DAILY_QUOTA",
    scansToday,
    limit:      DAILY_SCAN_LIMIT,
    resetsAt:   utcMidnight(),
    message:    "Daily scan limit reached. Come back tomorrow, brave adventurer!",
  };
}

// ─── checkIpRateLimit (verbatim) ─────────────────────────────────────────────
// Note: the production version takes a Supabase client; here we accept any
// object that exposes .from(...).select / .insert / .update / .upsert /
// .eq / .maybeSingle. The test suite passes in a stub.

export async function checkIpRateLimit(
  supabase: any,
  ipHash:   string
): Promise<{ allowed: boolean; requestCount: number }> {
  const windowStart = new Date(Date.now() - IP_WINDOW_MS).toISOString();

  const { data: existing } = await supabase
    .from("ip_rate_limits")
    .select("request_count, window_start")
    .eq("ip_hash", ipHash)
    .maybeSingle();

  if (!existing || existing.window_start < windowStart) {
    await supabase.from("ip_rate_limits").upsert({
      ip_hash:       ipHash,
      request_count: 1,
      window_start:  new Date().toISOString(),
    });
    return { allowed: true, requestCount: 1 };
  }

  const newCount = existing.request_count + 1;
  await supabase
    .from("ip_rate_limits")
    .update({ request_count: newCount })
    .eq("ip_hash", ipHash);

  return { allowed: newCount <= IP_LIMIT_PER_MINUTE, requestCount: newCount };
}

// ─── shouldCheckCache (verbatim) ─────────────────────────────────────────────
// Cache is bypassed on retry attempts because nudge hints are session-
// specific. Only first-try evaluations are cacheable.

export function shouldCheckCache(failedAttempts: number): boolean {
  return failedAttempts === 0;
}

// ─── validateBody (verbatim) ─────────────────────────────────────────────────

export function validateBody(body: Record<string, unknown>): {
  valid: boolean; missing: string[];
} {
  const required = [
    "childId",
    "imageBase64",
    "currentWord",
    "questId",
    "detectedLabel",
  ];
  const missing = required.filter((k) => body[k] === undefined || body[k] === null);
  return { valid: missing.length === 0, missing };
}

// ─── extractIp (verbatim) ────────────────────────────────────────────────────
// Order: x-forwarded-for (first hop) → cf-connecting-ip → fallback

export function extractIp(headers: Headers | Record<string, string | undefined>): string {
  const get = (k: string): string | undefined => {
    if (headers instanceof Headers) return headers.get(k) ?? undefined;
    return headers[k] ?? headers[k.toLowerCase()];
  };

  const xff = get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || "unknown";

  const cf = get("cf-connecting-ip");
  if (cf) return cf;

  return "unknown";
}
