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
import { getModelAdapter } from "../_shared/models/index.ts";
import {
  resolveFeatureAccess,
  statusFor,
  messageFor,
} from "../_shared/featureAccess.ts";

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

// ─── Vocabulary taxonomy ──────────────────────────────────────────────────────
//
// v5.0 (2026-06-02): Restructured from a single flat material-property list into
// MULTIPLE PERCEPTUAL AXES. Rationale:
//   • The old pool was one conceptual axis ("material/physical property"). At
//     age 5-6 that was only 20 words → the daily-quest generator kept hitting
//     property_set_collision and falling back to recycled seed quests.
//   • Color / shape / size / count / pattern are MORE reliably evaluable from a
//     single camera frame than the material words, and are core early-childhood
//     vocabulary. Adding them multiplies the generation space (sensory × color ×
//     shape ≫ sensory alone), which is the real fix for collisions.
//   • CAMERA-UNVERIFIABLE words were RETIRED. A property the vision model cannot
//     see in a still image (magnetism, temperature, conductivity, absorbency)
//     forces the model to hedge, and evaluateObject's hedging-cap then scores it
//     0.55 → passes:false. Net effect: a child scans a genuinely-magnetic object,
//     is correct in reality, and the app tells them "no" — the worst UX we ship.
//     Those words are removed from generation so they stop reaching kids.
//
// AXIS ESCALATION:
//   escalates:true  → has meaningful upward synonyms; eligible for hard-mode
//                     (e.g. soft → squishy → pliable). Sensory + material axes.
//   escalates:false → no sensible higher register (red has no Latinate upgrade).
//                     Hard mode for these axes = ADD a property / COMBINE axes,
//                     handled in the prompt — never "find a fancier word".
//                     Prevents the flat→planar/laminated/stratified mis-scaling
//                     bug seen on 5-6 quests.

interface Axis {
  name:       string;   // human-readable axis label used in the prompt
  words:      string[];
  escalates:  boolean;  // see AXIS ESCALATION above
}

const TAXONOMY: Record<string, {
  propertyType:     string;
  axes:             Axis[];
  /** Flattened convenience view — preserves the old `wordPool` contract.
   *  Populated by the rebuild loop below (NOT in the literals), so it is
   *  optional at definition time but always present at runtime. */
  wordPool?:        string[];
  hardModePool:     string;
  maxSyllables:     number;
  defaultPropCount: Record<string, number>;
  objectExamples:   string;
  feedbackCeiling:  string;
}> = {
  "5-6": {
    propertyType: "basic sensory + color, shape, size, count",
    axes: [
      { name: "sensory", escalates: true, words: [
        "hard", "soft", "rough", "smooth", "shiny", "dull",
        "bumpy", "flat", "fuzzy", "squishy", "stretchy",
      ] },
      { name: "color", escalates: false, words: [
        "red", "blue", "green", "yellow", "orange", "purple",
        "pink", "brown", "black", "white",
      ] },
      { name: "shape", escalates: false, words: [
        "round", "square", "flat", "pointy", "curved", "straight", "long",
      ] },
      { name: "size", escalates: false, words: [
        "big", "small", "tall", "tiny", "wide",
      ] },
      { name: "count", escalates: false, words: [
        "one", "two", "many",
      ] },
    ],
    // RETIRED from 5-6: heavy, light (weight ≈ guessable but unreliable from a
    // photo), wet, dry, hot, cold (temperature/moisture not visible), sticky,
    // crunchy, slippery (require touch/sound, not sight).
    hardModePool: `
      hard → solid
      soft → squishy → pliable
      shiny → gleaming → lustrous (pick ONE next step up, not both)
      rough → bumpy → textured
      stretchy → flexible
      (color / shape / size / count words do NOT escalate — see hard-mode rules)`,
    maxSyllables: 2,
    defaultPropCount: { apprentice: 1, scholar: 1, sage: 1, archmage: 1 },
    objectExamples: "spoon, pillow, stone, leaf, sock, cup, pencil, crayon, toy block, blanket, ball, book",
    feedbackCeiling: `
      - Maximum sentence length: 8 words.
      - No compound sentences ("and", "but", "because" are fine; semicolons are not).
      - Use ONLY words a 5-year-old knows. If in doubt, use a simpler word.
      - Forbidden in feedback: any word longer than 2 syllables, science terms, adjectives above this list.`,
  },

  "7-8": {
    propertyType: "physical state + color, shape, size",
    axes: [
      { name: "physical-state", escalates: true, words: [
        "transparent", "opaque", "flexible", "rigid", "hollow",
        "solid", "fragile", "durable", "elastic", "reflective",
      ] },
      { name: "sensory", escalates: true, words: [
        "smooth", "rough", "shiny", "dull", "bumpy", "fuzzy",
      ] },
      { name: "color", escalates: false, words: [
        "red", "blue", "green", "yellow", "orange", "purple",
        "pink", "brown", "black", "white", "grey", "gold", "silver",
      ] },
      { name: "shape", escalates: false, words: [
        "round", "square", "rectangular", "oval", "pointed", "curved", "flat", "narrow",
      ] },
      { name: "size", escalates: false, words: [
        "large", "small", "thin", "thick", "wide", "narrow",
      ] },
      { name: "pattern", escalates: false, words: [
        "striped", "spotted", "plain",
      ] },
    ],
    // RETIRED from 7-8: magnetic, absorbent, porous, waterproof, dense,
    // lightweight, insulating — none determinable from a still image.
    hardModePool: `
      transparent → see-through → clear → translucent (pick one step up)
      flexible → bendable → pliable
      rigid → stiff → inflexible
      reflective → mirror-like → glossy
      smooth → polished → sleek
      (color / shape / size / pattern words do NOT escalate)`,
    maxSyllables: 3,
    defaultPropCount: { apprentice: 1, scholar: 2, sage: 2, archmage: 2 },
    objectExamples: "mirror, sponge, ruler, candle, coin, balloon, rubber band, plastic bottle, glass, cup, leaf",
    feedbackCeiling: `
      - Use simple sentences. Some compound sentences are fine.
      - Vocabulary of a confident 7-year-old reader.
      - Avoid words above 3 syllables in feedback.
      - Science terms must be explained in parentheses if used: "transparent (you can see right through it)".`,
  },

  "9-10": {
    propertyType: "material science + color, shape, texture",
    axes: [
      { name: "material", escalates: true, words: [
        "elastic", "reflective", "crystalline", "fibrous", "grainy",
        "brittle", "translucent", "coarse", "granular", "layered",
      ] },
      { name: "physical-state", escalates: true, words: [
        "transparent", "opaque", "flexible", "rigid", "fragile", "durable",
      ] },
      { name: "color", escalates: false, words: [
        "crimson", "scarlet", "turquoise", "navy", "amber", "violet",
        "maroon", "beige", "metallic", "transparent",
      ] },
      { name: "shape", escalates: false, words: [
        "cylindrical", "spherical", "rectangular", "triangular", "tapered", "angular", "rounded",
      ] },
      { name: "texture-visual", escalates: false, words: [
        "ridged", "speckled", "woven", "smooth", "mottled",
      ] },
    ],
    // RETIRED from 9-10: conductive, dense, buoyant, permeable, insulating,
    // malleable, adhesive, porous — behaviour/material identity, not visible.
    hardModePool: `
      elastic → resilient → springy
      brittle → fragile → friable
      translucent → semi-transparent → pellucid (save pellucid for age 11-12)
      fibrous → filamentous
      reflective → specular
      crystalline → faceted
      (color / shape / visual-texture words do NOT escalate)`,
    maxSyllables: 4,
    defaultPropCount: { apprentice: 1, scholar: 2, sage: 3, archmage: 3 },
    objectExamples: "cork, aluminium foil, rubber eraser, clay, gravel, felt, mesh, wax candle, glass marble, pinecone",
    feedbackCeiling: `
      - Standard vocabulary for age 9-10.
      - Words up to 4 syllables are fine.
      - Can introduce one new vocabulary word per feedback, defined in context.
      - Science terms should be explained once, then used freely.`,
  },

  "11-12": {
    propertyType: "advanced physical science + precise color & form",
    axes: [
      { name: "advanced-material", escalates: true, words: [
        "translucent", "viscous", "lustrous", "pellucid",
        "iridescent", "crystalline", "refractive", "cohesive",
        "tensile", "laminated", "amorphous",
      ] },
      { name: "material", escalates: true, words: [
        "elastic", "brittle", "fibrous", "grainy", "coarse", "reflective",
      ] },
      { name: "color-precise", escalates: false, words: [
        "iridescent", "metallic", "translucent", "opalescent", "monochrome", "muted",
      ] },
      { name: "form", escalates: false, words: [
        "cylindrical", "spherical", "conical", "polygonal", "tapered", "symmetrical", "elongated",
      ] },
    ],
    // RETIRED from 11-12: malleable, ductile, hygroscopic, thermoplastic,
    // ferromagnetic, permeable, porosity — invisible material behaviours.
    // (Kept lustrous/refractive/iridescent: these ARE visible optical effects.)
    hardModePool: `
      translucent → pellucid (Latin-origin, same meaning, higher register)
      lustrous → specular → iridescent
      viscous → viscid → tenacious
      crystalline → faceted → vitreous
      reflective → specular → refractive
      (precise-color / form words do NOT escalate)`,
    maxSyllables: 5,
    defaultPropCount: { apprentice: 2, scholar: 3, sage: 3, archmage: 3 },
    objectExamples: "glass rod, wax block, felt sheet, resin block, polished metal, mica flake, salt crystal, soap bubble, prism",
    feedbackCeiling: `
      - Rich vocabulary. Age 11-12 level.
      - Can introduce etymology: "Pellucid comes from Latin pellucēre — to shine through."
      - Can use richer synonyms in feedback to plant seeds for the next level.
      - Archmage feedback should always introduce one word from the NEXT level up.`,
  },
};

// Build the flat `wordPool` view from axes once at module load (preserves the
// old contract: anything reading tax.wordPool still works, deduped).
for (const band of Object.values(TAXONOMY)) {
  band.wordPool = [...new Set(band.axes.flatMap((a) => a.words))];
}

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
  Word pool — organised by PERCEPTUAL AXIS (choose FROM these or close synonyms):
${tax.axes.map((a) => `    - ${a.name}: ${a.words.join(", ")}`).join("\n")}
  AXIS RULE: prefer drawing the ${propCount > 1 ? `${propCount} properties from DIFFERENT axes` : "property from whichever axis best fits the object"} (e.g. one color + one shape, not two colors). Mixing axes makes quests feel varied and teaches broader vocabulary.
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

  Two kinds of base word, handled DIFFERENTLY:

  (a) ESCALATING axes (sensory, physical-state, material, advanced-material):
      the hard-mode word MUST be an UPWARD SYNONYM of its base word:
        • Same physical property as the base word
        • Higher vocabulary register (more technical, more specific, or Latin/Greek origin)
        • Never a different property — "hard → dense" is WRONG. "hard → rigid → inflexible" is CORRECT.
      Hard-mode synonym guide:
${tax.hardModePool}

  (b) NON-ESCALATING axes (color, shape, size, count, pattern):
      these words have NO higher register — do NOT invent fancy synonyms
      (e.g. NEVER "red → crimson → vermillion" for a 5-6 child, NEVER
      "flat → planar → laminated"). Instead, make hard mode HARDER by:
        • specifying a more PRECISE value ("red" → "dark red", "round" → "perfectly round")
        • OR pairing it with a second observable attribute ("red" → "small and red")
      Keep the hard-mode word inside the same age band's max syllables (${tax.maxSyllables}).
      The hard-mode property must still be findable by the same child — just less obvious.

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

  // ── Authenticate caller + resolve access (premium gate / grant / cap) ──────
  //
  // generate-quest historically ran anonymous (deployed --no-verify-jwt and
  // never read the auth header). The Supabase client SDK's functions.invoke()
  // ALREADY attaches the caller's session JWT — this function just ignored
  // it. So we derive the parent identity here with ZERO client-side change,
  // mirroring export-word-tome's pattern.
  //
  // Access policy lives entirely server-side in feature_flags (premium_only,
  // free_lifetime_grant, monthly_cap) — see _shared/featureAccess.ts. The
  // premium gate fails CLOSED for an unidentifiable caller when premium_only
  // is on; cost controls fail OPEN.
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  let parentId: string | null = null;
  const authHeader = req.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const userClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        {
          global: { headers: { Authorization: authHeader } },
          auth:   { autoRefreshToken: false, persistSession: false },
        },
      );
      const { data: { user }, error: authErr } = await userClient.auth.getUser();
      if (!authErr && user) parentId = user.id;
    } catch (e) {
      console.warn(`[generate-quest] getUser threw: ${(e as Error)?.message ?? e}`);
    }
  }

  const access = await resolveFeatureAccess(admin, parentId, "generate_quest");
  if (!access.allowed) {
    console.log(
      `[generate-quest] blocked outcome=${access.outcome} ` +
      `parent=${parentId ?? "anon"} used=${access.monthUsed}/${access.cap}`,
    );
    return json(messageFor("generate_quest", access.outcome), statusFor(access.outcome));
  }

  // ── Call the model (provider chosen by feature_flags via _shared/models) ───
  const systemPrompt = buildSystemPrompt(ageBand, tier, knownWords, masteryProfile, propCount);
  const userMessage  = buildUserMessage(theme, ageBand, tier);

  // Scale token budget with propCount — 5 properties needs ~400 more tokens than 1
  const maxTokens = Math.max(1200, 800 + propCount * 200);

  let raw: string;
  try {
    // Provider resolved from feature_flags.generate_quest_model_provider
    // (anthropic|gemini|mistral) by the shared factory, with the same env +
    // fallback chain evaluate uses. Default stays Haiku until deliberately
    // flipped. Adapter normalises the request/response across providers.
    const adapter = await getModelAdapter("generate-quest", admin);
    const result  = await adapter.call({
      systemPrompt,
      userText:  userMessage,
      maxTokens,
      jsonMode:  true,   // quest is strict JSON; let the provider enforce it
    });
    raw = result.rawText;
    console.log(
      `[generate-quest] model=${result.modelId} latency=${result.latencyMs}ms`,
    );
  } catch (err: any) {
    console.error("[generate-quest] model call error:", err?.message ?? err);
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
