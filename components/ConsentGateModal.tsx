/**
 * ConsentGateModal.tsx
 * Lexi-Lens — Phase 4.1 COPPA + GDPR-K Compliance
 *
 * Rendered inside AuthScreen during "sign_up" flow, BEFORE the Supabase
 * signUp() call is made. Implements two hard regulatory requirements:
 *
 *   1. PARENTAL GATE (COPPA §312.5 / Apple Kids Cat. 5.1.4)
 *      A randomised arithmetic challenge that a child cannot reasonably
 *      solve without adult assistance. Apple requires this before any
 *      account creation or data collection in kids-category apps.
 *      — 3 attempts before a 30-second lockout (prevents brute-force).
 *      — New question generated each time the modal is shown.
 *
 *   2. EXPLICIT OPT-IN CONSENT (COPPA §312.5(a) / GDPR-K Art. 8)
 *      Four unchecked checkboxes covering:
 *        a) Age confirmation (parent is 18+)
 *        b) COPPA data-minimisation acknowledgement
 *        c) GDPR-K processing consent (can withdraw → delete account)
 *        d) AI processing consent (object labels only — no PII, no images)
 *      ALL four must be checked before the "Create Account" button enables.
 *
 * Export:
 *   ConsentGateModal   — the Modal component
 *   ConsentMetadata    — the type returned via onConsented()
 *   CURRENT_POLICY_VERSION — semver string matching privacy_policy_versions table
 *
 * Usage in AuthScreen:
 *   <ConsentGateModal
 *     visible={showConsentGate}
 *     onConsented={(meta) => { setShowConsentGate(false); performSignUp(meta); }}
 *     onCancel={() => setShowConsentGate(false)}
 *   />
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  TextInput,
  Platform,
  Linking,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";

// ─── Public types ─────────────────────────────────────────────────────────────

/** Written into auth.users user_metadata at signup and mirrored to parental_consents via DB trigger. */
export interface ConsentMetadata {
  policyVersion:          string;  // semver, e.g. "1.0"
  consentedAt:            string;  // ISO 8601 timestamp
  coppaConfirmed:         boolean;
  gdprKConfirmed:         boolean;
  aiProcessingConfirmed:  boolean;
  parentalGatePassed:     boolean;
}

interface Props {
  visible:      boolean;
  onConsented:  (meta: ConsentMetadata) => void;
  onCancel:     () => void;
  /** Call this to open the full privacy policy screen / URL */
  onOpenPrivacyPolicy?: () => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const CURRENT_POLICY_VERSION = "1.0";

const GATE_MAX_ATTEMPTS  = 3;
const GATE_LOCKOUT_SECS  = 30;

// ─── Palette ──────────────────────────────────────────────────────────────────

const P = {
  cream:        "#fdf8f0",
  parchment:    "#f5edda",
  warmBorder:   "#e2d0b0",
  inkBrown:     "#3d2a0f",
  inkMid:       "#6b4c1e",
  inkLight:     "#9c7540",
  inkFaint:     "#c4a97a",
  amber:        "#d97706",
  amberLight:   "#fef3c7",
  amberBorder:  "#fde68a",
  errorBg:      "#fff1f2",
  errorBorder:  "#fecdd3",
  errorText:    "#9f1239",
  green:        "#059669",
  greenLight:   "#ecfdf5",
  greenBorder:  "#a7f3d0",
  white:        "#ffffff",
  overlay:      "rgba(0,0,0,0.55)",
} as const;

// ─── Math gate helper ─────────────────────────────────────────────────────────

interface MathQuestion {
  display:  string; // e.g. "17 + 24"
  answer:   number;
}

/**
 * Generates a question adults answer in seconds but children find challenging.
 * Two-digit addition (18–57) or single-digit multiplication (4–81).
 * Avoids trivial cases (×1, ×0, +0, identical operands for multiplication).
 */
function generateQuestion(): MathQuestion {
  const useMultiply = Math.random() > 0.5;

  if (useMultiply) {
    // a ∈ [3,9], b ∈ [3,9], a ≠ b to prevent trivially obvious squares
    const a = Math.floor(Math.random() * 7) + 3;
    let b   = Math.floor(Math.random() * 7) + 3;
    while (b === a) b = Math.floor(Math.random() * 7) + 3;
    return { display: `${a} × ${b}`, answer: a * b };
  }

  // a ∈ [13,29], b ∈ [13,29], sum ∈ [26,58] — requires carrying
  const a = Math.floor(Math.random() * 17) + 13;
  const b = Math.floor(Math.random() * 17) + 13;
  return { display: `${a} + ${b}`, answer: a + b };
}

// ─── Checkbox sub-component ───────────────────────────────────────────────────

function ConsentCheckbox({
  checked,
  onToggle,
  label,
  linkText,
  onLinkPress,
}: {
  checked:      boolean;
  onToggle:     () => void;
  label:        string;
  linkText?:    string;
  onLinkPress?: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.checkboxRow, checked && styles.checkboxRowChecked]}
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      activeOpacity={0.75}
    >
      <View style={[styles.checkboxBox, checked && styles.checkboxBoxChecked]}>
        {checked && <Text style={styles.checkboxTick}>✓</Text>}
      </View>
      <View style={styles.checkboxTextWrap}>
        <Text style={styles.checkboxLabel}>{label}</Text>
        {linkText && onLinkPress && (
          <TouchableOpacity onPress={onLinkPress} hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}>
            <Text style={styles.checkboxLink}>{linkText}</Text>
          </TouchableOpacity>
        )}
      </View>
    </TouchableOpacity>
  );
}

// ─── Step: Parental Gate ──────────────────────────────────────────────────────

function GateStep({
  question,
  answer,
  onAnswerChange,
  onSubmit,
  error,
  locked,
  secondsLeft,
}: {
  question:       MathQuestion;
  answer:         string;
  onAnswerChange: (v: string) => void;
  onSubmit:       () => void;
  error:          string | null;
  locked:         boolean;
  secondsLeft:    number;
}) {
  const canSubmit = !locked && answer.trim().length > 0;

  return (
    <>
      <Text style={styles.stepEmoji}>🔐</Text>
      <Text style={styles.stepTitle}>Parent Verification</Text>
      <Text style={styles.stepBody}>
        Lexi-Lens is built for children. To protect your child's data under{" "}
        <Text style={styles.boldInk}>COPPA</Text>, we must confirm you are an
        adult before creating an account.
      </Text>

      <View style={styles.mathCard}>
        <Text style={styles.mathPrompt}>Solve this to continue:</Text>
        <Text style={styles.mathEquation} accessibilityLabel={`What is ${question.display}?`}>
          {question.display} = ?
        </Text>
        <TextInput
          style={[
            styles.mathInput,
            !!error  && styles.mathInputError,
            locked   && styles.mathInputLocked,
          ]}
          value={answer}
          onChangeText={onAnswerChange}
          keyboardType="number-pad"
          placeholder="Type your answer"
          placeholderTextColor={P.inkFaint}
          editable={!locked}
          onSubmitEditing={canSubmit ? onSubmit : undefined}
          returnKeyType="done"
          maxLength={4}
          accessibilityLabel={`Answer to ${question.display}`}
        />
        {error ? (
          <View style={styles.gateErrorBox}>
            <Text style={styles.gateErrorText}>{error}</Text>
            {locked && (
              <Text style={styles.lockCountdown}>
                Retry in {secondsLeft}s
              </Text>
            )}
          </View>
        ) : null}
      </View>

      <Text style={styles.gateExplainer}>
        This arithmetic challenge prevents children from creating accounts
        without a parent's knowledge — required by COPPA and Apple / Google
        Kids category policies.
      </Text>

      <TouchableOpacity
        style={[styles.primaryBtn, !canSubmit && styles.primaryBtnDisabled]}
        onPress={onSubmit}
        disabled={!canSubmit}
        accessibilityRole="button"
        accessibilityLabel="Verify and continue"
      >
        <Text style={styles.primaryBtnText}>Verify & Continue →</Text>
      </TouchableOpacity>
    </>
  );
}

// ─── Step: Explicit Consent ───────────────────────────────────────────────────

function ConsentStep({
  ageCheck, coppaCheck, gdprCheck, aiCheck,
  onToggleAge, onToggleCoppa, onToggleGdpr, onToggleAi,
  onPrivacyPolicy,
  onConsent,
  allChecked,
}: {
  ageCheck:       boolean;
  coppaCheck:     boolean;
  gdprCheck:      boolean;
  aiCheck:        boolean;
  onToggleAge:    () => void;
  onToggleCoppa:  () => void;
  onToggleGdpr:   () => void;
  onToggleAi:     () => void;
  onPrivacyPolicy: () => void;
  onConsent:      () => void;
  allChecked:     boolean;
}) {
  return (
    <>
      <Text style={styles.stepEmoji}>📋</Text>
      <Text style={styles.stepTitle}>Parental Consent</Text>
      <Text style={styles.stepBody}>
        Please read and confirm all four items below. Each confirmation is
        required before we can create your account.
      </Text>

      {/* Data snapshot card */}
      <View style={styles.dataCard}>
        <Text style={styles.dataCardTitle}>📊 What we collect</Text>
        <Text style={styles.dataRow}>
          <Text style={styles.boldAmber}>Parents: </Text>
          Email address, display name
        </Text>
        <Text style={styles.dataRow}>
          <Text style={styles.boldAmber}>Children: </Text>
          First name (display only), age band
        </Text>
        <Text style={styles.dataRow}>
          <Text style={styles.boldAmber}>Gameplay: </Text>
          Words scanned, XP, quest progress
        </Text>

        <View style={styles.neverCard}>
          <Text style={styles.neverTitle}>🚫 Never collected for children</Text>
          <Text style={styles.neverItem}>• Email address or date of birth</Text>
          <Text style={styles.neverItem}>• Location data or device IDs</Text>
          <Text style={styles.neverItem}>• Photos (frames processed live, then discarded)</Text>
          <Text style={styles.neverItem}>• Advertising or tracking identifiers</Text>
        </View>
      </View>

      {/* Checkboxes — none pre-checked (COPPA requirement) */}
      <View style={styles.checkboxGroup}>
        <ConsentCheckbox
          checked={ageCheck}
          onToggle={onToggleAge}
          label="I confirm I am 18 years of age or older and the parent or legal guardian of the child who will use this app."
        />
        <ConsentCheckbox
          checked={coppaCheck}
          onToggle={onToggleCoppa}
          label="I understand Lexi-Lens stores only a display name and age band for my child — no email, date of birth, or location — in compliance with COPPA."
          linkText="Read Privacy Policy →"
          onLinkPress={onPrivacyPolicy}
        />
        <ConsentCheckbox
          checked={gdprCheck}
          onToggle={onToggleGdpr}
          label="I consent to my child's vocabulary gameplay data (words scanned, XP, quest progress) being stored securely and used solely to personalise their learning. I may request full deletion at any time."
        />
        <ConsentCheckbox
          checked={aiCheck}
          onToggle={onToggleAi}
          label="I consent to camera-detected object labels (e.g. 'apple', 'chair') being sent to Claude AI to check vocabulary matches. No images or child identity are ever sent — only the object label."
        />
      </View>

      <TouchableOpacity
        style={[styles.primaryBtn, !allChecked && styles.primaryBtnDisabled]}
        onPress={onConsent}
        disabled={!allChecked}
        accessibilityRole="button"
        accessibilityLabel={allChecked ? "I consent — create account" : "Check all boxes above to continue"}
      >
        <Text style={styles.primaryBtnText}>
          {allChecked ? "I Consent — Create Account →" : "Please tick all boxes above"}
        </Text>
      </TouchableOpacity>

      <Text style={styles.consentFooter}>
        Policy version {CURRENT_POLICY_VERSION} · Consent timestamp recorded
      </Text>
    </>
  );
}

// ─── Main Modal ───────────────────────────────────────────────────────────────

export function ConsentGateModal({ visible, onConsented, onCancel, onOpenPrivacyPolicy }: Props) {
  const insets = useSafeAreaInsets();

  // Gate state
  const [step,       setStep]       = useState<"gate" | "consent">("gate");
  const [question,   setQuestion]   = useState<MathQuestion>(generateQuestion);
  const [answer,     setAnswer]     = useState("");
  const [gateError,  setGateError]  = useState<string | null>(null);
  const [attempts,   setAttempts]   = useState(0);
  const [locked,     setLocked]     = useState(false);
  const [secsLeft,   setSecsLeft]   = useState(0);

  // Consent state — NOT pre-checked
  const [ageCheck,  setAgeCheck]  = useState(false);
  const [coppaCheck, setCoppaCheck] = useState(false);
  const [gdprCheck,  setGdprCheck]  = useState(false);
  const [aiCheck,    setAiCheck]    = useState(false);

  const allChecked = ageCheck && coppaCheck && gdprCheck && aiCheck;

  // Reset fully each time modal opens
  useEffect(() => {
    if (!visible) return;
    setStep("gate");
    setQuestion(generateQuestion());
    setAnswer("");
    setGateError(null);
    setAttempts(0);
    setLocked(false);
    setSecsLeft(0);
    setAgeCheck(false);
    setCoppaCheck(false);
    setGdprCheck(false);
    setAiCheck(false);
  }, [visible]);

  // Lockout countdown
  useEffect(() => {
    if (!locked) return;
    setSecsLeft(GATE_LOCKOUT_SECS);
    const id = setInterval(() => {
      setSecsLeft((s) => {
        if (s <= 1) {
          clearInterval(id);
          setLocked(false);
          setAttempts(0);
          setQuestion(generateQuestion());
          setAnswer("");
          setGateError(null);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [locked]);

  const handleGateSubmit = useCallback(() => {
    if (locked) return;
    const parsed = parseInt(answer.trim(), 10);
    if (isNaN(parsed)) {
      setGateError("Please enter a whole number.");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }
    if (parsed !== question.answer) {
      const next = attempts + 1;
      setAttempts(next);
      if (next >= GATE_MAX_ATTEMPTS) {
        setLocked(true);
        setGateError("Too many wrong answers. Please wait.");
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      } else {
        const remaining = GATE_MAX_ATTEMPTS - next;
        setGateError(`Incorrect. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`);
        setAnswer("");
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
      return;
    }
    // Correct
    setGateError(null);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setStep("consent");
  }, [locked, answer, question.answer, attempts]);

  const handleConsent = useCallback(() => {
    if (!allChecked) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onConsented({
      policyVersion:         CURRENT_POLICY_VERSION,
      consentedAt:           new Date().toISOString(),
      coppaConfirmed:        coppaCheck,
      gdprKConfirmed:        gdprCheck,
      aiProcessingConfirmed: aiCheck,
      parentalGatePassed:    true,
    });
  }, [allChecked, coppaCheck, gdprCheck, aiCheck, onConsented]);

  const handlePrivacyPolicy = useCallback(() => {
    if (onOpenPrivacyPolicy) {
      onOpenPrivacyPolicy();
    } else {
      Linking.openURL("https://lexi-lens.app/privacy").catch(() => null);
    }
  }, [onOpenPrivacyPolicy]);

  const toggle = (fn: React.Dispatch<React.SetStateAction<boolean>>) => () => {
    fn((v) => !v);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onCancel}
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>

          {/* Drag handle + close */}
          <View style={styles.sheetTop}>
            <View style={styles.handle} />
            <TouchableOpacity
              style={styles.closeBtn}
              onPress={onCancel}
              accessibilityRole="button"
              accessibilityLabel="Cancel and go back"
            >
              <Text style={styles.closeBtnText}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView
            contentContainerStyle={styles.sheetBody}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {step === "gate" ? (
              <GateStep
                question={question}
                answer={answer}
                onAnswerChange={setAnswer}
                onSubmit={handleGateSubmit}
                error={gateError}
                locked={locked}
                secondsLeft={secsLeft}
              />
            ) : (
              <ConsentStep
                ageCheck={ageCheck}
                coppaCheck={coppaCheck}
                gdprCheck={gdprCheck}
                aiCheck={aiCheck}
                onToggleAge={toggle(setAgeCheck)}
                onToggleCoppa={toggle(setCoppaCheck)}
                onToggleGdpr={toggle(setGdprCheck)}
                onToggleAi={toggle(setAiCheck)}
                onPrivacyPolicy={handlePrivacyPolicy}
                onConsent={handleConsent}
                allChecked={allChecked}
              />
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  overlay: {
    flex:            1,
    backgroundColor: P.overlay,
    justifyContent:  "flex-end",
  },
  sheet: {
    backgroundColor:      P.cream,
    borderTopLeftRadius:  28,
    borderTopRightRadius: 28,
    maxHeight:            "94%",
    ...Platform.select({
      ios:     { shadowColor: "#000", shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.18, shadowRadius: 24 },
      android: { elevation: 24 },
    }),
  },
  sheetTop: {
    paddingTop:        14,
    paddingHorizontal: 20,
    alignItems:        "center",
    position:          "relative",
    marginBottom:      4,
  },
  handle: {
    width:           40,
    height:          4,
    borderRadius:    2,
    backgroundColor: P.warmBorder,
  },
  closeBtn: {
    position: "absolute",
    right:    20,
    top:      14,
    padding:  6,
    minWidth: 32,
    alignItems: "center",
  },
  closeBtnText: { fontSize: 16, color: P.inkLight, fontWeight: "600" },
  sheetBody:    { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 24 },

  // Shared step UI
  stepEmoji: { fontSize: 52, textAlign: "center", marginBottom: 14, marginTop: 4 },
  stepTitle: { fontSize: 22, fontWeight: "800", color: P.inkBrown, textAlign: "center", marginBottom: 10 },
  stepBody:  { fontSize: 14, color: P.inkMid, lineHeight: 21, textAlign: "center", marginBottom: 24 },
  boldInk:   { fontWeight: "700", color: P.inkBrown },
  boldAmber: { fontWeight: "700", color: P.amber },

  // Math gate
  mathCard: {
    backgroundColor: P.white,
    borderRadius:    18,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    padding:         22,
    alignItems:      "center",
    marginBottom:    18,
    ...Platform.select({
      ios:     { shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 10 },
      android: { elevation: 3 },
    }),
  },
  mathPrompt:   { fontSize: 14, color: P.inkLight, marginBottom: 14 },
  mathEquation: { fontSize: 40, fontWeight: "900", color: P.inkBrown, marginBottom: 18, letterSpacing: 1 },
  mathInput: {
    width:             "100%",
    backgroundColor:   P.parchment,
    borderRadius:      12,
    borderWidth:       1.5,
    borderColor:       P.warmBorder,
    paddingHorizontal: 14,
    paddingVertical:   14,
    fontSize:          24,
    color:             P.inkBrown,
    textAlign:         "center",
    fontWeight:        "700",
  },
  mathInputError:  { borderColor: "#fca5a5", backgroundColor: "#fff5f5" },
  mathInputLocked: { opacity: 0.35 },
  gateErrorBox: {
    marginTop:       12,
    backgroundColor: P.errorBg,
    borderRadius:    10,
    padding:         10,
    width:           "100%",
    alignItems:      "center",
    borderWidth:     1,
    borderColor:     P.errorBorder,
  },
  gateErrorText:   { fontSize: 13, color: P.errorText, textAlign: "center" },
  lockCountdown:   { fontSize: 20, fontWeight: "800", color: P.errorText, marginTop: 6 },
  gateExplainer:   { fontSize: 12, color: P.inkFaint, lineHeight: 17, textAlign: "center", marginBottom: 22 },

  // Data summary
  dataCard: {
    backgroundColor: P.amberLight,
    borderRadius:    16,
    borderWidth:     1,
    borderColor:     P.amberBorder,
    padding:         16,
    marginBottom:    20,
  },
  dataCardTitle: { fontSize: 14, fontWeight: "700", color: P.inkBrown, marginBottom: 10 },
  dataRow:       { fontSize: 13, color: P.inkMid, lineHeight: 20, marginBottom: 3 },
  neverCard: {
    marginTop:       12,
    backgroundColor: P.white,
    borderRadius:    12,
    padding:         12,
    borderWidth:     1,
    borderColor:     P.amberBorder,
  },
  neverTitle: { fontSize: 13, fontWeight: "700", color: P.errorText, marginBottom: 8 },
  neverItem:  { fontSize: 12, color: P.inkMid, lineHeight: 19 },

  // Checkboxes
  checkboxGroup:      { gap: 12, marginBottom: 24 },
  checkboxRow: {
    flexDirection:   "row",
    alignItems:      "flex-start",
    gap:             12,
    backgroundColor: P.parchment,
    borderRadius:    14,
    padding:         14,
    borderWidth:     1,
    borderColor:     P.warmBorder,
  },
  checkboxRowChecked: { backgroundColor: P.greenLight, borderColor: P.greenBorder },
  checkboxBox: {
    width:           24,
    height:          24,
    borderRadius:    7,
    borderWidth:     2,
    borderColor:     P.warmBorder,
    backgroundColor: P.white,
    alignItems:      "center",
    justifyContent:  "center",
    flexShrink:      0,
    marginTop:       1,
  },
  checkboxBoxChecked: { backgroundColor: P.green, borderColor: P.green },
  checkboxTick:       { fontSize: 14, color: P.white, fontWeight: "900", lineHeight: 18 },
  checkboxTextWrap:   { flex: 1 },
  checkboxLabel:      { fontSize: 13, color: P.inkMid, lineHeight: 20 },
  checkboxLink:       { fontSize: 12, color: P.amber, fontWeight: "700", marginTop: 5 },

  // Primary button
  primaryBtn: {
    backgroundColor: P.amber,
    borderRadius:    16,
    paddingVertical: 16,
    alignItems:      "center",
    marginBottom:    14,
  },
  primaryBtnDisabled: { backgroundColor: "#e5c58a", opacity: 0.65 },
  primaryBtnText:     { fontSize: 15, fontWeight: "700", color: P.white },

  consentFooter: { fontSize: 11, color: P.inkFaint, textAlign: "center" },
});
