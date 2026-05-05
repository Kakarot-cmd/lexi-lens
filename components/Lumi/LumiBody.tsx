/**
 * components/Lumi/LumiBody.tsx — SAFE rewrite (Fabric + Reanimated 4 + RN-SVG 15)
 *
 * ─── Why this version ────────────────────────────────────────────────────────
 * The previous version animated SVG attributes directly via Reanimated:
 *   • Animated.createAnimatedComponent(G) + useAnimatedProps({ transform: '...' })
 *   • AnimatedEllipse + useAnimatedProps({ ry: ... })
 *
 * That combination is fragile on Fabric + Reanimated 4 + react-native-svg 15.x.
 * The native shadow node update path for animated SVG attributes can fault and
 * crash the process with no JS error.
 *
 * This rewrite is 100% static SVG. All visible animation is moved to the OUTER
 * <Animated.View> in LumiMascot (View-level transforms — battle-tested).
 *   • Wings: drawn as static ellipses (no flap; LumiMascot's bob + scale on
 *            the outer container provides plenty of life).
 *   • Eyes:  React-state blink (open / closed) every ~3s via setInterval.
 *
 * Props named wingPhase / blinkPhase are accepted (typed as `unknown`) for
 * backward compatibility with the previous LumiMascot — they are silently
 * ignored.
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

import type { LumiTheme } from './lumiTypes';
import { LUMI_THEMES } from './lumiTypes';

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
  /** Accepted for back-compat. Ignored in this safe build. */
  wingPhase?:   unknown;
  /** Accepted for back-compat. Ignored in this safe build. */
  blinkPhase?:  unknown;
}

export function LumiBody(props: LumiBodyProps): React.ReactElement {
  const {
    size = 64,
    theme = 'normal',
    mood = 'happy',
  } = props;

  const tokens = LUMI_THEMES[theme];

  // ── Plain React-state blink. No Reanimated, no animated SVG attrs. ─────────
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

  const eyeRy = blinking ? 0.4 : 2.6;

  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs>
        <RadialGradient id="lumiGlow" cx="50%" cy="50%" r="50%">
          <Stop offset="0%"   stopColor={tokens.glow} stopOpacity={0.55} />
          <Stop offset="60%"  stopColor={tokens.glow} stopOpacity={0.18} />
          <Stop offset="100%" stopColor={tokens.glow} stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id="lumiBody" cx="40%" cy="35%" r="65%">
          <Stop offset="0%"   stopColor={tokens.bodyHighlight} stopOpacity={1} />
          <Stop offset="100%" stopColor={tokens.bodyShadow}    stopOpacity={1} />
        </RadialGradient>
        <RadialGradient id="lumiWing" cx="50%" cy="50%" r="50%">
          <Stop offset="0%"   stopColor={tokens.bodyHighlight} stopOpacity={0.85} />
          <Stop offset="100%" stopColor={tokens.bodyHighlight} stopOpacity={0} />
        </RadialGradient>
      </Defs>

      {/* outer halo */}
      <Circle cx={32} cy={32} r={30} fill="url(#lumiGlow)" />

      {/* wings — STATIC. No animatedProps, no createAnimatedComponent. */}
      <G>
        <Ellipse cx={18} cy={28} rx={9} ry={13} fill="url(#lumiWing)" />
      </G>
      <G>
        <Ellipse cx={46} cy={28} rx={9} ry={13} fill="url(#lumiWing)" />
      </G>

      {/* body teardrop */}
      <Path
        d="M32 16 C24 16 18 24 18 34 C18 42 24 48 32 48 C40 48 46 42 46 34 C46 24 40 16 32 16 Z"
        fill="url(#lumiBody)"
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

  const mouthPath =
    mood === 'excited'    ? 'M27 37 Q32 43 37 37'
    : mood === 'sad'      ? 'M28 41 Q32 38 36 41'
    : mood === 'sleeping' ? 'M30 40 Q32 41 34 40'
    : mood === 'thinking' ? 'M29 40 L35 40'
    : 'M28 38 Q32 41 36 38';

  if (mood === 'sleeping') {
    return (
      <>
        <Path d="M24 32 Q27 34 30 32" stroke={eyeColor} strokeWidth={1.5} fill="none" strokeLinecap="round" />
        <Path d="M34 32 Q37 34 40 32" stroke={eyeColor} strokeWidth={1.5} fill="none" strokeLinecap="round" />
        <Path d={mouthPath} stroke={eyeColor} strokeWidth={1.2} fill="none" strokeLinecap="round" />
        <Path d="M44 18 L48 18 L44 22 L48 22" stroke={eyeColor} strokeWidth={1} fill="none" />
      </>
    );
  }

  if (mood === 'excited') {
    return (
      <>
        <Path d="M27 31 L28 33 L30 33 L28.5 34.5 L29 36.5 L27 35.5 L25 36.5 L25.5 34.5 L24 33 L26 33 Z" fill={eyeColor} />
        <Path d="M37 31 L38 33 L40 33 L38.5 34.5 L39 36.5 L37 35.5 L35 36.5 L35.5 34.5 L34 33 L36 33 Z" fill={eyeColor} />
        <Path d={mouthPath} stroke={eyeColor} strokeWidth={1.5} fill="none" strokeLinecap="round" />
      </>
    );
  }

  // Default: round eyes via plain JSX. ry is a regular prop, NOT animated.
  return (
    <>
      <Ellipse cx={27} cy={32} rx={2.6} ry={eyeRy} fill={eyeColor} />
      <Circle  cx={27.8} cy={31.2} r={0.7} fill="#ffffff" />
      <Ellipse cx={37} cy={32} rx={2.6} ry={eyeRy} fill={eyeColor} />
      <Circle  cx={37.8} cy={31.2} r={0.7} fill="#ffffff" />
      <Path d={mouthPath} stroke={eyeColor} strokeWidth={1.5} fill="none" strokeLinecap="round" />
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
