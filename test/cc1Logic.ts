/**
 * cc1Logic.ts — pure-logic extract of:
 *   • supabase/functions/cc1/index.ts → sanitizeOutput (+ its constants)
 *
 * Mirrors the live function VERBATIM as of repo 3ed6a1b. This is the
 * child-safety core of CC1: the defense-in-depth layer that forces any
 * human-body or generic canonical to "object" even if the model ignores
 * the prompt. Untested before this file — unacceptable for a kids' app.
 *
 * Platform-agnostic: this is server-side Edge logic, identical for
 * Android and iOS clients.
 */

export const GENERIC_LABELS = new Set(["", "object", "unknown", "thing", "item"]);

export const HUMAN_BODY_BLOCKLIST = new Set([
  "person", "people", "human", "child", "kid", "baby", "infant", "toddler",
  "adult", "man", "woman", "boy", "girl",
  "face", "head", "neck", "shoulder", "shoulders",
  "hair", "skin", "flesh", "hand", "hands", "finger", "fingers",
  "arm", "arms", "leg", "legs", "foot", "feet", "knee",
  "eye", "eyes", "nose", "mouth", "lip", "lips", "ear", "ears",
  "chest", "stomach", "back",
]);

export interface ModelOutput {
  canonical: string;
  aliases: string[];
}

// Verbatim mirror of supabase/functions/cc1/index.ts :: sanitizeOutput
export function sanitizeOutput(parsed: ModelOutput): ModelOutput {
  const stripArticles = (s: string): string =>
    s.replace(/^(a|an|the)\s+/i, "").trim();

  let canonical = stripArticles(parsed.canonical);

  if (canonical.length === 0 || GENERIC_LABELS.has(canonical)) {
    canonical = "object";
  }

  if (HUMAN_BODY_BLOCKLIST.has(canonical)) {
    canonical = "object";
  }

  const aliases = canonical === "object"
    ? []
    : parsed.aliases
        .map(stripArticles)
        .filter((a) => a.length > 0)
        .filter((a) => !GENERIC_LABELS.has(a))
        .filter((a) => !HUMAN_BODY_BLOCKLIST.has(a))
        .filter((a) => a !== canonical);

  return { canonical, aliases };
}
