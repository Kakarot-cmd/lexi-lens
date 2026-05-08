/**
 * supabase/functions/evaluate/evaluateObject.ts
 * Lexi-Lens — supabase/functions/evaluate/evaluateObject.ts
 *
 * v5.2.1 — Per-label resolved-name cache integration
 *   • composeResultFromCachedOnly() now accepts an optional `resolvedName`
 *     argument. When the per-label cache provides a model-corrected name
 *     for the detectedLabel, the caller passes it through; otherwise the
 *     function falls back to detectedLabel as in v5.2.0.
 *   • No change to evaluateObject() itself — it always returns a fresh
 *     model-produced resolvedObjectName, which the caller then writes to
 *     the per-label cache so future full-hits can recover it.
 *
 * v5.2 — Per-property cache integration
 *   • New `previouslyEvaluatedProperties` option lets the caller pass in
 *     property scores already retrieved from the per-property cache.
 *   • Result combination happens inside this function. Returned
 *     EvaluationResult contains the FULL property list (cached + fresh).
 *
 * v5.1 — Model provider abstraction (adapter argument)
 * v4.7 — CHILD_SAFETY_PREFIX
 * v1.6.1 — Issue 1 fix: dead-code OR in xpAwarded
 * v1.6  — Negative phrase + contradiction validation
 * v1.5  — Mastery-aware system prompt
 */

// ─── Imports ──────────────────────────────────────────────────────────────────

import { CHILD_SAFETY_PREFIX } from "../_shared/childSafety.ts";
import { ModelCallError }      from "../_shared/models/types.ts";
import type { ModelAdapter }   from "../_shared/models/types.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PropertyRequirement {
  word:             string;
  definition:       string;
  evaluationHints?: string;
}

export interface PropertyScore {
  word:      string;
  score:     number;
  reasoning: string;
  passes:    boolean;
}

export interface EvaluationResult {
  resolvedObjectName: string;
  properties:         PropertyScore[];
  overallMatch:       boolean;
  childFeedback:      string;
  nudgeHint?:         string | null;
  xpAwarded:          number;
}

// ─── v1.5: Mastery profile types ─────────────────────────────────────────────

export type MasteryTier = "novice" | "developing" | "proficient" | "expert";

export interface MasteryEntry {
  word:        string;
  definition:  string;
  mastery:     number;
  masteryTier: MasteryTier;
  timesUsed:   number;
}

export interface EvaluateObjectOptions {
  detectedLabel:      string;
  confidence:         number;
  frameBase64?:       string | null;
  /**
   * Properties that the model should evaluate this scan.
   *
   * v5.2: when the caller has already pulled some property scores from
   * the per-property cache, requiredProperties contains ONLY the ones
   * that missed cache. Cached scores arrive separately via
   * `previouslyEvaluatedProperties`.
   */
  requiredProperties: PropertyRequirement[];
  childAge:           number;
  failedAttempts?:    number;
  questName?:         string;
  masteryProfile?:    MasteryEntry[];
  /**
   * Words the child has already won in earlier scans this quest.
   * Different from previouslyEvaluatedProperties (which is per-property
   * cache hits from THIS scan). alreadyFoundWords are stripped from
   * evaluation; previouslyEvaluatedProperties are passed through to the
   * final result with their cached scores intact.
   */
  alreadyFoundWords?: string[];
  /**
   * v5.2 — Property scores for the same scan that were retrieved from
   * the per-property cache. Format: full PropertyScore objects whose
   * `word` field matches words NOT in requiredProperties.
   */
  previouslyEvaluatedProperties?: PropertyScore[];
  /**
   * XP FIX — per-quest XP rates from the DB.
   */
  xpRates?: { firstTry: number; secondTry: number; thirdPlus: number };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PROPERTY_PASS_THRESHOLD = 0.7;
const CONTRADICTION_THRESHOLD = 0.7;
const CONTRADICTION_CAP       = 0.55;
const XP_FIRST_TRY            = 40;
const XP_SECOND_TRY           = 25;
const XP_THIRD_PLUS           = 10;
const MAX_TOKENS              = 700;

// ─── v1.6: Negative phrase validation ────────────────────────────────────────

const NEGATIVE_PHRASES: string[] = [
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
  "not flexible", "not rigid", "not fragile", "not durable",
  "not translucent", "not transparent", "not opaque",
  "not smooth", "not rough", "not soft", "not hard",
  "not hollow", "not solid", "not porous",
  "not magnetic", "not conductive", "not insulating",
  "not buoyant", "not absorbent", "not reflective",
  "opposite of", "contrary to", "rather than", "the reverse",
  "instead of", "in contrast", "does the opposite",
  "fails the", "does not meet", "does not satisfy",
  "not a match", "does not match", "no match",
];

const HEDGING_PHRASES: string[] = [
  "might be", "could be", "may be", "possibly",
  "perhaps", "arguably", "debatable", "questionable",
  "it depends", "in some ways", "to some extent",
  "loosely speaking", "loosely defined",
  "if you stretch", "stretch the definition",
  "not typically", "not usually", "not conventionally",
  "in a sense", "technically not", "not strictly",
  "borderline", "marginal", "borderline case",
];

// ─── Property score validator ─────────────────────────────────────────────────

function validatePropertyScore(prop: PropertyScore): PropertyScore {
  const reasoning = prop.reasoning.toLowerCase();

  if (prop.score < PROPERTY_PASS_THRESHOLD) {
    const hardMatch = NEGATIVE_PHRASES.find((phrase) => reasoning.includes(phrase));
    if (hardMatch) {
      return { ...prop, score: 0.0, passes: false };
    }
  }

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

export function applyNegativePhraseValidation(
  properties: PropertyScore[]
): { properties: PropertyScore[]; overallMatch: boolean } {
  const corrected = properties.map(validatePropertyScore);
  const overallMatch = corrected.some((p) => p.passes);
  return { properties: corrected, overallMatch };
}

// ─── Mastery profile formatter ────────────────────────────────────────────────

function formatMasteryProfile(profile: MasteryEntry[]): string {
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
    lines.push(`EXPERT (nearly retired): ${byTier.expert.join(", ")}`);
  if (byTier.proficient.length > 0)
    lines.push(`PROFICIENT (solid understanding): ${byTier.proficient.join(", ")}`);
  if (byTier.developing.length > 0)
    lines.push(`DEVELOPING (building confidence): ${byTier.developing.join(", ")}`);
  if (byTier.novice.length > 0)
    lines.push(`NOVICE (just learning): ${byTier.novice.join(", ")}`);

  return lines.join("\n");
}

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(
  childAge:       number,
  questName?:     string,
  masteryProfile?: MasteryEntry[]
): string {
  const masterySection = masteryProfile && masteryProfile.length > 0
    ? `
CHILD'S VOCABULARY MASTERY PROFILE:
${formatMasteryProfile(masteryProfile)}

HOW TO USE THE MASTERY PROFILE:
- NOVICE words: Use the simplest language in your feedback. Be extra encouraging.
- DEVELOPING words: Normal age-appropriate language. Affirm progress explicitly.
- PROFICIENT words: Use slightly richer vocabulary in your feedback.
- EXPERT words: The child is nearly done with this word. Subtly introduce richer synonyms or related concepts.
- If a quest word is NOVICE tier, your childFeedback MUST use simple vocabulary.
`
    : "";

  return `${CHILD_SAFETY_PREFIX}

You are an encouraging vocabulary coach for a child aged ${childAge}.
${questName ? `Quest: "${questName}"` : ""}
${masterySection}
Your task: evaluate whether the detected object genuinely demonstrates each required vocabulary property.

RULES:
1. Score each property 0.0–1.0. A score >= 0.7 means the property passes.
2. Be honest and precise — do NOT give benefit of the doubt if the match is weak.
3. If the object clearly does NOT have a property, say so directly in your reasoning.
4. Set overallMatch to true if ANY of the listed properties pass.
5. childFeedback must be 1 short sentence appropriate for age ${childAge}.
   Name every property that passed — INCLUDING properties from the "Already evaluated" list if any are shown in the user message. If none passed, give one gentle observation.
6. nudgeHint: only if failedAttempts >= 2. Guide without naming the answer.

CONSISTENCY (critical — do not violate):
- The "properties" array MUST contain one entry per word listed under "Properties to evaluate THIS scan" — no more, no fewer.
- Use each property word with the EXACT spelling and case as listed.
- Do NOT include any word that wasn't listed under "Properties to evaluate THIS scan" (especially not words from "Already won this quest" or "Already evaluated").
- childFeedback may reference words from "Already evaluated" only if they passed there. Never claim a property passed that has passes:false in the JSON.

Respond ONLY with valid JSON — no preamble, no markdown fences:
{
  "resolvedObjectName": "corrected label",
  "properties": [
    { "word": "...", "score": 0.0, "reasoning": "...", "passes": false }
  ],
  "overallMatch": false,
  "childFeedback": "...",
  "nudgeHint": null
}`;
}

// ─── User message builder ─────────────────────────────────────────────────────

function buildUserText(opts: EvaluateObjectOptions): string {
  const propertyList = opts.requiredProperties
    .map(
      (p) =>
        `"${p.word}" — ${p.definition}${
          p.evaluationHints ? ` | Hint: ${p.evaluationHints}` : ""
        }`
    )
    .join("\n");

  const propertyMasteryContext =
    opts.masteryProfile && opts.masteryProfile.length > 0
      ? opts.requiredProperties
          .map((p) => {
            const m = opts.masteryProfile?.find(
              (mp) => mp.word.toLowerCase() === p.word.toLowerCase()
            );
            return m
              ? `  • "${p.word}" mastery tier: ${m.masteryTier} (score: ${m.mastery.toFixed(2)}, used ${m.timesUsed}×)`
              : `  • "${p.word}" mastery tier: novice (new word)`;
          })
          .join("\n")
      : null;

  const alreadyFoundContext =
    opts.alreadyFoundWords && opts.alreadyFoundWords.length > 0
      ? `\nAlready won this quest (do NOT include these in your "properties" array — they are off the table for this scan): ${opts.alreadyFoundWords.join(", ")}\n`
      : "";

  const previouslyEvaluatedContext =
    opts.previouslyEvaluatedProperties && opts.previouslyEvaluatedProperties.length > 0
      ? `\nAlready evaluated for THIS scan (per-property cache hits — do NOT include in your "properties" array, but DO mention any passing ones in childFeedback):\n${
          opts.previouslyEvaluatedProperties
            .map((p) => `  • "${p.word}" → score ${p.score.toFixed(2)}, passes=${p.passes} (reasoning: ${p.reasoning})`)
            .join("\n")
        }\n`
      : "";

  const failedAttempts = opts.failedAttempts ?? 0;

  return `The child's camera detected: "${opts.detectedLabel}" (Vision confidence: ${(
    opts.confidence * 100
  ).toFixed(0)}%).

Properties to evaluate THIS scan (one or more is enough — the quest tracks completion across multiple scans):
${propertyList}
${alreadyFoundContext}${previouslyEvaluatedContext}${
  propertyMasteryContext
    ? `\nMastery context for quest words:\n${propertyMasteryContext}\n`
    : ""
}
Failed attempts so far: ${failedAttempts}

Evaluate whether "${opts.detectedLabel}" satisfies each property listed under "Properties to evaluate THIS scan". Return one entry per such property, using the exact word as written above.
${
  failedAttempts >= 2
    ? "The child has struggled. Include a gentle nudgeHint that guides without naming the object."
    : "Set nudgeHint to null."
}`;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function evaluateObject(
  opts:    EvaluateObjectOptions,
  adapter: ModelAdapter,
): Promise<EvaluationResult> {

  if (opts.requiredProperties.length === 0) {
    throw new Error(
      "evaluateObject called with empty requiredProperties — caller should " +
      "use composeResultFromCachedOnly when all properties hit per-property cache."
    );
  }

  // ── 1. Build prompts ─────────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(
    opts.childAge,
    opts.questName,
    opts.masteryProfile,
  );
  const userText = buildUserText(opts);

  // ── 2. Call the model via adapter ────────────────────────────────────────
  let rawText: string;
  try {
    const result = await adapter.call({
      systemPrompt,
      userText,
      imageBase64: opts.frameBase64 ?? undefined,
      maxTokens:   MAX_TOKENS,
      jsonMode:    true,
    });
    rawText = result.rawText;
  } catch (e) {
    if (e instanceof ModelCallError) {
      throw new Error(`${e.modelId} API error ${e.status ?? ""}: ${e.bodyExcerpt || e.message}`);
    }
    throw e;
  }

  // ── 3. Parse JSON ────────────────────────────────────────────────────────
  let parsed: Omit<EvaluationResult, "xpAwarded">;
  try {
    const clean = rawText.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(clean);
  } catch {
    throw new Error(`Model returned non-JSON: ${rawText.slice(0, 200)}`);
  }

  if ((parsed as Record<string, unknown>).error === "unable_to_evaluate") {
    throw new Error("Frame could not be evaluated safely.");
  }

  // ── 4. Negative-phrase + hedging validation on FRESH properties only ─────
  const { properties: validatedFresh } = applyNegativePhraseValidation(parsed.properties);

  // ── 5. Combine fresh + cached into the final property list ───────────────
  const cached = opts.previouslyEvaluatedProperties ?? [];
  const combinedProperties: PropertyScore[] = [...validatedFresh, ...cached];
  const combinedOverallMatch = combinedProperties.some((p) => p.passes);

  // ── 6. XP calculation against COMBINED count ─────────────────────────────
  const attempts = opts.failedAttempts ?? 0;

  const rates = opts.xpRates ?? {
    firstTry:  XP_FIRST_TRY,
    secondTry: XP_SECOND_TRY,
    thirdPlus: XP_THIRD_PLUS,
  };

  const passingCount = combinedProperties.filter((p) => p.passes).length;
  const multiBonus   = passingCount >= 3 ? 2.0 : passingCount === 2 ? 1.5 : 1.0;

  const baseXp = combinedOverallMatch
    ? attempts === 0 ? rates.firstTry
    : attempts === 1 ? rates.secondTry
    : rates.thirdPlus
    : 0;

  const xpAwarded = combinedOverallMatch
    ? Math.round(baseXp * passingCount * multiBonus)
    : 0;

  return {
    resolvedObjectName: parsed.resolvedObjectName,
    properties:         combinedProperties,
    overallMatch:       combinedOverallMatch,
    childFeedback:      parsed.childFeedback,
    nudgeHint:          parsed.nudgeHint ?? null,
    xpAwarded,
  };
}

// ─── computeXp (exported for unit tests) ─────────────────────────────────────

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

  const passingCount = opts.properties.filter((p) => p.passes).length;
  const multiBonus   = passingCount >= 3 ? 2.0 : passingCount === 2 ? 1.5 : 1.0;

  const baseXp = opts.overallMatch
    ? opts.failedAttempts === 0 ? rates.firstTry
    : opts.failedAttempts === 1 ? rates.secondTry
    : rates.thirdPlus
    : 0;

  return opts.overallMatch
    ? Math.round(baseXp * passingCount * multiBonus)
    : 0;
}

// ─── Templated childFeedback for full per-property cache hits ────────────────

export function buildTemplatedFeedback(passingWords: string[]): string {
  if (passingWords.length === 0) {
    return "Hmm, that doesn't quite match — try a different angle!";
  }
  if (passingWords.length === 1) {
    return `You found something ${passingWords[0]}!`;
  }
  if (passingWords.length === 2) {
    return `Nice! You found something ${passingWords[0]} and ${passingWords[1]}!`;
  }
  const head = passingWords.slice(0, -1).join(", ");
  const tail = passingWords[passingWords.length - 1];
  return `Amazing! You found ${head}, and ${tail}!`;
}

// ─── Compose from cached only (no model call) ────────────────────────────────
//
// v5.2.1: now accepts an optional resolvedName from the per-label cache.
// When supplied (per-label cache hit), the kid sees the model-corrected
// name (e.g. "remote control" instead of ML Kit's "Mobile phone").
// When undefined (per-label cache miss), falls back to detectedLabel.

export function composeResultFromCachedOnly(
  detectedLabel:    string,
  cachedProperties: PropertyScore[],
  failedAttempts:   number,
  xpRates?:         XpRates,
  resolvedName?:    string,
): EvaluationResult {
  const overallMatch = cachedProperties.some((p) => p.passes);
  const passingWords = cachedProperties.filter((p) => p.passes).map((p) => p.word);
  const xpAwarded    = computeXp({
    overallMatch,
    properties:     cachedProperties,
    failedAttempts,
    xpRates,
  });

  return {
    resolvedObjectName: resolvedName && resolvedName.length > 0 ? resolvedName : detectedLabel,
    properties:         cachedProperties,
    overallMatch,
    childFeedback:      buildTemplatedFeedback(passingWords),
    nudgeHint:          null,
    xpAwarded,
  };
}
