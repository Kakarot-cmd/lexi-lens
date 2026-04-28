/**
 * DataDeletionScreen.tsx
 * Lexi-Lens — Phase 4.1 COPPA + GDPR-K Compliance
 *
 * Implements the COPPA §312.6 and GDPR Art. 17 "right to erasure" for parents.
 *
 * REGULATORY REQUIREMENTS MET:
 *   • COPPA: Parent can delete all child data at any time, must be honoured
 *     within a reasonable time (interpreted as 30 days).
 *   • GDPR-K Art. 17: Erasure request must be fulfilled without undue delay
 *     (max 1 month). Child data deleted immediately; parent account within 30 days.
 *   • Apple Review §5.1.4: Kids apps must provide a clear, accessible deletion
 *     mechanism and must delete all user data when requested.
 *
 * DELETION FLOW (4 steps + 2 terminal states):
 *   Step 1 — "summary"  : Full list of what WILL and what MUST be retained.
 *   Step 2 — "reason"   : Optional reason (7 choices). Helps product improvement.
 *   Step 3 — "confirm"  : Parent types "DELETE" to confirm. Prevents accidents.
 *   Step 4 — "success"  : Request submitted. Shows deletion timeline. Signs out.
 *   Terminal — "error"  : Shown if Edge Function call fails. Provides email fallback.
 *
 * WHAT HAPPENS ON SUBMISSION:
 *   The `request-deletion` Edge Function:
 *     1. Validates JWT (parent must be authenticated).
 *     2. Validates confirmation field === "DELETE".
 *     3. Records a data_deletion_requests row (status = 'processing').
 *     4. Immediately hard-deletes: scan_attempts, word_mastery, quest_progress, children.
 *     5. Stamps auth.users app_metadata with deletion_scheduled_at (+30 days).
 *     6. A pg_cron job at 02:00 UTC daily purges users past their scheduled date.
 *
 * Usage: Opened as a full-screen Modal from ParentDashboard → Settings section.
 *
 *   <DataDeletionScreen
 *     visible={showDeleteScreen}
 *     onClose={() => setShowDeleteScreen(false)}
 *     onDeleted={() => { /* navigate to Auth screen *\/ }}
 *   />
 */

import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Platform,
  Modal,
  Linking,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { supabase } from "../lib/supabase";

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = "summary" | "reason" | "confirm" | "success" | "error";

const DELETION_REASONS = [
  "No longer using the app",
  "Privacy concerns",
  "My child has outgrown the app",
  "Switching to a different service",
  "Technical issues with the app",
  "I want to restart with a fresh account",
  "Other",
] as const;

type DeletionReason = typeof DELETION_REASONS[number];

// ─── Props ────────────────────────────────────────────────────────────────────

export interface DataDeletionScreenProps {
  visible:   boolean;
  onClose:   () => void;
  /** Called after successful submission. Navigate to Auth screen here. */
  onDeleted: () => void;
}

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
  danger:       "#dc2626",
  dangerLight:  "#fff1f2",
  dangerBorder: "#fecdd3",
  dangerDark:   "#9f1239",
  green:        "#059669",
  greenLight:   "#ecfdf5",
  warnBg:       "#fffbeb",
  warnBorder:   "#fde68a",
  warnText:     "#92400e",
  keepBg:       "#f0fdf4",
  keepBorder:   "#bbf7d0",
  keepText:     "#14532d",
  white:        "#ffffff",
} as const;

// ─── Step 1: Summary ──────────────────────────────────────────────────────────

function SummaryStep({
  onContinue,
  onCancel,
}: {
  onContinue: () => void;
  onCancel:   () => void;
}) {
  const DELETED_ITEMS = [
    { emoji: "📧", label: "Your parent account (email address and display name)" },
    { emoji: "👧🧒", label: "All child profiles (names, age bands, avatars)" },
    { emoji: "📖", label: "All Word Tome entries and vocabulary history" },
    { emoji: "🗺️", label: "All quest progress and quest completions" },
    { emoji: "⭐", label: "All XP, streaks, and mastery scores" },
    { emoji: "📸", label: "All scan attempt logs (object labels, verdicts, timestamps)" },
  ];

  const RETAINED_ITEMS = [
    {
      emoji: "📋",
      label: "Parental consent record",
      reason: "7-year legal retention — required by COPPA and GDPR to demonstrate compliance",
    },
    {
      emoji: "📝",
      label: "This deletion request record",
      reason: "7-year legal retention — required to demonstrate we honoured your request promptly",
    },
  ];

  return (
    <>
      <View style={styles.dangerBadge}>
        <Text style={styles.dangerBadgeEmoji}>⚠️</Text>
      </View>

      <Text style={styles.stepTitle}>This permanently deletes your account</Text>
      <Text style={styles.stepBody}>
        This action is irreversible. Under COPPA and GDPR, all your data will be
        deleted within 30 days. Child data is deleted{" "}
        <Text style={styles.bold}>immediately</Text>.
      </Text>

      {/* What gets deleted */}
      <View style={styles.deletedCard}>
        <Text style={styles.deletedCardTitle}>🗑️  Will be permanently deleted</Text>
        {DELETED_ITEMS.map((item) => (
          <View key={item.label} style={styles.listRow}>
            <Text style={styles.listEmoji}>{item.emoji}</Text>
            <Text style={styles.listLabel}>{item.label}</Text>
          </View>
        ))}
        <View style={styles.deletedTimeline}>
          <Text style={styles.deletedTimelineText}>
            Child data: deleted <Text style={styles.bold}>within 24 hours</Text>
            {"\n"}
            Parent account: deleted <Text style={styles.bold}>within 30 days</Text>
          </Text>
        </View>
      </View>

      {/* What is legally retained */}
      <View style={styles.retainedCard}>
        <Text style={styles.retainedCardTitle}>📌  Legally required to retain (no personal content)</Text>
        {RETAINED_ITEMS.map((item) => (
          <View key={item.label} style={styles.retainedRow}>
            <View style={styles.listRow}>
              <Text style={styles.listEmoji}>{item.emoji}</Text>
              <Text style={styles.listLabel}>{item.label}</Text>
            </View>
            <Text style={styles.retainedReason}>{item.reason}</Text>
          </View>
        ))}
      </View>

      <TouchableOpacity
        style={styles.dangerBtn}
        onPress={onContinue}
        accessibilityRole="button"
        accessibilityLabel="I understand — continue with account deletion"
      >
        <Text style={styles.dangerBtnText}>I understand — Continue</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.cancelBtn}
        onPress={onCancel}
        accessibilityRole="button"
        accessibilityLabel="Cancel and keep my account"
      >
        <Text style={styles.cancelBtnText}>Cancel — Keep my account</Text>
      </TouchableOpacity>
    </>
  );
}

// ─── Step 2: Reason ───────────────────────────────────────────────────────────

function ReasonStep({
  reason,
  onSelect,
  onContinue,
  onBack,
}: {
  reason:     DeletionReason | null;
  onSelect:   (r: DeletionReason) => void;
  onContinue: () => void;
  onBack:     () => void;
}) {
  return (
    <>
      <Text style={styles.stepTitle}>Why are you leaving?</Text>
      <Text style={styles.stepBody}>
        Completely optional. Your feedback helps us improve Lexi-Lens for
        other families. You can skip this step.
      </Text>

      <View style={styles.reasonList}>
        {DELETION_REASONS.map((r) => (
          <TouchableOpacity
            key={r}
            style={[styles.reasonItem, reason === r && styles.reasonItemSelected]}
            onPress={() => {
              onSelect(r);
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected: reason === r }}
          >
            <View style={[styles.radio, reason === r && styles.radioSelected]}>
              {reason === r && <View style={styles.radioDot} />}
            </View>
            <Text style={[styles.reasonText, reason === r && styles.reasonTextSelected]}>
              {r}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity
        style={styles.dangerBtn}
        onPress={onContinue}
        accessibilityRole="button"
      >
        <Text style={styles.dangerBtnText}>
          {reason ? "Continue →" : "Skip & Continue →"}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.cancelBtn} onPress={onBack} accessibilityRole="button">
        <Text style={styles.cancelBtnText}>← Go back</Text>
      </TouchableOpacity>
    </>
  );
}

// ─── Step 3: Final confirmation ───────────────────────────────────────────────

function ConfirmStep({
  confirmation,
  onConfirmChange,
  onDelete,
  loading,
  onBack,
}: {
  confirmation:   string;
  onConfirmChange: (v: string) => void;
  onDelete:       () => void;
  loading:        boolean;
  onBack:         () => void;
}) {
  const isConfirmed = confirmation.trim().toUpperCase() === "DELETE";

  return (
    <>
      <Text style={styles.stepTitle}>Final confirmation</Text>
      <Text style={styles.stepBody}>
        Type <Text style={styles.boldDanger}>DELETE</Text> in the box below
        to permanently delete your account.
      </Text>

      <View style={styles.confirmCard}>
        <Text style={styles.confirmHint}>Type DELETE to confirm:</Text>
        <TextInput
          style={[
            styles.confirmInput,
            isConfirmed && styles.confirmInputValid,
          ]}
          value={confirmation}
          onChangeText={onConfirmChange}
          placeholder="DELETE"
          placeholderTextColor={P.inkFaint}
          autoCapitalize="characters"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={isConfirmed ? onDelete : undefined}
          accessibilityLabel="Type DELETE to confirm account deletion"
        />
        {isConfirmed && (
          <Text style={styles.confirmCheckmark}>✓ Confirmed</Text>
        )}
      </View>

      {/* Warning box */}
      <View style={styles.warningBox}>
        <Text style={styles.warningText}>
          ⚠️  Child data is deleted within 24 hours. Your parent account will
          be fully deleted within 30 days. You will receive an email confirmation
          once the deletion is complete.
        </Text>
      </View>

      <TouchableOpacity
        style={[
          styles.dangerBtn,
          styles.dangerBtnFull,
          (!isConfirmed || loading) && styles.dangerBtnDisabled,
        ]}
        onPress={onDelete}
        disabled={!isConfirmed || loading}
        accessibilityRole="button"
        accessibilityLabel="Permanently delete my account"
        accessibilityState={{ disabled: !isConfirmed || loading }}
      >
        {loading ? (
          <ActivityIndicator color={P.white} />
        ) : (
          <Text style={styles.dangerBtnText}>🗑️  Permanently Delete My Account</Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.cancelBtn}
        onPress={onBack}
        disabled={loading}
        accessibilityRole="button"
      >
        <Text style={styles.cancelBtnText}>← Go back</Text>
      </TouchableOpacity>
    </>
  );
}

// ─── Terminal: Success ────────────────────────────────────────────────────────

function SuccessStep() {
  return (
    <View style={styles.terminalWrap}>
      <Text style={styles.terminalEmoji}>✅</Text>
      <Text style={styles.terminalTitle}>Deletion request received</Text>
      <Text style={styles.terminalBody}>
        Your child's data has been deleted immediately.{"\n\n"}
        Your parent account is scheduled for full deletion within 30 days.
        You will receive an email confirmation once complete.{"\n\n"}
        You are now being signed out.
      </Text>
    </View>
  );
}

// ─── Terminal: Error ──────────────────────────────────────────────────────────

function ErrorStep({
  message,
  onRetry,
  onClose,
}: {
  message:  string | null;
  onRetry:  () => void;
  onClose:  () => void;
}) {
  return (
    <View style={styles.terminalWrap}>
      <Text style={styles.terminalEmoji}>❌</Text>
      <Text style={styles.terminalTitle}>Something went wrong</Text>
      <Text style={styles.terminalBody}>
        {message ?? "Unable to process your deletion request at this time."}
        {"\n\n"}
        Please try again. If the problem persists, email us and we will
        manually process your deletion within 30 days.
      </Text>

      <TouchableOpacity
        style={[styles.dangerBtn, { marginTop: 8 }]}
        onPress={onRetry}
        accessibilityRole="button"
      >
        <Text style={styles.dangerBtnText}>Try again</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.emailFallbackBtn}
        onPress={() => Linking.openURL("mailto:privacy@lexi-lens.app?subject=Data%20Deletion%20Request").catch(() => null)}
        accessibilityRole="link"
      >
        <Text style={styles.emailFallbackText}>📬  Email privacy@lexi-lens.app</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.cancelBtn} onPress={onClose} accessibilityRole="button">
        <Text style={styles.cancelBtnText}>Close</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export function DataDeletionScreen({ visible, onClose, onDeleted }: DataDeletionScreenProps) {
  const insets = useSafeAreaInsets();

  const [step,         setStep]         = useState<Step>("summary");
  const [reason,       setReason]       = useState<DeletionReason | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [loading,      setLoading]      = useState(false);
  const [errorMsg,     setErrorMsg]     = useState<string | null>(null);

  const reset = useCallback(() => {
    setStep("summary");
    setReason(null);
    setConfirmation("");
    setLoading(false);
    setErrorMsg(null);
  }, []);

  const handleClose = useCallback(() => {
    if (step === "success") return; // Signing out — don't let them close
    reset();
    onClose();
  }, [step, reset, onClose]);

  const handleDelete = useCallback(async () => {
    if (confirmation.trim().toUpperCase() !== "DELETE") return;

    setLoading(true);
    setErrorMsg(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Your session has expired. Please sign in again.");

      const { data, error } = await supabase.functions.invoke("request-deletion", {
        body: {
          reason:       reason ?? "Not specified",
          confirmation: confirmation.trim().toUpperCase(), // Server re-validates this
        },
      });

      if (error) throw new Error(error.message ?? "Deletion request failed");
      if (!data?.success) throw new Error("Server returned an unexpected response");

      // Success path
      setStep("success");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      // Auto sign-out after brief delay so user can read the success message
      setTimeout(async () => {
        await supabase.auth.signOut().catch(() => null);
        onDeleted();
      }, 3500);

    } catch (err: any) {
      const msg: string = err?.message ?? "An unknown error occurred.";
      setErrorMsg(msg);
      setStep("error");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoading(false);
    }
  }, [confirmation, reason, onDeleted]);

  const isSuccess = step === "success";

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      onRequestClose={handleClose}
      statusBarTranslucent
    >
      <View style={[styles.root, { paddingTop: insets.top }]}>

        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backBtn}
            onPress={handleClose}
            disabled={isSuccess || loading}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            {!isSuccess && !loading && (
              <Text style={styles.backBtnText}>← Back</Text>
            )}
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Delete Account</Text>
          <View style={{ width: 60 }} />
        </View>

        {/* Step indicator */}
        {!isSuccess && step !== "error" && (
          <View style={styles.stepIndicator}>
            {(["summary", "reason", "confirm"] as Step[]).map((s, i) => (
              <View
                key={s}
                style={[
                  styles.stepDot,
                  step === s && styles.stepDotActive,
                  (["summary", "reason", "confirm"] as Step[]).indexOf(step) > i && styles.stepDotDone,
                ]}
              />
            ))}
          </View>
        )}

        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 32 }]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {step === "summary" && (
            <SummaryStep
              onContinue={() => setStep("reason")}
              onCancel={handleClose}
            />
          )}
          {step === "reason" && (
            <ReasonStep
              reason={reason}
              onSelect={setReason}
              onContinue={() => setStep("confirm")}
              onBack={() => setStep("summary")}
            />
          )}
          {step === "confirm" && (
            <ConfirmStep
              confirmation={confirmation}
              onConfirmChange={setConfirmation}
              onDelete={handleDelete}
              loading={loading}
              onBack={() => setStep("reason")}
            />
          )}
          {step === "success" && <SuccessStep />}
          {step === "error" && (
            <ErrorStep
              message={errorMsg}
              onRetry={() => { setStep("confirm"); setConfirmation(""); }}
              onClose={handleClose}
            />
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: P.cream },

  header: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    paddingHorizontal: 20,
    paddingVertical:   14,
    borderBottomWidth: 1,
    borderBottomColor: P.warmBorder,
  },
  backBtn:     { width: 60 },
  backBtnText: { fontSize: 15, color: P.amber, fontWeight: "700" },
  headerTitle: { fontSize: 17, fontWeight: "700", color: P.inkBrown },

  stepIndicator: {
    flexDirection:  "row",
    justifyContent: "center",
    gap:            8,
    paddingVertical: 12,
  },
  stepDot: {
    width:           8,
    height:          8,
    borderRadius:    4,
    backgroundColor: P.warmBorder,
  },
  stepDotActive: { backgroundColor: P.danger, width: 20, borderRadius: 4 },
  stepDotDone:   { backgroundColor: "#fca5a5" },

  scroll: { paddingHorizontal: 20, paddingTop: 20 },

  // Step shared
  dangerBadge:      { alignItems: "center", marginBottom: 16 },
  dangerBadgeEmoji: { fontSize: 60 },
  stepTitle: { fontSize: 22, fontWeight: "800", color: P.inkBrown, textAlign: "center", marginBottom: 10 },
  stepBody:  { fontSize: 14, color: P.inkMid, lineHeight: 21, textAlign: "center", marginBottom: 22 },
  bold:      { fontWeight: "700", color: P.inkBrown },
  boldDanger:{ fontWeight: "700", color: P.dangerDark },

  // Deleted items card
  deletedCard: {
    backgroundColor: P.dangerLight,
    borderRadius:    16,
    borderWidth:     1,
    borderColor:     P.dangerBorder,
    padding:         16,
    marginBottom:    12,
  },
  deletedCardTitle:    { fontSize: 14, fontWeight: "700", color: P.dangerDark, marginBottom: 14 },
  deletedTimeline: {
    marginTop:       12,
    backgroundColor: P.white,
    borderRadius:    10,
    padding:         10,
    borderWidth:     1,
    borderColor:     P.dangerBorder,
  },
  deletedTimelineText: { fontSize: 13, color: P.dangerDark, lineHeight: 21 },

  // Retained card
  retainedCard: {
    backgroundColor: P.keepBg,
    borderRadius:    16,
    borderWidth:     1,
    borderColor:     P.keepBorder,
    padding:         16,
    marginBottom:    24,
  },
  retainedCardTitle: { fontSize: 14, fontWeight: "700", color: P.keepText, marginBottom: 12 },
  retainedRow:       { marginBottom: 10 },
  retainedReason:    { fontSize: 12, color: P.inkLight, lineHeight: 17, marginLeft: 28, marginTop: 2 },

  // List rows
  listRow:   { flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: 8 },
  listEmoji: { fontSize: 16, lineHeight: 22 },
  listLabel: { fontSize: 13, color: P.inkMid, flex: 1, lineHeight: 20 },

  // Reason selector
  reasonList: { gap: 10, marginBottom: 24 },
  reasonItem: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             12,
    padding:         14,
    borderRadius:    12,
    backgroundColor: P.white,
    borderWidth:     1,
    borderColor:     P.warmBorder,
  },
  reasonItemSelected: { borderColor: P.danger, backgroundColor: P.dangerLight },
  radio: {
    width:           22,
    height:          22,
    borderRadius:    11,
    borderWidth:     2,
    borderColor:     P.warmBorder,
    alignItems:      "center",
    justifyContent:  "center",
    flexShrink:      0,
  },
  radioSelected: { borderColor: P.danger },
  radioDot:      { width: 10, height: 10, borderRadius: 5, backgroundColor: P.danger },
  reasonText:         { fontSize: 14, color: P.inkMid, flex: 1 },
  reasonTextSelected: { color: P.dangerDark, fontWeight: "600" },

  // Confirm step
  confirmCard: {
    backgroundColor: P.white,
    borderRadius:    16,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    padding:         20,
    marginBottom:    16,
  },
  confirmHint:       { fontSize: 14, fontWeight: "600", color: P.inkMid, marginBottom: 12 },
  confirmInput: {
    backgroundColor:   P.parchment,
    borderRadius:      12,
    borderWidth:       1.5,
    borderColor:       P.warmBorder,
    paddingHorizontal: 14,
    paddingVertical:   14,
    fontSize:          20,
    color:             P.inkBrown,
    textAlign:         "center",
    fontWeight:        "700",
    letterSpacing:     6,
  },
  confirmInputValid: { borderColor: P.green, backgroundColor: P.greenLight },
  confirmCheckmark:  { fontSize: 13, color: P.green, fontWeight: "700", textAlign: "center", marginTop: 8 },

  warningBox: {
    backgroundColor: P.warnBg,
    borderRadius:    12,
    borderWidth:     1,
    borderColor:     P.warnBorder,
    padding:         14,
    marginBottom:    20,
  },
  warningText: { fontSize: 13, color: P.warnText, lineHeight: 20 },

  // Buttons
  dangerBtn: {
    backgroundColor: P.danger,
    borderRadius:    16,
    paddingVertical: 16,
    alignItems:      "center",
    marginBottom:    12,
  },
  dangerBtnFull:     {},
  dangerBtnDisabled: { opacity: 0.4 },
  dangerBtnText:     { fontSize: 15, fontWeight: "700", color: P.white },

  cancelBtn: {
    borderWidth:     1,
    borderColor:     P.warmBorder,
    borderRadius:    16,
    paddingVertical: 14,
    alignItems:      "center",
    marginBottom:    12,
  },
  cancelBtnText: { fontSize: 14, fontWeight: "600", color: P.inkMid },

  emailFallbackBtn: {
    backgroundColor: P.parchment,
    borderRadius:    14,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    paddingVertical: 14,
    alignItems:      "center",
    marginBottom:    12,
  },
  emailFallbackText: { fontSize: 14, fontWeight: "600", color: P.amber },

  // Terminal states
  terminalWrap:  { alignItems: "center", paddingTop: 32 },
  terminalEmoji: { fontSize: 68, marginBottom: 20 },
  terminalTitle: { fontSize: 22, fontWeight: "800", color: P.inkBrown, textAlign: "center", marginBottom: 16 },
  terminalBody:  { fontSize: 14, color: P.inkMid, lineHeight: 22, textAlign: "center", marginBottom: 28 },
});
