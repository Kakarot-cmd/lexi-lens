/**
 * components/Lumi/LumiTrail.tsx
 *
 * Glitter particle trail behind Lumi.
 *
 * Architecture:
 *   • Fixed pool of 12 <Particle/> components (no hooks-in-map issue —
 *     each Particle is its own component with its own hooks).
 *   • Parent passes current Lumi (x, y) and an `enabled` flag.
 *   • A spawn timer rotates through pool slots, activating one at a time
 *     at the current position with a random drift vector.
 *   • Each particle owns its own animation lifecycle (Reanimated).
 *   • Total bridge cost: ~1 setState every 80ms when active.
 *
 * Performance budget:
 *   • Max 12 concurrent particles
 *   • All transforms via shared values (no per-frame JS bridge)
 *   • Disabled entirely when `enabled=false` or `reduceMotion=true`
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
const PARTICLE_SIZE  = 7;

export interface LumiTrailProps {
  /** Current Lumi center, in container coords. */
  x:            number;
  y:            number;
  /** Toggle the spawner. */
  enabled:      boolean;
  /** Glitter color (theme-tinted). */
  color:        string;
  /** Honored: skips spawning when true. */
  reduceMotion?: boolean;
}

interface Slot {
  id:     number;
  active: boolean;
  /** snapshot at spawn time */
  spawnX: number;
  spawnY: number;
  /** drift target offsets */
  driftX: number;
  driftY: number;
  /** rotation total */
  rot:    number;
}

export function LumiTrail(props: LumiTrailProps): React.ReactElement | null {
  const { x, y, enabled, color, reduceMotion } = props;

  const [slots, setSlots] = useState<Slot[]>(() =>
    Array.from({ length: POOL_SIZE }, (_, i) => ({
      id: i, active: false, spawnX: 0, spawnY: 0, driftX: 0, driftY: 0, rot: 0,
    }))
  );

  const cursorRef    = useRef(0);
  const xRef         = useRef(x);
  const yRef         = useRef(y);
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
        next[slot] = {
          id:     slot,
          active: true,
          spawnX: xRef.current,
          spawnY: yRef.current,
          driftX: (Math.random() - 0.5) * 24,
          driftY: 16 + Math.random() * 18, // gentle downward drift
          rot:    (Math.random() - 0.5) * 240,
        };
        return next;
      });
    }, SPAWN_RATE_MS);
    return () => clearInterval(id);
  }, [enabled, reduceMotion]);

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
          color={color}
          onDone={handleParticleDone}
        />
      ))}
    </View>
  );
}

// ─── Single particle ──────────────────────────────────────────────────────────

function Particle({
  slot,
  color,
  onDone,
}: {
  slot:   Slot;
  color:  string;
  onDone: (id: number) => void;
}) {
  const opacity   = useSharedValue(0);
  const dx        = useSharedValue(0);
  const dy        = useSharedValue(0);
  const rotation  = useSharedValue(0);
  const scale     = useSharedValue(0.6);

  useEffect(() => {
    if (!slot.active) return;

    // reset
    opacity.value  = 1;
    dx.value       = 0;
    dy.value       = 0;
    rotation.value = 0;
    scale.value    = 0.6;

    // animate out
    const ease = Easing.out(Easing.quad);
    opacity.value  = withTiming(0,           { duration: PARTICLE_LIFE, easing: ease },
                                () => { runOnJS(onDone)(slot.id); });
    dx.value       = withTiming(slot.driftX, { duration: PARTICLE_LIFE, easing: ease });
    dy.value       = withTiming(slot.driftY, { duration: PARTICLE_LIFE, easing: ease });
    rotation.value = withTiming(slot.rot,    { duration: PARTICLE_LIFE, easing: ease });
    scale.value    = withTiming(1.0,         { duration: PARTICLE_LIFE * 0.5, easing: ease });

    // (no need to cancel - interval is in parent)
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
      <Svg width={PARTICLE_SIZE * 2} height={PARTICLE_SIZE * 2} viewBox="0 0 14 14">
        <Path
          d="M7 1 L8.4 5.6 L13 7 L8.4 8.4 L7 13 L5.6 8.4 L1 7 L5.6 5.6 Z"
          fill={color}
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
