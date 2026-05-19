/**
 * plugins/withReleaseSigningConfig.js
 * Lexi-Lens — Phase 4.4 build automation (May 15, 2026)
 *
 * Android-only Expo config plugin that injects a release signing config into
 * android/app/build.gradle every time `npx expo prebuild` runs. Without
 * this plugin, prebuild regenerates build.gradle with the release variant
 * signed by the debug keystore — and the resulting AAB is rejected by
 * Play Console with "App Bundle is signed with the wrong key".
 *
 * The plugin makes two atomic edits to android/app/build.gradle:
 *
 *   1. Adds a `release { ... }` block inside `signingConfigs { ... }` that
 *      reads keystore credentials from project properties:
 *        - LEXILENS_UPLOAD_STORE_FILE
 *        - LEXILENS_UPLOAD_KEY_ALIAS
 *        - LEXILENS_UPLOAD_STORE_PASSWORD
 *        - LEXILENS_UPLOAD_KEY_PASSWORD
 *
 *   2. Changes `buildTypes.release.signingConfig` from `signingConfigs.debug`
 *      to `signingConfigs.release`.
 *
 * Both edits are idempotent — running prebuild repeatedly is safe; the
 * plugin detects whether the changes are already present and skips them.
 *
 * ─── iOS safety ─────────────────────────────────────────────────────────
 *
 * This plugin uses `withAppBuildGradle` from @expo/config-plugins, which
 * is implemented as a no-op for iOS builds (its callback only fires when
 * the Android prebuild pipeline is active). The plugin's callback never
 * executes during `npx expo prebuild --platform ios`.
 *
 * Verification: run `npx expo prebuild --platform ios --clean` with and
 * without this plugin registered. The generated ios/ folder should be
 * byte-identical. See docs/BUILD_ANDROID_LOCAL.md for the explicit
 * verification recipe.
 *
 * ─── Failure modes ──────────────────────────────────────────────────────
 *
 * Property source: android/gradle.properties (gitignored — contains real
 * keystore credentials). On a fresh clone, add the four LEXILENS_UPLOAD_*
 * properties manually — see docs/BUILD_ANDROID_LOCAL.md.
 *
 * If gradle.properties is missing the properties, the plugin degrades
 * correctly: the injected `release` SigningConfig mirrors the debug keystore
 * (so it is a valid, fully-populated config — not an empty one that makes
 * AGP throw), AND buildTypes.release stays pointed at signingConfigs.debug
 * via a Gradle-time `project.hasProperty(...)` ternary. Net: a fresh clone
 * or a --clean-wiped machine produces a working debug-signed APK with zero
 * secrets. Only release AABs destined for Play need the real upload key.
 * (Earlier versions of this plugin DOCUMENTED this fallback but did not
 * implement it — an empty release config crashed every Gradle task,
 * including assembleDebug. Fixed 2026-05-18.)
 *
 * If the build.gradle template's `signingConfigs.debug` block can't be
 * located (Expo updates its template and the regex misses), the plugin
 * logs an error and passes through. The build will succeed but produce an
 * unsigned-by-release-key AAB, which Play will reject with a clear SHA1
 * mismatch message — easy to debug from there.
 */

const { withAppBuildGradle } = require('@expo/config-plugins');

const RELEASE_SIGNING_BLOCK = `
        release {
            // Lexi-Lens upload keystore — injected by plugins/withReleaseSigningConfig.js.
            // Values resolved from android/gradle.properties (gitignored).
            //
            // When the LEXILENS_UPLOAD_* properties are PRESENT this configures
            // the real upload keystore. When ABSENT (fresh clone, dev machine,
            // after a --clean wipe of gradle.properties) it deliberately mirrors
            // the DEBUG signing config so the 'release' SigningConfig is fully
            // populated and valid — never an empty/half-evaluated config that
            // makes AGP throw 'unknown property LEXILENS_UPLOAD_STORE_PASSWORD'
            // and fail *every* task, including assembleDebug. Edit 2 below only
            // repoints buildTypes.release at this when the props exist, so a
            // keyless machine still produces a debug-signed APK as documented.
            if (project.hasProperty('LEXILENS_UPLOAD_STORE_FILE')) {
                storeFile     file(LEXILENS_UPLOAD_STORE_FILE)
                storePassword LEXILENS_UPLOAD_STORE_PASSWORD
                keyAlias      LEXILENS_UPLOAD_KEY_ALIAS
                keyPassword   LEXILENS_UPLOAD_KEY_PASSWORD
            } else {
                storeFile     file(signingConfigs.debug.storeFile)
                storePassword signingConfigs.debug.storePassword
                keyAlias      signingConfigs.debug.keyAlias
                keyPassword   signingConfigs.debug.keyPassword
            }
        }`;

const withReleaseSigningConfig = (config) => {
  // withAppBuildGradle's callback ONLY runs during Android prebuild.
  // iOS prebuild bypasses it entirely — the callback is never invoked.
  // This is an Expo API contract, but the iOS-safety doc above explains
  // how to verify it empirically.

  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      // Defensive: should never hit this branch since this callback only
      // fires for Android build.gradle. Pass through rather than throw.
      console.warn(
        '[withReleaseSigningConfig] Unexpected modResults.language: ' +
          config.modResults.language + ' (expected groovy). Skipping.',
      );
      return config;
    }

    let contents = config.modResults.contents;
    let edit1Applied = false;
    let edit2Applied = false;

    // ── Edit 1: Inject release { ... } into signingConfigs { ... } ──────────
    if (!contents.includes("LEXILENS_UPLOAD_STORE_FILE")) {
      const debugBlockPattern = /(signingConfigs\s*\{[\s\S]*?debug\s*\{[\s\S]*?\n\s*\})/;
      const match = contents.match(debugBlockPattern);

      if (!match) {
        // Not throwing — log loudly and skip. Throwing would break prebuild
        // for anyone whose build.gradle template diverges; too brittle for a
        // build-automation plugin. Worst case: AAB signs with debug, Play
        // rejects with SHA1 mismatch, developer fixes from there.
        console.error(
          '[withReleaseSigningConfig] ERROR: Could not locate signingConfigs.debug ' +
            'block in build.gradle. Release builds will sign with debug keystore ' +
            'and Play upload will fail. Inspect android/app/build.gradle template.',
        );
      } else {
        contents = contents.replace(debugBlockPattern, `$1${RELEASE_SIGNING_BLOCK}`);
        edit1Applied = true;
      }
    }

    // ── Edit 2: buildTypes.release.signingConfig debug → release ────────────
    //
    // ONLY repoint release at signingConfigs.release when the upload keystore
    // is actually configured. The plugin runs at prebuild time but the regex
    // edit bakes a static decision into build.gradle, so we cannot read
    // project.hasProperty here — instead we wrap the swapped value itself in
    // a Gradle-time ternary. With props absent this evaluates to
    // signingConfigs.debug (valid, debug-signed release — fine for local
    // dev/debug; never uploaded to Play). With props present it is
    // signingConfigs.release (the real upload key). Either way the value is a
    // fully-populated, valid SigningConfig, so AGP never throws during :app
    // evaluation and assembleDebug works with zero secrets.
    const wrongSigningPattern = /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig\s+signingConfigs\.debug/;

    if (wrongSigningPattern.test(contents)) {
      contents = contents.replace(
        wrongSigningPattern,
        "$1signingConfig (project.hasProperty('LEXILENS_UPLOAD_STORE_FILE') " +
          "? signingConfigs.release : signingConfigs.debug)",
      );
      edit2Applied = true;
    }

    if (edit1Applied || edit2Applied) {
      console.log(
        '[withReleaseSigningConfig] Injected release signing config (edit1=' +
          edit1Applied + ' edit2=' + edit2Applied + '). ' +
          'Set LEXILENS_UPLOAD_* in android/gradle.properties before bundleRelease.',
      );
    }

    config.modResults.contents = contents;
    return config;
  });
};

module.exports = withReleaseSigningConfig;
