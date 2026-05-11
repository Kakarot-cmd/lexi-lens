/**
 * components/Lumi/lumiTypes.ts
 *
 * Lumi — Lexi-Lens mascot.
 * Core types: state machine, props, theme tokens, movement modes.
 *
 * v2 additions:
 *   • 'rainbow' theme tokens — full-color party variant
 *   • RAINBOW_PALETTE — 6 hues used for body color-cycling and trail
 *   • LumiMovementMode — 'anchor' (sits in corner) | 'wander' (figure-8)
 *
 * State machine philosophy:
 *   • Each state maps to a distinct animation profile + quote pool.
 *   • Transitions are driven by parent (ScanScreen, RateLimitWall, etc.).
 *   • No global state — Lumi is a presentational component.
 *
 * Lumi never blocks input. She is decorative + emotional, never functional.
 */

// ─── State machine ────────────────────────────────────────────────────────────

export type LumiState =
  | 'idle'
  | 'guide'
  | 'scanning'
  | 'looking-up'   // v6.2 Phase 2 — CC1 in flight; reuses scanning visuals
  | 'success'
  | 'fail'
  | 'boss-help'
  | 'out-of-juice'
  | 'cheering';

// ─── Quote intents ────────────────────────────────────────────────────────────

export type QuoteIntent =
  | 'greeting'
  | 'onboarding'
  | 'scanning'
  | 'looking-up'   // v6.2 Phase 2 — paired with looking-up state
  | 'success-match'
  | 'success-partial'
  | 'fail-mismatch'
  | 'boss-hint'
  | 'rate-limit'
  | 'victory'
  | 'idle-flavor';

// ─── Position presets ─────────────────────────────────────────────────────────

export type LumiPosition =
  | 'top-left'
  | 'top-right'
  | 'top-center'
  | 'bottom-left'
  | 'bottom-right'
  | 'center'
  | 'free';

// ─── Movement modes (v2) ──────────────────────────────────────────────────────

export type LumiMovementMode =
  | 'anchor'       // stay at preset position (original behavior)
  | 'wander'       // smooth figure-8 across upper portion of screen
  | 'drift'        // gentle horizontal drift along an edge
  | 'orbit-reticle'; // v6.5 — orbit a screen-coord center (freePosition) at
                   //         orbitRadius / orbitSpeedRpm from the active
                   //         state profile. Used during scan-evaluation.

// ─── Theme variants ───────────────────────────────────────────────────────────

export type LumiTheme = 'normal' | 'hard-mode' | 'sleeping' | 'rainbow';

export interface LumiThemeTokens {
  bodyHighlight:  string;
  bodyShadow:     string;
  glow:           string;
  trail:          string;
  star:           string;
  hasCrown:       boolean;
}

// ─── Lumi props ───────────────────────────────────────────────────────────────

export interface LumiMascotProps {
  state?:         LumiState;
  /** Override the default quote for this state. Empty string hides the bubble. */
  message?:       string;
  /** Hard-mode quest? Switches to red/crown variant. */
  hardMode?:      boolean;
  /** Pixel size of the mascot body. Default 64. */
  size?:          number;
  /** Position preset. Use 'free' with freePosition for custom placement. */
  position?:      LumiPosition;
  freePosition?:  { x: number; y: number };
  /** v2: How Lumi moves around the screen. Default 'anchor'. */
  movement?:      LumiMovementMode;
  /** Override trail visibility. */
  showTrail?:     boolean;
  /** v2: Use the rainbow theme regardless of hardMode/state. Default false. */
  rainbow?:       boolean;
  /** Tap handler. */
  onTap?:         () => void;
  /** Hide speech bubbles for this session. */
  muted?:         boolean;
  /** Override Reduce Motion. */
  reduceMotion?:  boolean;
  /** Padding from safe-area edges when using a position preset. Default 16. */
  edgeInset?:     number;
  /** zIndex / elevation. Default 100. */
  zIndex?:        number;
}

// ─── Internal: animation profile per state ────────────────────────────────────

export interface LumiAnimationProfile {
  bobAmplitude:    number;
  bobDurationMs:   number;
  wingFlapRateHz:  number;
  orbitRadius:     number;
  orbitSpeedRpm:   number;
  blinkChance:     number;
  trailEnabled:    boolean;
  trailRateMs:     number;
  scaleBase:       number;
  glowIntensity:   number;
}

// ─── Default theme tokens ─────────────────────────────────────────────────────

export const LUMI_THEMES: Record<LumiTheme, LumiThemeTokens> = {
  normal: {
    bodyHighlight: '#fef3c7',
    bodyShadow:    '#a78bfa',
    glow:          '#fde68a',
    trail:         '#fde68a',
    star:          '#f5c842',
    hasCrown:      false,
  },
  'hard-mode': {
    bodyHighlight: '#fee2e2',
    bodyShadow:    '#dc2626',
    glow:          '#fbbf24',
    trail:         '#fecaca',
    star:          '#fbbf24',
    hasCrown:      true,
  },
  sleeping: {
    bodyHighlight: '#e2e8f0',
    bodyShadow:    '#64748b',
    glow:          '#475569',
    trail:         '#cbd5e1',
    star:          '#94a3b8',
    hasCrown:      false,
  },
  // v2: rainbow tokens — actual cycling colors driven by RAINBOW_PALETTE
  // and a slow React-state timer in LumiMascot.
  rainbow: {
    bodyHighlight: '#fef3c7',
    bodyShadow:    '#ec4899',
    glow:          '#fbbf24',
    trail:         '#a78bfa',
    star:          '#fbbf24',
    hasCrown:      false,
  },
};

// ─── Rainbow palette (v2) ─────────────────────────────────────────────────────

export const RAINBOW_PALETTE = [
  '#ef4444',  // red
  '#f97316',  // orange
  '#facc15',  // yellow
  '#22c55e',  // green
  '#3b82f6',  // blue
  '#a855f7',  // purple
] as const;

export const RAINBOW_HIGHLIGHT_PALETTE = [
  '#fecaca',
  '#fed7aa',
  '#fef08a',
  '#bbf7d0',
  '#bfdbfe',
  '#e9d5ff',
] as const;

export const SPARKLE_PALETTE = [
  '#fde68a',
  '#fbcfe8',
  '#bfdbfe',
  '#bbf7d0',
] as const;
