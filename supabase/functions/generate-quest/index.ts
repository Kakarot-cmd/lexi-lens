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
import { TAXONOMY } from "../_shared/vocabularyTaxonomy.ts";
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
// Moved to _shared/vocabularyTaxonomy.ts (shared with ensure-daily-quest).


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
  SAME index = SAME object must satisfy both the required word and its hard word;
  the hard word describes the SAME attribute, just at a harder vocabulary level.

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
      "evaluationHints":  "one sentence: what Claude's vision model should look for in an object to verify this property",
      "phonetic":         "IPA pronunciation in slashes, General American (e.g. /braʊn/). Be accurate."
    }
  ],
  "hard_mode_properties": [
    {
      "word":             "upward synonym of the base word",
      "definition":       "definition at the higher register, ${ageBand}+1 reading level",
      "evaluationHints":  "same or more specific than the base hint",
      "phonetic":         "IPA pronunciation in slashes, General American (e.g. /ˈrɪdʒɪd/). Be accurate."
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
    required_properties:  Array<{ word: string; definition: string; evaluationHints: string; phonetic?: string }>;
    hard_mode_properties: Array<{ word: string; definition: string; evaluationHints: string; phonetic?: string }>;
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
