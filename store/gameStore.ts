/**
 * gameStore.ts
 * Lexi-Lens — Zustand store for all client-side game state.
 *
 * v4.4.2 additions (this file):
 *   • markQuestCompletion now retries on transient network errors —
 *     fixes Bug C ("[markQuestCompletion] Upsert failed: TypeError:
 *     Network request failed" silently dropping completions).
 *
 *     Retry policy mirrors useLexiEvaluate's existing constants for
 *     consistency: MAX_RETRIES=2, BASE_DELAY=800ms, exponential backoff
 *     (800ms → 1600ms). Total worst-case latency: ~3.4 seconds before
 *     surrender. Both the quest_completions upsert AND the award_xp RPC
 *     are wrapped — failure of either silently dropped XP before this fix.
 *
 *     Only NETWORK errors retry. Real DB errors (UNIQUE constraint
 *     violations, RLS rejections, missing columns) skip retry — they
 *     won't resolve themselves and retrying just delays the surfacing.
 *
 *     A Sentry breadcrumb fires on every retry attempt and on final
 *     surrender, giving a clean retry trail in the dashboard. Local
 *     completedQuestIds set still updates optimistically (UI feels fast)
 *     but rolls back if all retries fail — so a transient blip leaves
 *     the user with the correct DB-backed state on next reload.
 *
 * v4.4.1 additions:
 *   • gameSessionId: string | null  — hoisted from useAnalytics hook-local
 *     ref so any instance of useAnalytics (currently called in BOTH App.tsx
 *     and ScanScreen.tsx) reads the same value via useGameStore.getState().
 *     Fixes Bug A: quest_sessions.game_session_id was always NULL.
 *   • addWordToTome findIndex now case-insensitive — "Soft" and "soft" no
 *     longer create duplicate cache entries.
 *
 * v4.4 additions:
 *   • sessionCounters slice — { questsStarted, questsFinished, xpEarned }
 *     incremented by beginQuest (after idempotency guard) and
 *     markQuestCompletion (after award_xp success). NOT persisted —
 *     resets on every cold start. Read by App.tsx at game_sessions
 *     close to populate quests_started / quests_finished / xp_earned.
 *
 * N4 additions:
 *   • AchievementRecord, Badge types (imported from achievementService)
 *   • achievements: AchievementRecord[]      — earned badges cache
 *   • newlyEarnedBadges: Badge[]              — queue feeding AchievementToast
 *   • isLoadingAchievements: boolean
 *   • loadAchievements()                      — called on session start
 *   • checkAndAwardBadges()                   — called after scan + quest complete
 *   • dismissEarnedBadge()                    — pops front of toast queue
 *
 * N1 additions:
 *   • hasSeenOnboarding: boolean  — persisted; gates first-session walkthrough
 *   • markOnboardingComplete()    — flips flag, persists to AsyncStorage
 *
 * v2.4 / v2.3 / v2.1 / v1.4 — see prior history in repo.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "../lib/supabase";
import { addGameBreadcrumb } from "../lib/sentry";

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

/**
 * v6.4 — UTC-anchored date for daily-quest lookups.
 *
 * The daily quest rotates globally at UTC midnight (server-side anchor in
 * supabase/functions/ensure-daily-quest). Client must use UTC for the
 * daily_quests fast-path lookup so off-UTC users don't miss the cached row
 * and trigger an unnecessary Edge Function call. Streak logic continues to
 * use local todayDate() — that's deliberate, kids' "I played today" feeling
 * should match their local calendar.
 */
function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysSinceEpoch(): number {
  return Math.floor(Date.now() / 86_400_000);
}

// ─── v4.4.2 — Retry helpers for markQuestCompletion ──────────────────────────
//
// Mirrors useLexiEvaluate.ts constants for consistency (DRY would put these in
// lib/retry.ts, deferred — keeping them inline so this fix is one-file).

const MQC_MAX_RETRIES         = 2;
const MQC_BASE_RETRY_DELAY_MS = 800;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Heuristic — does this Supabase error look like a transient network failure?
 *
 * On RN, fetch failures arrive as `TypeError: Network request failed` (with
 * no .code, no .status). On real DB errors, Supabase returns a structured
 * { code, message, details, hint } shape with a populated .code. We retry
 * the first class only — retrying real DB errors just delays surfacing.
 *
 * Also catches AbortError / timeout-shaped errors that some RN polyfills
 * raise during connectivity flaps.
 */
function isTransientNetworkError(err: unknown): boolean {
  if (!err) return false;

  const msg = String((err as any)?.message ?? err ?? "").toLowerCase();
  if (msg.includes("network request failed")) return true;
  if (msg.includes("network error"))           return true;
  if (msg.includes("failed to fetch"))         return true;
  if (msg.includes("timeout"))                 return true;
  if (msg.includes("aborted"))                 return true;

  // TypeError with no Postgres .code field is the classic RN fetch-failure shape.
  // Real Postgres errors carry a non-empty code like "23505" (unique violation),
  // "42501" (RLS), "PGRST..." (PostgREST routing), etc. — all are deterministic
  // server-side rejections that won't change between retries.
  const code = (err as any)?.code;
  const isTypeError = (err as any)?.name === "TypeError";
  if (isTypeError && (!code || code === "")) return true;

  return false;
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
  hard_mode_properties: PropertyRequirement[];
  is_active:            boolean;
  tier:                 QuestTier;
  sort_order?:          number;
  spell_name?:          string;
  weapon_emoji?:        string;
  spell_description?:   string;
  created_by?:          string;
  /**
   * v6.0 — DB column `quests.min_subscription_tier`.
   * 'free' = visible+playable for everyone.
   * 'paid' = visible-but-locked for free parents (greyed card with
   *   upgrade CTA). Server `evaluate` enforces the gate as a safety
   *   net even if a client somehow bypasses the lock.
   * Optional in the client type because legacy quests pre-dating the
   * column may return null; treat null as 'free'.
   */
  min_subscription_tier?: "free" | "paid";
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
  age:          number;   // v6.1 — actual integer age, NOT the band's representative
  age_band:     string;   // derived from age via DB trigger; kept for cohort queries
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

  hasSeenOnboarding:      boolean;
  markOnboardingComplete: () => void;

  achievements:           AchievementRecord[];
  newlyEarnedBadges:      Badge[];
  isLoadingAchievements:  boolean;
  loadAchievements:       () => Promise<void>;
  checkAndAwardBadges:    () => Promise<void>;
  dismissEarnedBadge:     () => void;

  sessionCounters: {
    questsStarted:  number;
    questsFinished: number;
    xpEarned:       number;
  };
  resetSessionCounters:     () => void;
  bumpSessionQuestStarted:  () => void;
  bumpSessionQuestFinished: (xp: number) => void;

  gameSessionId:    string | null;
  setGameSessionId: (id: string | null) => void;

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
  loadStreakData:        () => Promise<void>;
  loadDailyQuest:        () => Promise<void>;
  recordDailyCompletion: (questId: string) => Promise<void>;
  loadSpellBook:         () => Promise<void>;

  // ── v6.0 — Parent subscription tier (drives quest lock state on the map) ─
  /**
   * 'free' or 'paid', sourced from public.parents.subscription_tier.
   * null means "not yet loaded" — render conservatively as if free.
   * Persisted via partialize so cold starts don't flash a misleading
   * unlocked-then-locked state on the QuestMap.
   */
  parentSubscriptionTier: "free" | "paid" | null;
  /**
   * Fetches the signed-in parent's subscription_tier and writes it to
   * the store. Defaults to 'free' on any error or missing row — the
   * most restrictive value, so the lock stays on if we can't verify.
   * Idempotent; safe to call from any mount.
   */
  loadParentProfile:     () => Promise<void>;
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
  return ({ "5-6": 0, "7-8": 1, "9-10": 2, "11-12": 3, "13-14": 4 } as Record<string, number>)[band] ?? 99;
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

      sessionCounters: { questsStarted: 0, questsFinished: 0, xpEarned: 0 },

      gameSessionId:    null,
      setGameSessionId: (id) => set({ gameSessionId: id }),

      hasSeenOnboarding:      false,
      markOnboardingComplete: () => set({ hasSeenOnboarding: true }),

      achievements:          [],
      newlyEarnedBadges:     [],
      isLoadingAchievements: false,

      // v6.0 — null until loadParentProfile() resolves; render as free meanwhile
      parentSubscriptionTier: null,

      resetSessionCounters: () =>
        set({ sessionCounters: { questsStarted: 0, questsFinished: 0, xpEarned: 0 } }),

      bumpSessionQuestStarted: () =>
        set((state) => ({
          sessionCounters: {
            ...state.sessionCounters,
            questsStarted: state.sessionCounters.questsStarted + 1,
          },
        })),

      bumpSessionQuestFinished: (xp: number) =>
        set((state) => ({
          sessionCounters: {
            ...state.sessionCounters,
            questsFinished: state.sessionCounters.questsFinished + 1,
            xpEarned:       state.sessionCounters.xpEarned + (typeof xp === "number" && !isNaN(xp) ? xp : 0),
          },
        })),

      // ── Session ────────────────────────────────────────────
      startChildSession: (child) => {
        const { activeChild: prev } = get();
        const isSameChild = prev?.id === child.id;

        set({
          activeChild: child,
          ...(!isSameChild && {
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
              tier:                 (q.tier as QuestTier) ?? "apprentice",
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

      // ── v6.0 — Parent profile (subscription tier) ─────────
      //
      // Reads the signed-in parent's row from public.parents and writes
      // subscription_tier into the store. Used by QuestMapScreen to mark
      // paid quests as locked for free parents.
      //
      // Failure modes — all bias toward 'free' (most restrictive lock state):
      //   • Not signed in              → null  (treat as free at render time)
      //   • parents row missing         → 'free' (defensive default)
      //   • Network / DB error          → 'free'
      //   • Column doesn't exist yet    → 'free' (graceful pre-migration)
      //
      // Server-side `evaluate` is the authoritative gate; this client value
      // only drives UI affordance, never a security decision.
      loadParentProfile: async () => {
        try {
          const { data: { user }, error: authErr } = await supabase.auth.getUser();
          if (authErr || !user) {
            set({ parentSubscriptionTier: null });
            return;
          }

          const { data, error } = await supabase
            .from("parents")
            .select("subscription_tier")
            .eq("id", user.id)
            .maybeSingle();

          if (error) {
            // Likely the column or row is missing — fail closed to 'free'.
            set({ parentSubscriptionTier: "free" });
            return;
          }

          const raw = (data as { subscription_tier?: string } | null)?.subscription_tier;
          // v6.3.1: paid-equivalent tier collapse. Any of the 4 v6.0 tiers OR
          // the legacy 'paid' value counts as paid-tier capability for UI
          // gating purposes. Keeps parentSubscriptionTier as a binary field
          // (free | paid | null) — callers like selectIsQuestLocked stay
          // simple; the SQL-side equivalent is the is_paid_tier() function.
          // Mirrors the same vocabulary; update both if the tier list changes.
          const isPaidEquivalent =
            raw === "paid"  ||
            raw === "tier1" ||
            raw === "tier2" ||
            raw === "family";
          set({ parentSubscriptionTier: isPaidEquivalent ? "paid" : "free" });
        } catch {
          set({ parentSubscriptionTier: "free" });
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

        if (
          existing &&
          existing.quest.id === quest.id &&
          existing.isHardMode === canHardMode
        ) {
          return;
        }

        get().bumpSessionQuestStarted();

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

          const target = propertyWord.toLowerCase().trim();
          const components = state.activeQuest.components.map((c) =>
            c.propertyWord.toLowerCase().trim() === target
              ? { ...c, found: true, objectUsed, xpEarned: xpAwarded, attemptCount }
              : c
          );

          const enemyHp = calcEnemyHp(components);

          return {
            activeQuest: { ...state.activeQuest, components, enemyHp },
          };
        }),

      recordComponentsFound: (updates) =>
        set((state) => {
          if (!state.activeQuest || updates.length === 0) return state;

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
      addWordToTome: (entry) => {
        set((state) => {
          const incomingKey = entry.word.toLowerCase().trim();
          const existing = state.wordTomeCache.findIndex(
            (w) => w.word.toLowerCase().trim() === incomingKey
          );
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
      //
      // v4.4.2 — Bug C fix: retry-with-backoff on transient network errors.
      //
      // The previous shape (try { upsert; if (!err) award_xp; } catch {}) silently
      // dropped completions whenever a single fetch hit a network glitch — a real
      // problem on iOS dev mode (TypeError: Network request failed) and a latent
      // problem in production (carrier handoff, lift cellular, brief WiFi drop).
      //
      // Strategy:
      //   • Each Supabase call wrapped in retryOnNetworkError() with 2 retries.
      //   • Total worst-case latency ~3.4s before surrender.
      //   • Real DB errors (UNIQUE violation, RLS, missing column) skip retry.
      //   • Local completedQuestIds set still updates optimistically — UI feels
      //     fast — but rolls back if all retries fail. So a transient blip leaves
      //     the user with the correct DB-backed state on next reload.
      //   • Sentry breadcrumbs on every retry attempt + final surrender for
      //     observability.
      markQuestCompletion: async (questId, mode, totalXp) => {
        const { activeChild, completedQuestIds, hardCompletedQuestIds } = get();
        if (!activeChild) return;

        // ── Optimistic local update ────────────────────────────────────────
        // Set the local flag so the UI updates immediately. If both retries
        // fail, we roll this back below so DB stays the source of truth.
        const wasInNormal = completedQuestIds.includes(questId);
        const wasInHard   = hardCompletedQuestIds.includes(questId);
        if (mode === "normal" && !wasInNormal) {
          set({ completedQuestIds: [...completedQuestIds, questId] });
        } else if (mode === "hard" && !wasInHard) {
          set({ hardCompletedQuestIds: [...hardCompletedQuestIds, questId] });
        }

        // ── Generic retry helper for the two RPC calls below ───────────────
        // Returns: { ok: true } on success (within retry budget),
        //          { ok: false, error } on real DB error (skip retry),
        //          { ok: false, error } on network error after retries exhausted.
        const retryOnNetworkError = async (
          label: string,
          fn:    () => PromiseLike<{ error: any | null }>
        ): Promise<{ ok: true } | { ok: false; error: any }> => {
          for (let attempt = 0; attempt <= MQC_MAX_RETRIES; attempt++) {
            try {
              const { error } = await fn();
              if (!error) {
                if (attempt > 0) {
                  addGameBreadcrumb({
                    category: "quest",
                    message:  `[markQuestCompletion] ${label} succeeded on retry ${attempt}`,
                    data:     { questId, mode, totalXp, attempt },
                  });
                }
                return { ok: true };
              }

              // We got an error object back — is it transient or a real DB error?
              if (!isTransientNetworkError(error)) {
                console.error(`[markQuestCompletion] ${label} failed (non-transient, skipping retry):`, error);
                return { ok: false, error };
              }

              // Transient — retry if we have budget left
              if (attempt < MQC_MAX_RETRIES) {
                const delay = MQC_BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
                addGameBreadcrumb({
                  category: "quest",
                  message:  `[markQuestCompletion] ${label} network error, retry ${attempt + 1} in ${delay}ms`,
                  data:     { questId, mode, totalXp, attempt: attempt + 1, errorMsg: String((error as any)?.message ?? error) },
                });
                await sleep(delay);
                continue;
              }

              // Out of retries
              console.error(`[markQuestCompletion] ${label} failed after ${MQC_MAX_RETRIES} retries:`, error);
              return { ok: false, error };
            } catch (thrown) {
              // Supabase errors usually arrive as { error } in the destructured
              // response, but a thrown TypeError from the RN fetch polyfill can
              // bypass that and land here. Same retry logic.
              if (!isTransientNetworkError(thrown)) {
                console.error(`[markQuestCompletion] ${label} threw (non-transient, skipping retry):`, thrown);
                return { ok: false, error: thrown };
              }
              if (attempt < MQC_MAX_RETRIES) {
                const delay = MQC_BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
                addGameBreadcrumb({
                  category: "quest",
                  message:  `[markQuestCompletion] ${label} threw network error, retry ${attempt + 1} in ${delay}ms`,
                  data:     { questId, mode, totalXp, attempt: attempt + 1, errorMsg: String((thrown as any)?.message ?? thrown) },
                });
                await sleep(delay);
                continue;
              }
              console.error(`[markQuestCompletion] ${label} threw after ${MQC_MAX_RETRIES} retries:`, thrown);
              return { ok: false, error: thrown };
            }
          }
          // Unreachable but TS wants a return path
          return { ok: false, error: new Error("retry loop exited unexpectedly") };
        };

        // ── Step 1: upsert quest_completions row ───────────────────────────
        const upsertOutcome = await retryOnNetworkError("Upsert", () =>
          supabase
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
            )
            .then((res) => ({ error: res.error }))
        );

        if (!upsertOutcome.ok) {
          // Roll back the optimistic local update so DB stays source of truth.
          // On next loadCompletedQuests() the DB-side absence will reassert.
          if (mode === "normal" && !wasInNormal) {
            set((s) => ({
              completedQuestIds: s.completedQuestIds.filter((id) => id !== questId),
            }));
          } else if (mode === "hard" && !wasInHard) {
            set((s) => ({
              hardCompletedQuestIds: s.hardCompletedQuestIds.filter((id) => id !== questId),
            }));
          }

          addGameBreadcrumb({
            category: "quest",
            message:  "[markQuestCompletion] Final surrender — local state rolled back",
            data:     {
              questId,
              mode,
              totalXp,
              stage:    "upsert",
              errorMsg: String((upsertOutcome.error as any)?.message ?? upsertOutcome.error),
            },
          });
          return;
        }

        // ── Step 2: award_xp RPC ───────────────────────────────────────────
        const xpOutcome = await retryOnNetworkError("award_xp", () =>
          supabase
            .rpc("award_xp", {
              p_child_id: activeChild.id,
              p_xp:       totalXp,
            })
            .then((res) => ({ error: res.error }))
        );

        if (!xpOutcome.ok) {
          // The completion row IS in the DB at this point — leave it. Rolling
          // back the local set would mean the user's quest "uncompletes" on
          // reload but the DB shows it complete. Keep the local set as-is.
          // The XP itself is missing, but loadCompletedQuests() on next start
          // will at least keep the quest looking complete.
          //
          // We still need to call refreshChildFromDB to reconcile total_xp
          // from the server — if the RPC partially succeeded (which can
          // happen with network blips on the response side), the child's
          // total_xp may already be updated server-side.
          addGameBreadcrumb({
            category: "quest",
            message:  "[markQuestCompletion] award_xp surrendered — completion saved but XP unconfirmed",
            data:     {
              questId,
              mode,
              totalXp,
              stage:    "award_xp",
              errorMsg: String((xpOutcome.error as any)?.message ?? xpOutcome.error),
            },
          });
          await get().refreshChildFromDB();
          get().loadCompletedQuests();
          return;
        }

        // ── Both calls succeeded — bump session counter and refresh ────────
        // Bumped BEFORE refreshChildFromDB so a slow refresh can't lose the
        // count to a tab switch / quick child swap.
        get().bumpSessionQuestFinished(totalXp);
        await get().refreshChildFromDB();
        get().loadCompletedQuests();

        get().recordDailyCompletion(questId);
        get().loadSpellBook();
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
        // v6.4: daily quest is anchored to UTC midnight (one global quest
        // rotation for all users worldwide). Use UTC for the cache lookup
        // here. Local todayDate() stays in use for streak (see file header).
        const todayUtc   = todayUtcDate();
        const todayLocal = todayDate();

        // 1. Fast path: today's daily quest already set in the DB
        const { data: existing } = await supabase
          .from("daily_quests")
          .select("quest_id")
          .eq("quest_date", todayUtc)
          .maybeSingle();

        let questId: string | null = existing?.quest_id ?? null;

        // 2. Not yet provisioned — call ensure-daily-quest to auto-generate
        // (or fall back to round-robin if kill-switch is off). The Edge
        // Function is idempotent on quest_date so concurrent callers converge.
        if (!questId) {
          try {
            const { data: result, error } = await supabase.functions.invoke<{
              quest_id?: string;
            }>("ensure-daily-quest");
            if (!error && result?.quest_id) {
              questId = result.quest_id;
            }
          } catch {
            // Edge Function unreachable — fall through to local round-robin
            // below. Rare; only fires when network or function is down.
          }
        }

        // 3. Last-resort fallback: deterministic round-robin from local cache.
        // Only fires if the DB read AND the Edge Function both failed.
        if (!questId) {
          const { questLibrary } = get();
          const activeQuests = questLibrary.filter((q) => (q as any).is_active !== false);
          if (activeQuests.length > 0) {
            const dayIndex = daysSinceEpoch() % activeQuests.length;
            questId = activeQuests[dayIndex].id;
          }
        }

        set({
          dailyQuest: {
            questId,
            questDate: todayLocal,
            isLoaded:  true,
          },
        });

        // 4. If we just provisioned a new quest, the local questLibrary
        // won't contain it yet — reload so it renders on the map. Fire-and-
        // forget; dailyQuest state is already set.
        if (questId && !existing?.quest_id) {
          void get().loadQuests();
        }
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

        set((state) => ({
          achievements:      [...state.achievements, ...newRecords],
          newlyEarnedBadges: [...state.newlyEarnedBadges, ...newBadges],
        }));

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
        activeQuest:           state.activeQuest,
        wordTomeCache:         state.wordTomeCache,
        completedQuestIds:     state.completedQuestIds,
        hardCompletedQuestIds: state.hardCompletedQuestIds,
        streak:                state.streak,
        isDailyQuestComplete:  state.isDailyQuestComplete,
        spellBook:             state.spellBook,
        hasSeenOnboarding:     state.hasSeenOnboarding,
        // v6.0 — persist parent tier so cold-start QuestMap doesn't flash
        // unlocked content for a beat before loadParentProfile() resolves.
        parentSubscriptionTier: state.parentSubscriptionTier,
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

export const selectQuestCompletionMode = (
  state:   GameState,
  questId: string
): "normal" | "hard" | null => {
  if (state.hardCompletedQuestIds.includes(questId))   return "hard";
  if (state.completedQuestIds.includes(questId))        return "normal";
  return null;
};

export const selectHasHardMode = (quest: Quest): boolean =>
  Array.isArray(quest.hard_mode_properties) && quest.hard_mode_properties.length > 0;

/**
 * v6.0 — true if the quest is paid-tier AND the parent is on free.
 * Used by QuestMapScreen to render the locked card variant.
 *
 * Treats null parentSubscriptionTier as 'free' (most restrictive) — better
 * to show a transient lock during cold start than to flash an unlocked
 * paid quest before loadParentProfile() resolves.
 *
 * Treats missing/null quest.min_subscription_tier as 'free' (legacy quest
 * pre-dating the column).
 */
export const selectIsQuestLocked = (
  quest:      Quest,
  parentTier: GameState["parentSubscriptionTier"],
): boolean => {
  const questNeeds = quest.min_subscription_tier ?? "free";
  if (questNeeds !== "paid") return false;
  return parentTier !== "paid"; // null or 'free' both lock
};

export const selectLevelProgress = (state: GameState): number => {
  const xp    = state.activeChild?.total_xp ?? 0;
  const level = Math.max(1, state.activeChild?.level ?? 1);
  const lo    = Math.pow(level - 1, 2) * 50;
  const hi    = Math.pow(level, 2) * 50;
  const range = hi - lo;
  if (range <= 0) return 1;
  return Math.min(1, Math.max(0, (xp - lo) / range));
};

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
