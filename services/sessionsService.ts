/**
 * SessionsService
 * ───────────────
 * Typed read API for the `quest_sessions` table.
 *
 * The table is populated by the gameplay flow (ScanScreen / VerdictCard /
 * QuestMap) — this service ONLY reads. Writing happens elsewhere.
 *
 * Conventions mirror MasteryService.ts:
 *   - One service module, named exports, no default.
 *   - Supabase client imported from '../lib/supabase'.
 *   - All errors swallowed at the boundary and surfaced as `null` / `[]`,
 *     with a Sentry breadcrumb for observability. Components never see
 *     a thrown error — they get an empty state instead.
 *
 * ACTUAL schema (verified against supabase/bootstrap.sql, table public.quest_sessions):
 *   quest_sessions(
 *     id              uuid pk,
 *     child_id        uuid not null,
 *     quest_id        uuid not null,
 *     game_session_id uuid null,
 *     hard_mode       boolean not null default false,
 *     started_at      timestamptz not null default now(),
 *     finished_at     timestamptz null,
 *     completed       boolean not null default false,
 *     total_scans     integer not null default 0,
 *     xp_awarded      integer not null default 0
 *   )
 *
 * One row == one quest attempt (inserted on ScanScreen mount, updated on
 * finish/abandon). The panel-facing QuestSession shape below is DERIVED from
 * these columns so the UI need not know the raw column names:
 *   ended_at        <- finished_at
 *   duration_sec    <- (finished_at - started_at), null while in-progress
 *   quests_finished <- completed ? 1 : 0   (one row is one quest)
 *   xp_earned       <- xp_awarded
 *
 * NOTE: a previous version selected ended_at / duration_sec / quests_finished /
 * xp_earned directly. Those columns do not exist, so PostgREST returned a 400,
 * the error was swallowed, and the panel showed "hasn't played" for everyone
 * regardless of activity. The mapping below is the fix.
 */

import { supabase } from '../lib/supabase';
import * as SentryShim from '../lib/sentry';

/**
 * Best-effort observability hook. Calls into lib/sentry.ts if it exposes
 * `addBreadcrumb`, no-ops otherwise. We do this so the panel doesn't gain
 * a hard dep on a specific shape of the sentry wrapper — if your wrapper
 * uses a different name (e.g. `gameBreadcrumb`), just rename below.
 */
function trace(b: {
  category: string;
  message: string;
  level?: 'info' | 'warning' | 'error';
  data?: Record<string, unknown>;
}): void {
  const fn = (SentryShim as { addBreadcrumb?: (b: unknown) => void }).addBreadcrumb;
  if (typeof fn === 'function') fn(b);
}

// ─── Types ────────────────────────────────────────────────────────────────

export interface QuestSession {
  id: string;
  child_id: string;
  started_at: string;          // ISO timestamp
  ended_at: string | null;
  duration_sec: number | null;
  quests_finished: number;
  xp_earned: number;
}

export interface SessionsSummary {
  /** Number of sessions in the window. */
  sessionCount: number;
  /** Sum of duration_sec, ignoring nulls and sessions < MIN_SESSION_SEC. */
  totalDurationSec: number;
  /** Sum of quests_finished. */
  totalQuests: number;
  /** Sum of xp_earned. */
  totalXp: number;
  /** Average session duration in seconds, or 0 if no valid sessions. */
  avgDurationSec: number;
  /** Number of distinct days a session was played in the window. */
  activeDays: number;
  /** XP earned per day, oldest → newest, length === windowDays. */
  dailyXp: number[];
}

export type EngagementLevel = 'active' | 'casual' | 'quiet';

// ─── Constants ────────────────────────────────────────────────────────────

/** Sessions shorter than this are treated as test/abandoned and excluded. */
export const MIN_SESSION_SEC = 5;

/** Default window for the dashboard summary. */
export const DEFAULT_WINDOW_DAYS = 7;

/** Hard cap on rows returned to the client per query. */
const MAX_ROWS = 100;

// ─── Reads ────────────────────────────────────────────────────────────────

/**
 * Recent sessions for one child, newest first.
 * Sessions with sub-MIN duration are filtered client-side so the same
 * data underlies both the list and the summary.
 */
export async function getRecentSessions(
  childId: string,
  opts: { windowDays?: number; limit?: number } = {}
): Promise<QuestSession[]> {
  const { windowDays = DEFAULT_WINDOW_DAYS, limit = 20 } = opts;
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  const { data, error } = await supabase
    .from('quest_sessions')
    .select('id, child_id, started_at, finished_at, completed, xp_awarded')
    .eq('child_id', childId)
    .gte('started_at', since)
    .order('started_at', { ascending: false })
    .limit(Math.min(limit, MAX_ROWS));

  if (error) {
    trace({
      category: 'sessions',
      level: 'error',
      message: 'getRecentSessions failed',
      data: { code: error.code, windowDays },
    });
    return [];
  }

  // Raw DB row shape (the real columns). Mapped below into QuestSession so the
  // panel keeps its stable field names regardless of the underlying schema.
  interface RawSessionRow {
    id:           string;
    child_id:     string;
    started_at:   string;
    finished_at:  string | null;
    completed:    boolean | null;
    xp_awarded:   number | null;
  }

  const rows: QuestSession[] = ((data ?? []) as RawSessionRow[]).map((r) => {
    const durationSec = r.finished_at
      ? Math.max(
          0,
          Math.round(
            (new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000
          )
        )
      : null;
    return {
      id:              r.id,
      child_id:        r.child_id,
      started_at:      r.started_at,
      ended_at:        r.finished_at,
      duration_sec:    durationSec,
      quests_finished: r.completed ? 1 : 0,
      xp_earned:       r.xp_awarded ?? 0,
    };
  });

  return rows.filter(isValidSession);
}

/**
 * Aggregated summary for the dashboard top card.
 * Computed from the same `getRecentSessions` payload so list and summary
 * never disagree.
 */
export async function getSessionsSummary(
  childId: string,
  opts: { windowDays?: number } = {}
): Promise<SessionsSummary> {
  const { windowDays = DEFAULT_WINDOW_DAYS } = opts;
  const sessions = await getRecentSessions(childId, { windowDays, limit: MAX_ROWS });

  if (sessions.length === 0) {
    return emptySummary(windowDays);
  }

  const totalDurationSec = sessions.reduce((acc, s) => acc + (s.duration_sec ?? 0), 0);
  const totalQuests = sessions.reduce((acc, s) => acc + (s.quests_finished ?? 0), 0);
  const totalXp = sessions.reduce((acc, s) => acc + (s.xp_earned ?? 0), 0);

  const activeDayKeys = new Set(sessions.map((s) => dayKey(s.started_at)));
  const dailyXp = bucketDailyXp(sessions, windowDays);

  return {
    sessionCount: sessions.length,
    totalDurationSec,
    totalQuests,
    totalXp,
    avgDurationSec: Math.round(totalDurationSec / sessions.length),
    activeDays: activeDayKeys.size,
    dailyXp,
  };
}

/**
 * Soft engagement classifier — purely advisory, never gating.
 *  - active: ≥4 active days in 7d  (parent-friendly: "they're hooked")
 *  - casual: 2–3 active days        ("a few times this week")
 *  - quiet:  0–1 active days        ("hasn't checked in much")
 *
 * The thresholds are deliberately gentle — children miss days and that's fine.
 * This is shown as a pill, not a score.
 */
export function classifyEngagement(summary: SessionsSummary): EngagementLevel {
  if (summary.activeDays >= 4) return 'active';
  if (summary.activeDays >= 2) return 'casual';
  return 'quiet';
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function isValidSession(s: QuestSession): boolean {
  // A session is meaningful if it actually produced something.
  const meaningful = (s.xp_earned ?? 0) > 0 || (s.quests_finished ?? 0) > 0;

  // Duration-less rows are quest_sessions that were started but never closed
  // (finished_at is null) — orphans from Metro reloads, app kills, or quick
  // bail-outs. These are the "— · 0 quests · +0 XP" duplicates. Only keep one
  // if it earned XP / completed a quest; otherwise it's noise, not a session.
  if (s.duration_sec == null) return meaningful;

  // Finished rows: drop test-tap-length empties (no duration AND nothing earned).
  if (s.duration_sec < MIN_SESSION_SEC && !meaningful) return false;

  return true;
}

/** Local-time YYYY-MM-DD bucket key. Matches user perception of "a day". */
function dayKey(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Build an oldest→newest array of XP totals, one slot per day in the window. */
function bucketDailyXp(sessions: QuestSession[], windowDays: number): number[] {
  const buckets: Record<string, number> = {};
  for (const s of sessions) {
    const k = dayKey(s.started_at);
    buckets[k] = (buckets[k] ?? 0) + (s.xp_earned ?? 0);
  }

  const out: number[] = [];
  const today = new Date();
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    out.push(buckets[`${y}-${m}-${day}`] ?? 0);
  }
  return out;
}

function emptySummary(windowDays: number): SessionsSummary {
  return {
    sessionCount: 0,
    totalDurationSec: 0,
    totalQuests: 0,
    totalXp: 0,
    avgDurationSec: 0,
    activeDays: 0,
    dailyXp: new Array(windowDays).fill(0),
  };
}
