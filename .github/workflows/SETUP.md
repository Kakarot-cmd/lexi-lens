# Lexi-Lens CI/CD — Setup Guide
> Complete this once. Takes ~15 minutes. Then `main` is protected forever.

---

## 1 · Get your EXPO_TOKEN

This is the only secret the CI pipeline needs.

1. Go to **[expo.dev/accounts/\<your-account\>/settings/access-tokens](https://expo.dev/accounts/)**
2. Click **Create token**
3. Name it `lexi-lens-ci` — Token type: **Personal access token**
4. Copy the token immediately (it won't be shown again)

---

## 2 · Add the secret to GitHub

1. In your repo go to **Settings → Secrets and variables → Actions**
2. Click **New repository secret**
3. Name: `EXPO_TOKEN`
4. Value: paste the token from step 1
5. Click **Add secret**

That's the only secret needed. The Supabase anon key is already in `eas.json`
(it's a public key by design — Supabase RLS protects the data, not the key).

---

## 3 · Enable branch protection on `main`

1. Go to **Settings → Branches → Add branch ruleset** (or classic: Branch protection rules)
2. Branch name pattern: `main`
3. Check these boxes:

```
✅  Require a pull request before merging
      ✅  Require approvals: 1  (can be 0 for solo dev — still enforces PR flow)
      ✅  Dismiss stale pull request approvals when new commits are pushed
✅  Require status checks to pass before merging
      ✅  Require branches to be up to date before merging
      → Search for and add:  "TypeScript · strict"
✅  Do not allow bypassing the above settings
```

4. Click **Create** / **Save changes**

> After this, `git push origin main` directly will be rejected. Every change
> must go through a PR. The `typecheck` job must pass before merge is allowed.

---

## 4 · Trigger your first production build

```bash
# Make sure you're on main and up to date
git checkout main && git pull

# Tag it (this is what triggers eas-build.yml)
git tag v1.0.0
git push origin v1.0.0
```

Then watch:
- **GitHub Actions** tab → `🚀 EAS Production Build` → should go green in ~2 min
- **[expo.dev](https://expo.dev)** → Builds → your Android AAB building (takes 15–25 min)
- EAS sends an email when the AAB is ready to download and upload to Play Console

---

## 5 · Local typecheck (run before every PR)

```bash
# Added to package.json in this commit
npm run typecheck

# Equivalent
npx tsc --noEmit
```

---

## 6 · Add the CI badge to your README

```markdown
![TypeCheck](https://github.com/Kakarot-cmd/lexi-lens/actions/workflows/typecheck.yml/badge.svg)
![EAS Build](https://github.com/Kakarot-cmd/lexi-lens/actions/workflows/eas-build.yml/badge.svg)
```

---

## 7 · Activate iOS build (when ready)

When you have your Apple Developer account enrolled and EAS Production plan:

1. Configure provisioning in EAS:
   ```bash
   eas credentials --platform ios
   ```
2. In `.github/workflows/eas-build.yml`, uncomment the `build-ios` job block
3. The `ios` profile is already stubbed in `eas.json` — fill in any
   additional iOS-specific settings (entitlements, bundle ID, etc.)
4. Push a new tag: `git tag v1.0.1 && git push origin v1.0.1`

Both Android AAB and iOS IPA will build in parallel on EAS cloud.

---

## Workflow summary

| Event | Workflow | Jobs |
|-------|----------|------|
| PR opened / updated | `typecheck.yml` | TS check + CVE scan |
| Push to `main` | `typecheck.yml` | TS check |
| Tag `v*.*.*` pushed | `eas-build.yml` | TS check → Android AAB (→ iOS IPA when activated) |

---

## Troubleshooting

**`tsc --noEmit` fails in CI but passes locally**
→ Likely a missing `@types/*` package or an import that works in Metro but
  not in strict TypeScript. Fix the type error — don't add `// @ts-ignore`.

**`EXPO_TOKEN` error: "Not logged in"**
→ The secret wasn't added, or the token expired. Re-generate at expo.dev
  and update the GitHub secret.

**EAS build fails immediately after submission**
→ Check the build log at expo.dev. Common causes: missing `eas.json`
  profile, wrong bundle identifier, or `autoIncrement` conflict.
  The GitHub CI job will still show green since it only submits — check
  expo.dev for the actual build status.
