# Local Android Build Setup

One-time setup for building signed Android AABs locally, plus reference for
how the build automation works and how to safely verify iOS isn't affected.

After this setup, every release build is one command:

```cmd
scripts\build-android.cmd          REM build current versionCode
scripts\build-android.cmd bump     REM increment versionCode, then build
scripts\build-android.cmd clean    REM clean :app, then build (slower)
```

The script:

- Validates `.env.local` exists and has required vars (fail fast if missing)
- Sets `APP_VARIANT=staging` if not already exported
- Disables Sentry source-map upload (no auth token needed locally)
- Optionally bumps `versionCode` in `build.gradle`
- Runs `gradlew :app:bundleRelease`
- Verifies the AAB exists and prints the SHA1 to confirm signing

---

## Prerequisites

| Tool | Where |
|---|---|
| Node.js + npm | https://nodejs.org |
| Java JDK 21 | bundled with Android Studio at `C:\Program Files\Android\Android Studio\jbr` |
| Android SDK | bundled with Android Studio at `C:\Users\<you>\AppData\Local\Android\Sdk` |
| EAS CLI | `npm install -g eas-cli` |

Verify they all work:

```cmd
node --version
"C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe" -help
eas whoami
```

---

## 1. Export the upload keystore from EAS (one-time)

The upload keystore is the cryptographic identity Google Play uses to verify
all AAB uploads. EAS Build manages it in the cloud; for local builds you must
export it once.

```cmd
cd C:\Users\Mouni\lexi-lens
eas credentials
```

Navigate:

1. Platform: **Android**
2. Profile: **staging** (or **production** — same keystore on both)
3. **Keystore: Manage everything needed to build your project**
4. **Download credentials**
5. Save to: `C:\Users\Mouni\lexi-lens-secrets\lexilens-upload.jks`

Also note the credentials EAS prints (key alias, keystore password, key
password). Save them to `lexi-lens-secrets\keystore-credentials.txt` —
you'll need them in step 2 and they are NOT recoverable if lost.

### Verify the keystore is the right one

The fingerprint must match what Play Console expects for `com.navinj.lexilore`:

```cmd
"C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe" ^
  -list -v ^
  -keystore C:\Users\Mouni\lexi-lens-secrets\lexilens-upload.jks ^
  -storepass <KEYSTORE_PASSWORD>
```

Look for the `SHA1:` line. **MUST be** `9C:EB:47:42:33:D7:BB:BB:6E:ED:FF:7B:10:84:55:54:CD:58:8B:D4`.

If it's any other fingerprint, you exported the wrong keystore — go back through
`eas credentials` and check both staging and production profiles.

---

## 2. Configure local Gradle to use the keystore

Create or edit `android\gradle.properties` and add at the bottom:

```properties
# ─── Lexi-Lens upload keystore (EAS-exported) ──────────────────────────
# Used by plugins/withReleaseSigningConfig.js to sign release AABs.
# This file is gitignored — never commit these values.
LEXILENS_UPLOAD_STORE_FILE=C:\\Users\\Mouni\\lexi-lens-secrets\\lexilens-upload.jks
LEXILENS_UPLOAD_KEY_ALIAS=<KEY_ALIAS_FROM_EAS>
LEXILENS_UPLOAD_STORE_PASSWORD=<KEYSTORE_PASSWORD_FROM_EAS>
LEXILENS_UPLOAD_KEY_PASSWORD=<KEY_PASSWORD_FROM_EAS>
```

Critical rules:

- **Double-backslashes** in the file path. Gradle reads single `\` as escape.
- **No quotes** around values.
- **No spaces** around `=`.
- The `android/` folder is gitignored (Expo prebuild regenerates it), so this
  file is never accidentally committed.

---

## 3. Configure local environment variables

`.env.local` provides the runtime values the JS bundle needs at build time
(Supabase URL/anon key, Sentry DSN, RC SDK keys). EAS Cloud builds read these
from EAS environment vars; **local Gradle builds read from `.env.local`** at
the repo root.

Copy the template and fill it in:

```cmd
cd C:\Users\Mouni\lexi-lens
copy .env.local.template .env.local
notepad .env.local
```

The file has two sections:

**Section 1 — EAS-parity (suffixed)** — documentation only, code does NOT
read these. Kept for parity with EAS env structure.

**Section 2 — Code-consumed (unsuffixed)** — what `process.env.EXPO_PUBLIC_*`
reads at runtime. Point these at STAGING for local sandbox builds.

Get the values:

```cmd
REM Lists everything in your EAS dev/preview environment:
eas env:list --environment development

REM For prod values:
eas env:list --environment production
```

Or fetch directly from Supabase Dashboard / Sentry Settings / RC Dashboard.

**Sample filled-in `.env.local` (Section 2 only):**

```
EXPO_PUBLIC_APP_VARIANT=staging
EXPO_PUBLIC_SUPABASE_URL=https://zhnaxafmacygbhpvtwvf.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIs...
EXPO_PUBLIC_SENTRY_DSN=https://1a0b369...@o4505...ingest.sentry.io/4505...
EXPO_PUBLIC_REVENUECAT_IOS_KEY=
EXPO_PUBLIC_REVENUECAT_ANDROID_KEY=
```

RC keys can stay empty until RC Dashboard is configured; `lib/revenueCat.ts`
gracefully no-ops when keys are missing.

Verify Expo reads the file:

```cmd
npx expo config | findstr supabase
```

Should print your Supabase URL. If empty, `.env.local` isn't at the repo root
or the var names have typos.

---

## 4. Verify the config plugin is registered

The plugin `plugins/withReleaseSigningConfig.js` should be referenced in
`app.config.js`:

```cmd
findstr "withReleaseSigningConfig" app.config.js
```

Should match a line. If not, add it to the `plugins:` array.

---

## 5. First-time prebuild

The plugin runs during `expo prebuild`. First time after pulling the
automation patch, regenerate `android/`:

```cmd
npx expo prebuild --platform android --clean
```

Verify the plugin injected the signing config:

```cmd
findstr "LEXILENS_UPLOAD" android\app\build.gradle
```

Should output three or four lines referencing the keystore properties. If
nothing returns, the plugin didn't run — check `app.config.js` registration.

---

## 6. iOS safety — verify the plugin doesn't affect iOS builds

The plugin is Android-only by design. To prove it empirically:

```cmd
REM Prebuild iOS WITH the plugin registered
cd C:\Users\Mouni\lexi-lens
npx expo prebuild --platform ios --clean

REM Save the generated ios/ contents to a hash
powershell -Command "Get-ChildItem -Path ios -Recurse -File | Get-FileHash -Algorithm SHA256 | Sort-Object Path | ConvertTo-Json" > ios-with-plugin.json

REM Now temporarily comment out the plugin in app.config.js and re-prebuild
REM (Edit app.config.js, prefix the plugin line with //)
npx expo prebuild --platform ios --clean

powershell -Command "Get-ChildItem -Path ios -Recurse -File | Get-FileHash -Algorithm SHA256 | Sort-Object Path | ConvertTo-Json" > ios-without-plugin.json

REM Diff the two
fc ios-with-plugin.json ios-without-plugin.json
```

If `fc` reports "no differences encountered" → the plugin has zero effect on
iOS. Restore the plugin line in app.config.js and you're done.

(This verification is recommended once after applying the automation patch,
and any time `@expo/config-plugins` major version updates.)

---

## 7. First build — verify everything works

```cmd
scripts\build-android.cmd
```

Expected:
- `.env.local` validation passes
- Sentry upload disabled
- Build succeeds in ~5-7 minutes
- AAB at `android\app\build\outputs\bundle\release\app-release.aab`
- Verify-step prints `SHA1: 9C:EB:47:42:33:D7:BB:BB:6E:ED:FF:7B:10:84:55:54:CD:58:8B:D4`

If the SHA1 matches → upload to Play Console will succeed.

---

## 8. Day-to-day workflow

Once setup is done, every release build is:

```cmd
REM Bump versionCode and build:
scripts\build-android.cmd bump

REM Or build without bumping (re-upload same versionCode — Play will reject):
scripts\build-android.cmd

REM Or clean build (only when build.gradle changed or strange errors):
scripts\build-android.cmd clean

REM Explicit prod build (rare from local; usually EAS Cloud does prod):
scripts\build-android.cmd bump production
```

Then upload the resulting AAB to Play Console → Internal Testing → Create
new release.

---

## 9. Setting up production Sentry source-map upload (optional)

For LOCAL sandbox builds, source-map upload is skipped automatically. No
setup needed.

For PRODUCTION builds where you want symbolicated crash reports, create
`android\sentry.properties`:

```properties
auth.token=<your-sentry-org-auth-token>
defaults.org=njlabs
defaults.project=lexi-lens
defaults.url=https://sentry.io/
```

Generate the auth token at:
https://njlabs.sentry.io/settings/account/api/auth-tokens/

Required scopes: `project:releases`, `org:read`. Save the token to
`lexi-lens-secrets\sentry-auth-token.txt` for future reference.

For prod: use `defaults.project=lexi-lens-prod` instead.

The build script forces source-map upload off via `SENTRY_DISABLE_AUTO_UPLOAD=true`.
To do a build with source-map upload enabled, run the gradle command manually:

```cmd
cd android
gradlew :app:bundleRelease
```

without setting the env var.

---

## Troubleshooting

### Build fails: "App Bundle signed with wrong key" on Play upload

The plugin didn't run, or gradle.properties is wrong. Verify:

```cmd
findstr "LEXILENS_UPLOAD" android\app\build.gradle
findstr "LEXILENS_UPLOAD" android\gradle.properties
```

Both should output 4 LEXILENS_UPLOAD_* lines. If `build.gradle` has them
but `gradle.properties` doesn't, you forgot step 2. If `build.gradle`
doesn't have them, the plugin didn't run — re-run prebuild.

### "Version code N has already been used"

versionCode wasn't bumped. Use `scripts\build-android.cmd bump`.

### App black-screens on launch after install

This is the most common failure: `.env.local` is missing required vars.
The build succeeds and signs correctly, but JS init crashes at runtime when
`process.env.EXPO_PUBLIC_SUPABASE_URL` is undefined.

Diagnose:

```cmd
cd C:\Users\Mouni\lexi-lens
npx expo config | findstr supabase
```

Should print your Supabase URL. If empty:

1. Verify `.env.local` exists at repo root
2. Verify the unsuffixed names (section 2) are filled in, not just the
   suffixed ones (section 1)
3. Re-run the build

The build script tries to catch this with its `.env.local` validation step,
but bypasses are possible if you build via `gradlew` directly.

### Gradle file-lock errors during clean

A stuck Gradle daemon. Stop it:

```cmd
cd android
gradlew --stop
taskkill /F /IM java.exe /T 2>nul
```

Then retry the build.

### "expo prebuild" wipes my android/ changes

This is expected. The plugin re-injects the signing config on every prebuild.
If something else manual you edited got wiped, that's a sign it needs to be
a plugin too. The plugin is designed to survive `expo prebuild --clean`.

### Sentry build errors

The build script sets `SENTRY_DISABLE_AUTO_UPLOAD=true` before running
Gradle. If you're still hitting Sentry-related build errors, your shell may
be overriding the env var. Try:

```cmd
set SENTRY_DISABLE_AUTO_UPLOAD=true
scripts\build-android.cmd
```

### KEYTOOL not found

Java's bin folder isn't on PATH. Use the full path:

```cmd
"C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe" ...
```

Or add to system PATH permanently (Windows → Edit System Environment
Variables → Path → Add `C:\Program Files\Android\Android Studio\jbr\bin`).

---

## What gets committed vs. local-only

**Committed (in git):**

- `plugins/withReleaseSigningConfig.js` — the plugin code itself
- `scripts/build-android.cmd` — the build wrapper
- `app.config.js` (plugin registration line)
- `.env.local.template` — template with empty values; users copy to `.env.local`
- `docs/BUILD_ANDROID_LOCAL.md` — this file

**Local only (gitignored — set up per-machine):**

- `C:\Users\Mouni\lexi-lens-secrets\lexilens-upload.jks` (the keystore)
- `C:\Users\Mouni\lexi-lens-secrets\keystore-credentials.txt`
- `android\gradle.properties` (LEXILENS_UPLOAD_* properties; `android/` is
  gitignored entirely by Expo convention)
- `android\sentry.properties` (if you do source-map upload locally)
- `.env.local` (your actual filled-in values)

The whole `android/` folder is gitignored by Expo convention (it's regenerated
by `expo prebuild`).

---

## How EAS builds differ from local builds

Useful to know when debugging "why does local work differently from EAS Cloud":

| Concern | Local Gradle | EAS Cloud |
|---|---|---|
| Env vars | `.env.local` at repo root | `eas env:list` configured in EAS dashboard, mapped through `eas.json` |
| Keystore | `android/gradle.properties` (LEXILENS_UPLOAD_*) | EAS-managed in cloud, never exported |
| Sentry source maps | Skipped (build script sets DISABLE flag) | Uploaded via `SENTRY_AUTH_TOKEN` secret |
| versionCode | Manual or `bump` arg | EAS auto-increments per profile |
| Signing config | Injected by `withReleaseSigningConfig` plugin during prebuild | Same plugin + EAS pulls credentials from cloud |
| Sentry DSN, Supabase URL/key | Read from `.env.local` section 2 | Mapped through `eas.json` from `_STAGING`/`_PROD` suffixed EAS vars |

Both produce the same AAB given the same source code and credentials. The
plugin ensures the signing config part is identical between local and cloud.
