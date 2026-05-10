/**
 * QuestMapScreen.tsx — Lexi-Lens dungeon map, Phase 2.3
 *
 * v2.3 additions:
 *   • DailyQuestBanner at top of list — today's featured quest with pulsing fire glow
 *   • StreakBar below banner — 7-flame tracker, bounces when 2× XP active
 *   • loadStreakData + loadDailyQuest called on mount alongside loadQuests
 *   • QuestCard shows a 📅 Daily badge when it matches today's daily quest
 *   • handleDailyQuestPress — dedicated handler that navigates directly to Scan
 *
 * v2.2 additions:
 *   • DifficultyDots — 1/2/3 filled dots derived from quest.sort_order
 *
 * v2.1 changes:
 *   • Quests grouped into Tier sections: Apprentice → Scholar → Sage → Archmage
 *   • Each tier has a TierHeader showing emoji, name, cleared/locked state
 *   • Locked tiers render LockedTierCard instead of playable QuestCards
 *
 * Quest card states:
 *   • Available   — "Begin Quest ✦"
 *   • Completed   — green badge + "↩ Replay" + "⚔ Hard Mode"
 *   • Hard Beaten — red crown badge
 *   • Daily       — orange 📅 Daily badge overlay
 *
 * Lumi addition (this file):
 *   • LumiHUD overlays the screen — ambient brand presence, bottom-right
 */

import React, { useEffect, useCallback, useMemo } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  SectionList,
  StyleSheet,
  Platform,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useFocusEffect } from "@react-navigation/native";
import * as Haptics from "expo-haptics";

import {
  useGameStore,
  selectQuestCompletionMode,
  selectHasHardMode,
  selectLevelProgress,
  selectQuestsGroupedByTier,
  selectDailyQuest,
  selectIsQuestLocked,
  getDisplayProperties,
  TIER_META,
  type Quest,
  type TierGroup,
  type QuestTier,
} from "../store/gameStore";

import { DailyQuestBanner } from "../components/DailyQuestBanner";
import { StreakBar }         from "../components/StreakBar";
import { LumiHUD }           from "../components/Lumi";

import type { RootStackParamList } from "../types/navigation";
type Props = NativeStackScreenProps<RootStackParamList, "QuestMap">;

// ─── Palette ──────────────────────────────────────────────────────────────────

const P = {
  bg:          "#0f0620",
  cardBg:      "#1e1040",
  cardBorder:  "#3d2080",
  gold:        "#f5c842",
  textPrimary: "#f3e8ff",
  textMuted:   "#a78bfa",
  textDim:     "#6b5fa0",
  purple:      "#7c3aed",
  fire:        "#f97316",

  hardBg:      "#1a0505",
  hardBorder:  "#7f1d1d",
  hardText:    "#fca5a5",
  hardBtn:     "#991b1b",
  hardBtnText: "#fef2f2",

  doneGreen:   "#052e16",
  doneGreenBd: "#166534",
  doneText:    "#86efac",

  lockedBg:     "#0d0d1a",
  lockedBorder: "#2a2040",
  lockedText:   "#4a3f6b",

  // v6.0 — Premium-locked quest card (visible-but-locked)
  // Uses gold accents to read as "valuable thing you could unlock" rather
  // than "broken/unavailable". Distinct from the tier-progression lock
  // (which uses the dim purple lockedBg above).
  premiumBg:     "rgba(245,200,66,0.06)",
  premiumBorder: "rgba(245,200,66,0.30)",
  premiumGold:   "#f5c842",
  premiumDim:    "#7a6a3a",
};

// ─── XP / level bar ───────────────────────────────────────────────────────────

function LevelBar() {
  const child    = useGameStore((s) => s.activeChild);
  const progress = useGameStore(selectLevelProgress);

  if (!child) return null;
  const pct = Math.round(progress * 100);

  return (
    <View style={styles.levelBar}>
      <Text style={styles.levelLabel}>Lv {child.level}</Text>
      <View style={styles.levelTrack}>
        <View style={[styles.levelFill, { width: `${pct}%` as any }]} />
      </View>
      <Text style={styles.levelXp}>{child.total_xp} XP</Text>
    </View>
  );
}

// ─── Tier header ──────────────────────────────────────────────────────────────

function TierHeader({ tier, unlocked, cleared }: { tier: QuestTier; unlocked: boolean; cleared: boolean }) {
  const meta = TIER_META[tier];

  return (
    <View style={[styles.tierHeader, !unlocked && styles.tierHeaderLocked]}>
      <Text style={styles.tierEmoji}>{unlocked ? meta.emoji : "🔒"}</Text>
      <View style={{ flex: 1 }}>
        <Text style={[styles.tierLabel, !unlocked && styles.tierLabelLocked]}>
          {meta.label}
        </Text>
        {!unlocked && (
          <Text style={styles.tierLockMsg}>{meta.lockMessage}</Text>
        )}
      </View>
      {cleared && (
        <View style={[styles.tierBadge, { borderColor: meta.color }]}>
          <Text style={[styles.tierBadgeText, { color: meta.color }]}>✦ Cleared</Text>
        </View>
      )}
      {unlocked && !cleared && (
        <View style={styles.tierBadgeOpen}>
          <Text style={styles.tierBadgeOpenText}>Active</Text>
        </View>
      )}
    </View>
  );
}

// ─── Locked tier placeholder ──────────────────────────────────────────────────

function LockedTierCard({ questCount, lockMessage }: { questCount: number; lockMessage: string }) {
  return (
    <View style={styles.lockedCard}>
      <Text style={styles.lockedIcon}>🔒</Text>
      <Text style={styles.lockedTitle}>
        {questCount} quest{questCount !== 1 ? "s" : ""} await
      </Text>
      <Text style={styles.lockedMsg}>{lockMessage}</Text>
    </View>
  );
}

// ─── Difficulty dots ──────────────────────────────────────────────────────────

function getDifficultyLevel(sortOrder: number): 1 | 2 | 3 {
  if (sortOrder <= 5)  return 1;
  if (sortOrder <= 10) return 2;
  return 3;
}

const DIFF_META: Record<1 | 2 | 3, { label: string; activeColor: string }> = {
  1: { label: "Beginner",  activeColor: "#22c55e" },
  2: { label: "Explorer",  activeColor: "#f59e0b" },
  3: { label: "Champion",  activeColor: "#f97316" },
};

function DifficultyDots({ sortOrder }: { sortOrder: number }) {
  const level = getDifficultyLevel(sortOrder ?? 8);
  const { label, activeColor } = DIFF_META[level];

  return (
    <View style={diffStyles.row}>
      {([1, 2, 3] as const).map((dot) => (
        <View
          key={dot}
          style={[
            diffStyles.dot,
            { backgroundColor: dot <= level ? activeColor : "rgba(255,255,255,0.10)" },
          ]}
        />
      ))}
      <Text style={[diffStyles.label, { color: activeColor }]}>{label}</Text>
    </View>
  );
}

const diffStyles = StyleSheet.create({
  row:   { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  dot:   { width: 6, height: 6, borderRadius: 3 },
  label: { fontSize: 10, fontWeight: "600", marginLeft: 2, letterSpacing: 0.3 },
});

// ─── Quest card ───────────────────────────────────────────────────────────────

function QuestCard({
  quest,
  onBegin,
  onHardMode,
  isLocked,
}: {
  quest:      Quest;
  onBegin:    () => void;
  onHardMode: () => void;
  /**
   * v6.0 — true when quest is paid-tier and the parent is on free.
   * Renders a greyed card with a 🔒 Premium CTA instead of Begin.
   * Server `evaluate` enforces the gate authoritatively — this is UX only.
   */
  isLocked:   boolean;
}) {
  const completionMode   = useGameStore((s) => selectQuestCompletionMode(s, quest.id));
  const dailyQuestId     = useGameStore((s) => s.dailyQuest.questId);
  const isDailyComplete  = useGameStore((s) => s.isDailyQuestComplete);
  const ageBand          = useGameStore((s: any) => s.activeChild?.age_band ?? "7-8");
  const hasHard          = selectHasHardMode(quest);

  // Age-band-specific properties — matches exactly what beginQuest() will use
  const displayProps = getDisplayProperties(quest, ageBand);

  const isCompleted  = completionMode === "normal" || completionMode === "hard";
  const isHardBeaten = completionMode === "hard";
  const isDaily      = quest.id === dailyQuestId;
  const propCount    = displayProps.length;

  // XP FIX: compute the real max XP the Edge Function will award.
  // Formula mirrors evaluateObject.ts: base × propCount × multiBonus
  const multiBonus  = propCount >= 3 ? 2.0 : propCount === 2 ? 1.5 : 1.0;
  const maxXpFirst  = Math.round((quest.xp_reward_first_try ?? 40) * propCount * multiBonus);
  const maxXpRetry  = Math.round((quest.xp_reward_retry     ?? 25) * propCount * multiBonus);

  // ── v6.0 — Premium-locked tap handler ─────────────────────
  // Pre-RevenueCat (Phase 4.4): single Alert explaining the lock.
  // Post-RevenueCat: replace this body with the paywall trigger.
  const handleLockedTap = useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    Alert.alert(
      "🔒 Premium Quest",
      `"${quest.name}" is part of the Premium adventure pack.\n\nUpgrade your account to unlock all premium dungeons, harder challenges, and more XP.`,
      [
        { text: "Maybe later", style: "cancel" },
        // TODO Phase 4.4 — replace with RevenueCat paywall presenter.
        { text: "Tell me more", style: "default", onPress: () => { /* paywall hook */ } },
      ],
      { cancelable: true },
    );
  }, [quest.name]);

  return (
    <View
      style={[
        styles.card,
        isLocked && styles.cardLocked,
        isHardBeaten && !isLocked && styles.cardHardBeaten,
        isCompleted && !isHardBeaten && !isLocked && styles.cardCompleted,
        // v2.3 — fire glow for today's daily quest (only when not yet done AND not locked)
        isDaily && !isDailyComplete && !isLocked && styles.cardDaily,
      ]}
    >
      {/* ── Header ─────────────────────────────────────── */}
      <View style={styles.cardHeader}>
        <Text style={[styles.cardEmoji, isLocked && styles.dimmed]}>{quest.enemy_emoji}</Text>
        <View style={{ flex: 1 }}>
          <Text style={[styles.cardEnemyName, isLocked && styles.dimmedText]}>{quest.enemy_name}</Text>
          <Text style={[styles.cardRoom, isLocked && styles.dimmedText]}>{quest.room_label}</Text>
          <DifficultyDots sortOrder={quest.sort_order ?? 8} />
        </View>

        {/* Badges — right side */}
        <View style={styles.badgeStack}>
          {/* v6.0 — Premium badge takes priority over other badges when locked */}
          {isLocked && (
            <View style={styles.badgePremium}>
              <Text style={styles.badgePremiumText}>🔒 Premium</Text>
            </View>
          )}
          {/* v2.3 — Daily badge (suppressed on locked cards to avoid mixed signals) */}
          {!isLocked && isDaily && !isDailyComplete && (
            <View style={styles.badgeDaily}>
              <Text style={styles.badgeDailyText}>📅 Daily</Text>
            </View>
          )}
          {/* User-created badge */}
          {!isLocked && quest.created_by && (
            <View style={styles.badgeUser}>
              <Text style={styles.badgeUserText}>✏ Custom</Text>
            </View>
          )}
          {!isLocked && isHardBeaten && (
            <View style={styles.badgeHard}>
              <Text style={styles.badgeHardText}>⚔ Hard</Text>
            </View>
          )}
          {!isLocked && isCompleted && !isHardBeaten && (
            <View style={styles.badgeDone}>
              <Text style={styles.badgeDoneText}>✦ Done</Text>
            </View>
          )}
        </View>
      </View>

      {/* ── Property preview — words the child will actually scan for ───── */}
      <View style={[styles.propRow, isLocked && styles.dimmed]}>
        {displayProps.slice(0, 3).map((p) => (
          <View key={p.word} style={styles.propChip}>
            <Text style={styles.propChipText}>{p.word}</Text>
          </View>
        ))}
        {propCount > 3 && (
          <Text style={styles.propMore}>+{propCount - 3}</Text>
        )}
      </View>

      {/* ── Hard mode property preview ───────────────────── */}
      {!isLocked && isCompleted && !isHardBeaten && hasHard && (
        <View style={styles.hardPropRow}>
          <Text style={styles.hardPropLabel}>⚔ Hard words: </Text>
          {quest.hard_mode_properties.slice(0, 3).map((p) => (
            <View key={p.word} style={styles.hardPropChip}>
              <Text style={styles.hardPropChipText}>{p.word}</Text>
            </View>
          ))}
        </View>
      )}

      {/* ── XP rewards (XP FIX: shows real formula total) ── */}
      <View style={[styles.xpRow, isLocked && styles.dimmed]}>
        <View>
          <Text style={styles.xpText}>
            ⚡ Up to{" "}
            <Text style={{ color: isLocked ? P.premiumDim : P.gold, fontWeight: "800" }}>{maxXpFirst} XP</Text>
          </Text>
          <Text style={[styles.xpText, { fontSize: 10, color: P.textDim, marginTop: 1 }]}>
            {quest.xp_reward_first_try ?? 40}/prop · {propCount} prop{propCount !== 1 ? "s" : ""} · {multiBonus}×
          </Text>
        </View>
        <Text style={styles.xpText}>
          Retry: <Text style={{ color: P.textDim }}>{maxXpRetry} XP</Text>
        </Text>
      </View>

      {/* ── Action buttons ──────────────────────────────── */}
      <View style={styles.btnRow}>
        {isLocked ? (
          <TouchableOpacity
            style={styles.premiumBtn}
            onPress={handleLockedTap}
            activeOpacity={0.85}
            accessibilityLabel={`${quest.name} is a premium quest. Tap to learn more.`}
          >
            <Text style={styles.premiumBtnText}>🔒 Unlock Premium</Text>
          </TouchableOpacity>
        ) : (
          <>
            {!isHardBeaten && (
              <TouchableOpacity
                style={[styles.beginBtn, isCompleted && styles.replayBtn]}
                onPress={onBegin}
                activeOpacity={0.8}
              >
                <Text style={[styles.beginBtnText, isCompleted && styles.replayBtnText]}>
                  {isCompleted ? "↩ Replay" : "Begin Quest ✦"}
                </Text>
              </TouchableOpacity>
            )}

            {isCompleted && !isHardBeaten && hasHard && (
              <TouchableOpacity
                style={styles.hardBtn}
                onPress={onHardMode}
                activeOpacity={0.8}
              >
                <Text style={styles.hardBtnText}>⚔ Hard Mode</Text>
              </TouchableOpacity>
            )}

            {isHardBeaten && (
              <View style={styles.hardBeatenRow}>
                <Text style={styles.hardBeatenText}>👑 Hard mode conquered!</Text>
              </View>
            )}
          </>
        )}
      </View>
    </View>
  );
}

// ─── Section item type ────────────────────────────────────────────────────────

type SectionItem =
  | { kind: "quest";  quest: Quest }
  | { kind: "locked"; questCount: number; lockMessage: string };

// ─── Main screen ──────────────────────────────────────────────────────────────

export function QuestMapScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();

  const activeChild       = useGameStore((s) => s.activeChild);
  const isLoading         = useGameStore((s) => s.isLoadingQuests);
  const questError        = useGameStore((s) => s.questError);
  const loadQuests        = useGameStore((s) => s.loadQuests);
  const loadCompleted     = useGameStore((s) => s.loadCompletedQuests);
  const questLibrary      = useGameStore((s) => s.questLibrary);
  const completedQuestIds = useGameStore((s) => s.completedQuestIds);

  // v6.0 — parent subscription tier (drives quest lock state)
  const parentTier        = useGameStore((s) => s.parentSubscriptionTier);
  const loadParentProfile = useGameStore((s) => s.loadParentProfile);

  // v2.3 — streak + daily quest loaders
  const loadStreakData = useGameStore((s) => s.loadStreakData);
  const loadDailyQuest = useGameStore((s) => s.loadDailyQuest);
  const dailyQuestObj  = useGameStore(selectDailyQuest);

  // v2.1 — derive tier groups
  const tierGroups = useMemo(
    () => selectQuestsGroupedByTier({ questLibrary, completedQuestIds } as any),
    [questLibrary, completedQuestIds]
  );

  // Load everything on mount / child change
  useEffect(() => {
    loadQuests();
    loadCompleted();
    loadStreakData();
    // v6.0 — fetch parent tier alongside quests so the QuestMap renders
    // accurate lock state on first paint. Independent of activeChild
    // since subscription is parent-level, but cheap to refresh on switch.
    loadParentProfile();
  }, [activeChild?.id]);

  // Refresh child XP + level + completed quests whenever QuestMap regains
  // focus (e.g. after returning from ScanScreen post-quest-completion).
  useFocusEffect(
    useCallback(() => {
      const refreshState = useGameStore.getState();
      refreshState.refreshChildFromDB();
      refreshState.loadCompletedQuests();
    }, [])
  );

  // Load daily quest once quest library is ready
  useEffect(() => {
    if (questLibrary.length > 0) {
      loadDailyQuest();
    }
  }, [questLibrary.length]);

  // Generic quest navigation handler
  const handleBegin = useCallback(
    (quest: Quest, hardMode = false) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      navigation.navigate("Scan", { questId: quest.id, hardMode });
    },
    [navigation]
  );

  // v2.3 — dedicated handler for the daily quest banner
  const handleDailyQuestPress = useCallback(() => {
    if (!dailyQuestObj) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    navigation.navigate("Scan", { questId: dailyQuestObj.id, hardMode: false });
  }, [dailyQuestObj, navigation]);

  // Build SectionList sections from tier groups
  const sections = useMemo(() => {
    return tierGroups.map((group: TierGroup) => {
      const data: SectionItem[] = group.unlocked
        ? group.quests.map((q) => ({ kind: "quest", quest: q }))
        : [
            {
              kind:        "locked",
              questCount:  group.quests.length,
              lockMessage: TIER_META[group.tier].lockMessage,
            } as SectionItem,
          ];

      return {
        tier:     group.tier,
        unlocked: group.unlocked,
        cleared:  group.cleared,
        data,
      };
    });
  }, [tierGroups]);

  const renderSectionHeader = useCallback(
    ({ section }: { section: (typeof sections)[number] }) => (
      <TierHeader
        tier={section.tier}
        unlocked={section.unlocked}
        cleared={section.cleared}
      />
    ),
    []
  );

  const renderItem = useCallback(
    ({ item }: { item: SectionItem }) => {
      if (item.kind === "locked") {
        return (
          <LockedTierCard
            questCount={item.questCount}
            lockMessage={item.lockMessage}
          />
        );
      }
      // v6.0 — derive lock state per-quest. selectIsQuestLocked treats
      // null parentTier as 'free' (most restrictive) so the card stays
      // locked during the brief window before loadParentProfile resolves.
      const isLocked = selectIsQuestLocked(item.quest, parentTier);
      return (
        <QuestCard
          quest={item.quest}
          isLocked={isLocked}
          onBegin={() => handleBegin(item.quest, false)}
          onHardMode={() => handleBegin(item.quest, true)}
        />
      );
    },
    [handleBegin, parentTier]
  );

  const keyExtractor = useCallback(
    (item: SectionItem, index: number) =>
      item.kind === "quest" ? item.quest.id : `locked-${index}`,
    []
  );

  // v2.3 — list header component (banner + streak bar)
  const ListHeader = useCallback(
    () => (
      <View>
        <DailyQuestBanner onPress={handleDailyQuestPress} />
        <StreakBar variant="full" />
      </View>
    ),
    [handleDailyQuestPress]
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* ── Screen header ───────────────────────────────── */}
      <View style={styles.header}>
        {/* Chart icon removed — ParentDashboard accessible via PIN-gated Word Tome on ChildSwitcher */}
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Dungeon Map</Text>
          {activeChild && (
            <Text style={styles.headerSub}>{activeChild.display_name}</Text>
          )}
        </View>
        <View style={styles.headerRight}>
          <LevelBar />
          <TouchableOpacity
            style={styles.spellBookBtn}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              navigation.navigate("SpellBook");
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.spellBookBtnText}>📖</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Content ─────────────────────────────────────── */}
      {isLoading ? (
        <View style={styles.empty}>
          <ActivityIndicator color={P.purple} size="large" />
        </View>
      ) : sections.length === 0 ? (
        <View style={styles.empty}>
          {questError ? (
            <Text style={[styles.emptyText, { color: "#fca5a5" }]}>{questError}</Text>
          ) : (
            <>
              <Text style={{ fontSize: 40, marginBottom: 16 }}>🗺️</Text>
              <Text style={styles.emptyText}>No quests available yet.</Text>
            </>
          )}
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={keyExtractor}
          renderSectionHeader={renderSectionHeader}
          renderItem={renderItem}
          // v2.3 — banner + streak bar at top
          ListHeaderComponent={ListHeader}
          contentContainerStyle={[
            styles.list,
            { paddingBottom: insets.bottom + 24 },
          ]}
          stickySectionHeadersEnabled={false}
          showsVerticalScrollIndicator={false}
        />
      )}

      {/* ── Lumi mascot — ambient brand presence, bottom-right ─────────── */}
      <LumiHUD screen="quest-map" />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: P.bg },

  // ── Screen header ──────────────────────────────────────
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    paddingHorizontal: 16,
    paddingVertical:   12,
    borderBottomWidth: 0.5,
    borderBottomColor: P.cardBorder,
  },
  headerTitle: { fontSize: 22, fontWeight: "800", color: P.textPrimary },
  headerSub:   { fontSize: 13, color: P.textMuted, marginTop: 1 },

  headerCenter: {
    flex:           1,
    alignItems:     "center",
    justifyContent: "center",
  },

  headerRight: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           12,
  },
  spellBookBtn: {
    width:           38,
    height:          38,
    borderRadius:    19,
    backgroundColor: "rgba(167,139,250,0.15)",
    borderWidth:     1,
    borderColor:     "rgba(167,139,250,0.35)",
    alignItems:      "center",
    justifyContent:  "center",
  },
  spellBookBtnText: {
    fontSize: 18,
  },

  // ── Level bar ──────────────────────────────────────────
  levelBar: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           8,
  },
  levelLabel: { fontSize: 12, color: P.gold, fontWeight: "700", minWidth: 34 },
  levelTrack: {
    width: 72, height: 6,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderRadius: 3, overflow: "hidden",
  },
  levelFill: { height: 6, backgroundColor: P.purple, borderRadius: 3 },
  levelXp:   { fontSize: 11, color: P.textDim, minWidth: 50, textAlign: "right" },

  // ── List container ─────────────────────────────────────
  list: { paddingHorizontal: 16, paddingTop: 12 },

  // ── Tier header ────────────────────────────────────────
  tierHeader: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               10,
    marginTop:         24,
    marginBottom:      10,
    paddingHorizontal: 4,
  },
  tierHeaderLocked: { opacity: 0.55 },
  tierEmoji: { fontSize: 22 },
  tierLabel: {
    fontSize:      16,
    fontWeight:    "800",
    color:         P.textPrimary,
    letterSpacing: 0.3,
  },
  tierLabelLocked: { color: P.textDim },
  tierLockMsg:     { fontSize: 11, color: P.textDim, marginTop: 1 },

  tierBadge: {
    borderRadius:      20,
    borderWidth:       1,
    paddingHorizontal: 10,
    paddingVertical:   4,
  },
  tierBadgeText: { fontSize: 11, fontWeight: "700" },

  tierBadgeOpen: {
    backgroundColor:   "rgba(124,58,237,0.15)",
    borderRadius:      20,
    borderWidth:       0.5,
    borderColor:       P.cardBorder,
    paddingHorizontal: 10,
    paddingVertical:   4,
  },
  tierBadgeOpenText: { fontSize: 11, color: P.textMuted, fontWeight: "600" },

  // ── Locked tier ────────────────────────────────────────
  lockedCard: {
    backgroundColor: P.lockedBg,
    borderRadius:    16,
    borderWidth:     1,
    borderColor:     P.lockedBorder,
    borderStyle:     "dashed",
    padding:         20,
    marginBottom:    12,
    alignItems:      "center",
    gap:             6,
  },
  lockedIcon:  { fontSize: 28, marginBottom: 4 },
  lockedTitle: { fontSize: 14, fontWeight: "700", color: P.lockedText },
  lockedMsg:   { fontSize: 12, color: P.lockedText, textAlign: "center", lineHeight: 18 },

  // ── Quest card ─────────────────────────────────────────
  card: {
    backgroundColor: P.cardBg,
    borderRadius:    18,
    borderWidth:     1,
    borderColor:     P.cardBorder,
    padding:         16,
    marginBottom:    14,
    ...Platform.select({
      ios:     { shadowColor: "#7c3aed", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 12 },
      android: { elevation: 6 },
    }),
  },
  cardCompleted: {
    borderColor:      "#166534",
    backgroundColor:  "rgba(5,46,22,0.35)",
  },
  cardHardBeaten: {
    borderColor:      "#7f1d1d",
    backgroundColor:  "rgba(26,5,5,0.6)",
  },
  // v2.3 — daily quest glow
  cardDaily: {
    borderColor:  P.fire,
    borderWidth:  1.5,
    ...Platform.select({
      ios:     { shadowColor: P.fire, shadowOpacity: 0.45, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } },
      android: { elevation: 8 },
    }),
  },

  // v6.0 — Premium-locked quest card. Subtle gold border to read as
  // "premium content you could unlock", not "broken thing". Avoids any
  // hard greying of the card itself — the dimming happens to the inner
  // content so the gold frame stays inviting.
  cardLocked: {
    backgroundColor: P.premiumBg,
    borderColor:     P.premiumBorder,
    ...Platform.select({
      ios:     { shadowColor: P.premiumGold, shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
      android: { elevation: 3 },
    }),
  },
  // Applied to inner content blocks (emoji, props, xp row) when locked
  dimmed:     { opacity: 0.45 },
  dimmedText: { color: P.textDim },

  cardHeader:    { flexDirection: "row", alignItems: "flex-start", gap: 12, marginBottom: 10 },
  cardEmoji:     { fontSize: 36 },
  cardEnemyName: { fontSize: 17, fontWeight: "700", color: P.textPrimary },
  cardRoom:      { fontSize: 12, color: P.textMuted, marginTop: 2 },

  // Badge stack (right side of card header)
  badgeStack: { alignItems: "flex-end", gap: 4 },

  badgeDone: {
    backgroundColor:   "#052e16",
    borderRadius:      20, borderWidth: 1, borderColor: "#166534",
    paddingHorizontal: 10, paddingVertical: 4,
  },
  badgeDoneText: { fontSize: 11, color: "#86efac", fontWeight: "700" },

  badgeHard: {
    backgroundColor:   "#450a0a",
    borderRadius:      20, borderWidth: 1, borderColor: "#7f1d1d",
    paddingHorizontal: 10, paddingVertical: 4,
  },
  badgeHardText: { fontSize: 11, color: "#fca5a5", fontWeight: "700" },

  badgeUser: {
    backgroundColor:   "rgba(124,58,237,0.12)",
    borderRadius:      20, borderWidth: 1, borderColor: P.cardBorder,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  badgeUserText: { fontSize: 11, color: P.textMuted, fontWeight: "600" },

  // v2.3 — daily badge
  badgeDaily: {
    backgroundColor:   P.fire,
    borderRadius:      20,
    paddingHorizontal: 10,
    paddingVertical:   4,
  },
  badgeDailyText: { fontSize: 11, color: "#fff", fontWeight: "700" },

  // v6.0 — Premium lock badge in the card header
  badgePremium: {
    backgroundColor:   "rgba(245,200,66,0.18)",
    borderRadius:      20,
    borderWidth:       1,
    borderColor:       P.premiumBorder,
    paddingHorizontal: 10,
    paddingVertical:   4,
  },
  badgePremiumText: { fontSize: 11, color: P.premiumGold, fontWeight: "700", letterSpacing: 0.3 },

  // ── Property chips ─────────────────────────────────────
  propRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 6 },
  propChip: {
    backgroundColor:   "rgba(124,58,237,0.15)",
    borderRadius:      20, borderWidth: 0.5, borderColor: P.cardBorder,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  propChipText: { fontSize: 11, color: P.textMuted },
  propMore:     { fontSize: 11, color: P.textDim, alignSelf: "center" },

  hardPropRow:      { flexDirection: "row", flexWrap: "wrap", gap: 5, marginBottom: 6, alignItems: "center" },
  hardPropLabel:    { fontSize: 10, color: "#b45309", fontWeight: "600" },
  hardPropChip: {
    backgroundColor:   "#1c0505",
    borderRadius:      20, borderWidth: 0.5, borderColor: "#7f1d1d",
    paddingHorizontal: 8, paddingVertical: 3,
  },
  hardPropChipText: { fontSize: 10, color: "#fca5a5" },

  // ── XP row ─────────────────────────────────────────────
  xpRow: { flexDirection: "row", gap: 16, marginBottom: 12 },
  xpText: { fontSize: 11, color: P.textDim },

  // ── Action buttons ─────────────────────────────────────
  btnRow: { flexDirection: "row", gap: 10 },

  beginBtn: {
    flex:            1,
    backgroundColor: P.purple,
    borderRadius:    12,
    paddingVertical: 13,
    alignItems:      "center",
  },
  beginBtnText: { fontSize: 15, fontWeight: "700", color: "#fff" },

  replayBtn:     { backgroundColor: "transparent", borderWidth: 1, borderColor: "#166534" },
  replayBtnText: { color: "#86efac" },

  hardBtn: {
    flex:            1,
    backgroundColor: "#991b1b",
    borderRadius:    12,
    paddingVertical: 13,
    alignItems:      "center",
    borderWidth:     1,
    borderColor:     "#7f1d1d",
  },
  hardBtnText: { fontSize: 15, fontWeight: "700", color: "#fef2f2" },

  hardBeatenRow: { flex: 1, alignItems: "center", paddingVertical: 10 },
  hardBeatenText: { fontSize: 14, color: "#fca5a5", fontWeight: "600" },

  // v6.0 — Premium-locked CTA button. Replaces Begin/Replay when isLocked.
  // Gold-on-deep-purple to read as upsell, not as the regular purple
  // primary action — keeps the visual hierarchy intact (premium ≠ free).
  premiumBtn: {
    flex:            1,
    backgroundColor: "rgba(245,200,66,0.10)",
    borderRadius:    12,
    paddingVertical: 13,
    alignItems:      "center",
    borderWidth:     1,
    borderColor:     P.premiumGold,
  },
  premiumBtnText: { fontSize: 15, fontWeight: "700", color: P.premiumGold, letterSpacing: 0.3 },

  // ── Empty / loading ────────────────────────────────────
  empty:     { flex: 1, alignItems: "center", justifyContent: "center", padding: 40 },
  emptyText: { fontSize: 16, color: P.textMuted, textAlign: "center", lineHeight: 24 },
});
