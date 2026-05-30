/**
 * plugins/withGradleMemory.js
 * Lexi-Lens — build automation (May 30, 2026)
 *
 * Android-only Expo config plugin that pins the Gradle daemon's JVM memory
 * settings in android/gradle.properties on every `npx expo prebuild`.
 *
 * ─── Why this exists ─────────────────────────────────────────────────────
 *
 * `android/gradle.properties` is gitignored and is regenerated from the Expo
 * template on every `prebuild --clean`. The template default is conservative:
 *
 *     org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m
 *
 * A RELEASE bundle build (R8 / dexing in :app:packageReleaseBundle) exhausts
 * that metaspace and dies with `java.lang.OutOfMemoryError: Metaspace`. A
 * DEBUG build does not, which is why USB sideload builds pass but the store
 * AAB failed (2026-05-30). Bumping the value by hand fixes one build, but the
 * next `--clean` silently reverts it — a recurring trap by exactly the
 * mechanism the build playbook warns about.
 *
 * This plugin makes the fix survive prebuild: it upserts org.gradle.jvmargs
 * to a release-safe value every time android/ is regenerated. Committed to
 * the repo, so both the Mac and Windows rigs inherit it automatically.
 *
 * NOTE on expo-build-properties: as of expo-build-properties@1.0.10 (the
 * version pinned in package.json) there is NO `gradleProperties` / `jvmArgs`
 * option in its Android schema — verified against the installed .d.ts. The
 * supported keys are minSdkVersion, compileSdkVersion, enableProguard, etc.,
 * but not arbitrary gradle.properties entries. A dedicated config plugin via
 * `withGradleProperties` is the correct mechanism, mirroring the existing
 * plugins/withReleaseSigningConfig.js pattern.
 *
 * ─── What it sets ────────────────────────────────────────────────────────
 *
 *     org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m \
 *                        -XX:+HeapDumpOnOutOfMemoryError -Dfile.encoding=UTF-8
 *
 * 4 GiB heap + 1 GiB metaspace clears the release R8 step with headroom on
 * both the M-series Mac (24 GB) and the Windows rig. Override per-machine by
 * setting GRADLE_JVMARGS in the shell before prebuild — useful for a
 * lower-RAM CI box. The heap-dump flag aids diagnosis if it ever OOMs again.
 *
 * Idempotent: replaces the value if the key exists, appends it if it doesn't.
 * Running prebuild repeatedly is safe.
 *
 * ─── iOS safety ──────────────────────────────────────────────────────────
 *
 * `withGradleProperties` only schedules an Android `gradle.properties` mod.
 * Its callback never fires during `npx expo prebuild --platform ios`, and it
 * writes nothing into ios/. The generated ios/ folder is byte-identical with
 * or without this plugin (same verification recipe as
 * docs/BUILD_ANDROID_LOCAL.md §6).
 */

const { withGradleProperties } = require('@expo/config-plugins');

// Per-machine override hook; falls back to the release-safe default.
const JVM_ARGS =
  process.env.GRADLE_JVMARGS ||
  '-Xmx4096m -XX:MaxMetaspaceSize=1024m -XX:+HeapDumpOnOutOfMemoryError -Dfile.encoding=UTF-8';

const KEY = 'org.gradle.jvmargs';

const withGradleMemory = (config) => {
  return withGradleProperties(config, (config) => {
    const items = config.modResults; // array of {type:'property'|'comment', ...}

    const existing = items.find(
      (item) => item.type === 'property' && item.key === KEY,
    );

    if (existing) {
      if (existing.value !== JVM_ARGS) {
        console.log(
          `[withGradleMemory] Updating ${KEY}: "${existing.value}" -> "${JVM_ARGS}"`,
        );
        existing.value = JVM_ARGS;
      }
      // else: already correct, no-op (idempotent).
    } else {
      console.log(`[withGradleMemory] Adding ${KEY}=${JVM_ARGS}`);
      items.push({ type: 'property', key: KEY, value: JVM_ARGS });
    }

    return config;
  });
};

module.exports = withGradleMemory;
