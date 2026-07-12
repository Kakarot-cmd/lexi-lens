/**
 * ParentPinGateModal.tsx
 * Lexi-Lens — Parent PIN gate for parent-only features (Phase 3.3 security)
 *
 * Two modes:
 *   SET  — first launch, parent creates a 4-digit PIN (enter + confirm)
 *   VERIFY — subsequent launches, parent enters PIN to unlock
 *
 * "Forgot PIN" flow:
 *   Re-authenticates via Supabase email + password.
 *   On success, clears the stored PIN → falls back to SET mode.
 *
 * Storage:
 *   AsyncStorage key: `lexi:parent_pin:<parentId>`
 *   Value: 4-digit string (this is a UX gate, not a crypto secret —
 *   the real security is Supabase session auth which is already required
 *   to reach any screen that renders this modal).
 *
 * Usage:
 *   const [pinVisible, setPinVisible] = useState(false);
 *
 *   <TouchableOpacity onPress={() => setPinVisible(true)}>
 *     <Text>AI Quest Creator</Text>
 *   </TouchableOpacity>
 *
 *   <ParentPinGateModal
 *     visible={pinVisible}
 *     parentId={session.user.id}
 *     parentEmail={session.user.email}
 *     onSuccess={() => {
 *       setPinVisible(false);
 *       navigation.navigate("QuestGenerator");
 *     }}
 *     onDismiss={() => setPinVisible(false)}
 *   />
 *
 * Dependencies (already in project):
 *   @react-native-async-storage/async-storage
 *   @supabase/supabase-js
 *   expo-haptics
 */

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
} from "react";
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  TextInput,
  Platform,
  ActivityIndicator,
} from "react-native";
import { KeyboardAwareView } from "./KeyboardAware";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "../lib/supabase";
import { ParentalGateChallenge } from "./ParentalGateChallenge";

// ─── Palette (matches the app's dark purple theme) ───────────────────────────

const C = {
  bg:         "#0f0620",
  surface:    "#1a0f35",
  surfaceAlt: "#231445",
  border:     "#3d2080",
  borderFaint:"#2a1660",
  gold:       "#f5c842",
  goldDim:    "#b8922e",
  purple:     "#7c3aed",
  purpleLight:"#a78bfa",
  purplePale: "#ede9fe",
  textPrime:  "#f3e8ff",
  textMuted:  "#a78bfa",
  textDim:    "#5b4fa0",
  red:        "#ef4444",
  redBg:      "#2d0a0a",
  green:      "#22c55e",
  greenBg:    "#052e16",
};

const PIN_LENGTH = 4;
const STORAGE_PREFIX = "lexi:parent_pin:";
const MAX_ATTEMPTS = 5;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function loadStoredPin(parentId: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(`${STORAGE_PREFIX}${parentId}`);
  } catch {
    return null;
  }
}

async function savePin(parentId: string, pin: string): Promise<void> {
  await AsyncStorage.setItem(`${STORAGE_PREFIX}${parentId}`, pin);
}

async function clearPin(parentId: string): Promise<void> {
  await AsyncStorage.removeItem(`${STORAGE_PREFIX}${parentId}`);
}

// ─── PIN dot indicators ───────────────────────────────────────────────────────

function PinDots({ filled, shake }: { filled: number; shake: Animated.Value }) {
  return (
    <Animated.View
      style={[
        styles.dotsRow,
        {
          transform: [{
            translateX: shake.interpolate({
              inputRange:  [0, 0.2, 0.4, 0.6, 0.8, 1],
              outputRange: [0, -10, 10, -10, 10, 0],
            }),
          }],
        },
      ]}
    >
      {Array.from({ length: PIN_LENGTH }).map((_, i) => (
        <View
          key={i}
          style={[
            styles.dot,
            i < filled && styles.dotFilled,
          ]}
        />
      ))}
    </Animated.View>
  );
}

// ─── Number pad ───────────────────────────────────────────────────────────────

const PAD_KEYS = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  ["", "0", "⌫"],
];

function NumberPad({
  onPress,
  disabled,
}: {
  onPress: (key: string) => void;
  disabled: boolean;
}) {
  return (
    <View style={styles.pad}>
      {PAD_KEYS.map((row, ri) => (
        <View key={ri} style={styles.padRow}>
          {row.map((key, ki) => (
            <TouchableOpacity
              key={ki}
              style={[styles.padKey, !key && styles.padKeyEmpty]}
              onPress={() => key && onPress(key)}
              disabled={disabled || !key}
              activeOpacity={0.65}
            >
              {key ? (
                <Text style={styles.padKeyText}>{key}</Text>
              ) : null}
            </TouchableOpacity>
          ))}
        </View>
      ))}
    </View>
  );
}

// ─── Forgot PIN sub-view ──────────────────────────────────────────────────────

function ForgotPinView({
  parentEmail,
  parentId,
  onRecovered,
  onCancel,
}: {
  parentEmail: string;
  parentId:   string;
  onRecovered: () => void;
  onCancel:    () => void;
}) {
  // ── Which re-auth method does THIS account actually have? ───────────────────
  //
  // The original implementation hard-coded supabase.auth.signInWithPassword().
  // That silently assumed every parent is an email/password signup. Since the
  // native Google + Apple ID-token flow shipped (2026-06-23), OAuth parents
  // have NO Supabase password at all — signInWithPassword returns "Invalid
  // login credentials" for them no matter what they type, so a forgotten PIN
  // locked them out of Parent Hub permanently, and with it out of
  // "Account & Privacy → Delete Account & Data" (Guideline 5.1.1(v)).
  //
  // Fix: branch on the account's real identities.
  //   • has an `email` identity  → password re-auth (unchanged; zero regression
  //     on the path App Review uses, since the demo account is email/password)
  //   • OAuth-only (google/apple) → one-time code emailed to the account address
  //
  // Why an emailed code and NOT "just re-run Google/Apple sign-in": the native
  // provider sheet can be satisfied with a single tap on an already-signed-in
  // account (and Apple's is satisfied by whatever face is enrolled on the
  // device — which on a kid's iPad is the kid). That would make the PIN
  // decorative: a child solves the arithmetic gate, taps "Forgot PIN", taps
  // the Google chip, and resets the parent's PIN. Control of the parent's
  // inbox is the ownership proof this app already relies on for COPPA consent,
  // and a child does not have it.
  type ReauthMethod = "loading" | "password" | "otp";

  const [method,   setMethod]     = useState<ReauthMethod>("loading");
  const [provider, setProvider]   = useState<string>("");
  const [password, setPassword]   = useState("");
  const [code,     setCode]       = useState("");
  const [codeSent, setCodeSent]   = useState(false);
  const [cooldown, setCooldown]   = useState(0);
  const [loading,  setLoading]    = useState(false);
  const [error,    setError]      = useState<string | null>(null);
  const [success,  setSuccess]    = useState(false);

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (cancelled) return;
      const identities = user?.identities ?? [];
      const hasEmail =
        identities.some((i) => i.provider === "email") ||
        // Defensive: if identities is unavailable for any reason, fall back to
        // the previous behaviour rather than locking an email user out.
        identities.length === 0;
      const social = identities.find((i) => i.provider !== "email");
      setProvider(social?.provider === "apple" ? "Apple" : social?.provider === "google" ? "Google" : "");
      setMethod(hasEmail ? "password" : "otp");
    });
    return () => { cancelled = true; };
  }, []);

  // Resend cooldown
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => setCooldown((c) => (c <= 1 ? 0 : c - 1)), 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  const finish = useCallback(async () => {
    await clearPin(parentId);
    setSuccess(true);
    setLoading(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setTimeout(onRecovered, 900);
  }, [parentId, onRecovered]);

  // ── Path A: email/password accounts (unchanged behaviour) ───────────────────
  const handleRecover = async () => {
    if (!password) return;
    setLoading(true);
    setError(null);

    const { error: authErr } = await supabase.auth.signInWithPassword({
      email:    parentEmail,
      password,
    });

    if (authErr) {
      setError("Incorrect password. Please try again.");
      setLoading(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    await finish();
  };

  // ── Path B: OAuth-only accounts — emailed one-time code ─────────────────────
  const handleSendCode = async () => {
    if (!parentEmail) {
      setError("No email address is attached to this account. Contact support.");
      return;
    }
    setLoading(true);
    setError(null);

    // shouldCreateUser:false — this must never mint a new account, only
    // re-verify the existing one.
    const { error: otpErr } = await supabase.auth.signInWithOtp({
      email:   parentEmail,
      options: { shouldCreateUser: false },
    });

    setLoading(false);

    if (otpErr) {
      setError("Could not send the code. Please try again in a minute.");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    setCodeSent(true);
    setCooldown(60);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const handleVerifyCode = async () => {
    if (code.length < 6) return;
    setLoading(true);
    setError(null);

    const { error: verifyErr } = await supabase.auth.verifyOtp({
      email: parentEmail,
      token: code,
      type:  "email",
    });

    if (verifyErr) {
      setError("That code isn't right, or it has expired.");
      setCode("");
      setLoading(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    await finish();
  };

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (success) {
    return (
      <View style={styles.forgotWrap}>
        <Text style={styles.successIcon}>✓</Text>
        <Text style={styles.forgotTitle}>Identity confirmed</Text>
        <Text style={styles.forgotSub}>You can now set a new PIN.</Text>
      </View>
    );
  }

  if (method === "loading") {
    return (
      <View style={styles.forgotWrap}>
        <ActivityIndicator color={C.purpleLight} size="large" />
      </View>
    );
  }

  if (method === "otp") {
    return (
      <View style={styles.forgotWrap}>
        <Text style={styles.forgotTitle}>Confirm your identity</Text>
        <Text style={styles.forgotSub}>
          {provider
            ? `This account signs in with ${provider}, so it has no password. We'll email a one-time code instead.`
            : "We'll email a one-time code to confirm it's you."}
        </Text>

        <Text style={styles.emailLabel}>{parentEmail}</Text>

        {codeSent && (
          <TextInput
            style={styles.passwordInput}
            placeholder="6-digit code"
            placeholderTextColor={C.textDim}
            keyboardType="number-pad"
            maxLength={6}
            value={code}
            onChangeText={(t) => { setCode(t.replace(/[^0-9]/g, "")); setError(null); }}
            autoFocus
            editable={!loading}
          />
        )}

        {error && <Text style={styles.errorText}>{error}</Text>}

        {codeSent && (
          <TouchableOpacity
            style={styles.resendLink}
            onPress={handleSendCode}
            disabled={loading || cooldown > 0}
          >
            <Text style={styles.resendText}>
              {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
            </Text>
          </TouchableOpacity>
        )}

        <View style={styles.forgotBtnRow}>
          <TouchableOpacity
            style={styles.forgotCancelBtn}
            onPress={onCancel}
            disabled={loading}
          >
            <Text style={styles.forgotCancelText}>Cancel</Text>
          </TouchableOpacity>

          {codeSent ? (
            <TouchableOpacity
              style={[styles.forgotConfirmBtn, code.length < 6 && styles.btnDisabled]}
              onPress={handleVerifyCode}
              disabled={loading || code.length < 6}
            >
              {loading
                ? <ActivityIndicator color={C.bg} size="small" />
                : <Text style={styles.forgotConfirmText}>Confirm</Text>
              }
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.forgotConfirmBtn}
              onPress={handleSendCode}
              disabled={loading}
            >
              {loading
                ? <ActivityIndicator color={C.bg} size="small" />
                : <Text style={styles.forgotConfirmText}>Email me a code</Text>
              }
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.forgotWrap}>
      <Text style={styles.forgotTitle}>Confirm your identity</Text>
      <Text style={styles.forgotSub}>
        Enter your Skanlore account password to reset your PIN.
      </Text>

      <Text style={styles.emailLabel}>{parentEmail}</Text>

      <TextInput
        style={styles.passwordInput}
        placeholder="Account password"
        placeholderTextColor={C.textDim}
        secureTextEntry
        value={password}
        onChangeText={(t) => { setPassword(t); setError(null); }}
        autoFocus
        editable={!loading}
      />

      {error && <Text style={styles.errorText}>{error}</Text>}

      <View style={styles.forgotBtnRow}>
        <TouchableOpacity
          style={styles.forgotCancelBtn}
          onPress={onCancel}
          disabled={loading}
        >
          <Text style={styles.forgotCancelText}>Cancel</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.forgotConfirmBtn, !password && styles.btnDisabled]}
          onPress={handleRecover}
          disabled={loading || !password}
        >
          {loading
            ? <ActivityIndicator color={C.bg} size="small" />
            : <Text style={styles.forgotConfirmText}>Confirm</Text>
          }
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Main modal ───────────────────────────────────────────────────────────────

interface ParentPinGateModalProps {
  visible:     boolean;
  parentId:    string;
  parentEmail: string;
  onSuccess:   () => void;
  onDismiss:   () => void;
  /**
   * APPLE GUIDELINE 1.3 (Kids Category) — commerce surfaces.
   *
   * When true, the randomised arithmetic ParentalGateChallenge runs on EVERY
   * open and is the sole unlock; the PIN is never consulted. Set this on any
   * surface that can reach a real purchase. Rationale: a PIN is a shared
   * secret a child can watch a parent type, AND on a fresh install (the state
   * App Review is always in) there is no PIN at all, so the modal would open
   * in SET mode and let the user invent their own gate. A randomised
   * challenge has no stored state, so it cannot be pre-satisfied, disabled,
   * memorised, or reset by reinstalling.
   *
   * When false/absent (parent-only, non-commerce surfaces: Parent Hub entry,
   * child-profile deletion) the PIN flow is kept, but the challenge is now
   * mandatory before a PIN can be CREATED — closing the same fresh-install
   * hole on those surfaces too.
   */
  alwaysChallenge?: boolean;
}

type ModalMode = "loading" | "challenge" | "set" | "confirm_set" | "verify" | "forgot";

/** What happens once the arithmetic challenge is passed. */
type ChallengeIntent = "unlock" | "set";

export function ParentPinGateModal({
  visible,
  parentId,
  parentEmail,
  onSuccess,
  onDismiss,
  alwaysChallenge = false,
}: ParentPinGateModalProps) {
  const insets = useSafeAreaInsets();

  const [mode,        setMode]        = useState<ModalMode>("loading");
  const [pin,         setPin]         = useState("");
  const [firstPin,    setFirstPin]    = useState("");  // SET mode: stores first entry
  const [attempts,    setAttempts]    = useState(0);
  const [errorMsg,    setErrorMsg]    = useState<string | null>(null);
  const [locked,      setLocked]      = useState(false);
  const [challengeIntent, setChallengeIntent] = useState<ChallengeIntent>("unlock");

  const shakeAnim  = useRef(new Animated.Value(0)).current;
  const fadeAnim   = useRef(new Animated.Value(0)).current;

  // Determine mode when modal opens
  useEffect(() => {
    if (!visible) {
      // Reset all local state when modal closes
      setTimeout(() => {
        setPin("");
        setFirstPin("");
        setErrorMsg(null);
        setMode("loading");
        setAttempts(0);
        setLocked(false);
        setChallengeIntent("unlock");
      }, 300);
      return;
    }

    setMode("loading");

    const reveal = () => {
      fadeAnim.setValue(0);
      Animated.timing(fadeAnim, {
        toValue: 1, duration: 220, useNativeDriver: true,
      }).start();
    };

    // Commerce surfaces: the challenge IS the gate, every time. No PIN read,
    // no PIN write, no state that could make it a no-op.
    if (alwaysChallenge) {
      setChallengeIntent("unlock");
      setMode("challenge");
      reveal();
      return;
    }

    loadStoredPin(parentId).then((stored) => {
      if (stored) {
        setMode("verify");
      } else {
        // No PIN yet. Previously this dropped straight into SET mode, which
        // let ANY user (child or App Reviewer on a fresh install) define the
        // gate themselves and walk through it. The challenge now stands in
        // front of PIN creation.
        setChallengeIntent("set");
        setMode("challenge");
      }
      reveal();
    });
  }, [visible, parentId, alwaysChallenge]);

  // ── Shake animation on wrong PIN ────────────────────────────────────────────
  const triggerShake = useCallback(() => {
    shakeAnim.setValue(0);
    Animated.timing(shakeAnim, {
      toValue: 1, duration: 400, useNativeDriver: true,
    }).start(() => shakeAnim.setValue(0));
  }, []);

  // ── Handle number pad key press ─────────────────────────────────────────────
  const handleKey = useCallback(async (key: string) => {
    if (locked) return;

    if (key === "⌫") {
      setPin((p) => p.slice(0, -1));
      setErrorMsg(null);
      return;
    }

    const next = pin + key;
    if (next.length > PIN_LENGTH) return;
    setPin(next);
    setErrorMsg(null);
    Haptics.selectionAsync();

    if (next.length < PIN_LENGTH) return;

    // ── Full PIN entered ───────────────────────────────────────────────────
    await new Promise((r) => setTimeout(r, 120)); // let last dot render

    if (mode === "set") {
      // First entry in SET mode → move to confirm
      setFirstPin(next);
      setPin("");
      setMode("confirm_set");
      return;
    }

    if (mode === "confirm_set") {
      if (next === firstPin) {
        // PINs match → save and unlock
        await savePin(parentId, next);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setPin(next);
        setTimeout(onSuccess, 250);
      } else {
        // Mismatch → restart SET flow
        triggerShake();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setErrorMsg("PINs don't match. Start again.");
        setPin("");
        setFirstPin("");
        setTimeout(() => { setMode("set"); setErrorMsg(null); }, 1400);
      }
      return;
    }

    if (mode === "verify") {
      const stored = await loadStoredPin(parentId);
      if (next === stored) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setPin(next);
        setTimeout(onSuccess, 250);
      } else {
        triggerShake();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        const newAttempts = attempts + 1;
        setAttempts(newAttempts);
        setPin("");

        if (newAttempts >= MAX_ATTEMPTS) {
          setLocked(true);
          setErrorMsg("Too many incorrect attempts.\nPlease use Forgot PIN.");
        } else {
          const left = MAX_ATTEMPTS - newAttempts;
          setErrorMsg(
            left === 1
              ? "Incorrect PIN. 1 attempt left."
              : `Incorrect PIN. ${left} attempts left.`
          );
        }
      }
    }
  }, [pin, mode, firstPin, parentId, attempts, locked, triggerShake, onSuccess]);

  // ── Labels per mode ─────────────────────────────────────────────────────────
  const modeTitle: Record<Exclude<ModalMode, "loading" | "forgot" | "challenge">, string> = {
    set:         "Create a parent PIN",
    confirm_set: "Confirm your PIN",
    verify:      "Parent access",
  };

  const modeSub: Record<Exclude<ModalMode, "loading" | "forgot" | "challenge">, string> = {
    set:         "Set a 4-digit PIN to protect\nparent-only features.",
    confirm_set: "Enter the same PIN again\nto confirm.",
    verify:      "Enter your PIN to open\nthe AI Quest Creator.",
  };

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onDismiss}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <KeyboardAwareView style={styles.overlay}>
        <TouchableOpacity
          style={StyleSheet.absoluteFill}
          activeOpacity={1}
          onPress={onDismiss}
        />

        <Animated.View
          style={[
            styles.sheet,
            { paddingBottom: insets.bottom + 24, opacity: fadeAnim },
          ]}
        >
          {/* Handle */}
          <View style={styles.handle} />

          {/* Header */}
          <View style={styles.headerRow}>
            <View style={styles.lockBadge}>
              <Text style={styles.lockIcon}>🔒</Text>
            </View>
            <TouchableOpacity onPress={onDismiss} style={styles.closeBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.closeText}>✕</Text>
            </TouchableOpacity>
          </View>

          {/* Loading */}
          {mode === "loading" && (
            <View style={styles.loadingWrap}>
              <ActivityIndicator color={C.purpleLight} size="large" />
            </View>
          )}

          {/* Forgot PIN */}
          {mode === "forgot" && (
            <ForgotPinView
              parentEmail={parentEmail}
              parentId={parentId}
              onRecovered={() => {
                // Recovery clears the stored PIN. Re-arm the challenge before a
                // new PIN can be created, so the recovery path can't be used as
                // a back door into an ungated SET screen.
                setChallengeIntent("set");
                setMode("challenge");
                setPin("");
                setAttempts(0);
                setLocked(false);
                setErrorMsg(null);
              }}
              onCancel={() => setMode("verify")}
            />
          )}

          {/* Parental gate — randomised arithmetic, no off switch (Apple 1.3) */}
          {mode === "challenge" && (
            <ParentalGateChallenge
              purpose={challengeIntent === "unlock" ? "commerce" : "setup"}
              onPass={() => {
                if (challengeIntent === "unlock") {
                  setTimeout(onSuccess, 120);
                } else {
                  setPin("");
                  setFirstPin("");
                  setErrorMsg(null);
                  setMode("set");
                }
              }}
            />
          )}

          {/* PIN entry modes */}
          {(mode === "set" || mode === "confirm_set" || mode === "verify") && (
            <>
              <Text style={styles.title}>
                {modeTitle[mode]}
              </Text>
              <Text style={styles.sub}>
                {modeSub[mode]}
              </Text>

              <PinDots filled={pin.length} shake={shakeAnim} />

              {errorMsg ? (
                <View style={styles.errorBox}>
                  <Text style={styles.errorText}>{errorMsg}</Text>
                </View>
              ) : (
                <View style={styles.errorBox} />
              )}

              <NumberPad
                onPress={handleKey}
                disabled={locked}
              />

              {/* Forgot PIN — only shown in verify mode */}
              {mode === "verify" && (
                <TouchableOpacity
                  style={styles.forgotLink}
                  onPress={() => { setPin(""); setMode("forgot"); }}
                >
                  <Text style={styles.forgotLinkText}>Forgot PIN?</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </Animated.View>
      </KeyboardAwareView>
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  overlay: {
    flex:            1,
    backgroundColor: "rgba(0,0,0,0.72)",
    justifyContent:  "flex-end",
  },

  sheet: {
    backgroundColor: C.surface,
    borderTopLeftRadius:  28,
    borderTopRightRadius: 28,
    paddingTop:   12,
    paddingHorizontal: 24,
    borderTopWidth:  0.5,
    borderTopColor:  C.border,
  },

  handle: {
    width:        40,
    height:       4,
    borderRadius: 2,
    backgroundColor: C.border,
    alignSelf:    "center",
    marginBottom: 20,
  },

  headerRow: {
    flexDirection:  "row",
    alignItems:     "center",
    justifyContent: "space-between",
    marginBottom:   20,
  },

  lockBadge: {
    width:           44,
    height:          44,
    borderRadius:    12,
    backgroundColor: C.surfaceAlt,
    borderWidth:     0.5,
    borderColor:     C.border,
    alignItems:      "center",
    justifyContent:  "center",
  },
  lockIcon: { fontSize: 20 },

  closeBtn: {
    width:           36,
    height:          36,
    borderRadius:    18,
    backgroundColor: C.surfaceAlt,
    alignItems:      "center",
    justifyContent:  "center",
  },
  closeText: {
    color:      C.textMuted,
    fontSize:   14,
    fontWeight: "600",
  },

  loadingWrap: {
    paddingVertical: 60,
    alignItems:      "center",
  },

  title: {
    fontSize:   20,
    fontWeight: "700",
    color:      C.textPrime,
    textAlign:  "center",
    marginBottom: 6,
  },
  sub: {
    fontSize:   13,
    color:      C.textMuted,
    textAlign:  "center",
    lineHeight: 19,
    marginBottom: 32,
  },

  // ── PIN dots
  dotsRow: {
    flexDirection:  "row",
    justifyContent: "center",
    gap:            18,
    marginBottom:   12,
  },
  dot: {
    width:        18,
    height:       18,
    borderRadius: 9,
    borderWidth:  1.5,
    borderColor:  C.border,
    backgroundColor: "transparent",
  },
  dotFilled: {
    backgroundColor: C.gold,
    borderColor:     C.gold,
  },

  // ── Error
  errorBox: {
    minHeight:    38,
    alignItems:   "center",
    justifyContent: "center",
    marginBottom: 16,
    paddingHorizontal: 16,
  },
  errorText: {
    fontSize:   12,
    color:      C.red,
    textAlign:  "center",
    lineHeight: 17,
  },

  // ── Number pad
  pad: {
    gap: 10,
    marginBottom: 8,
  },
  padRow: {
    flexDirection:  "row",
    justifyContent: "center",
    gap:            10,
  },
  padKey: {
    width:           88,
    height:          64,
    borderRadius:    14,
    backgroundColor: C.surfaceAlt,
    borderWidth:     0.5,
    borderColor:     C.borderFaint,
    alignItems:      "center",
    justifyContent:  "center",
  },
  padKeyEmpty: {
    backgroundColor: "transparent",
    borderColor:     "transparent",
  },
  padKeyText: {
    fontSize:   24,
    fontWeight: "500",
    color:      C.textPrime,
  },

  // ── Forgot PIN link
  forgotLink: {
    alignItems:   "center",
    paddingTop:   16,
  },
  forgotLinkText: {
    fontSize:   13,
    color:      C.purpleLight,
    fontWeight: "500",
  },

  // ── Forgot PIN sub-view
  forgotWrap: {
    paddingHorizontal: 8,
    paddingBottom:     8,
    alignItems: "center",
  },
  forgotTitle: {
    fontSize:   18,
    fontWeight: "700",
    color:      C.textPrime,
    marginBottom: 8,
    textAlign:  "center",
  },
  forgotSub: {
    fontSize:   13,
    color:      C.textMuted,
    textAlign:  "center",
    lineHeight: 19,
    marginBottom: 20,
  },
  emailLabel: {
    fontSize:         13,
    color:            C.gold,
    marginBottom:     12,
    fontWeight:       "500",
  },
  resendLink: {
    marginTop:  10,
    alignSelf:  "center",
    paddingVertical: 6,
  },
  resendText: {
    color:      C.purpleLight,
    fontSize:   13,
    fontWeight: "600",
  },

  passwordInput: {
    width:            "100%",
    height:           52,
    borderRadius:     12,
    borderWidth:      0.5,
    borderColor:      C.border,
    backgroundColor:  C.surfaceAlt,
    color:            C.textPrime,
    paddingHorizontal:16,
    fontSize:         15,
    marginBottom:     10,
  },
  forgotBtnRow: {
    flexDirection:  "row",
    gap:            10,
    marginTop:      8,
    width:          "100%",
  },
  forgotCancelBtn: {
    flex:            1,
    height:          50,
    borderRadius:    12,
    borderWidth:     0.5,
    borderColor:     C.border,
    alignItems:      "center",
    justifyContent:  "center",
  },
  forgotCancelText: {
    color:      C.textMuted,
    fontSize:   15,
    fontWeight: "600",
  },
  forgotConfirmBtn: {
    flex:            1,
    height:          50,
    borderRadius:    12,
    backgroundColor: C.purple,
    alignItems:      "center",
    justifyContent:  "center",
  },
  forgotConfirmText: {
    color:      "#fff",
    fontSize:   15,
    fontWeight: "700",
  },
  btnDisabled: {
    opacity: 0.4,
  },

  successIcon: {
    fontSize:     40,
    color:        C.green,
    marginBottom: 12,
  },
});
