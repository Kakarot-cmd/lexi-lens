/**
 * screens/OnboardingBackstoryScreen.tsx (v3 — fullscreen-immersive)
 *
 * Shown ONCE per device, the very first time a child opens Lexi-Lens.
 * Tells the story of who Lumi is and why she lives in the Lens.
 *
 * ─── v3 CHANGES vs v2 ────────────────────────────────────────────────────────
 *
 * Layout overhaul: each panel is now an EDGE-TO-EDGE fullscreen image with
 * the story text overlaid on the lower portion of the screen. v2 had the
 * image shrunk into a tiny 280pt box with text below it — the watercolor
 * art was wasted at thumbnail scale. v3 lets the art breathe and uses it
 * as the hero element of every panel.
 *
 *   ┌──────────────────────────────┐
 *   │                       [Skip] │   ← Pill button, own backdrop
 *   │                              │
 *   │      (watercolor art         │   ← Image fills the entire screen
 *   │       extends edge-to-edge)  │     resizeMode="cover", center crop
 *   │                              │
 *   │  ═══ gradient scrim begins ══│   ← SVG LinearGradient, transparent
 *   │      The Page Title          │     at top, dark at bottom
 *   │                              │
 *   │      Body line 1.            │
 *   │      Body line 2.            │
 *   │                              │
 *   │      • • ● • •               │   ← Progress dots
 *   │      [ Back ] [ Next ]       │   ← Footer buttons
 *   └──────────────────────────────┘
 *
 * Why a bottom gradient (not a full overlay or a top scrim):
 *   1. ALL FIVE panels have their visual focal point in the upper 50%
 *      (sunset in 1, sparks-from-book in 2, fairy in 3, fairy-on-leaf in 4,
 *      sleeping-fairy in 5). A bottom scrim NEVER covers a focal subject.
 *   2. A full-screen dim would mute the watercolor palette — defeats the
 *      whole point of the upgrade.
 *   3. A top scrim would clash with panel 4 (fairy sits in top third).
 *
 * Text legibility is double-belted:
 *   a) The gradient scrim darkens the band where text sits.
 *   b) Every text element ALSO carries a text-shadow, so even on a pale
 *      image region (e.g. panel 2's book pages) the text reads cleanly.
 *
 * IMPORTANT — if you ever regenerate or replace any of the backstory PNGs,
 * keep the BOTTOM 40% of the composition calm/dark/uncluttered. That zone
 * is now reserved for the text overlay. A bright face or busy detail down
 * there will fight the title even with the scrim.
 *
 * Dependencies: pure React Native + react-native-svg (already in the
 * project — used only for the gradient scrim). No new native deps. Works
 * identically on Android and iOS.
 *
 * ─── Carry-overs from v2 ─────────────────────────────────────────────────────
 *   • Falls back to <LumiMascot/> if a panel.image is missing.
 *   • First-launch gating helpers (hasSeenBackstory / markBackstorySeen /
 *     resetBackstorySeen) unchanged — App.tsx contract preserved.
 *   • Cast policy unchanged (Lumi is the only recurring character; see
 *     LUMI_BACKSTORY.md rationale).
 *
 * Flow:
 *   App.tsx — on mount —
 *     read AsyncStorage('lexilens.backstory.seen')
 *       === null → render <OnboardingBackstoryScreen onComplete={...}/>
 *       else     → existing OnboardingScreen / QuestMap flow
 *
 * Accessibility:
 *   • Each page's text has accessibilityRole="text"
 *   • Skip button is always visible (with its own pill backdrop)
 *   • Reduced-motion users get static Lumi (LumiMascot honors that)
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Image,
  ImageSourcePropType,
  Pressable,
  StatusBar,
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
  title: string;
  body: string[];
  /**
   * Optional illustration. Set `image: require('../assets/backstory/0N.png')`
   * once you have the PNG. Leave as null to use the animated Lumi fallback.
   */
  image?: ImageSourcePropType | null;
  /** Which mood the placeholder LumiMascot shows (when no image is set). */
  lumiMood: 'curious' | 'happy' | 'excited' | 'thinking' | 'sleeping';
  /** Footer button copy. */
  cta: string;
};

const PANELS: Panel[] = [
  {
    title: 'The First Word',
    body: [
      'A long time ago, before there were books, before there were even letters, the world was silent.',
      'Trees, stones, rivers, stars — all quiet.',
    ],
    image: require('../assets/backstory/01.png'),
    lumiMood: 'thinking',
    cta: 'Next',
  },
  {
    title: 'The First Spark',
    body: [
      'Then the very first word was spoken — and the world lit up.',
      'Every true word — cloud, warm, crinkly, brave — left a tiny spark behind.',
      'Some sparks hide in books. Some still float around your house.',
    ],
    image: require('../assets/backstory/02.png'),
    lumiMood: 'curious',
    cta: 'Next',
  },
  {
    title: 'Meet Lumi',
    body: [
      'I\'m Lumi! I\'m one of those sparks — the friendliest, my mum says.',
      'I live inside your Lens.',
      'Point me at the right thing and a new spark comes home with you. Forever.',
    ],
    image: require('../assets/backstory/03.png'),
    lumiMood: 'excited',
    cta: 'Next',
  },
  {
    title: 'The Quest Tome',
    body: [
      'The Tome tells you what to find — maybe "something that crinkles".',
      'Look around. Tap to scan.',
      'I peek with you, so wait for me to nod ✨',
    ],
    image: require('../assets/backstory/04.png'),
    lumiMood: 'happy',
    cta: 'Next',
  },
  {
    title: 'When my spark fizzles',
    body: [
      'After lots of scanning I get sleepy.',
      'I rest until sunrise, then come back full of magic.',
      'Tomorrow is always a bigger adventure ✨',
    ],
    image: require('../assets/backstory/05.png'),
    lumiMood: 'sleeping',
    cta: 'Let\'s find magic!',
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
  const { width, height } = useWindowDimensions();
  const [index, setIndex] = useState(0);

  // Cross-fade between panels. Both the image and the text fade together,
  // so the panel feels like a single thing changing — not two layers
  // popping out of sync.
  const fade = useRef(new Animated.Value(1)).current;

  const advance = useCallback(
    (delta: number) => {
      const next = Math.min(PANELS.length - 1, Math.max(0, index + delta));
      if (next === index) {
        if (delta > 0) {
          try {
            void Haptics.notificationAsync(
              Haptics.NotificationFeedbackType.Success,
            );
          } catch {}
          onComplete();
        }
        return;
      }
      try {
        void Haptics.selectionAsync();
      } catch {}
      Animated.timing(fade, {
        toValue: 0,
        duration: 160,
        useNativeDriver: true,
        easing: Easing.out(Easing.cubic),
      }).start(() => {
        setIndex(next);
        Animated.timing(fade, {
          toValue: 1,
          duration: 240,
          useNativeDriver: true,
          easing: Easing.out(Easing.cubic),
        }).start();
      });
    },
    [index, fade, onComplete],
  );

  const panel = PANELS[index];
  const isLast = index === PANELS.length - 1;

  const dots = useMemo(
    () => Array.from({ length: PANELS.length }, (_, i) => i),
    [],
  );

  return (
    <View style={styles.root}>
      {/* Light-content status bar — every image has a dark/calm top area. */}
      <StatusBar
        barStyle="light-content"
        translucent
        backgroundColor="transparent"
      />

      {/* ─── Layer 1: fullscreen image (or Lumi fallback) ──────────────── */}
      {/*
        Image-rendering note: the Image is wrapped in an Animated.View
        rather than using Animated.createAnimatedComponent(Image). Reason:
        on RN 0.81 + Hermes + new arch (Android in particular), the
        Animated.Image wrapper under useNativeDriver:true does not reliably
        forward `resizeMode` or the absoluteFill measurement to the native
        side — the image falls back to its intrinsic pixel dimensions
        (1200×1800) anchored top-left, which on a 3x display shows only the
        upper-left ~30% of the art. Animating opacity on a View instead and
        keeping a plain <Image> child with explicit width/height in DPs
        sidesteps the whole class of bug.
      */}
      {panel.image ? (
        <Animated.View
          style={[
            StyleSheet.absoluteFillObject,
            { opacity: fade, overflow: 'hidden' },
          ]}
          pointerEvents="none"
        >
          <Image
            source={panel.image}
            // Explicit DPs so resizeMode has a fixed box to crop inside.
            // `width` / `height` come from useWindowDimensions and update
            // on rotation / fold-state changes.
            style={{ width, height }}
            resizeMode="cover"
            // Screen readers skip the image — the <Text> header below already
            // announces the panel title. Avoids double-reading the same label.
            accessibilityElementsHidden
            importantForAccessibility="no"
          />
        </Animated.View>
      ) : (
        // Fallback path: no PNG → solid bg + centered LumiMascot doing the
        // mood. Mirrors the v2 behaviour so the screen ships even if any
        // image asset is ever missing.
        <Animated.View
          style={[
            StyleSheet.absoluteFillObject,
            {
              backgroundColor: '#0f0620',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: fade,
            },
          ]}
        >
          <LumiMascot
            state={
              panel.lumiMood === 'sleeping'
                ? 'out-of-juice'
                : panel.lumiMood === 'excited'
                ? 'cheering'
                : panel.lumiMood === 'curious'
                ? 'guide'
                : 'idle'
            }
            size={160}
            position="center"
            muted
          />
        </Animated.View>
      )}

      {/* ─── Layer 2: Skip pill, top-right ─────────────────────────────── */}
      {/*
        Lives ABOVE the card, so given more clearance from the status-bar
        icons (insets.top + 18 vs the previous +8 — was visually cramped
        against Samsung notification icons).
      */}
      <View
        style={[styles.topBar, { paddingTop: insets.top + 18 }]}
        pointerEvents="box-none"
      >
        <Pressable
          onPress={onComplete}
          accessibilityRole="button"
          accessibilityLabel="Skip the story"
          style={({ pressed }) => [
            styles.skip,
            pressed && { opacity: 0.7 },
          ]}
          hitSlop={12}
        >
          <Text style={styles.skipText}>Skip</Text>
        </Pressable>
      </View>

      {/* ─── Layer 3: storybook-style text card + footer (anchored bottom) ─ */}
      {/*
        Replaces the previous SVG bottom-gradient. The gradient worked on
        dark image regions (panels 1/3/5) but failed on bright ones
        (panel 2's cream book pages, panel 4's orange leaf) where gold
        title on bright watercolour bled into illegibility.
        
        The card is a semi-transparent (≈55% alpha) dark panel pinned to
        the bottom, with rounded top corners and a hairline purple border
        for definition. Image still shows through at ~45% — it's a stage
        for the text, not a wall in front of the art. Same backdrop on
        every panel = consistent text contrast regardless of what's
        behind it. Soft top-shadow gives the card lift off the image
        without needing a real blur library.
        
        Animated.View wraps the *contents* (not the card itself) so the
        card stays put while title/body/dots cross-fade between panels.
      */}
      <View
        style={[
          styles.card,
          { paddingBottom: insets.bottom + 18 },
        ]}
        pointerEvents="box-none"
      >
        <Animated.View
          style={[styles.cardInner, { opacity: fade }]}
          pointerEvents="box-none"
        >
          <Text style={styles.title} accessibilityRole="header">
            {panel.title}
          </Text>

          {panel.body.map((para, i) => (
            <Text key={i} style={styles.body} accessibilityRole="text">
              {para}
            </Text>
          ))}

          <View style={styles.dotsRow}>
            {dots.map(i => (
              <View
                key={i}
                style={[styles.dot, i === index && styles.dotActive]}
              />
            ))}
          </View>

          <View style={styles.buttonsRow}>
            {index > 0 && (
              <Pressable
                onPress={() => advance(-1)}
                accessibilityRole="button"
                accessibilityLabel="Go back"
                style={({ pressed }) => [
                  styles.btn,
                  styles.btnGhost,
                  pressed && { opacity: 0.7 },
                ]}
                hitSlop={10}
              >
                <Text style={styles.btnGhostText}>Back</Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => advance(+1)}
              accessibilityRole="button"
              accessibilityLabel={isLast ? 'Begin adventure' : 'Next page'}
              style={({ pressed }) => [
                styles.btn,
                styles.btnPrimary,
                pressed && { opacity: 0.85 },
              ]}
              hitSlop={10}
            >
              <Text style={styles.btnPrimaryText}>{panel.cta}</Text>
            </Pressable>
          </View>
        </Animated.View>
      </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
// Palette aligned with the Lexi-Lens tokens:
//   --bg #0f0620, --bg-card #1e1040, --accent #f5c842, --text #f3e8ff

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0f0620', // fallback if image hasn't decoded yet
  },

  // ── Top bar (Skip pill, floats over image) ──────────────────────────────
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    alignItems: 'flex-end',
    zIndex: 10,
  },
  skip: {
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 16,
    // Darker, more opaque pill — needs to read against ANY image region
    // since there is no top-scrim. The pill IS the scrim for this control.
    backgroundColor: 'rgba(15, 6, 32, 0.65)',
    borderWidth: 1,
    borderColor: 'rgba(196, 181, 253, 0.25)',
  },
  skipText: {
    color: '#f3e8ff',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.2,
  },

  // ── Storybook text card (semi-opaque dark stage at bottom) ─────────────
  card: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(15, 6, 32, 0.55)',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    // Hairline rim-light at the top edge of the card — gives definition
    // against bright image regions (panel 2's book pages, panel 4's leaf).
    borderTopColor: 'rgba(196, 181, 253, 0.22)',
    paddingHorizontal: 22,
    paddingTop: 22,
    alignItems: 'center',
    zIndex: 5,
    // Soft lift off the image — substitutes for a backdrop-blur since
    // we don't have expo-blur in the bundle.
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 14,
  },
  cardInner: {
    width: '100%',
    alignItems: 'center',
  },

  title: {
    fontSize: 26,
    fontWeight: '800',
    color: '#f5c842',
    textAlign: 'center',
    marginBottom: 10,
    letterSpacing: -0.3,
    // Strong halo — even with the card at 0.55 alpha, gold needs help
    // against the bright watercolour bleeding through (panels 2, 4).
    textShadowColor: 'rgba(0, 0, 0, 0.92)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 14,
  },
  body: {
    fontSize: 15,
    lineHeight: 21,
    color: '#f3e8ff',
    textAlign: 'center',
    marginBottom: 6,
    paddingHorizontal: 4,
    fontWeight: '500', // bumped from default 400 — sits better on watercolour
    textShadowColor: 'rgba(0, 0, 0, 0.85)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 8,
  },

  // ── Progress dots ──────────────────────────────────────────────────────
  dotsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 10,
    marginBottom: 12,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginHorizontal: 4,
    backgroundColor: 'rgba(243, 232, 255, 0.35)',
  },
  dotActive: {
    backgroundColor: '#f5c842',
    width: 22,
  },

  // ── Buttons ────────────────────────────────────────────────────────────
  buttonsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
  },
  btn: {
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 28,
    minWidth: 140,
    alignItems: 'center',
  },
  btnPrimary: {
    backgroundColor: '#f5c842',
    // Soft gold halo so the primary CTA lifts off the card surface
    shadowColor: '#f5c842',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.45,
    shadowRadius: 12,
    elevation: 6,
  },
  btnPrimaryText: {
    color: '#0f0620',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  btnGhost: {
    backgroundColor: 'rgba(15, 6, 32, 0.55)',
    borderWidth: 1,
    borderColor: 'rgba(196, 181, 253, 0.45)',
  },
  btnGhostText: {
    color: '#f3e8ff',
    fontSize: 15,
    fontWeight: '600',
  },
});

// ─── First-launch gating helper ───────────────────────────────────────────────
//
// PRESERVED unchanged from v2 — App.tsx imports these and the public
// contract must stay stable. Storage key is the same so existing users
// who already saw v2's story don't see v3 again.

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
  try {
    await AsyncStorage.setItem(KEY_SEEN, '1');
  } catch {
    /* no-op */
  }
}

/**
 * Dev-only — reset the flag so the story shows again on next launch.
 * Wire to a ParentDashboard debug button if useful.
 */
export async function resetBackstorySeen(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY_SEEN);
  } catch {
    /* no-op */
  }
}
