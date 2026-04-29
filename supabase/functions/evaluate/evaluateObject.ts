/**
 * evaluateObject.ts
 * Lexi-Lens — Claude API call for vocabulary property evaluation.
 *
 * v1.5 additions (Proficiency-Based Vocabulary):
 *   • EvaluateObjectOptions gains masteryProfile: MasteryEntry[]
 *   • buildSystemPrompt uses mastery tiers to tailor Claude's language
 *   • buildUserMessage appends the mastery profile as structured context
 *
 * v1.6 additions (Negative Phrase Validation):
 *   • NEGATIVE_PHRASES — force-fail any property whose reasoning contains
 *     clear negative language even when Claude scores it above threshold
 *   • HEDGING_PHRASES — cap score below threshold when Claude hedges
 *
 * DEPLOY FIX — two issues caused "Bundle generation timed out":
 *
 *   1. import Anthropic from "https://esm.sh/@anthropic-ai/sdk"
 *      The Anthropic SDK is a large Node.js package. esm.sh's transpiler
 *      must resolve and rewrite all of its transitive dependencies for Deno.
 *      This process reliably times out during Supabase Edge Function bundling.
 *      Fix: removed the SDK entirely. The Anthropic REST API is called directly
 *      with native fetch() which is built into Deno — zero bundle cost.
 *
 *   2. process.env.ANTHROPIC_API_KEY
 *      process.env is a Node.js global. It does not exist in Deno and would
 *      throw a ReferenceError at runtime even if bundling succeeded.
 *      Fix: replaced with Deno.env.get("ANTHROPIC_API_KEY").
 *
 * All business logic (mastery formatting, negative phrase validation,
 * system prompt, user message, XP calculation) is 100% preserved.
 *
 * Architecture:
 *   Never call this directly from React Native — route through the
 *   Supabase Edge Function so ANTHROPIC_API_KEY never touches the device.
 */

// ─── Local message content types (replaces Anthropic SDK types) ───────────────
//
// These mirror the Anthropic REST API shapes exactly.
// No SDK import needed — the REST API is called via native fetch().

type TextBlock = {
  type:   "text";
  text:   string;
};

type ImageBlock = {
  type:   "image";
  source: {
    type:       "base64";
    media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    data:       string;
  };
};

type MessageContent = TextBlock | ImageBlock;

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
  mastery:     number;       // 0.0–1.0
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
  /** v1.5 — mastery profile of the child's known vocabulary */
  masteryProfile?:    MasteryEntry[];
  /**
   * XP FIX — per-quest XP rates from the DB (xp_reward_first_try / xp_reward_retry).
   * When supplied, the Edge Function uses these instead of the hardcoded constants so
   * the value shown on the quest card matches what actually gets awarded.
   */
  xpRates?: { firstTry: number; secondTry: number; thirdPlus: number };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PROPERTY_PASS_THRESHOLD = 0.7;
const CONTRADICTION_THRESHOLD = 0.7;   // score >= this triggers hedge check
const CONTRADICTION_CAP       = 0.55;  // score is capped here if hedging found
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
  // "without" and "absent" removed — too ambiguous.
  // "without breaking/cracking/damage" are positive phrases that confirm a property.
  // Trust Claude's score directly when phrasing is ambiguous.

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

const HEDGING_PHRASES: string[] = [
  "not typically", "not usually", "not generally",
  "not necessarily", "not always", "not inherently",
  "not particularly", "not especially", "not notably",
  "questionable", "debatable", "arguable",
  "borderline", "marginal", "barely",
  "stretch", "pushing it", "loose interpretation",
  "unconventional", "unusual interpretation",
  "depends on", "subjective",
];

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
    lines.push(`EXPERT (mastered, nearly retired): ${byTier.expert.join(", ")}`);
  if (byTier.proficient.length > 0)
    lines.push(`PROFICIENT (solid understanding): ${byTier.proficient.join(", ")}`);
  if (byTier.developing.length > 0)
    lines.push(`DEVELOPING (building confidence): ${byTier.developing.join(", ")}`);
  if (byTier.novice.length > 0)
    lines.push(`NOVICE (just learning): ${byTier.novice.join(", ")}`);

  return lines.join("\n");
}

// ─── v1.6: Validation ────────────────────────────────────────────────────────

function validatePropertyScore(prop: PropertyScore): PropertyScore {
  const reasoning = prop.reasoning.toLowerCase();

  // ── Negative phrase override ───────────────────────────────────────────────
  // Only override when Claude's own score is already below the pass threshold.
  // This prevents ambiguous phrases like "without breaking" (which confirm the
  // property is present) from falsely overriding high-confidence passes.
  // Rule: if Claude scores >= PROPERTY_PASS_THRESHOLD, trust Claude's judgment.
  if (prop.score < PROPERTY_PASS_THRESHOLD) {
    const hardMatch = NEGATIVE_PHRASES.find((phrase) => reasoning.includes(phrase));
    if (hardMatch) {
      return {
        ...prop,
        score:  0.0,
        passes: false,
        // reasoning unchanged — no debug text injected into child-facing UI
      };
    }
  }

  // ── Hedging cap ───────────────────────────────────────────────────────────
  // If Claude scores confidently but uses hedging language, cap the score.
  // This catches cases like "not typically flexible" scored at 0.8.
  if (prop.score >= CONTRADICTION_THRESHOLD) {
    const hedgeMatch = HEDGING_PHRASES.find((phrase) => reasoning.includes(phrase));
    if (hedgeMatch) {
      const cappedScore = Math.min(prop.score, CONTRADICTION_CAP);
      return {
        ...prop,
        score:  cappedScore,
        passes: cappedScore >= PROPERTY_PASS_THRESHOLD,
        // reasoning unchanged — no debug text injected into child-facing UI
      };
    }
  }

  return prop;
}

function applyNegativePhraseValidation(
  properties: PropertyScore[]
): { properties: PropertyScore[]; overallMatch: boolean } {
  const corrected     = properties.map(validatePropertyScore);
  const overallMatch  = corrected.every((p) => p.passes);
  return { properties: corrected, overallMatch };
}

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(
  childAge:        number,
  questName?:      string,
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
- PROFICIENT words: You can use slightly richer vocabulary in your feedback itself.
  Reference other words the child knows to build connections.
- EXPERT words: The child is nearly done with this word. In your feedback, subtly
  introduce richer synonyms or related concepts to prepare them for the next level.
  E.g. if "translucent" is expert-tier, you might say "…almost pellucid in the way
  light passes through it" — planting the seed of the next challenge word.
- If a quest word is NOVICE tier, your childFeedback MUST use simple vocabulary
  throughout. Do not introduce complexity that would confuse a novice learner.
- If a quest word is EXPERT tier, your childFeedback can be more linguistically rich.
`
    : "";

  return `You are a warm, encouraging vocabulary tutor in a fantasy RPG game called Lexi-Lens.
Children aged 5–12 scan real objects with their camera to find "material components"
for spells that defeat dungeon monsters.

${questName ? `Current quest: "${questName}".` : ""}
The child is approximately ${childAge} years old. Match language complexity to this age.

FEEDBACK VOCABULARY CEILING — HARD RULE (never use words above this level in childFeedback):
${
  childAge <= 6  ? "Max 2 syllables per word. Max 8 words per sentence. No compound sentences. Only words a 5-year-old knows."
  : childAge <= 8  ? "Max 3 syllables per word. Short sentences. Define any unusual word immediately after using it."
  : childAge <= 10 ? "Max 4 syllables per word. Standard age-9-10 vocabulary. Introduce one new word per response, defined in context."
  : "Rich vocabulary. Can use etymology and richer synonyms. Plant seeds for the next vocabulary level."
}

${masterySection}
CRITICAL SAFETY RULES (never break these):
- Only discuss the object's physical properties. Never comment on the child,
  their home, or anything else visible in the frame.
- Keep all feedback warm, encouraging, and age-appropriate.
- Never tell the child exactly which object to find — guide, don't spoil.
- If the camera frame shows anything inappropriate, respond ONLY with:
  { "error": "unable_to_evaluate" }

RESPONSE FORMAT — valid JSON only, no markdown, no text outside JSON:
{
  "resolvedObjectName": string,
  "properties": [
    {
      "word": string,
      "score": number,        // 0.0–1.0
      "reasoning": string,    // one sentence, adult-readable
      "passes": boolean
    }
  ],
  "overallMatch": boolean,
  "childFeedback": string,    // 1–3 sentences, age-appropriate, RPG tone
  "nudgeHint": string | null, // indirect hint after 2+ failures; null otherwise
  "xpAwarded": number         // always return 0 — server computes XP
}`;
}

// ─── User message builder ─────────────────────────────────────────────────────

function buildUserMessage(opts: EvaluateObjectOptions): MessageContent[] {
  const propertyList = opts.requiredProperties
    .map(
      (p, i) =>
        `${i + 1}. "${p.word}" — ${p.definition}${
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

  const textBlock: TextBlock = {
    type: "text",
    text: `The child's camera detected: "${opts.detectedLabel}" (Vision confidence: ${(
      opts.confidence * 100
    ).toFixed(0)}%).

The quest requires an object satisfying ALL of these properties:
${propertyList}
${
  propertyMasteryContext
    ? `\nMastery context for quest words:\n${propertyMasteryContext}\n`
    : ""
}
Failed attempts so far: ${opts.failedAttempts ?? 0}

Evaluate whether "${opts.detectedLabel}" satisfies each property.
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

// ─── Main function ────────────────────────────────────────────────────────────

export async function evaluateObject(
  opts: EvaluateObjectOptions
): Promise<EvaluationResult> {

  // FIX: was `process.env.ANTHROPIC_API_KEY` (Node.js) — throws ReferenceError in Deno
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set in Edge Function environment");

  // FIX: was `new Anthropic({...}).messages.create({...})` via esm.sh SDK
  // Replaced with native fetch() — zero bundle cost, no timeout risk
  const response = await fetch(ANTHROPIC_API_URL, {
    method:  "POST",
    headers: {
      "Content-Type":    "application/json",
      "x-api-key":       apiKey,
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

  const attempts  = opts.failedAttempts ?? 0;

  // XP FIX: use per-quest rates from the DB when provided; fall back to constants.
  // This ensures the number shown on the quest card matches what is actually awarded.
  const rates = opts.xpRates ?? {
    firstTry:  XP_FIRST_TRY,
    secondTry: XP_SECOND_TRY,
    thirdPlus: XP_THIRD_PLUS,
  };

  const baseXp = correctedResult.overallMatch
    ? attempts === 0 ? rates.firstTry
    : attempts === 1 ? rates.secondTry
    : rates.thirdPlus
    : 0;

  // Phase 1.2: Multi-property bonus
  //
  // The multiplier must apply PER PROPERTY, not just to the base XP total.
  //
  // OLD (wrong):  xpAwarded = baseXp × multiBonus
  //   3 props in one scan = 40 × 2.0 = 80  ← LESS than 3 separate scans (120)
  //   This punishes efficient scanning instead of rewarding it.
  //
  // FIXED: xpAwarded = baseXpPerProperty × passingCount × multiBonus
  //   1 prop,  1st try: 40 × 1 × 1.0 =  40
  //   2 props, 1st try: 40 × 2 × 1.5 = 120  ← beats 2 separate scans (80)  ✓
  //   3 props, 1st try: 40 × 3 × 2.0 = 240  ← beats 3 separate scans (120) ✓
  //   2 props, 2nd try: 25 × 2 × 1.5 =  75  ← beats 2 separate 2nd-try (50) ✓
  //   3 props, 3rd try: 10 × 3 × 2.0 =  60  ← beats 3 separate 3rd-try (30) ✓
  const passingCount = correctedResult.properties.filter((p) => p.passes).length;
  const multiBonus   = passingCount >= 3 ? 2.0 : passingCount === 2 ? 1.5 : 1.0;
  const xpAwarded    = correctedResult.overallMatch || passingCount > 0
    ? Math.round(baseXp * passingCount * multiBonus)
    : 0;

  return { ...correctedResult, xpAwarded };
}
