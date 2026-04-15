/**
 * useLexiEvaluate.ts
 * Lexi-Lens — client-side hook for the evaluate Edge Function.
 *
 * Handles the full lifecycle of a scan:
 *   pending → evaluating → verdict (match | no-match | error)
 *
 * Features:
 *   • Streaming-style progressive feedback (shows "Scanning…" → "Analysing…" instantly)
 *   • Automatic retry on transient network errors (max 2 retries, exponential backoff)
 *   • Deduplication — ignores a second call while one is already in flight
 *   • Converts frame file:// URI → base64 before sending
 *
 * Dependencies:
 *   npm install @supabase/supabase-js
 *   npx expo install expo-file-system
 */

import { useState, useCallback, useRef } from "react";
import * as FileSystem from "expo-file-system";
import { supabase } from "../lib/supabase"; // your initialised Supabase client

// ─── Types ────────────────────────────────────────────────────────────────────

export type EvaluateStatus =
  | "idle"
  | "converting"   // file URI → base64
  | "evaluating"   // waiting for Edge Function / Claude
  | "match"        // overallMatch = true
  | "no-match"     // overallMatch = false
  | "error";

export interface PropertyScore {
  word: string;
  score: number;
  reasoning: string;
  passes: boolean;
}

export interface EvaluationResult {
  resolvedObjectName: string;
  properties: PropertyScore[];
  overallMatch: boolean;
  childFeedback: string;
  nudgeHint?: string | null;
  xpAwarded: number;
}

export interface EvaluatePayload {
  childId: string;
  questId: string;
  questName?: string;
  detectedLabel: string;
  confidence: number;
  /** file:// URI from Vision Camera snapshot — converted to base64 internally */
  frameUri?: string | null;
  frameBase64Already?: string | null; 
  requiredProperties: Array<{
    word: string;
    definition: string;
    evaluationHints?: string;
  }>;
  childAge: number;
  failedAttempts?: number;
}

interface UseLexiEvaluateReturn {
  status: EvaluateStatus;
  result: EvaluationResult | null;
  error: string | null;
  /** Call this when the child points at an object and taps scan */
  evaluate: (payload: EvaluatePayload) => Promise<void>;
  /** Reset back to idle so the child can try again */
  reset: () => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 800;
/** Max base64 size to send — ~1.2MB decoded (roughly a 600KB JPEG) */
const MAX_FRAME_BASE64_CHARS = 1_600_000;
const EDGE_FUNCTION_NAME = "evaluate";

// ─── Utility: file URI → base64 ──────────────────────────────────────────────

async function uriToBase64(uri: string): Promise<string | null> {
  try {
    const base64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    // Drop oversized frames to avoid bloating the API call
    if (base64.length > MAX_FRAME_BASE64_CHARS) {
      console.warn("[LexiEvaluate] Frame too large, sending without image");
      return null;
    }
    return base64;
  } catch {
    return null;
  }
}

// ─── Utility: sleep ──────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Utility: call Edge Function with retry ───────────────────────────────────

async function callEdgeFunction(
  body: object,
  attempt = 0
): Promise<EvaluationResult> {
  const { data, error } = await supabase.functions.invoke<EvaluationResult>(
    EDGE_FUNCTION_NAME,
    { body }
  );

  if (error) {
    const isTransient =
      error.message.includes("fetch") ||
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
  const [status, setStatus] = useState<EvaluateStatus>("idle");
  const [result, setResult] = useState<EvaluationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Prevent overlapping calls
  const inFlight = useRef(false);

  const evaluate = useCallback(async (payload: EvaluatePayload) => {
    if (inFlight.current) return;
    inFlight.current = true;

    setResult(null);
    setError(null);

    try {
      // Step 1: convert frame URI to base64 (fast, local)
     let frameBase64: string | null = null;
if (payload.frameBase64Already) {
  frameBase64 = payload.frameBase64Already;
} else if (payload.frameUri) {
  setStatus("converting");
  frameBase64 = await uriToBase64(payload.frameUri);
}

      // Step 2: call Edge Function → Claude
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
      });

      setResult(evaluationResult);
      setStatus(evaluationResult.overallMatch ? "match" : "no-match");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong";
      setError(message);
      setStatus("error");
    } finally {
      inFlight.current = false;
    }
  }, []);

  const reset = useCallback(() => {
    if (inFlight.current) return; // don't reset mid-flight
    setStatus("idle");
    setResult(null);
    setError(null);
  }, []);

  return { status, result, error, evaluate, reset };
}

// ─── UI status helpers (use in your component) ────────────────────────────────

export const STATUS_MESSAGES: Record<EvaluateStatus, string> = {
  idle:       "Point at an object and tap Scan",
  converting: "Focusing the Lexi-Lens…",
  evaluating: "Consulting the ancient tomes…",
  match:      "Material component found!",
  "no-match": "Hmm, not quite…",
  error:      "The Lens flickered — try again",
};

// ─── Usage example ────────────────────────────────────────────────────────────
//
// function ScanScreen({ quest, child }) {
//   const { status, result, error, evaluate, reset } = useLexiEvaluate();
//   const { cameraRef, device, frameProcessor } = useObjectScanner({
//     enabled: status === "idle",
//     onDetection: async ({ primary, frameBase64: frameUri }) => {
//       if (!primary) return;
//       await evaluate({
//         childId:            child.id,
//         questId:            quest.id,
//         questName:          quest.name,
//         detectedLabel:      primary.label,
//         confidence:         primary.confidence,
//         frameUri,
//         requiredProperties: quest.requiredProperties,
//         childAge:           child.age,
//         failedAttempts:     quest.failedAttempts,
//       });
//     },
//   });
//
//   return (
//     <View style={{ flex: 1 }}>
//       <Camera ref={cameraRef} device={device} isActive={status === "idle"}
//               frameProcessor={frameProcessor} style={StyleSheet.absoluteFill} />
//
//       <StatusBanner message={STATUS_MESSAGES[status]} />
//
//       {status === "match" && (
//         <VerdictCard
//           feedback={result.childFeedback}
//           xp={result.xpAwarded}
//           properties={result.properties}
//           onContinue={() => { /* advance quest */ }}
//         />
//       )}
//
//       {status === "no-match" && (
//         <VerdictCard
//           feedback={result.childFeedback}
//           hint={result.nudgeHint}
//           onTryAgain={reset}
//         />
//       )}
//
//       {status === "error" && (
//         <ErrorCard message={error} onRetry={reset} />
//       )}
//     </View>
//   );
// }
