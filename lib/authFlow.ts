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
}

export const useAuthFlow = create<AuthFlowState>((set) => ({
  recoveryActive: false,
  beginRecovery: () => set({ recoveryActive: true }),
  clearRecovery: () => set({ recoveryActive: false }),

  deletionScheduledAt: null,
  beginDeletionGate: (scheduledAt: string) => set({ deletionScheduledAt: scheduledAt }),
  clearDeletionGate: () => set({ deletionScheduledAt: null }),
}));

/**
 * Imperative read used by App.tsx in non-component contexts (auth listener
 * callback). Component code should use the hook above.
 */
export function getAuthFlow() {
  return useAuthFlow.getState();
}
