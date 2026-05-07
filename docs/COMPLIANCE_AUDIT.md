# Lexi-Lens — Compliance Audit (v4.7 polish session)

**Date:** May 7, 2026  
**Author:** Compliance polish session  
**Status:** All code-side items closed. Two manual platform-console items pending.

This document is the audit trail for the Phase 4.6 "Compliance polish" session.
Each numbered item below corresponds to an entry in the original session
checklist. Items marked **MANUAL** require action in the App Store Connect
or Google Play Console UI — they cannot be solved in code.

---

## 1. Privacy Policy URL audit

### Finding
The two HTML pages served at the published Privacy Policy / Data Deletion URLs
both branded the app as **"LexiLore"**. The actual app brand on every store
listing and inside the app is **"Lexi-Lens"**. Apple App Store reviewers
cross-check this and a brand-name mismatch is a documented rejection trigger
("the privacy policy submitted is for a different app").

The Android package name `com.navinj.lexilore` is intentionally a typo of
`lexilens` (frozen because v1.0.11 already shipped). That typo is internal —
it is not the user-facing brand. The privacy policy must use the user-facing
brand "Lexi-Lens".

### Fix
- `privacy-policy.html` — full rewrite, branded "Lexi-Lens", dated May 7 2026.
  Adds explicit COPPA & GDPR-K language, an "How AI Is Used" section
  describing what is sent to Anthropic and what is not, an "In-app reporting"
  section pointing to the new verdict-report flow, and a third-party services
  list including Anthropic, Sentry, and Upstash by name with privacy
  responsibilities for each.
- `data-deletion.html` — full rewrite, branded "Lexi-Lens", exact in-app
  navigation path (`Parent Dashboard → Word Tome → Parent PIN → Request
  Account Deletion`), explicit list of what is and is not deleted, plus the
  30-day grace-period cancellation note.

### Manual step required
After deploying the new HTML files to the public host, paste the same URLs
into:
- App Store Connect → App Privacy → Privacy Policy URL
- Google Play Console → App content → Privacy Policy

(URLs themselves do not change. This is a re-paste only because both stores
re-validate the policy against the live app on every submission.)

---

## 2. Apple age rating questionnaire refresh

**STATUS: MANUAL — needs your action in App Store Connect.**

The questionnaire must be reviewed and resubmitted before the next iOS build
is uploaded for review. The answer key below is what Lexi-Lens v1.0.12
should report. Anything currently set differently in App Store Connect is
incorrect and must be fixed.

### Apple age rating answers (Lexi-Lens v1.0.12)

App Store Connect → App Information → Age Rating → Edit Age Rating

| Category | Answer |
|---|---|
| Cartoon or Fantasy Violence | None |
| Realistic Violence | None |
| Prolonged Graphic or Sadistic Realistic Violence | None |
| Profanity or Crude Humor | None |
| Mature/Suggestive Themes | None |
| Horror/Fear Themes | None |
| Medical/Treatment Information | None |
| Alcohol, Tobacco, or Drug Use or References | None |
| Simulated Gambling | None |
| Sexual Content or Nudity | None |
| Graphic Sexual Content and Nudity | None |
| Contests | None |
| Unrestricted Web Access | **No** |
| Gambling | No |

| Made for Kids? | **Yes** |
| Targeted age band | **6–8** (primary) and **9–11** (secondary) — pick "Mixed Audiences for Kids" if the form requires a single value, since Lexi-Lens supports 5–12 |

| Capabilities | Answer |
|---|---|
| Collects data | **Yes** (parent email, child first name, gameplay data) |
| Tracks users across apps | **No** |
| Personalised ads | **No** |
| Third-party advertising | **No** |
| In-app purchases | **Yes** (RevenueCat — once activated; until then answer No) |

### Why these answers
- Lexi-Lens contains zero combat/violence/gore in its quest content. The
  fantasy framing uses "spells" and "enemies" but the v4.7 child-safety
  prefix (`supabase/functions/_shared/childSafety.ts`) explicitly forbids
  Claude from generating violent enemy descriptions. Verified by audit of
  the quest seed.
- "Unrestricted Web Access" is **No**: the only outbound network calls are
  to your Supabase Edge Functions, Anthropic API (server-side only), and
  Sentry. The app does not embed a WebView for arbitrary URLs.
- COPPA + GDPR-K are answered "Yes — collects data" with the parental
  consent flow as the lawful basis. This is the correct answer for an app
  with a parental-consent gate; saying "No — doesn't collect data" would
  be inaccurate and a worse review outcome than honest disclosure.

---

## 3. In-app verdict reporting tool

### Finding
There was no structured way for a parent or child to flag a Claude-generated
verdict that seemed wrong, off-topic, or inappropriate. Both Apple and Google
expect this for LLM-driven children's apps. The closest thing was Sentry
crash reporting, which only captures app crashes, not content concerns.

### Fix
Three new files and one substantive modification to `evaluate/index.ts`:

| File | Purpose |
|---|---|
| `supabase/migrations/20260507_verdict_reports.sql` | Creates `verdict_reports` table with FK to `scan_attempts` and `child_profiles` (both `ON DELETE CASCADE` so reports vanish on COPPA/GDPR-K erasure). RLS restricts SELECT and INSERT to the parent's own children. |
| `supabase/functions/report-verdict/index.ts` | Service-role Edge Function that verifies the supplied `scanAttemptId` belongs to a child whose `parent_id` matches the JWT's `auth.uid()`, then inserts the report. This server-side ownership check is the critical anti-spoofing guarantee — RLS alone cannot enforce it. |
| `supabase/functions/evaluate/index.ts` (modified) | `logScanResult` and `logScanCacheHit` now return the inserted row's id; the response includes a new `_scanAttemptId` field on both the cache-hit and Claude-call paths so the client can link a report to its scan. |
| `components/VerdictCard.tsx` (modified) | Adds a small "⚐ Report this verdict" link below the action buttons (only when a `scanAttemptId` is present, i.e. never on error states). Tapping opens a modal sheet with five reason buttons; non-"other" reasons submit immediately, "other" reveals a 200-char optional note. Success/error states are inline. |
| `hooks/useLexiEvaluate.ts` (modified) | Surfaces `_scanAttemptId` from the result as a clean `scanAttemptId: string \| null` value on the hook return. |
| `lib/sentry.ts` (modified) | Adds `captureVerdictReport()` helper that fires a Sentry warning event in parallel with the DB insert so spikes show up on the crash dashboard. The free-text note is **never** sent to Sentry — only structured fields. |
| `screens/ScanScreen.tsx` (modified) | Three-line change: pulls `scanAttemptId` from the hook and passes it to `<VerdictCard>`. |

### Reason taxonomy
The CHECK constraint on `verdict_reports.reason` allows exactly six values:
`wrong_object`, `wrong_property`, `feels_inappropriate`, `too_hard`,
`too_easy`, `other`. To add a new reason: replace the constraint via a new
migration (the column is plain TEXT to make this cheap — no Postgres ENUM
rebuild required).

### Review path
Until volume justifies a UI, reports are reviewed via SQL. Useful queries:

```sql
-- Most recent 50 reports
SELECT created_at, reason, detected_label, resolved_name, cache_hit, note
FROM verdict_reports
ORDER BY created_at DESC
LIMIT 50;

-- Reason breakdown last 7 days
SELECT reason, count(*) AS n
FROM verdict_reports
WHERE created_at >= now() - interval '7 days'
GROUP BY reason
ORDER BY n DESC;

-- Are reports concentrated on specific cached entries?
-- (a useful signal for cache-key regressions)
SELECT cache_hit, count(*) AS n
FROM verdict_reports
WHERE created_at >= now() - interval '7 days'
GROUP BY cache_hit;
```

A dashboard would be a post-launch data-gated item once volume crosses ~5
reports/day.

---

## 4. Anthropic child-safety system prompt prefix

### Finding
All five Claude-using Edge Functions (`evaluate`, `generate-quest`,
`retire-word`, `classify-words`, `export-word-tome`) built their own system
prompt independently, with no explicit child-safety guardrails — they relied
on Anthropic's base alignment plus the implicit context of a children's
vocabulary game. That is the right starting point for prototype work, but
not for App Store Kids and Play Designed-for-Families.

### Fix
- New shared module: `supabase/functions/_shared/childSafety.ts` exporting
  `CHILD_SAFETY_PREFIX`. ~250 tokens, prepended to every system prompt in
  the project.
- The prefix lists eight content categories Claude must never produce
  (violence, sexual content, frightening content, profanity/slurs,
  drugs/alcohol, religious/political/commercial advocacy, dangerous
  imitable activities, PII extraction).
- It also imposes a **fail-safe contract**: when Claude is uncertain or
  receives input that would push toward unsafe output, it must return the
  task's expected JSON shape with neutral placeholder content (e.g.
  `resolvedObjectName: "object"`, `childFeedback: "Let's try another
  scan!"`) rather than refuse with prose. This prevents the child-facing
  UI from ever displaying a refusal message.
- Applied to all 5 functions. Drop-in files patched cleanly.

### Cost impact
Negligible. ~250 tokens × Haiku 4.5 input rate (~$1/MTok) = $0.00025 per
scan. At the project's observed pre-launch volume the monthly cost is well
under $1. Prompt caching is not viable on Haiku 4.5 at the project's
current prompt size (cache threshold 4,096 tokens; system prompt ~1,000
even with the new prefix), so the prefix is paid in full on every call.
This trade-off is correct: the safety guarantee dominates the marginal
spend.

### What this does NOT solve
The prefix is a soft constraint, not a hard one. A determined adversarial
input could still elicit borderline output. The prefix raises the floor;
it does not establish a ceiling. The verdict-reporting tool above is the
companion safety net for cases that slip through.

---

## 5. Sentry PII audit

**STATUS: AUDIT COMPLETE — no PII leakage found.**

### Methodology
- `grep -rn "captureGameError\|addGameBreadcrumb\|setUser\|setContext\|setTag"
  --include="*.ts" --include="*.tsx" .` across the entire codebase.
- Inspected every match for fields that could carry PII (email,
  display_name, child_name, address, phone, raw text the child typed).

### Findings
| Call site | What it sends | Verdict |
|---|---|---|
| `lib/sentry.ts → setUserContext` | `id: parentId`, `tag: child_id`, `tag: child_age` | ✓ Clean. IDs only, no names, no emails. |
| `App.tsx` auth/navigation breadcrumbs | `userId`, `routeName`, `event` (auth event type) | ✓ Clean. UUIDs and enum strings. |
| `hooks/useLexiEvaluate.ts` | `detectedLabel`, `questId`, `attempt`, `resolvedObjectName`, `xpAwarded`, `cacheHit` | ✓ Clean. No PII. The `detectedLabel` is an ML Kit / `"object"` string, not user input. |
| `hooks/useAnalytics.ts` | `sessionId`, `childId`, `questId`, `gameSessionId`, `xpAwarded`, `hardMode` | ✓ Clean. IDs and integers only. |
| `hooks/usePdfExport.ts` | `childId`, file size, error message | ✓ Clean. |
| `components/ErrorBoundary.tsx` | React error stack | ✓ Clean. Stack frames are code-internal, not user data. |
| `store/gameStore.ts` | Quest lifecycle: `questId`, `childId`, `xpAwarded` | ✓ Clean. |

### Belt-and-braces additions in `lib/sentry.ts` (v4.7)
Even though the audit is clean, future contributors might add a breadcrumb
that accidentally includes sensitive content. Two new defensive layers:

1. **Field-level scrubber.** `SENSITIVE_KEYS` set covers `Authorization`,
   `x-api-key`, `apiKey`, `anthropic_api_key`, `supabase_service_role_key`,
   `password`, `frameBase64`, `frameUri`, `email`, `displayName`,
   `childName` and several variants. Any breadcrumb data field with one
   of those names is replaced with `[redacted]` before transmission.
2. **Pattern-level scrubber.** Free-form strings (breadcrumb messages,
   error messages, exception values, tag values) pass through three
   regex replacements: Anthropic API keys (`sk-ant-...`), JWTs (`eyJ...`),
   and email addresses. Each is replaced with a marker like
   `[redacted-email]`.

The scrubbers fail closed — they replace, never drop the event entirely —
so we still see that an event happened even when its content was masked.

---

## 6. Sentry environment override

### Finding
`lib/sentry.ts` was initialising with
`environment: __DEV__ ? "development" : "production"`. That collapses
staging TestFlight + Play Internal Testing into the same Sentry environment
as real production crashes, making it impossible to filter staging noise
out of the production crash dashboard. The wiring to fix this was already
present in `lib/env.ts` — `ENV.sentry.environment` already maps to the
APP_VARIANT — but `lib/sentry.ts` simply wasn't reading it.

### Fix
Drop-in `lib/sentry.ts` reads `ENV.sentry.environment` and uses it as the
Sentry environment tag. Three values now possible: `development`,
`staging`, `production`. Each one gets its own filter in the Sentry
dashboard.

Additional changes that fell out of being in the file:
- `release` is now `${variant}@${version}` (e.g. `production@1.0.12`,
  `staging@1.0.12`). This prevents a staging 1.0.12 crash from being
  incorrectly attributed to the production 1.0.12 release in the Sentry
  Releases dashboard, and matches the sourcemap upload format from the
  `@sentry/react-native/expo` plugin in `app.config.js`.
- `tracesSampleRate` is now 1.0 in dev/staging and 0.2 in production
  (was 0.2 for everything non-dev). 100% sampling in staging gives full
  performance traces during testing without touching the production budget.

---

## Adjacent fix: missing migration `20260504_quest_completions_unique_mode.sql`

The unique constraint on `quest_completions(child_id, quest_id, mode)` was
applied directly to the live Supabase project during a v4.3 debugging pass
but the SQL file was never committed. `bootstrap.sql` contains the
constraint inline, so a fresh DB provisioned via `bootstrap.sql` is
correct, but `supabase db push` against an existing project provisioned
via the older migration approach would have been missing the constraint.
Recovered as `supabase/migrations/20260504_quest_completions_unique_mode.sql`
during this session. Idempotent — safe to apply on a DB that already has
the constraint.

This is a prerequisite to the Phase 4.0 staging+prod migration. If you run
`supabase db push` against a fresh staging or prod project before the v4.7
migrations land, the missing constraint would silently degrade the
gameStore upsert to a plain INSERT.

---

## Roadmap delta

The following items in `LexiLens_Roadmap_v4_9.html` "Compliance polish"
section can be marked closed:

- ✅ Privacy Policy URL audit (code-side fix complete; manual re-paste of
  same URLs into both stores is the only remaining step)
- ⚠ Apple age rating questionnaire refresh — **MANUAL**, see § 2 above.
  Roadmap should keep this open until you've completed it in App Store
  Connect. Estimate: 5 minutes.
- ✅ In-app verdict reporting tool
- ✅ Anthropic child-safety system prompt prefix
- ✅ Sentry PII audit
- ✅ Sentry environment override

Two items remain after this session:

| Item | Owner | Where |
|---|---|---|
| Re-paste Privacy Policy URL into App Store Connect + Play Console | NJ | Manual UI |
| Refresh Apple age rating answers per § 2 | NJ | App Store Connect |

Both are App Store Connect / Play Console UI work — neither can be solved
in code. Once both are done, "Compliance polish" can be moved to the
"Closed pre-launch" section of the roadmap.

---

## Files changed in this session

### New files
- `supabase/migrations/20260507_verdict_reports.sql`
- `supabase/migrations/20260504_quest_completions_unique_mode.sql` (recovered)
- `supabase/functions/report-verdict/index.ts`
- `supabase/functions/_shared/childSafety.ts`
- `docs/COMPLIANCE_AUDIT.md` (this file)

### Modified files
- `privacy-policy.html`
- `data-deletion.html`
- `lib/sentry.ts`
- `hooks/useLexiEvaluate.ts`
- `components/VerdictCard.tsx`
- `screens/ScanScreen.tsx`
- `supabase/functions/evaluate/index.ts`
- `supabase/functions/evaluate/evaluateObject.ts`
- `supabase/functions/generate-quest/index.ts`
- `supabase/functions/retire-word/index.ts`
- `supabase/functions/classify-words/index.ts`
- `supabase/functions/export-word-tome/index.ts`

### Deploy order
1. Run both migrations: `20260504` first (defensive — no-op if already present), then `20260507`.
2. Deploy Edge Functions: `report-verdict` and the four already-existing functions that have prefix patches.
3. Deploy `evaluate` last, after the migrations land — `_scanAttemptId` returned by the modified evaluate is a no-op for older clients.
4. Publish app build with new `lib/sentry.ts`, `hooks/useLexiEvaluate.ts`, `components/VerdictCard.tsx`, `screens/ScanScreen.tsx`. EAS Update is sufficient; no native change.
5. Replace `privacy-policy.html` and `data-deletion.html` on the public host.
6. Manual: re-paste Privacy Policy URL in App Store Connect + Play Console; refresh Apple age rating per § 2.
