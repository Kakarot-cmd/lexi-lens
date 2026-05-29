/**
 * components/Lumi/lumiRiveConfig.ts
 *
 * Single source of truth for the Rive-backed Lumi body.
 *
 * ─── How this slots into the existing module ────────────────────────────────
 *
 *   LumiMascot.tsx  (orchestrator — unchanged behaviour)
 *      └─► LumiBody.tsx  (NEW dispatcher)
 *             ├─► LumiBodyRive.tsx   when LUMI_RIVE_ENABLED && asset loads OK
 *             └─► LumiBodySvg.tsx    fallback (the original procedural body)
 *
 * Public LumiBodyProps interface is unchanged. Adding the Rive backend does
 * NOT require touching LumiHUD, LumiMascot animation profiles, lumiQuotes,
 * lumiSounds, or anything in screens/*.
 *
 * ─── How to flip the switch ─────────────────────────────────────────────────
 *
 *   1. Drop  `assets/lumi/lumi.riv`  into the repo.
 *   2. Set   `LUMI_RIVE_ENABLED = true`   below.
 *   3. Rebuild the client (`rive-react-native` is a native module → NOT OTA).
 *      iOS: follow docs/iOS_LOCAL_TESTFLIGHT_RUNBOOK.md
 *      Android: `build-android.cmd staging`  (after `expo prebuild --clean`
 *      and re-applying the 4 Xcode/Gradle sharp-edges per project memory)
 *
 * If `LUMI_RIVE_ENABLED = true` but the asset fails to load at runtime
 * (decode error, missing file, native module crash), LumiBodyRive falls back
 * to the SVG body automatically. The app keeps working.
 */

import type { LumiTheme } from './lumiTypes';
import type { LumiMood }  from './LumiBodySvg';

// ─── Master toggle ────────────────────────────────────────────────────────────

/**
 * Compile-time master toggle.
 *
 * Default `false` so dropping these files into the repo does NOT change app
 * behaviour. Flip to `true` only when the .riv file is present AND the next
 * client build is going out.
 *
 * Do NOT gate this with `__DEV__` — the new Lumi must render identically in
 * dev and prod. Gate with a feature flag in Supabase if you want runtime
 * control (not implemented here — keep it static for first ship).
 */
export const LUMI_RIVE_ENABLED = true;

// ─── Asset locator ────────────────────────────────────────────────────────────

/**
 * Resolves to a Metro module id when the file exists. The require is lazy
 * inside LumiBodyRive (wrapped in a try) so a missing file does NOT crash
 * the bundler — it just falls back to SVG.
 *
 * Place the file at  `assets/lumi/lumi.riv`  (path is relative to this file
 * because that's where the require() lives in LumiBodyRive).
 */
export const LUMI_RIVE_ASSET_REL_PATH = '../../assets/lumi/lumi.riv';

// ─── Rive state machine contract ──────────────────────────────────────────────
//
// The .riv file MUST export one artboard and one state machine matching the
// names below. The animator works from assets/lumi/LUMI_RIVE_SPEC.md, which
// pins the contract verbatim.

export const RIVE_ARTBOARD_NAME      = 'Lumi';
export const RIVE_STATE_MACHINE_NAME = 'LumiSM';

/**
 * Number-typed inputs (Rive supports Number / Boolean / Trigger).
 * Both are written from React props on every render — Rive de-dupes
 * no-op writes internally.
 */
export const RIVE_INPUT = {
  /** 0..5 — drives pose + face expression. See LUMI_MOOD_INDEX. */
  moodIndex:      'moodIndex',
  /** 0..3 — drives palette + crown. See LUMI_THEME_INDEX. */
  themeIndex:     'themeIndex',
  /** 0..8 — finer-grained state for animators who want richer behaviour
   *  (e.g. distinguish `scanning` from `looking-up`, both `curious` mood).
   *  See LUMI_STATE_INDEX. Optional — animators can ignore and read mood. */
  stateIndex:     'stateIndex',
  /** Boolean — when true, Rive should freeze hover/flap loops and just show
   *  a static pose. Driven by AccessibilityInfo.isReduceMotionEnabled(). */
  reducedMotion:  'reducedMotion',
  /** Number 0..5 — rainbow palette tick. Only meaningful when
   *  themeIndex == 3 (rainbow). LumiMascot drives this via a slow timer. */
  colorTick:      'colorTick',
} as const;

// ─── Prop → Rive-input index maps ─────────────────────────────────────────────
//
// Order MUST match the Rive file. The animator references these numbers in
// the state machine's "if-then" conditions. Changing this order means
// re-keying the .riv file.

export const LUMI_MOOD_INDEX: Record<LumiMood, number> = {
  happy:     0,
  curious:   1,
  excited:   2,
  thinking:  3,
  sad:       4,
  sleeping:  5,
};

export const LUMI_THEME_INDEX: Record<LumiTheme, number> = {
  normal:      0,
  'hard-mode': 1,
  sleeping:    2,
  rainbow:     3,
};

// Note: kept as an explicit string union (not imported from lumiTypes) to
// avoid a cycle if you ever extend the state set. Keep this in sync by hand.
export const LUMI_STATE_INDEX: Record<string, number> = {
  idle:           0,
  guide:          1,
  scanning:       2,
  'looking-up':   3,
  success:        4,
  fail:           5,
  'boss-help':    6,
  'out-of-juice': 7,
  cheering:       8,
};
