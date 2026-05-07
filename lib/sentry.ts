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

  Sentry.init({
    dsn,

    // ── Release tracking ─────────────────────────────────────────────────────
    release:     releaseName,
    dist:        versionTag,
    environment: variant,

    // ── Performance monitoring ───────────────────────────────────────────────
    // 20 % sample in production — enough to catch slow scans / Edge Fn latency
    // without burning quota. Staging and dev sample 100 %.
    tracesSampleRate: variant === "production" ? 0.2 : 1.0,

    // ── Session replay (disabled — children's app, privacy first) ───────────
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,

    // ── Breadcrumb filtering + scrubbing ─────────────────────────────────────
    beforeBreadcrumb(breadcrumb) {
      // Drop the entire breadcrumb if it's a known noisy XHR to Anthropic
      // (we already log structured breadcrumbs around evaluate calls; the
      // raw http breadcrumb adds nothing and may carry headers).
      if (
        breadcrumb.category === "xhr" &&
        typeof breadcrumb.data === "object" &&
        breadcrumb.data &&
        typeof (breadcrumb.data as Record<string, unknown>).url === "string" &&
        ((breadcrumb.data as Record<string, string>).url).includes("api.anthropic.com")
      ) {
        return null;
      }

      // Scrub data + message fields.
      if (breadcrumb.data) {
        breadcrumb.data = scrubData(breadcrumb.data) as Record<string, unknown>;
      }
      if (typeof breadcrumb.message === "string") {
        breadcrumb.message = scrubString(breadcrumb.message);
      }
      return breadcrumb;
    },

    // ── Event filtering ──────────────────────────────────────────────────────
    beforeSend(event) {
      // Drop suspiciously large events — likely a base64 frame slipped in.
      const json = JSON.stringify(event);
      if (json.includes("frameBase64") || json.length > 500_000) {
        return null;
      }

      // Scrub free-form text fields where secrets / emails could leak via
      // captureException(message) calls.
      if (event.message) {
        if (typeof event.message === "string") {
          event.message = scrubString(event.message);
        } else if (event.message.message) {
          event.message.message = scrubString(event.message.message);
        }
      }
      if (event.exception?.values) {
        for (const ex of event.exception.values) {
          if (ex.value) ex.value = scrubString(ex.value);
        }
      }

      // Scrub all extras / contexts / tags via the deep walker.
      if (event.extra)    event.extra    = scrubData(event.extra)    as Record<string, unknown>;
      if (event.contexts) event.contexts = scrubData(event.contexts) as Record<string, Record<string, unknown>>;
      if (event.tags) {
        // Tags are flat — only scrub string values.
        for (const [k, v] of Object.entries(event.tags)) {
          if (typeof v === "string") event.tags[k] = scrubString(v);
        }
      }
      return event;
    },

    // ── Ignored errors ───────────────────────────────────────────────────────
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
  | "verdict"       // match / no-match / rate_limited
  | "quest"         // quest start / complete / hard-mode
  | "navigation"    // screen transitions
  | "auth"          // login / logout
  | "mastery"       // word mastery updates
  | "cache"         // Redis hit / miss
  | "xp"            // XP awarded
  | "report"        // v4.7 — verdict report submitted
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
