/**
 * supabase/functions/evaluate/evaluateObject.ts
 * Lexi-Lens — model call + result composition (v6.0)
 *
 * v6.0 (2026-05-10): Cache v6 + Mistral primary
 *   • Per-property output now includes kid_msg.{young,older} and optional
 *     nudge.{young,older}. Replaces the v5 top-level childFeedback +
 *     nudgeHint that the model produced as a single string for the whole
 *     scan.
 *   • childFeedback is composed at the Edge Function layer from per-
 *     property kid_msg strings. Same composition function runs for both
 *     cache-only paths (full hit) and model-call paths (full or partial
 *     miss). Cache hits no longer fall back to templated "You found
 *     something X!" feedback — they get real kid voice from the cache.
 *   • Quest flavor template (quests.feedback_flavor_template) is appended
 *     to passing childFeedback. Surfaces quest atmosphere without putting
 *     questId in the cache key.
 *   • MAX_TOKENS raised 700 → 900 to accommodate the extra strings on
 *     6-property scans without truncating.
 *   • EvaluationResult public shape preserved (properties: PropertyScore[]
 *     with verdict-only fields). The v6 strings are stripped before the
 *     final result returns to callers — they're internal to composition.
 *
 * v5.2.1 — Per-label resolved-name cache integration
 * v5.2   — Per-property cache integration
 * v5.1   — Model provider abstraction (adapter argument)
 * v4.7   — CHILD_SAFETY_PREFIX
 * v1.6.1 — dead-code OR in xpAwarded
 * v1.6   — Negative phrase + contradiction validation
 * v1.5   — Mastery-aware system prompt
 */

// ─── Imports ──────────────────────────────────────────────────────────────────

import { CHILD_SAFETY_PREFIX } from "../_shared/childSafety.ts";
import { ModelCallError }      from "../_shared/models/types.ts";
import type { ModelAdapter }   from "../_shared/models/types.ts";

// ─── Types — public shape (unchanged for backward compat) ────────────────────

export interface PropertyRequirement {
  word:             string;
  definition:       string;
  evaluationHints?: string;
}

export interface PropertyScore {
  word:      string;
  score:     number;
  reasoning: string;
  passes:    boolean;
}

export interface EvaluationResult {
  resolvedObjectName: string;
  properties:         PropertyScore[];
  overallMatch:       boolean;
  childFeedback:      string;
  nudgeHint?:         string | null;
  xpAwarded:          number;
}

// ─── Types — v6 internal shape (kid_msg, nudge per property) ─────────────────

export type AgeBand = "young" | "older";

export interface AgeBandedString {
  young: string;
  older: string;
}

/**
 * v6 per-property cache record. The model produces this; the Edge Function
 * caches it; composeFinalResult derives the public-facing EvaluationResult
 * from arrays of these.
 */
export interface PropertyScoreV6 {
  word:      string;
  score:     number;
  reasoning: string;
  passes:    boolean;
  /** Age-banded kid-voice message. Required on every property. */
  kid_msg:   AgeBandedString;
  /** Age-banded nudge. Only set on FAIL+failedAttempts>=2; null otherwise. */
  nudge:     AgeBandedString | null;
}

/** The age-band selector. childAge < 8 → young; >= 8 → older. */
export function ageBandFor(childAge: number): AgeBand {
  return childAge < 8 ? "young" : "older";
}

// ─── v1.5: Mastery profile types ─────────────────────────────────────────────

export type MasteryTier = "novice" | "developing" | "proficient" | "expert";

export interface MasteryEntry {
  word:        string;
  definition:  string;
  mastery:     number;
  masteryTier: MasteryTier;
  timesUsed:   number;
}

export interface XpRates {
  firstTry:  number;
  secondTry: number;
  thirdPlus: number;
}

export interface EvaluateObjectOptions {
  detectedLabel:      string;
  confidence:         number;
  frameBase64?:       string | null;
  /** Properties to evaluate this turn (cache misses only on partial-hit calls). */
  requiredProperties: PropertyRequirement[];
  childAge:           number;
  failedAttempts?:    number;
  questName?:         string;
  /** Per-quest atmospheric suffix; appended on passing childFeedback. */
  questFlavorTemplate?: string | null;
  masteryProfile?:    MasteryEntry[];
  alreadyFoundWords?: string[];
  /** v6 cache hits passed through to compose with fresh model output. */
  previouslyEvaluatedProperties?: PropertyScoreV6[];
  xpRates?:           XpRates;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const PROPERTY_PASS_THRESHOLD = 0.7;
export const CONTRADICTION_THRESHOLD = 0.7;
export const CONTRADICTION_CAP       = 0.55;
export const XP_FIRST_TRY            = 40;
export const XP_SECOND_TRY           = 25;
export const XP_THIRD_PLUS           = 10;

/** v6.0: raised from 700 to accommodate per-property kid_msg + nudge. */
export const MAX_TOKENS              = 900;

// ─── v1.6: Negative phrase validation ────────────────────────────────────────

export const NEGATIVE_PHRASES: string[] = [
  "does not", "doesn't", "do not", "don't",
  "is not", "isn't", "are not", "aren't",
  "will not", "won't", "cannot", "can't",
  "would not", "wouldn't", "could not", "couldn't",
  "should not", "shouldn't",
  "has no", "have no", "had no",
  "no evidence", "not evident", "not present",
  "not applicable", "not qualify", "not qualif",
  "fails to", "fail to", "failed to",
  "lacks", "lack ", "lacking",
  "not flexible", "not rigid", "not fragile", "not durable",
  "not translucent", "not transparent", "not opaque",
  "not smooth", "not rough",
];

export const HEDGING_PHRASES: string[] = [
  "somewhat", "slightly", "a bit", "a little", "kind of",
  "sort of", "barely", "marginally", "weakly", "loosely",
];

function validatePropertyV6(prop: PropertyScoreV6): PropertyScoreV6 {
  const reasoning = (prop.reasoning ?? "").toLowerCase();

  // Trust the model when score >= 0.7.
  if (prop.score < PROPERTY_PASS_THRESHOLD) {
    const hardMatch = NEGATIVE_PHRASES.find((phrase) => reasoning.includes(phrase));
    if (hardMatch) {
      return { ...prop, score: 0.0, passes: false };
    }
  }

  // Hedging cap.
  if (prop.score >= CONTRADICTION_THRESHOLD) {
    const hedgeMatch = HEDGING_PHRASES.find((phrase) => reasoning.includes(phrase));
    if (hedgeMatch) {
      const cappedScore = Math.min(prop.score, CONTRADICTION_CAP);
      return {
        ...prop,
        score:  cappedScore,
        passes: cappedScore >= PROPERTY_PASS_THRESHOLD,
      };
    }
  }

  return prop;
}

export function applyNegativePhraseValidationV6(
  properties: PropertyScoreV6[],
): { properties: PropertyScoreV6[]; overallMatch: boolean } {
  const corrected    = properties.map(validatePropertyV6);
  const overallMatch = corrected.some((p) => p.passes);
  return { properties: corrected, overallMatch };
}

// ─── XP calculation ──────────────────────────────────────────────────────────

export function computeXp(opts: {
  overallMatch:   boolean;
  properties:     ReadonlyArray<{ passes: boolean }>;
  failedAttempts: number;
  xpRates?:       XpRates;
}): number {
  const rates = opts.xpRates ?? {
    firstTry:  XP_FIRST_TRY,
    secondTry: XP_SECOND_TRY,
    thirdPlus: XP_THIRD_PLUS,
  };

  const passingCount = opts.properties.filter((p) => p.passes).length;
  const multiBonus   = passingCount >= 3 ? 2.0 : passingCount === 2 ? 1.5 : 1.0;

  const baseXp = opts.overallMatch
    ? opts.failedAttempts === 0 ? rates.firstTry
    : opts.failedAttempts === 1 ? rates.secondTry
    : rates.thirdPlus
    : 0;

  return opts.overallMatch
    ? Math.round(baseXp * passingCount * multiBonus)
    : 0;
}

// ─── Compose: childFeedback from per-property kid_msgs ───────────────────────

const FALLBACK_PASS_FEEDBACK = "Nice find!";
const FALLBACK_FAIL_FEEDBACK = "Hmm, not quite — try a different angle!";

function joinSentences(sentences: string[]): string {
  // Trim each, drop empties, join with single space. The model is prompted
  // to make per-property kid_msg strings that read naturally on their own
  // and chain naturally with siblings, so a space-join is sufficient.
  return sentences
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(" ");
}

export function composeChildFeedback(
  properties: PropertyScoreV6[],
  childAge:   number,
  questFlavorTemplate?: string | null,
): string {
  const ageBand = ageBandFor(childAge);
  const passing = properties.filter((p) => p.passes);
  const failing = properties.filter((p) => !p.passes);

  let msg: string;

  if (passing.length > 0) {
    const passMsgs = passing
      .map((p) => p.kid_msg?.[ageBand] ?? "")
      .filter((s) => typeof s === "string" && s.trim().length > 0);
    msg = passMsgs.length > 0 ? joinSentences(passMsgs) : FALLBACK_PASS_FEEDBACK;

    // Quest flavor only on success — never celebrate when the kid is failing.
    const flavor = (questFlavorTemplate ?? "").trim();
    if (flavor.length > 0) msg = msg + " " + flavor;
  } else if (failing.length > 0) {
    // Pick one failing message — don't pile on. Highest-confidence-FAIL goes
    // first (lowest score). Stable across retries because the model is
    // prompted to make kid_msg deterministic-ish for the same input.
    const sortedFails = [...failing].sort((a, b) => a.score - b.score);
    const candidate   = sortedFails[0]?.kid_msg?.[ageBand];
    msg = candidate && candidate.trim().length > 0 ? candidate.trim() : FALLBACK_FAIL_FEEDBACK;
  } else {
    msg = FALLBACK_FAIL_FEEDBACK;
  }

  return msg;
}

export function composeNudge(
  properties:     PropertyScoreV6[],
  childAge:       number,
  failedAttempts: number,
): string | null {
  if (failedAttempts < 2) return null;

  const ageBand = ageBandFor(childAge);
  const candidates = properties
    .filter((p) => !p.passes && p.nudge?.[ageBand])
    .map((p) => p.nudge![ageBand].trim())
    .filter((s) => s.length > 0);

  return candidates[0] ?? null;
}

// ─── Compose: full EvaluationResult from V6 properties ───────────────────────

export function composeFinalResult(opts: {
  detectedLabel:        string;
  resolvedName?:        string;
  freshProperties:      PropertyScoreV6[];
  cachedProperties:     PropertyScoreV6[];
  childAge:             number;
  failedAttempts:       number;
  questFlavorTemplate?: string | null;
  xpRates?:             XpRates;
}): EvaluationResult {
  const all          = [...opts.freshProperties, ...opts.cachedProperties];
  const overallMatch = all.some((p) => p.passes);

  const childFeedback = composeChildFeedback(
    all,
    opts.childAge,
    overallMatch ? opts.questFlavorTemplate : null,
  );
  const nudgeHint = composeNudge(all, opts.childAge, opts.failedAttempts);

  const xpAwarded = computeXp({
    overallMatch,
    properties:     all,
    failedAttempts: opts.failedAttempts,
    xpRates:        opts.xpRates,
  });

  // Strip v6-internal fields for the public EvaluationResult.properties shape.
  const publicProperties: PropertyScore[] = all.map((p) => ({
    word:      p.word,
    score:     p.score,
    reasoning: p.reasoning,
    passes:    p.passes,
  }));

  return {
    resolvedObjectName: (opts.resolvedName && opts.resolvedName.length > 0)
                          ? opts.resolvedName
                          : opts.detectedLabel,
    properties:         publicProperties,
    overallMatch,
    childFeedback,
    nudgeHint:          nudgeHint ?? null,
    xpAwarded,
  };
}

// ─── Mastery profile formatting (unchanged from v5) ──────────────────────────

export function formatMasteryProfile(profile: MasteryEntry[] | undefined): string {
  if (!profile || profile.length === 0) return "";

  const byTier: Record<MasteryTier, string[]> = {
    novice:     [],
    developing: [],
    proficient: [],
    expert:     [],
  };

  for (const entry of profile) byTier[entry.masteryTier].push(entry.word);

  const lines: string[] = [];
  if (byTier.expert.length > 0)
    lines.push(`EXPERT (nearly retired): ${byTier.expert.join(", ")}`);
  if (byTier.proficient.length > 0)
    lines.push(`PROFICIENT (solid understanding): ${byTier.proficient.join(", ")}`);
  if (byTier.developing.length > 0)
    lines.push(`DEVELOPING (building confidence): ${byTier.developing.join(", ")}`);
  if (byTier.novice.length > 0)
    lines.push(`NOVICE (just learning): ${byTier.novice.join(", ")}`);

  return lines.join("\n");
}

// ─── System prompt (v6.0) ────────────────────────────────────────────────────

function buildSystemPrompt(
  childAge:        number,
  questName?:      string,
  masteryProfile?: MasteryEntry[],
): string {
  const masterySection = masteryProfile && masteryProfile.length > 0
    ? `
CHILD'S VOCABULARY MASTERY PROFILE:
${formatMasteryProfile(masteryProfile)}

HOW TO USE THE MASTERY PROFILE:
- NOVICE words: Use the simplest language in kid_msg. Be extra encouraging.
- DEVELOPING words: Normal age-appropriate language. Affirm progress.
- PROFICIENT words: Use slightly richer vocabulary in kid_msg.
- EXPERT words: The child is nearly done with this word. Subtly introduce richer synonyms or related concepts in the kid_msg.
`
    : "";

  return `${CHILD_SAFETY_PREFIX}

You are an encouraging vocabulary coach for a child aged ${childAge}.
${questName ? `Quest: "${questName}"` : ""}
${masterySection}
Your task: evaluate whether the detected object genuinely demonstrates each required vocabulary property, AND produce age-banded kid-voice messages for each verdict.

OUTPUT SHAPE (strict — return exactly this JSON shape; no prose, no markdown):
{
  "resolvedObjectName": "<bare lowercase common noun, NO articles (a/an/the), NO sentence punctuation. examples: 'apple', 'remote control', 'biscuit packet'. NOT 'a chair', 'The Bottle.', 'an apple'>",
  "aliases": ["<up to 3 common synonyms or alternative names a different vision model might call this same object — bare lowercase nouns, NO articles, NO punctuation. example for 'water bottle': ['bottle', 'drink bottle', 'plastic bottle']. example for 'sneaker': ['shoe', 'trainer', 'tennis shoe']. example for 'mobile phone': ['phone', 'smartphone', 'cell phone']. Empty array [] is fine if no obvious synonyms exist (e.g. for 'apple'). Avoid generic basket terms like 'object', 'thing', 'item', 'tableware', 'food', 'plant'.>"],
  "properties": [
    {
      "word":      "<exact property word>",
      "score":     0.0–1.0,
      "reasoning": "<one sentence justifying the score>",
      "passes":    true | false,
      "kid_msg": {
        "young":   "<message for a 5-7 year old>",
        "older":   "<message for an 8-12 year old>"
      },
      "nudge": null | {
        "young":   "<gentle hint for a 5-7 year old>",
        "older":   "<gentle hint for an 8-12 year old>"
      }
    }
  ]
}

VERDICT RULES:
1. Score each property 0.0–1.0. Score >= 0.7 means passes:true.
2. Be honest and precise — do NOT give benefit of the doubt if the match is weak.
3. If the object clearly does NOT have a property, say so directly in reasoning.
4. The "properties" array MUST contain exactly one entry per word listed under "Properties to evaluate THIS scan" — no more, no fewer. Use the exact spelling and case.
5. Do NOT include any property word that wasn't listed under "Properties to evaluate THIS scan".

KID_MSG RULES (the child sees these, not your reasoning):
- "young" (ages 5-7): SHORT. 5-10 words. Simple words. Concrete comparisons ("like a ball", "as fluffy as a cloud"). Exclamation if passing.
- "older" (ages 8-12): 8-15 words. Slightly richer vocabulary. Can use the precise property word.
- Each kid_msg.young/older should be a complete short sentence that reads naturally on its own AND chains naturally if joined with other property kid_msgs from the same scan.
- For passes:true → celebratory tone, name what they found.
- For passes:false → gentle, factual, no negative judgment ("Apples aren't stretchy — they're firm and stay the same shape!").
- Do NOT use the child's name. Do NOT ask questions. Do NOT mention the camera or scanning.

NUDGE RULES:
- Set nudge to null UNLESS passes:false AND failedAttempts >= 2.
- When set: short hint that guides toward an object with this property without naming it. ("Try something soft and squishy you can squeeze.")
- Same age-banding as kid_msg.

CONSISTENCY (critical):
- Property words MUST match the listed words exactly.
- "Already evaluated" properties (if shown in the user message) are passed through verbatim — do NOT re-score them, do NOT include them in your properties array.
- "Already won" words are skipped entirely — do NOT include them.

Return only the JSON. No commentary, no markdown fences.`;
}

// ─── User message builder ────────────────────────────────────────────────────
//
// v6.1.2 — Image-only evaluation prompt (no detected-label poisoning).
//
// The previous version told the model "The child's camera detected: 'chair'
// (Vision confidence: 76%)" and then asked it to "Evaluate whether 'chair'
// satisfies each property". That's classic prompt poisoning: any vision
// model will take the labeled identity as a strong prior, confirm it in
// resolvedObjectName, and evaluate properties as if the labeled object
// were what's in the frame — even when the image clearly shows something
// else.
//
// Observed PROD failure (2026-05-10): a translucent orange water bottle
// was scanned. ML Kit said "chair" 76%. Mistral, given the prompt above,
// returned resolvedObjectName="chair", round=fail (chairs aren't round),
// hollow=fail (chairs aren't hollow), curved=fail (chair backrests aren't
// curved). Internally consistent verdicts — about the wrong object.
//
// The fix: stop telling the evaluator what the classifier guessed. Give
// it the image and the property list. The model identifies the object in
// resolvedObjectName (the same output field as before — no schema change)
// and evaluates its own perception. ML Kit still serves as the cache-
// lookup hint via the alias map — so cache hit rate is preserved — but
// it does NOT influence the model's identification.
//
// `opts.detectedLabel` and `opts.confidence` are intentionally UNUSED
// here. They remain in the EvaluateObjectOptions interface because they
// drive cache key construction and alias-map updates upstream in
// evaluate/index.ts. Don't reintroduce them into the prompt without
// re-doing the eval against bottle/chair/tableware test cases.

function buildUserText(opts: EvaluateObjectOptions): string {
  const propertyList = opts.requiredProperties
    .map((p) => `  • "${p.word}" — ${p.definition}${p.evaluationHints ? ` (hint: ${p.evaluationHints})` : ""}`)
    .join("\n");

  const alreadyFoundContext = (opts.alreadyFoundWords ?? []).length > 0
    ? `\nAlready won this quest (do NOT re-evaluate): ${opts.alreadyFoundWords!.join(", ")}\n`
    : "";

  const previouslyEvaluatedContext = (opts.previouslyEvaluatedProperties ?? []).length > 0
    ? `\nAlready evaluated this scan (cached, included in final result): ${
        opts.previouslyEvaluatedProperties!.map((p) => `${p.word}=${p.passes ? "PASS" : "FAIL"}`).join(", ")
      }\n`
    : "";

  const propertyMasteryContext = opts.masteryProfile && opts.masteryProfile.length > 0
    ? formatMasteryProfile(opts.masteryProfile)
    : "";

  const failedAttempts = opts.failedAttempts ?? 0;

  return `Look at the attached image. First identify what the object actually is — write the bare common noun in resolvedObjectName per the schema. Then evaluate that object — what you can SEE in the frame — against each property below. Trust your own perception, not any caption that may have arrived with the request.

Properties to evaluate THIS scan (one or more is enough — the quest tracks completion across multiple scans):
${propertyList}
${alreadyFoundContext}${previouslyEvaluatedContext}${
  propertyMasteryContext
    ? `\nMastery context for quest words:\n${propertyMasteryContext}\n`
    : ""
}
Failed attempts so far: ${failedAttempts}

Return one entry per property listed above, using the exact word as written. Produce kid_msg.young AND kid_msg.older for each.
${
  failedAttempts >= 2
    ? "The child has struggled. For any FAILING property, also produce a nudge with young+older variants."
    : "Set nudge to null on every property."
}`;
}

// ─── Strict v6 shape validation on parsed model output ───────────────────────

function isAgeBandedString(v: unknown): v is AgeBandedString {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.young === "string" && o.young.trim().length > 0
      && typeof o.older === "string" && o.older.trim().length > 0;
}

function isPropertyScoreV6(v: unknown): v is PropertyScoreV6 {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.word      === "string"
      && typeof o.score     === "number"
      && typeof o.reasoning === "string"
      && typeof o.passes    === "boolean"
      && isAgeBandedString(o.kid_msg)
      && (o.nudge === null || isAgeBandedString(o.nudge));
}

interface ParsedModelOutput {
  resolvedObjectName: string;
  /**
   * v6.2 — model-introspected synonyms for the canonical. Up to 3 entries.
   * Used by the cache write path to populate the alias map at low confidence
   * (0.5) so future scans of the same object that get a different label
   * (different model, different angle, different ML detector) can still hit
   * the cache. Empty array is fine — common for unique objects like "apple".
   *
   * Already filtered: empty entries removed, generic/basket entries removed,
   * duplicates removed, normalized via normalizeResolvedObjectName, trimmed
   * to max 3.
   */
  aliases:            string[];
  properties:         PropertyScoreV6[];
}

/**
 * v6.1.1 — Defensive normalization for the model's resolvedObjectName.
 *
 * What it fixes
 * -------------
 * Mistral (and Gemini occasionally) returns names with English determiners
 * intact: "a chair", "the bottle", "an apple". The downstream
 * normalizeForKey() in evaluate/index.ts treats spaces as part of the key
 * and turns these into junk canonicals — "a-chair", "the-bottle" — that
 * pollute the alias map and verdict cache for weeks (14-day TTL).
 *
 * Observed in PROD logs 2026-05-10:
 *   [evaluate] alias created: detected="chair" → canonical="a-chair"
 *
 * Strategy
 * --------
 * Strip at parse time so EVERY downstream consumer (cache key builder,
 * alias updater, EvaluationResult returned to the client) sees the same
 * cleaned value. Don't try to normalize inside cache helpers — too easy
 * to forget one.
 *
 * Conservative: only strips whole-word leading articles followed by a
 * space. "Apple" stays "apple". "Antelope" stays "antelope" (not "telope"
 * — we match "an " with a space, not bare "an").
 *
 * Lowercase + collapse internal whitespace too, so "Coffee  Mug" and
 * "coffee mug" converge on the same canonical. Trailing punctuation
 * (period, exclamation) gets trimmed because Mistral occasionally adds
 * sentence-ending marks even though the schema is a noun.
 */
function normalizeResolvedObjectName(raw: string): string {
  let s = raw.trim().toLowerCase();

  // Strip a leading article when followed by a space and at least one more char
  // ("a", "an", "the"). Loop in case of "the the" weirdness, capped at 2 iterations.
  for (let i = 0; i < 2; i++) {
    const stripped = s.replace(/^(a|an|the)\s+(?=\S)/, "");
    if (stripped === s) break;
    s = stripped;
  }

  // Collapse runs of whitespace to a single space
  s = s.replace(/\s+/g, " ");

  // Trim trailing punctuation that the model sometimes appends
  s = s.replace(/[.!?,;:]+$/, "");

  return s.trim();
}

function parseModelOutput(rawText: string): ParsedModelOutput {
  let parsed: unknown;
  try {
    const clean = rawText.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(clean);
  } catch {
    throw new Error(`Model returned non-JSON: ${rawText.slice(0, 200)}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Model returned non-object JSON");
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.error === "unable_to_evaluate") {
    throw new Error("Frame could not be evaluated safely.");
  }

  const rawName = typeof obj.resolvedObjectName === "string"
    ? obj.resolvedObjectName
    : "";
  if (rawName.length === 0) {
    throw new Error("Model output missing resolvedObjectName");
  }

  // v6.1.1 — apply defensive normalization. See normalizeResolvedObjectName.
  const resolvedObjectName = normalizeResolvedObjectName(rawName);
  if (resolvedObjectName.length === 0) {
    // E.g. model returned literally "the." → after strip+trim, empty.
    throw new Error("Model output resolvedObjectName empty after normalization");
  }
  if (resolvedObjectName !== rawName) {
    console.log(
      `[evaluate] resolvedObjectName normalized: "${rawName}" → "${resolvedObjectName}"`,
    );
  }

  if (!Array.isArray(obj.properties)) {
    throw new Error("Model output missing properties array");
  }

  const validated: PropertyScoreV6[] = [];
  for (const p of obj.properties) {
    if (!isPropertyScoreV6(p)) {
      // Surface the malformed entry; calling code will degrade gracefully.
      throw new Error(`Model output property has wrong shape: ${JSON.stringify(p).slice(0, 200)}`);
    }
    validated.push(p);
  }

  // v6.2 — parse model-introspected aliases. Optional in the schema (some
  // objects genuinely have no synonyms). Same normalization as resolvedObjectName.
  // We don't enforce strict typing on the array contents — non-string entries
  // are silently dropped. The downstream alias-write guard will additionally
  // filter generic/basket terms and entries matching the canonical itself;
  // we only do the cheap, model-output-level cleanup here.
  const aliases: string[] = [];
  if (Array.isArray(obj.aliases)) {
    const seen = new Set<string>();
    seen.add(resolvedObjectName); // exclude the canonical itself
    for (const raw of obj.aliases) {
      if (typeof raw !== "string") continue;
      const normalized = normalizeResolvedObjectName(raw);
      if (normalized.length < 3) continue;          // too short — likely junk
      if (seen.has(normalized))   continue;         // dedupe
      seen.add(normalized);
      aliases.push(normalized);
      if (aliases.length >= 3) break;               // schema cap
    }
  }

  return { resolvedObjectName, aliases, properties: validated };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function evaluateObject(
  opts:    EvaluateObjectOptions,
  adapter: ModelAdapter,
): Promise<{
  result:             EvaluationResult;
  freshProperties:    PropertyScoreV6[];
  resolvedObjectName: string;
  /**
   * v6.2 — model-introspected synonyms. The caller in evaluate/index.ts uses
   * these to populate the alias map at low confidence (0.5) so future scans
   * of the same object that get a different label can still hit the cache.
   * Already filtered/normalized; max 3; may be empty.
   */
  aliases:            string[];
}> {

  if (opts.requiredProperties.length === 0) {
    throw new Error(
      "evaluateObject called with empty requiredProperties — caller should " +
      "use composeFinalResult directly when all properties hit cache."
    );
  }

  // ── 1. Build prompts ─────────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(
    opts.childAge,
    opts.questName,
    opts.masteryProfile,
  );
  const userText = buildUserText(opts);

  // ── 2. Call the model via adapter ────────────────────────────────────────
  let rawText: string;
  try {
    const result = await adapter.call({
      systemPrompt,
      userText,
      imageBase64: opts.frameBase64 ?? undefined,
      maxTokens:   MAX_TOKENS,
      jsonMode:    true,
    });
    rawText = result.rawText;
  } catch (e) {
    if (e instanceof ModelCallError) {
      throw new Error(`${e.modelId} API error ${e.httpStatus ?? ""}: ${e.bodyText.slice(0, 200) || e.message}`);
    }
    throw e;
  }

  // ── 3. Parse + strict-validate JSON ──────────────────────────────────────
  const parsed = parseModelOutput(rawText);

  // ── 4. Negative-phrase + hedging validation on FRESH properties only ─────
  const { properties: validatedFresh } = applyNegativePhraseValidationV6(parsed.properties);

  // ── 5. Compose final result (fresh + cached) ─────────────────────────────
  const cached = opts.previouslyEvaluatedProperties ?? [];
  const result = composeFinalResult({
    detectedLabel:        opts.detectedLabel,
    resolvedName:         parsed.resolvedObjectName,
    freshProperties:      validatedFresh,
    cachedProperties:     cached,
    childAge:             opts.childAge,
    failedAttempts:       opts.failedAttempts ?? 0,
    questFlavorTemplate:  opts.questFlavorTemplate ?? null,
    xpRates:              opts.xpRates,
  });

  return {
    result,
    freshProperties:    validatedFresh,
    resolvedObjectName: parsed.resolvedObjectName,
    aliases:            parsed.aliases,
  };
}
