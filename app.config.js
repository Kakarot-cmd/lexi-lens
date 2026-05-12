/**
 * app.config.js — Lexi-Lens dynamic Expo config (v4.5.3)
 *
 * v4.5.3 (May 12, 2026) — Three changes, all driven by the v1.0.13 staging
 *                          crash on tester devices.
 *
 *   1. OTA startup check disabled (`checkAutomatically: 'NEVER'`).
 *      v1.0.13 staging build crashed every cold start with no Sentry events
 *      (crash is in expo-updates' Kotlin StartupProcedure, before JS init).
 *      Logcat: `dev.expo.updates: "Loaded new update but it failed to
 *      launch", "code":"UpdateFailedToLoad"`. Stacktrace path:
 *        StartupProcedure.run → LoaderTask.start → launchRemoteUpdate
 *        → DatabaseLauncher.launch (kt:79)
 *
 *      Default expo-updates behaviour fetches + applies an OTA every cold
 *      start. We haven't been publishing OTAs deliberately, so the local
 *      update DB drifted into a bad state from earlier experiments / auto-
 *      publishes, and DatabaseLauncher.launch() threw on every launch.
 *      With 'NEVER', the embedded JS bundle always wins at startup. Manual
 *      `Updates.fetchUpdateAsync()` is still available the day we want OTAs
 *      intentionally (probably post-launch for JS-only hotfixes). To re-
 *      enable later: change this back to 'ON_LOAD' (default) or 'WIFI_ONLY'.
 *
 *   2. Version bumped 1.0.13 → 1.0.14.
 *      `runtimeVersion.policy: 'appVersion'` ties OTA runtime compatibility
 *      to the `version` field. Bumping the version invalidates any cached
 *      1.0.13 OTA bundle on tester devices. Without the bump, the bad
 *      cache could persist across the reinstall and re-crash even after
 *      the `checkAutomatically` fix.
 *
 *   3. IDENTIFIERS.staging cleaned up — single-application design.
 *      Previously the staging entry had `.staging` suffixes on iosBundle
 *      AND androidPackage. That was dead code at build time (EAS staging
 *      profile sets APP_VARIANT="production", which picks IDENTIFIERS.
 *      production), but the mismatch documented a two-application design
 *      that was explicitly rejected. Now: iosBundle and androidPackage
 *      match production. Only `name` ("Lexi-Lens (Staging)") and `scheme`
 *      ("lexilensstaging") differ — both safe per-build distinctions that
 *      don't create a second App Store / Play Console listing.
 *
 *      Concrete intent: ONE Play Console listing for com.navinj.lexilore,
 *      ONE App Store Connect record for com.navinj.lexilens (ascAppId
 *      6766159881). Staging vs production distinguished by:
 *        • EAS channel (`staging` vs `production`)
 *        • Bundled Supabase env vars (`_STAGING` vs `_PROD` secrets)
 *        • Play Console track / TestFlight group
 *      NOT by bundle/package identity.
 *
 * ─── Variant model ──────────────────────────────────────────────────────────
 *
 *   APP_VARIANT=production   → com.navinj.lexilens      / com.navinj.lexilore
 *   APP_VARIANT=staging      → com.navinj.lexilens      / com.navinj.lexilore   (same as prod; name+scheme differ)
 *   APP_VARIANT=development  → com.navinj.lexilens.dev  / com.navinj.lexilore.dev
 *
 *   IMPORTANT: production identifiers are FROZEN. The existing v1.0.11
 *   build lives in Play Console and Apple App Store Connect under those
 *   exact names. Renaming would create new app records and orphan testers.
 *
 *   The URL scheme stays `lexilensstaging` for the staging variant —
 *   Info.plist is per-build, so deep-link routing (Supabase password reset
 *   emails, etc.) remains scoped per-environment even though the bundle ID
 *   is shared with production.
 *
 *   Android package `com.navinj.lexilore` is a typo of `lexilens`, but it
 *   has shipped — we keep it. Development variant uses the same typo for
 *   consistency.
 *
 * ─── Local development ─────────────────────────────────────────────────────
 *
 *   The default fallback when APP_VARIANT is unset is 'development'. That
 *   means `eas submit` (which runs locally and reads app.config.js with
 *   your shell env) defaults to dev identifiers — which won't match the
 *   built AAB's identifiers. Workaround until we decide to flip the
 *   default: `set APP_VARIANT=production` in Windows CMD before running
 *   any `eas submit` command. See lexi-lens-eas-command-reference.docx §7.
 *
 *   For local Metro dev: copy `.env.example` → `.env.local` and set
 *   APP_VARIANT=development there. Expo loads .env.local automatically
 *   when you run `npm start`.
 *
 * ─── EAS Secrets setup (run once per profile) ─────────────────────────────
 *
 *   eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_URL_PROD       --value "https://<prod-ref>.supabase.co"
 *   eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_ANON_KEY_PROD  --value "eyJ..."
 *   eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_URL_STAGING    --value "https://<staging-ref>.supabase.co"
 *   eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_ANON_KEY_STAGING --value "eyJ..."
 *   eas secret:create --scope project --name EXPO_PUBLIC_SENTRY_DSN              --value "https://...@sentry.io/..."
 *
 *   Verify: eas secret:list
 *
 *   Current operational state (May 12, 2026): the env split is code-wired
 *   but the prod Supabase project has not been created. Both _STAGING and
 *   _PROD secrets point at the same project (zhnaxafmacygbhpvtwvf). The
 *   `production` build profile is therefore not yet shippable to public
 *   stores — staging-profile builds are the only safe path until the env
 *   split is operationally complete.
 */

const VARIANT = (process.env.APP_VARIANT ?? 'development').trim();

// ── Identifiers per variant ──────────────────────────────────────────────────

const IDENTIFIERS = {
  production: {
    name:               'Lexi-Lens',
    iosBundle:          'com.navinj.lexilens',
    androidPackage:     'com.navinj.lexilore',
    scheme:             'lexilens',
  },
  staging: {
    name:               'Lexi-Lens (Staging)',
    // Single-application design — iOS bundle and Android package match
    // production. See v4.5.3 header note #3. The "(Staging)" name and the
    // distinct URL scheme are the only per-build distinctions.
    iosBundle:          'com.navinj.lexilens',
    androidPackage:     'com.navinj.lexilore',
    scheme:             'lexilensstaging',
  },
  development: {
    name:               'Lexi-Lens (Dev)',
    iosBundle:          'com.navinj.lexilens.dev',
    androidPackage:     'com.navinj.lexilore.dev',
    scheme:             'lexilensdev',
  },
};

const id = IDENTIFIERS[VARIANT] ?? IDENTIFIERS.development;

if (!IDENTIFIERS[VARIANT]) {
  console.warn(`[app.config] Unknown APP_VARIANT="${VARIANT}", falling back to "development".`);
}

// ── Sentry environment label (matches what lib/env.ts reads) ─────────────────

const sentryEnv = VARIANT === 'production' ? 'production' : VARIANT === 'staging' ? 'staging' : 'development';

export default {
  expo: {
    name: id.name,
    slug: 'lexi-lens',
    version: '1.0.14',
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'light',
    newArchEnabled: true,

    splash: {
      image: './assets/splash-icon.png',
      resizeMode: 'contain',
      backgroundColor: '#ffffff',
    },

    ios: {
      bundleIdentifier: id.iosBundle,
      supportsTablet: true,
      entitlements: {
        'aps-environment': VARIANT === 'production' ? 'production' : 'development',
      },
      infoPlist: {
        NSCameraUsageDescription:
          'Lexi-Lens uses your camera to scan real-world objects and bring vocabulary quests to life.',
        ITSAppUsesNonExemptEncryption: false,
        CFBundleURLTypes: [
          {
            CFBundleURLSchemes: [id.scheme],
          },
        ],
      },
    },

    android: {
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#ffffff',
      },
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
      permissions: ['android.permission.CAMERA'],
      package: id.androidPackage,
    },

    web: {
      favicon: './assets/favicon.png',
    },

    plugins: [
      'react-native-vision-camera',
      [
        'expo-build-properties',
        {
          ios: {
            deploymentTarget: '16.0',
          },
        },
      ],
      [
        '@sentry/react-native/expo',
        {
          url: 'https://sentry.io/',
          project: 'lexi-lens',
          organization: 'njlabs',
        },
      ],
    ],

    extra: {
      eas: {
        projectId: '7fe2d61b-242a-4de3-91a7-1422f6876164',
      },
      appVariant: VARIANT,
    },

    // ── EAS Update ────────────────────────────────────────────────────────
    // checkAutomatically: 'NEVER' added in v4.5.3 — see header for full
    // reasoning. Embedded bundle always wins at startup. Flip back to
    // 'ON_LOAD' (or remove the line, default is 'ON_LOAD') the day you
    // start publishing OTAs intentionally. Until then, expo-updates is
    // effectively dormant — no server pings, no auto-applied cached
    // bundles on cold start.
    updates: {
      url: 'https://u.expo.dev/7fe2d61b-242a-4de3-91a7-1422f6876164',
      fallbackToCacheTimeout: 0,
      checkAutomatically: 'NEVER',
    },
    runtimeVersion: {
      policy: 'appVersion',
    },

    owner: 'navinj',
    scheme: id.scheme,
  },
};
