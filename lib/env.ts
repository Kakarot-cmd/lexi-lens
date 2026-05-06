/**
 * lib/env.ts
 * Lexi-Lens — environment configuration single source of truth.
 *
 * Why this file exists
 * ────────────────────
 * Until v4.4 we had ONE Supabase project (`zhnaxafmacygbhpvtwvf`) used for
 * local dev, internal testers, AND production users. That works fine while
 * everyone is the developer or a friend. It stops working the moment:
 *
 *   • RevenueCat sandbox purchases start landing in the same `child_profiles`
 *     and `quest_completions` rows as real subscribers.
 *   • Apple / Google reviewers create accounts that show up next to real
 *     users in `parental_consents` and `data_deletion_requests`.
 *   • A bad migration on local dev wipes production data because
 *     `supabase db reset` doesn't ask which project it's pointed at.
 *
 * Solution: 3 environments, each with its own Supabase project.
 *
 *   ┌──────────────┬──────────────────┬───────────────────────────────────┐
 *   │ Variant      │ APP_VARIANT      │ Where it runs                     │
 *   ├──────────────┼──────────────────┼───────────────────────────────────┤
 *   │ development  │ "development"    │ expo run:ios / Metro / dev client │
 *   │ staging      │ "staging"        │ EAS preview builds + TestFlight   │
 *   │              │                  │ Internal + Play Internal Testing  │
 *   │              │                  │ + Closed Testing tracks           │
 *   │ production   │ "production"     │ App Store + Play Production       │
 *   └──────────────┴──────────────────┴───────────────────────────────────┘
 *
 * The variant is selected by EAS at build time via the `env.APP_VARIANT`
 * field on each profile in `eas.json`. Locally, set APP_VARIANT in your
 * shell or a `.env.local` file (see `.env.example`).
 *
 * What happens if APP_VARIANT is missing
 * ───────────────────────────────────────
 * We fall back to "development" with a console.warn so you notice. This
 * keeps Expo Go and `expo run:ios` (which don't go through EAS profiles)
 * usable without manual env setup as long as you have a `.env.local`.
 */

// ─── Variant resolution ───────────────────────────────────────────────────────

export type AppVariant = 'development' | 'staging' | 'production';

function resolveVariant(): AppVariant {
  const raw = (process.env.APP_VARIANT ?? process.env.EXPO_PUBLIC_APP_VARIANT ?? '').trim();
  if (raw === 'development' || raw === 'staging' || raw === 'production') {
    return raw;
  }
  if (__DEV__) {
    return 'development';
  }
  // Non-dev build with no variant set is a misconfiguration. Warn LOUD but
  // don't crash — fall back to staging (safer than production by default).
  console.warn(
    '[env] APP_VARIANT is not set. Falling back to "staging". ' +
    'Set APP_VARIANT in eas.json env or .env.local to silence this.',
  );
  return 'staging';
}

export const APP_VARIANT: AppVariant = resolveVariant();
export const IS_DEV     = APP_VARIANT === 'development';
export const IS_STAGING = APP_VARIANT === 'staging';
export const IS_PROD    = APP_VARIANT === 'production';

// ─── Supabase ─────────────────────────────────────────────────────────────────

function readSupabaseUrl(): string {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  if (!url) {
    if (__DEV__) {
      console.warn(
        '[env] EXPO_PUBLIC_SUPABASE_URL is empty. Add it to your .env.local ' +
        'or set it as an EAS Secret on the appropriate profile.',
      );
    }
  }
  return url;
}

function readSupabaseAnonKey(): string {
  const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!key && __DEV__) {
    console.warn('[env] EXPO_PUBLIC_SUPABASE_ANON_KEY is empty.');
  }
  return key;
}

// ─── Sentry ───────────────────────────────────────────────────────────────────

function readSentryDsn(): string | null {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN ?? '';
  return dsn || null;
}

// ─── RevenueCat (Phase 4.4 — wired ahead of integration) ─────────────────────

function readRevenueCatIosKey(): string | null {
  return process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY ?? null;
}

function readRevenueCatAndroidKey(): string | null {
  return process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY ?? null;
}

// ─── Deep-link scheme ─────────────────────────────────────────────────────────
//
// Per-variant scheme so a developer running the dev client with a staging
// build installed doesn't accidentally consume the other variant's auth
// confirmation links.

function deepLinkScheme(): string {
  switch (APP_VARIANT) {
    case 'production':  return 'lexilens';
    case 'staging':     return 'lexilensstaging';
    case 'development': return 'lexilensdev';
  }
}

// ─── Public env object ────────────────────────────────────────────────────────

export const ENV = {
  variant:       APP_VARIANT,
  isDev:         IS_DEV,
  isStaging:     IS_STAGING,
  isProd:        IS_PROD,

  appVersion:    process.env.EXPO_PUBLIC_APP_VERSION ?? 'unknown',

  supabase: {
    url:     readSupabaseUrl(),
    anonKey: readSupabaseAnonKey(),
  },

  sentry: {
    dsn: readSentryDsn(),
    // Sentry environment label so you can filter the Sentry dashboard by
    // tier. Maps 1:1 to APP_VARIANT.
    environment: APP_VARIANT,
  },

  revenueCat: {
    iosKey:     readRevenueCatIosKey(),
    androidKey: readRevenueCatAndroidKey(),
  },

  deepLink: {
    scheme: deepLinkScheme(),
    // Convenience helpers for building deep-link URLs that survive scheme
    // changes between variants.
    confirmUrl: `${deepLinkScheme()}://auth/confirm`,
    resetUrl:   `${deepLinkScheme()}://auth/reset`,
  },
} as const;

// ─── Helper: assert critical env at startup ──────────────────────────────────
//
// Call once at app start (after Sentry init) to fail fast in any tier where
// a critical secret is missing. Sentry will capture the warning so you see
// misconfigured staging/prod builds in the dashboard.

export function assertEnvOrWarn(): void {
  const issues: string[] = [];
  if (!ENV.supabase.url)     issues.push('EXPO_PUBLIC_SUPABASE_URL is missing');
  if (!ENV.supabase.anonKey) issues.push('EXPO_PUBLIC_SUPABASE_ANON_KEY is missing');
  if (IS_PROD && !ENV.sentry.dsn) {
    issues.push('EXPO_PUBLIC_SENTRY_DSN is missing in a production build');
  }
  if (issues.length > 0) {
    console.warn(`[env] Configuration issues for variant "${APP_VARIANT}":\n  - ${issues.join('\n  - ')}`);
  }
}

// ─── Debug print (dev only) ──────────────────────────────────────────────────

if (__DEV__) {
  console.log(
    `[env] variant=${APP_VARIANT} ` +
    `supabaseHost=${ENV.supabase.url.replace(/^https?:\/\//, '').split('.')[0] || 'unset'} ` +
    `sentryEnv=${ENV.sentry.environment} ` +
    `scheme=${ENV.deepLink.scheme}`,
  );
}
