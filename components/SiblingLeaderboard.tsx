/**
 * SiblingLeaderboard.tsx
 * ──────────────────────
 * N2 — Sibling Leaderboard component.
 *
 * Drop-in usage in ParentDashboard:
 *   <SiblingLeaderboard
 *     activeChildId={selectedChild?.id}
 *     refreshKey={refreshKey}           // bump on pull-to-refresh
 *     onAddSibling={navigateToChildSwitcher}
 *   />
 *
 * Features:
 *   • 3 metric tabs: XP · Words · Streak (re-sorts in place)
 *   • Rank medals: 👑 🥈 🥉 for positions 1–3
 *   • Reanimated 3 FadeInDown stagger per row (40 ms offset)
 *   • Active child highlighted + gap motivator line below card
 *   • Single-child graceful state with "Add a sibling" CTA
 *   • Skeleton shimmer while loading (matches parchment palette)
 *   • Zero new dependencies beyond react-native-reanimated (already in stack)
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Animated, {
  FadeInDown,
  FadeInUp,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import {
  fetchFamilyLeaderboard,
  gapLine,
  rankBy,
  type LeaderboardMetric,
  type SiblingEntry,
} from "../services/leaderboardService";

// ─── Palette (mirrors ParentDashboard P.*) ────────────────────────────────────

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
  purpleAccent: "#7c3aed",
  purpleLight:  "#f5f3ff",
  purpleBorder: "#ddd6fe",
  greenBg:      "#f0fdf4",
  greenBorder:  "#86efac",
  greenMid:     "#16a34a",
  shimmerLight: "#f0e4c4",
  shimmerDark:  "#e8d5b0",
};

// ─── Constants ────────────────────────────────────────────────────────────────

const AVATAR_EMOJIS: Record<string, string> = {
  wizard:  "🧙",
  knight:  "⚔️",
  archer:  "🏹",
  dragon:  "🐉",
  default: "✦",
};

const RANK_MEDALS = ["👑", "🥈", "🥉"];

const TABS: { key: LeaderboardMetric; label: string; unit: string }[] = [
  { key: "xp",     label: "XP",     unit: "XP"    },
  { key: "words",  label: "Words",  unit: "words" },
  { key: "streak", label: "Streak", unit: "🔥"    },
];

const STAGGER_MS = 55;

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  /** ID of the currently selected child — highlighted in the list. */
  activeChildId?:  string | null;
  /** Increment to trigger a re-fetch (parent's pull-to-refresh). */
  refreshKey?:     number;
  /** Called when the user taps "Add a sibling" in the empty state. */
  onAddSibling?:   () => void;
}

// ─── Shimmer skeleton ─────────────────────────────────────────────────────────

function SkeletonRow({ index }: { index: number }) {
  const opacity = useSharedValue(1);

  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.4, { duration: 700 }),
        withTiming(1,   { duration: 700 }),
      ),
      -1,
      false,
    );
  }, []);

  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      entering={FadeInDown.delay(index * STAGGER_MS).springify()}
      style={animStyle}
    >
      <View style={styles.skeletonRow}>
        <View style={styles.skeletonRank} />
        <View style={styles.skeletonAvatar} />
        <View style={{ flex: 1, gap: 6 }}>
          <View style={[styles.skeletonBar, { width: "55%" }]} />
          <View style={[styles.skeletonBar, { width: "35%", height: 8 }]} />
        </View>
        <View style={[styles.skeletonBar, { width: 40, height: 20 }]} />
      </View>
    </Animated.View>
  );
}

// ─── Metric pill ──────────────────────────────────────────────────────────────

function MetricValue({
  sibling,
  metric,
}: {
  sibling: SiblingEntry;
  metric:  LeaderboardMetric;
}) {
  const value =
    metric === "xp"     ? sibling.total_xp :
    metric === "words"  ? sibling.word_count :
                          sibling.streak;

  const suffix =
    metric === "xp"     ? " XP"    :
    metric === "words"  ? " words" :
                          "🔥";

  return (
    <Text style={styles.metricValue}>
      {value.toLocaleString()}
      <Text style={styles.metricSuffix}>{suffix}</Text>
    </Text>
  );
}

// ─── Single leaderboard row ───────────────────────────────────────────────────

function LeaderRow({
  sibling,
  rank,
  metric,
  isActive,
  index,
}: {
  sibling:  SiblingEntry;
  rank:     number;
  metric:   LeaderboardMetric;
  isActive: boolean;
  index:    number;
}) {
  const avatarEmoji =
    AVATAR_EMOJIS[sibling.avatar_key ?? "default"] ?? AVATAR_EMOJIS.default;

  const medal = rank <= 3 ? RANK_MEDALS[rank - 1] : String(rank);
  const isFirst = rank === 1;

  return (
    <Animated.View
      entering={FadeInDown.delay(index * STAGGER_MS).springify().damping(14)}
    >
      <View
        style={[
          styles.row,
          isFirst  && styles.rowFirst,
          isActive && styles.rowActive,
        ]}
      >
        {/* Rank medal */}
        <View style={styles.rankBox}>
          <Text style={[styles.rankText, isFirst && styles.rankTextFirst]}>
            {medal}
          </Text>
        </View>

        {/* Avatar bubble */}
        <View style={[styles.avatarBubble, isActive && styles.avatarBubbleActive]}>
          <Text style={styles.avatarEmoji}>{avatarEmoji}</Text>
        </View>

        {/* Name + level */}
        <View style={styles.nameBlock}>
          <Text
            style={[styles.nameText, isActive && styles.nameTextActive]}
            numberOfLines={1}
          >
            {sibling.display_name}
            {isActive ? " · you" : ""}
          </Text>
          <Text style={styles.levelText}>Level {sibling.level}</Text>
        </View>

        {/* Metric value */}
        <MetricValue sibling={sibling} metric={metric} />
      </View>
    </Animated.View>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function SiblingLeaderboard({
  activeChildId,
  refreshKey = 0,
  onAddSibling,
}: Props) {
  const [siblings, setSiblings] = useState<SiblingEntry[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);
  const [metric,   setMetric]   = useState<LeaderboardMetric>("xp");

  const fetchKey = useRef(0);

  const load = useCallback(async () => {
    const key = ++fetchKey.current;
    setLoading(true);
    setError(null);

    const { data, error: fetchError } = await fetchFamilyLeaderboard();

    if (fetchKey.current !== key) return; // stale response — ignore

    if (fetchError || !data) {
      setError(fetchError ?? "Could not load leaderboard");
      setLoading(false);
      return;
    }

    setSiblings(data.siblings);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  // ── Derived ───────────────────────────────────────────────────────────────

  const ranked = rankBy(siblings, metric);
  const activeEntry = ranked.find((s) => s.id === activeChildId) ?? null;
  const leader      = ranked[0]  ?? null;

  const gap = activeEntry && leader
    ? gapLine(activeEntry, leader, metric)
    : null;

  // ── Single-child empty state ───────────────────────────────────────────────

  if (!loading && siblings.length <= 1) {
    return (
      <Animated.View
        entering={FadeInUp.springify()}
        style={styles.section}
      >
        <View style={styles.header}>
          <Text style={styles.headerEmoji}>🏆</Text>
          <Text style={styles.headerTitle}>Family Leaderboard</Text>
        </View>

        <View style={styles.emptyState}>
          <Text style={styles.emptyEmoji}>👪</Text>
          <Text style={styles.emptyTitle}>
            {siblings.length === 0
              ? "No children yet"
              : "Add a sibling to compete!"}
          </Text>
          <Text style={styles.emptyDesc}>
            {siblings.length === 0
              ? "Add your first child to get started."
              : `Once a sibling joins, ${siblings[0]?.display_name ?? "your child"} will have someone to race for the top spot.`}
          </Text>
          {onAddSibling && (
            <TouchableOpacity
              style={styles.addBtn}
              onPress={onAddSibling}
              accessibilityRole="button"
              accessibilityLabel="Add a sibling"
            >
              <Text style={styles.addBtnText}>＋  Add a sibling</Text>
            </TouchableOpacity>
          )}
        </View>
      </Animated.View>
    );
  }

  // ── Loading skeleton ───────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={styles.section}>
        <View style={styles.header}>
          <Text style={styles.headerEmoji}>🏆</Text>
          <Text style={styles.headerTitle}>Family Leaderboard</Text>
        </View>
        <View style={styles.skeletonContainer}>
          {[0, 1, 2].map((i) => <SkeletonRow key={i} index={i} />)}
        </View>
      </View>
    );
  }

  // ── Error state ────────────────────────────────────────────────────────────

  if (error) {
    return (
      <View style={styles.section}>
        <View style={styles.header}>
          <Text style={styles.headerEmoji}>🏆</Text>
          <Text style={styles.headerTitle}>Family Leaderboard</Text>
        </View>
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>⚠️  {error}</Text>
          <TouchableOpacity onPress={load} style={styles.retryBtn}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── Main render ────────────────────────────────────────────────────────────

  return (
    <View style={styles.section}>
      {/* Header */}
      <Animated.View entering={FadeInDown.springify()} style={styles.header}>
        <Text style={styles.headerEmoji}>🏆</Text>
        <Text style={styles.headerTitle}>Family Leaderboard</Text>
      </Animated.View>

      {/* Metric tabs */}
      <Animated.View entering={FadeInDown.delay(40).springify()} style={styles.tabs}>
        {TABS.map((tab) => {
          const active = metric === tab.key;
          return (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tab, active && styles.tabActive]}
              onPress={() => setMetric(tab.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.tabText, active && styles.tabTextActive]}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </Animated.View>

      {/* Rows */}
      <View style={styles.rows}>
        {ranked.map((sibling, index) => (
          <LeaderRow
            key={sibling.id}
            sibling={sibling}
            rank={index + 1}
            metric={metric}
            isActive={sibling.id === activeChildId}
            index={index}
          />
        ))}
      </View>

      {/* Gap motivator */}
      {gap && (
        <Animated.View
          entering={FadeInUp.delay(ranked.length * STAGGER_MS + 60).springify()}
          style={styles.gapBanner}
        >
          <Text style={styles.gapText}>⚡ {gap} — keep going!</Text>
        </Animated.View>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  section: {
    marginHorizontal: 20,
    marginTop:        24,
  },

  // Header
  header: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           8,
    marginBottom:  12,
  },
  headerEmoji: { fontSize: 18 },
  headerTitle: {
    fontSize:   16,
    fontWeight: "700",
    color:      P.inkBrown,
  },

  // Metric tabs
  tabs: {
    flexDirection:    "row",
    backgroundColor:  P.parchment,
    borderRadius:     12,
    borderWidth:      1,
    borderColor:      P.warmBorder,
    marginBottom:     14,
    padding:          3,
  },
  tab: {
    flex:            1,
    alignItems:      "center",
    paddingVertical: 8,
    borderRadius:    9,
  },
  tabActive: {
    backgroundColor: P.amberAccent,
  },
  tabText: {
    fontSize:   13,
    fontWeight: "600",
    color:      P.inkLight,
  },
  tabTextActive: {
    color: "#fff",
  },

  // Rows
  rows: {
    gap: 8,
  },
  row: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: P.parchment,
    borderRadius:    14,
    padding:         12,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    gap:             10,
  },
  rowFirst: {
    backgroundColor: P.amberLight,
    borderColor:     P.amberBorder,
    borderWidth:     1.5,
  },
  rowActive: {
    backgroundColor: P.purpleLight,
    borderColor:     P.purpleBorder,
    borderWidth:     1.5,
  },

  // Rank
  rankBox: {
    width:          30,
    alignItems:     "center",
    justifyContent: "center",
  },
  rankText: {
    fontSize:   18,
    lineHeight: 22,
  },
  rankTextFirst: {
    fontSize: 22,
  },

  // Avatar
  avatarBubble: {
    width:           42,
    height:          42,
    borderRadius:    21,
    backgroundColor: P.cream,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    alignItems:      "center",
    justifyContent:  "center",
  },
  avatarBubbleActive: {
    backgroundColor: P.purpleLight,
    borderColor:     P.purpleBorder,
  },
  avatarEmoji: { fontSize: 22 },

  // Name
  nameBlock: { flex: 1 },
  nameText: {
    fontSize:   14,
    fontWeight: "700",
    color:      P.inkBrown,
  },
  nameTextActive: {
    color: P.purpleAccent,
  },
  levelText: {
    fontSize:  11,
    color:     P.inkFaint,
    marginTop: 2,
  },

  // Metric value
  metricValue: {
    fontSize:   15,
    fontWeight: "800",
    color:      P.inkMid,
    textAlign:  "right",
  },
  metricSuffix: {
    fontSize:   11,
    fontWeight: "500",
    color:      P.inkFaint,
  },

  // Gap motivator banner
  gapBanner: {
    marginTop:       10,
    backgroundColor: P.greenBg,
    borderRadius:    10,
    borderWidth:     1,
    borderColor:     P.greenBorder,
    paddingVertical: 8,
    paddingHorizontal: 14,
    alignItems:      "center",
  },
  gapText: {
    fontSize:   13,
    fontWeight: "600",
    color:      P.greenMid,
  },

  // Skeleton
  skeletonContainer: { gap: 8 },
  skeletonRow: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: P.parchment,
    borderRadius:    14,
    padding:         12,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    gap:             10,
  },
  skeletonRank: {
    width:        30,
    height:       22,
    borderRadius: 6,
    backgroundColor: P.shimmerLight,
  },
  skeletonAvatar: {
    width:           42,
    height:          42,
    borderRadius:    21,
    backgroundColor: P.shimmerLight,
  },
  skeletonBar: {
    height:          13,
    borderRadius:    6,
    backgroundColor: P.shimmerLight,
  },

  // Empty state
  emptyState: {
    alignItems:        "center",
    paddingVertical:   32,
    backgroundColor:   P.parchment,
    borderRadius:      16,
    borderWidth:       1,
    borderColor:       P.warmBorder,
    paddingHorizontal: 24,
  },
  emptyEmoji: { fontSize: 44, marginBottom: 10 },
  emptyTitle: {
    fontSize:     16,
    fontWeight:   "700",
    color:        P.inkBrown,
    marginBottom: 8,
  },
  emptyDesc: {
    fontSize:   13,
    color:      P.inkLight,
    textAlign:  "center",
    lineHeight: 19,
    marginBottom: 20,
  },
  addBtn: {
    backgroundColor: P.amberAccent,
    borderRadius:    12,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  addBtnText: {
    fontSize:   14,
    fontWeight: "700",
    color:      "#fff",
  },

  // Error
  errorBox: {
    backgroundColor: "#fff1f2",
    borderRadius:    12,
    borderWidth:     1,
    borderColor:     "#fecdd3",
    padding:         16,
    alignItems:      "center",
    gap:             12,
  },
  errorText: { fontSize: 13, color: "#9f1239" },
  retryBtn: {
    backgroundColor: "#9f1239",
    borderRadius:    8,
    paddingVertical: 8,
    paddingHorizontal: 20,
  },
  retryText: { fontSize: 13, fontWeight: "700", color: "#fff" },
});
