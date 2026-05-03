/**
 * gameStoreLogic.ts — pure-logic extract of store/gameStore.ts
 *
 * Extracts:
 *   • Helpers: buildComponents, calcEnemyHp, ageBandOrder, childMinAgeBandOk
 *   • Selectors (rewritten as pure functions taking state)
 *   • Reducer functions extracted from the set() callbacks of each action
 *     (so we can test them without instantiating Zustand)
 *   • getDisplayProperties (age-band merging)
 */

// ─── Types (minimal — only what the pure logic needs) ────────────────────────

export interface PropertyRequirement {
  word:             string;
  definition:       string;
  evaluationHints?: string;
}

export interface ComponentProgress {
  propertyWord: string;
  found:        boolean;
  objectUsed:   string | null;
  xpEarned:     number;
  attemptCount: number;
}

export type QuestTier = "apprentice" | "scholar" | "sage" | "archmage";

export interface Quest {
  id:                     string;
  name:                   string;
  tier:                   QuestTier;
  required_properties:    PropertyRequirement[];
  hard_mode_properties?:  PropertyRequirement[];
  age_band_properties?:   Record<string, PropertyRequirement[]>;
  is_active?:             boolean;
}

export interface ActiveQuest {
  quest:                Quest;
  components:           ComponentProgress[];
  startedAt:            number;
  enemyHp:              number;
  isHardMode:           boolean;
  effectiveProperties:  PropertyRequirement[];
}

export interface ChildSession {
  id:        string;
  total_xp:  number;
  level:     number;
}

export interface StreakData {
  currentStreak:  number;
  longestStreak:  number;
  lastQuestDate:  string | null;
  streakDates:    string[];
  gotMultiplier:  boolean;
}

export interface MinimalState {
  activeChild:        ChildSession | null;
  activeQuest:        ActiveQuest | null;
  questLibrary:       Quest[];
  streak:             StreakData;
  completedQuestIds:  string[];
  hardCompletedQuestIds: string[];
  dailyQuest:         { questId: string | null; questDate: string; isLoaded: boolean };
}

// ─── Helpers (verbatim) ───────────────────────────────────────────────────────

export function buildComponents(properties: PropertyRequirement[]): ComponentProgress[] {
  return properties.map((p) => ({
    propertyWord: p.word,
    found:        false,
    objectUsed:   null,
    xpEarned:     0,
    attemptCount: 0,
  }));
}

export function calcEnemyHp(components: ComponentProgress[]): number {
  if (components.length === 0) return 100;
  const foundCount = components.filter((c) => c.found).length;
  return Math.round(((components.length - foundCount) / components.length) * 100);
}

export function ageBandOrder(band: string): number {
  return ({ "5-6": 0, "7-8": 1, "9-10": 2, "11-12": 3, "13-14": 4 } as Record<string, number>)[band] ?? 99;
}

export function childMinAgeBandOk(childBand: string, questMinBand: string): boolean {
  return ageBandOrder(childBand) >= ageBandOrder(questMinBand);
}

// ─── Selectors (verbatim) ─────────────────────────────────────────────────────

export const selectCurrentComponent = (state: MinimalState): ComponentProgress | null =>
  state.activeQuest?.components.find((c) => !c.found) ?? null;

export const selectCurrentAttempts = (state: MinimalState): number =>
  state.activeQuest?.components.find((c) => !c.found)?.attemptCount ?? 0;

export const selectQuestComplete = (state: MinimalState): boolean =>
  !!state.activeQuest && state.activeQuest.components.every((c) => c.found);

export const selectStreakMultiplier = (state: MinimalState): number =>
  state.streak.gotMultiplier ? 2.0 : 1.0;

export const selectIsPlayingDailyQuest = (state: MinimalState): boolean =>
  !!state.activeQuest &&
  !!state.dailyQuest.questId &&
  state.activeQuest.quest.id === state.dailyQuest.questId;

export const selectQuestCompletionMode = (
  state:   MinimalState,
  questId: string
): "normal" | "hard" | null => {
  if (state.hardCompletedQuestIds.includes(questId))   return "hard";
  if (state.completedQuestIds.includes(questId))       return "normal";
  return null;
};

export const selectHasHardMode = (quest: Quest): boolean =>
  Array.isArray(quest.hard_mode_properties) && quest.hard_mode_properties.length > 0;

export const selectLevelProgress = (state: MinimalState): number => {
  const xp    = state.activeChild?.total_xp ?? 0;
  const level = Math.max(1, state.activeChild?.level ?? 1);
  const lo    = Math.pow(level - 1, 2) * 50;
  const hi    = Math.pow(level, 2) * 50;
  const range = hi - lo;
  if (range <= 0) return 1;
  return Math.min(1, Math.max(0, (xp - lo) / range));
};

// ─── Age-band property merging (verbatim) ─────────────────────────────────────

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

// ─── Reducer extractions (the set() callback bodies) ──────────────────────────

/**
 * recordComponentFoundReducer — verbatim from gameStore.recordComponentFound
 */
export function recordComponentFoundReducer(
  state: { activeQuest: ActiveQuest | null },
  opts: { propertyWord: string; objectUsed: string; xpAwarded: number; attemptCount: number }
): { activeQuest: ActiveQuest | null } {
  if (!state.activeQuest) return state;

  const components = state.activeQuest.components.map((c) =>
    c.propertyWord === opts.propertyWord
      ? { ...c, found: true, objectUsed: opts.objectUsed, xpEarned: opts.xpAwarded, attemptCount: opts.attemptCount }
      : c
  );

  const enemyHp = calcEnemyHp(components);

  return {
    activeQuest: { ...state.activeQuest, components, enemyHp },
  };
}

/**
 * recordComponentsFoundReducer — verbatim from gameStore.recordComponentsFound
 * The atomic batch fix that prevents the multi-property race condition.
 */
export function recordComponentsFoundReducer(
  state:   { activeQuest: ActiveQuest | null },
  updates: Array<{ propertyWord: string; objectUsed: string; xpAwarded: number; attemptCount: number }>
): { activeQuest: ActiveQuest | null } {
  if (!state.activeQuest || updates.length === 0) return state;

  const updateMap = new Map(updates.map((u) => [u.propertyWord, u]));

  const components = state.activeQuest.components.map((c) => {
    const update = updateMap.get(c.propertyWord);
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
}

/**
 * recordMissedScanReducer — verbatim from gameStore.recordMissedScan
 */
export function recordMissedScanReducer(
  state:        { activeQuest: ActiveQuest | null },
  propertyWord: string
): { activeQuest: ActiveQuest | null } {
  if (!state.activeQuest) return state;
  const components = state.activeQuest.components.map((c) =>
    c.propertyWord === propertyWord
      ? { ...c, attemptCount: c.attemptCount + 1 }
      : c
  );
  return { activeQuest: { ...state.activeQuest, components } };
}
