/**
 * components/GameAudioSettingsCard.tsx — v1.0
 *
 * Parent controls for game-wide audio: Background music + Game sound effects.
 * Mounts in ParentDashboard next to the existing "Lumi (Mascot)" card. Lumi's
 * own VOICE + haptics stay on their own toggles in that card — these two are
 * the music bed and the UI/feedback SFX, which are a separate system.
 *
 * Mirrors LumiSettingsCard's look + behaviour:
 *   • Rows hidden when expo-audio isn't available (graceful no-op build).
 *   • State hydrated from the engine; writes persist via the engine.
 *   • Flipping SFX on plays a tiny tap so the parent hears it's working.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, Switch, StyleSheet } from 'react-native';
import * as Haptics from 'expo-haptics';
import {
  isGameAudioAvailable,
  isMusicEnabled,
  isSfxEnabled,
  setMusicEnabled,
  setSfxEnabled,
  playSfx,
} from '../lib/audio';

// Local palette (matches ParentDashboard's inline P tokens).
const P = {
  parchment:   '#f5edda',
  warmBorder:  '#e8d5b0',
  inkBrown:    '#3d2a0f',
  inkMid:      '#6b4c1e',
  inkLight:    '#9c7540',
  amberAccent: '#d97706',
};

export function GameAudioSettingsCard() {
  const audioAvailable = isGameAudioAvailable();
  const [musicOn, setMusicOn] = useState(true);
  const [sfxOn,   setSfxOn]   = useState(true);

  useEffect(() => {
    // Engine state is synchronous after init; reflect it on mount.
    try {
      setMusicOn(isMusicEnabled());
      setSfxOn(isSfxEnabled());
    } catch { /* defaults */ }
  }, []);

  const onToggleMusic = async (val: boolean) => {
    setMusicOn(val);
    try { await setMusicEnabled(val); } catch { /* non-fatal */ }
  };

  const onToggleSfx = async (val: boolean) => {
    setSfxOn(val);
    try { await setSfxEnabled(val); } catch { /* non-fatal */ }
    if (val) {
      try { playSfx('tap'); } catch {}
      try { Haptics.selectionAsync(); } catch {}
    }
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Sound &amp; Music</Text>
      <Text style={styles.sectionDesc}>
        The adventure's music bed and tap, success, and victory sounds. Lumi's own
        voice has its own switch in the section below.
      </Text>

      <View style={styles.card}>
        {audioAvailable ? (
          <>
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowLabel}>Background music</Text>
                <Text style={styles.rowSub}>A gentle bed that changes with the screen</Text>
              </View>
              <Switch
                value={musicOn}
                onValueChange={onToggleMusic}
                trackColor={{ false: P.warmBorder, true: P.amberAccent }}
                thumbColor={musicOn ? P.inkBrown : P.parchment}
                ios_backgroundColor={P.warmBorder}
              />
            </View>

            <View style={[styles.row, styles.rowDivider]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowLabel}>Game sound effects</Text>
                <Text style={styles.rowSub}>Taps, screen changes, success, and victory chimes</Text>
              </View>
              <Switch
                value={sfxOn}
                onValueChange={onToggleSfx}
                trackColor={{ false: P.warmBorder, true: P.amberAccent }}
                thumbColor={sfxOn ? P.inkBrown : P.parchment}
                ios_backgroundColor={P.warmBorder}
              />
            </View>
          </>
        ) : (
          <Text style={styles.note}>
            Music &amp; sound effects ship in a future update.
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section:     { marginTop: 24, paddingHorizontal: 4 },
  sectionTitle:{ fontSize: 18, fontWeight: '700', color: P.inkBrown, marginBottom: 4 },
  sectionDesc: { fontSize: 13, color: P.inkLight, marginBottom: 12, lineHeight: 18 },
  card:        { backgroundColor: P.parchment, borderRadius: 16, borderWidth: 1, borderColor: P.warmBorder, overflow: 'hidden' },
  row:         { flexDirection: 'row', alignItems: 'center', padding: 16 },
  rowDivider:  { borderTopWidth: 1, borderTopColor: P.warmBorder },
  rowLabel:    { fontSize: 15, fontWeight: '600', color: P.inkBrown },
  rowSub:      { fontSize: 12, color: P.inkMid, marginTop: 2 },
  note:        { fontSize: 13, color: P.inkLight, padding: 16, lineHeight: 18 },
});
