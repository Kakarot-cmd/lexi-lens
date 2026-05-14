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

// ─── Components ───────────────────────────────────────────────────────────────

import { ErrorBoundary }           from "./components/ErrorBoundary";
import { AchievementToastOverlay } from "./components/AchievementToast";

// ─── Store ────────────────────────────────────────────────────────────────────

import { useGameStore } from "./store/gameStore";

// ─── Analytics ────────────────────────────────────────────────────────────────

import { useAnalytics } from "./hooks/useAnalytics";

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
        Camera scanning is only available on iOS and Android. Try Lexi-Lens on a phone or tablet.
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

function AppNavigator() {
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

  const navigationRef = useNavigationContainerRef();

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
      } catch (err) {
        // Sound init failures are non-fatal — kids still get the game.
        console.warn("[Lumi] sound init skipped:", err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Auth listener ──────────────────────────────────────────────────────────

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
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
          addGameBreadcrumb({ category: "auth", message: "User signed out" });
        } else {
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
  useEffect(() => {
    if (!session || !activeChild?.id) return;
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
  }, [session?.user?.id, activeChild?.id]);

  // ── Game-session lifecycle — Phase 3.7 ─────────────────────────────────────
  const { startSession, endSession } = useAnalytics();
  const screenSequenceRef = useRef<string[]>([]);

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
      if (nextState === "background" || nextState === "inactive") {
        const c = useGameStore.getState().sessionCounters;
        endSession({
          questsStarted:  c.questsStarted,
          questsFinished: c.questsFinished,
          xpEarned:       c.xpEarned,
          screenSequence: screenSequenceRef.current,
        });
      } else if (nextState === "active") {
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
    }
  }, []);

  // ── Loading splash ─────────────────────────────────────────────────────────

  if (initialising) {
    return (
      <View style={{ flex: 1, backgroundColor: "#0f0620", alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color="#f5c842" size="large" />
      </View>
    );
  }

  // v4.5 — show AuthNavigator if there's no session OR if we're in
  // password-recovery mode (session exists but parent must reset password
  // before reaching the game).
  const showAuth = !session || recoveryActive;

  return (
    <ErrorBoundary screen="App">
      <SafeAreaProvider>
        <NavigationContainer
          ref={navigationRef}
          onStateChange={handleNavigationStateChange}
        >
          {showAuth ? <AuthNavigator /> : <AppNavigator />}
        </NavigationContainer>

        {/* N4 — Badge toast overlay */}
        <AchievementToastOverlay />

      </SafeAreaProvider>
    </ErrorBoundary>
  );
}

export default ENV.sentry.dsn ? Sentry.wrap(App) : App;
