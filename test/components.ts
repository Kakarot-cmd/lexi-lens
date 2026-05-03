/**
 * components.ts — pure-logic extracts from:
 *   • components/VerdictCard.tsx
 *   • components/RateLimitWall.tsx
 *   • components/StreakHeatmap.tsx
 *   • components/StreakBar.tsx
 *   • components/DailyQuestBanner.tsx
 *   • components/RecentSessionsPanel.tsx (formatters)
 */

// ═════════════════════════════════════════════════════════════════════════════
// VerdictCard
// ═════════════════════════════════════════════════════════════════════════════

interface PropertyScore {
  word:      string;
  score:     number;
  reasoning: string;
  passes:    boolean;
}

interface VerdictResult {
  resolvedObjectName?: string;
  properties?:         PropertyScore[];
  childFeedback?:      string;
  xpAwarded?:          number;
}

/**
 * splitProperties — verbatim of the defensive split in VerdictCard.
 * Production fix: result?.properties may be undefined when the Edge Function
 * returns a partial/malformed response. Without ?., calling .filter() on
 * undefined crashes the render.
 */
export function splitProperties(result: VerdictResult | null | undefined): {
  passingProps:  PropertyScore[];
  failingProps:  PropertyScore[];
  somethingFound: boolean;
  totalXpEarned: number;
} {
  const passingProps   = result?.properties?.filter((p) => p.passes) ?? [];
  const failingProps   = result?.properties?.filter((p) => !p.passes) ?? [];
  const somethingFound = passingProps.length > 0;
  const totalXpEarned  = result?.xpAwarded ?? 0;
  return { passingProps, failingProps, somethingFound, totalXpEarned };
}

/**
 * bonusPillText — verbatim of VerdictCard's multi-property bonus label:
 *   passingProps.length >= 3 ? "2× multi-property bonus!" : "1.5× bonus!"
 * Pill is only rendered when passingProps.length >= 2.
 */
export function bonusPillText(passingCount: number): string | null {
  if (passingCount < 2) return null;
  return passingCount >= 3 ? "2× multi-property bonus!" : "1.5× bonus!";
}

/**
 * stripAutoCorrectedTag — verbatim of the regex in PropertyBadge that
 * strips "[auto-corrected: …]" debug strings from reasoning before display.
 */
export function stripAutoCorrectedTag(reasoning: string): string {
  return reasoning.replace(/\s*\[auto-corrected:[^\]]*\]/g, "").trim();
}

/**
 * headerTitle — verbatim of the somethingFound branch:
 *   somethingFound
 *     ? `${count} propert{y|ies} found!`
 *     : "Almost…"
 */
export function headerTitle(passingCount: number): string {
  if (passingCount === 0) return "Almost…";
  return `${passingCount} propert${passingCount === 1 ? "y" : "ies"} found!`;
}

// ═════════════════════════════════════════════════════════════════════════════
// RateLimitWall
// ═════════════════════════════════════════════════════════════════════════════

export function secondsUntil(isoTarget: string | null): number {
  if (!isoTarget) return 0;
  return Math.max(0, Math.floor((new Date(isoTarget).getTime() - Date.now()) / 1000));
}

export function formatCountdown(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const hh = String(h).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/**
 * approachingLimitMath — the remaining + pct calculation done inside
 * ApproachingLimitBanner. Extracted so we can lock in the math without
 * mocking React Native.
 */
export function approachingLimitMath(scansToday: number, dailyLimit: number): {
  remaining: number;
  pct:       number;
  remainingLabel: string;
} {
  const remaining = dailyLimit - scansToday;
  const pct       = Math.round((scansToday / dailyLimit) * 100);
  const remainingLabel = `${remaining} scan${remaining !== 1 ? "s" : ""} left today`;
  return { remaining, pct, remainingLabel };
}

// ═════════════════════════════════════════════════════════════════════════════
// StreakHeatmap
// ═════════════════════════════════════════════════════════════════════════════

/** ISO date string for a date offset by `daysBack` from today */
export function isoOffset(daysBack: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  return d.toISOString().slice(0, 10);
}

/** Last 28 calendar dates, oldest first */
export function last28Days(): string[] {
  return Array.from({ length: 28 }, (_, i) => isoOffset(27 - i));
}

export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * padDaysToWeeks — verbatim of the Sunday-aligned padding logic in StreakHeatmap.
 * Returns the days array padded with leading nulls so the first row starts on
 * Sunday, then split into 7-day weeks.
 */
export function padDaysToWeeks(days: string[]): (string | null)[][] {
  const firstDow = new Date(days[0]).getDay();
  const padded   = [...Array(firstDow).fill(null), ...days];
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < padded.length; i += 7) {
    weeks.push(padded.slice(i, i + 7));
  }
  return weeks;
}

// ═════════════════════════════════════════════════════════════════════════════
// StreakBar — flame display logic
// ═════════════════════════════════════════════════════════════════════════════

/**
 * flameOpacities — for a 7-flame StreakBar, returns the opacity (1 lit, 0.18 dim)
 * for each flame index based on the current streak.
 */
export function flameOpacities(currentStreak: number): number[] {
  return Array.from({ length: 7 }, (_, i) => (i < currentStreak ? 1 : 0.18));
}

export function progressHintText(currentStreak: number): string | null {
  if (currentStreak <= 0 || currentStreak >= 7) return null;
  const days = 7 - currentStreak;
  return `${days} more day${days !== 1 ? "s" : ""} to 2× XP!`;
}

// ═════════════════════════════════════════════════════════════════════════════
// DailyQuestBanner — XP formula display
// ═════════════════════════════════════════════════════════════════════════════

/**
 * computeMaxXpFirst — verbatim of the DailyQuestBanner XP FIX:
 *   propCount  = displayProps.length
 *   multiBonus = propCount >= 3 ? 2.0 : propCount === 2 ? 1.5 : 1.0
 *   maxXpFirst = round(xp_reward_first_try * propCount * multiBonus)
 *
 * Then the displayed XP = has2x ? maxXpFirst * 2 : maxXpFirst
 */
export function computeMaxXpFirst(xpRewardFirstTry: number, propCount: number): number {
  const multiBonus = propCount >= 3 ? 2.0 : propCount === 2 ? 1.5 : 1.0;
  return Math.round(xpRewardFirstTry * propCount * multiBonus);
}

export function dailyXpDisplay(xpRewardFirstTry: number, propCount: number, has2x: boolean): string {
  const base = computeMaxXpFirst(xpRewardFirstTry, propCount);
  return has2x ? `${base * 2} XP` : `${base} XP`;
}

// ═════════════════════════════════════════════════════════════════════════════
// RecentSessionsPanel formatters
// ═════════════════════════════════════════════════════════════════════════════

export function formatRelative(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString())       return `Today, ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { weekday: "short" })}, ${d.toLocaleDateString([], { day: "numeric", month: "short" })}`;
}

export function formatDuration(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60)   return `${sec}s`;
  const m  = Math.floor(sec / 60);
  const s  = sec % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  const h  = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}
