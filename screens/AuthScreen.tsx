/**
 * AuthScreen.tsx  (Phase 4.1 — COPPA + GDPR-K update)
 * Lexi-Lens — parent authentication (login + signup).
 *
 * CHANGES FROM PREVIOUS VERSION:
 *
 *   1. ConsentGateModal integrated into sign-up flow.
 *      When the parent taps "Create account", the consent gate appears
 *      FIRST (parental gate maths challenge + 4 opt-in checkboxes).
 *      Only after ALL four boxes are checked does the Supabase signUp()
 *      call fire. This satisfies COPPA §312.5(a) and GDPR-K Art. 8.
 *
 *   2. Consent metadata passed in user_metadata at signup.
 *      A Supabase DB trigger (handle_new_user_consent) reads these fields
 *      and writes a parental_consents row automatically — so the record
 *      is created even when email verification is required before a
 *      session is available.
 *
 *   3. Privacy Policy modal accessible from AuthScreen.
 *      "Privacy Policy" text in the legal footer is now tappable and
 *      opens the PrivacyPolicyScreen inline. This is required by:
 *        • Google Play data safety section
 *        • Apple App Store review guideline 5.1.1
 *        • COPPA §312.4 (link in first place where data is collected)
 *
 *   4. Sign-in and sign-up paths separated into distinct functions.
 *      handleSubmit() → routes to gate (sign_up) or sign-in directly.
 *      performSignIn() → Supabase signInWithPassword.
 *      performSignUp(meta) → Supabase signUp with consent metadata.
 *
 * Two modes toggled inline — no separate screens:
 *   "sign_in"  → email + password + "Sign in" button
 *   "sign_up"  → display name + email + password + confirm + "Create account"
 *               → triggers ConsentGateModal first
 *
 * After successful auth the navigator's onAuthStateChange listener
 * (in App.tsx) will redirect to ChildSwitcher automatically.
 */

import React, { useState, useRef, useCallback, useEffect } from "react";
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
  Modal,
  Linking,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { supabase } from "../lib/supabase";
import { ConsentGateModal, ConsentMetadata } from "../components/ConsentGateModal";
import { PrivacyPolicyScreen }               from "../components/PrivacyPolicyScreen";

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
  white:       "#ffffff",
} as const;

// ─── Field state hook ─────────────────────────────────────────────────────────

interface FieldState { value: string; touched: boolean; error: string | null; }

function useField(initial = ""): [FieldState, (v: string) => void, () => void] {
  const [state, setState] = useState<FieldState>({ value: initial, touched: false, error: null });
  const setValue = useCallback((v: string) => setState((s) => ({ ...s, value: v, error: null })), []);
  const touch    = useCallback(() => setState((s) => ({ ...s, touched: true })), []);
  return [state, setValue, touch];
}

// ─── Validators ───────────────────────────────────────────────────────────────

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

// ─── Inline field error ───────────────────────────────────────────────────────

function FieldError({ message }: { message: string }) {
  return <Text style={styles.fieldError}>{message}</Text>;
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export function AuthScreen() {
  const insets = useSafeAreaInsets();

  const [mode,    setMode]    = useState<AuthMode>("sign_in");
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [success,  setSuccess]  = useState(false);
  // Set to true when the app is reopened via the confirmation deep link,
  // so we can show a "Email confirmed! Sign in below." banner.
  const [emailConfirmed, setEmailConfirmed] = useState(false);

  // Detect cold-start via confirmation link (warm-start is handled in App.tsx)
  useEffect(() => {
    Linking.getInitialURL().then((url: string | null) => {
      if (url?.includes("auth/confirm")) setEmailConfirmed(true);
    });
    const sub = Linking.addEventListener("url", ({ url }: { url: string }) => {
      if (url?.includes("auth/confirm")) {
        setEmailConfirmed(true);
        // Switch to sign-in so the user can immediately log in
        setMode("sign_in");
      }
    });
    return () => sub.remove();
  }, []);

  // Phase 4.1: Consent + privacy state
  const [showConsentGate,  setShowConsentGate]  = useState(false);
  const [showPrivacyPolicy, setShowPrivacyPolicy] = useState(false);

  // Phase 4.1: Deletion-recovery state — set when sign-in detects a pending deletion
  const [pendingDeletion, setPendingDeletion] = useState<{
    daysLeft: number;
    restoringAccount: boolean;
  } | null>(null);

  // Fields
  const [displayName, setDisplayName, touchDisplayName] = useField();
  const [email,       setEmail,       touchEmail]       = useField();
  const [password,    setPassword,    touchPassword]    = useField();
  const [confirm,     setConfirm,     touchConfirm]     = useField();

  // Mode-switch animation
  const fadeAnim = useRef(new Animated.Value(1)).current;

  const switchMode = (next: AuthMode) => {
    setApiError(null);
    Animated.sequence([
      Animated.timing(fadeAnim, { toValue: 0, duration: 120, useNativeDriver: true }),
      Animated.timing(fadeAnim, { toValue: 1, duration: 180, useNativeDriver: true }),
    ]).start();
    setTimeout(() => setMode(next), 120);
  };

  // ── Validation ──────────────────────────────────────────────────────────────
  const validate = (): boolean => {
    let ok = true;

    if (mode === "sign_up" && !displayName.value.trim()) {
      touchDisplayName(); ok = false;
    }
    if (validateEmail(email.value)) { touchEmail(); ok = false; }
    if (validatePassword(password.value)) { touchPassword(); ok = false; }
    if (mode === "sign_up" && password.value !== confirm.value) {
      touchConfirm(); ok = false;
    }

    return ok;
  };

  // ── Sign-in ─────────────────────────────────────────────────────────────────
  const performSignIn = useCallback(async () => {
    setLoading(true);
    setApiError(null);
    setPendingDeletion(null);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email:    email.value.trim(),
        password: password.value,
      });
      if (error) throw error;

      // ── Deletion-pending guard ─────────────────────────────────────────────
      // If the parent requested deletion within the last 30 days, block full
      // navigation but present a "Restore account" option instead of a dead end.
      const scheduledAt = data.session?.user?.app_metadata?.deletion_scheduled_at;
      if (scheduledAt) {
        const daysLeft = Math.ceil(
          (new Date(scheduledAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
        );
        // Keep the session alive so cancel-deletion can use the JWT.
        // DO NOT sign out here — we need the session for the restore flow.
        setPendingDeletion({ daysLeft, restoringAccount: false });
        return;
      }
      // onAuthStateChange in App.tsx handles navigation on success
    } catch (err: any) {
      const msg: string = err?.message ?? "Something went wrong";
      if (msg.includes("Invalid login credentials")) {
        setApiError("Email or password is incorrect.");
      } else {
        setApiError(msg);
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoading(false);
    }
  }, [email.value, password.value]);

  // ── Restore account (cancel pending deletion) ────────────────────────────
  // Called from the deletion-recovery banner in the sign-in form.
  const handleRestoreAccount = useCallback(async () => {
    if (!pendingDeletion) return;
    setPendingDeletion((p) => p ? { ...p, restoringAccount: true } : null);
    try {
      const { error } = await supabase.functions.invoke("cancel-deletion", {});
      if (error) throw error;
      // Deletion cleared — onAuthStateChange will now navigate normally
      setPendingDeletion(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: any) {
      setPendingDeletion((p) => p ? { ...p, restoringAccount: false } : null);
      setApiError("Could not restore account: " + (err?.message ?? "Unknown error"));
    }
  }, [pendingDeletion]);

  // ── Dismiss pending-deletion state and sign out ───────────────────────────
  const handleKeepDeletion = useCallback(async () => {
    setPendingDeletion(null);
    await supabase.auth.signOut();
  }, []);

  // ── Sign-up (called after consent gate passes) ───────────────────────────────
  const performSignUp = useCallback(async (meta: ConsentMetadata) => {
    setLoading(true);
    setApiError(null);
    try {
      const { data, error } = await supabase.auth.signUp({
        email:    email.value.trim(),
        password: password.value,
        options: {
          // Deep-link the confirmation email back into the app (not localhost).
          // App.tsx handles this URL via Linking and calls exchangeCodeForSession().
          emailRedirectTo: "lexilens://auth/confirm",
          data: {
            display_name: displayName.value.trim(),
            // Consent metadata stored in raw_user_meta_data for reference.
            // The DB trigger approach was removed (postgres doesn't own auth.users
            // in Supabase — ERROR 42501). Consent is recorded below instead,
            // using the user's own JWT immediately after signup.
            consent_policy_version:          meta.policyVersion,
            consent_consented_at:            meta.consentedAt,
            consent_coppa_confirmed:         meta.coppaConfirmed,
            consent_gdpr_k_confirmed:        meta.gdprKConfirmed,
            consent_ai_processing_confirmed: meta.aiProcessingConfirmed,
            consent_parental_gate_passed:    meta.parentalGatePassed,
          },
        },
      });

      if (error) throw error;

      // ── Record parental consent via Edge Function ──────────────────────────
      // We call the record-consent Edge Function (service role) instead of
      // inserting directly from the client. This works regardless of whether
      // email confirmation is enabled (data.session may be null, but data.user
      // is always returned on successful signUp).
      if (data.user) {
        try {
          const { error: fnError } = await supabase.functions.invoke("record-consent", {
            body: {
              userId:                data.user.id,
              policyVersion:         meta.policyVersion,
              consentedAt:           meta.consentedAt,
              coppaConfirmed:        meta.coppaConfirmed,
              gdprKConfirmed:        meta.gdprKConfirmed,
              aiProcessingConfirmed: meta.aiProcessingConfirmed,
              parentalGatePassed:    meta.parentalGatePassed,
            },
          });
          if (fnError) {
            // Non-fatal — consent metadata is in raw_user_meta_data as backup.
            console.warn("[consent] record-consent function error:", fnError.message);
          }
        } catch (consentErr: any) {
          console.warn("[consent] record-consent call failed:", consentErr?.message);
        }
      }

      // Email verification pending — session will be null until the link is clicked
      if (data.session === null) {
        setSuccess(true);
      }
      // If session is immediately available, onAuthStateChange in App.tsx handles redirect
    } catch (err: any) {
      const msg: string = err?.message ?? "Something went wrong";
      if (msg.includes("already registered")) {
        setApiError(
          "An account with this email already exists. " +
          "If you recently deleted this account, it will be permanently removed " +
          "within 30 days — after which you can register again. " +
          "To restore it now, sign in and choose \"Keep account\"."
        );
      } else {
        setApiError(msg);
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoading(false);
    }
  }, [email.value, password.value, displayName.value]);

  // ── Primary "submit" handler ─────────────────────────────────────────────────
  // Routes to consent gate for sign_up, or sign-in directly.
  const handleSubmit = useCallback(async () => {
    if (!validate()) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }

    if (mode === "sign_up") {
      // COPPA requirement: show parental gate + consent form BEFORE any API call
      setShowConsentGate(true);
      return;
    }

    await performSignIn();
  }, [mode, validate, performSignIn]);

  // ── Consent gate callbacks ───────────────────────────────────────────────────
  const handleConsented = useCallback((meta: ConsentMetadata) => {
    setShowConsentGate(false);
    performSignUp(meta);
  }, [performSignUp]);

  const handleConsentCancelled = useCallback(() => {
    setShowConsentGate(false);
  }, []);

  // ── Email verification success screen ────────────────────────────────────────
  if (success) {
    return (
      <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.successEmoji}>📬</Text>
        <Text style={styles.successTitle}>Check your email</Text>
        <Text style={styles.successBody}>
          We sent a confirmation link to{"\n"}
          <Text style={{ fontWeight: "600" }}>{email.value.trim()}</Text>
          {"\n\n"}
          Tap it to activate your account, then come back and sign in.
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

  // ── Main form ─────────────────────────────────────────────────────────────────
  return (
    <>
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
            <Text style={styles.wordmarkSub}>Vocabulary Adventure for Children</Text>
          </View>

          <Animated.View style={[styles.card, { opacity: fadeAnim }]}>
            <Text style={styles.formTitle}>
              {mode === "sign_in" ? "Welcome back" : "Create a parent account"}
            </Text>
            <Text style={styles.formSub}>
              {mode === "sign_in"
                ? "Sign in to manage your child's vocabulary progress."
                : "One account for the whole family. You control all child profiles."}
            </Text>

            {/* Email-confirmed banner — shown when user returns via confirmation link */}
            {emailConfirmed && !apiError && (
              <View style={styles.confirmedBox}>
                <Text style={styles.confirmedText}>
                  ✅ Email confirmed! Sign in below to start your adventure.
                </Text>
              </View>
            )}

            {/* API-level error */}
            {apiError && (
              <View style={styles.apiErrorBox}>
                <Text style={styles.apiErrorText}>{apiError}</Text>
              </View>
            )}

            {/* Deletion-recovery banner — shown instead of dead-end error */}
            {pendingDeletion && !apiError && (
              <View style={styles.deletionRecoveryBox}>
                <Text style={styles.deletionRecoveryTitle}>
                  ⏳ Account scheduled for deletion
                </Text>
                <Text style={styles.deletionRecoveryBody}>
                  {"Your account will be permanently deleted in "}
                  <Text style={{ fontWeight: "700" }}>
                    {pendingDeletion.daysLeft} day{pendingDeletion.daysLeft !== 1 ? "s" : ""}
                  </Text>
                  {". Child data has already been removed."}
                </Text>
                <Text style={styles.deletionRecoveryBody}>
                  {"Changed your mind? You can restore your account now."}
                </Text>
                <View style={styles.deletionRecoveryActions}>
                  <TouchableOpacity
                    style={[
                      styles.restoreBtn,
                      pendingDeletion.restoringAccount && { opacity: 0.6 },
                    ]}
                    onPress={handleRestoreAccount}
                    disabled={pendingDeletion.restoringAccount}
                    accessibilityLabel="Restore account and cancel deletion"
                  >
                    <Text style={styles.restoreBtnText}>
                      {pendingDeletion.restoringAccount ? "Restoring…" : "✓ Restore my account"}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.keepDeletionBtn}
                    onPress={handleKeepDeletion}
                    accessibilityLabel="Keep deletion and sign out"
                  >
                    <Text style={styles.keepDeletionBtnText}>Keep deletion</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* Display name (sign-up only) */}
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

            {/* Confirm password (sign-up only) */}
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

            {/* COPPA notice for sign-up */}
            {mode === "sign_up" && (
              <View style={styles.coppaNoticeBox}>
                <Text style={styles.coppaNoticeText}>
                  🔐  Tapping "Create account" will open a{" "}
                  <Text style={styles.coppaNoticeBold}>parent verification step</Text>{" "}
                  required by COPPA children's privacy law.
                </Text>
              </View>
            )}

            {/* Submit */}
            <TouchableOpacity
              style={[styles.submitBtn, loading && styles.submitBtnDisabled]}
              onPress={handleSubmit}
              disabled={loading}
              accessibilityRole="button"
              accessibilityLabel={mode === "sign_in" ? "Sign in" : "Create account — opens parental consent"}
            >
              {loading ? (
                <ActivityIndicator color={P.white} />
              ) : (
                <Text style={styles.submitBtnText}>
                  {mode === "sign_in" ? "Sign in" : "Create account →"}
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

          {/* Legal footer with tappable Privacy Policy */}
          <Text style={styles.legalText}>
            By creating an account you agree to our{" "}
            <Text
              style={styles.legalLink}
              onPress={() => setShowPrivacyPolicy(true)}
              accessibilityRole="link"
              accessibilityLabel="Read our Privacy Policy"
            >
              Privacy Policy
            </Text>
            .{"\n"}
            Lexi-Lens complies with COPPA — no personal data is collected from children.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* ── COPPA Parental Gate + Consent ──────────────────────────── */}
      <ConsentGateModal
        visible={showConsentGate}
        onConsented={handleConsented}
        onCancel={handleConsentCancelled}
        onOpenPrivacyPolicy={() => {
          setShowConsentGate(false);
          setShowPrivacyPolicy(true);
        }}
      />

      {/* ── Privacy Policy full-screen modal ───────────────────────── */}
      <Modal
        visible={showPrivacyPolicy}
        animationType="slide"
        transparent={false}
        onRequestClose={() => setShowPrivacyPolicy(false)}
        statusBarTranslucent
      >
        <PrivacyPolicyScreen onClose={() => setShowPrivacyPolicy(false)} />
      </Modal>
    </>
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
  // Email-confirmed success banner
  confirmedBox: {
    backgroundColor: "#f0fdf4",
    borderRadius:    10,
    borderWidth:     1,
    borderColor:     "#86efac",
    padding:         12,
    marginBottom:    16,
  },
  confirmedText: { fontSize: 13, color: "#166534", lineHeight: 18, fontWeight: "600" },

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
    backgroundColor:   P.parchment,
    borderRadius:      10,
    borderWidth:       1,
    borderColor:       P.warmBorder,
    paddingHorizontal: 14,
    paddingVertical:   12,
    fontSize:          15,
    color:             P.inkBrown,
  },
  inputError:  { borderColor: "#fca5a5", backgroundColor: "#fff5f5" },
  fieldError:  { fontSize: 12, color: P.errorText, marginTop: 5 },

  // COPPA gate pre-notice
  coppaNoticeBox: {
    backgroundColor: P.amberLight,
    borderRadius:    10,
    borderWidth:     1,
    borderColor:     P.amberBorder,
    padding:         12,
    marginBottom:    16,
  },
  coppaNoticeText: { fontSize: 12, color: P.inkMid, lineHeight: 18 },
  coppaNoticeBold: { fontWeight: "700", color: P.inkBrown },

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

  // Legal footer
  legalText: {
    fontSize:   11,
    color:      P.inkFaint,
    textAlign:  "center",
    lineHeight: 17,
  },
  legalLink: {
    color:          P.amber,
    fontWeight:     "700",
    textDecorationLine: "underline",
  },

  // Success / email verification
  successEmoji: { fontSize: 56, marginBottom: 16 },
  successTitle: { fontSize: 22, fontWeight: "700", color: P.inkBrown, marginBottom: 12 },
  successBody:  { fontSize: 15, color: P.inkMid, textAlign: "center", lineHeight: 22, marginBottom: 32 },
  switchModeBtn: {
    borderWidth:       1,
    borderColor:       P.warmBorder,
    borderRadius:      12,
    paddingHorizontal: 24,
    paddingVertical:   12,
  },
  switchModeBtnText: { fontSize: 15, fontWeight: "600", color: P.inkMid },

  // Phase 4.1 — Deletion-recovery banner (shown at sign-in when account is pending deletion)
  deletionRecoveryBox: {
    backgroundColor: "#fffbeb",
    borderRadius:    12,
    borderWidth:     1.5,
    borderColor:     "#fcd34d",
    padding:         16,
    gap:             10,
  },
  deletionRecoveryTitle: {
    fontSize:   14,
    fontWeight: "700",
    color:      "#92400e",
  },
  deletionRecoveryBody: {
    fontSize:   13,
    color:      "#78350f",
    lineHeight: 19,
  },
  deletionRecoveryActions: {
    flexDirection: "row",
    gap:           10,
    marginTop:     4,
    flexWrap:      "wrap",
  },
  restoreBtn: {
    backgroundColor:   "#166534",
    borderRadius:      8,
    paddingHorizontal: 14,
    paddingVertical:   9,
  },
  restoreBtnText: {
    color:      "#fff",
    fontSize:   13,
    fontWeight: "600",
  },
  keepDeletionBtn: {
    borderRadius:      8,
    borderWidth:       1,
    borderColor:       "#d1d5db",
    paddingHorizontal: 14,
    paddingVertical:   9,
  },
  keepDeletionBtnText: {
    color:    "#9c7540",
    fontSize: 13,
  },
});
