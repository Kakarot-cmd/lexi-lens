#!/usr/bin/env bash
# ============================================================================
# scripts/build-android.sh
# Lexi-Lens — local Android release build (macOS / Linux)
#
# Bash port of scripts/build-android.cmd. Behaviour-identical so the two
# machines (Windows CMD rig + Mac M-series rig) produce byte-equivalent AABs
# from the same source. Handles:
#   1. Validates .env.local has required EXPO_PUBLIC_* vars (else fail fast)
#   2. Resolves APP_VARIANT (arg > existing env > default 'staging')
#   3. Runs the Jest regression gate (test/) before spending build time
#   4. Optional: bump versionCode in android/app/build.gradle
#   5. Skips Sentry source-map upload (no auth token needed locally)
#   6. Runs ./gradlew :app:bundleRelease
#   7. Verifies AAB exists + compares signing SHA1 to the expected upload key
#
# Usage:
#   ./scripts/build-android.sh                 build current versionCode (staging)
#   ./scripts/build-android.sh bump            bump versionCode +1, then build
#   ./scripts/build-android.sh clean           clean :app then build (slower)
#   ./scripts/build-android.sh bump production  bump + build with prod env
#   ./scripts/build-android.sh skiptest         bypass the Jest gate (known-good rebuild)
# Args combine in any order: ./scripts/build-android.sh staging bump skiptest
#
# Prerequisites (one-time setup — see docs/BUILD_ANDROID_MAC.md):
#   - .env.local at repo root with EXPO_PUBLIC_* vars filled in (staging)
#   - android/gradle.properties has LEXILENS_UPLOAD_* keystore properties,
#     with a MAC path (forward slashes), e.g.
#       LEXILENS_UPLOAD_STORE_FILE=/Users/nj/lexi-lens-secrets/lexilens-upload.jks
#   - plugins/withReleaseSigningConfig.js registered in app.config.js
#   - `npx expo prebuild --platform android --clean` run at least once with the
#     CORRECT APP_VARIANT baked in (see Two-Stage Build Model in BUILD_PLAYBOOK)
#
# This script NEVER runs prebuild. It only runs Gradle against the already
# generated android/ folder. If the baked applicationId is wrong (.dev), no
# argument to this script can fix it — re-prebuild first (Flow 2).
#
# iOS is unaffected by this script. iOS ships via the local Xcode archive flow
# (docs/iOS_LOCAL_TESTFLIGHT_RUNBOOK.md), a separate workstream.
# ============================================================================

# Expected Play upload-key fingerprint for com.navinj.lexilore.
EXPECTED_SHA1="9C:EB:47:42:33:D7:BB:BB:6E:ED:FF:7B:10:84:55:54:CD:58:8B:D4"

# ── Resolve project root (script lives in <root>/scripts) ───────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

echo ""
echo "=== Lexi-Lens Android Build (macOS/Linux) ==="
echo "Project: $PROJECT_ROOT"
echo ""

# ── Parse args (any order) ──────────────────────────────────────────────────
DO_BUMP=0
DO_CLEAN=0
SKIP_TEST=0
REQUESTED_VARIANT=""

for arg in "$@"; do
  case "$(printf '%s' "$arg" | tr '[:upper:]' '[:lower:]')" in
    bump)        DO_BUMP=1 ;;
    clean)       DO_CLEAN=1 ;;
    skiptest)    SKIP_TEST=1 ;;
    staging)     REQUESTED_VARIANT="staging" ;;
    production)  REQUESTED_VARIANT="production" ;;
    development) REQUESTED_VARIANT="development" ;;
    *) echo "[warn] Unrecognized arg '$arg' — ignoring." ;;
  esac
done

# ── Determine APP_VARIANT: explicit arg > existing env > default 'staging' ───
if [ -n "$REQUESTED_VARIANT" ]; then
  export APP_VARIANT="$REQUESTED_VARIANT"
elif [ -z "${APP_VARIANT:-}" ]; then
  export APP_VARIANT="staging"
  echo "[warn] APP_VARIANT not set; defaulting to 'staging'."
  echo "       For prod builds, pass 'production' as an argument."
fi
echo "[env] APP_VARIANT = $APP_VARIANT"

# NOTE: APP_VARIANT here only influences JS-side env resolution at bundle time.
# It does NOT change the baked applicationId — that was frozen at prebuild.
# Pre-flight gate below catches a mismatched baked package before we waste a build.

# ── Pre-flight gate: confirm the baked package matches a Play-bound build ────
GRADLE_FILE="android/app/build.gradle"
if [ ! -f "$GRADLE_FILE" ]; then
  echo ""
  echo "[ERROR] $GRADLE_FILE not found — android/ was never prebuilt."
  echo "Run Flow 2 first (see docs/BUILD_ANDROID_MAC.md): set APP_VARIANT then"
  echo "  npx expo prebuild --platform android --clean"
  exit 1
fi

BAKED_APP_ID="$(grep -E '^\s*applicationId' "$GRADLE_FILE" | head -1 | sed -E "s/.*applicationId[ '\"]*([a-zA-Z0-9._]+).*/\1/")"
echo "[env] baked applicationId = ${BAKED_APP_ID:-<unreadable>}"
if echo "$BAKED_APP_ID" | grep -q '\.dev$'; then
  echo ""
  echo "[ERROR] Baked applicationId is a .dev variant ($BAKED_APP_ID)."
  echo "        A development-variant AAB is rejected by Play (wrong package)."
  echo "        Fix with Flow 2 — re-prebuild under staging/production:"
  echo "          export APP_VARIANT=staging"
  echo "          export EXPO_PUBLIC_APP_VARIANT=staging"
  echo "          npx expo prebuild --platform android --clean"
  echo "        then restore keystore props + versionCode (see BUILD_ANDROID_MAC.md)."
  exit 1
fi

# ── Validate .env.local exists and has required vars ────────────────────────
if [ ! -f ".env.local" ]; then
  echo ""
  echo "[ERROR] .env.local not found at repo root."
  echo "See docs/BUILD_ANDROID_MAC.md for the required shape."
  echo ".env.local.template at repo root has a starter you can copy."
  exit 1
fi

MISSING_VARS=""
check_var() {
  # $1 = var name; flags it missing unless a non-empty value is present.
  if ! grep -Eq "^$1=.+" .env.local; then
    MISSING_VARS="$MISSING_VARS $1"
  fi
}
check_var EXPO_PUBLIC_SUPABASE_URL
check_var EXPO_PUBLIC_SUPABASE_ANON_KEY
check_var EXPO_PUBLIC_SENTRY_DSN

if [ -n "$MISSING_VARS" ]; then
  echo ""
  echo "[ERROR] .env.local is missing required values for:$MISSING_VARS"
  echo ""
  echo "Each must be set to a non-empty value, e.g.:"
  echo "  EXPO_PUBLIC_SUPABASE_URL=https://zhnaxafmacygbhpvtwvf.supabase.co"
  echo ""
  echo "Fetch staging values via: eas env:list --environment development"
  exit 1
fi
echo "[env] .env.local validation passed."

# ── Regression gate: run the Jest suite before spending build time ──────────
if [ "$SKIP_TEST" = "1" ]; then
  echo "[test] SKIPPED via 'skiptest' arg."
else
  echo "[test] Running Jest regression suite (test/)..."
  (
    cd test
    if [ ! -d node_modules ]; then
      echo "[test] Installing test deps (first run only)..."
      npm install --silent
    fi
    npx jest --config jest.config.json
  )
  TEST_EXIT=$?
  if [ "$TEST_EXIT" != "0" ]; then
    echo ""
    echo "[TEST FAILED] Jest exited with code $TEST_EXIT — aborting before Gradle."
    echo "Fix the failing test, or pass 'skiptest' to bypass intentionally."
    exit 1
  fi
  echo "[test] All suites green."
  echo ""
fi

# ── Optional: bump versionCode (portable, no BSD/GNU sed -i divergence) ──────
if [ "$DO_BUMP" = "1" ]; then
  echo "[bump] Reading current versionCode from $GRADLE_FILE..."
  CURRENT_VC="$(grep -Eo 'versionCode[[:space:]]+[0-9]+' "$GRADLE_FILE" | head -1 | grep -Eo '[0-9]+')"
  if [ -z "$CURRENT_VC" ]; then
    echo "[bump] ERROR: Could not parse versionCode from build.gradle — aborting."
    exit 1
  fi
  NEW_VC=$((CURRENT_VC + 1))
  echo "[bump] Incrementing versionCode: $CURRENT_VC -> $NEW_VC"
  # awk (not sed) — portable across BSD/macOS and GNU. Matching on the exact
  # numeric field ($2==old) avoids a 'versionCode 29' bump corrupting a
  # 'versionCode 290' elsewhere; sed \b word-boundaries are not portable to
  # BSD sed and would silently no-op on macOS.
  TMP_GRADLE="$(mktemp)"
  awk -v old="$CURRENT_VC" -v new="$NEW_VC" '
    $1=="versionCode" && $2==old {
      sub(/versionCode[[:space:]]+[0-9]+/, "versionCode " new); print; next
    }
    { print }
  ' "$GRADLE_FILE" > "$TMP_GRADLE"
  mv "$TMP_GRADLE" "$GRADLE_FILE"
  echo "[bump] Done. versionCode line now:"
  grep -E 'versionCode' "$GRADLE_FILE" | head -1
  echo ""
  echo "[bump] REMINDER: 'bump' only adds 1 to the LOCAL value. After a"
  echo "       'prebuild --clean' the local value resets to a default and bump"
  echo "       will produce a number Play has already burned. Set versionCode"
  echo "       manually to (Play App-bundle-explorer max + 1) for the first"
  echo "       post-clean build."
fi

# ── Sentry source-map upload: skip in local builds ──────────────────────────
export SENTRY_DISABLE_AUTO_UPLOAD=true
echo "[sentry] Source-map upload DISABLED for this build."
echo ""

# ── Stop any leftover Gradle daemons ────────────────────────────────────────
echo "[gradle] Stopping previous Gradle daemons..."
( cd android && ./gradlew --stop >/dev/null 2>&1 || true )

# ── Optional clean ──────────────────────────────────────────────────────────
if [ "$DO_CLEAN" = "1" ]; then
  echo "[gradle] Cleaning :app module..."
  ( cd android && ./gradlew :app:clean )
  echo ""
fi

# ── The actual build ────────────────────────────────────────────────────────
echo "[gradle] Running :app:bundleRelease..."
echo ""
( cd android && ./gradlew :app:bundleRelease )
BUILD_EXIT=$?
if [ "$BUILD_EXIT" != "0" ]; then
  echo ""
  echo "[BUILD FAILED] Gradle exited with code $BUILD_EXIT"
  exit "$BUILD_EXIT"
fi

# ── Verify AAB exists ───────────────────────────────────────────────────────
AAB_PATH="android/app/build/outputs/bundle/release/app-release.aab"
if [ ! -f "$AAB_PATH" ]; then
  echo ""
  echo "[VERIFY FAILED] Build reported success but AAB missing: $AAB_PATH"
  exit 1
fi

echo ""
echo "=== BUILD SUCCESS ==="
AAB_BYTES="$(wc -c < "$AAB_PATH" | tr -d ' ')"
echo "AAB:  $PROJECT_ROOT/$AAB_PATH  ($AAB_BYTES bytes)"

# ── Verify keystore signature (best-effort, auto-compares to expected) ──────
# keytool discovery order: PATH -> $JAVA_HOME -> macOS Android Studio bundle.
KEYTOOL=""
if command -v keytool >/dev/null 2>&1; then
  KEYTOOL="keytool"
elif [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/keytool" ]; then
  KEYTOOL="$JAVA_HOME/bin/keytool"
elif [ -x "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/keytool" ]; then
  KEYTOOL="/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/keytool"
fi

if [ -n "$KEYTOOL" ]; then
  echo ""
  echo "[verify] Signing certificate:"
  ACTUAL_SHA1="$("$KEYTOOL" -printcert -jarfile "$AAB_PATH" 2>/dev/null \
    | grep -iE 'SHA-?1:' | head -1 \
    | grep -Eo '([0-9A-Fa-f]{2}:){19}[0-9A-Fa-f]{2}' \
    | tr '[:lower:]' '[:upper:]')"
  echo "  Actual   SHA1: ${ACTUAL_SHA1:-<could not extract>}"
  echo "  Expected SHA1: $EXPECTED_SHA1"
  if [ "$ACTUAL_SHA1" = "$EXPECTED_SHA1" ]; then
    echo "  [verify] MATCH — Play Console upload will be accepted."
  else
    echo "  [verify] MISMATCH — do NOT upload. Keystore is wrong (check"
    echo "           android/gradle.properties LEXILENS_UPLOAD_STORE_FILE path"
    echo "           and that the plugin injected signingConfigs.release)."
  fi
else
  echo "[verify] Skipped — keytool not found on PATH, \$JAVA_HOME, or the"
  echo "         Android Studio bundle. Add a JDK bin to PATH to enable this check."
fi

echo ""
echo "Next: upload AAB to Play Console -> Internal Testing -> Create new release"
echo ""
exit 0
