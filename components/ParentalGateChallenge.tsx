/**
 * components/ParentalGateChallenge.tsx
 * Skanlore — Apple Guideline 1.3 parental gate (Kids Category).
 *
 * WHY THIS EXISTS
 * ---------------
 * `ParentPinGateModal` was treated as "the parental gate" in front of every
 * commerce surface. It is not one on a fresh install. Its mode resolver is:
 *
 *     loadStoredPin(parentId).then(stored => setMode(stored ? "verify" : "set"))
 *
 * With no PIN stored — which is the state of EVERY fresh install, including
 * the one App Review installs — the gate opens in SET mode: "choose a 4-digit
 * PIN", enter, confirm, done. A six-year-old (or a reviewer) types 1111 twice
 * and lands on PaywallScreen with a live `purchasePackage()` call. That is
 * precisely Apple's finding: "In-App Purchases that are not behind a parental
 * gate" + "ensure that the parental gate cannot be disabled". A gate the user
 * defines on first contact is not a gate; it is a password-creation screen.
 *
 * WHAT THIS IS
 * ------------
 * The randomised arithmetic challenge that `ConsentGateModal` already uses for
 * COPPA §312.5 / Apple 5.1.4 at signup — the one Apple has ALREADY accepted on
 * this app — extracted into a standalone, reusable view so the same primitive
 * can guard commerce. Properties that make it a real gate:
 *
 *   • Randomised per mount — nothing to memorise, nothing to shoulder-surf.
 *   • No stored state — cannot be "already satisfied", cannot be disabled,
 *     cannot be reset by reinstalling. There is no off switch anywhere in the
 *     app, by construction.
 *   • 3 attempts → 30s lockout → fresh question. Brute force is not viable.
 *
 * USAGE
 * -----
 * Rendered INSIDE the ParentPinGateModal sheet (it is a view, not a Modal), so
 * every existing gated surface inherits it with no caller changes:
 *
 *   commerce surfaces (alwaysChallenge)  → challenge → onSuccess
 *   parent-only surfaces, no PIN yet     → challenge → create PIN → onSuccess
 *   parent-only surfaces, PIN exists     → verify PIN → onSuccess
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Animated,
} from "react-native";
import * as Haptics from "expo-haptics";

// ─── Palette (matches ParentPinGateModal's dark purple sheet) ─────────────────

const C = {
  surfaceAlt:  "#231445",
  border:      "#3d2080",
  gold:        "#f5c842",
  purple:      "#7c3aed",
  purpleLight: "#a78bfa",
  textPrime:   "#f3e8ff",
  textMuted:   "#a78bfa",
  textDim:     "#5b4fa0",
  red:         "#ef4444",
  redBg:       "#2d0a0a",
} as const;

const MAX_ATTEMPTS = 3;
const LOCKOUT_SECS = 30;

// ─── Question generator ───────────────────────────────────────────────────────

export interface GateQuestion {
  display: string;
  answer:  number;
}

/**
 * Adults answer in seconds; children in the 5–12 target band do not.
 * Two-digit addition requiring a carry (26–58), or single-digit multiplication
 * with distinct operands ≥ 3 (12–72). Trivial cases (×0, ×1, +0, squares) are
 * excluded on purpose. Same generator ConsentGateModal ships.
 */
export function generateGateQuestion(): GateQuestion {
  if (Math.random() > 0.5) {
    const a = Math.floor(Math.random() * 7) + 3;
    let   b = Math.floor(Math.random() * 7) + 3;
    while (b === a) b = Math.floor(Math.random() * 7) + 3;
    return { display: `${a} × ${b}`, answer: a * b };
  }
  const a = Math.floor(Math.random() * 17) + 13;
  const b = Math.floor(Math.random() * 17) + 13;
  return { display: `${a} + ${b}`, answer: a + b };
}

// ─── Component ────────────────────────────────────────────────────────────────

export interface ParentalGateChallengeProps {
  /** Fired only on a correct answer. */
  onPass: () => void;
  /** What the adult is being verified FOR — drives the sub-copy only. */
  purpose?: "commerce" | "setup";
}

export function ParentalGateChallenge({
  onPass,
  purpose = "commerce",
}: ParentalGateChallengeProps) {
  const [question, setQuestion] = useState<GateQuestion>(generateGateQuestion);
  const [answer,   setAnswer]   = useState("");
  const [attempts, setAttempts] = useState(0);
  const [locked,   setLocked]   = useState(false);
  const [secsLeft, setSecsLeft] = useState(LOCKOUT_SECS);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const shake = useRef(new Animated.Value(0)).current;

  // ── Lockout countdown ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!locked) return;
    setSecsLeft(LOCKOUT_SECS);
    const id = setInterval(() => {
      setSecsLeft((s) => {
        if (s <= 1) {
          clearInterval(id);
          // Fresh question after a lockout — a burned question is never reused.
          setQuestion(generateGateQuestion());
          setAttempts(0);
          setLocked(false);
          setErrorMsg(null);
          setAnswer("");
          return LOCKOUT_SECS;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [locked]);

  const triggerShake = useCallback(() => {
    shake.setValue(0);
    Animated.timing(shake, {
      toValue: 1, duration: 400, useNativeDriver: true,
    }).start(() => shake.setValue(0));
  }, [shake]);

  const submit = useCallback(() => {
    if (locked) return;
    const parsed = Number.parseInt(answer.trim(), 10);

    if (Number.isFinite(parsed) && parsed === question.answer) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onPass();
      return;
    }

    triggerShake();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    setAnswer("");

    const next = attempts + 1;
    setAttempts(next);

    if (next >= MAX_ATTEMPTS) {
      setLocked(true);
      setErrorMsg("Too many incorrect answers.");
    } else {
      const left = MAX_ATTEMPTS - next;
      setErrorMsg(
        left === 1
          ? "Not quite. 1 attempt left."
          : `Not quite. ${left} attempts left.`
      );
      // New question on every wrong answer — no repeat-until-guessed path.
      setQuestion(generateGateQuestion());
    }
  }, [answer, attempts, locked, question.answer, onPass, triggerShake]);

  const canSubmit = !locked && answer.trim().length > 0;

  const sub =
    purpose === "commerce"
      ? "Only a grown-up can open the subscription page.\nSolve this to continue."
      : "Only a grown-up can set the parent PIN.\nSolve this to continue.";

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Ask a grown-up</Text>
      <Text style={styles.sub}>{sub}</Text>

      <Animated.View
        style={[
          styles.card,
          {
            transform: [{
              translateX: shake.interpolate({
                inputRange:  [0, 0.2, 0.4, 0.6, 0.8, 1],
                outputRange: [0, -9, 9, -9, 9, 0],
              }),
            }],
          },
        ]}
      >
        <Text
          style={styles.equation}
          accessibilityLabel={`What is ${question.display}?`}
        >
          {question.display} = ?
        </Text>

        <TextInput
          style={[
            styles.input,
            !!errorMsg && styles.inputError,
            locked     && styles.inputLocked,
          ]}
          value={answer}
          onChangeText={(v) => { setAnswer(v.replace(/[^0-9]/g, "")); setErrorMsg(null); }}
          keyboardType="number-pad"
          placeholder="Answer"
          placeholderTextColor={C.textDim}
          editable={!locked}
          onSubmitEditing={canSubmit ? submit : undefined}
          returnKeyType="done"
          maxLength={4}
          autoFocus={false}
          accessibilityLabel={`Answer to ${question.display}`}
        />
      </Animated.View>

      {errorMsg ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{errorMsg}</Text>
          {locked && (
            <Text style={styles.countdown}>Try again in {secsLeft}s</Text>
          )}
        </View>
      ) : (
        <View style={styles.errorBox} />
      )}

      <TouchableOpacity
        style={[styles.cta, !canSubmit && styles.ctaDisabled]}
        onPress={submit}
        disabled={!canSubmit}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel="Submit parental gate answer"
      >
        <Text style={[styles.ctaText, !canSubmit && styles.ctaTextDisabled]}>
          Continue
        </Text>
      </TouchableOpacity>

      <Text style={styles.explainer}>
        This check is required by Apple's Kids Category rules and cannot be
        turned off.
      </Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 24,
    paddingTop:        4,
    alignItems:        "center",
  },

  title: {
    fontSize:   22,
    fontWeight: "800",
    color:      C.textPrime,
    textAlign:  "center",
  },
  sub: {
    marginTop:  6,
    fontSize:   13,
    lineHeight: 19,
    color:      C.textMuted,
    textAlign:  "center",
  },

  card: {
    marginTop:       20,
    width:           "100%",
    backgroundColor: C.surfaceAlt,
    borderWidth:     1,
    borderColor:     C.border,
    borderRadius:    16,
    paddingVertical: 20,
    alignItems:      "center",
  },
  equation: {
    fontSize:      34,
    fontWeight:    "800",
    color:         C.gold,
    letterSpacing: 1,
  },
  input: {
    marginTop:       16,
    width:           170,
    height:          52,
    borderRadius:    12,
    borderWidth:     1.5,
    borderColor:     C.border,
    backgroundColor: "rgba(0,0,0,0.28)",
    color:           C.textPrime,
    fontSize:        22,
    fontWeight:      "700",
    textAlign:       "center",
  },
  inputError:  { borderColor: C.red },
  inputLocked: { opacity: 0.45 },

  errorBox: {
    minHeight:  40,
    marginTop:  10,
    alignItems: "center",
    justifyContent: "center",
  },
  errorText: {
    color:      C.red,
    fontSize:   13,
    fontWeight: "600",
    textAlign:  "center",
  },
  countdown: {
    marginTop: 2,
    color:     C.textMuted,
    fontSize:  12,
  },

  cta: {
    width:           "100%",
    height:          52,
    borderRadius:    14,
    backgroundColor: C.purple,
    alignItems:      "center",
    justifyContent:  "center",
  },
  ctaDisabled: {
    backgroundColor: "rgba(124,58,237,0.28)",
  },
  ctaText: {
    color:      "#ffffff",
    fontSize:   16,
    fontWeight: "800",
  },
  ctaTextDisabled: {
    color: C.textDim,
  },

  explainer: {
    marginTop:  14,
    fontSize:   11,
    lineHeight: 16,
    color:      C.textDim,
    textAlign:  "center",
  },
});

export default ParentalGateChallenge;
