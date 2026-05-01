/**
 * gameStore.ts
 * Lexi-Lens — Zustand store for all client-side game state.
 *
 * N1 additions:
 *   • hasSeenOnboarding: boolean  — persisted; gates first-session walkthrough
 *   • markOnboardingComplete()    — flips flag, persists to AsyncStorage
 *
 * v2.4 additions (Phase 2.4 — Spell Book):
 *   • SpellUnlock type
 *   • spellBook: SpellUnlock[]
 *   • isLoadingSpells: boolean
 *   • loadSpellBook()
 *   • markQuestCompletion() now auto-calls loadSpellBook()
 *
 * v2.3 additions (Phase 2.3 — Daily Quest + 7-day Streak):
 *   • StreakData + DailyQuestState types
 *   • streak, dailyQuest, isDailyQuestComplete
 *   • loadStreakData(), loadDailyQuest(), recordDailyCompletion()
 *   • selectStreakMultiplier — 2.0 at ≥7 days, 1.0 otherwise
 *
 * v2.1 additions (Phase 2.1 — Quest Tier System):
 *   • QuestTier union type
 *   • TIER_ORDER, TIER_META constants
 *   • selectUnlockedTiers(), selectQuestsGroupedByTier(), selectTierCleared()
 *
 * v1.4 additions:
 *   • hard mode support on ActiveQuest
 *   • quest completion tracking
 *   • markQuestCompletion(), loadCompletedQuests()
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "../lib/supabase";

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
  evaluationHints?: string;
}

export interface Quest {
  id:                    string;
  name:                  string;
  enemy_name:            string;
  enemy_emoji:           string;
  room_label:            string;
  min_age_band:          string;
  xp_reward_first_try:   number;
  xp_reward_retry:       number;
  required_properties:   PropertyRequirement[];
  hard_mode_properties:  PropertyRequirement[];
  tier:                  QuestTier;
  age_band_properties:   Record<string, PropertyRequirement[]>;
  created_by:            string | null;
  visibility:            "public" | "private" | "pending_approval";
  approved_at:           string | null;
  sort_order:            number;
  spell_name?:           string;
  weapon_emoji?:         string;
  spell_description?:    string;
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

  // ── Actions ────────────────────────────────────────────────
  startChildSession:  (child: ChildSession) => void;
  endChildSession:    () => void;
  loadQuests:         () => Promise<void>;
  beginQuest:         (quest: Quest, hardMode?: boolean) => void;
  recordComponentFound: (opts: {
    propertyWord:  string;
    objectUsed:    string;
    xpAwarded:     number;
    attemptCount:  number;
  }) => void;
  recordMissedScan:   (propertyWord: string) => void;
  completeQuest:      () => void;
  abandonQuest:       () => void;
  syncXpFromServer:   (newXp: number, newLevel: number) => void;
  refreshChildFromDB: () => Promise<void>;
  addWordToTome:      (entry: WordTomeEntry) => void;
  setWordTomeCache:   (entries: WordTomeEntry[]) => void;
  addScanHistory:     (item: ScanHistoryItem) => void;
  clearScanHistory:   () => void;
  markQuestCompletion: (questId: string, mode: "normal" | "hard", totalXp: number) => Promise<void>;
  loadCompletedQuests: () => Promise<void>;
  loadStreakData:       () => Promise<void>;
  loadDailyQuest:      () => Promise<void>;
  recordDailyCompletion: (questId: string) => Promise<void>;
  loadSpellBook:       () => Promise<void>;
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

      // ── Session ────────────────────────────────────────────
      startChildSession: (child) => {
        const { activeChild: prev } = get();
        const isSameChild = prev?.id === child.id;

        set({
          activeChild: child,
          ...(!isSameChild && {
            completedQuestIds:     [],
            hardCompletedQuestIds: [],
            spellBook:             [],
          }),
          streak:               DEFAULT_STREAK,
          dailyQuest:           DEFAULT_DAILY_QUEST,
          isDailyQuestComplete: false,
        });

        get().loadStreakData();
        get().loadSpellBook();
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
            .order("tier", { ascending: true })
            .order("sort_order", { ascending: true });

          if (error) throw error;

          const filtered = (data ?? [])
            .filter((q: Quest) =>
              activeChild ? childMinAgeBandOk(activeChild.age_band, q.min_age_band) : true
            )
            .sort((a: Quest, b: Quest) => {
              const tierDiff =
                TIER_ORDER.indexOf(a.tier ?? "apprentice") -
                TIER_ORDER.indexOf(b.tier ?? "apprentice");
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
        const { activeChild } = get();
        const ageBand = activeChild?.age_band ?? "7-8";

        const canHardMode =
          hardMode &&
          Array.isArray(quest.hard_mode_properties) &&
          quest.hard_mode_properties.length > 0;

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

          const components = state.activeQuest.components.map((c) =>
            c.propertyWord === propertyWord
              ? { ...c, found: true, objectUsed, xpEarned: xpAwarded, attemptCount }
              : c
          );

          const enemyHp  = calcEnemyHp(components);
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
          if (!state.activeQuest || !state.activeChild) return { activeQuest: null };
          const earnedSoFar     = state.activeQuest.components
            .filter((c) => c.found)
            .reduce((sum, c) => sum + c.xpEarned, 0);
          const rolledBackXp    = Math.max(0, state.activeChild.total_xp - earnedSoFar);
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
    }),

    {
      name:    "lexi-lens-game",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        activeChild:           state.activeChild,
        wordTomeCache:         state.wordTomeCache,
        completedQuestIds:     state.completedQuestIds,
        hardCompletedQuestIds: state.hardCompletedQuestIds,
        streak:                state.streak,
        isDailyQuestComplete:  state.isDailyQuestComplete,
        spellBook:             state.spellBook,
        hasSeenOnboarding:     state.hasSeenOnboarding,   // ← N1
      }),
    }
  )
);

// ─── Selectors ────────────────────────────────────────────────────────────────

export const selectCurrentComponent = (state: GameState): ComponentProgress | null =>
  state.activeQuest?.components.find((c) => !c.found) ?? null;

export const selectQuestComplete = (state: GameState): boolean =>
  !!state.activeQuest && state.activeQuest.components.every((c) => c.found);

export const selectCurrentAttempts = (state: GameState): number =>
  selectCurrentComponent(state)?.attemptCount ?? 0;

export const selectLevelProgress = (state: GameState): number => {
  const xp    = state.activeChild?.total_xp ?? 0;
  const level = state.activeChild?.level ?? 1;
  const prev  = Math.pow(level - 1, 2) * 50;
  const next  = Math.pow(level, 2) * 50;
  return next === prev ? 0 : Math.min(1, (xp - prev) / (next - prev));
};

export const selectHasHardMode = (quest: Quest): boolean =>
  Array.isArray(quest.hard_mode_properties) && quest.hard_mode_properties.length > 0;

export const selectQuestCompletionMode = (
  state: GameState,
  questId: string
): "none" | "normal" | "hard" => {
  if (state.hardCompletedQuestIds.includes(questId)) return "hard";
  if (state.completedQuestIds.includes(questId)) return "normal";
  return "none";
};

// ── v2.1 Tier selectors ───────────────────────────────────────────────────────

export const selectTierCleared = (state: GameState, tier: QuestTier): boolean => {
  const questsInTier = state.questLibrary.filter((q) => q.tier === tier);
  if (questsInTier.length === 0) return false;
  return questsInTier.every((q) => state.completedQuestIds.includes(q.id));
};

export const selectUnlockedTiers = (state: GameState): Set<QuestTier> => {
  const unlocked = new Set<QuestTier>(["apprentice"]);
  for (let i = 0; i < TIER_ORDER.length - 1; i++) {
    const current = TIER_ORDER[i];
    const next    = TIER_ORDER[i + 1];
    if (selectTierCleared(state, current)) {
      unlocked.add(next);
    } else {
      break;
    }
  }
  return unlocked;
};

export const selectQuestsGroupedByTier = (state: GameState): TierGroup[] => {
  const unlocked = selectUnlockedTiers(state);
  return TIER_ORDER
    .map((tier) => ({
      tier,
      quests:   state.questLibrary.filter((q) => q.tier === tier),
      unlocked: unlocked.has(tier),
      cleared:  selectTierCleared(state, tier),
    }))
    .filter((group) => group.quests.length > 0);
};

// ── v2.3 Streak selectors ─────────────────────────────────────────────────────

export const selectStreakMultiplier = (state: GameState): number =>
  state.streak?.gotMultiplier ? 2.0 : 1.0;

export const selectIsPlayingDailyQuest = (state: GameState): boolean =>
  !!state.activeQuest &&
  !!state.dailyQuest.questId &&
  state.activeQuest.quest.id === state.dailyQuest.questId;

export const selectDailyQuest = (state: GameState): Quest | null =>
  state.dailyQuest.questId
    ? (state.questLibrary.find((q) => q.id === state.dailyQuest.questId) ?? null)
    : null;

// ── v2.4 Spell Book selectors ─────────────────────────────────────────────────

export const selectSpellsUnlockedCount = (state: GameState): number => {
  const unique = new Set(state.spellBook.map((s) => s.questId));
  return unique.size;
};

export const selectSpellsByTier = (
  state: GameState,
  tier: QuestTier
): SpellUnlock[] =>
  state.spellBook.filter((s) => s.tier === tier);

// ── Age-band property helper ───────────────────────────────────────────────────

/**
 * Returns the vocabulary properties that will actually be used when a child
 * plays a quest — mirroring the priority logic in beginQuest().
 *
 * Priority:
 *   1. age_band_properties[ageBand]  (enriched with definitions if bare)
 *   2. required_properties            (fallback)
 *
 * Use this everywhere word chips are rendered so the UI always matches
 * what the child will actually have to scan for.
 */
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
