/**
 * verdictSafety.test.ts
 *
 * Locks the neutral-safety-verdict behaviour that fixes the reported bug where
 * a face/document scan showed "Almost… Let's find a real object to scan!"
 * repeated once per property.
 *
 *  Part A — client predicate isSafetyVerdict() imported from the REAL module
 *           (lib/verdictSafety.ts), so it can never drift from shipping code.
 *  Part B — pure mirrors of the two server helpers in
 *           supabase/functions/evaluate/evaluateObject.ts (joinSentences dedupe
 *           and isNeutralPlaceholderVerdict). The edge file is Deno-native and
 *           cannot be imported under ts-jest, so — per the test/ convention
 *           (see components.ts, evaluateHandler.ts) — the logic is mirrored.
 *           If you change the server helpers, change these mirrors too.
 */

import { isSafetyVerdict, SAFETY_VERDICT } from "../lib/verdictSafety";

// ── fixtures ─────────────────────────────────────────────────────────────────
const placeholder = (word: string) => ({
  word, score: 0, passes: false, reasoning: "Generic placeholder.",
});
const real = (word: string, passes: boolean) => ({
  word, score: passes ? 0.9 : 0.2, passes,
  reasoning: passes ? "Yes, this is round." : "Not quite round.",
});

// ═════════════════════════════════════════════════════════════════════════════
// Part A — client predicate (real module)
// ═════════════════════════════════════════════════════════════════════════════
describe("isSafetyVerdict (client)", () => {
  test("face/document placeholder verdict → true", () => {
    expect(isSafetyVerdict({
      resolvedObjectName: "object",
      properties: [placeholder("small"), placeholder("wide"), placeholder("clear")],
    })).toBe(true);
  });

  test("explicit server safetyBlock flag wins even with odd props", () => {
    expect(isSafetyVerdict({
      resolvedObjectName: "object", safetyBlock: true, properties: [],
    })).toBe(true);
  });

  test("ordinary failed near-miss (real reasoning) → false", () => {
    expect(isSafetyVerdict({
      resolvedObjectName: "apple",
      properties: [real("round", false), real("red", true)],
    })).toBe(false);
  });

  test("generic name but real reasoning (unidentified object) → false", () => {
    // Must NOT be treated as a policy event — user still gets "try another".
    expect(isSafetyVerdict({
      resolvedObjectName: "object",
      properties: [real("small", false)],
    })).toBe(false);
  });

  test("tolerant of missing period / casing on placeholder reasoning", () => {
    expect(isSafetyVerdict({
      resolvedObjectName: "object",
      properties: [{ passes: false, reasoning: "generic placeholder" }],
    })).toBe(true);
  });

  test("empty properties without flag → false", () => {
    expect(isSafetyVerdict({ resolvedObjectName: "object", properties: [] })).toBe(false);
  });

  test("null/undefined → false", () => {
    expect(isSafetyVerdict(null)).toBe(false);
    expect(isSafetyVerdict(undefined)).toBe(false);
  });

  test("redirect copy names the out-of-scope categories", () => {
    expect(SAFETY_VERDICT.message).toMatch(/people/i);
    expect(SAFETY_VERDICT.message).toMatch(/screens/i);
    expect(SAFETY_VERDICT.message).toMatch(/writing/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Part B — server-logic mirrors (evaluateObject.ts)
// ═════════════════════════════════════════════════════════════════════════════
function joinSentencesMirror(sentences: string[]): string {
  const seen = new Set<string>();
  return sentences
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => {
      const key = s.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(" ");
}

const GENERIC = new Set(["", "object", "unknown", "thing", "item"]);
const PLACEHOLDER = /^\s*generic placeholder\.?\s*$/i;
function isNeutralPlaceholderVerdictMirror(
  name: string,
  props: Array<{ passes: boolean; reasoning: string }>,
): boolean {
  if (!GENERIC.has((name ?? "").trim().toLowerCase())) return false;
  if (props.length === 0) return false;
  return props.every((p) => p.passes === false && PLACEHOLDER.test(p.reasoning));
}

describe("joinSentences dedupe (server mirror)", () => {
  test("collapses identical repeated sentences (the reported triple)", () => {
    const s = "Let's find a real object to scan!";
    expect(joinSentencesMirror([s, s, s])).toBe(s);
  });
  test("keeps distinct sentences, order preserved", () => {
    expect(joinSentencesMirror(["It's round.", "It's red.", "It's round."]))
      .toBe("It's round. It's red.");
  });
});

describe("isNeutralPlaceholderVerdict (server mirror)", () => {
  test("all-placeholder + generic name → true", () => {
    expect(isNeutralPlaceholderVerdictMirror("object", [
      { passes: false, reasoning: "Generic placeholder." },
      { passes: false, reasoning: "Generic placeholder." },
    ])).toBe(true);
  });
  test("named object → false", () => {
    expect(isNeutralPlaceholderVerdictMirror("apple", [
      { passes: false, reasoning: "Generic placeholder." },
    ])).toBe(false);
  });
  test("one real reasoning among placeholders → false", () => {
    expect(isNeutralPlaceholderVerdictMirror("object", [
      { passes: false, reasoning: "Generic placeholder." },
      { passes: false, reasoning: "Not quite round." },
    ])).toBe(false);
  });
});
