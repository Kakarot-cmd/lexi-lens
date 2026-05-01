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
import { useEffect, useState, useCallback } from "react";
import { View, Text, ActivityIndicator, Platform } from "react-native";

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

// ─── Screens ──────────────────────────────────────────────────────────────────
import { AuthScreen }           from "./screens/AuthScreen";
import { ChildSwitcherScreen }  from "./screens/ChildSwitcherScreen";
import { QuestMapScreen }       from "./screens/QuestMapScreen";
import { ParentDashboard }      from "./screens/ParentDashboard";
import SpellBookScreen          from "./screens/SpellBookScreen";
import { QuestGeneratorScreen } from "./screens/QuestGeneratorScreen";
import { OnboardingScreen }     from "./screens/OnboardingScreen";   // ← N1

// ─── Error boundary ───────────────────────────────────────────────────────────
import { ErrorBoundary } from "./components/ErrorBoundary";

// ─── Store ────────────────────────────────────────────────────────────────────
import { useGameStore } from "./store/gameStore";

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

const AuthNav = createNativeStackNavigator();
const AppNav  = createNativeStackNavigator();

function AuthNavigator() {
  return (
    <AuthNav.Navigator screenOptions={{ headerShown: false }}>
      <AuthNav.Screen name="Auth">
        {(props) => (
          <ErrorBoundary screen="AuthScreen">
            <AuthScreen {...props} />
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
        {(props) => (
          <ErrorBoundary screen="QuestGeneratorScreen">
            <QuestGeneratorScreen {...props} />
          </ErrorBoundary>
        )}
      </AppNav.Screen>

      {/* ── N1: First-session onboarding ────────────────────────────────── */}
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
  const [session,      setSession]      = useState<Session | null>(null);
  const [initialising, setInitialising] = useState(true);

  const activeChild = useGameStore((s) => s.activeChild);

  // Navigation ref — feeds screen names into Sentry breadcrumbs
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

    return () => subscription.unsubscribe();
  }, []);

  // ── Sentry user context — sync whenever active child changes ──────────────
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
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}

// Sentry.wrap() registers the JS-level global error handler.
export default Sentry.wrap(App);
