/**
 * OnboardingScreen.tsx — Lexi-Lens N1: First-Session Onboarding
 *
 * Shown exactly once per device after the first child profile is selected.
 * Gate: gameStore.hasSeenOnboarding (Zustand + AsyncStorage).
 *
 * ─── 3 Steps ──────────────────────────────────────────────────────────────────
 *   0  "Your Magic Lens"   point camera at any object in the room
 *   1  "Pick a Quest"      choose from the quest map
 *   2  "Your Word Tome"    words saved, spells unlocked (+10 XP reward)
 *
 * ─── Animations (Reanimated 3) ────────────────────────────────────────────────
 *   • Horizontal slide pager          withSpring translateX on SCREEN_WIDTH grid
 *   • Illustration entrance           withSpring scale + withTiming opacity per step
 *   • Pulse ring (step 0)             withRepeat withSequence — scale + opacity loop
 *   • Quest-node stagger (step 1)     withSpring with 200 ms / 400 ms setTimeout delays
 *   • XP badge pop (step 2)           withSpring scale after 400 ms delay
 *   • Active dot pill                 withTiming width 8 px → 24 px
 *   • Final CTA heartbeat             withRepeat withSequence withSpring scale
 *
 * ─── Gestures ─────────────────────────────────────────────────────────────────
 *   • PanResponder swipe ±50 px threshold (stepRef avoids stale-closure issue)
 *   • Tap CTA button or progress dots to advance
 *   • Skip button exits early on steps 0 and 1; hidden on step 2
 *
 * ─── Side-effects ─────────────────────────────────────────────────────────────
 *   • expo-haptics: light impact on step change, success on completion
 *   • markOnboardingComplete() writes flag to Zustand + AsyncStorage
 *   • navigation.replace("QuestMap") — replace so back-press can't return here
 *
 * ─── Lumi addition (this file) ────────────────────────────────────────────────
 *   • LumiHUD overlays the screen with a per-step message
 *   • She's Lexi-Lens's spokesperson for the user's first 30 seconds
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Dimensions,
  PanResponder,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ViewStyle,
} from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useGameStore } from "../store/gameStore";

import { LumiHUD } from "../components/Lumi";

// ─── Navigation typing ────────────────────────────────────────────────────────
// Must stay consistent with the RootStackParamList in App.tsx after you add
// "Onboarding: undefined" there.

import type { RootStackParamList } from "../types/navigation";

type Props = NativeStackScreenProps<RootStackParamList, "Onboarding">;

// ─── Constants ────────────────────────────────────────────────────────────────

const { width: SCREEN_WIDTH } = Dimensions.get("window");

/** Shared colour tokens — mirror the rest of the app palette. */
const P = {
  bg:        "#0f0620",   // root background (matches QuestMap)
  bgCard:    "#1c0f36",   // illustration card surface
  gold:      "#f5c842",   // primary CTA / active accent
  purple:    "#a78bfa",   // secondary accent
  purpleDim: "#3b2278",   // borders and connectors
  inkLight:  "#e9d5ff",   // primary text on dark bg
  inkFaint:  "#7c5cbf",   // muted text / inactive dots
} as const;

// ─── Step definitions ─────────────────────────────────────────────────────────

const STEPS = [
  {
    title: "Your Magic Lens",
    body:  "Point your camera at anything around you — a chair, a cup, a leaf. Lexi-Lens spots it and builds a quest just for that object.",
    cta:   "Show me →",
  },
  {
    title: "Pick a Quest",
    body:  "Each quest hides vocabulary inside everyday objects. Find colours, textures, shapes and sounds — one word at a time.",
    cta:   "Next →",
  },
  {
    title: "Your Word Tome",
    body:  "Every word you discover lives in your Word Tome forever. Master words to unlock new spells and level up your adventurer!",
    cta:   "Let's go! 🚀",
  },
] as const;

// Lumi messages keyed to each step
const LUMI_STEP_MESSAGES = [
  "Hi! I'm Lumi, your spark guide ✨",
  "Pick the next quest you want to try!",
  "Words you find live in your Tome ✨",
] as const;

// ─── Helper: corner bracket ───────────────────────────────────────────────────
// Four of these compose the camera viewfinder in step 0.

function CornerBracket({
  position,
  color,
  size = 24,
  thickness = 3,
}: {
  position: "tl" | "tr" | "bl" | "br";
  color: string;
  size?: number;
  thickness?: number;
}) {
  const base: ViewStyle = {
    position: "absolute",
    width: size,
    height: size,
    borderColor: color,
  };
  const edge: Record<string, ViewStyle> = {
    tl: { top: 0,    left: 0,    borderTopWidth:    thickness, borderLeftWidth:   thickness },
    tr: { top: 0,    right: 0,   borderTopWidth:    thickness, borderRightWidth:  thickness },
    bl: { bottom: 0, left: 0,    borderBottomWidth: thickness, borderLeftWidth:   thickness },
    br: { bottom: 0, right: 0,   borderBottomWidth: thickness, borderRightWidth:  thickness },
  };
  return <View style={[base, edge[position]]} />;
}

// ─── Step 0 illustration: Scanner viewfinder ─────────────────────────────────
// Renders four corner brackets around a pulsing ring + centre dot.
// Entrance: scale 0.5 → 1 with spring when isActive turns true.
// Pulse ring: continuous scale + opacity loop while active.

function ScannerIllustration({ isActive }: { isActive: boolean }) {
  const scale       = useSharedValue(0.5);
  const opacity     = useSharedValue(0);
  const ringScale   = useSharedValue(0.8);
  const ringOpacity = useSharedValue(0.7);

  useEffect(() => {
    if (isActive) {
      scale.value   = withSpring(1, { damping: 10, stiffness: 180 });
      opacity.value = withTiming(1, { duration: 350 });

      // Expand ring out and fade it — loops indefinitely
      ringScale.value = withRepeat(
        withSequence(
          withTiming(1.7, { duration: 900, easing: Easing.out(Easing.ease) }),
          withTiming(0.8, { duration: 0 }),
        ),
        -1,
        false,
      );
      ringOpacity.value = withRepeat(
        withSequence(
          withTiming(0, { duration: 900, easing: Easing.out(Easing.ease) }),
          withTiming(0.7, { duration: 0 }),
        ),
        -1,
        false,
      );
    } else {
      scale.value   = 0.5;
      opacity.value = 0;
    }
  }, [isActive]);

  const wrapStyle = useAnimatedStyle(() => ({
    opacity:   opacity.value,
    transform: [{ scale: scale.value }],
  }));
  const ringStyle = useAnimatedStyle(() => ({
    opacity:   ringOpacity.value,
    transform: [{ scale: ringScale.value }],
  }));

  return (
    <Animated.View style={[styles.illustWrap, wrapStyle]}>
      {/* Viewfinder box */}
      <View style={styles.viewfinder}>
        <CornerBracket position="tl" color={P.gold} />
        <CornerBracket position="tr" color={P.gold} />
        <CornerBracket position="bl" color={P.gold} />
        <CornerBracket position="br" color={P.gold} />

        {/* Pulse ring — centered via absolute positioning */}
        <Animated.View style={[styles.pulseRing, ringStyle]} />

        {/* Target dot */}
        <View style={styles.targetDot} />
      </View>

      <Text style={styles.illustCaption}>scanning…</Text>
    </Animated.View>
  );
}

// ─── Step 1 illustration: Quest map preview ───────────────────────────────────
// Three nodes on a parchment card; each node springs in with a staggered delay.

function QuestMapIllustration({ isActive }: { isActive: boolean }) {
  const scale   = useSharedValue(0.5);
  const opacity = useSharedValue(0);
  const n0Op    = useSharedValue(0);
  const n1Scale = useSharedValue(0.6);
  const n1Op    = useSharedValue(0);
  const n2Op    = useSharedValue(0);

  // Store timer ids so we can cancel on unmount / deactivation
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    // Clear any pending timers
    timers.current.forEach(clearTimeout);
    timers.current = [];

    if (isActive) {
      scale.value   = withSpring(1, { damping: 10, stiffness: 180 });
      opacity.value = withTiming(1, { duration: 350 });

      n0Op.value    = withTiming(1, { duration: 300 });

      timers.current.push(setTimeout(() => {
        n1Op.value    = withSpring(1, { damping: 12, stiffness: 200 });
        n1Scale.value = withSpring(1, { damping: 8,  stiffness: 200 });
      }, 200));

      timers.current.push(setTimeout(() => {
        n2Op.value = withSpring(1, { damping: 12, stiffness: 200 });
      }, 420));
    } else {
      scale.value   = 0.5; opacity.value = 0;
      n0Op.value    = 0;
      n1Op.value    = 0; n1Scale.value = 0.6;
      n2Op.value    = 0;
    }

    return () => { timers.current.forEach(clearTimeout); };
  }, [isActive]);

  const wrapStyle = useAnimatedStyle(() => ({
    opacity: opacity.value, transform: [{ scale: scale.value }],
  }));
  const n0Style = useAnimatedStyle(() => ({ opacity: n0Op.value }));
  const n1Style = useAnimatedStyle(() => ({
    opacity: n1Op.value, transform: [{ scale: n1Scale.value }],
  }));
  const n2Style = useAnimatedStyle(() => ({ opacity: n2Op.value }));

  return (
    <Animated.View style={[styles.illustWrap, wrapStyle]}>
      <View style={styles.parchment}>
        <Text style={styles.parchmentHeader}>📜  Quest Map</Text>

        <View style={styles.nodesRow}>
          {/* Node 0 — completed */}
          <Animated.View style={[styles.nodeCol, n0Style]}>
            <View style={[styles.questNode, styles.nodeDone]}>
              <Text style={styles.nodeEmoji}>⚔️</Text>
            </View>
            <Text style={[styles.nodeWord, { color: "#4ade80" }]}>apple</Text>
          </Animated.View>

          <View style={styles.connector} />

          {/* Node 1 — active (bounces in largest) */}
          <Animated.View style={[styles.nodeCol, n1Style]}>
            <View style={[styles.questNode, styles.nodeActive]}>
              <Text style={styles.nodeEmoji}>🌟</Text>
            </View>
            <Text style={[styles.nodeWord, { color: P.gold }]}>chair</Text>
          </Animated.View>

          <View style={styles.connector} />

          {/* Node 2 — locked */}
          <Animated.View style={[styles.nodeCol, n2Style]}>
            <View style={[styles.questNode, styles.nodeLocked]}>
              <Text style={styles.nodeEmoji}>🔒</Text>
            </View>
            <Text style={[styles.nodeWord, { color: P.inkFaint }]}>mug</Text>
          </Animated.View>
        </View>
      </View>

      <Text style={styles.illustCaption}>3 quests unlocked</Text>
    </Animated.View>
  );
}

// ─── Step 2 illustration: Word Tome open book ─────────────────────────────────
// An open two-page book with word rows.
// XP badge pops in after 400 ms.

function WordTomeIllustration({ isActive }: { isActive: boolean }) {
  const scale   = useSharedValue(0.5);
  const opacity = useSharedValue(0);
  const xpScale = useSharedValue(0);

  const xpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (xpTimer.current) clearTimeout(xpTimer.current);

    if (isActive) {
      scale.value   = withSpring(1, { damping: 10, stiffness: 180 });
      opacity.value = withTiming(1, { duration: 350 });
      xpTimer.current = setTimeout(() => {
        xpScale.value = withSpring(1.05, { damping: 8, stiffness: 220 });
      }, 400);
    } else {
      scale.value   = 0.5;
      opacity.value = 0;
      xpScale.value = 0;
    }

    return () => { if (xpTimer.current) clearTimeout(xpTimer.current); };
  }, [isActive]);

  const wrapStyle = useAnimatedStyle(() => ({
    opacity: opacity.value, transform: [{ scale: scale.value }],
  }));
  const xpStyle = useAnimatedStyle(() => ({
    transform: [{ scale: xpScale.value }],
  }));

  return (
    <Animated.View style={[styles.illustWrap, wrapStyle]}>
      {/* Open book */}
      <View style={styles.book}>
        {/* Spine */}
        <View style={styles.spine} />

        {/* Left page */}
        <View style={styles.bookPage}>
          <Text style={styles.bookPageTitle}>📖 My Words</Text>
          {["crimson", "grainy", "hollow"].map((w) => (
            <Text key={w} style={styles.bookWord}>{w}</Text>
          ))}
        </View>

        {/* Right page */}
        <View style={styles.bookPage}>
          <Text style={styles.bookPageTitle}>✨ Mastered</Text>
          {["smooth", "cobalt"].map((w) => (
            <Text key={w} style={styles.bookWord}>{w}</Text>
          ))}
        </View>
      </View>

      {/* XP badge — absolute, overlaps top-right corner of book */}
      <Animated.View style={[styles.xpBadge, xpStyle]}>
        <Text style={styles.xpText}>+10 XP</Text>
      </Animated.View>

      <Text style={styles.illustCaption}>5 words discovered</Text>
    </Animated.View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export function OnboardingScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const markOnboardingComplete = useGameStore((s) => s.markOnboardingComplete);

  // Both state (triggers re-renders) and a ref (stays fresh inside PanResponder)
  const [step, setStepState] = useState(0);
  const stepRef = useRef(0);

  const setStep = useCallback((s: number) => {
    stepRef.current = s;
    setStepState(s);
  }, []);

  // ── Slide pager ─────────────────────────────────────────────────────────
  // All three slides sit side-by-side; translateX moves the track left.
  // Step 0 → translateX 0, Step 1 → -SCREEN_WIDTH, Step 2 → -2*SCREEN_WIDTH

  const translateX = useSharedValue(0);
  const slideStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  // ── CTA heartbeat on final step ──────────────────────────────────────────
  const ctaScale = useSharedValue(1);
  const ctaStyle = useAnimatedStyle(() => ({
    transform: [{ scale: ctaScale.value }],
  }));

  useEffect(() => {
    if (step === 2) {
      ctaScale.value = withRepeat(
        withSequence(
          withSpring(1.05, { damping: 6, stiffness: 280 }),
          withSpring(1.00, { damping: 6, stiffness: 280 }),
        ),
        -1,
        true,
      );
    } else {
      ctaScale.value = withTiming(1, { duration: 150 });
    }
  }, [step]);

  // ── Dot pill widths (8 px inactive → 24 px active) ───────────────────────
  const dw = [
    useSharedValue(24),  // step 0 starts active
    useSharedValue(8),
    useSharedValue(8),
  ];
  const dotStyles = dw.map((sv) =>
    useAnimatedStyle(() => ({ width: sv.value })),
  );

  const refreshDots = useCallback((active: number) => {
    dw.forEach((sv, i) => {
      sv.value = withTiming(i === active ? 24 : 8, { duration: 250 });
    });
  }, []);

  // ── Core advance function ─────────────────────────────────────────────────
  const advanceTo = useCallback((nextStep: number) => {
    setStep(nextStep);
    refreshDots(nextStep);
    translateX.value = withSpring(-nextStep * SCREEN_WIDTH, {
      damping: 18,
      stiffness: 200,
    });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [setStep, refreshDots]);

  // Keep a ref so PanResponder always calls the latest advanceTo
  const advanceRef = useRef(advanceTo);
  useEffect(() => { advanceRef.current = advanceTo; }, [advanceTo]);

  // ── Complete handler ──────────────────────────────────────────────────────
  const handleComplete = useCallback(() => {
    markOnboardingComplete();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    // replace() so the back gesture cannot return to onboarding
    navigation.replace("QuestMap");
  }, [markOnboardingComplete, navigation]);

  const handleNext = useCallback(() => {
    if (stepRef.current < 2) {
      advanceTo(stepRef.current + 1);
    } else {
      handleComplete();
    }
  }, [advanceTo, handleComplete]);

  // ── Swipe gesture ─────────────────────────────────────────────────────────
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, { dx, dy }) =>
        Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 12,
      onPanResponderRelease: (_, { dx }) => {
        if (dx < -50 && stepRef.current < 2) {
          advanceRef.current(stepRef.current + 1);
        } else if (dx > 50 && stepRef.current > 0) {
          advanceRef.current(stepRef.current - 1);
        }
      },
    }),
  ).current;

  return (
    <View
      style={[styles.root, { paddingBottom: insets.bottom + 12 }]}
      {...panResponder.panHandlers}
    >
      <StatusBar barStyle="light-content" backgroundColor={P.bg} />

      {/* ── Top bar ──────────────────────────────────────────────── */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <Text style={styles.stepCounter}>{step + 1} / {STEPS.length}</Text>

        {/* Skip hidden on final step — child has committed at that point */}
        {step < 2 ? (
          <TouchableOpacity
            onPress={handleComplete}
            style={styles.skipBtn}
            accessibilityLabel="Skip onboarding"
            accessibilityRole="button"
          >
            <Text style={styles.skipText}>Skip</Text>
          </TouchableOpacity>
        ) : (
          /* Spacer keeps the top bar height stable */
          <View style={styles.skipBtn} />
        )}
      </View>

      {/* ── Slide pager ──────────────────────────────────────────── */}
      {/* overflow: hidden clips slides that are off-screen */}
      <View style={styles.pagerClip}>
        <Animated.View style={[styles.pagerTrack, slideStyle]}>
          {/* ── Step 0 ── */}
          <View style={styles.slide}>
            <ScannerIllustration isActive={step === 0} />
            <Text style={styles.slideTitle}>{STEPS[0].title}</Text>
            <Text style={styles.slideBody}>{STEPS[0].body}</Text>
          </View>

          {/* ── Step 1 ── */}
          <View style={styles.slide}>
            <QuestMapIllustration isActive={step === 1} />
            <Text style={styles.slideTitle}>{STEPS[1].title}</Text>
            <Text style={styles.slideBody}>{STEPS[1].body}</Text>
          </View>

          {/* ── Step 2 ── */}
          <View style={styles.slide}>
            <WordTomeIllustration isActive={step === 2} />
            <Text style={styles.slideTitle}>{STEPS[2].title}</Text>
            <Text style={styles.slideBody}>{STEPS[2].body}</Text>
          </View>
        </Animated.View>
      </View>

      {/* ── Progress dots ─────────────────────────────────────────── */}
      <View style={styles.dotsRow}>
        {[0, 1, 2].map((i) => (
          <TouchableOpacity
            key={i}
            // Only allow tapping a dot if it's already been reached
            onPress={() => { if (i <= stepRef.current) advanceTo(i); }}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
            accessibilityLabel={`Go to step ${i + 1}`}
            activeOpacity={0.7}
          >
            <Animated.View
              style={[
                styles.dot,
                { backgroundColor: i === step ? P.gold : P.inkFaint },
                dotStyles[i],
              ]}
            />
          </TouchableOpacity>
        ))}
      </View>

      {/* ── CTA button ────────────────────────────────────────────── */}
      <Animated.View style={[styles.ctaWrap, ctaStyle]}>
        <TouchableOpacity
          style={[styles.ctaBtn, step === 2 && styles.ctaBtnFinal]}
          onPress={handleNext}
          accessibilityLabel={STEPS[step].cta}
          accessibilityRole="button"
          activeOpacity={0.8}
        >
          <Text style={[styles.ctaText, step === 2 && styles.ctaTextFinal]}>
            {STEPS[step].cta}
          </Text>
        </TouchableOpacity>
      </Animated.View>

      {/* ── Swipe hint — only on step 0 ───────────────────────────── */}
      {step === 0 && (
        <Text style={styles.swipeHint}>swipe to explore</Text>
      )}

      {/* ── Lumi mascot ───────────────────────────────────────────── */}
      <LumiHUD
        screen="onboarding"
        message={LUMI_STEP_MESSAGES[step]}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: P.bg,
    alignItems: "center",
  },

  // ── Top bar
  topBar: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  stepCounter: {
    color: P.inkFaint,
    fontSize: 13,
    fontWeight: "500",
  },
  skipBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  skipText: {
    color: P.inkFaint,
    fontSize: 14,
    fontWeight: "500",
  },

  // ── Pager
  pagerClip: {
    flex: 1,
    alignSelf: "stretch",
    overflow: "hidden",
  },
  pagerTrack: {
    flex: 1,
    flexDirection: "row",
  },
  slide: {
    width: SCREEN_WIDTH,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
  },

  // ── Illustration shared wrapper
  illustWrap: {
    alignItems: "center",
    marginBottom: 36,
  },
  illustCaption: {
    color: P.inkFaint,
    fontSize: 12,
    marginTop: 10,
    letterSpacing: 0.4,
  },

  // ── Scanner illustration
  viewfinder: {
    width: 148,
    height: 148,
    alignItems: "center",
    justifyContent: "center",
  },
  pulseRing: {
    position: "absolute",
    width: 60,
    height: 60,
    borderRadius: 30,
    borderWidth: 2,
    borderColor: P.gold,
  },
  targetDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: P.gold,
    opacity: 0.95,
  },

  // ── Quest map illustration
  parchment: {
    backgroundColor: P.bgCard,
    borderRadius: 14,
    padding: 16,
    width: 230,
    borderWidth: 0.5,
    borderColor: P.purpleDim,
  },
  parchmentHeader: {
    color: P.inkLight,
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
    marginBottom: 14,
    letterSpacing: 0.3,
  },
  nodesRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  nodeCol: {
    alignItems: "center",
  },
  questNode: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
  },
  nodeDone: {
    backgroundColor: "#12271d",
    borderColor: "#4ade80",
  },
  nodeActive: {
    backgroundColor: "#2d2200",
    borderColor: P.gold,
  },
  nodeLocked: {
    backgroundColor: "#1a1228",
    borderColor: P.purpleDim,
  },
  nodeEmoji: {
    fontSize: 18,
  },
  connector: {
    height: 2,
    width: 20,
    backgroundColor: P.purpleDim,
    marginHorizontal: 4,
    marginBottom: 20, // nudge up to align with node centres
  },
  nodeWord: {
    color: P.inkLight,
    fontSize: 10,
    textAlign: "center",
    marginTop: 5,
  },

  // ── Word Tome illustration
  book: {
    flexDirection: "row",
    width: 228,
    height: 146,
    backgroundColor: P.bgCard,
    borderRadius: 10,
    overflow: "hidden",
    borderWidth: 0.5,
    borderColor: P.purpleDim,
  },
  spine: {
    width: 6,
    backgroundColor: P.purpleDim,
  },
  bookPage: {
    flex: 1,
    padding: 10,
    borderRightWidth: 0.5,
    borderRightColor: P.purpleDim,
  },
  bookPageTitle: {
    color: P.purple,
    fontSize: 10,
    fontWeight: "600",
    marginBottom: 7,
    letterSpacing: 0.2,
  },
  bookWord: {
    color: P.inkLight,
    fontSize: 11,
    marginBottom: 4,
    letterSpacing: 0.1,
  },
  xpBadge: {
    position: "absolute",
    top: -10,
    right: -10,
    backgroundColor: P.gold,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    // Shadow won't render on Android but the bg colour is enough
  },
  xpText: {
    color: "#000",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.2,
  },

  // ── Slide text
  slideTitle: {
    color: P.inkLight,
    fontSize: 26,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 14,
    lineHeight: 34,
    letterSpacing: 0.2,
  },
  slideBody: {
    color: P.inkFaint,
    fontSize: 15,
    textAlign: "center",
    lineHeight: 23,
  },

  // ── Progress dots
  dotsRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 20,
  },
  dot: {
    height: 8,
    borderRadius: 4,
    marginHorizontal: 4,  // gap replacement — safe on all Android versions
  },

  // ── CTA
  ctaWrap: {
    width: SCREEN_WIDTH - 64,
    marginBottom: 8,
  },
  ctaBtn: {
    backgroundColor: P.bgCard,
    borderWidth: 1,
    borderColor: P.purpleDim,
    borderRadius: 28,
    paddingVertical: 16,
    alignItems: "center",
  },
  ctaBtnFinal: {
    backgroundColor: P.gold,
    borderColor: P.gold,
  },
  ctaText: {
    color: P.purple,
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: 0.4,
  },
  ctaTextFinal: {
    color: "#000000",
    fontWeight: "700",
  },

  // ── Swipe hint
  swipeHint: {
    color: P.inkFaint,
    fontSize: 12,
    letterSpacing: 0.6,
    marginBottom: 4,
  },
});
