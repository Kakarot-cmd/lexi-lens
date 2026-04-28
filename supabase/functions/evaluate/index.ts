/**
 * supabase/functions/evaluate/index.ts
 * Lexi-Lens — Supabase Edge Function entry point.
 *
 * Phase 3.5 additions — Rate Limiting + Abuse Prevention:
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
 *   xp_awarded, claude_latency_ms, ip_hash, rate_limited
 *
 * Execution order:
 *   1. CORS preflight
 *   2. Parse + validate body
 *   3. IP rate limit check  (ip_rate_limits table, 20 req/min)
 *   4. Daily quota check    (get_daily_scan_count RPC, 50/day)
 *   5. Redis cache check
 *   6. Claude evaluation
 *   7. INSERT into scan_attempts
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

function buildCacheKey(detectedLabel: string, questId: string): string {
  const raw = `${detectedLabel.toLowerCase().trim()}::${questId}`;
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

// ─── scan_attempts logger ─────────────────────────────────────────────────────
//
// logScanBlocked — call was blocked before Claude ran (rate limit or error)
// logScanResult  — Claude ran and returned a full evaluation result
//
// Column mapping against actual scan_attempts schema:
//   child_id          ← childId
//   quest_id          ← questId
//   detected_label    ← detectedLabel
//   vision_confidence ← confidence
//   ip_hash           ← ipHash          (added by Phase 3.5 migration)
//   rate_limited      ← isRateLimited   (added by Phase 3.5 migration)
//   resolved_name     ← result.resolvedObjectName
//   overall_match     ← result.overallMatch
//   property_scores   ← result.properties  (jsonb)
//   child_feedback    ← result.childFeedback
//   xp_awarded        ← result.xpAwarded
//   claude_latency_ms ← claudeLatencyMs

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
    });
  } catch (e) {
    console.error("[evaluate] logScanResult INSERT failed:", e);
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

// ─── Main handler ─────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const startMs = Date.now();

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
  } = body as Record<string, unknown>;

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
  const cacheKey     = buildCacheKey(detectedLabel as string, (questId as string) ?? "");
  const cachedResult = (failedAttempts as number ?? 0) === 0
    ? await cacheGet(cacheKey)
    : null;

  if (cachedResult) {
    console.log(`[evaluate] ⚡ Cache hit: key=${cacheKey}`);
    // Cache hits are NOT logged to scan_attempts — the original call was already
    // logged, and cache hits don't consume a Claude token or count toward quota.
    return jsonResponse({ ...(cachedResult as object), _cacheHit: true });
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

  // ── 6. Log full result to scan_attempts ───────────────────────────────────
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
  if ((failedAttempts as number | undefined ?? 0) === 0) {
    await cacheSet(cacheKey, { ...evaluationResult, _cacheHit: false });
  }

  // ── 8. Parent alert flags ─────────────────────────────────────────────────
  const newScansToday = scansToday + 1;
  const alertFlags = {
    scansToday:       newScansToday,
    dailyLimit:       DAILY_SCAN_LIMIT,
    approachingLimit: newScansToday >= Math.floor(DAILY_SCAN_LIMIT * ALERT_THRESHOLD_PCT),
    limitReached:     newScansToday >= DAILY_SCAN_LIMIT,
  };

  return jsonResponse({
    ...evaluationResult,
    _cacheHit:  false,
    _rateLimit: alertFlags,
  });
});
