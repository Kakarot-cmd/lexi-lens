// supabase/functions/_shared/nounTarget.ts
// ─────────────────────────────────────────────────────────────────────────────
// Unit 3 (property model) — noun × adjective hybrid: category REQUIREMENT
// selection + prompt steering + post-parse enforcement.
//
// A category requirement is NOT a separate column or gate. It is one entry
// inside `required_properties` (and its parallel in `hard_mode_properties`),
// shaped exactly like an adjective property but with `kind:"category"`:
//
//   { "word":"utensil", "kind":"category",
//     "definition":"A tool you eat or cook with.",
//     "examples":["spoon","fork"],
//     "evaluationHints":"any eating or cooking utensil" }
//
// The eval scores it by is-a membership (see evaluate/evaluateObject.ts), and it
// flows through every existing per-property mechanism (component, found-state,
// XP, cache, "found N of M") unchanged. It is independently scannable — the
// multi-object USP is preserved.
//
// Gated by the `noun_target_rate_pct` flag (default 0 = DORMANT): generation is
// a pure no-op until an operator raises it. The category vocabulary always
// comes from the vetted taxonomy `nounCategories` — never model-invented.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { TAXONOMY }      from "./vocabularyTaxonomy.ts";
import { getNumericFlag } from "./featureFlags.ts";

export const NOUN_TARGET_RATE_FLAG = "noun_target_rate_pct";

export interface PickedCategory {
  category:  string;       // the word the quest names + teaches, e.g. "utensil"
  examples:  string[];     // findable members, e.g. ["spoon","fork"]
  escalates: boolean;      // can it step up for hard mode?
  harder?:   string;       // the higher-register category word (e.g. "cutlery")
}

/** A property shape that may carry the category fields. Generation's
 *  QuestProperty and the eval's PropertyRequirement both conform once they
 *  gain `kind?` + `examples?`. */
export interface CategoryAwareProp {
  word:             string;
  definition?:      string;
  evaluationHints?: string;
  kind?:            "adjective" | "category";
  examples?:        string[];
}

/**
 * Reads the rate flag (0–100), rolls once, and on a hit returns a curated
 * category for the band. Never throws — any failure resolves to null
 * (adjective-only quest). Caller picks ONCE per quest (1 category max).
 */
export async function pickCategory(
  supabase: SupabaseClient,
  ageBand:  string,
): Promise<PickedCategory | null> {
  let ratePct = 0;
  try {
    ratePct = await getNumericFlag(supabase, NOUN_TARGET_RATE_FLAG, 0, 0, 100);
  } catch {
    return null;
  }
  if (ratePct <= 0) return null;                    // dormant
  if (Math.random() * 100 >= ratePct) return null;  // didn't roll in this time

  const cats = TAXONOMY[ageBand]?.nounCategories ?? TAXONOMY["7-8"]?.nounCategories;
  if (!cats || cats.length === 0) return null;

  const pick = cats[Math.floor(Math.random() * cats.length)];
  if (!pick?.category) return null;

  return {
    category:  pick.category,
    examples:  pick.examples ?? [],
    escalates: Boolean(pick.escalates),
    harder:    pick.harder,
  };
}

/**
 * Prompt block telling the model to make EXACTLY ONE of its properties a
 * category requirement (with a kid-friendly definition), and to choose the
 * remaining adjectives so a real member of that category can plausibly have
 * them all. Empty string when there is no category (prompt unchanged).
 */
export function categoryPromptBlock(cat: PickedCategory | null): string {
  if (!cat) return "";
  const examples   = cat.examples.join(", ");
  const hardWord   = cat.harder ?? cat.category;
  return `

CATEGORY REQUIREMENT (IMPORTANT — exactly ONE property must be a category):
- Make EXACTLY ONE of the required_properties a CATEGORY requirement: set its "word" to "${cat.category}", add "kind":"category", write a child-friendly "definition" of what a ${cat.category} is${examples ? ` (everyday members: ${examples})` : ""}, and "evaluationHints" describing what counts as a ${cat.category}.
- The PARALLEL entry in hard_mode_properties (same position) must also be a category with "kind":"category" and "word":"${hardWord}".
- The OTHER properties stay adjectives — and choose them so that one real, common ${cat.category} a child could find at home plausibly has ALL of them at once (never ask for an adjective a ${cat.category} essentially never has).
- This category is one of several independently-findable requirements; the child may satisfy it with a different object than the adjectives. Do not force one object to be everything.`;
}

/**
 * Guarantees EXACTLY ONE entry in `props` is a category with the target word +
 * examples. Prefers the entry the model already produced (keeps its
 * definition/hints); if the model didn't comply, converts the last entry.
 * Mutates and returns the same array. `examples` ignored for hard-mode if the
 * matched entry already has its own. Never throws.
 */
export function enforceCategoryProperty<T extends CategoryAwareProp>(
  props:      T[],
  targetWord: string,
  examples:   string[],
): T[] {
  const norm = (s: string) => (s ?? "").trim().toLowerCase();

  if (!Array.isArray(props) || props.length === 0) {
    return [{
      word:            targetWord,
      kind:            "category",
      examples,
      definition:      `A kind of ${targetWord}.`,
      evaluationHints: `Pass if the object is any kind of ${targetWord}.`,
    } as unknown as T];
  }

  const exact   = props.findIndex((p) => norm(p.word) === norm(targetWord));
  const flagged = props.findIndex((p) => p.kind === "category");
  const idx     = exact >= 0 ? exact : flagged;

  if (idx >= 0) {
    props[idx] = {
      ...props[idx],
      word:     targetWord,
      kind:     "category",
      examples: props[idx].examples && props[idx].examples!.length > 0 ? props[idx].examples : examples,
    } as T;
    return props;
  }

  // Model didn't emit a category — convert the last entry server-side.
  const last = props.length - 1;
  const eg   = examples.slice(0, 2).join(" or ");
  props[last] = {
    ...props[last],
    word:            targetWord,
    kind:            "category",
    examples,
    definition:      eg ? `A kind of ${targetWord}, like a ${eg}.` : `A kind of ${targetWord}.`,
    evaluationHints: `Pass if the object is any kind of ${targetWord}.`,
  } as T;
  return props;
}
