/**
 * ScanScreen.tsx — Lexi-Lens main gameplay screen
 *
 * v3.5 additions (Rate Limiting + Abuse Prevention):
 *   • Destructures rateLimitCode, scansToday, dailyLimit, approachingLimit,
 *     resetsAt from useLexiEvaluate
 *   • status === "rate_limited" → setPhase("verdict") so render tree picks
 *     it up cleanly (same pattern as "error")
 *   • RateLimitWall rendered as absoluteFillObject overlay when rate_limited
 *   • ApproachingLimitBanner shown non-blocking in scanning phase at 80% quota
 *   • limitBannerDismissed local state so child can clear the warning
 *
 * v3.1 additions:
 *   • LiveLabelChip — floating chip on camera showing what ML Kit currently sees
 *     ("📦 cushion · 94%"). Updates every 1.5s. Disappears when scanning.
 *   • liveLabel + liveConfidence destructured from useObjectScanner
 *   • StatusBanner receives liveLabel + liveConfidence for idle state text
 *   • onDetection now receives ML Kit label as primary.label — Claude only
 *     evaluates vocabulary properties, not object identification (~50% cheaper)
 *
 * v1.4 changes:
 *   • effectiveProperties for hard mode
 *   • markQuestCompletion on victory dismiss
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
} from "react-native";
import { Camera } from "react-native-vision-camera";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import { useObjectScanner } from "../hooks/useObjectScanner";
import { useLexiEvaluate } from "../hooks/useLexiEvaluate";
import {
  useGameStore,
  selectCurrentComponent,
  selectCurrentAttempts,
  selectQuestComplete,
  selectStreakMultiplier,
} from "../store/gameStore";
import { VerdictCard }                              from "../components/VerdictCard";
import { StatusBanner }                             from "../components/StatusBanner";
import { VictoryFusionScreen }                      from "../components/VictoryFusionScreen";
import { RateLimitWall, ApproachingLimitBanner }    from "../components/RateLimitWall"; // v3.5

type RootStackParamList = {
  Scan: { questId: string; hardMode?: boolean };
};
type Props = NativeStackScreenProps<RootStackParamList, "Scan">;

type ScreenPhase =
  | "quest_intro"
  | "scanning"
  | "verdict"
  | "component_win"
  | "quest_victory";

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

// ─── v3.1: Live ML Kit label chip ────────────────────────────────────────────

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
  onSelectWord,
}: {
  components:   Array<{ propertyWord: string; found: boolean; objectUsed: string | null }>;
  current:      string | null;
  browsedWord:  string | null;
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
      <Text style={styles.progressLabel}>{foundCount}/{total} components found</Text>

      <View style={styles.chipsRow}>
        {components.map((c) => {
          const isBrowsed = c.propertyWord === browsedWord && !c.found;
          return (
            <TouchableOpacity
              key={c.propertyWord}
              style={[
                styles.chip,
                c.found   && styles.chipDone,
                isBrowsed && styles.chipActive,
              ]}
              onPress={() => { if (!c.found) onSelectWord(c.propertyWord); }}
              activeOpacity={c.found ? 1 : 0.7}
              accessibilityRole="button"
              accessibilityLabel={`${c.propertyWord}${c.found ? " — found" : " — tap to view"}`}
            >
              <Text style={{ fontSize: 10, color: c.found ? "#86efac" : P.textDim }}>
                {c.found ? "✦" : isBrowsed ? "◉" : "○"}
              </Text>
              <View>
                <Text style={[styles.chipText, c.found && styles.chipTextDone]}>
                  {c.propertyWord}
                </Text>
                {c.found && c.objectUsed && (
                  <Text style={styles.chipObject} numberOfLines={1}>
                    via {c.objectUsed}
                  </Text>
                )}
                {!c.found && (
                  <Text style={styles.chipTapHint}>
                    {isBrowsed ? "viewing" : "tap to view"}
                  </Text>
                )}
              </View>
            </TouchableOpacity>
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
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={styles.enemyName} numberOfLines={1}>{name}</Text>
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
  quest:               NonNullable<ReturnType<typeof useGameStore>["activeQuest"]>["quest"];
  effectiveProperties: NonNullable<ReturnType<typeof useGameStore>["activeQuest"]>["effectiveProperties"];
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
        {isHardMode ? "Hard mode vocabulary:" : "Find material components:"}
      </Text>
      <Text style={styles.introHint}>
        {isHardMode
          ? "Same enemy — harder synonym challenge!"
          : "One object can satisfy multiple properties!"}
      </Text>
      {effectiveProperties.map((p) => (
        <View key={p.word} style={styles.introPropRow}>
          <Text style={{ color: isHardMode ? P.hardRedText : P.gold, fontSize: 14, marginTop: 2 }}>
            {isHardMode ? "⚔" : "✦"}
          </Text>
          <View style={{ flex: 1 }}>
            <Text style={[styles.introPropWord, isHardMode && { color: P.hardRedText }]}>
              {p.word}
            </Text>
            <Text style={styles.introPropDef}>{p.definition}</Text>
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

  const streakMultiplier     = useGameStore(selectStreakMultiplier);
  const beginQuest           = useGameStore((s) => s.beginQuest);
  const recordComponentFound = useGameStore((s) => s.recordComponentFound);
  const recordMissedScan     = useGameStore((s) => s.recordMissedScan);
  const completeQuest        = useGameStore((s) => s.completeQuest);
  const abandonQuest         = useGameStore((s) => s.abandonQuest);
  const addWordToTome        = useGameStore((s) => s.addWordToTome);
  const addScanHistory       = useGameStore((s) => s.addScanHistory);
  const markQuestCompletion  = useGameStore((s) => s.markQuestCompletion);
  const refreshChildFromDB   = useGameStore((s) => s.refreshChildFromDB);

  const [phase, setPhase]                         = useState<ScreenPhase>("quest_intro");
  const [lastLabel, setLastLabel]                 = useState<string | null>(null);
  const [browsedWord, setBrowsedWord]             = useState<string | null>(null);
  const [limitBannerDismissed, setLimitBannerDismissed] = useState(false); // v3.5

  useEffect(() => {
    const quest = questLibrary.find((q) => q.id === questId);
    if (quest && (!activeQuest || activeQuest.quest.id !== questId)) {
      beginQuest(quest, routeHardMode);
    }
  }, [questId]);

  useEffect(() => {
    if (currentComponent && !browsedWord) {
      setBrowsedWord(currentComponent.propertyWord);
    }
  }, [currentComponent?.propertyWord]);

  const isHardMode          = activeQuest?.isHardMode ?? false;
  const effectiveProperties = activeQuest?.effectiveProperties ?? [];

  const pendingProperties = effectiveProperties.filter(
    (p) => !activeQuest?.components.find((c) => c.propertyWord === p.word && c.found)
  );

  // v3.5: expanded destructure
  const {
    status,
    result,
    error,
    masteryResult,
    cacheHit,
    evaluate,
    reset: resetEval,
    rateLimitCode,
    scansToday,
    dailyLimit,
    approachingLimit,
    resetsAt,
  } = useLexiEvaluate();

  // ── Core mechanic: save any newly passing property ────────────────────────

  useEffect(() => {
    // v3.5: rate_limited goes straight to verdict phase so RateLimitWall renders
    if (status === "rate_limited") {
      setPhase("verdict");
      return;
    }

    if (!result || !activeQuest) return;

    if (status === "match" || status === "no-match") {
      setPhase("verdict");

      const alreadyFound = new Set(
        (activeQuest.components ?? []).filter((c) => c.found).map((c) => c.propertyWord)
      );

      // FIX: result.properties is undefined when Edge Function returns a
      // partial response (e.g. error shape without properties array).
      // Guard with ?? [] so the forEach below safely does nothing.
      const newlyPassing = (result.properties ?? []).filter(
        (p) => p.passes && !alreadyFound.has(p.word)
      );

      if (newlyPassing.length > 0) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

        // ── XP calculation (Phase 1.2 + 2.3) ─────────────────────────────
        //
        // result.xpAwarded already includes the multi-property bonus from
        // the Edge Function (1.0× / 1.5× / 2.0× based on passingCount).
        //
        // Here we additionally apply the 7-day streak multiplier (1.0× or 2.0×)
        // from the store — this is the only place that knows both values.
        //
        // Previous bug: divided xpAwarded by newlyPassing.length, which cut
        // XP instead of distributing it. Each property gets the full XP share:
        //   total = xpAwarded × streakMultiplier
        //   each  = total / newlyPassing.length   (fair split across properties)
        //
        // Minimum 10 XP per property so no find ever feels worthless.
        const totalXpThisScan = Math.round((result.xpAwarded || 20) * streakMultiplier);
        const xpEach = Math.max(10, Math.floor(totalXpThisScan / newlyPassing.length));

        newlyPassing.forEach((p) => {
          recordComponentFound({
            propertyWord: p.word,
            objectUsed:   result.resolvedObjectName,
            xpAwarded:    xpEach,
            attemptCount: currentAttempts + 1,
          });
          const req = effectiveProperties.find((r) => r.word === p.word);
          if (req) {
            addWordToTome({
              word:            p.word,
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
          questName:     activeQuest.quest.name ?? "",
          feedback:      result.childFeedback,
        });
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        if (currentComponent) recordMissedScan(currentComponent.propertyWord);
      }
    }

    if (status === "error") setPhase("verdict");
  }, [status]);

  const handleContinue = useCallback(() => {
    if (questComplete) {
      setPhase("quest_victory");
    } else {
      setPhase("component_win");
      setTimeout(() => { resetEval(); setPhase("scanning"); }, 1400);
    }
  }, [questComplete, resetEval]);

  const handleTryAgain = useCallback(() => {
    resetEval();
    setPhase("scanning");
  }, [resetEval]);

  const handleVictoryDismiss = useCallback(() => {
    if (!activeQuest || !activeChild) {
      completeQuest();
      navigation.goBack();
      return;
    }
    const totalXp = activeQuest.components.reduce((s, c) => s + c.xpEarned, 0);
    const mode    = activeQuest.isHardMode ? "hard" : "normal";

    // FIX: markQuestCompletion was not awaited. navigation.goBack() fired while the
    // upsert was still in-flight. Any focus-triggered DB read in QuestMap would
    // race the upsert and return stale data, wiping the optimistic update.
    //
    // We use .then() (not async/await) so the callback stays () => void as required
    // by VictoryFusionScreen's onContinue prop type.
    //
    // Sequence:
    //   1. markQuestCompletion() → optimistic set fires immediately (sync) → upsert starts
    //   2. Upsert completes (~200ms) → loadCompletedQuests() confirms from DB
    //   3. .then() fires → completeQuest() + navigation.goBack()
    //   4. QuestMap renders with fully confirmed completedQuestIds → shows "Done" ✓
    markQuestCompletion(activeQuest.quest.id, mode, totalXp)
      .then(() => {
        completeQuest();
        refreshChildFromDB();
        navigation.goBack();
      })
      .catch(() => {
        // Upsert failed (network/schema error) — optimistic update is still in
        // the store and AsyncStorage, so same-session and cold-launch still work.
        // Navigate away regardless so the child isn't stuck on the victory screen.
        completeQuest();
        navigation.goBack();
      });
  }, [activeQuest, activeChild, markQuestCompletion, completeQuest, refreshChildFromDB, navigation]);

  // ── v3.1: ML Kit scanner ──────────────────────────────────────────────────

  const {
    cameraRef,
    device,
    hasPermission,
    frameProcessor,
    triggerManualScan,
    liveLabel,
    liveConfidence,
  } = useObjectScanner({
    enabled: phase === "scanning" && status === "idle",
    onDetection: async ({ primary, frameBase64 }) => {
      if (!activeChild || !activeQuest) return;

      setLastLabel(primary?.label ?? "object");
      setPhase("verdict");

      await evaluate({
        childId:            activeChild.id,
        questId:            activeQuest.quest.id,
        questName:          activeQuest.quest.name,
        detectedLabel:      primary?.label ?? "object",
        confidence:         primary?.confidence ?? 0.9,
        frameBase64Already: frameBase64 ?? undefined,
        requiredProperties: pendingProperties,
        alreadyFoundWords:  activeQuest.components
          .filter((c) => c.found)
          .map((c) => c.propertyWord),
        childAge:           parseInt(activeChild.age_band.split("-")[1], 10),
        failedAttempts:     currentAttempts,
      });
    },
  });

  // ── Guards ────────────────────────────────────────────────────────────────

  if (!hasPermission) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.permText}>Camera access needed</Text>
      </View>
    );
  }
  if (!device) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.permText}>No camera found</Text>
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
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={phase === "scanning"}
        frameProcessor={frameProcessor}
        photo
      />

      {(phase === "scanning" || phase === "component_win") && (
        <>
          <CameraOverlay />

          <LiveLabelChip
            label={liveLabel}
            confidence={liveConfidence}
            visible={phase === "scanning" && status === "idle"}
          />

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
            {/* v3.5 — approaching-limit warning strip, dismissible */}
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
              onSelectWord={(word) => {
                setBrowsedWord(word);
                Haptics.selectionAsync();
              }}
            />

            <TouchableOpacity
              style={[styles.scanBtn, isHardMode && styles.scanBtnHard]}
              onPress={triggerManualScan}
            >
              <Text style={styles.scanBtnText}>
                {isHardMode ? "⚔ Scan this object" : "✦ Scan this object"}
              </Text>
            </TouchableOpacity>

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

      {/* v3.5 — rate limit wall: full-screen overlay, shown before VerdictCard check */}
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
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root:     { flex: 1, backgroundColor: P.deepPurple },
  center:   { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, backgroundColor: P.deepPurple },
  permText: { fontSize: 18, fontWeight: "700", color: P.textPrimary, textAlign: "center" },

  corner: { position: "absolute", width: 22, height: 22, borderColor: "#67e8f9", borderStyle: "solid", borderWidth: 0 },
  tl: { top: 80,    left: 20,  borderTopWidth: 2.5,    borderLeftWidth: 2.5,  borderTopLeftRadius: 4 },
  tr: { top: 80,    right: 20, borderTopWidth: 2.5,    borderRightWidth: 2.5, borderTopRightRadius: 4 },
  bl: { bottom: 290, left: 20, borderBottomWidth: 2.5, borderLeftWidth: 2.5,  borderBottomLeftRadius: 4 },
  br: { bottom: 290, right: 20,borderBottomWidth: 2.5, borderRightWidth: 2.5, borderBottomRightRadius: 4 },

  liveChipWrap: {
    position:   "absolute",
    top:        "38%",
    left:       0,
    right:      0,
    alignItems: "center",
    zIndex:     50,
  },
  liveChip: {
    flexDirection:     "row",
    alignItems:        "center",
    gap:               6,
    paddingHorizontal: 14,
    paddingVertical:   7,
    borderRadius:      30,
    borderWidth:       1,
    borderColor:       "rgba(103,232,249,0.3)",
  },
  liveDot:      { width: 7, height: 7, borderRadius: 3.5 },
  liveChipText: { fontSize: 14, fontWeight: "600" },
  liveChipConf: { fontSize: 12, fontWeight: "500", opacity: 0.7 },

  hardBanner:     { backgroundColor: P.hardRed, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 5, alignSelf: "center", marginBottom: 6 },
  hardBannerText: { fontSize: 11, fontWeight: "700", color: "#fff", letterSpacing: 0.5 },

  topHud:    { position: "absolute", top: 0, left: 0, right: 0, paddingHorizontal: 12 },
  bottomHud: { position: "absolute", bottom: 0, left: 0, right: 0, paddingHorizontal: 12 },

  enemyBar:     { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "rgba(15,6,32,0.82)", borderRadius: 14, padding: 10, borderWidth: 0.5, borderColor: P.cardBorder },
  enemyBarHard: { borderColor: "#7f1d1d", backgroundColor: "rgba(26,5,5,0.85)" },
  enemyName:    { fontSize: 13, color: P.textPrimary, fontWeight: "500", marginBottom: 4 },
  hpTrack:      { height: 5, backgroundColor: "rgba(255,255,255,0.1)", borderRadius: 3, overflow: "hidden" },
  hpFill:       { height: 5, backgroundColor: "#ef4444", borderRadius: 3 },
  hpFillHard:   { backgroundColor: "#dc2626" },
  hpLabel:      { fontSize: 11, color: P.textDim, minWidth: 30, textAlign: "right" },

  hardPill:     { backgroundColor: "#7f1d1d", borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2 },
  hardPillText: { fontSize: 10, color: P.hardRedText },

  progressRow:   { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 2 },
  progressTrack: { flex: 1, height: 5, backgroundColor: "rgba(255,255,255,0.08)", borderRadius: 3, overflow: "hidden" },
  progressFill:  { height: 5, backgroundColor: P.progressPurple, borderRadius: 3 },
  progressPct:   { fontSize: 12, color: P.textMuted, fontWeight: "600", minWidth: 36, textAlign: "right" },
  progressLabel: { fontSize: 11, color: P.textDim, marginBottom: 8 },

  chipsRow:     { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 },
  chip:         { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20, backgroundColor: "rgba(30,16,64,0.85)", borderWidth: 0.5, borderColor: P.cardBorder },
  chipActive:   { borderColor: P.gold, backgroundColor: "rgba(40,24,80,0.9)" },
  chipDone:     { borderColor: "#166534", backgroundColor: "rgba(5,46,22,0.85)" },
  chipText:     { fontSize: 12, color: P.textMuted },
  chipTextDone: { color: "#86efac" },
  chipObject:   { fontSize: 9, color: "#4ade80", opacity: 0.8 },
  chipTapHint:  { fontSize: 8, color: P.textDim, opacity: 0.6, marginTop: 1 },

  seekCard:     { backgroundColor: "rgba(15,6,32,0.88)", borderRadius: 16, padding: 14, marginBottom: 8, borderWidth: 0.5, borderColor: P.cardBorder },
  seekCardHard: { borderColor: "#7f1d1d", backgroundColor: "rgba(26,5,5,0.88)" },
  seekLabel:    { fontSize: 11, color: P.textDim, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 2 },
  seekWord:     { fontSize: 22, fontWeight: "700", color: P.gold, marginBottom: 4 },
  seekDef:      { fontSize: 13, color: P.textMuted, lineHeight: 18 },

  scanBtn:     { backgroundColor: "#7c3aed", borderRadius: 50, paddingVertical: 16, alignItems: "center", marginBottom: 8 },
  scanBtnHard: { backgroundColor: P.hardRed },
  scanBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },

  abandonBtn:  { alignItems: "center", paddingVertical: 6 },
  abandonText: { fontSize: 12, color: "rgba(200,180,255,0.35)" },

  overlayFull: { ...StyleSheet.absoluteFillObject, backgroundColor: P.deepPurple, justifyContent: "center", padding: 20 },

  introWrap:          { alignItems: "center" },
  introHardBadge:     { backgroundColor: P.hardRed, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 6, marginBottom: 14 },
  introHardBadgeText: { fontSize: 13, color: "#fff", fontWeight: "800", letterSpacing: 0.8 },
  introName:          { fontSize: 26, fontWeight: "800", color: P.textPrimary, textAlign: "center" },
  introRoom:          { fontSize: 13, color: P.textMuted, marginTop: 4, marginBottom: 16 },
  introDivider:       { height: 0.5, backgroundColor: P.cardBorder, width: "100%", marginBottom: 16 },
  introHeading:       { fontSize: 14, color: P.textDim, fontWeight: "600", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 },
  introHint:          { fontSize: 12, color: P.textDim, textAlign: "center", marginBottom: 16, lineHeight: 18 },
  introPropRow:       { flexDirection: "row", gap: 10, marginBottom: 12, alignItems: "flex-start", width: "100%" },
  introPropWord:      { fontSize: 16, fontWeight: "700", color: P.gold },
  introPropDef:       { fontSize: 13, color: P.textMuted, marginTop: 2, lineHeight: 18 },
  beginBtn:           { marginTop: 24, backgroundColor: "#7c3aed", borderRadius: 16, paddingVertical: 16, paddingHorizontal: 48, alignItems: "center" },
  beginBtnHard:       { backgroundColor: P.hardRed },
  beginBtnText:       { fontSize: 17, fontWeight: "700", color: "#fff" },

  winFlash: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(34,197,94,0.15)", pointerEvents: "none" as any },
  winText:  { fontSize: 36, fontWeight: "800", color: "#86efac" },
});
