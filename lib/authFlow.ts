/**
 * lib/authFlow.ts
 * Lexi-Lens — auth-flow state shared between App.tsx and AuthScreen.
 *
 * Why this exists
 * ───────────────
 * The Supabase password-recovery flow is awkward in any app that has
 * post-auth navigation. The reset-link click does this:
 *
 *   1. App opens via deep link (lexilens://auth/reset?code=…)
 *   2. App.tsx calls supabase.auth.exchangeCodeForSession(code)
 *   3. A real session is created — Supabase fires onAuthStateChange
 *      with event "PASSWORD_RECOVERY", session.user is the parent.
 *   4. Our existing logic would render <AppNavigator/> because session
 *      is non-null. But we don't WANT to navigate to the game yet —
 *      the parent still needs to set a new password.
 *
 * Fix: when we see PASSWORD_RECOVERY, set `recoveryActive = true` here.
 * App.tsx renders <AuthNavigator/> while `recoveryActive` is true, and
 * AuthScreen reads the same flag to switch into "set new password" mode.
 * Once the new password is saved, AuthScreen calls clearRecovery() and
 * the normal session-routes-to-AppNavigator behaviour resumes.
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
}

export const useAuthFlow = create<AuthFlowState>((set) => ({
  recoveryActive: false,
  beginRecovery: () => set({ recoveryActive: true }),
  clearRecovery: () => set({ recoveryActive: false }),
}));

/**
 * Imperative read used by App.tsx in non-component contexts (auth listener
 * callback). Component code should use the hook above.
 */
export function getAuthFlow() {
  return useAuthFlow.getState();
}
