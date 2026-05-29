# `LUMI_RIVE_INTEGRATION_RUNBOOK.md` — Lumi v6.8 deploy playbook

**Scope of this doc:** `lumi.riv` lives in `assets/lumi/` → shipped to iOS TestFlight + Play Internal Testing with `LUMI_RIVE_ENABLED = true`.
**Previous doc:** `assets/lumi/LUMI_RIVE_SPEC.md` (rigging).
**This is a native module rebuild.** Cannot be shipped via Expo OTA. Requires `expo prebuild --clean` + local builds on both platforms.

---

## 0 · Why this isn't OTA

`rive-react-native@9.8.3` is a native module — it links Rive's C++ runtime via autolinking into the iOS Pods + Android Gradle build. Adding it requires `expo prebuild --clean` to regenerate the `ios/` and `android/` projects, then a local build per platform. `LUMI_RIVE_ENABLED` is a JS-level constant baked at bundle time, so flipping it after the native build still requires a fresh bundle (effectively an OTA, but the native module must be present in the binary already).

**Single native rebuild rule** (per the standing decision in `LexiLens_Roadmap_v7_5.html`): you pay this cost once. Bundle any other native changes you've been holding back into the SAME rebuild session. Right now the queued item is the `plugins/withXcode26Compat.js` Expo config plugin — see §5.

---

## 1 · Pre-flight (do not skip)

| # | Check                                                                                                                       | Command / location                                  |
|---|-----------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------|
| 1 | `lumi.riv` exists at `assets/lumi/lumi.riv`                                                                                 | `ls assets/lumi/`                                   |
| 2 | All 5 inputs in Rive match `RIVE_INPUT` constants                                                                           | Visual check in Rive editor + grep `lumiRiveConfig.ts` |
| 3 | Artboard name = `Lumi`, state machine name = `LumiSM`                                                                       | Rive editor right panel                             |
| 4 | `npx tsc --noEmit` passes with current code                                                                                 | Type check before anything else                     |
| 5 | `npx expo export --platform android` bundles cleanly with flag still `false`                                                | Confirms `require.context` works with the new asset |
| 6 | Git working tree clean — no uncommitted Lumi work                                                                           | `git status`                                        |
| 7 | iOS XR test device on iOS Dev Mode, UDID `00008020-000904E80CF9002E` reachable                                              | `xcrun devicectl list devices`                       |
| 8 | Android keystore credentials in `C:\Users\Mouni\lexi-lens-secrets\keystore-credentials.txt` (or `~/lexi-lens-secrets` on Mac) | Memory check                                        |
| 9 | Play Console current `versionCode` — next must be ≥ max + 1                                                                 | Play Console → Internal Testing → most recent build |
| 10 | App Store Connect current build number — next must be ≥ current + 1                                                        | ASC → TestFlight                                    |

If any of these fail, fix before proceeding. Especially #5 — a broken bundle pre-flag-flip means a broken bundle post-flag-flip too.

---

## 2 · Flip the flag

| # | Action | Type | Command |
|---|--------|------|---------|
| 1 | Edit `components/Lumi/lumiRiveConfig.ts` line 47 | `[patch]` | Change `export const LUMI_RIVE_ENABLED = false;` to `= true;` |
| 2 | (Optional but recommended) Pass `state` through `LumiMascot` → `LumiBody` | `[patch]` | `LumiMascot.tsx` line 453: add `state={state}` to the `<LumiBody>` JSX |
| 3 | Type check | `[verify]` | `npx tsc --noEmit` |
| 4 | Bundle check | `[verify]` | `npx expo export --platform android` |
| 5 | Commit | `[git]` | `git add components/Lumi assets/lumi/lumi.riv && git commit -m "feat(lumi): enable Rive backend (v6.8)"` |
| 6 | Push | `[git]` | `git push origin main` |

**Do not push to a separate branch.** This is a small, surgically-defined change. The risk profile is "either it works on device or `LumiBody.tsx` flips back to SVG fallback at runtime." `main` is correct.

---

## 3 · Native rebuild — iOS

**Run from the Mac dev rig** at `~/projects/lexi-lens`. Bash syntax.

| # | Action | Type | Command |
|---|--------|------|---------|
| 1 | Re-pull latest | `[git]` | `git pull origin main` |
| 2 | Bump iOS build number in `app.config.ts` (next > current ASC build) | `[patch]` | manual edit |
| 3 | Prebuild — wipes `ios/` and `android/` (these are gitignored CNG) | `[verify]` | `APP_VARIANT=staging npx expo prebuild --platform ios --clean` |
| 4 | Re-apply the 4 Xcode 26 sharp-edges (per memory: fmt+RCT-Folly c++17, SWIFT_ENABLE_EXPLICIT_MODULES=NO on all Pods, ENABLE_USER_SCRIPT_SANDBOXING sed to NO, Sentry token or `SENTRY_DISABLE_AUTO_UPLOAD=true` in `.xcode.env.local`) | `[manual test]` | follow `docs/iOS_LOCAL_TESTFLIGHT_RUNBOOK.md` |
| 5 | Pod install | `[verify]` | `cd ios && pod install && cd ..` |
| 6 | Verify `rive-react-native` autolinked | `[verify]` | `grep -i "rive" ios/Podfile.lock` should show entries |
| 7 | Open Xcode workspace | `[manual test]` | `open ios/LexiLens.xcworkspace` |
| 8 | Build → Archive (Product menu) | `[manual test]` | Xcode UI |
| 9 | Distribute to TestFlight | `[manual test]` | Xcode Organizer |
| 10 | Wait for ASC processing (5–30 min) | `[manual test]` | ASC TestFlight tab |
| 11 | Install on iOS XR via TestFlight app | `[manual test]` | TestFlight |
| 12 | Open the app, navigate to Onboarding → ScanScreen → QuestMap; verify Lumi animates per spec | `[manual test]` | Visual QA on device |

**Nuclear recovery if pods break:** `pod deintegrate && pod install` in `ios/`.

**If Lumi shows the SVG body on device, the fallback path tripped.** Check the order:
1. Did the asset bundle in? `ls ios/Pods/ ../assets/lumi/`
2. Is `rive-react-native` linked? `grep RNRive ios/Pods/Pods.xcodeproj/project.pbxproj`
3. Does the LumiPlayground in __DEV__ build show Rive? (Production build's screens hide diagnostic info.)

---

## 4 · Native rebuild — Android

**Run from the Windows rig** at `C:\Users\Mouni\projects\lexi-lens`. CMD syntax (`set VAR=val`, backslashes).

This is the **recurring-trap sequence** from memory — `applicationId` is frozen at `expo prebuild` time from `APP_VARIANT`. Wrong variant = Play rejects. Follow this exact sequence without skipping.

| # | Action | Type | Command |
|---|--------|------|---------|
| 1 | Re-pull latest | `[git]` | `git pull origin main` |
| 2 | Confirm Play Console current versionCode | `[verify]` | Play Console → Internal Testing |
| 3 | Set variant env vars | `[manual test]` | `set APP_VARIANT=staging` then `set EXPO_PUBLIC_APP_VARIANT=staging` |
| 4 | Prebuild for Android | `[verify]` | `npx expo prebuild --platform android --clean` |
| 5 | **VERIFY** `applicationId` in `android/app/build.gradle` reads `com.navinj.lexilens` (NOT `.dev`) | `[verify]` | `findstr applicationId android\app\build.gradle` |
| 6 | If `.dev` showed up in step 5 → STOP. Re-do step 3 with correct env var spelling and rerun step 4. | `[verify]` | Stop and fix |
| 7 | Restore the 4 `LEXILENS_UPLOAD_*` gradle properties (from secrets) | `[manual test]` | `findstr LEXILENS_UPLOAD android\gradle.properties` should show 4 lines |
| 8 | Bump `versionCode` in `android/app/build.gradle` to Play max + 1 | `[patch]` | manual edit |
| 9 | Run the local build script | `[manual test]` | `scripts\build-android.cmd staging` |
| 10 | Upload AAB to Play Internal Testing | `[manual test]` | Play Console manual upload |
| 11 | Install on Android test device via Play Internal track | `[manual test]` | Play Store on device |
| 12 | Open the app, navigate Onboarding → ScanScreen → QuestMap; verify Lumi animates per spec | `[manual test]` | Visual QA on device |

---

## 5 · The companion piece — `plugins/withXcode26Compat.js`

**Per the standing memory:** the 4 Xcode 26 manual fixes (fmt+RCT-Folly c++17, SWIFT_ENABLE_EXPLICIT_MODULES=NO, ENABLE_USER_SCRIPT_SANDBOXING sed, Sentry env) are required after every `expo prebuild --clean`. Today, that's manual every time. An Expo config plugin can automate it.

**The Lumi rebuild is the next time those fixes are required.** Authoring the plugin in the SAME session is high-leverage — you pay the prebuild cost once and walk away with a permanent fix.

| # | Action | Type | Notes |
|---|--------|------|-------|
| 1 | Author `plugins/withXcode26Compat.js` | `[file]` | One config plugin that patches all 4 things via `withDangerousMod` and `withAppDelegate` |
| 2 | Add to `app.config.ts` plugins array | `[patch]` | One line |
| 3 | Re-run `expo prebuild --clean` to test plugin idempotency | `[verify]` | Should reproduce the manual fixes automatically |
| 4 | Commit alongside the Lumi flag flip | `[git]` | Same PR/commit if possible |

**This is optional** — Lumi can ship without the plugin. But it converts a recurring annoyance into a permanent fix at zero marginal time cost during this session. **Strong recommend.**

If you don't want it this session, that's fine; flag it for the next native rebuild and follow `docs/iOS_LOCAL_TESTFLIGHT_RUNBOOK.md` manually one more time.

---

## 6 · Roll-back

Roll-back is **OTA-fast** because the flag is a JS constant:

| # | Action | Time |
|---|--------|------|
| 1 | Revert `lumiRiveConfig.ts` line 47 → `LUMI_RIVE_ENABLED = false` | 1 commit |
| 2 | `eas update --channel staging` (or production once ready) | 2 min |
| 3 | App on next launch checks for OTA, downloads, behaviour reverts to v6.7 SVG | Next cold start on user devices |

The native module stays in the binary (no harm — it's just dormant when the flag is off). When you want to try again, flip the flag back to `true` and ship another OTA. No rebuild needed for re-enable, since `rive-react-native` is already linked.

This is why the dispatcher architecture is worth it: rollback cost ≈ rollback cost of a feature flag, not rollback cost of a native binary.

---

## 7 · Post-deploy verification on each platform

### 7.1 iOS XR

- [ ] Lumi visible on Onboarding (size 64)
- [ ] Lumi visible on ScanScreen (size 96, orbit-the-reticle still works — the orbit motion is in `LumiMascot.tsx` wrapper, NOT in the Rive file; it should be unaffected)
- [ ] Lumi visible on QuestMap (size 64)
- [ ] Lumi visible on ParentDashboard (size 64)
- [ ] Mood transitions feel smooth (180ms ease-in-out target)
- [ ] Hard mode → crown appears
- [ ] Sleeping theme → "Zzz" appears
- [ ] iOS Settings → Accessibility → Reduce Motion → ON → Lumi freezes hover loop
- [ ] App backgrounds and foregrounds → Lumi resumes cleanly (no black frame, no crash)
- [ ] No new Sentry crashes in first 24 hr on TestFlight Internal cohort

### 7.2 Android

- [ ] All of 7.1 + works on entry-level Android (test on whatever you have closest to 3 GB RAM)
- [ ] Camera frame processor on ScanScreen running concurrently with Lumi animation — no fps drops visible to the eye
- [ ] System back-press while Lumi is animating → no crash
- [ ] No new Sentry crashes in first 24 hr on Play Internal cohort

### 7.3 Sentry breadcrumbs to watch

The runtime intentionally does NOT log to Sentry on Rive load failure (SVG fallback is the safety net). But if you see ANY Lumi-related Sentry crash, that's signal for genuine issues — investigate immediately, don't assume the fallback caught it.

---

## 8 · 24-hour bake watch

After both platforms are live on Internal Testing:

| Metric              | What to watch                                                       | Action if it trips                                            |
|---------------------|---------------------------------------------------------------------|---------------------------------------------------------------|
| Crash-free sessions | Should match v6.7 baseline ± 0.5 %                                  | If down >0.5 %, OTA-rollback to flag off                      |
| Scan-screen fps     | No new "slow frame" warnings vs v6.7                                | If new warnings, investigate ScanScreen's Lumi mount specifically |
| ANRs (Android only) | Watch for new ANRs near Lumi mount                                  | If any, OTA-rollback                                          |
| Sentry breadcrumbs  | `LumiBodyRive` should appear at mount; no errors                    | If errors, see §4                                             |

If everything is clean at 24 hr, promote to **closed beta** (next track up). If anything tripped, OTA-rollback and dig in.

---

## 9 · What this runbook does NOT cover

- Production Play / App Store release. That's a separate decision gated on closed beta data — see roadmap Phase 4.x.
- Adding more poses or richer animations to the Rive file (v6.9+).
- Wiring `stateIndex` through (deferred — `LumiMascot` doesn't pass `state` yet; that's a 1-line follow-up patch once mood + theme are stable in prod).

---

## 10 · Quick troubleshooting

| Symptom on device                                           | Likely cause                                                 | Fix                                                                                          |
|-------------------------------------------------------------|--------------------------------------------------------------|----------------------------------------------------------------------------------------------|
| Lumi shows but doesn't animate (frozen on idle)             | Rive input name mismatch                                     | Open Rive editor, verify all 5 inputs spelled exactly per `RIVE_INPUT` in `lumiRiveConfig.ts` |
| Lumi shows SVG body (old v6.7 art) despite `LUMI_RIVE_ENABLED = true` | Native module didn't autolink, OR `.riv` failed to decode at runtime | Check `Podfile.lock` for RNRive entry on iOS; check `node_modules/rive-react-native/android/` exists; re-prebuild |
| App crashes on cold start                                   | Native module init failure                                   | Revert flag via OTA, then debug in dev build with full stack trace                          |
| Lumi animation stutters during scan                         | GPU contention with camera frame processor                   | Investigate; this would be a real platform-level issue, not a config issue                  |
| TypeScript error after pulling latest                       | Stale repo or out-of-sync types                              | `rm -rf node_modules && npm install`, then `npx tsc --noEmit`                                |

---

## 11 · Done state

Shipping Lumi v6.8 is complete when:

- [ ] iOS TestFlight Internal Testing build with `LUMI_RIVE_ENABLED = true` baking 24+ hr with no new crashes
- [ ] Android Play Internal Testing build with same — also baking 24+ hr clean
- [ ] Crash-free sessions matching v6.7 baseline
- [ ] Roadmap updated: phase 6.8 → DONE
- [ ] (Optional) `plugins/withXcode26Compat.js` shipped in same commit, removing the manual 4-fixes step from future runbooks

When all of the above are true, the work is shipped. Then either:
- Promote to closed beta + production (per Phase 4.x gating)
- OR start v6.9 polish (state pass-through, articulated rig Path B, additional poses)
