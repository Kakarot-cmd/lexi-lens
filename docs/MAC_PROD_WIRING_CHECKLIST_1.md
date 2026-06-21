# Mac M5 — PROD Build Wiring Readiness Checklist

**Purpose:** Confirm the Mac dev rig has every **production environment variable**
correctly wired *before* the first public PROD build — so the prod package
hits prod Supabase / prod RevenueCat / prod Sentry, not staging, and nothing
is silently empty. This is about **variable wiring**, not Xcode capabilities.

**Created:** 2026-05-30 · **Rig:** MacBook Air M5 (`~/projects/lexi-lens`)
**Status of PROD build path:** UNTESTED end-to-end as of 2026-05-30. Staging
TestFlight + Play Internal both proven; production never built from this Mac.
Treat every box below as UNCHECKED until you run the command and see the
expected output.

> **Run this whole checklist immediately before any `APP_VARIANT=production`
> build.** It is also worth a dry-run now (costs nothing, surfaces gaps early).
> Most boxes will currently FAIL on a staging-configured rig — that is expected;
> the point is to know exactly what to flip.

---

## How the wiring actually works (so the checks make sense)

Three independent layers must all point at prod for a correct prod build:

1. **`eas.json` `production` profile** (committed, already correct) — maps the
   unsuffixed runtime vars to the `_PROD`-suffixed source vars:
   `EXPO_PUBLIC_SUPABASE_URL ← $EXPO_PUBLIC_SUPABASE_URL_PROD`, etc. This is the
   path EAS *cloud* builds use. **Local builds do NOT read eas.json env** — they
   read `.env.local`. (This is the trap: eas.json being correct does not mean a
   local prod build is correct.)

2. **`.env.local` Section 2** (gitignored, per-machine) — the unsuffixed vars
   Metro actually bundles for a **local** build. For a local prod build these
   must hold **prod** values. For staging builds they hold staging values. Only
   one set can be active at a time → this is the file you toggle.

3. **`APP_VARIANT` / `EXPO_PUBLIC_APP_VARIANT`** — must be `production` at
   prebuild + build time. `lib/env.ts` `resolveVariant()` reads these.

**Safety property worth knowing:** if `APP_VARIANT` is unset in a non-dev
build, `lib/env.ts` falls back to **staging, not production**. So a
misconfigured prod build fails *safe* (hits staging). The danger is the
reverse — a prod build with staging *values* still in `.env.local` Section 2 —
which is exactly what this checklist catches.

**The two Supabase projects:**
- Staging: `zhnaxafmacygbhpvtwvf`
- Prod:    `vwlfzvabvlcozqpepsoi`

---

## Decision gate before you even start

- [ ] **PROD Supabase migration (Phase 4.0) is applied to `vwlfzvabvlcozqpepsoi`.**
  Per roadmap this is the pending operational step and RevenueCat-prod is gated
  on it. If the prod project is not migrated, STOP — a prod build now would hit
  an unprovisioned backend. This checklist assumes the prod project is live.

---

## A. Secrets present on the Mac (the `_PROD` source values)

These must exist *somewhere* you can copy from — EAS env, or a prod section in
`keystore-credentials.txt` / a prod `.env` note. EAS is the source of truth.

- [ ] **Prod Supabase URL + anon key exist in EAS production env.**
  ```sh
  eas env:list --environment production --include-sensitive | grep -iE 'SUPABASE'
  ```
  Expect non-empty `EXPO_PUBLIC_SUPABASE_URL_PROD` (the `vwlfzvabvlcozqpepsoi`
  URL) and `EXPO_PUBLIC_SUPABASE_ANON_KEY_PROD`.

- [ ] **Prod Sentry DSN exists.**
  ```sh
  eas env:list --environment production --include-sensitive | grep -iE 'SENTRY_DSN'
  ```
  Expect non-empty `EXPO_PUBLIC_SENTRY_DSN_PROD` (a `lexi-lens-prod` project DSN,
  distinct from the staging DSN).

- [ ] **Prod RevenueCat keys exist (real `goog_` / `appl_`, not Test Store).**
  ```sh
  eas env:list --environment production --include-sensitive | grep -iE 'REVENUECAT'
  ```
  Expect `EXPO_PUBLIC_REVENUECAT_IOS_KEY_PROD` starting `appl_` and
  `EXPO_PUBLIC_REVENUECAT_ANDROID_KEY_PROD` starting `goog_`.

---

## B. Android-specific PROD wiring

- [ ] **Play service-account JSON present at the path eas.json expects.**
  ```sh
  ls -la ~/projects/lexi-lens-secrets/play-service-account.json
  ```
  (`eas.json` submit.production references `../lexi-lens-secrets/play-service-account.json`.)

- [ ] **Upload keystore + the DISTINCT key password recorded.**
  ```sh
  ls -la ~/projects/lexi-lens-secrets/lexilens-upload.jks
  grep -iE 'KEY_PASSWORD|STORE_PASSWORD' ~/projects/lexi-lens-secrets/keystore-credentials.txt
  ```
  Same keystore as staging (prod + staging share `com.navinj.lexilore`).
  **Confirm the key password is recorded distinctly from the store password** —
  the 2026-05-30 "Cannot recover key" failure was caused by assuming they were
  equal. SHA1 must be `9C:EB:47:42:33:D7:BB:BB:6E:ED:FF:7B:10:84:55:54:CD:58:8B:D4`.

- [ ] **Android prod build is just `build-android.sh production`** — BUT only
  after `.env.local` Section 2 holds prod values (Section C). The script reads
  `.env.local`, not eas.json. `applicationId` is unchanged (`com.navinj.lexilore`
  for both staging and production), so **no re-prebuild needed to switch
  staging→prod** on Android — only the `.env.local` values change.

---

## C. iOS-specific PROD wiring

- [ ] **`.p8` ASC API key present** (for `eas submit` / Transporter, if used).
  ```sh
  ls -la ~/projects/lexi-lens-secrets/*.p8
  ```
  (Several `SubscriptionKey_*.p8` exist; confirm the ASC API key one is among them.)

- [ ] **Bundle ID is identical staging↔prod (`com.navinj.lexilens`)** — so the
  ASC record `6766159881` (LexiLens RPG) receives both. No second ASC record
  needed. BUT the prebuild *project name* differs: prod →
  `LexiLens.xcworkspace` (no "Staging" suffix). The `withXcode26Compat` plugin
  is variant-agnostic and will still apply, but the runbook's hard-coded
  `LexiLensStaging` paths in the manual-fallback `grep`/`sed` would need the
  prod name.

- [ ] **`aps-environment` flips to `production`** automatically — `app.config.js`
  sets it from `VARIANT === 'production'`. No manual step; just confirm after a
  prod prebuild:
  ```sh
  grep -A1 'aps-environment' ios/LexiLens/LexiLens.entitlements 2>/dev/null
  ```

- [ ] **Signing cert:** a prod App Store archive uses a **Distribution** cert,
  which Xcode automatic signing generates at archive time. (The staging
  TestFlight build used "Apple Development" — expect this to differ for prod;
  not a blocker, just don't be surprised.)

---

## D. The `.env.local` toggle (the actual switch — do this LAST, right before build)

This is the single highest-risk step: a prod build with staging values in
Section 2 silently writes to the wrong backend. There is NO build-time error for
this — `lib/env.ts` only warns on *empty*, never on *wrong*.

- [ ] **Section 2 unsuffixed vars point at PROD before a prod build:**
  ```sh
  grep -E '^EXPO_PUBLIC_(APP_VARIANT|SUPABASE_URL|SUPABASE_ANON_KEY|SENTRY_DSN|REVENUECAT)' .env.local
  ```
  For a **prod** build, expect:
  - `EXPO_PUBLIC_APP_VARIANT=production`
  - `EXPO_PUBLIC_SUPABASE_URL=https://vwlfzvabvlcozqpepsoi.supabase.co` ← **prod ref**
  - anon key = the prod anon key
  - Sentry DSN = the prod DSN
  - RC keys = the `appl_` / `goog_` prod keys

  > **Reminder:** this file is wiped by `prebuild --clean`. After any clean, the
  > active values revert and must be re-set. Keep a `.env.prod.local` copy
  > alongside `.env.local` so the toggle is a `cp`, not a retype. (Workflow
  > improvement candidate — not yet built.)

- [ ] **Confirm Expo resolves the prod URL** (the definitive bundle-time check):
  ```sh
  npx expo config | grep -i supabase
  ```
  Must print the **`vwlfzvabvlcozqpepsoi`** URL, not `zhnaxafmacygbhpvtwvf`.
  If it shows staging, the bundle would hit staging — STOP and fix Section 2.

---

## E. Post-build verification (catch a wrong-backend build before it ships)

- [ ] **Android:** after `build-android.sh production`, the SHA1 verdict must
  still print MATCH (same keystore). Then confirm the bundled URL by checking
  the build's env resolution — or smoke-test the installed build against a known
  prod-only account.

- [ ] **iOS:** install the prod archive on a device and confirm it talks to the
  prod backend (a staging-only test account should NOT log in; a prod account
  should). This is the only reliable runtime confirmation of which Supabase the
  bundle embedded.

- [ ] **Both:** confirm Sentry events land in the **prod** Sentry project, not
  staging — proves the prod DSN was bundled.

---

## Tonight's quick dry-run (while staging build indexes)

Run A.1–A.3 + B.1–B.2 now to learn whether the prod *source* secrets even exist
on this Mac yet. Expect:
- If EAS prod env has the values → prod source is ready; only the `.env.local`
  toggle (Section D) + the Phase 4.0 migration gate remain.
- If EAS prod env is empty/missing keys → that's the real gap to close before
  prod, logged here so it's not a launch-day surprise.

Do NOT run Section D's toggle tonight — it would repoint your `.env.local` at
prod and the staging TestFlight build you're about to archive reads that file.
Keep `.env.local` on staging until the staging build is uploaded.
