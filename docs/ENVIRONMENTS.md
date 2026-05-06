# Lexi-Lens — Environment Split Operations Guide

**Status:** v4.5 — code-side wiring delivered. Supabase migration is the next operational step.
**Audience:** Anyone running `eas build`, `supabase functions deploy`, or local `expo start`.

This document is the runbook for the staging / production environment split. Read it once before your first staging build, and again before the production migration session.

---

## The architecture in one paragraph

**Two Supabase projects. Three build variants.**

| Build variant | Where it runs | Supabase project |
|---|---|---|
| `development` | Local Metro / `expo start` / dev client builds | **STAGING** |
| `staging` | EAS preview builds, TestFlight Internal, Play Internal/Closed Testing | **STAGING** |
| `production` | App Store + Play Store production | **PRODUCTION** |

`development` and `staging` share the same Supabase database. They differ only in build profile (debuggable vs release-mode) and bundle ID (so they install side-by-side on the same device for testing). All your tester data, RevenueCat sandbox purchases, Apple/Google reviewer accounts, and developer scans land in the same staging tables — exactly where you want them.

`production` stands alone. It has its own Supabase project, its own Anthropic API key (with a budget cap), its own Upstash cache, its own RevenueCat keys. **Nothing test-related ever touches production.**

---

## Why two and not three

In an earlier draft this document recommended three Supabase projects. After thinking through the tradeoffs for a one-person team, two is right for Lexi-Lens v1.0:

- The actual firewall that matters is **testers vs paying users** (staging-vs-production). A separate dev database doesn't strengthen that firewall.
- A third project means a third Anthropic key to budget-cap, a third Upstash to monitor, a third schema to keep in sync, a third set of EAS Secrets — paid in your time.
- Adding a third project later is a 5-minute operation. Adding it preemptively is permanent overhead.

**Triggers to revisit (split dev from staging into a third project):**
1. You hire a second dev — they need a sandbox that doesn't kick you out.
2. You add CI tests that mutate data — they need their own clean DB.
3. You need a separate "demo" environment for partner/school pitches.

Until those happen, two environments is the right call.

---

## Step 1 — Identify which existing project becomes staging

You already have ONE Supabase project in active use:

```
Project ref:  zhnaxafmacygbhpvtwvf
URL:          https://zhnaxafmacygbhpvtwvf.supabase.co
```

**This becomes staging.** No migration needed for staging — it already has your schema, RLS, Edge Functions, secrets, quest data, and current testers. You just rename it in your head from "the Supabase project" to "the staging Supabase project."

Optional cosmetic step in the dashboard: rename the project to `lexi-lens-staging` so the title in the URL bar reminds you which environment you're looking at. This doesn't change the project ref — that's permanent.

---

## Step 2 — Create the new production project

This is the only Supabase creation you do.

1. Go to https://supabase.com/dashboard
2. **New project** → name it `lexi-lens-prod`
3. **Same region** as staging (your testers' latency expectations carry over)
4. **New strong password** — don't reuse the staging password. Store both in your password manager separately.
5. Note the new project ref. You'll need it in step 5.

The project is empty at this point. Schema, functions, secrets, quests all need to be applied — the next steps cover that.

---

## Step 3 — Mirror schema from staging to production

You need your existing schema (every table, RLS policy, function, trigger, view, index) replicated on the new project.

The shortest path:

```bash
# From the project root.
# Replace passwords with what you stored in your password manager.

# Dump schema-only from staging (skip data — it's not migrating)
supabase db dump \
  --db-url "postgresql://postgres:<STAGING_PASSWORD>@db.zhnaxafmacygbhpvtwvf.supabase.co:5432/postgres" \
  --schema public \
  --schema auth \
  --data-only=false \
  -f /tmp/schema.sql

# Apply to new prod
psql "postgresql://postgres:<PROD_PASSWORD>@db.<new-prod-ref>.supabase.co:5432/postgres" \
  -f /tmp/schema.sql
```

Verify in psql against the new prod:

```bash
psql "<new-prod-conn-string>"

\dt public.*           # should list child_profiles, quests, scan_attempts, etc.
\df public.*           # should list all your functions
\dv public.*           # should list views like word_fail_rates
```

If any tables/functions are missing, your `bootstrap.sql` skeleton (per v4.4) plus the `bootstrap_extract_functions.sql` script you already have are the fallback — run them against the new prod manually.

---

## Step 4 — Deploy Edge Functions to production

```bash
# From project root, looping all 8 functions
for fn in evaluate generate-quest export-word-tome classify-words request-deletion retire-word record-consent cancel-deletion; do
  supabase functions deploy $fn --project-ref <new-prod-ref> --no-verify-jwt
done
```

Verify in the prod project's dashboard → Edge Functions → all 8 should be listed and "Active."

---

## Step 5 — Set Edge Function secrets on production

The new prod project has no secrets yet. Each Edge Function reads `ANTHROPIC_API_KEY`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` from project secrets.

```bash
supabase secrets set --project-ref <new-prod-ref> \
  ANTHROPIC_API_KEY="<NEW prod Anthropic key>" \
  UPSTASH_REDIS_REST_URL="<NEW prod Upstash REST URL>" \
  UPSTASH_REDIS_REST_TOKEN="<NEW prod Upstash token>"
```

**Use brand-new credentials for prod, NOT a copy of staging's:**

- **Anthropic:** create a fresh API key in the Anthropic console with a $200/month budget cap (you can raise it later). Don't reuse the staging key. If your staging key leaks via a stale log or a forked dev build, you don't want it to auth as production.
- **Upstash:** create a fresh Upstash database. The staging cache contains keys derived from staging label patterns — meaningless to prod and a tiny privacy concern.

Note: production builds the new architecture. Staging keeps using its existing secrets — no changes there.

---

## Step 6 — Curated quest seed for production

This is the only production data that exists at launch. Hand-pick from the 75+ quests in staging.

```bash
# Quickest path: filter to active+launch-ready quests in staging,
# export to CSV, import to prod.

psql "<staging-conn>" -c "\
  COPY (SELECT * FROM quests WHERE is_active = true AND launch_ready = true) \
  TO '/tmp/quests_seed.csv' WITH CSV HEADER"

psql "<prod-conn>" -c "\
  COPY quests FROM '/tmp/quests_seed.csv' WITH CSV HEADER"
```

Adjust the `WHERE` clause to match your actual quality criteria. Treat this as a quality cut — fewer well-tested quests is better than many half-baked ones at launch.

If you have related seed tables (achievements, mastery tiers), repeat the same pattern for each.

---

## Step 7 — Configure auth on the production Supabase project

In the new prod Supabase project's dashboard:

1. **Authentication → URL Configuration → Redirect URLs** — add these to the allowlist:
   ```
   lexilens://auth/confirm
   lexilens://auth/reset
   ```
   Skip `lexilensstaging://*` and `lexilensdev://*` — those don't apply to prod.

2. **Authentication → Email Templates → Reset Password** — verify the body contains `{{ .ConfirmationURL }}`. See `docs/FORGOT_PASSWORD_SETUP.md` for the full template.

3. **Authentication → Settings** — match the email-confirmation setting from staging (it's currently enabled).

---

## Step 8 — Set EAS Secrets

Local dev gets credentials from `.env.local`. EAS cloud builds get them from EAS Secrets.

```bash
# ── Production secrets ─────────────────────────────────────────────
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_URL_PROD       --value "https://<new-prod-ref>.supabase.co"
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_ANON_KEY_PROD  --value "<new-prod-anon-key>"
eas secret:create --scope project --name EXPO_PUBLIC_SENTRY_DSN_PROD         --value "<prod-sentry-dsn>"
# RevenueCat keys are added when Phase 4.4 starts — leave for later
# eas secret:create --scope project --name EXPO_PUBLIC_REVENUECAT_IOS_KEY_PROD     --value "..."
# eas secret:create --scope project --name EXPO_PUBLIC_REVENUECAT_ANDROID_KEY_PROD --value "..."

# ── Staging secrets ────────────────────────────────────────────────
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_URL_STAGING       --value "https://zhnaxafmacygbhpvtwvf.supabase.co"
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_ANON_KEY_STAGING  --value "<existing-staging-anon-key>"
eas secret:create --scope project --name EXPO_PUBLIC_SENTRY_DSN_STAGING         --value "<staging-sentry-dsn>"
# RevenueCat sandbox keys for staging (added in Phase 4.4)
# eas secret:create --scope project --name EXPO_PUBLIC_REVENUECAT_IOS_KEY_SANDBOX     --value "..."
# eas secret:create --scope project --name EXPO_PUBLIC_REVENUECAT_ANDROID_KEY_SANDBOX --value "..."

# Verify
eas secret:list
```

You should see at minimum: `_PROD` set for SUPABASE_URL, SUPABASE_ANON_KEY, SENTRY_DSN, and `_STAGING` set for the same three.

---

## Step 9 — Verify the wiring end-to-end

The single most important verification step. Run this BEFORE submitting anything to App Store or Play Production.

```bash
# 1. Local dev hits staging
npx expo start
# Watch Metro startup logs for:
#   [env] variant=development supabaseHost=zhnaxafmacygbhpvtwvf ...

# 2. Build a staging APK and install it
eas build --profile staging --platform android
# After install, sign up with a fresh email
# → Check the STAGING Supabase project's auth.users — the new user appears there
# → Check the PROD Supabase project's auth.users — empty (or test users only)

# 3. Build a production APK and install it
eas build --profile production --platform android
# After install, sign up with a different fresh email
# → Check the PROD Supabase project's auth.users — the new user appears there
# → Check Sentry → events tagged environment: production
```

If both sign-ups land in the right projects, your env wiring is correct.

If your "production" sign-up shows up in staging's user list, **stop everything**. There's a misconfiguration to fix before submitting to the stores. Possibilities to check:
- Wrong EAS Secret value (`SUPABASE_URL_PROD` accidentally pointing at the staging project)
- Build picked up `.env.local` over EAS Secrets (shouldn't happen with EAS Build — `.env.local` is gitignored)
- `eas.json` profile env block not referencing `_PROD` (compare to the file you have)

---

## Step 10 — Final pre-launch insurance

The day before you submit to App Store / apply for Play production access:

```bash
# Snapshot of staging just in case
pg_dump "<staging-conn-string>" -f ~/lexi-lens-staging-snapshot-$(date +%Y%m%d).sql
```

Worst-case rollback / data recovery if a tester complains about losing genuinely valuable progress. Costs nothing, peace of mind significant.

---

## Building each variant

After everything above is done:

```bash
# Local dev (uses .env.local — Metro reads it automatically)
npx expo start

# Staging build (Internal Testing / TestFlight Internal)
eas build --profile staging --platform android
eas build --profile staging --platform ios

# Production build (App Store / Play Production)
eas build --profile production --platform android
eas build --profile production --platform ios
```

Bundle IDs differ by variant so all three can co-exist on a single test device:

| Variant | iOS bundle | Android package |
|---|---|---|
| development | com.navinj.lexilens.dev | com.navinj.lexilore.dev |
| staging | com.navinj.lexilens.staging | com.navinj.lexilore.staging |
| production | com.navinj.lexilens | com.navinj.lexilore |

> **Why two different "lexi" spellings?** The Android package was originally registered as `com.navinj.lexilore` (a typo of `lexilens`). Renaming would create an entirely separate Play Store app and break the update path for existing testers. We keep the typo in production. Staging and dev mirror it for consistency.

---

## App Store Connect / Play Console — separate app records?

**No.** Both staging and production builds upload to the same App Store Connect app and the same Play Console app, just to different release tracks.

For Lexi-Lens v1.0 launch, the simplest path: submit the `production` profile (with bundle ID `com.navinj.lexilens`) to both TestFlight External AND App Store Production. Skip uploading the `staging` variant to TestFlight — the production binary is what gets reviewed anyway.

The `staging` variant exists for builds you install on your own devices for sandbox-testing without touching the production Apple account / RevenueCat customer pool. Keep that local; don't upload to TestFlight.

---

## Sanity checklist before submitting v1.0 to App Store + Play

- [ ] Production Supabase project (`lexi-lens-prod`) exists and has all migrations applied
- [ ] Production Edge Function secrets set (Anthropic, Upstash) — verify `supabase secrets list --project-ref <prod-ref>`
- [ ] Production Anthropic API key has a budget cap (rec: $200/month for v1.0)
- [ ] Production Upstash database is the new one, not staging's
- [ ] EAS secrets `_PROD` and `_STAGING` exist (`eas secret:list`)
- [ ] `eas build --profile production` builds green on both iOS and Android
- [ ] Test sign-up from production AAB lands in PROD's `auth.users`, NOT staging's
- [ ] Sentry environment tag for that test session shows `production`
- [ ] Reset password redirect URLs added to the prod Supabase project
- [ ] Reset password email template has `{{ .ConfirmationURL }}` in prod
- [ ] Privacy Policy URL accessible from the in-app link
- [ ] Staging snapshot taken (Step 10) — file exists somewhere safe
- [ ] Internal Testing testers told their accounts won't transfer to production

---

## Common confusions, settled

**"Should I use `development` or `staging` profile when building?"**
Local laptop work: don't build, just `npx expo start`. The `development` variant kicks in via `.env.local`.
Building something to install on a phone for personal testing: `--profile development`. Faster, debuggable.
Building something to share with testers via TestFlight or Play Internal: `--profile staging`. Release-mode, optimized.
Building for the App Store / Play Production: `--profile production`. Different Supabase, different keys.

**"Will dev/staging confusion cause data corruption?"**
No. Both `development` and `staging` profiles point at the same Supabase project. Whichever you use, you're hitting staging data. The only profile that touches production is `production`, and that requires you to type `--profile production` explicitly. There's no accidental path to prod from a dev or staging build.

**"What if I want to point local dev at production briefly to debug a real-user issue?"**
Don't edit `.env.local` to use prod credentials — too easy to forget to revert. Better: use a read-only psql session against prod for the SQL parts, and keep your local app pointed at staging. If you genuinely need to reproduce a bug against prod data, copy the relevant rows from prod to staging first.
