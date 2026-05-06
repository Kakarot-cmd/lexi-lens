# Forgot Password — Supabase Dashboard Setup

This runbook covers the **operational side** of the password-reset flow: the Supabase Dashboard configuration that lives outside the codebase. The code-side wiring (`lib/authFlow.ts`, `screens/AuthScreen.tsx`, `App.tsx`) is already in place; without the Dashboard configuration documented here, the reset emails will fail to deep-link back into the app.

This setup must be applied to **every Supabase project** the app talks to — in v4.x that's `lexi-lens-staging` and `lexi-lens-prod`. They are configured independently and have independent allowlists; a redirect URL added on staging does **not** carry over to prod.

---

## 1. How the flow works (mental model)

The app uses Supabase's PKCE flow for password reset. End-to-end:

1. Parent taps **"Forgot password?"** on `AuthScreen` → app calls `supabase.auth.resetPasswordForEmail(email, { redirectTo: <scheme>://auth/reset })`.
2. Supabase emails the parent a link to `https://<project-ref>.supabase.co/auth/v1/verify?token=...&type=recovery&redirect_to=<scheme>://auth/reset`.
3. Parent taps the email link → Supabase validates the token, then 302-redirects to `<scheme>://auth/reset?code=<pkce-code>`.
4. The mobile OS resolves `<scheme>://` to the Lexi-Lens app and opens it. `App.tsx`'s `handleDeepLink` fires.
5. `handleDeepLink` detects the path matches `auth/reset` (or `type=recovery`), calls `getAuthFlow().beginRecovery()` to flip `recoveryActive = true`, then `supabase.auth.exchangeCodeForSession(code)` to mint a session.
6. Supabase's `onAuthStateChange` fires `PASSWORD_RECOVERY`, which `App.tsx` also routes to `beginRecovery()` (belt-and-braces — either path works).
7. `App.tsx`'s `showAuth = !session || recoveryActive` keeps the user on the auth navigator even though a session now exists.
8. `AuthScreen` sees `recoveryActive === true` and renders the **set new password** form. On successful `updateUser({ password })`, it calls `getAuthFlow().endRecovery()` → app proceeds into the game.

The Dashboard configuration in this runbook is what enables steps **2** and **3**:

- The redirect URL in step 3 must be in the project's allowlist, or Supabase will refuse the redirect and the user gets a Supabase-branded error page instead of the app opening.
- The email body in step 2 must contain `{{ .ConfirmationURL }}` or the parent has nothing to tap.

---

## 2. URL scheme per environment (critical)

The Expo app sets a different deep-link scheme per build profile (in `app.config.js`):

| Profile       | Scheme                      | Talks to Supabase project |
|---------------|-----------------------------|---------------------------|
| `development` | `lexilensdev://`            | staging                   |
| `staging`     | `lexilensstaging://`        | staging                   |
| `production`  | `lexilens://`               | prod                      |

**Implication for allowlists:** a Supabase project must allowlist *every* scheme that any build hitting it might use. So:

- **staging Supabase project** → allowlist `lexilensdev://*` and `lexilensstaging://*`. Skip `lexilens://*` (production builds hit prod, not staging).
- **prod Supabase project** → allowlist `lexilens://*`. Skip `lexilensdev://*` and `lexilensstaging://*` (those builds hit staging, not prod).

If you add a wrong-environment scheme to a project's allowlist it's not catastrophic — it just means a misconfigured build *could* succeed at completing reset against the wrong DB. Better to scope tightly.

---

## 3. Configuration steps (per project)

Repeat these for each Supabase project. Order doesn't matter; both must be done before that project's reset flow works.

### 3.1 Add redirect URLs to the allowlist

**Dashboard → Authentication → URL Configuration → Redirect URLs**

Add the entries from the table above for the project you're configuring. Example for the **prod** project:

```
lexilens://auth/confirm
lexilens://auth/reset
```

Example for the **staging** project:

```
lexilensdev://auth/confirm
lexilensdev://auth/reset
lexilensstaging://auth/confirm
lexilensstaging://auth/reset
```

Note the `auth/confirm` entries: those are for the email-confirmation flow on sign-up, not password reset. They share the allowlist mechanism, so add them in the same pass to avoid forgetting.

The **Site URL** field on the same page is unused by the mobile app (it's the legacy default for email-link redirection). Leave it at whatever Supabase prefilled — it doesn't affect mobile flows.

### 3.2 Configure the password-reset email template

**Dashboard → Authentication → Email Templates → Reset Password**

The default Supabase template works. The only mandatory element in the body is the `{{ .ConfirmationURL }}` placeholder. If you customise the template for branding, leave that placeholder intact.

A minimal Lexi-Lens-branded version:

```html
<h2>Reset your Lexi-Lens password</h2>

<p>Hi there,</p>

<p>You asked to reset your Lexi-Lens password. Tap the button below within the next hour to set a new one. If you didn't request this, you can ignore this email.</p>

<p><a href="{{ .ConfirmationURL }}">Reset password</a></p>

<p>If the button doesn't open the app, copy and paste this link into your browser:</p>

<p>{{ .ConfirmationURL }}</p>

<p>— The Lexi-Lens team</p>
```

Subject line: `Reset your Lexi-Lens password`

The default expiry is 1 hour. If a parent reports "the link doesn't work", the most common cause is they're tapping it more than an hour after request. Check **Authentication → Settings → Email link expiry** if you want to tune this — the current default is fine.

### 3.3 Verify auth settings

**Dashboard → Authentication → Settings**

- **Enable email confirmations** — should be ON. (Already set on staging; match on prod.)
- **Secure email change** — leave at default.
- **Email confirmation expiry** — leave at default unless there's a specific reason to change.

No other settings affect password reset.

---

## 4. Per-environment quick reference

### Staging Supabase project (`zhnaxafmacygbhpvtwvf`)

Redirect URLs allowlist:

```
lexilensdev://auth/confirm
lexilensdev://auth/reset
lexilensstaging://auth/confirm
lexilensstaging://auth/reset
```

Email template: minimal branded version above, or Supabase default.

### Production Supabase project (created in Phase 4.0)

Redirect URLs allowlist:

```
lexilens://auth/confirm
lexilens://auth/reset
```

Email template: production-quality branded version (use staging's as a starting point, polish copy for launch).

---

## 5. Test procedure (per project)

After configuration, verify the project end-to-end against a test build matching its scheme:

1. Build a profile that talks to this project (`eas build --profile development` for staging, `eas build --profile production` for prod — though for prod you'll typically test staging-clone first).
2. On the device, install the build and create a test account.
3. Sign out. On AuthScreen, tap **Forgot password?** and enter the test account's email.
4. Open the email on the device. Tap the reset link.
5. **Pass criteria:**
   - The Lexi-Lens app opens (not a browser, not Supabase's error page).
   - You land on AuthScreen's "Set new password" view.
   - You can enter a new password and successfully sign in afterwards.
6. **If the app doesn't open** — see Troubleshooting.

---

## 6. Troubleshooting

### Symptom: tapping the email link opens a browser showing "Error: redirect_to is not allowed"

The redirect URL is missing from the project's allowlist (Section 3.1). Add it, then ask the parent to request a fresh reset email — the old link's `redirect_to` is baked in and the new allowlist doesn't apply retroactively.

### Symptom: app opens but stays on the sign-in form (doesn't show the reset password view)

`recoveryActive` isn't being flipped. Two known causes:

- **Deep link not parsed correctly.** Add a console log in `App.tsx`'s `handleDeepLink` and check the URL — confirm `parsed.searchParams.get("type") === "recovery"` or the path includes `auth/reset`.
- **PKCE code exchange failed silently.** The `addGameBreadcrumb` call inside the `error` branch of `exchangeCodeForSession` should fire to Sentry — check there. Common cause: the code already got consumed (parent tapped the link twice).

### Symptom: parent reports "the link expired"

Default expiry is 1 hour. If they consistently can't get to email within the window, consider extending in Dashboard → Authentication → Settings, but don't go above 24h — increases the attack surface for compromised inboxes.

### Symptom: reset works on staging but not on prod (or vice versa)

The two projects' allowlists are independent. You probably configured one and forgot the other, or pointed the build at the wrong scheme. Re-verify Section 4 for the project that's failing.

### Symptom: email doesn't arrive at all

Not a redirect-URL or template issue. Check:

- **Dashboard → Authentication → Logs** for the project — failed sends show up here.
- **Email rate limit** (default 4/hour per address). If a parent has spammed the form, they'll be blocked.
- **Spam folder** on the parent's email. Supabase's default sender domain isn't always whitelisted by major providers.
- For prod, consider configuring a custom SMTP provider (Postmark, SendGrid) once email volume justifies it.

---

## 7. When to revisit this runbook

- **Changing URL schemes** in `app.config.js` → re-do Section 3.1 on every project that the new scheme talks to.
- **Adding a new Supabase project** (e.g. an EU region for GDPR-K isolation post-launch) → repeat all of Section 3 for the new project.
- **Switching email provider to SMTP** → most of this runbook still applies; the SMTP config is a separate Dashboard page (Authentication → SMTP Settings) and doesn't affect redirect URLs or templates.

---

## 8. References

- `lib/authFlow.ts` — Zustand store with `recoveryActive` flag and `beginRecovery` / `endRecovery` actions
- `screens/AuthScreen.tsx` — handles the "set new password" mode when `recoveryActive === true`
- `App.tsx` — deep link handler, PKCE code exchange, `PASSWORD_RECOVERY` event routing
- `docs/ENVIRONMENTS.md` — overall env split rationale and Step 7 covers the prod project's redirect URL setup at a high level
