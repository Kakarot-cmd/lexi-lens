/**
 * utils/responsive.ts
 * Skanlore (Lexi-Lens) — Cross-device responsive primitives
 *
 * PURPOSE
 * ───────
 * One reactive source of truth for "how big is the screen right now, and how
 * should chrome adapt to it." Replaces the app's two competing habits:
 *
 *   • module-scope `const { width } = Dimensions.get('window')`  ← STALE.
 *     Captured once at import time. Wrong after rotation, fold/unfold,
 *     iPad split-view resize, or Android free-form multi-window.
 *
 *   • ad-hoc `useWindowDimensions()` calls with no shared breakpoints,
 *     no tablet rule, and no font-scale policy.
 *
 * Everything here is reactive (driven by useWindowDimensions) or pure, so a
 * layout that consumes it re-renders correctly when the window changes.
 *
 * DESIGN NOTES
 * ────────────
 *   • isTablet keys off the SHORTEST side, so a device stays "tablet" in
 *     both portrait and landscape (a 768pt-wide iPad rotated to landscape
 *     is still a tablet — width alone would misclassify it).
 *   • Font scale is CLAMPED, not frozen. A hard cap of 1.0 would break
 *     accessibility for low-vision parents on the parent-facing screens.
 *     We cap at 1.4 so chrome (fixed-height buttons, badges, card headers)
 *     stops clipping while large-text users still get meaningfully bigger
 *     copy. Body text that lives in a scroll view can opt out of the cap.
 *   • Touch-target minimums follow the platform guidelines: 44pt (Apple
 *     HIG) and 48dp (Material). Use MIN_TOUCH for any tappable control.
 *
 * USAGE
 * ─────
 *   const r = useResponsive();
 *   <View style={{ width: r.contentWidth, alignSelf: 'center' }} />        // tablet-centered column
 *   <Text maxFontSizeMultiplier={r.maxFontMultiplier}>{label}</Text>       // clipping-safe chrome
 *   <Pressable style={{ minHeight: MIN_TOUCH, minWidth: MIN_TOUCH }} />     // spec-compliant target
 *
 * This file has NO native dependency. It is safe to import anywhere and is a
 * no-op until a component actually reads from it.
 */

import { useMemo } from 'react';
import { useWindowDimensions, Platform } from 'react-native';

/* ── Breakpoints (dp) ──────────────────────────────────────────────────── */

/**
 * sw600dp is the long-standing Android tablet line and also cleanly separates
 * large phones (~430pt shortest side max) from small tablets (iPad mini's
 * shortest side is 744pt). Anything with a shortest side ≥ 600 gets the
 * centered, max-width treatment.
 */
export const TABLET_MIN_WIDTH = 600;

/* ── Centered-content width ────────────────────────────────────────────── */

/**
 * On phones a screen should fill the width. On tablets / iPad split-view a
 * full-bleed phone layout looks broken (buttons stretch the whole panel,
 * line lengths get unreadable). Clamp content columns to this width and
 * center them.
 */
export const CONTENT_MAX_WIDTH = 560;

/* ── Touch targets ─────────────────────────────────────────────────────── */

export const MIN_TOUCH_IOS = 44;       // Apple HIG
export const MIN_TOUCH_ANDROID = 48;   // Material Design

/** Platform-correct minimum tappable size. Use for both minWidth and minHeight. */
export const MIN_TOUCH: number = Platform.select({
  ios: MIN_TOUCH_IOS,
  android: MIN_TOUCH_ANDROID,
  default: MIN_TOUCH_IOS,
}) as number;

/* ── Font scaling ──────────────────────────────────────────────────────── */

/**
 * Upper bound for system font scaling on layout chrome. 1.4 keeps fixed-height
 * UI from clipping while still honoring large-text accessibility settings.
 * Pass to <Text maxFontSizeMultiplier> / <TextInput maxFontSizeMultiplier>.
 */
export const MAX_FONT_SCALE_CHROME = 1.4;

/** Clamp a raw system font scale to a safe ceiling. Guards against NaN/0. */
export function clampFontScale(scale: number, max: number = MAX_FONT_SCALE_CHROME): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(scale, max);
}

/* ── Hook ──────────────────────────────────────────────────────────────── */

export interface ResponsiveInfo {
  /** Live window width (dp). */
  width: number;
  /** Live window height (dp). */
  height: number;
  /** Shorter of width/height — the orientation-stable device-size signal. */
  shortestSide: number;
  /** True when the device's shortest side ≥ TABLET_MIN_WIDTH. */
  isTablet: boolean;
  /** True when width > height. */
  isLandscape: boolean;
  /** Raw system font scale (unclamped). */
  fontScale: number;
  /** fontScale clamped to MAX_FONT_SCALE_CHROME — for chrome sizing math. */
  cappedFontScale: number;
  /** Ready to drop into <Text maxFontSizeMultiplier>. Same value as the cap. */
  maxFontMultiplier: number;
  /** min(width, CONTENT_MAX_WIDTH) — width for a centered content column. */
  contentWidth: number;
}

/**
 * Reactive responsive info. Re-renders the consuming component on rotation,
 * fold, split-view resize, or font-scale change.
 */
export function useResponsive(): ResponsiveInfo {
  const { width, height, fontScale } = useWindowDimensions();

  return useMemo<ResponsiveInfo>(() => {
    const shortestSide = Math.min(width, height);
    const isTablet = shortestSide >= TABLET_MIN_WIDTH;
    return {
      width,
      height,
      shortestSide,
      isTablet,
      isLandscape: width > height,
      fontScale,
      cappedFontScale: clampFontScale(fontScale),
      maxFontMultiplier: MAX_FONT_SCALE_CHROME,
      contentWidth: Math.min(width, CONTENT_MAX_WIDTH),
    };
  }, [width, height, fontScale]);
}

export default useResponsive;
