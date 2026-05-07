/**
 * VerdictCard.tsx — Lexi-Lens result card
 *
 * v4.7 additions (Compliance polish — verdict reporting):
 *   • Adds a small "Report" button beneath the action button on any
 *     non-error verdict. Tapping opens a modal sheet with five reason
 *     buttons (wrong_object, wrong_property, feels_inappropriate,
 *     too_hard, too_easy) plus an "Other" path with a 200-char note
 *     field.
 *   • The submission goes to the report-verdict Edge Function which
 *     verifies parent ownership of the scan_attempt server-side. The
 *     button does NOT show on error states (no scan_attempt to link to).
 *   • While the submission is in flight, the button shows "Sending…";
 *     on success, a subtle "Thanks — report sent" confirmation appears
 *     in place of the button (it doesn't auto-dismiss the card so the
 *     child can still tap Continue / Try again).
 *   • On failure (network, 401, 403, 500), shows "Report failed — try
 *     again later" without leaking the specific error to the child.
 *   • The free-text note never goes to Sentry — only the structured
 *     reason and the scan_attempt context. The note is a privacy-
 *     sensitive field gated behind RLS.
 *
 * v3.4 additions (Redis Response Caching):
 *   • Accepts cacheHit prop from useLexiEvaluate
 *   • Shows a small "⚡ Instant" pill beneath the resolved object name
 *     when the result came from Redis cache (< 10 ms response).
 *   • Parents won't see it; children will think the magic is extra fast ✨
 *
 * Verdict logic:
 *  - If ANY property newly passes → show "✦ Found X properties!" (even if not all pass)
 *  - Show passing properties in GREEN, failing in RED
 *  - If nothing new found → show "Almost..." with red/green split
 *  - "Continue quest" when something found, "Try another object" when nothing found
 */

import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Animated,
  Dimensions,
  Platform,
  Modal,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { EvaluationResult, EvaluateStatus } from "../hooks/useLexiEvaluate";
import type { MasteryUpdateResult } from "../services/MasteryService";
import { supabase } from "../lib/supabase";
import { ENV } from "../lib/env";
import { addGameBreadcrumb, captureVerdictReport } from "../lib/sentry";

interface VerdictCardProps {
  status:         Extract<EvaluateStatus, "match" | "no-match" | "error">;
  result?:        EvaluationResult | null;
  error?:         string | null;
  /** v1.5 — pass masteryResult from useLexiEvaluate; shows "Word Mastered!" banner */
  masteryResult?: MasteryUpdateResult | null;
  /** v3.4 — true when result served from Redis cache (< 10 ms) */
  cacheHit?:      boolean;
  /** v4.7 — scan_attempts.id for this verdict; enables the Report button */
  scanAttemptId?: string | null;
  onContinue:     () => void;
  onTryAgain:     () => void;
}

const { height: SCREEN_H } = Dimensions.get("window");
const CARD_H = SCREEN_H * 0.62;

const P = {
  deepPurple:  "#0f0620",
  midPurple:   "#1a0a35",
  cardBg:      "#1e1040",
  cardBorder:  "#3d2080",
  gold:        "#f5c842",
  goldText:    "#fde68a",
  textPrimary: "#f3e8ff",
  textMuted:   "#a78bfa",
  textDim:     "#6b5fa0",
  passBg:      "#052e16",
  passBorder:  "#166534",
  passText:    "#86efac",
  failBg:      "#1f0505",
  failBorder:  "#7f1d1d",
  failText:    "#fca5a5",
};

// ─── Cache hit pill ───────────────────────────────────────────────────────────

/**
 * Tiny "⚡ Instant" pill — appears when the result came from Redis.
 * Fades in with a gentle animation so it doesn't distract from the verdict.
 * Only visible to parents who peek at dev logs; children just see fast magic.
 */
function CacheHitPill() {
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: 1, duration: 400, delay: 200, useNativeDriver: true,
    }).start();
  }, []);

  return (
    <Animated.View style={[styles.cachePill, { opacity }]}>
      <Text style={styles.cachePillText}>⚡ Instant</Text>
    </Animated.View>
  );
}

// ─── Property badge ────────────────────────────────────────────────────────────

function PropertyBadge({ word, passes, reasoning }: {
  word: string; passes: boolean; reasoning: string;
}) {
  return (
    <View style={[styles.badge, passes ? styles.badgePass : styles.badgeFail]}>
      <View style={styles.badgeRow}>
        <Text style={{ fontSize: 12, marginRight: 6, color: passes ? P.passText : P.failText }}>
          {passes ? "✦" : "✕"}
        </Text>
        <Text style={[styles.badgeWord, { color: passes ? P.passText : P.failText }]}>
          {word}
        </Text>
      </View>
      <Text style={styles.badgeReason}>{reasoning.replace(/\s*\[auto-corrected:[^\]]*\]/g, "").trim()}</Text>
    </View>
  );
}

// ─── XP counter ───────────────────────────────────────────────────────────────

function XPCounter({ xp }: { xp: number }) {
  const [display, setDisplay] = React.useState(0);
  const scaleAnim = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    Animated.spring(scaleAnim, {
      toValue: 1, useNativeDriver: true, tension: 80, friction: 6,
    }).start();

    const steps = 20;
    const interval = 900 / steps;
    let current = 0;
    const timer = setInterval(() => {
      current += 1;
      setDisplay(Math.round((current / steps) * xp));
      if (current >= steps) clearInterval(timer);
    }, interval);

    return () => clearInterval(timer);
  }, [xp]);

  return (
    <Animated.View style={[styles.xpBadge, { transform: [{ scale: scaleAnim }] }]}>
      <Text style={styles.xpNum}>{display}</Text>
      <Text style={styles.xpLbl}>XP</Text>
    </Animated.View>
  );
}

// ─── v4.7: Verdict report types + sheet ───────────────────────────────────────

type ReportReason =
  | "wrong_object"
  | "wrong_property"
  | "feels_inappropriate"
  | "too_hard"
  | "too_easy"
  | "other";

type ReportSubmitState = "idle" | "sending" | "success" | "error";

const REPORT_REASONS: Array<{ value: ReportReason; label: string; emoji: string }> = [
  { value: "wrong_object",        label: "Wrong object",            emoji: "🔍" },
  { value: "wrong_property",      label: "Wrong about a property",  emoji: "✖️" },
  { value: "feels_inappropriate", label: "Feels not right for kids", emoji: "🛡️" },
  { value: "too_hard",            label: "Too hard for my child",   emoji: "🧗" },
  { value: "too_easy",            label: "Too easy for my child",   emoji: "🪶" },
  { value: "other",               label: "Something else",          emoji: "💬" },
];

interface ReportSheetProps {
  visible:         boolean;
  scanAttemptId:   string;
  detectedLabel?:  string | null;
  resolvedName?:   string | null;
  cacheHit?:       boolean;
  questId?:        string;
  onClose:         () => void;
}

/**
 * Modal sheet shown when the user taps the small "Report" button on a verdict.
 *
 * Two-step flow:
 *   Step 1 — choose a reason. Tapping any non-"other" reason submits
 *            immediately (no friction; the child / parent shouldn't have to
 *            type to flag a clear miss).
 *   Step 2 — only shown for the "Other" reason: optional 200-char note,
 *            then Submit.
 *
 * After submission:
 *   • Success → swap to a brief "Thanks — sent" view with a Done button.
 *   • Error   → inline message; reasons stay tappable for retry.
 */
function ReportSheet({
  visible,
  scanAttemptId,
  detectedLabel,
  resolvedName,
  cacheHit,
  questId,
  onClose,
}: ReportSheetProps) {
  const [selected, setSelected]   = useState<ReportReason | null>(null);
  const [note,     setNote]       = useState("");
  const [state,    setState]      = useState<ReportSubmitState>("idle");
  const [errMsg,   setErrMsg]     = useState<string | null>(null);

  // Reset transient state every time the sheet is freshly opened.
  useEffect(() => {
    if (visible) {
      setSelected(null);
      setNote("");
      setState("idle");
      setErrMsg(null);
    }
  }, [visible]);

  async function submit(reason: ReportReason) {
    setState("sending");
    setErrMsg(null);

    try {
      const { data, error } = await supabase.functions.invoke("report-verdict", {
        body: {
          scanAttemptId,
          reason,
          note:        reason === "other" ? note.trim().slice(0, 200) : undefined,
          appVariant:  ENV.variant,
          appVersion:  ENV.appVersion,
        },
      });

      if (error || !data || (data as { ok?: boolean }).ok !== true) {
        throw new Error(error?.message ?? "Submission failed");
      }

      // Mirror to Sentry as a "warning" event so spikes show on the
      // crash dashboard. Note is intentionally NOT included.
      captureVerdictReport({
        scanAttemptId,
        questId,
        detectedLabel: detectedLabel ?? undefined,
        resolvedName:  resolvedName  ?? undefined,
        reason,
        cacheHit,
      });

      addGameBreadcrumb({
        category: "report",
        message:  `Verdict reported: ${reason}`,
        data:     { scanAttemptId, reason, cacheHit: cacheHit ?? false },
      });

      setState("success");
    } catch (e) {
      // Don't leak the underlying error to the user — this is a
      // child-facing UI. Generic message + Sentry breadcrumb for triage.
      addGameBreadcrumb({
        category: "report",
        message:  "Verdict report submission failed",
        level:    "warning",
        data:     {
          scanAttemptId,
          reason,
          message: e instanceof Error ? e.message : String(e),
        },
      });
      setErrMsg("Couldn't send report — please try again in a bit.");
      setState("error");
    }
  }

  function handleReasonTap(r: ReportReason) {
    setSelected(r);
    if (r !== "other") {
      // Clear-cut reason: submit immediately, no friction.
      submit(r);
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={state === "sending" ? undefined : onClose}
    >
      <KeyboardAvoidingView
        style={reportStyles.backdrop}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={reportStyles.sheet}>
          <View style={reportStyles.handle} />

          {state === "success" ? (
            <View style={reportStyles.successWrap}>
              <Text style={reportStyles.successEmoji}>✦</Text>
              <Text style={reportStyles.successTitle}>Thanks — report sent</Text>
              <Text style={reportStyles.successBody}>
                We'll review this verdict to make Lexi-Lens better.
              </Text>
              <TouchableOpacity
                style={reportStyles.doneBtn}
                onPress={onClose}
              >
                <Text style={reportStyles.doneBtnText}>Done</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <Text style={reportStyles.sheetTitle}>What's wrong with this verdict?</Text>
              <Text style={reportStyles.sheetSubtitle}>
                Tap a reason to send a report. We use these to improve the app.
              </Text>

              <ScrollView style={reportStyles.reasonList} showsVerticalScrollIndicator={false}>
                {REPORT_REASONS.map((r) => {
                  const isSel    = selected === r.value;
                  const disabled = state === "sending";
                  return (
                    <TouchableOpacity
                      key={r.value}
                      style={[
                        reportStyles.reasonBtn,
                        isSel && reportStyles.reasonBtnSelected,
                        disabled && reportStyles.reasonBtnDisabled,
                      ]}
                      onPress={() => handleReasonTap(r.value)}
                      disabled={disabled}
                    >
                      <Text style={reportStyles.reasonEmoji}>{r.emoji}</Text>
                      <Text style={reportStyles.reasonLabel}>{r.label}</Text>
                      {isSel && state === "sending" && (
                        <ActivityIndicator size="small" color="#a78bfa" style={{ marginLeft: 8 }} />
                      )}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>

              {selected === "other" && state !== "sending" && (
                <View style={reportStyles.noteWrap}>
                  <TextInput
                    style={reportStyles.noteInput}
                    value={note}
                    onChangeText={(t) => setNote(t.slice(0, 200))}
                    placeholder="Tell us a bit more (optional, 200 chars)"
                    placeholderTextColor="#6b5fa0"
                    multiline
                    maxLength={200}
                    editable={state !== "sending"}
                  />
                  <View style={reportStyles.noteRow}>
                    <Text style={reportStyles.noteCount}>{note.length}/200</Text>
                    <TouchableOpacity
                      style={reportStyles.submitBtn}
                      onPress={() => submit("other")}
                    >
                      <Text style={reportStyles.submitBtnText}>Send report</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {errMsg && (
                <Text style={reportStyles.errorText}>{errMsg}</Text>
              )}

              <TouchableOpacity
                style={reportStyles.cancelBtn}
                onPress={onClose}
                disabled={state === "sending"}
              >
                <Text style={reportStyles.cancelBtnText}>
                  {state === "sending" ? "Sending…" : "Cancel"}
                </Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function VerdictCard({
  status, result, error, masteryResult, cacheHit, scanAttemptId, onContinue, onTryAgain,
}: VerdictCardProps) {
	
	  //console.log("[VerdictCard] scanAttemptId=", scanAttemptId, "status=", status);  // ← ADD THIS

  const insets    = useSafeAreaInsets();
  const slideAnim = useRef(new Animated.Value(CARD_H)).current;

  // v4.7 — verdict report sheet state
  const [reportOpen, setReportOpen] = useState(false);

  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: 0, useNativeDriver: true, tension: 60, friction: 12,
    }).start();
  }, []);

  // FIX: result?.properties is undefined when the Edge Function returns a
  // partial/malformed response. Without ?. after .properties, calling
  // .filter() on undefined crashes VerdictCard during render.
  const passingProps   = result?.properties?.filter((p) => p.passes) ?? [];
  const failingProps   = result?.properties?.filter((p) => !p.passes) ?? [];
  const somethingFound = passingProps.length > 0;
  const totalXpEarned  = result?.xpAwarded ?? 0;

  return (
    <Animated.View
      style={[
        styles.container,
        { paddingBottom: insets.bottom + 16 },
        { transform: [{ translateY: slideAnim }] },
      ]}
      accessibilityLiveRegion="polite"
    >
      <View style={[
        styles.card,
        somethingFound && { borderColor: "#3d8060" },
      ]}>
        <View style={styles.handle} />

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>

          {/* ── Error ──────────────────────────────────────── */}
          {status === "error" && (
            <>
              <View style={styles.header}>
                <Text style={styles.headerEmoji}>✦</Text>
                <Text style={styles.headerTitle}>The Lens flickered</Text>
              </View>
              <View style={styles.feedbackBox}>
                <Text style={styles.feedbackText}>
                  Something got in the way of the magic. Point at the object again and try!
                </Text>
                {!!error && (
                  <Text style={{ color: "#fca5a5", fontSize: 11, marginTop: 8 }}>
                    {error}
                  </Text>
                )}
              </View>
              <TouchableOpacity style={styles.retryBtn} onPress={onTryAgain}>
                <Text style={styles.retryBtnText}>Try again</Text>
              </TouchableOpacity>
            </>
          )}

          {/* ── Has result (match or no-match) ──────────────── */}
          {result && (status === "match" || status === "no-match") && (
            <>
              {/* Header */}
              <View style={styles.header}>
                <Text style={styles.headerEmoji}>{somethingFound ? "⚡" : "🔮"}</Text>
                <Text style={[
                  styles.headerTitle,
                  { color: somethingFound ? P.gold : P.textPrimary },
                ]}>
                  {somethingFound
                    ? `${passingProps.length} propert${passingProps.length === 1 ? "y" : "ies"} found!`
                    : "Almost…"}
                </Text>

                {/* Resolved object name + optional cache pill */}
                <View style={styles.resolvedRow}>
                  <Text style={styles.resolvedName}>{result.resolvedObjectName}</Text>
                  {cacheHit && <CacheHitPill />}
                </View>
              </View>

              {/* XP badge */}
              {somethingFound && totalXpEarned > 0 && (
                <>
                  {/* Multi-property bonus pill — matches Phase 1.2 edge function math */}
                  {passingProps.length >= 2 && (
                    <View style={styles.bonusPill}>
                      <Text style={styles.bonusPillText}>
                        {passingProps.length >= 3 ? "2× multi-property bonus!" : "1.5× bonus!"}
                      </Text>
                    </View>
                  )}
                  <XPCounter xp={totalXpEarned} />
                </>
              )}

              {/* Claude's child-friendly feedback */}
              <View style={styles.feedbackBox}>
                <Text style={styles.feedbackText}>{result.childFeedback}</Text>
              </View>

              {/* Passing properties (GREEN) */}
              {passingProps.length > 0 && (
                <View style={styles.section}>
                  <Text style={styles.sectionLabel}>✦ Found this scan</Text>
                  {passingProps.map((p) => (
                    <PropertyBadge key={p.word} word={p.word} passes={true} reasoning={p.reasoning} />
                  ))}
                </View>
              )}

              {/* Failing properties (RED) */}
              {failingProps.length > 0 && (
                <View style={styles.section}>
                  <Text style={styles.sectionLabel}>✕ Not this object</Text>
                  {failingProps.map((p) => (
                    <PropertyBadge key={p.word} word={p.word} passes={false} reasoning={p.reasoning} />
                  ))}
                </View>
              )}

              {/* Nudge hint after multiple failures */}
              {!somethingFound && result.nudgeHint && (
                <View style={styles.hintBox}>
                  <Text style={styles.hintLabel}>Hint from the tome</Text>
                  <Text style={styles.hintText}>{result.nudgeHint}</Text>
                </View>
              )}

              {/* v1.5 — Word Mastered! banner */}
              {masteryResult?.justRetired && (
                <View style={styles.masteryBanner}>
                  <Text style={styles.masteryIcon}>🌟</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.masteryTitle}>Word Mastered!</Text>
                    <Text style={styles.masteryBody}>
                      {masteryResult.synonym
                        ? `You've truly learned "${masteryResult.word}". Your next challenge: "${masteryResult.synonym.synonym}"!`
                        : `You've truly learned "${masteryResult.word}". Amazing work, Scholar!`}
                    </Text>
                  </View>
                </View>
              )}

              {/* Buttons */}
              {somethingFound ? (
                <TouchableOpacity style={styles.primaryBtn} onPress={onContinue}>
                  <Text style={styles.primaryBtnText}>Continue quest ✦</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity style={styles.retryBtn} onPress={onTryAgain}>
                  <Text style={styles.retryBtnText}>Try another object</Text>
                </TouchableOpacity>
              )}

              {/* v4.7 — Report this verdict (small, low-visibility link) */}
              {scanAttemptId && (
                <TouchableOpacity
                  style={styles.reportLink}
                  onPress={() => setReportOpen(true)}
                  accessibilityLabel="Report this verdict"
                >
                  <Text style={styles.reportLinkText}>⚐ Report this verdict</Text>
                </TouchableOpacity>
              )}
            </>
          )}

        </ScrollView>
      </View>

      {/* v4.7 — Report sheet (rendered outside the card so the modal layers cleanly) */}
      {scanAttemptId && (
        <ReportSheet
          visible={reportOpen}
          scanAttemptId={scanAttemptId}
          detectedLabel={result?.resolvedObjectName ?? null}
          resolvedName={result?.resolvedObjectName ?? null}
          cacheHit={cacheHit}
          onClose={() => setReportOpen(false)}
        />
      )}
    </Animated.View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    position: "absolute", bottom: 0, left: 0, right: 0,
    paddingHorizontal: 12,
  },
  card: {
    backgroundColor: P.cardBg,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: P.cardBorder,
    maxHeight: CARD_H,
    overflow: "hidden",
    ...Platform.select({
      ios:     { shadowColor: "#7c3aed", shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.4, shadowRadius: 20 },
      android: { elevation: 16 },
    }),
  },
  handle: {
    width: 40, height: 4, backgroundColor: P.textDim,
    borderRadius: 2, alignSelf: "center", marginTop: 10, marginBottom: 4,
  },
  scroll: { paddingHorizontal: 20, paddingBottom: 8 },

  // Header
  header:       { alignItems: "center", paddingTop: 12, marginBottom: 8 },
  headerEmoji:  { fontSize: 36, marginBottom: 6 },
  headerTitle:  { fontSize: 22, fontWeight: "700", color: P.gold, letterSpacing: 0.3, textAlign: "center" },

  // Resolved name row (name + cache pill side by side)
  resolvedRow:  { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  resolvedName: { fontSize: 13, color: P.textMuted },

  // v3.4 — Cache hit pill
  cachePill: {
    backgroundColor: "#0c1a10",
    borderColor:     "#22c55e",
    borderWidth:     1,
    borderRadius:    10,
    paddingHorizontal: 7,
    paddingVertical:   2,
  },
  cachePillText: { fontSize: 10, color: "#22c55e", fontWeight: "600", letterSpacing: 0.3 },

  // XP
  xpBadge: {
    flexDirection: "row", alignItems: "baseline", justifyContent: "center",
    backgroundColor: "#052e16", borderRadius: 40,
    paddingHorizontal: 24, paddingVertical: 8,
    alignSelf: "center", marginVertical: 12,
    borderWidth: 1, borderColor: "#166534",
  },
  xpNum: { fontSize: 32, fontWeight: "800", color: "#22c55e" },
  xpLbl: { fontSize: 14, fontWeight: "600", color: "#22c55e", marginLeft: 6 },

  // Bonus
  bonusPill: {
    alignSelf: "center", backgroundColor: "#7c3aed",
    borderRadius: 20, paddingHorizontal: 14, paddingVertical: 4, marginBottom: 6,
  },
  bonusPillText: { color: "#fff", fontSize: 13, fontWeight: "700" },

  // Feedback
  feedbackBox: {
    backgroundColor: P.midPurple, borderRadius: 12,
    padding: 14, marginVertical: 10,
    borderLeftWidth: 3, borderLeftColor: P.cardBorder,
  },
  feedbackText: { fontSize: 15, color: P.textPrimary, lineHeight: 22 },

  // Sections
  section:      { marginTop: 6 },
  sectionLabel: {
    fontSize: 11, fontWeight: "600", color: P.textDim,
    textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8,
  },

  // Property badge
  badge:       { borderRadius: 10, padding: 10, marginBottom: 8, borderWidth: 1 },
  badgePass:   { backgroundColor: P.passBg, borderColor: P.passBorder },
  badgeFail:   { backgroundColor: P.failBg, borderColor: P.failBorder },
  badgeRow:    { flexDirection: "row", alignItems: "center", marginBottom: 3 },
  badgeWord:   { fontSize: 14, fontWeight: "600" },
  badgeReason: { fontSize: 12, color: P.textDim, lineHeight: 17, marginLeft: 18 },

  // Hint
  hintBox: {
    backgroundColor: "#1a120a", borderRadius: 10,
    padding: 12, marginTop: 6,
    borderWidth: 1, borderColor: "#a88820",
  },
  hintLabel: { fontSize: 10, color: "#a88820", fontWeight: "600", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 },
  hintText:  { fontSize: 13, color: P.goldText, lineHeight: 19 },

  // Buttons
  primaryBtn: {
    backgroundColor: "#7c3aed", borderRadius: 14,
    paddingVertical: 15, alignItems: "center", marginTop: 16,
  },
  primaryBtnText: { fontSize: 16, fontWeight: "700", color: "#fff", letterSpacing: 0.3 },

  retryBtn: {
    backgroundColor: "transparent", borderRadius: 14,
    paddingVertical: 15, alignItems: "center", marginTop: 12,
    borderWidth: 1, borderColor: P.cardBorder,
  },
  retryBtnText: { fontSize: 15, fontWeight: "600", color: P.textMuted },

  // v1.5 — Mastery banner
  masteryBanner: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: "#1a1200", borderColor: "#f59e0b",
    borderWidth: 1.5, borderRadius: 12, padding: 14, marginTop: 12,
  },
  masteryIcon:  { fontSize: 28 },
  masteryTitle: { fontSize: 14, fontWeight: "700", color: "#fbbf24", marginBottom: 2 },
  masteryBody:  { fontSize: 13, color: "#fde68a", lineHeight: 18 },

  // v4.7 — Report verdict link (under main action buttons)
  reportLink: {
    alignSelf: "center",
    paddingVertical: 10,
    paddingHorizontal: 16,
    marginTop: 10,
    marginBottom: 4,
  },
  reportLinkText: {
    fontSize: 12,
    color: P.textDim,
    letterSpacing: 0.4,
    textDecorationLine: "underline",
    textDecorationColor: P.textDim,
  },
});

// ─── v4.7 — Report sheet styles ───────────────────────────────────────────────

const reportStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(15, 6, 32, 0.78)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: P.cardBg,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderColor: P.cardBorder,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: Platform.OS === "ios" ? 32 : 20,
    maxHeight: "80%",
  },
  handle: {
    width: 40, height: 4, backgroundColor: P.textDim,
    borderRadius: 2, alignSelf: "center", marginBottom: 14,
  },
  sheetTitle: {
    fontSize: 18, fontWeight: "700", color: P.textPrimary,
    textAlign: "center", marginBottom: 4,
  },
  sheetSubtitle: {
    fontSize: 13, color: P.textMuted,
    textAlign: "center", marginBottom: 16,
  },
  reasonList: {
    maxHeight: 320,
  },
  reasonBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: P.midPurple,
    borderColor: P.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 14,
    marginBottom: 8,
  },
  reasonBtnSelected: {
    backgroundColor: "#2a1058",
    borderColor: "#7c3aed",
  },
  reasonBtnDisabled: {
    opacity: 0.5,
  },
  reasonEmoji: { fontSize: 20, marginRight: 12 },
  reasonLabel: { flex: 1, fontSize: 15, color: P.textPrimary, fontWeight: "500" },

  noteWrap: {
    marginTop: 8,
  },
  noteInput: {
    backgroundColor: P.midPurple,
    borderColor: P.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    color: P.textPrimary,
    fontSize: 14,
    padding: 12,
    minHeight: 70,
    textAlignVertical: "top",
  },
  noteRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
  },
  noteCount: { fontSize: 11, color: P.textDim },
  submitBtn: {
    backgroundColor: "#7c3aed",
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  submitBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },

  errorText: {
    color: "#fca5a5",
    fontSize: 12,
    textAlign: "center",
    marginTop: 10,
  },

  cancelBtn: {
    alignItems: "center",
    paddingVertical: 14,
    marginTop: 10,
  },
  cancelBtnText: { color: P.textMuted, fontSize: 14, fontWeight: "600" },

  successWrap: {
    alignItems: "center",
    paddingVertical: 12,
  },
  successEmoji: { fontSize: 40, marginBottom: 8, color: "#22c55e" },
  successTitle: { fontSize: 18, fontWeight: "700", color: P.textPrimary, marginBottom: 6 },
  successBody:  { fontSize: 13, color: P.textMuted, textAlign: "center", marginBottom: 18 },
  doneBtn: {
    backgroundColor: "#7c3aed",
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 36,
  },
  doneBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },
});
