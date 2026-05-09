/**
 * scripts/prewarm-corpus.ts
 * Lexi-Lens — curated cache pre-warm corpus.
 *
 * v3 (2026-05-09): rewritten for the no-overlap 3-dungeon design.
 *
 *   The free tier now has three distinct dungeons in three distinct rooms,
 *   with three completely disjoint property pools (no word appears in more
 *   than one pool). The corpus reflects this: per-object property lists
 *   are the union of pool words across whichever dungeons that object is
 *   plausibly scanned in.
 *
 *   Pool A — Bedroom textures:    soft, fluffy, smooth, stretchy
 *   Pool B — Kitchen shape-3D:    round, hollow, cylindrical, curved
 *   Pool C — Library flatness:    flat, rectangular, rigid, thin
 *
 *   12 unique property words. Pool intersections all empty.
 *
 * The corpus is in TWO blocks:
 *
 *   1. category="free_dungeon" — high priority. Every entry maps a
 *      likely-scan object to the union of pool words it could be tested
 *      against. A "ball" gets tested for {smooth, soft} from A and
 *      {round, hollow, curved} from B because balls show up in both
 *      dungeons. A "book" gets only Pool C words. A "pillow" gets only
 *      Pool A words.
 *
 *      Run before launch:
 *        deno run -A scripts/prewarm-cache.ts --env staging \
 *          --category free_dungeon --skip-cached
 *
 *   2. category="general_household" — wider corpus, paid-tier and edge
 *      cases. Properties extend beyond the 12-word free pool. Lower
 *      priority; run after launch when prod data tells you what paid
 *      users actually scan.
 *
 * ─── Design rules ─────────────────────────────────────────────────────────
 *
 *   1. Lower-case singular labels. The cache-key normalize step handles
 *      plurals and casing — "apple" warms hits for "apples", "Apple",
 *      "APPLES" too.
 *
 *   2. 4-8 properties per entry. Production caps Anthropic at
 *      max_tokens=700; more than 8 risks truncation.
 *
 *   3. For free_dungeon entries, the property list is the union of words
 *      from any pool the object plausibly belongs to. Each (object, word)
 *      pair gets cached regardless of model verdict — false verdicts
 *      ("a book is not soft") still save a model call when a kid scans
 *      mistakenly.
 *
 *   4. Phrasal labels ("toy car", "stuffed animal", "remote control")
 *      match the canonical form the model would return as
 *      resolvedObjectName. The resolved-name cache layer maps ML Kit's
 *      labels onto these separately. iOS perceptual-hash work, when it
 *      lands, MUST resolve to this same canonical label set.
 *
 * ─── Maintenance ───────────────────────────────────────────────────────────
 *
 *   When you spot a (label, word) pair that consistently misses cache in
 *   production (run the SQL in monitor v5.3 § "Cache hit surface — repeat
 *   (label, word) pairs"), add it to free_dungeon if it's a free-tier
 *   miss, or general_household otherwise. Re-run prewarm with --skip-cached;
 *   only new entries cost the per-call rate.
 *
 *   IMPORTANT: if the 3 free-tier dungeons' age_band_properties are
 *   updated to add/remove words, update the FREE_DUNGEON_POOL constant
 *   below to match — and verify pool disjointness before committing.
 */

export interface PrewarmEntry {
  /** Object label as it would arrive from ML Kit (or be canonicalised by the model). */
  label: string;
  /** Property words to evaluate together in one model call. 4-8 items. */
  properties: string[];
  /** Category tag for grouping logs and partial runs. */
  category: string;
}

// ─── FREE-TIER DUNGEON POOLS (must match age_band_properties on the 3 free dungeons) ──
//
// These constants are the source of truth for what gets prewarmed. If the
// dungeon definitions in Supabase change, update these — pool disjointness
// is asserted at module load time (see the bottom of this file).

export const FREE_DUNGEON_POOL_A_TEXTURES   = ["soft", "fluffy", "smooth", "stretchy"]   as const;
export const FREE_DUNGEON_POOL_B_SHAPES_3D  = ["round", "hollow", "cylindrical", "curved"] as const;
export const FREE_DUNGEON_POOL_C_FLATNESS   = ["flat", "rectangular", "rigid", "thin"]   as const;

// ─── FREE-DUNGEON PRIORITY BLOCK ─────────────────────────────────────────────
//
// Per-object property mapping: each object lists the union of pool words
// from whichever dungeons it might be scanned in. The model returns a
// verdict per word; both passes and fails get cached and save future
// model calls.
//
// Object selection criteria:
//   - Things kids 5-10 actually point cameras at, in or near bedrooms,
//     kitchens, and libraries.
//   - At least one object per pool gets several entries to drive hit
//     rate concentration in that pool.
//   - Cross-pool objects (ball, plate, balloon) are explicit so a single
//     object scan during gameplay across multiple dungeons gets the right
//     verdict from cache.

const FREE_DUNGEON_ENTRIES: readonly PrewarmEntry[] = [
  // ─── BEDROOM-only objects (Pool A: textures) ─────────────────────────────
  { category: "free_dungeon", label: "pillow",          properties: ["soft", "fluffy", "smooth", "stretchy"] },
  { category: "free_dungeon", label: "blanket",         properties: ["soft", "fluffy", "smooth", "stretchy"] },
  { category: "free_dungeon", label: "teddy bear",      properties: ["soft", "fluffy", "smooth", "stretchy"] },
  { category: "free_dungeon", label: "stuffed animal",  properties: ["soft", "fluffy", "smooth", "stretchy"] },
  { category: "free_dungeon", label: "doll",            properties: ["soft", "smooth", "stretchy"] },
  { category: "free_dungeon", label: "sock",            properties: ["soft", "smooth", "stretchy"] },
  { category: "free_dungeon", label: "shirt",           properties: ["soft", "smooth", "stretchy"] },
  { category: "free_dungeon", label: "sweater",         properties: ["soft", "fluffy", "smooth", "stretchy"] },
  { category: "free_dungeon", label: "scarf",           properties: ["soft", "fluffy", "smooth", "stretchy"] },
  { category: "free_dungeon", label: "towel",           properties: ["soft", "fluffy", "smooth"] },
  { category: "free_dungeon", label: "cushion",         properties: ["soft", "fluffy", "smooth"] },
  { category: "free_dungeon", label: "rug",             properties: ["soft", "fluffy", "smooth"] },

  // ─── KITCHEN-only objects (Pool B: shape-3D) ─────────────────────────────
  { category: "free_dungeon", label: "cup",             properties: ["round", "hollow", "cylindrical", "curved"] },
  { category: "free_dungeon", label: "mug",             properties: ["round", "hollow", "cylindrical", "curved"] },
  { category: "free_dungeon", label: "bowl",            properties: ["round", "hollow", "curved"] },
  { category: "free_dungeon", label: "glass",           properties: ["round", "hollow", "cylindrical", "curved"] },
  { category: "free_dungeon", label: "bottle",          properties: ["round", "hollow", "cylindrical", "curved"] },
  { category: "free_dungeon", label: "jar",             properties: ["round", "hollow", "cylindrical", "curved"] },
  { category: "free_dungeon", label: "pot",             properties: ["round", "hollow", "cylindrical", "curved"] },
  { category: "free_dungeon", label: "kettle",          properties: ["round", "hollow", "curved"] },

  // ─── LIBRARY-only objects (Pool C: flatness) ─────────────────────────────
  { category: "free_dungeon", label: "book",            properties: ["flat", "rectangular", "rigid", "thin"] },
  { category: "free_dungeon", label: "notebook",        properties: ["flat", "rectangular", "thin"] },
  { category: "free_dungeon", label: "paper",           properties: ["flat", "rectangular", "thin"] },
  { category: "free_dungeon", label: "magazine",        properties: ["flat", "rectangular", "thin"] },
  { category: "free_dungeon", label: "ruler",           properties: ["flat", "rectangular", "rigid", "thin"] },
  { category: "free_dungeon", label: "binder",          properties: ["flat", "rectangular", "rigid"] },
  { category: "free_dungeon", label: "envelope",        properties: ["flat", "rectangular", "thin"] },
  { category: "free_dungeon", label: "card",            properties: ["flat", "rectangular", "thin", "rigid"] },

  // ─── CROSS-POOL objects (likely scanned across multiple dungeons) ────────
  // These get the union of words from EVERY pool they plausibly belong to.

  // Ball: in Bedroom (texture quest) AND Kitchen (shape quest)
  { category: "free_dungeon", label: "ball",            properties: ["soft", "smooth", "round", "hollow", "curved"] },

  // Balloon: same as ball
  { category: "free_dungeon", label: "balloon",         properties: ["smooth", "stretchy", "round", "hollow", "curved"] },

  // Plate: Kitchen (curved/round) AND Library (flat/rigid)
  { category: "free_dungeon", label: "plate",           properties: ["round", "curved", "flat", "rigid"] },

  // Tablet: typically Library (flat/rigid/rectangular) but sometimes scanned for textures
  { category: "free_dungeon", label: "tablet",          properties: ["smooth", "flat", "rectangular", "rigid", "thin"] },

  // Phone: same as tablet
  { category: "free_dungeon", label: "phone",           properties: ["smooth", "flat", "rectangular", "rigid", "thin"] },

  // Remote control: Library (rectangular/rigid) but kids hold it on bed too
  { category: "free_dungeon", label: "remote control",  properties: ["smooth", "flat", "rectangular", "rigid"] },

  // Toys that show up in Bedroom AND Library
  { category: "free_dungeon", label: "toy car",         properties: ["smooth", "round", "rigid"] },
  { category: "free_dungeon", label: "lego",            properties: ["smooth", "rigid", "rectangular"] },
  { category: "free_dungeon", label: "blocks",          properties: ["smooth", "rigid", "rectangular"] },

  // ─── COMMON FRUIT (kids carry into Bedroom + Kitchen) ────────────────────
  { category: "free_dungeon", label: "apple",           properties: ["smooth", "round", "curved"] },
  { category: "free_dungeon", label: "orange",          properties: ["round", "curved"] },
  { category: "free_dungeon", label: "banana",          properties: ["smooth", "curved"] },
];

// ─── GENERAL HOUSEHOLD BLOCK ─────────────────────────────────────────────────
//
// Wider coverage for paid-tier scans, edge-case objects, and organic-traffic
// shoulder. Properties extend beyond the 12-word free pool. Run AFTER you
// have prod data showing what paid users actually scan.

const GENERAL_HOUSEHOLD_ENTRIES: readonly PrewarmEntry[] = [
  // ─── FRUITS & VEGETABLES (extras beyond free_dungeon) ────────────────────
  { category: "general_household", label: "lemon",        properties: ["yellow", "oval", "bumpy", "sour", "small"] },
  { category: "general_household", label: "strawberry",   properties: ["red", "small", "bumpy", "sweet", "soft"] },
  { category: "general_household", label: "grape",        properties: ["small", "round", "smooth", "sweet", "purple", "green"] },
  { category: "general_household", label: "carrot",       properties: ["orange", "long", "hard", "pointy", "smooth"] },
  { category: "general_household", label: "tomato",       properties: ["red", "round", "smooth", "shiny", "soft"] },
  { category: "general_household", label: "broccoli",     properties: ["green", "bumpy", "small", "soft"] },
  { category: "general_household", label: "potato",       properties: ["brown", "round", "rough", "hard", "bumpy"] },

  // ─── KITCHEN (extras) ────────────────────────────────────────────────────
  { category: "general_household", label: "spoon",        properties: ["smooth", "shiny", "metal", "small", "curved"] },
  { category: "general_household", label: "fork",         properties: ["pointy", "shiny", "metal", "smooth"] },
  { category: "general_household", label: "knife",        properties: ["sharp", "shiny", "metal", "long"] },

  // ─── TOYS (extras) ───────────────────────────────────────────────────────
  { category: "general_household", label: "puzzle",       properties: ["flat", "small", "colorful", "hard"] },
  { category: "general_household", label: "kite",         properties: ["light", "flat", "colorful", "thin"] },
  { category: "general_household", label: "yo-yo",        properties: ["round", "small", "hard", "smooth"] },
  { category: "general_household", label: "toy train",    properties: ["long", "hard", "shiny", "small"] },

  // ─── SCHOOL (extras) ─────────────────────────────────────────────────────
  { category: "general_household", label: "pencil",       properties: ["long", "thin", "wooden", "pointy", "smooth"] },
  { category: "general_household", label: "pen",          properties: ["long", "thin", "smooth", "plastic", "shiny"] },
  { category: "general_household", label: "crayon",       properties: ["small", "smooth", "colorful", "pointy", "waxy"] },
  { category: "general_household", label: "marker",       properties: ["long", "thin", "smooth", "plastic", "colorful"] },
  { category: "general_household", label: "eraser",       properties: ["small", "soft", "rubber", "smooth"] },
  { category: "general_household", label: "scissors",     properties: ["sharp", "metal", "shiny", "small"] },
  { category: "general_household", label: "glue stick",   properties: ["small", "smooth", "sticky", "plastic"] },
  { category: "general_household", label: "backpack",     properties: ["soft", "big", "cloth", "colorful"] },

  // ─── FURNITURE & HOUSEHOLD ───────────────────────────────────────────────
  { category: "general_household", label: "chair",        properties: ["hard", "tall", "wooden", "smooth"] },
  { category: "general_household", label: "table",        properties: ["flat", "hard", "wooden", "smooth", "tall"] },
  { category: "general_household", label: "sofa",         properties: ["soft", "big", "fluffy", "cloth"] },
  { category: "general_household", label: "bed",          properties: ["soft", "big", "flat", "fluffy"] },
  { category: "general_household", label: "lamp",         properties: ["bright", "tall", "smooth", "shiny"] },
  { category: "general_household", label: "mirror",       properties: ["flat", "shiny", "smooth", "fragile"] },
  { category: "general_household", label: "clock",        properties: ["round", "flat", "hard", "smooth"] },
  { category: "general_household", label: "vase",         properties: ["tall", "smooth", "fragile", "shiny", "hollow"] },
  { category: "general_household", label: "candle",       properties: ["small", "smooth", "waxy", "cylindrical"] },
  { category: "general_household", label: "key",          properties: ["small", "metal", "shiny", "hard", "smooth"] },

  // ─── CLOTHES (extras) ────────────────────────────────────────────────────
  { category: "general_household", label: "hat",          properties: ["soft", "round", "cloth", "small"] },
  { category: "general_household", label: "shoe",         properties: ["soft", "leather", "small", "flexible"] },
  { category: "general_household", label: "jacket",       properties: ["warm", "soft", "thick", "big"] },
  { category: "general_household", label: "gloves",       properties: ["small", "soft", "warm", "stretchy"] },

  // ─── ANIMALS ─────────────────────────────────────────────────────────────
  { category: "general_household", label: "cat",          properties: ["soft", "small", "fluffy", "warm"] },
  { category: "general_household", label: "dog",          properties: ["soft", "fluffy", "warm", "big"] },
  { category: "general_household", label: "fish",         properties: ["small", "shiny", "smooth", "wet"] },
  { category: "general_household", label: "bird",         properties: ["small", "light", "soft"] },
  { category: "general_household", label: "rabbit",       properties: ["soft", "fluffy", "small", "warm"] },

  // ─── NATURE & OUTDOOR ────────────────────────────────────────────────────
  { category: "general_household", label: "tree",         properties: ["tall", "wooden", "rough", "big"] },
  { category: "general_household", label: "leaf",         properties: ["green", "thin", "flat", "small", "smooth"] },
  { category: "general_household", label: "flower",       properties: ["colorful", "small", "soft", "smooth"] },
  { category: "general_household", label: "grass",        properties: ["green", "thin", "soft", "small"] },
  { category: "general_household", label: "rock",         properties: ["hard", "rough", "heavy", "small"] },
  { category: "general_household", label: "stick",        properties: ["wooden", "long", "rough", "thin"] },
  { category: "general_household", label: "pinecone",     properties: ["brown", "rough", "small", "hard", "bumpy"] },
  { category: "general_household", label: "seashell",     properties: ["small", "smooth", "hard", "shiny"] },

  // ─── VEHICLES ────────────────────────────────────────────────────────────
  { category: "general_household", label: "car",          properties: ["big", "hard", "shiny", "metal", "smooth"] },
  { category: "general_household", label: "truck",        properties: ["big", "hard", "heavy", "metal"] },
  { category: "general_household", label: "bicycle",      properties: ["tall", "metal", "shiny", "hard"] },

  // ─── PERSONAL CARE ───────────────────────────────────────────────────────
  { category: "general_household", label: "toothbrush",   properties: ["small", "smooth", "plastic", "thin"] },
  { category: "general_household", label: "soap",         properties: ["small", "smooth", "soft", "slippery"] },
  { category: "general_household", label: "comb",         properties: ["small", "thin", "plastic", "smooth"] },

  // ─── ELECTRONICS (extras) ────────────────────────────────────────────────
  { category: "general_household", label: "laptop",       properties: ["flat", "rectangular", "smooth", "hard"] },
  { category: "general_household", label: "headphones",   properties: ["soft", "small", "plastic", "smooth"] },
];

export const PREWARM_CORPUS: readonly PrewarmEntry[] = [
  ...FREE_DUNGEON_ENTRIES,
  ...GENERAL_HOUSEHOLD_ENTRIES,
];

/**
 * Categories enumerated for --category CLI filter.
 */
export const CATEGORIES = Array.from(
  new Set(PREWARM_CORPUS.map((e) => e.category))
).sort();

/**
 * Total cache rows that will be produced if every entry runs successfully.
 * Used by the runner to surface "you're about to write N rows" pre-flight.
 */
export const TOTAL_ROWS = PREWARM_CORPUS.reduce(
  (n, e) => n + e.properties.length,
  0
);

/**
 * Free-dungeon-only stats — useful for pre-flight reporting in the runner.
 */
export const FREE_DUNGEON_STATS = {
  entries: FREE_DUNGEON_ENTRIES.length,
  rows:    FREE_DUNGEON_ENTRIES.reduce((n, e) => n + e.properties.length, 0),
};

// ─── Runtime invariant: pool disjointness ────────────────────────────────────
//
// If any pool word ends up in two pools, the no-overlap design is broken.
// Asserting this at module load means a typo in pool definition surfaces
// immediately rather than silently corrupting the cache hit assumptions.

(function assertPoolsDisjoint() {
  const pools = {
    A_textures:  new Set(FREE_DUNGEON_POOL_A_TEXTURES),
    B_shapes3D:  new Set(FREE_DUNGEON_POOL_B_SHAPES_3D),
    C_flatness:  new Set(FREE_DUNGEON_POOL_C_FLATNESS),
  };
  const pairs: Array<[keyof typeof pools, keyof typeof pools]> = [
    ["A_textures", "B_shapes3D"],
    ["A_textures", "C_flatness"],
    ["B_shapes3D", "C_flatness"],
  ];
  for (const [x, y] of pairs) {
    const overlap = [...pools[x]].filter((w) => pools[y].has(w));
    if (overlap.length > 0) {
      throw new Error(
        `prewarm-corpus.ts: free-dungeon pools overlap between ${x} and ${y}: ${overlap.join(", ")}`
      );
    }
  }
})();
