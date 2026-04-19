/**
 * evaluateObject.ts
 * Lexi-Lens — Claude API call for vocabulary property evaluation.
 *
 * v1.5 additions (Proficiency-Based Vocabulary):
 *   • EvaluateObjectOptions gains masteryProfile: MasteryEntry[]
 *   • buildSystemPrompt uses mastery tiers to tailor Claude's language:
 *       - novice words  → simple, highly encouraging language
 *       - proficient words → richer vocabulary in feedback
 *       - expert words  → challenge with the synonym they're growing into
 *   • buildUserMessage appends the mastery profile as structured context
 *
 * Architecture:
 *   Never call this directly from React Native — route through the
 *   Supabase Edge Function so ANTHROPIC_API_KEY never touches the device.
 *
 * Dependencies:
 *   npm install @anthropic-ai/sdk
 */

import Anthropic from "@anthropic-ai/sdk";

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
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PROPERTY_PASS_THRESHOLD = 0.7;

// ─── v1.6: Negative phrase validation ────────────────────────────────────────
//
// Two-layer contradiction detection:
//
// Layer 1 — NEGATIVE_PHRASES: If Claude's reasoning for a property contains
//   any of these phrases, the property is force-failed regardless of score.
//   These phrases signal that Claude itself is describing a mismatch, even
//   when it assigns a passing score (the "resonant for fabric" bug class).
//
// Layer 2 — CONTRADICTION_THRESHOLD: If a property score is high (≥ 0.7)
//   BUT reasoning contains softer hedging phrases, we cap the score at
//   CONTRADICTION_CAP so it falls below the pass threshold.
//   This catches "technically qualifies but..." cases.

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
  "without", "absent",

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

// Softer hedging phrases: score gets capped if Claude sounds uncertain
// while still assigning a high score
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

const CONTRADICTION_THRESHOLD = 0.7;  // score >= this triggers hedge check
const CONTRADICTION_CAP       = 0.55; // score is capped here if hedging found
const XP_FIRST_TRY   = 40;
const XP_SECOND_TRY  = 25;
const XP_THIRD_PLUS  = 10;
const MODEL          = "claude-sonnet-4-20250514";
const MAX_TOKENS     = 700;

// ─── Mastery profile formatter ────────────────────────────────────────────────

/**
 * Convert the mastery profile into a compact, readable format for Claude.
 * We give Claude tier labels rather than raw numbers so it can reason
 * intuitively ("this child is proficient at 'translucent'") rather than
 * having to interpret floating-point thresholds.
 */
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

  if (byTier.expert.length > 0) {
    lines.push(`EXPERT (mastered, nearly retired): ${byTier.expert.join(", ")}`);
  }
  if (byTier.proficient.length > 0) {
    lines.push(`PROFICIENT (solid understanding): ${byTier.proficient.join(", ")}`);
  }
  if (byTier.developing.length > 0) {
    lines.push(`DEVELOPING (building confidence): ${byTier.developing.join(", ")}`);
  }
  if (byTier.novice.length > 0) {
    lines.push(`NOVICE (just learning): ${byTier.novice.join(", ")}`);
  }

  return lines.join("\n");
}

// ─── v1.6: Post-processing validation ────────────────────────────────────────

/**
 * Checks a single property score for contradictions between the numeric
 * score and the text reasoning.
 *
 * Returns a corrected PropertyScore — the original if clean, or a
 * force-failed/capped version with an audit note appended to reasoning.
 */
function validatePropertyScore(prop: PropertyScore): PropertyScore {
  const reasoning = prop.reasoning.toLowerCase();

  // Layer 1: Hard negative phrases → force fail
  const hardMatch = NEGATIVE_PHRASES.find((phrase) => reasoning.includes(phrase));
  if (hardMatch) {
    return {
      ...prop,
      score:   0.0,
      passes:  false,
      reasoning: `${prop.reasoning} [auto-corrected: score overridden due to negative phrasing ("${hardMatch}")]`,
    };
  }

  // Layer 2: Hedging phrases on a high score → cap score below threshold
  if (prop.score >= CONTRADICTION_THRESHOLD) {
    const hedgeMatch = HEDGING_PHRASES.find((phrase) => reasoning.includes(phrase));
    if (hedgeMatch) {
      const cappedScore = Math.min(prop.score, CONTRADICTION_CAP);
      return {
        ...prop,
        score:   cappedScore,
        passes:  cappedScore >= PROPERTY_PASS_THRESHOLD,
        reasoning: `${prop.reasoning} [auto-corrected: score capped due to hedging ("${hedgeMatch}")]`,
      };
    }
  }

  return prop;
}

/**
 * Run validatePropertyScore over every property in the result,
 * then recompute overallMatch from the corrected passes flags.
 *
 * This is the single entry point — call it on the raw Claude response
 * before computing XP or returning to the client.
 */
function applyNegativePhraseValidation(
  properties: PropertyScore[]
): { properties: PropertyScore[]; overallMatch: boolean } {
  const corrected = properties.map(validatePropertyScore);
  const overallMatch = corrected.every((p) => p.passes);
  return { properties: corrected, overallMatch };
}

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(
  childAge:      number,
  questName?:    string,
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

function buildUserMessage(
  opts: EvaluateObjectOptions
): Anthropic.MessageParam["content"] {
  const propertyList = opts.requiredProperties
    .map(
      (p, i) =>
        `${i + 1}. "${p.word}" — ${p.definition}${
          p.evaluationHints ? ` | Hint: ${p.evaluationHints}` : ""
        }`
    )
    .join("\n");

  // Find the mastery tier for each required property word so Claude has
  // immediate context without having to cross-reference the full profile.
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

  const textBlock: Anthropic.TextBlockParam = {
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
    return [
      {
        type:   "image",
        source: { type: "base64", media_type: "image/jpeg", data: opts.frameBase64 },
      } satisfies Anthropic.ImageBlockParam,
      textBlock,
    ];
  }

  return [textBlock];
}

// ─── Main function ────────────────────────────────────────────────────────────

export async function evaluateObject(
  opts: EvaluateObjectOptions
): Promise<EvaluationResult> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: MAX_TOKENS,
    system:     buildSystemPrompt(opts.childAge, opts.questName, opts.masteryProfile),
    messages:   [{ role: "user", content: buildUserMessage(opts) }],
  });

  const rawText = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as Anthropic.TextBlock).text)
    .join("");

  let parsed: Omit<EvaluationResult, "xpAwarded">;
  try {
    const clean = rawText.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(clean);
  } catch {
    throw new Error(`Claude returned non-JSON: ${rawText.slice(0, 200)}`);
  }

  if ((parsed as any).error === "unable_to_evaluate") {
    throw new Error("Frame could not be evaluated safely.");
  }

  // v1.6: Apply negative phrase + contradiction validation BEFORE computing XP.
  // This corrects cases where Claude assigns a passing score but its own
  // reasoning contains clear negative language (the "resonant for fabric" bug).
  const { properties: validatedProperties, overallMatch: validatedMatch } =
    applyNegativePhraseValidation(parsed.properties);

  const correctedResult = {
    ...parsed,
    properties:   validatedProperties,
    overallMatch: validatedMatch,
  };

  const attempts  = opts.failedAttempts ?? 0;
  const xpAwarded = correctedResult.overallMatch
    ? attempts === 0 ? XP_FIRST_TRY : attempts === 1 ? XP_SECOND_TRY : XP_THIRD_PLUS
    : 0;

  return { ...correctedResult, xpAwarded };
}

// ─── Supabase Edge Function wrapper ──────────────────────────────────────────
//
// supabase/functions/evaluate/index.ts
//
// import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
// import { evaluateObject } from "./evaluateObject.ts";
//
// serve(async (req) => {
//   const {
//     detectedLabel, confidence, frameBase64,
//     requiredProperties, childAge, failedAttempts,
//     questName,
//     masteryProfile,          // ← v1.5: passed from client
//   } = await req.json();
//
//   try {
//     const result = await evaluateObject({
//       detectedLabel, confidence, frameBase64,
//       requiredProperties, childAge, failedAttempts,
//       questName,
//       masteryProfile,          // ← forward to evaluateObject
//     });
//     return new Response(JSON.stringify(result), {
//       headers: { "Content-Type": "application/json" },
//     });
//   } catch (err) {
//     return new Response(JSON.stringify({ error: err.message }), {
//       status: 500,
//       headers: { "Content-Type": "application/json" },
//     });
//   }
// });
