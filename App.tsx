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
import { View, Text, ActivityIndicator, Platform, Linking } from "react-native";

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
import { AuthScreen }             from "./screens/AuthScreen";
import { ChildSwitcherScreen }    from "./screens/ChildSwitcherScreen";
import { QuestMapScreen }         from "./screens/QuestMapScreen";
import { ParentDashboard }        from "./screens/ParentDashboard";
import SpellBookScreen            from "./screens/SpellBookScreen";
import { QuestGeneratorScreen }   from "./screens/QuestGeneratorScreen";

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

// Dynamically import ScanScreen only on native — unchanged from your original
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

    // ── Deep-link handler — email-confirmation redirect ─────────────────────
    // When the user taps the confirmation link in their email client, the OS
    // opens the app via the "lexilens://auth/confirm" custom scheme.
    // Supabase appends either a PKCE ?code=… param (v2 default) or a legacy
    // #access_token=… fragment. We handle both.
    const handleDeepLink = async ({ url }: { url: string | null }) => {
      if (!url) return;
      try {
        const parsed = new URL(url);

        // PKCE code exchange — Supabase JS v2 default
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

        // Legacy implicit-flow fragment: #access_token=…&refresh_token=…
        const fragment = parsed.hash.replace(/^#/, "");
        if (fragment) {
          const params = new URLSearchParams(fragment);
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

    // Cold-start: app launched directly via the confirmation link
    Linking.getInitialURL().then((url) => handleDeepLink({ url }));
    // Warm-start: app was already running when the link was tapped
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
        childId:  activeChild.id,
        parentId: session.user.id,
        // age_band is "7-8" → take upper digit as a proxy for exact age
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

  // ── Loading splash — identical to your original ────────────────────────────
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
// Must wrap the default export — this is what Expo loads as the entry point.
export default Sentry.wrap(App);
