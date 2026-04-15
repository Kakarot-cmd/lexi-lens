/**
 * evaluateObject.ts
 * Lexi-Lens — Claude API call for vocabulary property evaluation.
 *
 * This is the "brain" of Lexi-Lens. It takes a detected object label
 * (from on-device Vision) and evaluates whether it satisfies the
 * vocabulary properties required by the current quest.
 *
 * Dependencies:
 *   npm install @anthropic-ai/sdk
 *
 * Environment:
 *   ANTHROPIC_API_KEY — keep server-side only (Expo API route or Edge Function)
 *
 * Architecture note:
 *   Never call this directly from the React Native client.
 *   Route through your Supabase Edge Function or a Next.js API route
 *   so the API key never touches the device.
 */

import Anthropic from "@anthropic-ai/sdk";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PropertyRequirement {
  /** The vocabulary word the child must demonstrate understanding of */
  word: string;
  /** Plain-English definition shown to the child during the quest */
  definition: string;
  /**
   * Optional additional criteria that help Claude disambiguate edge cases.
   * e.g. for "fragile": "Should shatter or permanently deform under moderate force.
   * Rigid plastics that bend without breaking do NOT qualify."
   */
  evaluationHints?: string;
}

export interface PropertyScore {
  word: string;
  /** 0.0 = definitely does not apply, 1.0 = perfectly matches */
  score: number;
  /** One sentence Claude uses as the verdict for this property */
  reasoning: string;
  /** true only if score >= PROPERTY_PASS_THRESHOLD */
  passes: boolean;
}

export interface EvaluationResult {
  /** The object Claude understood the child to be pointing at */
  resolvedObjectName: string;
  /** Per-property breakdown */
  properties: PropertyScore[];
  /** True only if ALL required properties pass */
  overallMatch: boolean;
  /**
   * The message shown to the child.
   * - On match: celebratory, explains WHY it qualifies.
   * - On partial match: affirms what's correct, redirects on what's wrong.
   * - On no match: encouraging, steers without giving away the answer.
   */
  childFeedback: string;
  /**
   * Optional hint shown if the child has failed 2+ times on the same quest.
   * More direct but still doesn't name the answer object.
   */
  nudgeHint?: string;
  /** XP to award (0 on failure, scaled by attempt count on success) */
  xpAwarded: number;
}

interface EvaluateObjectOptions {
  /** Object label from on-device detection (e.g. "water bottle", "glass") */
  detectedLabel: string;
  /** Confidence score from Vision API (0.0–1.0) */
  confidence: number;
  /**
   * Optional: base64-encoded JPEG of the camera frame.
   * Including this lets Claude visually confirm the object,
   * catching cases where the Vision label is ambiguous (e.g. "container").
   */
  frameBase64?: string | null;
  /** Properties the child's object must satisfy */
  requiredProperties: PropertyRequirement[];
  /** Child's age — adjusts vocabulary complexity of feedback */
  childAge: number;
  /** How many failed attempts on this exact quest so far */
  failedAttempts?: number;
  /** Name of the current quest for narrative context */
  questName?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PROPERTY_PASS_THRESHOLD = 0.7;
const XP_FIRST_TRY = 40;
const XP_SECOND_TRY = 25;
const XP_THIRD_PLUS = 10;

const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 600;

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(childAge: number, questName?: string): string {
  return `You are a warm, encouraging vocabulary tutor in a fantasy RPG game called Lexi-Lens.
Children aged 5–12 are playing. They point their camera at real objects in their home to find
"material components" for spells that defeat dungeon monsters.

${questName ? `Current quest: "${questName}".` : ""}
The child is approximately ${childAge} years old. Match your language complexity to this age.

CRITICAL SAFETY RULES (never break these):
- Only discuss the object's physical properties. Never comment on the child, their home,
  or anything else visible in the frame.
- Keep all feedback warm, encouraging, and age-appropriate.
- Never tell the child exactly which object to find — guide, don't spoil.
- If the camera frame shows anything inappropriate, respond with:
  { "error": "unable_to_evaluate" } and nothing else.

RESPONSE FORMAT:
Respond ONLY with valid JSON. No markdown, no explanation outside the JSON.
Schema:
{
  "resolvedObjectName": string,       // What you believe the object is
  "properties": [
    {
      "word": string,                 // The vocabulary word
      "score": number,               // 0.0–1.0
      "reasoning": string,           // One sentence, adult-readable
      "passes": boolean
    }
  ],
  "overallMatch": boolean,
  "childFeedback": string,           // 1–3 sentences, age-appropriate, in-world RPG tone
  "nudgeHint": string | null,        // Shown only after 2+ failures. Indirect hint. Null otherwise.
  "xpAwarded": number                // You return 0 always — the server computes XP.
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

  const textBlock: Anthropic.TextBlockParam = {
    type: "text",
    text: `The child's camera detected: "${opts.detectedLabel}" (Vision confidence: ${(
      opts.confidence * 100
    ).toFixed(0)}%).

The quest requires an object that satisfies ALL of these properties:
${propertyList}

Failed attempts so far: ${opts.failedAttempts ?? 0}

Evaluate whether "${opts.detectedLabel}" satisfies each property.
${
  opts.failedAttempts && opts.failedAttempts >= 2
    ? "The child has struggled. Include a gentle nudgeHint that guides without naming the object."
    : "Set nudgeHint to null."
}`,
  };

  // Optionally attach the camera frame for visual grounding
  if (opts.frameBase64) {
    const imageBlock: Anthropic.ImageBlockParam = {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: opts.frameBase64,
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
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: buildSystemPrompt(opts.childAge, opts.questName),
    messages: [
      {
        role: "user",
        content: buildUserMessage(opts),
      },
    ],
  });

  // Extract JSON from response
  const rawText = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as Anthropic.TextBlock).text)
    .join("");

  let parsed: Omit<EvaluationResult, "xpAwarded">;
  try {
    // Strip any accidental markdown fences before parsing
    const clean = rawText.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(clean);
  } catch {
    throw new Error(`Claude returned non-JSON response: ${rawText.slice(0, 200)}`);
  }

  // Safety: reject if Claude flagged the frame as inappropriate
  if ((parsed as any).error === "unable_to_evaluate") {
    throw new Error("Frame could not be evaluated safely.");
  }

  // Compute XP server-side (never trust Claude's value)
  const attempts = opts.failedAttempts ?? 0;
  const xpAwarded = parsed.overallMatch
    ? attempts === 0
      ? XP_FIRST_TRY
      : attempts === 1
      ? XP_SECOND_TRY
      : XP_THIRD_PLUS
    : 0;

  return { ...parsed, xpAwarded };
}

// ─── Supabase Edge Function wrapper (deploy to supabase/functions/evaluate) ───
//
// import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
// import { evaluateObject } from "./evaluateObject.ts";
//
// serve(async (req) => {
//   const { detectedLabel, confidence, frameBase64,
//           requiredProperties, childAge, failedAttempts, questName }
//     = await req.json();
//
//   try {
//     const result = await evaluateObject({
//       detectedLabel, confidence, frameBase64,
//       requiredProperties, childAge, failedAttempts, questName,
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

// ─── Example call ─────────────────────────────────────────────────────────────
//
// const result = await evaluateObject({
//   detectedLabel: "glass",
//   confidence: 0.87,
//   frameBase64: "<base64 jpeg>",
//   childAge: 7,
//   failedAttempts: 1,
//   questName: "Defeat the Boredom Behemoth",
//   requiredProperties: [
//     {
//       word: "translucent",
//       definition: "Allows light to pass through, but not completely clear",
//       evaluationHints: "Glass and water qualify. Frosted glass barely qualifies. Opaque ceramic does not.",
//     },
//     {
//       word: "fragile",
//       definition: "Easily broken or damaged",
//       evaluationHints: "Glass shatters = yes. Rigid plastic bends without breaking = no. Paper tears but is not 'fragile' in this context.",
//     },
//   ],
// });
//
// console.log(result);
// {
//   resolvedObjectName: "drinking glass",
//   properties: [
//     { word: "translucent", score: 0.95, reasoning: "Glass allows light through but distorts images.", passes: true },
//     { word: "fragile", score: 0.92, reasoning: "Glass shatters under moderate impact.", passes: true },
//   ],
//   overallMatch: true,
//   childFeedback: "The glass of water glows with magical light! It's translucent — light shines right through it — and fragile, meaning it could shatter. Your Prism Bolt is charged! ⚡",
//   nudgeHint: null,
//   xpAwarded: 25,
// }
