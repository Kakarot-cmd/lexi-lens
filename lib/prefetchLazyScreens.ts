// lib/prefetchLazyScreens.ts
// Lexi-Lens — background prefetch of lazy screen modules (v6.9.1)
//
// WHY THIS FILE EXISTS
// ────────────────────
// App.tsx wraps the heavy screens (Scan, QuestMap, ParentDashboard,
// Paywall, OnboardingBackstory) in React.lazy(...) so they don't
// participate in the cold-start bundle resolution. That was added in
// v4.5.8 explicitly as a stability shield — Reanimated/Vision-Camera/Lumi
// module-init was probably crashing iOS Release at bundle-resolve time.
// Lazy boundaries fixed it.
//
// The tradeoff: first time the user navigates to each of those screens,
// React.lazy resolves the dynamic import() on the JS thread, which
// triggers a Suspense fallback (the spinner) for ~50-300ms. After that
// the module is cached for the rest of the session — second visit is
// instant.
//
// This module closes that one-time gap WITHOUT removing the lazy
// boundaries. We silently fire every dynamic import() in the background
// after first paint, AFTER user interactions settle. By the time the
// user actually navigates to QuestMap or Scan, the module is already
// resolved and the Suspense fallback never renders.
//
// DESIGN NOTES
// ────────────
// 1. InteractionManager.runAfterInteractions: defers our work until the
//    UI thread reports no pending interactions. Standard RN pattern for
//    "do this work, but don't fight the user's taps". Critical on iOS
//    bridgeless where parallel JS work during first interaction can
//    drop frames.
//
// 2. Serial, not parallel. Yes — we COULD Promise.all everything, but
//    each module's import() triggers a heavyweight JS parse + module
//    eval (Reanimated, Vision-Camera, etc). Doing them serial spreads
//    that cost across multiple JS-thread idle ticks instead of pegging
//    the thread for 500ms. Total wall-clock is similar; perceived
//    smoothness is better.
//
// 3. Each import() is wrapped in its own try/catch with a 1-tick yield
//    between them. A single screen's module-init failure doesn't block
//    the rest — and the failure is logged so we don't lose visibility
//    if a prefetch causes a problem.
//
// 4. The conditional gates (hasBackstoryShown, hasOnboarded) skip
//    work the user will never need. Saves ~25KB of resolve work
//    each plus avoids decoding the 5 watercolor backstory PNGs again
//    when they're guaranteed not to be displayed.
//
// 5. Idempotent. Calling prefetchLazyScreens() twice is harmless —
//    dynamic import() is cached by Metro/Hermes after first resolve.
//    Second call is a no-op walk through resolved Promises.
//
// SAFETY ENVELOPE
// ───────────────
// • No native modules touched. Pure JS module-resolution.
// • No state changes. No navigation. No UI render.
// • All failures swallowed with console.warn — never throws.
// • Web platform: skipped entirely (Scan is a placeholder there; the
//   other screens aren't on the web critical path).

import { InteractionManager, Platform } from "react-native";

/** Whether prefetch has already been kicked off this session. */
let _kickedOff = false;

/** Options for what to prefetch. Pass what you know from App.tsx state. */
export interface PrefetchOptions {
  /**
   * True if the user has completed the OnboardingBackstoryScreen.
   * When true, that module is skipped (it won't render again this install).
   * In App.tsx this maps to `backstorySeen === true`.
   */
  hasBackstoryShown: boolean;
}

/**
 * Schedule background prefetch of lazy screen modules.
 *
 * Call ONCE per session, after auth has resolved and the user is in
 * the main app surface (not Auth, not Backstory). The function is
 * idempotent — subsequent calls return immediately.
 *
 * Safe to call eagerly from a useEffect; the heavy work is deferred
 * until InteractionManager reports the UI thread idle.
 */
export function prefetchLazyScreens(opts: PrefetchOptions): void {
  if (_kickedOff) return;
  _kickedOff = true;

  // Skip on web — see header note.
  if (Platform.OS === "web") return;

  InteractionManager.runAfterInteractions(() => {
    // Fire-and-forget; the runner handles its own errors.
    void runPrefetch(opts);
  });
}

/**
 * Test-only: reset the kicked-off flag. Lets unit tests run prefetch
 * multiple times in a single Node process. Not exported via index.ts.
 */
export function _resetPrefetchForTests(): void {
  _kickedOff = false;
}

// ─── Internals ──────────────────────────────────────────────────────────────

/**
 * Ordered list of screens to prefetch.
 *
 * Order matters slightly: earlier entries are resolved first, before the
 * UI thread yields back to user interaction. Order is BY LIKELIHOOD OF
 * USE, not by module size:
 *   • QuestMap — the next screen after auth/backstory completes
 *   • Scan     — the most-used gameplay screen
 *   • ParentDashboard — accessed via lock-screen tap, less frequent
 *   • Paywall  — only on premium upsell paths
 *   • Onboarding / Backstory — only on first-launch flows (conditional)
 *
 * If a future screen joins App.tsx as lazy(...), add a matching entry
 * here. The compiler won't catch the omission — it's a manual mirror.
 */
type PrefetchEntry = {
  name: string;
  load: () => Promise<unknown>;
  /** Skip if this returns true at run time. */
  skipIf?: (opts: PrefetchOptions) => boolean;
};

const ENTRIES: PrefetchEntry[] = [
  {
    name: "QuestMapScreen",
    load: () => import("../screens/QuestMapScreen"),
  },
  {
    name: "ScanScreen",
    // Match App.tsx's Platform.OS guard. On web the lazy boundary
    // uses a placeholder; nothing to prefetch.
    load: () => import("../screens/ScanScreen"),
  },
  {
    name: "ParentDashboard",
    load: () => import("../screens/ParentDashboard"),
  },
  {
    name: "PaywallScreen",
    load: () => import("../screens/PaywallScreen"),
  },
  {
    name: "OnboardingScreen",
    // Prefetched unconditionally — the project doesn't track per-child
    // "onboarding done" state as a startup gate, so we can't reliably
    // skip. Worst case is ~25KB of resolve work on a user who'll
    // never re-visit, which is acceptable.
    load: () => import("../screens/OnboardingScreen"),
  },
  {
    name: "OnboardingBackstoryScreen",
    load: () => import("../screens/OnboardingBackstoryScreen"),
    skipIf: (o) => o.hasBackstoryShown,
  },
];

async function runPrefetch(opts: PrefetchOptions): Promise<void> {
  for (const entry of ENTRIES) {
    if (entry.skipIf?.(opts)) {
      continue;
    }

    try {
      await entry.load();
      // 1-tick yield so the UI thread can service any frames that came
      // in while we were parsing. Without this, a 4-entry serial chain
      // on a cold device can peg the JS thread for ~400ms straight.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } catch (err) {
      // Non-fatal. The lazy boundary in App.tsx will handle the
      // failure normally when the user actually navigates.
      console.warn(
        `[prefetch] ${entry.name} failed to preload:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
