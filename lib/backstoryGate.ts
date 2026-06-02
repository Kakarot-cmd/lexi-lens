/**
 * lib/backstoryGate.ts
 * Lexi-Lens — first-launch backstory gate (device-level AsyncStorage flag).
 *
 * Why this lives in its own module (v4.6)
 * ───────────────────────────────────────
 * These three helpers were previously defined at the bottom of
 * screens/OnboardingBackstoryScreen.tsx, which imports LumiMascot at module
 * top-level (→ Reanimated → react-native-svg). JS executes ALL of a module's
 * top-level imports the moment ANYTHING is imported from it — so App.tsx
 * importing `hasSeenBackstory`/`markBackstorySeen` from that screen silently
 * dragged the entire Lumi tree into the eager boot bundle, defeating the
 * lazy-isolation the boot path was designed around (the App.tsx comment
 * claimed the helpers were "safe to import eagerly … no Lumi imports" — that
 * was not true once they shared a module with the LumiMascot import).
 *
 * Extracting them here (no Lumi imports) makes that promise real: the screen
 * component stays lazy and Lumi-isolated, while the gate read/write stays
 * eager and cheap. Storage key is unchanged, so users who already saw the
 * story do NOT see it again.
 *
 * Behaviour is identical to the previous in-screen implementation.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_SEEN = 'lexilens.backstory.seen';

export async function hasSeenBackstory(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(KEY_SEEN);
    return v === '1';
  } catch {
    // Fail safe: if storage broken, don't trap the user in the story screen
    return true;
  }
}

export async function markBackstorySeen(): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_SEEN, '1');
  } catch {
    /* no-op */
  }
}

/**
 * Dev-only — reset the flag so the story shows again on next launch.
 * Wire to a ParentDashboard debug button if useful.
 */
export async function resetBackstorySeen(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY_SEEN);
  } catch {
    /* no-op */
  }
}
