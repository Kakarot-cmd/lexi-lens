/**
 * leaderboardService.ts
 * ─────────────────────
 * N2 — Sibling Leaderboard data layer.
 *
 * Fetches all children belonging to the signed-in parent and computes
 * three rank metrics:
 *   • XP          — child_profiles.total_xp
 *   • Words        — COUNT(word_tome rows) per child
 *   • Streak       — child_streaks.current_streak
 *
 * Zero new schema. Three existing tables, three parallel queries.
 *
 * Usage:
 *   const { data, error } = await fetchFamilyLeaderboard();
 */

import { supabase } from "../lib/supabase";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SiblingEntry {
  id:           string;
  display_name: string;
  avatar_key:   string | null;
  level:        number;
  total_xp:     number;
  word_count:   number;
  streak:       number;
}

export type LeaderboardMetric = "xp" | "words" | "streak";

export interface FamilyLeaderboard {
  /** Ordered by XP desc (the canonical sort; UI re-sorts per tab). */
  siblings:     SiblingEntry[];
  fetchedAt:    string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export async function fetchFamilyLeaderboard(): Promise<{
  data: FamilyLeaderboard | null;
  error: string | null;
}> {
  try {
    // ── 1. All children for this parent (RLS enforces parent_id = auth.uid()) ─
    const { data: profiles, error: profileErr } = await supabase
      .from("child_profiles")
      .select("id, display_name, avatar_key, level, total_xp")
      .order("created_at", { ascending: true });

    if (profileErr) throw new Error(profileErr.message);
    if (!profiles || profiles.length === 0) {
      return { data: { siblings: [], fetchedAt: new Date().toISOString() }, error: null };
    }

    const childIds = profiles.map((p) => p.id as string);

    // ── 2. Word counts — one aggregate query, not N queries ───────────────────
    //    Supabase doesn't expose GROUP BY directly, so we fetch all word_tome
    //    rows for these children (just child_id) and aggregate client-side.
    //    For typical family sizes (2-6 children) this is very cheap.
    const { data: wordRows, error: wordErr } = await supabase
      .from("word_tome")
      .select("child_id")
      .in("child_id", childIds);

    if (wordErr) throw new Error(wordErr.message);

    const wordCountMap: Record<string, number> = {};
    for (const row of wordRows ?? []) {
      wordCountMap[row.child_id] = (wordCountMap[row.child_id] ?? 0) + 1;
    }

    // ── 3. Streaks ────────────────────────────────────────────────────────────
    const { data: streakRows, error: streakErr } = await supabase
      .from("child_streaks")
      .select("child_id, current_streak")
      .in("child_id", childIds);

    // Streak table may not have a row for every child (zero-streak child = no row).
    // Treat missing rows as streak 0 — don't throw on this error.
    if (streakErr) {
      console.warn("[leaderboardService] streak fetch partial:", streakErr.message);
    }

    const streakMap: Record<string, number> = {};
    for (const row of streakRows ?? []) {
      streakMap[row.child_id] = row.current_streak ?? 0;
    }

    // ── 4. Assemble ───────────────────────────────────────────────────────────
    const siblings: SiblingEntry[] = profiles.map((p) => ({
      id:           p.id,
      display_name: p.display_name,
      avatar_key:   p.avatar_key ?? null,
      level:        p.level ?? 1,
      total_xp:     p.total_xp ?? 0,
      word_count:   wordCountMap[p.id] ?? 0,
      streak:       streakMap[p.id]   ?? 0,
    }));

    // Default sort: XP desc
    siblings.sort((a, b) => b.total_xp - a.total_xp);

    return {
      data: { siblings, fetchedAt: new Date().toISOString() },
      error: null,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[leaderboardService] fetch failed:", msg);
    return { data: null, error: msg };
  }
}

// ─── Rank helpers ──────────────────────────────────────────────────────────────

/** Returns siblings sorted by the chosen metric, highest first. */
export function rankBy(
  siblings: SiblingEntry[],
  metric: LeaderboardMetric,
): SiblingEntry[] {
  const sorted = [...siblings];
  switch (metric) {
    case "xp":     sorted.sort((a, b) => b.total_xp    - a.total_xp);    break;
    case "words":  sorted.sort((a, b) => b.word_count  - a.word_count);  break;
    case "streak": sorted.sort((a, b) => b.streak       - a.streak);      break;
  }
  return sorted;
}

/** Returns a short motivational gap string for the selected child. */
export function gapLine(
  child: SiblingEntry,
  leader: SiblingEntry,
  metric: LeaderboardMetric,
): string | null {
  if (child.id === leader.id) return null; // they ARE the leader

  const gap =
    metric === "xp"     ? leader.total_xp   - child.total_xp   :
    metric === "words"  ? leader.word_count  - child.word_count :
                          leader.streak       - child.streak;

  if (gap <= 0) return null;

  const unit =
    metric === "xp"     ? `XP`    :
    metric === "words"  ? `word${gap === 1 ? "" : "s"}` :
                          `day${gap === 1 ? "" : "s"}`;

  return `${gap} ${unit} behind ${leader.display_name}`;
}
