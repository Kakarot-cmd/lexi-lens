/**
 * DailyQuestBanner.tsx
 * Lexi-Lens — Phase 2.3
 *
 * A glowing "Daily Quest" card that sits at the top of QuestMapScreen.
 * Shows today's featured quest with a fire-border glow, streak pill,
 * and 2× XP badge when the streak multiplier is active.
 *
 * Props:
 *   onPress — opens the quest (calls beginQuest then navigates to ScanScreen)
 *
 * Dependencies: none beyond what the app already has.
 */

import React, { useEffect, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
} from "react-native";
import {
  useGameStore,
  selectDailyQuest,
  selectStreakMultiplier,
  getDisplayProperties,
} from "../store/gameStore";

// ─── Palette (matches dungeon dark theme) ─────────────────────────────────────
const P = {
  bg:       "#1a1025",
  card:     "#231535",
  border:   "#7c3aed",
  gold:     "#fbbf24",
  fire:     "#f97316",
  fireGlow: "#ea580c",
  textHi:   "#f3f4f6",
  textDim:  "#a78bfa",
  green:    "#86efac",
  badge:    "#7c3aed",
};

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  onPress: () => void;
}

export function DailyQuestBanner({ onPress }: Props) {
  const dailyQuest         = useGameStore(selectDailyQuest);
  const isDone             = useGameStore((s: any) => s.isDailyQuestComplete);
  const streak             = useGameStore((s: any) => s.streak);
  const multiplier         = useGameStore(selectStreakMultiplier);
  const dailyQuestLoaded   = useGameStore((s: any) => s.dailyQuest.isLoaded);
  const ageBand            = useGameStore((s: any) => s.activeChild?.age_band ?? "7-8");

  // Pulsing glow animation
  const glowAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (isDone) return;
    Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 1, duration: 1400, useNativeDriver: false }),
        Animated.timing(glowAnim, { toValue: 0, duration: 1400, useNativeDriver: false }),
      ])
    ).start();
  }, [isDone]);

  const borderColor = glowAnim.interpolate({
    inputRange:  [0, 1],
    outputRange: [P.border, P.fire],
  });

  const shadowOpacity = glowAnim.interpolate({
    inputRange:  [0, 1],
    outputRange: [0.35, 0.85],
  });

  if (!dailyQuestLoaded || !dailyQuest) return null;

  const currentStreak = streak?.currentStreak ?? 0;
  const has2x         = multiplier >= 2;

  // Use the age-band-specific word list so chips match what the child scans
  const displayProps = getDisplayProperties(dailyQuest, ageBand);

  // XP FIX: compute real max XP matching the Edge Function formula
  const propCount  = displayProps.length;
  const multiBonus = propCount >= 3 ? 2.0 : propCount === 2 ? 1.5 : 1.0;
  const maxXpFirst = Math.round((dailyQuest.xp_reward_first_try ?? 40) * propCount * multiBonus);

  return (
    <View style={styles.wrapper}>
      {/* Section header */}
      <View style={styles.sectionRow}>
        <Text style={styles.sectionLabel}>⚔ TODAY'S QUEST</Text>
        {has2x && (
          <View style={styles.multiplierBadge}>
            <Text style={styles.multiplierText}>2× XP ACTIVE</Text>
          </View>
        )}
      </View>

      {/* Card */}
      <Animated.View
        style={[
          styles.card,
          { borderColor, shadowOpacity, shadowColor: P.fire },
          isDone && styles.cardDone,
        ]}
      >
        <TouchableOpacity
          style={styles.cardInner}
          onPress={onPress}
          activeOpacity={0.85}
          disabled={isDone}
        >
          {/* Enemy + info */}
          <View style={styles.left}>
            <Text style={styles.emoji}>{dailyQuest.enemy_emoji}</Text>
          </View>

          <View style={styles.middle}>
            <Text style={styles.enemyName}>{dailyQuest.enemy_name}</Text>
            <Text style={styles.roomLabel}>{dailyQuest.room_label}</Text>

            {/* Property chips — show the words the child will actually scan for */}
            <View style={styles.chips}>
              {displayProps.slice(0, 3).map((p: any) => (
                <View key={p.word} style={styles.chip}>
                  <Text style={styles.chipText}>{p.word}</Text>
                </View>
              ))}
            </View>
          </View>

          {/* Right side — XP + streak + CTA */}
          <View style={styles.right}>
            {isDone ? (
              <>
                <Text style={styles.doneEmoji}>✅</Text>
                <Text style={styles.doneLabel}>Done!</Text>
              </>
            ) : (
              <>
                <View style={styles.xpPill}>
                  <Text style={styles.xpText}>
                    {/* XP FIX: show formula total, not raw xp_reward_first_try */}
                    {has2x ? `${maxXpFirst * 2} XP` : `${maxXpFirst} XP`}
                  </Text>
                  {has2x && <Text style={styles.xpBase}>×2</Text>}
                </View>
                <TouchableOpacity style={styles.beginBtn} onPress={onPress} activeOpacity={0.8}>
                  <Text style={styles.beginBtnText}>Begin ›</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </TouchableOpacity>

        {/* Streak bar — 7 flames */}
        <View style={styles.streakRow}>
          <Text style={styles.streakLabel}>Streak</Text>
          {Array.from({ length: 7 }, (_, i) => {
            const lit = i < currentStreak;
            return (
              <Text key={i} style={[styles.flame, lit ? styles.flameLit : styles.flameDim]}>
                🔥
              </Text>
            );
          })}
          <Text style={styles.streakCount}>{currentStreak}/7</Text>
        </View>
      </Animated.View>

      {/* Reset note */}
      {!isDone && (
        <Text style={styles.resetNote}>Resets at midnight • {7 - currentStreak} days to 2× XP</Text>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  wrapper: {
    marginHorizontal: 16,
    marginBottom:     20,
  },

  // Section header
  sectionRow: {
    flexDirection:  "row",
    alignItems:     "center",
    justifyContent: "space-between",
    marginBottom:    8,
  },
  sectionLabel: {
    color:          P.gold,
    fontSize:       11,
    fontWeight:     "700",
    letterSpacing:  1.4,
  },
  multiplierBadge: {
    backgroundColor: P.fire,
    borderRadius:    6,
    paddingHorizontal: 8,
    paddingVertical:   2,
  },
  multiplierText: {
    color:       "#fff",
    fontSize:    10,
    fontWeight:  "800",
    letterSpacing: 0.8,
  },

  // Card
  card: {
    backgroundColor: P.card,
    borderRadius:    14,
    borderWidth:     1.5,
    shadowOffset:    { width: 0, height: 0 },
    shadowRadius:    12,
    elevation:       8,
    overflow:        "hidden",
  },
  cardDone: {
    opacity: 0.6,
  },
  cardInner: {
    flexDirection: "row",
    alignItems:    "center",
    padding:       14,
    gap:           12,
  },

  // Left — emoji
  left: {
    width: 48,
    alignItems: "center",
  },
  emoji: {
    fontSize: 36,
  },

  // Middle — text
  middle: {
    flex: 1,
  },
  enemyName: {
    color:      P.textHi,
    fontSize:   15,
    fontWeight: "700",
  },
  roomLabel: {
    color:      P.textDim,
    fontSize:   11,
    marginTop:  1,
    marginBottom: 6,
  },
  chips: {
    flexDirection: "row",
    flexWrap:      "wrap",
    gap:           4,
  },
  chip: {
    backgroundColor: "rgba(124,58,237,0.25)",
    borderRadius:     4,
    paddingHorizontal: 6,
    paddingVertical:   2,
  },
  chipText: {
    color:      P.textDim,
    fontSize:   10,
    fontWeight: "600",
  },

  // Right — XP + button
  right: {
    alignItems: "center",
    gap:         6,
  },
  xpPill: {
    backgroundColor: "rgba(251,191,36,0.15)",
    borderRadius:     8,
    paddingHorizontal: 10,
    paddingVertical:    4,
    flexDirection:     "row",
    alignItems:        "center",
    gap:               3,
  },
  xpText: {
    color:      P.gold,
    fontSize:   13,
    fontWeight: "800",
  },
  xpBase: {
    color:      P.fire,
    fontSize:   11,
    fontWeight: "700",
  },
  beginBtn: {
    backgroundColor: P.fire,
    borderRadius:    8,
    paddingHorizontal: 14,
    paddingVertical:    7,
  },
  beginBtnText: {
    color:      "#fff",
    fontSize:   13,
    fontWeight: "700",
  },
  doneEmoji: {
    fontSize: 24,
  },
  doneLabel: {
    color:      P.green,
    fontSize:   11,
    fontWeight: "700",
  },

  // Streak row
  streakRow: {
    flexDirection:   "row",
    alignItems:      "center",
    borderTopWidth:  1,
    borderTopColor:  "rgba(124,58,237,0.2)",
    paddingHorizontal: 14,
    paddingVertical:    8,
    gap:              4,
  },
  streakLabel: {
    color:       P.textDim,
    fontSize:    11,
    fontWeight:  "600",
    marginRight: 4,
  },
  flame: {
    fontSize: 14,
  },
  flameLit: {
    opacity: 1,
  },
  flameDim: {
    opacity: 0.22,
  },
  streakCount: {
    color:      P.textDim,
    fontSize:   11,
    fontWeight: "600",
    marginLeft: 4,
  },

  // Reset note
  resetNote: {
    color:        "rgba(167,139,250,0.5)",
    fontSize:      10,
    textAlign:    "center",
    marginTop:     5,
    letterSpacing: 0.3,
  },
});
