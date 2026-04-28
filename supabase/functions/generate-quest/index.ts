/**
 * supabase/functions/generate-quest/index.ts
 * Lexi-Lens — Phase 3.3: AI Quest Generator for Parents
 *
 * POST body:
 *   {
 *     theme:    string   — parent's description, e.g. "ocean creatures" or "kitchen magic"
 *     ageBand:  string   — "5-6" | "7-8" | "9-10" | "11-12"
 *     tier:     string   — "apprentice" | "scholar" | "sage" | "archmage"
 *   }
 *
 * Response:
 *   GeneratedQuest — a complete quest object ready to preview + save
 *
 * Security:
 *   • Requires valid Supabase JWT (parent must be signed in)
 *   • Rate-limited to 10 generations per parent per day via DB check
 */

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── CORS ────────────────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface GenerateRequest {
  theme:   string;
  ageBand: string;
  tier:    string;
}

interface PropertyRequirement {
  word:             string;
  definition:       string;
  evaluationHints:  string;
}

interface GeneratedQuest {
  name:                 string;
  enemy_name:           string;
  enemy_emoji:          string;
  room_label:           string;
  spell_name:           string;
  weapon_emoji:         string;
  spell_description:    string;
  required_properties:  PropertyRequirement[];
}

// ─── Age band vocab guide ─────────────────────────────────────────────────────

const AGE_VOCAB_GUIDE: Record<string, string> = {
  "5-6":   "very simple words (2–3 syllables max). Examples: soft, heavy, rough, shiny, round.",
  "7-8":   "everyday descriptive words. Examples: transparent, flexible, smooth, hollow, magnetic.",
  "9-10":  "intermediate vocabulary. Examples: porous, luminous, rigid, absorbent, reflective.",
  "11-12": "advanced vocabulary. Examples: opaque, malleable, translucent, combustible, conductive.",
};

const TIER_GUIDE: Record<string, string> = {
  apprentice: "straightforward, concrete properties a child can easily verify visually or by touch",
  scholar:    "slightly more abstract properties requiring some observation or thought",
  sage:       "nuanced properties combining two concepts or requiring inference",
  archmage:   "sophisticated, multi-layered properties that challenge advanced readers",
};

// ─── Claude prompt ────────────────────────────────────────────────────────────

function buildPrompt(theme: string, ageBand: string, tier: string): string {
  const vocabGuide = AGE_VOCAB_GUIDE[ageBand] ?? AGE_VOCAB_GUIDE["7-8"];
  const tierGuide  = TIER_GUIDE[tier]         ?? TIER_GUIDE["apprentice"];

  return `You are a creative game designer for Lexi-Lens, a vocabulary RPG for children aged 5–12.
Parents can create custom quests for their children. Your job is to generate one complete quest
based on the parent's theme.

THEME: "${theme}"
CHILD AGE BAND: ${ageBand} years old
DIFFICULTY TIER: ${tier}

VOCABULARY LEVEL: Use ${vocabGuide}
PROPERTY COMPLEXITY: Properties should be ${tierGuide}.

RULES:
- The enemy should relate to the theme creatively (e.g. theme "ocean" → "The Coral Kraken")
- The room should be a fantasy location that fits the theme (e.g. "The Sunken Reef Chamber")
- Each property MUST be something a child can find by looking at real household objects
- The evaluationHints guide the AI evaluator — be specific about what to look for
- All 3 properties must be DIFFERENT aspects (e.g. texture, transparency, shape — not all texture)
- The spell should have a magical name that fits the theme
- Definitions must be simple enough for the child's age band

RESPOND WITH ONLY VALID JSON — no markdown, no explanation, no text outside the JSON object:
{
  "name": "Quest name (e.g. 'The Frost Golem Siege')",
  "enemy_name": "Enemy display name (e.g. 'Frost Golem')",
  "enemy_emoji": "Single emoji that best represents the enemy",
  "room_label": "Fantasy room name (e.g. 'The Glacial Keep')",
  "spell_name": "Magical spell name (e.g. 'Arctic Shatter Beam')",
  "weapon_emoji": "Single emoji for the spell's weapon or effect",
  "spell_description": "One exciting sentence describing the spell (age-appropriate)",
  "required_properties": [
    {
      "word": "vocabulary word",
      "definition": "child-friendly definition matching age band ${ageBand}",
      "evaluationHints": "specific guidance for the AI evaluator on how to verify this property"
    },
    {
      "word": "second vocabulary word",
      "definition": "child-friendly definition",
      "evaluationHints": "specific guidance for evaluation"
    },
    {
      "word": "third vocabulary word",
      "definition": "child-friendly definition",
      "evaluationHints": "specific guidance for evaluation"
    }
  ]
}`;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  try {
    // ── Auth ──────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── Parse body ────────────────────────────────────────
    const body: GenerateRequest = await req.json();
    const { theme, ageBand, tier } = body;

    if (!theme?.trim() || !ageBand || !tier) {
      return new Response(JSON.stringify({ error: "theme, ageBand, and tier are required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    if (theme.trim().length > 200) {
      return new Response(JSON.stringify({ error: "Theme too long (max 200 chars)" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── Rate limit — 10 generations per parent per day ────
    const today = new Date().toISOString().split("T")[0];
    const { count } = await supabase
      .from("quests")
      .select("id", { count: "exact", head: true })
      .eq("created_by", user.id)
      .gte("created_at", `${today}T00:00:00Z`);

    if ((count ?? 0) >= 10) {
      return new Response(JSON.stringify({ error: "Daily quest generation limit reached (10/day). Try again tomorrow!" }), {
        status: 429, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── Call Claude ───────────────────────────────────────
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
        "content-type":      "application/json",
      },
      body: JSON.stringify({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 1200,
        messages:   [{ role: "user", content: buildPrompt(theme.trim(), ageBand, tier) }],
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      throw new Error(`Claude API error ${claudeRes.status}: ${err}`);
    }

    const claudeData = await claudeRes.json();
    const rawText: string = claudeData.content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("");

    // Strip markdown fences if Claude adds them
    const clean = rawText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const quest: GeneratedQuest = JSON.parse(clean);

    // ── Validate shape ────────────────────────────────────
    if (
      !quest.name || !quest.enemy_name || !quest.enemy_emoji ||
      !quest.room_label || !quest.spell_name || !quest.weapon_emoji ||
      !Array.isArray(quest.required_properties) ||
      quest.required_properties.length < 3
    ) {
      throw new Error("Generated quest is missing required fields");
    }

    // Normalise — ensure exactly 3 properties and all fields present
    quest.required_properties = quest.required_properties.slice(0, 3).map((p) => ({
      word:            (p.word            ?? "").trim(),
      definition:      (p.definition      ?? "").trim(),
      evaluationHints: (p.evaluationHints ?? "").trim(),
    }));

    return new Response(JSON.stringify({ quest }), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("[generate-quest]", err);
    return new Response(JSON.stringify({ error: "Failed to generate quest. Please try again." }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
