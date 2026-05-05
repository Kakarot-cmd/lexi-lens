/**
 * components/Lumi/LumiTrail.tsx — v2
 *
 * Glitter particle trail behind Lumi.
 *
 * v2 additions:
 *   • `colors` prop — array of hex strings. If provided, each particle picks
 *     a color randomly from this array. Falls back to single `color` if
 *     `colors` is empty/undefined. Used for the rainbow trail.
 *
 * Architecture:
 *   • Fixed pool of 12 <Particle/> components (no hooks-in-map issue).
 *   • Parent passes current Lumi (x, y) and an `enabled` flag.
 *   • A spawn timer rotates through pool slots, activating one at a time
 *     at the current position with a random drift vector and color.
 *   • Each particle owns its own animation lifecycle (Reanimated on Animated.View
 *     ONLY — never on SVG attrs, so this is crash-safe on Fabric + R4 + RN-SVG 15).
 *   • Total bridge cost: ~1 setState every 80ms when active.
 */

import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

const POOL_SIZE      = 12;
const SPAWN_RATE_MS  = 80;
const PARTICLE_LIFE  = 700;
const PARTICLE_SIZE  = 8;   // slightly bigger than v1

export interface LumiTrailProps {
  x:            number;
  y:            number;
  enabled:      boolean;
  /** Single fallback color used when `colors` is empty. */
  color:        string;
  /** v2: pick from this list per particle for rainbow trail. */
  colors?:      readonly string[];
  reduceMotion?: boolean;
}

interface Slot {
  id:     number;
  active: boolean;
  spawnX: number;
  spawnY: number;
  driftX: number;
  driftY: number;
  rot:    number;
  fill:   string;   // v2: per-particle color
}

export function LumiTrail(props: LumiTrailProps): React.ReactElement | null {
  const { x, y, enabled, color, colors, reduceMotion } = props;

  const [slots, setSlots] = useState<Slot[]>(() =>
    Array.from({ length: POOL_SIZE }, (_, i) => ({
      id: i, active: false, spawnX: 0, spawnY: 0, driftX: 0, driftY: 0, rot: 0, fill: color,
    }))
  );

  const cursorRef = useRef(0);
  const xRef      = useRef(x);
  const yRef      = useRef(y);
  xRef.current = x;
  yRef.current = y;

  // Spawn loop
  useEffect(() => {
    if (!enabled || reduceMotion) return;
    const id = setInterval(() => {
      setSlots(prev => {
        const next = prev.slice();
        const slot = cursorRef.current % POOL_SIZE;
        cursorRef.current = (cursorRef.current + 1) % POOL_SIZE;
        const fill = (colors && colors.length > 0)
          ? colors[Math.floor(Math.random() * colors.length)]
          : color;
        next[slot] = {
          id:     slot,
          active: true,
          spawnX: xRef.current,
          spawnY: yRef.current,
          driftX: (Math.random() - 0.5) * 28,
          driftY: 14 + Math.random() * 22,
          rot:    (Math.random() - 0.5) * 240,
          fill,
        };
        return next;
      });
    }, SPAWN_RATE_MS);
    return () => clearInterval(id);
  }, [enabled, reduceMotion, color, colors]);

  const handleParticleDone = (id: number) => {
    setSlots(prev => prev.map(s => (s.id === id ? { ...s, active: false } : s)));
  };

  if (!enabled || reduceMotion) return null;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {slots.map(slot => (
        <Particle
          key={slot.id}
          slot={slot}
          onDone={handleParticleDone}
        />
      ))}
    </View>
  );
}

// ─── Single particle ──────────────────────────────────────────────────────────

function Particle({
  slot,
  onDone,
}: {
  slot:   Slot;
  onDone: (id: number) => void;
}) {
  const opacity   = useSharedValue(0);
  const dx        = useSharedValue(0);
  const dy        = useSharedValue(0);
  const rotation  = useSharedValue(0);
  const scale     = useSharedValue(0.6);

  useEffect(() => {
    if (!slot.active) return;

    opacity.value  = 1;
    dx.value       = 0;
    dy.value       = 0;
    rotation.value = 0;
    scale.value    = 0.6;

    const ease = Easing.out(Easing.quad);
    opacity.value  = withTiming(0,           { duration: PARTICLE_LIFE, easing: ease },
                                () => { runOnJS(onDone)(slot.id); });
    dx.value       = withTiming(slot.driftX, { duration: PARTICLE_LIFE, easing: ease });
    dy.value       = withTiming(slot.driftY, { duration: PARTICLE_LIFE, easing: ease });
    rotation.value = withTiming(slot.rot,    { duration: PARTICLE_LIFE, easing: ease });
    scale.value    = withTiming(1.0,         { duration: PARTICLE_LIFE * 0.5, easing: ease });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot.active, slot.spawnX, slot.spawnY]);

  const aStyle = useAnimatedStyle(() => ({
    opacity:    opacity.value,
    transform: [
      { translateX: dx.value },
      { translateY: dy.value },
      { rotate: `${rotation.value}deg` },
      { scale: scale.value },
    ],
  }));

  if (!slot.active) return null;

  return (
    <Animated.View
      style={[
        styles.particle,
        {
          left: slot.spawnX - PARTICLE_SIZE,
          top:  slot.spawnY - PARTICLE_SIZE,
        },
        aStyle,
      ]}
    >
      <Svg width={PARTICLE_SIZE * 2} height={PARTICLE_SIZE * 2} viewBox="0 0 16 16">
        <Path
          d="M8 1 L9.6 6.4 L15 8 L9.6 9.6 L8 15 L6.4 9.6 L1 8 L6.4 6.4 Z"
          fill={slot.fill}
        />
      </Svg>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  particle: {
    position: 'absolute',
    width:    PARTICLE_SIZE * 2,
    height:   PARTICLE_SIZE * 2,
  },
});
