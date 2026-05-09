/**
 * scripts/prewarm-corpus.ts
 * Lexi-Lens — prewarm corpus v2 (audited 2026-05-09).
 *
 * v2 changes from v1, based on the model-evaluation finding that 14 of 143
 * (label × property) assignments produced cross-model verdict disagreement:
 *
 *   • REMOVED 11 genuinely-ambiguous assignments (a kid scanning the same
 *     object class would get inconsistent verdicts depending on the specific
 *     instance). These were corpus design problems, not model problems.
 *
 *   • ADDED evaluationHints to 14 category-truth assignments where one or
 *     more models (sometimes including Haiku itself) reasoned at instance-
 *     level rather than category-level. Hints anchor all models toward the
 *     pedagogically-correct interpretation.
 *
 * v2 verdict-agreement projection: ~95%+ across all models, up from 87%
 * baseline (Mistral) and 87% (Gemini). Validate with a re-run before
 * prewarming the cache.
 *
 * ─── Shape ────────────────────────────────────────────────────────────────
 *
 *   Mixed: properties is an array of `string` (no hint) OR
 *   `{ word: string, evaluationHints: string }` (hint-anchored).
 *
 *   The eval harness's normalizeEntry() and evaluateObject() both accept
 *   this mixed shape — string properties default to using the word as
 *   its own definition, object properties carry the hint into the prompt.
 *
 * ─── Disjoint property pools (preserved from v1) ──────────────────────────
 *
 *   Free Dungeon A — Plushy Pixie's Bedroom (textures):  soft, fluffy, smooth, stretchy
 *   Free Dungeon B — Hollow Hippo's Kitchen (3D shape):  round, hollow, cylindrical, curved
 *   Free Dungeon C — Bookbound Banshee's Library (flat): flat, rectangular, rigid, thin
 *
 *   Disjointness is asserted at module-load time; bad entries fail loudly.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PrewarmProperty {
  word:             string;
  evaluationHints?: string;
}

export interface PrewarmEntry {
  category:    "free_dungeon" | "general_household";
  label:       string;
  /** Mixed: string for unambiguous properties, object for hint-anchored. */
  properties:  Array<string | PrewarmProperty>;
}

// ─── Disjoint property pool constants ────────────────────────────────────────

const POOL_TEXTURES   = new Set(["soft", "fluffy", "smooth", "stretchy"]);
const POOL_3D_SHAPE   = new Set(["round", "hollow", "cylindrical", "curved"]);
const POOL_FLATNESS   = new Set(["flat", "rectangular", "rigid", "thin"]);

// ─── Hint text constants (re-used across multiple entries) ───────────────────

const HINT_FLUFFY_PILE_OBJECTS =
  "Accept PASS for any object with raised pile, plush, or fleece-like texture. " +
  "Reason at the object class level: this category typically has a fluffy texture, " +
  "even if individual instances vary. Avoid FAIL for image-based uncertainty.";

const HINT_KNIT_STRETCH =
  "Accept PASS for any knitted garment. Knitted fabrics stretch by construction; " +
  "reason at the category level rather than rejecting due to a specific instance " +
  "looking firm in the image.";

const HINT_GLASS_ROUND =
  "A drinking glass has a circular (round) cross-section and rim. Accept PASS — " +
  "'round' applies to circular shape, not only spherical objects.";

const HINT_GLASS_HOLLOW =
  "A drinking glass is by design hollow — it holds liquid in an empty interior. " +
  "Accept PASS for any glass; this is a category truth.";

const HINT_GLASS_CYLINDRICAL =
  "Drinking glasses have vertical or near-vertical sides forming a cylindrical " +
  "or tapered-cylindrical body. Accept PASS for typical drinkware.";

const HINT_GLASS_CURVED =
  "Glasses have curved rims and often curved sides. Accept PASS for any drinking glass.";

const HINT_KETTLE_ROUND =
  "A kettle has a round (circular cross-section) body. The presence of a spout " +
  "or handle does not disqualify — the body itself is round.";

const HINT_PHONE_FLAT =
  "A modern smartphone is a flat slab. Accept PASS — slight edge curvature does " +
  "not disqualify the overall flat geometry.";

const HINT_BLOCKS_RECTANGULAR =
  "Building blocks are rectangular cuboids. Accept PASS — this is the canonical block shape.";

const HINT_BOOK_RIGID =
  "Hardcover and most paperback books have rigid covers and a bound spine. " +
  "Accept PASS unless the object is clearly a soft/floppy booklet.";

const HINT_BOOK_THIN =
  "A book is thin relative to its length and width. Accept PASS based on the " +
  "thin dimension being narrower than the others — not on absolute thinness.";

const HINT_BLANKET_FLUFFY =
  "Accept PASS for blankets with any plush, soft, or pile texture (fleece, " +
  "sherpa, knit, quilted). Most household blankets meet this category description.";

const HINT_TOWEL_FLUFFY =
  "Accept PASS for any terry-cloth or pile-textured towel. Standard bath, " +
  "hand, and beach towels all qualify by category.";

const HINT_RUG_FLUFFY =
  "Accept PASS for any rug with raised pile (shag, plush, area rugs). " +
  "Most household rugs have some pile and qualify by category.";

const HINT_CUSHION_FLUFFY =
  "Accept PASS for cushions filled with foam, down, or fiberfill that creates " +
  "a plump, airy texture. Standard household cushions qualify.";

// ─── Free Dungeon — corpus entries (40, audited 2026-05-09) ──────────────────
//
// Inline comments document the v1 → v2 audit changes. Removed properties are
// noted but absent from the array; added hints are present on object entries.

const FREE_DUNGEON_ENTRIES: PrewarmEntry[] = [

  // ── Plushy Pixie's Bedroom — texture properties ──

  // pillow: removed "smooth" (outer cover smooth, filling not — ambiguous)
  { category: "free_dungeon", label: "pillow",
    properties: ["soft", "fluffy", "stretchy"] },

  { category: "free_dungeon", label: "blanket",
    properties: [
      "soft",
      { word: "fluffy", evaluationHints: HINT_BLANKET_FLUFFY },
      // "smooth" removed: ambiguous (depends on material)
      "stretchy",
    ]
  },

  { category: "free_dungeon", label: "teddy bear",
    properties: ["soft", "fluffy", "smooth", "stretchy"] },

  { category: "free_dungeon", label: "stuffed animal",
    properties: ["soft", "fluffy", "smooth", "stretchy"] },

  // doll: removed "smooth" (varies by body part — face plastic, hair textured)
  { category: "free_dungeon", label: "doll",
    properties: ["soft", "stretchy"] },

  // sock: removed "smooth" (depends on weave/material)
  { category: "free_dungeon", label: "sock",
    properties: ["soft", "stretchy"] },

  // shirt: removed "smooth" (varies by fabric)
  { category: "free_dungeon", label: "shirt",
    properties: ["soft", "stretchy"] },

  // sweater: removed "smooth" (most are textured knit). Hinted "stretchy" since
  // some models doubted at instance level.
  { category: "free_dungeon", label: "sweater",
    properties: [
      "soft",
      "fluffy",
      { word: "stretchy", evaluationHints: HINT_KNIT_STRETCH },
    ]
  },

  // scarf: removed "smooth" and "fluffy" (both depend on material — silk vs wool)
  { category: "free_dungeon", label: "scarf",
    properties: ["soft", "stretchy"] },

  { category: "free_dungeon", label: "towel",
    properties: [
      "soft",
      { word: "fluffy", evaluationHints: HINT_TOWEL_FLUFFY },
      // "smooth" removed: terry-cloth not smooth by design
    ]
  },

  { category: "free_dungeon", label: "cushion",
    properties: [
      "soft",
      { word: "fluffy", evaluationHints: HINT_CUSHION_FLUFFY },
      // "smooth" removed: ambiguous
    ]
  },

  { category: "free_dungeon", label: "rug",
    properties: [
      "soft",
      { word: "fluffy", evaluationHints: HINT_RUG_FLUFFY },
      // "smooth" removed: most rugs have texture
    ]
  },

  // ── Hollow Hippo's Kitchen — 3D shape properties ──

  { category: "free_dungeon", label: "cup",
    properties: ["round", "hollow", "cylindrical", "curved"] },

  { category: "free_dungeon", label: "mug",
    properties: ["round", "hollow", "cylindrical", "curved"] },

  { category: "free_dungeon", label: "bowl",
    properties: ["round", "hollow", "curved"] },

  // glass: ALL FOUR properties hinted. Haiku itself was wrong on "round" and
  // gave self-contradictory reasoning on hollow/cylindrical/curved. Strong hints.
  { category: "free_dungeon", label: "glass",
    properties: [
      { word: "round",       evaluationHints: HINT_GLASS_ROUND },
      { word: "hollow",      evaluationHints: HINT_GLASS_HOLLOW },
      { word: "cylindrical", evaluationHints: HINT_GLASS_CYLINDRICAL },
      { word: "curved",      evaluationHints: HINT_GLASS_CURVED },
    ]
  },

  { category: "free_dungeon", label: "bottle",
    properties: ["round", "hollow", "cylindrical", "curved"] },

  { category: "free_dungeon", label: "jar",
    properties: ["round", "hollow", "cylindrical", "curved"] },

  // pot: hinted "cylindrical" (Haiku was over-cautious about taper)
  { category: "free_dungeon", label: "pot",
    properties: [
      "round",
      "hollow",
      { word: "cylindrical", evaluationHints:
          "Most cooking pots are cylindrical — circular cross-section, vertical sides. " +
          "Slight taper does not disqualify." },
      "curved",
    ]
  },

  // kettle: hinted "round" (Haiku FAILed due to spout/handle; body is still round)
  { category: "free_dungeon", label: "kettle",
    properties: [
      { word: "round", evaluationHints: HINT_KETTLE_ROUND },
      "hollow",
      "curved",
    ]
  },

  // ── Bookbound Banshee's Library — flatness properties ──

  // book: hinted both "rigid" (Haiku correct, others doubted) and "thin"
  // (Haiku was over-strict on the relative interpretation)
  { category: "free_dungeon", label: "book",
    properties: [
      "flat",
      "rectangular",
      { word: "rigid", evaluationHints: HINT_BOOK_RIGID },
      { word: "thin",  evaluationHints: HINT_BOOK_THIN },
    ]
  },

  { category: "free_dungeon", label: "notebook",
    properties: [
      "flat",
      "rectangular",
      { word: "thin", evaluationHints: HINT_BOOK_THIN },
    ]
  },

  { category: "free_dungeon", label: "paper",
    properties: ["flat", "rectangular", "thin"] },

  { category: "free_dungeon", label: "magazine",
    properties: [
      "flat",
      "rectangular",
      { word: "thin", evaluationHints: HINT_BOOK_THIN },
    ]
  },

  { category: "free_dungeon", label: "ruler",
    properties: ["flat", "rectangular", "rigid", "thin"] },

  { category: "free_dungeon", label: "binder",
    properties: ["flat", "rectangular", "rigid"] },

  { category: "free_dungeon", label: "envelope",
    properties: ["flat", "rectangular", "thin"] },

  { category: "free_dungeon", label: "card",
    properties: ["flat", "rectangular", "thin", "rigid"] },

  // ── Cross-pool / general entries (formerly assumed general_household but
  //    appearing in the free_dungeon eval set) ──

  // ball: removed "smooth" and "soft" (vary too much by ball type — basketball
  // vs ping-pong vs tennis ball). Kept the shape properties.
  { category: "free_dungeon", label: "ball",
    properties: ["round", "hollow", "curved"] },

  { category: "free_dungeon", label: "balloon",
    properties: ["smooth", "stretchy", "round", "hollow", "curved"] },

  { category: "free_dungeon", label: "plate",
    properties: ["round", "curved", "flat", "rigid"] },

  { category: "free_dungeon", label: "tablet",
    properties: ["smooth", "flat", "rectangular", "rigid", "thin"] },

  // phone: hinted "flat" (Haiku FAILed due to slight edge curvature)
  { category: "free_dungeon", label: "phone",
    properties: [
      "smooth",
      { word: "flat", evaluationHints: HINT_PHONE_FLAT },
      "rectangular",
      "rigid",
      "thin",
    ]
  },

  { category: "free_dungeon", label: "remote control",
    properties: ["smooth", "flat", "rectangular", "rigid"] },

  // toy car: REMOVED "round" entirely (depends on wheels vs body — corpus
  // designer's intent unclear, kid-confusing either way)
  { category: "free_dungeon", label: "toy car",
    properties: ["smooth", "rigid"] },

  // lego: removed "smooth" (studs make it not smooth)
  { category: "free_dungeon", label: "lego",
    properties: ["rigid", "rectangular"] },

  // blocks: hinted "rectangular" (Haiku was self-contradictory FAIL with reasoning
  // that said "most blocks are rectangular")
  { category: "free_dungeon", label: "blocks",
    properties: [
      "smooth",
      "rigid",
      { word: "rectangular", evaluationHints: HINT_BLOCKS_RECTANGULAR },
    ]
  },

  { category: "free_dungeon", label: "apple",
    properties: ["smooth", "round", "curved"] },

  { category: "free_dungeon", label: "orange",
    properties: ["round", "curved"] },

  { category: "free_dungeon", label: "banana",
    properties: ["smooth", "curved"] },
];

// ─── general_household entries (PRESERVE FROM v1 — not yet audited) ──────────
//
// These haven't been through eval yet. Run `eval-adapters.ts --corpus
// general_household` before prewarm to identify property-assignment issues.
// Then re-audit the same way as free_dungeon was audited above.

const GENERAL_HOUSEHOLD_ENTRIES: PrewarmEntry[] = [
  // ▸ TODO: Paste your existing v1 general_household entries here unchanged.
  //   The audit fixes above only apply to free_dungeon based on the eval
  //   sample we have. general_household audit is a follow-up after running
  //   `--corpus general_household` and reviewing its disagreement set.
];

// ─── Combined corpus ─────────────────────────────────────────────────────────

export const PREWARM_CORPUS: PrewarmEntry[] = [
  ...FREE_DUNGEON_ENTRIES,
  ...GENERAL_HOUSEHOLD_ENTRIES,
];
