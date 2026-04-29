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
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "../lib/supabase";

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
  const [password, setPassword]   = useState("");
  const [loading,  setLoading]    = useState(false);
  const [error,    setError]      = useState<string | null>(null);
  const [success,  setSuccess]    = useState(false);

  const handleRecover = async () => {
    if (!password) return;
    setLoading(true);
    setError(null);

    // Re-authenticate to confirm identity
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

    // Clear the stored PIN — next open will be SET mode
    await clearPin(parentId);
    setSuccess(true);
    setLoading(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    setTimeout(onRecovered, 900);
  };

  if (success) {
    return (
      <View style={styles.forgotWrap}>
        <Text style={styles.successIcon}>✓</Text>
        <Text style={styles.forgotTitle}>Identity confirmed</Text>
        <Text style={styles.forgotSub}>You can now set a new PIN.</Text>
      </View>
    );
  }

  return (
    <View style={styles.forgotWrap}>
      <Text style={styles.forgotTitle}>Confirm your identity</Text>
      <Text style={styles.forgotSub}>
        Enter your Lexi-Lens account password to reset your PIN.
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
}

type ModalMode = "loading" | "set" | "confirm_set" | "verify" | "forgot";

export function ParentPinGateModal({
  visible,
  parentId,
  parentEmail,
  onSuccess,
  onDismiss,
}: ParentPinGateModalProps) {
  const insets = useSafeAreaInsets();

  const [mode,        setMode]        = useState<ModalMode>("loading");
  const [pin,         setPin]         = useState("");
  const [firstPin,    setFirstPin]    = useState("");  // SET mode: stores first entry
  const [attempts,    setAttempts]    = useState(0);
  const [errorMsg,    setErrorMsg]    = useState<string | null>(null);
  const [locked,      setLocked]      = useState(false);

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
      }, 300);
      return;
    }

    setMode("loading");
    loadStoredPin(parentId).then((stored) => {
      setMode(stored ? "verify" : "set");
      fadeAnim.setValue(0);
      Animated.timing(fadeAnim, {
        toValue: 1, duration: 220, useNativeDriver: true,
      }).start();
    });
  }, [visible, parentId]);

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
  const modeTitle: Record<Exclude<ModalMode, "loading" | "forgot">, string> = {
    set:         "Create a parent PIN",
    confirm_set: "Confirm your PIN",
    verify:      "Parent access",
  };

  const modeSub: Record<Exclude<ModalMode, "loading" | "forgot">, string> = {
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
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
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
            <TouchableOpacity onPress={onDismiss} style={styles.closeBtn}>
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
                setMode("set");
                setPin("");
                setAttempts(0);
                setLocked(false);
                setErrorMsg(null);
              }}
              onCancel={() => setMode("verify")}
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
      </KeyboardAvoidingView>
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
