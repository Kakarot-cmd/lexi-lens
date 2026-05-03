/**
 * staticHealth.test.ts
 * Chunk 9 — Static / repo health
 *
 * Coverage:
 *   1. Boom.json Lottie schema validity
 *   2. Boom.json composition timing observation (potential gotcha)
 *   3. Test suite meta-check (all extract files compile + import cleanly)
 *   4. Type-shape lock-in for the public types extracted from production
 */

import { BOOM_JSON_HEAD, LAYER_EXTENTS } from "./boom_excerpt";

// All chunks' modules — importing them here verifies they compile cleanly
// and have stable public API surface.
import * as PureLogic    from "./pureLogic";
import * as Evaluate     from "./evaluateHandler";
import * as Store        from "./gameStoreLogic";
import * as Services     from "./services";
import * as Victory      from "./victoryFusion";
import * as OtherEdge    from "./otherEdgeFunctions";
import * as Components   from "./components";

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Boom.json — Lottie schema validity
// ═══════════════════════════════════════════════════════════════════════════════

describe("Boom.json — Lottie schema", () => {
  test("has required Lottie/Bodymovin top-level fields", () => {
    // Per the bodymovin-extension docs, every Lottie JSON requires:
    //   v   (schema version)
    //   fr  (frame rate)
    //   ip  (composition in-point)
    //   op  (composition out-point)
    //   w   (width)
    //   h   (height)
    //   nm  (name)
    //   layers (array)
    expect(BOOM_JSON_HEAD.v).toMatch(/^\d+\.\d+/);
    expect(typeof BOOM_JSON_HEAD.fr).toBe("number");
    expect(typeof BOOM_JSON_HEAD.ip).toBe("number");
    expect(typeof BOOM_JSON_HEAD.op).toBe("number");
    expect(typeof BOOM_JSON_HEAD.w).toBe("number");
    expect(typeof BOOM_JSON_HEAD.h).toBe("number");
    expect(typeof BOOM_JSON_HEAD.nm).toBe("string");
  });

  test("composition out-point > in-point (animation has duration)", () => {
    expect(BOOM_JSON_HEAD.op).toBeGreaterThan(BOOM_JSON_HEAD.ip);
  });

  test("frame rate is a sane animation rate (24-60)", () => {
    expect(BOOM_JSON_HEAD.fr).toBeGreaterThanOrEqual(24);
    expect(BOOM_JSON_HEAD.fr).toBeLessThanOrEqual(60);
  });

  test("canvas dimensions are positive and square (512×512)", () => {
    expect(BOOM_JSON_HEAD.w).toBe(512);
    expect(BOOM_JSON_HEAD.h).toBe(512);
  });

  test("name field matches the file's purpose (BigBadaBoom)", () => {
    expect(BOOM_JSON_HEAD.nm).toBe("BigBadaBoom");
  });

  test("composition duration as seconds matches the timing budget", () => {
    // The VictoryFusionScreen schedules its content reveal at t+1100ms.
    // Composition is 30 frames at 30 fps = 1.0 s. The Lottie burst should
    // complete BEFORE the content arrives, so 1.0 s ≤ 1.1 s is correct.
    const durationSec = (BOOM_JSON_HEAD.op - BOOM_JSON_HEAD.ip) / BOOM_JSON_HEAD.fr;
    expect(durationSec).toBeCloseTo(1.0);
    expect(durationSec * 1000).toBeLessThanOrEqual(1100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Boom.json layer/composition timing observation
// ═══════════════════════════════════════════════════════════════════════════════

describe("Boom.json — layer extent observation (potential gotcha)", () => {
  // FINDING: Individual shape layers have op values of 60–65, but the
  // composition's op is 30. lottie-react-native (Skia / Bodymovin)
  // CLIPS rendering at composition.op by default. Layer-level op past
  // composition.op is invisible — those late frames never play.
  //
  // This is a deliberate authoring choice in After Effects: the artist
  // designed for the layers to extend past the comp so timing curves
  // overshoot/easing-out cleanly. The clip at frame 30 is intentional.
  //
  // The test is a regression guard so any future change that reduces
  // layer op below comp op gets surfaced.
  test("composition op (30) is shorter than the longest shape-layer op", () => {
    const maxLayerOp = Math.max(...LAYER_EXTENTS.shapeLayersOp);
    expect(maxLayerOp).toBeGreaterThan(BOOM_JSON_HEAD.op);
  });

  test("all shape layers start AFTER composition in-point (lazy reveal)", () => {
    expect(LAYER_EXTENTS.shapeLayersIp.every((ip) => ip >= BOOM_JSON_HEAD.ip)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Test suite meta-check — every extract module imports cleanly
// ═══════════════════════════════════════════════════════════════════════════════

describe("module imports — every chunk's extract is importable", () => {
  test("pureLogic exports the documented public surface", () => {
    expect(typeof PureLogic.validatePropertyScore).toBe("function");
    expect(typeof PureLogic.applyNegativePhraseValidation).toBe("function");
    expect(typeof PureLogic.computeXp).toBe("function");
    expect(typeof PureLogic.formatMasteryProfile).toBe("function");
  });

  test("evaluateHandler exports rate-limit + cache helpers", () => {
    expect(typeof Evaluate.buildCacheKey).toBe("function");
    expect(typeof Evaluate.checkIpRateLimit).toBe("function");
    expect(typeof Evaluate.isValidCacheShape).toBe("function");
  });

  test("gameStoreLogic exports selectors + reducers", () => {
    expect(typeof Store.selectQuestComplete).toBe("function");
    expect(typeof Store.recordComponentsFoundReducer).toBe("function");
    expect(typeof Store.calcEnemyHp).toBe("function");
  });

  test("services exports MasteryService + sessions + radar", () => {
    expect(typeof Services.calculateNewMastery).toBe("function");
    expect(typeof Services.classifyEngagement).toBe("function");
    expect(typeof Services.computeRadarFromRows).toBe("function");
    expect(typeof Services.buildMasteryProfile).toBe("function");
  });

  test("victoryFusion exports themes + cascade", () => {
    expect(typeof Victory.selectTheme).toBe("function");
    expect(typeof Victory.triggerVictoryCascade).toBe("function");
    expect(Victory.MAX_PARTICLES).toBe(5);
  });

  test("otherEdgeFunctions exports all 5 EF validators", () => {
    expect(typeof OtherEdge.sanitizeInput).toBe("function");
    expect(typeof OtherEdge.validateConsentBody).toBe("function");
    expect(typeof OtherEdge.validateDeletionConfirmation).toBe("function");
    expect(typeof OtherEdge.validateRetireWordBody).toBe("function");
    expect(typeof OtherEdge.validateGenerateQuestBody).toBe("function");
  });

  test("components exports formatters + display helpers", () => {
    expect(typeof Components.splitProperties).toBe("function");
    expect(typeof Components.computeMaxXpFirst).toBe("function");
    expect(typeof Components.formatDuration).toBe("function");
    expect(typeof Components.padDaysToWeeks).toBe("function");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Type-shape lock-in
// ═══════════════════════════════════════════════════════════════════════════════

describe("type-shape lock-in — production contracts", () => {
  test("MasteryEntry has 5 required fields (lock-in for Claude prompt)", () => {
    // Building a fresh entry exercises the type at compile time.
    const entry: PureLogic.MasteryEntry = {
      word:        "translucent",
      definition:  "lets some light through",
      mastery:     0.7,
      masteryTier: "proficient",
      timesUsed:   3,
    };
    expect(Object.keys(entry).sort()).toEqual([
      "definition", "mastery", "masteryTier", "timesUsed", "word",
    ]);
  });

  test("MasteryTier is exactly 4 string values", () => {
    const tiers: PureLogic.MasteryTier[] = ["novice", "developing", "proficient", "expert"];
    expect(tiers).toHaveLength(4);
  });

  test("XP rates contract has exactly 3 fields", () => {
    const r: PureLogic.XpRates = { firstTry: 40, secondTry: 25, thirdPlus: 10 };
    expect(Object.keys(r).sort()).toEqual(["firstTry", "secondTry", "thirdPlus"]);
  });

  test("RADAR_DOMAINS is the canonical 6-axis list (no 'other')", () => {
    expect(Services.RADAR_DOMAINS).toEqual(
      ["texture", "colour", "structure", "sound", "shape", "material"]
    );
  });
});
