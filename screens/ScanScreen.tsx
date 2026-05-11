/**
 * ScanScreen.tsx — Lexi-Lens main gameplay screen
 *
 * v6.2 Phase 1 changes (ML Kit removal — premium UX overhaul):
 *   • LiveLabelChip rendering REMOVED. Production data showed ~50% of ML Kit
 *     labels were embarrassing (generic "object" or basket "tableware"). Lumi
 *     mascot is now the sole framing-phase visual presence.
 *   • LiveLabelChip COMPONENT preserved for rollback. Just no longer rendered.
 *   • ScanButton pulses unconditionally after a 600ms settling delay (was
 *     gated on ML Kit's scanReady). The pulse IS the tap-to-scan affordance
 *     now that the chip is gone.
 *   • Button label simplified — no more "✦ {detectedLabel} — tap to scan!"
 *     since detectedLabel is always "object" post-ML-Kit-removal.
 *
 * Lumi: scan-screen LumiHUD wired to evaluationStatus already drives the
 *   right state machine (idle/scanning/success/fail). v6.2 widens Lumi's
 *   movement to "wander" during scan-framing for kid engagement.
 *
 * v3.3 iOS patch (on top of v3.7):
 *   • scanErrorMsg state + onScanError wired to useObjectScanner
 *   • Camera gets photo={true} video={true}
 *   • Error toast rendered above ScanButton
 *
 * v3.5 additions (Rate Limiting + Abuse Prevention):
 *   • rateLimitCode, scansToday, dailyLimit, approachingLimit, resetsAt
 *   • RateLimitWall + ApproachingLimitBanner
 */

import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Linking,
} from "react-native";
import { Camera } from "react-native-vision-camera";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import { useObjectScanner } from "../hooks/useObjectScanner";
import { useLexiEvaluate }  from "../hooks/useLexiEvaluate";
import { useAnalytics }     from "../hooks/useAnalytics";
import { computePropertyHints } from "../utils/propertyHints";
import {
  useGameStore,
  selectCurrentComponent,
  selectCurrentAttempts,
  selectQuestComplete,
  selectStreakMultiplier,
} from "../store/gameStore";
import { VerdictCard }                           from "../components/VerdictCard";
import { StatusBanner }                          from "../components/StatusBanner";
import { VictoryFusionScreen }                   from "../components/VictoryFusionScreen";
import { RateLimitWall, ApproachingLimitBanner } from "../components/RateLimitWall";
import { LumiHUD }                               from "../components/Lumi";
import { addGameBreadcrumb }                     from "../lib/sentry";

import type { RootStackParamList } from "../types/navigation";
type Props = NativeStackScreenProps<RootStackParamList, "Scan">;

type ScreenPhase =
  | "quest_intro"
  | "scanning"
  | "verdict"
  | "component_win"
  | "quest_victory";

// ─── Palette ──────────────────────────────────────────────────────────────────

const P = {
  deepPurple:     "#0f0620",
  cardBg:         "#1e1040",
  cardBorder:     "#3d2080",
  gold:           "#f5c842",
  textPrimary:    "#f3e8ff",
  textMuted:      "#a78bfa",
  textDim:        "#6b5fa0",
  progressPurple: "#7c3aed",
  hardRed:        "#991b1b",
  hardRedText:    "#fca5a5",
};

// ─── Camera brackets ──────────────────────────────────────────────────────────

function CameraOverlay() {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {(["tl", "tr", "bl", "br"] as const).map((c) => (
        <View key={c} style={[styles.corner, styles[c]]} />
      ))}
    </View>
  );
}

// ─── Live ML Kit label chip (Android only — ML Kit not available on iOS) ──────

function LiveLabelChip({
  label,
  confidence,
  visible,
}: {
  label:      string | null;
  confidence: number;
  visible:    boolean;
}) {
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue:         visible && !!label ? 1 : 0,
      duration:        250,
      useNativeDriver: true,
    }).start();
  }, [visible, label]);

  if (!label) return null;

  const confPct = Math.round(confidence * 100);
  const chipBg  = confidence > 0.75
    ? "rgba(6,40,55,0.92)"
    : "rgba(20,8,50,0.85)";
  const textCol = confidence > 0.75 ? "#67e8f9" : "#a78bfa";

  return (
    <Animated.View style={[styles.liveChipWrap, { opacity: fadeAnim }]} pointerEvents="none">
      <View style={[styles.liveChip, { backgroundColor: chipBg }]}>
        <View style={[styles.liveDot, { backgroundColor: textCol }]} />
        <Text style={[styles.liveChipText, { color: textCol }]}>{label}</Text>
        <Text style={[styles.liveChipConf, { color: textCol }]}>· {confPct}%</Text>
      </View>
    </Animated.View>
  );
}

// ─── Hard mode banner ─────────────────────────────────────────────────────────

function HardModeBanner() {
  return (
    <View style={styles.hardBanner}>
      <Text style={styles.hardBannerText}>⚔ HARD MODE — harder vocabulary</Text>
    </View>
  );
}

// ─── Progress bar + component chips ──────────────────────────────────────────

function ComponentsStrip({
  components,
  current,
  browsedWord,
  hintedWords,
  onSelectWord,
}: {
  components:   Array<{ propertyWord: string; found: boolean; objectUsed: string | null }>;
  current:      string | null;
  browsedWord:  string | null;
  hintedWords:  Set<string>;
  onSelectWord: (word: string) => void;
}) {
  const foundCount = components.filter((c) => c.found).length;
  const total      = components.length;
  const percent    = total > 0 ? Math.round((foundCount / total) * 100) : 0;

  return (
    <View>
      <View style={styles.progressRow}>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${percent}%` as any }]} />
        </View>
        <Text style={styles.progressPct}>{percent}%</Text>
      </View>
      <Text style={styles.progressLabel}>
        {foundCount} of {total} word{total !== 1 ? "s" : ""} found
      </Text>
      <View style={styles.chipsRow}>
        {components.map((comp) => {
          const isActive  = comp.propertyWord === current;
          const isBrowsed = comp.propertyWord === browsedWord;
          const isHinted  = hintedWords.has(comp.propertyWord);

          return (
            <Animated.View
              key={comp.propertyWord}
              style={[
                styles.chipHintWrap,
                isHinted  && { borderColor: "#f59e0b" },
              ]}
            >
              <TouchableOpacity
                style={[
                  styles.chip,
                  // v6.2.3 (Session D fix) — browse highlight reuses chipActive
                  // gold-on-inner-chip styling for visual consistency. CRITICAL:
                  // isBrowsed is the SOLE driver. Earlier (v6.2.2) condition
                  // included `isActive` too, which lit up two chips at once
                  // (quest target AND the chip the user tapped to view).
                  // browsedWord initialises to currentComponent.propertyWord
                  // via the sync useEffect, so the highlight starts on the
                  // active chip by default and follows the user's taps.
                  // Single source of truth = single chip highlighted.
                  isBrowsed && !comp.found && styles.chipActive,
                  comp.found && styles.chipDone,
                ]}
                onPress={() => !comp.found && onSelectWord(comp.propertyWord)}
                activeOpacity={comp.found ? 1 : 0.7}
              >
                {comp.found && (
                  <Text style={{ fontSize: 10, marginRight: 4 }}>✓</Text>
                )}
                <View>
                  <Text style={[
                    styles.chipText,
                    comp.found && styles.chipTextDone,
                    isHinted  && styles.chipTextHinted,
                  ]}>
                    {comp.propertyWord}
                  </Text>
                  {comp.found && comp.objectUsed ? (
                    <Text style={styles.chipObject}>{comp.objectUsed}</Text>
                  ) : (
                    <Text style={[
                      styles.chipTapHint,
                      isHinted && styles.chipTapHintHinted,
                    ]}>
                      {isHinted ? "✦ try this!" : isBrowsed ? "viewing" : "tap to view"}
                    </Text>
                  )}
                </View>
              </TouchableOpacity>
            </Animated.View>
          );
        })}
      </View>
    </View>
  );
}

// ─── Enemy HP bar ─────────────────────────────────────────────────────────────

function EnemyBar({
  hp, name, emoji, isHardMode,
}: {
  hp: number; name: string; emoji: string; isHardMode: boolean;
}) {
  const anim = useRef(new Animated.Value(hp)).current;
  useEffect(() => {
    Animated.timing(anim, { toValue: hp, duration: 600, useNativeDriver: false }).start();
  }, [hp]);

  return (
    <View style={[styles.enemyBar, isHardMode && styles.enemyBarHard]}>
      <Text style={{ fontSize: 22 }}>{emoji}</Text>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Text style={[styles.enemyName, { flex: 1 }]} numberOfLines={1}>{name}</Text>
          {isHardMode && (
            <View style={styles.hardPill}>
              <Text style={styles.hardPillText}>⚔</Text>
            </View>
          )}
        </View>
        <View style={styles.hpTrack}>
          <Animated.View
            style={[
              styles.hpFill,
              isHardMode && styles.hpFillHard,
              {
                width: anim.interpolate({
                  inputRange:  [0, 100],
                  outputRange: ["0%", "100%"],
                }),
              },
            ]}
          />
        </View>
      </View>
      <Text style={styles.hpLabel}>{hp}%</Text>
    </View>
  );
}

// ─── Quest intro ──────────────────────────────────────────────────────────────

function QuestIntro({
  quest,
  effectiveProperties,
  isHardMode,
  onBegin,
}: {
  quest:               NonNullable<ReturnType<typeof useGameStore.getState>["activeQuest"]>["quest"];
  effectiveProperties: NonNullable<ReturnType<typeof useGameStore.getState>["activeQuest"]>["effectiveProperties"];
  isHardMode:          boolean;
  onBegin:             () => void;
}) {
  const scale = useRef(new Animated.Value(0.85)).current;
  const fade  = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, useNativeDriver: true, tension: 70, friction: 9 }),
      Animated.timing(fade,  { toValue: 1, duration: 350, useNativeDriver: true }),
    ]).start();
  }, []);

  return (
    <Animated.View style={[styles.introWrap, { opacity: fade, transform: [{ scale }] }]}>
      {isHardMode && (
        <View style={styles.introHardBadge}>
          <Text style={styles.introHardBadgeText}>⚔ HARD MODE</Text>
        </View>
      )}
      <Text style={{ fontSize: 72, marginBottom: 12 }}>{quest.enemy_emoji}</Text>
      <Text style={styles.introName}>{quest.enemy_name}</Text>
      <Text style={styles.introRoom}>Appears in: {quest.room_label}</Text>
      <View style={styles.introDivider} />
      <Text style={styles.introHeading}>
        {isHardMode ? "Harder vocabulary to find:" : "Vocabulary to find:"}
      </Text>
      <Text style={styles.introHint}>
        {isHardMode
          ? "Use Hard Mode synonyms — they're trickier!"
          : "Scan any object that matches these words"}
      </Text>
      {effectiveProperties.map((p, i) => (
        <View key={p.word} style={styles.introPropRow}>
          <Text style={styles.introPropWord}>{i + 1}. {p.word}</Text>
          <View style={{ flex: 1 }}>
            {p.definition?.trim() ? (
              <Text style={styles.introPropDef}>{p.definition}</Text>
            ) : (
              <Text style={styles.introPropDefMissing}>
                Find something that is {p.word}!
              </Text>
            )}
          </View>
        </View>
      ))}
      <TouchableOpacity
        style={[styles.beginBtn, isHardMode && styles.beginBtnHard]}
        onPress={onBegin}
      >
        <Text style={styles.beginBtnText}>
          {isHardMode ? "⚔ Begin Hard Mode" : "Open Lexi-Lens ✦"}
        </Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Scan button ──────────────────────────────────────────────────────────────

function ScanButton({
  onPress,
  isHardMode,
  scanReady,
  liveLabel,
  stableFrameCount,
}: {
  onPress:          () => void;
  isHardMode:       boolean;
  /**
   * v6.2: scanReady was previously gated on ML Kit confidence > 0.75. With
   * ML Kit removed, this is always false and the button used to never pulse.
   * The pulse is now driven by an internal 600ms settling delay below — the
   * scanReady prop is preserved on the interface for future reuse but no
   * longer gates the pulse.
   */
  scanReady:        boolean;
  liveLabel:        string | null;
  stableFrameCount: number;
}) {
  const pulse = useRef(new Animated.Value(1)).current;

  // v6.2: pulse always runs after a brief settling delay. Without ML Kit,
  // there's no "scanReady" signal to wait for, so the button itself becomes
  // the primary tap-to-scan affordance. 600ms gives the camera a moment to
  // initialize and the kid a moment to frame the object before the pulse
  // starts demanding attention.
  useEffect(() => {
    const settle = setTimeout(() => {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 1.06, duration: 580, useNativeDriver: true }),
          Animated.timing(pulse, { toValue: 1.00, duration: 580, useNativeDriver: true }),
        ])
      ).start();
    }, 600);
    return () => {
      clearTimeout(settle);
      pulse.stopAnimation();
      pulse.setValue(1);
    };
  }, []);

  const dotCount  = Math.min(stableFrameCount, 3);
  const dotColors = ["#6b5fa0", "#a78bfa", "#f5c842"];

  // v6.2: button color is now driven purely by hard-mode state, not by
  // ML Kit's confidence threshold (which produced the green "ready" state).
  // Green-ready signal removed because there's no per-frame confidence to
  // anchor it to anymore.
  const bgColor = isHardMode ? P.hardRed : "#7c3aed";

  // v6.2: simplified label. Previously showed "✦ {liveLabel} — tap to scan!"
  // when ML Kit was confident; that's gone. The verb-first phrasing is also
  // more directive for younger kids.
  const label = isHardMode ? "⚔ Tap to Scan" : "✦ Tap to Scan";

  return (
    <Animated.View style={{ transform: [{ scale: pulse }] }}>
      <TouchableOpacity
        style={[styles.scanBtn, { backgroundColor: bgColor }]}
        onPress={onPress}
        activeOpacity={0.85}
      >
        <Text style={styles.scanBtnText}>{label}</Text>
        {stableFrameCount > 0 && !scanReady && (
          <View style={styles.lockDots}>
            {[0, 1, 2].map((i) => (
              <View
                key={i}
                style={[
                  styles.lockDot,
                  { backgroundColor: i < dotCount ? dotColors[i] : "rgba(255,255,255,0.15)" },
                ]}
              />
            ))}
          </View>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export function ScanScreen({ route, navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { questId, hardMode: routeHardMode = false } = route.params;

  const activeChild      = useGameStore((s) => s.activeChild);
  const activeQuest      = useGameStore((s) => s.activeQuest);
  const questLibrary     = useGameStore((s) => s.questLibrary);
  const currentComponent = useGameStore(selectCurrentComponent);
  const currentAttempts  = useGameStore(selectCurrentAttempts);
  const questComplete    = useGameStore(selectQuestComplete);
  const streakMultiplier = useGameStore(selectStreakMultiplier);

  const beginQuest            = useGameStore((s) => s.beginQuest);
  const recordComponentsFound = useGameStore((s) => s.recordComponentsFound);
  const recordMissedScan      = useGameStore((s) => s.recordMissedScan);
  const completeQuest         = useGameStore((s) => s.completeQuest);
  const abandonQuest          = useGameStore((s) => s.abandonQuest);
  const addWordToTome         = useGameStore((s) => s.addWordToTome);
  const addScanHistory        = useGameStore((s) => s.addScanHistory);
  const markQuestCompletion   = useGameStore((s) => s.markQuestCompletion);

  const { startQuestSession, finishQuestSession, logWordOutcome } = useAnalytics();
  const scanCountRef      = useRef(0);
  const questStartedAtRef = useRef<string | null>(null);

  const [phase,               setPhase]               = useState<ScreenPhase>("quest_intro");
  const [lastLabel,           setLastLabel]           = useState<string | null>(null);
  const [browsedWord,         setBrowsedWord]         = useState<string | null>(null);
  const [limitBannerDismissed, setLimitBannerDismissed] = useState(false);
  // v3.3 iOS patch — surface capture errors as an in-UI toast
  const [scanErrorMsg,        setScanErrorMsg]        = useState<string | null>(null);

  // ── Begin quest on mount ──────────────────────────────────────────────────
  useEffect(() => {
    const quest = questLibrary.find((q) => q.id === questId);
    if (quest && (!activeQuest || activeQuest.quest.id !== questId)) {
      beginQuest(quest, routeHardMode);
    }
  }, [questId]);

  // ── Quest session lifecycle (Phase 3.7) ──────────────────────────────────
  useEffect(() => {
    const ac = activeChild;
    const aq = activeQuest;
    if (!ac?.id || !aq?.quest?.id) return;
    if (questStartedAtRef.current === aq.quest.id) return;

    questStartedAtRef.current = aq.quest.id;
    scanCountRef.current      = 0;
    startQuestSession({ childId: ac.id, questId: aq.quest.id, hardMode: aq.isHardMode });

    return () => {
      if (questStartedAtRef.current) {
        const partialXp = aq.components.reduce((s, c) => s + c.xpEarned, 0);
        finishQuestSession({ completed: false, totalScans: scanCountRef.current, xpAwarded: partialXp });
        questStartedAtRef.current = null;
      }
    };
  }, [activeChild?.id, activeQuest?.quest?.id, activeQuest?.isHardMode, startQuestSession, finishQuestSession]);

  // ── Sync browsedWord to currentComponent ─────────────────────────────────
  useEffect(() => {
    if (currentComponent && !browsedWord) {
      setBrowsedWord(currentComponent.propertyWord);
    }
  }, [currentComponent?.propertyWord]);

  const isHardMode          = activeQuest?.isHardMode ?? false;
  const effectiveProperties = activeQuest?.effectiveProperties ?? [];
  const pendingProperties   = effectiveProperties.filter(
    (p) => !activeQuest?.components.find((c) => c.propertyWord === p.word && c.found)
  );

  // ── useLexiEvaluate ───────────────────────────────────────────────────────
  const {
    status,
    result,
    error,
    masteryResult,
    cacheHit,
    scanAttemptId,
    evaluate,
    reset: resetEval,
    rateLimitCode,
    scansToday,
    dailyLimit,
    approachingLimit,
    resetsAt,
  } = useLexiEvaluate();

  // ── Result effect ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (status === "rate_limited") { setPhase("verdict"); return; }
    if (!result) return;

    const aq = useGameStore.getState().activeQuest;
    if (!aq) return;

    if (status === "match" || status === "no-match") {
      setPhase("verdict");

      const alreadyFound = new Set(
        (aq.components ?? []).filter((c) => c.found).map((c) => c.propertyWord.toLowerCase().trim())
      );
      const canonicalMap = new Map(
        (aq.effectiveProperties ?? []).map((p) => [p.word.toLowerCase().trim(), p.word])
      );
      const newlyPassing = (result.properties ?? []).filter((p) => {
        const key = p.word.toLowerCase().trim();
        return p.passes && !alreadyFound.has(key) && canonicalMap.has(key);
      });

      if (newlyPassing.length > 0) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        const totalXpThisScan = Math.round((result.xpAwarded || 20) * streakMultiplier);
        const xpEach = Math.max(10, Math.floor(totalXpThisScan / newlyPassing.length));

        recordComponentsFound(
          newlyPassing.map((p) => ({
            propertyWord: canonicalMap.get(p.word.toLowerCase().trim()) ?? p.word,
            objectUsed:   result.resolvedObjectName,
            xpAwarded:    xpEach,
            attemptCount: currentAttempts + 1,
          }))
        );

        newlyPassing.forEach((p) => {
          const canonicalWord = canonicalMap.get(p.word.toLowerCase().trim()) ?? p.word;
          const req = (aq.effectiveProperties ?? []).find(
            (r) => r.word.toLowerCase().trim() === canonicalWord.toLowerCase().trim()
          );
          if (req) {
            addWordToTome({
              word:            canonicalWord,
              definition:      req.definition,
              exemplar_object: result.resolvedObjectName,
              times_used:      1,
              first_used_at:   new Date().toISOString(),
            });
          }
        });

        addScanHistory({
          id:            Math.random().toString(36).slice(2),
          timestamp:     Date.now(),
          detectedLabel: lastLabel ?? result.resolvedObjectName,
          overallMatch:  true,
          xpAwarded:     totalXpThisScan,
          questName:     aq.quest.name ?? "",
          feedback:      result.childFeedback,
        });
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        if (currentComponent) recordMissedScan(currentComponent.propertyWord);
      }

      scanCountRef.current += 1;
      const ac = useGameStore.getState().activeChild;
      if (ac && result.properties && result.properties.length > 0) {
        const attemptNum = (currentAttempts || 0) + 1;
        for (const p of result.properties) {
          logWordOutcome({
            childId:   ac.id,
            questId:   aq.quest.id,
            word:      p.word,
            passed:    p.passes,
            scanLabel: result.resolvedObjectName ?? lastLabel ?? "",
            attempt:   attemptNum,
          });
        }
      }
    }

    if (status === "error") setPhase("verdict");
  }, [status, result]);

  // ── Verdict-vs-state watchdog ─────────────────────────────────────────────
  useEffect(() => {
    if (!result || (status !== "match" && status !== "no-match")) return;
    const aq = useGameStore.getState().activeQuest;
    if (!aq) return;

    const passingFromClaude = (result.properties ?? [])
      .filter((p) => p.passes)
      .map((p) => p.word.toLowerCase().trim());
    if (passingFromClaude.length === 0) return;

    const foundInStore = new Set(
      aq.components.filter((c) => c.found).map((c) => c.propertyWord.toLowerCase().trim())
    );
    const missing = passingFromClaude.filter((w) => !foundInStore.has(w));
    if (missing.length > 0) {
      addGameBreadcrumb({
        category: "verdict",
        message:  "verdict_state_mismatch",
        data: {
          questId:           aq.quest.id,
          missingProperties: missing,
          claudeReturned:    passingFromClaude,
          componentsFound:   Array.from(foundInStore),
          detectedLabel:     lastLabel,
        },
      });
    }
  }, [status, result, lastLabel]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleContinue = useCallback(() => {
    const isComplete = selectQuestComplete(useGameStore.getState());
    if (isComplete) {
      setPhase("quest_victory");
    } else {
      setPhase("component_win");
      setTimeout(() => { resetEval(); setPhase("scanning"); }, 1400);
    }
  }, [resetEval]);

  const handleTryAgain = useCallback(() => {
    resetEval();
    setPhase("scanning");
  }, [resetEval]);

  const handleVictoryDismiss = useCallback(() => {
    const { activeQuest: aq, activeChild: ac } = useGameStore.getState();
    const exitToMap = () => {
      completeQuest();
      if (navigation.canGoBack()) {
        navigation.goBack();
      } else {
        navigation.replace("QuestMap");
      }
    };

    if (!aq || !ac) { exitToMap(); return; }

    const totalXp = aq.components.reduce((s, c) => s + c.xpEarned, 0);
    const mode    = aq.isHardMode ? "hard" : "normal";

    if (questStartedAtRef.current) {
      finishQuestSession({ completed: true, totalScans: scanCountRef.current, xpAwarded: totalXp });
      questStartedAtRef.current = null;
    }

    markQuestCompletion(aq.quest.id, mode, totalXp).then(exitToMap).catch(exitToMap);
  }, [completeQuest, markQuestCompletion, navigation, finishQuestSession]);

  // ── ML Kit scanner ────────────────────────────────────────────────────────
  const {
    cameraRef,
    device,
    hasPermission,
    frameProcessor,
    triggerManualScan,
    liveLabel,
    liveConfidence,
    scanReady,
    stableFrameCount,
    topLabels,
    requestPermission,
  } = useObjectScanner({
    enabled: phase === "scanning" && status === "idle",
    // v3.3 iOS patch: surface capture errors as a dismissing toast
    onScanError: (msg) => {
      setScanErrorMsg(msg);
      setTimeout(() => setScanErrorMsg(null), 3000);
    },
    onDetection: async ({ primary, frameBase64 }) => {
      const { activeChild: ac, activeQuest: aq } = useGameStore.getState();
      if (!ac || !aq) return;

      const alreadyFoundWords = aq.components.filter((c) => c.found).map((c) => c.propertyWord);
      const pendingNow = (aq.effectiveProperties ?? []).filter(
        (p) => !alreadyFoundWords.includes(p.word)
      );

      setLastLabel(primary?.label ?? "object");
      setPhase("verdict");

      await evaluate({
        childId:            ac.id,
        questId:            aq.quest.id,
        questName:          aq.quest.name,
        detectedLabel:      primary?.label ?? "object",
        confidence:         primary?.confidence ?? 0.9,
        frameBase64Already: frameBase64 ?? undefined,
        requiredProperties: pendingNow,
        alreadyFoundWords,
        // v6.1: pass ACTUAL age, not the band's upper bound. Pre-v6.1 the
        // line below was `parseInt(ac.age_band.split("-")[1], 10)` which
        // collapsed every child to age 6/8/10/12 regardless of true age and
        // forced 7-year-olds into the kid_msg.older voice (band threshold
        // is age<8). The model receives the actual integer now.
        childAge:           ac.age,
        failedAttempts:     currentAttempts,
        xp_reward_first_try:  aq.quest.xp_reward_first_try  ?? 40,
        xp_reward_retry:      aq.quest.xp_reward_retry      ?? 25,
        xp_reward_third_plus: aq.quest.xp_reward_third_plus ?? 10,
      });
    },
  });

  // ── Property hint engine ──────────────────────────────────────────────────
  const pendingPropertyWords = useMemo(
    () => pendingProperties.map((p) => p.word),
    [pendingProperties]
  );
  const { hintedWords } = useMemo(
    () => computePropertyHints({ labels: topLabels, pendingProperties: pendingPropertyWords }),
    [topLabels.join("|"), pendingPropertyWords.join("|")]
  );

  // Force camera remount when permission is granted
  const [cameraKey, setCameraKey] = React.useState(0);
  React.useEffect(() => {
    if (hasPermission && device) setCameraKey((k) => k + 1);
  }, [hasPermission, device]);

  // ── Guards ────────────────────────────────────────────────────────────────
  if (!hasPermission) {
    return (
      <View style={[styles.center, { paddingTop: insets.top, padding: 32 }]}>
        <Text style={{ fontSize: 48, marginBottom: 16 }}>📷</Text>
        <Text style={styles.permText}>Camera access needed</Text>
        <Text style={{ color: "#a78bfa", fontSize: 14, textAlign: "center", lineHeight: 22, marginBottom: 24 }}>
          Lexi-Lens needs camera access to scan objects for your quest.
        </Text>
        <TouchableOpacity
          onPress={requestPermission}
          style={{ backgroundColor: "#7c3aed", borderRadius: 50, paddingVertical: 14, paddingHorizontal: 32, marginBottom: 12 }}
        >
          <Text style={{ color: "#fff", fontSize: 16, fontWeight: "700" }}>Grant Camera Access</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => Linking.openSettings()}>
          <Text style={{ color: "#a78bfa", fontSize: 13 }}>Open App Settings instead</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={[styles.center, { paddingTop: insets.top, padding: 32 }]}>
        <Text style={{ fontSize: 48, marginBottom: 16 }}>📷</Text>
        <Text style={styles.permText}>Camera not available</Text>
        <Text style={{ color: "#a78bfa", fontSize: 14, textAlign: "center", lineHeight: 22, marginBottom: 24 }}>
          Could not access the back camera. Please grant permission in Settings.
        </Text>
        <TouchableOpacity onPress={() => Linking.openSettings()}>
          <Text style={{ color: "#fff", backgroundColor: "#7c3aed", borderRadius: 50,
            paddingVertical: 14, paddingHorizontal: 32, fontSize: 16, fontWeight: "700" }}>
            Open App Settings
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  const quest      = activeQuest?.quest;
  const components = activeQuest?.components ?? [];
  const enemyHp    = activeQuest?.enemyHp ?? 100;
  const totalXp    = components.reduce((s, c) => s + c.xpEarned, 0);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <View style={styles.root}>
      {/* v3.3: photo={true} enables takePhoto() for iOS path in useObjectScanner
               video={true} enables takeSnapshot() for Android path */}
      <Camera
        key={cameraKey}
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={phase === "scanning"}
        frameProcessor={frameProcessor}
        photo={true}
        video={true}
      />

      {(phase === "scanning" || phase === "component_win") && (
        <>
          <CameraOverlay />

          {/*
           * v6.2 Phase 1: LiveLabelChip removed from render.
           * The component definition is preserved above for easy rollback;
           * production data (2026-05-10) showed >50% of ML Kit labels were
           * embarrassing (generic "object" or basket "tableware"), so we
           * stopped showing them to users. Lumi (rendered below) is now the
           * sole framing-phase visual presence.
           */}

          <View style={[styles.topHud, { paddingTop: insets.top + 8 }]}>
            {isHardMode && <HardModeBanner />}
            {quest && (
              <EnemyBar
                hp={enemyHp}
                name={quest.enemy_name}
                emoji={quest.enemy_emoji}
                isHardMode={isHardMode}
              />
            )}
          </View>

          <View style={[styles.bottomHud, { paddingBottom: insets.bottom + 12 }]}>
            {approachingLimit && !limitBannerDismissed && (
              <ApproachingLimitBanner
                scansToday={scansToday}
                dailyLimit={dailyLimit}
                onDismiss={() => setLimitBannerDismissed(true)}
              />
            )}

            {browsedWord && !activeQuest?.components.find(c => c.propertyWord === browsedWord && c.found) && (
              <View style={[styles.seekCard, isHardMode && styles.seekCardHard]}>
                <Text style={styles.seekLabel}>
                  {browsedWord === currentComponent?.propertyWord
                    ? "Find something…"
                    : "Browse — tap chip to hunt this"}
                </Text>
                <Text style={[styles.seekWord, isHardMode && { color: P.hardRedText }]}>
                  {browsedWord}
                </Text>
                <Text style={styles.seekDef} numberOfLines={3}>
                  {effectiveProperties.find((p) => p.word === browsedWord)?.definition}
                </Text>
              </View>
            )}

            <ComponentsStrip
              components={components}
              current={currentComponent?.propertyWord ?? null}
              browsedWord={browsedWord}
              hintedWords={hintedWords}
              onSelectWord={(word) => {
                setBrowsedWord(word);
                Haptics.selectionAsync();
              }}
            />

            {/* v3.3 iOS patch — capture error toast */}
            {scanErrorMsg !== null && (
              <View style={styles.scanErrorBanner}>
                <Text style={styles.scanErrorText}>⚠ {scanErrorMsg}</Text>
              </View>
            )}

            <ScanButton
              onPress={triggerManualScan}
              isHardMode={isHardMode}
              scanReady={scanReady}
              liveLabel={liveLabel}
              stableFrameCount={stableFrameCount}
            />

            <TouchableOpacity
              style={styles.abandonBtn}
              onPress={() => { abandonQuest(); navigation.goBack(); }}
            >
              <Text style={styles.abandonText}>✕ Abandon quest</Text>
            </TouchableOpacity>
          </View>

          <StatusBanner
            status={status}
            detectedLabel={lastLabel}
            liveLabel={liveLabel}
            liveConfidence={liveConfidence}
          />

          {phase === "component_win" && (
            <View style={styles.winFlash} pointerEvents="none">
              <Text style={styles.winText}>✦ Found!</Text>
            </View>
          )}
        </>
      )}

      {phase === "quest_intro" && quest && (
        <View style={styles.overlayFull}>
          <QuestIntro
            quest={quest}
            effectiveProperties={effectiveProperties}
            isHardMode={isHardMode}
            onBegin={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              setPhase("scanning");
            }}
          />
        </View>
      )}

      {phase === "verdict" && status === "rate_limited" && rateLimitCode && (
        <View style={StyleSheet.absoluteFillObject}>
          <RateLimitWall
            code={rateLimitCode}
            scansToday={scansToday}
            dailyLimit={dailyLimit}
            resetsAt={resetsAt}
            onBack={() => {
              resetEval();
              abandonQuest();
              navigation.goBack();
            }}
          />
        </View>
      )}

      {phase === "verdict" &&
        (status === "match" || status === "no-match" || status === "error") && (
          <VerdictCard
            status={status}
            result={result}
            error={error}
            masteryResult={masteryResult}
            cacheHit={cacheHit}
            scanAttemptId={scanAttemptId}
            onContinue={handleContinue}
            onTryAgain={handleTryAgain}
          />
        )}

      {phase === "verdict" &&
        (status === "converting" || status === "evaluating") && (
          <StatusBanner status={status} detectedLabel={lastLabel} />
        )}

      {phase === "quest_victory" && quest && (
        <VictoryFusionScreen
          quest={quest}
          components={components}
          totalXp={totalXp}
          isHardMode={isHardMode}
          onContinue={handleVictoryDismiss}
        />
      )}

      {/* ── Lumi mascot ─────────────────────────────────────────────────────
          Auto-derives state from props:
            • status              → scanning / success / fail
            • status="rate_limited" → out-of-juice
            • currentAttempts ≥ 3 → boss-help hint mode
            • hardMode            → red/crown variant
            • hidden during quest_victory (VictoryFusionScreen has its own Lumi)

          v6.2 Phase 1: Lumi is now the sole framing-phase visual presence
          (the ML Kit chip is gone). To compensate, override the scan preset's
          'anchor' movement with 'wander' during framing — Lumi drifts in a
          figure-8 across the upper portion of the screen with sparkle trail.
          Reverts to 'anchor' during evaluation (status ≠ idle) so Lumi sits
          near the scan button performing the magic loop without distracting
          from the kid's wait.
       */}
      <LumiHUD
        screen="scan"
        evaluationStatus={status}
        hardMode={isHardMode}
        dailyLimitReached={status === "rate_limited"}
        failureStreak={currentAttempts}
        hidden={phase === "quest_victory"}
        movement={status === "idle" ? "wander" : "anchor"}
        size={64}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root:     { flex: 1, backgroundColor: P.deepPurple },
  center:   { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: P.deepPurple },
  permText: { fontSize: 18, fontWeight: "700", color: P.textPrimary, textAlign: "center", marginBottom: 12 },

  // Camera viewfinder corners
  corner: { position: "absolute", width: 22, height: 22, borderColor: "#67e8f9", borderWidth: 0 },
  tl: { top: 80,     left: 20,  borderTopWidth: 2.5,    borderLeftWidth: 2.5,   borderTopLeftRadius: 4 },
  tr: { top: 80,     right: 20, borderTopWidth: 2.5,    borderRightWidth: 2.5,  borderTopRightRadius: 4 },
  bl: { bottom: 290, left: 20,  borderBottomWidth: 2.5, borderLeftWidth: 2.5,   borderBottomLeftRadius: 4 },
  br: { bottom: 290, right: 20, borderBottomWidth: 2.5, borderRightWidth: 2.5,  borderBottomRightRadius: 4 },

  // Live label chip
  liveChipWrap: { position: "absolute", top: "38%", left: 0, right: 0, alignItems: "center", zIndex: 50 },
  liveChip:     { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 7,
                  borderRadius: 30, borderWidth: 1, borderColor: "rgba(103,232,249,0.3)" },
  liveDot:      { width: 7, height: 7, borderRadius: 3.5, marginRight: 6 },
  liveChipText: { fontSize: 14, fontWeight: "600" },
  liveChipConf: { fontSize: 12, fontWeight: "500", opacity: 0.7, marginLeft: 4 },

  // Hard mode banner
  hardBanner:     { backgroundColor: P.hardRed, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 5, alignSelf: "center", marginBottom: 6 },
  hardBannerText: { fontSize: 11, fontWeight: "700", color: "#fff", letterSpacing: 0.5 },

  topHud:    { position: "absolute", top: 0, left: 0, right: 0, paddingHorizontal: 12 },
  bottomHud: { position: "absolute", bottom: 0, left: 0, right: 0, paddingHorizontal: 12 },

  // Enemy bar
  enemyBar:     { flexDirection: "row", alignItems: "center", backgroundColor: "rgba(15,6,32,0.82)", borderRadius: 14, padding: 10, borderWidth: 0.5, borderColor: P.cardBorder, marginBottom: 8 },
  enemyBarHard: { borderColor: "#7f1d1d", backgroundColor: "rgba(26,5,5,0.85)" },
  enemyName:    { fontSize: 13, color: P.textPrimary, fontWeight: "500", marginBottom: 4 },
  hpTrack:      { height: 5, backgroundColor: "rgba(255,255,255,0.1)", borderRadius: 3, overflow: "hidden" },
  hpFill:       { height: 5, backgroundColor: "#ef4444", borderRadius: 3 },
  hpFillHard:   { backgroundColor: "#dc2626" },
  hpLabel:      { fontSize: 11, color: P.textDim, minWidth: 30, textAlign: "right", marginLeft: 8 },
  hardPill:     { backgroundColor: "#7f1d1d", borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2, marginLeft: 6 },
  hardPillText: { fontSize: 10, color: P.hardRedText },

  // Progress strip
  progressRow:   { flexDirection: "row", alignItems: "center", marginBottom: 2 },
  progressTrack: { flex: 1, height: 5, backgroundColor: "rgba(255,255,255,0.08)", borderRadius: 3, overflow: "hidden", marginRight: 8 },
  progressFill:  { height: 5, backgroundColor: P.progressPurple, borderRadius: 3 },
  progressPct:   { fontSize: 12, color: P.textMuted, fontWeight: "600", minWidth: 36, textAlign: "right" },
  progressLabel: { fontSize: 11, color: P.textDim, marginBottom: 8 },

  // Word chips
  chipsRow:          { flexDirection: "row", flexWrap: "wrap", marginBottom: 8 },
  chip:              { flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20, backgroundColor: "rgba(30,16,64,0.85)", borderWidth: 0.5, borderColor: P.cardBorder, marginRight: 6, marginBottom: 6 },
  chipActive:        { borderColor: P.gold, backgroundColor: "rgba(40,24,80,0.9)" },
  chipDone:          { borderColor: "#166534", backgroundColor: "rgba(5,46,22,0.85)" },
  chipText:          { fontSize: 12, color: P.textMuted, marginLeft: 5 },
  chipTextDone:      { color: "#86efac" },
  chipObject:        { fontSize: 9, color: "#4ade80", opacity: 0.8 },
  chipTapHint:       { fontSize: 8, color: P.textDim, opacity: 0.6, marginTop: 1 },
  chipHintWrap:      { borderWidth: 1.5, borderColor: "transparent", borderRadius: 14, padding: 1 },
  chipTextHinted:    { color: "#fef3c7" },
  chipTapHintHinted: { fontSize: 8, color: "#fbbf24", opacity: 0.95, marginTop: 1, fontWeight: "700" as const },

  // Seek card
  seekCard:     { backgroundColor: "rgba(15,6,32,0.88)", borderRadius: 16, padding: 14, marginBottom: 8, borderWidth: 0.5, borderColor: P.cardBorder },
  seekCardHard: { borderColor: "#7f1d1d", backgroundColor: "rgba(26,5,5,0.88)" },
  seekLabel:    { fontSize: 11, color: P.textDim, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 2 },
  seekWord:     { fontSize: 22, fontWeight: "700", color: P.gold, marginBottom: 4 },
  seekDef:      { fontSize: 13, color: P.textMuted, lineHeight: 18 },

  // v3.3 iOS scan error toast
  scanErrorBanner: { backgroundColor: "#7f1d1d", borderRadius: 10, padding: 10, marginBottom: 8 },
  scanErrorText:   { color: "#fca5a5", fontSize: 13, textAlign: "center" },

  // Scan button
  scanBtn:     { backgroundColor: "#7c3aed", borderRadius: 50, paddingVertical: 16, alignItems: "center", marginBottom: 8 },
  scanBtnHard: { backgroundColor: P.hardRed },
  scanBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },

  // Lock-on dots
  lockDots: { flexDirection: "row", justifyContent: "center", marginTop: 6, gap: 5 },
  lockDot:  { width: 6, height: 6, borderRadius: 3 },

  abandonBtn:  { alignItems: "center", paddingVertical: 6 },
  abandonText: { fontSize: 12, color: "rgba(200,180,255,0.35)" },

  // Overlays
  overlayFull: { ...StyleSheet.absoluteFillObject, backgroundColor: P.deepPurple, justifyContent: "center", padding: 20 },
  winFlash:    { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(34,197,94,0.15)" },
  winText:     { fontSize: 36, fontWeight: "800", color: "#86efac" },

  // Quest intro
  introWrap:           { alignItems: "center" },
  introHardBadge:      { backgroundColor: P.hardRed, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 6, marginBottom: 14 },
  introHardBadgeText:  { fontSize: 13, color: "#fff", fontWeight: "800", letterSpacing: 0.8 },
  introName:           { fontSize: 26, fontWeight: "800", color: P.textPrimary, textAlign: "center" },
  introRoom:           { fontSize: 13, color: P.textMuted, marginTop: 4, marginBottom: 16 },
  introDivider:        { height: 0.5, backgroundColor: P.cardBorder, width: "100%", marginBottom: 16 },
  introHeading:        { fontSize: 14, color: P.textDim, fontWeight: "600", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 },
  introHint:           { fontSize: 12, color: P.textDim, textAlign: "center", marginBottom: 16, lineHeight: 18 },
  introPropRow:        { flexDirection: "row", marginBottom: 12, alignItems: "flex-start", width: "100%" },
  introPropWord:       { fontSize: 16, fontWeight: "700", color: P.gold, marginRight: 10, minWidth: 30 },
  introPropDef:        { fontSize: 13, color: P.textMuted, marginTop: 2, lineHeight: 18 },
  introPropDefMissing: { fontSize: 13, color: P.textDim,   marginTop: 2, lineHeight: 18, fontStyle: "italic" },
  beginBtn:            { marginTop: 24, backgroundColor: "#7c3aed", borderRadius: 16, paddingVertical: 16, paddingHorizontal: 48, alignItems: "center" },
  beginBtnHard:        { backgroundColor: P.hardRed },
  beginBtnText:        { fontSize: 17, fontWeight: "700", color: "#fff" },
});
