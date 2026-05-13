/**
 * app.config.js — Lexi-Lens dynamic Expo config (v4.5.5)
 *
 * v4.5.5 (May 13, 2026 evening) — Corrects v4.5.4. Reinstalls expo-updates
 *                                  and disables it via `updates.enabled: false`
 *                                  instead of uninstalling.
 *
 *   Why this matters:
 *     v4.5.4 uninstalled expo-updates entirely (`npm uninstall expo-updates`).
 *     This SHOULD have worked but did not — v1.0.15 iOS launched to a white
 *     screen on TestFlight with no native crash and no .ips file generated.
 *
 *   Root cause (per official expo-updates README):
 *     Uninstalling the npm package alone is not enough. Per Expo's docs, you
 *     must ALSO remove the build phase entry that runs:
 *       ../node_modules/expo-updates/scripts/create-manifest-ios.sh
 *     from the "Bundle React Native code and images" phase in Xcode.
 *
 *     EAS Cloud's prebuild regenerates the iOS Xcode project on every build.
 *     We cannot edit the project file from Windows (no Xcode). When the
 *     build phase ran the missing script, it silently failed at producing
 *     the expected manifest. AppDelegate's bundleURL() then either returned
 *     nil or pointed at a non-existent embedded bundle. React Native
 *     received no JS to execute. App launched, rendered nothing, no crash.
 *
 *     Symptom triplet confirms this diagnosis:
 *       1. App launches past iOS sandbox provisioning ✓ (no SIGABRT)
 *       2. White screen forever ✓ (no JS context, no React tree)
 *       3. No .ips crash file ✓ (Swift nil-coalescing didn't crash, just no-op'd)
 *
 *   The Expo-documented escape hatch:
 *     "If you don't intend to use OTA updates, you can disable the module
 *      by setting EXUpdatesEnabled=NO in Expo.plist and
 *      expo.modules.updates.ENABLED=false in AndroidManifest.xml.
 *      The module stays installed, no OTA code paths execute."
 *     — https://github.com/expo/expo/tree/main/packages/expo-updates#disabling
 *
 *   How v4.5.5 implements this:
 *     1. expo-updates is reinstalled (npm install — already done before edit)
 *        → native code is back in the binary, AppDelegate references it,
 *          bundleURL() resolves correctly, main.jsbundle gets embedded.
 *     2. `updates.enabled: false` in this config
 *        → Expo's autolinking writes EXUpdatesEnabled=NO into Expo.plist
 *          and expo.modules.updates.ENABLED=false into AndroidManifest.xml.
 *        → StartupProcedure short-circuits, errorRecoveryQueue is never armed,
 *          UpdatesPackage.invokeReadyRunnable signals "ready" immediately
 *          without going to network.
 *     3. NO `runtimeVersion` block (only meaningful when enabled=true).
 *     4. NO `updates.url` (no point if enabled=false).
 *
 *   What this fixes vs the previous attempts:
 *     v1.0.13: default expo-updates → SIGABRT crashing cold-start
 *     v1.0.14: checkAutomatically=NEVER, expo-updates still installed
 *              → Android: ReactHost stuck waiting on UpdatesPackage.invokeReadyRunnable
 *              → iOS: errorRecoveryQueue threw uncaught NSException → SIGABRT
 *     v1.0.15: expo-updates UNINSTALLED, no updates block
 *              → iOS: white screen (broken bundle embed due to stale Xcode build phase)
 *              → Android: untested (build quota wall hit)
 *     v1.0.16: expo-updates INSTALLED + enabled:false
 *              → Native infrastructure intact, runtime cleanly disabled.
 *
 *   Expected behavior after this fix:
 *     - App launches past splash to auth screen normally
 *     - No expo-updates errors in logcat / Sentry
 *     - Sentry begins receiving events with release="staging@1.0.16"
 *     - Lumi audio + orbit work as in dev validation
 *
 *   Rollback path if v1.0.16 still fails:
 *     If iOS still white-screens after this, the bug is NOT in expo-updates.
 *     Next investigation would be the Expo plugin chain (vision-camera,
 *     Sentry plugin) or the @react-native-firebase peer dep (if present).
 *     Would require WSL2 or Mac access to inspect generated AppDelegate.swift.
 *
 *   To turn OTAs ON later (probably post-launch, JS-only hotfixes):
 *     1. Change `enabled: false` to `enabled: true` (or remove the field — defaults to true)
 *     2. Add back `url: 'https://u.expo.dev/7fe2d61b-242a-4de3-91a7-1422f6876164'`
 *     3. Add back `runtimeVersion: { policy: 'appVersion' }`
 *     4. Build, then adopt smoke-test discipline before each `eas update` publish
 *
 *   Apple ITMS-90683 fixes (carried from v4.5.4):
 *     - NSLocationWhenInUseUsageDescription (vision-camera transitive)
 *     - NSMicrophoneUsageDescription (defensive for expo-audio)
 *
 *   Version bumped 1.0.15 → 1.0.16. Fresh AAB/IPA, monotonic buildNumber.
 *
 * ─── v4.5.3-v4.5.4 (rolled forward) — single-application design ───────────
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
 *   Windows CMD reminder: `eas submit` reads app.config.js locally with your
 *   shell env. With APP_VARIANT unset, falls back to 'development' → resolves
 *   to .dev package which doesn't exist on Play Console. Always:
 *     set APP_VARIANT=production && eas submit ...
 *
 * ─── EAS Secrets (current operational state) ─────────────────────────────
 *
 *   Two Supabase projects, operationally split:
 *     zhnaxafmacygbhpvtwvf → staging (dev + tester builds)
 *     vwlfzvabvlcozqpepsoi → production (public launch)
 *
 *   EAS environments:
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
    version: '1.0.17',
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
        // Apple ITMS-90683 preempt. Bundled library references location APIs.
        // Lexi-Lens does not actually use location → no user prompt.
        NSLocationWhenInUseUsageDescription:
          'Lexi-Lens does not use your location. This declaration is required by a bundled library and the API is never actually called.',
        // Defensive — expo-audio iOS may probe AVAudioSession.
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
      eas: {
        projectId: '7fe2d61b-242a-4de3-91a7-1422f6876164',
      },
      appVariant: VARIANT,
    },

    // ── expo-updates: installed but disabled ─────────────────────────────
    //
    // expo-updates IS reinstalled in package.json (v1.0.16 onwards). The
    // `enabled: false` setting tells Expo's plugin to write:
    //   - EXUpdatesEnabled=NO into ios/Lexi-Lens/Supporting/Expo.plist
    //   - expo.modules.updates.ENABLED=false into AndroidManifest.xml
    //
    // Effect: native module compiles into binary (AppDelegate references
    // remain valid, main.jsbundle embeds correctly), but the runtime
    // StartupProcedure short-circuits and never goes to network or wait
    // states. The previous failure modes (Android black-screen-forever,
    // iOS SIGABRT in errorRecoveryQueue, v1.0.15 white screen) all came
    // from the runtime side. With runtime disabled, none of them can fire.
    //
    // To turn OTAs ON in a future release:
    //   updates: {
    //     url: 'https://u.expo.dev/7fe2d61b-242a-4de3-91a7-1422f6876164',
    //     enabled: true,  // or omit (defaults to true)
    //     checkAutomatically: 'ON_LOAD',
    //   },
    //   runtimeVersion: {
    //     policy: 'appVersion',
    //   },
    updates: {
      enabled: false,
    },

    owner: 'navinj',
    scheme: id.scheme,
  },
};
