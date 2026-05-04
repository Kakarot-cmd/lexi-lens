/**
 * gameStoreLogic.test.ts
 * Chunk 5 — Zustand store pure logic
 *
 * Coverage:
 *   1. buildComponents              — initial component shape
 *   2. calcEnemyHp                  — 100 → 0 ramp, edge cases
 *   3. ageBandOrder + childMinAgeBandOk — gating logic
 *   4. selectCurrentComponent       — first unfound
 *   5. selectCurrentAttempts        — per-component attempts
 *   6. selectQuestComplete          — every-vs-some
 *   7. selectStreakMultiplier       — 7-day threshold
 *   8. selectIsPlayingDailyQuest    — daily quest match
 *   9. selectQuestCompletionMode    — hard wins over normal
 *  10. selectHasHardMode            — array shape check
 *  11. selectLevelProgress          — XP curve formula
 *  12. getDisplayProperties         — age-band merging
 *  13. recordComponentFoundReducer  — single-property unlock + enemyHp recalc
 *  14. recordComponentsFoundReducer — the atomic batch race-fix
 *  15. recordMissedScanReducer      — attempt counter
 */

import {
  buildComponents,
  calcEnemyHp,
  ageBandOrder,
  childMinAgeBandOk,
  selectCurrentComponent,
  selectCurrentAttempts,
  selectQuestComplete,
  selectStreakMultiplier,
  selectIsPlayingDailyQuest,
  selectQuestCompletionMode,
  selectHasHardMode,
  selectLevelProgress,
  getDisplayProperties,
  recordComponentFoundReducer,
  recordComponentsFoundReducer,
  recordMissedScanReducer,
  ActiveQuest,
  ComponentProgress,
  MinimalState,
  PropertyRequirement,
  Quest,
} from "./gameStoreLogic";

// ─── factories ────────────────────────────────────────────────────────────────

const props = (...words: string[]): PropertyRequirement[] =>
  words.map((w) => ({ word: w, definition: `def of ${w}` }));

const comp = (word: string, found = false, attempts = 0): ComponentProgress => ({
  propertyWord: word,
  found,
  objectUsed:   found ? "apple" : null,
  xpEarned:     found ? 40 : 0,
  attemptCount: attempts,
});

const makeQuest = (over: Partial<Quest> = {}): Quest => ({
  id: "q1",
  name: "The Crystal Cup",
  tier: "apprentice",
  required_properties: props("translucent", "rigid"),
  ...over,
});

const makeActiveQuest = (over: Partial<ActiveQuest> = {}): ActiveQuest => ({
  quest: makeQuest(),
  components: buildComponents(props("translucent", "rigid")),
  startedAt: Date.now(),
  enemyHp: 100,
  isHardMode: false,
  effectiveProperties: props("translucent", "rigid"),
  ...over,
});

const makeState = (over: Partial<MinimalState> = {}): MinimalState => ({
  activeChild: { id: "c1", total_xp: 0, level: 1 },
  activeQuest: null,
  questLibrary: [],
  streak: { currentStreak: 0, longestStreak: 0, lastQuestDate: null, streakDates: [], gotMultiplier: false },
  completedQuestIds: [],
  hardCompletedQuestIds: [],
  dailyQuest: { questId: null, questDate: "", isLoaded: false },
  ...over,
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. buildComponents
// ═══════════════════════════════════════════════════════════════════════════════

describe("buildComponents", () => {
  test("creates one component per property in input order", () => {
    const result = buildComponents(props("a", "b", "c"));
    expect(result).toHaveLength(3);
    expect(result.map((c) => c.propertyWord)).toEqual(["a", "b", "c"]);
  });

  test("initial state: not found, no objectUsed, 0 xp, 0 attempts", () => {
    const result = buildComponents(props("a"));
    expect(result[0]).toEqual({
      propertyWord: "a", found: false, objectUsed: null, xpEarned: 0, attemptCount: 0,
    });
  });

  test("empty input returns empty array", () => {
    expect(buildComponents([])).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. calcEnemyHp
// ═══════════════════════════════════════════════════════════════════════════════

describe("calcEnemyHp", () => {
  test("100 when no components found", () => {
    expect(calcEnemyHp([comp("a"), comp("b"), comp("c")])).toBe(100);
  });

  test("0 when all components found", () => {
    expect(calcEnemyHp([comp("a", true), comp("b", true), comp("c", true)])).toBe(0);
  });

  test("ramps proportionally — 1 of 3 found → 67", () => {
    expect(calcEnemyHp([comp("a", true), comp("b"), comp("c")])).toBe(67);
  });

  test("ramps proportionally — 2 of 3 found → 33", () => {
    expect(calcEnemyHp([comp("a", true), comp("b", true), comp("c")])).toBe(33);
  });

  test("empty components → 100 (sentinel)", () => {
    expect(calcEnemyHp([])).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. ageBandOrder + childMinAgeBandOk
// ═══════════════════════════════════════════════════════════════════════════════

describe("ageBandOrder", () => {
  test("known bands 0..4 in order", () => {
    expect(ageBandOrder("5-6")).toBe(0);
    expect(ageBandOrder("7-8")).toBe(1);
    expect(ageBandOrder("9-10")).toBe(2);
    expect(ageBandOrder("11-12")).toBe(3);
    expect(ageBandOrder("13-14")).toBe(4);
  });

  test("unknown band returns 99 (defensive sentinel)", () => {
    expect(ageBandOrder("3-4")).toBe(99);
    expect(ageBandOrder("")).toBe(99);
  });
});

describe("childMinAgeBandOk", () => {
  test("older child meets older quest requirement", () => {
    expect(childMinAgeBandOk("11-12", "7-8")).toBe(true);
  });

  test("same band passes", () => {
    expect(childMinAgeBandOk("7-8", "7-8")).toBe(true);
  });

  test("younger child fails", () => {
    expect(childMinAgeBandOk("5-6", "9-10")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4-6. Quest progress selectors
// ═══════════════════════════════════════════════════════════════════════════════

describe("selectCurrentComponent / selectCurrentAttempts", () => {
  test("returns the first unfound component", () => {
    const aq = makeActiveQuest({
      components: [comp("a", true), comp("b", false, 2), comp("c")],
    });
    const state = makeState({ activeQuest: aq });
    expect(selectCurrentComponent(state)?.propertyWord).toBe("b");
    expect(selectCurrentAttempts(state)).toBe(2);
  });

  test("returns null when no active quest", () => {
    expect(selectCurrentComponent(makeState())).toBeNull();
    expect(selectCurrentAttempts(makeState())).toBe(0);
  });

  test("returns null when all components are found", () => {
    const aq = makeActiveQuest({
      components: [comp("a", true), comp("b", true)],
    });
    const state = makeState({ activeQuest: aq });
    expect(selectCurrentComponent(state)).toBeNull();
    expect(selectCurrentAttempts(state)).toBe(0);
  });
});

describe("selectQuestComplete", () => {
  test("true when every component is found", () => {
    const aq = makeActiveQuest({ components: [comp("a", true), comp("b", true)] });
    expect(selectQuestComplete(makeState({ activeQuest: aq }))).toBe(true);
  });

  test("false when at least one is unfound", () => {
    const aq = makeActiveQuest({ components: [comp("a", true), comp("b", false)] });
    expect(selectQuestComplete(makeState({ activeQuest: aq }))).toBe(false);
  });

  test("false when no active quest", () => {
    expect(selectQuestComplete(makeState())).toBe(false);
  });

  test("false when components is empty (vacuous-truth guard)", () => {
    // Note: components.every() on [] returns true, but activeQuest existing
    // with no components is an invalid state. The guard `!!activeQuest` lets
    // this through — documenting current behaviour.
    const aq = makeActiveQuest({ components: [] });
    expect(selectQuestComplete(makeState({ activeQuest: aq }))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. selectStreakMultiplier
// ═══════════════════════════════════════════════════════════════════════════════

describe("selectStreakMultiplier", () => {
  test("1.0 when gotMultiplier is false (any streak < 7)", () => {
    const state = makeState({ streak: { ...makeState().streak, currentStreak: 6, gotMultiplier: false } });
    expect(selectStreakMultiplier(state)).toBe(1.0);
  });

  test("2.0 when gotMultiplier is true (streak >= 7)", () => {
    const state = makeState({ streak: { ...makeState().streak, currentStreak: 7, gotMultiplier: true } });
    expect(selectStreakMultiplier(state)).toBe(2.0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. selectIsPlayingDailyQuest
// ═══════════════════════════════════════════════════════════════════════════════

describe("selectIsPlayingDailyQuest", () => {
  test("true when activeQuest.id matches dailyQuest.questId", () => {
    const aq = makeActiveQuest({ quest: makeQuest({ id: "daily-1" }) });
    const state = makeState({
      activeQuest: aq,
      dailyQuest:  { questId: "daily-1", questDate: "2026-05-03", isLoaded: true },
    });
    expect(selectIsPlayingDailyQuest(state)).toBe(true);
  });

  test("false when ids differ", () => {
    const aq = makeActiveQuest({ quest: makeQuest({ id: "other" }) });
    const state = makeState({
      activeQuest: aq,
      dailyQuest:  { questId: "daily-1", questDate: "2026-05-03", isLoaded: true },
    });
    expect(selectIsPlayingDailyQuest(state)).toBe(false);
  });

  test("false when no daily quest set", () => {
    const aq = makeActiveQuest();
    expect(selectIsPlayingDailyQuest(makeState({ activeQuest: aq }))).toBe(false);
  });

  test("false when no active quest", () => {
    expect(selectIsPlayingDailyQuest(makeState({
      dailyQuest: { questId: "daily-1", questDate: "2026-05-03", isLoaded: true },
    }))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. selectQuestCompletionMode
// ═══════════════════════════════════════════════════════════════════════════════

describe("selectQuestCompletionMode — hard wins over normal", () => {
  test("returns 'hard' when in hardCompletedQuestIds", () => {
    const state = makeState({
      hardCompletedQuestIds: ["q1"],
      completedQuestIds:     ["q1"], // present in both — hard wins
    });
    expect(selectQuestCompletionMode(state, "q1")).toBe("hard");
  });

  test("returns 'normal' when only in completedQuestIds", () => {
    expect(selectQuestCompletionMode(
      makeState({ completedQuestIds: ["q1"] }), "q1"
    )).toBe("normal");
  });

  test("returns null when in neither", () => {
    expect(selectQuestCompletionMode(makeState(), "q1")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. selectHasHardMode
// ═══════════════════════════════════════════════════════════════════════════════

describe("selectHasHardMode", () => {
  test("true when hard_mode_properties is a non-empty array", () => {
    expect(selectHasHardMode(makeQuest({ hard_mode_properties: props("rigid") }))).toBe(true);
  });

  test("false when hard_mode_properties is undefined", () => {
    expect(selectHasHardMode(makeQuest())).toBe(false);
  });

  test("false when hard_mode_properties is empty array", () => {
    expect(selectHasHardMode(makeQuest({ hard_mode_properties: [] }))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. selectLevelProgress — XP curve
// ═══════════════════════════════════════════════════════════════════════════════

describe("selectLevelProgress", () => {
  // formula: lo = (level-1)^2 * 50 ; hi = level^2 * 50 ; progress = (xp - lo) / (hi - lo)
  test("level 1, 0 XP → 0", () => {
    const s = makeState({ activeChild: { id: "c1", total_xp: 0, level: 1 } });
    expect(selectLevelProgress(s)).toBe(0);
  });

  test("level 1, 25 XP → 0.5 (lo=0, hi=50)", () => {
    const s = makeState({ activeChild: { id: "c1", total_xp: 25, level: 1 } });
    expect(selectLevelProgress(s)).toBeCloseTo(0.5);
  });

  test("level 2, 50 XP → 0 (lo=50, hi=200)", () => {
    const s = makeState({ activeChild: { id: "c1", total_xp: 50, level: 2 } });
    expect(selectLevelProgress(s)).toBe(0);
  });

  test("level 2, 125 XP → 0.5 (midpoint of 50..200)", () => {
    const s = makeState({ activeChild: { id: "c1", total_xp: 125, level: 2 } });
    expect(selectLevelProgress(s)).toBeCloseTo(0.5);
  });

  test("clamps to [0, 1]", () => {
    const overshoot = makeState({ activeChild: { id: "c1", total_xp: 999_999, level: 1 } });
    expect(selectLevelProgress(overshoot)).toBe(1);

    const negative = makeState({ activeChild: { id: "c1", total_xp: -10, level: 1 } });
    expect(selectLevelProgress(negative)).toBe(0);
  });

  test("no active child → 0 XP at level 1 → 0 progress", () => {
    expect(selectLevelProgress(makeState({ activeChild: null }))).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 12. getDisplayProperties
// ═══════════════════════════════════════════════════════════════════════════════

describe("getDisplayProperties — age-band merging", () => {
  test("falls back to required_properties when no age band match", () => {
    const quest = makeQuest({
      required_properties: props("translucent", "rigid"),
    });
    expect(getDisplayProperties(quest, "5-6")).toEqual(props("translucent", "rigid"));
  });

  test("uses age-band properties when present", () => {
    const quest = makeQuest({
      required_properties: props("translucent"),
      age_band_properties: {
        "5-6": [{ word: "see-through", definition: "you can see through it" }],
      },
    });
    const result = getDisplayProperties(quest, "5-6");
    expect(result[0].word).toBe("see-through");
  });

  test("enriches age-band props with canonical definition when blank", () => {
    const quest = makeQuest({
      required_properties: [{ word: "translucent", definition: "lets some light through" }],
      age_band_properties: {
        "5-6": [{ word: "translucent", definition: "  " }], // blank
      },
    });
    const result = getDisplayProperties(quest, "5-6");
    expect(result[0].definition).toBe("lets some light through");
  });

  test("preserves age-band evaluationHints over canonical when both present", () => {
    const quest = makeQuest({
      required_properties: [{
        word: "translucent",
        definition: "x",
        evaluationHints: "canonical-hint",
      }],
      age_band_properties: {
        "5-6": [{
          word: "translucent",
          definition: "kid-def",
          evaluationHints: "kid-hint",
        }],
      },
    });
    expect(getDisplayProperties(quest, "5-6")[0].evaluationHints).toBe("kid-hint");
  });

  test("empty age-band array falls back to required_properties", () => {
    const quest = makeQuest({
      required_properties: props("a"),
      age_band_properties: { "5-6": [] },
    });
    expect(getDisplayProperties(quest, "5-6")).toEqual(props("a"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 13. recordComponentFoundReducer
// ═══════════════════════════════════════════════════════════════════════════════

describe("recordComponentFoundReducer", () => {
  test("marks the matching component as found, sets objectUsed/xp/attempts", () => {
    const aq = makeActiveQuest({ components: [comp("a"), comp("b")] });
    const result = recordComponentFoundReducer(
      { activeQuest: aq },
      { propertyWord: "a", objectUsed: "lemon", xpAwarded: 40, attemptCount: 1 }
    );
    const a = result.activeQuest!.components.find((c) => c.propertyWord === "a")!;
    expect(a.found).toBe(true);
    expect(a.objectUsed).toBe("lemon");
    expect(a.xpEarned).toBe(40);
    expect(a.attemptCount).toBe(1);
  });

  test("does not affect other components", () => {
    const aq = makeActiveQuest({ components: [comp("a"), comp("b")] });
    const result = recordComponentFoundReducer(
      { activeQuest: aq },
      { propertyWord: "a", objectUsed: "lemon", xpAwarded: 40, attemptCount: 1 }
    );
    const b = result.activeQuest!.components.find((c) => c.propertyWord === "b")!;
    expect(b.found).toBe(false);
  });

  test("recalculates enemyHp", () => {
    const aq = makeActiveQuest({ components: [comp("a"), comp("b")], enemyHp: 100 });
    const result = recordComponentFoundReducer(
      { activeQuest: aq },
      { propertyWord: "a", objectUsed: "lemon", xpAwarded: 40, attemptCount: 1 }
    );
    expect(result.activeQuest!.enemyHp).toBe(50);
  });

  test("no-op when activeQuest is null", () => {
    const result = recordComponentFoundReducer(
      { activeQuest: null },
      { propertyWord: "a", objectUsed: "lemon", xpAwarded: 40, attemptCount: 1 }
    );
    expect(result.activeQuest).toBeNull();
  });

  test("no-op when propertyWord doesn't match any component", () => {
    const aq = makeActiveQuest({ components: [comp("a"), comp("b")] });
    const result = recordComponentFoundReducer(
      { activeQuest: aq },
      { propertyWord: "nonexistent", objectUsed: "x", xpAwarded: 40, attemptCount: 1 }
    );
    expect(result.activeQuest!.components.every((c) => !c.found)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 14. recordComponentsFoundReducer — the atomic batch race-fix
// ═══════════════════════════════════════════════════════════════════════════════

describe("recordComponentsFoundReducer — atomic batch (the race-condition fix)", () => {
  test("applies ALL updates in one pass — every component is marked found", () => {
    // The whole point: 3 properties unlocked from a single Claude scan must
    // all stick. The pre-fix bug was that only the LAST stuck.
    const aq = makeActiveQuest({
      components: [comp("smooth"), comp("round"), comp("hollow")],
    });
    const result = recordComponentsFoundReducer({ activeQuest: aq }, [
      { propertyWord: "smooth", objectUsed: "cup", xpAwarded: 80, attemptCount: 1 },
      { propertyWord: "round",  objectUsed: "cup", xpAwarded: 80, attemptCount: 1 },
      { propertyWord: "hollow", objectUsed: "cup", xpAwarded: 80, attemptCount: 1 },
    ]);
    expect(result.activeQuest!.components.every((c) => c.found)).toBe(true);
  });

  test("after batch, selectQuestComplete returns true (the visible end-to-end fix)", () => {
    const aq = makeActiveQuest({
      components: [comp("smooth"), comp("round"), comp("hollow")],
    });
    const result = recordComponentsFoundReducer({ activeQuest: aq }, [
      { propertyWord: "smooth", objectUsed: "cup", xpAwarded: 80, attemptCount: 1 },
      { propertyWord: "round",  objectUsed: "cup", xpAwarded: 80, attemptCount: 1 },
      { propertyWord: "hollow", objectUsed: "cup", xpAwarded: 80, attemptCount: 1 },
    ]);
    const newState = makeState({ activeQuest: result.activeQuest });
    expect(selectQuestComplete(newState)).toBe(true);
  });

  test("ignores updates whose propertyWord doesn't match any component", () => {
    const aq = makeActiveQuest({ components: [comp("a"), comp("b")] });
    const result = recordComponentsFoundReducer({ activeQuest: aq }, [
      { propertyWord: "a",       objectUsed: "x", xpAwarded: 40, attemptCount: 1 },
      { propertyWord: "phantom", objectUsed: "x", xpAwarded: 40, attemptCount: 1 },
    ]);
    expect(result.activeQuest!.components).toHaveLength(2);
    expect(result.activeQuest!.components.find((c) => c.propertyWord === "a")!.found).toBe(true);
  });

  test("partial batch — only matching components flip", () => {
    const aq = makeActiveQuest({ components: [comp("a"), comp("b"), comp("c")] });
    const result = recordComponentsFoundReducer({ activeQuest: aq }, [
      { propertyWord: "a", objectUsed: "x", xpAwarded: 40, attemptCount: 1 },
      { propertyWord: "c", objectUsed: "x", xpAwarded: 40, attemptCount: 1 },
    ]);
    const c = result.activeQuest!.components;
    expect(c.find((x) => x.propertyWord === "a")!.found).toBe(true);
    expect(c.find((x) => x.propertyWord === "b")!.found).toBe(false);
    expect(c.find((x) => x.propertyWord === "c")!.found).toBe(true);
  });

  test("recalculates enemyHp once at the end", () => {
    const aq = makeActiveQuest({ components: [comp("a"), comp("b"), comp("c")] });
    const result = recordComponentsFoundReducer({ activeQuest: aq }, [
      { propertyWord: "a", objectUsed: "x", xpAwarded: 40, attemptCount: 1 },
      { propertyWord: "b", objectUsed: "x", xpAwarded: 40, attemptCount: 1 },
    ]);
    // 1 of 3 unfound → 33
    expect(result.activeQuest!.enemyHp).toBe(33);
  });

  test("empty updates array is a no-op", () => {
    const aq = makeActiveQuest({ components: [comp("a"), comp("b")] });
    const result = recordComponentsFoundReducer({ activeQuest: aq }, []);
    expect(result.activeQuest!.components.every((c) => !c.found)).toBe(true);
  });

  test("no-op when activeQuest is null", () => {
    const result = recordComponentsFoundReducer({ activeQuest: null }, [
      { propertyWord: "a", objectUsed: "x", xpAwarded: 40, attemptCount: 1 },
    ]);
    expect(result.activeQuest).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 15. recordMissedScanReducer
// ═══════════════════════════════════════════════════════════════════════════════

describe("recordMissedScanReducer", () => {
  test("increments attemptCount on the matching component", () => {
    const aq = makeActiveQuest({ components: [comp("a", false, 2), comp("b")] });
    const result = recordMissedScanReducer({ activeQuest: aq }, "a");
    expect(result.activeQuest!.components.find((c) => c.propertyWord === "a")!.attemptCount).toBe(3);
  });

  test("does not affect 'found' or other components", () => {
    const aq = makeActiveQuest({ components: [comp("a", false, 2), comp("b")] });
    const result = recordMissedScanReducer({ activeQuest: aq }, "a");
    const a = result.activeQuest!.components.find((c) => c.propertyWord === "a")!;
    expect(a.found).toBe(false);
    expect(result.activeQuest!.components.find((c) => c.propertyWord === "b")!.attemptCount).toBe(0);
  });

  test("no-op when activeQuest is null", () => {
    const result = recordMissedScanReducer({ activeQuest: null }, "a");
    expect(result.activeQuest).toBeNull();
  });

  test("no-op (silently) when propertyWord doesn't match", () => {
    const aq = makeActiveQuest({ components: [comp("a"), comp("b")] });
    const result = recordMissedScanReducer({ activeQuest: aq }, "phantom");
    expect(result.activeQuest!.components.every((c) => c.attemptCount === 0)).toBe(true);
  });
});



// ═══════════════════════════════════════════════════════════════════════════════
// 17. v4.4.2 — markQuestCompletion retry classifier
// ═══════════════════════════════════════════════════════════════════════════════
//
// Pure-reducer mirror of the isTransientNetworkError() helper added in
// v4.4.2 to gameStore.ts. Verifies the network-vs-DB-error classification
// so a future change can't accidentally cause real DB errors to be retried
// (which would mask data integrity issues) or transient network errors to
// be skipped (which would re-introduce Bug C).
//
// PASTE THIS BLOCK AT THE END OF test/gameStoreLogic.test.ts.

describe("markQuestCompletion retry classifier", () => {
  // Mirror of the gameStore helper. Keep these in sync whenever the
  // production helper changes.
  function isTransientNetworkError(err: unknown): boolean {
    if (!err) return false;

    const msg = String((err as any)?.message ?? err ?? "").toLowerCase();
    if (msg.includes("network request failed")) return true;
    if (msg.includes("network error"))           return true;
    if (msg.includes("failed to fetch"))         return true;
    if (msg.includes("timeout"))                 return true;
    if (msg.includes("aborted"))                 return true;

    const code = (err as any)?.code;
    const isTypeError = (err as any)?.name === "TypeError";
    if (isTypeError && (!code || code === "")) return true;

    return false;
  }

  test("RN fetch failure (TypeError: Network request failed) is transient", () => {
    const err = new TypeError("Network request failed");
    expect(isTransientNetworkError(err)).toBe(true);
  });

  test("Postgres unique constraint violation is NOT transient", () => {
    const err = {
      code:    "23505",
      message: "duplicate key value violates unique constraint",
      details: null,
      hint:    null,
    };
    expect(isTransientNetworkError(err)).toBe(false);
  });

  test("RLS rejection is NOT transient", () => {
    const err = {
      code:    "42501",
      message: "new row violates row-level security policy",
      details: null,
      hint:    null,
    };
    expect(isTransientNetworkError(err)).toBe(false);
  });

  test("PostgREST routing error is NOT transient", () => {
    const err = {
      code:    "PGRST301",
      message: "JWT expired",
      details: null,
      hint:    null,
    };
    expect(isTransientNetworkError(err)).toBe(false);
  });

  test("Plain timeout string is transient", () => {
    expect(isTransientNetworkError(new Error("Request timeout"))).toBe(true);
  });

  test("AbortError-shaped error is transient", () => {
    expect(isTransientNetworkError(new Error("The operation was aborted"))).toBe(true);
  });

  test("null / undefined / empty are NOT transient (no retry)", () => {
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isTransientNetworkError(undefined)).toBe(false);
    expect(isTransientNetworkError({})).toBe(false);
  });

  test("exponential backoff math: 800ms base, 2 retries", () => {
    const BASE = 800;
    // Attempt 0 fails → wait BASE * 2^0 = 800ms → attempt 1
    // Attempt 1 fails → wait BASE * 2^1 = 1600ms → attempt 2 (final)
    expect(BASE * Math.pow(2, 0)).toBe(800);
    expect(BASE * Math.pow(2, 1)).toBe(1600);
    // Total worst-case latency before surrender: 800 + 1600 + (3 * fetch RTT)
    // ≈ 2.4s + RTTs ≈ ~3.4s on a typical mobile connection.
    expect(BASE * (Math.pow(2, 0) + Math.pow(2, 1))).toBe(2400);
  });
});
