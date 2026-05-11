/**
 * components/Lumi/LumiHUD.tsx — v2
 *
 * High-level Lumi wrapper used by every screen. Auto-derives state, position,
 * size, AND now movement + rainbow from per-screen presets.
 *
 * v2 additions:
 *   • `movement` prop — 'anchor' | 'wander' | 'drift'. Per-screen defaults.
 *   • `rainbow`  prop — boolean. Per-screen defaults.
 *
 * ─── KILL SWITCH ──────────────────────────────────────────────────────────────
 * Flip LUMI_ENABLED to false to disable Lumi globally without touching screens.
 *   • LUMI_ENABLED = false → app behaves as if Lumi was never installed.
 *   • LUMI_ENABLED = true  → safe Lumi v2 renders.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { LumiMascot } from './LumiMascot';
import type {
  LumiMovementMode,
  LumiPosition,
  LumiState,
} from './lumiTypes';

const LUMI_ENABLED = true; // ← FLIP TO false TO DISABLE LUMI ENTIRELY

const HOLD_MS = 1400;

// ─── Screen presets ───────────────────────────────────────────────────────────

export type LumiScreen =
  | 'scan'
  | 'rate-limit'
  | 'onboarding'
  | 'victory'
  | 'quest-map'
  | 'spell-book'
  | 'parent-dashboard'
  | 'child-switcher';

interface ScreenPreset {
  defaultState:    LumiState;
  position:        LumiPosition;
  size:            number;
  movement:        LumiMovementMode;
  rainbow:         boolean;
}

// Preset table — picks per-screen defaults that balance playfulness with
// not-blocking-content. Every preset can be overridden per-call.
const SCREEN_PRESETS: Record<LumiScreen, ScreenPreset> = {
  // Scan: anchored at top-right so she never blocks the camera viewfinder.
  scan:               { defaultState: 'idle',          position: 'top-right',    size: 56, movement: 'anchor', rainbow: false },

  // Rate-limit: anchored centre, sleeping sparkle.
  'rate-limit':       { defaultState: 'out-of-juice',  position: 'top-center',   size: 96, movement: 'anchor', rainbow: false },

  // Onboarding: gentle horizontal drift to feel companionable while explaining.
  onboarding:         { defaultState: 'guide',         position: 'top-center',   size: 80, movement: 'drift',  rainbow: false },

  // Victory: anchored centre — VictoryFusionScreen has its own celebration burst,
  // so Lumi just hovers and cheers without travelling.
  victory:            { defaultState: 'cheering',      position: 'top-center',   size: 72, movement: 'anchor', rainbow: true  },

  // Quest map: full wander figure-8 in upper portion + rainbow theme.
  // This is where the playful brand presence lives.
  'quest-map':        { defaultState: 'idle',          position: 'top-center',   size: 56, movement: 'wander', rainbow: true  },

  // Spell book / Parent / Child: subtle anchored corners.
  'spell-book':       { defaultState: 'idle',          position: 'bottom-right', size: 48, movement: 'anchor', rainbow: false },
  'parent-dashboard': { defaultState: 'idle',          position: 'top-right',    size: 44, movement: 'anchor', rainbow: false },
  'child-switcher':   { defaultState: 'idle',          position: 'top-right',    size: 56, movement: 'anchor', rainbow: false },
};

export type LumiEvaluationStatus =
  | 'idle'
  | 'converting'
  | 'looking-up'   // v6.2 Phase 2 — CC1 in flight
  | 'evaluating'
  | 'match'
  | 'no-match'
  | 'rate_limited'
  | 'error';

export interface LumiHUDProps {
  screen:               LumiScreen;
  evaluationStatus?:    LumiEvaluationStatus;
  hardMode?:            boolean;
  dailyLimitReached?:   boolean;
  failureStreak?:       number;
  message?:             string;
  position?:            LumiPosition;
  size?:                number;
  /** v2: override the screen's default movement mode. */
  movement?:            LumiMovementMode;
  /** v2: override the screen's default rainbow flag. */
  rainbow?:             boolean;
  muted?:               boolean;
  hidden?:              boolean;
  zIndex?:              number;
  /**
   * v6.5 — when set with movement='orbit-reticle', Lumi orbits this
   * screen-coord center at the active state's orbitRadius / orbitSpeedRpm.
   */
  reticleCenter?:       { x: number; y: number };
}

export function LumiHUD(props: LumiHUDProps): React.ReactElement | null {
  const {
    screen,
    evaluationStatus,
    hardMode          = false,
    dailyLimitReached = false,
    failureStreak     = 0,
    message,
    position,
    size,
    movement,
    rainbow,
    muted             = false,
    hidden            = false,
    zIndex            = 100,
    reticleCenter,
  } = props;

  const preset = SCREEN_PRESETS[screen];

  const [transient, setTransient] = useState<LumiState | null>(null);

  useEffect(() => {
    if (!evaluationStatus) return;
    if (evaluationStatus === 'match') {
      setTransient('success');
    } else if (evaluationStatus === 'no-match' || evaluationStatus === 'error') {
      setTransient('fail');
    }
  }, [evaluationStatus]);

  useEffect(() => {
    if (transient === null) return;
    const id = setTimeout(() => setTransient(null), HOLD_MS);
    return () => clearTimeout(id);
  }, [transient]);

  const resolvedState = useMemo<LumiState>(() => {
    if (dailyLimitReached) return 'out-of-juice';
    if (transient) return transient;
    // v6.2 Phase 2 — looking-up gets its own LumiState (different quote
    // pool, same animation). The 'converting' | 'evaluating' beats both
    // still collapse to 'scanning' as before.
    if (evaluationStatus === 'looking-up') return 'looking-up';
    if (evaluationStatus === 'converting' || evaluationStatus === 'evaluating') {
      return 'scanning';
    }
    if (evaluationStatus === 'rate_limited') return 'out-of-juice';
    if (failureStreak >= 3) return 'boss-help';
    return preset.defaultState;
  }, [dailyLimitReached, transient, evaluationStatus, failureStreak, preset.defaultState]);

  // Hard-mode forces anchor for wander/drift so kids see the crown clearly
  // without it darting across the screen. 'orbit-reticle' is exempt — the
  // orbit stays bounded inside the viewfinder, the crown stays readable, and
  // a spinning red Lumi reinforces "this quest is intense".
  const requestedMovement: LumiMovementMode = movement ?? preset.movement;
  const resolvedMovement: LumiMovementMode =
    hardMode && requestedMovement !== 'orbit-reticle' ? 'anchor' : requestedMovement;

  // Hard-mode also forces non-rainbow (red crown is the brand cue)
  const resolvedRainbow = hardMode ? false : (rainbow ?? preset.rainbow);

  if (!LUMI_ENABLED) return null;
  if (hidden) return null;

  return (
    <LumiMascot
      state={resolvedState}
      hardMode={hardMode}
      message={message}
      position={position    ?? preset.position}
      size={size            ?? preset.size}
      movement={resolvedMovement}
      rainbow={resolvedRainbow}
      muted={muted}
      zIndex={zIndex}
      freePosition={reticleCenter}
    />
  );
}
