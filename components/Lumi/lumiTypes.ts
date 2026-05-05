/**
 * components/Lumi/lumiTypes.ts
 *
 * Lumi — Lexi-Lens mascot.
 * Core types: state machine, props, theme tokens.
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
  | 'idle'         // gentle bob — anywhere, ambient
  | 'guide'        // points + speaks (onboarding, first-time use)
  | 'scanning'     // orbits scan target, glitter trail, eyes wide
  | 'success'      // happy wiggle + glitter burst (after match)
  | 'fail'         // gentle tilt, no glitter, encouraging quote
  | 'boss-help'    // hint mid-quest after failed attempts
  | 'out-of-juice' // asleep / dim / drooping — rate-limit state
  | 'cheering';    // big victory motion — overlay during VictoryFusionScreen

// ─── Quote intents ────────────────────────────────────────────────────────────

export type QuoteIntent =
  | 'greeting'        // first open of the day
  | 'onboarding'      // first-time user explainer
  | 'scanning'        // while ML Kit + Claude evaluate
  | 'success-match'   // verdict matched
  | 'success-partial' // verdict partial match
  | 'fail-mismatch'   // verdict no match
  | 'boss-hint'       // stuck, needs a nudge
  | 'rate-limit'      // out of magic for the day
  | 'victory'         // quest complete
  | 'idle-flavor';    // occasional ambient line

// ─── Position presets ─────────────────────────────────────────────────────────

export type LumiPosition =
  | 'top-left'
  | 'top-right'
  | 'top-center'
  | 'bottom-left'
  | 'bottom-right'
  | 'center'
  | 'free';

// ─── Theme variants ───────────────────────────────────────────────────────────

export type LumiTheme = 'normal' | 'hard-mode' | 'sleeping';

export interface LumiThemeTokens {
  bodyHighlight:  string;  // inner radial gradient stop 0
  bodyShadow:     string;  // inner radial gradient stop 1
  glow:           string;  // outer halo color
  trail:          string;  // glitter particle color
  star:           string;  // top antenna star
  hasCrown:       boolean; // hard-mode crown overlay
}

// ─── Lumi props ───────────────────────────────────────────────────────────────

export interface LumiMascotProps {
  state?:         LumiState;
  /** Override the default quote for this state. Empty string hides the bubble. */
  message?:       string;
  /** Hard-mode quest? Switches to red/crown variant. */
  hardMode?:      boolean;
  /** Pixel size of the mascot body (halo extends ~30% beyond). Default 64. */
  size?:          number;
  /** Position preset. Use 'free' with freePosition for custom placement. */
  position?:      LumiPosition;
  freePosition?:  { x: number; y: number };
  /** Override trail visibility. Default: on for active states only. */
  showTrail?:     boolean;
  /** Tap handler. Honor this to let kids interact (e.g. trigger a fresh quote). */
  onTap?:         () => void;
  /** Hide all speech bubbles for this session. */
  muted?:         boolean;
  /** Override Reduce Motion auto-detect. */
  reduceMotion?:  boolean;
  /** Padding from safe-area edges when using a position preset. Default 16. */
  edgeInset?:     number;
  /** zIndex / elevation. Default 100 (above content, below modals). */
  zIndex?:        number;
}

// ─── Internal: animation profile per state ────────────────────────────────────

export interface LumiAnimationProfile {
  bobAmplitude:    number;   // px, vertical idle bob
  bobDurationMs:   number;
  wingFlapRateHz:  number;
  orbitRadius:     number;   // px, used in 'scanning' & 'cheering'
  orbitSpeedRpm:   number;
  blinkChance:     number;   // 0–1 per second
  trailEnabled:    boolean;
  trailRateMs:     number;   // particle spawn interval
  scaleBase:       number;   // 1.0 = full size; 0.85 = sleepy/small
  glowIntensity:   number;   // 0–1
}

// ─── Default theme tokens ─────────────────────────────────────────────────────

export const LUMI_THEMES: Record<LumiTheme, LumiThemeTokens> = {
  normal: {
    bodyHighlight: '#f3e8ff',
    bodyShadow:    '#b794f6',
    glow:          '#f5c842',
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
};
