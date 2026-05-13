/**
 * app.config.js — Lexi-Lens dynamic Expo config (v4.5.4)
 *
 * v4.5.4 (May 13, 2026) — iOS SIGABRT fix + Apple ITMS-90683 warning preempt.
 *
 *   Diagnosis from .ips crash report (LexiLens-2026-05-12-220346.ips):
 *     type:     EXC_CRASH / SIGABRT
 *     proc:     "abort() called" from libsystem_c.dylib
 *     queue:    "expo.controller.errorRecoveryQueue"
 *     thread:   faulting thread 4, NSException bubbled to objc_exception_throw
 *               → __cxa_throw → abort
 *
 *   The Expo error-recovery handler itself threw an uncaught NSException
 *   during cold-start init. checkAutomatically: 'NEVER' (v4.5.3) prevents
 *   the network fetch but does NOT disarm the iOS error-recovery code path,
 *   which still runs and crashes on stale/corrupt expo-updates DB state
 *   left by earlier iOS submission attempts.
 *
 *   Android dev validated the same Lumi 2.0 native deps work end-to-end,
 *   so the iOS crash is iOS-specific (Android uses a different error
 *   recovery code path that did NOT trigger).
 *
 *   Fix: remove the `updates` block entirely. expo-updates is still
 *   transitively in the binary (it's a default Expo SDK package) but with
 *   no URL configured, the startup procedure short-circuits and the error
 *   recovery queue is never armed.
 *
 *   When we want OTAs back (probably post-launch for JS-only hotfixes):
 *     1. Re-add the updates block with `checkAutomatically: 'ON_LOAD'`
 *     2. Re-add the `runtimeVersion` block
 *     3. Ship a fresh build at a new version number
 *     4. Adopt smoke-test discipline before propagating each `eas update`
 *
 *   Also added (same drop, Apple ITMS-90683 warning preempt):
 *     - NSLocationWhenInUseUsageDescription purpose string
 *     - NSMicrophoneUsageDescription purpose string
 *
 *   Lexi-Lens does NOT use location or microphone APIs, but one of the
 *   bundled native libraries (probably vision-camera or a transitive dep)
 *   references CoreLocation symbols at the static analysis level. Apple
 *   warned about this on the v1.0.14 (6) iOS submission. Adding honest
 *   purpose strings satisfies the static check without prompting users —
 *   the APIs are never actually called, so the prompts never appear.
 *
 *   Version bumped 1.0.14 → 1.0.15.
 *     Without the updates block, the runtimeVersion policy is gone, but
 *     a version bump is still good hygiene: Play Console / TestFlight
 *     need monotonically increasing buildNumber, and a fresh installable
 *     binary helps testers know they have the v4.5.4 fix.
 *
 * ─── v4.5.3 (rolled forward) — single-application design, retained ────────
 *
 *   The staging entry in IDENTIFIERS still has iosBundle and androidPackage
 *   matching production. Only `name` ("Lexi-Lens (Staging)") and `scheme`
 *   ("lexilensstaging") differ. ONE Play Console listing, ONE App Store
 *   Connect record (ascAppId 6766159881).
 *
 * ─── Variant model ──────────────────────────────────────────────────────────
 *
 *   APP_VARIANT=production   → com.navinj.lexilens      / com.navinj.lexilore
 *   APP_VARIANT=staging      → com.navinj.lexilens      / com.navinj.lexilore   (same as prod; name+scheme differ)
 *   APP_VARIANT=development  → com.navinj.lexilens.dev  / com.navinj.lexilore.dev
 *
 *   Production identifiers FROZEN — renaming would orphan testers.
 *
 *   On Windows CMD, `eas submit` reads app.config.js locally with your
 *   shell env. Always prefix submit commands with `set APP_VARIANT=production`
 *   so the Android package resolves to com.navinj.lexilore (not .dev).
 *
 * ─── EAS Secrets ──────────────────────────────────────────────────────────
 *
 *   Two Supabase projects (env split is operational as of May 2026):
 *     - zhnaxafmacygbhpvtwvf → staging (dev + tester builds bundle this)
 *     - vwlfzvabvlcozqpepsoi → production (public launch bundles this)
 *
 *   EAS env vars (clean state):
 *     _STAGING suffix in development + preview + production EAS environments
 *     _PROD suffix in production EAS environment only
 *     SENTRY_AUTH_TOKEN (Secret) in all three for sourcemap upload
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
    version: '1.0.15',
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
        // Required by Apple static analysis (ITMS-90683). A bundled native
        // library references location APIs; Lexi-Lens does not actually
        // request or use location. No user prompt will appear.
        NSLocationWhenInUseUsageDescription:
          'Lexi-Lens does not use your location. This declaration is required by a bundled library and the API is never actually called.',
        // Required defensively. expo-audio iOS may probe microphone APIs
        // via AVAudioSession even though Lexi-Lens only plays audio (Lumi
        // sound cues). Lexi-Lens does not record audio.
        NSMicrophoneUsageDescription:
          'Lexi-Lens does not record audio. This declaration is required by a bundled audio library and the API is never actually called.',
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
      // extra.eas.projectId is the EAS project identifier — used by EAS
      // Build, push notifications, and (when re-enabled) expo-updates.
      // Same projectId across all variants; identifies the EAS project
      // (@navinj/lexi-lens) not a specific environment. Do not remove.
      eas: {
        projectId: '7fe2d61b-242a-4de3-91a7-1422f6876164',
      },
      appVariant: VARIANT,
    },

    // ── No updates block ─────────────────────────────────────────────────
    //
    // Removed in v4.5.4 to stop iOS expo-updates' error-recovery queue from
    // arming on cold start (root cause of v1.0.14 iOS SIGABRT). See header
    // for full context.
    //
    // To re-enable OTAs in a future release:
    //
    //   updates: {
    //     url: 'https://u.expo.dev/7fe2d61b-242a-4de3-91a7-1422f6876164',
    //     fallbackToCacheTimeout: 0,
    //     checkAutomatically: 'ON_LOAD',  // or 'WIFI_ONLY'
    //   },
    //   runtimeVersion: {
    //     policy: 'appVersion',
    //   },
    //
    // Ship a fresh build, adopt the discipline of smoke-testing each
    // `eas update` publish on a real tester device before letting the
    // channel propagate.

    owner: 'navinj',
    scheme: id.scheme,
  },
};
