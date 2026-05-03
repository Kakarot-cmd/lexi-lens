/**
 * victoryFusion.ts — pure-logic extract of components/VictoryFusionScreen.tsx
 *
 * Animation orchestration, theming, particle math — extracted as standalone
 * functions so we can test the logic without instantiating the React tree
 * (which would require mocking Reanimated, Lottie, Haptics, and RN itself).
 */

// ─── Theme constants (verbatim) ───────────────────────────────────────────────

export const THEME_NORMAL = {
  bg:         "#052e16",
  burst:      "rgba(34,197,94,0.35)",
  weapon:     "⚔️",
  trophy:     "🏆",
  xpColor:    "#22c55e",
  xpBg:       "rgba(34,197,94,0.15)",
  xpBorder:   "#166534",
  titleColor: "#d1fae5",
  subColor:   "#6ee7b7",
  wordBg:     "rgba(255,255,255,0.05)",
  wordColor:  "#d1fae5",
  objColor:   "#6ee7b7",
  learnedClr: "#4ade80",
  btnBg:      "#22c55e",
  btnText:    "#052e16",
} as const;

export const THEME_HARD = {
  bg:         "#1a0505",
  burst:      "rgba(239,68,68,0.35)",
  weapon:     "🗡️",
  trophy:     "👑",
  xpColor:    "#fca5a5",
  xpBg:       "rgba(127,29,29,0.25)",
  xpBorder:   "#7f1d1d",
  titleColor: "#fca5a5",
  subColor:   "#fda4af",
  wordBg:     "rgba(127,29,29,0.2)",
  wordColor:  "#fca5a5",
  objColor:   "#fda4af",
  learnedClr: "#fda4af",
  btnBg:      "#991b1b",
  btnText:    "#fff",
} as const;

export type Theme = typeof THEME_NORMAL | typeof THEME_HARD;

export function selectTheme(isHardMode: boolean): Theme {
  return isHardMode ? THEME_HARD : THEME_NORMAL;
}

// ─── Particle layout (verbatim) ───────────────────────────────────────────────

const W = 360; // representative — tests don't depend on actual screen
const H = 800;

export const PARTICLE_ORIGINS = [
  { x: -W * 0.35, y: -H * 0.22 },
  { x:  W * 0.35, y: -H * 0.22 },
  { x: -W * 0.38, y:  H * 0.08 },
  { x:  W * 0.38, y:  H * 0.08 },
  { x:  0,        y: -H * 0.30 },
];

export const OBJECT_EMOJIS = ["🔮", "💎", "🪨", "🌿", "🕯️"];

export const MAX_PARTICLES = 5;

export function clampParticleCount(componentCount: number): number {
  return Math.min(componentCount, MAX_PARTICLES);
}

// ─── Cascade timing (verbatim from useEffect) ─────────────────────────────────
//
// When all particles have landed:
//   t+0    → burst flash + heavy haptic
//   t+200  → weapon drops
//   t+600  → enemy explodes + success haptic
//   t+1100 → content scrolls in
//
// Plus the per-particle stagger:
//   particle i delay = i * 120

export const CASCADE_DELAYS = {
  weapon:  200,
  explode: 600,
  content: 1100,
} as const;

export const PARTICLE_STAGGER_MS = 120;

export function particleDelay(index: number): number {
  return index * PARTICLE_STAGGER_MS;
}

// ─── Cascade orchestrator — extracted from the useEffect body ────────────────

export interface CascadeCallbacks {
  setBurstTriggered:   (v: boolean) => void;
  setWeaponTriggered:  (v: boolean) => void;
  setExplodeTriggered: (v: boolean) => void;
  setShowContent:      (v: boolean) => void;
  hapticHeavy:         () => void;
  hapticSuccess:       () => void;
  setTimeout:          (cb: () => void, ms: number) => unknown;
}

/**
 * triggerVictoryCascade — verbatim extraction of the gating + sequencing
 * logic from the VictoryFusionScreen useEffect.
 */
export function triggerVictoryCascade(
  landedCount:    number,
  particleCount:  number,
  cb:             CascadeCallbacks
): boolean {
  if (particleCount <= 0) return false;
  if (landedCount < particleCount) return false;

  cb.setBurstTriggered(true);
  cb.hapticHeavy();

  cb.setTimeout(() => cb.setWeaponTriggered(true), CASCADE_DELAYS.weapon);

  cb.setTimeout(() => {
    cb.setExplodeTriggered(true);
    cb.hapticSuccess();
  }, CASCADE_DELAYS.explode);

  cb.setTimeout(() => cb.setShowContent(true), CASCADE_DELAYS.content);

  return true;
}

// ─── Lottie mount gate (extracted from the bug-fix conditional render) ───────
//
// Production fix: previously Lottie rendered always with autoPlay={trigger}.
// autoPlay is evaluated once on mount, so it never started. Fix is to
// conditionally render the component so it mounts when triggered.

export function shouldRenderLottie(weaponTriggered: boolean): boolean {
  return weaponTriggered;
}

// ─── Title text logic (small, but documented) ────────────────────────────────

export function getTitleText(isHardMode: boolean): string {
  return isHardMode ? "Hard mode cleared!" : "Dungeon cleared!";
}

export function getSubTitleText(enemyName: string, isHardMode: boolean): string {
  return `${enemyName} defeated${isHardMode ? " (Hard Mode)" : ""}`;
}
