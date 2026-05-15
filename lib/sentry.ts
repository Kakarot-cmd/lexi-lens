/**
 * lib/sentry.ts
 * Lexi-Lens — Sentry Crash Reporting
 *
 * v4.7 update — Compliance polish:
 *   • environment now reads ENV.sentry.environment (= APP_VARIANT) instead of
 *     `__DEV__ ? "development" : "production"`. Previously ALL non-dev builds
 *     reported as "production" — staging TestFlight noise mixed with real
 *     production crashes in one filter. Now staging events tag as "staging",
 *     dev as "development", prod as "production" so each tier is isolatable.
 *   • release uses ENV.appVersion (mapped from app.config.js `version`),
 *     prefixed with the variant so a crash from a staging 1.0.12 build is not
 *     mistaken for a production 1.0.12 crash. Format: "<variant>@<version>".
 *   • beforeBreadcrumb / beforeSend are extended to scrub a wider set of
 *     fields that should never reach Sentry: Authorization headers, x-api-key,
 *     Anthropic API keys, full email addresses in arbitrary breadcrumb data,
 *     base64 frame URIs, and Supabase service role keys. This is purely
 *     defensive — the audit in docs/COMPLIANCE_AUDIT.md confirms no current
 *     call site logs these, but a future call site might. The scrubbers fail
 *     closed: anything matching is replaced with "[redacted]" rather than
 *     dropped entirely, so we still see that an event happened.
 *   • initSentry returns the variant it initialised under so App.tsx can log
 *     it once at startup for ground-truth observability.
 *
 * v3.7 (original) — Sentry init, user/quest context, breadcrumbs, error capture.
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
 *   setQuestContext({ questId, questName })
 *   clearQuestContext()
 *   addGameBreadcrumb({ category, message, data })
 *   captureGameError(error, context)
 */

import * as Sentry from "@sentry/react-native";
import { ENV } from "./env";

// ─── PII / secret scrubbing ───────────────────────────────────────────────────
//
// These run on every breadcrumb and event. The current code is clean (audit:
// docs/COMPLIANCE_AUDIT.md), but a future contributor adding a breadcrumb
// could accidentally pass a header object or an Anthropic key. The scrubbers
// catch those without dropping the event entirely so we still see the
// breadcrumb's existence and category.

const REDACT = "[redacted]";

// Field names that should never carry their raw value to Sentry, regardless
// of where they appear in a breadcrumb's `data` object.
const SENSITIVE_KEYS = new Set([
  "authorization",
  "Authorization",
  "x-api-key",
  "X-Api-Key",
  "apiKey",
  "api_key",
  "anthropic_api_key",
  "ANTHROPIC_API_KEY",
  "supabase_service_role_key",
  "SUPABASE_SERVICE_ROLE_KEY",
  "password",
  "frameBase64",
  "frameUri",
  "frame_base64",
  "email",
  "parentEmail",
  "parent_email",
  "displayName",
  "display_name",
  "childName",
  "child_name",
]);

// Regex patterns that scrub free-form strings (e.g. message, error.message).
// Anthropic keys: sk-ant-api03-...
// Supabase keys:  eyJ...   (JWT shape — too aggressive on user JWTs but those
//                  also shouldn't be in Sentry strings, so this is fine.)
// Email addresses: standard pattern.
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[a-zA-Z0-9_\-]{10,}/g, "[redacted-anthropic-key]"],
  [/eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, "[redacted-jwt]"],
  [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[redacted-email]"],
];

function scrubString(value: string): string {
  let out = value;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

function scrubData(input: unknown): unknown {
  if (input == null) return input;
  if (typeof input === "string") return scrubString(input);
  if (Array.isArray(input)) return input.map(scrubData);
  if (typeof input === "object") {
    const src = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (SENSITIVE_KEYS.has(k)) {
        out[k] = REDACT;
      } else {
        out[k] = scrubData(v);
      }
    }
    return out;
  }
  return input;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

/**
 * Initialise Sentry for the current app variant.
 * Returns the variant it initialised under (or null if disabled — no DSN).
 */
export function initSentry(): string | null {
  const dsn = ENV.sentry.dsn;

  if (!dsn) {
    // In dev or any tier without a DSN, Sentry is a no-op — no crashes.
    if (__DEV__) {
      console.warn("[Sentry] EXPO_PUBLIC_SENTRY_DSN not set — Sentry disabled.");
    }
    return null;
  }

  // v4.7: variant-aware environment + release.
  //
  // environment   — "development" | "staging" | "production"
  //                  Drives Sentry's environment filter and alert routing.
  //
  // release       — "<variant>@<version>" so a staging 1.0.12 crash never
  //                  collides with a production 1.0.12 crash in the
  //                  Releases dashboard. Sentry uses release strings to
  //                  associate sourcemaps; the @sentry/react-native/expo
  //                  plugin in app.config.js uploads sourcemaps tagged
  //                  with the same string so stack frames stay symbolicated.
  //
  // dist          — runtime version policy is "appVersion", so dist is the
  //                  raw app version. Helps disambiguate within a release
  //                  when a JS-only EAS Update lands.
  const variant     = ENV.sentry.environment;
  const versionTag  = ENV.appVersion;
  const releaseName = `${variant}@${versionTag}`;

  // v4.5.9 — Conservative init to unblock iOS TestFlight white-screen
  // (May 14, 2026 — after 9 failed iOS builds).
  //
  // Hypothesis (Sentry GitHub issue #3623): setting `tracesSampleRate` in
  // Sentry.init causes a synchronous production-build crash on certain
  // platforms. The issue reporter narrowed it to that exact property and
  // confirmed that passing an empty config object resolved the crash.
  // Our symptom (white screen, no .ips, no Sentry events) is consistent
  // with the JS bundle silently halting during Sentry.init's native
  // bridge call.
  //
  // This conservative init:
  //   • Removes `tracesSampleRate`        ← the documented crash trigger
  //   • Removes `beforeBreadcrumb` fn     ← native-to-JS callback, could
  //                                          trip new arch bridgeless
  //   • Simplifies `beforeSend` to just   ← drops the deep-walk scrubber
  //     the size guard + scrub on top      that could throw on circular
  //     fields                              refs in the event payload
  //   • Keeps `release`, `dist`,          ← strings, can't crash
  //     `environment`, `ignoreErrors`
  //
  // What we lose temporarily:
  //   • Performance tracing (20% sample) — no traces in Sentry dashboard
  //     until we re-enable. Crash reporting is UNAFFECTED.
  //   • XHR breadcrumb filtering — Sentry may log api.anthropic.com URLs
  //     in breadcrumbs. We accept this for now; revisit post-launch.
  //   • Deep nested data scrubbing — extras/contexts/tags not scrubbed.
  //     Top-level message + exception.value strings are still scrubbed.
  //
  // What we keep:
  //   • Crash reporting (the main reason we have Sentry)
  //   • Release/dist/environment tagging (sourcemaps still symbolicate)
  //   • ignoreErrors (known noisy categories filtered)
  //   • Top-level string scrubbing (PII protection on message field)
  //   • Replay disabled (children's app, privacy first)
  //
  // To re-enable after iOS is confirmed working:
  //   1. Add `tracesSampleRate: 0.2` back, ship one tester build, verify
  //   2. If OK, add `beforeBreadcrumb` back, ship + verify
  //   3. If OK, restore the full beforeSend scrubber
  Sentry.init({
    dsn,
    release:     releaseName,
    dist:        versionTag,
    environment: variant,

    // Session replay disabled (children's app)
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,

    // Minimal beforeSend — size guard + top-level scrub only.
    // Crucially, no deep object walking.
    beforeSend(event) {
      const json = JSON.stringify(event);
      if (json.includes("frameBase64") || json.length > 500_000) {
        return null;
      }
      if (typeof event.message === "string") {
        event.message = scrubString(event.message);
      }
      if (event.exception?.values) {
        for (const ex of event.exception.values) {
          if (ex.value) ex.value = scrubString(ex.value);
        }
      }
      return event;
    },

    ignoreErrors: [
      "Camera permission not granted",
      "Module AppRegistry is not a registered callable module",
      "Network request failed",
      "AuthSessionMissingError",
    ],
  });

  return variant;
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
  | "cc1"           // v6.2 Phase 2 — canonical classifier call lifecycle
  | "verdict"       // match / no-match / rate_limited
  | "quest"         // quest start / complete / hard-mode
  | "navigation"    // screen transitions
  | "auth"          // login / logout
  | "mastery"       // word mastery updates
  | "cache"         // Redis hit / miss
  | "xp"            // XP awarded
  | "report"        // v4.7 — verdict report submitted
  | "pdf_export"    // Word Tome PDF generation
  | "revenuecat";   // Phase 4.4 — RC SDK lifecycle, purchases, customer-info updates

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

/**
 * v4.7 — Capture a parent/child verdict report as a Sentry "warning".
 *
 * Sent in addition to the verdict_reports DB row so a spike in reports
 * shows up in the Sentry dashboard alongside crashes — the DB row is the
 * audit trail; Sentry is the alerting surface.
 *
 * Note: never include the child's free-text note here. It's sent only to
 * the DB row where it sits behind RLS — Sentry is shared visibility.
 */
export function captureVerdictReport(opts: {
  scanAttemptId:  string;
  questId?:       string;
  detectedLabel?: string;
  resolvedName?:  string;
  reason:         string;
  cacheHit?:      boolean;
}): void {
  Sentry.withScope((scope) => {
    scope.setLevel("warning");
    scope.setTag("event_kind",     "verdict_report");
    scope.setTag("report_reason",  opts.reason);
    if (opts.questId)       scope.setTag("quest_id",        opts.questId);
    if (opts.detectedLabel) scope.setTag("detected_label",  opts.detectedLabel);
    scope.setContext("verdict_report", {
      scan_attempt_id: opts.scanAttemptId,
      resolved_name:   opts.resolvedName ?? null,
      cache_hit:       opts.cacheHit ?? false,
    });
    Sentry.captureMessage(`Verdict reported: ${opts.reason}`, "warning");
  });
}

// ─── Performance spans ────────────────────────────────────────────────────────

/**
 * Wrap an async operation in a Sentry performance span.
 * Returns the result of fn(), or re-throws after marking the span as failed.
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
