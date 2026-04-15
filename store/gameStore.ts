/**
 * gameStore.ts
 * Lexi-Lens — Zustand store for all client-side game state.
 *
 * Covers:
 *   • Active child session (which child is playing)
 *   • Current quest + component progress
 *   • XP / level with optimistic updates
 *   • Word Tome cache (mirrors DB, avoids round-trips)
 *   • Scan history for the current session
 *   • Quest library (fetched once, cached)
 *
 * Dependencies:
 *   npm install zustand
 *   npx expo install @react-native-async-storage/async-storage
 *   npm install zustand/middleware   (bundled with zustand)
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "../lib/supabase";

// ─── Domain types ─────────────────────────────────────────────────────────────

export interface PropertyRequirement {
  word:             string;
  definition:       string;
  evaluationHints?: string;
}

export interface Quest {
  id:                  string;
  name:                string;
  enemy_name:          string;
  enemy_emoji:         string;
  room_label:          string;
  min_age_band:        string;
  xp_reward_first_try: number;
  xp_reward_retry:     number;
  required_properties: PropertyRequirement[];
}

export interface ComponentProgress {
  /** The property word this component unlocks (e.g. "translucent") */
  propertyWord:   string;
  found:          boolean;
  objectUsed:     string | null; // e.g. "glass of water"
  xpEarned:       number;
  attemptCount:   number;
}

export interface ActiveQuest {
  quest:       Quest;
  /** One entry per required_property in quest.required_properties */
  components:  ComponentProgress[];
  startedAt:   number; // Date.now()
  enemyHp:     number; // 0–100, decremented on each component found
}

export interface ChildSession {
  id:           string;
  display_name: string;
  age_band:     string;
  level:        number;
  total_xp:     number;
  avatar_key:   string | null;
}

export interface WordTomeEntry {
  word:            string;
  definition:      string;
  exemplar_object: string;
  times_used:      number;
  first_used_at:   string;
}

export interface ScanHistoryItem {
  id:            string; // uuid
  timestamp:     number;
  detectedLabel: string;
  overallMatch:  boolean;
  xpAwarded:     number;
  questName:     string;
  feedback:      string;
}

// ─── Store shape ──────────────────────────────────────────────────────────────

interface GameState {
  // ── Session ──────────────────────────────────────────────
  activeChild:     ChildSession | null;
  questLibrary:    Quest[];
  activeQuest:     ActiveQuest | null;
  scanHistory:     ScanHistoryItem[];
  wordTomeCache:   WordTomeEntry[];

  // UI flags
  isLoadingQuests: boolean;
  questError:      string | null;

  // ── Actions ───────────────────────────────────────────────
  /** Call after a parent selects which child is playing */
  startChildSession:  (child: ChildSession) => void;
  endChildSession:    () => void;

  /** Load quest library from Supabase (filtered to child's age band) */
  loadQuests:         () => Promise<void>;

  /** Set the current quest (enemy appears, components reset to unfound) */
  beginQuest:         (quest: Quest) => void;

  /**
   * Called by ScanScreen after a successful Claude evaluation.
   * Updates the matching component, decrements enemy HP, awards XP optimistically.
   */
  recordComponentFound: (opts: {
    propertyWord:   string;
    objectUsed:     string;
    xpAwarded:      number;
    attemptCount:   number;
  }) => void;

  /** Called when the child misses — increments attempt count on the component */
  recordMissedScan: (propertyWord: string) => void;

  /** Clears active quest (called after all components found + victory animation) */
  completeQuest: () => void;

  /** Abandons quest without completion */
  abandonQuest: () => void;

  /** Sync XP/level from server after Edge Function confirms it */
  syncXpFromServer: (newXp: number, newLevel: number) => void;

  /** Add a word to the local Word Tome cache */
  addWordToTome: (entry: WordTomeEntry) => void;

  /** Seed the Word Tome cache from a fresh DB fetch */
  setWordTomeCache: (entries: WordTomeEntry[]) => void;

  /** Append a scan to session history */
  addScanHistory: (item: ScanHistoryItem) => void;

  /** Clear session history (e.g. on logout) */
  clearScanHistory: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildComponents(quest: Quest): ComponentProgress[] {
  return quest.required_properties.map((p) => ({
    propertyWord: p.word,
    found:        false,
    objectUsed:   null,
    xpEarned:     0,
    attemptCount: 0,
  }));
}

function calcEnemyHp(components: ComponentProgress[]): number {
  if (components.length === 0) return 100;
  const foundCount = components.filter((c) => c.found).length;
  return Math.round(((components.length - foundCount) / components.length) * 100);
}

function ageBandOrder(band: string): number {
  return { "5-6": 0, "7-8": 1, "9-10": 2, "11-12": 3 }[band] ?? 99;
}

function childMinAgeBandOk(childBand: string, questMinBand: string): boolean {
  return ageBandOrder(childBand) >= ageBandOrder(questMinBand);
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useGameStore = create<GameState>()(
  persist(
    (set, get) => ({
      activeChild:     null,
      questLibrary:    [],
      activeQuest:     null,
      scanHistory:     [],
      wordTomeCache:   [],
      isLoadingQuests: false,
      questError:      null,

      // ── Session ────────────────────────────────────────────
      startChildSession: (child) => set({ activeChild: child }),

      endChildSession: () =>
        set({
          activeChild:   null,
          activeQuest:   null,
          scanHistory:   [],
          wordTomeCache: [],
        }),

      // ── Quest library ──────────────────────────────────────
      loadQuests: async () => {
        const { activeChild } = get();
        set({ isLoadingQuests: true, questError: null });
        try {
          const { data, error } = await supabase
            .from("quests")
            .select("*")
            .eq("is_active", true)
            .order("created_at");

          if (error) throw error;

          // Filter to age-appropriate quests
          const filtered = (data ?? []).filter((q: Quest) =>
            activeChild ? childMinAgeBandOk(activeChild.age_band, q.min_age_band) : true
          );

          set({ questLibrary: filtered, isLoadingQuests: false });
        } catch (err: any) {
          set({ questError: err.message ?? "Failed to load quests", isLoadingQuests: false });
        }
      },

      // ── Quest lifecycle ────────────────────────────────────
      beginQuest: (quest) =>
        set({
          activeQuest: {
            quest,
            components: buildComponents(quest),
            startedAt:  Date.now(),
            enemyHp:    100,
          },
        }),

      recordComponentFound: ({ propertyWord, objectUsed, xpAwarded, attemptCount }) =>
        set((state) => {
          if (!state.activeQuest) return state;

          const components = state.activeQuest.components.map((c) =>
            c.propertyWord === propertyWord
              ? { ...c, found: true, objectUsed, xpAwarded, attemptCount }
              : c
          );

          const enemyHp = calcEnemyHp(components);

          // Optimistic XP update
          const newXp    = (state.activeChild?.total_xp ?? 0) + xpAwarded;
          const newLevel = Math.min(100, Math.floor(Math.sqrt(newXp / 50)) + 1);

          return {
            activeQuest: { ...state.activeQuest, components, enemyHp },
            activeChild: state.activeChild
              ? { ...state.activeChild, total_xp: newXp, level: newLevel }
              : null,
          };
        }),

      recordMissedScan: (propertyWord) =>
        set((state) => {
          if (!state.activeQuest) return state;
          const components = state.activeQuest.components.map((c) =>
            c.propertyWord === propertyWord
              ? { ...c, attemptCount: c.attemptCount + 1 }
              : c
          );
          return { activeQuest: { ...state.activeQuest, components } };
        }),

      completeQuest: () => set({ activeQuest: null }),

      abandonQuest: () =>
        set((state) => {
          // Roll back optimistic XP for any components found during this quest
          if (!state.activeQuest || !state.activeChild) return { activeQuest: null };
          const earnedSoFar = state.activeQuest.components
            .filter((c) => c.found)
            .reduce((sum, c) => sum + c.xpEarned, 0);
          const rolledBackXp = Math.max(0, state.activeChild.total_xp - earnedSoFar);
          const rolledBackLevel = Math.min(100, Math.floor(Math.sqrt(rolledBackXp / 50)) + 1);
          return {
            activeQuest: null,
            activeChild: {
              ...state.activeChild,
              total_xp: rolledBackXp,
              level:    rolledBackLevel,
            },
          };
        }),

      // ── XP sync ───────────────────────────────────────────
      syncXpFromServer: (newXp, newLevel) =>
        set((state) =>
          state.activeChild
            ? { activeChild: { ...state.activeChild, total_xp: newXp, level: newLevel } }
            : state
        ),

      // ── Word Tome ──────────────────────────────────────────
      addWordToTome: (entry) =>
        set((state) => {
          const existing = state.wordTomeCache.findIndex((w) => w.word === entry.word);
          if (existing >= 0) {
            const updated = [...state.wordTomeCache];
            updated[existing] = {
              ...updated[existing],
              times_used:      updated[existing].times_used + 1,
              exemplar_object: entry.exemplar_object,
            };
            return { wordTomeCache: updated };
          }
          return { wordTomeCache: [entry, ...state.wordTomeCache] };
        }),

      setWordTomeCache: (entries) => set({ wordTomeCache: entries }),

      // ── Scan history ──────────────────────────────────────
      addScanHistory: (item) =>
        set((state) => ({
          // Keep last 50 scans in memory
          scanHistory: [item, ...state.scanHistory].slice(0, 50),
        })),

      clearScanHistory: () => set({ scanHistory: [] }),
    }),

    {
      name:    "lexi-lens-game",
      storage: createJSONStorage(() => AsyncStorage),
      // Only persist the child session + word tome cache across app restarts.
      // Never persist activeQuest — a killed app should restart the quest cleanly.
      partialize: (state) => ({
        activeChild:   state.activeChild,
        wordTomeCache: state.wordTomeCache,
      }),
    }
  )
);

// ─── Selectors (use these in components, not raw state) ───────────────────────

/** Current component the child needs to find next (first unfound) */
export const selectCurrentComponent = (state: GameState): ComponentProgress | null =>
  state.activeQuest?.components.find((c) => !c.found) ?? null;

/** True when all components in the active quest have been found */
export const selectQuestComplete = (state: GameState): boolean =>
  !!state.activeQuest && state.activeQuest.components.every((c) => c.found);

/** How many times the child has failed on the current component */
export const selectCurrentAttempts = (state: GameState): number =>
  selectCurrentComponent(state)?.attemptCount ?? 0;

/** XP progress within the current level (0–1) */
export const selectLevelProgress = (state: GameState): number => {
  const xp    = state.activeChild?.total_xp ?? 0;
  const level = state.activeChild?.level ?? 1;
  const prev  = Math.pow(level - 1, 2) * 50;
  const next  = Math.pow(level, 2) * 50;
  return next === prev ? 0 : Math.min(1, (xp - prev) / (next - prev));
};
