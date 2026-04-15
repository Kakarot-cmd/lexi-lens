/**
 * VerdictCard.tsx — Lexi-Lens result card (updated)
 *
 * Verdict logic:
 *  - If ANY property newly passes → show "✦ Found X properties!" (even if not all pass)
 *  - Show passing properties in GREEN, failing in RED
 *  - If nothing new found → show "Almost..." with red/green split
 *  - "Continue quest" when something found, "Try another object" when nothing found
 */

import React, { useEffect, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Animated,
  Dimensions,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { EvaluationResult, EvaluateStatus } from "../hooks/useLexiEvaluate";

interface VerdictCardProps {
  status:     Extract<EvaluateStatus, "match" | "no-match" | "error">;
  result?:    EvaluationResult | null;
  error?:     string | null;
  onContinue: () => void;
  onTryAgain: () => void;
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
      <Text style={styles.badgeReason}>{reasoning}</Text>
    </View>
  );
}

// ─── XP counter ───────────────────────────────────────────────────────────────

function XPCounter({ xp }: { xp: number }) {
  const countAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, tension: 80, friction: 6 }),
      Animated.timing(countAnim, { toValue: xp, duration: 900, useNativeDriver: false }),
    ]).start();
  }, [xp]);

  return (
    <Animated.View style={[styles.xpBadge, { transform: [{ scale: scaleAnim }] }]}>
      <Animated.Text style={styles.xpNum}>
        {countAnim.interpolate({ inputRange: [0, xp || 1], outputRange: ["0", String(xp)] })}
      </Animated.Text>
      <Text style={styles.xpLbl}>XP</Text>
    </Animated.View>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function VerdictCard({ status, result, error, onContinue, onTryAgain }: VerdictCardProps) {
  const insets   = useSafeAreaInsets();
  const slideAnim = useRef(new Animated.Value(CARD_H)).current;

  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: 0, useNativeDriver: true, tension: 60, friction: 12,
    }).start();
  }, []);

  // Determine what was found vs not found
  const passingProps = result?.properties.filter((p) => p.passes) ?? [];
  const failingProps = result?.properties.filter((p) => !p.passes) ?? [];
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
              </View>
              <TouchableOpacity style={styles.retryBtn} onPress={onTryAgain}>
                <Text style={styles.retryBtnText}>Try again</Text>
              </TouchableOpacity>
            </>
          )}

          {/* ── Has result (match or no-match) ──────────────── */}
          {result && (status === "match" || status === "no-match") && (
            <>
              {/* Header — changes based on whether anything was found */}
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
                <Text style={styles.resolvedName}>{result.resolvedObjectName}</Text>
              </View>

              {/* XP badge — only shown when something found */}
              {somethingFound && totalXpEarned > 0 && (
                <XPCounter xp={totalXpEarned} />
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
            </>
          )}

        </ScrollView>
      </View>
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
  resolvedName: { fontSize: 13, color: P.textMuted, marginTop: 2 },

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
  badge:      { borderRadius: 10, padding: 10, marginBottom: 8, borderWidth: 1 },
  badgePass:  { backgroundColor: P.passBg, borderColor: P.passBorder },
  badgeFail:  { backgroundColor: P.failBg, borderColor: P.failBorder },
  badgeRow:   { flexDirection: "row", alignItems: "center", marginBottom: 3 },
  badgeWord:  { fontSize: 14, fontWeight: "600" },
  badgeReason:{ fontSize: 12, color: P.textDim, lineHeight: 17, marginLeft: 18 },

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
});
