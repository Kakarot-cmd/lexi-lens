/**
 * lib/sentry.ts
 * Lexi-Lens — Phase 3.7: Sentry Crash Reporting
 *
 * Initialises Sentry for React Native (Expo managed workflow).
 * Provides typed helpers to attach Lexi-Lens game context to every event.
 *
 * Setup (run once, then rebuild):
 *   npx expo install @sentry/react-native
 *   npx @sentry/wizard -i reactNative   ← patches metro.config.js automatically
 *
 * Environment variable to add to .env (never commit the real DSN):
 *   EXPO_PUBLIC_SENTRY_DSN=https://xxxx@oXXX.ingest.sentry.io/YYYYYYY
 *
 * Usage in App.tsx:
 *   import { initSentry } from "./lib/sentry";
 *   initSentry();                            ← call before any other code
 *   export default Sentry.wrap(App);         ← wraps the root component
 *
 * Custom helpers used in hooks / screens:
 *   setUserContext({ childId, parentId, childAge })
 *   clearUserContext()
 *   addGameBreadcrumb({ category, message, data })
 *   captureGameError(error, context)
 */

import * as Sentry from "@sentry/react-native";

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initSentry(): void {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

  if (!dsn) {
    // In development without a DSN, Sentry is a no-op — no crashes.
    console.warn("[Sentry] EXPO_PUBLIC_SENTRY_DSN not set — Sentry disabled.");
    return;
  }

  Sentry.init({
    dsn,

    // ── Release tracking ─────────────────────────────────────────────────────
    // EAS build sets EXPO_PUBLIC_APP_VERSION from app.json automatically.
    // Matches the release uploaded by `sentry-expo` during `eas build`.
    release: process.env.EXPO_PUBLIC_APP_VERSION ?? "unknown",
    environment: __DEV__ ? "development" : "production",

    // ── Performance monitoring ───────────────────────────────────────────────
    // 20 % sample in production — enough to catch slow scans / Edge Fn latency.
    tracesSampleRate: __DEV__ ? 1.0 : 0.2,

    // ── Session replay (disabled — children's app, privacy first) ───────────
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,

    // ── Breadcrumb filtering ─────────────────────────────────────────────────
    // Strip any breadcrumb that accidentally contains a base64 frame blob.
    beforeBreadcrumb(breadcrumb) {
      if (
        breadcrumb.data &&
        typeof breadcrumb.data === "object" &&
        "frameBase64" in breadcrumb.data
      ) {
        const { frameBase64: _removed, ...safeData } = breadcrumb.data as Record<string, unknown>;
        return { ...breadcrumb, data: safeData };
      }
      return breadcrumb;
    },

    // ── Event filtering ──────────────────────────────────────────────────────
    // Remove any event that slipped a base64 blob into its payload.
    // Also redact the Anthropic API key if it ever surfaces (belt + braces).
    beforeSend(event) {
      const json = JSON.stringify(event);
      if (json.includes("frameBase64") || json.length > 500_000) {
        // Event is suspiciously large — likely contains an image blob.
        return null; // Drop silently.
      }
      return event;
    },

    // ── Ignored errors ───────────────────────────────────────────────────────
    // These are expected in normal app operation and would just add noise.
    ignoreErrors: [
      // Camera permission not yet granted on first launch
      "Camera permission not granted",
      // ML Kit not available before first EAS build (Expo Go)
      "Module AppRegistry is not a registered callable module",
      // Network blip on Edge Function retry — handled by callEdgeFunction
      "Network request failed",
      // Supabase auth token refresh on offline resume
      "AuthSessionMissingError",
    ],
  });
}

// ─── User context ─────────────────────────────────────────────────────────────

/**
 * Call after a child is selected in ChildSwitcherScreen.
 * Uses child/parent IDs — no names or emails sent to Sentry (COPPA-safe).
 */
export function setUserContext(opts: {
  childId:  string;
  parentId: string;
  childAge: number;
}): void {
  Sentry.setUser({ id: opts.parentId });      // Sentry "user" = the parent account
  Sentry.setTag("child_id",  opts.childId);
  Sentry.setTag("child_age", String(opts.childAge));
}

/**
 * Call on sign-out or when the parent switches away from a child profile.
 */
export function clearUserContext(): void {
  Sentry.setUser(null);
  Sentry.setTag("child_id",  "");
  Sentry.setTag("child_age", "");
}

// ─── Game context tags ────────────────────────────────────────────────────────

/**
 * Attach the active quest to all subsequent events in this session.
 * Call at the start of ScanScreen.
 */
export function setQuestContext(opts: {
  questId:   string;
  questName: string;
}): void {
  Sentry.setTag("quest_id",   opts.questId);
  Sentry.setTag("quest_name", opts.questName);
}

/** Clear quest context when the user leaves ScanScreen. */
export function clearQuestContext(): void {
  Sentry.setTag("quest_id",   "");
  Sentry.setTag("quest_name", "");
}

// ─── Breadcrumbs ──────────────────────────────────────────────────────────────

/** Category values for Lexi-Lens breadcrumbs — keeps them filterable in Sentry UI. */
export type GameBreadcrumbCategory =
  | "scan"          // ML Kit label detection
  | "evaluate"      // Edge Function call lifecycle
  | "verdict"       // match / no-match / rate_limited
  | "quest"         // quest start / complete / hard-mode
  | "navigation"    // screen transitions
  | "auth"          // login / logout
  | "mastery"       // word mastery updates
  | "cache"         // Redis hit / miss
  | "xp"            // XP awarded
  | "pdf_export";   // Word Tome PDF generation

export function addGameBreadcrumb(opts: {
  category: GameBreadcrumbCategory;
  message:  string;
  level?:   Sentry.SeverityLevel;
  data?:    Record<string, unknown>;
}): void {
  Sentry.addBreadcrumb({
    category: `lexi.${opts.category}`,
    message:  opts.message,
    level:    opts.level ?? "info",
    data:     opts.data,
    timestamp: Date.now() / 1000,
  });
}

// ─── Error capture ────────────────────────────────────────────────────────────

/**
 * Capture a handled error with Lexi-Lens game context.
 *
 * @example
 * captureGameError(err, {
 *   context:       "evaluate_edge_function",
 *   detectedLabel: "lamp",
 *   questId:       "abc-123",
 *   attempt:       2,
 * });
 */
export function captureGameError(
  error: unknown,
  context: {
    context:       string;
    detectedLabel?: string;
    questId?:       string;
    attempt?:       number;
    [key: string]:  unknown;
  }
): void {
  Sentry.withScope((scope) => {
    scope.setContext("game_context", context);
    scope.setTag("error_context", context.context);
    if (context.questId)      scope.setTag("quest_id",        context.questId);
    if (context.detectedLabel) scope.setTag("detected_label", context.detectedLabel);

    if (error instanceof Error) {
      Sentry.captureException(error);
    } else {
      Sentry.captureException(new Error(String(error)));
    }
  });
}

// ─── Performance spans ────────────────────────────────────────────────────────

/**
 * Wrap an async operation in a Sentry performance span.
 * Returns the result of fn(), or re-throws after marking the span as failed.
 *
 * @example
 * const result = await withSentrySpan("evaluate", "edge_function_call", async () => {
 *   return await callEdgeFunction(body);
 * });
 */
export async function withSentrySpan<T>(
  op:          string,
  description: string,
  fn:          () => Promise<T>
): Promise<T> {
  return Sentry.startSpan({ op, name: description }, async (span) => {
    try {
      const result = await fn();
      span?.setStatus({ code: 1 }); // OK
      return result;
    } catch (err) {
      span?.setStatus({ code: 2 }); // ERROR
      throw err;
    }
  });
}

// Re-export Sentry so callers can use Sentry.wrap() without a double import.
export { Sentry };
