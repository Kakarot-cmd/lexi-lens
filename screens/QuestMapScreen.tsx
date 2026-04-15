/**
 * QuestMapScreen.tsx
 * Lexi-Lens — the quest selection "dungeon map" screen.
 *
 * What the child sees between quests:
 *   • Their character card (level, XP bar, avatar)
 *   • A scrollable map of available quests as dungeon rooms
 *   • Completed quests are sealed (greyed, trophy icon)
 *   • Active / available quests pulse gently
 *   • Tapping a room navigates to ScanScreen with that questId
 *
 * Also handles:
 *   • Loading the quest library into the store on mount
 *   • Syncing the child's Word Tome cache from DB on mount
 *   • A "Switch child" button for multi-child households
 *
 * Dependencies (all installed in previous steps):
 *   react-native-reanimated
 *   react-native-safe-area-context
 *   expo-haptics
 *   zustand
 */

import React, { useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Animated,
  Dimensions,
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets }    from "react-native-safe-area-context";
import * as Haptics             from "expo-haptics";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import {
  useGameStore,
  selectLevelProgress,
  type Quest,
} from "../store/gameStore";
import { supabase } from "../lib/supabase";

// ─── Navigation types ─────────────────────────────────────────────────────────

type RootStackParamList = {
  QuestMap: undefined;
  Scan:     { questId: string };
  Parent:   undefined;
};
type Props = NativeStackScreenProps<RootStackParamList, "QuestMap">;

// ─── Constants ────────────────────────────────────────────────────────────────

const { width: SCREEN_W } = Dimensions.get("window");
const CARD_W = (SCREEN_W - 48) / 2; // two columns with 12px gaps + 12px edge padding

const P = {
  deepPurple:  "#0f0620",
  midPurple:   "#160830",
  cardBg:      "#1a0a35",
  cardBorder:  "#2d1560",
  gold:        "#f5c842",
  goldDim:     "#a88820",
  goldText:    "#fde68a",
  textPrimary: "#f3e8ff",
  textMuted:   "#a78bfa",
  textDim:     "#6b5fa0",
  completedBg: "#0f0f1a",
  completedBorder: "#1e1e30",
  xpFill:      "#7c3aed",
  xpTrack:     "rgba(255,255,255,0.08)",
  activePulse: "#7c3aed",
};

const AVATAR_EMOJIS: Record<string, string> = {
  wizard: "🧙", knight: "⚔️", archer: "🏹", dragon: "🐉", default: "✦",
};

// ─── Pulsing ring for available quests ───────────────────────────────────────

function PulseRing() {
  const scale   = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(scale,   { toValue: 1.35, duration: 1400, useNativeDriver: true }),
          Animated.timing(scale,   { toValue: 1,    duration: 1400, useNativeDriver: true }),
        ]),
        Animated.sequence([
          Animated.timing(opacity, { toValue: 0,    duration: 1400, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0.5,  duration: 1400, useNativeDriver: true }),
        ]),
      ])
    ).start();
  }, []);

  return (
    <Animated.View
      style={[styles.pulseRing, { transform: [{ scale }], opacity }]}
      pointerEvents="none"
    />
  );
}

// ─── Quest card ───────────────────────────────────────────────────────────────

function QuestCard({
  quest,
  completed,
  onPress,
}: {
  quest:     Quest;
  completed: boolean;
  onPress:   () => void;
}) {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePress = () => {
    Animated.sequence([
      Animated.timing(scaleAnim, { toValue: 0.95, duration: 80,  useNativeDriver: true }),
      Animated.timing(scaleAnim, { toValue: 1,    duration: 120, useNativeDriver: true }),
    ]).start();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (!completed) onPress();
  };

  const componentCount = quest.required_properties.length;

  return (
    <TouchableOpacity
      onPress={handlePress}
      activeOpacity={0.9}
      accessibilityRole="button"
      accessibilityLabel={`${quest.name} — ${completed ? "completed" : "available"}`}
      accessibilityState={{ disabled: completed }}
    >
      <Animated.View
        style={[
          styles.questCard,
          completed ? styles.questCardDone : styles.questCardActive,
          { transform: [{ scale: scaleAnim }] },
        ]}
      >
        {/* Pulse ring on active quests */}
        {!completed && <PulseRing />}

        {/* Room indicator */}
        <Text style={styles.questRoom} numberOfLines={1}>{quest.room_label}</Text>

        {/* Enemy */}
        <Text style={completed ? styles.questEmojiDone : styles.questEmoji}>
          {completed ? "🏆" : quest.enemy_emoji}
        </Text>
        <Text
          style={completed ? styles.questNameDone : styles.questName}
          numberOfLines={2}
        >
          {quest.name}
        </Text>

        {/* Component count pill */}
        <View style={[styles.componentPill, completed && styles.componentPillDone]}>
          <Text style={[styles.componentPillText, completed && styles.componentPillTextDone]}>
            {completed ? "Cleared" : `${componentCount} component${componentCount !== 1 ? "s" : ""}`}
          </Text>
        </View>
      </Animated.View>
    </TouchableOpacity>
  );
}

// ─── Character card ───────────────────────────────────────────────────────────

function CharacterCard({ onParentTap }: { onParentTap: () => void }) {
  const child         = useGameStore((s) => s.activeChild);
  const levelProgress = useGameStore(selectLevelProgress);
  const wordCount     = useGameStore((s) => s.wordTomeCache.length);

  if (!child) return null;

  const avatar = AVATAR_EMOJIS[child.avatar_key ?? "default"] ?? "✦";
  const progressWidth = `${Math.round(levelProgress * 100)}%`;

  return (
    <View style={styles.characterCard}>
      <View style={styles.characterLeft}>
        <View style={styles.avatarCircle}>
          <Text style={styles.avatarEmoji}>{avatar}</Text>
        </View>
        <View>
          <Text style={styles.characterName}>{child.display_name}</Text>
          <Text style={styles.characterLevel}>Level {child.level}</Text>
        </View>
      </View>

      <View style={styles.characterRight}>
        {/* XP bar */}
        <View style={styles.xpBarTrack}>
          <View style={[styles.xpBarFill, { width: progressWidth as any }]} />
        </View>
        <Text style={styles.xpText}>{child.total_xp.toLocaleString()} XP</Text>

        {/* Word count */}
        <Text style={styles.wordCountText}>
          {wordCount} word{wordCount !== 1 ? "s" : ""} mastered
        </Text>
      </View>

      <TouchableOpacity
        style={styles.parentBtn}
        onPress={onParentTap}
        accessibilityRole="button"
        accessibilityLabel="Open parent dashboard"
      >
        <Text style={styles.parentBtnText}>📖</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export function QuestMapScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();

  const questLibrary     = useGameStore((s) => s.questLibrary);
  const isLoadingQuests  = useGameStore((s) => s.isLoadingQuests);
  const questError       = useGameStore((s) => s.questError);
  const activeChild      = useGameStore((s) => s.activeChild);
  const loadQuests       = useGameStore((s) => s.loadQuests);
  const setWordTomeCache = useGameStore((s) => s.setWordTomeCache);

  // ── Load quests + word tome on mount ──────────────────────
  useEffect(() => {
    loadQuests();
    syncWordTome();
  }, []);

  const syncWordTome = useCallback(async () => {
    if (!activeChild) return;
    const { data } = await supabase
      .from("word_tome")
      .select("word, definition, exemplar_object, times_used, first_used_at")
      .eq("child_id", activeChild.id)
      .order("first_used_at", { ascending: false });
    if (data) setWordTomeCache(data);
  }, [activeChild, setWordTomeCache]);

  // ── Which quests has this child completed? ────────────────
  const [completedIds, setCompletedIds] = React.useState<Set<string>>(new Set());

  useEffect(() => {
    if (!activeChild) return;
    supabase
      .from("quest_completions")
      .select("quest_id")
      .eq("child_id", activeChild.id)
      .then(({ data }) => {
        if (data) setCompletedIds(new Set(data.map((r: { quest_id: string }) => r.quest_id)));
      });
  }, [activeChild]);

  // ── Section: available vs completed ──────────────────────
  const available = questLibrary.filter((q) => !completedIds.has(q.id));
  const completed = questLibrary.filter((q) => completedIds.has(q.id));

  // ── Render ───────────────────────────────────────────────
  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Dungeon Map</Text>
        <Text style={styles.headerSub}>Choose your next quest</Text>
      </View>

      {/* Character card */}
      <CharacterCard onParentTap={() => navigation.navigate("Parent")} />

      {/* Quest grid */}
      {isLoadingQuests ? (
        <View style={styles.loadingCenter}>
          <ActivityIndicator color={P.gold} size="large" />
          <Text style={styles.loadingText}>Scouting the dungeon…</Text>
        </View>
      ) : questError ? (
        <View style={styles.loadingCenter}>
          <Text style={styles.errorText}>Could not load quests</Text>
          <TouchableOpacity onPress={loadQuests} style={styles.retryBtn}>
            <Text style={styles.retryBtnText}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            { paddingBottom: insets.bottom + 24 },
          ]}
          showsVerticalScrollIndicator={false}
        >
          {/* Available quests */}
          {available.length > 0 && (
            <>
              <SectionHeader title="Available" count={available.length} />
              <View style={styles.grid}>
                {available.map((q) => (
                  <QuestCard
                    key={q.id}
                    quest={q}
                    completed={false}
                    onPress={() => navigation.navigate("Scan", { questId: q.id })}
                  />
                ))}
              </View>
            </>
          )}

          {/* No quests at all */}
          {available.length === 0 && completed.length === 0 && (
            <View style={styles.loadingCenter}>
              <Text style={styles.emptyEmoji}>🗺️</Text>
              <Text style={styles.emptyTitle}>No quests yet</Text>
              <Text style={styles.emptyDesc}>
                Ask a parent to add quests from the dashboard.
              </Text>
            </View>
          )}

          {/* All done */}
          {available.length === 0 && completed.length > 0 && (
            <View style={styles.allDoneCard}>
              <Text style={styles.allDoneEmoji}>🏰</Text>
              <Text style={styles.allDoneTitle}>All dungeons cleared!</Text>
              <Text style={styles.allDoneSub}>
                You've defeated every monster. Check back soon for new quests.
              </Text>
            </View>
          )}

          {/* Completed quests */}
          {completed.length > 0 && (
            <>
              <SectionHeader title="Cleared" count={completed.length} muted />
              <View style={styles.grid}>
                {completed.map((q) => (
                  <QuestCard
                    key={q.id}
                    quest={q}
                    completed
                    onPress={() => {}}
                  />
                ))}
              </View>
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}

// ─── Section header ───────────────────────────────────────────────────────────

function SectionHeader({
  title,
  count,
  muted = false,
}: {
  title: string;
  count: number;
  muted?: boolean;
}) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={[styles.sectionTitle, muted && styles.sectionTitleMuted]}>
        {title}
      </Text>
      <View style={[styles.sectionBadge, muted && styles.sectionBadgeMuted]}>
        <Text style={[styles.sectionBadgeText, muted && styles.sectionBadgeTextMuted]}>
          {count}
        </Text>
      </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: P.deepPurple },

  // Header
  header: { paddingHorizontal: 20, paddingBottom: 4, paddingTop: 8 },
  headerTitle: { fontSize: 26, fontWeight: "800", color: P.textPrimary, letterSpacing: -0.5 },
  headerSub:   { fontSize: 13, color: P.textDim, marginTop: 2 },

  // Character card
  characterCard: {
    flexDirection:    "row",
    alignItems:       "center",
    marginHorizontal: 12,
    marginVertical:   12,
    backgroundColor:  P.cardBg,
    borderRadius:     16,
    borderWidth:      0.5,
    borderColor:      P.cardBorder,
    padding:          14,
    gap:              12,
  },
  characterLeft:  { flexDirection: "row", alignItems: "center", gap: 10 },
  avatarCircle:   {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: "rgba(124,58,237,0.2)",
    borderWidth: 1, borderColor: "rgba(124,58,237,0.4)",
    alignItems: "center", justifyContent: "center",
  },
  avatarEmoji:    { fontSize: 22 },
  characterName:  { fontSize: 15, fontWeight: "700", color: P.textPrimary },
  characterLevel: { fontSize: 12, color: P.textMuted, marginTop: 1 },
  characterRight: { flex: 1 },
  xpBarTrack:     { height: 5, backgroundColor: P.xpTrack, borderRadius: 3, overflow: "hidden", marginBottom: 4 },
  xpBarFill:      { height: 5, backgroundColor: P.xpFill, borderRadius: 3 },
  xpText:         { fontSize: 11, color: P.textDim },
  wordCountText:  { fontSize: 11, color: P.textDim, marginTop: 2 },
  parentBtn:      {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.06)",
    alignItems: "center", justifyContent: "center",
    borderWidth: 0.5, borderColor: P.cardBorder,
  },
  parentBtnText: { fontSize: 18 },

  // Scroll
  scrollContent: { paddingHorizontal: 12 },

  // Section header
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10, marginTop: 8 },
  sectionTitle:  { fontSize: 13, fontWeight: "700", color: P.textMuted, textTransform: "uppercase", letterSpacing: 0.8 },
  sectionTitleMuted: { color: P.textDim },
  sectionBadge:  { backgroundColor: "rgba(124,58,237,0.25)", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  sectionBadgeMuted: { backgroundColor: "rgba(255,255,255,0.05)" },
  sectionBadgeText: { fontSize: 11, fontWeight: "700", color: P.textMuted },
  sectionBadgeTextMuted: { color: P.textDim },

  // Grid
  grid: {
    flexDirection:  "row",
    flexWrap:       "wrap",
    gap:            12,
    marginBottom:   8,
  },

  // Quest card
  questCard: {
    width:           CARD_W,
    borderRadius:    16,
    padding:         14,
    borderWidth:     0.5,
    minHeight:       160,
    overflow:        "hidden",
    position:        "relative",
    justifyContent:  "flex-end",
  },
  questCardActive: { backgroundColor: P.cardBg, borderColor: P.cardBorder },
  questCardDone:   { backgroundColor: P.completedBg, borderColor: P.completedBorder },

  // Pulse ring (positioned behind content)
  pulseRing: {
    position:     "absolute",
    top:          -20,
    right:        -20,
    width:        80,
    height:       80,
    borderRadius: 40,
    borderWidth:  1.5,
    borderColor:  P.activePulse,
  },

  questRoom: { fontSize: 10, color: P.textDim, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 },
  questEmoji:     { fontSize: 36, marginBottom: 6 },
  questEmojiDone: { fontSize: 28, marginBottom: 6, opacity: 0.5 },
  questName:     { fontSize: 14, fontWeight: "700", color: P.textPrimary, lineHeight: 19, marginBottom: 10 },
  questNameDone: { fontSize: 14, fontWeight: "600", color: P.textDim,     lineHeight: 19, marginBottom: 10 },

  componentPill: {
    alignSelf:        "flex-start",
    backgroundColor:  "rgba(124,58,237,0.2)",
    borderRadius:     20,
    paddingHorizontal: 8,
    paddingVertical:  3,
    borderWidth:      0.5,
    borderColor:      "rgba(124,58,237,0.4)",
  },
  componentPillDone: { backgroundColor: "rgba(255,255,255,0.04)", borderColor: "rgba(255,255,255,0.08)" },
  componentPillText:     { fontSize: 11, fontWeight: "600", color: P.textMuted },
  componentPillTextDone: { color: P.textDim },

  // Loading / empty
  loadingCenter: { alignItems: "center", justifyContent: "center", paddingVertical: 60, gap: 12 },
  loadingText:   { fontSize: 14, color: P.textDim },
  errorText:     { fontSize: 15, fontWeight: "600", color: P.textMuted },
  retryBtn: {
    borderWidth: 0.5, borderColor: P.cardBorder,
    borderRadius: 10, paddingHorizontal: 20, paddingVertical: 10,
  },
  retryBtnText: { fontSize: 14, color: P.textMuted },

  emptyEmoji: { fontSize: 48 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: P.textMuted },
  emptyDesc:  { fontSize: 14, color: P.textDim, textAlign: "center", lineHeight: 20 },

  // All done
  allDoneCard: {
    alignItems:      "center",
    backgroundColor: P.cardBg,
    borderRadius:    20,
    borderWidth:     0.5,
    borderColor:     P.cardBorder,
    padding:         32,
    marginBottom:    16,
    gap:             8,
  },
  allDoneEmoji: { fontSize: 56 },
  allDoneTitle: { fontSize: 20, fontWeight: "800", color: P.gold },
  allDoneSub:   { fontSize: 14, color: P.textDim, textAlign: "center", lineHeight: 20 },
});
