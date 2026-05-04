/**
 * gameStore.ts
 * Lexi-Lens — Zustand store for all client-side game state.
 *
 * N4 additions:
 *   • AchievementRecord, Badge types (imported from achievementService)
 *   • achievements: AchievementRecord[]      — earned badges cache
 *   • newlyEarnedBadges: Badge[]              — queue feeding AchievementToast
 *   • isLoadingAchievements: boolean
 *   • loadAchievements()                      — called on session start
 *   • checkAndAwardBadges()                   — called after scan + quest complete
 *   • dismissEarnedBadge()                    — pops front of toast queue
 *   • startChildSession now kicks loadAchievements
 *   • markQuestCompletion now calls checkAndAwardBadges
 *
 * N1 additions:
 *   • hasSeenOnboarding: boolean  — persisted; gates first-session walkthrough
 *   • markOnboardingComplete()    — flips flag, persists to AsyncStorage
 *
 * v2.4 additions (Phase 2.4 — Spell Book):
 *   • SpellUnlock type + spellBook + isLoadingSpells + loadSpellBook()
 *   • markQuestCompletion() auto-calls loadSpellBook()
 *
 * v2.3 additions (Phase 2.3 — Daily Quest + 7-day Streak):
 *   • StreakData + DailyQuestState types
 *   • streak, dailyQuest, isDailyQuestComplete
 *   • loadStreakData(), loadDailyQuest(), recordDailyCompletion()
 *
 * v2.1 additions (Phase 2.1 — Quest Tier System):
 *   • QuestTier union type + TIER_ORDER + TIER_META
 *   • selectUnlockedTiers(), selectQuestsGroupedByTier(), selectTierCleared()
 *
 * v1.4 additions:
 *   • hard mode support + quest completion tracking
 *   • markQuestCompletion(), loadCompletedQuests()
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "../lib/supabase";

// N4 — Achievement service imports
import {
  loadEarnedAchievements,
  checkAndAward,
  type Badge,
  type AchievementRecord,
  type BadgeCheckContext,
} from "../services/achievementService";

// ─── Utility helpers ──────────────────────────────────────────────────────────

function todayDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysSinceEpoch(): number {
  return Math.floor(Date.now() / 86_400_000);
}

// ─── Domain types ─────────────────────────────────────────────────────────────

export type QuestTier = "apprentice" | "scholar" | "sage" | "archmage";

export const TIER_ORDER: QuestTier[] = [
  "apprentice",
  "scholar",
  "sage",
  "archmage",
];

export const TIER_META: Record<
  QuestTier,
  { label: string; emoji: string; color: string; lockMessage: string }
> = {
  apprentice: {
    label:       "Apprentice",
    emoji:       "🌱",
    color:       "#86efac",
    lockMessage: "Start your adventure here!",
  },
  scholar: {
    label:       "Scholar",
    emoji:       "📖",
    color:       "#93c5fd",
    lockMessage: "Complete all Apprentice quests to unlock.",
  },
  sage: {
    label:       "Sage",
    emoji:       "🔮",
    color:       "#c4b5fd",
    lockMessage: "Complete all Scholar quests to unlock.",
  },
  archmage: {
    label:       "Archmage",
    emoji:       "⚡",
    color:       "#fbbf24",
    lockMessage: "Complete all Sage quests to unlock.",
  },
};

export interface PropertyRequirement {
  word:             string;
  definition:       string;
  evaluationHints?: string;   // single hint string — matches useLexiEvaluate EvaluatePayload
}

export interface Quest {
  id:                   string;
  name:                 string;
  enemy_name:           string;
  enemy_emoji:          string;
  room_label:           string;
  min_age_band:         string;
  xp_reward_first_try:  number;
  xp_reward_retry:      number;
  xp_reward_third_plus: number;
  required_properties:  PropertyRequirement[];
  age_band_properties?: Record<string, PropertyRequirement[]>;
  // hard_mode_properties is always an array (empty if no hard mode)
  hard_mode_properties: PropertyRequirement[];
  is_active:            boolean;
  // tier is required — all quests must have one (defaulted in loadQuests)
  tier:                 QuestTier;
  sort_order?:          number;
  spell_name?:          string;
  weapon_emoji?:        string;
  spell_description?:   string;
  created_by?:          string;   // AI-generated quests carry the parent's user id
}

export interface ComponentProgress {
  propertyWord:  string;
  found:         boolean;
  objectUsed:    string | null;
  xpEarned:      number;
  attemptCount:  number;
}

export interface ActiveQuest {
  quest:               Quest;
  components:          ComponentProgress[];
  startedAt:           number;
  enemyHp:             number;
  isHardMode:          boolean;
  effectiveProperties: PropertyRequirement[];
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
  id:            string;
  timestamp:     number;
  detectedLabel: string;
  overallMatch:  boolean;
  xpAwarded:     number;
  questName:     string;
  feedback:      string;
}

export interface TierGroup {
  tier:     QuestTier;
  quests:   Quest[];
  unlocked: boolean;
  cleared:  boolean;
}

export interface StreakData {
  currentStreak:  number;
  longestStreak:  number;
  lastQuestDate:  string | null;
  streakDates:    string[];
  gotMultiplier:  boolean;
}

export interface DailyQuestState {
  questId:   string | null;
  questDate: string;
  isLoaded:  boolean;
}

export interface SpellUnlock {
  questId:          string;
  questName:        string;
  spellName:        string;
  weaponEmoji:      string;
  spellDescription: string;
  enemyName:        string;
  enemyEmoji:       string;
  roomLabel:        string;
  tier:             QuestTier;
  unlockedAt:       string;
  bestXp:           number;
  completionCount:  number;
}

// ─── Store shape ──────────────────────────────────────────────────────────────

interface GameState {
  activeChild:           ChildSession | null;
  questLibrary:          Quest[];
  activeQuest:           ActiveQuest | null;
  scanHistory:           ScanHistoryItem[];
  wordTomeCache:         WordTomeEntry[];
  completedQuestIds:     string[];
  hardCompletedQuestIds: string[];
  streak:                StreakData;
  dailyQuest:            DailyQuestState;
  isDailyQuestComplete:  boolean;
  spellBook:             SpellUnlock[];
  isLoadingSpells:       boolean;
  isLoadingQuests:       boolean;
  questError:            string | null;
  isLoadingCompletions:  boolean;

  // ── N1 ─────────────────────────────────────────────────────
  hasSeenOnboarding:      boolean;
  markOnboardingComplete: () => void;

  // ── N4: Achievement Badge System ───────────────────────────
  achievements:           AchievementRecord[];
  newlyEarnedBadges:      Badge[];
  isLoadingAchievements:  boolean;
  loadAchievements:       () => Promise<void>;
  checkAndAwardBadges:    () => Promise<void>;
  dismissEarnedBadge:     () => void;

  // ── Actions ────────────────────────────────────────────────
  startChildSession:     (child: ChildSession) => void;
  endChildSession:       () => void;
  loadQuests:            () => Promise<void>;
  beginQuest:            (quest: Quest, hardMode?: boolean) => void;
  recordComponentFound:  (opts: {
    propertyWord:  string;
    objectUsed:    string;
    xpAwarded:     number;
    attemptCount:  number;
  }) => void;
  /**
   * Atomic batch variant — accepts multiple property updates in one
   * set() call so concurrent updates from a multi-property scan don't
   * race and overwrite each other. Use this whenever a single Claude
   * response confirms 2+ properties at once.
   */
  recordComponentsFound: (updates: Array<{
    propertyWord:  string;
    objectUsed:    string;
    xpAwarded:     number;
    attemptCount:  number;
  }>) => void;
  recordMissedScan:      (propertyWord: string) => void;
  completeQuest:         () => void;
  abandonQuest:          () => void;
  syncXpFromServer:      (newXp: number, newLevel: number) => void;
  refreshChildFromDB:    () => Promise<void>;
  addWordToTome:         (entry: WordTomeEntry) => void;
  setWordTomeCache:      (entries: WordTomeEntry[]) => void;
  addScanHistory:        (item: ScanHistoryItem) => void;
  clearScanHistory:      () => void;
  markQuestCompletion:   (questId: string, mode: "normal" | "hard", totalXp: number) => Promise<void>;
  loadCompletedQuests:   () => Promise<void>;
  loadStreakData:         () => Promise<void>;
  loadDailyQuest:        () => Promise<void>;
  recordDailyCompletion: (questId: string) => Promise<void>;
  loadSpellBook:         () => Promise<void>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildComponents(properties: PropertyRequirement[]): ComponentProgress[] {
  return properties.map((p) => ({
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
  return { "5-6": 0, "7-8": 1, "9-10": 2, "11-12": 3, "13-14": 4 }[band] ?? 99;
}

function childMinAgeBandOk(childBand: string, questMinBand: string): boolean {
  return ageBandOrder(childBand) >= ageBandOrder(questMinBand);
}

const DEFAULT_STREAK: StreakData = {
  currentStreak: 0,
  longestStreak: 0,
  lastQuestDate: null,
  streakDates:   [],
  gotMultiplier: false,
};

const DEFAULT_DAILY_QUEST: DailyQuestState = {
  questId:   null,
  questDate: "",
  isLoaded:  false,
};

// ─── Store ────────────────────────────────────────────────────────────────────

export const useGameStore = create<GameState>()(
  persist(
    (set, get) => ({
      activeChild:           null,
      questLibrary:          [],
      activeQuest:           null,
      scanHistory:           [],
      wordTomeCache:         [],
      completedQuestIds:     [],
      hardCompletedQuestIds: [],
      isLoadingQuests:       false,
      questError:            null,
      isLoadingCompletions:  false,
      streak:                DEFAULT_STREAK,
      dailyQuest:            DEFAULT_DAILY_QUEST,
      isDailyQuestComplete:  false,
      spellBook:             [],
      isLoadingSpells:       false,

      // ── N1: Onboarding gate ────────────────────────────────
      hasSeenOnboarding:      false,
      markOnboardingComplete: () => set({ hasSeenOnboarding: true }),

      // ── N4: Achievement initial state ──────────────────────
      achievements:          [],
      newlyEarnedBadges:     [],
      isLoadingAchievements: false,

      // ── Session ────────────────────────────────────────────
      startChildSession: (child) => {
        const { activeChild: prev } = get();
        const isSameChild = prev?.id === child.id;

        set({
          activeChild: child,
          ...(!isSameChild && {
            // CRITICAL: clear all per-child state when switching children.
            // activeQuest is now persisted (so partial progress survives
            // app restarts within the SAME child's session) — but it must
            // NOT bleed across children. Without this clear, switching
            // from Child A to Child B while A had an in-progress quest
            // would show A's quest chips on B's screen, with A's components
            // already marked found via A's exemplar objects.
            activeQuest:           null,
            completedQuestIds:     [],
            hardCompletedQuestIds: [],
            spellBook:             [],
            scanHistory:           [],
            wordTomeCache:         [],
            achievements:          [],
            newlyEarnedBadges:     [],
          }),
          streak:               DEFAULT_STREAK,
          dailyQuest:           DEFAULT_DAILY_QUEST,
          isDailyQuestComplete: false,
        });

        get().loadStreakData();
        get().loadSpellBook();
        // N4 — load earned badges on session start (fire & forget)
        setTimeout(() => { get().loadAchievements(); }, 0);
      },

      endChildSession: () =>
        set({
          activeChild:           null,
          activeQuest:           null,
          scanHistory:           [],
          wordTomeCache:         [],
          completedQuestIds:     [],
          hardCompletedQuestIds: [],
          spellBook:             [],
          streak:                DEFAULT_STREAK,
          dailyQuest:            DEFAULT_DAILY_QUEST,
          isDailyQuestComplete:  false,
          achievements:          [],
          newlyEarnedBadges:     [],
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
            .order("tier",       { ascending: true })
            .order("sort_order", { ascending: true });

          if (error) throw error;

          const filtered: Quest[] = (data ?? [])
            .filter((q: any) =>
              activeChild ? childMinAgeBandOk(activeChild.age_band, q.min_age_band) : true
            )
            .map((q: any): Quest => ({
              ...q,
              // Guarantee tier is always a valid QuestTier (never undefined)
              tier:                 (q.tier as QuestTier) ?? "apprentice",
              // Guarantee hard_mode_properties is always an array
              hard_mode_properties: Array.isArray(q.hard_mode_properties)
                ? q.hard_mode_properties
                : [],
            }))
            .sort((a: Quest, b: Quest) => {
              const tierDiff =
                TIER_ORDER.indexOf(a.tier) -
                TIER_ORDER.indexOf(b.tier);
              if (tierDiff !== 0) return tierDiff;
              return (a.sort_order ?? 8) - (b.sort_order ?? 8);
            });

          set({ questLibrary: filtered, isLoadingQuests: false });
        } catch (err: any) {
          set({ questError: err.message ?? "Failed to load quests", isLoadingQuests: false });
        }
      },

      // ── Quest lifecycle ────────────────────────────────────
      beginQuest: (quest, hardMode = false) => {
        const { activeChild, activeQuest: existing } = get();
        const ageBand = activeChild?.age_band ?? "7-8";

        const canHardMode =
          hardMode &&
          Array.isArray(quest.hard_mode_properties) &&
          quest.hard_mode_properties.length > 0;

        // Idempotency guard: if we already have an active quest for the
        // same quest id AND the same hard-mode flag, DO NOT clobber it.
        // The user might be returning to ScanScreen mid-quest after
        // backgrounding — wiping components.found here would re-ask
        // Claude about already-found properties on the next scan.
        if (
          existing &&
          existing.quest.id === quest.id &&
          existing.isHardMode === canHardMode
        ) {
          return;
        }

        const ageBandProps = quest.age_band_properties?.[ageBand];

        const enrichedAgeBandProps = ageBandProps?.map(
          (p: PropertyRequirement) => {
            if (p.definition?.trim()) return p;
            const canonical = quest.required_properties.find((r) => r.word === p.word);
            return canonical
              ? { ...p, definition: canonical.definition, evaluationHints: p.evaluationHints ?? canonical.evaluationHints }
              : p;
          }
        );

        const baseProperties =
          enrichedAgeBandProps && enrichedAgeBandProps.length > 0
            ? enrichedAgeBandProps
            : quest.required_properties;

        const effectiveProperties = canHardMode
          ? quest.hard_mode_properties
          : baseProperties;

        set({
          activeQuest: {
            quest,
            components:          buildComponents(effectiveProperties),
            startedAt:           Date.now(),
            enemyHp:             100,
            isHardMode:          canHardMode,
            effectiveProperties,
          },
        });
      },

      recordComponentFound: ({ propertyWord, objectUsed, xpAwarded, attemptCount }) =>
        set((state) => {
          if (!state.activeQuest) return state;

          // FIX (Boredom Behemoth chip-stuck-grey): match case-insensitively.
          // Claude occasionally returns property words with different casing
          // ("Fibrous" vs canonical "fibrous"). Strict equality silently misses
          // those, leaving chips grey even though Claude flagged passes:true.
          const target = propertyWord.toLowerCase().trim();
          const components = state.activeQuest.components.map((c) =>
            c.propertyWord.toLowerCase().trim() === target
              ? { ...c, found: true, objectUsed, xpEarned: xpAwarded, attemptCount }
              : c
          );

          const enemyHp = calcEnemyHp(components);

          // FIX #2 (audit): NO optimistic XP credit to activeChild.total_xp here.
          // The xpEarned value is recorded on the component so the verdict card
          // can display "+X XP" and markQuestCompletion can sum at the end.
          // But the running total_xp on the child is the AUTHORITATIVE source —
          // updated only by markQuestCompletion → award_xp RPC → refreshChildFromDB.
          // This eliminates the optimistic-vs-DB drift class of bug.
          return {
            activeQuest: { ...state.activeQuest, components, enemyHp },
          };
        }),

      /**
       * Atomic batch update — applies all property unlocks in a single
       * set() call so the second update can see the first's results.
       *
       * Why this exists: when a single Claude response confirms multiple
       * properties (e.g. "smooth", "round", "hollow" all on a cup), calling
       * recordComponentFound() in a forEach loop creates a race. Each call
       * starts from state.activeQuest.components — Zustand may still hold
       * the pre-update snapshot when the second/third call fires, so
       * earlier updates get clobbered. Net result: only the LAST property
       * stays marked found. Quest never completes. Screen never closes.
       *
       * The batch path computes one new components array containing every
       * update, then commits in a single set(). All-or-nothing, no race.
       */
      recordComponentsFound: (updates) =>
        set((state) => {
          if (!state.activeQuest || updates.length === 0) return state;

          // FIX (Boredom Behemoth chip-stuck-grey): match case-insensitively.
          // Map keys lowercase-trim so "Fibrous" → "fibrous" lookup succeeds
          // when canonical components.propertyWord is "fibrous".
          const updateMap = new Map(
            updates.map((u) => [u.propertyWord.toLowerCase().trim(), u])
          );

          const components = state.activeQuest.components.map((c) => {
            const update = updateMap.get(c.propertyWord.toLowerCase().trim());
            return update
              ? {
                  ...c,
                  found:        true,
                  objectUsed:   update.objectUsed,
                  xpEarned:     update.xpAwarded,
                  attemptCount: update.attemptCount,
                }
              : c;
          });

          const enemyHp = calcEnemyHp(components);

          // FIX #2 (audit): NO optimistic XP credit to activeChild.total_xp.
          // See recordComponentFound above for the full rationale.
          return {
            activeQuest: { ...state.activeQuest, components, enemyHp },
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
          // FIX #2 (audit): abandonQuest no longer rolls back XP because no XP
          // was optimistically credited during the quest. The child's total_xp
          // only changes via markQuestCompletion → award_xp, which only fires
          // on successful completion. Abandoning is now a clean state reset.
          if (!state.activeQuest) return { activeQuest: null };
          return { activeQuest: null };
        }),

      syncXpFromServer: (newXp, newLevel) =>
        set((state) =>
          state.activeChild
            ? { activeChild: { ...state.activeChild, total_xp: newXp, level: newLevel } }
            : state
        ),

      refreshChildFromDB: async () => {
        const { activeChild } = get();
        if (!activeChild) return;
        try {
          const { data, error } = await supabase
            .from("child_profiles")
            .select("total_xp, level")
            .eq("id", activeChild.id)
            .single();
          if (error || !data) return;
          set((state) =>
            state.activeChild
              ? { activeChild: { ...state.activeChild, total_xp: data.total_xp, level: data.level } }
              : state
          );
        } catch {
          // Non-fatal
        }
      },

      // ── Word Tome ──────────────────────────────────────────
      // PERSISTENCE FIX: addWordToTome was previously local-only —
      // wordTomeCache was updated, but nothing ever wrote to the
      // public.word_tome table. Result: every child's Word Tome was
      // empty across sessions, the PDF export was empty, and the
      // mastery + leaderboard services queried an empty table.
      //
      // We now also fire-and-forget the record_word_learned RPC
      // (defined in schema.sql, security-definer, idempotent on
      // (child_id, word) — increments times_used on conflict).
      // The RPC failure is logged but never breaks the local cache
      // update, so the in-game UX is unaffected if the network is down.
      addWordToTome: (entry) => {
        // Local cache update — synchronous, unchanged behaviour.
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
        });

        // DB persistence — fire-and-forget. Reads activeChild fresh
        // from the store so we don't capture a stale closure value.
        const child = get().activeChild;
        if (!child) return;

        void (async () => {
          try {
            const { error } = await supabase.rpc("record_word_learned", {
              p_child_id:        child.id,
              p_word:            entry.word,
              p_definition:      entry.definition,
              p_exemplar_object: entry.exemplar_object,
            });
            if (error) {
              console.warn("[addWordToTome] record_word_learned RPC failed:", error.message);
            }
          } catch (e) {
            // Non-fatal — local cache already updated; UX continues.
            console.warn("[addWordToTome] record_word_learned threw:", e);
          }
        })();
      },

      setWordTomeCache: (entries) => set({ wordTomeCache: entries }),

      addScanHistory: (item) =>
        set((state) => ({
          scanHistory: [item, ...state.scanHistory].slice(0, 50),
        })),

      clearScanHistory: () => set({ scanHistory: [] }),

      // ── v1.4: Quest completion ─────────────────────────────
      markQuestCompletion: async (questId, mode, totalXp) => {
        const { activeChild, completedQuestIds, hardCompletedQuestIds } = get();
        if (!activeChild) return;

        if (mode === "normal" && !completedQuestIds.includes(questId)) {
          set({ completedQuestIds: [...completedQuestIds, questId] });
        } else if (mode === "hard" && !hardCompletedQuestIds.includes(questId)) {
          set({ hardCompletedQuestIds: [...hardCompletedQuestIds, questId] });
        }

        try {
          const { error: upsertError } = await supabase
            .from("quest_completions")
            .upsert(
              {
                child_id:     activeChild.id,
                quest_id:     questId,
                mode,
                total_xp:     totalXp,
                completed_at: new Date().toISOString(),
              },
              { onConflict: "child_id,quest_id,mode" }
            );

          if (upsertError) {
            console.error("[markQuestCompletion] Upsert failed:", upsertError);
          } else {
            const { error: xpError } = await supabase.rpc("award_xp", {
              p_child_id: activeChild.id,
              p_xp:       totalXp,
            });
            if (xpError) {
              console.error("[markQuestCompletion] award_xp RPC failed:", xpError);
            } else {
              await get().refreshChildFromDB();
            }
            get().loadCompletedQuests();
          }
        } catch (e) {
          console.error("[markQuestCompletion] Unexpected error:", e);
        }

        get().recordDailyCompletion(questId);
        get().loadSpellBook();
        // N4 — check for newly earned badges after quest complete
        get().checkAndAwardBadges();
      },

      loadCompletedQuests: async () => {
        const { activeChild } = get();
        if (!activeChild) return;

        set({ isLoadingCompletions: true });
        try {
          const { data, error } = await supabase
            .from("quest_completions")
            .select("quest_id, mode")
            .eq("child_id", activeChild.id);

          if (error) {
            console.error("[loadCompletedQuests] DB read failed:", error);
            set({ isLoadingCompletions: false });
            return;
          }

          const normal: string[] = [];
          const hard:   string[] = [];
          (data ?? []).forEach((row: { quest_id: string; mode: string }) => {
            if (row.mode === "normal") normal.push(row.quest_id);
            else if (row.mode === "hard") hard.push(row.quest_id);
          });

          set({
            completedQuestIds:     normal,
            hardCompletedQuestIds: hard,
            isLoadingCompletions:  false,
          });
        } catch (e) {
          console.error("[loadCompletedQuests] Exception:", e);
          set({ isLoadingCompletions: false });
        }
      },

      // ── v2.3: Streak actions ───────────────────────────────

      loadStreakData: async () => {
        const { activeChild } = get();
        if (!activeChild) return;

        const { data, error } = await supabase
          .from("child_streaks")
          .select("current_streak, longest_streak, last_quest_date, streak_dates")
          .eq("child_id", activeChild.id)
          .maybeSingle();

        if (error || !data) return;

        const today = todayDate();
        set({
          streak: {
            currentStreak: data.current_streak  ?? 0,
            longestStreak: data.longest_streak  ?? 0,
            lastQuestDate: data.last_quest_date ?? null,
            streakDates:   data.streak_dates    ?? [],
            gotMultiplier: (data.current_streak ?? 0) >= 7,
          },
          isDailyQuestComplete: data.last_quest_date === today,
        });
      },

      loadDailyQuest: async () => {
        const { questLibrary } = get();
        const today = todayDate();

        const { data } = await supabase
          .from("daily_quests")
          .select("quest_id")
          .eq("quest_date", today)
          .maybeSingle();

        let questId: string | null = null;

        if (data?.quest_id) {
          questId = data.quest_id;
        } else if (questLibrary.length > 0) {
          const activeQuests = questLibrary.filter((q) => (q as any).is_active !== false);
          if (activeQuests.length > 0) {
            const dayIndex = daysSinceEpoch() % activeQuests.length;
            questId = activeQuests[dayIndex].id;
          }
        }

        set({
          dailyQuest: {
            questId,
            questDate: today,
            isLoaded:  true,
          },
        });
      },

      recordDailyCompletion: async (questId: string) => {
        const { activeChild, dailyQuest, isDailyQuestComplete } = get();
        if (!activeChild)                    return;
        if (dailyQuest.questId !== questId)  return;
        if (isDailyQuestComplete)             return;

        try {
          const { data, error } = await supabase.rpc("record_daily_completion", {
            p_child_id: activeChild.id,
            p_date:     todayDate(),
          });

          if (error) throw error;

          const row = Array.isArray(data) ? data[0] : data;
          if (!row) return;

          const today = todayDate();
          set((state) => ({
            isDailyQuestComplete: true,
            streak: {
              ...state.streak,
              currentStreak: row.new_streak,
              longestStreak: row.longest_streak,
              lastQuestDate: today,
              streakDates:   [...new Set([...state.streak.streakDates, today])].slice(-30),
              gotMultiplier: row.got_multiplier,
            },
          }));
        } catch {
          // Non-fatal
        }
      },

      // ── v2.4: Spell Book ───────────────────────────────────

      loadSpellBook: async () => {
        const { activeChild } = get();
        if (!activeChild) return;

        set({ isLoadingSpells: true });
        try {
          const { data, error } = await supabase
            .from("spell_unlocks")
            .select(
              "quest_id, quest_name, spell_name, weapon_emoji, spell_description, " +
              "enemy_name, enemy_emoji, room_label, tier, " +
              "first_unlocked_at, best_xp, completion_count"
            )
            .eq("child_id", activeChild.id)
            .order("first_unlocked_at", { ascending: false });

          if (error) throw error;

          const unlocks: SpellUnlock[] = (data ?? []).map((row: any) => ({
            questId:          row.quest_id,
            questName:        row.quest_name,
            spellName:        row.spell_name        ?? row.quest_name,
            weaponEmoji:      row.weapon_emoji       ?? "⚔️",
            spellDescription: row.spell_description  ?? "",
            enemyName:        row.enemy_name,
            enemyEmoji:       row.enemy_emoji,
            roomLabel:        row.room_label,
            tier:             row.tier               as QuestTier,
            unlockedAt:       row.first_unlocked_at,
            bestXp:           row.best_xp            ?? 0,
            completionCount:  row.completion_count   ?? 1,
          }));

          set({ spellBook: unlocks, isLoadingSpells: false });
        } catch {
          set({ isLoadingSpells: false });
        }
      },

      // ── N4: Achievement Badge System ───────────────────────

      loadAchievements: async () => {
        const { activeChild } = get();
        if (!activeChild) return;
        set({ isLoadingAchievements: true });
        try {
          const records = await loadEarnedAchievements(activeChild.id);
          set({ achievements: records, isLoadingAchievements: false });
        } catch {
          set({ isLoadingAchievements: false });
        }
      },

      checkAndAwardBadges: async () => {
        const {
          activeChild,
          wordTomeCache,
          streak,
          completedQuestIds,
          hardCompletedQuestIds,
          spellBook,
        } = get();
        if (!activeChild) return;

        // Always load fresh from DB — prevents double-awarding across sessions
        const currentEarned = await loadEarnedAchievements(activeChild.id);

        const ctx: BadgeCheckContext = {
          childId:           activeChild.id,
          totalXp:           activeChild.total_xp,
          wordCount:         wordTomeCache.length,
          streak:            streak.currentStreak,
          completedQuestIds,
          hardCompletedIds:  hardCompletedQuestIds,
          completedTiers:    [...new Set(spellBook.map((s) => s.tier.toLowerCase()))],
          hasScanned:        wordTomeCache.length > 0 || completedQuestIds.length > 0,
        };

        const newBadges = await checkAndAward(ctx, currentEarned);
        if (newBadges.length === 0) return;

        const nowStr     = new Date().toISOString();
        const newRecords = newBadges.map((b) => ({ badge_id: b.id, earned_at: nowStr }));

        // Update cache + push to toast queue
        set((state) => ({
          achievements:      [...state.achievements, ...newRecords],
          newlyEarnedBadges: [...state.newlyEarnedBadges, ...newBadges],
        }));

        // Fire push notification per badge (stagger 1.5s apart)
        newBadges.forEach((badge, i) => {
          setTimeout(async () => {
            try {
              const { sendBadgeNotification } = await import("../lib/notifications");
              await sendBadgeNotification(badge);
            } catch { /* non-fatal */ }
          }, i * 1500);
        });
      },

      dismissEarnedBadge: () =>
        set((state) => ({ newlyEarnedBadges: state.newlyEarnedBadges.slice(1) })),

    }),

    {
      name:    "lexi-lens-game",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        activeChild:           state.activeChild,
        // activeQuest is now persisted so partial progress survives
        // screen unmounts and app restarts. Without this, navigating
        // away from ScanScreen mid-quest (or backgrounding the app)
        // would wipe the components.found flags — meaning the next
        // scan would re-ask Claude about already-found properties,
        // award duplicate XP, and break the completion check.
        activeQuest:           state.activeQuest,
        wordTomeCache:         state.wordTomeCache,
        completedQuestIds:     state.completedQuestIds,
        hardCompletedQuestIds: state.hardCompletedQuestIds,
        streak:                state.streak,
        isDailyQuestComplete:  state.isDailyQuestComplete,
        spellBook:             state.spellBook,
        hasSeenOnboarding:     state.hasSeenOnboarding,
        // achievements are NOT persisted — always loaded fresh from DB
      }),
    }
  )
);

// ─── Selectors ────────────────────────────────────────────────────────────────

export const selectCurrentComponent = (state: GameState): ComponentProgress | null =>
  state.activeQuest?.components.find((c) => !c.found) ?? null;

export const selectCurrentAttempts = (state: GameState): number =>
  state.activeQuest?.components.find((c) => !c.found)?.attemptCount ?? 0;

export const selectQuestComplete = (state: GameState): boolean =>
  !!state.activeQuest &&
  state.activeQuest.components.length > 0 &&
  state.activeQuest.components.every((c) => c.found);

export const selectUnlockedTiers = (state: GameState): QuestTier[] => {
  const completed = new Set(state.completedQuestIds);
  const unlocked: QuestTier[] = [];

  for (const tier of TIER_ORDER) {
    unlocked.push(tier);
    const tierQuests = state.questLibrary.filter((q) => q.tier === tier);
    const allDone    = tierQuests.length > 0 && tierQuests.every((q) => completed.has(q.id));
    if (!allDone) break;
  }

  return unlocked;
};

export const selectQuestsGroupedByTier = (state: GameState): TierGroup[] => {
  const completed     = new Set(state.completedQuestIds);
  const unlockedTiers = selectUnlockedTiers(state);

  return TIER_ORDER.map((tier) => ({
    tier,
    quests:   state.questLibrary.filter((q) => q.tier === tier),
    unlocked: unlockedTiers.includes(tier),
    cleared:  state.questLibrary
      .filter((q) => q.tier === tier)
      .every((q) => completed.has(q.id)),
  }));
};

export const selectTierCleared = (tier: QuestTier) => (state: GameState): boolean => {
  const tierQuests = state.questLibrary.filter((q) => q.tier === tier);
  const completed  = new Set(state.completedQuestIds);
  return tierQuests.length > 0 && tierQuests.every((q) => completed.has(q.id));
};

export const selectStreakMultiplier = (state: GameState): number =>
  state.streak.gotMultiplier ? 2.0 : 1.0;

export const selectIsPlayingDailyQuest = (state: GameState): boolean =>
  !!state.activeQuest &&
  !!state.dailyQuest.questId &&
  state.activeQuest.quest.id === state.dailyQuest.questId;

export const selectDailyQuest = (state: GameState): Quest | null =>
  state.dailyQuest.questId
    ? (state.questLibrary.find((q) => q.id === state.dailyQuest.questId) ?? null)
    : null;

export const selectSpellsUnlockedCount = (state: GameState): number => {
  const unique = new Set(state.spellBook.map((s) => s.questId));
  return unique.size;
};

export const selectSpellsByTier = (
  state: GameState,
  tier: QuestTier
): SpellUnlock[] =>
  state.spellBook.filter((s) => s.tier === tier);

// ── Missing selectors (QuestMapScreen) ────────────────────────────────────────

/**
 * Per-quest completion mode — takes (state, questId).
 * Called as: useGameStore((s) => selectQuestCompletionMode(s, quest.id))
 * Returns the highest mode the child has completed this quest in, or null.
 */
export const selectQuestCompletionMode = (
  state:   GameState,
  questId: string
): "normal" | "hard" | null => {
  if (state.hardCompletedQuestIds.includes(questId))   return "hard";
  if (state.completedQuestIds.includes(questId))        return "normal";
  return null;
};

/**
 * Pure function — takes a Quest object, NOT the store state.
 * Called as: selectHasHardMode(quest)
 * Returns true when the quest has hard-mode properties defined.
 */
export const selectHasHardMode = (quest: Quest): boolean =>
  Array.isArray(quest.hard_mode_properties) && quest.hard_mode_properties.length > 0;
 
/**
 * Returns fractional XP progress toward the next level (0 – 1).
 * XP formula mirrors the server-side award_xp stored procedure:
 *   level = floor(sqrt(total_xp / 50)) + 1
 *   threshold_for_level_n = (n-1)^2 * 50
 */
export const selectLevelProgress = (state: GameState): number => {
  const xp    = state.activeChild?.total_xp ?? 0;
  const level = Math.max(1, state.activeChild?.level ?? 1);
  const lo    = Math.pow(level - 1, 2) * 50;
  const hi    = Math.pow(level, 2) * 50;
  const range = hi - lo;
  if (range <= 0) return 1;
  return Math.min(1, Math.max(0, (xp - lo) / range));
};

// ── Age-band property helper ───────────────────────────────────────────────────
export function getDisplayProperties(
  quest: Quest,
  ageBand: string
): PropertyRequirement[] {
  const ageBandProps = quest.age_band_properties?.[ageBand];
  if (!ageBandProps || ageBandProps.length === 0) return quest.required_properties;

  const enriched = ageBandProps.map((p) => {
    if (p.definition?.trim()) return p;
    const canonical = quest.required_properties.find((r) => r.word === p.word);
    return canonical
      ? { ...p, definition: canonical.definition, evaluationHints: p.evaluationHints ?? canonical.evaluationHints }
      : p;
  });

  return enriched;
}
