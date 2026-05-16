@echo off
REM ============================================================================
REM scripts\build-android.cmd
REM Lexi-Lens — local Android release build (Phase 4.4 build automation)
REM
REM One-command production AAB build. Handles:
REM   1. Validates .env.local has required EXPO_PUBLIC_* vars (else fail fast)
REM   2. Sets APP_VARIANT if not already exported
REM   3. Skips Sentry source-map upload (no auth token needed locally)
REM   4. Optional: bump versionCode by reading current and incrementing
REM   5. Runs gradlew :app:bundleRelease
REM   6. Verifies AAB exists + reports SHA1 fingerprint for sanity check
REM
REM Usage:
REM   scripts\build-android.cmd                — build current versionCode
REM   scripts\build-android.cmd bump           — bump versionCode +1, then build
REM   scripts\build-android.cmd clean          — clean :app then build (slower)
REM   scripts\build-android.cmd bump production — bump + build with prod env
REM
REM Prerequisites (one-time setup — see docs/BUILD_ANDROID_LOCAL.md):
REM   - .env.local at repo root with EXPO_PUBLIC_* vars filled in
REM   - android\gradle.properties has LEXILENS_UPLOAD_* keystore properties
REM   - plugins\withReleaseSigningConfig.js registered in app.config.js
REM   - npx expo prebuild --platform android --clean has been run at least once
REM ============================================================================

setlocal EnableDelayedExpansion

REM Resolve script directory and project root.
set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%.."
pushd "%PROJECT_ROOT%"

echo.
echo === Lexi-Lens Android Build ===
echo Project: %CD%
echo.

REM ── Parse args ─────────────────────────────────────────────────────────────
REM Args can come in any order. Look for known tokens.
set "DO_BUMP=0"
set "DO_CLEAN=0"
set "REQUESTED_VARIANT="

:parse_args
if "%~1"=="" goto args_done
if /I "%~1"=="bump"        set "DO_BUMP=1"
if /I "%~1"=="clean"       set "DO_CLEAN=1"
if /I "%~1"=="staging"     set "REQUESTED_VARIANT=staging"
if /I "%~1"=="production"  set "REQUESTED_VARIANT=production"
if /I "%~1"=="development" set "REQUESTED_VARIANT=development"
shift
goto parse_args
:args_done

REM ── Determine APP_VARIANT ──────────────────────────────────────────────────
REM Priority: explicit arg > existing shell var > default 'staging'
if defined REQUESTED_VARIANT set "APP_VARIANT=!REQUESTED_VARIANT!"
if not defined APP_VARIANT (
    set "APP_VARIANT=staging"
    echo [warn] APP_VARIANT not set; defaulting to 'staging'.
    echo        For prod builds, pass 'production' as an argument.
)
echo [env] APP_VARIANT = %APP_VARIANT%

REM ── Validate .env.local exists and has required vars ──────────────────────
if not exist ".env.local" (
    echo.
    echo [ERROR] .env.local not found at repo root.
    echo See docs/BUILD_ANDROID_LOCAL.md section 3 for the required shape.
    echo .env.local.template at repo root has a starter you can copy.
    popd
    endlocal
    exit /b 1
)

set "MISSING_VARS="
call :check_var EXPO_PUBLIC_SUPABASE_URL
call :check_var EXPO_PUBLIC_SUPABASE_ANON_KEY
call :check_var EXPO_PUBLIC_SENTRY_DSN

if defined MISSING_VARS (
    echo.
    echo [ERROR] .env.local is missing required values for:!MISSING_VARS!
    echo.
    echo Each must be set to a non-empty value, e.g.:
    echo   EXPO_PUBLIC_SUPABASE_URL=https://zhnaxafmacygbhpvtwvf.supabase.co
    echo.
    echo Fetch staging values via: eas env:list --environment development
    popd
    endlocal
    exit /b 1
)
echo [env] .env.local validation passed.

REM ── Optional: bump versionCode (delegated to subroutine) ───────────────────
if "!DO_BUMP!"=="1" (
    call :bump_version_code
    if errorlevel 1 (
        echo [bump] FAILED — aborting build.
        popd
        endlocal
        exit /b 1
    )
)

REM ── Sentry source-map upload: skip in local builds ─────────────────────────
REM Production EAS Cloud builds upload source maps via SENTRY_AUTH_TOKEN.
REM Local Gradle builds skip — sandbox testing doesn't need symbolication.
REM For prod-with-source-maps locally, configure android/sentry.properties
REM (see docs/BUILD_ANDROID_LOCAL.md section 9).
set SENTRY_DISABLE_AUTO_UPLOAD=true
echo [sentry] Source-map upload DISABLED for this build.
echo.

REM ── Stop any leftover Gradle daemons (prevents Windows file-lock issues) ───
echo [gradle] Stopping previous Gradle daemons...
pushd android
call gradlew --stop > nul 2>&1
popd

REM ── Optional clean ─────────────────────────────────────────────────────────
if "!DO_CLEAN!"=="1" (
    echo [gradle] Cleaning :app module...
    pushd android
    call gradlew :app:clean
    popd
    echo.
)

REM ── The actual build ───────────────────────────────────────────────────────
echo [gradle] Running :app:bundleRelease...
echo.
pushd android
call gradlew :app:bundleRelease
set "BUILD_EXIT=%ERRORLEVEL%"
popd

if not "%BUILD_EXIT%"=="0" (
    echo.
    echo [BUILD FAILED] Gradle exited with code %BUILD_EXIT%
    popd
    endlocal
    exit /b %BUILD_EXIT%
)

REM ── Verify AAB exists ──────────────────────────────────────────────────────
set "AAB_PATH=android\app\build\outputs\bundle\release\app-release.aab"

if not exist "%AAB_PATH%" (
    echo.
    echo [VERIFY FAILED] Build reported success but AAB missing: %AAB_PATH%
    popd
    endlocal
    exit /b 1
)

echo.
echo === BUILD SUCCESS ===
for %%I in ("%AAB_PATH%") do echo AAB:  %%~fI  ^(%%~zI bytes^)

REM ── Verify keystore signature (best-effort) ────────────────────────────────
set "KEYTOOL=C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe"
if exist "%KEYTOOL%" (
    echo.
    echo [verify] Signing certificate:
    "%KEYTOOL%" -printcert -jarfile "%AAB_PATH%" 2>nul | findstr "SHA1:"
    echo.
    echo Expected Play upload SHA1:
    echo   SHA1: 9C:EB:47:42:33:D7:BB:BB:6E:ED:FF:7B:10:84:55:54:CD:58:8B:D4
    echo If the SHA1 above matches, upload to Play Console will succeed.
) else (
    echo [verify] Skipped — keytool not at %KEYTOOL%
    echo          Add JDK bin to PATH or check Android Studio install location.
)

echo.
echo Next: upload AAB to Play Console -^> Internal Testing -^> Create new release
echo.

popd
endlocal
exit /b 0

REM ============================================================================
REM Subroutines (reached only via CALL; never fall through into these)
REM ============================================================================

:check_var
REM %1 = variable name to look for in .env.local with a non-empty value.
REM Appends to MISSING_VARS if missing/empty.
findstr /R /C:"^%~1=." .env.local > nul 2>&1
if errorlevel 1 set "MISSING_VARS=!MISSING_VARS! %~1"
goto :eof

:bump_version_code
REM Reads versionCode from android\app\build.gradle, increments by 1,
REM writes it back. Uses CALL + label legally (not inside a parens block).
echo.
echo [bump] Reading current versionCode from android\app\build.gradle...

set "CURRENT_VC="
for /f "tokens=2" %%a in ('findstr /R /C:"versionCode [0-9]" android\app\build.gradle') do (
    if not defined CURRENT_VC set "CURRENT_VC=%%a"
)

if not defined CURRENT_VC (
    echo [bump] ERROR: Could not parse versionCode from build.gradle.
    exit /b 1
)

set /a "NEW_VC=CURRENT_VC + 1"
echo [bump] Incrementing versionCode: !CURRENT_VC! -^> !NEW_VC!

powershell -NoProfile -Command "(Get-Content 'android\app\build.gradle' -Raw) -replace 'versionCode !CURRENT_VC!', 'versionCode !NEW_VC!' | Set-Content 'android\app\build.gradle' -NoNewline"

echo [bump] Done. versionCode lines now in build.gradle:
findstr /C:"versionCode" android\app\build.gradle
exit /b 0
