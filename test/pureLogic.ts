/**
 * pureLogic.ts — verbatim extract of the pure-logic portions of
 * supabase/functions/evaluate/evaluateObject.ts
 *
 * Copied as-is to bind tests to production behaviour. If evaluateObject.ts
 * changes, mirror the change here.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PropertyScore {
  word:      string;
  score:     number;
  reasoning: string;
  passes:    boolean;
}

export type MasteryTier = "novice" | "developing" | "proficient" | "expert";

export interface MasteryEntry {
  word:        string;
  definition:  string;
  mastery:     number;
  masteryTier: MasteryTier;
  timesUsed:   number;
}

// ─── Constants (verbatim) ─────────────────────────────────────────────────────

export const PROPERTY_PASS_THRESHOLD = 0.7;
export const CONTRADICTION_THRESHOLD = 0.7;
export const CONTRADICTION_CAP       = 0.55;
export const XP_FIRST_TRY            = 40;
export const XP_SECOND_TRY           = 25;
export const XP_THIRD_PLUS           = 10;

// ─── NEGATIVE_PHRASES (verbatim) ──────────────────────────────────────────────

export const NEGATIVE_PHRASES: string[] = [
  // Direct negations
  "does not", "doesn't", "do not", "don't",
  "is not", "isn't", "are not", "aren't",
  "will not", "won't", "cannot", "can't",
  "would not", "wouldn't", "could not", "couldn't",
  "should not", "shouldn't",
  "has no", "have no", "had no",
  "no evidence", "not evident", "not present",
  "not applicable", "not qualify", "not qualif",
  "fails to", "fail to", "failed to",
  "lacks", "lack ", "lacking",

  // Property mismatch signals
  "does not apply", "does not match", "does not meet",
  "does not satisfy", "does not demonstrate",
  "not translucent", "not transparent", "not opaque",
  "not fragile", "not rigid", "not flexible", "not pliable",
  "not heavy", "not light", "not smooth", "not rough",
  "not soft", "not hard", "not wet", "not dry",
  "not magnetic", "not conductive", "not absorbent",
  "not hollow", "not solid", "not dense", "not porous",
  "opposite of", "contrary to", "unlike",
  "incorrect", "inaccurate", "wrong property",

  // Hedged contradiction phrases
  "rather than", "instead of", "more of a",
  "does the opposite", "the reverse",
  "this object is actually", "actually does not",
  "misleading", "incorrect match",
  "not the right", "wrong kind of",

  // Soft but definitive mismatches
  "would not qualify", "should not pass", "should not qualify",
  "technically does not", "strictly does not",
  "by definition does not",
];

// ─── HEDGING_PHRASES (verbatim) ───────────────────────────────────────────────

export const HEDGING_PHRASES: string[] = [
  "not typically", "not usually", "not generally",
  "not necessarily", "not always", "not inherently",
  "not particularly", "not especially", "not notably",
  "questionable", "debatable", "arguable",
  "borderline", "marginal", "barely",
  "stretch", "pushing it", "loose interpretation",
  "unconventional", "unusual interpretation",
  "depends on", "subjective",
];

// ─── formatMasteryProfile (verbatim) ──────────────────────────────────────────

export function formatMasteryProfile(profile: MasteryEntry[]): string {
  if (!profile || profile.length === 0) return "No vocabulary history yet.";

  const byTier: Record<MasteryTier, string[]> = {
    novice:     [],
    developing: [],
    proficient: [],
    expert:     [],
  };

  for (const entry of profile) {
    byTier[entry.masteryTier].push(entry.word);
  }

  const lines: string[] = [];
  if (byTier.expert.length > 0)
    lines.push(`EXPERT (mastered, nearly retired): ${byTier.expert.join(", ")}`);
  if (byTier.proficient.length > 0)
    lines.push(`PROFICIENT (solid understanding): ${byTier.proficient.join(", ")}`);
  if (byTier.developing.length > 0)
    lines.push(`DEVELOPING (building confidence): ${byTier.developing.join(", ")}`);
  if (byTier.novice.length > 0)
    lines.push(`NOVICE (just learning): ${byTier.novice.join(", ")}`);

  return lines.join("\n");
}

// ─── validatePropertyScore (verbatim) ─────────────────────────────────────────

export function validatePropertyScore(prop: PropertyScore): PropertyScore {
  const reasoning = prop.reasoning.toLowerCase();

  // Negative phrase override — only when Claude's score is BELOW threshold.
  // Trust Claude when score >= 0.7.
  if (prop.score < PROPERTY_PASS_THRESHOLD) {
    const hardMatch = NEGATIVE_PHRASES.find((phrase) => reasoning.includes(phrase));
    if (hardMatch) {
      return {
        ...prop,
        score:  0.0,
        passes: false,
      };
    }
  }

  // Hedging cap — applies when Claude scores confidently but hedges in language.
  if (prop.score >= CONTRADICTION_THRESHOLD) {
    const hedgeMatch = HEDGING_PHRASES.find((phrase) => reasoning.includes(phrase));
    if (hedgeMatch) {
      const cappedScore = Math.min(prop.score, CONTRADICTION_CAP);
      return {
        ...prop,
        score:  cappedScore,
        passes: cappedScore >= PROPERTY_PASS_THRESHOLD,
      };
    }
  }

  return prop;
}

// ─── applyNegativePhraseValidation (verbatim) ─────────────────────────────────

export function applyNegativePhraseValidation(
  properties: PropertyScore[]
): { properties: PropertyScore[]; overallMatch: boolean } {
  const corrected    = properties.map(validatePropertyScore);
  const overallMatch = corrected.some((p) => p.passes); // ANY property passes
  return { properties: corrected, overallMatch };
}

// ─── computeXp (extracted from evaluateObject for testability) ────────────────
//
// Mirrors the inline math in evaluateObject() exactly:
//   baseXp = overallMatch ? rates[attempt] : 0
//   passingCount = properties.filter(p => p.passes).length
//   multiBonus  = passingCount >= 3 ? 2.0 : passingCount === 2 ? 1.5 : 1.0
//   xpAwarded   = (overallMatch || passingCount > 0)
//                  ? Math.round(baseXp * passingCount * multiBonus)
//                  : 0

export interface XpRates { firstTry: number; secondTry: number; thirdPlus: number; }

export function computeXp(opts: {
  overallMatch:   boolean;
  properties:     PropertyScore[];
  failedAttempts: number;
  xpRates?:       XpRates;
}): number {
  const rates = opts.xpRates ?? {
    firstTry:  XP_FIRST_TRY,
    secondTry: XP_SECOND_TRY,
    thirdPlus: XP_THIRD_PLUS,
  };

  const attempts = opts.failedAttempts;
  const baseXp = opts.overallMatch
    ? attempts === 0 ? rates.firstTry
    : attempts === 1 ? rates.secondTry
    : rates.thirdPlus
    : 0;

  const passingCount = opts.properties.filter((p) => p.passes).length;
  const multiBonus   = passingCount >= 3 ? 2.0 : passingCount === 2 ? 1.5 : 1.0;
  const xpAwarded    = opts.overallMatch || passingCount > 0
    ? Math.round(baseXp * passingCount * multiBonus)
    : 0;

  return xpAwarded;
}
