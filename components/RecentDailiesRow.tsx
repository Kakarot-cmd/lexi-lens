/**
 * RecentDailiesRow.tsx
 * Skanlore — v6.5
 *
 * Renders the PAST dailies in the rolling 3-day free window (yesterday and the
 * day before), as compact tappable cards beneath the DailyQuestBanner (which
 * shows today's). Free users can see and play today + the past 2 days; older
 * dailies are not surfaced. Daily quests are excluded from the curated
 * QuestMap library (is_daily=true), so this is the only place past dailies
 * appear. Server (get_evaluate_context) enforces the same window, so these are
 * genuinely playable on the free tier.
 *
 * Props:
 *   onSelect(questId) — parent opens the quest (navigates to ScanScreen).
 *
 * Renders nothing when there are no past dailies in the window.
 */

import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useGameStore } from "../store/gameStore";

// ─── Palette (matches DailyQuestBanner / dungeon dark theme) ──────────────────
const P = {
  card:    "#231535",
  border:  "#7c3aed",
  gold:    "#fbbf24",
  textHi:  "#f3f4f6",
  textDim: "#a78bfa",
};

interface Props {
  onSelect: (questId: string) => void;
}

export function RecentDailiesRow({ onSelect }: Props) {
  const recent  = useGameStore((s) => s.dailyQuest.recent);
  const todayId = useGameStore((s) => s.dailyQuest.questId);
  const isLoaded = useGameStore((s) => s.dailyQuest.isLoaded);

  if (!isLoaded) return null;

  // Past dailies = the window minus today's (which the banner already shows).
  const past = recent.filter((q) => q.id !== todayId).slice(0, 2);
  if (past.length === 0) return null;

  return (
    <View style={styles.wrapper}>
      <Text style={styles.sectionLabel}>📅 RECENT DAILIES — FREE FOR A FEW DAYS</Text>
      <View style={styles.row}>
        {past.map((q) => (
          <TouchableOpacity
            key={q.id}
            style={styles.card}
            onPress={() => onSelect(q.id)}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={`Play recent daily quest: ${q.enemy_name}`}
          >
            <Text style={styles.emoji}>{q.enemy_emoji}</Text>
            <Text style={styles.enemyName} numberOfLines={1}>{q.enemy_name}</Text>
            <Text style={styles.room} numberOfLines={1}>{q.room_label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    marginTop: 4,
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  sectionLabel: {
    color: P.textDim,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  row: {
    flexDirection: "row",
    gap: 10,
  },
  card: {
    flex: 1,
    backgroundColor: P.card,
    borderColor: P.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 10,
    alignItems: "center",
  },
  emoji: {
    fontSize: 28,
    marginBottom: 4,
  },
  enemyName: {
    color: P.textHi,
    fontSize: 13,
    fontWeight: "700",
    textAlign: "center",
  },
  room: {
    color: P.gold,
    fontSize: 11,
    marginTop: 2,
    textAlign: "center",
  },
});
