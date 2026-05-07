/**
 * supabase/functions/generate-quest/index.ts
 * Lexi-Lens — AI Quest Generator (Phase 3.3 + propCount update)
 *
 * v4.7 — Compliance polish: prepend CHILD_SAFETY_PREFIX to the system prompt.
 *   Sourced from supabase/functions/_shared/childSafety.ts. Applied to every
 *   Claude-using Edge Function uniformly. Guarantees that quest names, enemy
 *   names, spell descriptions, and feedback ceilings cannot drift into
 *   unsafe territory regardless of the parent-supplied theme. Adds ~250
 *   tokens to the system prompt; runtime cost on Haiku 4.5 is negligible.
 *
 * Changes in this version:
 *   • Accepts `propCount` (1–5) in the request body. When provided it overrides
 *     the taxonomy default so Claude generates exactly the number of vocabulary
 *     words the parent selected in the app.
 *   • max_tokens scales with propCount (800 + 200 × N) so larger quests never
 *     get truncated.
 *   • buildSystemPrompt receives propCount as an explicit parameter instead of
 *     deriving it from the taxonomy table.
 *
 * REQUEST BODY:
 *   {
 *     theme:          string,
 *     ageBand:        "5-6"|"7-8"|"9-10"|"11-12",
 *     tier:           "apprentice"|"scholar"|"sage"|"archmage",
 *     propCount?:     number,   // 1–5, default 3
 *     knownWords?:    string[],
 *     masteryProfile?: Array<{ word, mastery, masteryTier, timesUsed }>;
 *   }
 *
 * RESPONSE:
 *   { quest: GeneratedQuest }
 *
 * DEPLOY:
 *   supabase functions deploy generate-quest --no-verify-jwt
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CHILD_SAFETY_PREFIX } from "../_shared/childSafety.ts";

// ─── CORS ─────────────────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
} as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ─── Vocabulary taxonomy ──────────────────────────────────────────────────────

const TAXONOMY: Record<string, {
  propertyType:    string;
  wordPool:        string[];
  hardModePool:    string;
  maxSyllables:    number;
  defaultPropCount: Record<string, number>;  // renamed from propertyCount for clarity
  objectExamples:  string;
  feedbackCeiling: string;
}> = {
  "5-6": {
    propertyType:  "basic sensory",
    wordPool: [
      "hard", "soft", "rough", "smooth", "heavy", "light", "shiny", "dull",
      "wet", "dry", "hot", "cold", "bumpy", "flat", "fuzzy", "sticky",
      "squishy", "crunchy", "slippery", "stretchy",
    ],
    hardModePool: `
      hard → solid
      soft → squishy → pliable
      shiny → gleaming → lustrous (pick ONE next step up, not both)
      heavy → weighty
      rough → bumpy → textured
      stretchy → flexible`,
    maxSyllables:     2,
    defaultPropCount: { apprentice: 1, scholar: 1, sage: 1, archmage: 1 },
    objectExamples:   "spoon, pillow, stone, leaf, sock, cup, pencil, crayon, toy block, blanket",
    feedbackCeiling: `
      - Maximum sentence length: 8 words.
      - No compound sentences ("and", "but", "because" are fine; semicolons are not).
      - Use ONLY words a 5-year-old knows. If in doubt, use a simpler word.
      - Forbidden in feedback: any word longer than 2 syllables, science terms, adjectives above this list.`,
  },

  "7-8": {
    propertyType:  "physical state",
    wordPool: [
      "transparent", "opaque", "flexible", "rigid", "magnetic", "hollow",
      "solid", "absorbent", "porous", "waterproof", "fragile", "durable",
      "elastic", "dense", "lightweight", "reflective", "insulating",
    ],
    hardModePool: `
      transparent → see-through → clear → translucent (pick one step up)
      flexible → bendable → pliable
      rigid → stiff → inflexible
      magnetic → attracted-to-magnets → ferromagnetic (use only for age 11-12)
      absorbent → sponge-like → porous
      reflective → mirror-like → glossy`,
    maxSyllables:     3,
    defaultPropCount: { apprentice: 1, scholar: 2, sage: 2, archmage: 2 },
    objectExamples:   "mirror, sponge, ruler, candle, coin, balloon, rubber band, plastic bottle, glass",
    feedbackCeiling: `
      - Use simple sentences. Some compound sentences are fine.
      - Vocabulary of a confident 7-year-old reader.
      - Avoid words above 3 syllables in feedback.
      - Science terms must be explained in parentheses if used: "transparent (you can see right through it)".`,
  },

  "9-10": {
    propertyType:  "material science",
    wordPool: [
      "conductive", "elastic", "reflective", "dense", "crystalline", "fibrous",
      "grainy", "brittle", "buoyant", "permeable", "insulating", "translucent",
      "malleable", "adhesive", "coarse", "granular", "layered", "porous",
    ],
    hardModePool: `
      elastic → resilient → springy
      conductive → transmissive
      brittle → fragile → friable
      dense → compact
      translucent → semi-transparent → pellucid (save pellucid for age 11-12)
      fibrous → filamentous
      malleable → workable → ductile (save ductile for age 11-12)
      buoyant → floatable → hydrophobic`,
    maxSyllables:     4,
    defaultPropCount: { apprentice: 1, scholar: 2, sage: 3, archmage: 3 },
    objectExamples:   "cork, aluminium foil, rubber eraser, copper wire, clay, gravel, felt, mesh, wax candle",
    feedbackCeiling: `
      - Standard vocabulary for age 9-10.
      - Words up to 4 syllables are fine.
      - Can introduce one new vocabulary word per feedback, defined in context.
      - Science terms should be explained once, then used freely.`,
  },

  "11-12": {
    propertyType:  "advanced physical science",
    wordPool: [
      "translucent", "malleable", "ductile", "viscous", "lustrous",
      "hygroscopic", "thermoplastic", "ferromagnetic", "pellucid",
      "iridescent", "crystalline", "refractive", "permeable", "cohesive",
      "tensile", "laminated", "amorphous", "porosity",
    ],
    hardModePool: `
      translucent → pellucid (Latin-origin, same meaning, higher register)
      malleable → ductile (more specific: ductile = drawn into wire)
      lustrous → specular → iridescent
      viscous → viscid → tenacious
      ferromagnetic → paramagnetic (different but related — explain distinction)
      hygroscopic → deliquescent (extreme case of hygroscopic)
      refractive → diffractive (introduce optical nuance)`,
    maxSyllables:     5,
    defaultPropCount: { apprentice: 2, scholar: 3, sage: 3, archmage: 3 },
    objectExamples:   "copper pipe, glass rod, wax block, felt sheet, resin block, polished metal, mica flake, salt crystal",
    feedbackCeiling: `
      - Rich vocabulary. Age 11-12 level.
      - Can introduce etymology: "Pellucid comes from Latin pellucēre — to shine through."
      - Can use richer synonyms in feedback to plant seeds for the next level.
      - Archmage feedback should always introduce one word from the NEXT level up.`,
  },
};

// ─── System prompt builder ────────────────────────────────────────────────────

function buildSystemPrompt(
  ageBand:        string,
  tier:           string,
  knownWords:     string[],
  masteryProfile: Array<{ word: string; mastery: number; masteryTier: string; timesUsed: number }>,
  propCount:      number,   // parent-specified, already clamped to 1–5
): string {
  const tax = TAXONOMY[ageBand] ?? TAXONOMY["7-8"];

  const knownWordsSection = knownWords.length > 0
    ? `\nWORDS ALREADY IN THE CHILD'S VOCABULARY (DO NOT use any of these):
${knownWords.map(w => `  • ${w}`).join("\n")}
These words are retired — the child has already learned them. Introducing them again wastes the quest.`
    : "";

  const masterySection = masteryProfile.length > 0
    ? `\nCHILD'S MASTERY PROFILE (use to calibrate difficulty):
${masteryProfile.map(m =>
  `  • "${m.word}" — ${m.masteryTier} tier (score: ${m.mastery.toFixed(2)}, used ${m.timesUsed}×)`
).join("\n")}
For ARCHMAGE tier: prioritise words that are upward synonyms of the child's DEVELOPING-tier words.
For SAGE tier: pick from the upper half of the age-band word pool, not words already PROFICIENT.
For SCHOLAR/APPRENTICE: use words from the lower-mid pool regardless of mastery.`
    : "";

  return `${CHILD_SAFETY_PREFIX}

You are a vocabulary curriculum designer for Lexi-Lens, a children's AR vocabulary RPG.
Your job is to generate a single vocabulary quest that children complete by finding a real physical
object that matches specific word properties with their device camera.

AGE BAND: ${ageBand} years old
DIFFICULTY TIER: ${tier}

VOCABULARY TAXONOMY FOR THIS AGE BAND (${ageBand}):
  Property type: ${tax.propertyType}
  Word pool (choose FROM these or close synonyms): ${tax.wordPool.join(", ")}
  Max syllables per vocabulary word: ${tax.maxSyllables}
  Number of required_properties: EXACTLY ${propCount}
  Target object concreteness: ${tax.objectExamples}

TIER BEHAVIOUR:
  apprentice — Use the simplest words from the pool. One-syllable preferred. Very common objects.
  scholar    — Middle of the pool. Objects children encounter regularly.
  sage       — Upper half of pool. Slightly less common objects but still findable at home/school.
  archmage   — Top of pool + one preview word from the NEXT age band up (with clear definition).
               Current band (${ageBand}) max syllables: ${tax.maxSyllables}. Preview word may have ${tax.maxSyllables + 1} syllables.

HARD MODE PROPERTIES (hard_mode_properties array):
  Generate exactly ${propCount} hard-mode properties — one for each required property.
  Each hard-mode word MUST be an UPWARD SYNONYM of its base word:
    • Same physical property as the base word
    • Higher vocabulary register (more technical, more specific, or Latin/Greek origin)
    • Never a different property — "hard → dense" is WRONG. "hard → rigid → inflexible" is CORRECT.
  Hard-mode synonym guide:
${tax.hardModePool}

FEEDBACK CEILING (used in childFeedback field):
${tax.feedbackCeiling}
${knownWordsSection}
${masterySection}

UNIQUENESS RULES:
  1. Never use a word from the "known words" list above as a required_property or hard_mode_property.
  2. Choose vocabulary words that are genuinely useful for the child's real-world vocabulary.
  3. Pick objects that are findable in a typical home or classroom — not rare collector items.

RESPONSE: Return ONLY valid JSON. No markdown, no prose outside JSON.

{
  "name":               "Quest name (RPG fantasy style, 3-6 words)",
  "enemy_name":         "Fantasy enemy name (2-3 words)",
  "enemy_emoji":        "Single emoji for the enemy",
  "room_label":         "Fantasy room name (2-4 words)",
  "spell_name":         "Name of the spell the child casts (2-4 words)",
  "weapon_emoji":       "Single emoji for the weapon/spell",
  "spell_description":  "One sentence: what the spell does in fantasy terms",
  "required_properties": [
    {
      "word":             "vocabulary word (from the taxonomy pool)",
      "definition":       "child-appropriate definition, ${ageBand} reading level",
      "evaluationHints":  "one sentence: what Claude's vision model should look for in an object to verify this property"
    }
  ],
  "hard_mode_properties": [
    {
      "word":             "upward synonym of the base word",
      "definition":       "definition at the higher register, ${ageBand}+1 reading level",
      "evaluationHints":  "same or more specific than the base hint"
    }
  ]
}

CRITICAL: required_properties.length === ${propCount} and hard_mode_properties.length === ${propCount}.
Both arrays must have exactly ${propCount} item(s). Never more, never fewer.`;
}

// ─── User message builder ─────────────────────────────────────────────────────

function buildUserMessage(theme: string, ageBand: string, tier: string): string {
  return `Create a vocabulary quest with theme: "${theme}"

Age band: ${ageBand} | Tier: ${tier}

Design an immersive RPG quest where finding and scanning the right real-world object
defeats the enemy. The vocabulary words must come from the taxonomy specified in the system prompt.
Make the quest feel exciting and magical while staying true to the age-appropriate vocabulary constraints.`;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")    return json({ error: "POST only" }, 405);

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body: {
    theme?:          unknown;
    ageBand?:        unknown;
    tier?:           unknown;
    propCount?:      unknown;   // ← NEW
    knownWords?:     unknown;
    masteryProfile?: unknown;
  };

  try {
    body = await req.json();
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }

  const theme    = typeof body.theme   === "string" ? body.theme.trim() : "";
  const ageBand  = typeof body.ageBand === "string" ? body.ageBand      : "7-8";
  const tier     = typeof body.tier    === "string" ? body.tier         : "apprentice";

  // propCount: parent-specified (1–5). If absent/invalid, fall back to taxonomy default.
  const tax = TAXONOMY[ageBand] ?? TAXONOMY["7-8"];
  const taxonomyDefault = tax.defaultPropCount[tier] ?? 2;
  const rawPropCount    = typeof body.propCount === "number" ? body.propCount : null;
  const propCount       = rawPropCount !== null
    ? Math.min(5, Math.max(1, Math.round(rawPropCount)))
    : taxonomyDefault;

  const knownWords = Array.isArray(body.knownWords)
    ? (body.knownWords as string[]).filter(w => typeof w === "string")
    : [];
  const masteryProfile = Array.isArray(body.masteryProfile)
    ? body.masteryProfile as Array<{ word: string; mastery: number; masteryTier: string; timesUsed: number }>
    : [];

  if (theme.length < 3) {
    return json({ error: "theme must be at least 3 characters." }, 400);
  }
  if (!TAXONOMY[ageBand]) {
    return json({ error: `Unknown ageBand: ${ageBand}. Use 5-6, 7-8, 9-10, or 11-12.` }, 400);
  }

  // ── Call Claude ────────────────────────────────────────────────────────────
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY not configured." }, 500);

  const systemPrompt = buildSystemPrompt(ageBand, tier, knownWords, masteryProfile, propCount);
  const userMessage  = buildUserMessage(theme, ageBand, tier);

  // Scale token budget with propCount — 5 properties needs ~400 more tokens than 1
  const maxTokens = Math.max(1200, 800 + propCount * 200);

  let raw: string;
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method:  "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: maxTokens,
        system:     systemPrompt,
        messages:   [{ role: "user", content: userMessage }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "(unreadable)");
      console.error("[generate-quest] Anthropic error:", response.status, errText);
      return json({ error: `AI service error (${response.status}). Please try again.` }, 502);
    }

    const apiResponse = await response.json() as {
      content: Array<{ type: string; text?: string }>;
    };

    raw = apiResponse.content
      .filter(b => b.type === "text")
      .map(b => b.text ?? "")
      .join("");

  } catch (err: any) {
    console.error("[generate-quest] fetch error:", err.message);
    return json({ error: "Could not reach AI service. Please try again." }, 502);
  }

  // ── Parse & validate response ──────────────────────────────────────────────
  let quest: {
    name:                 string;
    enemy_name:           string;
    enemy_emoji:          string;
    room_label:           string;
    spell_name:           string;
    weapon_emoji:         string;
    spell_description:    string;
    required_properties:  Array<{ word: string; definition: string; evaluationHints: string }>;
    hard_mode_properties: Array<{ word: string; definition: string; evaluationHints: string }>;
  };

  try {
    const clean = raw.replace(/```json|```/g, "").trim();
    quest = JSON.parse(clean);
  } catch (parseErr) {
    console.error("[generate-quest] JSON parse failed:", raw.slice(0, 300));
    return json({ error: "AI returned malformed response. Please try again." }, 502);
  }

  // Validate required shape
  if (!quest.name || !Array.isArray(quest.required_properties) || quest.required_properties.length === 0) {
    console.error("[generate-quest] Invalid quest shape:", JSON.stringify(quest).slice(0, 300));
    return json({ error: "AI returned an incomplete quest. Please try again." }, 502);
  }

  // Ensure hard_mode_properties exists
  if (!Array.isArray(quest.hard_mode_properties)) {
    quest.hard_mode_properties = [];
  }

  // Guard: never return a quest where required_property.word is in knownWords
  if (knownWords.length > 0) {
    const knownSet  = new Set(knownWords.map(w => w.toLowerCase()));
    const collision = quest.required_properties.find(p => knownSet.has(p.word.toLowerCase()));
    if (collision) {
      console.warn(`[generate-quest] Claude used a known word: "${collision.word}" — returning error`);
      return json({
        error: `The AI reused a word the child already knows ("${collision.word}"). Please try generating again.`
      }, 422);
    }
  }

  console.log(
    `[generate-quest] Generated quest "${quest.name}" for age ${ageBand} tier ${tier}. ` +
    `propCount requested: ${propCount}, delivered: ${quest.required_properties.length}. ` +
    `Properties: ${quest.required_properties.map(p => p.word).join(", ")}`
  );

  return json({ quest });
});
