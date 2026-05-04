// ─── Sentry: must be first import + call before anything else ─────────────────

import {
  initSentry,
  Sentry,
  setUserContext,
  clearUserContext,
  addGameBreadcrumb,
} from "./lib/sentry";

initSentry();

// ─── React + RN ───────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback, useRef } from "react";
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

// ─── Navigation param lists ───────────────────────────────────────────────────

import type { RootStackParamList, AuthStackParamList } from "./types/navigation";

// ─── Screens ──────────────────────────────────────────────────────────────────

import { AuthScreen }          from "./screens/AuthScreen";
import { ChildSwitcherScreen } from "./screens/ChildSwitcherScreen";
import { QuestMapScreen }      from "./screens/QuestMapScreen";
import { ParentDashboard }     from "./screens/ParentDashboard";
import SpellBookScreen         from "./screens/SpellBookScreen";
import QuestGeneratorScreen    from "./screens/QuestGeneratorScreen";
import { OnboardingScreen }    from "./screens/OnboardingScreen";

// ─── Components ───────────────────────────────────────────────────────────────

import { ErrorBoundary }           from "./components/ErrorBoundary";
// N4 — Achievement badge toast overlay (global, above all screens)
import { AchievementToastOverlay } from "./components/AchievementToast";

// ─── Store ────────────────────────────────────────────────────────────────────

import { useGameStore } from "./store/gameStore";

// ─── Analytics ────────────────────────────────────────────────────────────────
// Phase 3.7 instrumentation — game_sessions / quest_sessions / word_outcomes.
// Wire-up missing since launch; persistence patch ships these tables for real.
import { useAnalytics } from "./hooks/useAnalytics";

// ─── Web placeholder (camera not available in browser) ───────────────────────

function ScanPlaceholder() {
  return (
    <View style={{ flex: 1, backgroundColor: "#0f0620", alignItems: "center", justifyContent: "center", padding: 32 }}>
      <Text style={{ fontSize: 48, marginBottom: 16 }}>📱</Text>
      <Text style={{ fontSize: 20, fontWeight: "700", color: "#f3e8ff", textAlign: "center", marginBottom: 12 }}>
        Camera required
      </Text>
      <Text style={{ fontSize: 14, color: "#a78bfa", textAlign: "center", lineHeight: 22 }}>
        This feature works on a real Android device with the custom APK installed.
      </Text>
    </View>
  );
}

// Dynamically import ScanScreen only on native
const ScanScreen = Platform.OS === "web"
  ? ScanPlaceholder
  : require("./screens/ScanScreen").ScanScreen;

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
            <QuestMapScreen {...props} />
          </ErrorBoundary>
        )}
      </AppNav.Screen>

      <AppNav.Screen name="Scan">
        {(props) => (
          <ErrorBoundary screen="ScanScreen">
            <ScanScreen {...props} />
          </ErrorBoundary>
        )}
      </AppNav.Screen>

      <AppNav.Screen name="ParentDashboard">
        {(props) => (
          <ErrorBoundary screen="ParentDashboard">
            <ParentDashboard {...props} />
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

      {/* ── N1: First-session onboarding ──────────────────────────────────── */}
      <AppNav.Screen name="Onboarding">
        {(props) => (
          <ErrorBoundary screen="OnboardingScreen">
            <OnboardingScreen {...props} />
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

  const navigationRef = useNavigationContainerRef();

  // ── Auth listener ──────────────────────────────────────────────────────────

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setInitialising(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, s) => {
        setSession(s);
        if (!s) {
          clearUserContext();
          addGameBreadcrumb({ category: "auth", message: "User signed out" });
        } else {
          addGameBreadcrumb({
            category: "auth",
            message:  "Session established",
            data:     { userId: s.user.id },
          });
        }
      }
    );

    // ── Deep-link handler — email-confirmation redirect ─────────────────────
    const handleDeepLink = async ({ url }: { url: string | null }) => {
      if (!url) return;
      try {
        const parsed = new URL(url);

        const code = parsed.searchParams.get("code");
        if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) {
            addGameBreadcrumb({
              category: "auth",
              message:  "Email confirm code exchange failed",
              data:     { error: error.message },
            });
          }
          return;
        }

        const fragment = parsed.hash.replace(/^#/, "");
        if (fragment) {
          const params        = new URLSearchParams(fragment);
          const access_token  = params.get("access_token");
          const refresh_token = params.get("refresh_token");
          if (access_token && refresh_token) {
            await supabase.auth.setSession({ access_token, refresh_token });
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

  // ── Sentry user context ────────────────────────────────────────────────────

  useEffect(() => {
    if (activeChild && session?.user) {
      setUserContext({
        childId:  activeChild.id,
        parentId: session.user.id,
        childAge: parseInt(activeChild.age_band?.split("-")[1] ?? "8", 10),
      });
      addGameBreadcrumb({
        category: "auth",
        message:  "Active child set",
        data:     { childId: activeChild.id },
      });
    }
  }, [activeChild?.id, session?.user?.id]);

  // ── Analytics: game_sessions lifecycle ─────────────────────────────────────
  // PERSISTENCE FIX (Phase 3.7 wire-up):
  // Until now, useAnalytics existed but was never imported anywhere outside
  // its own test file — so game_sessions / quest_sessions / word_outcomes
  // had zero rows DB-wide despite ~99 scans across 6 children. Wiring it
  // here means: whenever a child profile becomes active we open a session
  // row; whenever the child switches OR the app moves to the background
  // we close that row with the screen sequence and quest counts.
  //
  // All writes are fire-and-forget inside useAnalytics — Supabase failures
  // never break the game loop. Quest-level writes (startQuestSession /
  // finishQuestSession / logWordOutcome) are wired separately in ScanScreen.
  //
  // SESSION COUNTERS FIX (v4.4 — Known Gap "App.tsx quest counters not incremented"):
  // The previous shape declared `questCountsRef = useRef({ started, finished, xp })`
  // and read it back into endSession's payload, but no code path ever
  // incremented it — every game_sessions row closed with 0/0/0. The counter
  // state has been moved into gameStore.sessionCounters where beginQuest and
  // markQuestCompletion can bump it at the actual event sites. We pull the
  // live values at flush-time via useGameStore.getState().sessionCounters
  // inside the cleanup and the AppState callback — getState() returns the
  // current snapshot (not a stale closure capture), which is exactly what
  // we want when closing the session row.
  //
  // SCREEN_SEQUENCE FIRST-ENTRY FIX (v4.4.2 — Bug E):
  // Before this fix, the first game_sessions row per child opened with an
  // empty screen_sequence and stayed empty until a fresh navigation event
  // fired AFTER session start. Cause: NavigationContainer's onStateChange
  // fires when navigation commits, which can happen BEFORE this activeChild
  // useEffect runs (React batches state from ChildSwitcher — setActiveChild
  // and navigate("QuestMap") both queue, navigation onStateChange fires
  // during commit, then this useEffect runs after commit and resets the ref
  // — wiping "QuestMap"). Fix: after resetting, capture the current route
  // via navigationRef and seed the sequence with it. Guarantees every closed
  // session has at least one screen recorded.
  const { startSession, endSession } = useAnalytics();
  const screenSequenceRef = useRef<string[]>([]);

  useEffect(() => {
    if (!activeChild?.id) return;

    // Open a fresh session row for this child.
    screenSequenceRef.current = [];
    useGameStore.getState().resetSessionCounters();

    // v4.4.2 — seed with the current route so the first nav event for this
    // session isn't lost. See SCREEN_SEQUENCE FIRST-ENTRY FIX comment above.
    const initialRoute = navigationRef.getCurrentRoute();
    if (initialRoute?.name) {
      screenSequenceRef.current.push(initialRoute.name);
    }

    startSession();

    // Cleanup runs on child switch OR sign-out — close the row.
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

  // Close the session when the app moves to background, reopen on foreground.
  // This avoids a single "session" stretching across multiple days when the
  // user backgrounds the app overnight.
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

        // v4.4.2 — same fix as the activeChild effect above. When the user
        // foregrounds the app the navigation state hasn't changed (they're
        // returning to whatever screen they left), so onStateChange won't
        // fire — without seeding here, the session row would close with
        // zero screens recorded.
        const route = navigationRef.getCurrentRoute();
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
    const route = navigationRef.getCurrentRoute();
    if (route) {
      addGameBreadcrumb({
        category: "navigation",
        message:  `→ ${route.name}`,
        data:     { routeName: route.name },
      });
      Sentry.setTag("active_screen", route.name);

      // Phase 3.7: accumulate the screen sequence for the closing
      // game_sessions.screen_sequence column. Dedup consecutive
      // duplicates so re-renders don't pollute the trail. The seed-with-
      // initial-route logic in the activeChild useEffect above also relies
      // on this dedup — if the initial route fires a redundant nav event
      // (some platforms do this on mount), we don't double-push it.
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

  return (
    <ErrorBoundary screen="App">
      <SafeAreaProvider>
        <NavigationContainer
          ref={navigationRef}
          onStateChange={handleNavigationStateChange}
        >
          {session ? <AppNavigator /> : <AuthNavigator />}
        </NavigationContainer>

        {/* N4 — Badge toast overlay — floats above all screens, touches pass through */}
        <AchievementToastOverlay />

      </SafeAreaProvider>
    </ErrorBoundary>
  );
}

export default Sentry.wrap(App);
