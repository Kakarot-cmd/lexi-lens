/**
 * MasteryService.ts
 * Lexi-Lens — Phase 1.5: Proficiency-Based Vocabulary
 *
 * Owns all mastery-related business logic:
 *   • Mastery score math (mirrors the SQL function exactly)
 *   • Retirement detection
 *   • Mastery profile builder (what Claude receives per request)
 *   • Synonym promotion via the retire-word Edge Function
 *
 * This file runs entirely on the client (React Native) and contains
 * NO secrets. All DB writes go through Supabase RPC or Edge Functions.
 *
 * Dependencies: none beyond supabase client + expo-haptics
 */

import { supabase } from "../lib/supabase";

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single word's mastery snapshot — sent to Claude in each evaluate call */
export interface MasteryEntry {
  word:         string;
  definition:   string;
  mastery:      number;   // 0.0–1.0
  masteryTier:  MasteryTier;
  timesUsed:    number;
}

export type MasteryTier = "novice" | "developing" | "proficient" | "expert";

/** Shape returned by the retire-word Edge Function */
export interface SynonymResult {
  synonym:    string;
  definition: string;
}

/** Full result of updateMastery() — used to trigger retirement UI */
export interface MasteryUpdateResult {
  word:           string;
  oldMastery:     number;
  newMastery:     number;
  justRetired:    boolean;  // crossed 0.8 on THIS update
  synonym?:       SynonymResult;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const MASTERY_RETIREMENT_THRESHOLD = 0.80;

/**
 * How many words from the tome to include in each Claude prompt.
 * We cap this to keep the prompt compact — Claude only needs the
 * most relevant context, not the child's entire history.
 */
const MAX_PROFILE_WORDS = 20;

// ─── Pure math (mirrors schema_v1_5.sql exactly) ─────────────────────────────

/**
 * Calculate new mastery score after a scan attempt.
 *
 * Success: exponential approach to 1.0 — prevents "mastered in 2 taps"
 *   new = min(1.0,  old + (1 - old) × 0.20)
 * Failure: gentle decay — one slip shouldn't erase real learning
 *   new = max(0.0,  old - 0.08)
 */
export function calculateNewMastery(current: number, success: boolean): number {
  if (success) {
    return Math.min(1.0, current + (1.0 - current) * 0.2);
  }
  return Math.max(0.0, current - 0.08);
}

/** True if mastery has crossed the retirement threshold */
export function isReadyForRetirement(mastery: number): boolean {
  return mastery >= MASTERY_RETIREMENT_THRESHOLD;
}

/** Map a 0–1 score to a human-readable tier label */
export function masteryTierFrom(score: number): MasteryTier {
  if (score < 0.3) return "novice";
  if (score < 0.6) return "developing";
  if (score < 0.8) return "proficient";
  return "expert";
}

// ─── Profile builder ─────────────────────────────────────────────────────────

/**
 * Build the mastery profile slice that Claude receives with each request.
 *
 * Strategy:
 *   1. Exclude already-retired words (child is done with them).
 *   2. Prioritise words the child is currently working on (lowest mastery first).
 *   3. Cap at MAX_PROFILE_WORDS to keep prompts compact.
 *
 * Claude uses this to:
 *   a) Match feedback vocabulary to the child's actual proficiency level.
 *   b) Introduce synonyms or more complex phrasing for high-mastery words.
 *   c) Give simpler, more encouraging language for novice-tier words.
 */
export function buildMasteryProfile(
  wordTomeCache: Array<{
    word:        string;
    definition:  string;
    mastery_score: number;
    times_used:  number;
    is_retired?: boolean;
  }>
): MasteryEntry[] {
  return wordTomeCache
    .filter((w) => !w.is_retired)
    .sort((a, b) => a.mastery_score - b.mastery_score) // weakest first
    .slice(0, MAX_PROFILE_WORDS)
    .map((w) => ({
      word:        w.word,
      definition:  w.definition,
      mastery:     Math.round(w.mastery_score * 100) / 100,
      masteryTier: masteryTierFrom(w.mastery_score),
      timesUsed:   w.times_used,
    }));
}

// ─── DB update ────────────────────────────────────────────────────────────────

/**
 * Persist a mastery score update via Supabase RPC.
 *
 * Uses the `update_word_mastery` SQL function defined in schema_v1_5.sql,
 * which handles the math server-side and returns the new score.
 * This keeps the client and DB perfectly in sync even if the RPC
 * succeeds but the app crashes before the local state update fires.
 *
 * Returns null on any DB error (caller should fall back to local calculation).
 */
export async function persistMasteryUpdate(
  childId: string,
  word:    string,
  success: boolean
): Promise<number | null> {
  try {
    const { data, error } = await supabase.rpc("update_word_mastery", {
      p_child_id: childId,
      p_word:     word,
      p_success:  success,
    });
    if (error) {
      console.warn("[MasteryService] RPC error:", error.message);
      return null;
    }
    return data as number;
  } catch {
    return null;
  }
}

// ─── Synonym retirement ───────────────────────────────────────────────────────

/**
 * Ask Claude (via the retire-word Edge Function) to suggest a harder synonym
 * for a word the child has mastered.
 *
 * The Edge Function prompt is:
 *   "The child has mastered '{word}' (definition: '{definition}').
 *    Suggest one harder synonym appropriate for a child aged {childAge}.
 *    Return JSON: { synonym: string, definition: string }"
 *
 * Falls back gracefully — if the Edge Function fails, retirement is skipped
 * and tried again on the next scan (mastery stays at its current value).
 */
export async function fetchHarderSynonym(
  word:       string,
  definition: string,
  childAge:   number
): Promise<SynonymResult | null> {
  try {
    const { data, error } = await supabase.functions.invoke<SynonymResult>(
      "retire-word",
      {
        body: { word, definition, childAge },
      }
    );
    if (error || !data) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Retire a word in the DB and promote its harder synonym.
 * Calls the `retire_word_and_promote` SQL function from schema_v1_5.sql.
 */
export async function persistWordRetirement(
  childId:       string,
  word:          string,
  synonym:       string,
  synonymDef:    string
): Promise<void> {
  try {
    await supabase.rpc("retire_word_and_promote", {
      p_child_id:    childId,
      p_word:        word,
      p_synonym:     synonym,
      p_synonym_def: synonymDef,
    });
  } catch (err) {
    console.warn("[MasteryService] Retirement RPC failed:", err);
  }
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Full mastery update pipeline — call this after every scan verdict.
 *
 * 1. Persist new score to DB (server-side math is authoritative).
 * 2. Check if the word just crossed the retirement threshold.
 * 3. If so, fetch a harder synonym from Claude (non-blocking — doesn't delay UI).
 * 4. Persist retirement + synonym promotion to DB.
 * 5. Return a MasteryUpdateResult so the store + UI can react.
 *
 * The function is intentionally non-throwing — all errors are swallowed
 * and the caller gets a graceful result. Mastery is not critical-path;
 * a failed update is retried naturally on the next scan.
 */
export async function updateMastery(opts: {
  childId:       string;
  word:          string;
  definition:    string;
  childAge:      number;
  success:       boolean;
  currentMastery: number;
}): Promise<MasteryUpdateResult> {
  const { childId, word, definition, childAge, success, currentMastery } = opts;

  // Optimistic local calculation (used if RPC fails)
  const optimisticNew = calculateNewMastery(currentMastery, success);

  // Persist to DB — use server's returned value if available
  const serverNew = await persistMasteryUpdate(childId, word, success);
  const newMastery = serverNew ?? optimisticNew;

  const wasAlreadyRetired = isReadyForRetirement(currentMastery);
  const justRetired       = isReadyForRetirement(newMastery) && !wasAlreadyRetired;

  let synonym: SynonymResult | undefined;

  if (justRetired) {
    // Non-blocking: fetch synonym in the background.
    // We await here because the caller (VerdictCard) can show
    // a "Word Mastered!" celebration while we wait (~1 s).
    const result = await fetchHarderSynonym(word, definition, childAge);
    if (result) {
      synonym = result;
      // Fire-and-forget — DB retirement doesn't need to block the UI
      persistWordRetirement(childId, word, result.synonym, result.definition).catch(
        () => { /* swallowed — next scan will retry */ }
      );
    }
  }

  return {
    word,
    oldMastery: currentMastery,
    newMastery,
    justRetired,
    synonym,
  };
}
