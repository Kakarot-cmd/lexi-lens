# Lexi-Lens — Store Launch To-Do

**Owner:** NJ · **Created:** 2026-05-30 · **Status:** working doc

Single source of truth for moving Lexi-Lens through the remaining launch
phases on **both Apple App Store and Google Play**. Tracks the *as-is*
ship plan — no new features, just the operational path from current state
(iOS v1.0.31 TestFlight Internal, Android v1.0.29 Play Internal) to live
on both stores.

If a step here contradicts `BUILD_PLAYBOOK.md` or `iOS_LOCAL_TESTFLIGHT_RUNBOOK.md`,
**those win for build procedure**. This doc owns the *store* side.

---

## 0. How to use this doc

- Each section is a sequential phase. Don't start a phase until prereqs pass.
- The `Type` column maps to the same vocabulary as the deploy checklists:
  `[verify]`, `[manual]`, `[manual test]`, `[build]`, `[submit]`, `[wait]`, `[decision]`.
- "Time" is wall-clock, assuming you're not blocked. Add buffer.
- When a step is **blocking** for store review, it's marked **🔴**.
- The "Done" column is for your own check-off — mark with date.

---

## 1. Open questions to resolve BEFORE starting

These three answers change the plan. Pin them down day 1.

| # | Question | Why it matters | How to find out |
|---|---|---|---|
| 1 | When was the Play Console account created? | Determines Android Branch A (21–28d, 12/14 closed-test gate) vs Branch B (5–10d, direct to prod). Pivotal. | Play Console → Account details → Account creation date. If after **Nov 13, 2023** and personal → Branch A. |
| 2 | List on **Apple Kids Category**? | Kids Cat = stricter scrutiny + no third-party analytics in non-parent zones + age-band lock-in (5-and-under / 6-8 / 9-11). For a 5–12 vocab RPG, **recommend skipping** and staying in Education with age rating 4+ or 9+. | Decision. Default: skip. |
| 3 | List on **Google Designed for Families**? | Boosts visibility in Family section, slightly stricter rules, separate one-time enrollment. Independent of the closed-testing gate. | Decision. Default: enroll **after** first prod release is live, not before. |

---

## 2. Shared prerequisites (both stores)

Run these in parallel. None depend on either store. Target: complete in 3–4 days.

| # | Task | Type | Time | Done |
|---|---|---|---|---|
| 2.1 | Privacy policy hosted at stable URL. Must address: data collected per Sentry+Supabase, COPPA, GDPR-K, third-party (Anthropic, RevenueCat, Supabase, Sentry, Upstash) | 🔴 [manual] | 2h | |
| 2.2 | Terms of Service URL | [manual] | 1h | |
| 2.3 | Support URL or support email (e.g. `support@lexilens.app`) | 🔴 [manual] | 30m | |
| 2.4 | Data deletion request URL (already wired in-app; need public-facing page too) | 🔴 [manual] | 1h | |
| 2.5 | App icon 1024×1024 PNG (iOS), 512×512 PNG (Android), no alpha, no rounded corners | 🔴 [manual] | 1h | |
| 2.6 | Marketing screenshots from real device: 6.7" iPhone (3–10), 6.5" iPhone (3–10), Android phone (2–8), Android 7" tablet (2–8). Real gameplay, not mockups. | 🔴 [manual] | 4h | |
| 2.7 | App name decision: "Lexi-Lens" vs "Lexi-Lens: Word Quest" or similar. iOS allows 30 chars; Android allows 30. | [decision] | 30m | |
| 2.8 | App subtitle (iOS, 30 chars), short description (Android, 80 chars) | [manual] | 1h | |
| 2.9 | Full description (~4000 chars). Cover: what it is, how it works (camera-scan vocab RPG), age range, parent dashboard, COPPA stance, premium features | [manual] | 2h | |
| 2.10 | Keywords (iOS, 100 chars comma-separated) | [manual] | 30m | |
| 2.11 | Promotional text (iOS, 170 chars, editable without re-review) | [manual] | 15m | |
| 2.12 | Final regression pass on prod build: auth, scan, verdict cache hit, quest completion, parent dashboard, COPPA gate, deletion request | 🔴 [manual test] | 3h | |
| 2.13 | Verify Sentry config is COPPA-safe — no PII attached to events from child sessions. Audit `sentry.init()` call and any `setUser`/`setContext` paths | 🔴 [verify] | 1h | |
| 2.14 | **Phase 4.4l — sandbox IAP test.** Per memory, this is the last open Phase 4.4 item. Skipping = first real purchase failure = refund storm. | 🔴 [manual test] | 1h | |
| 2.15 | `docs/FORGOT_PASSWORD_SETUP.md` — author the Supabase Dashboard runbook for redirect URLs + email template config. Project instructions flag this is missing | [manual] | 2h | |
| 2.16 | Commit missing `supabase/migrations/20260504_quest_completions_unique_mode.sql` (extract from live DB per project instructions) | 🔴 [manual] | 30m | |

---

## 3. Apple track — TestFlight to App Store (~7–14 days)

### Phase A1 — TestFlight External beta (optional, 2–3 days)

You're already on TestFlight Internal at v1.0.31. External is optional but
strongly recommended for a kids app — Apple looks favorably on apps that
ship with real beta history. Family/friends qualify; no Apple Developer
account needed on their side.

| # | Task | Type | Time | Done |
|---|---|---|---|---|
| A1.1 | App Store Connect → TestFlight → External Testing → create group "Family Beta" | [manual] | 5m | |
| A1.2 | Add 10–20 external testers by email | [manual] | 15m | |
| A1.3 | Submit current build for Beta App Review (Apple reviews first build per version, then waives for builds in same version) | [submit] | 5m | |
| A1.4 | Beta App Review wait | [wait] | 24–48h | |
| A1.5 | Send invites once approved, collect feedback for 5–7 days | [manual] | 1w | |

### Phase A2 — App Store Connect metadata setup (~1 day, parallelizable with A1)

| # | Task | Type | Time | Done |
|---|---|---|---|---|
| A2.1 | ASC → App Store → App Information → fill name, subtitle, category (Primary: Education; Secondary: Games > Educational) | 🔴 [manual] | 30m | |
| A2.2 | **Kids Category decision** — recommend **DO NOT** opt in. Once selected, future updates also bound. Education + age rating 4+ delivers same discovery + no scrutiny tax. | 🔴 [decision] | 0 | |
| A2.3 | Complete the **new** age rating questionnaire (mandatory since Jan 31, 2026). New categories include 13+, 16+, 18+. For Lexi-Lens expect **4+**. | 🔴 [manual] | 30m | |
| A2.4 | App Privacy → declare every data type: Supabase auth (email), Supabase Postgres (child names, ages, scan history), Sentry (crash diagnostics — verify NO user ID linkage), RevenueCat (purchase data), camera (on-device, not collected). Map each to a purpose. | 🔴 [manual] | 2h | |
| A2.5 | Pricing and Availability → Free with IAP, set base territory (recommend US for review, expand after) | 🔴 [manual] | 30m | |
| A2.6 | IAP products → create in ASC, attach to build, ensure RevenueCat dashboard matches. Sandbox-tested in 2.14. | 🔴 [manual] | 1h | |
| A2.7 | URLs → privacy policy, support, marketing (optional) | 🔴 [manual] | 15m | |
| A2.8 | App Review Information → demo account for reviewers (pre-seeded child profile, can use the test child Anya: `25be0ab1-bbe2-4135-af96-111aabf3bbb5`), notes explaining the parental gate + COPPA flow | 🔴 [manual] | 30m | |
| A2.9 | Export Compliance → HTTPS-only exemption, declare in `Info.plist` (already wired? verify) | 🔴 [verify] | 15m | |
| A2.10 | Content Rights — confirm no third-party content, no music licensing issues (Lumi 2.0 audio: confirm 23 MP3s are owned/CC0) | 🔴 [verify] | 30m | |
| A2.11 | Upload screenshots from 2.6 | 🔴 [manual] | 30m | |

### Phase A3 — Submission and review (~3–10 days)

| # | Task | Type | Time | Done |
|---|---|---|---|---|
| A3.1 | Build production iOS binary via Xcode archive (per `iOS_LOCAL_TESTFLIGHT_RUNBOOK.md`, but with `APP_VARIANT=production`) | 🔴 [build] | 30m | |
| A3.2 | Upload to ASC via Xcode Organizer or Transporter | 🔴 [submit] | 30m | |
| A3.3 | Wait for processing (10–30 min), attach build to App Store version | 🔴 [wait] | 30m | |
| A3.4 | Set **release option to Manual** — critical. This lets you coordinate launch day. | 🔴 [decision] | 5m | |
| A3.5 | Submit for review | 🔴 [submit] | 5m | |
| A3.6 | Apple review — 2–5 days typical for new app, 7+ days in surge periods. Kids/IAP apps trend longer. | 🔴 [wait] | 2–7d | |
| A3.7 | **If rejected** → read rejection reason carefully, fix, resubmit (each cycle adds 2–5 days) | [iterate] | 2–5d/cycle | |
| A3.8 | Once approved → app sits in "Pending Developer Release" until you click release | [verify] | 0 | |

### Phase A4 — Release

| # | Task | Type | Time | Done |
|---|---|---|---|---|
| A4.1 | Coordinate release day with Google (if doing simultaneous launch) | [manual] | 0 | |
| A4.2 | ASC → click "Release This Version" | [submit] | 1m | |
| A4.3 | App propagates to App Store globally — 1–24h depending on region | [wait] | up to 24h | |

---

## 4. Google track — branches on the 12/14 gate

**Resolve question 1.1 BEFORE starting this section.**

### Phase G0 — Pre-track setup (~1 day, both branches)

| # | Task | Type | Time | Done |
|---|---|---|---|---|
| G0.1 | Play Console → App content → Privacy policy URL | 🔴 [manual] | 15m | |
| G0.2 | App content → App access → declare credentials for Google reviewer (test parent account + child profile) | 🔴 [manual] | 30m | |
| G0.3 | App content → Ads → declare ad presence (Lexi-Lens has none → "No ads") | 🔴 [manual] | 5m | |
| G0.4 | App content → Content guidelines → COPPA + Families | 🔴 [manual] | 15m | |
| G0.5 | App content → Target audience and content → select age groups (5–8, 9–12). Triggers Families Policy compliance — already aligned with COPPA work | 🔴 [manual] | 30m | |
| G0.6 | App content → Data safety form → declare every data type matching A2.4. Be exhaustive. | 🔴 [manual] | 3h | |
| G0.7 | App content → Government apps → No | [manual] | 2m | |
| G0.8 | App content → Financial features → declare IAP if shipping with premium | 🔴 [manual] | 10m | |
| G0.9 | App content → News apps → No | [manual] | 2m | |
| G0.10 | App content → Health → No | [manual] | 2m | |
| G0.11 | Content rating → complete IARC questionnaire → expect "Everyone" or "Everyone 10+" | 🔴 [manual] | 30m | |
| G0.12 | Main store listing → app name, short description, full description (from 2.7–2.9) | 🔴 [manual] | 30m | |
| G0.13 | Main store listing → graphics: feature graphic 1024×500, screenshots (2.6), app icon (2.5) | 🔴 [manual] | 30m | |
| G0.14 | Store presence → Store settings → categorize as Educational, tag as Family | 🔴 [manual] | 15m | |

### Branch A — Subject to 12/14 closed-testing rule (~21–28 days)

**Triggered by:** personal account created on/after Nov 13, 2023.

| # | Task | Type | Time | Done |
|---|---|---|---|---|
| GA.1 | Recruit **15–18 testers** (buffer above the 12 floor). Mix family / friends / parents-with-kids across different households and networks. | 🔴 [manual] | 1–3d | |
| GA.2 | Send each tester a clear "what to do" note: install via opt-in link, keep installed 14 days, open daily, scan a few objects | [manual] | 1h | |
| GA.3 | Play Console → Testing → Closed testing → create new track "Closed family beta" | 🔴 [manual] | 10m | |
| GA.4 | Upload v1.0.29 AAB (or rebuild as v1.0.30 — bump versionCode per `BUILD_PLAYBOOK.md` §3 Flow 1) | 🔴 [build] | 30m | |
| GA.5 | Add testers via email list or Google Group, save | 🔴 [manual] | 15m | |
| GA.6 | Send opt-in link to all 15–18 testers, confirm all 12+ have opted in within 24h | 🔴 [verify] | 1d | |
| GA.7 | **Day-1 check** — Play Console → Testing → Closed testing → verify ≥12 "Opted in" | 🔴 [verify] | 5m | |
| GA.8 | **Freeze the build.** Do NOT push updates during the 14 days unless critical bug. Each update risks tester drop-off. | 🔴 [decision] | 0 | |
| GA.9 | **Daily checks days 2–13** — opt-in count, no drops below 12. If a tester drops, add replacement immediately. | 🔴 [verify] | 5m/day | |
| GA.10 | Day-14 confirmation — Play Console should now show "Apply for production" enabled | 🔴 [verify] | 5m | |
| GA.11 | Production access application — answer questions about testing process, feedback received, app readiness | 🔴 [submit] | 1h | |
| GA.12 | Google review of production access application | 🔴 [wait] | 1–7d | |
| GA.13 | Approval (or rejection → fix and reapply; rejection cycles cost ~7d each) | [verify] | 0 | |
| GA.14 | Proceed to Phase G2 below | | | |

### Branch B — Not subject to closed-testing rule (~5–10 days)

**Triggered by:** account created before Nov 13, 2023, OR organization account.

| # | Task | Type | Time | Done |
|---|---|---|---|---|
| GB.1 | Proceed directly to Phase G2 — production submission | | | |

### Phase G2 — Production submission (both branches converge)

| # | Task | Type | Time | Done |
|---|---|---|---|---|
| G2.1 | Build production AAB. Per `BUILD_PLAYBOOK.md` §6 — run all 6 pre-flight checks first | 🔴 [build] | 30m | |
| G2.2 | Verify versionCode is Play max +1. **Critical** — Play rejects same-or-lower codes. | 🔴 [verify] | 5m | |
| G2.3 | Play Console → Production → create release → upload AAB | 🔴 [submit] | 15m | |
| G2.4 | Release notes (50-char-per-language limit per "What's new") | 🔴 [manual] | 15m | |
| G2.5 | Choose rollout %: recommend **20% staged rollout** initially, escalate to 100% over 3–5 days post-launch | 🔴 [decision] | 5m | |
| G2.6 | Review summary page → no warnings? → submit | 🔴 [submit] | 10m | |
| G2.7 | Google production review | 🔴 [wait] | 1–7d | |
| G2.8 | Approval → app live within hours of approval (or set to "managed publishing" if you want a Manual-Release equivalent) | [verify] | 0 | |

### Phase G3 — Post-launch (Branch A and B both)

| # | Task | Type | Time | Done |
|---|---|---|---|---|
| G3.1 | **Designed for Families** enrollment (decision 1.3) — only after first prod release is live and stable for 1–2 weeks | [manual] | 30m | |
| G3.2 | Apply COPPA-safe ad SDK exclusion attestation if Designed for Families | [manual] | 15m | |

---

## 5. Launch day coordination

Use ASC Manual Release + Play Console staged rollout to land both stores
within a few hours of each other.

| # | Task | Type | Time | Done |
|---|---|---|---|---|
| 5.1 | **T-7d** — both stores have approved binaries waiting. Sanity-check that the *same git SHA* powers both (avoid surprises). | 🔴 [verify] | 30m | |
| 5.2 | **T-2d** — final on-device smoke test on both platforms using production build | 🔴 [manual test] | 1h | |
| 5.3 | **T-1d** — coordinate any social/marketing announcements; warm up Supabase prod project (run a sample query, check Sentry connectivity, RevenueCat webhook still alive) | 🔴 [verify] | 30m | |
| 5.4 | **T-0 morning** — ASC click "Release This Version" + Play Console push 20% rollout. Both propagate over the next 2–24h. | 🔴 [submit] | 15m | |
| 5.5 | Watch Sentry and Supabase live for first 2h. Common day-1 issues: env vars wrong on prod, deeplink not registered, IAP product IDs mismatched. | 🔴 [verify] | 2h | |
| 5.6 | **T+3d** — escalate Play rollout to 50%, then 100% on T+5d | [manual] | 5m | |

---

## 6. First-week post-launch watch list

| # | Watch | Threshold | Action |
|---|---|---|---|
| 6.1 | Sentry crash-free rate | < 99.5% = stop rollout | Hotfix, ship as same-version update (no re-review of testing) |
| 6.2 | Supabase Edge Function p95 latency | `evaluate` > 8s sustained = investigate Gemini fallback | Check `evaluate_model_provider` flag, consider toggle |
| 6.3 | RevenueCat purchase success rate | < 95% = real bug | Re-test sandbox flow; check Phase 4.4l gaps |
| 6.4 | Negative store reviews citing specific bugs | Any 1-star within first 48h | Reply quickly, ship hotfix |
| 6.5 | COPPA-related complaints | Any | Stop everything, audit data flow |

---

## 7. What I'm deliberately NOT including in v1 launch

These are real issues but don't block submission and don't depend on prod
data, so they're judgment calls. Listing them here so they don't get
forgotten:

| Item | Why deferred from v1 launch | When to address |
|---|---|---|
| Env split (Phase 4.0) — staging vs prod Supabase | Code is wired but Supabase migration not done. Launch is technically possible against staging project; better to migrate before public users land but launch survives without it. | Within 30 days of launch |
| `get_evaluate_context` RPC `parent_tier`/`primary_today` undefined bug | Causes `is_primary_call` to always be true. Cosmetic — doesn't break gameplay or block submission. | Hotfix v1.0.x post-launch |
| `plugins/withXcode26Compat.js` Expo config plugin | Quality-of-life for future iOS rebuilds. Manual fixes still work. | Post-launch v6.6+ |
| Lumi engagement Tier 1 / Tier 3 (Rive body swap, 3D non-scan) | Feature work, not launch-blocking. | Post-launch v6.6+ |
| Mistral CHILD_SAFETY_PREFIX compliance retest | Gemini is verified-correct and is the live primary. Mistral is migration-default but flag-overridden. | When prod data shows whether Mistral is ever actually called |

---

## 8. Quick reference

### Time budgets (no surprises)

| Track | Best case | Realistic | Worst case (one rejection cycle) |
|---|---|---|---|
| Shared prereqs (§2) | 3d | 4d | 6d |
| Apple (§3) | 5d | 9d | 14d |
| Google Branch A (§4 + GA) | 21d | 25d | 32d |
| Google Branch B (§4 + GB) | 5d | 8d | 13d |
| **Total to both live (Branch A in parallel)** | 21d | 25d | 32d |
| **Total to both live (Branch B in parallel)** | 5d | 9d | 14d |

### Critical references

- `BUILD_PLAYBOOK.md` — Android build, never deviate from §3 Flow 1/Flow 2
- `iOS_LOCAL_TESTFLIGHT_RUNBOOK.md` — iOS archive via Xcode, the 4 Xcode-26 fixes after every `expo prebuild --clean`
- `LexiLens_Roadmap_v7_5.html` — phase status snapshot
- `lexi-lens-monitor_v7_5.html` — operational thresholds + SQL queries

### Test child for store reviewers

- Username/account: pre-seed a parent account before submission
- Child profile: Anya (`25be0ab1-bbe2-4135-af96-111aabf3bbb5`) is the canonical test child per agent memory

---

## 9. Open items requiring NJ decision before this plan can start

1. **Play Console account creation date** → determines Branch A vs Branch B (item 1.1)
2. **Kids Category opt-in** → recommend skip (item 1.2)
3. **Designed for Families** → recommend post-launch enrollment (item 1.3)
4. **IAP shipping in v1?** → if no, strip premium gating from the v1 binary and save the entire RevenueCat-validation surface area
5. **Simultaneous launch on both stores, or iOS-first?** → iOS-first is the lower-risk option given Android Branch A's longer timeline

Mark these in the cells of section 1 before starting any work in §3 or §4.
