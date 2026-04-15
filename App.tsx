import { useEffect, useState } from "react";
import { View, Text, ActivityIndicator, Platform } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { Session } from "@supabase/supabase-js";

import { supabase } from "./lib/supabase";
import { AuthScreen } from "./screens/AuthScreen";
import { ChildSwitcherScreen } from "./screens/ChildSwitcherScreen";
import { QuestMapScreen } from "./screens/QuestMapScreen";
import { ParentDashboard } from "./screens/ParentDashboard";

function ScanPlaceholder() {
  return (
    <View style={{ flex:1, backgroundColor:"#0f0620", alignItems:"center", justifyContent:"center", padding:32 }}>
      <Text style={{ fontSize:48, marginBottom:16 }}>📱</Text>
      <Text style={{ fontSize:20, fontWeight:"700", color:"#f3e8ff", textAlign:"center", marginBottom:12 }}>
        Camera required
      </Text>
      <Text style={{ fontSize:14, color:"#a78bfa", textAlign:"center", lineHeight:22 }}>
        This feature works on a real Android device with the custom APK installed.
      </Text>
    </View>
  );
}

// Dynamically import ScanScreen only on native
const ScanScreen = Platform.OS === "web"
  ? ScanPlaceholder
  : require("./screens/ScanScreen").ScanScreen;

const AuthNav = createNativeStackNavigator();
const AppNav  = createNativeStackNavigator();

function AuthNavigator() {
  return (
    <AuthNav.Navigator screenOptions={{ headerShown: false }}>
      <AuthNav.Screen name="Auth" component={AuthScreen} />
    </AuthNav.Navigator>
  );
}

function AppNavigator() {
  return (
    <AppNav.Navigator screenOptions={{ headerShown: false }}>
      <AppNav.Screen name="ChildSwitcher" component={ChildSwitcherScreen} />
      <AppNav.Screen name="QuestMap"      component={QuestMapScreen} />
      <AppNav.Screen name="Scan"          component={ScanScreen} />
      <AppNav.Screen name="Parent"        component={ParentDashboard} />
    </AppNav.Navigator>
  );
}

export default function App() {
  const [session,      setSession]      = useState<Session | null>(null);
  const [initialising, setInitialising] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setInitialising(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => setSession(session)
    );
    return () => subscription.unsubscribe();
  }, []);

  if (initialising) {
    return (
      <View style={{ flex:1, backgroundColor:"#0f0620", alignItems:"center", justifyContent:"center" }}>
        <ActivityIndicator color="#f5c842" size="large" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <NavigationContainer>
        {session ? <AppNavigator /> : <AuthNavigator />}
      </NavigationContainer>
    </SafeAreaProvider>
  );
}