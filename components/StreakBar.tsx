/**
 * StreakBar.tsx
 * Lexi-Lens — Phase 2.3
 *
 * Compact 7-flame streak indicator.
 * Used in:
 *   • QuestMapScreen header (top-right corner)
 *   • ScanScreen header (so child always sees streak while playing)
 *
 * At 7 flames lit → bounces + shows "2× XP" label.
 *
 * Dependencies:
 *   react-native (Animated) — no extra packages needed.
 */

import React, { useEffect, useRef } from "react";
import {
  View,
  Text,
  Animated,
  StyleSheet,
} from "react-native";
import { useGameStore, selectStreakMultiplier } from "../store/gameStore";

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  /** 'full' shows count + label; 'compact' shows flames only (for tight headers) */
  variant?: "full" | "compact";
}

export function StreakBar({ variant = "full" }: Props) {
  const streak     = useGameStore((s: any) => s.streak);
  const multiplier = useGameStore(selectStreakMultiplier);

  const current    = streak?.currentStreak ?? 0;
  const has2x      = multiplier >= 2;

  // Bounce animation when 2× is active
  const bounceAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!has2x) return;
    Animated.loop(
      Animated.sequence([
        Animated.spring(bounceAnim, { toValue: 1.18, useNativeDriver: true, speed: 12, bounciness: 10 }),
        Animated.spring(bounceAnim, { toValue: 1.0,  useNativeDriver: true, speed: 12, bounciness: 10 }),
      ])
    ).start();
  }, [has2x]);

  if (variant === "compact") {
    return (
      <View style={styles.compactRow}>
        {Array.from({ length: 7 }, (_, i) => (
          <Text
            key={i}
            style={[styles.flame, { opacity: i < current ? 1 : 0.18 }]}
          >
            🔥
          </Text>
        ))}
        <Text style={styles.compactCount}>{current}</Text>
      </View>
    );
  }

  return (
    <Animated.View
      style={[
        styles.fullContainer,
        has2x && styles.fullContainer2x,
        { transform: [{ scale: has2x ? bounceAnim : new Animated.Value(1) }] },
      ]}
    >
      {/* Flames row */}
      <View style={styles.flamesRow}>
        {Array.from({ length: 7 }, (_, i) => (
          <Text
            key={i}
            style={[styles.flame, { opacity: i < current ? 1 : 0.18 }]}
          >
            🔥
          </Text>
        ))}
      </View>

      {/* Labels */}
      <View style={styles.labelsRow}>
        <Text style={styles.streakNum}>{current} day streak</Text>
        {has2x && (
          <View style={styles.twoxBadge}>
            <Text style={styles.twoxText}>2× XP</Text>
          </View>
        )}
      </View>

      {!has2x && current > 0 && (
        <Text style={styles.progressHint}>
          {7 - current} more day{7 - current !== 1 ? "s" : ""} to 2× XP!
        </Text>
      )}
    </Animated.View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // Compact variant
  compactRow: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           1,
  },
  compactCount: {
    color:      "#fbbf24",
    fontSize:   11,
    fontWeight: "700",
    marginLeft: 3,
  },

  // Full variant
  fullContainer: {
    backgroundColor: "rgba(124,58,237,0.15)",
    borderRadius:    10,
    borderWidth:     1,
    borderColor:     "rgba(124,58,237,0.3)",
    paddingHorizontal: 12,
    paddingVertical:    8,
    marginHorizontal:  16,
    marginBottom:      10,
  },
  fullContainer2x: {
    backgroundColor: "rgba(249,115,22,0.18)",
    borderColor:     "#f97316",
  },
  flamesRow: {
    flexDirection: "row",
    gap:           2,
    marginBottom:  4,
  },
  flame: {
    fontSize: 16,
  },
  labelsRow: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           8,
  },
  streakNum: {
    color:      "#fbbf24",
    fontSize:   12,
    fontWeight: "700",
  },
  twoxBadge: {
    backgroundColor: "#f97316",
    borderRadius:    5,
    paddingHorizontal: 6,
    paddingVertical:   2,
  },
  twoxText: {
    color:      "#fff",
    fontSize:   10,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  progressHint: {
    color:      "rgba(167,139,250,0.7)",
    fontSize:   10,
    marginTop:   3,
  },
});
