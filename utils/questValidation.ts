/**
 * utils/questValidation.ts
 * Lexi-Lens — Post-generation quest word validation
 *
 * PURPOSE
 * ───────
 * The generate-quest Edge Function tells Claude to avoid known words, but
 * that is a prompt-level instruction — not a hard guarantee. This utility
 * adds a client-side safety net that runs immediately after Claude returns
 * a quest, before the parent ever sees the preview screen.
 *
 * It catches three gaps the Edge Function alone cannot close:
 *   1. Claude occasionally ignores the knownWords rule (hallucination edge
 *      cases, especially when the pool is nearly exhausted).
 *   2. hard_mode_properties are NOT checked server-side — only
 *      required_properties are guarded in the Edge Function.
 *   3. "For all children" mode sends an empty knownWords list, so the
 *      server guard is silently bypassed for multi-child households.
 *
 * INTEGRATION
 * ───────────
 * See QuestGeneratorScreen.tsx for usage. Two entry points:
 *
 *   buildKnownWordsSet(childId?, forAllChildren?)
 *     → async: fetches word_tome from Supabase, returns a normalised Set
 *       Works for single-child AND for-all-children modes.
 *
 *   validateQuestWords(quest, knownWordsSet)
 *     → sync: pure function, no I/O. Returns ValidationResult.
 *       Call this right after the Edge Function responds.
 *
 * BEHAVIOUR
 * ─────────
 * Validation is NON-BLOCKING. Flagged words appear as amber warnings in
 * the preview screen — parents can still save (they may intentionally want
 * a review quest) or tap "Regenerate" to get a clean result.
 */

import { supabase } from "../lib/supabase";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FlaggedWord {
  /** The repeated word itself. */
  word:  string;
  /** Whether it appeared in required or hard-mode properties. */
  slot:  "required" | "hard_mode";
  /**
   * Index within its array — used by StepPreview to highlight the
   * correct PropertyEditor row without a full array scan.
   */
  index: number;
}

export interface ValidationResult {
  /** true when zero known words slipped through. */
  isClean:         boolean;
  /** Required properties whose word is in the child's word_tome. */
  flaggedRequired: FlaggedWord[];
  /** Hard-mode properties whose word is in the child's word_tome. */
  flaggedHardMode: FlaggedWord[];
  /** flaggedRequired.length + flaggedHardMode.length */
  totalFlags:      number;
  /**
   * Human-readable one-liner shown in the preview banner.
   * e.g. '2 required words already known: "buoyant", "crystalline".'
   */
  summary:         string;
}

// ─── Step 1: build the known-words set ───────────────────────────────────────

/**
 * Fetches the child's (or all children's) word_tome and returns a
 * lower-cased Set ready for O(1) lookup.
 *
 * @param childId       - The specific child's UUID, or null for forAllChildren
 * @param forAllChildren - When true, unions ALL children under this parent
 *
 * Returns an empty Set (never throws) if Supabase is unreachable — in that
 * case validateQuestWords will report isClean=true and no false positives
 * will block the parent.
 */
export async function buildKnownWordsSet(
  childId:         string | null,
  forAllChildren?: boolean,
): Promise<Set<string>> {
  try {
    let words: string[] = [];

    if (childId && !forAllChildren) {
      // ── Single child ──────────────────────────────────────────────────────
      const { data } = await supabase
        .from("word_tome")
        .select("word")
        .eq("child_id", childId);

      words = (data ?? []).map((r: any) => r.word as string);

    } else {
      // ── All children under this parent ────────────────────────────────────
      // This is the gap: forAllChildren mode previously sent knownWords=[]
      // because there was no single childId to query against.
      const { data: profiles } = await supabase
        .from("child_profiles")
        .select("id");

      if (profiles && profiles.length > 0) {
        const allChildIds = profiles.map((p: any) => p.id as string);

        const { data: tomeRows } = await supabase
          .from("word_tome")
          .select("word")
          .in("child_id", allChildIds);

        // Union across all children — a word known by ANY child is "known".
        words = (tomeRows ?? []).map((r: any) => r.word as string);
      }
    }

    // Normalise: lower-case + trim, deduplicate via Set
    return new Set(words.map(w => w.toLowerCase().trim()));

  } catch {
    // Fail open — return empty set so generation is never falsely blocked.
    return new Set<string>();
  }
}

// ─── Step 2: validate the returned quest ─────────────────────────────────────

/**
 * Pure, synchronous validation. Call immediately after the Edge Function
 * returns a quest. No Supabase calls here — pass the Set from
 * buildKnownWordsSet().
 *
 * Checks:
 *   • required_properties[*].word  against knownWordsSet
 *   • hard_mode_properties[*].word against knownWordsSet  ← not done server-side
 */
export function validateQuestWords(
  quest: {
    required_properties:   Array<{ word: string }>;
    hard_mode_properties?: Array<{ word: string }>;
  },
  knownWordsSet: Set<string>,
): ValidationResult {
  // Nothing to check → report clean so UI shows no warnings.
  if (knownWordsSet.size === 0) {
    return {
      isClean:         true,
      flaggedRequired: [],
      flaggedHardMode: [],
      totalFlags:      0,
      summary:         "",
    };
  }

  const normalize = (w: string) => w.toLowerCase().trim();

  const flaggedRequired: FlaggedWord[] = quest.required_properties
    .map((p, i) => ({ word: p.word, slot: "required" as const, index: i }))
    .filter(f => knownWordsSet.has(normalize(f.word)));

  const flaggedHardMode: FlaggedWord[] = (quest.hard_mode_properties ?? [])
    .map((p, i) => ({ word: p.word, slot: "hard_mode" as const, index: i }))
    .filter(f => knownWordsSet.has(normalize(f.word)));

  const totalFlags = flaggedRequired.length + flaggedHardMode.length;
  const isClean    = totalFlags === 0;

  // Build human-readable summary for the preview banner.
  const summary = buildSummary(flaggedRequired, flaggedHardMode);

  return { isClean, flaggedRequired, flaggedHardMode, totalFlags, summary };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildSummary(
  flaggedRequired: FlaggedWord[],
  flaggedHardMode: FlaggedWord[],
): string {
  if (flaggedRequired.length === 0 && flaggedHardMode.length === 0) return "";

  const parts: string[] = [];

  if (flaggedRequired.length > 0) {
    const label = flaggedRequired.length === 1 ? "word" : "words";
    const list  = flaggedRequired.map(f => `"${f.word}"`).join(", ");
    parts.push(`${flaggedRequired.length} required ${label} already in child's Tome: ${list}`);
  }

  if (flaggedHardMode.length > 0) {
    const label = flaggedHardMode.length === 1 ? "word" : "words";
    const list  = flaggedHardMode.map(f => `"${f.word}"`).join(", ");
    parts.push(`${flaggedHardMode.length} hard-mode ${label} already known: ${list}`);
  }

  return parts.join(". ") + ". Tap Regenerate or edit manually.";
}

/**
 * Convenience: returns the Set of word indices (within required_properties)
 * that are flagged, for O(1) lookup inside the property list render loop.
 */
export function flaggedRequiredIndexSet(result: ValidationResult): Set<number> {
  return new Set(result.flaggedRequired.map(f => f.index));
}

/**
 * Convenience: returns the Set of word indices (within hard_mode_properties)
 * that are flagged.
 */
export function flaggedHardModeIndexSet(result: ValidationResult): Set<number> {
  return new Set(result.flaggedHardMode.map(f => f.index));
}
