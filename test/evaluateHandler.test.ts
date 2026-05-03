/**
 * evaluateHandler.test.ts
 * Chunk 2 — evaluate Edge Function pure helpers
 *
 * Coverage:
 *   1. buildCacheKey         — shape, idempotency, lowercasing, base64 padding strip
 *   2. utcMidnight           — always future, always midnight UTC
 *   3. hashIp                — deterministic, salt-respecting, fixed-length
 *   4. isValidCacheShape     — the production cache-corruption guard
 *   5. extractXpRates        — DB rate override, fallback to constants, mixed types
 *   6. 429 response shapes   — IP_LIMIT and DAILY_QUOTA bodies
 *   7. checkIpRateLimit      — fresh window, in-window, over-limit, exact boundary
 *   8. shouldCheckCache      — skip on retry
 *   9. validateBody          — required fields
 *  10. extractIp             — x-forwarded-for, cf-connecting-ip, fallback
 *  11. jsonResponse          — CORS headers, content-type, status code
 */

import {
  buildCacheKey,
  utcMidnight,
  hashIp,
  isValidCacheShape,
  extractXpRates,
  buildIpLimitResponseBody,
  buildDailyQuotaResponseBody,
  checkIpRateLimit,
  shouldCheckCache,
  validateBody,
  extractIp,
  jsonResponse,
  CORS_HEADERS,
  DAILY_SCAN_LIMIT,
  IP_LIMIT_PER_MINUTE,
  IP_WINDOW_MS,
} from "./evaluateHandler";

// ═══════════════════════════════════════════════════════════════════════════════
// 1. buildCacheKey
// ═══════════════════════════════════════════════════════════════════════════════

describe("buildCacheKey", () => {
  test("starts with the lexi:eval: namespace", () => {
    expect(buildCacheKey("apple", "quest-1")).toMatch(/^lexi:eval:/);
  });

  test("is deterministic for the same input", () => {
    expect(buildCacheKey("apple", "quest-1")).toBe(buildCacheKey("apple", "quest-1"));
  });

  test("normalises label: case-insensitive and trim", () => {
    expect(buildCacheKey("APPLE", "q1")).toBe(buildCacheKey("apple", "q1"));
    expect(buildCacheKey("  apple  ", "q1")).toBe(buildCacheKey("apple", "q1"));
    expect(buildCacheKey("Apple\n", "q1")).toBe(buildCacheKey("apple", "q1"));
  });

  test("does NOT normalise questId — different quests give different keys", () => {
    expect(buildCacheKey("apple", "q1")).not.toBe(buildCacheKey("apple", "q2"));
  });

  test("strips base64 '=' padding", () => {
    const key = buildCacheKey("apple", "q1");
    expect(key).not.toContain("=");
  });

  test("handles empty questId without throwing", () => {
    expect(() => buildCacheKey("apple", "")).not.toThrow();
    const key = buildCacheKey("apple", "");
    expect(key).toMatch(/^lexi:eval:/);
  });

  test("handles unicode labels", () => {
    expect(() => buildCacheKey("café", "q1")).not.toThrow();
    expect(buildCacheKey("café", "q1")).not.toBe(buildCacheKey("cafe", "q1"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. utcMidnight
// ═══════════════════════════════════════════════════════════════════════════════

describe("utcMidnight", () => {
  test("returns a valid ISO 8601 string", () => {
    const iso = utcMidnight();
    expect(() => new Date(iso)).not.toThrow();
    expect(new Date(iso).toISOString()).toBe(iso);
  });

  test("returns a date STRICTLY in the future", () => {
    expect(new Date(utcMidnight()).getTime()).toBeGreaterThan(Date.now());
  });

  test("the returned moment is exactly midnight UTC (00:00:00.000)", () => {
    const d = new Date(utcMidnight());
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCSeconds()).toBe(0);
    expect(d.getUTCMilliseconds()).toBe(0);
  });

  test("returns at most ~24 hours in the future", () => {
    const ms = new Date(utcMidnight()).getTime() - Date.now();
    expect(ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. hashIp
// ═══════════════════════════════════════════════════════════════════════════════

describe("hashIp", () => {
  test("returns a 16-char hex string", () => {
    return hashIp("1.2.3.4").then((h) => {
      expect(h).toHaveLength(16);
      expect(h).toMatch(/^[0-9a-f]+$/);
    });
  });

  test("is deterministic for the same IP", async () => {
    const a = await hashIp("1.2.3.4");
    const b = await hashIp("1.2.3.4");
    expect(a).toBe(b);
  });

  test("different IPs produce different hashes", async () => {
    const a = await hashIp("1.2.3.4");
    const b = await hashIp("5.6.7.8");
    expect(a).not.toBe(b);
  });

  test("salt changes the hash (verified via env override)", async () => {
    const before = await hashIp("1.2.3.4");
    const oldSalt = process.env.IP_HASH_SALT;
    process.env.IP_HASH_SALT = "different-salt";
    // Re-import to pick up new env? hashIp reads env at call time — verify.
    const after = await hashIp("1.2.3.4");
    if (oldSalt === undefined) delete process.env.IP_HASH_SALT;
    else process.env.IP_HASH_SALT = oldSalt;
    expect(before).not.toBe(after);
  });

  test("'unknown' IP doesn't crash", async () => {
    const h = await hashIp("unknown");
    expect(h).toHaveLength(16);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. isValidCacheShape — the production bug-fix guard
// ═══════════════════════════════════════════════════════════════════════════════

describe("isValidCacheShape", () => {
  test("accepts a fully-formed cache entry", () => {
    expect(isValidCacheShape({
      resolvedObjectName: "apple",
      properties:         [],
      childFeedback:      "Nice!",
      overallMatch:       true,
      xpAwarded:          40,
    })).toBe(true);
  });

  test("rejects null and undefined", () => {
    expect(isValidCacheShape(null)).toBe(false);
    expect(isValidCacheShape(undefined)).toBe(false);
  });

  test("rejects primitives", () => {
    expect(isValidCacheShape("apple")).toBe(false);
    expect(isValidCacheShape(42)).toBe(false);
    expect(isValidCacheShape(true)).toBe(false);
  });

  test("rejects the broken-format that triggered the production bug", () => {
    // The buggy cacheSet stored { value: JSON.string, ex: ttl } as the cache entry.
    expect(isValidCacheShape({ value: "{...}", ex: 604800 })).toBe(false);
  });

  test("rejects when resolvedObjectName is missing or wrong type", () => {
    expect(isValidCacheShape({ properties: [], childFeedback: "x" })).toBe(false);
    expect(isValidCacheShape({ resolvedObjectName: 42, properties: [], childFeedback: "x" })).toBe(false);
  });

  test("rejects when properties is missing or not an array", () => {
    expect(isValidCacheShape({ resolvedObjectName: "x", childFeedback: "x" })).toBe(false);
    expect(isValidCacheShape({ resolvedObjectName: "x", properties: "not array", childFeedback: "x" })).toBe(false);
  });

  test("rejects when childFeedback is missing or wrong type", () => {
    expect(isValidCacheShape({ resolvedObjectName: "x", properties: [] })).toBe(false);
    expect(isValidCacheShape({ resolvedObjectName: "x", properties: [], childFeedback: 123 })).toBe(false);
  });

  test("accepts even when extra fields are present", () => {
    expect(isValidCacheShape({
      resolvedObjectName: "apple",
      properties:         [],
      childFeedback:      "x",
      somethingExtra:     "fine",
    })).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. extractXpRates
// ═══════════════════════════════════════════════════════════════════════════════

describe("extractXpRates — XP FIX (per-quest DB values)", () => {
  test("uses DB values when all three are numbers", () => {
    expect(extractXpRates({
      xp_reward_first_try:  100,
      xp_reward_retry:      60,
      xp_reward_third_plus: 20,
    })).toEqual({ firstTry: 100, secondTry: 60, thirdPlus: 20 });
  });

  test("falls back to defaults (40/25/10) when fields are missing", () => {
    expect(extractXpRates({})).toEqual({ firstTry: 40, secondTry: 25, thirdPlus: 10 });
  });

  test("falls back per-field when a single value is wrong type", () => {
    expect(extractXpRates({
      xp_reward_first_try:  100,
      xp_reward_retry:      "not a number",
      xp_reward_third_plus: null,
    })).toEqual({ firstTry: 100, secondTry: 25, thirdPlus: 10 });
  });

  test("rejects boolean false (not a number)", () => {
    expect(extractXpRates({ xp_reward_first_try: false })).toEqual({
      firstTry: 40, secondTry: 25, thirdPlus: 10,
    });
  });

  test("0 is a valid value (not falsy-rejected)", () => {
    // Edge case: a quest with xp=0 should pass through, not get bumped to 40.
    expect(extractXpRates({
      xp_reward_first_try:  0,
      xp_reward_retry:      0,
      xp_reward_third_plus: 0,
    })).toEqual({ firstTry: 0, secondTry: 0, thirdPlus: 0 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. 429 response shapes
// ═══════════════════════════════════════════════════════════════════════════════

describe("429 response bodies", () => {
  test("IP_LIMIT body has the contract fields the client expects", () => {
    const body = buildIpLimitResponseBody();
    expect(body.error).toBe("rate_limit_exceeded");
    expect(body.code).toBe("IP_LIMIT");
    expect(body.retryAfter).toBe(60);
    expect(typeof body.message).toBe("string");
  });

  test("DAILY_QUOTA body includes scansToday, limit, and resetsAt", () => {
    const body = buildDailyQuotaResponseBody(50);
    expect(body.error).toBe("rate_limit_exceeded");
    expect(body.code).toBe("DAILY_QUOTA");
    expect(body.scansToday).toBe(50);
    expect(body.limit).toBe(DAILY_SCAN_LIMIT);
    expect(typeof body.resetsAt).toBe("string");
    expect(new Date(body.resetsAt).getTime()).toBeGreaterThan(Date.now());
  });

  test("DAILY_QUOTA body propagates scansToday correctly", () => {
    expect(buildDailyQuotaResponseBody(50).scansToday).toBe(50);
    expect(buildDailyQuotaResponseBody(99).scansToday).toBe(99);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. checkIpRateLimit
// ═══════════════════════════════════════════════════════════════════════════════

function makeMockSupabase(opts: {
  existing?: { request_count: number; window_start: string } | null;
  upsertSpy?: jest.Mock;
  updateSpy?: jest.Mock;
}) {
  const upsertSpy = opts.upsertSpy ?? jest.fn().mockResolvedValue({ data: null, error: null });
  const updateSpy = opts.updateSpy ?? jest.fn().mockResolvedValue({ data: null, error: null });

  const tableApi: any = {
    select:      jest.fn().mockReturnThis(),
    eq:          jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: opts.existing ?? null }),
    upsert:      upsertSpy,
    update:      jest.fn(() => ({ eq: updateSpy })),
  };

  return {
    client: { from: jest.fn(() => tableApi) },
    upsertSpy,
    updateSpy,
    tableApi,
  };
}

describe("checkIpRateLimit", () => {
  test("first call from a new IP → allowed, count = 1, upsert called", async () => {
    const { client, upsertSpy } = makeMockSupabase({ existing: null });
    const result = await checkIpRateLimit(client as any, "deadbeef");
    expect(result.allowed).toBe(true);
    expect(result.requestCount).toBe(1);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
  });

  test("expired window (window_start older than IP_WINDOW_MS) → reset to 1", async () => {
    const stale = new Date(Date.now() - IP_WINDOW_MS - 1000).toISOString();
    const { client, upsertSpy } = makeMockSupabase({
      existing: { request_count: 999, window_start: stale },
    });
    const result = await checkIpRateLimit(client as any, "x");
    expect(result.allowed).toBe(true);
    expect(result.requestCount).toBe(1);
    expect(upsertSpy).toHaveBeenCalled();
  });

  test("within window, count under limit → allowed, count incremented", async () => {
    const fresh = new Date().toISOString();
    const { client, updateSpy } = makeMockSupabase({
      existing: { request_count: 5, window_start: fresh },
    });
    const result = await checkIpRateLimit(client as any, "x");
    expect(result.allowed).toBe(true);
    expect(result.requestCount).toBe(6);
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  test("exactly at the limit → still allowed (boundary: <=)", async () => {
    const fresh = new Date().toISOString();
    const { client } = makeMockSupabase({
      existing: { request_count: IP_LIMIT_PER_MINUTE - 1, window_start: fresh },
    });
    const result = await checkIpRateLimit(client as any, "x");
    expect(result.requestCount).toBe(IP_LIMIT_PER_MINUTE);
    expect(result.allowed).toBe(true);
  });

  test("one over the limit → BLOCKED", async () => {
    const fresh = new Date().toISOString();
    const { client } = makeMockSupabase({
      existing: { request_count: IP_LIMIT_PER_MINUTE, window_start: fresh },
    });
    const result = await checkIpRateLimit(client as any, "x");
    expect(result.requestCount).toBe(IP_LIMIT_PER_MINUTE + 1);
    expect(result.allowed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. shouldCheckCache
// ═══════════════════════════════════════════════════════════════════════════════

describe("shouldCheckCache — skip on retry", () => {
  test("checks cache on first attempt (failedAttempts = 0)", () => {
    expect(shouldCheckCache(0)).toBe(true);
  });

  test("checks cache when failedAttempts is undefined", () => {
    expect(shouldCheckCache(undefined)).toBe(true);
  });

  test("SKIPS cache on any retry (failedAttempts >= 1)", () => {
    expect(shouldCheckCache(1)).toBe(false);
    expect(shouldCheckCache(2)).toBe(false);
    expect(shouldCheckCache(99)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. validateBody
// ═══════════════════════════════════════════════════════════════════════════════

describe("validateBody", () => {
  test("rejects when childId is missing", () => {
    const r = validateBody({ detectedLabel: "apple" });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/childId/);
    }
  });

  test("rejects when childId is wrong type", () => {
    const r = validateBody({ childId: 42, detectedLabel: "apple" });
    expect(r.valid).toBe(false);
  });

  test("rejects when detectedLabel is missing", () => {
    const r = validateBody({ childId: "abc" });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.body.error).toMatch(/detectedLabel/);
  });

  test("accepts a minimal valid body", () => {
    const r = validateBody({ childId: "abc", detectedLabel: "apple" });
    expect(r.valid).toBe(true);
  });

  test("rejects empty string childId (truthy check)", () => {
    const r = validateBody({ childId: "", detectedLabel: "apple" });
    expect(r.valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. extractIp — header fallback chain
// ═══════════════════════════════════════════════════════════════════════════════

describe("extractIp", () => {
  test("uses x-forwarded-for first (taking the first comma-separated entry)", () => {
    const h = new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
    expect(extractIp(h)).toBe("1.2.3.4");
  });

  test("trims whitespace from the first entry", () => {
    const h = new Headers({ "x-forwarded-for": "  1.2.3.4  ,  5.6.7.8" });
    expect(extractIp(h)).toBe("1.2.3.4");
  });

  test("falls back to cf-connecting-ip when x-forwarded-for is absent", () => {
    const h = new Headers({ "cf-connecting-ip": "9.9.9.9" });
    expect(extractIp(h)).toBe("9.9.9.9");
  });

  test("falls back to 'unknown' when no headers present", () => {
    const h = new Headers();
    expect(extractIp(h)).toBe("unknown");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. jsonResponse
// ═══════════════════════════════════════════════════════════════════════════════

describe("jsonResponse", () => {
  test("default status is 200", () => {
    const r = jsonResponse({ ok: true });
    expect(r.status).toBe(200);
  });

  test("sets Content-Type: application/json", () => {
    const r = jsonResponse({ ok: true });
    expect(r.headers.get("Content-Type")).toBe("application/json");
  });

  test("includes CORS_HEADERS", () => {
    const r = jsonResponse({ ok: true });
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(r.headers.get("Access-Control-Allow-Headers")).toBe(CORS_HEADERS["Access-Control-Allow-Headers"]);
  });

  test("custom status (e.g. 429) is propagated", () => {
    const r = jsonResponse({ error: "too many" }, 429);
    expect(r.status).toBe(429);
  });

  test("body is JSON-encoded", async () => {
    const r = jsonResponse({ a: 1, b: "two" });
    const body = await r.text();
    expect(JSON.parse(body)).toEqual({ a: 1, b: "two" });
  });
});
