/**
 * services.test.ts
 * Chunk 4 — MasteryService + sessionsService + masteryRadarService + useAnalytics
 *
 * Coverage:
 *   1. calculateNewMastery        — exponential approach + decay floor/ceiling
 *   2. isReadyForRetirement       — threshold
 *   3. masteryTierFrom            — 4-tier boundary mapping
 *   4. buildMasteryProfile        — filter retired, sort weakest first, cap at 20
 *   5. classifyEngagement         — active/casual/quiet thresholds
 *   6. isValidSession             — null vs <5s
 *   7. dayKey + bucketDailyXp     — date bucketing + window length
 *   8. computeSummaryFromSessions — full aggregation
 *   9. emptyByDomain / emptyRadar — sentinel shapes
 *  10. computeRadarFromRows       — domain join + averaging
 *  11. useAnalytics call shapes   — insert/update payload contracts
 */

import {
  calculateNewMastery,
  isReadyForRetirement,
  masteryTierFrom,
  buildMasteryProfile,
  MASTERY_RETIREMENT_THRESHOLD,
  classifyEngagement,
  isValidSession,
  dayKey,
  bucketDailyXp,
  emptySummary,
  computeSummaryFromSessions,
  RADAR_DOMAINS,
  emptyByDomain,
  emptyRadar,
  computeRadarFromRows,
  buildGameSessionInsert,
  buildGameSessionUpdate,
  buildQuestSessionInsert,
  buildQuestSessionFinishUpdate,
  buildWordOutcomeInsert,
  QuestSession,
  SessionsSummary,
} from "./services";

// ═══════════════════════════════════════════════════════════════════════════════
// 1. calculateNewMastery
// ═══════════════════════════════════════════════════════════════════════════════

describe("calculateNewMastery — exponential approach & decay", () => {
  test("success at 0.0 → +0.20 (full delta to 1)", () => {
    expect(calculateNewMastery(0.0, true)).toBeCloseTo(0.20);
  });

  test("success at 0.5 → +0.10 (half of remaining)", () => {
    expect(calculateNewMastery(0.5, true)).toBeCloseTo(0.60);
  });

  test("success at 0.9 → +0.02 (slows near 1)", () => {
    expect(calculateNewMastery(0.9, true)).toBeCloseTo(0.92);
  });

  test("success at 1.0 stays clamped at 1.0", () => {
    expect(calculateNewMastery(1.0, true)).toBe(1.0);
  });

  test("failure subtracts 0.08", () => {
    expect(calculateNewMastery(0.5, false)).toBeCloseTo(0.42);
  });

  test("failure floor — never below 0", () => {
    expect(calculateNewMastery(0.05, false)).toBe(0);
    expect(calculateNewMastery(0.0, false)).toBe(0);
  });

  test("requires >2 successes from 0 to cross 0.5 (no instant mastery)", () => {
    let m = 0.0;
    m = calculateNewMastery(m, true); // 0.20
    m = calculateNewMastery(m, true); // 0.36
    expect(m).toBeLessThan(0.5);
    m = calculateNewMastery(m, true); // 0.488
    expect(m).toBeLessThan(0.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. isReadyForRetirement
// ═══════════════════════════════════════════════════════════════════════════════

describe("isReadyForRetirement", () => {
  test("threshold is exactly 0.80", () => {
    expect(MASTERY_RETIREMENT_THRESHOLD).toBe(0.80);
  });

  test("0.79 below threshold → false", () => {
    expect(isReadyForRetirement(0.79)).toBe(false);
  });

  test("0.80 at threshold → true (>=)", () => {
    expect(isReadyForRetirement(0.80)).toBe(true);
  });

  test("0.95 above threshold → true", () => {
    expect(isReadyForRetirement(0.95)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. masteryTierFrom — 4-tier boundary mapping
// ═══════════════════════════════════════════════════════════════════════════════

describe("masteryTierFrom — boundaries", () => {
  // Prod: <0.3 novice, <0.6 developing, <0.8 proficient, >=0.8 expert
  test("0.0 → novice", () => expect(masteryTierFrom(0.0)).toBe("novice"));
  test("0.299 → novice (just below)", () => expect(masteryTierFrom(0.299)).toBe("novice"));
  test("0.3 → developing", () => expect(masteryTierFrom(0.3)).toBe("developing"));
  test("0.599 → developing", () => expect(masteryTierFrom(0.599)).toBe("developing"));
  test("0.6 → proficient", () => expect(masteryTierFrom(0.6)).toBe("proficient"));
  test("0.799 → proficient", () => expect(masteryTierFrom(0.799)).toBe("proficient"));
  test("0.8 → expert", () => expect(masteryTierFrom(0.8)).toBe("expert"));
  test("1.0 → expert", () => expect(masteryTierFrom(1.0)).toBe("expert"));
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. buildMasteryProfile
// ═══════════════════════════════════════════════════════════════════════════════

describe("buildMasteryProfile", () => {
  test("filters out retired words", () => {
    const tome = [
      { word: "a", definition: "x", mastery_score: 0.5, times_used: 1, is_retired: true },
      { word: "b", definition: "y", mastery_score: 0.5, times_used: 1, is_retired: false },
    ];
    const out = buildMasteryProfile(tome);
    expect(out).toHaveLength(1);
    expect(out[0].word).toBe("b");
  });

  test("sorts weakest first (lowest mastery_score)", () => {
    const tome = [
      { word: "expert", definition: "x", mastery_score: 0.9, times_used: 1 },
      { word: "novice", definition: "x", mastery_score: 0.1, times_used: 1 },
      { word: "mid",    definition: "x", mastery_score: 0.5, times_used: 1 },
    ];
    expect(buildMasteryProfile(tome).map((e) => e.word)).toEqual(["novice", "mid", "expert"]);
  });

  test("caps at 20 entries", () => {
    const tome = Array.from({ length: 50 }, (_, i) => ({
      word: `w${i}`, definition: "x", mastery_score: i / 100, times_used: 1,
    }));
    expect(buildMasteryProfile(tome)).toHaveLength(20);
  });

  test("rounds mastery to 2 decimals", () => {
    const tome = [{ word: "a", definition: "x", mastery_score: 0.123456, times_used: 1 }];
    expect(buildMasteryProfile(tome)[0].mastery).toBe(0.12);
  });

  test("attaches the correct masteryTier", () => {
    const tome = [
      { word: "a", definition: "x", mastery_score: 0.1, times_used: 1 },
      { word: "b", definition: "x", mastery_score: 0.5, times_used: 1 },
      { word: "c", definition: "x", mastery_score: 0.7, times_used: 1 },
      { word: "d", definition: "x", mastery_score: 0.9, times_used: 1 },
    ];
    const out = buildMasteryProfile(tome);
    expect(out.map((e) => e.masteryTier)).toEqual(["novice", "developing", "proficient", "expert"]);
  });

  test("empty input returns empty array", () => {
    expect(buildMasteryProfile([])).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. classifyEngagement
// ═══════════════════════════════════════════════════════════════════════════════

describe("classifyEngagement — soft thresholds", () => {
  const summary = (activeDays: number): SessionsSummary => ({
    sessionCount: 0, totalDurationSec: 0, totalQuests: 0, totalXp: 0,
    avgDurationSec: 0, activeDays, dailyXp: [],
  });

  test("0 days → quiet", () => expect(classifyEngagement(summary(0))).toBe("quiet"));
  test("1 day → quiet", () => expect(classifyEngagement(summary(1))).toBe("quiet"));
  test("2 days → casual", () => expect(classifyEngagement(summary(2))).toBe("casual"));
  test("3 days → casual", () => expect(classifyEngagement(summary(3))).toBe("casual"));
  test("4 days → active", () => expect(classifyEngagement(summary(4))).toBe("active"));
  test("7 days → active", () => expect(classifyEngagement(summary(7))).toBe("active"));
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. isValidSession
// ═══════════════════════════════════════════════════════════════════════════════

describe("isValidSession — duration filter", () => {
  const session = (duration_sec: number | null): QuestSession => ({
    id: "x", child_id: "c", started_at: new Date().toISOString(),
    ended_at: null, duration_sec, quests_finished: 0, xp_earned: 0,
  });

  test("null duration is kept (in-progress / older row)", () => {
    expect(isValidSession(session(null))).toBe(true);
  });

  test("at boundary (5s) is valid", () => {
    expect(isValidSession(session(5))).toBe(true);
  });

  test("just below boundary (4s) is invalid", () => {
    expect(isValidSession(session(4))).toBe(false);
  });

  test("0s and 1s rejected as test taps", () => {
    expect(isValidSession(session(0))).toBe(false);
    expect(isValidSession(session(1))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. dayKey + bucketDailyXp
// ═══════════════════════════════════════════════════════════════════════════════

describe("dayKey", () => {
  test("formats as YYYY-MM-DD", () => {
    const k = dayKey("2026-05-03T12:00:00Z");
    expect(k).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("two ISO timestamps on the same local day produce the same key", () => {
    // Both noon local — deterministic regardless of TZ.
    const local = new Date("2026-05-03T12:00:00").toISOString();
    const local2 = new Date("2026-05-03T18:00:00").toISOString();
    expect(dayKey(local)).toBe(dayKey(local2));
  });
});

describe("bucketDailyXp", () => {
  test("returns array of length windowDays", () => {
    expect(bucketDailyXp([], 7)).toHaveLength(7);
    expect(bucketDailyXp([], 30)).toHaveLength(30);
  });

  test("empty sessions → all zeros", () => {
    expect(bucketDailyXp([], 7)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  test("today's session lands in the LAST bucket (oldest → newest order)", () => {
    const todayIso = new Date().toISOString();
    const sessions: QuestSession[] = [{
      id: "x", child_id: "c", started_at: todayIso, ended_at: null,
      duration_sec: 100, quests_finished: 0, xp_earned: 50,
    }];
    const buckets = bucketDailyXp(sessions, 7);
    expect(buckets[6]).toBe(50);
    expect(buckets.slice(0, 6).every((v) => v === 0)).toBe(true);
  });

  test("multiple sessions on the same day are summed", () => {
    const todayIso = new Date().toISOString();
    const mk = (xp: number): QuestSession => ({
      id: Math.random().toString(36), child_id: "c", started_at: todayIso,
      ended_at: null, duration_sec: 100, quests_finished: 0, xp_earned: xp,
    });
    const buckets = bucketDailyXp([mk(20), mk(30)], 7);
    expect(buckets[6]).toBe(50);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. computeSummaryFromSessions
// ═══════════════════════════════════════════════════════════════════════════════

describe("computeSummaryFromSessions — aggregation", () => {
  test("empty → emptySummary", () => {
    expect(computeSummaryFromSessions([], 7)).toEqual(emptySummary(7));
  });

  test("filters short sessions then aggregates", () => {
    const todayIso = new Date().toISOString();
    const sessions: QuestSession[] = [
      { id: "1", child_id: "c", started_at: todayIso, ended_at: null, duration_sec: 60, quests_finished: 1, xp_earned: 100 },
      { id: "2", child_id: "c", started_at: todayIso, ended_at: null, duration_sec: 120, quests_finished: 2, xp_earned: 200 },
      { id: "3", child_id: "c", started_at: todayIso, ended_at: null, duration_sec: 2,  quests_finished: 0, xp_earned: 0 }, // excluded
    ];
    const summary = computeSummaryFromSessions(sessions, 7);
    expect(summary.sessionCount).toBe(2);
    expect(summary.totalDurationSec).toBe(180);
    expect(summary.totalQuests).toBe(3);
    expect(summary.totalXp).toBe(300);
    expect(summary.avgDurationSec).toBe(90);
    expect(summary.activeDays).toBe(1);
  });

  test("activeDays counts distinct day buckets", () => {
    const day1 = new Date("2026-05-01T12:00:00").toISOString();
    const day2 = new Date("2026-05-02T12:00:00").toISOString();
    const sessions: QuestSession[] = [
      { id: "1", child_id: "c", started_at: day1, ended_at: null, duration_sec: 60, quests_finished: 0, xp_earned: 0 },
      { id: "2", child_id: "c", started_at: day1, ended_at: null, duration_sec: 60, quests_finished: 0, xp_earned: 0 },
      { id: "3", child_id: "c", started_at: day2, ended_at: null, duration_sec: 60, quests_finished: 0, xp_earned: 0 },
    ];
    expect(computeSummaryFromSessions(sessions, 7).activeDays).toBe(2);
  });

  test("dailyXp length === windowDays", () => {
    expect(computeSummaryFromSessions([], 7).dailyXp).toHaveLength(7);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. emptyByDomain / emptyRadar
// ═══════════════════════════════════════════════════════════════════════════════

describe("emptyByDomain / emptyRadar", () => {
  test("emptyByDomain has 6 entries (one per radar domain)", () => {
    const entries = emptyByDomain();
    expect(entries).toHaveLength(6);
    expect(entries.map((e) => e.domain)).toEqual(["texture", "colour", "structure", "sound", "shape", "material"]);
    expect(entries.every((e) => e.avgMastery === 0 && e.wordCount === 0)).toBe(true);
  });

  test("RADAR_DOMAINS does NOT include 'other'", () => {
    expect(RADAR_DOMAINS).not.toContain("other");
  });

  test("emptyRadar has all-zero counters", () => {
    const r = emptyRadar();
    expect(r.unclassifiedCount).toBe(0);
    expect(r.totalClassified).toBe(0);
    expect(r.otherCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. computeRadarFromRows
// ═══════════════════════════════════════════════════════════════════════════════

describe("computeRadarFromRows", () => {
  test("aggregates per-domain averages correctly", () => {
    const tome = [
      { word: "smooth", mastery_score: 0.5 },
      { word: "rough",  mastery_score: 0.7 },
      { word: "red",    mastery_score: 0.3 },
    ];
    const domains = [
      { word: "smooth", domain: "texture" as const },
      { word: "rough",  domain: "texture" as const },
      { word: "red",    domain: "colour"  as const },
    ];
    const radar = computeRadarFromRows(tome, domains);
    const texture = radar.byDomain.find((d) => d.domain === "texture")!;
    const colour  = radar.byDomain.find((d) => d.domain === "colour")!;
    expect(texture.avgMastery).toBeCloseTo(0.6); // (0.5 + 0.7) / 2
    expect(texture.wordCount).toBe(2);
    expect(colour.avgMastery).toBeCloseTo(0.3);
    expect(colour.wordCount).toBe(1);
  });

  test("counts words with no domain entry as unclassified", () => {
    const tome = [{ word: "mystery", mastery_score: 0.5 }];
    const radar = computeRadarFromRows(tome, []);
    expect(radar.unclassifiedCount).toBe(1);
    expect(radar.totalClassified).toBe(0);
  });

  test("'other' contributes to otherCount but not the radar plot", () => {
    const tome = [{ word: "heavy", mastery_score: 0.5 }];
    const domains = [{ word: "heavy", domain: "other" as const }];
    const radar = computeRadarFromRows(tome, domains);
    expect(radar.otherCount).toBe(1);
    expect(radar.byDomain.every((d) => d.wordCount === 0)).toBe(true);
  });

  test("treats null mastery_score as 0 (defensive)", () => {
    const tome = [{ word: "x", mastery_score: null }];
    const domains = [{ word: "x", domain: "shape" as const }];
    const radar = computeRadarFromRows(tome, domains);
    const shape = radar.byDomain.find((d) => d.domain === "shape")!;
    expect(shape.avgMastery).toBe(0);
    expect(shape.wordCount).toBe(1);
  });

  test("totalClassified counts ONLY the 6 radar domains (excludes 'other')", () => {
    // Production type comment: "Words classified into one of the 6 radar
    // domains (excludes 'other')." otherCount is reported separately.
    const tome = [
      { word: "a", mastery_score: 0.5 },
      { word: "b", mastery_score: 0.5 },
    ];
    const domains = [
      { word: "a", domain: "texture" as const },
      { word: "b", domain: "other"   as const },
    ];
    const radar = computeRadarFromRows(tome, domains);
    expect(radar.totalClassified).toBe(1);
    expect(radar.otherCount).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. useAnalytics call shapes
// ═══════════════════════════════════════════════════════════════════════════════

describe("useAnalytics — supabase call payload contracts", () => {
  test("game session insert: only child_id (server fills the rest)", () => {
    expect(buildGameSessionInsert("c1")).toEqual({ child_id: "c1" });
  });

  test("game session update has all 5 contract fields", () => {
    const u = buildGameSessionUpdate({
      questsStarted: 3, questsFinished: 2, xpEarned: 100, screenSequence: ["a", "b"],
    });
    expect(Object.keys(u).sort()).toEqual([
      "ended_at", "quests_finished", "quests_started", "screen_sequence", "xp_earned",
    ]);
    expect(typeof u.ended_at).toBe("string");
    expect(new Date(u.ended_at).toISOString()).toBe(u.ended_at);
    expect(u.quests_started).toBe(3);
    expect(u.screen_sequence).toEqual(["a", "b"]);
  });

  test("quest session insert maps payload + uses fallback gameSessionId", () => {
    const insert = buildQuestSessionInsert(
      { childId: "c1", questId: "q1", hardMode: true },
      "fallback-gsid"
    );
    expect(insert).toEqual({
      child_id: "c1", quest_id: "q1", game_session_id: "fallback-gsid", hard_mode: true,
    });
  });

  test("quest session insert prefers payload.gameSessionId over fallback", () => {
    const insert = buildQuestSessionInsert(
      { childId: "c1", questId: "q1", gameSessionId: "explicit", hardMode: false },
      "fallback"
    );
    expect(insert.game_session_id).toBe("explicit");
  });

  test("quest session finish update contract", () => {
    const u = buildQuestSessionFinishUpdate({ completed: true, totalScans: 5, xpAwarded: 240 });
    expect(u).toMatchObject({ completed: true, total_scans: 5, xp_awarded: 240 });
    expect(typeof u.finished_at).toBe("string");
  });

  test("word outcome insert contract", () => {
    const insert = buildWordOutcomeInsert({
      childId: "c1", questId: "q1", word: "translucent", passed: true,
      scanLabel: "glass", attempt: 2,
    });
    expect(insert).toEqual({
      child_id: "c1", quest_id: "q1", word: "translucent", passed: true,
      scan_label: "glass", attempt_num: 2,
    });
  });

  test("word outcome insert handles missing questId (sets quest_id: null)", () => {
    const insert = buildWordOutcomeInsert({
      childId: "c1", word: "translucent", passed: false, scanLabel: "x", attempt: 1,
    });
    expect(insert.quest_id).toBeNull();
  });
});
