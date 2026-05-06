/**
 * app.config.js — Lexi-Lens dynamic Expo config (v4.5)
 *
 * Reads APP_VARIANT (set by EAS via the env block in eas.json, or by your
 * .env.local for Metro/dev-client) and applies the matching identifiers.
 *
 *   APP_VARIANT=production   → com.navinj.lexilens          / com.navinj.lexilore
 *   APP_VARIANT=staging      → com.navinj.lexilens.staging  / com.navinj.lexilore.staging
 *   APP_VARIANT=development  → com.navinj.lexilens.dev      / com.navinj.lexilore.dev
 *
 * IMPORTANT: production identifiers are FROZEN. The existing v1.0.11 build
 * already lives in the Play Console and Apple App Store Connect under those
 * exact names. Renaming them would create entirely new app records and
 * orphan all current testers.
 *
 * The Android package name `com.navinj.lexilore` is a typo of `lexilens`,
 * but it has shipped — we keep it for production. The staging/dev variants
 * use the same typo for consistency.
 *
 * EAS Secrets setup (run once per profile):
 *   eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_URL_PROD       --value "https://<prod-ref>.supabase.co"
 *   eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_ANON_KEY_PROD  --value "eyJ..."
 *   eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_URL_STAGING    --value "https://<staging-ref>.supabase.co"
 *   eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_ANON_KEY_STAGING --value "eyJ..."
 *   eas secret:create --scope project --name EXPO_PUBLIC_SENTRY_DSN              --value "https://...@sentry.io/..."
 *
 * Verify: eas secret:list
 *
 * Local dev: copy .env.example → .env.local and fill in dev or staging values.
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
    iosBundle:          'com.navinj.lexilens.staging',
    androidPackage:     'com.navinj.lexilore.staging',
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
    version: '1.0.12',
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
        // Custom URL scheme is also declared via the top-level `scheme` field
        // below, but iOS requires it in CFBundleURLTypes too for cold-start
        // links to work consistently.
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
      // Surfaced into the JS bundle for lib/env.ts. EXPO_PUBLIC_* vars are
      // also injected directly by Expo, so this is a belt+braces channel
      // for anything we want available via Constants.expoConfig.extra.
      appVariant: VARIANT,
    },

    updates: {
      fallbackToCacheTimeout: 0,
    },

    owner: 'navinj',
    scheme: id.scheme,
  },
};
