/**
 * evaluateHandler.test.ts
 * Chunk 2 — evaluate Edge Function pure helpers
 *
 * v4.7 changes:
 *   • buildCacheKey suite rewritten for 3-arg signature + env prefix
 *   • Added cross-environment isolation tests
 *   • Added plural normalisation tests
 *   • Added _resetEnvNameForTests usage
 *
 * Coverage:
 *   1. buildCacheKey         — env prefix, normalisation, determinism, plurals
 *   2. utcMidnight           — always future, always midnight UTC
 *   3. hashIp                — deterministic, salt-respecting, fixed-length
 *   4. isValidCacheShape     — production cache-corruption guard
 *   5. extractXpRates        — DB rate override, fallback to constants
 *   6. 429 response shapes   — IP_LIMIT and DAILY_QUOTA bodies
 *   7. checkIpRateLimit      — fresh window, in-window, over-limit, exact boundary
 *   8. shouldCheckCache      — skip on retry
 *   9. validateBody          — required fields
 *  10. extractIp             — x-forwarded-for, cf-connecting-ip, fallback
 *  11. jsonResponse          — CORS headers, content-type, status code
 */

import {
  buildCacheKey,
  _resetEnvNameForTests,
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
// 1. buildCacheKey (v4.7)
// ═══════════════════════════════════════════════════════════════════════════════

describe("buildCacheKey (v4.7)", () => {
  beforeEach(() => {
    delete process.env.CACHE_ENV_NAMESPACE;
    _resetEnvNameForTests();
  });

  // ─── Format / shape ─────────────────────────────────────────────────────────

  test("starts with the env-prefixed namespace", () => {
    expect(buildCacheKey("apple", "quest-1", [])).toMatch(/^default:lexi:eval:/);
  });

  test("uses the configured CACHE_ENV_NAMESPACE", () => {
    process.env.CACHE_ENV_NAMESPACE = "prod";
    _resetEnvNameForTests();
    expect(buildCacheKey("apple", "quest-1", [])).toMatch(/^prod:lexi:eval:/);

    process.env.CACHE_ENV_NAMESPACE = "staging";
    _resetEnvNameForTests();
    expect(buildCacheKey("apple", "quest-1", [])).toMatch(/^staging:lexi:eval:/);
  });

  test("falls back to 'default' for invalid namespace values", () => {
    for (const bad of ["", "   ", "PROD ENV", "stag/ing", "x;y"]) {
      process.env.CACHE_ENV_NAMESPACE = bad;
      _resetEnvNameForTests();
      expect(buildCacheKey("a", "q", [])).toMatch(/^default:lexi:eval:/);
    }
  });

  test("namespace is normalised to lowercase", () => {
    process.env.CACHE_ENV_NAMESPACE = "PROD";
    _resetEnvNameForTests();
    expect(buildCacheKey("apple", "q1", [])).toMatch(/^prod:lexi:eval:/);
  });

  // ─── Cross-environment isolation (the whole point of v4.7) ──────────────────

  test("staging and prod yield different keys for identical inputs", () => {
    process.env.CACHE_ENV_NAMESPACE = "staging";
    _resetEnvNameForTests();
    const stagingKey = buildCacheKey("ring", "quest-uuid-A", ["shiny", "metallic"]);

    process.env.CACHE_ENV_NAMESPACE = "prod";
    _resetEnvNameForTests();
    const prodKey = buildCacheKey("ring", "quest-uuid-A", ["shiny", "metallic"]);

    expect(stagingKey).not.toBe(prodKey);
    expect(stagingKey).toMatch(/^staging:/);
    expect(prodKey).toMatch(/^prod:/);
  });

  // ─── Determinism ────────────────────────────────────────────────────────────

  test("is deterministic for identical input within the same env", () => {
    expect(
      buildCacheKey("apple", "quest-1", ["red"])
    ).toBe(
      buildCacheKey("apple", "quest-1", ["red"])
    );
  });

  test("pendingWords order does not affect the key", () => {
    expect(
      buildCacheKey("ring", "q1", ["shiny", "metallic", "round"])
    ).toBe(
      buildCacheKey("ring", "q1", ["round", "shiny", "metallic"])
    );
  });

  test("pendingWords case does not affect the key", () => {
    expect(
      buildCacheKey("ring", "q1", ["Shiny", "METALLIC"])
    ).toBe(
      buildCacheKey("ring", "q1", ["shiny", "metallic"])
    );
  });

  // ─── Label normalisation ────────────────────────────────────────────────────

  test("label is case-insensitive and trimmed", () => {
    expect(buildCacheKey("APPLE", "q1", [])).toBe(buildCacheKey("apple", "q1", []));
    expect(buildCacheKey("  apple  ", "q1", [])).toBe(buildCacheKey("apple", "q1", []));
  });

  test("internal whitespace in label is collapsed", () => {
    expect(
      buildCacheKey("Gold   Ring", "q1", [])
    ).toBe(
      buildCacheKey("gold ring", "q1", [])
    );
  });

  test("simple English plurals collapse to singular", () => {
    expect(buildCacheKey("rings", "q1", [])).toBe(buildCacheKey("ring", "q1", []));
    expect(buildCacheKey("books", "q1", [])).toBe(buildCacheKey("book", "q1", []));
  });

  test("ss-final words preserve the final s (not pluralised)", () => {
    expect(buildCacheKey("glass", "q1", [])).not.toBe(buildCacheKey("glasses", "q1", []));
  });

  test("e+s endings preserve the s (avoid wrong-collapse)", () => {
    expect(buildCacheKey("phones", "q1", [])).not.toBe(buildCacheKey("phone", "q1", []));
  });

  // ─── Quest ID and pending words contribute to the key ──────────────────────

  test("different questId yields different key", () => {
    expect(buildCacheKey("apple", "q1", []))
      .not.toBe(buildCacheKey("apple", "q2", []));
  });

  test("different pendingWords yield different keys", () => {
    expect(buildCacheKey("apple", "q1", ["red"]))
      .not.toBe(buildCacheKey("apple", "q1", ["green"]));
  });

  test("empty pendingWords array is handled cleanly", () => {
    expect(() => buildCacheKey("apple", "q1", [])).not.toThrow();
    expect(buildCacheKey("apple", "q1", [])).toMatch(/^default:lexi:eval:/);
  });

  test("pendingWords parameter defaults to empty array", () => {
    // 2-arg call should work via the default parameter
    expect(buildCacheKey("apple", "q1")).toBe(buildCacheKey("apple", "q1", []));
  });

  // ─── Base64 padding ─────────────────────────────────────────────────────────

  test("does not contain '=' padding characters", () => {
    expect(buildCacheKey("a",      "b",  []                )).not.toMatch(/=/);
    expect(buildCacheKey("ab",     "c",  ["x"]             )).not.toMatch(/=/);
    expect(buildCacheKey("apple",  "q1", ["red", "shiny"]  )).not.toMatch(/=/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. utcMidnight
// ═══════════════════════════════════════════════════════════════════════════════

describe("utcMidnight", () => {
  test("returns ISO 8601 UTC string", () => {
    expect(utcMidnight()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("is always in the future", () => {
    expect(new Date(utcMidnight()).getTime()).toBeGreaterThan(Date.now());
  });

  test("is at midnight UTC (next day)", () => {
    const m = new Date(utcMidnight());
    expect(m.getUTCHours()).toBe(0);
    expect(m.getUTCMinutes()).toBe(0);
    expect(m.getUTCSeconds()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. hashIp
// ═══════════════════════════════════════════════════════════════════════════════

describe("hashIp", () => {
  test("returns 16 hex characters", async () => {
    const h = await hashIp("1.2.3.4");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  test("is deterministic for the same IP and salt", async () => {
    expect(await hashIp("1.2.3.4")).toBe(await hashIp("1.2.3.4"));
  });

  test("different IPs hash to different values", async () => {
    expect(await hashIp("1.2.3.4")).not.toBe(await hashIp("1.2.3.5"));
  });

  test("different salt yields different hash", async () => {
    const oldSalt = process.env.IP_HASH_SALT;
    process.env.IP_HASH_SALT = "test-salt-A";
    const before = await hashIp("1.2.3.4");
    process.env.IP_HASH_SALT = "test-salt-B";
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
    expect(isValidCacheShape({ value: '{"resolvedObjectName":"apple"}', ex: 604800 })).toBe(false);
  });

  test("rejects entries missing required fields", () => {
    expect(isValidCacheShape({ resolvedObjectName: "apple" })).toBe(false);
    expect(isValidCacheShape({ properties: [] })).toBe(false);
    expect(isValidCacheShape({
      resolvedObjectName: "apple",
      properties:         [],
      // missing childFeedback
    })).toBe(false);
  });

  test("rejects when properties is not an array", () => {
    expect(isValidCacheShape({
      resolvedObjectName: "apple",
      properties:         "not an array",
      childFeedback:      "ok",
    })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. extractXpRates
// ═══════════════════════════════════════════════════════════════════════════════

describe("extractXpRates", () => {
  test("uses DB-provided rates when present", () => {
    expect(extractXpRates({
      xp_reward_first_try:  50,
      xp_reward_retry:      30,
      xp_reward_third_plus: 15,
    })).toEqual({ firstTry: 50, secondTry: 30, thirdPlus: 15 });
  });

  test("falls back to constants when fields are missing", () => {
    expect(extractXpRates({})).toEqual({ firstTry: 40, secondTry: 25, thirdPlus: 10 });
  });

  test("falls back when fields are non-numeric", () => {
    expect(extractXpRates({
      xp_reward_first_try:  "fifty",
      xp_reward_retry:      null,
      xp_reward_third_plus: undefined,
    })).toEqual({ firstTry: 40, secondTry: 25, thirdPlus: 10 });
  });

  test("partial override — some fields use DB, others fall back", () => {
    expect(extractXpRates({
      xp_reward_first_try: 100,
    })).toEqual({ firstTry: 100, secondTry: 25, thirdPlus: 10 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. 429 response shapes
// ═══════════════════════════════════════════════════════════════════════════════

describe("429 response builders", () => {
  test("IP_LIMIT body has expected shape", () => {
    const body = buildIpLimitResponseBody();
    expect(body).toMatchObject({
      error:      "rate_limit_exceeded",
      code:       "IP_LIMIT",
      retryAfter: 60,
    });
    expect(typeof body.message).toBe("string");
  });

  test("DAILY_QUOTA body has expected shape and limits", () => {
    const body = buildDailyQuotaResponseBody(45);
    expect(body).toMatchObject({
      error:      "rate_limit_exceeded",
      code:       "DAILY_QUOTA",
      scansToday: 45,
      limit:      DAILY_SCAN_LIMIT,
    });
    expect(typeof body.message).toBe("string");
    expect(body.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. checkIpRateLimit
// ═══════════════════════════════════════════════════════════════════════════════

describe("checkIpRateLimit", () => {
  // Build a Supabase client stub.
  function buildStub(initialRow: { request_count: number; window_start: string } | null) {
    let row = initialRow;
    return {
      from: (_: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: row }),
          }),
        }),
        upsert: async (newRow: any) => {
          row = { request_count: newRow.request_count, window_start: newRow.window_start };
          return { data: null };
        },
        update: (patch: any) => ({
          eq: async () => {
            if (row) row = { ...row, ...patch };
            return { data: null };
          },
        }),
      }),
    };
  }

  test("fresh request (no row) → allowed, count=1", async () => {
    const stub = buildStub(null);
    const r = await checkIpRateLimit(stub, "abc123");
    expect(r).toEqual({ allowed: true, requestCount: 1 });
  });

  test("expired window → resets to count=1", async () => {
    const stub = buildStub({
      request_count: 99,
      window_start:  new Date(Date.now() - IP_WINDOW_MS - 1000).toISOString(),
    });
    const r = await checkIpRateLimit(stub, "abc123");
    expect(r).toEqual({ allowed: true, requestCount: 1 });
  });

  test("in-window, under limit → allowed, count incremented", async () => {
    const stub = buildStub({
      request_count: 5,
      window_start:  new Date().toISOString(),
    });
    const r = await checkIpRateLimit(stub, "abc123");
    expect(r).toEqual({ allowed: true, requestCount: 6 });
  });

  test("at exact limit → still allowed (boundary)", async () => {
    const stub = buildStub({
      request_count: IP_LIMIT_PER_MINUTE - 1,
      window_start:  new Date().toISOString(),
    });
    const r = await checkIpRateLimit(stub, "abc123");
    expect(r.allowed).toBe(true);
    expect(r.requestCount).toBe(IP_LIMIT_PER_MINUTE);
  });

  test("over limit → blocked", async () => {
    const stub = buildStub({
      request_count: IP_LIMIT_PER_MINUTE,
      window_start:  new Date().toISOString(),
    });
    const r = await checkIpRateLimit(stub, "abc123");
    expect(r.allowed).toBe(false);
    expect(r.requestCount).toBe(IP_LIMIT_PER_MINUTE + 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. shouldCheckCache
// ═══════════════════════════════════════════════════════════════════════════════

describe("shouldCheckCache", () => {
  test("first attempt → check cache", () => {
    expect(shouldCheckCache(0)).toBe(true);
  });

  test("retry attempts → skip cache", () => {
    expect(shouldCheckCache(1)).toBe(false);
    expect(shouldCheckCache(2)).toBe(false);
    expect(shouldCheckCache(99)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. validateBody
// ═══════════════════════════════════════════════════════════════════════════════

describe("validateBody", () => {
  const fullBody = {
    childId:       "c1",
    imageBase64:   "x",
    currentWord:   "shiny",
    questId:       "q1",
    detectedLabel: "ring",
  };

  test("accepts a complete body", () => {
    expect(validateBody(fullBody)).toEqual({ valid: true, missing: [] });
  });

  test("flags missing fields", () => {
    expect(validateBody({})).toEqual({
      valid: false,
      missing: ["childId", "imageBase64", "currentWord", "questId", "detectedLabel"],
    });
  });

  test("treats null/undefined as missing", () => {
    const r = validateBody({ ...fullBody, questId: null });
    expect(r.valid).toBe(false);
    expect(r.missing).toEqual(["questId"]);
  });

  test("preserves extra fields without flagging them", () => {
    const r = validateBody({ ...fullBody, extraFlag: "ok" });
    expect(r.valid).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. extractIp
// ═══════════════════════════════════════════════════════════════════════════════

describe("extractIp", () => {
  test("uses x-forwarded-for first hop", () => {
    expect(extractIp({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" })).toBe("1.2.3.4");
  });

  test("falls back to cf-connecting-ip if XFF missing", () => {
    expect(extractIp({ "cf-connecting-ip": "9.9.9.9" })).toBe("9.9.9.9");
  });

  test("returns 'unknown' if both headers missing", () => {
    expect(extractIp({})).toBe("unknown");
  });

  test("works with Headers instance", () => {
    const h = new Headers();
    h.set("x-forwarded-for", "10.0.0.1, 11.0.0.1");
    expect(extractIp(h)).toBe("10.0.0.1");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. jsonResponse
// ═══════════════════════════════════════════════════════════════════════════════

describe("jsonResponse", () => {
  test("status defaults to 200", () => {
    const r = jsonResponse({ ok: true });
    expect(r.status).toBe(200);
  });

  test("custom status is preserved", () => {
    const r = jsonResponse({ error: "x" }, 429);
    expect(r.status).toBe(429);
  });

  test("includes CORS headers", () => {
    const r = jsonResponse({});
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe(CORS_HEADERS["Access-Control-Allow-Origin"]);
    expect(r.headers.get("Access-Control-Allow-Headers")).toBe(CORS_HEADERS["Access-Control-Allow-Headers"]);
  });

  test("Content-Type is application/json", () => {
    const r = jsonResponse({});
    expect(r.headers.get("Content-Type")).toBe("application/json");
  });

  test("body is JSON-serialised", async () => {
    const r = jsonResponse({ a: 1, b: "two" });
    expect(await r.text()).toBe('{"a":1,"b":"two"}');
  });
});
