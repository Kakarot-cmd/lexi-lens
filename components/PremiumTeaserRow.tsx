/**
 * PremiumTeaserRow.tsx
 * Skanlore — v6.5
 *
 * A focused, aspirational teaser of premium quests for FREE-tier parents, shown
 * near the top of QuestMapScreen. Rather than relying on the ~21 greyed premium
 * cards scattered through the Apprentice list, this surfaces a small curated set
 * (one quest per tier — an easy→advanced ramp) as a single, legible "here's
 * what's ahead" nudge. Tapping any card opens the paywall.
 *
 * Gating:
 *   • Renders nothing for paid parents (they already have the full library).
 *   • Renders nothing until questLibrary has loaded any paid quests.
 *
 * The server (evaluate) is the authoritative gate; this is conversion UX only.
 *
 * Props:
 *   onUpgrade() — parent opens PaywallScreen (reuse QuestMap's handleLockedTap).
 */

import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useGameStore, type Quest, type QuestTier } from "../store/gameStore";

// ─── Palette (premium gold accent over the dungeon dark theme) ────────────────
const P = {
  card:        "#2a1c12",   // warm dark (distinct from the purple quest cards)
  border:      "#fbbf24",   // gold
  gold:        "#fbbf24",
  goldDim:     "#d9a441",
  textHi:      "#f3f4f6",
  textDim:     "#d6c08a",
};

const TIER_ORDER: QuestTier[] = ["apprentice", "scholar", "sage", "archmage"];
const MAX_FEATURED = 3;

interface Props {
  onUpgrade: () => void;
}

export function PremiumTeaserRow({ onUpgrade }: Props) {
  const parentTier   = useGameStore((s) => s.parentSubscriptionTier);
  const questLibrary = useGameStore((s) => s.questLibrary);

  const paid = questLibrary.filter(
    (q) => (q.min_subscription_tier ?? "free") === "paid" && !q.is_daily
  );

  // Paid parents already have everything — no teaser.
  if (parentTier === "paid") return null;
  if (paid.length === 0) return null;

  // One quest per tier (easy → advanced), then top up to MAX_FEATURED if some
  // tiers have no paid quests. Deterministic so the teaser is stable per session.
  const featured: Quest[] = [];
  const picked = new Set<string>();
  for (const tier of TIER_ORDER) {
    const first = paid
      .filter((q) => q.tier === tier)
      .sort((a, b) => (a.sort_order ?? 8) - (b.sort_order ?? 8))[0];
    if (first && !picked.has(first.id)) {
      featured.push(first);
      picked.add(first.id);
    }
  }
  if (featured.length < MAX_FEATURED) {
    for (const q of paid) {
      if (featured.length >= MAX_FEATURED) break;
      if (!picked.has(q.id)) {
        featured.push(q);
        picked.add(q.id);
      }
    }
  }
  const cards = featured.slice(0, MAX_FEATURED);
  if (cards.length === 0) return null;

  return (
    <View style={styles.wrapper}>
      <View style={styles.headerRow}>
        <Text style={styles.sectionLabel}>✨ PREMIUM QUESTS</Text>
        <Text style={styles.tagline}>Unlock the full library</Text>
      </View>
      <View style={styles.row}>
        {cards.map((q) => (
          <TouchableOpacity
            key={q.id}
            style={styles.card}
            onPress={onUpgrade}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={`Premium quest ${q.enemy_name} — unlock with Premium`}
          >
            <Text style={styles.lock}>🔒</Text>
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
    marginBottom: 14,
    paddingHorizontal: 4,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  sectionLabel: {
    color: P.gold,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  tagline: {
    color: P.textDim,
    fontSize: 11,
    fontWeight: "600",
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
    paddingHorizontal: 8,
    alignItems: "center",
  },
  lock: {
    fontSize: 13,
    marginBottom: 2,
  },
  emoji: {
    fontSize: 26,
    marginBottom: 4,
  },
  enemyName: {
    color: P.textHi,
    fontSize: 13,
    fontWeight: "700",
    textAlign: "center",
  },
  room: {
    color: P.goldDim,
    fontSize: 11,
    marginTop: 2,
    textAlign: "center",
  },
});
