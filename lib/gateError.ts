/**
 * lib/gateError.ts
 * Lexi-Lens — premium / quota gate parsing for Edge Function responses.
 *
 * The gated Edge Functions (generate-quest, export-word-tome) return:
 *   • 402  need_premium  → { error: <friendly>, reason: <paywall key> }
 *   • 429  monthly_cap   → { error: <friendly> }
 * (see supabase/functions/_shared/featureAccess.ts → messageFor).
 *
 * BUT supabase-js v2 functions.invoke() places non-2xx bodies on
 * error.context (a Response), NOT in `data` — `data` is null. Callers that
 * only read `data` or `error.message` therefore collapse a 402/429 into a
 * generic failure and never route to the Paywall. parseGateError() reads the
 * real body off the FunctionsHttpError so callers can react correctly.
 *
 * Returns null for anything that is not a recognised 402/429 gate response, so
 * callers fall through to their existing generic error handling.
 */

import { FunctionsHttpError } from "@supabase/supabase-js";

export type GateOutcome = "need_premium" | "monthly_cap";

export interface GateInfo {
  /** HTTP status from the Edge Function: 402 or 429 */
  httpStatus: 402 | 429;
  /** Normalised outcome */
  outcome:    GateOutcome;
  /** Friendly, child/parent-safe copy authored server-side */
  message:    string;
  /** Paywall routing key (need_premium only): "generate-quest-locked" | "export-tome-locked" */
  reason?:    string;
}

/** Thrown by service-layer code so hooks/screens can distinguish a gate from a crash. */
export class GateError extends Error {
  public readonly info: GateInfo;
  constructor(info: GateInfo) {
    super(info.message);
    this.name = "GateError";
    this.info = info;
  }
}

const FALLBACK_MESSAGE: Record<GateOutcome, string> = {
  need_premium: "This is a Premium feature.",
  monthly_cap:  "You've reached this month's limit. It resets next month.",
};

/**
 * Parse a supabase-js invoke() error into a GateError, or null if it isn't a
 * 402/429 gate response. Async because the body lives on a Response.
 */
export async function parseGateError(error: unknown): Promise<GateError | null> {
  if (!(error instanceof FunctionsHttpError)) return null;

  const ctxResp = error.context as Response | undefined;
  if (!ctxResp || typeof ctxResp.clone !== "function") return null;

  const status = ctxResp.status;
  if (status !== 402 && status !== 429) return null;

  // clone() so we never double-consume the body if something else reads it.
  const body = (await ctxResp.clone().json().catch(() => null)) as
    | { error?: unknown; reason?: unknown }
    | null;

  const outcome: GateOutcome = status === 402 ? "need_premium" : "monthly_cap";

  const serverMsg =
    body && typeof body.error === "string" && body.error.trim().length > 0
      ? body.error
      : null;

  return new GateError({
    httpStatus: status,
    outcome,
    message:    serverMsg ?? FALLBACK_MESSAGE[outcome],
    reason:     typeof body?.reason === "string" ? body.reason : undefined,
  });
}
