/**
 * otherEdgeFunctions.ts — extracts from:
 *   • supabase/functions/classify-words/index.ts
 *   • supabase/functions/record-consent/index.ts
 *   • supabase/functions/request-deletion/index.ts
 *   • supabase/functions/retire-word/index.ts
 *   • supabase/functions/generate-quest/index.ts
 */

// ═════════════════════════════════════════════════════════════════════════════
// classify-words
// ═════════════════════════════════════════════════════════════════════════════

export const VALID_DOMAINS = [
  "texture", "colour", "structure", "sound", "shape", "material", "other",
] as const;
export type Domain = typeof VALID_DOMAINS[number];

export const VALID_CONFIDENCE = ["high", "medium", "low"] as const;
export type Confidence = typeof VALID_CONFIDENCE[number];

export const MAX_INPUT_WORDS = 200;

export interface InputWord     { word: string; definition: string; }
export interface Classification {
  word:       string;
  domain:     Domain;
  confidence: Confidence;
}

export function sanitizeInput(rawWords: unknown[]): InputWord[] {
  const out: InputWord[] = [];
  const seen = new Set<string>();

  for (const raw of rawWords.slice(0, MAX_INPUT_WORDS)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { word?: unknown; definition?: unknown };
    const word = typeof r.word === "string" ? r.word.toLowerCase().trim() : "";
    const def  = typeof r.definition === "string" ? r.definition.trim() : "";
    if (!word || word.length > 50) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    out.push({ word, definition: def });
  }
  return out;
}

export function parseClassifications(rawText: string, batch: InputWord[]): Classification[] {
  const cleaned = rawText.replace(/```json|```/g, "").trim();

  let parsed: { classifications?: unknown };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  if (!parsed || !Array.isArray(parsed.classifications)) return [];

  const inputWordSet = new Set(batch.map((w) => w.word));
  const validated: Classification[] = [];
  const seen = new Set<string>();

  for (const raw of parsed.classifications) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { word?: unknown; domain?: unknown; confidence?: unknown };

    const word = typeof r.word === "string" ? r.word.toLowerCase().trim() : "";
    if (!word || !inputWordSet.has(word) || seen.has(word)) continue;

    const domain = typeof r.domain === "string"
      ? r.domain.toLowerCase().trim() as Domain
      : "other" as Domain;
    const safeDomain: Domain = (VALID_DOMAINS as readonly string[]).includes(domain)
      ? domain : "other";

    const confidence = typeof r.confidence === "string"
      ? r.confidence.toLowerCase().trim() as Confidence
      : "medium" as Confidence;
    const safeConfidence: Confidence = (VALID_CONFIDENCE as readonly string[]).includes(confidence)
      ? confidence : "medium";

    validated.push({ word, domain: safeDomain, confidence: safeConfidence });
    seen.add(word);
  }

  // Fallback for omitted words
  for (const w of batch) {
    if (!seen.has(w.word)) {
      validated.push({ word: w.word, domain: "other", confidence: "low" });
    }
  }

  return validated;
}

// ═════════════════════════════════════════════════════════════════════════════
// record-consent
// ═════════════════════════════════════════════════════════════════════════════

export type ConsentValidation =
  | { valid: true }
  | { valid: false; status: number; error: string };

export function validateConsentBody(body: Record<string, unknown>): ConsentValidation {
  const { userId, policyVersion, consentedAt, coppaConfirmed, gdprKConfirmed,
          aiProcessingConfirmed, parentalGatePassed } = body;

  if (!userId || typeof userId !== "string") {
    return { valid: false, status: 400, error: "userId is required" };
  }
  if (!policyVersion || !consentedAt) {
    return { valid: false, status: 400, error: "policyVersion and consentedAt are required" };
  }
  if (coppaConfirmed !== true || gdprKConfirmed !== true ||
      aiProcessingConfirmed !== true || parentalGatePassed !== true) {
    return { valid: false, status: 400, error: "All consent checkboxes must be true" };
  }
  return { valid: true };
}

// ═════════════════════════════════════════════════════════════════════════════
// request-deletion
// ═════════════════════════════════════════════════════════════════════════════

export type DeletionValidation =
  | { valid: true; reason: string }
  | { valid: false; status: number; error: string };

export function validateDeletionConfirmation(body: { confirmation?: unknown; reason?: unknown }): DeletionValidation {
  if (
    typeof body.confirmation !== "string" ||
    body.confirmation.trim().toUpperCase() !== "DELETE"
  ) {
    return {
      valid: false,
      status: 400,
      error: "Field 'confirmation' must equal 'DELETE'. Request rejected.",
    };
  }
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 200) : "Not specified";
  return { valid: true, reason };
}

export function validateBearerAuth(authHeader: string | null): { valid: boolean; status?: number; error?: string } {
  if (!authHeader?.startsWith("Bearer ")) {
    return { valid: false, status: 401, error: "Authorization header missing or malformed." };
  }
  return { valid: true };
}

// ═════════════════════════════════════════════════════════════════════════════
// retire-word
// ═════════════════════════════════════════════════════════════════════════════

export function validateRetireWordBody(body: { word?: unknown; definition?: unknown; childAge?: unknown }): {
  valid: boolean; status?: number; error?: string;
} {
  if (!body.word || !body.definition || !body.childAge) {
    return { valid: false, status: 400, error: "Missing word, definition, or childAge" };
  }
  return { valid: true };
}

// ═════════════════════════════════════════════════════════════════════════════
// generate-quest
// ═════════════════════════════════════════════════════════════════════════════

export const VALID_AGE_BANDS = ["5-6", "7-8", "9-10", "11-12"] as const;
export type AgeBand = typeof VALID_AGE_BANDS[number];

export const VALID_TIERS = ["apprentice", "scholar", "sage", "archmage"] as const;
export type Tier = typeof VALID_TIERS[number];

export function clampPropCount(propCount: unknown): number {
  // Default 3, range 1–5.
  if (typeof propCount !== "number" || !Number.isFinite(propCount)) return 3;
  return Math.max(1, Math.min(5, Math.floor(propCount)));
}

export function computeMaxTokensForPropCount(propCount: number): number {
  // 800 + 200 × N — production formula.
  return 800 + 200 * propCount;
}

export function validateGenerateQuestBody(body: Record<string, unknown>): {
  valid: boolean; status?: number; error?: string;
} {
  if (!body.theme || typeof body.theme !== "string" || (body.theme as string).trim() === "") {
    return { valid: false, status: 400, error: "theme is required" };
  }
  if (!VALID_AGE_BANDS.includes(body.ageBand as AgeBand)) {
    return { valid: false, status: 400, error: "ageBand must be one of 5-6, 7-8, 9-10, 11-12" };
  }
  if (!VALID_TIERS.includes(body.tier as Tier)) {
    return { valid: false, status: 400, error: "tier must be apprentice, scholar, sage, or archmage" };
  }
  return { valid: true };
}
