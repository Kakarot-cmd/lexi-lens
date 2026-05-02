/**
 * supabase/functions/export-word-tome/index.ts
 * Lexi-Lens — Phase 2.6: Word Tome PDF Export
 *
 * POST /functions/v1/export-word-tome
 *
 * WHY AN EDGE FUNCTION:
 *   All word_tome, child_profiles, and quest_completions data is protected
 *   by RLS — only the authenticated parent can read their own children's data.
 *   This EF uses the service role to bypass RLS after verifying the caller's
 *   JWT, ensuring the parent can only ever export data for their own children.
 *   Additionally, the Claude AI portfolio summary is generated server-side so
 *   ANTHROPIC_API_KEY never touches the device.
 *
 * REQUEST BODY:
 *   { childId: string }
 *
 * RESPONSE:
 *   {
 *     child:        ChildProfile,
 *     words:        WordTomeEntry[],
 *     quests:       QuestCompletion[],
 *     summary:      string,      // Claude-generated portfolio summary
 *     generatedAt:  string,      // ISO 8601
 *   }
 *
 * REQUIRES:
 *   Authorization: Bearer <user_jwt>   (standard Supabase auth header —
 *                                       supabase.functions.invoke() sends
 *                                       this automatically)
 *
 * SECRETS:
 *   SUPABASE_URL              — injected automatically by Supabase runtime
 *   SUPABASE_ANON_KEY         — injected automatically by Supabase runtime
 *   SUPABASE_SERVICE_ROLE_KEY — injected automatically by Supabase runtime
 *   ANTHROPIC_API_KEY         — already set (shared with evaluate + retire-word)
 *
 * DEPLOY:
 *   supabase functions deploy export-word-tome --no-verify-jwt
 *   (JWT is verified manually inside the function using auth.getUser())
 *
 * MODEL CHOICE:
 *   claude-haiku-4-5-20251001 — same as retire-word. Fast and cheap; the
 *   portfolio summary is a simple 2-sentence generation, not a complex eval.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Constants ────────────────────────────────────────────────────────────────

const ANTHROPIC_API_URL  = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION  = "2023-06-01";
const MODEL              = "claude-haiku-4-5-20251001";

// ─── CORS ─────────────────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
} as const;

// ─── Helper: JSON response ────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChildProfile {
  id:           string;
  display_name: string;
  age_band:     string;
  level:        number;
  total_xp:     number;
  avatar_key:   string | null;
}

interface WordTomeEntry {
  word:            string;
  definition:      string;
  exemplar_object: string;
  times_used:      number;
  first_used_at:   string;
  last_used_at:    string;
  mastery_score:   number | null;
  is_retired:      boolean | null;
}

interface QuestCompletion {
  total_xp:      number;
  attempt_count: number;
  completed_at:  string;
  quests: {
    name:        string;
    enemy_emoji: string;
    tier:        string;
  } | null;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {

  // Preflight
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")    return json({ error: "POST only." }, 405);

  // ── 1. Parse body ──────────────────────────────────────────────────────────
  let body: { childId?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }

  const childId = body.childId;
  if (!childId || typeof childId !== "string") {
    return json({ error: "'childId' is required and must be a string." }, 400);
  }

  // ── 2. Authenticate caller ─────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json({ error: "Authorization header missing or malformed." }, 401);
  }

  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      global: { headers: { Authorization: authHeader } },
      auth:   { autoRefreshToken: false, persistSession: false },
    }
  );

  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) {
    return json({ error: "Invalid or expired session. Please sign in again." }, 401);
  }

  const parentId = user.id;

  // ── 3. Service-role client for data queries ────────────────────────────────
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // ── 4. Verify the child belongs to this parent ─────────────────────────────
  //      This is the security gate — a parent cannot export another family's data.
  const { data: childData, error: childErr } = await admin
    .from("child_profiles")
    .select("id, display_name, age_band, level, total_xp, avatar_key")
    .eq("id", childId)
    .eq("parent_id", parentId)
    .single();

  if (childErr || !childData) {
    // Either the child doesn't exist OR belongs to a different parent.
    // Return 403, not 404 — don't leak whether the ID exists at all.
    return json({ error: "Child not found or access denied." }, 403);
  }

  const child = childData as ChildProfile;

  // ── 5. Fetch Word Tome ─────────────────────────────────────────────────────
  //      Ordered by first_used_at asc so the PDF tells the child's story
  //      chronologically — first word first, most recent last.
  const { data: wordsData, error: wordsErr } = await admin
    .from("word_tome")
    .select("word, definition, exemplar_object, times_used, first_used_at, last_used_at, mastery_score, is_retired")
    .eq("child_id", childId)
    .order("first_used_at", { ascending: true });

  if (wordsErr) {
    console.error("[export-word-tome] word_tome fetch error:", wordsErr.message);
    return json({ error: "Failed to fetch Word Tome data." }, 500);
  }

  const words: WordTomeEntry[] = wordsData ?? [];

  // ── 6. Fetch Quest Completions ─────────────────────────────────────────────
  //      Cap at 30 most recent — enough for a useful history section.
  const { data: questsData, error: questsErr } = await admin
    .from("quest_completions")
    .select("total_xp, attempt_count, completed_at, quests(name, enemy_emoji, tier)")
    .eq("child_id", childId)
    .order("completed_at", { ascending: false })
    .limit(30);

  if (questsErr) {
    // Non-fatal — export without quest history rather than failing entirely
    console.warn("[export-word-tome] quest_completions fetch warn:", questsErr.message);
  }

  const quests: QuestCompletion[] = (questsData ?? []) as QuestCompletion[];

  // ── 7. Generate AI portfolio summary ──────────────────────────────────────
  const summary = await generatePortfolioSummary(child, words, quests);

  // ── 8. Return assembled portfolio data ────────────────────────────────────
  return json({
    child,
    words,
    quests,
    summary,
    generatedAt: new Date().toISOString(),
  });
});

// ─── Claude AI: Portfolio summary generator ───────────────────────────────────

/**
 * Asks Claude haiku to write a warm, teacher-facing portfolio summary.
 *
 * Input context:
 *   • Child's name, age band, and level
 *   • Total word count + a sample of recently learned words
 *   • Number of quests completed + total XP
 *   • Mastery tier distribution (how many Expert / Proficient / etc.)
 *
 * Output: 2–3 sentence plain-text paragraph, no markdown.
 *
 * Fails silently — if Claude is unavailable, a graceful fallback is returned.
 * This ensures the export always succeeds even during Anthropic API disruptions.
 */
async function generatePortfolioSummary(
  child:  ChildProfile,
  words:  WordTomeEntry[],
  quests: QuestCompletion[]
): Promise<string> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    console.warn("[export-word-tome] ANTHROPIC_API_KEY not set — using fallback summary.");
    return buildFallbackSummary(child, words, quests);
  }

  try {
    // Build mastery stats for the prompt
    const expertCount     = words.filter(w => (w.mastery_score ?? 0) >= 0.80).length;
    const proficientCount = words.filter(w => { const s = w.mastery_score ?? 0; return s >= 0.60 && s < 0.80; }).length;
    const retiredCount    = words.filter(w => w.is_retired).length;

    // Pick a sample of interesting words for Claude to mention
    // Prefer Expert-tier words since they're the proudest achievements
    const starWords = words
      .filter(w => (w.mastery_score ?? 0) >= 0.60)
      .slice(-5)
      .map(w => `"${w.word}"`)
      .join(", ");

    const recentWords = words
      .slice(-5)
      .map(w => `"${w.word}"`)
      .join(", ");

    const totalXp = quests.reduce((sum, q) => sum + (q.total_xp ?? 0), 0);

    const prompt = `You are writing a short vocabulary portfolio summary for a teacher or parent to receive as a PDF.

CHILD INFO:
- Name: ${child.display_name}
- Age band: ${child.age_band} years
- Level: ${child.level}
- Total XP earned: ${totalXp}

VOCABULARY PROGRESS:
- Total words mastered: ${words.length}
- Expert tier (≥80% mastery): ${expertCount} words
- Proficient tier (60–79%): ${proficientCount} words
- Words retired to harder synonyms: ${retiredCount}
- Expert/proficient sample: ${starWords || "none yet"}
- Most recently learned: ${recentWords || "none yet"}
- Quests completed: ${quests.length}

Write 2 sentences:
1. A warm, specific observation about this child's vocabulary journey (mention a word or two by name if possible).
2. An encouraging note about their progress trajectory for the teacher/parent.

Rules:
- Plain text only. No markdown, no bullet points, no quotes.
- Professional but warm tone — like a thoughtful teacher writing a report card comment.
- Be specific to THIS child's data, not generic.
- Max 60 words total.`;

    const response = await fetch(ANTHROPIC_API_URL, {
      method:  "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: 150,
        messages:   [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      console.warn("[export-word-tome] Claude API returned", response.status);
      return buildFallbackSummary(child, words, quests);
    }

    const data = await response.json();
    const text = data?.content?.[0]?.text ?? "";

    // Trim and clean — remove any stray quotes or leading/trailing whitespace
    return text.trim().replace(/^["']|["']$/g, "");

  } catch (err) {
    console.warn("[export-word-tome] Claude summary failed:", err);
    return buildFallbackSummary(child, words, quests);
  }
}

/**
 * Deterministic fallback summary when Claude is unavailable.
 * Always returns something coherent — the export must never fail just
 * because the AI summary step couldn't complete.
 */
function buildFallbackSummary(
  child:  ChildProfile,
  words:  WordTomeEntry[],
  quests: QuestCompletion[]
): string {
  const expertCount = words.filter(w => (w.mastery_score ?? 0) >= 0.80).length;
  const recent      = words.slice(-2).map(w => w.word).join(" and ");

  if (words.length === 0) {
    return `${child.display_name} is just beginning their vocabulary journey with Lexi-Lens RPG. Every great lexicon starts with the first word — exciting progress is ahead.`;
  }

  const masteryNote = expertCount > 0
    ? `${expertCount} word${expertCount > 1 ? "s" : ""} have reached Expert mastery`
    : "vocabulary is growing steadily with each session";

  return `${child.display_name} has built a vocabulary of ${words.length} words through hands-on AR scanning sessions, with ${masteryNote}. ${recent ? `Most recently, they added "${recent}" to their collection, showing` : "Their consistent engagement shows"} strong vocabulary development across ${quests.length} completed quest${quests.length !== 1 ? "s" : ""}.`;
}
