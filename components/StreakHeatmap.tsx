/**
 * StreakHeatmap.tsx
 * Lexi-Lens — Phase 2.3
 *
 * A 7-column × N-row heatmap calendar showing which days the child
 * completed the daily quest over the last 28 days.
 * Warm manuscript palette to match ParentDashboard aesthetic.
 *
 * Used inside ParentDashboard.tsx:
 *   import { StreakHeatmap } from "../components/StreakHeatmap";
 *   <StreakHeatmap childId={selectedChild.id} />
 */

import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { supabase } from "../lib/supabase";

// ─── Palette (matches ParentDashboard's warm manuscript look) ─────────────────
const P = {
  cream:      "#fdf8f0",
  parchment:  "#f5edda",
  warmBorder: "#e8d5b0",
  inkBrown:   "#3d2a0f",
  inkMid:     "#6b4c1e",
  inkDim:     "#8b6835",
  amber:      "#d97706",
  amberLight: "#fde68a",
  fire:       "#f97316",
  empty:      "#ede9d6",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** ISO date string for a date offset by `daysBack` from today */
function isoOffset(daysBack: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  return d.toISOString().slice(0, 10);
}

/** Last 28 calendar dates, oldest first */
function last28Days(): string[] {
  return Array.from({ length: 28 }, (_, i) => isoOffset(27 - i));
}

/** "Mon", "Tue" … */
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  childId:       string;
  currentStreak?: number;
  longestStreak?: number;
}

export function StreakHeatmap({ childId, currentStreak = 0, longestStreak = 0 }: Props) {
  const [completedDates, setCompletedDates] = useState<Set<string>>(new Set());
  const [loading, setLoading]               = useState(true);

  useEffect(() => {
    loadStreakDates();
  }, [childId]);

  async function loadStreakDates() {
    setLoading(true);
    try {
      const { data } = await supabase
        .from("child_streaks")
        .select("streak_dates")
        .eq("child_id", childId)
        .maybeSingle();

      const dates: string[] = data?.streak_dates ?? [];
      setCompletedDates(new Set(dates));
    } catch {
      // Non-fatal — show empty heatmap
    } finally {
      setLoading(false);
    }
  }

  const days  = last28Days();
  // Offset so first row starts on Sunday
  const firstDow = new Date(days[0]).getDay();
  const padded   = [...Array(firstDow).fill(null), ...days];
  // Split into weeks
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < padded.length; i += 7) {
    weeks.push(padded.slice(i, i + 7));
  }

  const todayISO = isoOffset(0);

  if (loading) {
    return (
      <View style={styles.loadingBox}>
        <ActivityIndicator color={P.amber} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Quest Streak Calendar</Text>
        <View style={styles.statPills}>
          <View style={styles.pill}>
            <Text style={styles.pillIcon}>🔥</Text>
            <Text style={styles.pillText}>{currentStreak} day{currentStreak !== 1 ? "s" : ""}</Text>
          </View>
          <View style={[styles.pill, styles.pillBest]}>
            <Text style={styles.pillIcon}>🏆</Text>
            <Text style={styles.pillText}>Best: {longestStreak}</Text>
          </View>
          {currentStreak >= 7 && (
            <View style={[styles.pill, styles.pillFire]}>
              <Text style={styles.pillText}>2× XP active!</Text>
            </View>
          )}
        </View>
      </View>

      {/* Day-of-week labels */}
      <View style={styles.dowRow}>
        {DAY_LABELS.map((d) => (
          <Text key={d} style={styles.dowLabel}>{d}</Text>
        ))}
      </View>

      {/* Grid */}
      {weeks.map((week, wi) => (
        <View key={wi} style={styles.weekRow}>
          {week.map((dateStr, di) => {
            if (!dateStr) {
              return <View key={di} style={styles.dayCell} />;
            }
            const done    = completedDates.has(dateStr);
            const isToday = dateStr === todayISO;
            return (
              <View
                key={di}
                style={[
                  styles.dayCell,
                  done    && styles.dayCellDone,
                  isToday && styles.dayCellToday,
                ]}
              >
                <Text
                  style={[
                    styles.dayNum,
                    done    && styles.dayNumDone,
                    isToday && styles.dayNumToday,
                  ]}
                >
                  {new Date(dateStr + "T12:00:00").getDate()}
                </Text>
                {done && <Text style={styles.doneDot}>✦</Text>}
              </View>
            );
          })}
        </View>
      ))}

      {/* Legend */}
      <View style={styles.legend}>
        <View style={[styles.legendSwatch, styles.dayCellDone]} />
        <Text style={styles.legendText}>Quest completed</Text>
        <View style={[styles.legendSwatch, { borderWidth: 1, borderColor: P.amber }]} />
        <Text style={styles.legendText}>Today</Text>
      </View>

      {/* Encouragement */}
      {currentStreak === 0 && (
        <Text style={styles.nudge}>Complete today's Daily Quest to start a streak! 🌱</Text>
      )}
      {currentStreak >= 1 && currentStreak < 7 && (
        <Text style={styles.nudge}>
          {7 - currentStreak} more day{7 - currentStreak !== 1 ? "s" : ""} until 2× XP bonus!
        </Text>
      )}
      {currentStreak >= 7 && (
        <Text style={[styles.nudge, { color: P.fire }]}>
          🔥 2× XP multiplier is ACTIVE — keep it going!
        </Text>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const CELL_SIZE = 36;

const styles = StyleSheet.create({
  container: {
    backgroundColor: P.parchment,
    borderRadius:    12,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    padding:         14,
    marginTop:       12,
  },
  loadingBox: {
    height:         80,
    justifyContent: "center",
    alignItems:     "center",
  },

  header: {
    marginBottom: 10,
  },
  title: {
    color:      P.inkBrown,
    fontSize:   14,
    fontWeight: "700",
    marginBottom: 6,
  },
  statPills: {
    flexDirection: "row",
    gap:           6,
    flexWrap:      "wrap",
  },
  pill: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: P.cream,
    borderRadius:    20,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    paddingHorizontal: 8,
    paddingVertical:   3,
    gap:             3,
  },
  pillBest: {
    borderColor: P.amber,
  },
  pillFire: {
    backgroundColor: "#fff7ed",
    borderColor:     P.fire,
  },
  pillIcon: {
    fontSize: 12,
  },
  pillText: {
    color:      P.inkMid,
    fontSize:   11,
    fontWeight: "600",
  },

  dowRow: {
    flexDirection:  "row",
    justifyContent: "space-between",
    marginBottom:    4,
    paddingHorizontal: 2,
  },
  dowLabel: {
    width:     CELL_SIZE,
    textAlign: "center",
    color:     P.inkDim,
    fontSize:  10,
    fontWeight: "600",
  },

  weekRow: {
    flexDirection:  "row",
    justifyContent: "space-between",
    marginBottom:    3,
  },
  dayCell: {
    width:          CELL_SIZE,
    height:         CELL_SIZE,
    borderRadius:   6,
    backgroundColor: P.empty,
    alignItems:     "center",
    justifyContent: "center",
  },
  dayCellDone: {
    backgroundColor: "#fde68a",
    borderWidth:     1,
    borderColor:     P.amber,
  },
  dayCellToday: {
    borderWidth:  2,
    borderColor:  P.amber,
  },
  dayNum: {
    fontSize:   11,
    color:      P.inkDim,
    fontWeight: "500",
    lineHeight: 14,
  },
  dayNumDone: {
    color:      P.inkBrown,
    fontWeight: "700",
  },
  dayNumToday: {
    color:      P.amber,
    fontWeight: "800",
  },
  doneDot: {
    fontSize:   7,
    color:      P.amber,
    lineHeight: 9,
  },

  legend: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           6,
    marginTop:     10,
  },
  legendSwatch: {
    width:        12,
    height:       12,
    borderRadius:  2,
    backgroundColor: "#fde68a",
  },
  legendText: {
    color:      P.inkDim,
    fontSize:   10,
    marginRight: 8,
  },

  nudge: {
    color:      P.inkMid,
    fontSize:   11,
    marginTop:  8,
    fontStyle:  "italic",
    textAlign:  "center",
  },
});
