/**
 * components/AchievementToast.tsx
 * Lexi-Lens — N4: Achievement Badge System
 *
 * Global overlay toast shown when a badge is earned.
 * Mounts once in App.tsx above NavigationContainer.
 *
 * ── Behaviour ─────────────────────────────────────────────────────────────────
 *   • Reads newlyEarnedBadges[0] from Zustand store
 *   • Slides in from translateY: -140 using withSpring (no layout interference)
 *   • Auto-dismisses after 3.5 seconds
 *   • Tap to dismiss early
 *   • When one toast finishes, the next badge in the queue auto-shows
 *   • pointerEvents="box-none" — touches pass through the container to screens
 *
 * ── Legendary shimmer ─────────────────────────────────────────────────────────
 *   Legendary badges get a horizontal shimmer overlay using Reanimated 3
 *   withRepeat + withSequence — pure JS, no native driver override needed.
 *
 * ── Haptics ───────────────────────────────────────────────────────────────────
 *   common/rare  → ImpactFeedbackStyle.Medium
 *   epic         → NotificationFeedbackType.Success
 *   legendary    → NotificationFeedbackType.Success × 2 (double buzz)
 */

import React, { useEffect, useRef } from "react";
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Platform,
} from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withRepeat,
  withSequence,
  runOnJS,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";

import { useGameStore }                          from "../store/gameStore";
import { RARITY_COLOR, RARITY_GLOW, RARITY_BG, RARITY_LABEL } from "../services/achievementService";
import type { Badge, BadgeRarity }               from "../services/achievementService";

// ── Constants ─────────────────────────────────────────────────────────────────

const TOAST_HEIGHT     = 96;
const AUTO_DISMISS_MS  = 3500;

// ── Haptic helper ─────────────────────────────────────────────────────────────

async function fireHaptic(rarity: BadgeRarity): Promise<void> {
  try {
    if (rarity === "legendary") {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await new Promise<void>((r) => setTimeout(r, 180));
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else if (rarity === "epic") {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
  } catch {
    // expo-haptics not available — ignore
  }
}

// ── Shimmer overlay for legendary ─────────────────────────────────────────────

function LegendaryShimmer() {
  const shimmerX = useSharedValue(-120);

  useEffect(() => {
    shimmerX.value = withRepeat(
      withSequence(
        withTiming(300, { duration: 1100 }),
        withTiming(-120, { duration: 0 })
      ),
      -1,
      false
    );
  }, [shimmerX]);

  const shimmerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shimmerX.value }],
  }));

  return (
    <Animated.View style={[styles.shimmer, shimmerStyle]} pointerEvents="none" />
  );
}

// ── Badge Toast card ──────────────────────────────────────────────────────────

interface BadgeToastCardProps {
  badge:     Badge;
  onDismiss: () => void;
}

function BadgeToastCard({ badge, onDismiss }: BadgeToastCardProps) {
  const insets          = useSafeAreaInsets();
  const translateY      = useSharedValue(-TOAST_HEIGHT - 60);
  const opacity         = useSharedValue(0);
  const timerRef        = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Animate in ─────────────────────────────────────────────────────────────

  useEffect(() => {
    // Haptic on enter
    fireHaptic(badge.rarity);

    // Slide + fade in
    translateY.value = withSpring(0, {
      damping:   18,
      stiffness: 160,
      mass:      0.8,
    });
    opacity.value = withTiming(1, { duration: 220 });

    // Auto-dismiss
    timerRef.current = setTimeout(() => handleDismiss(), AUTO_DISMISS_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [badge.id]);

  const handleDismiss = () => {
    if (timerRef.current) clearTimeout(timerRef.current);

    translateY.value = withSpring(
      -TOAST_HEIGHT - 60,
      { damping: 20, stiffness: 200 },
      (finished) => {
        if (finished) runOnJS(onDismiss)();
      }
    );
    opacity.value = withTiming(0, { duration: 180 });
  };

  const cardStyle = useAnimatedStyle(() => ({
    opacity:   opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  const color   = RARITY_COLOR[badge.rarity];
  const bg      = RARITY_BG[badge.rarity];
  const glow    = RARITY_GLOW[badge.rarity];
  const isLegendary = badge.rarity === "legendary";

  return (
    <Animated.View
      style={[
        styles.card,
        cardStyle,
        {
          top:            insets.top + 10,
          backgroundColor: "#1a1028",
          borderColor:    color,
          // Glow effect via shadow
          ...Platform.select({
            ios:     { shadowColor: color, shadowOpacity: 0.7, shadowRadius: 14, shadowOffset: { width: 0, height: 4 } },
            android: { elevation: 12 },
          }),
        },
      ]}
    >
      {/* Background rarity tint */}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: bg, borderRadius: 16 }]} />

      {/* Legendary shimmer overlay */}
      {isLegendary && <LegendaryShimmer />}

      <TouchableOpacity
        activeOpacity={0.85}
        onPress={handleDismiss}
        style={styles.cardInner}
        accessibilityLabel={`Achievement earned: ${badge.name}. Tap to dismiss.`}
        accessibilityRole="button"
      >
        {/* Emoji circle */}
        <View style={[styles.emojiWrap, { borderColor: color, backgroundColor: bg }]}>
          <Text style={styles.emoji}>{badge.emoji}</Text>
        </View>

        {/* Text block */}
        <View style={styles.textWrap}>
          <View style={styles.titleRow}>
            <Text style={styles.header} numberOfLines={1}>BADGE UNLOCKED</Text>
            <View style={[styles.rarityPill, { backgroundColor: color }]}>
              <Text style={styles.rarityText}>{RARITY_LABEL[badge.rarity]}</Text>
            </View>
          </View>
          <Text style={[styles.name, { color }]} numberOfLines={1}>{badge.name}</Text>
          <Text style={styles.description} numberOfLines={1}>{badge.description}</Text>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ── Root overlay (mounts in App.tsx) ──────────────────────────────────────────

/**
 * Mount once in App.tsx as a sibling to NavigationContainer:
 *
 *   <SafeAreaProvider>
 *     <NavigationContainer>...</NavigationContainer>
 *     <AchievementToastOverlay />
 *   </SafeAreaProvider>
 */
export function AchievementToastOverlay() {
  const newlyEarnedBadges = useGameStore((s) => s.newlyEarnedBadges);
  const dismissEarnedBadge = useGameStore((s) => s.dismissEarnedBadge);

  const currentBadge = newlyEarnedBadges[0] ?? null;
  if (!currentBadge) return null;

  return (
    <View style={styles.overlay} pointerEvents="box-none">
      <BadgeToastCard
        key={currentBadge.id + Date.now()}
        badge={currentBadge}
        onDismiss={dismissEarnedBadge}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex:          9999,
    pointerEvents:   "box-none",
  },

  card: {
    position:        "absolute",
    left:            14,
    right:           14,
    borderRadius:    16,
    borderWidth:     1.5,
    overflow:        "hidden",
    zIndex:          9999,
  },

  cardInner: {
    flexDirection:   "row",
    alignItems:      "center",
    paddingVertical: 14,
    paddingHorizontal: 14,
    gap:             12,
  },

  emojiWrap: {
    width:           56,
    height:          56,
    borderRadius:    28,
    borderWidth:     1.5,
    alignItems:      "center",
    justifyContent:  "center",
    flexShrink:      0,
  },

  emoji: {
    fontSize:        28,
    lineHeight:      32,
  },

  textWrap: {
    flex:            1,
    gap:             2,
  },

  titleRow: {
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "space-between",
    gap:             8,
  },

  header: {
    fontSize:        9,
    fontWeight:      "700",
    color:           "#9ca3af",
    letterSpacing:   1.2,
    textTransform:   "uppercase",
  },

  rarityPill: {
    borderRadius:    20,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },

  rarityText: {
    fontSize:        8,
    fontWeight:      "800",
    color:           "#fff",
    letterSpacing:   0.5,
    textTransform:   "uppercase",
  },

  name: {
    fontSize:        15,
    fontWeight:      "800",
    letterSpacing:   0.2,
  },

  description: {
    fontSize:        12,
    color:           "#d1d5db",
    lineHeight:      16,
  },

  shimmer: {
    ...StyleSheet.absoluteFillObject,
    width:           80,
    backgroundColor: "rgba(255,255,255,0.08)",
    transform:       [{ skewX: "-20deg" }],
  },
});
