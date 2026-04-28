/**
 * useLexiEvaluate.ts
 * Lexi-Lens — client-side hook for the evaluate Edge Function.
 *
 * v3.5 additions (Rate Limiting + Abuse Prevention):
 *   • EvaluateStatus gains "rate_limited" (HTTP 429 from Edge Function)
 *   • EvaluationResult gains _rateLimit: RateLimitInfo | undefined
 *   • useLexiEvaluate exposes:
 *       - rateLimitCode   — "DAILY_QUOTA" | "IP_LIMIT" | null
 *       - scansToday      — number (updated on every successful response)
 *       - dailyLimit      — 50 (constant from server)
 *       - approachingLimit — true when ≥ 80% used (for parent alert banner)
 *       - resetsAt        — ISO string of midnight UTC (for countdown timer)
 *   • callEdgeFunction now handles 429 responses as structured RateLimitError,
 *     no longer retried (rate limits are intentional, not transient).
 *
 * v3.4 additions (Redis Response Caching):
 *   • EvaluationResult gains _cacheHit: boolean (set by Edge Function)
 *   • useLexiEvaluate exposes cacheHit boolean for VerdictCard to show ⚡ badge
 *   • "converting" status is skipped on cache hits (no need to encode image)
 *
 * v1.5 additions (Proficiency-Based Vocabulary):
 *   • EvaluatePayload gains masteryProfile: MasteryEntry[]
 *   • After every verdict, calls updateMastery() for the evaluated word.
 *   • Returns masteryResult so VerdictCard can trigger "Word Mastered!" celebration.
 *
 * FIXES applied:
 *   • [BUG] updateMastery() was called with 4 positional arguments but
 *     MasteryService.ts defines it with a single opts object of 6 fields.
 *     The two missing fields were childAge and currentMastery.
 *     currentMastery is now sourced from payload.masteryProfile by matching
 *     on the currentWord; defaults to 0 (novice) if not yet in the profile.
 *   • [LOGS] Removed two development console.log statements:
 *       - "[LexiEvaluate] ⚡ Cache hit"
 *       - "[LexiEvaluate] ⚠ Approaching daily limit"
 *
 * Dependencies:
 *   npm install @supabase/supabase-js
 *   npx expo install expo-file-system
 */

import { useState, useCallback, useRef } from "react";
import * as FileSystem from "expo-file-system";
import { supabase } from "../lib/supabase";
import {
  updateMastery,
  type MasteryEntry,
  type MasteryUpdateResult,
} from "../services/MasteryService";

// ─── Types ────────────────────────────────────────────────────────────────────

export type EvaluateStatus =
  | "idle"
  | "converting"
  | "evaluating"
  | "match"
  | "no-match"
  | "error"
  | "rate_limited";   // v3.5 — HTTP 429 from Edge Function

export type RateLimitCode = "DAILY_QUOTA" | "IP_LIMIT";

/** Shape of the _rateLimit block returned by the Edge Function */
export interface RateLimitInfo {
  scansToday:       number;
  dailyLimit:       number;
  approachingLimit: boolean;
  limitReached:     boolean;
}

/** Structured error payload returned by Edge Function on HTTP 429 */
export interface RateLimitError {
  error:       "rate_limit_exceeded";
  code:        RateLimitCode;
  scansToday?: number;
  limit?:      number;
  resetsAt?:   string;
  message?:    string;
  retryAfter?: number;  // seconds (IP_LIMIT only)
}

export interface PropertyScore {
  word:      string;
  score:     number;
  reasoning: string;
  passes:    boolean;
}

export interface EvaluationResult {
  resolvedObjectName: string;
  properties:         PropertyScore[];
  overallMatch:       boolean;
  childFeedback:      string;
  nudgeHint?:         string | null;
  xpAwarded:          number;
  /** v3.4 — true when result was served from Redis cache */
  _cacheHit?:         boolean;
  /** v3.5 — rate-limit telemetry from Edge Function */
  _rateLimit?:        RateLimitInfo;
}

export interface EvaluatePayload {
  childId:       string;
  questId:       string;
  questName?:    string;
  detectedLabel: string;
  confidence:    number;
  frameUri?:           string | null;
  frameBase64Already?: string | null;
  requiredProperties: Array<{
    word:             string;
    definition:       string;
    evaluationHints?: string;
  }>;
  childAge:        number;
  failedAttempts?: number;
  masteryProfile?: MasteryEntry[];
  currentWord?:    string;
  alreadyFoundWords?: string[];
}

interface UseLexiEvaluateReturn {
  status:           EvaluateStatus;
  result:           EvaluationResult | null;
  error:            string | null;
  /** v1.5 — non-null when a mastery update occurred */
  masteryResult:    MasteryUpdateResult | null;
  /** v3.4 — true when the last result came from Redis cache (< 10 ms) */
  cacheHit:         boolean;
  // ── v3.5 rate limit fields ──────────────────────────────────────────────
  /** "DAILY_QUOTA" | "IP_LIMIT" | null */
  rateLimitCode:    RateLimitCode | null;
  /** How many Claude calls this child has made today (from server) */
  scansToday:       number;
  /** Always 50 — the server-side constant */
  dailyLimit:       number;
  /** True when scansToday >= 80% of dailyLimit — show parent alert */
  approachingLimit: boolean;
  /** ISO UTC midnight — when the quota resets */
  resetsAt:         string | null;
  // ───────────────────────────────────────────────────────────────────────
  evaluate:         (payload: EvaluatePayload) => Promise<void>;
  reset:            () => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_RETRIES            = 2;
const BASE_RETRY_DELAY_MS    = 800;
const MAX_FRAME_BASE64_CHARS = 1_600_000;
const EDGE_FUNCTION_NAME     = "evaluate";

// ─── Custom error for structured rate-limit responses ─────────────────────────

class RateLimitResponseError extends Error {
  public readonly payload: RateLimitError;
  constructor(payload: RateLimitError) {
    super(payload.message ?? "Rate limit exceeded");
    this.name    = "RateLimitResponseError";
    this.payload = payload;
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

async function uriToBase64(uri: string): Promise<string | null> {
  try {
    const base64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    if (base64.length > MAX_FRAME_BASE64_CHARS) {
      console.warn("[LexiEvaluate] Frame too large — sending without image");
      return null;
    }
    return base64;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callEdgeFunction(
  body:    object,
  attempt: number = 0
): Promise<EvaluationResult> {
  const { data, error } = await supabase.functions.invoke<EvaluationResult | RateLimitError>(
    EDGE_FUNCTION_NAME,
    { body }
  );

  // ── v3.5: Handle HTTP 429 (rate limit) ──────────────────────────────────
  if (data && (data as RateLimitError).error === "rate_limit_exceeded") {
    throw new RateLimitResponseError(data as RateLimitError);
  }

  if (error) {
    const isTransient =
      error.message.includes("fetch")   ||
      error.message.includes("network") ||
      error.message.includes("timeout");

    if (isTransient && attempt < MAX_RETRIES) {
      await sleep(BASE_RETRY_DELAY_MS * Math.pow(2, attempt));
      return callEdgeFunction(body, attempt + 1);
    }
    throw new Error(error.message ?? "Evaluation failed");
  }

  if (!data) throw new Error("Empty response from evaluation service");
  return data as EvaluationResult;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useLexiEvaluate(): UseLexiEvaluateReturn {
  const [status,           setStatus]           = useState<EvaluateStatus>("idle");
  const [result,           setResult]           = useState<EvaluationResult | null>(null);
  const [error,            setError]            = useState<string | null>(null);
  const [masteryResult,    setMasteryResult]    = useState<MasteryUpdateResult | null>(null);
  const [cacheHit,         setCacheHit]         = useState<boolean>(false);
  // v3.5
  const [rateLimitCode,    setRateLimitCode]    = useState<RateLimitCode | null>(null);
  const [scansToday,       setScansToday]       = useState<number>(0);
  const [dailyLimit,       setDailyLimit]       = useState<number>(50);
  const [approachingLimit, setApproachingLimit] = useState<boolean>(false);
  const [resetsAt,         setResetsAt]         = useState<string | null>(null);

  const inFlight = useRef(false);

  const evaluate = useCallback(async (payload: EvaluatePayload) => {
    if (inFlight.current) return;
    inFlight.current = true;

    setResult(null);
    setError(null);
    setMasteryResult(null);
    setCacheHit(false);
    setRateLimitCode(null);

    try {
      // ── Step 1: Convert frame URI to base64 ─────────────────────────────
      let frameBase64: string | null = null;
      const attempt = payload.failedAttempts ?? 0;

      if (payload.frameBase64Already) {
        frameBase64 = payload.frameBase64Already;
      } else if (payload.frameUri && attempt > 0) {
        setStatus("converting");
        frameBase64 = await uriToBase64(payload.frameUri);
      }

      // ── Step 2: Call Edge Function (IP → quota → Redis → Claude) ────────
      setStatus("evaluating");

      const evaluationResult = await callEdgeFunction({
        childId:            payload.childId,
        questId:            payload.questId,
        questName:          payload.questName,
        detectedLabel:      payload.detectedLabel,
        confidence:         payload.confidence,
        frameBase64,
        requiredProperties: payload.requiredProperties,
        childAge:           payload.childAge,
        failedAttempts:     attempt,
        masteryProfile:     payload.masteryProfile ?? [],
        alreadyFoundWords:  payload.alreadyFoundWords ?? [],
      });

      // ── Step 3: Record cache hit flag ────────────────────────────────────
      setCacheHit(evaluationResult._cacheHit === true);

      // ── Step 4: v3.5 — Update rate-limit telemetry from server ──────────
      if (evaluationResult._rateLimit) {
        const rl = evaluationResult._rateLimit;
        setScansToday(rl.scansToday);
        setDailyLimit(rl.dailyLimit);
        setApproachingLimit(rl.approachingLimit);
      }

      setResult(evaluationResult);
      setStatus(evaluationResult.overallMatch ? "match" : "no-match");

      // ── Step 5: Update mastery for the evaluated word (v1.5) ─────────────
      //
      // FIX: The previous call used 4 positional arguments and was missing
      //   `childAge` and `currentMastery`. MasteryService.updateMastery()
      //   expects a single opts object with all 6 fields.
      //
      //   currentMastery is sourced from payload.masteryProfile by matching
      //   on the word. Defaults to 0 (novice) if the word isn't in the
      //   profile yet (i.e. first time the child encounters this word).
      //
      if (payload.currentWord) {
        const wordScore = evaluationResult.properties.find(
          (p) => p.word.toLowerCase() === payload.currentWord!.toLowerCase()
        );
        const wordPassed = wordScore?.passes ?? evaluationResult.overallMatch;

        const definition = payload.requiredProperties.find(
          (p) => p.word.toLowerCase() === payload.currentWord!.toLowerCase()
        )?.definition ?? "";

        // Look up the child's existing mastery score for this word so the
        // update function can compute the correct delta.
        const currentMastery = payload.masteryProfile?.find(
          (mp) => mp.word.toLowerCase() === payload.currentWord!.toLowerCase()
        )?.mastery ?? 0;

        const mResult = await updateMastery({
          childId:        payload.childId,
          word:           payload.currentWord,
          definition,
          childAge:       payload.childAge,
          success:        wordPassed,
          currentMastery,
        });

        if (mResult) setMasteryResult(mResult);
      }
    } catch (err) {
      // ── v3.5: Rate limit error — friendly handling ───────────────────────
      if (err instanceof RateLimitResponseError) {
        const { code, scansToday: s, limit, resetsAt: ra } = err.payload;
        setRateLimitCode(code);
        if (s !== undefined)     setScansToday(s);
        if (limit !== undefined) setDailyLimit(limit);
        if (ra)                  setResetsAt(ra);
        setStatus("rate_limited");
        setError(err.message);
        return;
      }

      const msg = err instanceof Error ? err.message : "Something went wrong";
      setError(msg);
      setStatus("error");
    } finally {
      inFlight.current = false;
    }
  }, []);

  const reset = useCallback(() => {
    setStatus("idle");
    setResult(null);
    setError(null);
    setMasteryResult(null);
    setCacheHit(false);
    setRateLimitCode(null);
    // Keep scansToday / dailyLimit — they reflect real server state
    inFlight.current = false;
  }, []);

  return {
    status,
    result,
    error,
    masteryResult,
    cacheHit,
    rateLimitCode,
    scansToday,
    dailyLimit,
    approachingLimit,
    resetsAt,
    evaluate,
    reset,
  };
}
