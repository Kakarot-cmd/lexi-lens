// ─── Sentry: must be first import + call before anything else ─────────────────

import {
  initSentry,
  Sentry,
  setUserContext,
  clearUserContext,
  addGameBreadcrumb,
} from "./lib/sentry";

initSentry();

// ─── Env (also fires startup config validation) ──────────────────────────────

import { ENV, assertEnvOrWarn } from "./lib/env";

assertEnvOrWarn();

// ─── React + RN ───────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback, useRef, lazy, Suspense } from "react";
import { View, Text, ActivityIndicator, Platform, Linking, AppState } from "react-native";

// ─── Navigation ───────────────────────────────────────────────────────────────

import {
  NavigationContainer,
  useNavigationContainerRef,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";

// ─── Safe area ────────────────────────────────────────────────────────────────

import { SafeAreaProvider } from "react-native-safe-area-context";

// ─── Supabase ─────────────────────────────────────────────────────────────────

import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";

// ─── Auth flow store (v4.5: password recovery coordination) ─────────────────

import { useAuthFlow, getAuthFlow } from "./lib/authFlow";

// ─── Navigation param lists ───────────────────────────────────────────────────

import type { RootStackParamList, AuthStackParamList } from "./types/navigation";

// ─── Backstory gate helpers (v6.6) ────────────────────────────────────────────
//
// v4.6 — gate helpers now come from lib/backstoryGate (Lumi-free), so this
// eager import no longer drags the LumiMascot → Reanimated → SVG tree into
// the boot bundle. The <OnboardingBackstoryScreen/> component itself stays
// lazy-loaded below, preserving the iOS-safe boot path from v4.5.8.
import {
  hasSeenBackstory,
  markBackstorySeen,
} from "./lib/backstoryGate";

// ─── Screens ──────────────────────────────────────────────────────────────────
//
// v4.5.8 (May 14, 2026) — iOS white-screen mitigation.
//
// Screens that transitively import from `../components/Lumi` are LAZY-LOADED.
// That module pulls in `react-native-reanimated`, `expo-audio` (via lumiSounds),
// and react-native-svg at module-init time. On iOS bridgeless + new arch
// (RN 0.81, Hermes Release), at least one of those throws synchronously during
// the JS bundle's module-resolution pass — Hermes catches it, no React tree
// ever mounts, and you get a permanent white screen with no .ips crash and no
// JS error handler to surface anything.
//
// v1.0.11 (the last working iOS build) had ZERO Lumi imports anywhere. The
// regression range fe163d8..6b5e744 added the entire Lumi module + threaded
// `import { LumiHUD } from '../components/Lumi'` into four screens, plus a
// top-level `import { initLumiSounds } from './components/Lumi/lumiSounds'`
// in this file. Android is unaffected because expo-audio's Android backend
// is older + simpler.
//
// Strategy: defer all Lumi-transiting screens behind React.lazy. The Lumi
// module + expo-audio only initialize when the user actually navigates to
// one of these screens. AuthScreen renders first (eager, no Lumi) so the
// app boots to login regardless of any Lumi crash. The crash, if it happens,
// is now scoped to a single tab — caught by that screen's <ErrorBoundary>.
//
// Side benefits regardless of the iOS fix:
//   • Faster cold start — less JS to parse before first paint.
//   • Crash isolation — each screen's import tree is independent.
//   • Diagnostic ergonomics — if a future regression breaks one screen,
//     the rest of the app keeps working.
//
// Eagerly-imported screens (no Lumi in their import tree, proven safe in
// v1.0.11): AuthScreen, ChildSwitcherScreen, SpellBookScreen,
// QuestGeneratorScreen.

import { AuthScreen }          from "./screens/AuthScreen";
import { ChildSwitcherScreen } from "./screens/ChildSwitcherScreen";
import SpellBookScreen         from "./screens/SpellBookScreen";
import QuestGeneratorScreen    from "./screens/QuestGeneratorScreen";

// Lazy-loaded screens (import from ../components/Lumi). Each .then maps the
// named export to .default so React.lazy gets the expected shape.
const QuestMapScreen   = lazy(() =>
  import("./screens/QuestMapScreen").then((m) => ({ default: m.QuestMapScreen })),
);
const ParentDashboard  = lazy(() =>
  import("./screens/ParentDashboard").then((m) => ({ default: m.ParentDashboard })),
);
const OnboardingScreen = lazy(() =>
  import("./screens/OnboardingScreen").then((m) => ({ default: m.OnboardingScreen })),
);

// v6.6 — Backstory screen. Same lazy pattern: it transitively imports
// LumiMascot (Reanimated + SVG), so we defer its module-init until the
// first time the gate decides to show it. The gate read itself (the
// `hasSeenBackstory()` call above) is a tiny AsyncStorage check — no
// Lumi imports — so eager.
const OnboardingBackstoryScreen = lazy(() =>
  import("./screens/OnboardingBackstoryScreen").then((m) => ({
    default: m.OnboardingBackstoryScreen,
  })),
);

// Phase 4.4 — PaywallScreen is lazy-loaded for the same reason as the rest:
// keeps cold-start lean and isolates any react-native-purchases module-init
// crash to the moment the paywall is actually opened. The wrapper revenueCat.ts
// is already lazy at the SDK level — this just defers the SCREEN module too.
const PaywallScreen = lazy(() => import("./screens/PaywallScreen"));

// ─── Components ───────────────────────────────────────────────────────────────

import { ErrorBoundary }           from "./components/ErrorBoundary";
import { AchievementToastOverlay } from "./components/AchievementToast";

// ─── Store ────────────────────────────────────────────────────────────────────

import { useGameStore } from "./store/gameStore";

// ─── Analytics ────────────────────────────────────────────────────────────────

import { useAnalytics } from "./hooks/useAnalytics";

// ─── Lazy-screen prefetch (v6.9.1) ────────────────────────────────────────────
//
// The lazy(...) declarations above shield cold-start from
// Reanimated/VisionCamera/Lumi module-init crashes (see v4.5.8 history),
// but the tradeoff is a one-time Suspense fallback flash the first time
// the user navigates to each lazy screen in a session. We close that
// gap by silently warming every lazy module in the background after
// first paint and after the auth state settles. Implementation is
// guarded with InteractionManager + per-module try/catch so a prefetch
// failure cannot affect the rest of the app.
import { prefetchLazyScreens } from "./lib/prefetchLazyScreens";

// ─── Global font-scale cap (issue #3a) ───────────────────────────────────────
// Large system font settings can grow text past the point where fixed-height
// chrome (buttons, badges, card headers) clips it. Cap text growth at 1.4×
// app-wide — generous enough to honor accessibility, tight enough to protect
// layout. Mirrors MAX_FONT_SCALE_CHROME in utils/responsive.ts. Visual-only;
// does not affect any logic.
import { Text as _CapText, TextInput as _CapInput } from "react-native";
(_CapText as any).defaultProps = (_CapText as any).defaultProps || {};
(_CapText as any).defaultProps.maxFontSizeMultiplier = 1.4;
(_CapInput as any).defaultProps = (_CapInput as any).defaultProps || {};
(_CapInput as any).defaultProps.maxFontSizeMultiplier = 1.4;

// ─── Lumi mascot (lazy) ──────────────────────────────────────────────────────
//
// v4.5.8 — Lumi imports are deferred. They previously loaded at module-init
// time and (probably) crashed iOS Release builds during bundle resolution.
// Now they load inside useEffect, AFTER the React tree mounts and AFTER
// `useEffect` runs (i.e. AFTER first paint). Any failure becomes catchable
// via try/catch, not a silent module-init crash.

// ─── Web placeholder for Scan ─────────────────────────────────────────────────

function ScanPlaceholder() {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
      <Text style={{ fontSize: 18, color: "#7c3aed", textAlign: "center" }}>
        Camera scanning is only available on iOS and Android. Try Skanlore on a phone or tablet.
      </Text>
    </View>
  );
}

// v4.5.8 — ScanScreen is also lazy-loaded. It imports from ../components/Lumi
// (LumiHUD) and is the heaviest screen in the tree (react-native-vision-camera,
// useObjectScanner, useLexiEvaluate, VictoryFusionScreen, etc). Deferring it
// until the user navigates to Scan keeps cold-start lean and isolates any
// Lumi/vision-camera crash to that single screen.
//
// The Platform.OS === "web" branch keeps the existing placeholder behaviour
// — we just wrap it as a Promise so React.lazy's contract is satisfied on
// both branches.
const ScanScreen = Platform.OS === "web"
  ? lazy(() => Promise.resolve({ default: ScanPlaceholder }))
  : lazy(() =>
      import("./screens/ScanScreen").then((m) => ({ default: m.ScanScreen })),
    );

// ─── Navigators ───────────────────────────────────────────────────────────────

const AuthNav = createNativeStackNavigator<AuthStackParamList>();
const AppNav  = createNativeStackNavigator<RootStackParamList>();

function AuthNavigator() {
  return (
    <AuthNav.Navigator screenOptions={{ headerShown: false }}>
      <AuthNav.Screen name="Auth">
        {() => (
          <ErrorBoundary screen="AuthScreen">
            <AuthScreen />
          </ErrorBoundary>
        )}
      </AuthNav.Screen>
    </AuthNav.Navigator>
  );
}

function AppNavigator({
  onBackstoryComplete,
  backstoryChildName,
}: {
  onBackstoryComplete: () => void | Promise<void>;
  backstoryChildName:  string | null;
}) {
  // v4.5.8 — Shared fallback used by every <Suspense> boundary around a
  // lazy-loaded screen. Minimal, brand-aligned, never visible for more than
  // a few frames in practice (the screen module resolves on the next tick).
  // Kept inside AppNavigator so it has no module-init impact.
  const LazyScreenFallback = () => (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0f0620" }}>
      <ActivityIndicator size="large" color="#a78bfa" />
    </View>
  );

  return (
    <AppNav.Navigator screenOptions={{ headerShown: false }}>
      <AppNav.Screen name="ChildSwitcher">
        {(props) => (
          <ErrorBoundary screen="ChildSwitcherScreen">
            <ChildSwitcherScreen {...props} />
          </ErrorBoundary>
        )}
      </AppNav.Screen>

      <AppNav.Screen name="QuestMap">
        {(props) => (
          <ErrorBoundary screen="QuestMapScreen">
            <Suspense fallback={<LazyScreenFallback />}>
              <QuestMapScreen {...props} />
            </Suspense>
          </ErrorBoundary>
        )}
      </AppNav.Screen>

      <AppNav.Screen name="Scan">
        {(props) => (
          <ErrorBoundary screen="ScanScreen">
            <Suspense fallback={<LazyScreenFallback />}>
              <ScanScreen {...props} />
            </Suspense>
          </ErrorBoundary>
        )}
      </AppNav.Screen>

      <AppNav.Screen name="ParentDashboard">
        {(props) => (
          <ErrorBoundary screen="ParentDashboard">
            <Suspense fallback={<LazyScreenFallback />}>
              <ParentDashboard {...props} />
            </Suspense>
          </ErrorBoundary>
        )}
      </AppNav.Screen>

      <AppNav.Screen name="SpellBook">
        {(props) => (
          <ErrorBoundary screen="SpellBookScreen">
            <SpellBookScreen {...props} />
          </ErrorBoundary>
        )}
      </AppNav.Screen>

      <AppNav.Screen name="QuestGenerator">
        {({ navigation }) => (
          <ErrorBoundary screen="QuestGeneratorScreen">
            <QuestGeneratorScreen
              visible={true}
              onClose={() => navigation.goBack()}
            />
          </ErrorBoundary>
        )}
      </AppNav.Screen>

      <AppNav.Screen name="Onboarding">
        {(props) => (
          <ErrorBoundary screen="OnboardingScreen">
            <Suspense fallback={<LazyScreenFallback />}>
              <OnboardingScreen {...props} />
            </Suspense>
          </ErrorBoundary>
        )}
      </AppNav.Screen>

      {/* v4.6 — Backstory is now a stack screen reached AFTER first child
          selection (was a device-first-launch standalone branch). Moving it
          here means activeChild is set by the time it renders, so panel 3's
          personalised greeting ("And you must be {name}.") actually fires —
          previously it was always null at backstory time and silently fell
          back to generic copy. On complete it persists the flag (via
          onBackstoryComplete, which also flips App-state backstorySeen so the
          daily-greeting gate releases) then replaces itself with Onboarding
          (first run) or QuestMap. */}
      <AppNav.Screen name="OnboardingBackstory">
        {({ navigation }) => (
          <ErrorBoundary screen="OnboardingBackstoryScreen">
            <Suspense fallback={<LazyScreenFallback />}>
              <OnboardingBackstoryScreen
                childName={backstoryChildName}
                onComplete={async () => {
                  await onBackstoryComplete();
                  const seenOnboarding =
                    useGameStore.getState().hasSeenOnboarding;
                  navigation.replace(seenOnboarding ? "QuestMap" : "Onboarding");
                }}
              />
            </Suspense>
          </ErrorBoundary>
        )}
      </AppNav.Screen>

      {/* Phase 4.4 — Paywall presented as modal so the underlying QuestMap /
          ParentDashboard / RateLimitWall remains in the back stack on dismiss. */}
      <AppNav.Screen
        name="Paywall"
        options={{ presentation: "modal", animation: "slide_from_bottom" }}
      >
        {(props) => (
          <ErrorBoundary screen="PaywallScreen">
            <Suspense fallback={<LazyScreenFallback />}>
              <PaywallScreen {...props} />
            </Suspense>
          </ErrorBoundary>
        )}
      </AppNav.Screen>
    </AppNav.Navigator>
  );
}

// ─── Root component ───────────────────────────────────────────────────────────

function App() {
  const [session, setSession]           = useState<Session | null>(null);
  const [initialising, setInitialising] = useState(true);
  const activeChild                     = useGameStore((s) => s.activeChild);

  // v4.5 — password recovery state. Starts false, flipped true by deep link
  // or PASSWORD_RECOVERY auth event, cleared by AuthScreen after updateUser.
  const recoveryActive = useAuthFlow((s) => s.recoveryActive);

  // v4.6 — pending-deletion gate. Non-null ISO timestamp when the signed-in
  // parent has a scheduled account deletion. Keeps AuthScreen mounted (with a
  // live session) so the deletion-recovery banner can render at sign-in. See
  // lib/authFlow.ts for the full rationale.
  const deletionScheduledAt = useAuthFlow((s) => s.deletionScheduledAt);

  // social-auth — consent gate. True when a live session has no COPPA consent
  // metadata (a brand-new Google/Apple sign-in, or a legacy consent-less
  // account). Keeps AuthScreen mounted so the ConsentGateModal can run before
  // any child-facing screen renders. See lib/authFlow.ts.
  const consentPending = useAuthFlow((s) => s.consentPending);

  // ── Backstory gate (v6.6) ─────────────────────────────────────────────────
  //
  // null   = AsyncStorage read in flight (don't decide yet)
  // true   = already seen → skip the story, go straight to the app
  // false  = first launch → render <OnboardingBackstoryScreen/> before AppNavigator
  //
  // The read fires once at mount. It's intentionally NOT gated on session,
  // because the flag is per-device (an AsyncStorage key), not per-user — a
  // returning user signing in on a fresh install should still see the story
  // once on that device. While the read is in flight we render the same
  // splash as during auth init, so there's no extra loading flicker.
  const [backstorySeen, setBackstorySeen] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    hasSeenBackstory()
      .then((seen) => { if (!cancelled) setBackstorySeen(seen); })
      .catch(() => { if (!cancelled) setBackstorySeen(true); /* fail-safe: skip */ });
    return () => { cancelled = true; };
  }, []);

  const onBackstoryComplete = useCallback(async () => {
    try {
      await markBackstorySeen();
    } catch {
      // Even if persist fails, advance — we don't want the user trapped here.
    }
    setBackstorySeen(true);
    addGameBreadcrumb({
      category: "onboarding",
      message:  "Backstory completed (or skipped)",
    });
  }, []);

  const navigationRef = useNavigationContainerRef();
  const audioReadyRef = useRef(false);

  // ── Lumi sound bootstrap (once at app start) ──────────────────────────────
  // v4.5.8 — dynamic import so a module-init failure in expo-audio or the
  // Lumi tree cannot crash the JS bundle. Any error is logged + swallowed;
  // the app boots regardless of sound init success.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const lumiSounds = await import("./components/Lumi/lumiSounds");
        if (cancelled) return;
        await lumiSounds.initLumiSounds();

        // Game-wide audio (music bed + UI/feedback SFX). Same dynamic-import
        // safety as Lumi — a module-init failure here cannot crash the bundle.
        const gameAudio = await import("./lib/audio");
        if (cancelled) return;
        await gameAudio.initGameAudio();
        // Engine ready (assets localized). Start the bed for whatever screen is
        // already showing: onReady may have fired before init finished, in which
        // case the nav handler deliberately skipped audio (see below). This is
        // the other half — whichever of {nav-ready, init-done} lands last starts
        // the initial bed, exactly once.
        if (cancelled) return;
        audioReadyRef.current = true;
        const current = navigationRef.isReady() ? navigationRef.getCurrentRoute() : null;
        if (current) gameAudio.onScreenChange(current.name);
      } catch (err) {
        // Sound init failures are non-fatal — kids still get the game.
        console.warn("[Lumi] sound init skipped:", err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Auth listener ──────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    supabase.auth.getSession()
      .then(({ data: { session: s } }) => {
        if (cancelled) return;
        setSession(s);
        // v4.6 — cold-start path: a persisted session may belong to an account
        // that's mid-deletion. Gate in the same tick as setSession so the first
        // render that sees the session also sees the gate.
        const at = s?.user?.app_metadata?.deletion_scheduled_at;
        if (at) getAuthFlow().beginDeletionGate(at);
        else    getAuthFlow().clearDeletionGate();
        // social-auth — raise the consent gate for a live session that carries
        // no COPPA consent stamp (new Google/Apple user). Deletion takes
        // precedence; those accounts always have consent already.
        const consented = !!s?.user?.user_metadata?.consent_consented_at;
        if (s && !at && !consented) getAuthFlow().beginConsentGate();
        else                        getAuthFlow().clearConsentGate();
        setInitialising(false);
      })
      .catch(() => {
        if (cancelled) return;
        setInitialising(false);
      });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, s) => {
        setSession(s);

        // v4.5 — if Supabase tells us this session was reached via the
        // password recovery flow, flip authFlow into recovery mode so the
        // app stays on AuthScreen until the new password is saved.
        if (event === "PASSWORD_RECOVERY") {
          getAuthFlow().beginRecovery();
          addGameBreadcrumb({
            category: "auth",
            message:  "PASSWORD_RECOVERY event — entering reset_confirm mode",
          });
        }

        if (!s) {
          clearUserContext();
          getAuthFlow().clearDeletionGate();
          getAuthFlow().clearConsentGate();
          addGameBreadcrumb({ category: "auth", message: "User signed out" });
        } else {
          // v4.6 — warm path (e.g. sign-in, token refresh). If this account is
          // scheduled for deletion, raise the gate in the same callback as the
          // session update so AuthScreen stays mounted to show the banner.
          const at = s.user?.app_metadata?.deletion_scheduled_at;
          if (at) getAuthFlow().beginDeletionGate(at);
          // social-auth — same consent net on the warm path (sign-in, token
          // refresh, USER_UPDATED). A new Google/Apple session has no consent
          // stamp → gate; the AuthScreen consent step stamps it and clears.
          const consented = !!s.user?.user_metadata?.consent_consented_at;
          if (!at && !consented) getAuthFlow().beginConsentGate();
          else if (!at)          getAuthFlow().clearConsentGate();
          addGameBreadcrumb({
            category: "auth",
            message:  "Session established",
            data:     { userId: s.user.id, event },
          });
        }
      },
    );

    // ── Deep-link handler ────────────────────────────────────────────────────
    const handleDeepLink = async ({ url }: { url: string | null }) => {
      if (!url) return;
      try {
        const parsed = new URL(url);

        // v4.5 — recognise the password-reset path BEFORE token exchange so
        // AuthScreen can route to reset_confirm even if the auth event lags.
        const isResetPath =
          url.includes("auth/reset") ||
          parsed.searchParams.get("type") === "recovery";

        if (isResetPath) {
          getAuthFlow().beginRecovery();
        }

        // PKCE code exchange — Supabase JS v2 default
        const code = parsed.searchParams.get("code");
        if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) {
            addGameBreadcrumb({
              category: "auth",
              message:  "Code exchange failed",
              data:     { error: error.message, isResetPath },
            });
          }
          return;
        }

        // Legacy implicit-flow fragment: #access_token=…&refresh_token=…
        const fragment = parsed.hash.replace(/^#/, "");
        if (fragment) {
          const params = new URLSearchParams(fragment);
          const access_token  = params.get("access_token");
          const refresh_token = params.get("refresh_token");
          const type          = params.get("type");
          if (access_token && refresh_token) {
            await supabase.auth.setSession({ access_token, refresh_token });
          }
          if (type === "recovery") {
            getAuthFlow().beginRecovery();
          }
        }
      } catch {
        // Malformed / unrelated URL — ignore
      }
    };

    Linking.getInitialURL().then((url) => handleDeepLink({ url }));
    const linkingSub = Linking.addEventListener("url", handleDeepLink);

    return () => {
      cancelled = true;
      subscription.unsubscribe();
      linkingSub.remove();
    };
  }, []);

  // ── Sentry user context — sync whenever active child changes ──────────────
  useEffect(() => {
    if (activeChild && session?.user) {
      setUserContext({
        childId: activeChild.id,
        parentId: session.user.id,
        childAge: parseInt(activeChild.age_band?.split("-")[1] ?? "8", 10),
      });
      addGameBreadcrumb({
        category: "auth",
        message: "Active child set",
        data: { childId: activeChild.id },
      });
    }
  }, [activeChild?.id, session?.user?.id]);

  // ── Lumi daily greeting ────────────────────────────────────────────────────
  // v4.5.8 — dynamic imports; same rationale as the sound bootstrap above.
  //
  // v6.8 — also gates on `backstorySeen === true`. Two reasons:
  //   1. During the first-launch backstory, panels 1+2 are narrated by a
  //      third-person Narrator and panels 3-5 by Lumi herself. Firing the
  //      "Good morning, my magic is full again ✨" greeting on top of that
  //      audio is a collision.
  //   2. We also defer `markGreetedToday()` to *after* the greeting actually
  //      plays. The old code marked-then-played, which meant a user who
  //      closed the app mid-backstory on day 1 would never hear their
  //      first daily greeting at all — the flag would say "already greeted
  //      today" on relaunch even though no audio had fired.
  useEffect(() => {
    if (!session || !activeChild?.id) return;
    if (backstorySeen !== true) return; // skip during/before backstory
    let cancelled = false;
    (async () => {
      try {
        const [greeting, sounds] = await Promise.all([
          import("./components/Lumi/lumiGreeting"),
          import("./components/Lumi/lumiSounds"),
        ]);
        if (cancelled) return;
        const greet = await greeting.shouldGreetToday();
        if (cancelled || !greet) return;
        sounds.playLumiGreeting();
        await greeting.markGreetedToday();
      } catch {
        // Non-fatal
      }
    })();
    return () => { cancelled = true; };
  }, [session?.user?.id, activeChild?.id, backstorySeen]);

  // ── Lazy-screen prefetch (v6.9.1) ─────────────────────────────────────────
  //
  // Eliminates the one-time Suspense fallback flash on first navigation
  // to each lazy screen in a session. Conditions for kicking off:
  //   • Auth has resolved (session set, not initialising)
  //   • Backstory state is determined (not null — gate has completed read)
  //   • Not currently mid-recovery (user hasn't reset their password yet)
  //   • Not on the standalone backstory branch (where we don't want to
  //     compete with the backstory screen's own module-init)
  //
  // The prefetcher itself is internally idempotent — the !_kickedOff guard
  // inside it means a re-fire from any state churn (e.g. activeChild
  // switch) is harmless. We still gate here so we don't fire BEFORE the
  // user is in the main app surface, which would waste resolves if the
  // session turns out invalid.
  useEffect(() => {
    if (initialising)                  return;
    if (backstorySeen === null)        return;
    if (!session)                      return;
    if (recoveryActive)                return;
    if (backstorySeen === false)       return; // wait until backstory done
    prefetchLazyScreens({
      hasBackstoryShown: backstorySeen === true,
    });
  }, [initialising, backstorySeen, session, recoveryActive]);

  // ── RevenueCat lifecycle ───────────────────────────────────────────────────
  //
  // Phase 4.4. Wires the RC SDK to the Supabase auth session:
  //   • session established → initRevenueCat({ appUserId: parentId })
  //   • signed out         → clearParent()  (anonymise the local RC instance)
  //   • customer-info update (renewal, refund, expiration, sandbox event)
  //     → setSubscriptionFromRC() pushes details into the gameStore
  //   • AppState → 'active' → getCustomerInfo() to refresh, in case the
  //     webhook fired while the app was backgrounded.
  //
  // All RC calls are no-ops in __DEV__ (see lib/revenueCat.ts) — Metro's
  // log handler collides with RC's emitter setup. Test purchases in EAS
  // preview/staging builds, never in the dev client.
  //
  // Important: this hook DOES NOT block render. RC failures degrade
  // gracefully to "paywall hidden" — the rest of the game continues to work
  // and the server-side gate (parents.subscription_tier, written by the
  // webhook) remains the authoritative tier source.
  useEffect(() => {
    let cancelled = false;
    let unsubscribeRcListener: (() => void) | null = null;
    let appStateSub: { remove: () => void } | null = null;

    (async () => {
      try {
        const rc = await import("./lib/revenueCat");
        if (cancelled) return;

        if (!session?.user) {
          // Signed out — clear identity so the next sign-in starts fresh.
          await rc.clearParent();
          return;
        }

        const initialised = await rc.initRevenueCat({ appUserId: session.user.id });
        if (cancelled || !initialised) return;

        // Live updates: renewals, refunds, expirations, RC-pushed events.
        unsubscribeRcListener = rc.addCustomerInfoListener((info) => {
          const details = rc.deriveSubscriptionDetails(info);
          useGameStore.getState().setSubscriptionFromRC(details);
        });

        // One-shot initial fetch so the store has accurate state immediately
        // (the listener only fires on subsequent updates).
        const snapshot = await rc.getCustomerInfo();
        if (cancelled) return;
        if (snapshot) {
          useGameStore.getState().setSubscriptionFromRC(snapshot.details);
        }

        // Foreground refresh — webhook may have fired while app was backgrounded.
        appStateSub = AppState.addEventListener("change", async (next) => {
          if (next !== "active") return;
          try {
            const fresh = await rc.getCustomerInfo();
            if (fresh) useGameStore.getState().setSubscriptionFromRC(fresh.details);
          } catch {
            // Non-fatal — DB tier still reflects truth on next refreshChildFromDB.
          }
        });
      } catch (err) {
        addGameBreadcrumb({
          category: "revenuecat",
          message:  "Lifecycle setup failed (non-fatal)",
          data:     { error: String(err) },
        });
      }
    })();

    return () => {
      cancelled = true;
      if (unsubscribeRcListener) unsubscribeRcListener();
      if (appStateSub) appStateSub.remove();
    };
  }, [session?.user?.id]);

  // ── Game-session lifecycle — Phase 3.7 ─────────────────────────────────────
  const { startSession, endSession } = useAnalytics();
  const screenSequenceRef = useRef<string[]>([]);
  // Tracks whether the app actually went to BACKGROUND (vs a transient
  // 'inactive'). Only a real background→active round-trip starts a new session.
  const wasBackgroundedRef = useRef(false);

  useEffect(() => {
    if (!activeChild?.id) return;

    screenSequenceRef.current = [];
    useGameStore.getState().resetSessionCounters();

    const initialRoute = navigationRef.isReady()
      ? navigationRef.getCurrentRoute()
      : null;
    if (initialRoute?.name) {
      screenSequenceRef.current.push(initialRoute.name);
    }

    startSession();

    return () => {
      const c = useGameStore.getState().sessionCounters;
      endSession({
        questsStarted:  c.questsStarted,
        questsFinished: c.questsFinished,
        xpEarned:       c.xpEarned,
        screenSequence: screenSequenceRef.current,
      });
    };
  }, [activeChild?.id, startSession, endSession]);

  useEffect(() => {
    if (!activeChild?.id) return;

    const subscription = AppState.addEventListener("change", (nextState) => {
      // Only a real BACKGROUND transition ends a session / pauses music. iOS
      // fires 'inactive' for transient interruptions (Control Center, banners,
      // the app-switcher peek, Face ID), so treating 'inactive' as background
      // spawned bursts of empty 0-quest sessions and stuttered the music bed.
      if (nextState === "background") {
        wasBackgroundedRef.current = true;
        import("./lib/audio").then((m) => m.pauseBgmForBackground()).catch(() => {});
        const c = useGameStore.getState().sessionCounters;
        endSession({
          questsStarted:  c.questsStarted,
          questsFinished: c.questsFinished,
          xpEarned:       c.xpEarned,
          screenSequence: screenSequenceRef.current,
        });
      } else if (nextState === "active" && wasBackgroundedRef.current) {
        // Returning from a genuine background — start a fresh session.
        wasBackgroundedRef.current = false;
        import("./lib/audio").then((m) => m.resumeBgmFromForeground()).catch(() => {});
        screenSequenceRef.current = [];
        useGameStore.getState().resetSessionCounters();

        const route = navigationRef.isReady()
          ? navigationRef.getCurrentRoute()
          : null;
        if (route?.name) {
          screenSequenceRef.current.push(route.name);
        }

        startSession();
      }
    });

    return () => subscription.remove();
  }, [activeChild?.id, startSession, endSession]);

  // ── Screen-change breadcrumb ───────────────────────────────────────────────

  const handleNavigationStateChange = useCallback(() => {
    if (!navigationRef.isReady()) return;
    const route = navigationRef.getCurrentRoute();
    if (route) {
      addGameBreadcrumb({
        category: "navigation",
        message:  `→ ${route.name}`,
        data:     { routeName: route.name },
      });
      Sentry.setTag("active_screen", route.name);

      const seq = screenSequenceRef.current;
      if (seq[seq.length - 1] !== route.name) {
        seq.push(route.name);
      }

      // Per-screen music bed + entry whoosh. Dynamic import keeps the audio
      // tree out of any top-level App.tsx import (iOS module-init safety);
      // it resolves from cache after initGameAudio ran. Fire-and-forget.
      // Gated on audioReadyRef: before the engine localizes its assets, a
      // startBgm() on the not-yet-localized track fails silently AND poisons the
      // committed-route state, so the bed wouldn't start until the next screen.
      // Until then the init effect owns the initial bed.
      if (audioReadyRef.current) {
        import("./lib/audio")
          .then((m) => m.onScreenChange(route.name))
          .catch(() => { /* audio is non-essential */ });
      }
    }
  }, []);

  // ── Loading splash ─────────────────────────────────────────────────────────
  //
  // v6.6 — also gates on backstorySeen still being null. The backstory flag
  // read is fast (an AsyncStorage roundtrip), but we don't want to flash
  // AppNavigator and then yank it away to show the story. If auth resolves
  // first and the flag read is still in flight, we sit on the splash for the
  // extra few ms it takes — never visible to the user in practice.

  if (initialising || backstorySeen === null) {
    return (
      <View style={{ flex: 1, backgroundColor: "#0f0620", alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color="#f5c842" size="large" />
      </View>
    );
  }

  // v4.5 — show AuthNavigator if there's no session OR if we're in
  // password-recovery mode (session exists but parent must reset password
  // before reaching the game).
  // v4.6 — also stay on AuthNavigator while a deletion gate is up: the parent
  // has a live session but must first decide Restore vs Sign out.
  // social-auth — and while a consent gate is up: a new Google/Apple user has a
  // live session but must clear the COPPA consent step before entering.
  const showAuth = !session || recoveryActive || !!deletionScheduledAt || consentPending;

  // v4.6 — the backstory is NO LONGER a standalone pre-app branch. It moved
  // into AppNavigator as a stack screen reached after the first child
  // selection (see ChildSwitcher.handleSelect + the OnboardingBackstory
  // screen in AppNavigator). This lets it personalise on the child's name,
  // which was impossible when it ran before any child existed. App-state
  // `backstorySeen` is still tracked (mount read + onBackstoryComplete flip)
  // purely to gate the daily-greeting audio so it can't collide with the
  // story.

  return (
    <ErrorBoundary screen="App">
      <SafeAreaProvider>
        <NavigationContainer
          ref={navigationRef}
          onReady={handleNavigationStateChange}
          onStateChange={handleNavigationStateChange}
        >
          {showAuth ? (
            <AuthNavigator />
          ) : (
            <AppNavigator
              onBackstoryComplete={onBackstoryComplete}
              backstoryChildName={activeChild?.display_name ?? null}
            />
          )}
        </NavigationContainer>

        {/* N4 — Badge toast overlay */}
        <AchievementToastOverlay />

      </SafeAreaProvider>
    </ErrorBoundary>
  );
}

// ─── iOS safety-net wrapper (v4.5.9) ──────────────────────────────────────
//
// Wraps the production App in an ErrorBoundary + mount-deadline detector.
// If the production tree mounts cleanly within 5 seconds, the wrapper is
// a no-op pass-through. If it throws or fails to mount, the wrapper
// shows a live diagnostic UI instead of the silent white screen we saw
// in v1.0.13–v1.0.20.
//
// Once iOS is confirmed working post-v1.0.23:
//   1. Delete lib/iosSafetyNet.tsx
//   2. Remove this import + the withIosSafetyNet() call below
//   3. Restore: export default ENV.sentry.dsn ? Sentry.wrap(App) : App;
import { withIosSafetyNet } from "./lib/iosSafetyNet";

const RootApp = ENV.sentry.dsn ? Sentry.wrap(App) : App;
export default withIosSafetyNet(RootApp);
