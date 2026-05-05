/**
 * components/Lumi/LumiMascot.tsx — SAFE rewrite
 *
 * Pairs with the new SAFE LumiBody (no animated SVG attrs).
 *
 * Changes from previous version:
 *   • No wingPhase / blinkPhase shared values passed to LumiBody.
 *   • Removed `useReducedMotion` (Reanimated 4 hook). Always-on subtle motion;
 *     parents who need full reduce-motion can mute via the prop.
 *   • Removed the per-frame orbit setInterval (was 60fps setState on JS).
 *     Scanning state still feels alive via faster bob + brighter trail.
 *   • Reanimated usage is now ONLY: useSharedValue + useAnimatedStyle on the
 *     outer <Animated.View> for bob + scale. No animated props, no SVG hooks.
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
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LumiBody, type LumiMood } from './LumiBody';
import { LumiSpeechBubble } from './LumiSpeechBubble';
import { LumiTrail } from './LumiTrail';
import {
  LUMI_THEMES,
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
  guide:          { bobAmplitude: 5,  bobDurationMs: 1800, wingFlapRateHz: 0, orbitRadius: 0, orbitSpeedRpm: 0, blinkChance: 0, trailEnabled: false, trailRateMs: 0,    scaleBase: 1.00, glowIntensity: 0.7 },
  scanning:       { bobAmplitude: 3,  bobDurationMs: 1400, wingFlapRateHz: 0, orbitRadius: 0, orbitSpeedRpm: 0, blinkChance: 0, trailEnabled: true,  trailRateMs: 80,   scaleBase: 0.95, glowIntensity: 0.9 },
  success:        { bobAmplitude: 8,  bobDurationMs: 700,  wingFlapRateHz: 0, orbitRadius: 0, orbitSpeedRpm: 0, blinkChance: 0, trailEnabled: true,  trailRateMs: 50,   scaleBase: 1.10, glowIntensity: 1.0 },
  fail:           { bobAmplitude: 2,  bobDurationMs: 2200, wingFlapRateHz: 0, orbitRadius: 0, orbitSpeedRpm: 0, blinkChance: 0, trailEnabled: false, trailRateMs: 0,    scaleBase: 0.95, glowIntensity: 0.4 },
  'boss-help':    { bobAmplitude: 5,  bobDurationMs: 1600, wingFlapRateHz: 0, orbitRadius: 0, orbitSpeedRpm: 0, blinkChance: 0, trailEnabled: true,  trailRateMs: 140,  scaleBase: 1.00, glowIntensity: 0.7 },
  'out-of-juice': { bobAmplitude: 1,  bobDurationMs: 4000, wingFlapRateHz: 0, orbitRadius: 0, orbitSpeedRpm: 0, blinkChance: 0, trailEnabled: false, trailRateMs: 0,    scaleBase: 0.85, glowIntensity: 0.2 },
  cheering:       { bobAmplitude: 14, bobDurationMs: 500,  wingFlapRateHz: 0, orbitRadius: 0, orbitSpeedRpm: 0, blinkChance: 0, trailEnabled: true,  trailRateMs: 50,   scaleBase: 1.15, glowIntensity: 1.0 },
};

// ─── State → mood + intent mapping ────────────────────────────────────────────

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

// ─── Component ────────────────────────────────────────────────────────────────

export function LumiMascot(props: LumiMascotProps): React.ReactElement {
  const {
    state         = 'idle',
    message,
    hardMode      = false,
    size          = SIZE_DEFAULT,
    position      = POSITION_DEFAULT,
    freePosition,
    showTrail,
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

  // Theme resolution
  const theme: LumiTheme =
    state === 'out-of-juice' ? 'sleeping'
    : hardMode               ? 'hard-mode'
    : 'normal';
  const tokens  = LUMI_THEMES[theme];
  const profile = PROFILES[state];

  // Anchor position — pure math, no animated values
  const anchor = useMemo(
    () => resolveAnchor(position, freePosition, size, window, insets, edgeInset),
    [position, freePosition?.x, freePosition?.y, size, window.width, window.height, insets.top, insets.right, insets.bottom, insets.left, edgeInset]
  );

  // ── ONLY animations: bob + scale on the outer Animated.View ───────────────
  const bobY    = useSharedValue(0);
  const scaleSV = useSharedValue(profile.scaleBase);

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

  // Sound + haptic on state change. Idle has no haptic/sound mapping → no-op.
  useEffect(() => {
    if (effectiveMuted) return;
    try { playLumiForState(state); } catch { /* never crash on audio */ }
  }, [state, effectiveMuted]);

  const bodyAnimStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: bobY.value },
      { scale:      scaleSV.value },
    ],
  }));

  // Trail position is just the static anchor (no orbit setInterval)
  const trailEnabled = (showTrail ?? profile.trailEnabled) && !reduceMotion;

  // ── Bubble ────────────────────────────────────────────────────────────────
  const bubbleVisible = !effectiveMuted && state !== 'idle';
  const intent = STATE_INTENT[state];
  const bubbleText =
    message !== undefined
      ? message
      : LUMI_QUOTES[intent]?.length
        ? pickLumiQuote(intent, `${state}:${Math.floor(Date.now() / 4000)}`)
        : '';

  const bubbleOnLeftOfLumi  = anchor.centerX > window.width * 0.5;
  const bubbleTailSide: 'left' | 'right' = bubbleOnLeftOfLumi ? 'right' : 'left';
  const bubbleLeft = bubbleOnLeftOfLumi ? anchor.left - 200 - 8 : anchor.left + size + 8;
  const bubbleTop  = anchor.top + 4;

  return (
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { zIndex }]}>
      {/* Trail layer (below body) */}
      <LumiTrail
        x={anchor.centerX}
        y={anchor.centerY}
        enabled={trailEnabled && profile.trailRateMs > 0}
        color={tokens.trail}
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
            left:   anchor.left,
            top:    anchor.top,
            width:  size,
            height: size,
            opacity: pressed ? 0.85 : 1,
          },
        ]}
      >
        <Animated.View style={bodyAnimStyle}>
          <LumiBody size={size} theme={theme} mood={STATE_MOOD[state]} />
        </Animated.View>
      </Pressable>

      {/* Speech bubble */}
      {bubbleVisible && bubbleText ? (
        <View pointerEvents="none" style={[styles.bubbleContainer, { left: bubbleLeft, top: bubbleTop }]}>
          <LumiSpeechBubble
            message={bubbleText}
            tailSide={bubbleTailSide}
            visible={bubbleVisible}
            durationMs={state === 'out-of-juice' ? 0 : 3500}
          />
        </View>
      ) : null}
    </View>
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
});
