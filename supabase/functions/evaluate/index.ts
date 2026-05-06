/**
 * supabase/functions/evaluate/index.ts
 * Lexi-Lens — Supabase Edge Function entry point.
 *
 * v4.5 update (this file): cache_hit observability
 *   • Cache hits now write a lightweight row to scan_attempts with
 *     cache_hit=true and claude_latency_ms=null. Previously cache hits were
 *     invisible to product analytics — we couldn't measure hit rate, couldn't
 *     correlate cache effectiveness to retention, and the SQL queries we
 *     wrote against claude_latency_ms returned only Claude-call rows by
 *     accident.
 *   • The Claude-success path now sets cache_hit=false explicitly (was
 *     relying on the column DEFAULT — fine, but explicit is cheaper to
 *     read).
 *   • Cache-hit responses now include _rateLimit so the client UI's
 *     scansToday counter stays consistent (cache hits don't increment it,
 *     but the client should see a fresh value rather than a stale one).
 *   • REQUIRED COMPANION MIGRATION: 20260506_add_cache_hit_observability.sql
 *     adds the cache_hit column AND updates get_daily_scan_count to exclude
 *     cache_hit=true rows so re-scans don't burn quota slots. Deploy the
 *     migration BEFORE this file.
 *
 * v4.4 fix: iOS cross-scan property bleed
 *   • Symptom: scanning a matchstick on iOS returned a cached "gold ring"
 *     verdict from a previous scan — instant (<200 ms), wrong identification.
 *   • Cause: useObjectScanner.ts iOS path falls back to detectedLabel="object"
 *     because there is no ML Kit on iOS. Cache key = (label, questId,
 *     pendingWords) — so within any (questId, pendingWords) tuple, every
 *     distinct physical object scanned on iOS produces the IDENTICAL cache
 *     key. Cache hit returns whatever was last stored for that key.
 *   • Fix: skip cache GET (Section 4) and SET (Section 7) when detectedLabel
 *     is too generic to distinguish physical objects. Android scans (real
 *     ML Kit labels) are unaffected.
 *
 * Phase 3.5 — Rate Limiting + Abuse Prevention:
 *   • IP-level rate limit: max 20 requests/IP/minute (brute-force shield)
 *   • Daily child quota: max 50 Claude calls/child/day (get_daily_scan_count RPC)
 *   • All calls logged to scan_attempts (existing table — real column names)
 *   • Parent alert flag in response when child hits 80% / 100% of daily quota
 *   • HTTP 429 with structured body for quota + IP limit errors
 *
 * Phase 3.4 — Redis Response Caching:
 *   • Cache check/set via Upstash Redis (key = hash(label+questId), TTL 7d)
 *
 * scan_attempts columns used here:
 *   child_id, quest_id, detected_label, vision_confidence,
 *   resolved_name, overall_match, property_scores, child_feedback,
 *   xp_awarded, claude_latency_ms, ip_hash, rate_limited, cache_hit
 *
 * Execution order:
 *   1. CORS preflight + body parse
 *   2. IP rate limit check  (ip_rate_limits table, 20 req/min)
 *   3. Daily quota check    (get_daily_scan_count RPC, 50/day)
 *   4. Redis cache check    (skipped for generic labels — iOS bleed fix)
 *                           ↪ on hit: log cache row, return with _rateLimit
 *   5. Claude evaluation
 *   6. INSERT scan_attempts (cache_hit=false)
 *   7. Cache the successful result (cacheSet)
 *   8. Return result + alert flags
 */

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { evaluateObject } from "./evaluateObject.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const DAILY_SCAN_LIMIT    = 50;
const ALERT_THRESHOLD_PCT = 0.80;   // 80% → warn parent
const IP_LIMIT_PER_MINUTE = 20;
const IP_WINDOW_MS        = 60_000;

// v4.4 — labels too generic to safely identify a physical object.
// On iOS there is no ML Kit, so detectedLabel is always one of these.
// Caching against these labels causes cross-scan bleed — see Section 4.
const GENERIC_LABELS = new Set(["", "object", "unknown", "thing", "item"]);

// ─── Redis helpers (Upstash — Phase 3.4) ─────────────────────────────────────

const REDIS_URL   = Deno.env.get("UPSTASH_REDIS_REST_URL")   ?? "";
const REDIS_TOKEN = Deno.env.get("UPSTASH_REDIS_REST_TOKEN") ?? "";
const CACHE_TTL_S = 7 * 24 * 60 * 60; // 7 days

async function cacheGet(key: string): Promise<unknown | null> {
  if (!REDIS_URL) return null;
  try {
    const res  = await fetch(`${REDIS_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    const json = await res.json();
    if (!json.result) return null;

    const parsed = JSON.parse(json.result);

    // Shape validation — guard against old broken-format cache entries.
    //
    // The previous cacheSet sent { value: JSON.stringify(result), ex: TTL }
    // as a JSON object body to POST /set/{key}. Upstash stored that entire
    // object as the Redis string value. cacheGet then returned:
    //   { value: "{...}", ex: 604800 }
    // — an object with no resolvedObjectName / properties / childFeedback.
    // VerdictCard spread it, got blank fields, rendered an empty card
    // with only "Almost..." and the ⚡ Instant badge visible.
    //
    // Fix: require the three fields that every valid EvaluationResult must
    // have. Any entry missing them (old format, corruption, schema change)
    // is treated as a cache miss — Claude runs fresh and stores correctly.
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.resolvedObjectName !== "string" ||
      !Array.isArray(parsed.properties) ||
      typeof parsed.childFeedback !== "string"
    ) {
      console.warn("[cacheGet] Stale/invalid cache entry — treating as miss");
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

async function cacheSet(key: string, value: unknown): Promise<void> {
  if (!REDIS_URL) return;
  // BUG FIX: previous implementation sent { value, ex } as a JSON object in the
  // body to POST /set/{key} — that is NOT the Upstash REST API format.
  // Upstash expects a Redis command array sent to the base URL:
  //   POST {REDIS_URL}
  //   Body: ["SET", "key", "serialized_value", "EX", ttl_seconds]
  // The previous format was silently accepted (HTTP 200) but stored nothing,
  // so every subsequent GET returned null and the cache never hit.
  try {
    await fetch(REDIS_URL, {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["SET", key, JSON.stringify(value), "EX", CACHE_TTL_S]),
    });
  } catch { /* non-fatal */ }
}

function buildCacheKey(
  detectedLabel: string,
  questId:       string,
  pendingWords:  string[]
): string {
  // FIX (Boredom Behemoth chip-stuck-grey): pending property words are
  // part of the cache key so a first-attempt cache hit never returns a
  // response shaped for a different pending set.
  //
  // Without this: scan 1 evaluated [a,b,c] and cached. Later scan with
  // pending=[b,c] would cache-hit and return [a,b,c]'s response — Claude's
  // verdict feedback then references properties no longer in the chip
  // strip, causing the "all 3 available but chips greyed out" mismatch.
  const sortedWords = [...pendingWords].map((w) => w.toLowerCase().trim()).sort().join(",");
  const raw = `${detectedLabel.toLowerCase().trim()}::${questId}::${sortedWords}`;
  return `lexi:eval:${btoa(raw).replace(/=/g, "")}`;
}

// ─── IP rate limit ────────────────────────────────────────────────────────────

async function hashIp(ip: string): Promise<string> {
  const encoded = new TextEncoder().encode(
    ip + (Deno.env.get("IP_HASH_SALT") ?? "lexi-lens")
  );
  const buf = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

async function checkIpRateLimit(
  supabase: ReturnType<typeof createClient>,
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

// ─── scan_attempts loggers ────────────────────────────────────────────────────
//
// Three writers, three semantics:
//   logScanBlocked   — call was blocked before Claude ran (rate limit / error)
//   logScanResult    — Claude ran and returned a full evaluation (cache_hit=false)
//   logScanCacheHit  — served from Redis cache (cache_hit=true, no Claude)
//
// Column mapping against scan_attempts schema:
//   child_id          ← childId
//   quest_id          ← questId
//   detected_label    ← detectedLabel
//   vision_confidence ← confidence
//   ip_hash           ← ipHash             (Phase 3.5)
//   rate_limited      ← isRateLimited      (Phase 3.5)
//   resolved_name     ← result.resolvedObjectName
//   overall_match     ← result.overallMatch
//   property_scores   ← result.properties  (jsonb)
//   child_feedback    ← result.childFeedback
//   xp_awarded        ← result.xpAwarded
//   claude_latency_ms ← claudeLatencyMs    (null on cache hit)
//   cache_hit         ← cacheHit           (v4.5 — observability)

async function logScanBlocked(
  supabase: ReturnType<typeof createClient>,
  opts: {
    childId:       string;
    questId?:      string;
    detectedLabel: string;
    confidence?:   number;
    ipHash?:       string;
    isRateLimited: boolean;
  }
) {
  try {
    await supabase.from("scan_attempts").insert({
      child_id:          opts.childId,
      quest_id:          opts.questId       ?? null,
      detected_label:    opts.detectedLabel,
      vision_confidence: opts.confidence    ?? null,
      ip_hash:           opts.ipHash        ?? null,
      rate_limited:      opts.isRateLimited,
      xp_awarded:        0,
      cache_hit:         false,
    });
  } catch (e) {
    console.error("[evaluate] logScanBlocked INSERT failed:", e);
  }
}

async function logScanResult(
  supabase: ReturnType<typeof createClient>,
  opts: {
    childId:         string;
    questId?:        string;
    detectedLabel:   string;
    confidence?:     number;
    ipHash?:         string;
    claudeLatencyMs: number;
    result:          Awaited<ReturnType<typeof evaluateObject>>;
  }
) {
  try {
    await supabase.from("scan_attempts").insert({
      child_id:          opts.childId,
      quest_id:          opts.questId        ?? null,
      detected_label:    opts.detectedLabel,
      vision_confidence: opts.confidence     ?? null,
      ip_hash:           opts.ipHash         ?? null,
      rate_limited:      false,
      resolved_name:     opts.result.resolvedObjectName,
      overall_match:     opts.result.overallMatch,
      property_scores:   opts.result.properties,
      child_feedback:    opts.result.childFeedback,
      xp_awarded:        opts.result.xpAwarded,
      claude_latency_ms: opts.claudeLatencyMs,
      cache_hit:         false,
    });
  } catch (e) {
    console.error("[evaluate] logScanResult INSERT failed:", e);
  }
}

// v4.5 — NEW: log a row for a Redis cache hit so we can measure hit rate
// from data instead of inferring from latency. claude_latency_ms is left
// null deliberately — that's the unambiguous "no Claude call" signal.
//
// IMPORTANT: companion migration updates get_daily_scan_count to exclude
// cache_hit=true rows, so this insert does NOT cause re-scans to burn
// quota. Deploy the migration before this file.
interface CachedEvaluation {
  resolvedObjectName: string;
  properties:         unknown;
  overallMatch:       boolean;
  childFeedback:      string;
  xpAwarded:          number;
}

async function logScanCacheHit(
  supabase: ReturnType<typeof createClient>,
  opts: {
    childId:       string;
    questId?:      string;
    detectedLabel: string;
    confidence?:   number;
    ipHash?:       string;
    cachedResult:  CachedEvaluation;
  }
) {
  try {
    await supabase.from("scan_attempts").insert({
      child_id:          opts.childId,
      quest_id:          opts.questId        ?? null,
      detected_label:    opts.detectedLabel,
      vision_confidence: opts.confidence     ?? null,
      ip_hash:           opts.ipHash         ?? null,
      rate_limited:      false,
      resolved_name:     opts.cachedResult.resolvedObjectName,
      overall_match:     opts.cachedResult.overallMatch,
      property_scores:   opts.cachedResult.properties,
      child_feedback:    opts.cachedResult.childFeedback,
      xp_awarded:        opts.cachedResult.xpAwarded,
      claude_latency_ms: null,   // signal: no Claude call
      cache_hit:         true,
    });
  } catch (e) {
    console.error("[evaluate] logScanCacheHit INSERT failed:", e);
  }
}

// ─── Response helpers ─────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function utcMidnight(): string {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

// Helper — alert flags shape used by both the cache-hit and Claude-call
// response paths. Extracted so the two paths produce identical _rateLimit
// envelopes; the only difference is the scansToday value (cache hits don't
// increment, Claude calls do).
function buildAlertFlags(scansToday: number) {
  return {
    scansToday,
    dailyLimit:       DAILY_SCAN_LIMIT,
    approachingLimit: scansToday >= Math.floor(DAILY_SCAN_LIMIT * ALERT_THRESHOLD_PCT),
    limitReached:     scansToday >= DAILY_SCAN_LIMIT,
  };
}

// ─── Main handler ─────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  // ── 1. Parse + validate ───────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const {
    childId,
    questId,
    questName,
    detectedLabel,
    confidence,
    frameBase64,
    requiredProperties,
    childAge,
    failedAttempts,
    masteryProfile,
    alreadyFoundWords,
    // XP FIX: per-quest XP rates sent by useLexiEvaluate from the quest DB row
    xp_reward_first_try,
    xp_reward_retry,
    xp_reward_third_plus,
  } = body as Record<string, unknown>;

  // Build xpRates — use quest DB values so awarded XP matches what the card shows.
  const xpRates = {
    firstTry:  typeof xp_reward_first_try  === "number" ? xp_reward_first_try  : 40,
    secondTry: typeof xp_reward_retry      === "number" ? xp_reward_retry      : 25,
    thirdPlus: typeof xp_reward_third_plus === "number" ? xp_reward_third_plus : 10,
  };

  if (!childId || typeof childId !== "string") {
    return jsonResponse({ error: "childId is required" }, 400);
  }
  if (!detectedLabel || typeof detectedLabel !== "string") {
    return jsonResponse({ error: "detectedLabel is required" }, 400);
  }

  // ── 2. IP rate limit ──────────────────────────────────────────────────────
  const rawIp  = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
              ?? req.headers.get("cf-connecting-ip")
              ?? "unknown";
  const ipHash = await hashIp(rawIp);

  const { allowed: ipAllowed, requestCount: ipCount } =
    await checkIpRateLimit(supabase, ipHash);

  if (!ipAllowed) {
    console.warn(`[evaluate] IP limit hit: hash=${ipHash} count=${ipCount}`);
    await logScanBlocked(supabase, {
      childId,
      questId:       questId as string | undefined,
      detectedLabel: detectedLabel as string,
      confidence:    confidence as number | undefined,
      ipHash,
      isRateLimited: true,
    });
    return jsonResponse(
      {
        error:      "rate_limit_exceeded",
        code:       "IP_LIMIT",
        message:    "Too many requests. Please wait a moment before scanning again.",
        retryAfter: 60,
      },
      429
    );
  }

  // ── 3. Daily child quota ──────────────────────────────────────────────────
  const { data: scanCount, error: rpcError } = await supabase.rpc(
    "get_daily_scan_count",
    { p_child_id: childId }
  );

  if (rpcError) {
    // Fail open — let the scan through rather than blocking on a DB hiccup
    console.error("[evaluate] get_daily_scan_count RPC error:", rpcError);
  }

  const scansToday = (scanCount as number | null) ?? 0;

  if (scansToday >= DAILY_SCAN_LIMIT) {
    console.warn(`[evaluate] Daily quota exceeded: childId=${childId} scans=${scansToday}`);
    await logScanBlocked(supabase, {
      childId,
      questId:       questId as string | undefined,
      detectedLabel: detectedLabel as string,
      confidence:    confidence as number | undefined,
      ipHash,
      isRateLimited: true,
    });
    return jsonResponse(
      {
        error:      "rate_limit_exceeded",
        code:       "DAILY_QUOTA",
        scansToday,
        limit:      DAILY_SCAN_LIMIT,
        resetsAt:   utcMidnight(),
        message:    "Daily scan limit reached. Come back tomorrow, brave adventurer!",
      },
      429
    );
  }

  // ── 4. Redis cache check ──────────────────────────────────────────────────
  // Pending words from this scan are baked into the cache key — see
  // buildCacheKey for the rationale.
  //
  // iOS BLEED FIX (v4.4): on iOS there is no ML Kit, so detectedLabel is
  // always the constant fallback "object" (see useObjectScanner.ts iOS path).
  // Within the same (questId, pendingWords) tuple, every distinct physical
  // object scanned on iOS would otherwise produce the SAME cache key — so a
  // cache hit returns whatever was last cached for that key, regardless of
  // what the camera is actually pointing at.
  //
  // Fix: skip cache GET (and SET — see Section 7 below) entirely when
  // detectedLabel is too generic to distinguish physical objects. Android
  // scans (real ML Kit labels) still cache normally.
  const labelTrimmed   = ((detectedLabel as string) ?? "").toLowerCase().trim();
  const isGenericLabel = GENERIC_LABELS.has(labelTrimmed);

  const pendingWords = Array.isArray(requiredProperties)
    ? (requiredProperties as Array<{ word?: unknown }>)
        .map((p) => (typeof p?.word === "string" ? p.word : ""))
        .filter((w) => w.length > 0)
    : [];
  const cacheKey         = buildCacheKey(detectedLabel as string, (questId as string) ?? "", pendingWords);
  const shouldCheckCache = !isGenericLabel && (failedAttempts as number ?? 0) === 0;
  const cachedResult     = shouldCheckCache ? await cacheGet(cacheKey) : null;

  if (isGenericLabel) {
    // Observable signal — bypassing cache for an iOS-pattern scan. Useful in
    // Edge Function logs to confirm the fix is firing on the expected platform
    // mix. Should appear once per iOS scan, never on Android.
    console.log(`[evaluate] Skipping cache (generic label="${labelTrimmed}"): childId=${childId} questId=${questId ?? "n/a"}`);
  }

  if (cachedResult) {
    // v4.5: log the cache hit so it's visible to product analytics.
    // claude_latency_ms is null (no Claude call); cache_hit is true.
    // The companion migration's RPC update ensures this row does NOT
    // count toward the daily 50/child quota.
    const cached = cachedResult as CachedEvaluation;
    await logScanCacheHit(supabase, {
      childId,
      questId:       questId as string | undefined,
      detectedLabel: detectedLabel as string,
      confidence:    confidence as number | undefined,
      ipHash,
      cachedResult:  cached,
    });

    // scansToday is unchanged on cache hit (cache hits don't burn quota).
    // Including _rateLimit on the response keeps the client UI in sync —
    // it won't show stale "scans today" numbers while the user is mid-quest.
    return jsonResponse({
      ...(cachedResult as object),
      _cacheHit:  true,
      _rateLimit: buildAlertFlags(scansToday),
    });
  }

  // ── 5. Call Claude ────────────────────────────────────────────────────────
  const claudeStart = Date.now();
  let evaluationResult: Awaited<ReturnType<typeof evaluateObject>>;

  try {
    evaluationResult = await evaluateObject({
      detectedLabel:      detectedLabel as string,
      confidence:         confidence as number,
      frameBase64:        frameBase64 as string | null | undefined,
      requiredProperties: requiredProperties as Parameters<typeof evaluateObject>[0]["requiredProperties"],
      childAge:           childAge as number,
      failedAttempts:     failedAttempts as number | undefined,
      questName:          questName as string | undefined,
      masteryProfile:     masteryProfile as Parameters<typeof evaluateObject>[0]["masteryProfile"],
      // FIX: alreadyFoundWords was being received but never forwarded —
      // Claude couldn't acknowledge prior progress in feedback, which made
      // multi-scan verdicts feel disconnected from earlier wins.
      alreadyFoundWords:  Array.isArray(alreadyFoundWords)
        ? (alreadyFoundWords as unknown[]).filter((w): w is string => typeof w === "string")
        : [],
      xpRates,   // XP FIX: pass per-quest rates through to evaluateObject
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Evaluation failed";
    await logScanBlocked(supabase, {
      childId,
      questId:       questId as string | undefined,
      detectedLabel: detectedLabel as string,
      confidence:    confidence as number | undefined,
      ipHash,
      isRateLimited: false, // Claude errored — not a rate limit
    });
    return jsonResponse({ error: msg }, 500);
  }

  // ── 6. Log full result to scan_attempts (cache_hit=false) ─────────────────
  await logScanResult(supabase, {
    childId,
    questId:         questId as string | undefined,
    detectedLabel:   detectedLabel as string,
    confidence:      confidence as number | undefined,
    ipHash,
    claudeLatencyMs: Date.now() - claudeStart,
    result:          evaluationResult,
  });

  // ── 7. Cache successful result ────────────────────────────────────────────
  // iOS BLEED FIX (v4.4): same guard as Section 4 — never write a cache entry
  // that uses a generic label as part of its key. If we did, a future call
  // for a DIFFERENT physical object that happens to share (questId, pendingWords)
  // would hit this entry and get back the wrong object's verdict. Better to
  // recompute every iOS scan than to seed permanent cache pollution.
  if (!isGenericLabel && (failedAttempts as number | undefined ?? 0) === 0) {
    await cacheSet(cacheKey, { ...evaluationResult, _cacheHit: false });
  }

  // ── 8. Parent alert flags + return ────────────────────────────────────────
  const newScansToday = scansToday + 1;
  return jsonResponse({
    ...evaluationResult,
    _cacheHit:  false,
    _rateLimit: buildAlertFlags(newScansToday),
  });
});
