/**
 * supabase/functions/retire-word/index.ts
 * Lexi-Lens — Phase 1.5: retire-word Edge Function
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

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const { word, definition, childAge } = await req.json();

    if (!word || !definition || !childAge) {
      return new Response(
        JSON.stringify({ error: "Missing word, definition, or childAge" }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

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

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-20250514",
        max_tokens: 200,
        system: `You are a vocabulary curriculum designer for a children's educational game.
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
        messages: [
          {
            role:    "user",
            content: `The child has mastered the word "${word}" (definition: "${definition}").
What is the perfect next-level synonym they should learn? Return JSON only.`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Claude API error ${response.status}: ${errText}`);
    }

    const claudeData = await response.json();
    const rawText = claudeData.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");

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
