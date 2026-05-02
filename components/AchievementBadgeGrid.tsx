/**
 * components/AchievementBadgeGrid.tsx
 * Lexi-Lens — N4: Achievement Badge System
 *
 * Renders the full 16-badge grid in ParentDashboard.
 * Earned badges are fully coloured; locked ones are grey + padlock overlay.
 *
 * ── Features ──────────────────────────────────────────────────────────────────
 *   • 3-column grid, 16 badges
 *   • Stagger entrance animation (each badge fades + scales with 40ms delay)
 *   • Tap any badge → detail bottom-sheet modal (name, description, rarity, earned date)
 *   • Legendary badge card has a shimmer pulse on the border
 *   • "X / 16 earned" progress summary with a mini progress bar
 *   • Category filter tabs: All | First-time | Streak | Tomes | XP | Tier | Hard Mode
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   <AchievementBadgeGrid childId={selectedId} />
 *
 *   Mount in ParentDashboard.tsx inside the ScrollView, after MasteryRadarPanel.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Dimensions,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Animated, {
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";

import {
  BADGE_DEFINITIONS,
  RARITY_COLOR,
  RARITY_GLOW,
  RARITY_BG,
  RARITY_LABEL,
  loadEarnedAchievements,
  type Badge,
  type AchievementRecord,
  type BadgeCategory,
} from "../services/achievementService";

// ── Constants ─────────────────────────────────────────────────────────────────

const { width: SCREEN_W } = Dimensions.get("window");
const GRID_PAD            = 16;
const GRID_GAP            = 10;
const COLS                = 3;
const CELL_W              = (SCREEN_W - GRID_PAD * 2 - GRID_GAP * (COLS - 1)) / COLS;

const CATEGORY_TABS: { label: string; value: BadgeCategory | "all" }[] = [
  { label: "All",        value: "all"        },
  { label: "🌟 First",   value: "first-time" },
  { label: "🔥 Streak",  value: "streak"     },
  { label: "📚 Tomes",   value: "word-tome"  },
  { label: "⚡ XP",      value: "xp"         },
  { label: "⚔️ Tier",   value: "tier"        },
  { label: "💀 Hard",    value: "hard-mode"  },
];

const TOTAL_BADGES = BADGE_DEFINITIONS.length; // 16

// ── Shimmer border for legendary badges ───────────────────────────────────────

function LegendaryBorderPulse() {
  const pulseOpacity = useSharedValue(0.4);

  useEffect(() => {
    pulseOpacity.value = withRepeat(
      withSequence(
        withTiming(1,   { duration: 900 }),
        withTiming(0.4, { duration: 900 })
      ),
      -1,
      false
    );
  }, [pulseOpacity]);

  const style = useAnimatedStyle(() => ({ opacity: pulseOpacity.value }));

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, styles.legendaryBorderAnim, style]}
      pointerEvents="none"
    />
  );
}

// ── Individual badge cell ─────────────────────────────────────────────────────

interface BadgeCellProps {
  badge:      Badge;
  earned:     boolean;
  earnedAt:   string | null;
  index:      number;
  onPress:    (badge: Badge, earned: boolean, earnedAt: string | null) => void;
}

function BadgeCell({ badge, earned, earnedAt, index, onPress }: BadgeCellProps) {
  const color       = earned ? RARITY_COLOR[badge.rarity] : "#374151";
  const bg          = earned ? RARITY_BG[badge.rarity]    : "rgba(55,65,81,0.10)";
  const isLegendary = badge.rarity === "legendary" && earned;

  const entryDelay = Math.min(index * 40, 600); // cap at 600ms

  return (
    <Animated.View
      entering={FadeInDown.delay(entryDelay).springify().damping(18)}
      style={[
        styles.cell,
        {
          backgroundColor: bg,
          borderColor:     color,
          opacity:         earned ? 1 : 0.45,
          width:           CELL_W,
        },
      ]}
    >
      {isLegendary && <LegendaryBorderPulse />}

      <TouchableOpacity
        style={styles.cellTouchable}
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onPress(badge, earned, earnedAt);
        }}
        activeOpacity={0.75}
        accessibilityLabel={
          earned
            ? `${badge.name} badge, earned. ${badge.description}`
            : `${badge.name} badge, locked`
        }
      >
        <Text style={[styles.cellEmoji, { opacity: earned ? 1 : 0.5 }]}>
          {badge.emoji}
        </Text>
        <Text style={[styles.cellName, { color: earned ? "#f3f4f6" : "#6b7280" }]} numberOfLines={2}>
          {earned ? badge.name : "???"}
        </Text>
        {earned && (
          <View style={[styles.rarityDot, { backgroundColor: color }]} />
        )}
        {!earned && (
          <Text style={styles.lockIcon}>🔒</Text>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

// ── Detail modal ──────────────────────────────────────────────────────────────

interface DetailModalProps {
  badge:     Badge | null;
  earned:    boolean;
  earnedAt:  string | null;
  onClose:   () => void;
}

function BadgeDetailModal({ badge, earned, earnedAt, onClose }: DetailModalProps) {
  if (!badge) return null;

  const color = earned ? RARITY_COLOR[badge.rarity] : "#6b7280";

  const formattedDate = earnedAt
    ? new Date(earnedAt).toLocaleDateString(undefined, {
        day:   "numeric",
        month: "short",
        year:  "numeric",
      })
    : null;

  return (
    <Modal
      visible={!!badge}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={[styles.modalCard, { borderColor: color }]}>
          {/* Rarity header strip */}
          <View style={[styles.modalStrip, { backgroundColor: color }]}>
            <Text style={styles.modalStripText}>{RARITY_LABEL[badge.rarity]}</Text>
          </View>

          {/* Badge display */}
          <Text style={styles.modalEmoji}>{earned ? badge.emoji : "🔒"}</Text>
          <Text style={[styles.modalName, { color }]}>{earned ? badge.name : "???"}</Text>
          <Text style={styles.modalDesc}>{badge.description}</Text>

          {/* Category tag */}
          <View style={[styles.catTag, { borderColor: color }]}>
            <Text style={[styles.catTagText, { color }]}>
              {badge.category.replace("-", " ").toUpperCase()}
            </Text>
          </View>

          {/* Earned date OR locked hint */}
          {earned && formattedDate ? (
            <Text style={styles.earnedDate}>Earned {formattedDate} ✨</Text>
          ) : (
            <Text style={styles.lockedHint}>Keep questing to unlock this badge!</Text>
          )}

          <TouchableOpacity style={[styles.closeBtn, { borderColor: color }]} onPress={onClose}>
            <Text style={[styles.closeBtnText, { color }]}>Close</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface AchievementBadgeGridProps {
  childId: string;
}

export function AchievementBadgeGrid({ childId }: AchievementBadgeGridProps) {
  const [records,     setRecords]     = useState<AchievementRecord[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [activeTab,   setActiveTab]   = useState<BadgeCategory | "all">("all");
  const [detailBadge, setDetailBadge] = useState<Badge | null>(null);
  const [detailEarned, setDetailEarned] = useState(false);
  const [detailAt,    setDetailAt]    = useState<string | null>(null);

  // ── Load earned records ────────────────────────────────────────────────────

  useEffect(() => {
    if (!childId) return;
    setLoading(true);
    loadEarnedAchievements(childId)
      .then(setRecords)
      .catch(() => setRecords([]))
      .finally(() => setLoading(false));
  }, [childId]);

  // ── Derived data ───────────────────────────────────────────────────────────

  const earnedMap = useMemo<Map<string, string>>(() => {
    const m = new Map<string, string>();
    records.forEach((r) => m.set(r.badge_id, r.earned_at));
    return m;
  }, [records]);

  const earnedCount = earnedMap.size;

  const filteredBadges = useMemo(() =>
    activeTab === "all"
      ? BADGE_DEFINITIONS
      : BADGE_DEFINITIONS.filter((b) => b.category === activeTab),
    [activeTab]
  );

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleBadgePress = (badge: Badge, earned: boolean, at: string | null) => {
    setDetailBadge(badge);
    setDetailEarned(earned);
    setDetailAt(at);
  };

  const handleModalClose = () => {
    setDetailBadge(null);
    setDetailEarned(false);
    setDetailAt(null);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      {/* Section header */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>🏆 Achievements</Text>
        <Text style={styles.countBadge}>{earnedCount} / {TOTAL_BADGES}</Text>
      </View>

      {/* Progress bar */}
      <View style={styles.progressBg}>
        <Animated.View
          style={[
            styles.progressFill,
            { width: `${(earnedCount / TOTAL_BADGES) * 100}%` as any },
          ]}
        />
      </View>

      {/* Category filter tabs */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabsRow}
        contentContainerStyle={styles.tabsContent}
      >
        {CATEGORY_TABS.map((tab) => (
          <TouchableOpacity
            key={tab.value}
            style={[
              styles.tab,
              activeTab === tab.value && styles.tabActive,
            ]}
            onPress={() => {
              setActiveTab(tab.value);
              Haptics.selectionAsync();
            }}
          >
            <Text style={[
              styles.tabText,
              activeTab === tab.value && styles.tabTextActive,
            ]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Badge grid */}
      {loading ? (
        <View style={styles.loadingRow}>
          <Text style={styles.loadingText}>Loading badges…</Text>
        </View>
      ) : (
        <View style={styles.grid}>
          {filteredBadges.map((badge, idx) => {
            const earned    = earnedMap.has(badge.id);
            const earnedAt  = earnedMap.get(badge.id) ?? null;
            return (
              <BadgeCell
                key={badge.id}
                badge={badge}
                earned={earned}
                earnedAt={earnedAt}
                index={idx}
                onPress={handleBadgePress}
              />
            );
          })}
        </View>
      )}

      {/* Detail modal */}
      <BadgeDetailModal
        badge={detailBadge}
        earned={detailEarned}
        earnedAt={detailAt}
        onClose={handleModalClose}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    marginHorizontal: GRID_PAD,
    marginBottom:     28,
  },

  sectionHeader: {
    flexDirection:    "row",
    alignItems:       "center",
    justifyContent:   "space-between",
    marginBottom:     10,
  },

  sectionTitle: {
    fontSize:         17,
    fontWeight:       "700",
    color:            "#f3f4f6",
    letterSpacing:    0.3,
  },

  countBadge: {
    fontSize:         12,
    fontWeight:       "700",
    color:            "#7c3aed",
    backgroundColor:  "rgba(124,58,237,0.12)",
    borderRadius:     12,
    paddingHorizontal: 10,
    paddingVertical:  3,
    borderWidth:      1,
    borderColor:      "rgba(124,58,237,0.3)",
  },

  // Progress bar
  progressBg: {
    height:           5,
    backgroundColor:  "rgba(124,58,237,0.15)",
    borderRadius:     3,
    marginBottom:     14,
    overflow:         "hidden",
  },
  progressFill: {
    height:           "100%",
    backgroundColor:  "#7c3aed",
    borderRadius:     3,
  },

  // Tabs
  tabsRow: {
    marginBottom:     14,
    flexGrow:         0,
  },
  tabsContent: {
    gap:              8,
    paddingRight:     8,
  },
  tab: {
    paddingHorizontal: 12,
    paddingVertical:  6,
    borderRadius:     20,
    backgroundColor:  "rgba(55,65,81,0.4)",
    borderWidth:      1,
    borderColor:      "rgba(107,114,128,0.3)",
  },
  tabActive: {
    backgroundColor:  "rgba(124,58,237,0.18)",
    borderColor:      "#7c3aed",
  },
  tabText: {
    fontSize:         12,
    color:            "#9ca3af",
    fontWeight:       "600",
  },
  tabTextActive: {
    color:            "#a78bfa",
  },

  // Grid
  grid: {
    flexDirection:    "row",
    flexWrap:         "wrap",
    gap:              GRID_GAP,
  },

  loadingRow: {
    paddingVertical:  32,
    alignItems:       "center",
  },
  loadingText: {
    color:            "#9ca3af",
    fontSize:         13,
  },

  // Cell
  cell: {
    height:           108,
    borderRadius:     14,
    borderWidth:      1.5,
    overflow:         "hidden",
    position:         "relative",
  },
  cellTouchable: {
    flex:             1,
    alignItems:       "center",
    justifyContent:   "center",
    padding:          8,
    gap:              4,
  },
  cellEmoji: {
    fontSize:         28,
    lineHeight:       32,
  },
  cellName: {
    fontSize:         10,
    fontWeight:       "700",
    textAlign:        "center",
    lineHeight:       13,
  },
  rarityDot: {
    width:            6,
    height:           6,
    borderRadius:     3,
    marginTop:        2,
  },
  lockIcon: {
    fontSize:         10,
    marginTop:        2,
    opacity:          0.5,
  },
  legendaryBorderAnim: {
    borderRadius:     14,
    borderWidth:      1.5,
    borderColor:      "#f59e0b",
  },

  // Modal
  modalBackdrop: {
    flex:             1,
    backgroundColor:  "rgba(0,0,0,0.7)",
    alignItems:       "center",
    justifyContent:   "center",
    padding:          24,
  },
  modalCard: {
    width:            "100%",
    maxWidth:         340,
    backgroundColor:  "#1a1028",
    borderRadius:     20,
    borderWidth:      1.5,
    overflow:         "hidden",
    alignItems:       "center",
    paddingBottom:    24,
  },
  modalStrip: {
    width:            "100%",
    paddingVertical:  6,
    alignItems:       "center",
    marginBottom:     20,
  },
  modalStripText: {
    fontSize:         11,
    fontWeight:       "800",
    color:            "#fff",
    letterSpacing:    1.5,
    textTransform:    "uppercase",
  },
  modalEmoji: {
    fontSize:         52,
    lineHeight:       60,
    marginBottom:     10,
  },
  modalName: {
    fontSize:         20,
    fontWeight:       "800",
    letterSpacing:    0.3,
    marginBottom:     8,
    textAlign:        "center",
    paddingHorizontal: 16,
  },
  modalDesc: {
    fontSize:         13,
    color:            "#d1d5db",
    textAlign:        "center",
    lineHeight:       19,
    paddingHorizontal: 24,
    marginBottom:     14,
  },
  catTag: {
    borderRadius:     20,
    borderWidth:      1,
    paddingHorizontal: 12,
    paddingVertical:  4,
    marginBottom:     14,
  },
  catTagText: {
    fontSize:         10,
    fontWeight:       "800",
    letterSpacing:    1.2,
  },
  earnedDate: {
    fontSize:         12,
    color:            "#9ca3af",
    marginBottom:     18,
    fontStyle:        "italic",
  },
  lockedHint: {
    fontSize:         12,
    color:            "#6b7280",
    marginBottom:     18,
    fontStyle:        "italic",
    textAlign:        "center",
    paddingHorizontal: 16,
  },
  closeBtn: {
    borderRadius:     24,
    borderWidth:      1.5,
    paddingHorizontal: 32,
    paddingVertical:  10,
  },
  closeBtnText: {
    fontSize:         14,
    fontWeight:       "700",
  },
});
