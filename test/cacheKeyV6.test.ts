/**
 * cacheKeyV6.test.ts — v6 per-property cache key (CURRENT production contract)
 *
 * Replaces the coverage the orphaned evaluateHandler v4.7 buildCacheKey
 * suite no longer provides for production. Pins normalisation,
 * determinism, plural collapse, the hash fallback, and env prefixing —
 * all critical to cache correctness and cross-env isolation.
 */

import { buildPerPropCacheKey, normalizeForKey } from "./cacheKeyV6";

describe("evaluate.normalizeForKey", () => {
  it("lowercases, trims, collapses whitespace", () => {
    expect(normalizeForKey("  Red   APPLE ")).toBe("red-apple");
  });

  it("collapses regular plurals to singular (cats → cat)", () => {
    expect(normalizeForKey("cats")).toBe(normalizeForKey("cat"));
  });

  it("does NOT mangle -ss / -es words (glass stays glass)", () => {
    expect(normalizeForKey("glass")).toBe("glass");
  });

  it("strips punctuation to single dashes, trims edge dashes", () => {
    expect(normalizeForKey("!!apple, pie!!")).toBe("apple-pie");
  });
});

describe("evaluate.buildPerPropCacheKey", () => {
  it("is deterministic for identical inputs", () => {
    expect(buildPerPropCacheKey("Spoon", "metal"))
      .toBe(buildPerPropCacheKey("spoon", "metal"));
  });

  it("singular/plural label resolve to the SAME key (cache-hit win)", () => {
    expect(buildPerPropCacheKey("spoons", "shiny"))
      .toBe(buildPerPropCacheKey("spoon", "shiny"));
  });

  it("carries the env prefix for cross-environment isolation", () => {
    expect(buildPerPropCacheKey("apple", "red"))
      .toMatch(/^test:lexi:v6:verdict:/);
  });

  it("falls back to a hashed key when a segment normalises empty", () => {
    const k = buildPerPropCacheKey("???", "word");
    expect(k).toMatch(/^test:lexi:v6:verdict:_h:/);
    expect(k).not.toContain("=");
  });

  it("per-segment cap (80) keeps long inputs under the 200 full-key cap", () => {
    // Documents real behaviour: normalizeForKey slices each segment to
    // KEY_SEGMENT_MAX=80 BEFORE the full-key length check, so the 200-char
    // FULL_KEY_MAX hash fallback is effectively unreachable via long input
    // alone. The hash fallback is reached via the empty-segment path
    // (tested above), not via length. This test pins that intentional
    // ordering so a future refactor that moves the length check before
    // the slice is caught.
    const huge = "a".repeat(300);
    const k = buildPerPropCacheKey(huge, huge);
    expect(k).not.toContain("_h:");          // NOT the hash path
    expect(k.split(":").pop()!.length).toBe(80); // word segment capped at 80
    expect(k.length).toBeLessThanOrEqual(200);   // still under full cap
  });

  it("distinct objects do not collide", () => {
    expect(buildPerPropCacheKey("apple", "red"))
      .not.toBe(buildPerPropCacheKey("banana", "red"));
  });
});
