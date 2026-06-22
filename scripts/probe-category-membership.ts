/**
 * scripts/probe-category-membership.ts
 * Lexi-Lens — Eval probe (gate before Unit 3: noun × adjective quests)
 *
 * PURPOSE
 * ───────
 * Unit 3 lets a quest target a NOUN CATEGORY ("find a utensil"). The child
 * scans an object; the eval already resolves what it is (resolvedObjectName).
 * The NEW capability Unit 3 depends on is: given the object and a target
 * category, judge whether it BELONGS ("spoon" ∈ "utensil"? yes. "book" ∈
 * "utensil"? no). This probe proves the live eval model can do that reliably
 * BEFORE we build the feature on top of it.
 *
 * It deliberately tests the category REASONING (the new risk) in isolation —
 * object identification from a photo is already proven in production via
 * resolvedObjectName, so we don't re-test it here. A short on-device image
 * spot-check (see the chat notes) covers the identification→category seam.
 *
 * FAITHFULNESS
 * ────────────
 * Mirrors supabase/functions/_shared/models/gemini.ts exactly: same AI-Studio
 * endpoint, same default variant (gemini-2.5-flash-lite), same temperature
 * (0.2) and JSON mode. Reads the same env vars the Edge runtime uses, so a
 * GREEN here means the live eval model will behave the same way.
 *
 * RUN
 * ───
 *   export GOOGLE_AI_STUDIO_KEY=...            # same key the eval uses
 *   export GEMINI_MODEL_ID=gemini-2.5-flash-lite   # optional; match your live flag
 *   deno run --allow-env --allow-net scripts/probe-category-membership.ts
 *
 * EXIT CODE
 * ─────────
 *   0  → GREEN  (≥ PASS_THRESHOLD on unambiguous cases) — safe to build Unit 3
 *   1  → check  (below threshold, or API/config error) — tune the membership
 *               prompt or add an ontology fallback before Unit 3
 */

// ── Config (mirrors gemini.ts) ───────────────────────────────────────────────
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_VARIANT = "gemini-2.5-flash-lite";
const TEMPERATURE = 0.2;
const PER_CALL_TIMEOUT_MS = 30_000;
const INTER_CALL_DELAY_MS = 150; // gentle on rate limits
const PASS_THRESHOLD = 0.95; // fraction of unambiguous cases that must be correct

const API_KEY = Deno.env.get("GOOGLE_AI_STUDIO_KEY") ?? "";
const VARIANT = Deno.env.get("GEMINI_MODEL_ID")?.trim() || DEFAULT_VARIANT;

// ── The EXACT membership prompt Unit 3 will use ──────────────────────────────
// Validating the real prompt, not a proxy. If this probe passes, Unit 3 ships
// this same system prompt into evaluate.
const SYSTEM_PROMPT = `You are the category checker for a children's vocabulary game (ages 5-12).
A quest asks the child to find an object of a given CATEGORY (e.g. "utensil",
"container", "clothing", "vehicle"). Given the object the child found and the
target category, decide whether the object genuinely belongs to that category
using everyday, child-reasonable categorization.

Rules:
- Use ordinary everyday meaning, not narrow dictionary edge cases. A spoon IS a
  utensil; a fork IS cutlery; a jar IS a container; a sock IS clothing.
- A more specific item belongs to its broader category (a mug is a container,
  a bus is a vehicle, a jacket is a garment).
- If the object clearly does NOT fit, say so (a book is not a utensil).
- People, faces, body parts, or a generic "object"/"unknown"/"thing" label must
  return belongs:false — never match those to any category.

Answer ONLY this JSON, nothing else:
{"belongs": true, "reason": "<=6 words"}`;

// ── Test cases ───────────────────────────────────────────────────────────────
// `boundary:true` = genuinely debatable categorization; reported but NOT counted
// toward the pass/fail threshold (penalizing a judgment call would be unfair).
interface Case {
  object: string;
  category: string;
  expected: boolean;
  kind: "positive" | "escalation" | "negative" | "safety" | "boundary";
  boundary?: boolean;
}

const CASES: Case[] = [
  // ── Positives (base category, should be YES) ──────────────────────────────
  { object: "spoon",   category: "utensil",    expected: true,  kind: "positive" },
  { object: "fork",    category: "utensil",    expected: true,  kind: "positive" },
  { object: "whisk",   category: "utensil",    expected: true,  kind: "positive" },
  { object: "jar",     category: "container",  expected: true,  kind: "positive" },
  { object: "bowl",    category: "container",  expected: true,  kind: "positive" },
  { object: "bottle",  category: "container",  expected: true,  kind: "positive" },
  { object: "shirt",   category: "clothing",   expected: true,  kind: "positive" },
  { object: "sock",    category: "clothing",   expected: true,  kind: "positive" },
  { object: "glove",   category: "clothing",   expected: true,  kind: "positive" },
  { object: "apple",   category: "fruit",      expected: true,  kind: "positive" },
  { object: "grape",   category: "fruit",      expected: true,  kind: "positive" },
  { object: "chair",   category: "furniture",  expected: true,  kind: "positive" },
  { object: "toy car", category: "vehicle",    expected: true,  kind: "positive" },
  { object: "bus",     category: "vehicle",    expected: true,  kind: "positive" },
  { object: "jacket",  category: "garment",    expected: true,  kind: "positive" },
  { object: "ruler",   category: "instrument", expected: true,  kind: "positive" },
  { object: "lamp",    category: "appliance",  expected: true,  kind: "positive" },
  { object: "hinge",   category: "mechanism",  expected: true,  kind: "positive" },
  { object: "flask",   category: "receptacle", expected: true,  kind: "positive" },

  // ── Escalation (harder hypernym category, should still be YES) ─────────────
  { object: "spoon",   category: "cutlery",    expected: true,  kind: "escalation" },
  { object: "cup",     category: "vessel",     expected: true,  kind: "escalation" },
  { object: "jacket",  category: "apparel",    expected: true,  kind: "escalation" },
  { object: "whisk",   category: "implement",  expected: true,  kind: "escalation" },
  { object: "compass", category: "instrument", expected: true,  kind: "escalation" },
  { object: "mug",     category: "container",  expected: true,  kind: "escalation" },

  // ── Negatives (clear non-membership, should be NO) ────────────────────────
  { object: "book",    category: "utensil",    expected: false, kind: "negative" },
  { object: "shoe",    category: "container",  expected: false, kind: "negative" },
  { object: "apple",   category: "clothing",   expected: false, kind: "negative" },
  { object: "chair",   category: "utensil",    expected: false, kind: "negative" },
  { object: "pencil",  category: "fruit",      expected: false, kind: "negative" },
  { object: "spoon",   category: "vehicle",    expected: false, kind: "negative" },
  { object: "hat",     category: "container",  expected: false, kind: "negative" },
  { object: "clock",   category: "fruit",      expected: false, kind: "negative" },

  // ── Safety (people / generic labels must never match) ──────────────────────
  { object: "person",  category: "utensil",    expected: false, kind: "safety" },
  { object: "face",    category: "container",  expected: false, kind: "safety" },
  { object: "hand",    category: "clothing",   expected: false, kind: "safety" },
  { object: "object",  category: "utensil",    expected: false, kind: "safety" },
  { object: "unknown", category: "container",  expected: false, kind: "safety" },

  // ── Boundary (genuinely debatable — reported, not scored) ─────────────────
  { object: "bowl",    category: "utensil",    expected: false, kind: "boundary", boundary: true },
  { object: "mug",     category: "utensil",    expected: false, kind: "boundary", boundary: true },
  { object: "towel",   category: "clothing",   expected: false, kind: "boundary", boundary: true },
  { object: "spork",   category: "utensil",    expected: true,  kind: "boundary", boundary: true },
];

// ── Gemini call (faithful to gemini.ts request body) ─────────────────────────
async function askBelongs(object: string, category: string): Promise<{ belongs: boolean; reason: string } | { error: string }> {
  const url = `${API_BASE}/${VARIANT}:generateContent?key=${API_KEY}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PER_CALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: `Object: ${object}\nCategory: ${category}` }] }],
        generationConfig: {
          maxOutputTokens: 60,
          temperature: TEMPERATURE,
          responseMimeType: "application/json",
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      return { error: `HTTP ${res.status}: ${body.slice(0, 160)}` };
    }
    const data = await res.json();
    const text: string =
      data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
    const cleaned = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return { belongs: Boolean(parsed.belongs), reason: String(parsed.reason ?? "").slice(0, 40) };
  } catch (err) {
    return { error: String(err instanceof Error ? err.message : err).slice(0, 160) };
  } finally {
    clearTimeout(timeout);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Runner ───────────────────────────────────────────────────────────────────
async function main() {
  if (!API_KEY) {
    console.error("✗ GOOGLE_AI_STUDIO_KEY not set. Export it (same key the eval uses) and retry.");
    Deno.exit(1);
  }
  console.log(`\nCategory-membership probe — model variant: ${VARIANT}  (temp ${TEMPERATURE})\n`);

  let scored = 0;
  let correct = 0;
  let apiErrors = 0;
  const failures: string[] = [];
  const boundaryReport: string[] = [];
  const perKind: Record<string, { n: number; ok: number }> = {};

  for (const c of CASES) {
    const r = await askBelongs(c.object, c.category);
    await sleep(INTER_CALL_DELAY_MS);

    if ("error" in r) {
      apiErrors++;
      console.log(`  ERR   ${c.object} ∈ ${c.category}?  → ${r.error}`);
      continue;
    }

    const ok = r.belongs === c.expected;
    const mark = ok ? "✓" : "✗";
    const line = `  ${mark}  ${c.object} ∈ ${c.category}?  model=${r.belongs}  (${r.reason})`;

    if (c.boundary) {
      boundaryReport.push(`     ${c.object} ∈ ${c.category}?  model=${r.belongs}  (${r.reason})  [debatable — not scored]`);
      continue;
    }

    console.log(line);
    perKind[c.kind] ??= { n: 0, ok: 0 };
    perKind[c.kind].n++;
    if (ok) perKind[c.kind].ok++;
    scored++;
    if (ok) correct++;
    else failures.push(`${c.object} ∈ ${c.category}?  expected=${c.expected} got=${r.belongs} (${r.reason})`);
  }

  const acc = scored ? correct / scored : 0;

  console.log(`\n── By case kind ──`);
  for (const [kind, s] of Object.entries(perKind)) {
    console.log(`  ${kind.padEnd(11)} ${s.ok}/${s.n}  (${((s.ok / s.n) * 100).toFixed(0)}%)`);
  }

  if (boundaryReport.length) {
    console.log(`\n── Boundary cases (judgment calls — review, not scored) ──`);
    boundaryReport.forEach((b) => console.log(b));
  }

  if (failures.length) {
    console.log(`\n── Failures ──`);
    failures.forEach((f) => console.log(`  ✗ ${f}`));
  }
  if (apiErrors) console.log(`\n  ⚠ ${apiErrors} API/parse error(s) — not counted; investigate before trusting the score.`);

  console.log(`\n── Result ──`);
  console.log(`  Unambiguous accuracy: ${correct}/${scored}  (${(acc * 100).toFixed(1)}%)`);
  console.log(`  Threshold: ${(PASS_THRESHOLD * 100).toFixed(0)}%`);

  if (apiErrors > 0) {
    console.log(`  ⚠ CHECK — resolve API errors and re-run for a clean read.\n`);
    Deno.exit(1);
  }
  if (acc >= PASS_THRESHOLD) {
    console.log(`  ✓ GREEN — the eval model judges category membership reliably. Safe to build Unit 3.\n`);
    Deno.exit(0);
  }
  console.log(`  ✗ CHECK — below threshold. Tune the membership prompt or add an ontology fallback before Unit 3.\n`);
  Deno.exit(1);
}

main();
