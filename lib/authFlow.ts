/**
 * lib/authFlow.ts
 * Lexi-Lens — auth-flow state shared between App.tsx and AuthScreen.
 *
 * Why this exists
 * ───────────────
 * Two post-auth flows need to keep the user on AuthScreen even though a
 * valid Supabase session already exists. App.tsx routes on session alone,
 * so without a shared override flag both flows get bulldozed straight into
 * the game the instant the session lands.
 *
 *   A. Password recovery (recoveryActive)
 *      The reset-link click does this:
 *        1. App opens via deep link (lexilens://auth/reset?code=…)
 *        2. App.tsx calls supabase.auth.exchangeCodeForSession(code)
 *        3. A real session is created — Supabase fires onAuthStateChange
 *           with event "PASSWORD_RECOVERY", session.user is the parent.
 *        4. Naive logic renders <AppNavigator/> because session is non-null.
 *           But we don't WANT the game yet — the parent must set a new
 *           password first.
 *      Fix: on PASSWORD_RECOVERY, set recoveryActive = true. App.tsx keeps
 *      <AuthNavigator/> mounted while it's true; AuthScreen switches into
 *      "set new password" mode. Cleared after updateUser({ password }).
 *
 *   B. Pending-deletion gate (deletionScheduledAt)  [v4.6 fix]
 *      A parent who requested account deletion has a 30-day grace window
 *      (app_metadata.deletion_scheduled_at). The whole point of that window
 *      is to give them an obvious, EARLY chance to undo it. The deletion
 *      banner therefore belongs at sign-in, before they enter the app.
 *
 *      Previously AuthScreen tried to show that banner from local state set
 *      inside performSignIn() — but signInWithPassword() establishes the
 *      session, App.tsx sees a non-null session and swaps to <AppNavigator/>,
 *      unmounting AuthScreen before the banner could ever render. The banner
 *      was dead code; the only working recovery path was buried in
 *      ParentDashboard.
 *
 *      Fix: detection moves to App.tsx's auth listener (same place as
 *      PASSWORD_RECOVERY). When a session is established WITH a
 *      deletion_scheduled_at stamp, App.tsx calls beginDeletionGate(at) in
 *      the SAME callback as setSession — so the very first render that sees
 *      the session also sees the gate flag, and AuthScreen stays mounted.
 *      The session stays alive throughout, so handleRestoreAccount can still
 *      invoke the authenticated cancel-deletion function. clearDeletionGate()
 *      runs on successful restore (→ routes to app) or on sign-out.
 *
 * Implementation: zustand because it's already in the project (gameStore).
 * No new dependency.
 */

import { create } from 'zustand';

interface AuthFlowState {
  /** True while we're in the post-deep-link "set new password" flow. */
  recoveryActive: boolean;

  /** Called by App.tsx when PASSWORD_RECOVERY auth event fires. */
  beginRecovery: () => void;

  /** Called by AuthScreen after successful updateUser({ password }). */
  clearRecovery: () => void;

  /**
   * ISO timestamp of a scheduled account deletion, or null. When non-null,
   * App.tsx keeps AuthScreen mounted (even with a live session) so the
   * deletion-recovery banner can render. Set by App.tsx's auth listener.
   */
  deletionScheduledAt: string | null;

  /** Called by App.tsx when a session is established with a deletion stamp. */
  beginDeletionGate: (scheduledAt: string) => void;

  /** Called by AuthScreen on successful restore, or on sign-out. */
  clearDeletionGate: () => void;

  /**
   * C. Consent gate (social-login COPPA net)  [social-auth fix]
   * ──────────────────────────────────────────────────────────
   * Email/password sign-up runs the ConsentGateModal BEFORE an account exists,
   * so every email account carries consent metadata. Social sign-in
   * (Google / Apple) is different: signInWithIdToken creates-or-signs-in and
   * lands a live session in one step, with NO chance to gate beforehand.
   *
   * App.tsx therefore inspects every established session: if it lacks the
   * `consent_consented_at` user-metadata stamp (and isn't mid-deletion), it
   * raises this gate. App.tsx keeps AuthScreen mounted while consentPending is
   * true (same mechanism as recovery / deletion), AuthScreen forces the
   * ConsentGateModal, and only after consent is recorded does it clear.
   *
   * This also retroactively brings any consent-less legacy account into
   * compliance the next time it signs in — the COPPA-correct posture.
   */
  consentPending: boolean;

  /** Called by App.tsx when a session has no consent metadata. */
  beginConsentGate: () => void;

  /** Called by AuthScreen after consent is recorded, or on sign-out. */
  clearConsentGate: () => void;

  /**
   * Provider display name captured during social sign-in (Google always; Apple
   * only on first authorization). Consumed once by AuthScreen.performOAuthConsent
   * to stamp the parent's display_name, then cleared with the gate.
   */
  pendingDisplayName: string | null;
  setPendingDisplayName: (name: string) => void;
}

export const useAuthFlow = create<AuthFlowState>((set) => ({
  recoveryActive: false,
  beginRecovery: () => set({ recoveryActive: true }),
  clearRecovery: () => set({ recoveryActive: false }),

  deletionScheduledAt: null,
  beginDeletionGate: (scheduledAt: string) => set({ deletionScheduledAt: scheduledAt }),
  clearDeletionGate: () => set({ deletionScheduledAt: null }),

  consentPending: false,
  beginConsentGate: () => set({ consentPending: true }),
  clearConsentGate: () => set({ consentPending: false, pendingDisplayName: null }),

  pendingDisplayName: null,
  setPendingDisplayName: (name: string) => set({ pendingDisplayName: name }),
}));

/**
 * Imperative read used by App.tsx in non-component contexts (auth listener
 * callback). Component code should use the hook above.
 */
export function getAuthFlow() {
  return useAuthFlow.getState();
}
