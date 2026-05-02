/**
 * ParentDashboard.tsx
 * Lexi-Lens — parent-facing screen.
 *
 * N4 additions:
 *   • AchievementBadgeGrid mounted after MasteryRadarPanel
 *
 * N2 fix (TS2322 + TS2304):
 *   • handleAccountDeleted — removed navigation.reset({ name: "Auth" }).
 *     App.tsx onAuthStateChange handles routing when session clears.
 *   • sessionRefreshKey — fixed typo (was `refreshKey`) in SiblingLeaderboard prop.
 *
 * v2.4 — Phase 4.1 COPPA + GDPR-K compliance
 * v2.3 — Daily quest + 7-day streak
 * N5 — Recent Sessions panel
 * N3 — Mastery Radar chart
 * N2 — Sibling Leaderboard
 * 2.6 — Word Tome PDF export
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
  Switch,
  Modal,
} from "react-native";
import { useSafeAreaInsets }  from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { supabase }                from "../lib/supabase";
import { StreakHeatmap }           from "../components/StreakHeatmap";
import QuestGeneratorScreen        from "./QuestGeneratorScreen";
import { DataDeletionScreen }      from "../components/DataDeletionScreen";
import { PrivacyPolicyScreen }     from "../components/PrivacyPolicyScreen";
import { RecentSessionsPanel }     from "../components/RecentSessionsPanel";
import { MasteryRadarPanel }       from "../components/MasteryRadarPanel";
import { usePdfExport }            from "../hooks/usePdfExport";
import SiblingLeaderboard          from "../components/SiblingLeaderboard";
// N4 — Achievement badge grid
import { AchievementBadgeGrid }    from "../components/AchievementBadgeGrid";

import type { RootStackParamList } from "../types/navigation";
type Props = NativeStackScreenProps<RootStackParamList, "ParentDashboard">;

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
  id:            string;
  quest_id:      string;
  total_xp:      number;
  attempt_count: number;
  completed_at:  string;
  quests: { name: string; enemy_emoji: string };
}

interface StreakInfo {
  currentStreak: number;
  longestStreak: number;
}

interface DashboardData {
  child:            ChildProfile;
  wordTome:         WordTomeEntry[];
  questCompletions: QuestCompletion[];
  questsCompleted:  number;
}

// ─── Palette ──────────────────────────────────────────────────────────────────

const P = {
  cream:        "#fdf8f0",
  parchment:    "#f5edda",
  warmBorder:   "#e8d5b0",
  inkBrown:     "#3d2a0f",
  inkMid:       "#6b4c1e",
  inkLight:     "#9c7540",
  inkFaint:     "#c4a97a",
  amberAccent:  "#d97706",
  amberLight:   "#fef3c7",
  amberBorder:  "#fde68a",
  greenBadge:   "#166534",
  greenBg:      "#f0fdf4",
  greenBorder:  "#86efac",
  purpleAccent: "#7c3aed",
  purpleLight:  "#f5f3ff",
  purpleBorder: "#ddd6fe",
  fire:         "#f97316",
  fireBg:       "#fff7ed",
  fireBorder:   "#fed7aa",
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

// ─── StatCard ─────────────────────────────────────────────────────────────────

function StatCard({
  value,
  label,
  accent = false,
  fire   = false,
  badge,
}: {
  value:   string | number;
  label:   string;
  accent?: boolean;
  fire?:   boolean;
  badge?:  string;
}) {
  return (
    <View style={[
      styles.statCard,
      accent && styles.statCardAccent,
      fire   && styles.statCardFire,
    ]}>
      {badge && (
        <View style={styles.statBadge}>
          <Text style={styles.statBadgeText}>{badge}</Text>
        </View>
      )}
      <Text style={[
        styles.statValue,
        accent && styles.statValueAccent,
        fire   && styles.statValueFire,
      ]}>
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// ─── WordEntry ────────────────────────────────────────────────────────────────

function WordEntry({ entry }: { entry: WordTomeEntry }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <TouchableOpacity
      style={styles.wordEntry}
      onPress={() => setExpanded((e) => !e)}
      activeOpacity={0.8}
    >
      <View style={styles.wordEntryHeader}>
        <Text style={styles.wordText}>{entry.word}</Text>
        <View style={styles.wordMeta}>
          <Text style={styles.wordUsed}>×{entry.times_used}</Text>
          <Text style={styles.wordChevron}>{expanded ? "▲" : "▼"}</Text>
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

// ─── QuestCard ────────────────────────────────────────────────────────────────

function QuestCard({ completion }: { completion: QuestCompletion }) {
  const efficiency = completion.attempt_count === 1
    ? "First try!"
    : `${completion.attempt_count} attempts`;
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

export function ParentDashboard({ navigation }: Props) {
  const insets = useSafeAreaInsets();

  const [children,     setChildren]     = useState<ChildProfile[]>([]);
  const [selectedId,   setSelectedId]   = useState<string | null>(null);
  const [dashboard,    setDashboard]    = useState<DashboardData | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [refreshing,   setRefreshing]   = useState(false);
  const [search,       setSearch]       = useState("");
  const [error,        setError]        = useState<string | null>(null);

  const [streakInfo,          setStreakInfo]          = useState<StreakInfo>({ currentStreak: 0, longestStreak: 0 });
  const [notifEnabled,        setNotifEnabled]        = useState(false);
  const [showGenerator,       setShowGenerator]       = useState(false);
  const [showPrivacyPolicy,   setShowPrivacyPolicy]   = useState(false);
  const [showDeleteScreen,    setShowDeleteScreen]    = useState(false);
  const [deletionScheduledAt, setDeletionScheduledAt] = useState<string | null>(null);
  const [cancellingDeletion,  setCancellingDeletion]  = useState(false);
  // N5/N3 — bumped on pull-to-refresh so all panels reload in sync
  const [sessionRefreshKey,   setSessionRefreshKey]   = useState(0);

  const {
    exportPdf,
    isExporting,
    statusMessage,
    error:  exportError,
    status: exportStatus,
    reset:  resetExport,
  } = usePdfExport();

  const selectedChild = dashboard?.child ?? null;
  const has2xXp       = streakInfo.currentStreak >= 7;

  // ── Fetch children list ────────────────────────────────────────────────────

  useEffect(() => {
    async function fetchChildren() {
      const { data, error: e } = await supabase
        .from("child_profiles")
        .select("id, display_name, age_band, level, total_xp, avatar_key")
        .order("created_at");
      if (e) { setError(e.message); return; }
      setChildren(data ?? []);
      if (data?.length) setSelectedId(data[0].id);
    }

    async function checkDeletionStatus() {
      const { data: { user } } = await supabase.auth.getUser();
      const scheduled = user?.app_metadata?.deletion_scheduled_at ?? null;
      setDeletionScheduledAt(scheduled);
    }

    fetchChildren();
    checkDeletionStatus();
  }, []);

  // ── Fetch streak ───────────────────────────────────────────────────────────

  const fetchStreakData = useCallback(async (childId: string) => {
    const { data } = await supabase
      .from("child_streaks")
      .select("current_streak, longest_streak")
      .eq("child_id", childId)
      .maybeSingle();
    setStreakInfo(data
      ? { currentStreak: data.current_streak ?? 0, longestStreak: data.longest_streak ?? 0 }
      : { currentStreak: 0, longestStreak: 0 }
    );
  }, []);

  // ── Fetch full dashboard ───────────────────────────────────────────────────

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
    if (selectedId) {
      fetchDashboard(selectedId);
      fetchStreakData(selectedId);
    }
  }, [selectedId, fetchDashboard, fetchStreakData]);

  const onRefresh = () => {
    setRefreshing(true);
    setSessionRefreshKey((k) => k + 1);
    if (selectedId) {
      fetchDashboard(selectedId);
      fetchStreakData(selectedId);
    }
  };

  const filteredTome = (dashboard?.wordTome ?? []).filter(
    (w) =>
      search.trim() === "" ||
      w.word.toLowerCase().includes(search.toLowerCase()) ||
      w.exemplar_object.toLowerCase().includes(search.toLowerCase())
  );

  // ── Notification toggle ────────────────────────────────────────────────────

  const handleNotifToggle = async (val: boolean) => {
    setNotifEnabled(val);
    try {
      if (val) {
        const { scheduleDailyQuestReminder } = await import("../lib/notifications");
        await scheduleDailyQuestReminder(18, 0, selectedChild?.display_name ?? "");
      } else {
        const { cancelDailyReminder } = await import("../lib/notifications");
        await cancelDailyReminder();
      }
    } catch (e) {
      console.warn("[notifications] toggle failed:", e);
    }
  };

  // ── Account deleted handler ────────────────────────────────────────────────
  // N2 fix: removed navigation.reset({ routes: [{ name: "Auth" }] }) — "Auth"
  // is in AuthStackParamList, not RootStackParamList. App.tsx onAuthStateChange
  // switches to <AuthNavigator> automatically when the session clears.

  const handleAccountDeleted = useCallback(async () => {
    try {
      await supabase.auth.signOut();
      // App.tsx auth listener fires, session becomes null, <AuthNavigator> renders.
    } catch (e) {
      console.warn("[auth] signOut after deletion failed:", e);
    }
  }, []);

  // ── Cancel scheduled deletion ──────────────────────────────────────────────

  const handleCancelDeletion = useCallback(async () => {
    setCancellingDeletion(true);
    try {
      const { error: e } = await supabase.functions.invoke("cancel-deletion", {});
      if (e) throw e;
      setDeletionScheduledAt(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: any) {
      alert("Could not cancel deletion: " + (err?.message ?? "Unknown error"));
    } finally {
      setCancellingDeletion(false);
    }
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Text style={styles.backArrow}>‹</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Word Tome</Text>
          <TouchableOpacity
            style={styles.createQuestBtn}
            onPress={() => setShowGenerator(true)}
          >
            <Text style={styles.createQuestBtnText}>✦ AI Quest</Text>
          </TouchableOpacity>
        </View>
        {children.length > 1 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.childTabs}
            contentContainerStyle={{ paddingHorizontal: 0, gap: 8 }}
          >
            {children.map((c) => (
              <TouchableOpacity
                key={c.id}
                style={[styles.childTab, selectedId === c.id && styles.childTabSelected]}
                onPress={() => setSelectedId(c.id)}
              >
                <Text style={styles.childTabEmoji}>
                  {AVATAR_EMOJIS[c.avatar_key ?? "default"] ?? "✦"}
                </Text>
                <Text style={[styles.childTabName, selectedId === c.id && styles.childTabNameSelected]}>
                  {c.display_name}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </View>

      {/* Quest Generator modal */}
      <Modal
        visible={showGenerator}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowGenerator(false)}
      >
        <QuestGeneratorScreen
          visible={showGenerator}
          onClose={() => setShowGenerator(false)}
        />
      </Modal>

      {/* Privacy Policy modal */}
      <Modal
        visible={showPrivacyPolicy}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowPrivacyPolicy(false)}
      >
        <PrivacyPolicyScreen onClose={() => setShowPrivacyPolicy(false)} />
      </Modal>

      {/* Data Deletion modal */}
      <DataDeletionScreen
        visible={showDeleteScreen}
        onClose={() => setShowDeleteScreen(false)}
        onDeleted={handleAccountDeleted}
      />

      {loading && !refreshing ? (
        <View style={styles.center}>
          <ActivityIndicator color={P.amberAccent} />
        </View>
      ) : dashboard ? (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={P.amberAccent} />}
          showsVerticalScrollIndicator={false}
        >
          {/* ── Child profile ────────────────────────────── */}
          <View style={styles.profileRow}>
            <Avatar avatarKey={selectedChild?.avatar_key ?? null} size={52} />
            <View style={{ flex: 1 }}>
              <Text style={styles.profileName}>{selectedChild?.display_name}</Text>
              <Text style={styles.profileMeta}>
                Level {selectedChild?.level} · {ageLabel(selectedChild?.age_band ?? "")}
              </Text>
              <View style={styles.xpBarTrack}>
                <View
                  style={[
                    styles.xpBarFill,
                    { width: `${Math.min(100, ((selectedChild?.total_xp ?? 0) % 50) * 2)}%` as any },
                  ]}
                />
              </View>
              <Text style={styles.xpToNext}>
                {xpToNextLevel(selectedChild?.total_xp ?? 0, selectedChild?.level ?? 1)} XP to level {(selectedChild?.level ?? 1) + 1}
              </Text>
            </View>
          </View>

          {/* ── Stats grid ──────────────────────────────── */}
          <View style={styles.statsGrid}>
            <StatCard value={dashboard.wordTome.length} label="Words mastered" accent />
            <StatCard value={selectedChild?.level ?? 1} label="Level" />
            <StatCard value={dashboard.questCompletions.length} label="Quests done" />
            <StatCard
              value={`${streakInfo.currentStreak}🔥`}
              label="Day streak"
              fire={has2xXp}
              badge={has2xXp ? "2× XP" : undefined}
            />
          </View>

          {/* ── N2: Sibling Leaderboard ──────────────────── */}
          {selectedChild && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Family Leaderboard</Text>
              <SiblingLeaderboard
                activeChildId={selectedChild.id}
                refreshKey={sessionRefreshKey}
                onAddSibling={() => navigation.navigate("ChildSwitcher")}
              />
            </View>
          )}

          {/* ── N3: Vocabulary Mastery Radar ─────────────── */}
          {selectedChild && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Vocabulary Map</Text>
              <MasteryRadarPanel
                childId={selectedChild.id}
                childName={selectedChild.display_name}
                refreshKey={sessionRefreshKey}
              />
            </View>
          )}

          {/* ── N4: Achievement Badges ───────────────────── */}
          {selectedId && (
            <AchievementBadgeGrid childId={selectedId} />
          )}

          {/* ── Word Tome ────────────────────────────────── */}
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Word Tome</Text>
              <View style={styles.wordCountBadge}>
                <Text style={styles.wordCountText}>{dashboard.wordTome.length} words</Text>
              </View>
              {/* PDF export button */}
              <TouchableOpacity
                style={[styles.exportBtn, isExporting && styles.exportBtnLoading]}
                onPress={() => selectedChild && exportPdf(selectedChild.id, selectedChild.display_name)}
                disabled={isExporting}
                accessibilityLabel="Export Word Tome as PDF"
              >
                {isExporting
                  ? <ActivityIndicator size="small" color={P.amberAccent} />
                  : <Text style={styles.exportBtnText}>📄 Export</Text>
                }
              </TouchableOpacity>
            </View>

            {exportStatus === "done" && (
              <View style={[styles.exportStatus, styles.exportStatusDone]}>
                <Text style={[styles.exportStatusText, styles.exportStatusTextDone]}>
                  ✓ {statusMessage}
                </Text>
                <TouchableOpacity onPress={resetExport} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Text style={styles.exportStatusDismiss}>Dismiss</Text>
                </TouchableOpacity>
              </View>
            )}
            {exportStatus === "error" && exportError && (
              <View style={[styles.exportStatus, styles.exportStatusError]}>
                <Text style={[styles.exportStatusText, styles.exportStatusTextError]}>
                  ⚠ {exportError}
                </Text>
                <TouchableOpacity onPress={resetExport} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Text style={styles.exportStatusDismiss}>Retry</Text>
                </TouchableOpacity>
              </View>
            )}

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
              filteredTome.map((entry) => <WordEntry key={entry.id} entry={entry} />)
            )}
          </View>

          {/* ── Streak Heatmap ───────────────────────────── */}
          {selectedChild && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Quest Streak</Text>
              <StreakHeatmap
                childId={selectedChild.id}
                currentStreak={streakInfo.currentStreak}
                longestStreak={streakInfo.longestStreak}
              />
            </View>
          )}

          {/* ── N5: Recent Sessions ──────────────────────── */}
          {selectedChild && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Session History</Text>
              <RecentSessionsPanel
                childId={selectedChild.id}
                childName={selectedChild.display_name}
                refreshKey={sessionRefreshKey}
              />
            </View>
          )}

          {/* ── Recent quests ────────────────────────────── */}
          {dashboard.questCompletions.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Recent quests</Text>
              {dashboard.questCompletions.map((c) => (
                <QuestCard key={c.id} completion={c} />
              ))}
            </View>
          )}

          {/* ── Notification toggle ──────────────────────── */}
          <View style={[styles.section, styles.notifSection]}>
            <View style={styles.notifRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.notifLabel}>Daily Quest Reminder</Text>
                <Text style={styles.notifSub}>
                  Send {selectedChild?.display_name ?? "your child"} a nudge at 6:00 PM each day
                </Text>
              </View>
              <Switch
                value={notifEnabled}
                onValueChange={handleNotifToggle}
                trackColor={{ false: P.warmBorder, true: P.amberAccent }}
                thumbColor={notifEnabled ? P.inkBrown : P.parchment}
                ios_backgroundColor={P.warmBorder}
              />
            </View>
          </View>

          {/* ── Deletion-pending banner ──────────────────── */}
          {deletionScheduledAt && (
            <View style={styles.deletionBanner}>
              <View style={{ flex: 1 }}>
                <Text style={styles.deletionBannerTitle}>⏳ Account deletion pending</Text>
                <Text style={styles.deletionBannerSub}>
                  Scheduled for{" "}
                  {new Date(deletionScheduledAt).toLocaleDateString("en-US", {
                    month: "long", day: "numeric", year: "numeric",
                  })}.{" "}
                  All data will be permanently removed.
                </Text>
              </View>
              <TouchableOpacity
                style={[styles.cancelDeletionBtn, cancellingDeletion && { opacity: 0.6 }]}
                onPress={handleCancelDeletion}
                disabled={cancellingDeletion}
                accessibilityLabel="Cancel account deletion"
              >
                <Text style={styles.cancelDeletionBtnText}>
                  {cancellingDeletion ? "Cancelling…" : "Keep account"}
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* ── Account & Privacy ────────────────────────── */}
          <View style={[styles.section, { marginBottom: 8 }]}>
            <Text style={styles.sectionTitle}>Account & Privacy</Text>
            <TouchableOpacity
              style={styles.privacyRow}
              onPress={() => setShowPrivacyPolicy(true)}
            >
              <Text style={styles.privacyRowText}>Privacy Policy</Text>
              <Text style={styles.privacyRowChevron}>›</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.privacyRow, styles.deleteRow]}
              onPress={() => setShowDeleteScreen(true)}
            >
              <Text style={styles.deleteRowText}>Delete Account & Data</Text>
              <Text style={styles.privacyRowChevron}>›</Text>
            </TouchableOpacity>
            <Text style={styles.privacyNote}>
              🔒 Your child's scans are processed by AI to identify object labels only — images
              are never stored.
            </Text>
          </View>

        </ScrollView>
      ) : null}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root:   { flex: 1, backgroundColor: P.cream },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  scroll: { flex: 1 },

  header: {
    paddingHorizontal: 20,
    paddingBottom:     12,
    borderBottomWidth: 1,
    borderBottomColor: P.warmBorder,
    backgroundColor:   P.cream,
  },
  headerTop: {
    flexDirection:  "row",
    alignItems:     "center",
    justifyContent: "space-between",
    marginBottom:   4,
  },
  backArrow:   { fontSize: 22, color: P.amberAccent, fontWeight: "600" },
  headerTitle: { fontSize: 22, fontWeight: "700", color: P.inkBrown, letterSpacing: -0.3 },
  createQuestBtn: {
    backgroundColor:   P.purpleLight,
    borderRadius:      20,
    paddingHorizontal: 14,
    paddingVertical:   8,
    borderWidth:       1,
    borderColor:       P.purpleBorder,
  },
  createQuestBtnText: { color: P.purpleAccent, fontSize: 13, fontWeight: "700" },
  headerSub: { fontSize: 12, color: P.inkLight, marginTop: 1 },

  childTabs:    { marginTop: 10 },
  childTab: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               6,
    paddingHorizontal: 12,
    paddingVertical:   7,
    borderRadius:      20,
    backgroundColor:   P.parchment,
    marginRight:       8,
    borderWidth:       1,
    borderColor:       P.warmBorder,
  },
  childTabSelected:     { backgroundColor: P.amberLight, borderColor: P.amberBorder },
  childTabEmoji:        { fontSize: 14 },
  childTabName:         { fontSize: 13, color: P.inkMid, fontWeight: "500" },
  childTabNameSelected: { color: P.amberAccent },

  avatar: {
    backgroundColor: P.parchment,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    alignItems:      "center",
    justifyContent:  "center",
  },

  profileRow: {
    flexDirection: "row",
    alignItems:    "flex-start",
    gap:           14,
    margin:        20,
    marginBottom:  12,
  },
  profileName: { fontSize: 18, fontWeight: "700", color: P.inkBrown },
  profileMeta: { fontSize: 13, color: P.inkLight, marginBottom: 8 },
  xpBarTrack:  { height: 6, backgroundColor: P.warmBorder, borderRadius: 3, overflow: "hidden" },
  xpBarFill:   { height: 6, backgroundColor: P.amberAccent, borderRadius: 3 },
  xpToNext:    { fontSize: 11, color: P.inkFaint, marginTop: 4 },

  statsGrid: {
    flexDirection:     "row",
    flexWrap:          "wrap",
    gap:               10,
    paddingHorizontal: 20,
    marginBottom:      8,
  },
  statCard: {
    flex:            1,
    minWidth:        "44%",
    backgroundColor: P.parchment,
    borderRadius:    12,
    padding:         14,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    alignItems:      "center",
    position:        "relative",
  },
  statCardAccent: { backgroundColor: P.amberLight, borderColor: P.amberBorder },
  statCardFire:   { backgroundColor: P.fireBg, borderColor: P.fire, borderWidth: 1.5 },
  statValue:      { fontSize: 26, fontWeight: "700", color: P.inkBrown },
  statValueAccent:{ color: P.amberAccent },
  statValueFire:  { color: P.fire },
  statLabel:      { fontSize: 12, color: P.inkLight, marginTop: 2 },
  statBadge: {
    position:          "absolute",
    top:               -8,
    right:             -8,
    backgroundColor:   P.fire,
    borderRadius:      6,
    paddingHorizontal: 6,
    paddingVertical:   2,
  },
  statBadgeText: { color: "#fff", fontSize: 9, fontWeight: "800", letterSpacing: 0.4 },

  section: { marginHorizontal: 20, marginTop: 24 },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 },
  sectionTitle:  { fontSize: 16, fontWeight: "700", color: P.inkBrown },
  sectionDesc:   { fontSize: 13, color: P.inkLight, lineHeight: 19, marginBottom: 12 },

  wordCountBadge: {
    backgroundColor:   P.amberLight,
    borderRadius:      10,
    paddingHorizontal: 8,
    paddingVertical:   2,
    borderWidth:       1,
    borderColor:       P.amberBorder,
  },
  wordCountText: { fontSize: 12, fontWeight: "600", color: P.amberAccent },

  exportBtn: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               4,
    backgroundColor:   P.amberLight,
    borderRadius:      8,
    paddingHorizontal: 10,
    paddingVertical:   5,
    borderWidth:       1,
    borderColor:       P.amberBorder,
    marginLeft:        "auto",
    minWidth:          38,
    justifyContent:    "center",
  },
  exportBtnLoading: { opacity: 0.7 },
  exportBtnText:    { fontSize: 12, fontWeight: "600", color: P.amberAccent },
  exportStatus: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    backgroundColor:   P.amberLight,
    borderRadius:      8,
    borderWidth:       1,
    borderColor:       P.amberBorder,
    paddingHorizontal: 12,
    paddingVertical:   8,
    marginTop:         8,
    marginBottom:      4,
    gap:               8,
  },
  exportStatusDone:      { backgroundColor: "#f0fdf4", borderColor: "#86efac" },
  exportStatusError:     { backgroundColor: "#fff7ed", borderColor: "#fed7aa" },
  exportStatusText:      { fontSize: 12, color: P.amberAccent, flex: 1, flexShrink: 1 },
  exportStatusTextDone:  { color: "#166534" },
  exportStatusTextError: { color: "#c2410c" },
  exportStatusDismiss:   { fontSize: 11, color: P.inkLight, fontWeight: "600" },

  searchInput: {
    backgroundColor:   P.parchment,
    borderRadius:      10,
    borderWidth:       1,
    borderColor:       P.warmBorder,
    paddingHorizontal: 14,
    paddingVertical:   10,
    fontSize:          14,
    color:             P.inkBrown,
    marginBottom:      10,
  },

  wordEntry: {
    backgroundColor: "#fff",
    borderRadius:    12,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    marginBottom:    8,
    overflow:        "hidden",
  },
  wordEntryHeader: { flexDirection: "row", alignItems: "center", padding: 12 },
  wordText:        { flex: 1, fontSize: 15, fontWeight: "700", color: P.inkBrown },
  wordMeta:        { flexDirection: "row", alignItems: "center", gap: 8 },
  wordUsed:        { fontSize: 12, color: P.inkLight },
  wordChevron:     { fontSize: 12, color: P.inkFaint },
  wordDefinition:  { padding: 12, paddingTop: 0 },
  wordDefinitionText: { fontSize: 13, color: P.inkMid, lineHeight: 18, marginBottom: 4 },
  wordDefinitionMeta: { fontSize: 11, color: P.inkFaint, fontStyle: "italic" },

  emptyTome: { paddingVertical: 24, alignItems: "center" },
  emptyTomeText: { fontSize: 14, color: P.inkFaint, textAlign: "center" },

  questCard: {
    flexDirection:   "row",
    alignItems:      "center",
    gap:             12,
    backgroundColor: P.parchment,
    borderRadius:    12,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    padding:         12,
    marginBottom:    8,
  },
  questEmoji: { fontSize: 24 },
  questName:  { fontSize: 14, fontWeight: "600", color: P.inkBrown },
  questMeta:  { fontSize: 12, color: P.inkLight, marginTop: 2 },
  questXp:    { fontSize: 13, fontWeight: "700", color: P.amberAccent },

  notifSection: { backgroundColor: P.parchment, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: P.warmBorder },
  notifRow:     { flexDirection: "row", alignItems: "center", gap: 12 },
  notifLabel:   { fontSize: 15, fontWeight: "600", color: P.inkBrown },
  notifSub:     { fontSize: 12, color: P.inkLight, marginTop: 2, lineHeight: 17 },

  deletionBanner: {
    margin:          20,
    backgroundColor: "#fff7ed",
    borderRadius:    12,
    borderWidth:     1,
    borderColor:     "#fed7aa",
    padding:         16,
    flexDirection:   "row",
    alignItems:      "flex-start",
    gap:             12,
  },
  deletionBannerTitle: { fontSize: 14, fontWeight: "700", color: "#c2410c", marginBottom: 4 },
  deletionBannerSub:   { fontSize: 12, color: "#92400e", lineHeight: 17 },
  cancelDeletionBtn: {
    backgroundColor:   P.greenBg,
    borderRadius:      10,
    paddingHorizontal: 12,
    paddingVertical:   8,
    borderWidth:       1,
    borderColor:       P.greenBorder,
  },
  cancelDeletionBtnText: { fontSize: 12, color: P.greenBadge, fontWeight: "700" },

  privacyRow: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    backgroundColor:   P.parchment,
    borderRadius:      10,
    borderWidth:       1,
    borderColor:       P.warmBorder,
    paddingHorizontal: 16,
    paddingVertical:   14,
    marginBottom:      8,
  },
  privacyRowText:    { fontSize: 14, color: P.inkBrown },
  privacyRowChevron: { fontSize: 18, color: P.inkFaint },
  deleteRow:         { borderColor: "#fca5a5", backgroundColor: "#fff5f5" },
  deleteRowText:     { fontSize: 14, color: "#b91c1c", fontWeight: "600" },
  privacyNote: {
    fontSize:   11,
    color:      P.inkFaint,
    lineHeight: 16,
    marginTop:  8,
    textAlign:  "center",
  },
});
