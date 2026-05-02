/**
 * StatusBanner.tsx
 * Lexi-Lens — floating scan-state indicator rendered over the camera view.
 *
 * v3.1 additions:
 *   • `liveLabel` prop — when status is idle and ML Kit has detected something,
 *     shows "I see: cushion" instead of "Point at an object"
 *   • Idle text transitions smoothly when liveLabel changes
 *
 * Deliberately minimal so it doesn't obscure what the child is scanning.
 */

import React, { useEffect, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  Animated,
  Easing,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { EvaluateStatus } from "../hooks/useLexiEvaluate";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StatusBannerProps {
  status:        EvaluateStatus;
  /** Name of the object ML Kit or Claude detected */
  detectedLabel?: string | null;
  /** v3.1 — live ML Kit label while idle (updates every 1.5s) */
  liveLabel?:     string | null;
  /** v3.1 — confidence 0-1, shown as % in idle state */
  liveConfidence?: number;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  EvaluateStatus,
  { color: string; bg: string; showDots: boolean }
> = {
  idle:         { color: "rgba(200,200,255,0.7)", bg: "rgba(15,6,32,0.75)",  showDots: false },
  converting:   { color: "#c4b5fd",               bg: "rgba(15,6,32,0.85)",  showDots: true  },
  evaluating:   { color: "#fde68a",               bg: "rgba(20,8,50,0.9)",   showDots: true  },
  match:        { color: "#86efac",               bg: "rgba(5,46,22,0.9)",   showDots: false },
  "no-match":   { color: "#fca5a5",               bg: "rgba(42,10,10,0.9)", showDots: false },
  error:        { color: "#fca5a5",               bg: "rgba(30,10,10,0.85)",showDots: false },
  rate_limited: { color: "#fbbf24",               bg: "rgba(30,15,0,0.9)",   showDots: false },
};

function getBannerText(
  status:        EvaluateStatus,
  detectedLabel: string | null | undefined,
  liveLabel:     string | null | undefined,
): string {
  switch (status) {
    case "idle":
      // v3.1 — show what ML Kit currently sees
      return liveLabel ? `I see: ${liveLabel}` : "Point at an object";
    case "converting":
      return "Focusing the Lexi-Lens…";
    case "evaluating":
      return detectedLabel ? `Reading "${detectedLabel}"…` : "Consulting the tomes…";
    case "match":
      return "✦ Component found!";
    case "no-match":
      return "Not quite…";
    case "rate_limited":
      return "Daily limit reached…";
    case "error":
      return "Lens flickered";
  }
}

// ─── Animated dot ─────────────────────────────────────────────────────────────

function Dot({ delay }: { delay: number }) {
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(opacity, { toValue: 1,   duration: 350, useNativeDriver: true, easing: Easing.out(Easing.ease) }),
        Animated.timing(opacity, { toValue: 0.3, duration: 350, useNativeDriver: true, easing: Easing.in(Easing.ease) }),
        Animated.delay(700 - delay),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [delay]);

  return <Animated.View style={[styles.dot, { opacity }]} />;
}

// ─── Scan ring (idle, no ML Kit label) ───────────────────────────────────────

function ScanRing() {
  const scale   = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.parallel([
        Animated.timing(scale,   { toValue: 1.6, duration: 1800, useNativeDriver: true, easing: Easing.out(Easing.quad) }),
        Animated.timing(opacity, { toValue: 0,   duration: 1800, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, []);

  return (
    <Animated.View style={[styles.scanRing, { transform: [{ scale }], opacity }]} />
  );
}

// ─── ML Kit live indicator dot ────────────────────────────────────────────────

function LiveDot() {
  const opacity = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1,   duration: 600, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.4, duration: 600, useNativeDriver: true }),
      ])
    ).start();
  }, []);
  return <Animated.View style={[styles.liveDot, { opacity }]} />;
}

// ─── Main component ───────────────────────────────────────────────────────────

export function StatusBanner({
  status,
  detectedLabel,
  liveLabel,
  liveConfidence = 0,
}: StatusBannerProps) {
  const insets = useSafeAreaInsets();
  const config = STATUS_CONFIG[status];

  const fadeAnim   = useRef(new Animated.Value(0)).current;
  const slideAnim  = useRef(new Animated.Value(-8)).current;
  const prevStatus = useRef<EvaluateStatus | null>(null);
  const prevLive   = useRef<string | null | undefined>(null);

  // Animate on status change
  useEffect(() => {
    if (prevStatus.current === status) return;
    prevStatus.current = status;

    Animated.parallel([
      Animated.timing(fadeAnim,  { toValue: 0, duration: 80,  useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: -8, duration: 80, useNativeDriver: true }),
    ]).start(() => {
      Animated.parallel([
        Animated.timing(fadeAnim,  { toValue: 1, duration: 220, useNativeDriver: true }),
        Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, tension: 100, friction: 10 }),
      ]).start();
    });
  }, [status]);

  // Subtle fade when live label changes (only in idle state)
  useEffect(() => {
    if (status !== "idle" || prevLive.current === liveLabel) return;
    prevLive.current = liveLabel;

    Animated.sequence([
      Animated.timing(fadeAnim, { toValue: 0.4, duration: 100, useNativeDriver: true }),
      Animated.timing(fadeAnim, { toValue: 1,   duration: 200, useNativeDriver: true }),
    ]).start();
  }, [liveLabel, status]);

  const text         = getBannerText(status, detectedLabel, liveLabel);
  const hasLiveLabel = status === "idle" && !!liveLabel;
  const confPct      = Math.round(liveConfidence * 100);

  // Colour the pill cyan when ML Kit has a label, default otherwise
  const pillBg = hasLiveLabel ? "rgba(6,40,55,0.88)" : config.bg;
  const textColor = hasLiveLabel ? "#67e8f9" : config.color;

  return (
    <Animated.View
      style={[
        styles.wrapper,
        { top: insets.top + 12 },
        { opacity: fadeAnim, transform: [{ translateY: slideAnim }] },
      ]}
      accessibilityLiveRegion="polite"
      accessibilityLabel={text}
    >
      <View style={[styles.pill, { backgroundColor: pillBg }]}>
        {/* Idle + no ML Kit label: pulsing ring */}
        {status === "idle" && !liveLabel && (
          <View style={styles.ringWrap}>
            <ScanRing />
            <View style={styles.ringCore} />
          </View>
        )}

        {/* Idle + ML Kit label: live pulsing dot */}
        {hasLiveLabel && <LiveDot />}

        <Text style={[styles.text, { color: textColor }]}>
          {text}
        </Text>

        {/* Confidence % shown only in idle with live label */}
        {hasLiveLabel && confPct > 0 && (
          <Text style={styles.confText}>{confPct}%</Text>
        )}

        {config.showDots && (
          <View style={styles.dots}>
            <Dot delay={0} />
            <Dot delay={200} />
            <Dot delay={400} />
          </View>
        )}
      </View>
    </Animated.View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  wrapper: {
    position:      "absolute",
    left:          0,
    right:         0,
    alignItems:    "center",
    zIndex:        100,
    pointerEvents: "none" as any,
  },
  pill: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingVertical:   9,
    borderRadius:      40,
    gap:               8,
    borderWidth:       0.5,
    borderColor:       "rgba(255,255,255,0.12)",
  },
  text: {
    fontSize:      14,
    fontWeight:    "500",
    letterSpacing: 0.2,
  },

  // Confidence %
  confText: {
    fontSize:   11,
    color:      "rgba(103,232,249,0.6)",
    fontWeight: "600",
  },

  // Animated dots (evaluating / converting)
  dots: { flexDirection: "row", gap: 4, alignItems: "center" },
  dot:  { width: 4, height: 4, borderRadius: 2, backgroundColor: "#a78bfa" },

  // Idle ring (no label)
  ringWrap: { width: 14, height: 14, alignItems: "center", justifyContent: "center" },
  scanRing: {
    position:     "absolute",
    width:        14,
    height:       14,
    borderRadius: 7,
    borderWidth:  1.5,
    borderColor:  "#67e8f9",
  },
  ringCore: {
    width:        6,
    height:       6,
    borderRadius: 3,
    backgroundColor: "#67e8f9",
  },

  // Live dot (ML Kit active)
  liveDot: {
    width:           7,
    height:          7,
    borderRadius:    3.5,
    backgroundColor: "#67e8f9",
  },
});
