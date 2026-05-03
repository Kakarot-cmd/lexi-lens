/**
 * otherEdgeFunctions.test.ts
 * Chunk 3 — Other Edge Functions (mocked)
 *
 * Coverage:
 *   1. classify-words.sanitizeInput        — dedupe, lowercase, trim, length cap
 *   2. classify-words.parseClassifications — JSON guard, domain validation,
 *                                            confidence fallback, omitted-word fallback
 *   3. record-consent.validateConsentBody  — strict TRUE checkboxes, required fields
 *   4. request-deletion.validateDeletionConfirmation — case-insensitive "DELETE"
 *   5. validateBearerAuth                  — Bearer prefix
 *   6. retire-word.validateRetireWordBody  — required fields
 *   7. generate-quest.clampPropCount       — 1–5 range, default 3
 *   8. generate-quest.computeMaxTokensForPropCount
 *   9. generate-quest.validateGenerateQuestBody — theme/ageBand/tier
 */

import {
  sanitizeInput,
  parseClassifications,
  validateConsentBody,
  validateDeletionConfirmation,
  validateBearerAuth,
  validateRetireWordBody,
  clampPropCount,
  computeMaxTokensForPropCount,
  validateGenerateQuestBody,
  MAX_INPUT_WORDS,
  VALID_AGE_BANDS,
  VALID_TIERS,
} from "./otherEdgeFunctions";

// ═══════════════════════════════════════════════════════════════════════════════
// 1. classify-words.sanitizeInput
// ═══════════════════════════════════════════════════════════════════════════════

describe("classify-words.sanitizeInput", () => {
  test("lowercases and trims", () => {
    expect(sanitizeInput([{ word: "  TRANSLUCENT  ", definition: "x" }])).toEqual([
      { word: "translucent", definition: "x" },
    ]);
  });

  test("dedupes within a single request", () => {
    expect(sanitizeInput([
      { word: "smooth", definition: "a" },
      { word: "SMOOTH", definition: "b" },
      { word: "smooth", definition: "c" },
    ])).toHaveLength(1);
  });

  test("rejects empty word strings", () => {
    expect(sanitizeInput([
      { word: "", definition: "x" },
      { word: "   ", definition: "x" },
    ])).toEqual([]);
  });

  test("rejects words longer than 50 chars", () => {
    expect(sanitizeInput([{ word: "a".repeat(51), definition: "x" }])).toEqual([]);
    expect(sanitizeInput([{ word: "a".repeat(50), definition: "x" }])).toHaveLength(1);
  });

  test("rejects non-object entries", () => {
    expect(sanitizeInput([null, "string", 42, undefined, { word: "ok", definition: "x" }])).toHaveLength(1);
  });

  test("hard caps input at MAX_INPUT_WORDS", () => {
    const input = Array.from({ length: MAX_INPUT_WORDS + 50 }, (_, i) => ({
      word: `w${i}`, definition: "",
    }));
    expect(sanitizeInput(input)).toHaveLength(MAX_INPUT_WORDS);
  });

  test("treats missing definition as empty string", () => {
    expect(sanitizeInput([{ word: "smooth" } as any])).toEqual([
      { word: "smooth", definition: "" },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. classify-words.parseClassifications
// ═══════════════════════════════════════════════════════════════════════════════

describe("classify-words.parseClassifications", () => {
  const batch = [
    { word: "smooth", definition: "x" },
    { word: "rough",  definition: "x" },
  ];

  test("strips ```json fences before parsing", () => {
    const raw = '```json\n{"classifications":[{"word":"smooth","domain":"texture","confidence":"high"}]}\n```';
    const result = parseClassifications(raw, batch);
    expect(result.find((c) => c.word === "smooth")?.domain).toBe("texture");
  });

  test("returns empty array when JSON is malformed", () => {
    expect(parseClassifications("not json", [])).toEqual([]);
  });

  test("returns empty array when 'classifications' is not an array", () => {
    expect(parseClassifications('{"classifications":"oops"}', [])).toEqual([]);
  });

  test("falls back invalid domain to 'other'", () => {
    const raw = JSON.stringify({
      classifications: [{ word: "smooth", domain: "WEIRD_DOMAIN", confidence: "high" }],
    });
    expect(parseClassifications(raw, batch).find((c) => c.word === "smooth")?.domain).toBe("other");
  });

  test("falls back invalid confidence to 'medium'", () => {
    const raw = JSON.stringify({
      classifications: [{ word: "smooth", domain: "texture", confidence: "VERY_HIGH" }],
    });
    expect(parseClassifications(raw, batch).find((c) => c.word === "smooth")?.confidence).toBe("medium");
  });

  test("rejects classifications for words NOT in the input batch", () => {
    const raw = JSON.stringify({
      classifications: [
        { word: "smooth",  domain: "texture",  confidence: "high" },
        { word: "phantom", domain: "texture",  confidence: "high" }, // not in batch
      ],
    });
    const out = parseClassifications(raw, batch);
    expect(out.find((c) => c.word === "phantom")).toBeUndefined();
  });

  test("dedupes if Claude returns the same word twice", () => {
    const raw = JSON.stringify({
      classifications: [
        { word: "smooth", domain: "texture", confidence: "high" },
        { word: "smooth", domain: "shape",   confidence: "high" }, // dup
      ],
    });
    const out = parseClassifications(raw, batch);
    expect(out.filter((c) => c.word === "smooth")).toHaveLength(1);
  });

  test("fills in 'other' + low confidence for words Claude omitted", () => {
    // batch has smooth + rough; Claude only returns smooth → rough gets fallback.
    const raw = JSON.stringify({
      classifications: [{ word: "smooth", domain: "texture", confidence: "high" }],
    });
    const out = parseClassifications(raw, batch);
    const rough = out.find((c) => c.word === "rough");
    expect(rough).toEqual({ word: "rough", domain: "other", confidence: "low" });
  });

  test("normalises returned domain/confidence case", () => {
    const raw = JSON.stringify({
      classifications: [{ word: "smooth", domain: "TEXTURE", confidence: "HIGH" }],
    });
    const out = parseClassifications(raw, batch);
    const smooth = out.find((c) => c.word === "smooth")!;
    expect(smooth.domain).toBe("texture");
    expect(smooth.confidence).toBe("high");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. record-consent.validateConsentBody
// ═══════════════════════════════════════════════════════════════════════════════

const fullConsent = {
  userId: "u1", policyVersion: "1.0", consentedAt: new Date().toISOString(),
  coppaConfirmed: true, gdprKConfirmed: true, aiProcessingConfirmed: true, parentalGatePassed: true,
};

describe("record-consent.validateConsentBody — strict TRUE", () => {
  test("accepts a fully populated body with all 4 booleans true", () => {
    expect(validateConsentBody(fullConsent).valid).toBe(true);
  });

  test("rejects when userId is missing", () => {
    const r = validateConsentBody({ ...fullConsent, userId: "" });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/userId/);
  });

  test("rejects when policyVersion is missing", () => {
    const r = validateConsentBody({ ...fullConsent, policyVersion: "" });
    expect(r.valid).toBe(false);
  });

  test("rejects when consentedAt is missing", () => {
    const r = validateConsentBody({ ...fullConsent, consentedAt: "" });
    expect(r.valid).toBe(false);
  });

  test("rejects when ANY single checkbox is not strictly true", () => {
    const fields = ["coppaConfirmed", "gdprKConfirmed", "aiProcessingConfirmed", "parentalGatePassed"] as const;
    for (const f of fields) {
      expect(validateConsentBody({ ...fullConsent, [f]: false }).valid).toBe(false);
      expect(validateConsentBody({ ...fullConsent, [f]: undefined }).valid).toBe(false);
    }
  });

  test("rejects truthy-but-not-strictly-true (e.g. 'yes')", () => {
    expect(validateConsentBody({ ...fullConsent, coppaConfirmed: "yes" }).valid).toBe(false);
    expect(validateConsentBody({ ...fullConsent, coppaConfirmed: 1 }).valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. request-deletion.validateDeletionConfirmation
// ═══════════════════════════════════════════════════════════════════════════════

describe("request-deletion.validateDeletionConfirmation", () => {
  test("accepts 'DELETE' (uppercase)", () => {
    expect(validateDeletionConfirmation({ confirmation: "DELETE" }).valid).toBe(true);
  });

  test("accepts 'delete' (lowercase) — case-insensitive", () => {
    expect(validateDeletionConfirmation({ confirmation: "delete" }).valid).toBe(true);
  });

  test("accepts whitespace around the keyword", () => {
    expect(validateDeletionConfirmation({ confirmation: "  DELETE  " }).valid).toBe(true);
  });

  test("rejects 'remove' or other near-matches", () => {
    expect(validateDeletionConfirmation({ confirmation: "remove" }).valid).toBe(false);
    expect(validateDeletionConfirmation({ confirmation: "DELETED" }).valid).toBe(false);
  });

  test("rejects missing or wrong-type confirmation", () => {
    expect(validateDeletionConfirmation({}).valid).toBe(false);
    expect(validateDeletionConfirmation({ confirmation: 42 as any }).valid).toBe(false);
  });

  test("clips reason to 200 chars", () => {
    const long = "x".repeat(500);
    const r = validateDeletionConfirmation({ confirmation: "DELETE", reason: long });
    if (r.valid) expect(r.reason).toHaveLength(200);
  });

  test("defaults reason to 'Not specified' when missing", () => {
    const r = validateDeletionConfirmation({ confirmation: "DELETE" });
    if (r.valid) expect(r.reason).toBe("Not specified");
  });

  test("ignores non-string reason", () => {
    const r = validateDeletionConfirmation({ confirmation: "DELETE", reason: 42 });
    if (r.valid) expect(r.reason).toBe("Not specified");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. validateBearerAuth
// ═══════════════════════════════════════════════════════════════════════════════

describe("validateBearerAuth", () => {
  test("accepts 'Bearer <token>'", () => {
    expect(validateBearerAuth("Bearer abc123").valid).toBe(true);
  });

  test("rejects null", () => {
    const r = validateBearerAuth(null);
    expect(r.valid).toBe(false);
    expect(r.status).toBe(401);
  });

  test("rejects missing Bearer prefix", () => {
    expect(validateBearerAuth("abc123").valid).toBe(false);
    expect(validateBearerAuth("Token abc123").valid).toBe(false);
  });

  test("rejects lowercase 'bearer' (production uses startsWith with exact case)", () => {
    expect(validateBearerAuth("bearer abc").valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. retire-word.validateRetireWordBody
// ═══════════════════════════════════════════════════════════════════════════════

describe("retire-word.validateRetireWordBody", () => {
  test("accepts a complete body", () => {
    expect(validateRetireWordBody({
      word: "translucent", definition: "lets light through", childAge: 7,
    }).valid).toBe(true);
  });

  test("rejects when any required field is missing", () => {
    expect(validateRetireWordBody({ definition: "x", childAge: 7 } as any).valid).toBe(false);
    expect(validateRetireWordBody({ word: "x", childAge: 7 } as any).valid).toBe(false);
    expect(validateRetireWordBody({ word: "x", definition: "x" } as any).valid).toBe(false);
  });

  test("rejects when childAge is 0 (truthy check)", () => {
    // Note: production uses truthy check, so 0 is treated as missing.
    expect(validateRetireWordBody({ word: "x", definition: "x", childAge: 0 }).valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. generate-quest.clampPropCount
// ═══════════════════════════════════════════════════════════════════════════════

describe("generate-quest.clampPropCount", () => {
  test("default 3 when undefined", () => {
    expect(clampPropCount(undefined)).toBe(3);
  });

  test("default 3 when not a number", () => {
    expect(clampPropCount("4")).toBe(3);
    expect(clampPropCount(null)).toBe(3);
    expect(clampPropCount(NaN)).toBe(3);
    expect(clampPropCount(Infinity)).toBe(3);
  });

  test("clamps below to 1, above to 5", () => {
    expect(clampPropCount(0)).toBe(1);
    expect(clampPropCount(-5)).toBe(1);
    expect(clampPropCount(99)).toBe(5);
  });

  test("passes through valid values", () => {
    [1, 2, 3, 4, 5].forEach((n) => expect(clampPropCount(n)).toBe(n));
  });

  test("floors fractional values", () => {
    expect(clampPropCount(3.7)).toBe(3);
    expect(clampPropCount(2.1)).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. generate-quest.computeMaxTokensForPropCount
// ═══════════════════════════════════════════════════════════════════════════════

describe("generate-quest.computeMaxTokensForPropCount", () => {
  // Production formula: 800 + 200 × N
  test.each([
    [1, 1000],
    [2, 1200],
    [3, 1400],
    [4, 1600],
    [5, 1800],
  ])("propCount=%i → max_tokens=%i", (n, expected) => {
    expect(computeMaxTokensForPropCount(n)).toBe(expected);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. generate-quest.validateGenerateQuestBody
// ═══════════════════════════════════════════════════════════════════════════════

describe("generate-quest.validateGenerateQuestBody", () => {
  const baseValid = { theme: "Crystal Cave", ageBand: "7-8", tier: "scholar" };

  test("accepts a valid body", () => {
    expect(validateGenerateQuestBody(baseValid).valid).toBe(true);
  });

  test("rejects empty / whitespace theme", () => {
    expect(validateGenerateQuestBody({ ...baseValid, theme: "" }).valid).toBe(false);
    expect(validateGenerateQuestBody({ ...baseValid, theme: "   " }).valid).toBe(false);
  });

  test("rejects unknown ageBand", () => {
    expect(validateGenerateQuestBody({ ...baseValid, ageBand: "3-4" }).valid).toBe(false);
    expect(validateGenerateQuestBody({ ...baseValid, ageBand: "20-21" }).valid).toBe(false);
  });

  test("accepts every valid ageBand", () => {
    for (const ab of VALID_AGE_BANDS) {
      expect(validateGenerateQuestBody({ ...baseValid, ageBand: ab }).valid).toBe(true);
    }
  });

  test("rejects unknown tier", () => {
    expect(validateGenerateQuestBody({ ...baseValid, tier: "novice" }).valid).toBe(false);
  });

  test("accepts every valid tier", () => {
    for (const t of VALID_TIERS) {
      expect(validateGenerateQuestBody({ ...baseValid, tier: t }).valid).toBe(true);
    }
  });
});
