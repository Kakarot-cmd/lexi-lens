/**
 * components/Lumi/LumiHUD.tsx
 *
 * High-level Lumi wrapper used by every screen.
 *
 * ─── KILL SWITCH ──────────────────────────────────────────────────────────────
 * Flip LUMI_ENABLED to false to disable Lumi globally without removing any
 * <LumiHUD /> JSX from screens. Use this to isolate whether Lumi is the cause
 * of any crash:
 *   • LUMI_ENABLED = false → app behaves as if Lumi was never installed.
 *   • LUMI_ENABLED = true  → safe Lumi (no animated SVG) renders.
 *
 * Once you've confirmed the app is stable with the safe rewrite, you can leave
 * this true permanently or wire it to a feature flag.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { LumiMascot } from './LumiMascot';
import type {
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
  defaultState: LumiState;
  position:     LumiPosition;
  size:         number;
}

const SCREEN_PRESETS: Record<LumiScreen, ScreenPreset> = {
  scan:               { defaultState: 'idle',          position: 'top-right',   size: 56 },
  'rate-limit':       { defaultState: 'out-of-juice',  position: 'top-center',  size: 96 },
  onboarding:         { defaultState: 'guide',         position: 'top-center',  size: 80 },
  victory:            { defaultState: 'cheering',      position: 'top-center',  size: 72 },
  'quest-map':        { defaultState: 'idle',          position: 'bottom-right',size: 48 },
  'spell-book':       { defaultState: 'idle',          position: 'bottom-right',size: 48 },
  'parent-dashboard': { defaultState: 'idle',          position: 'top-right',   size: 44 },
  'child-switcher':   { defaultState: 'idle',          position: 'top-right',   size: 56 },
};

export type LumiEvaluationStatus =
  | 'idle'
  | 'converting'
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
  muted?:               boolean;
  hidden?:              boolean;
  zIndex?:              number;
}

export function LumiHUD(props: LumiHUDProps): React.ReactElement | null {
  // ── Kill switch — render nothing if disabled. Hook order is preserved
  //    because we still call all hooks below before any early return.
  const {
    screen,
    evaluationStatus,
    hardMode          = false,
    dailyLimitReached = false,
    failureStreak     = 0,
    message,
    position,
    size,
    muted             = false,
    hidden            = false,
    zIndex            = 100,
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
    if (evaluationStatus === 'converting' || evaluationStatus === 'evaluating') {
      return 'scanning';
    }
    if (evaluationStatus === 'rate_limited') return 'out-of-juice';
    if (failureStreak >= 3) return 'boss-help';
    return preset.defaultState;
  }, [dailyLimitReached, transient, evaluationStatus, failureStreak, preset.defaultState]);

  if (!LUMI_ENABLED) return null;
  if (hidden) return null;

  return (
    <LumiMascot
      state={resolvedState}
      hardMode={hardMode}
      message={message}
      position={position    ?? preset.position}
      size={size            ?? preset.size}
      muted={muted}
      zIndex={zIndex}
    />
  );
}
