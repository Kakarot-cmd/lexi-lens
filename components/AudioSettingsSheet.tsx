/**
 * components/AudioSettingsSheet.tsx — v1.0
 *
 * Bottom-sheet home for game audio (Background music + Game sound effects),
 * opened by the 🎵 button in the Parent Dashboard header. This replaces the
 * inline GameAudioSettingsCard so the dashboard scroll stays short.
 *
 * Lumi's own VOICE + haptics still live in the "Lumi (Mascot)" card below the
 * fold — those are a separate system. (If you later want one single audio home,
 * fold the two Lumi audio rows in here too; it's a small change.)
 *
 * Same engine APIs and graceful-degradation behaviour as the old card:
 *   • rows hidden when expo-audio isn't available
 *   • state hydrated from the engine; writes persist via the engine
 *   • flipping SFX on plays a tiny tap so the parent hears it working
 */

import React, { useEffect, useState } from 'react';
import {
  View, Text, Switch, StyleSheet, Modal, Pressable, TouchableOpacity,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import {
  isGameAudioAvailable,
  isMusicEnabled,
  isSfxEnabled,
  setMusicEnabled,
  setSfxEnabled,
  playSfx,
} from '../lib/audio';

const P = {
  parchment:   '#f5edda',
  cream:       '#fbf5e9',
  warmBorder:  '#e8d5b0',
  inkBrown:    '#3d2a0f',
  inkMid:      '#6b4c1e',
  inkLight:    '#9c7540',
  amberAccent: '#d97706',
  scrim:       'rgba(45, 30, 8, 0.45)',
};

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function AudioSettingsSheet({ visible, onClose }: Props) {
  const audioAvailable = isGameAudioAvailable();
  const [musicOn, setMusicOn] = useState(true);
  const [sfxOn,   setSfxOn]   = useState(true);

  // Re-sync from the engine each time the sheet opens.
  useEffect(() => {
    if (!visible) return;
    try {
      setMusicOn(isMusicEnabled());
      setSfxOn(isSfxEnabled());
    } catch { /* defaults */ }
  }, [visible]);

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
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/* Tap-outside-to-close scrim */}
      <Pressable style={styles.scrim} onPress={onClose}>
        {/* Stop propagation so taps inside the sheet don't close it */}
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />

          <View style={styles.titleRow}>
            <Text style={styles.title}>Sound &amp; Music</Text>
            <TouchableOpacity onPress={onClose} hitSlop={12}>
              <Text style={styles.close}>Done</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.subtitle}>
            The adventure's music bed and tap, success, and victory sounds.
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
              <Text style={styles.note}>Music &amp; sound effects ship in a future update.</Text>
            )}
          </View>

          <Text style={styles.footnote}>
            Lumi's own voice has its own switch in the Lumi section below.
          </Text>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim:     { flex: 1, backgroundColor: P.scrim, justifyContent: 'flex-end' },
  sheet:     {
    backgroundColor: P.cream,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 34,
    borderWidth: 1,
    borderColor: P.warmBorder,
  },
  handle:    { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: P.warmBorder, marginBottom: 14 },
  titleRow:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title:     { fontSize: 19, fontWeight: '700', color: P.inkBrown },
  close:     { fontSize: 15, fontWeight: '700', color: P.amberAccent },
  subtitle:  { fontSize: 13, color: P.inkLight, marginTop: 4, marginBottom: 14, lineHeight: 18 },
  card:      { backgroundColor: P.parchment, borderRadius: 16, borderWidth: 1, borderColor: P.warmBorder, overflow: 'hidden' },
  row:       { flexDirection: 'row', alignItems: 'center', padding: 16 },
  rowDivider:{ borderTopWidth: 1, borderTopColor: P.warmBorder },
  rowLabel:  { fontSize: 15, fontWeight: '600', color: P.inkBrown },
  rowSub:    { fontSize: 12, color: P.inkMid, marginTop: 2 },
  note:      { fontSize: 13, color: P.inkLight, padding: 16, lineHeight: 18 },
  footnote:  { fontSize: 12, color: P.inkLight, marginTop: 12, lineHeight: 17 },
});
