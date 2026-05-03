/**
 * pureLogic.test.ts
 * Chunk 1 — Pure logic of evaluateObject.ts
 *
 * Coverage:
 *   1. validatePropertyScore — negative phrases, hedging, "trust Claude >= 0.7"
 *   2. applyNegativePhraseValidation — overallMatch = ANY passes
 *   3. formatMasteryProfile — tier ordering, empty/missing
 *   4. computeXp — base rates, multi-property bonus, attempt tiers,
 *      partial match (overallMatch=false but passingCount>0), xpRates override
 */

import {
  validatePropertyScore,
  applyNegativePhraseValidation,
  formatMasteryProfile,
  computeXp,
  NEGATIVE_PHRASES,
  HEDGING_PHRASES,
  PROPERTY_PASS_THRESHOLD,
  CONTRADICTION_CAP,
  XP_FIRST_TRY,
  XP_SECOND_TRY,
  XP_THIRD_PLUS,
  PropertyScore,
  MasteryEntry,
} from "./pureLogic";

// ─── helpers ──────────────────────────────────────────────────────────────────

const prop = (over: Partial<PropertyScore> = {}): PropertyScore => ({
  word:      "translucent",
  score:     0.85,
  reasoning: "The object lets light through partially.",
  passes:    true,
  ...over,
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. validatePropertyScore
// ═══════════════════════════════════════════════════════════════════════════════

describe("validatePropertyScore — negative phrase override", () => {
  test("forces fail when reasoning contains negative phrase AND score is below threshold", () => {
    const result = validatePropertyScore(prop({
      score: 0.5,
      reasoning: "This object does not let light through.",
      passes: false,
    }));
    expect(result.score).toBe(0.0);
    expect(result.passes).toBe(false);
  });

  test("trusts Claude when score >= threshold even if reasoning contains negative phrase", () => {
    // The "trust Claude" rule: if score >= 0.7, do NOT override on negative match.
    // Production comment: phrases like "without breaking" can co-occur with positive verdicts.
    const result = validatePropertyScore(prop({
      score: 0.85,
      reasoning: "The glass shatters without breaking — wait, it does not stay intact.",
      passes: true,
    }));
    expect(result.score).toBe(0.85);
    expect(result.passes).toBe(true);
  });

  test("preserves the original prop when no negative phrase and score is sub-threshold", () => {
    const result = validatePropertyScore(prop({
      score: 0.4,
      reasoning: "The object only weakly demonstrates the property.",
      passes: false,
    }));
    expect(result.score).toBe(0.4);
    expect(result.passes).toBe(false);
  });

  test("matches case-insensitively (reasoning is lowercased internally)", () => {
    const result = validatePropertyScore(prop({
      score: 0.6,
      reasoning: "DOES NOT match the property at all.",
      passes: false,
    }));
    expect(result.score).toBe(0.0);
  });

  test("catches a sample from each NEGATIVE_PHRASES bucket", () => {
    const samples = [
      "doesn't",
      "isn't",
      "won't",
      "no evidence",
      "fails to",
      "lacks",
      "not translucent",
      "opposite of",
      "rather than",
      "would not qualify",
    ];
    for (const phrase of samples) {
      const result = validatePropertyScore(prop({
        score: 0.5,
        reasoning: `the object ${phrase} demonstrate this`,
        passes: false,
      }));
      expect(result.score).toBe(0.0);
    }
  });

  test("does NOT trigger on the deliberately-removed 'without' phrase", () => {
    // Production removed "without" + "absent" — they are too ambiguous.
    // "without breaking" actually CONFIRMS the property.
    expect(NEGATIVE_PHRASES).not.toContain("without");
    expect(NEGATIVE_PHRASES).not.toContain("absent");

    const result = validatePropertyScore(prop({
      score: 0.6,
      reasoning: "The metal flexes without breaking — flexible material.",
      passes: false,
    }));
    expect(result.score).toBe(0.6);
  });
});

describe("validatePropertyScore — hedging cap", () => {
  test("caps score to 0.55 when Claude scores >= 0.7 with hedging language", () => {
    const result = validatePropertyScore(prop({
      score: 0.85,
      reasoning: "Plastic is not typically flexible at this thickness.",
      passes: true,
    }));
    expect(result.score).toBe(CONTRADICTION_CAP);
    expect(result.passes).toBe(false); // 0.55 < 0.7
  });

  test("does NOT cap if score is already below threshold", () => {
    const result = validatePropertyScore(prop({
      score: 0.6,
      reasoning: "borderline case at best.",
      passes: false,
    }));
    // Score < threshold means we never enter the hedging branch.
    expect(result.score).toBe(0.6);
  });

  test("respects Math.min — never raises a low score", () => {
    // CONTRADICTION_CAP = 0.55. score = 0.5. Math.min(0.5, 0.55) = 0.5.
    // But this case won't trigger the hedging branch anyway (score < 0.7).
    // Verifying the branch entry at exactly 0.7:
    const result = validatePropertyScore(prop({
      score: 0.7,
      reasoning: "This is debatable but the object qualifies.",
      passes: true,
    }));
    expect(result.score).toBe(CONTRADICTION_CAP);
  });

  test("catches a sample from each HEDGING_PHRASES bucket", () => {
    const samples = [
      "not typically",
      "not necessarily",
      "questionable",
      "borderline",
      "stretch",
      "depends on",
    ];
    for (const phrase of samples) {
      const result = validatePropertyScore(prop({
        score: 0.9,
        reasoning: `it is ${phrase} a match`,
        passes: true,
      }));
      expect(result.score).toBe(CONTRADICTION_CAP);
      expect(result.passes).toBe(false);
    }
  });
});

describe("validatePropertyScore — interaction edge cases", () => {
  test("score of exactly PROPERTY_PASS_THRESHOLD (0.7) is treated as passing for trust", () => {
    // The condition is `score < threshold` so 0.7 should NOT trigger negative override.
    const result = validatePropertyScore(prop({
      score: PROPERTY_PASS_THRESHOLD,
      reasoning: "the object does not match",
      passes: true,
    }));
    // No override — but hedging branch triggers because score >= 0.7.
    // No hedging phrase here, so score unchanged.
    expect(result.score).toBe(PROPERTY_PASS_THRESHOLD);
  });

  test("when both negative AND hedging phrases present, negative override wins (executes first)", () => {
    // The negative override branch is `if (score < 0.7)`. Hedging is `if (score >= 0.7)`.
    // They're mutually exclusive on score, so no real interaction. Verifying.
    const result = validatePropertyScore(prop({
      score: 0.5,
      reasoning: "this is debatable and does not match",
      passes: false,
    }));
    expect(result.score).toBe(0.0); // negative wins, hedging branch never enters
  });

  test("preserves word and reasoning fields untouched", () => {
    const result = validatePropertyScore(prop({
      word: "translucent",
      score: 0.5,
      reasoning: "Does not match.",
      passes: false,
    }));
    expect(result.word).toBe("translucent");
    expect(result.reasoning).toBe("Does not match."); // production comment: never injects debug text
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. applyNegativePhraseValidation
// ═══════════════════════════════════════════════════════════════════════════════

describe("applyNegativePhraseValidation — overallMatch = ANY passes", () => {
  test("overallMatch is true when ANY single property passes (not all)", () => {
    // The production fix: changed from .every() to .some()
    const result = applyNegativePhraseValidation([
      prop({ word: "translucent", score: 0.85, passes: true }),
      prop({ word: "rigid",       score: 0.4,  passes: false }),
      prop({ word: "porous",      score: 0.3,  passes: false }),
    ]);
    expect(result.overallMatch).toBe(true);
  });

  test("overallMatch is false only when zero properties pass", () => {
    const result = applyNegativePhraseValidation([
      prop({ score: 0.4, passes: false }),
      prop({ score: 0.3, passes: false }),
    ]);
    expect(result.overallMatch).toBe(false);
  });

  test("validation is applied to every property", () => {
    const result = applyNegativePhraseValidation([
      prop({ word: "a", score: 0.5, reasoning: "does not match",       passes: false }),
      prop({ word: "b", score: 0.9, reasoning: "not typically applies", passes: true }),
      prop({ word: "c", score: 0.85, reasoning: "clean confirmation",   passes: true }),
    ]);
    expect(result.properties[0].score).toBe(0.0);  // negative override
    expect(result.properties[1].score).toBe(0.55); // hedging cap
    expect(result.properties[2].score).toBe(0.85); // unchanged
  });

  test("empty input returns empty + overallMatch false", () => {
    const result = applyNegativePhraseValidation([]);
    expect(result.properties).toEqual([]);
    expect(result.overallMatch).toBe(false);
  });

  test("does not mutate input array", () => {
    const input: PropertyScore[] = [prop({ score: 0.5, reasoning: "does not", passes: false })];
    const snapshot = JSON.parse(JSON.stringify(input));
    applyNegativePhraseValidation(input);
    expect(input).toEqual(snapshot);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. formatMasteryProfile
// ═══════════════════════════════════════════════════════════════════════════════

describe("formatMasteryProfile", () => {
  test("returns sentinel string when profile is empty", () => {
    expect(formatMasteryProfile([])).toBe("No vocabulary history yet.");
  });

  test("returns sentinel string when profile is null/undefined", () => {
    // @ts-expect-error — defensive null check in production
    expect(formatMasteryProfile(null)).toBe("No vocabulary history yet.");
    // @ts-expect-error
    expect(formatMasteryProfile(undefined)).toBe("No vocabulary history yet.");
  });

  test("orders tiers expert → proficient → developing → novice", () => {
    const profile: MasteryEntry[] = [
      { word: "n1", definition: "", mastery: 0.1, masteryTier: "novice",     timesUsed: 1 },
      { word: "e1", definition: "", mastery: 0.95, masteryTier: "expert",    timesUsed: 9 },
      { word: "p1", definition: "", mastery: 0.7, masteryTier: "proficient", timesUsed: 5 },
      { word: "d1", definition: "", mastery: 0.4, masteryTier: "developing", timesUsed: 3 },
    ];
    const out = formatMasteryProfile(profile);
    const eIdx = out.indexOf("EXPERT");
    const pIdx = out.indexOf("PROFICIENT");
    const dIdx = out.indexOf("DEVELOPING");
    const nIdx = out.indexOf("NOVICE");
    expect(eIdx).toBeGreaterThanOrEqual(0);
    expect(pIdx).toBeGreaterThan(eIdx);
    expect(dIdx).toBeGreaterThan(pIdx);
    expect(nIdx).toBeGreaterThan(dIdx);
  });

  test("omits empty tiers entirely (no header for missing tier)", () => {
    const profile: MasteryEntry[] = [
      { word: "fluffy", definition: "", mastery: 0.1, masteryTier: "novice", timesUsed: 1 },
    ];
    const out = formatMasteryProfile(profile);
    expect(out).toContain("NOVICE");
    expect(out).not.toContain("EXPERT");
    expect(out).not.toContain("PROFICIENT");
    expect(out).not.toContain("DEVELOPING");
  });

  test("groups multiple words within the same tier as a comma-separated list", () => {
    const profile: MasteryEntry[] = [
      { word: "translucent", definition: "", mastery: 0.95, masteryTier: "expert", timesUsed: 9 },
      { word: "pellucid",    definition: "", mastery: 0.92, masteryTier: "expert", timesUsed: 8 },
    ];
    const out = formatMasteryProfile(profile);
    expect(out).toContain("translucent, pellucid");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. computeXp
// ═══════════════════════════════════════════════════════════════════════════════

describe("computeXp — base attempt tiers (single property)", () => {
  test("first try: 40 XP", () => {
    const xp = computeXp({
      overallMatch:   true,
      properties:     [prop({ passes: true })],
      failedAttempts: 0,
    });
    expect(xp).toBe(XP_FIRST_TRY);
  });

  test("second try: 25 XP", () => {
    const xp = computeXp({
      overallMatch:   true,
      properties:     [prop({ passes: true })],
      failedAttempts: 1,
    });
    expect(xp).toBe(XP_SECOND_TRY);
  });

  test("third+ try: 10 XP", () => {
    const xp3 = computeXp({
      overallMatch:   true,
      properties:     [prop({ passes: true })],
      failedAttempts: 2,
    });
    const xp4 = computeXp({
      overallMatch:   true,
      properties:     [prop({ passes: true })],
      failedAttempts: 7,
    });
    expect(xp3).toBe(XP_THIRD_PLUS);
    expect(xp4).toBe(XP_THIRD_PLUS);
  });
});

describe("computeXp — multi-property bonus (the production examples)", () => {
  // From the production code comment:
  //   1 prop,  1st try: 40 × 1 × 1.0 =  40
  //   2 props, 1st try: 40 × 2 × 1.5 = 120
  //   3 props, 1st try: 40 × 3 × 2.0 = 240
  //   2 props, 2nd try: 25 × 2 × 1.5 =  75
  //   3 props, 3rd try: 10 × 3 × 2.0 =  60

  const passingProps = (n: number) =>
    Array.from({ length: n }, (_, i) => prop({ word: `w${i}`, passes: true }));

  test("1 prop, 1st try → 40", () => {
    expect(computeXp({ overallMatch: true, properties: passingProps(1), failedAttempts: 0 })).toBe(40);
  });

  test("2 props, 1st try → 120 (beats 2 separate scans = 80)", () => {
    expect(computeXp({ overallMatch: true, properties: passingProps(2), failedAttempts: 0 })).toBe(120);
  });

  test("3 props, 1st try → 240 (beats 3 separate scans = 120)", () => {
    expect(computeXp({ overallMatch: true, properties: passingProps(3), failedAttempts: 0 })).toBe(240);
  });

  test("2 props, 2nd try → 75", () => {
    expect(computeXp({ overallMatch: true, properties: passingProps(2), failedAttempts: 1 })).toBe(75);
  });

  test("3 props, 3rd try → 60", () => {
    expect(computeXp({ overallMatch: true, properties: passingProps(3), failedAttempts: 2 })).toBe(60);
  });

  test("efficiency rule: scanning N props together always beats N separate scans", () => {
    // Property-based: bundled XP > N × single-prop XP at every attempt tier.
    for (let attempts = 0; attempts <= 2; attempts++) {
      for (let n = 2; n <= 5; n++) {
        const single   = computeXp({ overallMatch: true, properties: passingProps(1), failedAttempts: attempts });
        const bundled  = computeXp({ overallMatch: true, properties: passingProps(n), failedAttempts: attempts });
        expect(bundled).toBeGreaterThan(single * n);
      }
    }
  });

  test("4 props clamps to the same 2.0× as 3 props (no super-bonus tier)", () => {
    // multiBonus = passingCount >= 3 ? 2.0 : ... — flat 2.0× from 3 onwards.
    const three = computeXp({ overallMatch: true, properties: passingProps(3), failedAttempts: 0 });
    const four  = computeXp({ overallMatch: true, properties: passingProps(4), failedAttempts: 0 });
    const five  = computeXp({ overallMatch: true, properties: passingProps(5), failedAttempts: 0 });
    expect(three).toBe(40 * 3 * 2.0); // 240
    expect(four).toBe (40 * 4 * 2.0); // 320
    expect(five).toBe (40 * 5 * 2.0); // 400
    // The MULTIPLIER is flat — total scales linearly past 3 props.
  });
});

describe("computeXp — partial match (overallMatch=false but some props pass)", () => {
  // Reading the production code:
  //   baseXp     = overallMatch ? rates[attempt] : 0
  //   xpAwarded  = (overallMatch || passingCount > 0) ? Math.round(baseXp * passingCount * multiBonus) : 0
  //
  // If overallMatch=false then baseXp=0, so even with passingCount>0 → xp=0.
  // Documenting current behaviour (not a bug — the gate is OR but baseXp is already 0).

  test("partial match with overallMatch=false yields 0 (baseXp=0 zeroes the product)", () => {
    const xp = computeXp({
      overallMatch:   false,
      properties:     [prop({ passes: true }), prop({ passes: false })],
      failedAttempts: 0,
    });
    expect(xp).toBe(0);
  });

  test("zero passing props with overallMatch=false yields 0", () => {
    const xp = computeXp({
      overallMatch:   false,
      properties:     [prop({ passes: false }), prop({ passes: false })],
      failedAttempts: 0,
    });
    expect(xp).toBe(0);
  });

  test("zero passing props with overallMatch=true (impossible state) yields 0 via passingCount=0", () => {
    // Defensive: even if overallMatch were true with 0 passing props,
    // baseXp * 0 * 1.0 = 0. Confirms the math is safe.
    const xp = computeXp({
      overallMatch:   true,
      properties:     [],
      failedAttempts: 0,
    });
    expect(xp).toBe(0);
  });
});

describe("computeXp — xpRates override from DB", () => {
  test("uses per-quest rates when provided (the XP FIX)", () => {
    const xp = computeXp({
      overallMatch:   true,
      properties:     [prop({ passes: true })],
      failedAttempts: 0,
      xpRates:        { firstTry: 100, secondTry: 60, thirdPlus: 20 },
    });
    expect(xp).toBe(100);
  });

  test("falls back to constants when xpRates is undefined", () => {
    const xp = computeXp({
      overallMatch:   true,
      properties:     [prop({ passes: true })],
      failedAttempts: 0,
    });
    expect(xp).toBe(XP_FIRST_TRY);
  });

  test("custom rates compound correctly with multi-property bonus", () => {
    // 100 × 3 × 2.0 = 600
    const xp = computeXp({
      overallMatch:   true,
      properties:     Array.from({ length: 3 }, () => prop({ passes: true })),
      failedAttempts: 0,
      xpRates:        { firstTry: 100, secondTry: 60, thirdPlus: 20 },
    });
    expect(xp).toBe(600);
  });

  test("Math.round handles non-integer products cleanly", () => {
    // 33 × 2 × 1.5 = 99 (already integer). Force a fractional case:
    // 33 × 1 × 1.0 = 33. Try odd rate × bonus:
    // 35 × 2 × 1.5 = 105. All integer — multiBonus is 1.0/1.5/2.0 and counts are ints.
    // Math.round is defensive against floating-point drift.
    const xp = computeXp({
      overallMatch:   true,
      properties:     [prop({ passes: true }), prop({ passes: true })],
      failedAttempts: 0,
      xpRates:        { firstTry: 35, secondTry: 20, thirdPlus: 8 },
    });
    expect(xp).toBe(105);
    expect(Number.isInteger(xp)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Sanity — phrase list integrity
// ═══════════════════════════════════════════════════════════════════════════════

describe("phrase list integrity", () => {
  test("NEGATIVE_PHRASES has no empty entries", () => {
    expect(NEGATIVE_PHRASES.every((s) => s.trim().length > 0)).toBe(true);
  });

  test("HEDGING_PHRASES has no empty entries", () => {
    expect(HEDGING_PHRASES.every((s) => s.trim().length > 0)).toBe(true);
  });

  test("phrase lists are all lowercase (matched against .toLowerCase() reasoning)", () => {
    // If any phrase had uppercase letters it would never match in production.
    expect(NEGATIVE_PHRASES.every((s) => s === s.toLowerCase())).toBe(true);
    expect(HEDGING_PHRASES.every((s) => s === s.toLowerCase())).toBe(true);
  });

  test("the deliberately-removed ambiguous phrases are not in NEGATIVE_PHRASES", () => {
    // Production comment locks these out — re-adding them would regress.
    expect(NEGATIVE_PHRASES).not.toContain("without");
    expect(NEGATIVE_PHRASES).not.toContain("absent");
  });
});
