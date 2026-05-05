/**
 * RateLimitWall.tsx
 * Lexi-Lens — Phase 3.5: Rate Limit + Abuse Prevention
 *
 * Rendered by ScanScreen when status === "rate_limited".
 * Two modes:
 *   • DAILY_QUOTA — child has used all 50 scans. Shows countdown to midnight.
 *   • IP_LIMIT    — too many requests in 60 s. Shows 60-second cooldown.
 *
 * Parent alert banner (ApproachingLimitBanner) is a SEPARATE lightweight
 * component, rendered inline in ScanScreen above VerdictCard so parents who
 * are supervising can see the warning without blocking the child's flow.
 *
 * Design principles:
 *   • Language stays age-appropriate — "brave adventurer", "spells recharged"
 *   • No scary red error screens — purple/amber RPG palette
 *   • Parent alert is dismissible and non-blocking
 *   • Countdown ticks in real-time via setInterval
 *
 * Lumi addition (this file):
 *   • LumiHUD overlays the screen in the sleeping/out-of-juice state
 *   • She replaces the dead-air feel of "you've hit the limit" with a daily
 *     ritual hook — kids come back tomorrow specifically to see her wake up
 */

import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
} from "react-native";
import type { RateLimitCode } from "../hooks/useLexiEvaluate";

import { LumiHUD } from "./Lumi";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RateLimitWallProps {
  code:        RateLimitCode;
  scansToday:  number;
  dailyLimit:  number;
  resetsAt:    string | null;  // ISO UTC
  onBack:      () => void;
}

interface ApproachingLimitBannerProps {
  scansToday:  number;
  dailyLimit:  number;
  onDismiss:   () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function secondsUntil(isoTarget: string | null): number {
  if (!isoTarget) return 0;
  return Math.max(0, Math.floor((new Date(isoTarget).getTime() - Date.now()) / 1000));
}

function formatCountdown(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const hh = String(h).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// ─── ApproachingLimitBanner ────────────────────────────────────────────────
// Shown in ScanScreen when _rateLimit.approachingLimit === true.
// Non-blocking — child can keep scanning until the hard limit.

export function ApproachingLimitBanner({
  scansToday,
  dailyLimit,
  onDismiss,
}: ApproachingLimitBannerProps) {
  const remaining = dailyLimit - scansToday;
  const pct       = Math.round((scansToday / dailyLimit) * 100);

  return (
    <View style={bannerStyles.container}>
      <View style={bannerStyles.bar}>
        <View style={[bannerStyles.fill, { width: `${pct}%` as any }]} />
      </View>
      <Text style={bannerStyles.text}>
        ⚠ {remaining} scan{remaining !== 1 ? "s" : ""} left today
      </Text>
      <TouchableOpacity onPress={onDismiss} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
        <Text style={bannerStyles.dismiss}>✕</Text>
      </TouchableOpacity>
    </View>
  );
}

const bannerStyles = StyleSheet.create({
  container: {
    flexDirection:    "row",
    alignItems:       "center",
    backgroundColor:  "rgba(186,117,23,0.15)",
    borderColor:      "rgba(186,117,23,0.4)",
    borderWidth:      1,
    borderRadius:     8,
    paddingVertical:  6,
    paddingHorizontal: 12,
    marginHorizontal: 16,
    marginBottom:     8,
    gap:              8,
  },
  bar: {
    flex:            1,
    height:          4,
    backgroundColor: "rgba(186,117,23,0.2)",
    borderRadius:    2,
    overflow:        "hidden",
  },
  fill: {
    height:          4,
    backgroundColor: "#BA7517",
    borderRadius:    2,
  },
  text: {
    color:     "#BA7517",
    fontSize:  12,
    fontWeight: "500",
  },
  dismiss: {
    color:    "#BA7517",
    fontSize: 14,
  },
});

// ─── RateLimitWall ────────────────────────────────────────────────────────────

export function RateLimitWall({
  code,
  scansToday,
  dailyLimit,
  resetsAt,
  onBack,
}: RateLimitWallProps) {
  const [countdown, setCountdown] = useState(secondsUntil(resetsAt));
  const [pulse]                   = useState(new Animated.Value(1));

  // Tick countdown every second
  useEffect(() => {
    if (code !== "DAILY_QUOTA") return;
    const id = setInterval(() => {
      setCountdown(secondsUntil(resetsAt));
    }, 1000);
    return () => clearInterval(id);
  }, [code, resetsAt]);

  // Pulse the shield icon
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.08, duration: 1200, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1.00, duration: 1200, useNativeDriver: true }),
      ])
    ).start();
  }, [pulse]);

  const isDailyQuota = code === "DAILY_QUOTA";

  return (
    <View style={styles.container}>
      {/* Shield glyph */}
      <Animated.Text style={[styles.icon, { transform: [{ scale: pulse }] }]}>
        {isDailyQuota ? "🛡" : "⏳"}
      </Animated.Text>

      {/* Headline */}
      <Text style={styles.headline}>
        {isDailyQuota
          ? "Your spell power is depleted!"
          : "Scanning too fast, adventurer!"}
      </Text>

      {/* Body */}
      <Text style={styles.body}>
        {isDailyQuota
          ? `You've cast ${scansToday} vocabulary spells today — that's your daily limit of ${dailyLimit}. Your power recharges at midnight.`
          : "You're scanning faster than the arcane lenses can handle. Take a breath and try again in a moment."}
      </Text>

      {/* Countdown (daily quota only) */}
      {isDailyQuota && (
        <View style={styles.countdownBox}>
          <Text style={styles.countdownLabel}>Spells recharge in</Text>
          <Text style={styles.countdown}>{formatCountdown(countdown)}</Text>
        </View>
      )}

      {/* Progress bar (daily quota) */}
      {isDailyQuota && (
        <View style={styles.progressWrap}>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: "100%" }]} />
          </View>
          <Text style={styles.progressLabel}>
            {scansToday} / {dailyLimit} scans used today
          </Text>
        </View>
      )}

      {/* Parent note */}
      {isDailyQuota && (
        <View style={styles.parentNote}>
          <Text style={styles.parentNoteText}>
            👨‍👩‍👧 Parents: daily scan limits keep the adventure balanced.
            You can review your child's scan history in the Parent Dashboard.
          </Text>
        </View>
      )}

      {/* Back button */}
      <TouchableOpacity style={styles.backBtn} onPress={onBack}>
        <Text style={styles.backBtnText}>← Back to Quest Map</Text>
      </TouchableOpacity>

      {/* ── Lumi mascot — sleeps in the corner while spells recharge ───── */}
      <LumiHUD screen="rate-limit" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex:            1,
    alignItems:      "center",
    justifyContent:  "center",
    paddingHorizontal: 28,
    paddingVertical:   40,
    backgroundColor:   "#0a0814",
  },
  icon: {
    fontSize:     72,
    marginBottom: 20,
  },
  headline: {
    color:        "#c9a0ff",
    fontSize:     22,
    fontWeight:   "700",
    textAlign:    "center",
    marginBottom: 12,
  },
  body: {
    color:        "#9b8ec4",
    fontSize:     15,
    textAlign:    "center",
    lineHeight:   22,
    marginBottom: 28,
    maxWidth:     320,
  },
  countdownBox: {
    alignItems:       "center",
    backgroundColor:  "rgba(201,160,255,0.08)",
    borderColor:      "rgba(201,160,255,0.25)",
    borderWidth:      1,
    borderRadius:     12,
    paddingVertical:  16,
    paddingHorizontal: 32,
    marginBottom:     24,
  },
  countdownLabel: {
    color:        "#9b8ec4",
    fontSize:     12,
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  countdown: {
    color:      "#c9a0ff",
    fontSize:   36,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  progressWrap: {
    width:        "100%",
    marginBottom: 24,
  },
  progressTrack: {
    height:          8,
    backgroundColor: "rgba(201,160,255,0.12)",
    borderRadius:    4,
    overflow:        "hidden",
    marginBottom:    6,
  },
  progressFill: {
    height:          8,
    backgroundColor: "#7c3aed",
    borderRadius:    4,
  },
  progressLabel: {
    color:     "#9b8ec4",
    fontSize:  12,
    textAlign: "center",
  },
  parentNote: {
    backgroundColor:   "rgba(255,255,255,0.04)",
    borderRadius:      10,
    padding:           14,
    marginBottom:      28,
    maxWidth:          340,
  },
  parentNoteText: {
    color:      "#7a6fa0",
    fontSize:   12,
    lineHeight: 18,
    textAlign:  "center",
  },
  backBtn: {
    backgroundColor: "rgba(201,160,255,0.15)",
    borderColor:     "rgba(201,160,255,0.4)",
    borderWidth:     1,
    borderRadius:    10,
    paddingVertical:  12,
    paddingHorizontal: 28,
  },
  backBtnText: {
    color:      "#c9a0ff",
    fontSize:   15,
    fontWeight: "600",
  },
});
