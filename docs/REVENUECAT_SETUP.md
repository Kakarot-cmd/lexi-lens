# RevenueCat Setup Runbook

**Phase:** 4.4
**Last updated:** 2026-05-14
**Owner:** NJ
**Status:** Code shipped. Dashboard setup is a manual checklist that must be completed before sandbox testing.

## Scope

This runbook covers everything OUTSIDE the codebase needed to make Phase 4.4 functional:

- RevenueCat Dashboard project + app + entitlement + offerings
- App Store Connect IAP products + sandbox testers + Small Business Program
- Google Play Console subscriptions + service account
- Supabase secrets (webhook secret)
- EAS secrets (sandbox + prod public keys)

If you reorder anything, the dependency graph is:

```
Apple SBP enrollment (start NOW — 2-4 week approval) ──────┐
                                                            │
ASC IAP products ─── RC iOS app config ─── RC Offerings ───┤
                                                            ├── End-to-end test
Play Console subs ── RC Android app config ── (same) ──────┤
                                                            │
Supabase secrets + migration apply ── Edge fn deploy ───────┘
```

## Naming conventions (locked — do not change)

| Concept | Value |
|---|---|
| Entitlement ID (RC) | `premium` |
| Product ID (premium monthly) | `lexilens_premium_monthly` |
| Product ID (premium yearly) | `lexilens_premium_yearly` |
| Product ID (family monthly — Phase 4.6) | `lexilens_family_monthly` |
| Product ID (family yearly — Phase 4.6) | `lexilens_family_yearly` |
| RevenueCat Offering ID | `default` |
| App User ID | Supabase parent UUID (from `auth.users.id`) |

Changing any of these later requires coordinated edits in:

- `lib/revenueCat.ts` (entitlement, tier mapping)
- `supabase/functions/revenuecat-webhook/index.ts` (entitlement, tier mapping)
- RC Dashboard
- App Store Connect product config
- Play Console subscription config

## Step 1 — Apple Small Business Program (longest lead time)

Apply NOW even before iOS builds work. Approval takes 2-4 weeks. Without SBP, Apple takes 30%. With SBP, they take 15% for the first $1M/year. This is a 50% margin improvement on iOS.

1. Apple Developer Account → Membership → Apple Small Business Program → Apply.
2. Provide business name, address, tax info.
3. Wait for approval email. SBP discount applies retroactively from the start of the next calendar quarter after approval.

Memory: Apple SBP application is independent of iOS build state. Approval clock starts the day you apply, not the day you launch.

## Step 2 — App Store Connect IAP products

Prerequisites:

- Lexi-Lens app record in App Store Connect (you have one: ASC ID 6766159881, bundle `com.navinj.lexilens`)
- Active Apple Developer Program membership ($99/yr — already paid)
- Paid Applications agreement signed in Agreements, Tax, and Banking
- Banking + tax forms complete (without these, even sandbox purchases fail)

Setup:

1. ASC → My Apps → Lexi-Lens → Subscriptions → Create Subscription Group.
   - Group reference name: `Lexi-Lens Premium`
2. Inside the group, create two subscriptions:
   - **Reference Name:** `Lexi-Lens Premium Monthly` · **Product ID:** `lexilens_premium_monthly`
   - **Reference Name:** `Lexi-Lens Premium Yearly` · **Product ID:** `lexilens_premium_yearly`
3. For each subscription:
   - Subscription duration: 1 Month and 1 Year respectively
   - Set price in your primary territory (INR for India). Apple will auto-tier other markets, override as needed.
   - Localization: English (US) + English (India) at minimum
     - Display name: "Premium"
     - Description: "Unlock the full Lexi-Lens adventure"
   - Optional: introductory offer (e.g. 7-day free trial). Apple's matrix shows ~25-35% uplift on free trials.
4. App Review Information:
   - Screenshot: provide a 1290×2796 screenshot of the paywall (you'll have one after first build)
   - Review notes: explain the product is a kids' educational subscription
5. Status: "Ready to Submit" for sandbox testing. Production requires app submission.

Sandbox testers:

1. ASC → Users and Access → Sandbox Testers → Add.
2. Use a unique email (Apple disallows real Apple IDs). Format: `nj+sandbox1@yourdomain.com`.
3. Create at least 3: one fresh-purchase tester, one renewal tester, one cancellation tester.
4. On the device: Settings → App Store → Sandbox Account → sign in with the sandbox tester credentials. **Do NOT sign in via Settings → Apple ID** — that's the production account and will charge real money.

## Step 3 — Google Play Console subscriptions

Prerequisites:

- Lexi-Lens app record in Play Console (you have one: package `com.navinj.lexilore`)
- Play Developer registration ($25 one-time — already paid)
- Closed Testing track with at least one tester active

Setup:

1. Play Console → Lexi-Lens → Monetize → Subscriptions → Create subscription.
   - **Product ID:** `lexilens_premium_monthly`
   - Name: "Premium Monthly"
   - Base plan: monthly auto-renewing, set price
2. Repeat for `lexilens_premium_yearly` (yearly base plan).
3. Activate both subscriptions. Status must be "Active" or RC can't list them.

Play service account for RC (required for entitlement verification on Android):

You already created `lexi-lens-play-upload@airy-adapter-249205.iam.gserviceaccount.com` for app upload. You can either:

- (A) Reuse it: grant the service account the additional Play Console permissions needed for subscriptions (View financial data, Manage orders and subscriptions).
- (B) Create a dedicated `lexi-lens-revenuecat@...` service account for cleaner audit trails.

Recommendation: (B) — separate concerns. The upload SA gets revoked or rotated on a different cadence than the RC SA.

Steps for option B:

1. GCP Console → IAM → Service Accounts → Create.
2. Name: `lexi-lens-revenuecat`. Grant no project-level roles.
3. Create a JSON key, download it.
4. Play Console → Setup → API access → Link the GCP project that hosts this SA.
5. Grant the SA: "View financial data", "Manage orders and subscriptions" at app level.
6. Upload the JSON to RC (see step 4).

## Step 4 — RevenueCat Dashboard

1. Create project: app.revenuecat.com → New Project → "Lexi-Lens".
2. Add iOS app:
   - Bundle ID: `com.navinj.lexilens`
   - App Store Connect API key: upload an API key with App Manager role (Settings → Apple Account in RC)
   - Copy the **iOS Public SDK Key** (starts with `appl_`). This goes into EAS as `EXPO_PUBLIC_REVENUECAT_IOS_KEY_SANDBOX` and `_PROD`.
3. Add Android app:
   - Package: `com.navinj.lexilore`
   - Upload the Play Console service account JSON from step 3
   - Copy the **Android Public SDK Key** (starts with `goog_`). Goes into EAS as `EXPO_PUBLIC_REVENUECAT_ANDROID_KEY_SANDBOX` and `_PROD`.

   Note: RC uses ONE pair of keys per app — sandbox and production share the same key. The "sandbox" label in your EAS env names refers to which Supabase project the staging build talks to, not to a separate RC key. If you only want to publish your app in one RC project for both sandbox and production purchases, set `EXPO_PUBLIC_REVENUECAT_IOS_KEY_SANDBOX = EXPO_PUBLIC_REVENUECAT_IOS_KEY_PROD`. This is the recommended setup.

4. Import products:
   - Products tab → Import from App Store / Play Store
   - All 4 products should appear: monthly + yearly on each platform
5. Create entitlement:
   - Entitlements → New entitlement → Identifier: `premium`
   - Attach all 4 products (the iOS pair AND the Android pair).
6. Create offering:
   - Offerings → New offering → Identifier: `default`
   - Mark as the **Current** offering.
   - Add two packages:
     - Package: `$rc_monthly` → attach `lexilens_premium_monthly` (both platforms)
     - Package: `$rc_annual` → attach `lexilens_premium_yearly` (both platforms)
   - Note: RC's package identifier `$rc_annual` is a fixed naming convention
     for "the annual cadence package" — the product attached can be named
     `_yearly` or `_annual` interchangeably. RC reads PackageType.ANNUAL on
     the client side via package introspection, not the product ID string.
7. Configure webhook:
   - Project Settings → Integrations → Webhooks → Add webhook
   - URL: `https://<your-supabase-project-ref>.supabase.co/functions/v1/revenuecat-webhook`
   - Add a custom header: `Authorization: Bearer <shared-secret>` — generate a random 32+ character string. Save this; you'll add it to Supabase secrets next.
   - Test events: pick "Send test event" → RC's webhook page should show a 200 response. The `revenuecat_webhook_log` table in Supabase should have a row with `event_type='TEST'`.

## Step 5 — Supabase secrets + Edge Function deploy

1. Apply the migration:

   ```
   supabase db push
   ```

   Verify:

   ```
   psql ... -c "SELECT table_name FROM information_schema.tables WHERE table_name='revenuecat_webhook_log';"
   ```

2. Set the webhook secret (the same string you used in RC Dashboard → webhook → Authorization header):

   ```
   supabase secrets set REVENUECAT_WEBHOOK_SECRET=<your-secret>
   ```

3. Deploy the function with `--no-verify-jwt` (RC doesn't sign with a Supabase JWT):

   ```
   supabase functions deploy revenuecat-webhook --no-verify-jwt
   ```

4. Test by clicking "Send test event" in RC Dashboard. Confirm:
   - HTTP 200 response in RC's webhook log
   - New row in `public.revenuecat_webhook_log` with `event_type='TEST'`, `processing_note='ignored'`

Apply all of this to BOTH Supabase projects (staging and production):

| Step | Staging (`zhnaxafmacygbhpvtwvf`) | Production (`vwlfzvabvlcozqpepsoi`) |
|---|---|---|
| Migration | Apply now | Apply at launch |
| Secret | Set with staging RC project's secret | Set with production RC project's secret |
| Function deploy | Deploy now | Deploy at launch |

If you only have ONE RC project (recommended for solo dev), you can use the same secret for both Supabase projects, but the webhook URL must be added twice in RC Dashboard (once per Supabase project URL). RC supports multiple webhooks per project.

## Step 6 — EAS secrets

You already have placeholders in `eas.json`. Add the actual values:

```
eas secret:create --scope project --name EXPO_PUBLIC_REVENUECAT_IOS_KEY_SANDBOX     --value appl_xxx --type STRING --visibility SENSITIVE
eas secret:create --scope project --name EXPO_PUBLIC_REVENUECAT_ANDROID_KEY_SANDBOX --value goog_xxx --type STRING --visibility SENSITIVE
eas secret:create --scope project --name EXPO_PUBLIC_REVENUECAT_IOS_KEY_PROD        --value appl_xxx --type STRING --visibility SENSITIVE
eas secret:create --scope project --name EXPO_PUBLIC_REVENUECAT_ANDROID_KEY_PROD    --value goog_xxx --type STRING --visibility SENSITIVE
```

If you're using one RC project for both: set `_SANDBOX` and `_PROD` to the same key value.

Note: `EXPO_PUBLIC_*` variables CANNOT be `SECRET` visibility — they bundle into the client. Use `SENSITIVE` (still hidden from non-builder EAS users) or `PLAIN_TEXT`.

## Step 7 — Sandbox end-to-end test

Build:

```
set APP_VARIANT=staging
eas build --platform android --profile staging
```

Install the resulting AAB on a real device via Play Console Internal Testing track. Then:

1. Sign in with a parent account in the app.
2. Tap a locked premium quest → paywall appears.
3. Tap "Subscribe" → Google Play (or Apple) purchase sheet appears.
4. Use sandbox tester credentials. Confirm purchase.
5. Back in the app, the QuestMap should refresh — locked quests now show as unlocked.
6. Check Supabase:

   ```sql
   SELECT subscription_tier FROM parents WHERE id = '<your-parent-uuid>';
   -- expect: 'tier1'

   SELECT event_type, processing_note, received_at
   FROM revenuecat_webhook_log
   WHERE app_user_id = '<your-parent-uuid>'
   ORDER BY received_at DESC LIMIT 5;
   -- expect: INITIAL_PURCHASE row with processing_note='applied:tier1'
   ```

If `parents.subscription_tier` shows `'free'` after a successful sandbox purchase:

- Check the RC Dashboard → Subscriber view for your sandbox parent UUID. Confirm "premium" entitlement is active.
- Check the webhook log for your event. If `processing_note` is `applied:tier1` but the column is still `'free'`, there's a row-update bug (capture and report).
- If the event isn't in the log at all, the webhook didn't fire or failed authorization. Check RC Dashboard → Integrations → Webhooks → recent deliveries.
- If the log shows `processing_note='duplicate'` for the very first event — you have a stale duplicate from a previous run; safe to clear `revenuecat_webhook_log` between full re-tests.

## Step 8 — iOS (deferred until iOS builds work)

When iOS builds are healthy:

- Repeat steps 2 and 7 with `--platform ios --profile staging`
- Sign in with a sandbox tester via Settings → App Store → Sandbox Account
- TestFlight handles distribution; the paywall flow is identical to Android

## Known gotchas

- **Subscription paused on Android** — RC sends `SUBSCRIPTION_PAUSED`. The webhook revokes the entitlement. When the user un-pauses, RC sends `RENEWAL`. This works correctly with our event handler.
- **Refunds** — RC sends `REFUND` and we set tier=free. The user retains historical content (badges, completed quests) but loses ongoing access. This is the intended behavior; revoking historical progress is hostile UX.
- **Grace period** — Apple subscribers in billing-issue grace get `BILLING_ISSUE` only AFTER the 16-day grace expires. During grace, no event is sent. Our derived `SubscriptionDetails.inGracePeriod` will reflect this from the client SDK; UI should soften the "Premium" badge during grace.
- **Family sharing (Apple)** — Apple's Family Sharing for Subscriptions: organizer purchases, family members can use the entitlement. RC handles this; we get an event per family member who first accesses the entitlement. No code changes needed; works out of the box.
- **Promotional offers** — RC supports promo codes via App Store Connect Promotional Offer Codes. Not in 4.4 MVP, but RC will deliver `INITIAL_PURCHASE` events with a discount applied; the webhook handles these the same as full-price purchases.

## Webhook event-type coverage table

| RC Event Type | Webhook Handler Behavior |
|---|---|
| `INITIAL_PURCHASE` | Set parent's tier from product ID |
| `RENEWAL` | Set parent's tier from product ID |
| `PRODUCT_CHANGE` | Set parent's tier from new product ID |
| `UNCANCELLATION` | Set parent's tier from product ID |
| `TEMPORARY_ENTITLEMENT_GRANT` | Set parent's tier from product ID (RC manual grants) |
| `SUBSCRIPTION_EXTENDED` | Set parent's tier from product ID (Apple grace period extensions) |
| `CANCELLATION` | No-op (entitlement remains until expiration; wait for EXPIRATION) |
| `EXPIRATION` | Set parent's tier to `free` |
| `BILLING_ISSUE` | Set parent's tier to `free` (after grace) |
| `REFUND` | Set parent's tier to `free` |
| `SUBSCRIPTION_PAUSED` | Set parent's tier to `free` (Android pause) |
| `TRANSFER` | Revoke from old UUID(s), grant to new UUID(s) |
| `TEST` | Log and ignore |
| `NON_RENEWING_PURCHASE` | Log and ignore (consumables — not in our product line) |
| Unknown future type | Log with `processing_note='unknown_type'`, return 200 |

## Apple App Review Notes (for first submission)

When submitting Lexi-Lens for review with IAP, the App Review team needs:

- One of your sandbox testers' credentials in App Review notes
- A short script: "Tap any quest in the second tier (purple). Paywall appears. Tap Subscribe. Use sandbox tester credentials. Purchase completes. The quest is now playable."
- Explicit mention that this is a subscription with auto-renewal (Apple guideline 3.1.2)
- Privacy URL: `https://lexilens.app/privacy-policy` (your existing page)
- Terms URL: `https://lexilens.app/terms` (you need to add this — currently linked in the paywall but the URL must exist before submission)

## Phase 4.6 follow-ups

Not in 4.4 scope but flagged here for next-phase memory:

- Family tier products in ASC + Play + RC
- Annual bundle prominent placement in paywall UI (currently auto-selects but doesn't ad-feature heavily)
- Promo code support in paywall ("I have a code" link)
- Restore-on-foreground (auto-call `Purchases.getCustomerInfo()` when app comes back to foreground; webhook lag mitigation)
- Per-region pricing optimization with FX hedge (~5% buffer on INR prices)
