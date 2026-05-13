/**
 * app.config.js — Lexi-Lens dynamic Expo config (v4.5.4)
 *
 * v4.5.4 (May 13, 2026) — Five changes, all driven by definitive logcat
 *                          evidence that expo-updates is the root cause
 *                          on BOTH Android and iOS.
 *
 *   Smoking gun (Android logcat from v1.0.14 release build):
 *     E dev.expo.updates: "UpdatesController onBackgroundUpdateFinished"
 *     E dev.expo.updates: "Loaded new update but it failed to launch"
 *                         code: UpdateFailedToLoad
 *     E dev.expo.updates: "Failed to download remote update"
 *     E dev.expo.updates: "Unexpected error encountered while loading"
 *     E dev.expo.updates: "Failed to launch embedded or launchable update"
 *     E unknown:ReactHost: awaitDelayLoadAppWhenReady →
 *                          UpdatesPackage$invokeReadyRunnable
 *
 *   What this proves:
 *     - `checkAutomatically: 'NEVER'` (v4.5.3) does NOT disable the
 *       expo-updates StartupProcedure. The procedure still runs,
 *       still goes to network, still fails.
 *     - The Expo ReactActivity's onCreate waits for expo-updates'
 *       invokeReadyRunnable to signal "app ready". When the procedure
 *       fails at every fallback, the signal never fires.
 *     - Android v1.0.14: black screen forever (ReactHost waits, app
 *       never advances past splash).
 *     - iOS v1.0.14: same root cause, different surface — iOS error
 *       recovery queue throws uncaught NSException → SIGABRT abort.
 *
 *   Why the half-measure failed: `checkAutomatically: 'NEVER'`
 *   controls WHEN expo-updates checks for updates, not WHETHER its
 *   startup procedure integrates into the React boot sequence.
 *
 *   Changes in v4.5.4:
 *
 *   1. Remove `updates` block entirely.
 *      Combined with uninstalling expo-updates from package.json (see
 *      package.json patch), this removes the native module from the
 *      binary, eliminating the startup procedure entirely.
 *      ReactHost no longer waits on UpdatesPackage's ready signal.
 *
 *   2. Remove `runtimeVersion` block.
 *      Only meaningful when updates is configured.
 *
 *   3. Remove `ios.infoPlist.CFBundleURLTypes`.
 *      EAS prebuild warned: "ios: scheme: 'ios.infoPlist.
 *      CFBundleURLTypes' is set in the config. Ignoring abstract
 *      property 'scheme': lexilensdev". The duplicate was breaking
 *      `npx expo config --json --type introspect`. Top-level `scheme`
 *      property is the canonical way — Expo's plugin generates the
 *      Info.plist CFBundleURLTypes from it automatically.
 *
 *   4. Add Info.plist purpose strings (Apple ITMS-90683 preempt).
 *      v1.0.14 (6) iOS submission received warning email:
 *        "ITMS-90683: Missing purpose string in Info.plist —
 *         NSLocationWhenInUseUsageDescription"
 *      A bundled native library (probably vision-camera transitive
 *      dep) references location APIs at static analysis level.
 *      Lexi-Lens does not use location; honest purpose string
 *      satisfies the static check without prompting users since the
 *      API is never actually called. Same for microphone (defensive,
 *      since expo-audio's iOS code paths may probe AVAudioSession).
 *
 *   5. Version bumped 1.0.14 → 1.0.15.
 *      Fresh APK/IPA buildNumber. Play Console / TestFlight need
 *      monotonically increasing versionCode/buildNumber.
 *
 *   IMPORTANT — accompanying change required outside this file:
 *
 *     Uninstall expo-updates from package.json:
 *       npm uninstall expo-updates
 *
 *     Verify after:
 *       grep "expo-updates" package.json     → no match
 *       grep -r "expo-updates" . --include="*.ts" --include="*.tsx"
 *         → no match (already verified: no app code imports it)
 *
 *     No code imports expo-updates. Safe to remove.
 *
 *   If/when OTAs are wanted later (probably post-launch, JS-only
 *   hotfixes, with smoke-test discipline):
 *     1. `npm install expo-updates`
 *     2. Re-add `updates` block + `runtimeVersion` block to this file
 *     3. Fresh full rebuild
 *     4. Test on a single tester device before propagating channel
 *
 * ─── v4.5.3 (rolled forward) — single-application design ──────────────────
 *
 *   IDENTIFIERS.staging.iosBundle and androidPackage match production.
 *   Only `name` ("Lexi-Lens (Staging)") and `scheme` ("lexilensstaging")
 *   differ. ONE Play Console listing for com.navinj.lexilore. ONE App
 *   Store Connect record for com.navinj.lexilens (ascAppId 6766159881).
 *
 * ─── Variant model ──────────────────────────────────────────────────────────
 *
 *   APP_VARIANT=production   → com.navinj.lexilens      / com.navinj.lexilore
 *   APP_VARIANT=staging      → com.navinj.lexilens      / com.navinj.lexilore   (same as prod; name+scheme differ)
 *   APP_VARIANT=development  → com.navinj.lexilens.dev  / com.navinj.lexilore.dev
 *
 *   Production identifiers FROZEN — renaming would orphan existing testers.
 *
 *   Windows CMD gotcha: `eas submit` reads app.config.js locally with your
 *   shell env. With APP_VARIANT unset, falls back to 'development' →
 *   resolves to .dev package which doesn't exist on Play Console. Always:
 *     set APP_VARIANT=production && eas submit ...
 *
 * ─── EAS Secrets (current operational state) ─────────────────────────────
 *
 *   Two Supabase projects, operationally split:
 *     zhnaxafmacygbhpvtwvf → staging (dev + tester builds)
 *     vwlfzvabvlcozqpepsoi → production (public launch)
 *
 *   EAS environments (cleaned up May 13):
 *     _STAGING suffix vars → all three envs (development, preview, production)
 *     _PROD suffix vars → production env only
 *     SENTRY_AUTH_TOKEN (Secret) → all three for sourcemap upload
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
      // CFBundleURLTypes intentionally NOT set here — top-level `scheme`
      // property below is the canonical way. Expo's plugin generates the
      // Info.plist CFBundleURLTypes block from it automatically. Having
      // both was breaking `npx expo config --type introspect`.
      infoPlist: {
        NSCameraUsageDescription:
          'Lexi-Lens uses your camera to scan real-world objects and bring vocabulary quests to life.',
        // Required by Apple static analysis (ITMS-90683). A bundled
        // native library references location APIs. Lexi-Lens does not
        // use location — API is never called → no user prompt.
        NSLocationWhenInUseUsageDescription:
          'Lexi-Lens does not use your location. This declaration is required by a bundled library and the API is never actually called.',
        // Defensive — expo-audio iOS may probe AVAudioSession. Lexi-Lens
        // plays audio (Lumi sound cues) but does not record audio.
        NSMicrophoneUsageDescription:
          'Lexi-Lens does not record audio. This declaration is required by a bundled audio library and the API is never actually called.',
        ITSAppUsesNonExemptEncryption: false,
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
      // EAS project identifier — used by EAS Build, push notifications,
      // and (if/when reintroduced) expo-updates. Same projectId across
      // all variants. Identifies the EAS project (@navinj/lexi-lens),
      // not a specific environment. Do not remove.
      eas: {
        projectId: '7fe2d61b-242a-4de3-91a7-1422f6876164',
      },
      appVariant: VARIANT,
    },

    // ── No `updates` block — see v4.5.4 header note #1 ──────────────────
    //
    // expo-updates is also uninstalled from package.json. To bring OTAs
    // back later: `npm install expo-updates`, re-add this block:
    //
    //   updates: {
    //     url: 'https://u.expo.dev/7fe2d61b-242a-4de3-91a7-1422f6876164',
    //     fallbackToCacheTimeout: 0,
    //     checkAutomatically: 'ON_LOAD',
    //   },
    //   runtimeVersion: {
    //     policy: 'appVersion',
    //   },

    owner: 'navinj',
    scheme: id.scheme,
  },
};
