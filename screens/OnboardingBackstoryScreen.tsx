/**
 * screens/OnboardingBackstoryScreen.tsx (v2 — no-humans story)
 *
 * Shown ONCE per device, the very first time a child opens Lexi-Lens.
 * Tells the story of who Lumi is and why she lives in the Lens.
 *
 * v2 CHANGES vs v1:
 *   • Panels 2 + 4 no longer reference a human child. Lumi is the only
 *     recurring character. See LUMI_BACKSTORY.md for the rationale (TL;DR:
 *     character-consistency trap for an AI illustration pipeline).
 *   • Image paths now point to /assets/backstory/0N.png by default. The
 *     screen falls back to an animated <LumiMascot/> if the file isn't
 *     present yet — so the screen ships immediately, illustrations
 *     populate as you generate them.
 *
 * Flow:
 *   App.tsx — on mount —
 *     read AsyncStorage('lexilens.backstory.seen')
 *       === null → render <OnboardingBackstoryScreen onComplete={...}/>
 *       else     → existing OnboardingScreen / QuestMap flow
 *
 * Accessibility:
 *   • Each page's text has accessibilityRole="text"
 *   • Skip button is always visible
 *   • Reduced-motion users get static Lumi (LumiMascot honors that)
 *
 * Both Android and iOS: pure View + Animated, no native modules.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Image,
  ImageSourcePropType,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';

import { LumiMascot } from '../components/Lumi';

// ─── Story content ────────────────────────────────────────────────────────────
//
// 5 panels. Read aloud takes ~70 seconds for a 7-year-old.
// Each line is ≤ ~12 words so it fits comfortably on a small phone screen.
//
// CAST: Lumi is the only recurring character. Panels 1, 2, and 5 have no
// figures at all. Panels 3 and 4 feature Lumi + an object. This is a
// deliberate choice — see LUMI_BACKSTORY.md (v2 rationale).

type Panel = {
  title:        string;
  body:         string[];
  /**
   * Optional illustration. Set `image: require('../assets/backstory/0N.png')`
   * once you have the PNG. Leave as null to use the animated Lumi fallback.
   */
  image?:       ImageSourcePropType | null;
  /** Which mood the placeholder LumiMascot shows (when no image is set). */
  lumiMood:     'curious' | 'happy' | 'excited' | 'thinking' | 'sleeping';
  /** Footer button copy. */
  cta:          string;
};

const PANELS: Panel[] = [
  {
    title:    'The First Word',
    body:     [
      'A long time ago, before there were books, before there were even letters, the world was silent.',
      'Trees, stones, rivers, stars — all quiet.',
    ],
     image: require('../assets/backstory/01.png'),
   
    lumiMood: 'thinking',
    cta:      'Next',
  },
  {
    title:    'The First Spark',
    body:     [
      'Then the very first word was spoken — and the world lit up.',
      'Every true word — cloud, warm, crinkly, brave — left a tiny spark behind.',
      'Some sparks hide in books. Some still float around your house.',
    ],
    image: require('../assets/backstory/02.png'),
    
    lumiMood: 'curious',
    cta:      'Next',
  },
  {
    title:    'Meet Lumi',
    body:     [
      'I\'m Lumi! I\'m one of those sparks — the friendliest, my mum says.',
      'I live inside your Lens.',
      'Point me at the right thing and a new spark comes home with you. Forever.',
    ],
     image: require('../assets/backstory/03.png'),
  
    lumiMood: 'excited',
    cta:      'Next',
  },
  {
    title:    'The Quest Tome',
    body:     [
      'The Tome tells you what to find — maybe "something that crinkles".',
      'Look around. Tap to scan.',
      'I peek with you, so wait for me to nod ✨',
    ],
     image: require('../assets/backstory/04.png'),
  
    lumiMood: 'happy',
    cta:      'Next',
  },
  {
    title:    'When my spark fizzles',
    body:     [
      'After lots of scanning I get sleepy.',
      'I rest until sunrise, then come back full of magic.',
      'Tomorrow is always a bigger adventure ✨',
    ],
   image: require('../assets/backstory/05.png'),
  
    lumiMood: 'sleeping',
    cta:      'Let\'s find magic!',
  },
];

// ─── Props ────────────────────────────────────────────────────────────────────

export interface OnboardingBackstoryScreenProps {
  /** Called when the user finishes (or skips) the story. */
  onComplete: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function OnboardingBackstoryScreen({
  onComplete,
}: OnboardingBackstoryScreenProps): React.ReactElement {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [index, setIndex] = useState(0);

  // Fade between panels for a soft transition.
  const fade = useRef(new Animated.Value(1)).current;
  const advance = useCallback((delta: number) => {
    const next = Math.min(PANELS.length - 1, Math.max(0, index + delta));
    if (next === index) {
      if (delta > 0) {
        try { void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
        onComplete();
      }
      return;
    }
    try { void Haptics.selectionAsync(); } catch {}
    Animated.timing(fade, { toValue: 0, duration: 160, useNativeDriver: true, easing: Easing.out(Easing.cubic) }).start(() => {
      setIndex(next);
      Animated.timing(fade, { toValue: 1, duration: 220, useNativeDriver: true, easing: Easing.out(Easing.cubic) }).start();
    });
  }, [index, fade, onComplete]);

  const panel = PANELS[index];
  const isLast = index === PANELS.length - 1;

  const dots = useMemo(() => Array.from({ length: PANELS.length }, (_, i) => i), []);

  return (
    <View style={[styles.root, { paddingTop: insets.top + 12 }]}>
      <Pressable
        onPress={onComplete}
        accessibilityRole="button"
        accessibilityLabel="Skip the story"
        style={styles.skip}
        hitSlop={12}
      >
        <Text style={styles.skipText}>Skip</Text>
      </Pressable>

      <Animated.View style={[styles.panel, { opacity: fade }]}>
        {/* Visual area — either an image, or the LumiMascot doing the mood */}
        <View style={styles.visualWrap}>
          {panel.image ? (
            <Image source={panel.image} style={styles.visualImage} resizeMode="contain" />
          ) : (
            <View style={styles.lumiSlot} pointerEvents="none">
              <LumiMascot
                state={
                  panel.lumiMood === 'sleeping' ? 'out-of-juice'
                  : panel.lumiMood === 'excited' ? 'cheering'
                  : panel.lumiMood === 'curious' ? 'guide'
                  : 'idle'
                }
                size={120}
                position="center"
                muted   // bubble suppressed — the panel text IS the dialogue
              />
            </View>
          )}
        </View>

        <Text style={styles.title} accessibilityRole="header">
          {panel.title}
        </Text>

        {panel.body.map((para, i) => (
          <Text key={i} style={styles.body} accessibilityRole="text">
            {para}
          </Text>
        ))}
      </Animated.View>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.dotsRow}>
          {dots.map(i => (
            <View
              key={i}
              style={[
                styles.dot,
                i === index && styles.dotActive,
              ]}
            />
          ))}
        </View>

        <View style={styles.buttonsRow}>
          {index > 0 && (
            <Pressable
              onPress={() => advance(-1)}
              accessibilityRole="button"
              accessibilityLabel="Go back"
              style={[styles.btn, styles.btnGhost]}
              hitSlop={10}
            >
              <Text style={styles.btnGhostText}>Back</Text>
            </Pressable>
          )}
          <Pressable
            onPress={() => advance(+1)}
            accessibilityRole="button"
            accessibilityLabel={isLast ? 'Begin adventure' : 'Next page'}
            style={[styles.btn, styles.btnPrimary]}
            hitSlop={10}
          >
            <Text style={styles.btnPrimaryText}>{panel.cta}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
// Palette aligned with the Lexi-Lens tokens:
//   --bg #0f0620, --bg-card #1e1040, --accent #f5c842, --text #f3e8ff

const styles = StyleSheet.create({
  root: {
    flex:            1,
    backgroundColor: '#0f0620',
    paddingHorizontal: 20,
  },
  skip: {
    alignSelf:      'flex-end',
    paddingVertical:   6,
    paddingHorizontal: 12,
    borderRadius:      14,
    backgroundColor:   'rgba(40, 26, 69, 0.6)',
  },
  skipText: {
    color:      '#c4b5fd',
    fontSize:   13,
    fontWeight: '600',
  },
  panel: {
    flex:            1,
    alignItems:      'center',
    justifyContent:  'center',
    paddingHorizontal: 8,
  },
  visualWrap: {
    width:           '100%',
    height:          280,
    alignItems:      'center',
    justifyContent:  'center',
    marginBottom:    22,
  },
  visualImage: {
    width:  '100%',
    height: 280,
    borderRadius: 12,
  },
  lumiSlot: {
    width:  180,
    height: 180,
    alignItems:     'center',
    justifyContent: 'center',
  },
  title: {
    fontSize:     26,
    fontWeight:   '800',
    color:        '#f5c842',
    textAlign:    'center',
    marginBottom: 16,
    letterSpacing: -0.4,
  },
  body: {
    fontSize:     16,
    lineHeight:   23,
    color:        '#f3e8ff',
    textAlign:    'center',
    marginBottom: 10,
    paddingHorizontal: 8,
  },
  footer: {
    paddingTop:      18,
  },
  dotsRow: {
    flexDirection:  'row',
    justifyContent: 'center',
    alignItems:     'center',
    marginBottom:   16,
  },
  dot: {
    width:  8,
    height: 8,
    borderRadius:    4,
    marginHorizontal: 4,
    backgroundColor:  'rgba(196, 181, 253, 0.3)',
  },
  dotActive: {
    backgroundColor: '#f5c842',
    width:  20,
  },
  buttonsRow: {
    flexDirection:  'row',
    justifyContent: 'center',
    gap:            12,
  },
  btn: {
    paddingVertical:   14,
    paddingHorizontal: 28,
    borderRadius:      28,
    minWidth:          140,
    alignItems:        'center',
  },
  btnPrimary: {
    backgroundColor: '#f5c842',
  },
  btnPrimaryText: {
    color:      '#0f0620',
    fontSize:   16,
    fontWeight: '800',
  },
  btnGhost: {
    backgroundColor: 'transparent',
    borderWidth:     1,
    borderColor:     'rgba(196, 181, 253, 0.4)',
  },
  btnGhostText: {
    color:      '#c4b5fd',
    fontSize:   15,
    fontWeight: '600',
  },
});

// ─── First-launch gating helper ───────────────────────────────────────────────

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_SEEN = 'lexilens.backstory.seen';

export async function hasSeenBackstory(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(KEY_SEEN);
    return v === '1';
  } catch {
    // Fail safe: if storage broken, don't trap the user in the story screen
    return true;
  }
}

export async function markBackstorySeen(): Promise<void> {
  try { await AsyncStorage.setItem(KEY_SEEN, '1'); } catch { /* no-op */ }
}

/**
 * Dev-only — reset the flag so the story shows again on next launch.
 * Wire to a ParentDashboard debug button if useful.
 */
export async function resetBackstorySeen(): Promise<void> {
  try { await AsyncStorage.removeItem(KEY_SEEN); } catch { /* no-op */ }
}
