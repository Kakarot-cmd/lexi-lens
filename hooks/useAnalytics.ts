/**
 * hooks/useAnalytics.ts
 * Lexi-Lens — Phase 3.7: Custom Analytics
 *
 * v4.4.1 fix (this file): quest_sessions.game_session_id was always NULL.
 *   Root cause: useAnalytics() is called in BOTH App.tsx and ScanScreen.tsx.
 *   Each call returns a separate hook instance with its own gameSessionRef.
 *   App.tsx's instance owned startSession() and populated its OWN ref. When
 *   ScanScreen's instance ran startQuestSession(), the fallback
 *   `payload.gameSessionId ?? gameSessionRef.current` saw ScanScreen's
 *   never-touched local ref (null) → game_session_id stored as NULL.
 *
 *   Fix: hoist gameSessionId into useGameStore. Both hook instances now
 *   read/write the same value via useGameStore.getState() — startSession
 *   writes it, endSession reads + clears it, startQuestSession reads it
 *   as the fallback. The questSessionRef stays hook-local because the
 *   start/finish pair always lives in the same hook instance (ScanScreen).
 *
 * Lightweight hook that writes session and word outcome data to Supabase.
 * Works alongside Sentry — Sentry catches crashes, this hook tracks behaviour.
 *
 * Usage in App.tsx (session lifecycle):
 *   const { startSession, endSession } = useAnalytics();
 *   useEffect(() => { startSession(); return () => endSession(); }, [childId]);
 *
 * Usage in ScanScreen.tsx (per-quest + per-word outcomes):
 *   const { startQuestSession, finishQuestSession, logWordOutcome } = useAnalytics();
 *
 * All writes are fire-and-forget — failures are silently swallowed so a
 * Supabase hiccup never breaks the game loop.
 */

import { useRef, useCallback } from "react";
import { supabase } from "../lib/supabase";
import { addGameBreadcrumb } from "../lib/sentry";
import { useGameStore } from "../store/gameStore";

// ─── Types ────────────────────────────────────────────────────────────────────

interface WordOutcomePayload {
  childId:   string;
  questId?:  string;
  word:      string;
  passed:    boolean;
  scanLabel: string;
  attempt:   number;
}

interface QuestSessionPayload {
  childId:        string;
  questId:        string;
  gameSessionId?: string;
  hardMode:       boolean;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useAnalytics() {
  const activeChild     = useGameStore((s) => s.activeChild);

  // v4.4.1 — gameSessionRef removed. Replaced with useGameStore.getState().gameSessionId
  // so any instance of this hook reads the same value. See file header for full
  // rationale. questSessionRef stays hook-local — start/finish always pair within
  // the same instance (ScanScreen) so cross-instance sharing isn't needed there.
  const questSessionRef = useRef<string | null>(null);   // current quest_sessions.id

  // ── App session lifecycle ──────────────────────────────────────────────────

  /** Call once when a child profile becomes active (app foreground / child switch). */
  const startSession = useCallback(async () => {
    if (!activeChild?.id) return;
    try {
      const { data, error } = await supabase
        .from("game_sessions")
        .insert({ child_id: activeChild.id })
        .select("id")
        .single();

      if (error) throw error;

      // v4.4.1 — write to store instead of hook-local ref so ScanScreen's
      // hook instance can read the same value.
      useGameStore.getState().setGameSessionId(data.id);

      addGameBreadcrumb({
        category: "navigation",
        message:  "Game session started",
        data:     { sessionId: data.id, childId: activeChild.id },
      });
    } catch {
      // Non-fatal — analytics failure must never break gameplay.
    }
  }, [activeChild?.id]);

  /** Call on app background / child switch / sign-out. */
  const endSession = useCallback(async (opts?: {
    questsStarted:  number;
    questsFinished: number;
    xpEarned:       number;
    screenSequence: string[];
  }) => {
    // v4.4.1 — read live from store at flush time. No closure capture risk.
    const sid = useGameStore.getState().gameSessionId;
    if (!sid) return;
    try {
      await supabase
        .from("game_sessions")
        .update({
          ended_at:       new Date().toISOString(),
          quests_started:  opts?.questsStarted  ?? 0,
          quests_finished: opts?.questsFinished ?? 0,
          xp_earned:       opts?.xpEarned       ?? 0,
          screen_sequence: opts?.screenSequence ?? [],
        })
        .eq("id", sid);

      addGameBreadcrumb({
        category: "navigation",
        message:  "Game session ended",
        data:     { sessionId: sid },
      });
    } catch {
      // Non-fatal.
    } finally {
      // v4.4.1 — clear in store so subsequent startQuestSession calls without
      // an open game_sessions row get NULL (correct behaviour) rather than
      // a stale id pointing at the just-closed row.
      useGameStore.getState().setGameSessionId(null);
    }
  }, []);

  // ── Quest session lifecycle ────────────────────────────────────────────────

  /** Call when ScanScreen mounts for a given quest. */
  const startQuestSession = useCallback(async (payload: QuestSessionPayload) => {
    try {
      // v4.4.1 — fallback now reads from store so ScanScreen's hook instance
      // sees the value App.tsx's hook instance wrote on session start.
      const gameSessionIdToUse =
        payload.gameSessionId ?? useGameStore.getState().gameSessionId ?? null;

      const { data, error } = await supabase
        .from("quest_sessions")
        .insert({
          child_id:        payload.childId,
          quest_id:        payload.questId,
          game_session_id: gameSessionIdToUse,
          hard_mode:       payload.hardMode,
        })
        .select("id")
        .single();

      if (error) throw error;
      questSessionRef.current = data.id;

      addGameBreadcrumb({
        category: "quest",
        message:  `Quest started${payload.hardMode ? " (Hard Mode)" : ""}`,
        data:     {
          questId:         payload.questId,
          questSessionId:  data.id,
          gameSessionId:   gameSessionIdToUse,
        },
      });
    } catch {
      // Non-fatal.
    }
  }, []);

  /**
   * Call when the player finishes or abandons a quest.
   * @param completed true = all components found; false = abandoned / navigated away.
   */
  const finishQuestSession = useCallback(async (opts: {
    completed:   boolean;
    totalScans:  number;
    xpAwarded:   number;
  }) => {
    const qsid = questSessionRef.current;
    if (!qsid) return;
    try {
      await supabase
        .from("quest_sessions")
        .update({
          finished_at:  new Date().toISOString(),
          completed:    opts.completed,
          total_scans:  opts.totalScans,
          xp_awarded:   opts.xpAwarded,
        })
        .eq("id", qsid);

      addGameBreadcrumb({
        category: "quest",
        message:  opts.completed ? "Quest completed ✓" : "Quest abandoned",
        data:     { questSessionId: qsid, xpAwarded: opts.xpAwarded },
      });
    } catch {
      // Non-fatal.
    } finally {
      questSessionRef.current = null;
    }
  }, []);

  // ── Word outcome logging ───────────────────────────────────────────────────

  /**
   * Call after each VerdictCard is shown — once per word per scan.
   * This is the data source for "words failed most" analytics.
   */
  const logWordOutcome = useCallback(async (payload: WordOutcomePayload) => {
    try {
      await supabase.from("word_outcomes").insert({
        child_id:    payload.childId,
        quest_id:    payload.questId ?? null,
        word:        payload.word,
        passed:      payload.passed,
        scan_label:  payload.scanLabel,
        attempt_num: payload.attempt,
      });
    } catch {
      // Non-fatal.
    }
  }, []);

  return {
    startSession,
    endSession,
    startQuestSession,
    finishQuestSession,
    logWordOutcome,
    /**
     * v4.4.1 — these reflect the live store/ref values, exposed for callers
     * that want to pass them explicitly into startQuestSession (rare — the
     * store-fallback inside startQuestSession handles 99% of cases).
     */
    gameSessionId:  useGameStore.getState().gameSessionId,
    questSessionId: questSessionRef.current,
  };
}
