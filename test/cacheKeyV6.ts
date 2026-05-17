/**
 * cacheKeyV6.ts — pure-logic extract of:
 *   • supabase/functions/evaluate/index.ts → buildPerPropCacheKey,
 *     normalizeForKey (v6 cache architecture)
 *
 * Verbatim mirror as of repo 3ed6a1b. NOTE: the legacy
 * test/evaluateHandler.ts still exports a v4.7 3-arg `buildCacheKey`
 * which production NO LONGER USES (renamed + re-architected to the
 * per-property canonical key below in the v6 cache rework). That legacy
 * suite is orphaned, not broken — left intact deliberately. THIS file
 * tests the contract production actually ships. Platform-agnostic.
 */

const ENV_NAME = "test"; // mirrors evaluate's ENV_NAME resolution under test
const KEY_SEGMENT_MAX = 80;
const FULL_KEY_MAX = 200;

// Verbatim mirror of evaluate/index.ts :: normalizeForKey
export function normalizeForKey(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/([a-z]{2,})([^se])s\b/g, "$1$2")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, KEY_SEGMENT_MAX);
}

// btoa shim for Node test env (Edge runtime has btoa natively)
const b64 = (s: string): string =>
  typeof btoa === "function"
    ? btoa(s)
    : Buffer.from(s, "binary").toString("base64");

// Verbatim mirror of evaluate/index.ts :: buildPerPropCacheKey
export function buildPerPropCacheKey(label: string, word: string): string {
  const nl = normalizeForKey(label);
  const nw = normalizeForKey(word);

  if (nl.length === 0 || nw.length === 0) {
    return `${ENV_NAME}:lexi:v6:verdict:_h:${b64(`${label}::${word}`).replace(/=/g, "")}`;
  }

  const key = `${ENV_NAME}:lexi:v6:verdict:${nl}:${nw}`;
  if (key.length > FULL_KEY_MAX) {
    return `${ENV_NAME}:lexi:v6:verdict:_h:${b64(`${label}::${word}`).replace(/=/g, "")}`;
  }
  return key;
}
