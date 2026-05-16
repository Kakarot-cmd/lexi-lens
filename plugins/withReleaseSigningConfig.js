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
 * If gradle.properties is missing the properties, the plugin's injected
 * `project.hasProperty(...)` guard falls back gracefully — release builds
 * silently sign with debug instead of failing the build. This is intentional:
 * developers on a fresh checkout can still produce *debug* APKs without
 * needing the production keystore. Only release AABs need the upload key.
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
            // Falls back gracefully if properties missing — release variant signs
            // with debug keystore in that case, which Play will reject but local
            // dev/debug workflows continue to function.
            if (project.hasProperty('LEXILENS_UPLOAD_STORE_FILE')) {
                storeFile     file(LEXILENS_UPLOAD_STORE_FILE)
                storePassword LEXILENS_UPLOAD_STORE_PASSWORD
                keyAlias      LEXILENS_UPLOAD_KEY_ALIAS
                keyPassword   LEXILENS_UPLOAD_KEY_PASSWORD
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
    const wrongSigningPattern = /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig\s+signingConfigs\.debug/;

    if (wrongSigningPattern.test(contents)) {
      contents = contents.replace(
        wrongSigningPattern,
        '$1signingConfig signingConfigs.release',
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
