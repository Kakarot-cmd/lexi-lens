/**
 * app.config.js — Lexi-Lens dynamic Expo config (v4.5.6)
 *
 * v4.5.6 (May 14, 2026) — iOS Build 17 white-screen root cause hypothesis.
 *
 *   What v4.5.5 / v1.0.16-17 got right:
 *     The Android-side fix (expo-updates installed + enabled:false) is
 *     confirmed working — local Gradle AAB boots cleanly on Play Internal.
 *
 *   What v4.5.5 / v1.0.16-17 got wrong:
 *     The assumption that the same plugin change would propagate cleanly to
 *     iOS via `EXUpdatesEnabled=NO` in Expo.plist was extrapolation, not
 *     verification. v1.0.17 (Build 17) on TestFlight: complete white screen,
 *     no .ips crash file, confirmed across multiple devices.
 *
 *   The actual iOS-specific issue (separate from the Android updates problem):
 *
 *     React Native 0.81 + Expo SDK 54 introduced precompiled iOS XCFrameworks
 *     (ReactNativeDependencies, RNCore) shipped as binaries alongside source.
 *     The auto-generated Podfile from `npx expo prebuild` contains:
 *
 *       ENV['RCT_USE_RN_DEP']        = '1' if buildReactNativeFromSource != 'true'
 *                                          && newArchEnabled != 'false'
 *       ENV['RCT_USE_PREBUILT_RNCORE'] = '1' if buildReactNativeFromSource != 'true'
 *                                          && newArchEnabled != 'false'
 *
 *     Our config:
 *       newArchEnabled: true             → 2nd clause satisfied
 *       buildReactNativeFromSource unset → 1st clause satisfied
 *
 *     Result: EAS Cloud builds iOS with both precompiled XCFrameworks.
 *
 *     RN 0.81.0 had a known bug: Release builds using these precompiled
 *     XCFrameworks shipped without proper code signing on the frameworks,
 *     causing iOS to fail to load them silently at app launch. The reported
 *     fix shipped in 0.81.1 (we're on 0.81.5), but the community discussion
 *     thread (RN proposals #923) shows ongoing reports through late 2025/2026
 *     of precompiled-binary code signing failures with various library
 *     combinations on Release builds — particularly with autolinked native
 *     modules that touch React's bridge (Sentry, Vision Camera, Reanimated).
 *
 *     Symptom triplet matches our Build 17 exactly:
 *       1. App installs cleanly via TestFlight ✓
 *       2. App launches, splash dismisses ✓
 *       3. White screen forever, no .ips, no Sentry events ✓
 *
 *     This pattern is consistent with: framework loaded into process address
 *     space but RN's bridgeless init can't find required symbols (code
 *     signing rejection on launch causes silent symbol resolution failure
 *     in the bridgeless path on iOS). No exception is thrown — the JS engine
 *     simply never gets a bundle to execute.
 *
 *   The fix:
 *     Set `expo-build-properties.ios.buildReactNativeFromSource: true`.
 *
 *   What this does:
 *     Disables RCT_USE_RN_DEP and RCT_USE_PREBUILT_RNCORE in the generated
 *     Podfile. EAS Cloud will compile React Native and its dependencies from
 *     source instead of pulling the precompiled XCFrameworks. The resulting
 *     binary embeds RN code signed by EAS's iOS signing keychain — same as
 *     every other native module in the app, no codesign mismatch possible.
 *
 *   Trade-off:
 *     iOS EAS build time will go up by roughly 5–10 minutes (precompiled was
 *     introduced specifically to speed builds). Acceptable for now — we're
 *     not iterating on iOS native code, just shipping JS changes.
 *
 *   Confidence:
 *     Strong but not certain. The hypothesis fits the symptom precisely and
 *     is grounded in documented Expo/RN behavior. If Build 18 still
 *     white-screens after this fix, the issue is NOT precompiled XCFrameworks
 *     and we move to the next hypothesis — likely New Arch + library
 *     interaction (Reanimated 4 + Worklets + Vision Camera 4.7).
 *
 *   Fallback plan if v1.0.18 also fails:
 *     1. Set `newArchEnabled: false` and build v1.0.19 — eliminates the
 *        bridgeless code path entirely. Most aggressive isolation.
 *     2. Comment out `Sentry.wrap(App)` in App.tsx — rules out Sentry SDK
 *        interaction with bridgeless RN.
 *     3. Strip App.tsx down to a single colored View rendering "OK" — proves
 *        whether ANY JS executes on iOS. If yes → app code issue. If no →
 *        native bundle/framework issue.
 *
 *   Version bumped 1.0.17 → 1.0.18.
 *
 * ─── v4.5.5 (rolled forward, historical context) ─────────────────────────────
 *
 *   v4.5.5 reinstalled expo-updates and set `enabled: false`. This was the
 *   right call for Android — Android v1.0.16/17 boots cleanly with this
 *   config. The fix propagates to AndroidManifest.xml as
 *   `expo.modules.updates.ENABLED=false` which short-circuits the
 *   StartupProcedure before DatabaseLauncher.launch can hang.
 *
 *   The iOS-side propagation (EXUpdatesEnabled=NO in Expo.plist) was
 *   syntactically correct but did not address the actual iOS white-screen
 *   root cause, which is the precompiled XCFramework issue documented above.
 *
 *   The `updates: { enabled: false }` block remains intact in this version
 *   for the Android benefit. iOS will additionally get the from-source RN
 *   build, addressing both issues independently.
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
    version: '1.0.24',
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
            // ── v4.5.6 (May 14, 2026) — iOS Build 17 white-screen fix ────────
            //
            // Forces EAS Cloud to compile React Native from source instead
            // of using the precompiled XCFrameworks introduced in RN 0.81.
            // The precompiled binaries (ReactNativeDependencies, RNCore) have
            // had documented code signing issues on Release builds since RN
            // 0.81.0 (Expo SDK 54 changelog); the supposed fix in 0.81.1 did
            // not resolve all cases — community reports through 2026 show
            // ongoing failures with various library combinations.
            //
            // Trade-off: iOS build time +5–10 min. Acceptable for now.
            //
            // To revert (faster builds, only safe once RN ships a confirmed
            // precompiled-binary code signing fix and we've validated it):
            //   remove the buildReactNativeFromSource line, or set to false.
            buildReactNativeFromSource: true,
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

    // ── expo-updates: installed but disabled (v4.5.5, retained) ──────────
    //
    // expo-updates IS reinstalled in package.json (v1.0.16 onwards). The
    // `enabled: false` setting tells Expo's plugin to write:
    //   - EXUpdatesEnabled=NO into ios/Lexi-Lens/Supporting/Expo.plist
    //   - expo.modules.updates.ENABLED=false into AndroidManifest.xml
    //
    // Effect: native module compiles into binary, but the runtime
    // StartupProcedure short-circuits. This fix is verified working on
    // Android (v1.0.16/17 Gradle build boots clean). On iOS it is necessary
    // but not sufficient — Build 17 still white-screened, which is what
    // v4.5.6's buildReactNativeFromSource:true is addressing separately.
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
