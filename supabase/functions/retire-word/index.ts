/**
 * supabase/functions/retire-word/index.ts
 * Lexi-Lens — Phase 1.5: retire-word Edge Function
 *
 * v4.7 — Compliance polish: prepend CHILD_SAFETY_PREFIX to the system prompt.
 *   Sourced from supabase/functions/_shared/childSafety.ts. Applied to every
 *   Claude-using Edge Function uniformly. Important here because the input
 *   "mastered word" is parent-influenceable (custom quests) and the synonym
 *   Claude returns is rendered straight into the child-facing celebration
 *   banner.
 *
 * Called by MasteryService.fetchHarderSynonym() when a child's mastery
 * for a word crosses the 0.8 retirement threshold.
 *
 * Input:  { word: string, definition: string, childAge: number }
 * Output: { synonym: string, definition: string }
 *
 * Uses Claude to find the ideal next-challenge word — one step harder
 * than the retired word, appropriate for the child's age, and specific
 * enough to be meaningful in the context of object scanning.
 *
 * Deploy:
 *   supabase functions deploy retire-word --no-verify-jwt
 *
 * Environment variables needed:
 *   ANTHROPIC_API_KEY — set via Supabase dashboard > Edge Functions > Secrets
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CHILD_SAFETY_PREFIX } from "../_shared/childSafety.ts";
import { getModelAdapter } from "../_shared/models/index.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};


// Model + endpoint are no longer hardcoded — provider is resolved per-call
// by _shared/models (feature_flags.retire_word_model_provider).

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const { word, definition, childAge } = await req.json();

    if (!word || !definition ||  typeof childAge !== "number") {
      return new Response(
        JSON.stringify({ error: "Missing word, definition, or childAge" }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured");
    }
    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // ── Call Claude for synonym suggestion ────────────────────────────────────
    //
    // We ask Claude to find a harder synonym that:
    //   1. Has a similar meaning but richer/more specific vocabulary
    //   2. Is appropriate for a child to encounter in the object-scanning context
    //   3. Is one step harder — not an obscure academic term, but a real upgrade
    //
    // Examples of good progressions:
    //   translucent → pellucid
    //   flexible    → pliable / ductile
    //   hard        → rigid / unyielding
    //   smooth      → frictionless / silken
    //   heavy       → ponderous / dense
    //   transparent → diaphanous
	
	
	

    // Provider resolved from feature_flags.retire_word_model_provider via the
    // shared factory. Default → gemini (set by migration): "suggest one
    // harder synonym + child-friendly definition" is a trivial text task;
    // Gemini Flash-Lite is ~30x cheaper than Haiku with no quality loss.
    // retire-word is app-logic (fires once when a word crosses mastery 0.80)
    // and intentionally NOT capped — model choice is the right cost lever.
    const adapter = await getModelAdapter("retire-word", supabase);
    const modelResult = await adapter.call({
      systemPrompt: `${CHILD_SAFETY_PREFIX}

You are a vocabulary curriculum designer for a children's educational game.
Your task: find a harder synonym for a word a child has just mastered.

Rules:
- The synonym must describe a PHYSICAL PROPERTY of real objects (so children can
  find it by scanning objects with a camera).
- It must be one step harder — more specific or literary than the mastered word,
  but NOT an academic/medical term.
- The definition must be child-friendly (age ${childAge}).
- Return ONLY valid JSON: { "synonym": string, "definition": string }
- No markdown, no explanation, no preamble.

Good progression examples:
  translucent → pellucid (def: "so clear that light passes through perfectly")
  flexible    → pliable  (def: "easily bent without breaking")
  heavy       → ponderous (def: "so heavy it moves slowly and with great weight")
  smooth      → frictionless (def: "so smooth that nothing can grip or catch on it")
  fragile     → brittle  (def: "hard but snaps instantly under force instead of bending")`,
      userText: `The child has mastered the word "${word}" (definition: "${definition}").
What is the perfect next-level synonym they should learn? Return JSON only.`,
      maxTokens: 200,
      jsonMode:  true,
    });

    const rawText = modelResult.rawText ?? "";

    // Strip accidental markdown fences
    const clean = rawText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    if (!parsed.synonym || !parsed.definition) {
      throw new Error("Claude returned incomplete synonym data");
    }

    return new Response(
      JSON.stringify({ synonym: parsed.synonym, definition: parsed.definition }),
      {
        status:  200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      }
    );
  } catch (err: any) {
    console.error("[retire-word]", err);
    return new Response(
      JSON.stringify({ error: err.message ?? "Synonym generation failed" }),
      {
        status:  500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      }
    );
  }
});
