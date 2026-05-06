/**
 * AuthScreen.tsx  (v4.5 — forgot password flow)
 * Lexi-Lens — parent authentication.
 *
 * CHANGES FROM v4.4:
 *
 *   1. Forgot-password flow.
 *      Tapping "Forgot password?" on the sign-in form opens a third mode
 *      that collects an email address and calls
 *      supabase.auth.resetPasswordForEmail(email, { redirectTo: ENV.deepLink.resetUrl }).
 *      A success-state mode follows ("Check your email").
 *
 *   2. Reset-confirmation mode.
 *      When the parent taps the reset link in the email, App.tsx handles
 *      the deep link, calls exchangeCodeForSession, and flips
 *      useAuthFlow().recoveryActive to true. This screen reads that flag
 *      and switches into "set new password" mode automatically. After
 *      supabase.auth.updateUser({ password }) succeeds, recoveryActive is
 *      cleared and the existing onAuthStateChange handler in App.tsx routes
 *      the now-authenticated parent to ChildSwitcher.
 *
 *   3. Deep-link scheme is now variant-aware.
 *      ENV.deepLink.confirmUrl / .resetUrl reflect the current APP_VARIANT
 *      (e.g. lexilensstaging://auth/reset on a staging build) so reset
 *      links from a staging password reset can't leak into a production app.
 *
 * Original v4.1 behaviour preserved verbatim:
 *   • ConsentGateModal in sign-up flow
 *   • Consent metadata recorded via record-consent Edge Function
 *   • Privacy Policy modal
 *   • Pending-deletion banner with Restore / Keep options
 *   • Email confirmation deep-link banner ("Email confirmed! Sign in below.")
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
import { ENV } from "../lib/env";
import { useAuthFlow } from "../lib/authFlow";
import { ConsentGateModal, ConsentMetadata } from "../components/ConsentGateModal";
import { PrivacyPolicyScreen }               from "../components/PrivacyPolicyScreen";

// ─── Types ────────────────────────────────────────────────────────────────────

type AuthMode =
  | "sign_in"
  | "sign_up"
  | "forgot_request"   // collect email, send reset link
  | "forgot_sent"      // success screen after sending the reset email
  | "reset_confirm";   // post-deep-link: set new password

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
  const [emailConfirmed, setEmailConfirmed] = useState(false);

  // v4.5 — recovery mode: flipped by App.tsx via useAuthFlow when a
  // password-reset deep link is processed. We listen for this and switch
  // into "set new password" mode immediately.
  const recoveryActive = useAuthFlow((s) => s.recoveryActive);
  const clearRecovery  = useAuthFlow((s) => s.clearRecovery);

  // Detect cold-start via auth-confirm or auth-reset deep links.
  // Warm-start is handled in App.tsx, but we also re-listen here for the
  // narrow purpose of UI state (confirmation banner, mode switch).
  useEffect(() => {
    const checkUrl = (url: string | null) => {
      if (!url) return;
      if (url.includes("auth/confirm")) {
        setEmailConfirmed(true);
        setMode("sign_in");
      } else if (url.includes("auth/reset")) {
        setMode("reset_confirm");
      }
    };
    Linking.getInitialURL().then(checkUrl);
    const sub = Linking.addEventListener("url", ({ url }) => checkUrl(url));
    return () => sub.remove();
  }, []);

  // Whenever App.tsx flips authFlow.recoveryActive to true, switch to
  // reset_confirm. This is the path that handles the live deep link too:
  // App.tsx sees the URL, calls beginRecovery(), this effect responds.
  useEffect(() => {
    if (recoveryActive) {
      setMode("reset_confirm");
      setApiError(null);
      setSuccess(false);
    }
  }, [recoveryActive]);

  // Phase 4.1: Consent + privacy state
  const [showConsentGate,  setShowConsentGate]  = useState(false);
  const [showPrivacyPolicy, setShowPrivacyPolicy] = useState(false);

  // Phase 4.1: Deletion-recovery state
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

    // Email is needed for sign_in, sign_up, forgot_request only.
    if (mode === "sign_in" || mode === "sign_up" || mode === "forgot_request") {
      if (validateEmail(email.value)) { touchEmail(); ok = false; }
    }

    // Password is needed for sign_in, sign_up, reset_confirm.
    if (mode === "sign_in" || mode === "sign_up" || mode === "reset_confirm") {
      if (validatePassword(password.value)) { touchPassword(); ok = false; }
    }

    // Confirm-password match is needed for sign_up + reset_confirm.
    if ((mode === "sign_up" || mode === "reset_confirm") && password.value !== confirm.value) {
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

      const scheduledAt = data.session?.user?.app_metadata?.deletion_scheduled_at;
      if (scheduledAt) {
        const daysLeft = Math.ceil(
          (new Date(scheduledAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
        );
        setPendingDeletion({ daysLeft, restoringAccount: false });
        return;
      }
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

  // ── Restore account (cancel pending deletion) ─────────────────────────────
  const handleRestoreAccount = useCallback(async () => {
    if (!pendingDeletion) return;
    setPendingDeletion((p) => p ? { ...p, restoringAccount: true } : null);
    try {
      const { error } = await supabase.functions.invoke("cancel-deletion", {});
      if (error) throw error;
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

  // ── Sign-up (called after consent gate passes) ────────────────────────────
  const performSignUp = useCallback(async (meta: ConsentMetadata) => {
    setLoading(true);
    setApiError(null);
    try {
      const { data, error } = await supabase.auth.signUp({
        email:    email.value.trim(),
        password: password.value,
        options: {
          emailRedirectTo: ENV.deepLink.confirmUrl,
          data: {
            display_name: displayName.value.trim(),
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
            console.warn("[consent] record-consent function error:", fnError.message);
          }
        } catch (consentErr: any) {
          console.warn("[consent] record-consent call failed:", consentErr?.message);
        }
      }

      if (data.session === null) {
        setSuccess(true);
      }
    } catch (err: any) {
      const msg: string = err?.message ?? "Something went wrong";
      if (msg.includes("already registered")) {
        setApiError(
          "An account with this email already exists. " +
          "If you recently deleted this account, it will be permanently removed " +
          "within 30 days — after which you can register again. " +
          "To restore it now, sign in and choose \"Keep account\".",
        );
      } else {
        setApiError(msg);
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoading(false);
    }
  }, [email.value, password.value, displayName.value]);

  // ── v4.5 — Send password reset email ──────────────────────────────────────
  const performForgotRequest = useCallback(async () => {
    setLoading(true);
    setApiError(null);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(
        email.value.trim(),
        { redirectTo: ENV.deepLink.resetUrl },
      );
      if (error) throw error;
      switchMode("forgot_sent");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: any) {
      // Supabase rate-limits this endpoint hard. Surface the message so the
      // parent knows whether to wait or check the email address.
      setApiError(err?.message ?? "Couldn't send the reset email. Try again in a minute.");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoading(false);
    }
  }, [email.value]);

  // ── v4.5 — Set the new password after the deep link ───────────────────────
  const performResetConfirm = useCallback(async () => {
    setLoading(true);
    setApiError(null);
    try {
      const { error } = await supabase.auth.updateUser({ password: password.value });
      if (error) throw error;

      // Recovery is done. Clear the flag so App.tsx's normal session →
      // AppNavigator routing kicks in.
      clearRecovery();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // No further action — onAuthStateChange will route to ChildSwitcher
      // because we're already authenticated.
    } catch (err: any) {
      setApiError(err?.message ?? "Couldn't update your password. Try again.");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoading(false);
    }
  }, [password.value, clearRecovery]);

  // ── Submit dispatcher ─────────────────────────────────────────────────────
  const handleSubmit = useCallback(() => {
    if (!validate()) return;
    Haptics.selectionAsync();

    switch (mode) {
      case "sign_in":
        performSignIn();
        break;
      case "sign_up":
        // Open consent gate first
        setShowConsentGate(true);
        break;
      case "forgot_request":
        performForgotRequest();
        break;
      case "reset_confirm":
        performResetConfirm();
        break;
      default:
        // forgot_sent has no submit
        break;
    }
  }, [mode, performSignIn, performForgotRequest, performResetConfirm]);

  // ── Consent gate handlers ─────────────────────────────────────────────────
  const handleConsented = useCallback((meta: ConsentMetadata) => {
    setShowConsentGate(false);
    performSignUp(meta);
  }, [performSignUp]);

  const handleConsentCancelled = useCallback(() => {
    setShowConsentGate(false);
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // Render — the form changes shape based on `mode`. A single ScrollView
  // contains the relevant fields + actions for each mode.
  // ─────────────────────────────────────────────────────────────────────────

  // After a successful sign-up the user must verify email.
  if (success && mode === "sign_up") {
    return (
      <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.successEmoji}>📧</Text>
        <Text style={styles.successTitle}>Check your email</Text>
        <Text style={styles.successBody}>
          We sent a confirmation link to{"\n"}
          <Text style={{ fontWeight: "700" }}>{email.value}</Text>{"\n\n"}
          Tap the link to finish creating your account.
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

  // ── Forgot-sent success screen ────────────────────────────────────────────
  if (mode === "forgot_sent") {
    return (
      <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.successEmoji}>🔑</Text>
        <Text style={styles.successTitle}>Check your email</Text>
        <Text style={styles.successBody}>
          We sent a password reset link to{"\n"}
          <Text style={{ fontWeight: "700" }}>{email.value}</Text>{"\n\n"}
          Tap the link to set a new password.
          {"\n\n"}
          <Text style={{ fontSize: 12, color: P.inkLight }}>
            Didn't see it? Check your spam folder. The link expires in 1 hour.
          </Text>
        </Text>
        <TouchableOpacity
          style={styles.switchModeBtn}
          onPress={() => switchMode("sign_in")}
        >
          <Text style={styles.switchModeBtnText}>Back to sign in</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Standard form (sign_in / sign_up / forgot_request / reset_confirm) ───
  return (
    <>
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scroll,
            { paddingTop: insets.top + 28, paddingBottom: insets.bottom + 32 },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >

          {/* ── Wordmark ──────────────────────────────────── */}
          <View style={styles.wordmark}>
            <Text style={styles.wordmarkEmoji}>📚</Text>
            <Text style={styles.wordmarkTitle}>Lexi-Lens</Text>
            <Text style={styles.wordmarkSub}>Vocabulary quests for curious kids</Text>
          </View>

          {/* ── Pending-deletion banner ───────────────────── */}
          {pendingDeletion && (
            <View style={[styles.card, { paddingVertical: 18 }]}>
              <View style={styles.deletionRecoveryBox}>
                <Text style={styles.deletionRecoveryTitle}>
                  ⏳ Deletion scheduled in {pendingDeletion.daysLeft} day{pendingDeletion.daysLeft !== 1 ? "s" : ""}
                </Text>
                <Text style={styles.deletionRecoveryBody}>
                  Your account is queued for permanent deletion.
                  Restore it now to keep all profiles, words, and progress.
                </Text>
                <View style={styles.deletionRecoveryActions}>
                  <TouchableOpacity
                    style={styles.restoreBtn}
                    onPress={handleRestoreAccount}
                    disabled={pendingDeletion.restoringAccount}
                  >
                    {pendingDeletion.restoringAccount
                      ? <ActivityIndicator color="#fff" size="small" />
                      : <Text style={styles.restoreBtnText}>Restore account</Text>
                    }
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.keepDeletionBtn} onPress={handleKeepDeletion}>
                    <Text style={styles.keepDeletionBtnText}>Sign out</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          )}

          {/* ── Email-confirmed banner (one-shot) ─────────── */}
          {emailConfirmed && !pendingDeletion && (
            <View style={[styles.card, { backgroundColor: "#ecfdf5", borderColor: "#a7f3d0", paddingVertical: 14 }]}>
              <Text style={{ color: "#047857", fontSize: 14, fontWeight: "600", textAlign: "center" }}>
                ✓ Email confirmed! Sign in below.
              </Text>
            </View>
          )}

          {/* ── Form card ─────────────────────────────────── */}
          {!pendingDeletion && (
            <Animated.View style={[styles.card, { opacity: fadeAnim }]}>
              <Text style={styles.formTitle}>
                {mode === "sign_in"        ? "Welcome back"
                 : mode === "sign_up"      ? "Create your account"
                 : mode === "forgot_request" ? "Reset your password"
                 : "Set a new password"}
              </Text>
              <Text style={styles.formSub}>
                {mode === "sign_in"        ? "Sign in to continue your child's adventure"
                 : mode === "sign_up"      ? "Track your child's vocabulary growth"
                 : mode === "forgot_request" ? "We'll email you a secure link to set a new password"
                 : "Choose a strong password (at least 8 characters)"}
              </Text>

              {/* API error banner */}
              {apiError && (
                <View style={styles.errorBox}>
                  <Text style={styles.errorText}>{apiError}</Text>
                </View>
              )}

              {/* Display name (sign_up only) */}
              {mode === "sign_up" && (
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>Your name</Text>
                  <TextInput
                    style={[styles.input, displayName.touched && !displayName.value.trim() && styles.inputError]}
                    placeholder="Mom, Dad, or your nickname"
                    placeholderTextColor={P.inkFaint}
                    value={displayName.value}
                    onChangeText={setDisplayName}
                    onBlur={touchDisplayName}
                    autoCapitalize="words"
                    autoCorrect={false}
                    returnKeyType="next"
                    accessibilityLabel="Display name"
                  />
                  {displayName.touched && !displayName.value.trim() && (
                    <FieldError message="Please tell us your name" />
                  )}
                </View>
              )}

              {/* Email — used by sign_in, sign_up, forgot_request */}
              {(mode === "sign_in" || mode === "sign_up" || mode === "forgot_request") && (
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>Email</Text>
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
                    returnKeyType={mode === "forgot_request" ? "done" : "next"}
                    onSubmitEditing={mode === "forgot_request" ? handleSubmit : undefined}
                    accessibilityLabel="Email address"
                  />
                  {email.touched && !!validateEmail(email.value) && (
                    <FieldError message={validateEmail(email.value)!} />
                  )}
                </View>
              )}

              {/* Password — sign_in, sign_up, reset_confirm */}
              {(mode === "sign_in" || mode === "sign_up" || mode === "reset_confirm") && (
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>
                    {mode === "reset_confirm" ? "New password" : "Password"}
                  </Text>
                  <TextInput
                    style={[
                      styles.input,
                      password.touched && !!validatePassword(password.value) && styles.inputError,
                    ]}
                    placeholder={
                      mode === "sign_up" || mode === "reset_confirm"
                        ? "At least 8 characters"
                        : "Your password"
                    }
                    placeholderTextColor={P.inkFaint}
                    value={password.value}
                    onChangeText={setPassword}
                    onBlur={touchPassword}
                    secureTextEntry
                    returnKeyType={
                      mode === "sign_up" || mode === "reset_confirm" ? "next" : "done"
                    }
                    onSubmitEditing={mode === "sign_in" ? handleSubmit : undefined}
                    accessibilityLabel={mode === "reset_confirm" ? "New password" : "Password"}
                  />
                  {password.touched && !!validatePassword(password.value) && (
                    <FieldError message={validatePassword(password.value)!} />
                  )}
                </View>
              )}

              {/* Forgot-password link (sign_in only) */}
              {mode === "sign_in" && (
                <TouchableOpacity
                  style={styles.forgotLinkRow}
                  onPress={() => switchMode("forgot_request")}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={styles.forgotLinkText}>Forgot password?</Text>
                </TouchableOpacity>
              )}

              {/* Confirm password — sign_up + reset_confirm */}
              {(mode === "sign_up" || mode === "reset_confirm") && (
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
                accessibilityLabel={
                  mode === "sign_in"        ? "Sign in"
                  : mode === "sign_up"      ? "Create account — opens parental consent"
                  : mode === "forgot_request" ? "Send password reset email"
                  : "Update password"
                }
              >
                {loading ? (
                  <ActivityIndicator color={P.white} />
                ) : (
                  <Text style={styles.submitBtnText}>
                    {mode === "sign_in"        ? "Sign in"
                     : mode === "sign_up"      ? "Create account →"
                     : mode === "forgot_request" ? "Send reset link"
                     : "Update password →"}
                  </Text>
                )}
              </TouchableOpacity>
            </Animated.View>
          )}

          {/* ── Mode toggle / back link ───────────────────── */}
          {!pendingDeletion && (
            <View style={styles.toggleRow}>
              {mode === "sign_in" && (
                <>
                  <Text style={styles.toggleText}>New to Lexi-Lens?</Text>
                  <TouchableOpacity onPress={() => switchMode("sign_up")}>
                    <Text style={styles.toggleLink}>Create account</Text>
                  </TouchableOpacity>
                </>
              )}
              {mode === "sign_up" && (
                <>
                  <Text style={styles.toggleText}>Already have an account?</Text>
                  <TouchableOpacity onPress={() => switchMode("sign_in")}>
                    <Text style={styles.toggleLink}>Sign in</Text>
                  </TouchableOpacity>
                </>
              )}
              {(mode === "forgot_request" || mode === "reset_confirm") && (
                <>
                  <Text style={styles.toggleText}>Remembered it?</Text>
                  <TouchableOpacity onPress={() => {
                    if (mode === "reset_confirm") clearRecovery();
                    switchMode("sign_in");
                  }}>
                    <Text style={styles.toggleLink}>Back to sign in</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          )}

          {/* Legal footer */}
          <Text style={styles.legalText}>
            By continuing you agree to the{" "}
            <Text style={styles.legalLink} onPress={() => setShowPrivacyPolicy(true)}>
              Privacy Policy
            </Text>
            .{"\n"}
            Lexi-Lens complies with COPPA — no personal data is collected from children.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* COPPA Parental Gate + Consent */}
      <ConsentGateModal
        visible={showConsentGate}
        onConsented={handleConsented}
        onCancel={handleConsentCancelled}
        onOpenPrivacyPolicy={() => {
          setShowConsentGate(false);
          setShowPrivacyPolicy(true);
        }}
      />

      {/* Privacy Policy full-screen modal */}
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
  errorBox: {
    backgroundColor: P.errorBg,
    borderColor:     P.errorBorder,
    borderWidth:     1,
    borderRadius:    10,
    padding:         12,
    marginBottom:    16,
  },
  errorText: { color: P.errorText, fontSize: 13, lineHeight: 19 },

  // Fields
  fieldGroup: { marginBottom: 16 },
  label:      { fontSize: 13, fontWeight: "600", color: P.inkBrown, marginBottom: 6 },
  input: {
    backgroundColor: P.parchment,
    borderColor:     P.warmBorder,
    borderWidth:     1,
    borderRadius:    10,
    paddingHorizontal: 14,
    paddingVertical:   Platform.OS === "ios" ? 13 : 11,
    fontSize:        15,
    color:           P.inkBrown,
  },
  inputError: { borderColor: P.errorBorder, backgroundColor: "#fff5f5" },
  fieldError: { color: P.errorText, fontSize: 11, marginTop: 4, marginLeft: 4 },

  // Forgot-password link
  forgotLinkRow: { alignSelf: "flex-end", marginTop: -4, marginBottom: 12 },
  forgotLinkText: { fontSize: 13, color: P.amber, fontWeight: "600" },

  // COPPA pre-submit notice
  coppaNoticeBox: {
    backgroundColor:   P.amberLight,
    borderColor:       P.amberBorder,
    borderWidth:       1,
    borderRadius:      10,
    padding:           12,
    marginBottom:      16,
  },
  coppaNoticeText: { fontSize: 12, color: P.inkMid, lineHeight: 18 },
  coppaNoticeBold: { fontWeight: "700", color: P.amber },

  // Submit
  submitBtn: {
    backgroundColor:   P.amber,
    borderRadius:      12,
    paddingVertical:   14,
    alignItems:        "center",
    marginTop:         4,
  },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText:     { color: P.white, fontSize: 15, fontWeight: "700" },

  // Toggle
  toggleRow: {
    flexDirection:  "row",
    justifyContent: "center",
    gap:            6,
    marginBottom:   24,
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

  // Phase 4.1 — Deletion-recovery banner
  deletionRecoveryBox: {
    backgroundColor: "#fffbeb",
    borderRadius:    12,
    borderWidth:     1.5,
    borderColor:     "#fcd34d",
    padding:         16,
    gap:             10,
  },
  deletionRecoveryTitle: { fontSize: 14, fontWeight: "700", color: "#92400e" },
  deletionRecoveryBody:  { fontSize: 13, color: "#78350f", lineHeight: 19 },
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
  restoreBtnText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  keepDeletionBtn: {
    borderRadius:      8,
    borderWidth:       1,
    borderColor:       "#d1d5db",
    paddingHorizontal: 14,
    paddingVertical:   9,
  },
  keepDeletionBtnText: { color: "#9c7540", fontSize: 13 },
});
