/**
 * supabase/functions/ensure-daily-quest/index.ts
 * Lexi-Lens — Daily Quest Auto-Provisioner (Session F, v6.4).
 *
 * Idempotent endpoint that ensures today's (UTC) daily_quests row exists. If
 * not, generates a fresh quest via Haiku 4.5 (or falls back to round-robin
 * selection of an existing free quest), links it as today's daily, and
 * returns the quest_id. Concurrent callers converge on the same quest_id via
 * the UNIQUE(quest_date) constraint and ON-CONFLICT recovery.
 *
 * ─── Timezone semantics (CRITICAL) ───────────────────────────────────────────
 *
 * Daily quest rotation is anchored to UTC midnight. This is the only way to
 * make "one global daily quest" actually global — if rotation were tied to
 * local time, two users in different timezones would see different daily
 * quests on the same calendar day. UTC anchoring means every user sees the
 * same quest in the same UTC window. For an IST user (UTC+5:30) the daily
 * quest changes at 05:30 IST each morning; for a US-East user (UTC-5) it
 * changes at 19:00 EST. Both fair, both deterministic.
 *
 * The client's streak system stays on LOCAL time intentionally — a child's
 * "I played today" feeling should match their local calendar, not UTC.
 *
 * ─── Kill switch (Session F follow-up) ───────────────────────────────────────
 *
 * feature_flags.daily_quest_auto_gen_enabled:
 *   'true'  → invoke Haiku, run uniqueness checks, retry up to MAX_RETRIES,
 *             fall back to round-robin only if all attempts collide.
 *   'false' → skip generation entirely, go straight to round-robin from
 *             existing free quests. Still writes daily_quests so "one global"
 *             invariant holds. Use this to halt Haiku spend or to stop new
 *             quest accumulation in the library.
 *
 * Default: 'true'. Flag row inserted by 20260513_daily_quest_auto_gen.sql.
 *
 * ─── Daily quest tier (20260518 follow-up) ───────────────────────────────────
 *
 * feature_flags.daily_quest_min_tier:
 *   'free' (default) → the daily quest is created/selected as a free quest,
 *                       so free-tier accounts can play it. Original behaviour.
 *   'paid'           → the daily quest is created/selected as a paid quest.
 *                       Free accounts no longer see it (RLS-gated out of
 *                       their quest library; the daily banner degrades to
 *                       hidden — selectDailyQuest returns null, no crash).
 *                       Makes the daily quest a 7-day-trial / paid perk.
 *
 * Unknown/garbage flag value falls back to 'free' (fail-open, never writes a
 * tier that violates quests_min_subscription_tier_check). Flag row inserted
 * by 20260518_daily_quest_min_tier_flag.sql. The fallback selector is also
 * constrained to the apprentice tier so flipping to 'paid' cannot surface a
 * hard quest as the gentle daily.
 *
 * ─── Uniqueness check (C3, partial overlap allowed) ──────────────────────────
 *
 *   • enemy_name uniqueness — case-insensitive ILIKE against existing rows.
 *   • required_properties full-set uniqueness — rejects only when ALL
 *     property words match an existing active quest's set. Partial overlap
 *     (1–2 shared words) is allowed per Session F brief.
 *   • Up to MAX_RETRIES retries; on full exhaustion → fallback path.
 *
 * ─── Race handling ───────────────────────────────────────────────────────────
 *
 * daily_quests has UNIQUE(quest_date). On collision (another request beat
 * us between SELECT and INSERT), we look up the winning quest_id and return
 * it. Our just-inserted quest row in `quests` may be orphaned — harmless,
 * it's a public free quest that's safe to leave in the library.
 *
 * DEPLOY:
 *   supabase functions deploy ensure-daily-quest
 */

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CHILD_SAFETY_PREFIX } from "../_shared/childSafety.ts";

// ─── Config ──────────────────────────────────────────────────────────────────

const MAX_RETRIES         = 2;     // Per Session F: 2 retries (3 total attempts)
const DAILY_AGE_BAND      = "7-8"; // Middle-ground vocabulary
const DAILY_TIER          = "apprentice";
const DAILY_PROP_COUNT    = 3;
const DAILY_MIN_AGE_BAND  = "5-6"; // Visibility — accessible to all ages
const MODEL               = "claude-haiku-4-5-20251001";
const MAX_TOKENS          = 1400;
const KILL_SWITCH_FLAG    = "daily_quest_auto_gen_enabled";
// Tier the daily quest is created/selected at. Flag (default 'free') so the
// free-vs-paid daily-quest decision is a one-line SQL flip, not a redeploy —
// same rationale as daily_scan_limit_*. Flip to 'paid' to make the daily
// quest a trial/paid perk. Allowed values mirror quests.min_subscription_tier.
const DAILY_TIER_FLAG     = "daily_quest_min_tier";
const DAILY_TIER_DEFAULT  = "free";
const DAILY_TIER_ALLOWED  = ["free", "paid"] as const;
type DailyMinTier = (typeof DAILY_TIER_ALLOWED)[number];

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

/** UTC anchor — see file header for timezone rationale. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `${CHILD_SAFETY_PREFIX}

You are Lexi-Lens's quest designer. Generate ONE vocabulary-learning quest for
a children's RPG. The child scans a real-world object with their phone camera;
the object must match specific word properties to defeat a fantasy enemy.

Target audience:
  Age band: ${DAILY_AGE_BAND}
  Tier:     ${DAILY_TIER} (the easiest difficulty tier — gentle introduction)

Constraints:
  • EXACTLY ${DAILY_PROP_COUNT} required_properties
  • EXACTLY ${DAILY_PROP_COUNT} hard_mode_properties (parallel array; harder word per slot)
  • Vocabulary words must be tactile, sensory, or visual — easy to verify from
    a photo of a real object (e.g., "smooth", "transparent", "ribbed").
  • AVOID abstract or invisible properties (e.g., "expensive", "old", "useful").
  • Each property's evaluationHints must be 1-2 short sentences guiding a
    vision model to score the property objectively from an image.
  • Enemy name should be 2-3 words, fantasy-themed, kid-friendly.
  • Room label is a short location like "The Crystal Cavern" or "Mossy Glade".
  • Spell name is a 2-3 word incantation matching the quest theme.

Output ONLY valid JSON, no preamble, no markdown:

{
  "name": "Quest title (short and evocative)",
  "enemy_name": "Fantasy enemy name (2-3 words)",
  "enemy_emoji": "Single emoji representing the enemy",
  "room_label": "Short location label",
  "spell_name": "Spell name (2-3 words)",
  "weapon_emoji": "Single emoji for the spell/weapon",
  "spell_description": "1-sentence description of what the spell does",
  "required_properties": [
    { "word": "...", "definition": "Age-appropriate definition.", "evaluationHints": "Short guidance for vision model." }
  ],
  "hard_mode_properties": [
    { "word": "...", "definition": "Age-appropriate definition.", "evaluationHints": "Short guidance for vision model." }
  ]
}`;

const USER_MESSAGE =
  "Generate today's daily quest. Pick a fresh theme appropriate for the age band — " +
  "examples to inspire (don't copy): a friendly woodland critter, a curious sea creature, " +
  "a mischievous sky spirit, a sleepy desert wanderer. Choose ONE theme.";

// ─── Types ───────────────────────────────────────────────────────────────────

interface QuestProperty {
  word:            string;
  definition:      string;
  evaluationHints: string;
}

interface GeneratedQuest {
  name:                 string;
  enemy_name:           string;
  enemy_emoji:          string;
  room_label:           string;
  spell_name:           string;
  weapon_emoji:         string;
  spell_description:    string;
  required_properties:  QuestProperty[];
  hard_mode_properties: QuestProperty[];
}

// ─── Feature flag read ───────────────────────────────────────────────────────

async function readAutoGenEnabled(supabase: SupabaseClient): Promise<boolean> {
  try {
    const { data } = await supabase
      .from("feature_flags")
      .select("value")
      .eq("key", KILL_SWITCH_FLAG)
      .maybeSingle();
    const v = (data as { value?: unknown } | null)?.value;
    // Default true if flag row missing — fail-open so a deploy-before-migrate
    // window doesn't silently disable generation.
    if (typeof v !== "string") return true;
    return v.trim().toLowerCase() !== "false";
  } catch {
    return true;
  }
}

async function readDailyQuestMinTier(supabase: SupabaseClient): Promise<DailyMinTier> {
  try {
    const { data } = await supabase
      .from("feature_flags")
      .select("value")
      .eq("key", DAILY_TIER_FLAG)
      .maybeSingle();
    const v = (data as { value?: unknown } | null)?.value;
    if (typeof v !== "string") return DAILY_TIER_DEFAULT;
    const norm = v.trim().toLowerCase();
    // Fail-safe: an unknown / fat-fingered value falls back to the default
    // rather than writing a tier that violates quests_min_subscription_tier_check.
    return (DAILY_TIER_ALLOWED as readonly string[]).includes(norm)
      ? (norm as DailyMinTier)
      : DAILY_TIER_DEFAULT;
  } catch {
    return DAILY_TIER_DEFAULT;
  }
}

// ─── Haiku call ──────────────────────────────────────────────────────────────

async function generateQuestViaHaiku(apiKey: string): Promise<GeneratedQuest> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: "user", content: USER_MESSAGE }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "(unreadable)");
    throw new Error(`Anthropic ${response.status}: ${errText.slice(0, 200)}`);
  }

  const apiResponse = await response.json() as { content: Array<{ type: string; text?: string }> };
  const raw = apiResponse.content
    .filter(b => b.type === "text")
    .map(b => b.text ?? "")
    .join("");

  const clean = raw.replace(/```json|```/g, "").trim();
  const quest = JSON.parse(clean) as GeneratedQuest;

  // Shape validation
  if (!quest.name || typeof quest.name !== "string") {
    throw new Error("missing or invalid quest.name");
  }
  if (!quest.enemy_name || typeof quest.enemy_name !== "string") {
    throw new Error("missing or invalid quest.enemy_name");
  }
  if (!Array.isArray(quest.required_properties) || quest.required_properties.length === 0) {
    throw new Error("missing or empty required_properties");
  }
  if (!Array.isArray(quest.hard_mode_properties)) {
    quest.hard_mode_properties = [];
  }

  return quest;
}

// ─── Uniqueness checks (C3) ──────────────────────────────────────────────────

async function nameCollides(
  supabase: SupabaseClient,
  enemyName: string,
): Promise<boolean> {
  const { count } = await supabase
    .from("quests")
    .select("id", { count: "exact", head: true })
    .ilike("enemy_name", enemyName.trim());
  return (count ?? 0) > 0;
}

async function propertySetCollides(
  supabase: SupabaseClient,
  candidateProps: QuestProperty[],
): Promise<boolean> {
  const candidateWords = candidateProps
    .map(p => (p.word ?? "").toLowerCase().trim())
    .filter(w => w.length > 0)
    .sort();

  if (candidateWords.length === 0) return false;

  const { data } = await supabase
    .from("quests")
    .select("required_properties")
    .eq("is_active", true);

  if (!data) return false;

  for (const q of data) {
    const existing = Array.isArray((q as { required_properties?: unknown }).required_properties)
      ? (q as { required_properties: Array<{ word?: unknown }> }).required_properties
      : [];

    const existingWords = existing
      .map(p => typeof p?.word === "string" ? p.word.toLowerCase().trim() : "")
      .filter(w => w.length > 0)
      .sort();

    if (existingWords.length !== candidateWords.length) continue;
    if (existingWords.every((w, i) => w === candidateWords[i])) {
      return true; // exact full-set match — reject
    }
  }
  return false;
}

// ─── Fallback: existing free quest, deterministic by UTC day ─────────────────

async function pickFallbackQuest(
  supabase: SupabaseClient,
  minTier:  DailyMinTier,
): Promise<string | null> {
  const { data } = await supabase
    .from("quests")
    .select("id")
    .eq("is_active", true)
    .eq("min_subscription_tier", minTier)
    // Constrain to the apprentice tier regardless of minTier. Without this,
    // flipping the flag to 'paid' would let the fallback surface ANY paid
    // quest (up to archmage) as the gentle "daily" — a sharp difficulty
    // cliff. The 3 curated starters are apprentice, so the free pool is
    // unaffected; the paid pool is correctly limited to easy quests.
    .eq("tier", DAILY_TIER)
    .order("created_at", { ascending: true });

  if (!data || data.length === 0) return null;
  // Deterministic by UTC day-count so all clients converge on the same fallback.
  const dayIndex = Math.floor(Date.now() / 86_400_000) % data.length;
  return (data[dayIndex] as { id: string }).id;
}

// ─── Insert helpers ──────────────────────────────────────────────────────────

async function insertQuest(
  supabase: SupabaseClient,
  q:        GeneratedQuest,
  minTier:  DailyMinTier,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("quests")
    .insert({
      name:                  q.name.trim(),
      enemy_name:            q.enemy_name.trim(),
      enemy_emoji:           q.enemy_emoji,
      room_label:            q.room_label,
      min_age_band:          DAILY_MIN_AGE_BAND,
      min_subscription_tier: minTier,
      required_properties:   q.required_properties,
      hard_mode_properties:  q.hard_mode_properties,
      spell_name:            q.spell_name,
      weapon_emoji:          q.weapon_emoji,
      spell_description:     q.spell_description,
      tier:                  DAILY_TIER,
      sort_order:            8,
      visibility:            "public",
      created_by:            null,
      is_active:             true,
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[ensure-daily-quest] quest insert failed:", error?.message);
    return null;
  }
  return (data as { id: string }).id;
}

async function linkDailyQuest(
  supabase: SupabaseClient,
  questDate: string,
  questId:   string,
): Promise<{ winning_quest_id: string; race: boolean }> {
  const { error } = await supabase
    .from("daily_quests")
    .insert({ quest_date: questDate, quest_id: questId });

  if (!error) return { winning_quest_id: questId, race: false };

  // Unique violation on quest_date → another request won. Read the winner.
  if (error.code === "23505") {
    const { data: winner } = await supabase
      .from("daily_quests")
      .select("quest_id")
      .eq("quest_date", questDate)
      .maybeSingle();
    if (winner?.quest_id) {
      return { winning_quest_id: winner.quest_id as string, race: true };
    }
  }

  console.error("[ensure-daily-quest] daily_quests insert failed:", error.message);
  return { winning_quest_id: questId, race: false };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")    return json({ error: "POST only" }, 405);

  const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")              ?? "";
  const SERVICE_ROLE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")         ?? "";

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json({ error: "missing_supabase_secrets" }, 500);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const today    = todayUtc();

  // ── 1. Fast path: already provisioned for today (UTC) ────────────────────
  const { data: existing } = await supabase
    .from("daily_quests")
    .select("quest_id")
    .eq("quest_date", today)
    .maybeSingle();

  if (existing?.quest_id) {
    return json({
      quest_id:   existing.quest_id,
      generated:  false,
      cached:     true,
      quest_date: today,
    });
  }

  // ── 2. Read kill-switch flag ─────────────────────────────────────────────
  const autoGenEnabled = await readAutoGenEnabled(supabase);
  // Tier the daily quest is created/selected at (flag-driven, default 'free').
  const dailyMinTier   = await readDailyQuestMinTier(supabase);

  // ── 3a. Kill-switch OFF → straight to round-robin fallback ───────────────
  if (!autoGenEnabled) {
    console.log(`[ensure-daily-quest] day=${today} kill-switch=off, using fallback`);
    const fallbackId = await pickFallbackQuest(supabase, dailyMinTier);
    if (!fallbackId) {
      return json({ error: "no_free_quests_available" }, 500);
    }
    const link = await linkDailyQuest(supabase, today, fallbackId);
    return json({
      quest_id:        link.winning_quest_id,
      generated:       false,
      fallback:        true,
      source:          "kill_switch_off",
      race:            link.race,
      quest_date:      today,
    });
  }

  // ── 3b. Kill-switch ON → generate with uniqueness check + retries ────────
  if (!ANTHROPIC_API_KEY) {
    return json({ error: "ANTHROPIC_API_KEY not configured" }, 500);
  }

  let questData: GeneratedQuest | null = null;
  let attempt = 0;
  let lastFailReason = "";

  while (attempt <= MAX_RETRIES) {
    attempt++;
    try {
      const candidate = await generateQuestViaHaiku(ANTHROPIC_API_KEY);

      if (await nameCollides(supabase, candidate.enemy_name)) {
        lastFailReason = `name_collision: "${candidate.enemy_name}"`;
        console.log(`[ensure-daily-quest] attempt ${attempt} ${lastFailReason}`);
        continue;
      }
      if (await propertySetCollides(supabase, candidate.required_properties)) {
        lastFailReason = `property_set_collision`;
        console.log(`[ensure-daily-quest] attempt ${attempt} ${lastFailReason}`);
        continue;
      }

      questData = candidate;
      break;
    } catch (err) {
      lastFailReason = err instanceof Error ? err.message : "unknown";
      console.error(`[ensure-daily-quest] attempt ${attempt} threw: ${lastFailReason}`);
    }
  }

  // ── 4. Fallback if all attempts failed ───────────────────────────────────
  if (!questData) {
    console.warn(
      `[ensure-daily-quest] all ${MAX_RETRIES + 1} attempts failed (${lastFailReason}); ` +
      `falling back to existing free quest`,
    );
    const fallbackId = await pickFallbackQuest(supabase, dailyMinTier);
    if (!fallbackId) {
      return json({ error: "could_not_provision_daily_quest" }, 500);
    }
    const link = await linkDailyQuest(supabase, today, fallbackId);
    return json({
      quest_id:    link.winning_quest_id,
      generated:   false,
      fallback:    true,
      source:      "all_attempts_collided",
      reason:      lastFailReason,
      race:        link.race,
      quest_date:  today,
    });
  }

  // ── 5. Insert quest + link as today's daily ──────────────────────────────
  const newQuestId = await insertQuest(supabase, questData, dailyMinTier);
  if (!newQuestId) {
    return json({ error: "quest_insert_failed" }, 500);
  }

  const link = await linkDailyQuest(supabase, today, newQuestId);

  console.log(
    `[ensure-daily-quest] day=${today} attempts=${attempt} ` +
    `quest="${questData.name}" enemy="${questData.enemy_name}" ` +
    `props=[${questData.required_properties.map(p => p.word).join(",")}] ` +
    `quest_id=${newQuestId} race=${link.race}`,
  );

  return json({
    quest_id:   link.winning_quest_id,
    generated:  !link.race,
    attempts:   attempt,
    race:       link.race,
    quest_date: today,
  });
});
