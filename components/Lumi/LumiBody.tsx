/**
 * components/Lumi/LumiBody.tsx — SAFE rewrite v2 (Fabric + Reanimated 4 + RN-SVG 15)
 *
 * Pure static SVG (no animated SVG attrs, no createAnimatedComponent).
 * All movement / scale / bob is handled by the OUTER <Animated.View> in LumiMascot.
 *
 * v2 additions:
 *   • `colorTick` prop — 0..5 index into RAINBOW_PALETTE. When `theme === 'rainbow'`,
 *     LumiMascot drives this via React state on a slow timer, swapping the gradient
 *     stop colors so Lumi cycles through hues. Plain prop change → React re-renders
 *     SVG with new fills. No Reanimated, no native shadow-node update path.
 *   • Bigger more expressive eyes (ry 3.0 instead of 2.6).
 *   • Body still has wings, halo, body teardrop, face, and star/crown.
 */

import React, { useEffect, useState } from 'react';
import Svg, {
  Circle,
  Defs,
  Ellipse,
  G,
  Path,
  RadialGradient,
  Stop,
} from 'react-native-svg';

import {
  LUMI_THEMES,
  RAINBOW_PALETTE,
  RAINBOW_HIGHLIGHT_PALETTE,
  type LumiTheme,
} from './lumiTypes';

export type LumiMood =
  | 'happy'
  | 'curious'
  | 'excited'
  | 'thinking'
  | 'sad'
  | 'sleeping';

export interface LumiBodyProps {
  size?:        number;
  theme?:       LumiTheme;
  mood?:        LumiMood;
  /** v2: rainbow color index 0..5. Driven by parent's slow timer. */
  colorTick?:   number;
  /** Accepted for back-compat. Ignored. */
  wingPhase?:   unknown;
  /** Accepted for back-compat. Ignored. */
  blinkPhase?:  unknown;
}

export function LumiBody(props: LumiBodyProps): React.ReactElement {
  const {
    size = 64,
    theme = 'normal',
    mood = 'happy',
    colorTick = 0,
  } = props;

  const baseTokens = LUMI_THEMES[theme];

  // Resolve actual gradient colors. For rainbow theme, override with cycling palette.
  const idx = ((colorTick % RAINBOW_PALETTE.length) + RAINBOW_PALETTE.length) % RAINBOW_PALETTE.length;
  const tokens = theme === 'rainbow'
    ? {
        ...baseTokens,
        bodyHighlight: RAINBOW_HIGHLIGHT_PALETTE[idx],
        bodyShadow:    RAINBOW_PALETTE[idx],
        glow:          RAINBOW_PALETTE[(idx + 3) % RAINBOW_PALETTE.length], // complementary halo
        star:          baseTokens.star,
      }
    : baseTokens;

  // ── React-state blink. No Reanimated, no animated SVG attrs. ────────────────
  const [blinking, setBlinking] = useState(false);

  useEffect(() => {
    if (mood === 'sleeping') {
      setBlinking(false);
      return;
    }
    const id = setInterval(() => {
      setBlinking(true);
      const t = setTimeout(() => setBlinking(false), 110);
      return () => clearTimeout(t);
    }, 3000 + Math.random() * 1500);
    return () => clearInterval(id);
  }, [mood]);

  // Slightly bigger eyes than v1 — more expressive
  const eyeRyOpen = 3.0;
  const eyeRy     = blinking ? 0.4 : eyeRyOpen;

  // Unique gradient ids per render to avoid collision when multiple Lumis exist.
  // The id is constant within one render so the fill="url(#...)" references match.
  // (Using a stable id derived from theme is fine — RN-SVG accepts changing ids.)
  const gradId = `lumi_${theme}_${idx}`;
  const glowId = `${gradId}_glow`;
  const bodyId = `${gradId}_body`;
  const wingId = `${gradId}_wing`;

  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs>
        <RadialGradient id={glowId} cx="50%" cy="50%" r="50%">
          <Stop offset="0%"   stopColor={tokens.glow} stopOpacity={0.55} />
          <Stop offset="60%"  stopColor={tokens.glow} stopOpacity={0.20} />
          <Stop offset="100%" stopColor={tokens.glow} stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id={bodyId} cx="38%" cy="32%" r="68%">
          <Stop offset="0%"   stopColor={tokens.bodyHighlight} stopOpacity={1} />
          <Stop offset="60%"  stopColor={tokens.bodyHighlight} stopOpacity={0.85} />
          <Stop offset="100%" stopColor={tokens.bodyShadow}    stopOpacity={1} />
        </RadialGradient>
        <RadialGradient id={wingId} cx="50%" cy="50%" r="50%">
          <Stop offset="0%"   stopColor={tokens.bodyHighlight} stopOpacity={0.85} />
          <Stop offset="100%" stopColor={tokens.bodyHighlight} stopOpacity={0} />
        </RadialGradient>
      </Defs>

      {/* outer halo */}
      <Circle cx={32} cy={32} r={30} fill={`url(#${glowId})`} />

      {/* wings — STATIC SVG, no animatedProps */}
      <G>
        <Ellipse cx={18} cy={28} rx={9} ry={13} fill={`url(#${wingId})`} />
      </G>
      <G>
        <Ellipse cx={46} cy={28} rx={9} ry={13} fill={`url(#${wingId})`} />
      </G>

      {/* body teardrop */}
      <Path
        d="M32 16 C24 16 18 24 18 34 C18 42 24 48 32 48 C40 48 46 42 46 34 C46 24 40 16 32 16 Z"
        fill={`url(#${bodyId})`}
      />

      {/* face */}
      <Face mood={mood} eyeRy={eyeRy} />

      {/* star / crown on top */}
      {tokens.hasCrown ? <Crown color={tokens.star} /> : <Star color={tokens.star} />}
    </Svg>
  );
}

// ─── Face sub-renderer ────────────────────────────────────────────────────────

function Face({ mood, eyeRy }: { mood: LumiMood; eyeRy: number }) {
  const eyeColor = '#1a0e2e';

  // Slightly more expressive mouths than v1 — wider grin on happy/excited
  const mouthPath =
    mood === 'excited'    ? 'M26 37 Q32 44 38 37'                     // big grin
    : mood === 'sad'      ? 'M28 41 Q32 38 36 41'                      // sad
    : mood === 'sleeping' ? 'M30 40 Q32 41 34 40'                      // tiny smile
    : mood === 'thinking' ? 'M29 40 L35 40'                            // straight
    : 'M27 38 Q32 42 37 38';                                            // happy / curious

  if (mood === 'sleeping') {
    return (
      <>
        <Path d="M24 32 Q27 34 30 32" stroke={eyeColor} strokeWidth={1.5} fill="none" strokeLinecap="round" />
        <Path d="M34 32 Q37 34 40 32" stroke={eyeColor} strokeWidth={1.5} fill="none" strokeLinecap="round" />
        <Path d={mouthPath} stroke={eyeColor} strokeWidth={1.2} fill="none" strokeLinecap="round" />
        {/* zZz */}
        <Path d="M44 18 L48 18 L44 22 L48 22" stroke={eyeColor} strokeWidth={1} fill="none" />
      </>
    );
  }

  if (mood === 'excited') {
    return (
      <>
        {/* star eyes */}
        <Path d="M27 31 L28 33 L30 33 L28.5 34.5 L29 36.5 L27 35.5 L25 36.5 L25.5 34.5 L24 33 L26 33 Z" fill={eyeColor} />
        <Path d="M37 31 L38 33 L40 33 L38.5 34.5 L39 36.5 L37 35.5 L35 36.5 L35.5 34.5 L34 33 L36 33 Z" fill={eyeColor} />
        <Path d={mouthPath} stroke={eyeColor} strokeWidth={1.6} fill="none" strokeLinecap="round" />
        {/* rosy cheeks */}
        <Circle cx={22} cy={37} r={1.6} fill="#fb7185" opacity={0.55} />
        <Circle cx={42} cy={37} r={1.6} fill="#fb7185" opacity={0.55} />
      </>
    );
  }

  // Default round eyes + sparkle catchlight
  return (
    <>
      <Ellipse cx={27} cy={32} rx={2.8} ry={eyeRy} fill={eyeColor} />
      <Circle  cx={27.9} cy={31.0} r={0.85} fill="#ffffff" />
      <Ellipse cx={37} cy={32} rx={2.8} ry={eyeRy} fill={eyeColor} />
      <Circle  cx={37.9} cy={31.0} r={0.85} fill="#ffffff" />
      <Path d={mouthPath} stroke={eyeColor} strokeWidth={1.6} fill="none" strokeLinecap="round" />
    </>
  );
}

// ─── Star + crown decorations ─────────────────────────────────────────────────

function Star({ color }: { color: string }) {
  return (
    <Path
      d="M32 8 L33.2 11 L36.5 11.4 L34 13.6 L34.7 16.8 L32 15.2 L29.3 16.8 L30 13.6 L27.5 11.4 L30.8 11 Z"
      fill={color}
    />
  );
}

function Crown({ color }: { color: string }) {
  return (
    <>
      <Path
        d="M25 14 L27 9 L29 13 L32 7 L35 13 L37 9 L39 14 L25 14 Z"
        fill={color}
        stroke="#7c2d12"
        strokeWidth={0.6}
      />
      <Circle cx={32} cy={11} r={1.2} fill="#fef3c7" />
    </>
  );
}
