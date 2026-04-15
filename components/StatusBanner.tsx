/**
 * StatusBanner.tsx
 * Lexi-Lens — floating scan-state indicator rendered over the camera view.
 *
 * Deliberately minimal so it doesn't obscure what the child is scanning.
 * Uses a pill shape at the top of the screen with animated state transitions.
 *
 * Dependencies:
 *   npx expo install react-native-reanimated
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
  status: EvaluateStatus;
  /** Name of the object Vision detected — shown during "evaluating" */
  detectedLabel?: string | null;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  EvaluateStatus,
  { text: (label?: string | null) => string; color: string; bg: string; showDots: boolean }
> = {
  idle: {
    text:     () => "Point at an object",
    color:    "rgba(200,200,255,0.7)",
    bg:       "rgba(15,6,32,0.75)",
    showDots: false,
  },
  converting: {
    text:     () => "Focusing the Lexi-Lens…",
    color:    "#c4b5fd",
    bg:       "rgba(15,6,32,0.85)",
    showDots: true,
  },
  evaluating: {
    text:     (label) => label ? `Reading "${label}"…` : "Consulting the tomes…",
    color:    "#fde68a",
    bg:       "rgba(20,8,50,0.9)",
    showDots: true,
  },
  match:     { text: () => "✦ Component found!", color: "#86efac", bg: "rgba(5,46,22,0.9)",  showDots: false },
  "no-match":{ text: () => "Not quite…",        color: "#fca5a5", bg: "rgba(42,10,10,0.9)", showDots: false },
  error:     { text: () => "Lens flickered",     color: "#fca5a5", bg: "rgba(30,10,10,0.85)",showDots: false },
};

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

// ─── Scan ring (idle state only) ──────────────────────────────────────────────

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
    <Animated.View
      style={[
        styles.scanRing,
        { transform: [{ scale }], opacity },
      ]}
    />
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function StatusBanner({ status, detectedLabel }: StatusBannerProps) {
  const insets = useSafeAreaInsets();
  const config = STATUS_CONFIG[status];

  const fadeAnim  = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(-8)).current;
  const prevStatus = useRef<EvaluateStatus | null>(null);

  useEffect(() => {
    if (prevStatus.current === status) return;
    prevStatus.current = status;

    // Fade+slide in on status change
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

  return (
    <Animated.View
      style={[
        styles.wrapper,
        { top: insets.top + 12 },
        { opacity: fadeAnim, transform: [{ translateY: slideAnim }] },
      ]}
      accessibilityLiveRegion="polite"
      accessibilityLabel={config.text(detectedLabel)}
    >
      <View style={[styles.pill, { backgroundColor: config.bg }]}>
        {/* Idle: show pulsing ring as a visual indicator */}
        {status === "idle" && (
          <View style={styles.ringWrap}>
            <ScanRing />
            <View style={styles.ringCore} />
          </View>
        )}

        <Text style={[styles.text, { color: config.color }]}>
          {config.text(detectedLabel)}
        </Text>

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
    position:       "absolute",
    left:           0,
    right:          0,
    alignItems:     "center",
    zIndex:         100,
    pointerEvents:  "none" as any, // pass touches through to camera
  },
  pill: {
    flexDirection:    "row",
    alignItems:       "center",
    paddingHorizontal: 16,
    paddingVertical:  9,
    borderRadius:     40,
    gap:              8,
    borderWidth:      0.5,
    borderColor:      "rgba(255,255,255,0.12)",
  },
  text: {
    fontSize:   14,
    fontWeight: "500",
    letterSpacing: 0.2,
  },

  // Animated dots
  dots: { flexDirection: "row", gap: 4, alignItems: "center" },
  dot:  { width: 4, height: 4, borderRadius: 2, backgroundColor: "#a78bfa" },

  // Idle ring
  ringWrap: { width: 14, height: 14, alignItems: "center", justifyContent: "center" },
  scanRing: {
    position:    "absolute",
    width:       14,
    height:      14,
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
});
