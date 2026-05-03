/**
 * evaluateObject.ts
 * Lexi-Lens — supabase/functions/evaluate/evaluateObject.ts
 *
 * v1.6.1 — Issue 1 fix: dead-code OR in xpAwarded
 * ─────────────────────────────────────────────────────
 * Dead code: xpAwarded used `overallMatch || passingCount > 0`
 * With some() semantics (ANY property passing → overallMatch=true),
 * the `|| passingCount > 0` branch is structurally unreachable:
 *   passingCount>0 → some() → overallMatch=true → first branch always fires.
 * When overallMatch=false (nothing passed), baseXp=0, so the OR branch
 * computed 0×passingCount×multiBonus=0 regardless — dead code.
 *
 * Fix (option A — clarity, zero behavior change):
 *   Remove the dead OR. overallMatch already encodes the gate.
 *   some() is preserved — it was correctly committed in April to allow
 *   multi-property quests where each scan targets a subset of properties.
 *
 * v1.6: Negative phrase + contradiction validation
 * v1.5: Mastery-aware Claude prompt
 */

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
  nudgeHint?:         string;
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

interface EvaluateObjectOptions {
  detectedLabel:      string;
  confidence:         number;
  frameBase64?:       string | null;
  requiredProperties: PropertyRequirement[];
  childAge:           number;
  failedAttempts?:    number;
  questName?:         string;
  masteryProfile?:    MasteryEntry[];
  /**
   * Words the child has already won in earlier scans this quest.
   * Sent so Claude can acknowledge progress in feedback without
   * re-evaluating them, AND so it doesn't claim a property "passes"
   * for one that's no longer in the requiredProperties list.
   */
  alreadyFoundWords?: string[];
  /**
   * XP FIX — per-quest XP rates from the DB (xp_reward_first_try / xp_reward_retry).
   * When supplied the Edge Function uses these instead of the hardcoded constants so
   * the value shown on the quest card matches what actually gets awarded.
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
const MODEL                   = "claude-haiku-4-5-20251001";
const MAX_TOKENS               = 700;
const ANTHROPIC_API_URL        = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION        = "2023-06-01";

// ─── v1.6: Negative phrase validation ────────────────────────────────────────

const NEGATIVE_PHRASES: string[] = [
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
  // Property-specific mismatches
  "not flexible", "not rigid", "not fragile", "not durable",
  "not translucent", "not transparent", "not opaque",
  "not smooth", "not rough", "not soft", "not hard",
  "not hollow", "not solid", "not porous",
  "not magnetic", "not conductive", "not insulating",
  "not buoyant", "not absorbent", "not reflective",
  // Semantic contradiction markers
  "opposite of", "contrary to", "rather than", "the reverse",
  "instead of", "in contrast", "does the opposite",
  "fails the", "does not meet", "does not satisfy",
  "not a match", "does not match", "no match",
];

const HEDGING_PHRASES: string[] = [
  // Epistemic hedges that weaken a confident score
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

  // Hard rejection — clear negative language forces score to 0 regardless of
  // what Claude's numeric score says (the "resonant for fabric" bug class).
  // Only applies when score is below pass threshold — trust Claude when score >= 0.7.
  if (prop.score < PROPERTY_PASS_THRESHOLD) {
    const hardMatch = NEGATIVE_PHRASES.find((phrase) => reasoning.includes(phrase));
    if (hardMatch) {
      return { ...prop, score: 0.0, passes: false };
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

// ─── applyNegativePhraseValidation ───────────────────────────────────────────

export function applyNegativePhraseValidation(
  properties: PropertyScore[]
): { properties: PropertyScore[]; overallMatch: boolean } {
  const corrected = properties.map(validatePropertyScore);

  // FIX v1.6.1: was `corrected.some(p => p.passes)` which made overallMatch=true
  // whenever ANY property passed — causing the quest XP gate to fire on partial
  // scans and making the `|| passingCount > 0` in xpAwarded unreachable dead code.
  // Correct semantics: ALL required properties must pass for the quest to count.
  // some() — not every(). Each scan evaluates only PENDING properties.
  // A property passing in one scan is a genuine win; the quest tracks
  // cumulative component.found flags, not overallMatch across all scans.
  // Using every() here would require finding all remaining properties
  // simultaneously in one frame, which is nearly impossible.
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
  Celebrate even partial understanding. Keep sentences short.
- DEVELOPING words: Normal age-appropriate language. Affirm progress explicitly.
- PROFICIENT words: Use slightly richer vocabulary in your feedback.
  Reference other words the child knows to build connections.
- EXPERT words: The child is nearly done with this word. In your feedback, subtly
  introduce richer synonyms or related concepts to prepare them for the next level.
- If a quest word is NOVICE tier, your childFeedback MUST use simple vocabulary.
`
    : "";

  return `You are an encouraging vocabulary coach for a child aged ${childAge}.
${questName ? `Quest: "${questName}"` : ""}
${masterySection}
Your task: evaluate whether the detected object genuinely demonstrates each required vocabulary property.

RULES:
1. Score each property 0.0–1.0. A score >= 0.7 means the property passes.
2. Be honest and precise — do NOT give benefit of the doubt if the match is weak.
3. If the object clearly does NOT have a property, say so directly in your reasoning.
   Do not soften rejections with hedging language and a high score.
4. Set overallMatch to true if ANY of the listed properties pass.
   (The quest tracks completion across multiple scans — each scan only
   evaluates the properties still pending. One passing property is a win.)
5. childFeedback must be 1 short sentence appropriate for age ${childAge}.
   Name every property that passed. If none passed, give one gentle observation.
6. nudgeHint: only if failedAttempts >= 2. Guide without naming the answer.

CONSISTENCY (critical — do not violate):
- The "properties" array MUST contain one entry per word listed in the user message.
- Use each property word with the EXACT spelling and case as listed — no capitalisation, pluralisation, or rewording.
- Do NOT include any word that wasn't listed (especially not words from "Already won this quest").
- childFeedback may ONLY reference property words that have passes:true in the JSON. Never claim a property passed in feedback while marking it passes:false in the JSON, or vice versa.

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

type TextBlock  = { type: "text";  text: string };
type ImageBlock = { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } };

function buildUserMessage(
  opts: EvaluateObjectOptions
): Array<TextBlock | ImageBlock> {
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

  // FIX (chip-stuck-grey): include already-found words so Claude doesn't
  // pretend they're being re-evaluated, AND so feedback can naturally
  // celebrate cumulative progress without referencing words off the list.
  const alreadyFoundContext =
    opts.alreadyFoundWords && opts.alreadyFoundWords.length > 0
      ? `\nAlready won this quest (do NOT include these in your "properties" array — they are off the table for this scan): ${opts.alreadyFoundWords.join(", ")}\n`
      : "";

  const textBlock: TextBlock = {
    type: "text",
    text: `The child's camera detected: "${opts.detectedLabel}" (Vision confidence: ${(
      opts.confidence * 100
    ).toFixed(0)}%).

These are the properties to evaluate for THIS scan (one or more is enough — the quest tracks completion across multiple scans):
${propertyList}
${alreadyFoundContext}${
  propertyMasteryContext
    ? `\nMastery context for quest words:\n${propertyMasteryContext}\n`
    : ""
}
Failed attempts so far: ${opts.failedAttempts ?? 0}

Evaluate whether "${opts.detectedLabel}" satisfies each of the listed properties. Return one entry per listed property, using the exact word as written above.
${
  opts.failedAttempts && opts.failedAttempts >= 2
    ? "The child has struggled. Include a gentle nudgeHint that guides without naming the object."
    : "Set nudgeHint to null."
}`,
  };

  if (opts.frameBase64) {
    const imageBlock: ImageBlock = {
      type:   "image",
      source: {
        type:       "base64",
        media_type: "image/jpeg",
        data:       opts.frameBase64,
      },
    };
    return [imageBlock, textBlock];
  }

  return [textBlock];
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function evaluateObject(
  opts: EvaluateObjectOptions
): Promise<EvaluationResult> {

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set in Edge Function environment");

  const response = await fetch(ANTHROPIC_API_URL, {
    method:  "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model:    MODEL,
      max_tokens: MAX_TOKENS,
      system:   buildSystemPrompt(opts.childAge, opts.questName, opts.masteryProfile),
      messages: [
        {
          role:    "user",
          content: buildUserMessage(opts),
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "(unreadable)");
    throw new Error(`Anthropic API error ${response.status}: ${errText}`);
  }

  const apiResponse = await response.json() as {
    content: Array<{ type: string; text?: string }>;
  };

  const rawText = apiResponse.content
    .filter((b) => b.type === "text")
    .map((b)   => b.text ?? "")
    .join("");

  let parsed: Omit<EvaluationResult, "xpAwarded">;
  try {
    const clean = rawText.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(clean);
  } catch {
    throw new Error(`Claude returned non-JSON: ${rawText.slice(0, 200)}`);
  }

  if ((parsed as Record<string, unknown>).error === "unable_to_evaluate") {
    throw new Error("Frame could not be evaluated safely.");
  }

  // v1.6: Apply negative phrase + contradiction validation BEFORE computing XP
  const { properties: validatedProperties, overallMatch: validatedMatch } =
    applyNegativePhraseValidation(parsed.properties);

  const correctedResult = {
    ...parsed,
    properties:   validatedProperties,
    overallMatch: validatedMatch,
  };

  const attempts = opts.failedAttempts ?? 0;

  // Per-quest XP rates — fall back to module constants when not provided
  const rates = opts.xpRates ?? {
    firstTry:  XP_FIRST_TRY,
    secondTry: XP_SECOND_TRY,
    thirdPlus: XP_THIRD_PLUS,
  };

  // ── XP v1.6.1: dead-code removal ────────────────────────────────────────────
  // Old code: xpAwarded = (overallMatch || passingCount > 0) ? ...
  // With some() semantics, passingCount>0 → overallMatch=true, so
  // the OR branch was structurally unreachable. When overallMatch=false
  // (nothing passed), baseXp=0, making the OR also compute 0. Dead either way.
  // Removed the OR — overallMatch is the sole, readable gate.
  // ─────────────────────────────────────────────────────────────────────────────

  const passingCount = correctedResult.properties.filter((p) => p.passes).length;
  const multiBonus   = passingCount >= 3 ? 2.0 : passingCount === 2 ? 1.5 : 1.0;

  const baseXp = correctedResult.overallMatch
    ? attempts === 0 ? rates.firstTry
    : attempts === 1 ? rates.secondTry
    : rates.thirdPlus
    : 0;

  // Dead-code fix (Issue 1): with some() above, overallMatch=true whenever
  // passingCount>0, so the old `|| passingCount > 0` OR was never reached.
  // Removed for clarity — overallMatch already encodes the gate.
  const xpAwarded = correctedResult.overallMatch
    ? Math.round(baseXp * passingCount * multiBonus)
    : 0;

  return { ...correctedResult, xpAwarded };
}

// ─── computeXp (exported for unit tests) ─────────────────────────────────────
//
// Mirrors the inline math in evaluateObject() exactly — keep in sync.

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
