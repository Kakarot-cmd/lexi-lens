/**
 * ParentDashboard.tsx
 * Lexi-Lens — parent-facing screen.
 *
 * Deliberately different aesthetic from the child's dark dungeon UI:
 * warm cream/amber tones, illuminated-manuscript feel, no gamification pressure.
 * Parents see what their child is actually learning, not just XP numbers.
 *
 * Sections:
 *   1. Child selector (if multiple children under the account)
 *   2. Stats row — level, words mastered, quests completed, streak
 *   3. Word Tome — searchable list of every vocabulary word the child has used
 *   4. Recent activity — last 5 scan attempts with outcomes
 *
 * Dependencies:
 *   npx expo install @supabase/supabase-js
 *   npx expo install expo-haptics
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  FlatList,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { supabase } from "../lib/supabase";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChildProfile {
  id:           string;
  display_name: string;
  age_band:     string;
  level:        number;
  total_xp:     number;
  avatar_key:   string | null;
}

interface WordTomeEntry {
  id:              string;
  word:            string;
  definition:      string;
  exemplar_object: string;
  times_used:      number;
  first_used_at:   string;
  last_used_at:    string;
}

interface QuestCompletion {
  id:           string;
  quest_id:     string;
  total_xp:     number;
  attempt_count: number;
  completed_at: string;
  quests: { name: string; enemy_emoji: string };
}

interface DashboardData {
  child:            ChildProfile;
  wordTome:         WordTomeEntry[];
  questCompletions: QuestCompletion[];
  questsCompleted:  number;
}

// ─── Palette ──────────────────────────────────────────────────────────────────

const P = {
  cream:      "#fdf8f0",
  parchment:  "#f5edda",
  warmBorder: "#e8d5b0",
  inkBrown:   "#3d2a0f",
  inkMid:     "#6b4c1e",
  inkLight:   "#9c7540",
  inkFaint:   "#c4a97a",
  amberAccent:"#d97706",
  amberLight: "#fef3c7",
  amberBorder:"#fde68a",
  greenBadge: "#166534",
  greenBg:    "#f0fdf4",
  greenBorder:"#86efac",
  purpleAccent:"#7c3aed",
  purpleLight: "#f5f3ff",
  purpleBorder:"#ddd6fe",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function xpToNextLevel(currentXp: number, level: number): number {
  const nextThreshold = Math.pow(level, 2) * 50;
  return Math.max(0, nextThreshold - currentXp);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function ageLabel(band: string): string {
  return `Age ${band}`;
}

// ─── Avatar ───────────────────────────────────────────────────────────────────

const AVATAR_EMOJIS: Record<string, string> = {
  wizard:  "🧙",
  knight:  "⚔️",
  archer:  "🏹",
  dragon:  "🐉",
  default: "✦",
};

function Avatar({ avatarKey, size = 44 }: { avatarKey: string | null; size?: number }) {
  const emoji = AVATAR_EMOJIS[avatarKey ?? "default"] ?? "✦";
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={{ fontSize: size * 0.5 }}>{emoji}</Text>
    </View>
  );
}

// ─── Child tab ────────────────────────────────────────────────────────────────

function ChildTab({
  child,
  selected,
  onPress,
}: {
  child: ChildProfile;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.childTab, selected && styles.childTabSelected]}
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
    >
      <Avatar avatarKey={child.avatar_key} size={28} />
      <Text style={[styles.childTabName, selected && styles.childTabNameSelected]}>
        {child.display_name}
      </Text>
    </TouchableOpacity>
  );
}

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({ value, label, accent = false }: { value: string | number; label: string; accent?: boolean }) {
  return (
    <View style={[styles.statCard, accent && styles.statCardAccent]}>
      <Text style={[styles.statValue, accent && styles.statValueAccent]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// ─── Word Tome entry ──────────────────────────────────────────────────────────

function WordEntry({ entry }: { entry: WordTomeEntry }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <TouchableOpacity
      style={styles.wordEntry}
      onPress={() => {
        setExpanded((e) => !e);
        Haptics.selectionAsync();
      }}
      accessibilityRole="button"
      accessibilityLabel={`${entry.word}: ${entry.definition}`}
      accessibilityHint="Tap to expand or collapse"
    >
      <View style={styles.wordEntryHeader}>
        <View style={styles.wordEntryLeft}>
          <Text style={styles.wordText}>{entry.word}</Text>
          <Text style={styles.exemplarText} numberOfLines={1}>
            via {entry.exemplar_object}
          </Text>
        </View>
        <View style={styles.wordEntryRight}>
          {entry.times_used > 1 && (
            <View style={styles.timesUsedBadge}>
              <Text style={styles.timesUsedText}>×{entry.times_used}</Text>
            </View>
          )}
          <Text style={styles.wordDate}>{formatDate(entry.first_used_at)}</Text>
          <Text style={styles.chevron}>{expanded ? "▲" : "▼"}</Text>
        </View>
      </View>

      {expanded && (
        <View style={styles.wordDefinition}>
          <Text style={styles.wordDefinitionText}>{entry.definition}</Text>
          <Text style={styles.wordDefinitionMeta}>
            Last used {formatDate(entry.last_used_at)} · Found with: {entry.exemplar_object}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

// ─── Quest completion card ────────────────────────────────────────────────────

function QuestCard({ completion }: { completion: QuestCompletion }) {
  const efficiency = completion.attempt_count === 1 ? "First try!" : `${completion.attempt_count} attempts`;
  return (
    <View style={styles.questCard}>
      <Text style={styles.questEmoji}>{completion.quests?.enemy_emoji ?? "⚔️"}</Text>
      <View style={{ flex: 1 }}>
        <Text style={styles.questName}>{completion.quests?.name ?? "Quest"}</Text>
        <Text style={styles.questMeta}>{efficiency} · {formatDate(completion.completed_at)}</Text>
      </View>
      <Text style={styles.questXp}>+{completion.total_xp} XP</Text>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export function ParentDashboard() {
  const insets = useSafeAreaInsets();

  const [children, setChildren]         = useState<ChildProfile[]>([]);
  const [selectedId, setSelectedId]     = useState<string | null>(null);
  const [dashboard, setDashboard]       = useState<DashboardData | null>(null);
  const [loading, setLoading]           = useState(true);
  const [refreshing, setRefreshing]     = useState(false);
  const [search, setSearch]             = useState("");
  const [error, setError]               = useState<string | null>(null);

  const selectedChild = dashboard?.child ?? null;

  // ── Fetch children list ─────────────────────────────────────
  useEffect(() => {
    async function fetchChildren() {
      const { data, error } = await supabase
        .from("child_profiles")
        .select("id, display_name, age_band, level, total_xp, avatar_key")
        .order("created_at");

      if (error) { setError(error.message); return; }
      setChildren(data ?? []);
      if (data?.length) setSelectedId(data[0].id);
    }
    fetchChildren();
  }, []);

  // ── Fetch dashboard data for selected child ─────────────────
  const fetchDashboard = useCallback(async (childId: string) => {
    setLoading(true);
    setError(null);
    try {
      const [childRes, tomeRes, completionsRes] = await Promise.all([
        supabase
          .from("child_profiles")
          .select("id, display_name, age_band, level, total_xp, avatar_key")
          .eq("id", childId)
          .single(),
        supabase
          .from("word_tome")
          .select("*")
          .eq("child_id", childId)
          .order("first_used_at", { ascending: false }),
        supabase
          .from("quest_completions")
          .select("*, quests(name, enemy_emoji)")
          .eq("child_id", childId)
          .order("completed_at", { ascending: false })
          .limit(5),
      ]);

      if (childRes.error) throw childRes.error;

      setDashboard({
        child:            childRes.data,
        wordTome:         tomeRes.data ?? [],
        questCompletions: completionsRes.data ?? [],
        questsCompleted:  completionsRes.data?.length ?? 0,
      });
    } catch (err: any) {
      setError(err.message ?? "Failed to load dashboard");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) fetchDashboard(selectedId);
  }, [selectedId, fetchDashboard]);

  const onRefresh = () => {
    setRefreshing(true);
    if (selectedId) fetchDashboard(selectedId);
  };

  // ── Filter Word Tome by search ──────────────────────────────
  const filteredTome = (dashboard?.wordTome ?? []).filter(
    (w) =>
      search.trim() === "" ||
      w.word.toLowerCase().includes(search.toLowerCase()) ||
      w.exemplar_object.toLowerCase().includes(search.toLowerCase())
  );

  // ── Render ──────────────────────────────────────────────────
  if (error) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.errorText}>Could not load dashboard</Text>
        <Text style={styles.errorSub}>{error}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>

      {/* ── Header ─────────────────────────────────────────── */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Word Tome</Text>
          <Text style={styles.headerSub}>Parent view</Text>
        </View>
        {/* Child tabs (only shown if multiple children) */}
        {children.length > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.childTabs}>
            {children.map((c) => (
              <ChildTab
                key={c.id}
                child={c}
                selected={c.id === selectedId}
                onPress={() => { setSelectedId(c.id); Haptics.selectionAsync(); }}
              />
            ))}
          </ScrollView>
        )}
      </View>

      {loading && !refreshing ? (
        <View style={styles.center}>
          <ActivityIndicator color={P.amberAccent} />
        </View>
      ) : dashboard ? (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={P.amberAccent} />}
          showsVerticalScrollIndicator={false}
        >
          {/* ── Child profile ─────────────────────────────── */}
          <View style={styles.profileRow}>
            <Avatar avatarKey={selectedChild?.avatar_key ?? null} size={52} />
            <View style={{ flex: 1 }}>
              <Text style={styles.profileName}>{selectedChild?.display_name}</Text>
              <Text style={styles.profileMeta}>
                Level {selectedChild?.level} · {ageLabel(selectedChild?.age_band ?? "")}
              </Text>
              {/* XP progress bar */}
              <View style={styles.xpBarTrack}>
                <View
                  style={[
                    styles.xpBarFill,
                    { width: `${Math.min(100, ((selectedChild?.total_xp ?? 0) % 50) * 2)}%` },
                  ]}
                />
              </View>
              <Text style={styles.xpToNext}>
                {xpToNextLevel(selectedChild?.total_xp ?? 0, selectedChild?.level ?? 1)} XP to level {(selectedChild?.level ?? 1) + 1}
              </Text>
            </View>
          </View>

          {/* ── Stats row ─────────────────────────────────── */}
          <View style={styles.statsGrid}>
            <StatCard value={dashboard.wordTome.length} label="Words mastered" accent />
            <StatCard value={selectedChild?.level ?? 1}  label="Level" />
            <StatCard value={dashboard.questCompletions.length} label="Quests done" />
            <StatCard value={`${selectedChild?.total_xp ?? 0}`} label="Total XP" />
          </View>

          {/* ── Word Tome ─────────────────────────────────── */}
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Word Tome</Text>
              <View style={styles.wordCountBadge}>
                <Text style={styles.wordCountText}>{dashboard.wordTome.length}</Text>
              </View>
            </View>
            <Text style={styles.sectionDesc}>
              Every word {selectedChild?.display_name} has learned, with the real object they used to prove it.
            </Text>

            <TextInput
              style={styles.searchInput}
              placeholder="Search words or objects…"
              placeholderTextColor={P.inkFaint}
              value={search}
              onChangeText={setSearch}
              clearButtonMode="while-editing"
              accessibilityLabel="Search words in the Word Tome"
            />

            {filteredTome.length === 0 ? (
              <View style={styles.emptyTome}>
                <Text style={styles.emptyTomeText}>
                  {search ? "No words match that search." : "No words learned yet — start a quest!"}
                </Text>
              </View>
            ) : (
              filteredTome.map((entry) => (
                <WordEntry key={entry.id} entry={entry} />
              ))
            )}
          </View>

          {/* ── Recent quests ──────────────────────────────── */}
          {dashboard.questCompletions.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Recent quests</Text>
              {dashboard.questCompletions.map((c) => (
                <QuestCard key={c.id} completion={c} />
              ))}
            </View>
          )}
        </ScrollView>
      ) : null}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root:  { flex: 1, backgroundColor: P.cream },
  center:{ flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  scroll:{ flex: 1 },

  // Header
  header: {
    paddingHorizontal: 20,
    paddingBottom:     12,
    borderBottomWidth: 1,
    borderBottomColor: P.warmBorder,
    backgroundColor:   P.cream,
  },
  headerTitle: { fontSize: 22, fontWeight: "700", color: P.inkBrown, letterSpacing: -0.3 },
  headerSub:   { fontSize: 12, color: P.inkLight, marginTop: 1 },

  // Child tabs
  childTabs: { marginTop: 10 },
  childTab: {
    flexDirection:    "row",
    alignItems:       "center",
    gap:              6,
    paddingHorizontal: 12,
    paddingVertical:  7,
    borderRadius:     20,
    backgroundColor:  P.parchment,
    marginRight:      8,
    borderWidth:      1,
    borderColor:      P.warmBorder,
  },
  childTabSelected: { backgroundColor: P.amberLight, borderColor: P.amberBorder },
  childTabName:     { fontSize: 13, color: P.inkMid, fontWeight: "500" },
  childTabNameSelected: { color: P.amberAccent },

  // Avatar
  avatar: {
    backgroundColor:  P.parchment,
    borderWidth:      1,
    borderColor:      P.warmBorder,
    alignItems:       "center",
    justifyContent:   "center",
  },

  // Profile row
  profileRow: {
    flexDirection:    "row",
    alignItems:       "flex-start",
    gap:              14,
    margin:           20,
    marginBottom:     12,
  },
  profileName:   { fontSize: 18, fontWeight: "700", color: P.inkBrown },
  profileMeta:   { fontSize: 13, color: P.inkLight, marginBottom: 8 },
  xpBarTrack:    { height: 6, backgroundColor: P.warmBorder, borderRadius: 3, overflow: "hidden" },
  xpBarFill:     { height: 6, backgroundColor: P.amberAccent, borderRadius: 3 },
  xpToNext:      { fontSize: 11, color: P.inkFaint, marginTop: 4 },

  // Stats grid
  statsGrid: {
    flexDirection:     "row",
    flexWrap:          "wrap",
    gap:               10,
    paddingHorizontal: 20,
    marginBottom:      8,
  },
  statCard: {
    flex:              1,
    minWidth:          "44%",
    backgroundColor:   P.parchment,
    borderRadius:      12,
    padding:           14,
    borderWidth:       1,
    borderColor:       P.warmBorder,
    alignItems:        "center",
  },
  statCardAccent:     { backgroundColor: P.amberLight, borderColor: P.amberBorder },
  statValue:          { fontSize: 26, fontWeight: "700", color: P.inkBrown },
  statValueAccent:    { color: P.amberAccent },
  statLabel:          { fontSize: 12, color: P.inkLight, marginTop: 2 },

  // Section
  section: {
    marginHorizontal:  20,
    marginTop:         24,
  },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 },
  sectionTitle:  { fontSize: 16, fontWeight: "700", color: P.inkBrown },
  sectionDesc:   { fontSize: 13, color: P.inkLight, lineHeight: 19, marginBottom: 12 },
  wordCountBadge:{
    backgroundColor: P.amberLight, borderRadius: 10, paddingHorizontal: 8,
    paddingVertical: 2, borderWidth: 1, borderColor: P.amberBorder,
  },
  wordCountText: { fontSize: 12, fontWeight: "600", color: P.amberAccent },

  // Search
  searchInput: {
    backgroundColor:  P.parchment,
    borderRadius:     10,
    borderWidth:      1,
    borderColor:      P.warmBorder,
    paddingHorizontal: 14,
    paddingVertical:  10,
    fontSize:         14,
    color:            P.inkBrown,
    marginBottom:     10,
  },

  // Word entry
  wordEntry: {
    backgroundColor: "#fff",
    borderRadius:    12,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    marginBottom:    8,
    overflow:        "hidden",
  },
  wordEntryHeader: {
    flexDirection:    "row",
    alignItems:       "center",
    padding:          14,
  },
  wordEntryLeft:  { flex: 1 },
  wordText:       { fontSize: 16, fontWeight: "700", color: P.inkBrown },
  exemplarText:   { fontSize: 12, color: P.inkLight, marginTop: 2 },
  wordEntryRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  timesUsedBadge: {
    backgroundColor: P.purpleLight, borderRadius: 8, paddingHorizontal: 7,
    paddingVertical: 2, borderWidth: 1, borderColor: P.purpleBorder,
  },
  timesUsedText:  { fontSize: 11, color: P.purpleAccent, fontWeight: "600" },
  wordDate:       { fontSize: 11, color: P.inkFaint },
  chevron:        { fontSize: 10, color: P.inkFaint },
  wordDefinition: {
    borderTopWidth:   1,
    borderTopColor:   P.warmBorder,
    padding:          14,
    backgroundColor:  P.parchment,
  },
  wordDefinitionText: { fontSize: 14, color: P.inkMid, lineHeight: 21 },
  wordDefinitionMeta: { fontSize: 11, color: P.inkFaint, marginTop: 6 },

  // Empty state
  emptyTome: { alignItems: "center", paddingVertical: 32 },
  emptyTomeText: { fontSize: 14, color: P.inkFaint, textAlign: "center" },

  // Quest card
  questCard: {
    flexDirection:    "row",
    alignItems:       "center",
    gap:              12,
    backgroundColor:  "#fff",
    borderRadius:     12,
    borderWidth:      1,
    borderColor:      P.warmBorder,
    padding:          14,
    marginBottom:     8,
  },
  questEmoji: { fontSize: 24 },
  questName:  { fontSize: 14, fontWeight: "600", color: P.inkBrown },
  questMeta:  { fontSize: 12, color: P.inkLight, marginTop: 2 },
  questXp:    { fontSize: 13, fontWeight: "700", color: P.amberAccent },

  // Error
  errorText: { fontSize: 16, fontWeight: "600", color: P.inkBrown },
  errorSub:  { fontSize: 13, color: P.inkLight },
});
