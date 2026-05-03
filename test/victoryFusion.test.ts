/**
 * victoryFusion.test.ts
 * Chunk 6 — VictoryFusionScreen pure logic
 *
 * Coverage:
 *   1. selectTheme              — hard vs normal, theme integrity
 *   2. clampParticleCount       — max 5
 *   3. PARTICLE_ORIGINS         — 5 distinct positions
 *   4. particleDelay            — 120ms stagger
 *   5. triggerVictoryCascade    — gating, sequencing, haptics
 *   6. shouldRenderLottie       — the production bug-fix conditional
 *   7. getTitleText / getSubTitleText — hard mode prefix
 *   8. THEME_HARD vs THEME_NORMAL — visual differentiation lock-in
 */

import {
  THEME_NORMAL,
  THEME_HARD,
  selectTheme,
  clampParticleCount,
  MAX_PARTICLES,
  PARTICLE_ORIGINS,
  PARTICLE_STAGGER_MS,
  particleDelay,
  CASCADE_DELAYS,
  triggerVictoryCascade,
  shouldRenderLottie,
  getTitleText,
  getSubTitleText,
} from "./victoryFusion";

// ═══════════════════════════════════════════════════════════════════════════════
// 1. selectTheme
// ═══════════════════════════════════════════════════════════════════════════════

describe("selectTheme", () => {
  test("isHardMode=true returns hard theme (red/crown)", () => {
    expect(selectTheme(true)).toBe(THEME_HARD);
    expect(selectTheme(true).trophy).toBe("👑");
    expect(selectTheme(true).weapon).toBe("🗡️");
  });

  test("isHardMode=false returns normal theme (green/trophy)", () => {
    expect(selectTheme(false)).toBe(THEME_NORMAL);
    expect(selectTheme(false).trophy).toBe("🏆");
    expect(selectTheme(false).weapon).toBe("⚔️");
  });

  test("hard theme uses red palette (background)", () => {
    expect(THEME_HARD.bg).toBe("#1a0505");
    expect(THEME_HARD.btnBg).toBe("#991b1b");
  });

  test("normal theme uses green palette (background)", () => {
    expect(THEME_NORMAL.bg).toBe("#052e16");
    expect(THEME_NORMAL.btnBg).toBe("#22c55e");
  });

  test("themes have identical key sets — drop-in compatible", () => {
    const normalKeys = Object.keys(THEME_NORMAL).sort();
    const hardKeys   = Object.keys(THEME_HARD).sort();
    expect(normalKeys).toEqual(hardKeys);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. clampParticleCount
// ═══════════════════════════════════════════════════════════════════════════════

describe("clampParticleCount", () => {
  test("MAX_PARTICLES is 5 (matches PARTICLE_ORIGINS length)", () => {
    expect(MAX_PARTICLES).toBe(5);
    expect(PARTICLE_ORIGINS).toHaveLength(MAX_PARTICLES);
  });

  test("clamps to MAX_PARTICLES when components > 5", () => {
    expect(clampParticleCount(7)).toBe(5);
    expect(clampParticleCount(100)).toBe(5);
  });

  test("returns count when components <= 5", () => {
    expect(clampParticleCount(0)).toBe(0);
    expect(clampParticleCount(1)).toBe(1);
    expect(clampParticleCount(5)).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. PARTICLE_ORIGINS
// ═══════════════════════════════════════════════════════════════════════════════

describe("PARTICLE_ORIGINS", () => {
  test("all 5 positions are distinct", () => {
    const seen = new Set(PARTICLE_ORIGINS.map((p) => `${p.x},${p.y}`));
    expect(seen.size).toBe(5);
  });

  test("origins span both above and below screen centre (visual variety)", () => {
    const above = PARTICLE_ORIGINS.filter((p) => p.y < 0);
    const below = PARTICLE_ORIGINS.filter((p) => p.y >= 0);
    expect(above.length).toBeGreaterThan(0);
    expect(below.length).toBeGreaterThan(0);
  });

  test("origins include left, right, and centre x positions", () => {
    expect(PARTICLE_ORIGINS.some((p) => p.x < 0)).toBe(true);
    expect(PARTICLE_ORIGINS.some((p) => p.x > 0)).toBe(true);
    expect(PARTICLE_ORIGINS.some((p) => p.x === 0)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. particleDelay (120ms stagger)
// ═══════════════════════════════════════════════════════════════════════════════

describe("particleDelay — staggered launch", () => {
  test("PARTICLE_STAGGER_MS is 120", () => {
    expect(PARTICLE_STAGGER_MS).toBe(120);
  });

  test("first particle has 0ms delay", () => {
    expect(particleDelay(0)).toBe(0);
  });

  test("each subsequent particle adds 120ms", () => {
    expect(particleDelay(1)).toBe(120);
    expect(particleDelay(2)).toBe(240);
    expect(particleDelay(4)).toBe(480);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. triggerVictoryCascade — the heart of the animation orchestration
// ═══════════════════════════════════════════════════════════════════════════════

describe("triggerVictoryCascade", () => {
  function makeCallbacks() {
    const calls = {
      burst:   [] as boolean[],
      weapon:  [] as boolean[],
      explode: [] as boolean[],
      content: [] as boolean[],
      hapticH: 0,
      hapticS: 0,
      timeouts: [] as Array<{ cb: () => void; ms: number }>,
    };
    const cb = {
      setBurstTriggered:   (v: boolean) => calls.burst.push(v),
      setWeaponTriggered:  (v: boolean) => calls.weapon.push(v),
      setExplodeTriggered: (v: boolean) => calls.explode.push(v),
      setShowContent:      (v: boolean) => calls.content.push(v),
      hapticHeavy:         () => { calls.hapticH += 1; },
      hapticSuccess:       () => { calls.hapticS += 1; },
      setTimeout:          ((fn: () => void, ms: number) => {
        calls.timeouts.push({ cb: fn, ms });
        return 1;
      }) as CascadeCallbacks["setTimeout"],
    };
    return { calls, cb };
  }

  test("does NOT fire when particles haven't all landed", () => {
    const { calls, cb } = makeCallbacks();
    const fired = triggerVictoryCascade(2, 5, cb as any);
    expect(fired).toBe(false);
    expect(calls.burst).toEqual([]);
    expect(calls.timeouts).toHaveLength(0);
  });

  test("does NOT fire when particleCount is 0 (defensive)", () => {
    const { calls, cb } = makeCallbacks();
    const fired = triggerVictoryCascade(0, 0, cb as any);
    expect(fired).toBe(false);
    expect(calls.burst).toEqual([]);
  });

  test("fires when all particles have landed", () => {
    const { calls, cb } = makeCallbacks();
    const fired = triggerVictoryCascade(5, 5, cb as any);
    expect(fired).toBe(true);
    expect(calls.burst).toEqual([true]);
    expect(calls.hapticH).toBe(1);
  });

  test("fires when MORE particles landed than expected (>= guard)", () => {
    const { cb } = makeCallbacks();
    expect(triggerVictoryCascade(6, 5, cb as any)).toBe(true);
  });

  test("schedules 3 timeouts at the documented delays (200/600/1100)", () => {
    const { calls, cb } = makeCallbacks();
    triggerVictoryCascade(5, 5, cb as any);
    const delays = calls.timeouts.map((t) => t.ms).sort((a, b) => a - b);
    expect(delays).toEqual([CASCADE_DELAYS.weapon, CASCADE_DELAYS.explode, CASCADE_DELAYS.content]);
    expect(delays).toEqual([200, 600, 1100]);
  });

  test("running the timeout callbacks fires the correct state setters and haptic", () => {
    const { calls, cb } = makeCallbacks();
    triggerVictoryCascade(5, 5, cb as any);
    // Run all queued callbacks in order of schedule
    calls.timeouts.sort((a, b) => a.ms - b.ms).forEach((t) => t.cb());

    expect(calls.weapon).toEqual([true]);
    expect(calls.explode).toEqual([true]);
    expect(calls.content).toEqual([true]);
    expect(calls.hapticS).toBe(1); // explode-time success haptic
  });

  test("burst happens BEFORE all of weapon/explode/content (synchronous)", () => {
    const { calls, cb } = makeCallbacks();
    triggerVictoryCascade(5, 5, cb as any);
    expect(calls.burst).toEqual([true]); // already true at this point
    expect(calls.weapon).toEqual([]);     // still queued in setTimeout
    expect(calls.explode).toEqual([]);
    expect(calls.content).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. shouldRenderLottie — the autoPlay bug-fix
// ═══════════════════════════════════════════════════════════════════════════════

describe("shouldRenderLottie — autoPlay bug-fix conditional render", () => {
  // Production bug: Lottie was always rendered with autoPlay={trigger}.
  // autoPlay is evaluated only on mount → it always saw `false` and never played.
  // Fix: conditionally render so the component mounts when trigger flips true.
  test("returns false until weapon is triggered", () => {
    expect(shouldRenderLottie(false)).toBe(false);
  });

  test("returns true once weapon is triggered (component mounts → autoPlay fires)", () => {
    expect(shouldRenderLottie(true)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Title / subtitle copy
// ═══════════════════════════════════════════════════════════════════════════════

describe("getTitleText / getSubTitleText", () => {
  test("normal mode title", () => {
    expect(getTitleText(false)).toBe("Dungeon cleared!");
  });

  test("hard mode title", () => {
    expect(getTitleText(true)).toBe("Hard mode cleared!");
  });

  test("subtitle includes enemy name and (Hard Mode) suffix when isHardMode", () => {
    expect(getSubTitleText("Goblin", false)).toBe("Goblin defeated");
    expect(getSubTitleText("Goblin", true)).toBe("Goblin defeated (Hard Mode)");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Theme differentiation lock-in (regression guard)
// ═══════════════════════════════════════════════════════════════════════════════

describe("THEME differentiation — visual lock-in", () => {
  test("the two themes differ on every key (no accidental overlap)", () => {
    const keys = Object.keys(THEME_NORMAL) as (keyof typeof THEME_NORMAL)[];
    for (const k of keys) {
      expect(THEME_NORMAL[k]).not.toEqual(THEME_HARD[k]);
    }
  });

  test("hard mode trophy emoji is 👑 (crown), not 🏆", () => {
    expect(THEME_HARD.trophy).toBe("👑");
  });

  test("hard mode weapon emoji is 🗡️ (dagger), not ⚔️", () => {
    expect(THEME_HARD.weapon).toBe("🗡️");
  });
});

// imported at top — declared here for the test harness type cast
type CascadeCallbacks = import("./victoryFusion").CascadeCallbacks;
