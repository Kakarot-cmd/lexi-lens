/**
 * supabase/functions/evaluate/index.ts
 * Lexi-Lens — Supabase Edge Function entry point.
 *
 * v5.2.1 — Per-label resolved-name cache (Option B)
 *
 *   Targets one specific user-facing degradation that landed in v5.2:
 *   on FULL per-property cache hit, the kid was seeing ML Kit's raw label
 *   ("Mobile phone") instead of the model-corrected name ("remote
 *   control") that the bundle cache used to preserve.
 *
 *   Mechanism:
 *
 *     • New per-label cache:  <env>:lexi:eval:resolved:<hash(label)>
 *       Value: { name: string, _modelId: string }
 *
 *     • Read path: on FULL per-property hit only, look up the resolved
 *       name. If found, pass it to composeResultFromCachedOnly so the kid
 *       sees the corrected label. If not found, fall back to the raw
 *       detectedLabel (v5.2.0 behaviour).
 *
 *     • Write path: every successful model response (full miss OR partial
 *       hit) writes the model's resolvedObjectName to this cache, fire-
 *       and-forget. Cache builds up organically — no backfill needed.
 *
 *   Cost: zero additional model calls. The corrected name comes from
 *   responses you're already paying for.
 *
 *   Latency:
 *     • Full-hit path:    +10-30ms (one extra Upstash GET on a path that
 *                                   was already ~300ms — imperceptible).
 *     • Partial-hit path: +0ms perceived (one extra fire-and-forget SET).
 *     • Full-miss path:   +0ms perceived (same fire-and-forget SET).
 *
 *   Recovers: model-corrected resolvedObjectName on full hits.
 *   Still templated on full hit: childFeedback. Defer to Option C if/when
 *   real-user data shows kids notice template repetition.
 *
 * v5.2 — Per-property cache refactor (Phase 4.8)
 * v5.1 — Model provider abstraction + shared cache namespace
 * v4.7 — scan_attempt_id on response (verdict reporting)
 * v4.5 — cache_hit observability
 * v4.4 — iOS cross-scan property bleed (generic-label cache bypass)
 *
 * scan_attempts columns used here:
 *   child_id, quest_id, detected_label, vision_confidence,
 *   resolved_name, overall_match, property_scores, child_feedback,
 *   xp_awarded, claude_latency_ms, ip_hash, rate_limited, cache_hit
 */

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import {
  evaluateObject,
  composeResultFromCachedOnly,
  type PropertyRequirement,
  type PropertyScore,
} from "./evaluateObject.ts";
import { getModelAdapter } from "../_shared/models/index.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const DAILY_SCAN_LIMIT    = 50;
const ALERT_THRESHOLD_PCT = 0.80;
const IP_LIMIT_PER_MINUTE = 20;
const IP_WINDOW_MS        = 60_000;

const GENERIC_LABELS = new Set(["", "object", "unknown", "thing", "item"]);

// ─── Redis helpers (Upstash) ─────────────────────────────────────────────────

const REDIS_URL   = Deno.env.get("UPSTASH_REDIS_REST_URL")   ?? "";
const REDIS_TOKEN = Deno.env.get("UPSTASH_REDIS_REST_TOKEN") ?? "";
const CACHE_TTL_S = 14 * 24 * 60 * 60; // 14 days

// ─── Cache env namespace (per-Supabase-project) ──────────────────────────────

const ENV_NAME: string = (() => {
  const fromEnv = Deno.env.get("CACHE_ENV_NAMESPACE")?.trim().toLowerCase();
  if (fromEnv && /^[a-z0-9_-]+$/.test(fromEnv)) return fromEnv;
  console.warn(
    "[evaluate] CACHE_ENV_NAMESPACE not set or invalid — using 'default'."
  );
  return "default";
})();

// ─── Normalisation (shared by both cache key builders) ───────────────────────

function normalize(s: string): string {
  return s.toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/([a-z]{2,})([^se])s\b/g, "$1$2");
}

// ─── Per-property cache key (v5.2) ───────────────────────────────────────────
//
// Format: <env>:lexi:eval:prop:<base64(normalize(label) :: normalize(word))>

function buildPerPropCacheKey(label: string, word: string): string {
  const raw = `${normalize(label)}::${normalize(word)}`;
  return `${ENV_NAME}:lexi:eval:prop:${btoa(raw).replace(/=/g, "")}`;
}

// ─── Per-label resolved-name cache key (v5.2.1) ──────────────────────────────
//
// Format: <env>:lexi:eval:resolved:<base64(normalize(label))>
//
// Different namespace from per-property cache (`:resolved:` vs `:prop:`),
// so they coexist cleanly. Same normalisation rules — case insensitive,
// plural-aware — so "Apple" and "apples" share the same cached resolved
// name. Same TTL.

function buildResolvedNameCacheKey(label: string): string {
  const raw = normalize(label);
  return `${ENV_NAME}:lexi:eval:resolved:${btoa(raw).replace(/=/g, "")}`;
}

// ─── Per-property cache GET ──────────────────────────────────────────────────

interface CachedPropertyScore extends PropertyScore {
  _modelId?: string;
}

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
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.word      !== "string" ||
      typeof parsed.score     !== "number" ||
      typeof parsed.reasoning !== "string" ||
      typeof parsed.passes    !== "boolean"
    ) {
      console.warn("[cacheGetProp] Stale/invalid entry — treating as miss");
      return null;
    }

    return parsed as CachedPropertyScore;
  } catch {
    return null;
  }
}

// ─── Per-property cache SET ──────────────────────────────────────────────────

async function cacheSetProp(
  key:     string,
  prop:    PropertyScore,
  modelId: string,
): Promise<void> {
  if (!REDIS_URL) return;
  try {
    await fetch(REDIS_URL, {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        "SET",
        key,
        JSON.stringify({ ...prop, _modelId: modelId }),
        "EX",
        CACHE_TTL_S,
      ]),
    });
  } catch { /* non-fatal */ }
}

// ─── Per-label resolved-name cache GET (v5.2.1) ──────────────────────────────
//
// Returns null when the cache has nothing for this label, when the entry
// is malformed, or when Upstash is unreachable. Caller treats null as
// "use detectedLabel as the resolved name" — the v5.2.0 behaviour.

interface CachedResolvedName {
  name:      string;
  _modelId?: string;
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
    if (!parsed || typeof parsed !== "object" || typeof parsed.name !== "string") {
      console.warn("[cacheGetResolvedName] Stale/invalid entry — treating as miss");
      return null;
    }

    return parsed as CachedResolvedName;
  } catch {
    return null;
  }
}

// ─── Per-label resolved-name cache SET (v5.2.1) ──────────────────────────────
//
// Called fire-and-forget after every successful model response. Stamps the
// model id alongside the name so we have lineage — useful if you ever need
// to selectively purge by model. We skip writes when the corrected name
// equals the raw label (no signal worth caching) and when the label was
// generic ("object", "thing", etc.) where ML Kit gave us nothing useful
// to correct in the first place.

async function cacheSetResolvedName(
  key:           string,
  name:          string,
  modelId:       string,
  detectedLabel: string,
): Promise<void> {
  if (!REDIS_URL)                                          return;
  if (!name || name.trim().length === 0)                   return;
  if (normalize(name) === normalize(detectedLabel))        return;

  try {
    await fetch(REDIS_URL, {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        "SET",
        key,
        JSON.stringify({ name, _modelId: modelId }),
        "EX",
        CACHE_TTL_S,
      ]),
    });
  } catch { /* non-fatal */ }
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
  opts: {
    childId:       string;
    questId?:      string;
    detectedLabel: string;
    confidence?:   number;
    ipHash?:       string;
    result:        Awaited<ReturnType<typeof evaluateObject>>;
  }
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
      claude_latency_ms: null,   // signal: no model call
      cache_hit:         true,
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
    xp_reward_first_try,
    xp_reward_retry,
    xp_reward_third_plus,
  } = body as Record<string, unknown>;

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

  // ── 2. Resolve model adapter ──────────────────────────────────────────────
  const adapter = await getModelAdapter("evaluate", supabase);

  // ── 3. IP rate limit ──────────────────────────────────────────────────────
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

  // ── 4. Daily child quota ──────────────────────────────────────────────────
  const { data: scanCount, error: rpcError } = await supabase.rpc(
    "get_daily_scan_count",
    { p_child_id: childId }
  );

  if (rpcError) {
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

  // ── 5. Per-property cache lookup ──────────────────────────────────────────
  const labelTrimmed   = ((detectedLabel as string) ?? "").toLowerCase().trim();
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
      pendingProperties.map(async (prop) => {
        const key = buildPerPropCacheKey(detectedLabel as string, prop.word);
        const hit = await cacheGetProp(key);
        return { prop, hit };
      })
    );

    cachedProperties = lookups
      .filter((l) => l.hit !== null)
      .map((l) => ({
        word:      l.hit!.word,
        score:     l.hit!.score,
        reasoning: l.hit!.reasoning,
        passes:    l.hit!.passes,
      }));

    missingProperties = lookups
      .filter((l) => l.hit === null)
      .map((l) => l.prop);

    console.log(
      `[evaluate] per-property: cached=${cachedProperties.length} ` +
      `missing=${missingProperties.length} ` +
      `(${cachedProperties.length === pendingProperties.length ? "FULL HIT" : missingProperties.length === pendingProperties.length ? "FULL MISS" : "PARTIAL HIT"}) ` +
      `childId=${childId}`
    );
  } else if (isGenericLabel) {
    console.log(`[evaluate] Skipping cache (generic label="${labelTrimmed}"): childId=${childId} questId=${questId ?? "n/a"}`);
  }

  // ── 6. FULL CACHE HIT — skip model entirely ───────────────────────────────
  // v5.2.1: also check the per-label resolved-name cache. If hit, the kid
  // sees the model-corrected name. If miss, fall back to detectedLabel.
  if (shouldUseCache && missingProperties.length === 0 && cachedProperties.length > 0) {
    const resolvedNameKey   = buildResolvedNameCacheKey(detectedLabel as string);
    const cachedResolvedRow = await cacheGetResolvedName(resolvedNameKey);
    const resolvedName      = cachedResolvedRow?.name;

    console.log(
      `[evaluate] resolved-name cache: ${cachedResolvedRow ? `HIT (producedBy=${cachedResolvedRow._modelId ?? "unknown"}, name="${resolvedName}")` : "MISS — using detectedLabel"} ` +
      `childId=${childId}`
    );

    const composed = composeResultFromCachedOnly(
      detectedLabel as string,
      cachedProperties,
      attempts,
      xpRates,
      resolvedName,
    );

    const scanAttemptId = await logScanCacheHit(supabase, {
      childId,
      questId:       questId as string | undefined,
      detectedLabel: detectedLabel as string,
      confidence:    confidence as number | undefined,
      ipHash,
      result:        composed,
    });

    return jsonResponse({
      ...composed,
      _cacheHit:      true,
      _scanAttemptId: scanAttemptId,
      _rateLimit:     buildAlertFlags(scansToday),
    });
  }

  // ── 7. Call the model (full miss or partial hit) ──────────────────────────
  const claudeStart = Date.now();
  let evaluationResult: Awaited<ReturnType<typeof evaluateObject>>;

  try {
    evaluationResult = await evaluateObject(
      {
        detectedLabel:                 detectedLabel as string,
        confidence:                    confidence as number,
        frameBase64:                   frameBase64 as string | null | undefined,
        requiredProperties:            missingProperties,
        previouslyEvaluatedProperties: cachedProperties.length > 0 ? cachedProperties : undefined,
        childAge:                      childAge as number,
        failedAttempts:                attempts,
        questName:                     questName as string | undefined,
        masteryProfile:                masteryProfile as Parameters<typeof evaluateObject>[0]["masteryProfile"],
        alreadyFoundWords:             Array.isArray(alreadyFoundWords)
          ? (alreadyFoundWords as unknown[]).filter((w): w is string => typeof w === "string")
          : [],
        xpRates,
      },
      adapter,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Evaluation failed";
    console.error(`[evaluate] model call failed (modelId=${adapter.id}):`, msg);
    await logScanBlocked(supabase, {
      childId,
      questId:       questId as string | undefined,
      detectedLabel: detectedLabel as string,
      confidence:    confidence as number | undefined,
      ipHash,
      isRateLimited: false,
    });
    return jsonResponse({ error: msg }, 500);
  }

  // ── 8. Log full result (cache_hit=false; model ran) ───────────────────────
  const scanAttemptId = await logScanResult(supabase, {
    childId,
    questId:         questId as string | undefined,
    detectedLabel:   detectedLabel as string,
    confidence:      confidence as number | undefined,
    ipHash,
    claudeLatencyMs: Date.now() - claudeStart,
    result:          evaluationResult,
  });

  // ── 9. Cache writes (per-property + per-label resolved name) ──────────────
  // Generic-label and retry bypasses extend to writes. We only write fresh
  // properties (the ones we just got from the model) — cached properties
  // were already in cache.
  //
  // v5.2.1: also write the resolved name to the per-label cache. Done as
  // fire-and-forget alongside the per-property writes — they run in parallel
  // via Promise.all and we don't await each individually.
  if (shouldUseCache) {
    const missingWords = new Set(missingProperties.map((p) => p.word));
    const freshScores  = evaluationResult.properties.filter((p) => missingWords.has(p.word));

    const writes: Promise<unknown>[] = freshScores.map((score) => {
      const key = buildPerPropCacheKey(detectedLabel as string, score.word);
      return cacheSetProp(key, score, adapter.id);
    });

    // Resolved-name write — model just produced a (potentially corrected)
    // name; remember it so future full-hits don't fall back to detectedLabel.
    // The helper itself skips writes when name === detectedLabel (no signal).
    writes.push(cacheSetResolvedName(
      buildResolvedNameCacheKey(detectedLabel as string),
      evaluationResult.resolvedObjectName,
      adapter.id,
      detectedLabel as string,
    ));

    await Promise.all(writes);
  }

  // ── 10. Parent alert flags + return ───────────────────────────────────────
  const newScansToday = scansToday + 1;
  return jsonResponse({
    ...evaluationResult,
    _cacheHit:      false,
    _scanAttemptId: scanAttemptId,
    _rateLimit:     buildAlertFlags(newScansToday),
  });
});
