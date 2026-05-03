/**
 * evaluateHandler.ts — pure helpers extracted from
 * supabase/functions/evaluate/index.ts
 *
 * Production-faithful. Deno globals replaced with Node equivalents:
 *   Deno.env.get(k) → process.env[k]
 *   crypto.subtle   → globalThis.crypto.subtle (built-in on Node 20+)
 *   btoa            → globalThis.btoa (built-in on Node 16+)
 */

// ─── Constants (verbatim) ─────────────────────────────────────────────────────

export const DAILY_SCAN_LIMIT    = 50;
export const ALERT_THRESHOLD_PCT = 0.80;
export const IP_LIMIT_PER_MINUTE = 20;
export const IP_WINDOW_MS        = 60_000;

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   ?? "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? "";
const CACHE_TTL_S = 7 * 24 * 60 * 60;

// ─── buildCacheKey (verbatim) ─────────────────────────────────────────────────

export function buildCacheKey(detectedLabel: string, questId: string): string {
  const raw = `${detectedLabel.toLowerCase().trim()}::${questId}`;
  return `lexi:eval:${btoa(raw).replace(/=/g, "")}`;
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

// ─── cacheGet shape validation (extracted from inline cacheGet body) ──────────
// The production fix: cache entries missing the three required fields are
// treated as misses so the broken-format entries don't render an empty card.

export function isValidCacheShape(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const p = parsed as Record<string, unknown>;
  return (
    typeof p.resolvedObjectName === "string" &&
    Array.isArray(p.properties) &&
    typeof p.childFeedback === "string"
  );
}

// ─── xpRates body extractor (verbatim from main handler) ──────────────────────

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

// ─── 429 response builders (extracted for shape-test) ─────────────────────────

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

// ─── checkIpRateLimit (verbatim, type-relaxed for testability) ────────────────

interface MockSupabaseTable {
  select: (cols: string) => MockSupabaseTable;
  eq:     (col: string, val: unknown) => MockSupabaseTable;
  maybeSingle: () => Promise<{ data: { request_count: number; window_start: string } | null }>;
  upsert: (row: Record<string, unknown>) => Promise<{ data: null; error: null }>;
  update: (row: Record<string, unknown>) => MockSupabaseTable;
}

interface MockSupabaseClient {
  from: (table: string) => MockSupabaseTable;
}

export async function checkIpRateLimit(
  supabase: MockSupabaseClient,
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

// ─── Cache-skip rule for retries (extracted from main handler) ────────────────
// Production: cache check is skipped on retries (failedAttempts > 0) so the
// child gets fresh feedback after a failed attempt.

export function shouldCheckCache(failedAttempts: number | undefined): boolean {
  return (failedAttempts ?? 0) === 0;
}

// ─── Body validation extracted from main handler ──────────────────────────────

export type BodyValidation =
  | { valid: true }
  | { valid: false; status: number; body: { error: string } };

export function validateBody(body: Record<string, unknown>): BodyValidation {
  if (!body.childId || typeof body.childId !== "string") {
    return { valid: false, status: 400, body: { error: "childId is required" } };
  }
  if (!body.detectedLabel || typeof body.detectedLabel !== "string") {
    return { valid: false, status: 400, body: { error: "detectedLabel is required" } };
  }
  return { valid: true };
}

// ─── IP extraction from request headers (extracted from main handler) ────────

export function extractIp(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim()
       ?? headers.get("cf-connecting-ip")
       ?? "unknown";
}
