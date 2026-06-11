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
import { getModelAdapter } from "../_shared/models/index.ts";
import { TAXONOMY } from "../_shared/vocabularyTaxonomy.ts";

// ─── Config ──────────────────────────────────────────────────────────────────

// MAX_RETRIES (Session F) superseded by STRICT_ATTEMPTS + RELAX_ATTEMPTS below.
const DAILY_AGE_BAND      = "7-8"; // Middle-ground vocabulary
const DAILY_TIER          = "apprentice";
const DAILY_PROP_COUNT    = 3;
const DAILY_MIN_AGE_BAND  = "5-6"; // Visibility — accessible to all ages
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

// ─── Word-rotation window (ask #4: "dailies not matching words for 10 days") ──
// The daily must not reuse ANY property word that appeared in a daily within
// the last N days. Flag-driven so the window is a one-line SQL change, never a
// redeploy. Defaults: 10-day window, 0 shared words allowed (strict).
//
//   daily_quest_word_window     → integer days to look back (default 10)
//   daily_quest_max_shared_words→ words allowed to overlap the window (default 0)
//
// Feasibility (checked against the 7-8 taxonomy, 45 words / 6 axes): 10 disjoint
// dailies need 30 distinct words — packs cleanly with ~15 to spare, leaning on
// the color axis (most headroom). So strict 0-overlap over 10 days is sound; the
// risk is purely generation reliability, handled by (a) feeding the window's
// words into the prompt as an avoid-list and (b) a relaxation ladder below.
const WORD_WINDOW_FLAG       = "daily_quest_word_window";
const WORD_WINDOW_DEFAULT    = 10;
const MAX_SHARED_FLAG        = "daily_quest_max_shared_words";
const MAX_SHARED_DEFAULT     = 0;
// Strict attempts before the relaxation ladder kicks in. After STRICT_ATTEMPTS
// collisions we bump the allowed-overlap by 1 each further attempt rather than
// dropping straight to the recycled-daily fallback — a daily with one shared
// word beats replaying last week's daily wholesale.
const STRICT_ATTEMPTS        = 4;
const RELAX_ATTEMPTS         = 2;

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

// Build the axis-grouped word pool for the daily's age band from the shared
// taxonomy. This is the breadth the daily prompt previously LACKED — without a
// word pool the model kept regenerating the same sensory trio and colliding.
const DAILY_TAX = TAXONOMY[DAILY_AGE_BAND] ?? TAXONOMY["7-8"];
const DAILY_AXIS_POOL = DAILY_TAX.axes
  .map((a) => `    - ${a.name}: ${a.words.join(", ")}`)
  .join("\n");

const SYSTEM_PROMPT = `${CHILD_SAFETY_PREFIX}

You are Lexi-Lens's quest designer. Generate ONE vocabulary-learning quest for
a children's RPG. The child scans a real-world object with their phone camera;
the object must match specific word properties to defeat a fantasy enemy.

Target audience:
  Age band: ${DAILY_AGE_BAND}
  Tier:     ${DAILY_TIER} (the easiest difficulty tier — gentle introduction)

Constraints:
  • EXACTLY ${DAILY_PROP_COUNT} required_properties
  • EXACTLY ${DAILY_PROP_COUNT} hard_mode_properties (parallel array, one per
    required property, SAME index = SAME object must satisfy both).
    Each hard_mode word must be GENUINELY HARDER than its required-property
    counterpart, describing the SAME physical attribute of the SAME object —
    NOT a lateral swap to a different easy word.
      ✓ CORRECT (harder word, same property):
          required "shiny"   → hard "reflective"   (same surface quality, richer word)
          required "round"   → hard "spherical"    (same shape, more precise word)
          required "see-through"/"transparent" → hard "translucent"
          required "smooth"  → hard "polished"
      ✗ WRONG (lateral — a different easy property, NOT harder):
          required "shiny"   → hard "blue"   ← different attribute, no harder
          required "round"   → hard "small"  ← different attribute
      The hard word should stretch the child's vocabulary for the property they
      already found — a word they likely don't know yet but can learn from the
      same object. Stay within an 8-12-year-old reading level; never invent
      pseudo-technical words for a young child.
  • Choose vocabulary words FROM these perceptual axes (or close synonyms):
${DAILY_AXIS_POOL}
  • VARIETY RULE: draw the ${DAILY_PROP_COUNT} properties from DIFFERENT axes
    (e.g. one color + one shape + one texture), NOT three words from the same
    axis. Mixing axes keeps daily quests feeling fresh and teaches broader
    vocabulary. Pick a different combination than an obvious one.
  • All words must be easy to verify from a photo of a real object.
  • AVOID abstract or invisible properties (e.g., "expensive", "old", "useful",
    "magnetic", "warm" — anything a camera cannot see).
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
    { "word": "...", "definition": "Age-appropriate definition.", "evaluationHints": "Short guidance for vision model.", "phonetic": "IPA in slashes, General American, e.g. /smuːð/. Be accurate." }
  ],
  "hard_mode_properties": [
    { "word": "...", "definition": "Age-appropriate definition.", "evaluationHints": "Short guidance for vision model.", "phonetic": "IPA in slashes, General American, e.g. /rɪˈflɛktɪv/. Be accurate." }
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
  phonetic?:       string;
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

/** Read a non-negative integer feature flag; fall back to `def` on any problem. */
async function readIntFlag(
  supabase: SupabaseClient,
  key: string,
  def: number,
): Promise<number> {
  try {
    const { data } = await supabase
      .from("feature_flags")
      .select("value")
      .eq("key", key)
      .maybeSingle();
    const v = (data as { value?: unknown } | null)?.value;
    const n = typeof v === "string" ? parseInt(v.trim(), 10) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : def;
  } catch {
    return def;
  }
}

// ─── Model call (provider via factory; default anthropic = unchanged) ────────

async function generateQuestViaModel(
  supabase:   SupabaseClient,
  avoidNames: string[] = [],
  avoidWords: string[] = [],
): Promise<GeneratedQuest> {
  // Wired to the shared factory for consistency with the other model-calling
  // functions. Default stays 'anthropic' (Haiku) via the seed migration —
  // this is a ~1-call/day-globally function, so cost is irrelevant; the only
  // goal here is that no function is left on a raw hardcoded fetch (avoids
  // the next "wait, is this one dynamic?" surprise). Flip the flag if ever
  // desired, but there is no cost reason to.
  //
  // avoidNames: recent-daily enemy names + names already tried this run. Fed
  // into the prompt so each (re)generation steers AWAY from collisions.
  // Without this, a low-diversity model returns the same enemy name on every
  // retry and all attempts collide → fallback (the 2026-06 repeating-daily bug).
  //
  // avoidWords: every property word used by a daily inside the rotation window
  // (ask #4). Steering the model away from these up front is what keeps the
  // strict 0-overlap rule cheap — the model picks fresh words on attempt #1
  // instead of us reject-and-retrying into the fallback.
  const avoidClause = avoidNames.length
    ? ` Do NOT use any of these enemy names — they were used recently or just ` +
      `attempted and rejected: ${avoidNames.map((n) => `"${n}"`).join(", ")}. ` +
      `Invent a clearly different enemy name and theme.`
    : "";

  const wordClause = avoidWords.length
    ? ` Do NOT use any of these property words — they appeared in recent daily ` +
      `quests and must rotate out: ${avoidWords.map((w) => `"${w}"`).join(", ")}. ` +
      `Choose entirely different words from the perceptual axes above.`
    : "";

  const adapter = await getModelAdapter("generate-quest", supabase);
  const result  = await adapter.call({
    systemPrompt: SYSTEM_PROMPT,
    userText:     USER_MESSAGE + avoidClause + wordClause,
    maxTokens:    MAX_TOKENS,
    jsonMode:     true,
  });

  const raw   = result.rawText ?? "";
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

// How many recent daily quests to de-duplicate against. A property set OR enemy
// name that last appeared > RECENT_DAILY_WINDOW days ago is allowed to recur —
// spaced repetition is GOOD for vocabulary retention, and a kid won't recall an
// enemy from weeks ago. Scoping to recent dailies (not the whole quest library)
// keeps generation robust as the library grows: a daily sharing a name/property
// set with some parent-created quest the child never sees is harmless.
const RECENT_DAILY_WINDOW = 14;

// Fetch the last N daily quests with their linked quest's enemy_name +
// required_properties in one query. Shared by both uniqueness checks so the
// daily de-dupes against the same recent window for names and property sets.
async function fetchRecentDailyQuests(
  supabase: SupabaseClient,
): Promise<Array<{ enemy_name: string; required_properties: Array<{ word?: unknown }> }>> {
  const { data } = await supabase
    .from("daily_quests")
    .select("quest_id, quests:quest_id ( enemy_name, required_properties )")
    .order("quest_date", { ascending: false })
    .limit(RECENT_DAILY_WINDOW);

  if (!data) return [];

  return data.map((row) => {
    const joined = (row as { quests?: unknown }).quests;
    const q = (Array.isArray(joined) ? joined[0] : joined) as
      { enemy_name?: unknown; required_properties?: unknown } | undefined;
    return {
      enemy_name: typeof q?.enemy_name === "string" ? q.enemy_name : "",
      required_properties: Array.isArray(q?.required_properties)
        ? (q!.required_properties as Array<{ word?: unknown }>)
        : [],
    };
  });
}

async function nameCollides(
  supabase: SupabaseClient,
  enemyName: string,
): Promise<boolean> {
  const candidate = enemyName.trim().toLowerCase();
  if (!candidate) return false;

  // Scope to recent dailies only (not the whole quests library). Prevents the
  // daily from repeating an enemy name seen in the last RECENT_DAILY_WINDOW
  // dailies, while allowing reuse of names that only exist on parent-created
  // quests (never shown as a daily) or on dailies older than the window.
  const recent = await fetchRecentDailyQuests(supabase);
  return recent.some((q) => q.enemy_name.trim().toLowerCase() === candidate);
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

  // Plan A: scope the uniqueness check to the LAST RECENT_DAILY_WINDOW daily
  // quests only — NOT the entire active-quest library. The daily does not need
  // a globally-unique property set; it only needs to differ from quests the
  // child has seen as a daily recently. Reusing a set that some parent-created
  // library quest happens to use is fine — the child never sees that quest.
  const recent = await fetchRecentDailyQuests(supabase);

  for (const q of recent) {
    const existingWords = q.required_properties
      .map(p => typeof p?.word === "string" ? p.word.toLowerCase().trim() : "")
      .filter(w => w.length > 0)
      .sort();

    if (existingWords.length !== candidateWords.length) continue;
    if (existingWords.every((w, i) => w === candidateWords[i])) {
      return true; // exact set repeats a RECENT daily — reject, regenerate
    }
  }
  return false;
}

// ─── Word-rotation window (ask #4) ───────────────────────────────────────────

/** Lowercased property words used by dailies within the last `windowDays`. */
async function wordsInRecentWindow(
  supabase:   SupabaseClient,
  windowDays: number,
): Promise<Set<string>> {
  const cutoff = new Date(Date.now() - windowDays * 86_400_000)
    .toISOString().slice(0, 10);

  const { data } = await supabase
    .from("daily_quests")
    .select("quest_date, quests:quest_id ( required_properties )")
    .gte("quest_date", cutoff)
    .order("quest_date", { ascending: false });

  const words = new Set<string>();
  for (const row of data ?? []) {
    const joined = (row as { quests?: unknown }).quests;
    const q = (Array.isArray(joined) ? joined[0] : joined) as
      { required_properties?: unknown } | undefined;
    const props = Array.isArray(q?.required_properties)
      ? (q!.required_properties as Array<{ word?: unknown }>) : [];
    for (const p of props) {
      if (typeof p?.word === "string") {
        const w = p.word.toLowerCase().trim();
        if (w) words.add(w);
      }
    }
  }
  return words;
}

/** How many of the candidate's words already appeared in the window. */
function wordOverlapCount(
  candidateProps: QuestProperty[],
  windowWords:    Set<string>,
): number {
  let n = 0;
  for (const p of candidateProps) {
    const w = (p.word ?? "").toLowerCase().trim();
    if (w && windowWords.has(w)) n++;
  }
  return n;
}

// ─── Fallback: most-recent generated daily (never recycle library quest) ─────

async function pickFallbackQuest(
  supabase:  SupabaseClient,
  _minTier:  DailyMinTier,
): Promise<string | null> {
  // 20260604 fork decision: NEVER reuse a curated library quest as the daily.
  // On total generation failure (rare after the avoid-list fix), reuse the most
  // recent PREVIOUSLY-GENERATED daily (is_daily = true) so a daily is still
  // present without polluting the curated library. If none exists yet (only on
  // a brand-new DB whose very first generation also failed), return null — the
  // caller 500s and the client's local round-robin covers display. _minTier is
  // unused: a past generated daily already carries the correct tier.
  const { data } = await supabase
    .from("quests")
    .select("id")
    .eq("is_active", true)
    .eq("is_daily", true)
    .eq("tier", DAILY_TIER)
    .order("created_at", { ascending: false })
    .limit(1);

  if (!data || data.length === 0) return null;
  return (data[0] as { id: string }).id;
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
      is_daily:              true,   // 20260604: keep generated dailies out of the curated library
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
  // Provider creds are owned by the model factory now; no hard ANTHROPIC
  // key requirement here (the factory falls back across providers).

  let questData: GeneratedQuest | null = null;
  let attempt = 0;
  let lastFailReason = "";

  // Read the rotation window + strictness (flag-driven, ask #4).
  const windowDays  = await readIntFlag(supabase, WORD_WINDOW_FLAG, WORD_WINDOW_DEFAULT);
  const baseMaxShared = await readIntFlag(supabase, MAX_SHARED_FLAG, MAX_SHARED_DEFAULT);
  const windowWords = await wordsInRecentWindow(supabase, windowDays);

  // Seed the avoid-list with recent dailies' enemy names so generation steers
  // clear of collisions from attempt #1, then grow it with every name we try.
  const recentDailies = await fetchRecentDailyQuests(supabase);
  const avoidNames: string[] = recentDailies
    .map((q) => q.enemy_name)
    .filter((n) => n.trim().length > 0);

  // Words used inside the window are fed into the prompt so the model picks
  // fresh vocabulary up front (cheap) rather than us reject-and-retrying.
  const avoidWords = [...windowWords];

  // Relaxation ladder: STRICT_ATTEMPTS at baseMaxShared (default 0 → zero word
  // overlap across the window), then RELAX_ATTEMPTS that loosen the allowed
  // overlap by 1 each, so a daily with one shared word still beats replaying an
  // old daily. Total budget = STRICT_ATTEMPTS + RELAX_ATTEMPTS.
  const totalAttempts = STRICT_ATTEMPTS + RELAX_ATTEMPTS;

  while (attempt < totalAttempts) {
    const relaxStep   = Math.max(0, attempt - STRICT_ATTEMPTS + 1);
    const maxShared   = baseMaxShared + (attempt >= STRICT_ATTEMPTS ? relaxStep : 0);
    attempt++;
    try {
      const candidate = await generateQuestViaModel(supabase, avoidNames, avoidWords);

      if (await nameCollides(supabase, candidate.enemy_name)) {
        lastFailReason = `name_collision: "${candidate.enemy_name}"`;
        console.log(`[ensure-daily-quest] attempt ${attempt} ${lastFailReason}`);
        avoidNames.push(candidate.enemy_name); // never offer it again this run
        continue;
      }
      if (await propertySetCollides(supabase, candidate.required_properties)) {
        lastFailReason = `property_set_collision`;
        console.log(`[ensure-daily-quest] attempt ${attempt} ${lastFailReason}`);
        avoidNames.push(candidate.enemy_name);
        continue;
      }
      const overlap = wordOverlapCount(candidate.required_properties, windowWords);
      if (overlap > maxShared) {
        lastFailReason =
          `word_window_overlap: ${overlap} shared > ${maxShared} allowed ` +
          `(window=${windowDays}d)`;
        console.log(`[ensure-daily-quest] attempt ${attempt} ${lastFailReason}`);
        // Push the colliding words into the avoid-list so the next attempt
        // actively rotates them out.
        for (const p of candidate.required_properties) {
          const w = (p.word ?? "").toLowerCase().trim();
          if (w && windowWords.has(w) && !avoidWords.includes(w)) avoidWords.push(w);
        }
        avoidNames.push(candidate.enemy_name);
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
      `[ensure-daily-quest] all ${totalAttempts} attempts failed (${lastFailReason}); ` +
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
