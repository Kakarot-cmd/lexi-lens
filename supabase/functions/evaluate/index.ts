/**
 * supabase/functions/evaluate/index.ts
 * Lexi-Lens — Supabase Edge Function entry point.
 *
 * v5.4 — Phase 4.10b: Tier-aware Haiku→Gemini routing + quest tier validation
 *
 *   Three changes layered on the v5.2.2 base:
 *
 *   1. Per-request adapter routing (was: per-container).
 *      The adapter for this scan is chosen by pickAdapterForRequest in
 *      _shared/tierRouting.ts based on (parent_tier, today_haiku_count,
 *      tier_config.haiku_calls_per_day, global kill switch). Cache hits
 *      do NOT count toward Haiku budget. Decision logged on every miss.
 *
 *   2. Quest tier validation closing the security gap.
 *      Pre-v5.4, the Edge Function bypassed RLS via service_role and did
 *      not check the requested quest's min_subscription_tier. A free
 *      child constructing a request with a paid quest_id directly would
 *      get a model call against that quest. Now: get_evaluate_context
 *      returns quest_min_tier; the function returns 403 if the parent's
 *      tier doesn't qualify.
 *
 *   3. scan_attempts.model_id population.
 *      Every cache_hit=false row now stamps the producing model id so
 *      future Haiku-count queries (and the per-tier model split monitor
 *      query) can attribute scans correctly. Cache hits leave model_id
 *      NULL by design — they didn't consume a model call.
 *
 *   New single-round-trip RPC: get_evaluate_context(child_id, quest_id)
 *   returns scans_today, haiku_calls_today, subscription_tier,
 *   quest_min_tier, quest_exists. Replaces the v5.2.2 get_daily_scan_status
 *   call. The old RPC stays in place for safety during the deploy window.
 *
 * v5.2.2 — Tier-aware daily scan cap (Phase 4.10) — preserved
 * v5.2.1 — Per-label resolved-name cache — preserved
 * v5.2   — Per-property cache refactor — preserved
 * v5.1   — Model provider abstraction — preserved
 */

import { serve }        from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import {
  evaluateObject,
  composeResultFromCachedOnly,
  type EvaluationResult,
  type PropertyRequirement,
  type PropertyScore,
} from "./evaluateObject.ts";

import { pickAdapterForRequest } from "../_shared/tierRouting.ts";
import { getTierLimits }         from "../_shared/tierConfig.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const ALERT_THRESHOLD_PCT = 0.80;
const IP_LIMIT_PER_MINUTE = 20;
const IP_WINDOW_MS        = 60_000;

const GENERIC_LABELS = new Set(["", "object", "unknown", "thing", "item"]);

// ─── Redis / Upstash setup ───────────────────────────────────────────────────

const REDIS_URL   = Deno.env.get("UPSTASH_REDIS_REST_URL")   ?? "";
const REDIS_TOKEN = Deno.env.get("UPSTASH_REDIS_REST_TOKEN") ?? "";
const CACHE_TTL_S = 14 * 24 * 60 * 60; // 14 days, user-write path

const ENV_NAME: string = (() => {
  const fromEnv = Deno.env.get("CACHE_ENV_NAMESPACE")?.trim().toLowerCase();
  if (fromEnv && /^[a-z0-9_-]+$/.test(fromEnv)) return fromEnv;
  console.warn("[evaluate] CACHE_ENV_NAMESPACE not set or invalid — using 'default'.");
  return "default";
})();

// ─── Cache key normalisation (must match prewarm-cache.ts byte-for-byte) ─────

function normalize(s: string): string {
  return s.toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/([a-z]{2,})([^se])s\b/g, "$1$2");
}

function buildPerPropCacheKey(label: string, word: string): string {
  const raw = `${normalize(label)}::${normalize(word)}`;
  return `${ENV_NAME}:lexi:eval:prop:${btoa(raw).replace(/=/g, "")}`;
}

function buildResolvedNameCacheKey(label: string): string {
  const raw = normalize(label);
  return `${ENV_NAME}:lexi:eval:resolved:${btoa(raw).replace(/=/g, "")}`;
}

// ─── Cache GET/SET helpers ───────────────────────────────────────────────────

interface CachedPropertyScore extends PropertyScore { _modelId?: string; }
interface CachedResolvedName  { name: string; _modelId?: string; }

async function cacheGetProp(key: string): Promise<CachedPropertyScore | null> {
  if (!REDIS_URL) return null;
  try {
    const res  = await fetch(`${REDIS_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    const json = await res.json();
    if (!json.result) return null;
    const parsed = JSON.parse(json.result);
    if (
      !parsed || typeof parsed !== "object" ||
      typeof parsed.word      !== "string" ||
      typeof parsed.score     !== "number" ||
      typeof parsed.reasoning !== "string" ||
      typeof parsed.passes    !== "boolean"
    ) {
      console.warn("[cacheGetProp] Stale/invalid entry — treating as miss");
      return null;
    }
    return parsed as CachedPropertyScore;
  } catch { return null; }
}

async function cacheSetProp(key: string, prop: PropertyScore, modelId: string): Promise<void> {
  if (!REDIS_URL) return;
  try {
    await fetch(REDIS_URL, {
      method:  "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(["SET", key, JSON.stringify({ ...prop, _modelId: modelId }), "EX", CACHE_TTL_S]),
    });
  } catch { /* non-fatal */ }
}

async function cacheGetResolvedName(key: string): Promise<CachedResolvedName | null> {
  if (!REDIS_URL) return null;
  try {
    const res  = await fetch(`${REDIS_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    const json = await res.json();
    if (!json.result) return null;
    const parsed = JSON.parse(json.result);
    if (!parsed || typeof parsed.name !== "string") return null;
    return parsed as CachedResolvedName;
  } catch { return null; }
}

async function cacheSetResolvedName(
  key:           string,
  resolvedName:  string,
  modelId:       string,
  detectedLabel: string,
): Promise<void> {
  if (!REDIS_URL) return;
  // Skip the write when the model didn't actually correct anything —
  // keeps the resolved-name cache focused on "real corrections".
  if (normalize(resolvedName) === normalize(detectedLabel)) return;
  try {
    await fetch(REDIS_URL, {
      method:  "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify([
        "SET", key, JSON.stringify({ name: resolvedName, _modelId: modelId }), "EX", CACHE_TTL_S,
      ]),
    });
  } catch { /* non-fatal */ }
}

// ─── IP rate limit (verbatim from v5.2.2) ────────────────────────────────────

async function checkIpRateLimit(
  supabase: ReturnType<typeof createClient>,
  ipHash:   string,
): Promise<{ allowed: boolean; requestCount: number }> {
  const now = new Date();
  const { data: existing } = await supabase
    .from("ip_rate_limits")
    .select("request_count, window_start")
    .eq("ip_hash", ipHash)
    .maybeSingle();

  if (!existing) {
    await supabase.from("ip_rate_limits").upsert({
      ip_hash: ipHash, request_count: 1, window_start: now.toISOString(),
    });
    return { allowed: true, requestCount: 1 };
  }

  const row = existing as { request_count: number; window_start: string };
  const windowStart = new Date(row.window_start).getTime();
  if (now.getTime() - windowStart > IP_WINDOW_MS) {
    await supabase.from("ip_rate_limits").upsert({
      ip_hash: ipHash, request_count: 1, window_start: now.toISOString(),
    });
    return { allowed: true, requestCount: 1 };
  }

  const newCount = row.request_count + 1;
  await supabase.from("ip_rate_limits").update({ request_count: newCount }).eq("ip_hash", ipHash);
  return { allowed: newCount <= IP_LIMIT_PER_MINUTE, requestCount: newCount };
}

async function hashIp(ip: string): Promise<string> {
  const encoded = new TextEncoder().encode(ip + (Deno.env.get("IP_HASH_SALT") ?? "lexi-lens"));
  const buf = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

// ─── New v5.4: get_evaluate_context RPC wrapper ──────────────────────────────

interface EvaluateContext {
  scansToday:       number;
  haikuCallsToday:  number;
  subscriptionTier: string;
  questMinTier:     string;
  questExists:      boolean;
}

async function getEvaluateContext(
  supabase: ReturnType<typeof createClient>,
  childId:  string,
  questId:  string,
): Promise<EvaluateContext> {
  try {
    const { data, error } = await supabase.rpc("get_evaluate_context", {
      p_child_id: childId,
      p_quest_id: questId,
    });
    if (error) {
      console.error("[evaluate] get_evaluate_context error:", error.message);
      return defaultContext();
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return defaultContext();
    return {
      scansToday:       typeof row.scans_today        === "number" ? row.scans_today        : 0,
      haikuCallsToday:  typeof row.haiku_calls_today  === "number" ? row.haiku_calls_today  : 0,
      subscriptionTier: typeof row.subscription_tier  === "string" ? row.subscription_tier  : "free",
      questMinTier:     typeof row.quest_min_tier     === "string" ? row.quest_min_tier     : "free",
      questExists:      Boolean(row.quest_exists),
    };
  } catch (e) {
    console.error("[evaluate] get_evaluate_context threw:", e);
    return defaultContext();
  }
}

function defaultContext(): EvaluateContext {
  // Conservative defaults: free tier, restrictive caps. Erring free here is
  // the safe direction — a paid customer briefly seeing free limits is
  // recoverable; the inverse is a cost incident.
  return {
    scansToday:       0,
    haikuCallsToday:  0,
    subscriptionTier: "free",
    questMinTier:     "free",
    questExists:      true, // assume exists on RPC failure to avoid false 404s
  };
}

// ─── Quest tier gate ─────────────────────────────────────────────────────────
//
// True if a parent on `parentTier` is allowed to scan a quest with
// `questMinTier`. Free quests are open to everyone; paid quests require
// the parent's tier to be anything other than 'free'.

function parentCanAccessQuest(parentTier: string, questMinTier: string): boolean {
  if (questMinTier === "free") return true;
  if (questMinTier === "paid") return parentTier !== "free";
  // Defensive default: treat unknown min-tier values as 'paid' (closed).
  return parentTier !== "free";
}

// ─── scan_attempts logging (v5.4: includes model_id) ─────────────────────────

interface LogScanArgs {
  childId:       string;
  questId?:      string;
  detectedLabel: string;
  confidence?:   number;
  ipHash?:       string;
  result:        EvaluationResult;
}

async function logScanResult(
  supabase: ReturnType<typeof createClient>,
  opts:     LogScanArgs & { claudeLatencyMs: number; modelId: string },
): Promise<string | null> {
  try {
    const { data, error } = await supabase.from("scan_attempts").insert({
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
      model_id:          opts.modelId,           // NEW v5.4
    }).select("id").single();
    if (error) {
      console.error("[evaluate] logScanResult INSERT error:", error.message);
      return null;
    }
    return (data as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error("[evaluate] logScanResult INSERT failed:", e);
    return null;
  }
}

async function logScanCacheHit(
  supabase: ReturnType<typeof createClient>,
  opts:     LogScanArgs,
): Promise<string | null> {
  try {
    const { data, error } = await supabase.from("scan_attempts").insert({
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
      claude_latency_ms: null,                   // signal: no model call
      cache_hit:         true,
      model_id:          null,                   // NEW v5.4: NULL for cache hits
    }).select("id").single();
    if (error) {
      console.error("[evaluate] logScanCacheHit INSERT error:", error.message);
      return null;
    }
    return (data as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error("[evaluate] logScanCacheHit INSERT failed:", e);
    return null;
  }
}

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
): Promise<void> {
  try {
    await supabase.from("scan_attempts").insert({
      child_id:          opts.childId,
      quest_id:          opts.questId        ?? null,
      detected_label:    opts.detectedLabel,
      vision_confidence: opts.confidence     ?? null,
      ip_hash:           opts.ipHash         ?? null,
      rate_limited:      opts.isRateLimited,
      resolved_name:     "",
      overall_match:     false,
      property_scores:   [],
      child_feedback:    "",
      xp_awarded:        0,
      claude_latency_ms: null,
      cache_hit:         false,
      model_id:          null,                   // NEW v5.4: nothing produced
    });
  } catch (e) {
    console.error("[evaluate] logScanBlocked INSERT failed:", e);
  }
}

// ─── Response helpers ────────────────────────────────────────────────────────

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

function buildAlertFlags(scansToday: number, dailyLimit: number, tier: string) {
  return {
    scansToday,
    dailyLimit,
    tier,
    approachingLimit: scansToday >= Math.floor(dailyLimit * ALERT_THRESHOLD_PCT),
    limitReached:     scansToday >= dailyLimit,
  };
}

// ─── Main handler ────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  // ── 1. Parse + validate body ──────────────────────────────────────────────
  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  const {
    childId, questId, questName, detectedLabel, confidence,
    frameBase64, requiredProperties, childAge, failedAttempts,
    masteryProfile, alreadyFoundWords,
    xp_reward_first_try, xp_reward_retry, xp_reward_third_plus,
  } = body as Record<string, unknown>;

  const xpRates = {
    firstTry:  typeof xp_reward_first_try  === "number" ? xp_reward_first_try  : 40,
    secondTry: typeof xp_reward_retry      === "number" ? xp_reward_retry      : 25,
    thirdPlus: typeof xp_reward_third_plus === "number" ? xp_reward_third_plus : 10,
  };

  if (typeof childId !== "string" || typeof questId !== "string" || typeof detectedLabel !== "string") {
    return jsonResponse({ error: "Missing required fields: childId, questId, detectedLabel" }, 400);
  }

  // ── 2. IP rate limit ──────────────────────────────────────────────────────
  const fwdFor = req.headers.get("x-forwarded-for") ?? req.headers.get("cf-connecting-ip") ?? "0.0.0.0";
  const ipHash = await hashIp(fwdFor.split(",")[0].trim());
  const ipCheck = await checkIpRateLimit(supabase, ipHash);
  if (!ipCheck.allowed) {
    await logScanBlocked(supabase, {
      childId, questId, detectedLabel, confidence: confidence as number | undefined,
      ipHash, isRateLimited: true,
    });
    return jsonResponse({
      error:      "rate_limit_exceeded",
      code:       "IP_LIMIT",
      message:    "Too many requests. Please wait a moment before scanning again.",
      retryAfter: 60,
    }, 429);
  }

  // ── 3. Single round-trip context fetch (v5.4) ─────────────────────────────
  const ctx = await getEvaluateContext(supabase, childId, questId);

  // ── 3a. Quest existence check (404) ───────────────────────────────────────
  if (!ctx.questExists) {
    return jsonResponse({ error: "quest_not_found", message: "Quest not found or inactive." }, 404);
  }

  // ── 3b. Quest tier gate (403) — closes the v5.3 security gap ─────────────
  if (!parentCanAccessQuest(ctx.subscriptionTier, ctx.questMinTier)) {
    console.warn(
      `[evaluate] quest tier gate: blocked. ` +
      `parent_tier=${ctx.subscriptionTier} quest_min_tier=${ctx.questMinTier} ` +
      `childId=${childId} questId=${questId}`
    );
    return jsonResponse({
      error:    "quest_not_available",
      code:     "TIER_GATE",
      message:  "This quest is not available on your current plan.",
      tier:     ctx.subscriptionTier,
      minTier:  ctx.questMinTier,
    }, 403);
  }

  // ── 3c. Daily scan cap (429) ──────────────────────────────────────────────
  const tierLimits = await getTierLimits(supabase, ctx.subscriptionTier);
  const dailyLimit = tierLimits.capScansPerDay;

  if (ctx.scansToday >= dailyLimit) {
    await logScanBlocked(supabase, {
      childId, questId, detectedLabel, confidence: confidence as number | undefined,
      ipHash, isRateLimited: false,
    });
    return jsonResponse({
      error:      "rate_limit_exceeded",
      code:       "DAILY_QUOTA",
      scansToday: ctx.scansToday,
      limit:      dailyLimit,
      tier:       ctx.subscriptionTier,
      resetsAt:   utcMidnight(),
      message:    "Daily scan limit reached. Come back tomorrow, brave adventurer!",
    }, 429);
  }

  // ── 4. Per-property cache lookup ──────────────────────────────────────────
  const labelTrimmed   = detectedLabel.toLowerCase().trim();
  const isGenericLabel = GENERIC_LABELS.has(labelTrimmed);
  const attempts       = (failedAttempts as number | undefined) ?? 0;
  const shouldUseCache = !isGenericLabel && attempts === 0;

  const pendingProperties: PropertyRequirement[] = Array.isArray(requiredProperties)
    ? (requiredProperties as Array<Record<string, unknown>>).map((p) => ({
        word:            typeof p.word            === "string" ? p.word            : "",
        definition:      typeof p.definition      === "string" ? p.definition      : "",
        evaluationHints: typeof p.evaluationHints === "string" ? p.evaluationHints : undefined,
      })).filter((p) => p.word.length > 0)
    : [];

  let cachedProperties:  PropertyScore[]        = [];
  let missingProperties: PropertyRequirement[]  = pendingProperties;

  if (shouldUseCache && pendingProperties.length > 0) {
    const lookups = await Promise.all(
      pendingProperties.map(async (prop) => ({
        prop,
        hit: await cacheGetProp(buildPerPropCacheKey(detectedLabel, prop.word)),
      }))
    );
    cachedProperties = lookups.filter((l) => l.hit !== null).map((l) => ({
      word: l.hit!.word, score: l.hit!.score, reasoning: l.hit!.reasoning, passes: l.hit!.passes,
    }));
    missingProperties = lookups.filter((l) => l.hit === null).map((l) => l.prop);

    console.log(
      `[evaluate] per-property: cached=${cachedProperties.length} ` +
      `missing=${missingProperties.length} ` +
      `(${cachedProperties.length === pendingProperties.length ? "FULL HIT"
        : missingProperties.length === pendingProperties.length ? "FULL MISS" : "PARTIAL HIT"}) ` +
      `childId=${childId}`
    );
  } else if (isGenericLabel) {
    console.log(`[evaluate] Skipping cache (generic label="${labelTrimmed}"): childId=${childId}`);
  }

  // ── 5. FULL CACHE HIT — skip model entirely ───────────────────────────────
  if (shouldUseCache && missingProperties.length === 0 && cachedProperties.length > 0) {
    const cachedResolvedRow = await cacheGetResolvedName(buildResolvedNameCacheKey(detectedLabel));
    const resolvedName      = cachedResolvedRow?.name;

    console.log(
      `[evaluate] resolved-name cache: ${
        cachedResolvedRow ? `HIT (producedBy=${cachedResolvedRow._modelId ?? "unknown"}, name="${resolvedName}")` : "MISS — using detectedLabel"
      } childId=${childId}`
    );

    const composed = composeResultFromCachedOnly(
      detectedLabel, cachedProperties, attempts, xpRates, resolvedName,
    );

    const scanAttemptId = await logScanCacheHit(supabase, {
      childId, questId, detectedLabel, confidence: confidence as number | undefined, ipHash, result: composed,
    });

    return jsonResponse({
      ...composed,
      _cacheHit:      true,
      _scanAttemptId: scanAttemptId,
      _rateLimit:     buildAlertFlags(ctx.scansToday, dailyLimit, ctx.subscriptionTier),
    });
  }

  // ── 6. Pick adapter for this request (v5.4) ───────────────────────────────
  const routing = await pickAdapterForRequest(
    supabase, ctx.subscriptionTier, ctx.haikuCallsToday,
  );
  console.log(
    `[evaluate] routing: model=${routing.adapter.id} reason=${routing.reason} ` +
    `parent_tier=${ctx.subscriptionTier} haiku_today=${ctx.haikuCallsToday}/${routing.haikuCallsPerDay} ` +
    `childId=${childId}`
  );

  // ── 7. Call the model (full miss or partial hit) ──────────────────────────
  const claudeStart = Date.now();
  let evaluationResult: EvaluationResult;

  try {
    evaluationResult = await evaluateObject(
      {
        detectedLabel,
        confidence:                    confidence as number,
        frameBase64:                   frameBase64 as string | null | undefined,
        requiredProperties:            missingProperties,
        previouslyEvaluatedProperties: cachedProperties.length > 0 ? cachedProperties : undefined,
        childAge:                      childAge as number,
        failedAttempts:                attempts,
        questName:                     questName as string | undefined,
        masteryProfile:                masteryProfile as Parameters<typeof evaluateObject>[0]["masteryProfile"],
        alreadyFoundWords: Array.isArray(alreadyFoundWords)
          ? (alreadyFoundWords as unknown[]).filter((w): w is string => typeof w === "string")
          : [],
        xpRates,
      },
      routing.adapter,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Evaluation failed";
    console.error(`[evaluate] model call failed (modelId=${routing.adapter.id}):`, msg);
    await logScanBlocked(supabase, {
      childId, questId, detectedLabel, confidence: confidence as number | undefined,
      ipHash, isRateLimited: false,
    });
    return jsonResponse({ error: msg }, 500);
  }

  // ── 8. Log full result (cache_hit=false; model ran) ───────────────────────
  const scanAttemptId = await logScanResult(supabase, {
    childId, questId, detectedLabel, confidence: confidence as number | undefined,
    ipHash, claudeLatencyMs: Date.now() - claudeStart,
    result: evaluationResult,
    modelId: routing.adapter.id,                  // NEW v5.4
  });

  // ── 9. Cache writes ───────────────────────────────────────────────────────
  if (shouldUseCache) {
    const missingWords = new Set(missingProperties.map((p) => p.word));
    const freshScores  = evaluationResult.properties.filter((p) => missingWords.has(p.word));

    const writes: Promise<unknown>[] = freshScores.map((score) =>
      cacheSetProp(buildPerPropCacheKey(detectedLabel, score.word), score, routing.adapter.id),
    );
    writes.push(cacheSetResolvedName(
      buildResolvedNameCacheKey(detectedLabel),
      evaluationResult.resolvedObjectName, routing.adapter.id, detectedLabel,
    ));
    await Promise.all(writes);
  }

  // ── 10. Parent alert flags + return ───────────────────────────────────────
  const newScansToday = ctx.scansToday + 1;
  return jsonResponse({
    ...evaluationResult,
    _cacheHit:      false,
    _scanAttemptId: scanAttemptId,
    _rateLimit:     buildAlertFlags(newScansToday, dailyLimit, ctx.subscriptionTier),
    // Optional client telemetry — useLexiEvaluate ignores extra props.
    _modelId:       routing.adapter.id,
    _routing:       routing.reason,
  });
});
