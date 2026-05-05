/**
 * components/Lumi/LumiMascot.tsx — v2
 *
 * Composes Body + Trail + SpeechBubble + Ambient Sparkles.
 *
 * v2 changes:
 *   • Wander mode (`movement: 'wander'`) — Lumi smoothly figure-8's across the
 *     upper portion of the screen via Animated.View transforms (UI-thread,
 *     proven safe path on Fabric + R4 + RN-SVG 15).
 *   • Drift mode (`movement: 'drift'`) — gentle horizontal drift along an edge.
 *   • Rainbow theme support — when `rainbow={true}`, body cycles through 6 hues
 *     every ~3.5s, trail uses multi-color particles. Color cycling is driven by
 *     React state (NOT animated SVG attrs — that path crashes).
 *   • Speech bubbles fixed — previously hidden when state==='idle', now show
 *     whenever bubbleText is non-empty. Idle quotes rotate every 11s with a
 *     stable salt so they don't flicker.
 *   • Ambient sparkles — 3 small twinkling stars around Lumi.
 *
 * Reanimated usage in this file is RESTRICTED to:
 *   • Outer <Animated.View> on the body (translateX/Y, scale, bob)
 *   • Inner <Animated.View> on each ambient sparkle (opacity pulse)
 *   • LumiTrail's <Animated.View> particles
 *
 * NEVER on SVG attributes. NEVER via createAnimatedComponent on SVG primitives.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LumiBody, type LumiMood } from './LumiBody';
import { LumiSpeechBubble } from './LumiSpeechBubble';
import { LumiTrail } from './LumiTrail';
import {
  LUMI_THEMES,
  RAINBOW_PALETTE,
  SPARKLE_PALETTE,
  type LumiAnimationProfile,
  type LumiMascotProps,
  type LumiState,
  type LumiTheme,
  type QuoteIntent,
} from './lumiTypes';
import { LUMI_QUOTES, pickLumiQuote } from './lumiQuotes';
import { playLumiForState } from './lumiSounds';

// ─── Animation profiles per state ─────────────────────────────────────────────

const PROFILES: Record<LumiState, LumiAnimationProfile> = {
  idle:           { bobAmplitude: 4,  bobDurationMs: 2500, wingFlapRateHz: 0, orbitRadius: 0, orbitSpeedRpm: 0, blinkChance: 0, trailEnabled: false, trailRateMs: 0,    scaleBase: 1.00, glowIntensity: 0.5 },
  guide:          { bobAmplitude: 5,  bobDurationMs: 1800, wingFlapRateHz: 0, orbitRadius: 0, orbitSpeedRpm: 0, blinkChance: 0, trailEnabled: true,  trailRateMs: 200,  scaleBase: 1.00, glowIntensity: 0.7 },
  scanning:       { bobAmplitude: 3,  bobDurationMs: 1400, wingFlapRateHz: 0, orbitRadius: 0, orbitSpeedRpm: 0, blinkChance: 0, trailEnabled: true,  trailRateMs: 80,   scaleBase: 0.95, glowIntensity: 0.9 },
  success:        { bobAmplitude: 8,  bobDurationMs: 700,  wingFlapRateHz: 0, orbitRadius: 0, orbitSpeedRpm: 0, blinkChance: 0, trailEnabled: true,  trailRateMs: 50,   scaleBase: 1.10, glowIntensity: 1.0 },
  fail:           { bobAmplitude: 2,  bobDurationMs: 2200, wingFlapRateHz: 0, orbitRadius: 0, orbitSpeedRpm: 0, blinkChance: 0, trailEnabled: false, trailRateMs: 0,    scaleBase: 0.95, glowIntensity: 0.4 },
  'boss-help':    { bobAmplitude: 5,  bobDurationMs: 1600, wingFlapRateHz: 0, orbitRadius: 0, orbitSpeedRpm: 0, blinkChance: 0, trailEnabled: true,  trailRateMs: 140,  scaleBase: 1.00, glowIntensity: 0.7 },
  'out-of-juice': { bobAmplitude: 1,  bobDurationMs: 4000, wingFlapRateHz: 0, orbitRadius: 0, orbitSpeedRpm: 0, blinkChance: 0, trailEnabled: false, trailRateMs: 0,    scaleBase: 0.85, glowIntensity: 0.2 },
  cheering:       { bobAmplitude: 14, bobDurationMs: 500,  wingFlapRateHz: 0, orbitRadius: 0, orbitSpeedRpm: 0, blinkChance: 0, trailEnabled: true,  trailRateMs: 50,   scaleBase: 1.15, glowIntensity: 1.0 },
};

const STATE_MOOD: Record<LumiState, LumiMood> = {
  idle:            'happy',
  guide:           'curious',
  scanning:        'curious',
  success:         'excited',
  fail:            'thinking',
  'boss-help':     'curious',
  'out-of-juice':  'sleeping',
  cheering:        'excited',
};

const STATE_INTENT: Record<LumiState, QuoteIntent> = {
  idle:            'idle-flavor',
  guide:           'onboarding',
  scanning:        'scanning',
  success:         'success-match',
  fail:            'fail-mismatch',
  'boss-help':     'boss-hint',
  'out-of-juice':  'rate-limit',
  cheering:        'victory',
};

const POSITION_DEFAULT = 'top-right' as const;
const SIZE_DEFAULT     = 64;

// Idle bubble cadence — try a new quote every 11s. Idle pool has empty
// strings interleaved so ~half of attempts will produce silence (which is
// the point — Lumi shouldn't chatter constantly).
const IDLE_QUOTE_INTERVAL_MS = 11_000;

// Rainbow color cycle period.
const COLOR_CYCLE_MS = 3500;

// ─── Component ────────────────────────────────────────────────────────────────

export function LumiMascot(props: LumiMascotProps): React.ReactElement {
  const {
    state         = 'idle',
    message,
    hardMode      = false,
    size          = SIZE_DEFAULT,
    position      = POSITION_DEFAULT,
    freePosition,
    movement      = 'anchor',
    showTrail,
    rainbow       = false,
    onTap,
    muted         = false,
    reduceMotion  = false,
    edgeInset     = 16,
    zIndex        = 100,
  } = props;

  const insets   = useSafeAreaInsets();
  const window   = useWindowDimensions();

  const [localMuted, setLocalMuted] = useState(false);
  const effectiveMuted = muted || localMuted;

  // ── Theme resolution ──────────────────────────────────────────────────────
  const theme: LumiTheme =
    state === 'out-of-juice' ? 'sleeping'
    : rainbow                ? 'rainbow'
    : hardMode               ? 'hard-mode'
    : 'normal';
  const tokens  = LUMI_THEMES[theme];
  const profile = PROFILES[state];

  // ── Color cycle (rainbow theme only) ──────────────────────────────────────
  const [colorTick, setColorTick] = useState(0);
  useEffect(() => {
    if (theme !== 'rainbow') return;
    const id = setInterval(() => {
      setColorTick(t => (t + 1) % RAINBOW_PALETTE.length);
    }, COLOR_CYCLE_MS);
    return () => clearInterval(id);
  }, [theme]);

  // ── Idle bubble rotation ──────────────────────────────────────────────────
  // Bumps every IDLE_QUOTE_INTERVAL_MS while in idle so a new quote is picked
  // and the bubble component sees a stable "salt" between bumps (no flicker).
  const [idleAttempt, setIdleAttempt] = useState(0);
  useEffect(() => {
    if (state !== 'idle') return;
    const id = setInterval(() => {
      setIdleAttempt(s => s + 1);
    }, IDLE_QUOTE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [state]);

  // ── Anchor (where Lumi nominally lives) ───────────────────────────────────
  // For wander mode we OVERRIDE to a center-top anchor so the figure-8 stays
  // in the upper portion of the screen.
  const wanderEnabled = movement === 'wander' && !reduceMotion;
  const driftEnabled  = movement === 'drift'  && !reduceMotion;

  const anchor = useMemo(() => {
    if (wanderEnabled) {
      const left = window.width / 2 - size / 2;
      const top  = insets.top + edgeInset + size; // upper third
      return { left, top, centerX: left + size / 2, centerY: top + size / 2 };
    }
    if (driftEnabled) {
      // Center vertically along the right edge, drift left/right
      const left = window.width - size - insets.right - edgeInset;
      const top  = (window.height - size) / 2;
      return { left, top, centerX: left + size / 2, centerY: top + size / 2 };
    }
    return resolveAnchor(position, freePosition, size, window, insets, edgeInset);
  }, [
    wanderEnabled, driftEnabled, position,
    freePosition?.x, freePosition?.y, size,
    window.width, window.height,
    insets.top, insets.right, insets.bottom, insets.left,
    edgeInset,
  ]);

  // ── Reanimated values for transforms ──────────────────────────────────────
  const bobY    = useSharedValue(0);
  const scaleSV = useSharedValue(profile.scaleBase);
  const wanderX = useSharedValue(0);
  const wanderY = useSharedValue(0);

  // Bob (subtle vertical idle motion)
  useEffect(() => {
    if (reduceMotion || profile.bobAmplitude === 0) {
      bobY.value = withTiming(0, { duration: 200 });
      return;
    }
    bobY.value = 0;
    bobY.value = withRepeat(
      withSequence(
        withTiming(-profile.bobAmplitude, { duration: profile.bobDurationMs / 2, easing: Easing.inOut(Easing.sin) }),
        withTiming( profile.bobAmplitude, { duration: profile.bobDurationMs,     easing: Easing.inOut(Easing.sin) }),
        withTiming(0,                     { duration: profile.bobDurationMs / 2, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      false,
    );
  }, [profile.bobAmplitude, profile.bobDurationMs, reduceMotion]);

  // Scale (one-shot pop on success)
  useEffect(() => {
    if (state === 'success') {
      scaleSV.value = withSequence(
        withTiming(1.20, { duration: 180, easing: Easing.out(Easing.cubic) }),
        withTiming(1.00, { duration: 280, easing: Easing.out(Easing.cubic) }),
      );
    } else {
      scaleSV.value = withTiming(profile.scaleBase, { duration: 300 });
    }
  }, [state, profile.scaleBase]);

  // Sound + haptic on state change
  useEffect(() => {
    if (effectiveMuted) return;
    try { playLumiForState(state); } catch { /* no-op */ }
  }, [state, effectiveMuted]);

  // Wander / drift motion. Different periods on X and Y produce a figure-8.
  useEffect(() => {
    if (wanderEnabled) {
      const radiusX = Math.max(60, (window.width - size - 2 * edgeInset) * 0.42);
      const radiusY = size * 1.0;

      wanderX.value = 0;
      wanderX.value = withRepeat(
        withSequence(
          withTiming( radiusX, { duration: 9000, easing: Easing.inOut(Easing.sin) }),
          withTiming(-radiusX, { duration: 9000, easing: Easing.inOut(Easing.sin) }),
        ),
        -1,
        false,
      );

      wanderY.value = 0;
      wanderY.value = withRepeat(
        withSequence(
          withTiming( radiusY, { duration: 4500, easing: Easing.inOut(Easing.sin) }),
          withTiming(-radiusY, { duration: 4500, easing: Easing.inOut(Easing.sin) }),
        ),
        -1,
        false,
      );
      return;
    }

    if (driftEnabled) {
      const radiusX = size * 1.5;
      wanderX.value = 0;
      wanderX.value = withRepeat(
        withSequence(
          withTiming(-radiusX, { duration: 6000, easing: Easing.inOut(Easing.sin) }),
          withTiming( 0,        { duration: 6000, easing: Easing.inOut(Easing.sin) }),
        ),
        -1,
        false,
      );
      wanderY.value = withTiming(0, { duration: 600 });
      return;
    }

    // anchor mode — ease back to 0
    wanderX.value = withTiming(0, { duration: 600 });
    wanderY.value = withTiming(0, { duration: 600 });
  }, [wanderEnabled, driftEnabled, window.width, size, edgeInset]);

  // Combined transform on the body's outer wrapper.
  const bodyAnimStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: wanderX.value },
      { translateY: wanderY.value + bobY.value },
      { scale:      scaleSV.value },
    ],
  }));

  // Trail enabled when state's profile says so AND not in motion modes that
  // would leave the trail behind (anchor / drift are fine; wander would orphan
  // particles — disable trail in wander to avoid visual clutter).
  const trailEnabled =
    (showTrail ?? profile.trailEnabled) &&
    !reduceMotion &&
    !wanderEnabled;

  const trailColors = theme === 'rainbow'
    ? RAINBOW_PALETTE
    : undefined;

  // ── Bubble text resolution ────────────────────────────────────────────────
  // Idle uses idleAttempt as salt (changes every 11s); other states use a
  // 6-second window so they refresh occasionally if the state lingers.
  const intent = STATE_INTENT[state];
  const salt = state === 'idle'
    ? `idle:${idleAttempt}`
    : `${state}:${Math.floor(Date.now() / 6000)}`;
  const bubbleText = message !== undefined
    ? message
    : LUMI_QUOTES[intent]?.length
      ? pickLumiQuote(intent, salt)
      : '';

  // BUG FIX (vs v1): show bubble whenever there's text, regardless of state.
  // Empty strings in idle-flavor pool give Lumi natural quiet windows.
  const bubbleVisible = !effectiveMuted && bubbleText.trim().length > 0;

  // Bubble placement: when Lumi wanders, place the bubble above her body so it
  // never clips off-screen at the extremes of her path. When anchored, fall
  // back to the original left/right placement based on which half of the
  // screen she lives in.
  const isMoving = wanderEnabled || driftEnabled;
  const bubbleOnLeftOfLumi  = !isMoving && anchor.centerX > window.width * 0.55;
  const bubbleTailSide: 'left' | 'right' = bubbleOnLeftOfLumi ? 'right' : 'left';

  const BUBBLE_HALF_W = 100; // half of LumiSpeechBubble maxWidth (200)
  const bubbleLeft = isMoving
    ? anchor.left + size / 2 - BUBBLE_HALF_W
    : bubbleOnLeftOfLumi
      ? anchor.left - 200 - 8
      : anchor.left + size + 8;
  const bubbleTop  = isMoving
    ? anchor.top - 52         // sit above the body
    : anchor.top + 4;

  return (
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { zIndex }]}>
      {/* Trail layer (below body) */}
      <LumiTrail
        x={anchor.centerX}
        y={anchor.centerY}
        enabled={trailEnabled && profile.trailRateMs > 0}
        color={tokens.trail}
        colors={trailColors}
        reduceMotion={reduceMotion}
      />

      {/* Body layer */}
      <Pressable
        onPress={onTap}
        onLongPress={() => setLocalMuted(m => !m)}
        delayLongPress={500}
        accessibilityRole="image"
        accessibilityLabel="Lumi, your spark guide"
        style={({ pressed }) => [
          styles.bodyContainer,
          {
            left:    anchor.left,
            top:     anchor.top,
            width:   size,
            height:  size,
            opacity: pressed ? 0.85 : 1,
          },
        ]}
      >
        <Animated.View style={bodyAnimStyle}>
          {/* Ambient sparkles ride along with the body */}
          <AmbientSparkles size={size} reduceMotion={reduceMotion} colorful={theme === 'rainbow'} />
          <LumiBody
            size={size}
            theme={theme}
            mood={STATE_MOOD[state]}
            colorTick={colorTick}
          />
        </Animated.View>
      </Pressable>

      {/* Speech bubble */}
      {bubbleVisible && bubbleText ? (
        <Animated.View
          pointerEvents="none"
          style={[styles.bubbleContainer, bodyAnimStyle, { left: bubbleLeft, top: bubbleTop }]}
        >
          <LumiSpeechBubble
            message={bubbleText}
            tailSide={bubbleTailSide}
            visible={bubbleVisible}
            durationMs={state === 'out-of-juice' ? 0 : 3500}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}

// ─── Ambient sparkles ─────────────────────────────────────────────────────────
// 3 small twinkling stars positioned around Lumi, each pulsing opacity on
// its own staggered loop. Pure View-level animation. SVG paths are static.

function AmbientSparkles({
  size,
  reduceMotion,
  colorful,
}: {
  size:         number;
  reduceMotion: boolean;
  colorful:     boolean;
}) {
  // Three sparkles at (angle, distance) from body center
  const sparkles = useMemo(
    () => [
      { angle:  -0.6, distance: size * 0.55, delay: 0,    color: colorful ? SPARKLE_PALETTE[1] : SPARKLE_PALETTE[0] },
      { angle:   1.4, distance: size * 0.62, delay: 700,  color: colorful ? SPARKLE_PALETTE[2] : SPARKLE_PALETTE[0] },
      { angle:   2.8, distance: size * 0.58, delay: 1400, color: colorful ? SPARKLE_PALETTE[3] : SPARKLE_PALETTE[0] },
    ],
    [size, colorful],
  );

  if (reduceMotion) return null;

  return (
    <>
      {sparkles.map((s, i) => (
        <Sparkle
          key={i}
          centerOffsetX={size / 2 + Math.cos(s.angle) * s.distance - 6}
          centerOffsetY={size / 2 + Math.sin(s.angle) * s.distance - 6}
          color={s.color}
          delayMs={s.delay}
        />
      ))}
    </>
  );
}

function Sparkle({
  centerOffsetX,
  centerOffsetY,
  color,
  delayMs,
}: {
  centerOffsetX: number;
  centerOffsetY: number;
  color:         string;
  delayMs:       number;
}) {
  const opacity = useSharedValue(0);

  useEffect(() => {
    opacity.value = withDelay(
      delayMs,
      withRepeat(
        withSequence(
          withTiming(1,   { duration: 600, easing: Easing.inOut(Easing.sin) }),
          withTiming(0.1, { duration: 1400, easing: Easing.inOut(Easing.sin) }),
        ),
        -1,
        false,
      ),
    );
  }, [delayMs]);

  const aStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.sparkle,
        { left: centerOffsetX, top: centerOffsetY },
        aStyle,
      ]}
    >
      <Svg width={12} height={12} viewBox="0 0 12 12">
        <Path d="M6 1 L7 5 L11 6 L7 7 L6 11 L5 7 L1 6 L5 5 Z" fill={color} />
      </Svg>
    </Animated.View>
  );
}

// ─── Position resolution ──────────────────────────────────────────────────────

interface Anchor {
  left:    number;
  top:     number;
  centerX: number;
  centerY: number;
}

function resolveAnchor(
  position: NonNullable<LumiMascotProps['position']>,
  freePosition: LumiMascotProps['freePosition'],
  size: number,
  window: { width: number; height: number },
  insets: { top: number; right: number; bottom: number; left: number },
  edgeInset: number,
): Anchor {
  const W = window.width;
  const H = window.height;
  const padL = insets.left   + edgeInset;
  const padR = insets.right  + edgeInset;
  const padT = insets.top    + edgeInset;
  const padB = insets.bottom + edgeInset;

  let left = padL, top = padT;

  switch (position) {
    case 'top-left':      left = padL;                top = padT;             break;
    case 'top-right':     left = W - size - padR;     top = padT;             break;
    case 'top-center':    left = (W - size) / 2;      top = padT;             break;
    case 'bottom-left':   left = padL;                top = H - size - padB;  break;
    case 'bottom-right':  left = W - size - padR;     top = H - size - padB;  break;
    case 'center':        left = (W - size) / 2;      top = (H - size) / 2;   break;
    case 'free':
      left = freePosition?.x ?? padL;
      top  = freePosition?.y ?? padT;
      break;
  }

  return { left, top, centerX: left + size / 2, centerY: top + size / 2 };
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  bodyContainer:   { position: 'absolute' },
  bubbleContainer: { position: 'absolute' },
  sparkle:         { position: 'absolute', width: 12, height: 12 },
});
