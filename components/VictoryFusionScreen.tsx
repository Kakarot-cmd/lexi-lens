/**
 * VictoryFusionScreen.tsx — Lexi-Lens victory screen (1.3 + 1.4)
 *
 * Animation sequence:
 *   0ms   — enemy staggers (shake)
 *   200ms — scanned objects fly from edges toward centre (spring)
 *   900ms — objects merge flash (scale pulse + white burst)
 *   1100ms — weapon sprite drops onto enemy (drop + bounce)
 *   1400ms — enemy explodes (scale up → fade out)
 *   1700ms — victory content fades + slides up
 *
 * 1.4: isHardMode prop — red/crown theme instead of green/trophy
 *
 * FIXES applied:
 *   • [BUG] useAnimatedStyle was called inside .map() — Rules of Hooks violation.
 *     Extracted WordRow as a standalone component so each row owns its hook calls.
 *   • [BUG] Lottie autoPlay={weaponTriggered} evaluated only on mount (always false).
 *     Changed to conditional render: {weaponTriggered && <LottieView autoPlay />}
 *     so the component mounts—and starts playing—only when the weapon drops.
 *
 * Lumi addition (this file):
 *   • LumiHUD overlays the screen in cheering state
 *   • The fusion animation stays the hero — Lumi is the sidekick celebrating
 *
 * Dependencies (already in project):
 *   npx expo install react-native-reanimated lottie-react-native expo-haptics
 */

import React, { useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Dimensions,
} from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  withSequence,
  withDelay,
  withRepeat,
  interpolate,
  Easing,
  runOnJS,
  SharedValue,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import LottieView from "lottie-react-native";

import { LumiHUD } from "./Lumi";

const { width: W, height: H } = Dimensions.get("window");

// ─── Theme ────────────────────────────────────────────────────────────────────

const T = {
  normal: {
    bg:         "#052e16",
    burst:      "rgba(34,197,94,0.35)",
    weapon:     "⚔️",
    trophy:     "🏆",
    xpColor:    "#22c55e",
    xpBg:       "rgba(34,197,94,0.15)",
    xpBorder:   "#166534",
    titleColor: "#d1fae5",
    subColor:   "#6ee7b7",
    wordBg:     "rgba(255,255,255,0.05)",
    wordColor:  "#d1fae5",
    objColor:   "#6ee7b7",
    learnedClr: "#4ade80",
    btnBg:      "#22c55e",
    btnText:    "#052e16",
  },
  hard: {
    bg:         "#1a0505",
    burst:      "rgba(239,68,68,0.35)",
    weapon:     "🗡️",
    trophy:     "👑",
    xpColor:    "#fca5a5",
    xpBg:       "rgba(127,29,29,0.25)",
    xpBorder:   "#7f1d1d",
    titleColor: "#fca5a5",
    subColor:   "#fda4af",
    wordBg:     "rgba(127,29,29,0.2)",
    wordColor:  "#fca5a5",
    objColor:   "#fda4af",
    learnedClr: "#fda4af",
    btnBg:      "#991b1b",
    btnText:    "#fff",
  },
};

// ─── Flying object particle ───────────────────────────────────────────────────

interface ParticleProps {
  emoji:    string;
  fromX:    number;
  fromY:    number;
  delay:    number;
  onLanded: () => void;
}

function FusionParticle({ emoji, fromX, fromY, delay, onLanded }: ParticleProps) {
  const x     = useSharedValue(fromX);
  const y     = useSharedValue(fromY);
  const scale = useSharedValue(0.6);
  const op    = useSharedValue(0);

  useEffect(() => {
    // Fade in quickly as particle appears
    op.value = withDelay(delay, withTiming(1, { duration: 150 }));

    // x/y: withTiming + cubic ease-out — moves with intent, no oscillation.
    // onLanded fires exactly when the animation ends, not after spring settling.
    x.value = withDelay(
      delay,
      withTiming(0, { duration: 480, easing: Easing.out(Easing.cubic) }, (finished) => {
        if (finished) runOnJS(onLanded)();
      })
    );
    y.value = withDelay(
      delay,
      withTiming(0, { duration: 480, easing: Easing.out(Easing.cubic) })
    );

    // Scale: keep the spring pop on arrival — feels like a magnetic snap
    scale.value = withDelay(delay, withSpring(1.1, { damping: 10, stiffness: 100 }));
  }, []);

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value },
      { translateY: y.value },
      { scale: scale.value },
    ],
    opacity: op.value,
  }));

  return (
    <Animated.View style={[styles.particle, style]}>
      <Text style={{ fontSize: 32 }}>{emoji}</Text>
    </Animated.View>
  );
}

// ─── Burst flash ──────────────────────────────────────────────────────────────

function BurstFlash({ color, trigger }: { color: string; trigger: boolean }) {
  const scale = useSharedValue(0.2);
  const op    = useSharedValue(0);

  useEffect(() => {
    if (!trigger) return;
    scale.value = withSequence(
      withTiming(2.5, { duration: 300, easing: Easing.out(Easing.quad) }),
      withTiming(3,   { duration: 200 })
    );
    op.value = withSequence(
      withTiming(1,   { duration: 150 }),
      withDelay(150, withTiming(0, { duration: 300 }))
    );
  }, [trigger]);

  const style = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity:   op.value,
    backgroundColor: color,
  }));

  return <Animated.View style={[styles.burst, style]} />;
}

// ─── Weapon drop ──────────────────────────────────────────────────────────────

function WeaponDrop({ weapon, trigger }: { weapon: string; trigger: boolean }) {
  const y     = useSharedValue(-160);
  const scale = useSharedValue(0.4);
  const op    = useSharedValue(0);

  useEffect(() => {
    if (!trigger) return;
    op.value    = withTiming(1, { duration: 100 });
    y.value     = withSpring(0, { damping: 8, stiffness: 140 });
    scale.value = withSequence(
      withSpring(1.4, { damping: 6, stiffness: 200 }),
      withTiming(1,   { duration: 200 })
    );
  }, [trigger]);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: y.value }, { scale: scale.value }],
    opacity:   op.value,
  }));

  return (
    <Animated.View style={[styles.weapon, style]}>
      <Text style={{ fontSize: 52 }}>{weapon}</Text>
    </Animated.View>
  );
}

// ─── Enemy target ─────────────────────────────────────────────────────────────

function EnemyTarget({
  emoji,
  name,
  triggerShake,
  triggerExplode,
}: {
  emoji:          string;
  name:           string;
  triggerShake:   boolean;
  triggerExplode: boolean;
}) {
  const x     = useSharedValue(0);
  const scale = useSharedValue(1);
  const op    = useSharedValue(1);

  useEffect(() => {
    if (triggerShake) {
      x.value = withRepeat(
        withSequence(
          withTiming(-10, { duration: 60 }),
          withTiming(10,  { duration: 60 }),
        ),
        4,
        true
      );
    }
  }, [triggerShake]);

  useEffect(() => {
    if (triggerExplode) {
      scale.value = withSequence(
        withTiming(1.5, { duration: 200 }),
        withTiming(0,   { duration: 300, easing: Easing.in(Easing.quad) })
      );
      op.value = withDelay(250, withTiming(0, { duration: 300 }));
    }
  }, [triggerExplode]);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { scale: scale.value }],
    opacity:   op.value,
  }));

  return (
    <Animated.View style={[styles.enemyTarget, style]}>
      <Text style={{ fontSize: 60 }}>{emoji}</Text>
      <Text style={styles.enemyTargetName}>{name}</Text>
    </Animated.View>
  );
}

// ─── Word row (FIX: was inline in .map() — hooks violation) ──────────────────
//
// Previously VictoryContent called useAnimatedStyle() inside components.map().
// React's Rules of Hooks forbid hook calls inside loops or callbacks.
// Solution: extract each row into its own component so useAnimatedStyle()
// is always called at the top level of a function component.

interface WordRowProps {
  propertyWord: string;
  objectUsed:   string | null;
  index:        number;
  parentOp:     SharedValue<number>;
  wordBg:       string;
  wordColor:    string;
  objColor:     string;
}

function WordRow({ propertyWord, objectUsed, index, parentOp, wordBg, wordColor, objColor }: WordRowProps) {
  // ✅ useAnimatedStyle is at the top level of this component — hooks rules satisfied
  const style = useAnimatedStyle(() => ({
    opacity: parentOp.value,
    transform: [{
      translateY: interpolate(parentOp.value, [0, 1], [20 + index * 8, 0]),
    }],
  }));

  return (
    <Animated.View style={[styles.wordRow, { backgroundColor: wordBg }, style]}>
      <Text style={[styles.wordText, { color: wordColor }]}>{propertyWord}</Text>
      {objectUsed && (
        <Text style={[styles.objText, { color: objColor }]}>
          found with: {objectUsed}
        </Text>
      )}
    </Animated.View>
  );
}

// ─── Victory content ──────────────────────────────────────────────────────────

function VictoryContent({
  quest,
  components,
  totalXp,
  isHardMode,
  onContinue,
  visible,
}: {
  quest:      { enemy_name: string };
  components: Array<{ propertyWord: string; objectUsed: string | null; xpEarned: number }>;
  totalXp:    number;
  isHardMode: boolean;
  onContinue: () => void;
  visible:    boolean;
}) {
  const theme = isHardMode ? T.hard : T.normal;
  const op    = useSharedValue(0);
  const ty    = useSharedValue(40);

  useEffect(() => {
    if (!visible) return;
    op.value = withTiming(1,  { duration: 500 });
    ty.value = withSpring(0,  { damping: 14, stiffness: 80 });
  }, [visible]);

  const wrapStyle = useAnimatedStyle(() => ({
    opacity:   op.value,
    transform: [{ translateY: ty.value }],
  }));

  return (
    <Animated.View style={[styles.contentWrap, wrapStyle]}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Text style={{ fontSize: 64, marginBottom: 8 }}>{theme.trophy}</Text>

        <Text style={[styles.title, { color: theme.titleColor }]}>
          {isHardMode ? "Hard mode cleared!" : "Dungeon cleared!"}
        </Text>
        <Text style={[styles.sub, { color: theme.subColor }]}>
          {quest.enemy_name} defeated{isHardMode ? " (Hard Mode)" : ""}
        </Text>

        <View style={[styles.xpBadge, { backgroundColor: theme.xpBg, borderColor: theme.xpBorder }]}>
          <Text style={[styles.xpNum, { color: theme.xpColor }]}>+{totalXp} XP</Text>
          <Text style={[styles.xpLbl, { color: theme.subColor }]}>earned this quest</Text>
        </View>

        <Text style={[styles.learnedLbl, { color: theme.learnedClr }]}>
          What you discovered
        </Text>

        {/* FIX: each row is now its own component — no hooks-in-map violation */}
        {components.map((c, i) => (
          <WordRow
            key={c.propertyWord}
            propertyWord={c.propertyWord}
            objectUsed={c.objectUsed}
            index={i}
            parentOp={op}
            wordBg={theme.wordBg}
            wordColor={theme.wordColor}
            objColor={theme.objColor}
          />
        ))}

        <TouchableOpacity
          style={[styles.btn, { backgroundColor: theme.btnBg }]}
          onPress={onContinue}
          activeOpacity={0.85}
        >
          <Text style={[styles.btnText, { color: theme.btnText }]}>Quest map ✦</Text>
        </TouchableOpacity>
      </ScrollView>
    </Animated.View>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface VictoryFusionScreenProps {
  quest: {
    enemy_name:  string;
    enemy_emoji: string;
  };
  components: Array<{
    propertyWord: string;
    objectUsed:   string | null;
    xpEarned:     number;
  }>;
  totalXp:    number;
  isHardMode: boolean; // v1.4
  onContinue: () => void;
}

// Spread positions for up to 5 particles (relative to screen centre)
const PARTICLE_ORIGINS = [
  { x: -W * 0.35, y: -H * 0.22 },
  { x:  W * 0.35, y: -H * 0.22 },
  { x: -W * 0.38, y:  H * 0.08 },
  { x:  W * 0.38, y:  H * 0.08 },
  { x:  0,        y: -H * 0.30 },
];

// Emojis representing found objects (fallback set)
const OBJECT_EMOJIS = ["🔮", "💎", "🪨", "🌿", "🕯️"];

export function VictoryFusionScreen({
  quest,
  components,
  totalXp,
  isHardMode,
  onContinue,
}: VictoryFusionScreenProps) {
  const theme = isHardMode ? T.hard : T.normal;

  const [landedCount,      setLandedCount]      = React.useState(0);
  const [burstTriggered,   setBurstTriggered]   = React.useState(false);
  const [weaponTriggered,  setWeaponTriggered]  = React.useState(false);
  const [explodeTriggered, setExplodeTriggered] = React.useState(false);
  const [showContent,      setShowContent]      = React.useState(false);

  const particleCount = Math.min(components.length, 5);

  // Haptics on mount
  useEffect(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, []);

  // When all particles land → trigger burst → weapon → explode → content
  useEffect(() => {
    if (landedCount >= particleCount && particleCount > 0) {
      setBurstTriggered(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);

      setTimeout(() => setWeaponTriggered(true), 200);

      setTimeout(() => {
        setExplodeTriggered(true);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }, 600);

      setTimeout(() => setShowContent(true), 1100);
    }
  }, [landedCount, particleCount]);

  const handleLanded = React.useCallback(() => {
    setLandedCount((n) => n + 1);
  }, []);

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>

      {/* ── Stage: enemy + particles fly in ─────────────── */}
      {!showContent && (
        <View style={styles.stage}>
          {/* Burst flash behind everything */}
          <BurstFlash color={theme.burst} trigger={burstTriggered} />

          {/* Enemy */}
          <EnemyTarget
            emoji={quest.enemy_emoji}
            name={quest.enemy_name}
            triggerShake={true}
            triggerExplode={explodeTriggered}
          />

          {/* Flying object particles */}
          {Array.from({ length: particleCount }).map((_, i) => (
            <FusionParticle
              key={i}
              emoji={OBJECT_EMOJIS[i % OBJECT_EMOJIS.length]}
              fromX={PARTICLE_ORIGINS[i].x}
              fromY={PARTICLE_ORIGINS[i].y}
              delay={i * 120}
              onLanded={handleLanded}
            />
          ))}

          {/* Weapon drop from above */}
          <WeaponDrop weapon={theme.weapon} trigger={weaponTriggered} />

          {/*
           * FIX: Lottie was always rendered with autoPlay={weaponTriggered}.
           * Because autoPlay is evaluated only on mount (when weaponTriggered
           * was still false), Lottie never started. Fix: conditionally render
           * the component so it mounts—and autoPlays—exactly when the weapon fires.
           */}
          {weaponTriggered && (
            <LottieView
              source={require("../assets/lottie/Boom.json")}
              autoPlay
              loop={false}
              style={styles.lottie}
            />
          )}
        </View>
      )}

      {/* ── Victory content ──────────────────────────────── */}
      <VictoryContent
        quest={quest}
        components={components}
        totalXp={totalXp}
        isHardMode={isHardMode}
        onContinue={onContinue}
        visible={showContent}
      />

      {/* ── Lumi cheers — appears after the burst, alongside content ── */}
      <LumiHUD
        screen="victory"
        hardMode={isHardMode}
        hidden={!showContent}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems:     "center",
  },

  stage: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems:     "center",
  },

  enemyTarget: {
    alignItems: "center",
    position:   "absolute",
  },
  enemyTargetName: {
    fontSize:   13,
    color:      "rgba(255,255,255,0.5)",
    marginTop:  4,
    fontWeight: "600",
  },

  particle: {
    position: "absolute",
  },

  burst: {
    position:     "absolute",
    width:        120,
    height:       120,
    borderRadius: 60,
  },

  weapon: {
    position: "absolute",
  },

  lottie: {
    position: "absolute",
    width:    200,
    height:   200,
  },

  contentWrap: {
    ...StyleSheet.absoluteFillObject,
  },
  content: {
    alignItems: "center",
    padding:    32,
    paddingTop: 72,
  },

  title:      { fontSize: 28, fontWeight: "800", marginBottom: 4, textAlign: "center" },
  sub:        { fontSize: 14, marginBottom: 28 },

  xpBadge: {
    borderRadius: 20, paddingHorizontal: 28, paddingVertical: 14,
    alignItems: "center", borderWidth: 1, marginBottom: 28,
  },
  xpNum: { fontSize: 38, fontWeight: "800" },
  xpLbl: { fontSize: 13, marginTop: 2 },

  learnedLbl: {
    fontSize: 10, fontWeight: "700",
    textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 12,
  },

  wordRow: {
    width: "100%", borderRadius: 10,
    padding: 12, marginBottom: 8,
  },
  wordText: { fontSize: 15, fontWeight: "700" },
  objText:  { fontSize: 11, marginTop: 2 },

  btn: {
    marginTop: 28, borderRadius: 16,
    paddingVertical: 15, paddingHorizontal: 48,
  },
  btnText: { fontSize: 16, fontWeight: "700" },
});
