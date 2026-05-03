/**
 * services.ts — pure-logic extract of:
 *   • services/MasteryService.ts
 *   • services/sessionsService.ts
 *   • services/masteryRadarService.ts (helpers)
 *   • hooks/useAnalytics.ts (call-shape builders for testing supabase payloads)
 */

// ═════════════════════════════════════════════════════════════════════════════
// MasteryService
// ═════════════════════════════════════════════════════════════════════════════

export type MasteryTier = "novice" | "developing" | "proficient" | "expert";

export interface MasteryEntry {
  word:        string;
  definition:  string;
  mastery:     number;
  masteryTier: MasteryTier;
  timesUsed:   number;
}

export const MASTERY_RETIREMENT_THRESHOLD = 0.80;
const MAX_PROFILE_WORDS = 20;

export function calculateNewMastery(current: number, success: boolean): number {
  if (success) return Math.min(1.0, current + (1.0 - current) * 0.2);
  return Math.max(0.0, current - 0.08);
}

export function isReadyForRetirement(mastery: number): boolean {
  return mastery >= MASTERY_RETIREMENT_THRESHOLD;
}

export function masteryTierFrom(score: number): MasteryTier {
  if (score < 0.3) return "novice";
  if (score < 0.6) return "developing";
  if (score < 0.8) return "proficient";
  return "expert";
}

export function buildMasteryProfile(
  wordTomeCache: Array<{
    word:          string;
    definition:    string;
    mastery_score: number;
    times_used:    number;
    is_retired?:   boolean;
  }>
): MasteryEntry[] {
  return wordTomeCache
    .filter((w) => !w.is_retired)
    .sort((a, b) => a.mastery_score - b.mastery_score)
    .slice(0, MAX_PROFILE_WORDS)
    .map((w) => ({
      word:        w.word,
      definition:  w.definition,
      mastery:     Math.round(w.mastery_score * 100) / 100,
      masteryTier: masteryTierFrom(w.mastery_score),
      timesUsed:   w.times_used,
    }));
}

// ═════════════════════════════════════════════════════════════════════════════
// sessionsService
// ═════════════════════════════════════════════════════════════════════════════

export interface QuestSession {
  id:              string;
  child_id:        string;
  started_at:      string;
  ended_at:        string | null;
  duration_sec:    number | null;
  quests_finished: number;
  xp_earned:       number;
}

export interface SessionsSummary {
  sessionCount:     number;
  totalDurationSec: number;
  totalQuests:      number;
  totalXp:          number;
  avgDurationSec:   number;
  activeDays:       number;
  dailyXp:          number[];
}

export type EngagementLevel = "active" | "casual" | "quiet";
export const MIN_SESSION_SEC = 5;

export function classifyEngagement(summary: SessionsSummary): EngagementLevel {
  if (summary.activeDays >= 4) return "active";
  if (summary.activeDays >= 2) return "casual";
  return "quiet";
}

export function isValidSession(s: QuestSession): boolean {
  if (s.duration_sec == null) return true;
  return s.duration_sec >= MIN_SESSION_SEC;
}

export function dayKey(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function bucketDailyXp(sessions: QuestSession[], windowDays: number): number[] {
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
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    out.push(buckets[`${y}-${m}-${day}`] ?? 0);
  }
  return out;
}

export function emptySummary(windowDays: number): SessionsSummary {
  return {
    sessionCount:     0,
    totalDurationSec: 0,
    totalQuests:      0,
    totalXp:          0,
    avgDurationSec:   0,
    activeDays:       0,
    dailyXp:          new Array(windowDays).fill(0),
  };
}

/**
 * computeSummaryFromSessions — extracted aggregation logic from getSessionsSummary
 * (everything that runs after the supabase fetch).
 */
export function computeSummaryFromSessions(
  sessions:    QuestSession[],
  windowDays:  number
): SessionsSummary {
  const valid = sessions.filter(isValidSession);
  if (valid.length === 0) return emptySummary(windowDays);

  const totalDurationSec = valid.reduce((a, s) => a + (s.duration_sec ?? 0), 0);
  const totalQuests      = valid.reduce((a, s) => a + (s.quests_finished ?? 0), 0);
  const totalXp          = valid.reduce((a, s) => a + (s.xp_earned       ?? 0), 0);
  const activeDayKeys    = new Set(valid.map((s) => dayKey(s.started_at)));
  const dailyXp          = bucketDailyXp(valid, windowDays);

  return {
    sessionCount:     valid.length,
    totalDurationSec,
    totalQuests,
    totalXp,
    avgDurationSec:   Math.round(totalDurationSec / valid.length),
    activeDays:       activeDayKeys.size,
    dailyXp,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// masteryRadarService — pure helpers
// ═════════════════════════════════════════════════════════════════════════════

export type Domain =
  | "texture" | "colour" | "structure" | "sound" | "shape" | "material" | "other";

export const RADAR_DOMAINS: ReadonlyArray<Domain> = [
  "texture", "colour", "structure", "sound", "shape", "material",
];

export interface DomainStat {
  domain:     Domain;
  avgMastery: number;
  wordCount:  number;
}

export interface MasteryRadarData {
  byDomain:          DomainStat[];
  unclassifiedCount: number;
  totalClassified:   number;
  otherCount:        number;
}

export function emptyByDomain(): DomainStat[] {
  return RADAR_DOMAINS.map((d) => ({ domain: d, avgMastery: 0, wordCount: 0 }));
}

export function emptyRadar(): MasteryRadarData {
  return {
    byDomain:          emptyByDomain(),
    unclassifiedCount: 0,
    totalClassified:   0,
    otherCount:        0,
  };
}

/**
 * computeRadarFromRows — pure aggregation: given tome rows + domain rows,
 * produce the radar stats.
 */
export function computeRadarFromRows(
  tome:    Array<{ word: string; mastery_score: number | null }>,
  domains: Array<{ word: string; domain: Domain }>,
): MasteryRadarData {
  const domainMap = new Map(domains.map((d) => [d.word, d.domain]));

  const buckets: Record<Domain, { sum: number; count: number }> = {
    texture: { sum: 0, count: 0 },
    colour:  { sum: 0, count: 0 },
    structure: { sum: 0, count: 0 },
    sound:   { sum: 0, count: 0 },
    shape:   { sum: 0, count: 0 },
    material: { sum: 0, count: 0 },
    other:    { sum: 0, count: 0 },
  };

  let unclassifiedCount = 0;

  for (const row of tome) {
    const score  = row.mastery_score ?? 0;
    const domain = domainMap.get(row.word);
    if (!domain) {
      unclassifiedCount += 1;
      continue;
    }
    buckets[domain].sum   += score;
    buckets[domain].count += 1;
  }

  const byDomain: DomainStat[] = RADAR_DOMAINS.map((d) => ({
    domain:     d,
    avgMastery: buckets[d].count === 0 ? 0 : buckets[d].sum / buckets[d].count,
    wordCount:  buckets[d].count,
  }));

  const totalClassified = RADAR_DOMAINS.reduce((sum, d) => sum + buckets[d].count, 0);
  const otherCount      = buckets.other.count;

  return { byDomain, unclassifiedCount, totalClassified, otherCount };
}

// ═════════════════════════════════════════════════════════════════════════════
// useAnalytics — call-shape builders (extracted for payload testing)
// ═════════════════════════════════════════════════════════════════════════════

export interface QuestSessionPayload {
  childId:        string;
  questId:        string;
  gameSessionId?: string | null;
  hardMode:       boolean;
}

export interface WordOutcomePayload {
  childId:   string;
  questId?:  string;
  word:      string;
  passed:    boolean;
  scanLabel: string;
  attempt:   number;
}

export function buildGameSessionInsert(childId: string) {
  return { child_id: childId };
}

export function buildGameSessionUpdate(opts: {
  questsStarted:  number;
  questsFinished: number;
  xpEarned:       number;
  screenSequence: string[];
}) {
  return {
    ended_at:        new Date().toISOString(),
    quests_started:  opts.questsStarted,
    quests_finished: opts.questsFinished,
    xp_earned:       opts.xpEarned,
    screen_sequence: opts.screenSequence,
  };
}

export function buildQuestSessionInsert(payload: QuestSessionPayload, fallbackGameSessionId: string | null) {
  return {
    child_id:        payload.childId,
    quest_id:        payload.questId,
    game_session_id: payload.gameSessionId ?? fallbackGameSessionId,
    hard_mode:       payload.hardMode,
  };
}

export function buildQuestSessionFinishUpdate(opts: {
  completed:  boolean;
  totalScans: number;
  xpAwarded:  number;
}) {
  return {
    finished_at: new Date().toISOString(),
    completed:   opts.completed,
    total_scans: opts.totalScans,
    xp_awarded:  opts.xpAwarded,
  };
}

export function buildWordOutcomeInsert(payload: WordOutcomePayload) {
  return {
    child_id:    payload.childId,
    quest_id:    payload.questId ?? null,
    word:        payload.word,
    passed:      payload.passed,
    scan_label:  payload.scanLabel,
    attempt_num: payload.attempt,
  };
}
