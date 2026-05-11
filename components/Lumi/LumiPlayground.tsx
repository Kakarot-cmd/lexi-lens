/**
 * components/Lumi/LumiPlayground.tsx
 *
 * Dev-only preview screen — shows all 8 Lumi states side by side.
 *
 * Usage:
 *   1. Import LumiPlayground in App.tsx (or wrap behind __DEV__).
 *   2. Add to your navigator as a hidden route, or render directly.
 *   3. Tap any cell to cycle that cell to the next mood.
 *
 * Not shipped — strip from production builds via:
 *     {__DEV__ && <Stack.Screen name="LumiPlayground" .../>}
 */

import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { LumiMascot } from './LumiMascot';
import type { LumiState } from './lumiTypes';

const ALL_STATES: LumiState[] = [
  'idle', 'guide', 'scanning', 'looking-up', 'success',
  'fail', 'boss-help', 'out-of-juice', 'cheering',
];

export function LumiPlayground(): React.ReactElement {
  const [hardMode, setHardMode]     = useState(false);
  const [muted, setMuted]           = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.scroll}>
      <Text style={styles.h1}>Lumi Playground</Text>
      <Text style={styles.sub}>
        All 9 states. Long-press any Lumi to mute her locally.
      </Text>

      <View style={styles.controls}>
        <Toggle label="Hard mode"     value={hardMode}     onChange={setHardMode} />
        <Toggle label="Muted"         value={muted}        onChange={setMuted} />
        <Toggle label="Reduce motion" value={reduceMotion} onChange={setReduceMotion} />
      </View>

      <View style={styles.grid}>
        {ALL_STATES.map(state => (
          <Cell
            key={state}
            state={state}
            hardMode={hardMode}
            muted={muted}
            reduceMotion={reduceMotion}
          />
        ))}
      </View>
    </ScrollView>
  );
}

function Cell({
  state, hardMode, muted, reduceMotion,
}: {
  state: LumiState; hardMode: boolean; muted: boolean; reduceMotion: boolean;
}) {
  return (
    <View style={styles.cell}>
      <Text style={styles.cellLabel}>{state}</Text>
      <View style={styles.cellStage}>
        <LumiMascot
          state={state}
          hardMode={hardMode}
          muted={muted}
          reduceMotion={reduceMotion}
          position="center"
          size={56}
        />
      </View>
    </View>
  );
}

function Toggle({
  label, value, onChange,
}: {
  label: string; value: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <Pressable style={styles.toggle} onPress={() => onChange(!value)}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch value={value} onValueChange={onChange} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root:   { flex: 1, backgroundColor: '#0f0620' },
  scroll: { padding: 16, paddingBottom: 64 },
  h1:     { fontSize: 22, fontWeight: '700', color: '#f5c842', marginTop: 16 },
  sub:    { fontSize: 13, color: '#8a7aa8', marginTop: 4, marginBottom: 16 },
  controls: {
    backgroundColor: '#20143a',
    borderRadius:    10,
    padding:         12,
    gap:             8,
    marginBottom:    20,
  },
  toggle: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
  },
  toggleLabel: { color: '#f3e8ff', fontSize: 14 },
  grid: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    gap:           12,
  },
  cell: {
    width:           '48%',
    backgroundColor: '#20143a',
    borderRadius:    10,
    padding:         8,
    borderWidth:     1,
    borderColor:     '#382a55',
  },
  cellLabel: {
    color:      '#c4b5d8',
    fontSize:   12,
    fontWeight: '600',
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  cellStage: {
    height:          160,
    borderRadius:    8,
    backgroundColor: '#0f0620',
    overflow:        'hidden',
  },
});
