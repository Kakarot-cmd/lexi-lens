/**
 * SpellBookScreen.tsx — Lexi-Lens Phase 2.4: Spell Book
 * Android-safe rewrite:
 *   • No `gap` property (unsupported on older RN/Android)
 *   • Tabs use a plain horizontal-scrolling View via ScrollView — not
 *     contentContainerStyle flexDirection (collapses on Android)
 *   • Grid uses justifyContent:"space-between" — no marginRight on cards
 *   • All spacing via explicit margin/padding
 */

import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  Modal,
  StatusBar,
  ActivityIndicator,
  Platform,
} from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  withDelay,
  Easing,
} from "react-native-reanimated";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useGameStore, QuestTier, TIER_META, TIER_ORDER } from "../store/gameStore";

// ─── Navigation ───────────────────────────────────────────────────────────────

import type { RootStackParamList } from "../types/navigation";
type Props = NativeStackScreenProps<RootStackParamList, "SpellBook">;

// ─── Constants ────────────────────────────────────────────────────────────────

const { width: W } = Dimensions.get("window");
const H_PAD   = 16;
const COL_GAP = 12;
const CARD_W  = (W - H_PAD * 2 - COL_GAP) / 2;

// ─── Tier colours ─────────────────────────────────────────────────────────────

const TIER_GLOW: Record<QuestTier, string> = {
  apprentice: "#86efac",
  scholar:    "#93c5fd",
  sage:       "#c4b5fd",
  archmage:   "#fbbf24",
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SpellEntry {
  questId:          string;
  questName:        string;
  spellName:        string;
  weaponEmoji:      string;
  spellDescription: string;
  enemyName:        string;
  enemyEmoji:       string;
  tier:             QuestTier;
  unlockedAt:       string | null;
  bestXp:           number;
  isHardCleared:    boolean;
}

type FilterTab = "all" | QuestTier;

// ─── Spell card ───────────────────────────────────────────────────────────────

function SpellCard({
  spell,
  colIndex,
  onPress,
}: {
  spell:    SpellEntry;
  colIndex: number;   // 0 = left col, 1 = right col
  onPress:  (s: SpellEntry) => void;
}) {
  const unlocked = spell.unlockedAt !== null;
  const color    = TIER_GLOW[spell.tier];
  const op       = useSharedValue(0);
  const ty       = useSharedValue(20);

  useEffect(() => {
    op.value = withDelay(80, withTiming(1,  { duration: 300 }));
    ty.value = withDelay(80, withSpring(0,  { damping: 16, stiffness: 120 }));
  }, []);

  const anim = useAnimatedStyle(() => ({
    opacity:   op.value,
    transform: [{ translateY: ty.value }],
  }));

  return (
    <Animated.View
      style={[
        anim,
        {
          width:        CARD_W,
          marginBottom: COL_GAP,
          marginLeft:   colIndex === 1 ? COL_GAP : 0,
        },
      ]}
    >
      <TouchableOpacity
        activeOpacity={0.75}
        onPress={() => onPress(spell)}
        style={[
          styles.card,
          {
            borderColor: unlocked
              ? color
              : "rgba(255,255,255,0.10)",
            backgroundColor: unlocked
              ? "rgba(255,255,255,0.05)"
              : "rgba(255,255,255,0.02)",
          },
        ]}
      >
        {/* Weapon / mystery icon */}
        <Text style={styles.cardIcon}>
          {unlocked ? spell.weaponEmoji : "❓"}
        </Text>

        {/* Name */}
        <Text
          numberOfLines={2}
          style={[
            styles.cardName,
            { color: unlocked ? color : "#475569" },
          ]}
        >
          {unlocked ? spell.spellName : "???"}
        </Text>

        {/* Enemy line */}
        {unlocked && (
          <Text numberOfLines={1} style={styles.cardEnemy}>
            {spell.enemyEmoji} {spell.enemyName}
          </Text>
        )}

        {/* Hard mode crown */}
        {unlocked && spell.isHardCleared && (
          <View style={styles.crown}>
            <Text style={{ fontSize: 12 }}>👑</Text>
          </View>
        )}

        {/* Locked tag */}
        {!unlocked && (
          <View style={styles.lockedTag}>
            <Text style={styles.lockedTagText}>🔒 Locked</Text>
          </View>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Two-column grid ─────────────────────────────────────────────────────────

function SpellGrid({
  spells,
  onPress,
}: {
  spells:  SpellEntry[];
  onPress: (s: SpellEntry) => void;
}) {
  // Split into left and right columns
  const left:  SpellEntry[] = [];
  const right: SpellEntry[] = [];
  spells.forEach((s, i) => (i % 2 === 0 ? left : right).push(s));

  return (
    <View style={styles.grid}>
      {/* Left column */}
      <View style={{ width: CARD_W }}>
        {left.map((s) => (
          <SpellCard key={s.questId + "L"} spell={s} colIndex={0} onPress={onPress} />
        ))}
      </View>
      {/* Right column */}
      <View style={{ width: CARD_W, marginLeft: COL_GAP }}>
        {right.map((s) => (
          <SpellCard key={s.questId + "R"} spell={s} colIndex={1} onPress={onPress} />
        ))}
      </View>
    </View>
  );
}

// ─── Tier section header ──────────────────────────────────────────────────────

function TierHeader({ tier, total, cleared }: { tier: QuestTier; total: number; cleared: number }) {
  const meta  = TIER_META[tier];
  const color = TIER_GLOW[tier];
  const pct   = total === 0 ? 0 : cleared / total;
  const bar   = useSharedValue(0);

  useEffect(() => {
    bar.value = withDelay(200, withTiming(pct, { duration: 600, easing: Easing.out(Easing.quad) }));
  }, [pct]);

  const barStyle = useAnimatedStyle(() => ({
    width: `${bar.value * 100}%` as any,
  }));

  return (
    <View style={styles.tierHeader}>
      <Text style={styles.tierEmoji}>{meta.emoji}</Text>
      <Text style={[styles.tierLabel, { color }]}>{meta.label}</Text>
      <View style={styles.tierTrackWrap}>
        <View style={styles.tierTrack}>
          <Animated.View style={[styles.tierFill, { backgroundColor: color }, barStyle]} />
        </View>
      </View>
      <Text style={[styles.tierCount, { color }]}>{cleared}/{total}</Text>
    </View>
  );
}

// ─── Tab bar — plain View inside ScrollView (no contentContainerStyle row) ────

function TabBar({
  active,
  onChange,
  counts,
}: {
  active:   FilterTab;
  onChange: (t: FilterTab) => void;
  counts:   Record<FilterTab, number>;
}) {
  const tabs: Array<{ key: FilterTab; emoji: string; label: string }> = [
    { key: "all",        emoji: "📖", label: "All" },
    { key: "apprentice", emoji: TIER_META.apprentice.emoji, label: "Apprentice" },
    { key: "scholar",    emoji: TIER_META.scholar.emoji,    label: "Scholar" },
    { key: "sage",       emoji: TIER_META.sage.emoji,       label: "Sage" },
    { key: "archmage",   emoji: TIER_META.archmage.emoji,   label: "Archmage" },
  ];

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.tabScroll}
    >
      {/* Plain View row — avoids contentContainerStyle Android collapse */}
      <View style={styles.tabRow}>
        {tabs.map((t, i) => {
          const isActive = active === t.key;
          const color    = t.key === "all" ? "#a78bfa" : (TIER_GLOW[t.key as QuestTier] ?? "#a78bfa");
          return (
            <TouchableOpacity
              key={t.key}
              activeOpacity={0.7}
              onPress={() => onChange(t.key)}
              style={[
                styles.tab,
                i < tabs.length - 1 && { marginRight: 10 },
                isActive && {
                  borderColor:     color,
                  backgroundColor: color + "22",
                },
              ]}
            >
              <Text style={styles.tabEmoji}>{t.emoji}</Text>
              <Text style={[styles.tabLabel, isActive && { color }]}>
                {t.label}
              </Text>
              <View style={[styles.tabBadge, isActive && { backgroundColor: color }]}>
                <Text style={[styles.tabBadgeText, isActive && { color: "#0f172a" }]}>
                  {counts[t.key] ?? 0}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    </ScrollView>
  );
}

// ─── Spell detail modal ───────────────────────────────────────────────────────

function DetailModal({
  spell,
  visible,
  onClose,
}: {
  spell:   SpellEntry | null;
  visible: boolean;
  onClose: () => void;
}) {
  const op    = useSharedValue(0);
  const scale = useSharedValue(0.9);

  useEffect(() => {
    if (visible) {
      op.value    = withTiming(1,  { duration: 200 });
      scale.value = withSpring(1,  { damping: 16, stiffness: 200 });
    } else {
      op.value    = withTiming(0,  { duration: 150 });
      scale.value = withTiming(0.9,{ duration: 150 });
    }
  }, [visible]);

  const modalAnim = useAnimatedStyle(() => ({
    opacity:   op.value,
    transform: [{ scale: scale.value }],
  }));

  if (!spell) return null;

  const unlocked = spell.unlockedAt !== null;
  const color    = TIER_GLOW[spell.tier];
  const meta     = TIER_META[spell.tier];
  const date     = unlocked && spell.unlockedAt
    ? new Date(spell.unlockedAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })
    : null;

  return (
    <Modal transparent animationType="fade" visible={visible} onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <Animated.View style={[styles.modal, modalAnim]}>
          <TouchableOpacity activeOpacity={1} style={styles.modalInner}>
            {/* Tier pill */}
            <View style={[styles.modalTierPill, { borderColor: color }]}>
              <Text style={[styles.modalTierText, { color }]}>
                {meta.emoji}  {meta.label}
              </Text>
            </View>

            {/* Weapon */}
            <Text style={styles.modalWeapon}>{unlocked ? spell.weaponEmoji : "❓"}</Text>

            {/* Spell name */}
            <Text style={[styles.modalSpellName, { color }]}>
              {unlocked ? spell.spellName : "???"}
            </Text>

            {/* Flavour */}
            <Text style={styles.modalFlavour}>
              {unlocked && spell.spellDescription
                ? `"${spell.spellDescription}"`
                : `Defeat ${spell.enemyEmoji} ${spell.enemyName} to unlock this spell.`}
            </Text>

            {/* Stats */}
            {unlocked && (
              <View style={styles.statsBox}>
                <StatRow label="Quest"   value={spell.questName}               color={color} />
                <StatRow label="Enemy"   value={`${spell.enemyEmoji} ${spell.enemyName}`} color={color} />
                {date          && <StatRow label="Unlocked" value={date}             color={color} />}
                {spell.bestXp > 0 && <StatRow label="Best XP"  value={`${spell.bestXp} XP`} color={color} />}
                {spell.isHardCleared && <StatRow label="Hard Mode" value="👑 Cleared!" color="#fbbf24" />}
              </View>
            )}

            <TouchableOpacity style={[styles.closeBtn, { borderColor: color }]} onPress={onClose}>
              <Text style={[styles.closeBtnText, { color }]}>Close</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </Animated.View>
      </TouchableOpacity>
    </Modal>
  );
}

function StatRow({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, { color }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

// ─── Global progress bar ──────────────────────────────────────────────────────

function ProgressBar({ unlocked, total }: { unlocked: number; total: number }) {
  const pct = total === 0 ? 0 : unlocked / total;
  const bar = useSharedValue(0);

  useEffect(() => {
    bar.value = withDelay(100, withTiming(pct, { duration: 800, easing: Easing.out(Easing.quad) }));
  }, [pct]);

  const barStyle = useAnimatedStyle(() => ({
    width: `${bar.value * 100}%` as any,
  }));

  return (
    <View style={styles.progressWrap}>
      <View style={styles.progressTrack}>
        <Animated.View style={[styles.progressFill, barStyle]} />
      </View>
      <Text style={styles.progressPct}>
        {total === 0 ? "0" : Math.round(pct * 100)}% complete
      </Text>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function SpellBookScreen({ navigation }: Props) {
  const spellBook             = useGameStore((s) => s.spellBook);
  const isLoadingSpells       = useGameStore((s) => s.isLoadingSpells);
  const loadSpellBook         = useGameStore((s) => s.loadSpellBook);
  const questLibrary          = useGameStore((s) => s.questLibrary);
  const hardCompletedQuestIds = useGameStore((s) => s.hardCompletedQuestIds);

  const [activeTab,    setActiveTab]    = useState<FilterTab>("all");
  const [detailSpell,  setDetailSpell]  = useState<SpellEntry | null>(null);
  const [modalVisible, setModalVisible] = useState(false);

  useEffect(() => { loadSpellBook(); }, []);

  // Build SpellEntry list from questLibrary + spellBook unlocks
  const allSpells: SpellEntry[] = questLibrary.map((q) => {
    const unlock = spellBook.find((u) => u.questId === q.id);
    return {
      questId:          q.id,
      questName:        q.name,
      spellName:        (q as any).spell_name       ?? q.name,
      weaponEmoji:      (q as any).weapon_emoji      ?? "⚔️",
      spellDescription: (q as any).spell_description ?? "",
      enemyName:        q.enemy_name,
      enemyEmoji:       q.enemy_emoji,
      tier:             q.tier,
      unlockedAt:       unlock?.unlockedAt ?? null,
      bestXp:           unlock?.bestXp     ?? 0,
      isHardCleared:    hardCompletedQuestIds.includes(q.id),
    };
  });

  const totalUnlocked = allSpells.filter((s) => s.unlockedAt !== null).length;

  // Tab unlock counts
  const counts: Record<FilterTab, number> = {
    all:        totalUnlocked,
    apprentice: allSpells.filter((s) => s.tier === "apprentice" && s.unlockedAt).length,
    scholar:    allSpells.filter((s) => s.tier === "scholar"    && s.unlockedAt).length,
    sage:       allSpells.filter((s) => s.tier === "sage"       && s.unlockedAt).length,
    archmage:   allSpells.filter((s) => s.tier === "archmage"   && s.unlockedAt).length,
  };

  // Group by tier, filtered by active tab
  const grouped: Partial<Record<QuestTier, SpellEntry[]>> = {};
  allSpells
    .filter((s) => activeTab === "all" || s.tier === activeTab)
    .forEach((s) => {
      if (!grouped[s.tier]) grouped[s.tier] = [];
      grouped[s.tier]!.push(s);
    });

  const handlePress = useCallback((spell: SpellEntry) => {
    setDetailSpell(spell);
    setModalVisible(true);
  }, []);

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={styles.backArrow}>←</Text>
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>📖 Spell Book</Text>
          <Text style={styles.headerSub}>{totalUnlocked} / {allSpells.length} spells collected</Text>
        </View>
        <View style={{ width: 32 }} />
      </View>

      {/* Progress */}
      <ProgressBar unlocked={totalUnlocked} total={allSpells.length} />

      {/* Tab bar */}
      <TabBar active={activeTab} onChange={setActiveTab} counts={counts} />

      {/* Content */}
      {isLoadingSpells ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#a78bfa" />
          <Text style={styles.loadingText}>Loading spells…</Text>
        </View>
      ) : allSpells.length === 0 ? (
        <View style={styles.center}>
          <Text style={{ fontSize: 48, marginBottom: 12 }}>🌑</Text>
          <Text style={styles.emptyTitle}>No quests yet</Text>
          <Text style={styles.emptySub}>Complete quests to collect spells.</Text>
        </View>
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
        >
          {TIER_ORDER.map((tier) => {
            const spells = grouped[tier];
            if (!spells || spells.length === 0) return null;

            const allInTier   = allSpells.filter((s) => s.tier === tier);
            const clearedInTier = allInTier.filter((s) => s.unlockedAt !== null).length;

            return (
              <View key={tier} style={styles.tierSection}>
                <TierHeader
                  tier={tier}
                  total={allInTier.length}
                  cleared={clearedInTier}
                />
                <SpellGrid spells={spells} onPress={handlePress} />
              </View>
            );
          })}
          <View style={{ height: 40 }} />
        </ScrollView>
      )}

      <DetailModal
        spell={detailSpell}
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#050d1a" },

  // Header
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingTop:        Platform.OS === "ios" ? 52 : 36,
    paddingBottom:     12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(167,139,250,0.15)",
  },
  backArrow:    { color: "#a78bfa", fontSize: 22, fontWeight: "600", width: 32 },
  headerCenter: { flex: 1, alignItems: "center" },
  headerTitle:  { color: "#e2e8f0", fontSize: 20, fontWeight: "700" },
  headerSub:    { color: "#64748b", fontSize: 12, marginTop: 2 },

  // Progress
  progressWrap: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 16,
    paddingVertical:   10,
  },
  progressTrack: {
    flex:            1,
    height:          6,
    borderRadius:    3,
    backgroundColor: "rgba(255,255,255,0.08)",
    overflow:        "hidden",
    marginRight:     10,
  },
  progressFill: {
    height:          6,
    borderRadius:    3,
    backgroundColor: "#a78bfa",
  },
  progressPct: {
    color:     "#94a3b8",
    fontSize:  11,
    minWidth:  80,
    textAlign: "right",
  },

  // Tab bar — ScrollView wrapping a plain View row
  tabScroll: {
    flexGrow:       0,
    flexShrink:     0,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.06)",
  },
  tabRow: {
    flexDirection:   "row",
    alignItems:      "center",
    paddingHorizontal: 14,
    paddingVertical:   10,
  },
  tab: {
    flexDirection:     "row",
    alignItems:        "center",
    paddingHorizontal: 13,
    paddingVertical:   9,
    borderRadius:      22,
    borderWidth:       1.5,
    borderColor:       "rgba(255,255,255,0.18)",
    backgroundColor:   "rgba(255,255,255,0.04)",
  },
  tabEmoji:  { fontSize: 15, marginRight: 5 },
  tabLabel:  { fontSize: 13, fontWeight: "600", color: "#94a3b8", marginRight: 6 },
  tabBadge: {
    backgroundColor:   "rgba(255,255,255,0.10)",
    borderRadius:      10,
    paddingHorizontal: 6,
    paddingVertical:   2,
    minWidth:          20,
    alignItems:        "center",
  },
  tabBadgeText: { fontSize: 11, fontWeight: "700", color: "#94a3b8" },

  // Scroll
  scrollContent: { paddingHorizontal: H_PAD, paddingTop: 12 },

  // Tier section
  tierSection: { marginBottom: 28 },
  tierHeader: {
    flexDirection:  "row",
    alignItems:     "center",
    marginBottom:   14,
  },
  tierEmoji:    { fontSize: 18, marginRight: 8 },
  tierLabel:    { fontSize: 15, fontWeight: "700", letterSpacing: 0.4, marginRight: 10 },
  tierTrackWrap:{ flex: 1 },
  tierTrack: {
    height:          4,
    borderRadius:    2,
    backgroundColor: "rgba(255,255,255,0.07)",
    overflow:        "hidden",
  },
  tierFill:  { height: 4, borderRadius: 2 },
  tierCount: { fontSize: 11, fontWeight: "700", marginLeft: 8, minWidth: 30, textAlign: "right" },

  // Grid — two explicit column Views
  grid: {
    flexDirection: "row",
    alignItems:    "flex-start",
  },

  // Card
  card: {
    width:        "100%",
    minHeight:    140,
    borderRadius: 14,
    borderWidth:  1,
    padding:      14,
    alignItems:   "center",
  },
  cardIcon:  { fontSize: 36, marginBottom: 8 },
  cardName: {
    fontSize:   13,
    fontWeight: "700",
    textAlign:  "center",
    lineHeight: 18,
    marginBottom: 4,
  },
  cardEnemy: { color: "#64748b", fontSize: 10, textAlign: "center" },
  crown: {
    position: "absolute",
    top:      8,
    right:    8,
  },
  lockedTag: {
    marginTop:         8,
    backgroundColor:   "rgba(255,255,255,0.05)",
    borderRadius:      6,
    paddingHorizontal: 8,
    paddingVertical:   3,
  },
  lockedTagText: { color: "#475569", fontSize: 10, fontWeight: "600" },

  // Loading / empty
  center:      { flex: 1, alignItems: "center", justifyContent: "center" },
  loadingText: { color: "#64748b", fontSize: 14, marginTop: 14 },
  emptyTitle:  { color: "#e2e8f0", fontSize: 20, fontWeight: "700", marginBottom: 8 },
  emptySub:    { color: "#64748b", fontSize: 14, textAlign: "center" },

  // Modal
  backdrop: {
    flex:            1,
    backgroundColor: "rgba(5,13,26,0.88)",
    alignItems:      "center",
    justifyContent:  "center",
    paddingHorizontal: 24,
  },
  modal: {
    backgroundColor: "#0f1a2e",
    borderRadius:    20,
    borderWidth:     1,
    borderColor:     "rgba(167,139,250,0.25)",
    width:           "100%",
    maxWidth:        380,
  },
  modalInner: {
    padding:    24,
    alignItems: "center",
  },
  modalTierPill: {
    borderWidth:       1,
    borderRadius:      20,
    paddingHorizontal: 14,
    paddingVertical:   5,
    marginBottom:      16,
  },
  modalTierText: { fontSize: 12, fontWeight: "700" },
  modalWeapon:   { fontSize: 54, marginBottom: 10 },
  modalSpellName:{
    fontSize:     22,
    fontWeight:   "800",
    textAlign:    "center",
    marginBottom: 8,
  },
  modalFlavour: {
    color:        "#94a3b8",
    fontSize:     13,
    fontStyle:    "italic",
    textAlign:    "center",
    lineHeight:   19,
    marginBottom: 20,
    paddingHorizontal: 8,
  },
  statsBox: {
    width:        "100%",
    marginBottom: 20,
  },
  statRow: {
    flexDirection:     "row",
    justifyContent:    "space-between",
    alignItems:        "center",
    backgroundColor:   "rgba(255,255,255,0.04)",
    borderRadius:      8,
    paddingHorizontal: 12,
    paddingVertical:   8,
    marginBottom:      6,
  },
  statLabel: { color: "#64748b", fontSize: 12 },
  statValue: { fontSize: 12, fontWeight: "700", maxWidth: 180, textAlign: "right" },
  closeBtn: {
    borderWidth:       1,
    borderRadius:      12,
    paddingHorizontal: 32,
    paddingVertical:   10,
  },
  closeBtnText: { fontSize: 14, fontWeight: "700" },
});
