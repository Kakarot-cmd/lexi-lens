/**
 * AuthScreen.tsx
 * Lexi-Lens — parent authentication (login + signup).
 *
 * Two modes toggled inline — no separate screens:
 *   "sign_in"  → email + password + "Sign in" button
 *   "sign_up"  → display name + email + password + confirm + "Create account"
 *
 * After successful auth the navigator's onAuthStateChange listener
 * (in App.tsx) will redirect to ChildSwitcher automatically.
 *
 * Aesthetic: warm parchment / ink — the parent's world, not the child's dungeon.
 *
 * Dependencies (all installed):
 *   @supabase/supabase-js
 *   react-native-safe-area-context
 *   expo-haptics
 */

import React, { useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Animated,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { supabase } from "../lib/supabase";

// ─── Types ────────────────────────────────────────────────────────────────────

type AuthMode = "sign_in" | "sign_up";

// ─── Palette ──────────────────────────────────────────────────────────────────

const P = {
  cream:       "#fdf8f0",
  parchment:   "#f5edda",
  warmBorder:  "#e2d0b0",
  inkBrown:    "#3d2a0f",
  inkMid:      "#6b4c1e",
  inkLight:    "#9c7540",
  inkFaint:    "#c4a97a",
  amber:       "#d97706",
  amberLight:  "#fef3c7",
  amberBorder: "#fde68a",
  errorBg:     "#fff1f2",
  errorBorder: "#fecdd3",
  errorText:   "#9f1239",
  purple:      "#7c3aed",
  purpleLight: "#f5f3ff",
  white:       "#ffffff",
};

// ─── Validated field ──────────────────────────────────────────────────────────

interface FieldState {
  value:   string;
  touched: boolean;
  error:   string | null;
}

function useField(initialValue = ""): [FieldState, (v: string) => void, () => void] {
  const [state, setState] = useState<FieldState>({
    value: initialValue, touched: false, error: null,
  });

  const setValue = useCallback((v: string) =>
    setState((s) => ({ ...s, value: v, error: null })), []);

  const touch = useCallback(() =>
    setState((s) => ({ ...s, touched: true })), []);

  return [state, setValue, touch];
}

function validateEmail(v: string): string | null {
  if (!v.trim()) return "Email is required";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "Enter a valid email address";
  return null;
}

function validatePassword(v: string): string | null {
  if (!v) return "Password is required";
  if (v.length < 8) return "Password must be at least 8 characters";
  return null;
}

// ─── Inline error ─────────────────────────────────────────────────────────────

function FieldError({ message }: { message: string }) {
  return <Text style={styles.fieldError}>{message}</Text>;
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export function AuthScreen() {
  const insets = useSafeAreaInsets();
  const [mode, setMode]       = useState<AuthMode>("sign_in");
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [success, setSuccess]   = useState(false);

  // Fields
  const [displayName, setDisplayName, touchDisplayName] = useField();
  const [email,       setEmail,       touchEmail]       = useField();
  const [password,    setPassword,    touchPassword]    = useField();
  const [confirm,     setConfirm,     touchConfirm]     = useField();

  // Animation for mode switch
  const fadeAnim = useRef(new Animated.Value(1)).current;

  const switchMode = (next: AuthMode) => {
    setApiError(null);
    Animated.sequence([
      Animated.timing(fadeAnim, { toValue: 0, duration: 120, useNativeDriver: true }),
      Animated.timing(fadeAnim, { toValue: 1, duration: 180, useNativeDriver: true }),
    ]).start();
    setTimeout(() => setMode(next), 120);
  };

  // ── Validation ─────────────────────────────────────────────
  const validate = (): boolean => {
    let ok = true;

    if (mode === "sign_up" && !displayName.value.trim()) {
      touchDisplayName(); ok = false;
    }

    const emailErr = validateEmail(email.value);
    if (emailErr) { touchEmail(); ok = false; }

    const passErr = validatePassword(password.value);
    if (passErr) { touchPassword(); ok = false; }

    if (mode === "sign_up" && password.value !== confirm.value) {
      touchConfirm(); ok = false;
    }

    return ok;
  };

  // ── Submit ─────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!validate()) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }

    setLoading(true);
    setApiError(null);

    try {
      if (mode === "sign_in") {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.value.trim(),
          password: password.value,
        });
        if (error) throw error;
        // onAuthStateChange in App.tsx handles navigation
      } else {
        // Sign up
        const { data, error } = await supabase.auth.signUp({
          email:    email.value.trim(),
          password: password.value,
          options:  { data: { display_name: displayName.value.trim() } },
        });
        if (error) throw error;

    

        // Some Supabase projects require email verification
        if (data.session === null) {
          setSuccess(true);
        }
        // If session exists, onAuthStateChange handles redirect
      }
    } catch (err: any) {
      const message: string = err?.message ?? "Something went wrong";
      // Surface user-friendly versions of common Supabase errors
      if (message.includes("Invalid login credentials")) {
        setApiError("Email or password is incorrect.");
      } else if (message.includes("already registered")) {
        setApiError("An account with this email already exists. Try signing in.");
      } else {
        setApiError(message);
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoading(false);
    }
  };

  // ── Email verification pending ─────────────────────────────
  if (success) {
    return (
      <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.successEmoji}>📬</Text>
        <Text style={styles.successTitle}>Check your email</Text>
        <Text style={styles.successBody}>
          We sent a confirmation link to{"\n"}
          <Text style={{ fontWeight: "600" }}>{email.value.trim()}</Text>
          {"\n\n"}Tap it to activate your account, then come back and sign in.
        </Text>
        <TouchableOpacity
          style={styles.switchModeBtn}
          onPress={() => { setSuccess(false); switchMode("sign_in"); }}
        >
          <Text style={styles.switchModeBtnText}>Back to sign in</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Main form ──────────────────────────────────────────────
  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 40 },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Wordmark */}
        <View style={styles.wordmark}>
          <Text style={styles.wordmarkEmoji}>📖</Text>
          <Text style={styles.wordmarkTitle}>Lexi-Lens</Text>
          <Text style={styles.wordmarkSub}>Vocabulary adventures for children</Text>
        </View>

        <Animated.View style={[styles.card, { opacity: fadeAnim }]}>
          {/* Mode heading */}
          <Text style={styles.formTitle}>
            {mode === "sign_in" ? "Parent sign in" : "Create parent account"}
          </Text>
          <Text style={styles.formSub}>
            {mode === "sign_in"
              ? "Sign in to manage your children's quests and Word Tome."
              : "One account for the whole family. Add children after signing up."}
          </Text>

          {/* API error */}
          {apiError && (
            <View style={styles.apiErrorBox}>
              <Text style={styles.apiErrorText}>{apiError}</Text>
            </View>
          )}

          {/* Display name (sign up only) */}
          {mode === "sign_up" && (
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Your name</Text>
              <TextInput
                style={[
                  styles.input,
                  displayName.touched && !displayName.value.trim() && styles.inputError,
                ]}
                placeholder="e.g. Sarah"
                placeholderTextColor={P.inkFaint}
                value={displayName.value}
                onChangeText={setDisplayName}
                onBlur={touchDisplayName}
                autoCapitalize="words"
                returnKeyType="next"
                accessibilityLabel="Your display name"
              />
              {displayName.touched && !displayName.value.trim() && (
                <FieldError message="Your name is required" />
              )}
            </View>
          )}

          {/* Email */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Email address</Text>
            <TextInput
              style={[
                styles.input,
                email.touched && !!validateEmail(email.value) && styles.inputError,
              ]}
              placeholder="you@example.com"
              placeholderTextColor={P.inkFaint}
              value={email.value}
              onChangeText={setEmail}
              onBlur={touchEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
              accessibilityLabel="Email address"
            />
            {email.touched && !!validateEmail(email.value) && (
              <FieldError message={validateEmail(email.value)!} />
            )}
          </View>

          {/* Password */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Password</Text>
            <TextInput
              style={[
                styles.input,
                password.touched && !!validatePassword(password.value) && styles.inputError,
              ]}
              placeholder={mode === "sign_up" ? "At least 8 characters" : "Your password"}
              placeholderTextColor={P.inkFaint}
              value={password.value}
              onChangeText={setPassword}
              onBlur={touchPassword}
              secureTextEntry
              returnKeyType={mode === "sign_up" ? "next" : "done"}
              onSubmitEditing={mode === "sign_in" ? handleSubmit : undefined}
              accessibilityLabel="Password"
            />
            {password.touched && !!validatePassword(password.value) && (
              <FieldError message={validatePassword(password.value)!} />
            )}
          </View>

          {/* Confirm password (sign up only) */}
          {mode === "sign_up" && (
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Confirm password</Text>
              <TextInput
                style={[
                  styles.input,
                  confirm.touched && password.value !== confirm.value && styles.inputError,
                ]}
                placeholder="Repeat your password"
                placeholderTextColor={P.inkFaint}
                value={confirm.value}
                onChangeText={setConfirm}
                onBlur={touchConfirm}
                secureTextEntry
                returnKeyType="done"
                onSubmitEditing={handleSubmit}
                accessibilityLabel="Confirm password"
              />
              {confirm.touched && password.value !== confirm.value && (
                <FieldError message="Passwords don't match" />
              )}
            </View>
          )}

          {/* Submit */}
          <TouchableOpacity
            style={[styles.submitBtn, loading && styles.submitBtnDisabled]}
            onPress={handleSubmit}
            disabled={loading}
            accessibilityRole="button"
            accessibilityLabel={mode === "sign_in" ? "Sign in" : "Create account"}
          >
            {loading ? (
              <ActivityIndicator color={P.white} />
            ) : (
              <Text style={styles.submitBtnText}>
                {mode === "sign_in" ? "Sign in" : "Create account"}
              </Text>
            )}
          </TouchableOpacity>
        </Animated.View>

        {/* Mode toggle */}
        <View style={styles.toggleRow}>
          <Text style={styles.toggleText}>
            {mode === "sign_in" ? "New to Lexi-Lens?" : "Already have an account?"}
          </Text>
          <TouchableOpacity
            onPress={() => switchMode(mode === "sign_in" ? "sign_up" : "sign_in")}
            accessibilityRole="button"
          >
            <Text style={styles.toggleLink}>
              {mode === "sign_in" ? "Create account" : "Sign in"}
            </Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.legalText}>
          By creating an account you agree to our Terms of Service and Privacy Policy.
          Lexi-Lens complies with COPPA — no personal data is collected from children.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root:   { flex: 1, backgroundColor: P.cream },
  center: { alignItems: "center", justifyContent: "center", padding: 32 },
  scroll: { paddingHorizontal: 20 },

  // Wordmark
  wordmark:      { alignItems: "center", marginBottom: 32 },
  wordmarkEmoji: { fontSize: 52, marginBottom: 10 },
  wordmarkTitle: { fontSize: 30, fontWeight: "800", color: P.inkBrown, letterSpacing: -0.5 },
  wordmarkSub:   { fontSize: 14, color: P.inkLight, marginTop: 4 },

  // Card
  card: {
    backgroundColor: P.white,
    borderRadius:    20,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    padding:         24,
    marginBottom:    20,
    ...Platform.select({
      ios:     { shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 12 },
      android: { elevation: 3 },
    }),
  },
  formTitle: { fontSize: 20, fontWeight: "700", color: P.inkBrown, marginBottom: 6 },
  formSub:   { fontSize: 13, color: P.inkLight, lineHeight: 19, marginBottom: 20 },

  // API error
  apiErrorBox: {
    backgroundColor: P.errorBg,
    borderRadius:    10,
    borderWidth:     1,
    borderColor:     P.errorBorder,
    padding:         12,
    marginBottom:    16,
  },
  apiErrorText: { fontSize: 13, color: P.errorText, lineHeight: 18 },

  // Fields
  fieldGroup:  { marginBottom: 16 },
  label:       { fontSize: 13, fontWeight: "600", color: P.inkMid, marginBottom: 6 },
  input: {
    backgroundColor:  P.parchment,
    borderRadius:     10,
    borderWidth:      1,
    borderColor:      P.warmBorder,
    paddingHorizontal: 14,
    paddingVertical:  12,
    fontSize:         15,
    color:            P.inkBrown,
  },
  inputError:  { borderColor: "#fca5a5", backgroundColor: "#fff5f5" },
  fieldError:  { fontSize: 12, color: P.errorText, marginTop: 5 },

  // Submit
  submitBtn: {
    backgroundColor: P.amber,
    borderRadius:    14,
    paddingVertical: 16,
    alignItems:      "center",
    marginTop:       8,
  },
  submitBtnDisabled: { opacity: 0.65 },
  submitBtnText: { fontSize: 16, fontWeight: "700", color: P.white },

  // Toggle
  toggleRow: {
    flexDirection:  "row",
    justifyContent: "center",
    alignItems:     "center",
    gap:            6,
    marginBottom:   20,
  },
  toggleText: { fontSize: 14, color: P.inkLight },
  toggleLink: { fontSize: 14, fontWeight: "700", color: P.amber },

  // Legal
  legalText: {
    fontSize:   11,
    color:      P.inkFaint,
    textAlign:  "center",
    lineHeight: 16,
  },

  // Success
  successEmoji: { fontSize: 56, marginBottom: 16 },
  successTitle: { fontSize: 22, fontWeight: "700", color: P.inkBrown, marginBottom: 12 },
  successBody:  { fontSize: 15, color: P.inkMid, textAlign: "center", lineHeight: 22, marginBottom: 32 },
  switchModeBtn: {
    borderWidth:      1,
    borderColor:      P.warmBorder,
    borderRadius:     12,
    paddingHorizontal: 24,
    paddingVertical:  12,
  },
  switchModeBtnText: { fontSize: 15, fontWeight: "600", color: P.inkMid },
});
