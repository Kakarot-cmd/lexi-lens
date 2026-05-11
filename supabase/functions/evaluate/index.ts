/**
 * supabase/functions/evaluate/index.ts
 * Lexi-Lens — Supabase Edge Function entry point (v6.2 Phase 2)
 *
 * v6.2 Phase 2 (Session B) — CC1 integration
 *
 *   1. Accepts optional `cc1Result` field in the request body:
 *
 *        cc1Result?: { canonical: string; aliases: string[];
 *                      modelId: string; latencyMs: number }
 *
 *      When present, evaluate uses cc1Result.canonical as the cache lookup
 *      key — bypassing the alias-map resolution layer for forward lookups.
 *      cc1Result.aliases are still seeded into the alias map after a
 *      successful model call (alongside model-introspected aliases).
 *
 *   2. scan_attempts now writes four CC1 fields per row:
 *        cc1_model_id   — CC1's modelId, or NULL on skip/fallthrough
 *        cc1_latency_ms — CC1's measured latency, NULL when skipped
 *        cc1_skipped    — true=flag off; false=CC1 attempted (success or fallthrough)
 *        cc1_canonical  — CC1's reported canonical, for agreement analysis
 *
 *   3. Response now includes _cc1Enabled: boolean — piggybacked flag value
 *      so the client can update its own session cache without an extra
 *      round-trip to /cc1?probe=1.
 *
 *   4. NO behavioral change when cc1Result is absent — the function is
 *      drop-in compatible with the pre-Session-B client. Safe to deploy
 *      ahead of the CC1-aware client build.
 *
 * v6.0 (2026-05-10) — Mistral primary + cache v6
 *
 *   1. Mistral as primary model. Routing rewritten around Mistral →
 *      Gemini → Haiku hierarchy. Old Haiku-budget log lines replaced
 *      with primary-budget shape. See _shared/tierRouting.ts.
 *
 *   2. Cache v6 redesign. Two changes coupled:
 *      • Readable, greppable key format — no btoa on the common path.
 *        New: "{env}:lexi:v6:verdict:{label}:{word}" / "...:resolved:{label}"
 *      • Stratified value shape with kid_msg.young, kid_msg.older, optional
 *        nudge.young/older. Cache hits now produce real kid voice instead
 *        of being reconstructed from reasoning.
 *
 *      The old btoa-encoded v5 namespace ("lexi:eval:prop:..." and
 *      "lexi:eval:resolved:...") is NOT read on this version. Operator
 *      MUST FLUSH the v5 namespace before this code goes live, or wait
 *      14 days for v5 entries to expire. Mixed-schema reads are a defense
 *      against future migrations, not legacy compatibility.
 *
 *   3. Quest flavor template. quests.feedback_flavor_template (nullable
 *      TEXT, added in 20260510 migration) appended to passing
 *      childFeedback at compose time. Replaces the v5 attempt to put
 *      questId in the cache key.
 *
 *   4. Strict shape validation. Cache entries that fail v6 shape are
 *      treated as miss AND logged with a distinctive prefix
 *      ([evaluate] CACHE_SHAPE_INVALID ...) so silent corruption surfaces
 *      in log queries instead of degrading the kid-facing UX.
 *
 *   All v5.x defenses preserved verbatim:
 *     • GENERIC_LABELS guard (iOS "object" cross-scan bleed)
 *     • failedAttempts > 0 → skip cache entirely (retry nudges)
 *     • Per-property partial-hit composition (only fresh props go to model)
 *     • Quest tier validation (free child can't request a paid quest)
 *     • Daily scan cap, IP rate limit, scan_attempts logging
 *
 * v5.4 — Phase 4.10b tier-aware Haiku→Gemini routing (superseded)
 * v5.2.x — Per-property + per-label cache (superseded by v6 schema)
 */

import { serve }        from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

import {
  evaluateObject,
  composeFinalResult,
  type EvaluationResult,
  type PropertyRequirement,
  type PropertyScoreV6,
  type AgeBandedString,
  type XpRates,
} from "./evaluateObject.ts";

import { pickAdapterForRequest } from "../_shared/tierRouting.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const ALERT_THRESHOLD_PCT = 0.80;
const IP_LIMIT_PER_MINUTE = 20;
const IP_WINDOW_MS        = 60_000;

const GENERIC_LABELS = new Set(["", "object", "unknown", "thing", "item"]);

/**
 * v6.1 — Basket labels: ML Kit returns these for multiple distinct
 * canonical objects with materially different property verdicts.
 *
 * VERIFIED against the official ML Kit base-model label map at
 * https://developers.google.com/ml-kit/vision/image-labeling/label-map
 * (last fetched May 2026). Every entry here is confirmed present in the
 * base model vocabulary — no phantom labels that would never fire.
 *
 * Examples of the failure mode this guards against:
 *   • ML Kit labels both a biscuit packet and a ceramic plate as "tableware".
 *     A "smooth=passes" verdict cached for the plate would silently apply
 *     to a future scan of a (non-smooth) biscuit packet under the same
 *     label — the cache would serve a wrong verdict without a model call.
 *   • Material labels like "leather" wrap many objects (wallet, couch,
 *     belt, jacket) with materially different "soft" and "hard" verdicts.
 *   • Catchall buckets like "product", "junk", "model", "vehicle" are
 *     extreme — they cover hundreds of distinct objects.
 *
 * Treatment is the same as GENERIC_LABELS: skip cache lookup AND skip
 * cache write for these scans. Every basket-labeled scan is a model call.
 * The alias map is also bypassed for these — there's no useful canonical
 * to redirect to when one detected label maps to many real objects.
 *
 * Cost impact: bounded. At ~$0.0006/scan and a measured-from-PROD-data
 * fraction of basket-labeled scans, every basket scan is a model call.
 * The blended cost vs. ideal-cache is the basket fraction × $0.0006.
 *
 * v6.2 will revisit with a two-stage approach: a cheap-classify call
 * (potentially via a different cheaper provider — Gemini Flash-Lite) to
 * resolve the canonical name, then cache lookup on the canonical, then
 * full-evaluate only on miss. Defer until PROD data justifies the
 * complexity. See roadmap.
 *
 * Add labels here if PROD logs show new basket-label patterns producing
 * wrong cache hits. Sharp labels (single canonical object — "apple",
 * "couch", "television", etc.) MUST stay out — putting them here turns
 * off cache for them too.
 */
const BASKET_LABELS = new Set([
  // ── Container / packaging / serveware ──────────────────────────────────
  "tableware",        // plates, mugs, cups, bowls, cutlery — extreme range
  "cutlery",          // forks vs spoons vs knives — different props
  "cookware and bakeware",  // pots vs pans vs baking trays
  "bag",              // backpack vs plastic bag vs handbag

  // ── Food category buckets ──────────────────────────────────────────────
  "food",             // ML Kit's most general food label
  "fruit",            // apple vs banana vs grape — different props
  "vegetable",        // carrot vs potato vs broccoli
  "fast food",        // burger vs fries vs nuggets
  "cuisine",          // generic food bucket
  "meal", "lunch", "supper",  // generic meal labels
  "alcohol",          // bottle vs glass vs can
  "bread",            // loaf vs roll vs pita

  // ── Materials (wrap many distinct objects) ─────────────────────────────
  "leather",          // wallet vs couch vs belt vs jacket
  "metal",
  "textile",
  "denim",            // jacket vs jeans vs shirt
  "cotton",
  "wool",
  "fur",
  "porcelain",        // mug vs vase vs figurine
  "tile",             // ceramic, vinyl, wallpaper variants

  // ── Furniture & home buckets ───────────────────────────────────────────
  "cabinetry",        // kitchen cabinet vs wardrobe vs dresser
  "infrastructure",   // bridge vs tower vs road
  "building",         // cathedral vs office vs house

  // ── Vehicles & vehicle-like ────────────────────────────────────────────
  "vehicle",          // car vs bus vs boat vs helicopter
  "aircraft",         // plane vs helicopter vs drone
  "model",            // model car vs model plane vs fashion model

  // ── Wearables (category buckets) ───────────────────────────────────────
  "outerwear",        // jacket vs coat vs blazer vs cape
  "swimwear",         // different swimsuit types
  "shoe",             // ML Kit returns "shoe" as the catchall when it can't
                      // narrow to "sneakers"; could be sandal, boot, dress
                      // shoe, slipper. "sneakers" stays as a sharp label.

  // ── Toys & play (category buckets) ─────────────────────────────────────
  "toy",              // car toy vs doll vs blocks — extreme range
  "stuffed toy",      // bear vs bunny vs unicorn
  "plush",            // generic plush bucket

  // ── Jewellery & adornment ──────────────────────────────────────────────
  "jewellery",        // ring vs necklace vs bracelet vs earring
  "centrepiece",      // table centerpiece category
  "wreath",           // door wreath vs holiday wreath

  // ── Catchall multi-object labels ───────────────────────────────────────
  "product",          // ML Kit's broadest "this is a packaged thing" label
  "junk",             // generic catchall in ML Kit
  "plant", "flora",   // tree vs flower vs herb vs cactus
  "musical instrument", "musical",  // piano vs guitar vs drum vs flute
]);

// ─── Redis / Upstash ─────────────────────────────────────────────────────────

const REDIS_URL   = Deno.env.get("UPSTASH_REDIS_REST_URL")   ?? "";
const REDIS_TOKEN = Deno.env.get("UPSTASH_REDIS_REST_TOKEN") ?? "";
const CACHE_TTL_S = 14 * 24 * 60 * 60; // 14 days, organic-write path

const ENV_NAME: string = (() => {
  const fromEnv = Deno.env.get("CACHE_ENV_NAMESPACE")?.trim().toLowerCase();
  if (fromEnv && /^[a-z0-9_-]+$/.test(fromEnv)) return fromEnv;
  console.warn("[evaluate] CACHE_ENV_NAMESPACE not set or invalid — using 'default'.");
  return "default";
})();

// ─── Cache key builders (v6 — readable, no btoa on common path) ──────────────

const KEY_SEGMENT_MAX = 80;
const FULL_KEY_MAX    = 200;

/**
 * Normalize a label or property word for use in a Redis key. Keeps the
 * output human-readable so `redis-cli SCAN MATCH lexi:v6:verdict:apple:*`
 * works without script gymnastics.
 *
 * Steps (in order):
 *   1. lowercase, trim, collapse internal whitespace
 *   2. conservative depluralization (matches production v5 normalize)
 *   3. replace any non-[a-z0-9_-] sequence with single dash
 *   4. trim leading/trailing dashes
 *   5. cap to KEY_SEGMENT_MAX
 *
 * Pathological inputs (empty, all-special-chars, way too long) trigger
 * a fallback btoa hash in buildPerPropCacheKey — see there.
 */
function normalizeForKey(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/([a-z]{2,})([^se])s\b/g, "$1$2")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, KEY_SEGMENT_MAX);
}

function buildPerPropCacheKey(label: string, word: string): string {
  const nl = normalizeForKey(label);
  const nw = normalizeForKey(word);

  if (nl.length === 0 || nw.length === 0) {
    return `${ENV_NAME}:lexi:v6:verdict:_h:${btoa(`${label}::${word}`).replace(/=/g, "")}`;
  }

  const key = `${ENV_NAME}:lexi:v6:verdict:${nl}:${nw}`;
  if (key.length > FULL_KEY_MAX) {
    return `${ENV_NAME}:lexi:v6:verdict:_h:${btoa(`${label}::${word}`).replace(/=/g, "")}`;
  }
  return key;
}

function buildResolvedNameCacheKey(label: string): string {
  const nl = normalizeForKey(label);
  if (nl.length === 0) {
    return `${ENV_NAME}:lexi:v6:resolved:_h:${btoa(label).replace(/=/g, "")}`;
  }
  const key = `${ENV_NAME}:lexi:v6:resolved:${nl}`;
  if (key.length > FULL_KEY_MAX) {
    return `${ENV_NAME}:lexi:v6:resolved:_h:${btoa(label).replace(/=/g, "")}`;
  }
  return key;
}

/**
 * v6.1 — Alias key. Maps an ML-Kit-detected label (often misclassified)
 * to a canonical object name (Mistral-resolved). Used as a redirect layer
 * BEFORE the main verdict cache lookup so mislabeled scans converge on
 * the same canonical key as correctly-labeled scans of the same object.
 *
 * Read path: GET v6:alias:{detectedLabel} → if hit + confidence >= 0.5,
 * use alias.canonical as the key for verdict + resolved-name lookups.
 *
 * Write path: after a successful model call, if resolvedObjectName differs
 * from detectedLabel (after normalization), bump or create the alias entry.
 */
function buildAliasCacheKey(detectedLabel: string): string {
  const nl = normalizeForKey(detectedLabel);
  if (nl.length === 0) {
    return `${ENV_NAME}:lexi:v6:alias:_h:${btoa(detectedLabel).replace(/=/g, "")}`;
  }
  const key = `${ENV_NAME}:lexi:v6:alias:${nl}`;
  if (key.length > FULL_KEY_MAX) {
    return `${ENV_NAME}:lexi:v6:alias:_h:${btoa(detectedLabel).replace(/=/g, "")}`;
  }
  return key;
}

// ─── Cache value shapes (v6) ────────────────────────────────────────────────

// v6.2: "model-seed" added — distinguishes alias entries created from model
// introspection (canonical+aliases output) from "organic" entries observed
// from real ML Kit detections. Operator queries can filter by source to
// see which mechanism is producing the most cache value.
type WriteSource = "organic" | "prewarm" | "manual" | "model-seed";

interface CacheMetaV6 {
  model_id:   string;
  schema:     6;
  written_at: string; // ISO timestamp
  source:     WriteSource;
}

interface CachedVerdictV6 {
  v:       6;
  verdict: { score: number; passes: boolean; reasoning: string };
  kid_msg: AgeBandedString;
  nudge:   AgeBandedString | null;
  meta:    CacheMetaV6;
}

interface CachedResolvedNameV6 {
  v:    6;
  name: string;
  meta: CacheMetaV6;
}

/**
 * v6.1 — Alias entry. Maps mistralized canonical name to the noisy
 * detected label that ML Kit produces. Confidence and observed_count
 * grow over repeated confirmations so the alias is "advisory" until it
 * has enough evidence to be trusted.
 *
 * Confidence model:
 *   • new entry  = 0.6, observed_count = 1
 *   • confirmation (same detected → same canonical):
 *       confidence = min(1.0, confidence + 0.1), observed_count++
 *   • conflict (same detected → different canonical):
 *       confidence -= 0.1; if < 0.3, evict the alias entry entirely
 *
 * Read threshold: alias is used only if confidence >= 0.5. Below that,
 * the read path falls through to the original detectedLabel.
 */
interface CachedAliasV6 {
  v:               6;
  canonical:       string;        // normalized canonical name (matches verdict key segment)
  confidence:      number;        // 0.0–1.0; threshold for use is 0.5
  observed_count:  number;        // bumped on every confirmation
  first_seen:      string;        // ISO
  last_seen:       string;        // ISO
  meta:            CacheMetaV6;
}

// ─── Cache shape validators ──────────────────────────────────────────────────
//
// Strict. Anything failing returns null and emits a CACHE_SHAPE_INVALID
// log line so silent corruption surfaces in operator queries.

function isAgeBandedString(v: unknown): v is AgeBandedString {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.young === "string" && o.young.trim().length > 0
      && typeof o.older === "string" && o.older.trim().length > 0;
}

function isCacheMetaV6(v: unknown): v is CacheMetaV6 {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.model_id   === "string"
      && o.schema === 6
      && typeof o.written_at === "string"
      && (o.source === "organic" || o.source === "prewarm"
          || o.source === "manual" || o.source === "model-seed");
}

function isCachedVerdictV6(v: unknown): v is CachedVerdictV6 {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.v !== 6) return false;
  const verdict = o.verdict as Record<string, unknown> | undefined;
  if (!verdict || typeof verdict !== "object") return false;
  if (typeof verdict.score     !== "number")  return false;
  if (typeof verdict.passes    !== "boolean") return false;
  if (typeof verdict.reasoning !== "string")  return false;
  if (!isAgeBandedString(o.kid_msg)) return false;
  if (o.nudge !== null && !isAgeBandedString(o.nudge)) return false;
  if (!isCacheMetaV6(o.meta)) return false;
  return true;
}

function isCachedResolvedNameV6(v: unknown): v is CachedResolvedNameV6 {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.v !== 6) return false;
  if (typeof o.name !== "string" || o.name.trim().length === 0) return false;
  if (!isCacheMetaV6(o.meta)) return false;
  return true;
}

function isCachedAliasV6(v: unknown): v is CachedAliasV6 {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.v !== 6) return false;
  if (typeof o.canonical !== "string" || o.canonical.trim().length === 0) return false;
  if (typeof o.confidence !== "number"
      || Number.isNaN(o.confidence)
      || o.confidence < 0 || o.confidence > 1) return false;
  if (typeof o.observed_count !== "number"
      || !Number.isInteger(o.observed_count)
      || o.observed_count < 0) return false;
  if (typeof o.first_seen !== "string") return false;
  if (typeof o.last_seen  !== "string") return false;
  if (!isCacheMetaV6(o.meta)) return false;
  return true;
}

function logCacheShapeInvalid(key: string, raw: string, reason: string): void {
  // Distinctive prefix for log queries. If this fires regularly, a writer
  // is shipping malformed entries — investigate immediately.
  console.warn(
    `[evaluate] CACHE_SHAPE_INVALID key=${key} reason=${reason} ` +
    `raw_excerpt="${raw.slice(0, 120).replace(/\n/g, " ")}"`,
  );
}

// ─── Cache I/O ───────────────────────────────────────────────────────────────

async function cacheGetVerdict(key: string): Promise<CachedVerdictV6 | null> {
  if (!REDIS_URL) return null;
  try {
    const res  = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    const json = await res.json() as { result?: string | null };
    if (!json.result) return null;

    let parsed: unknown;
    try { parsed = JSON.parse(json.result); }
    catch { logCacheShapeInvalid(key, json.result, "json-parse-failed"); return null; }

    if (!isCachedVerdictV6(parsed)) {
      logCacheShapeInvalid(key, json.result, "shape-validation-failed");
      return null;
    }
    return parsed;
  } catch (e) {
    console.error(`[evaluate] cacheGetVerdict threw key=${key}:`, e);
    return null;
  }
}

async function cacheSetVerdict(
  key:      string,
  payload:  CachedVerdictV6,
): Promise<void> {
  if (!REDIS_URL) return;
  try {
    await fetch(REDIS_URL, {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["SET", key, JSON.stringify(payload), "EX", CACHE_TTL_S]),
    });
  } catch (e) {
    console.error(`[evaluate] cacheSetVerdict threw key=${key}:`, e);
  }
}

async function cacheGetResolvedName(key: string): Promise<CachedResolvedNameV6 | null> {
  if (!REDIS_URL) return null;
  try {
    const res  = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    const json = await res.json() as { result?: string | null };
    if (!json.result) return null;

    let parsed: unknown;
    try { parsed = JSON.parse(json.result); }
    catch { logCacheShapeInvalid(key, json.result, "json-parse-failed"); return null; }

    if (!isCachedResolvedNameV6(parsed)) {
      logCacheShapeInvalid(key, json.result, "shape-validation-failed");
      return null;
    }
    return parsed;
  } catch (e) {
    console.error(`[evaluate] cacheGetResolvedName threw key=${key}:`, e);
    return null;
  }
}

async function cacheSetResolvedName(
  key:           string,
  resolvedName:  string,
  modelId:       string,
  detectedLabel: string,
): Promise<void> {
  if (!REDIS_URL) return;

  // Skip the write when the model didn't correct anything — keeps the
  // resolved-name cache focused on real corrections.
  const a = normalizeForKey(detectedLabel);
  const b = normalizeForKey(resolvedName);
  if (a === b) return;

  const payload: CachedResolvedNameV6 = {
    v:    6,
    name: resolvedName,
    meta: {
      model_id:   modelId,
      schema:     6,
      written_at: new Date().toISOString(),
      source:     "organic",
    },
  };

  try {
    await fetch(REDIS_URL, {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["SET", key, JSON.stringify(payload), "EX", CACHE_TTL_S]),
    });
  } catch (e) {
    console.error(`[evaluate] cacheSetResolvedName threw key=${key}:`, e);
  }
}

// ─── v6.1 Alias I/O ──────────────────────────────────────────────────────────
//
// The alias layer maps noisy ML-Kit detected labels to canonical names.
// On read, we check the alias and (if confident enough) redirect verdict
// lookups to the canonical key. On write (after a successful model call),
// we bump or create the alias if the model corrected the label.

const ALIAS_READ_THRESHOLD     = 0.5;   // below this, alias is not used
const ALIAS_NEW_CONFIDENCE     = 0.6;   // initial confidence for a new alias (observed)
const ALIAS_CONFIRM_INCREMENT  = 0.1;   // bump on repeat confirmation
const ALIAS_CONFLICT_DECREMENT = 0.1;   // bump on disagreement
const ALIAS_EVICT_THRESHOLD    = 0.3;   // below this, evict alias entirely

// v6.2 — confidence at which we seed model-introspected aliases.
// Lower than ALIAS_NEW_CONFIDENCE because these are guesses (the model's
// theory of what someone else might call this object), not observations.
// First real-world confirmation will ratchet them up via ALIAS_CONFIRM_INCREMENT.
// First disagreement will drop them below ALIAS_EVICT_THRESHOLD and evict.
const ALIAS_MODEL_SEED_CONFIDENCE = 0.5;

async function cacheGetAlias(key: string): Promise<CachedAliasV6 | null> {
  if (!REDIS_URL) return null;
  try {
    const res  = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    const json = await res.json() as { result?: string | null };
    if (!json.result) return null;

    let parsed: unknown;
    try { parsed = JSON.parse(json.result); }
    catch { logCacheShapeInvalid(key, json.result, "json-parse-failed"); return null; }

    if (!isCachedAliasV6(parsed)) {
      logCacheShapeInvalid(key, json.result, "shape-validation-failed");
      return null;
    }
    return parsed;
  } catch (e) {
    console.error(`[evaluate] cacheGetAlias threw key=${key}:`, e);
    return null;
  }
}

async function cacheSetAlias(key: string, payload: CachedAliasV6): Promise<void> {
  if (!REDIS_URL) return;
  try {
    await fetch(REDIS_URL, {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["SET", key, JSON.stringify(payload), "EX", CACHE_TTL_S]),
    });
  } catch (e) {
    console.error(`[evaluate] cacheSetAlias threw key=${key}:`, e);
  }
}

async function cacheDeleteAlias(key: string): Promise<void> {
  if (!REDIS_URL) return;
  try {
    await fetch(REDIS_URL, {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["DEL", key]),
    });
  } catch (e) {
    console.error(`[evaluate] cacheDeleteAlias threw key=${key}:`, e);
  }
}

/**
 * v6.1 — Resolve a detected label to the name we should use as the cache
 * key. Falls back to detectedLabel if there's no alias or alias confidence
 * is below the read threshold.
 *
 * One Redis GET per request. Result is the canonical key segment to use
 * for verdict lookups.
 */
async function resolveCanonicalLabel(detectedLabel: string): Promise<{
  canonical:    string;       // the label to use for cache key construction
  aliasUsed:    boolean;      // true if we redirected to a canonical name
  aliasEntry:   CachedAliasV6 | null;
}> {
  if (!REDIS_URL) return { canonical: detectedLabel, aliasUsed: false, aliasEntry: null };

  const aliasKey   = buildAliasCacheKey(detectedLabel);
  const aliasEntry = await cacheGetAlias(aliasKey);

  if (aliasEntry && aliasEntry.confidence >= ALIAS_READ_THRESHOLD) {
    return {
      canonical:  aliasEntry.canonical,
      aliasUsed:  true,
      aliasEntry,
    };
  }

  return {
    canonical:  detectedLabel,
    aliasUsed:  false,
    aliasEntry,
  };
}

/**
 * v6.1 — Update the alias map after a successful model call. Three cases:
 *
 *   1. Model resolved to the same name as detected (after normalization):
 *      no alias needed — ML Kit was right. Skip.
 *
 *   2. Model resolved to a different name AND no existing alias:
 *      create a new alias with starting confidence 0.6.
 *
 *   3. Existing alias for this detected label:
 *      a. If new resolution agrees with stored canonical → confirm
 *         (confidence + 0.1, observed_count + 1)
 *      b. If new resolution disagrees with stored canonical → conflict
 *         (confidence - 0.1, observed_count + 1).
 *         If post-conflict confidence < 0.3 → evict the alias.
 */
async function updateAliasMap(
  detectedLabel:      string,
  resolvedObjectName: string,
  modelId:            string,
  existingAlias:      CachedAliasV6 | null,
): Promise<void> {
  const detectedNorm = normalizeForKey(detectedLabel);
  const resolvedNorm = normalizeForKey(resolvedObjectName);

  // Case 1 — ML Kit was right; no alias work needed.
  if (detectedNorm === resolvedNorm || resolvedNorm.length === 0) return;

  const aliasKey  = buildAliasCacheKey(detectedLabel);
  const nowIso    = new Date().toISOString();
  const baseMeta  = { model_id: modelId, schema: 6 as const, written_at: nowIso, source: "organic" as const };

  // Case 2 — no existing alias; create new at starting confidence.
  if (!existingAlias) {
    const payload: CachedAliasV6 = {
      v:               6,
      canonical:       resolvedNorm,
      confidence:      ALIAS_NEW_CONFIDENCE,
      observed_count:  1,
      first_seen:      nowIso,
      last_seen:       nowIso,
      meta:            baseMeta,
    };
    await cacheSetAlias(aliasKey, payload);
    console.log(
      `[evaluate] alias created: detected="${detectedNorm}" → canonical="${resolvedNorm}" ` +
      `confidence=${ALIAS_NEW_CONFIDENCE}`,
    );
    return;
  }

  // Case 3a — confirmation (existing canonical matches new resolution).
  if (existingAlias.canonical === resolvedNorm) {
    const newConfidence = Math.min(1.0, existingAlias.confidence + ALIAS_CONFIRM_INCREMENT);
    const payload: CachedAliasV6 = {
      ...existingAlias,
      confidence:     newConfidence,
      observed_count: existingAlias.observed_count + 1,
      last_seen:      nowIso,
      meta:           baseMeta,
    };
    await cacheSetAlias(aliasKey, payload);
    console.log(
      `[evaluate] alias confirmed: detected="${detectedNorm}" → canonical="${resolvedNorm}" ` +
      `confidence=${existingAlias.confidence.toFixed(2)}→${newConfidence.toFixed(2)} ` +
      `observed=${payload.observed_count}`,
    );
    return;
  }

  // Case 3b — conflict (new resolution disagrees with stored canonical).
  // Decrement confidence; if it drops below the evict threshold, delete
  // the alias entirely so a future scan starts fresh.
  const newConfidence = existingAlias.confidence - ALIAS_CONFLICT_DECREMENT;
  if (newConfidence < ALIAS_EVICT_THRESHOLD) {
    await cacheDeleteAlias(aliasKey);
    console.log(
      `[evaluate] alias evicted: detected="${detectedNorm}" prev_canonical="${existingAlias.canonical}" ` +
      `new_canonical="${resolvedNorm}" confidence=${existingAlias.confidence.toFixed(2)}→${newConfidence.toFixed(2)}`,
    );
    return;
  }

  // Conflict but not enough to evict — decay confidence, keep stored canonical.
  const payload: CachedAliasV6 = {
    ...existingAlias,
    confidence:     newConfidence,
    observed_count: existingAlias.observed_count + 1,
    last_seen:      nowIso,
    meta:           baseMeta,
  };
  await cacheSetAlias(aliasKey, payload);
  console.log(
    `[evaluate] alias conflict: detected="${detectedNorm}" stored_canonical="${existingAlias.canonical}" ` +
    `new_resolution="${resolvedNorm}" confidence=${existingAlias.confidence.toFixed(2)}→${newConfidence.toFixed(2)} ` +
    `(kept stored canonical)`,
  );
}

// ─── Quest flavor template fetch ─────────────────────────────────────────────
//
// Small in-process cache (60s TTL) keyed by quest_id so a parent doing a
// 5-scan session pays one DB hit total. Same pattern as feature_flags.

interface CachedFlavor { template: string | null; expiresAt: number }
const FLAVOR_TTL_MS    = 60_000;
const flavorCache      = new Map<string, CachedFlavor>();

async function fetchQuestFlavorTemplate(
  supabase: SupabaseClient,
  questId:  string | undefined,
): Promise<string | null> {
  if (!questId) return null;
  const now = Date.now();
  const c   = flavorCache.get(questId);
  if (c && c.expiresAt > now) return c.template;

  try {
    const { data, error } = await supabase
      .from("quests")
      .select("feedback_flavor_template")
      .eq("id", questId)
      .maybeSingle();

    if (error) {
      console.error(`[evaluate] fetchQuestFlavorTemplate error questId=${questId}:`, error.message);
      flavorCache.set(questId, { template: null, expiresAt: now + FLAVOR_TTL_MS });
      return null;
    }

    const raw      = (data as { feedback_flavor_template?: unknown } | null)?.feedback_flavor_template;
    const template = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
    flavorCache.set(questId, { template, expiresAt: now + FLAVOR_TTL_MS });
    return template;
  } catch (e) {
    console.error(`[evaluate] fetchQuestFlavorTemplate threw questId=${questId}:`, e);
    return null;
  }
}

// ─── scan_attempts logging ────────────────────────────────────────────────────

// v6.2 Phase 2 — cc1_enabled flag reader (60s in-process cache).
// Pattern mirrors tierRouting.ts's readGlobalProviderFlag. Keeps the
// per-request evaluate flow from re-fetching the same flag on every scan.
const CC1_FLAG_TTL_MS = 60_000;
let cc1EnabledCache: { value: boolean; expiresAt: number } | null = null;

async function readCc1EnabledFlag(supabase: SupabaseClient): Promise<boolean> {
  const now = Date.now();
  if (cc1EnabledCache && cc1EnabledCache.expiresAt > now) {
    return cc1EnabledCache.value;
  }
  try {
    const { data } = await supabase
      .from("feature_flags")
      .select("value")
      .eq("key", "cc1_enabled")
      .maybeSingle();
    const raw = (data as { value?: unknown } | null)?.value;
    const value = typeof raw === "string" && raw.trim().toLowerCase() === "true";
    cc1EnabledCache = { value, expiresAt: now + CC1_FLAG_TTL_MS };
    return value;
  } catch {
    cc1EnabledCache = { value: false, expiresAt: now + CC1_FLAG_TTL_MS };
    return false;
  }
}

/**
 * v6.2 Phase 2 — CC1 telemetry fields included in every log call.
 *
 *   cc1Skipped=true  → cc1_enabled was off; cc1Result not provided by client.
 *   cc1Skipped=false → CC1 was attempted. cc1ModelId is non-null on success,
 *                      null on CC1 error/timeout (client fell through).
 *   cc1Skipped=null  → caller didn't supply CC1 state (defensive default).
 *                      Should not happen with the v6.2 client.
 */
interface CC1Fields {
  cc1ModelId?:   string | null;
  cc1LatencyMs?: number  | null;
  cc1Skipped?:   boolean | null;
  cc1Canonical?: string  | null;
}

interface LogScanArgs extends CC1Fields {
  childId:       string;
  questId?:      string;
  detectedLabel: string;
  confidence?:   number;
  ipHash?:       string;
  result:        EvaluationResult;
}

async function logScanResult(
  supabase: SupabaseClient,
  opts:     LogScanArgs & {
    claudeLatencyMs: number;
    modelId:         string;
    isPrimaryCall:   boolean;  // v6.3 — true if routed to evaluate_primary_provider
  },
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
      model_id:          opts.modelId,
      is_primary_call:   opts.isPrimaryCall,   // v6.3 — drives get_evaluate_context.primary_calls_today
      cc1_model_id:      opts.cc1ModelId    ?? null,
      cc1_latency_ms:    opts.cc1LatencyMs  ?? null,
      cc1_skipped:       opts.cc1Skipped    ?? null,
      cc1_canonical:     opts.cc1Canonical  ?? null,
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
  supabase: SupabaseClient,
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
      claude_latency_ms: null,
      cache_hit:         true,
      model_id:          null,
      cc1_model_id:      opts.cc1ModelId    ?? null,
      cc1_latency_ms:    opts.cc1LatencyMs  ?? null,
      cc1_skipped:       opts.cc1Skipped    ?? null,
      cc1_canonical:     opts.cc1Canonical  ?? null,
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
  supabase: SupabaseClient,
  opts: {
    childId:       string;
    questId?:      string;
    detectedLabel: string;
    confidence?:   number;
    ipHash?:       string;
    isRateLimited: boolean;
  } & CC1Fields,
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
      model_id:          null,
      cc1_model_id:      opts.cc1ModelId    ?? null,
      cc1_latency_ms:    opts.cc1LatencyMs  ?? null,
      cc1_skipped:       opts.cc1Skipped    ?? null,
      cc1_canonical:     opts.cc1Canonical  ?? null,
    });
  } catch (e) {
    console.error("[evaluate] logScanBlocked INSERT failed:", e);
  }
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

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

async function hashIp(ip: string): Promise<string> {
  const encoded = new TextEncoder().encode(ip + (Deno.env.get("IP_HASH_SALT") ?? "lexi-lens"));
  const buf     = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

function extractIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || "unknown";
  const cf = headers.get("cf-connecting-ip");
  if (cf) return cf;
  return "unknown";
}

async function checkIpRateLimit(
  supabase: SupabaseClient,
  ipHash:   string,
): Promise<{ allowed: boolean; requestCount: number }> {
  const windowStart = new Date(Date.now() - IP_WINDOW_MS).toISOString();
  const { data: existing } = await supabase
    .from("ip_rate_limits")
    .select("request_count, window_start")
    .eq("ip_hash", ipHash)
    .maybeSingle();

  if (!existing || (existing as { window_start: string }).window_start < windowStart) {
    await supabase.from("ip_rate_limits").upsert({
      ip_hash:       ipHash,
      request_count: 1,
      window_start:  new Date().toISOString(),
    });
    return { allowed: true, requestCount: 1 };
  }

  const newCount = (existing as { request_count: number }).request_count + 1;
  await supabase.from("ip_rate_limits").update({ request_count: newCount }).eq("ip_hash", ipHash);
  return { allowed: newCount <= IP_LIMIT_PER_MINUTE, requestCount: newCount };
}

// ─── Main handler ────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
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
    cc1Result,
  } = body as Record<string, unknown>;

  // v6.2 Phase 2 — extract and validate CC1 result if present
  const cc1: { canonical: string; aliases: string[]; modelId: string; latencyMs: number } | null = (() => {
    if (!cc1Result || typeof cc1Result !== "object") return null;
    const r = cc1Result as Record<string, unknown>;
    if (typeof r.canonical !== "string" || r.canonical.length === 0) return null;
    if (typeof r.modelId !== "string") return null;
    if (typeof r.latencyMs !== "number") return null;
    const aliases = Array.isArray(r.aliases)
      ? (r.aliases as unknown[]).filter((a): a is string => typeof a === "string")
      : [];
    return {
      canonical: r.canonical.toLowerCase().trim(),
      aliases:   aliases.map((a) => a.toLowerCase().trim()).filter((a) => a.length > 0),
      modelId:   r.modelId,
      latencyMs: r.latencyMs,
    };
  })();

  // v6.2 Phase 2 — pre-built CC1 telemetry fields, shared by every log call.
  // cc1_skipped semantics:
  //   • cc1Result present → CC1 ran (cc1_skipped=false). cc1_model_id populated
  //     from cc1.modelId. On parse failure here we treat it as a malformed
  //     request and fall through with cc1_skipped=null (defensive).
  //   • cc1Result absent → either the flag is off OR an old client. Both
  //     map to cc1_skipped=true (CC1 didn't run by design for this scan).
  const cc1LogFields: CC1Fields = cc1
    ? { cc1ModelId: cc1.modelId, cc1LatencyMs: cc1.latencyMs, cc1Skipped: false, cc1Canonical: cc1.canonical }
    : { cc1ModelId: null,        cc1LatencyMs: null,          cc1Skipped: true,  cc1Canonical: null };

  const xpRates: XpRates = {
    firstTry:  typeof xp_reward_first_try   === "number" ? xp_reward_first_try   : 40,
    secondTry: typeof xp_reward_retry       === "number" ? xp_reward_retry       : 25,
    thirdPlus: typeof xp_reward_third_plus  === "number" ? xp_reward_third_plus  : 10,
  };

  if (typeof childId !== "string" || typeof detectedLabel !== "string" || typeof childAge !== "number") {
    return jsonResponse({ error: "Missing required fields" }, 400);
  }

  // v6.2 Phase 2 — Snapshot the cc1_enabled flag so the response can echo
  // it back to the client. Client uses this to refresh its session-bound
  // CC1-on/off cache without a separate /cc1?probe=1 round-trip. Cheap:
  // module-level 60s in-process cache (same pattern as tierRouting).
  const cc1EnabledFlagSnapshot = await readCc1EnabledFlag(supabase);

  // ── 2. IP rate limit ─────────────────────────────────────────────────────
  const ip     = extractIp(req.headers);
  const ipHash = await hashIp(ip);
  const ipRl   = await checkIpRateLimit(supabase, ipHash);
  if (!ipRl.allowed) {
    return jsonResponse({
      error:  "rate_limited_ip",
      childFriendly: "Whoa! Too many quick scans. Take a breath and try again in a minute.",
    }, 429);
  }

  // ── 3. Get evaluate context (scans today, primary calls today, tier, quest) ─
  const { data: ctxData, error: ctxError } = await supabase
    .rpc("get_evaluate_context", { p_child_id: childId, p_quest_id: questId ?? null });

  if (ctxError || !ctxData) {
    console.error("[evaluate] get_evaluate_context failed:", ctxError?.message);
    return jsonResponse({ error: "context_load_failed" }, 500);
  }

  const ctx = ctxData as {
    scans_today:         number;
    primary_calls_today: number;  // v6.3: renamed from haiku_calls_today
    subscription_tier:   string;
    quest_min_tier:      string | null;
    quest_exists:        boolean;
  };

  const primaryCallsToday = ctx.primary_calls_today;

  // Quest tier validation (preserved from v5.4)
  if (questId && ctx.quest_exists && ctx.quest_min_tier) {
    const tierRank = (t: string) => t === "free" ? 0
                                  : t === "tier1" || t === "paid" ? 1
                                  : t === "tier2" ? 2
                                  : t === "family" ? 3 : 0;
    if (tierRank(ctx.subscription_tier) < tierRank(ctx.quest_min_tier)) {
      console.warn(
        `[evaluate] tier_violation child_tier=${ctx.subscription_tier} ` +
        `quest_min_tier=${ctx.quest_min_tier} childId=${childId}`,
      );
      return jsonResponse({ error: "tier_required", required: ctx.quest_min_tier }, 403);
    }
  }

  // Daily scan cap
  const { capScansPerDay: dailyLimit } = await import("../_shared/tierConfig.ts")
    .then((m) => m.getTierLimits(supabase, ctx.subscription_tier));
  if (ctx.scans_today >= dailyLimit) {
    await logScanBlocked(supabase, {
      childId, questId: questId as string | undefined, detectedLabel,
      confidence: confidence as number | undefined, ipHash, isRateLimited: true,
      ...cc1LogFields,
    });
    return jsonResponse({
      error: "daily_limit_reached",
      childFriendly: "You've explored a lot today. Come back tomorrow, brave adventurer!",
    }, 429);
  }

  // ── 4. Per-property cache lookup ──────────────────────────────────────────
  const labelTrimmed   = detectedLabel.toLowerCase().trim();
  const isGenericLabel = GENERIC_LABELS.has(labelTrimmed);
  // v6.1: Basket labels (e.g. "tableware") apply to many distinct objects
  // with different property verdicts. Cache-bypass them like generic labels
  // to prevent serving wrong verdicts. See BASKET_LABELS comment for why.
  const isBasketLabel  = BASKET_LABELS.has(labelTrimmed);
  const attempts       = (failedAttempts as number | undefined) ?? 0;

  // v6.2 Phase 1: shouldUseCache split into READ vs WRITE.
  //
  // Why: with ML Kit kill-switched (v6.2 client), every Android scan now
  // arrives with detectedLabel="object" (generic). Under the old unified
  // shouldUseCache rule, this meant ALL writes were also bypassed — the
  // cache could never accumulate. CC1 (Phase 2) would then ship into an
  // empty cache.
  //
  // The split is safe because read and write key off different things:
  //   • READ keys off DETECTED label (untrusted post-ML-Kit). If we can't
  //     trust the lookup key, we can't trust the read. shouldReadCache
  //     stays exactly like shouldUseCache used to.
  //   • WRITE keys off the MODEL'S resolvedObjectName (canonical, trusted).
  //     The existing v6.1.3 input-contract guard (canonicalIsValid) further
  //     refuses writes when the canonical itself is generic/basket. So
  //     shouldWriteCache is the broader "did the model evaluate at all"
  //     gate; canonical validity is checked at write time.
  //
  // Result: with ML Kit gone, scans bypass cache lookup (no usable key) but
  // write under the model's canonical. By the time CC1 ships in Phase 2,
  // the cache holds a meaningful set of canonical→verdict mappings.
  const shouldReadCache  = !isGenericLabel && !isBasketLabel && attempts === 0;
  const shouldWriteCache = attempts === 0;

  // Carried for compatibility with logging code that still references
  // shouldUseCache as the "this scan participated in the cache system" flag.
  // Equivalent to shouldReadCache (the more restrictive of the two).
  const shouldUseCache = shouldReadCache;

  const pendingProperties: PropertyRequirement[] = Array.isArray(requiredProperties)
    ? (requiredProperties as Array<Record<string, unknown>>).map((p) => ({
        word:            typeof p.word            === "string" ? p.word            : "",
        definition:      typeof p.definition      === "string" ? p.definition      : "",
        evaluationHints: typeof p.evaluationHints === "string" ? p.evaluationHints : undefined,
      })).filter((p) => p.word.length > 0)
    : [];

  // v6.2 Phase 2: If CC1 provided a canonical, use it directly as the cache
  // lookup key. CC1 supersedes the alias-map for forward resolution — the
  // alias-map remains in use for non-CC1 clients and for ratchet-up of
  // observed alias confidences after a successful model call.
  //
  // When CC1 provides a canonical:
  //   • shouldReadCache is forced true (CC1 canonicals are by definition
  //     not "object"/"thing" — sanitization in cc1/index.ts already
  //     redirected those to canonical="object" which we still treat as
  //     generic via the GENERIC_LABELS check below).
  //   • CC1's canonical is checked against GENERIC_LABELS to preserve the
  //     bypass behavior for cases where CC1 punted to "object".
  //
  // When CC1 didn't provide one (old client, or flag off on client):
  //   • Existing alias-map resolution path runs (line 1066-style).
  const cc1CanonicalIsGeneric = cc1 ? GENERIC_LABELS.has(cc1.canonical) : false;
  const cc1CanonicalIsBasket  = cc1 ? BASKET_LABELS.has(cc1.canonical)  : false;
  const cc1CanonicalUsable    = cc1 !== null && !cc1CanonicalIsGeneric && !cc1CanonicalIsBasket;

  // v6.1: Resolve detected label to canonical name via the alias map BEFORE
  // verdict cache lookups. If ML Kit said "tableware" but we've previously
  // observed Mistral resolving that to "biscuit packet", we look up under
  // "biscuit packet" so this scan benefits from prior cache writes.
  // Falls back to detectedLabel when no confident alias exists.
  // Skipped for generic labels and retries (those bypass cache anyway).
  //
  // v6.2 Phase 2: CC1's canonical takes precedence when provided. The
  // alias-map call is short-circuited to avoid the Redis round-trip.
  const aliasResolution = cc1CanonicalUsable
    ? { canonical: cc1!.canonical, aliasUsed: false, aliasEntry: null as CachedAliasV6 | null }
    : shouldUseCache
      ? await resolveCanonicalLabel(detectedLabel)
      : { canonical: detectedLabel, aliasUsed: false, aliasEntry: null as CachedAliasV6 | null };

  // v6.2 Phase 2: With CC1's canonical in hand, cache reads are safe even
  // when detectedLabel="object" (the v6.2 Phase 1 bypass case). Override
  // shouldReadCache locally for this branch.
  const effectiveShouldReadCache = cc1CanonicalUsable ? true : shouldUseCache;

  if (cc1CanonicalUsable) {
    console.log(
      `[evaluate] cc1-canonical: "${cc1!.canonical}" aliases=${JSON.stringify(cc1!.aliases)} ` +
      `cc1_model=${cc1!.modelId} cc1_latency_ms=${cc1!.latencyMs} childId=${childId}`,
    );
  } else if (cc1 && !cc1CanonicalUsable) {
    console.log(
      `[evaluate] cc1-canonical-rejected: "${cc1.canonical}" ` +
      `reason=${cc1CanonicalIsGeneric ? "generic" : "basket"} ` +
      `falling back to alias-map. childId=${childId}`,
    );
  } else if (shouldUseCache) {
    console.log(
      `[evaluate] alias-resolve: detected="${normalizeForKey(detectedLabel)}" ` +
      `→ canonical="${normalizeForKey(aliasResolution.canonical)}" ` +
      `aliasUsed=${aliasResolution.aliasUsed}` +
      (aliasResolution.aliasEntry
        ? ` confidence=${aliasResolution.aliasEntry.confidence.toFixed(2)} ` +
          `observed=${aliasResolution.aliasEntry.observed_count}`
        : "") +
      ` childId=${childId}`,
    );
  }

  let cachedV6Properties: PropertyScoreV6[] = [];
  let missingProperties:  PropertyRequirement[] = pendingProperties;

  if (effectiveShouldReadCache && pendingProperties.length > 0) {
    const lookups = await Promise.all(
      pendingProperties.map(async (prop) => ({
        prop,
        hit: await cacheGetVerdict(buildPerPropCacheKey(aliasResolution.canonical, prop.word)),
      })),
    );

    cachedV6Properties = lookups
      .filter((l) => l.hit !== null)
      .map((l) => ({
        word:      l.prop.word,
        score:     l.hit!.verdict.score,
        reasoning: l.hit!.verdict.reasoning,
        passes:    l.hit!.verdict.passes,
        kid_msg:   l.hit!.kid_msg,
        nudge:     l.hit!.nudge,
      }));

    missingProperties = lookups.filter((l) => l.hit === null).map((l) => l.prop);

    console.log(
      `[evaluate] cache: cached=${cachedV6Properties.length} ` +
      `missing=${missingProperties.length} ` +
      `(${cachedV6Properties.length === pendingProperties.length ? "FULL HIT"
        : missingProperties.length === pendingProperties.length ? "FULL MISS" : "PARTIAL HIT"}) ` +
      `childId=${childId}`,
    );
  } else if (isGenericLabel) {
    console.log(`[evaluate] Skipping cache (generic label="${labelTrimmed}"): childId=${childId}`);
  } else if (isBasketLabel) {
    console.log(`[evaluate] Skipping cache (basket label="${labelTrimmed}" — covers many canonical objects): childId=${childId}`);
  }

  // ── 5. Quest flavor template (composed into childFeedback) ───────────────
  const questFlavorTemplate = await fetchQuestFlavorTemplate(supabase, questId as string | undefined);

  // ── 6. FULL CACHE HIT — skip model entirely ───────────────────────────────
  if (effectiveShouldReadCache && missingProperties.length === 0 && cachedV6Properties.length > 0) {
    const cachedResolvedRow = await cacheGetResolvedName(buildResolvedNameCacheKey(aliasResolution.canonical));
    const resolvedName      = cachedResolvedRow?.name;

    console.log(
      `[evaluate] resolved-name cache: ${
        cachedResolvedRow
          ? `HIT (producedBy=${cachedResolvedRow.meta.model_id}, name="${resolvedName}")`
          : "MISS — using detectedLabel"
      } childId=${childId}`,
    );

    const composed = composeFinalResult({
      detectedLabel,
      resolvedName,
      freshProperties:     [],
      cachedProperties:    cachedV6Properties,
      childAge:            childAge as number,
      failedAttempts:      attempts,
      questFlavorTemplate,
      xpRates,
    });

    const scanAttemptId = await logScanCacheHit(supabase, {
      childId, questId: questId as string | undefined, detectedLabel,
      confidence: confidence as number | undefined, ipHash, result: composed,
      ...cc1LogFields,
    });

    return jsonResponse({
      ...composed,
      _cacheHit:      true,
      _scanAttemptId: scanAttemptId,
      _rateLimit:     buildAlertFlags(ctx.scans_today, dailyLimit, ctx.subscription_tier),
      _cc1Enabled:    cc1EnabledFlagSnapshot,
    });
  }

  // ── 7. Pick adapter for this request ──────────────────────────────────────
  const routing = await pickAdapterForRequest(supabase, ctx.subscription_tier, primaryCallsToday);
  console.log(
    `[evaluate] routing: model=${routing.adapter.id} reason=${routing.reason} ` +
    `parent_tier=${ctx.subscription_tier} primary_today=${primaryCallsToday}/${routing.primaryCallsPerDay} ` +
    `is_primary=${routing.isPrimary} childId=${childId}`,
  );

  // ── 8. Call the model (full miss or partial hit) ─────────────────────────
  const modelStart = Date.now();
  let evaluation: {
    result:             EvaluationResult;
    freshProperties:    PropertyScoreV6[];
    resolvedObjectName: string;
    aliases:            string[];   // v6.2 — model-introspected synonyms
  };

  try {
    evaluation = await evaluateObject(
      {
        detectedLabel,
        confidence:                    confidence as number,
        frameBase64:                   frameBase64 as string | null | undefined,
        requiredProperties:            missingProperties,
        previouslyEvaluatedProperties: cachedV6Properties.length > 0 ? cachedV6Properties : undefined,
        childAge:                      childAge as number,
        failedAttempts:                attempts,
        questName:                     questName as string | undefined,
        questFlavorTemplate,
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
      childId, questId: questId as string | undefined, detectedLabel,
      confidence: confidence as number | undefined, ipHash, isRateLimited: false,
      ...cc1LogFields,
    });
    return jsonResponse({ error: msg }, 500);
  }

  const modelLatencyMs = Date.now() - modelStart;
  const modelId        = routing.adapter.id;

  // ── 9. Write fresh properties to cache (per-property + resolved-name + alias) ─
  //
  // v6.1: cache writes use the canonical name as the key segment, not the
  // raw detectedLabel. Canonical = evaluation.resolvedObjectName if the
  // model produced one, else the alias-resolved canonical, else the raw
  // detectedLabel as before.
  //
  // This means:
  //   • Mistral-correct scans (model returns a resolvedName) seed the
  //     canonical cache directly.
  //   • Subsequent ML-Kit-mislabeled scans of the same object find the
  //     same canonical entries via the alias redirect.
  //   • Backward compat: existing v6 cache entries keyed on raw
  //     detectedLabel keep serving for their TTL; new writes from v6.1
  //     converge on canonical keys.
  const canonicalForWrite =
    evaluation.resolvedObjectName && evaluation.resolvedObjectName.trim().length > 0
      ? evaluation.resolvedObjectName
      : aliasResolution.canonical;

  // v6.1.3 — Symmetric input contract: the read path bypasses cache for
  // GENERIC_LABELS and BASKET_LABELS. The write path now refuses to
  // create cache or alias entries when the MODEL'S resolvedObjectName
  // normalizes into the same buckets. Without this guard, any model
  // that punts (Gemini occasionally returns literal "object", "thing",
  // or "tableware" when uncertain) creates polluting bucket entries
  // that future generic-label-bypassed scans can't even look up but
  // the alias map happily redirects future ML-mislabeled scans into.
  //
  // Observed in PROD logs 2026-05-10: Gemini returned resolvedObjectName=
  // "object" on a "hair"-detected scan. Cache wrote v6:verdict:object:*
  // entries; alias mapped hair→object. Future "hair" detections would
  // pull those junk verdicts.
  const canonicalNormalized = canonicalForWrite.toLowerCase().trim();
  const canonicalIsGeneric  = GENERIC_LABELS.has(canonicalNormalized);
  const canonicalIsBasket   = BASKET_LABELS.has(canonicalNormalized);
  const canonicalIsValid    = !canonicalIsGeneric && !canonicalIsBasket && canonicalNormalized.length > 0;

  // v6.2: write gate changed from shouldUseCache → shouldWriteCache. See
  // the split definition above. Reads still bypass for generic/basket
  // detected labels; writes proceed under the model's canonical.
  if (shouldWriteCache && !canonicalIsValid) {
    console.warn(
      `[evaluate] CACHE_WRITE_SKIPPED canonical="${canonicalNormalized}" ` +
      `reason=${canonicalIsGeneric ? "generic-canonical" : canonicalIsBasket ? "basket-canonical" : "empty-canonical"} ` +
      `detectedLabel="${detectedLabel}" childId=${childId}`,
    );
  }

  if (shouldWriteCache && canonicalIsValid && evaluation.freshProperties.length > 0) {
    await Promise.all(evaluation.freshProperties.map(async (p) => {
      const key: string = buildPerPropCacheKey(canonicalForWrite, p.word);
      const payload: CachedVerdictV6 = {
        v: 6,
        verdict: { score: p.score, passes: p.passes, reasoning: p.reasoning },
        kid_msg: p.kid_msg,
        nudge:   p.nudge,
        meta: {
          model_id:   modelId,
          schema:     6,
          written_at: new Date().toISOString(),
          source:     "organic",
        },
      };
      await cacheSetVerdict(key, payload);
    }));

    if (evaluation.resolvedObjectName && evaluation.resolvedObjectName.trim().length > 0) {
      // Resolved-name cache: keyed under the canonical so a future scan
      // that lands on the same canonical (via alias or direct match) finds
      // the resolved name.
      await cacheSetResolvedName(
        buildResolvedNameCacheKey(canonicalForWrite),
        evaluation.resolvedObjectName,
        modelId,
        canonicalForWrite,
      );

      // Alias map update (detected-label observation):
      // updateAliasMap handles all the cases (no-op when detected ≈ resolved,
      // create-new, confirm, conflict, evict). This is the OBSERVED alias
      // — what ML Kit actually returned and we mapped to a canonical.
      await updateAliasMap(
        detectedLabel,
        evaluation.resolvedObjectName,
        modelId,
        aliasResolution.aliasEntry,
      );

      // v6.2 — Model-introspected aliases (synonym pre-seeding).
      //
      // The model emits a small list of common synonyms alongside the
      // canonical (schema added in v6.2 evaluateObject.ts). Each one becomes
      // a low-confidence alias entry pointing to the canonical. Future scans
      // where ANOTHER model (or a different angle / lighting) returns one of
      // those synonyms as detectedLabel can hit the cache via alias resolve.
      //
      // Lower starting confidence than detected-label aliases (0.5 vs the
      // ALIAS_NEW_CONFIDENCE used by updateAliasMap) because synonyms are
      // model-introspected, not observed. They're guesses about what other
      // observers MIGHT call this object. Real observation will quickly
      // ratchet confidence up via ALIAS_CONFIRM_INCREMENT or evict via
      // ALIAS_CONFLICT_DECREMENT.
      //
      // Block-list: parseModelOutput already filters short/duplicate aliases.
      // Here we additionally filter aliases that match the canonical itself
      // (defense-in-depth) and aliases that normalize into GENERIC/BASKET
      // buckets (same input contract as canonicalIsValid).
      if (Array.isArray(evaluation.aliases) && evaluation.aliases.length > 0) {
        for (const aliasRaw of evaluation.aliases) {
          const aliasNorm = aliasRaw.toLowerCase().trim();
          if (aliasNorm.length < 3)                continue;
          if (aliasNorm === canonicalNormalized)   continue;
          if (GENERIC_LABELS.has(aliasNorm))       continue;
          if (BASKET_LABELS.has(aliasNorm))        continue;

          // Don't clobber existing observed aliases — they have real
          // observation backing them. Only seed where there's nothing yet.
          const aliasKeyForRead = buildAliasCacheKey(aliasRaw);
          const existing = await cacheGetAlias(aliasKeyForRead);
          if (existing) {
            // Existing alias maps to a different canonical — leave alone;
            // observed data wins over model introspection.
            continue;
          }

          // Seed a new alias entry at low confidence (0.5).
          const seededPayload: CachedAliasV6 = {
            v:               6,
            canonical:       canonicalNormalized,
            confidence:      ALIAS_MODEL_SEED_CONFIDENCE,
            observed_count:  0,                    // 0 = never observed, only seeded
            first_seen:      new Date().toISOString(),
            last_seen:       new Date().toISOString(),
            meta: {
              model_id:   modelId,
              schema:     6,
              written_at: new Date().toISOString(),
              source:     "model-seed",            // distinguishes from "organic"
            },
          };
          await cacheSetAlias(aliasKeyForRead, seededPayload);
          console.log(
            `[evaluate] alias seeded: alias="${aliasNorm}" → canonical="${canonicalNormalized}" ` +
            `confidence=${ALIAS_MODEL_SEED_CONFIDENCE} source=model-seed`,
          );
        }
      }

      // v6.2 Phase 2 — CC1-supplied aliases (alongside model-introspected).
      //
      // When CC1 returned aliases ("bottle" + ["water bottle", "drink bottle"]),
      // those are evidence that downstream scans of the same object MIGHT
      // arrive with any of those alias names as the resolvedObjectName (e.g.,
      // a different evaluate call with a slightly different angle resolves
      // it as "drink bottle"). Seeding them now means future ML-Kit-less
      // scans that happen to fall back to detectedLabel→alias-map can still
      // find this canonical via "drink bottle"→"water bottle".
      //
      // Same low confidence as model-seed (these are also guesses, not
      // observed); same block-list. Only seeds when there's nothing
      // already at that alias key.
      if (cc1 && cc1.aliases.length > 0 && canonicalNormalized === cc1.canonical) {
        for (const aliasRaw of cc1.aliases) {
          const aliasNorm = aliasRaw.toLowerCase().trim();
          if (aliasNorm.length < 3)                continue;
          if (aliasNorm === canonicalNormalized)   continue;
          if (GENERIC_LABELS.has(aliasNorm))       continue;
          if (BASKET_LABELS.has(aliasNorm))        continue;

          const aliasKeyForRead = buildAliasCacheKey(aliasRaw);
          const existing = await cacheGetAlias(aliasKeyForRead);
          if (existing) continue;

          const seededPayload: CachedAliasV6 = {
            v:               6,
            canonical:       canonicalNormalized,
            confidence:      ALIAS_MODEL_SEED_CONFIDENCE,
            observed_count:  0,
            first_seen:      new Date().toISOString(),
            last_seen:       new Date().toISOString(),
            meta: {
              model_id:   cc1.modelId,
              schema:     6,
              written_at: new Date().toISOString(),
              source:     "model-seed",
            },
          };
          await cacheSetAlias(aliasKeyForRead, seededPayload);
          console.log(
            `[evaluate] alias seeded (CC1): alias="${aliasNorm}" → canonical="${canonicalNormalized}" ` +
            `confidence=${ALIAS_MODEL_SEED_CONFIDENCE} source=cc1-seed cc1_model=${cc1.modelId}`,
          );
        }
      }
    }
  }

  // v6.2 Phase 2 — CC1/evaluate disagreement signal (log only; no UX impact).
  // Useful for measuring whether CC1's cheap-canonical step is accurate enough
  // to be the cache key. Frequent disagreement = CC1 over-generalizing or
  // mis-classifying. The actual scan is logged below regardless; this is
  // just a greppable signal for post-launch SQL.
  if (cc1 && cc1.canonical !== canonicalNormalized && !cc1CanonicalIsGeneric) {
    console.warn(
      `[evaluate] cc1-disagreement cc1="${cc1.canonical}" evaluate="${canonicalNormalized}" ` +
      `cc1_model=${cc1.modelId} eval_model=${modelId} childId=${childId}`,
    );
  }

  // ── 10. Log scan_attempts and respond ─────────────────────────────────────
  const scanAttemptId = await logScanResult(supabase, {
    childId, questId: questId as string | undefined, detectedLabel,
    confidence: confidence as number | undefined, ipHash,
    result: evaluation.result, claudeLatencyMs: modelLatencyMs, modelId,
    isPrimaryCall: routing.isPrimary,
    ...cc1LogFields,
  });

  return jsonResponse({
    ...evaluation.result,
    _cacheHit:      false,
    _scanAttemptId: scanAttemptId,
    _rateLimit:     buildAlertFlags(ctx.scans_today, dailyLimit, ctx.subscription_tier),
    _routing:       { reason: routing.reason, modelId },
    _cc1Enabled:    cc1EnabledFlagSnapshot,
  });
});

// utcMidnight is exported for tests; not currently used inside this file
export { utcMidnight };
