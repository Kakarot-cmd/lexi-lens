/**
 * useLexiEvaluate.ts
 * Lexi-Lens — client-side hook for the evaluate Edge Function.
 *
 * v1.5 fix: updateWordMastery + markWordRetired were never added to gameStore.
 * Now calls MasteryService.updateMastery() directly — no store dependency needed.
 *
 * v1.5 additions (Proficiency-Based Vocabulary):
 *   • EvaluatePayload gains masteryProfile: MasteryEntry[]
 *   • After every verdict, calls updateMastery() for the evaluated word.
 *   • Returns masteryResult so VerdictCard can trigger "Word Mastered!" celebration.
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
  | "error";

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
  /**
   * Property words already found in previous scans this session.
   * Forwarded to the Edge Function so Claude knows what's already done
   * and doesn't reference those components in its feedback.
   */
  alreadyFoundWords?: string[];
}

interface UseLexiEvaluateReturn {
  status:        EvaluateStatus;
  result:        EvaluationResult | null;
  error:         string | null;
  /** v1.5 — non-null when a mastery update occurred */
  masteryResult: MasteryUpdateResult | null;
  evaluate:      (payload: EvaluatePayload) => Promise<void>;
  reset:         () => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_RETRIES            = 2;
const BASE_RETRY_DELAY_MS    = 800;
const MAX_FRAME_BASE64_CHARS = 1_600_000;
const EDGE_FUNCTION_NAME     = "evaluate";

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
  const { data, error } = await supabase.functions.invoke<EvaluationResult>(
    EDGE_FUNCTION_NAME,
    { body }
  );

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
  return data;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useLexiEvaluate(): UseLexiEvaluateReturn {
  const [status,        setStatus]        = useState<EvaluateStatus>("idle");
  const [result,        setResult]        = useState<EvaluationResult | null>(null);
  const [error,         setError]         = useState<string | null>(null);
  const [masteryResult, setMasteryResult] = useState<MasteryUpdateResult | null>(null);

  const inFlight = useRef(false);

  const evaluate = useCallback(async (payload: EvaluatePayload) => {
    if (inFlight.current) return;
    inFlight.current = true;

    setResult(null);
    setError(null);
    setMasteryResult(null);

    try {
      // ── Step 1: Convert frame URI to base64 ───────────────────────────
      let frameBase64: string | null = null;
      if (payload.frameBase64Already) {
        frameBase64 = payload.frameBase64Already;
      } else if (payload.frameUri) {
        setStatus("converting");
        frameBase64 = await uriToBase64(payload.frameUri);
      }

      // ── Step 2: Call Edge Function → Claude ───────────────────────────
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
        failedAttempts:     payload.failedAttempts ?? 0,
        masteryProfile:     payload.masteryProfile ?? [],
        alreadyFoundWords:  payload.alreadyFoundWords ?? [],
      });

      setResult(evaluationResult);
      setStatus(evaluationResult.overallMatch ? "match" : "no-match");

      // ── Step 3: Update mastery for the evaluated word (v1.5) ──────────
      //
      // Calls MasteryService.updateMastery() directly — no store action needed.
      // The service handles: DB persist → retirement check → synonym fetch.

      if (payload.currentWord) {
        const wordScore = evaluationResult.properties.find(
          (p) => p.word.toLowerCase() === payload.currentWord!.toLowerCase()
        );
        const wordPassed = wordScore?.passes ?? evaluationResult.overallMatch;

        // Look up the definition from requiredProperties for the retirement prompt
        const definition = payload.requiredProperties.find(
          (p) => p.word.toLowerCase() === payload.currentWord!.toLowerCase()
        )?.definition ?? "";

        try {
          const mResult = await updateMastery({
            childId:        payload.childId,
            word:           payload.currentWord,
            definition,
            childAge:       payload.childAge,
            success:        wordPassed,
            // Server-side math is authoritative; 0 is a safe local fallback
            currentMastery: 0,
          });
          setMasteryResult(mResult);
        } catch {
          // Mastery update is non-critical — scan result is already saved
          console.warn("[LexiEvaluate] Mastery update failed silently");
        }
      }

    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong";
      setError(message);
      setStatus("error");
    } finally {
      inFlight.current = false;
    }
  }, []); // no store deps — MasteryService is imported directly

  const reset = useCallback(() => {
    if (inFlight.current) return;
    setStatus("idle");
    setResult(null);
    setError(null);
    setMasteryResult(null);
  }, []);

  return { status, result, error, masteryResult, evaluate, reset };
}

// ─── UI status helpers ────────────────────────────────────────────────────────

export const STATUS_MESSAGES: Record<EvaluateStatus, string> = {
  idle:       "Point at an object and tap Scan",
  converting: "Focusing the Lexi-Lens…",
  evaluating: "Consulting the ancient tomes…",
  match:      "Material component found!",
  "no-match": "Hmm, not quite…",
  error:      "The Lens flickered — try again",
};
