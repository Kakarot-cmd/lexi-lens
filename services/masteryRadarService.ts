/**
 * MasteryRadarService
 * ───────────────────
 * Reads classified words for a child, computes per-domain mastery averages
 * for the radar chart, and fires async classification for any unclassified
 * words via the `classify-words` Edge Function.
 *
 * Design:
 *   • Same conventions as sessionsService.ts (resilient Sentry shim, all
 *     errors swallowed at the boundary, components get empty state never
 *     a thrown error).
 *   • Two queries instead of a JOIN — word_tome and word_domains have no
 *     declared FK between them (intentional: word_domains is global, not
 *     scoped to children, so adding a strict FK would be misleading).
 *     Two queries + in-memory merge is also more flexible if the schema
 *     changes later.
 *   • `classifyMissingWords` is fire-and-forget. The dashboard renders with
 *     whatever's classified now; on the next mount the radar will be more
 *     complete. We don't poll or block on classification.
 */

import { supabase } from "../lib/supabase";
import * as SentryShim from "../lib/sentry";

// ─── Types ────────────────────────────────────────────────────────────────

export type Domain =
  | "texture"
  | "colour"
  | "structure"
  | "sound"
  | "shape"
  | "material"
  | "other";

/** The 6 domains shown on the radar. "other" is tracked but not plotted. */
export const RADAR_DOMAINS: ReadonlyArray<Domain> = [
  "texture",
  "colour",
  "structure",
  "sound",
  "shape",
  "material",
];

export interface DomainStat {
  domain:     Domain;
  /** Average mastery_score across classified words in this domain. 0–1. */
  avgMastery: number;
  /** Number of words classified into this domain for this child. */
  wordCount:  number;
}

export interface MasteryRadarData {
  byDomain:           DomainStat[];
  /** Words in this child's tome that don't have a domain classification yet. */
  unclassifiedCount:  number;
  /** Words classified into one of the 6 radar domains (excludes "other"). */
  totalClassified:    number;
  /** Words classified as "other". Shown only as a footnote count. */
  otherCount:         number;
}

interface TomeRow {
  word:           string;
  mastery_score:  number | null;
}

interface DomainRow {
  word:    string;
  domain:  Domain;
}

// ─── Observability shim ───────────────────────────────────────────────────

function trace(b: {
  category: string;
  message:  string;
  level?:   "info" | "warning" | "error";
  data?:    Record<string, unknown>;
}): void {
  const fn = (SentryShim as { addBreadcrumb?: (b: unknown) => void }).addBreadcrumb;
  if (typeof fn === "function") fn(b);
}

// ─── Reads ────────────────────────────────────────────────────────────────

/**
 * Fetches the child's word tome, looks up each word's domain in word_domains,
 * and rolls up to per-domain averages.
 *
 * Returns zeros for every domain on error — the UI then renders an empty
 * radar instead of throwing.
 */
export async function getMasteryRadar(childId: string): Promise<MasteryRadarData> {
  const tomeResult = await supabase
    .from("word_tome")
    .select("word, mastery_score")
    .eq("child_id", childId);

  if (tomeResult.error) {
    trace({
      category: "mastery-radar",
      level:    "error",
      message:  "tome fetch failed",
      data:     { code: tomeResult.error.code },
    });
    return emptyRadar();
  }

  const tome = (tomeResult.data ?? []) as TomeRow[];
  if (tome.length === 0) return emptyRadar();

  const words = Array.from(new Set(
    tome.map((r) => (r.word ?? "").toLowerCase().trim()).filter(Boolean)
  ));
  if (words.length === 0) return emptyRadar();

  const domainsResult = await supabase
    .from("word_domains")
    .select("word, domain")
    .in("word", words);

  if (domainsResult.error) {
    trace({
      category: "mastery-radar",
      level:    "error",
      message:  "domains fetch failed",
      data:     { code: domainsResult.error.code },
    });
    // Tome read worked but classifications didn't — still show counts.
    return {
      byDomain:          emptyByDomain(),
      unclassifiedCount: tome.length,
      totalClassified:   0,
      otherCount:        0,
    };
  }

  const domainByWord = new Map<string, Domain>();
  for (const row of (domainsResult.data ?? []) as DomainRow[]) {
    if (row.word) domainByWord.set(row.word, row.domain);
  }

  // Bucket per radar domain
  const buckets: Record<Domain, { sum: number; count: number }> = {
    texture:   { sum: 0, count: 0 },
    colour:    { sum: 0, count: 0 },
    structure: { sum: 0, count: 0 },
    sound:     { sum: 0, count: 0 },
    shape:     { sum: 0, count: 0 },
    material:  { sum: 0, count: 0 },
    other:     { sum: 0, count: 0 },
  };

  let unclassified = 0;
  for (const row of tome) {
    const w = (row.word ?? "").toLowerCase().trim();
    if (!w) continue;
    const d = domainByWord.get(w);
    if (!d) {
      unclassified += 1;
      continue;
    }
    const score = typeof row.mastery_score === "number" ? row.mastery_score : 0;
    buckets[d].sum   += score;
    buckets[d].count += 1;
  }

  const byDomain: DomainStat[] = RADAR_DOMAINS.map((d) => ({
    domain:     d,
    avgMastery: buckets[d].count > 0 ? buckets[d].sum / buckets[d].count : 0,
    wordCount:  buckets[d].count,
  }));

  const totalClassified = byDomain.reduce((acc, b) => acc + b.wordCount, 0);

  trace({
    category: "mastery-radar",
    level:    "info",
    message:  "radar fetched",
    data:     { totalClassified, unclassified, otherCount: buckets.other.count },
  });

  return {
    byDomain,
    unclassifiedCount: unclassified,
    totalClassified,
    otherCount:        buckets.other.count,
  };
}

/**
 * Fire-and-forget: invokes the `classify-words` Edge Function for any words
 * in this child's tome that don't yet have a domain in `word_domains`.
 *
 * Returns the count classified (or null on error). Callers don't need to
 * await — UI just refreshes on next mount and picks up new classifications.
 */
export async function classifyMissingWords(
  childId: string
): Promise<{ classified: number; cached: number } | null> {
  // Find the child's words first
  const tomeResult = await supabase
    .from("word_tome")
    .select("word, definition")
    .eq("child_id", childId);

  if (tomeResult.error || !tomeResult.data) {
    trace({
      category: "mastery-radar",
      level:    "error",
      message:  "classifyMissingWords: tome fetch failed",
    });
    return null;
  }

  // Define the row shape so tsc doesn't infer `any` from the supabase client
  interface TomePairRow { word: string | null; definition: string | null; }
  const rows = (tomeResult.data ?? []) as TomePairRow[];

  const tomeWords = Array.from(new Set(
    rows
      .map((r) => ({
        word: (r.word ?? "").toLowerCase().trim(),
        definition: typeof r.definition === "string" ? r.definition : "",
      }))
      .filter((r) => r.word.length > 0)
      .map((r) => JSON.stringify(r))      // dedupe by stringified pair
  )).map((s) => JSON.parse(s) as { word: string; definition: string });

  if (tomeWords.length === 0) return { classified: 0, cached: 0 };

  // Find which are already classified
  const wordList = tomeWords.map((w) => w.word);
  const domainsResult = await supabase
    .from("word_domains")
    .select("word")
    .in("word", wordList);

  if (domainsResult.error) {
    trace({
      category: "mastery-radar",
      level:    "error",
      message:  "classifyMissingWords: domains fetch failed",
    });
    return null;
  }

  const knownRows = (domainsResult.data ?? []) as Array<{ word: string }>;
  const known = new Set(knownRows.map((r) => r.word));
  const missing = tomeWords.filter((w) => !known.has(w.word));

  if (missing.length === 0) {
    return { classified: 0, cached: tomeWords.length };
  }

  trace({
    category: "mastery-radar",
    level:    "info",
    message:  "classifyMissingWords: invoking EF",
    data:     { missing: missing.length },
  });

  const { data, error } = await supabase.functions.invoke("classify-words", {
    body: { words: missing },
  });

  if (error) {
    trace({
      category: "mastery-radar",
      level:    "error",
      message:  "classify-words EF failed",
      data:     { message: error.message },
    });
    return null;
  }

  const classified = typeof (data as { classified?: number })?.classified === "number"
    ? (data as { classified: number }).classified : 0;
  const cached = typeof (data as { cached?: number })?.cached === "number"
    ? (data as { cached: number }).cached : 0;

  return { classified, cached };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function emptyByDomain(): DomainStat[] {
  return RADAR_DOMAINS.map((d) => ({ domain: d, avgMastery: 0, wordCount: 0 }));
}

function emptyRadar(): MasteryRadarData {
  return {
    byDomain:          emptyByDomain(),
    unclassifiedCount: 0,
    totalClassified:   0,
    otherCount:        0,
  };
}
