// lib/verdictSafety.ts
// Lexi-Lens / Skanlore — client-side detection of the "neutral safety" verdict.
//
// WHY THIS FILE EXISTS
// ────────────────────
// When a child points the lens at a person, face, hand, document, screen, ID
// card, or anything else on the CHILD_SAFETY_PREFIX fail-safe list
// (supabase/functions/_shared/childSafety.ts), the model is instructed NOT to
// describe what it saw. Instead it returns a neutral placeholder verdict:
//
//     resolvedObjectName: "object"
//     every property: { score: 0, passes: false, reasoning: "Generic placeholder.", … }
//
// Rendered through the normal near-miss path this produced three problems that
// a child (and any parent watching, and an App Reviewer) should never see:
//
//   1. The per-property placeholder message was concatenated once PER property,
//      so a 3-property quest showed "Let's find a real object to scan!" three
//      times in a row (see the reported screenshot).
//   2. It was framed as a near-miss ("Almost…" + red property rows +
//      "Generic placeholder."), implying the child was close — when in fact the
//      scan hit a content boundary and was never scored.
//   3. Downstream, useLexiEvaluate recorded a FAILED mastery attempt against
//      each real quest word (small / wide / clear …) for a scan that should
//      never touch mastery at all — silent data pollution.
//
// This module centralises the detection so both the render layer (VerdictCard)
// and the scoring layer (useLexiEvaluate) agree on what a safety verdict is,
// and so the message is a single, clear, non-shaming redirect.
//
// DETECTION IS DELIBERATELY CONSERVATIVE. A scan where the model simply could
// not identify an ordinary object ("object" with real per-property reasoning)
// must still take the ordinary "try another object" path — it is not a policy
// event. We therefore require BOTH a generic resolved name AND the literal
// placeholder reasoning on every property. The server may also send an explicit
// `safetyBlock: true` (durable signal); when present it wins outright and the
// string sniff is not needed. The sniff exists so the fix works via an OTA
// client update alone, before the Edge Function that sets the flag ships.

/** Generic resolved-object names the model uses when it declines to identify. */
const GENERIC_RESOLVED_NAMES = new Set(["", "object", "unknown", "thing", "item"]);

/** Matches the fail-safe placeholder reasoning, tolerant of trailing period / case. */
const PLACEHOLDER_REASONING = /^\s*generic placeholder\.?\s*$/i;

/** Minimal structural shape — avoids importing (and coupling to) EvaluationResult. */
interface VerdictLike {
  resolvedObjectName?: string;
  safetyBlock?:        boolean;
  properties?:         Array<{ passes?: boolean; reasoning?: string } | null | undefined>;
}

/**
 * True when the verdict is the neutral safety placeholder (person / document /
 * screen / etc.), NOT an ordinary failed or near-miss scan.
 */
export function isSafetyVerdict(result: VerdictLike | null | undefined): boolean {
  if (!result) return false;

  // 1) Durable server signal wins outright.
  if (result.safetyBlock === true) return true;

  // 2) Conservative client sniff (works before the server flag ships, OTA-only).
  const name = (result.resolvedObjectName ?? "").trim().toLowerCase();
  if (!GENERIC_RESOLVED_NAMES.has(name)) return false;

  const props = result.properties ?? [];
  if (props.length === 0) return false;

  return props.every(
    (p) =>
      !!p &&
      p.passes === false &&
      typeof p.reasoning === "string" &&
      PLACEHOLDER_REASONING.test(p.reasoning),
  );
}

/**
 * The single, age-neutral redirect shown for a safety verdict. Warm and
 * non-accusatory (the child did nothing wrong), but unambiguous that people,
 * screens, and writing are out of scope — which doubles as the visible
 * child-safety posture for store review.
 */
export const SAFETY_VERDICT = {
  emoji: "🧸",
  title: "Let's scan an object!",
  message:
    "Skanlore scans objects you can find around you, like a " +
    "toy, a cup, or a spoon. It's not for people (not even you!), screens, or " +
    "writing. Point at a real object and let's try again! ✨",
} as const;