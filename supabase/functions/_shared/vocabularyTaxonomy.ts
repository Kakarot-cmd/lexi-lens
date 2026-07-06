/**
 * supabase/functions/_shared/vocabularyTaxonomy.ts
 * Lexi-Lens — SINGLE SOURCE OF TRUTH for the per-age-band vocabulary taxonomy.
 *
 * Extracted from generate-quest/index.ts (v5.0) so that BOTH the parent quest
 * generator (generate-quest) and the daily quest generator (ensure-daily-quest)
 * draw from the same axis-grouped word pools. Previously the daily had its own
 * inline prompt with NO word pool, which caused the daily generator to keep
 * regenerating the same sensory trio and hitting property_set_collision.
 *
 * Anyone editing the word lists edits them HERE, once.
 */

// ─── Vocabulary taxonomy ──────────────────────────────────────────────────────
//
// v5.0 (2026-06-02): Restructured from a single flat material-property list into
// MULTIPLE PERCEPTUAL AXES (see history below).
//
// v6.0 (2026-06-21): Axis expansion + noun categories. Rationale:
//   • COLOR DOMINANCE FIX. With only ~2 escalating axes at the daily band (7-8),
//     the generator leaned on color almost every quest — and color is the one
//     axis flagged escalates:false (no vocabulary growth). Added three NEW
//     first-class axes that a phone camera + the vision eval judge as reliably
//     as color but which DO escalate: `transparency`, `finish`, `edge`. The
//     daily band now has 4 escalating axes instead of 2, so color is one option
//     among many rather than the path of least resistance.
//   • DE-POLLUTED COLOR. Transparency/finish words (transparent, metallic,
//     reflective) were mis-filed inside the `color` axis. They are NOT colors;
//     filing them there meant "pick a color" kept landing on a non-color word.
//     Moved to their proper axes.
//   • RETIRED the camera-UNVERIFIABLE members of `physical-state` (flexible,
//     rigid, fragile, durable, elastic, hollow). A still photo cannot establish
//     flexibility/durability — this is exactly the "correct in reality, app says
//     no" failure the v5.0 note warns about. The visible members (transparent,
//     opaque, reflective) moved to transparency/finish; the axis is retired.
//   • NOUN CATEGORIES. Added `nounCategories` per band: category nouns (utensil,
//     container, garment, …) with concrete findable examples and a hypernym
//     escalation ladder (spoon → utensil → cutlery). Nouns reuse the eval's
//     existing `resolvedObjectName` (object identity is already computed every
//     scan), teach classification vocabulary, and — crucially for longevity —
//     compose with adjectives (noun × adjective) to multiply the quest space far
//     beyond what adjectives alone can reach. Category nouns (not narrow ones)
//     keep quests findable and keep verification reliable. All nouns are
//     inanimate everyday objects; nothing that requires photographing a person
//     (the CHILD_SAFETY path already resolves people to "object", so a noun
//     quest can never be satisfied by a photo of a person).
//
// v5.0 (2026-06-02): Restructured from a single flat material-property list into
// MULTIPLE PERCEPTUAL AXES. Rationale:
//   • The old pool was one conceptual axis ("material/physical property"). At
//     age 5-6 that was only 20 words → the daily-quest generator kept hitting
//     property_set_collision and falling back to recycled seed quests.
//   • Color / shape / size / count / pattern are MORE reliably evaluable from a
//     single camera frame than the material words, and are core early-childhood
//     vocabulary. Adding them multiplies the generation space (sensory × color ×
//     shape ≫ sensory alone), which is the real fix for collisions.
//   • CAMERA-UNVERIFIABLE words were RETIRED. A property the vision model cannot
//     see in a still image (magnetism, temperature, conductivity, absorbency)
//     forces the model to hedge, and evaluateObject's hedging-cap then scores it
//     0.55 → passes:false. Net effect: a child scans a genuinely-magnetic object,
//     is correct in reality, and the app tells them "no" — the worst UX we ship.
//     Those words are removed from generation so they stop reaching kids.
//
// AXIS ESCALATION:
//   escalates:true  → has meaningful upward synonyms; eligible for hard-mode
//                     (e.g. soft → squishy → pliable). Sensory + material axes.
//   escalates:false → no sensible higher register (red has no Latinate upgrade).
//                     Hard mode for these axes = ADD a property / COMBINE axes,
//                     handled in the prompt — never "find a fancier word".
//                     Prevents the flat→planar/laminated/stratified mis-scaling
//                     bug seen on 5-6 quests.

export interface Axis {
  name:       string;   // human-readable axis label used in the prompt
  words:      string[];
  escalates:  boolean;  // see AXIS ESCALATION above
}

/**
 * A noun the quest can target by CATEGORY. The child finds any object whose
 * resolved identity belongs to the category. Category nouns (not specific
 * nouns) keep quests findable and verification reliable.
 */
export interface NounCategory {
  category:   string;    // the category word the quest names + teaches, e.g. "utensil"
  examples:   string[];  // concrete findable instances, e.g. ["spoon","fork"]
  escalates:  boolean;   // can it step up to a higher-register category for hard mode?
  harder?:    string;    // the higher-register category word when escalates (e.g. "cutlery")
}

export const TAXONOMY: Record<string, {
  propertyType:     string;
  axes:             Axis[];
  /** Category nouns for noun × adjective quests. Optional: a band without it
   *  simply generates adjective-only quests (back-compatible). */
  nounCategories?:  NounCategory[];
  /** Flattened convenience view — preserves the old `wordPool` contract.
   *  Populated by the rebuild loop below (NOT in the literals), so it is
   *  optional at definition time but always present at runtime. */
  wordPool?:        string[];
  hardModePool:     string;
  maxSyllables:     number;
  defaultPropCount: Record<string, number>;
  objectExamples:   string;
  feedbackCeiling:  string;
}> = {
  "5-6": {
    propertyType: "basic sensory + color, shape, size, count",
    axes: [
      { name: "sensory", escalates: true, words: [
        "hard", "soft", "rough", "smooth",
        "bumpy", "fuzzy", "squishy", "stretchy",
      ] },
      { name: "finish", escalates: true, words: [
        "shiny", "dull",
      ] },
      { name: "transparency", escalates: true, words: [
        "see-through", "clear",
      ] },
      { name: "color", escalates: false, words: [
        "red", "blue", "green", "yellow", "orange", "purple",
        "pink", "brown", "black", "white",
      ] },
      { name: "shape", escalates: false, words: [
        "round", "square", "flat", "pointy", "curved", "straight", "long",
      ] },
      { name: "size", escalates: false, words: [
        "big", "small", "tall", "tiny", "wide",
      ] },
      { name: "count", escalates: false, words: [
        "one", "two", "many",
      ] },
    ],
    nounCategories: [
      { category: "toy",   examples: ["ball", "block", "doll", "toy car"], escalates: false },
      { category: "fruit", examples: ["apple", "banana", "orange"],        escalates: false },
      { category: "cup",   examples: ["cup", "mug", "glass"],              escalates: false },
      { category: "shoe",  examples: ["shoe", "sandal", "boot"],           escalates: false },
      { category: "hat",   examples: ["hat", "cap"],                       escalates: false },
    ],
    // RETIRED from 5-6: heavy, light (weight ≈ guessable but unreliable from a
    // photo), wet, dry, hot, cold (temperature/moisture not visible), sticky,
    // crunchy, slippery (require touch/sound, not sight).
    hardModePool: `
      hard → solid
      soft → squishy → pliable
      shiny → gleaming → lustrous (pick ONE next step up, not both)
      see-through → clear
      rough → bumpy → textured
      stretchy → flexible
      (color / shape / size / count words do NOT escalate — see hard-mode rules)`,
    maxSyllables: 2,
    defaultPropCount: { apprentice: 1, scholar: 1, sage: 1, archmage: 1 },
    objectExamples: "spoon, pillow, stone, leaf, sock, cup, pencil, crayon, toy block, blanket, ball, book, clear bottle",
    feedbackCeiling: `
      - Maximum sentence length: 8 words.
      - No compound sentences ("and", "but", "because" are fine; semicolons are not).
      - Use ONLY words a 5-year-old knows. If in doubt, use a simpler word.
      - Forbidden in feedback: any word longer than 2 syllables, science terms, adjectives above this list.`,
  },

  "7-8": {
    propertyType: "transparency + finish + edge + color, shape, size",
    axes: [
      { name: "sensory", escalates: true, words: [
        "smooth", "rough", "bumpy", "fuzzy",
      ] },
      { name: "transparency", escalates: true, words: [
        "transparent", "opaque", "see-through", "clear", "cloudy",
      ] },
      { name: "finish", escalates: true, words: [
        "shiny", "dull", "matte", "glossy", "reflective",
      ] },
      { name: "edge", escalates: true, words: [
        "pointed", "rounded", "sharp", "blunt",
      ] },
      { name: "color", escalates: false, words: [
        "red", "blue", "green", "yellow", "orange", "purple",
        "pink", "brown", "black", "white", "grey", "gold", "silver",
      ] },
      { name: "shape", escalates: false, words: [
        "round", "square", "rectangular", "oval", "curved", "flat", "narrow",
      ] },
      { name: "size", escalates: false, words: [
        "large", "small", "thin", "thick", "wide", "narrow",
      ] },
      { name: "pattern", escalates: false, words: [
        "striped", "spotted", "plain",
      ] },
    ],
    nounCategories: [
      { category: "utensil",   examples: ["spoon", "fork", "ladle", "whisk"], escalates: true,  harder: "cutlery" },
      { category: "container", examples: ["cup", "bowl", "jar", "box"],       escalates: true,  harder: "vessel" },
      { category: "clothing",  examples: ["shirt", "sock", "hat", "glove"],   escalates: true,  harder: "garment" },
      { category: "vehicle",   examples: ["toy car", "truck", "bus", "bike"], escalates: false },
      { category: "furniture", examples: ["chair", "table", "stool"],         escalates: false },
      { category: "fruit",     examples: ["apple", "grape", "lemon"],         escalates: false },
      // 2026-07 addition (ask: "no overlap of words for at least 10 days"):
      // the category axis was capped at 6 options while pickCategory() draws
      // uniformly at random with no memory of recent picks — with only 6
      // choices, a repeat inside a 10-day window is close to guaranteed by
      // pigeonhole, no matter how the picking logic is fixed. Grown to 15 here
      // so the pool has the same kind of headroom the adjective axis was
      // deliberately sized for (45 words / 6 axes → ~1.5x the 30 needed over
      // 10 days). 15 vs. a strict minimum of 10 gives the same ~1.5x buffer.
      // Paired with the pickCategory(...,excludeCategories) change in
      // nounTarget.ts — pool size alone doesn't enforce anything; the caller
      // has to actually consult recent history too.
      { category: "toy",       examples: ["ball", "block", "doll", "toy car"],          escalates: false },
      { category: "bag",       examples: ["backpack", "purse", "pouch", "tote bag"],    escalates: false },
      { category: "book",      examples: ["book", "notebook", "magazine"],              escalates: false },
      { category: "shoe",      examples: ["shoe", "sandal", "boot", "slipper"],         escalates: true,  harder: "footwear" },
      { category: "tool",      examples: ["hammer", "screwdriver", "wrench", "pliers"], escalates: true,  harder: "implement" },
      { category: "gadget",    examples: ["remote control", "calculator", "tablet"],    escalates: true,  harder: "device" },
      { category: "plant",     examples: ["potted plant", "flower", "houseplant"],      escalates: false },
      { category: "cookware",  examples: ["pot", "pan", "tray", "lid"],                 escalates: false },
      { category: "pillow",    examples: ["pillow", "cushion", "throw pillow"],         escalates: false },
    ],
    // RETIRED from 7-8: the old `physical-state` axis (flexible, rigid, hollow,
    // solid, fragile, durable, elastic) — flexibility/durability cannot be read
    // from a still photo. Its visible members moved: transparent/opaque →
    // transparency; reflective → finish. Also retired: magnetic, absorbent,
    // porous, waterproof, dense, lightweight, insulating (not visible).
    hardModePool: `
      transparent → translucent (one step up)
      see-through → semi-transparent
      shiny → glossy → reflective
      matte → satin
      pointed → tapered
      sharp → keen
      smooth → polished → sleek
      (color / shape / size / pattern words do NOT escalate)`,
    maxSyllables: 3,
    defaultPropCount: { apprentice: 1, scholar: 2, sage: 2, archmage: 2 },
    objectExamples: "mirror, sponge, ruler, candle, coin, balloon, rubber band, plastic bottle, glass, cup, leaf, comb, foil",
    feedbackCeiling: `
      - Use simple sentences. Some compound sentences are fine.
      - Vocabulary of a confident 7-year-old reader.
      - Avoid words above 3 syllables in feedback.
      - Science terms must be explained in parentheses if used: "transparent (you can see right through it)".`,
  },

  "9-10": {
    propertyType: "material science + transparency, finish, edge, color, shape",
    axes: [
      { name: "material", escalates: true, words: [
        "crystalline", "fibrous", "grainy", "brittle",
        "coarse", "granular", "layered", "elastic",
      ] },
      { name: "transparency", escalates: true, words: [
        "transparent", "opaque", "translucent", "frosted", "cloudy",
      ] },
      { name: "finish", escalates: true, words: [
        "glossy", "matte", "reflective", "metallic", "satin",
      ] },
      { name: "edge", escalates: true, words: [
        "sharp", "jagged", "serrated", "tapered", "rounded", "blunt",
      ] },
      { name: "color", escalates: false, words: [
        "crimson", "scarlet", "turquoise", "navy", "amber", "violet",
        "maroon", "beige",
      ] },
      { name: "shape", escalates: false, words: [
        "cylindrical", "spherical", "rectangular", "triangular", "tapered", "angular", "rounded",
      ] },
      { name: "texture-visual", escalates: false, words: [
        "ridged", "speckled", "woven", "smooth", "mottled",
      ] },
    ],
    nounCategories: [
      { category: "utensil",    examples: ["spoon", "whisk", "tongs", "spatula", "ladle"], escalates: true,  harder: "implement" },
      { category: "container",  examples: ["jar", "bottle", "tin", "basket", "carton"],    escalates: true,  harder: "receptacle" },
      { category: "garment",    examples: ["jacket", "scarf", "glove", "mitten"],          escalates: true,  harder: "apparel" },
      { category: "instrument", examples: ["ruler", "compass", "stapler", "clip"],         escalates: false },
      // "appliance" (lamp/clock/fan) removed — the category-membership probe
      // showed it is fuzzy (lamp∈appliance failed); the eval can't judge it
      // reliably, so it must not be a quest target.
    ],
    // RETIRED from 9-10: the old `physical-state` axis (flexible, rigid, fragile,
    // durable) — not visible from a still image; transparent/opaque moved to
    // transparency. Also retired earlier: conductive, dense, buoyant, permeable,
    // insulating, malleable, adhesive, porous (behaviour/identity, not visible).
    // De-polluted color: removed "metallic" (→ finish) and "transparent"
    // (→ transparency) — neither is a color.
    hardModePool: `
      elastic → resilient → springy
      brittle → fragile → friable
      translucent → semi-transparent → pellucid (save pellucid for age 11-12)
      glossy → reflective → specular
      metallic → lustrous
      sharp → jagged → serrated
      serrated → saw-toothed
      fibrous → filamentous
      crystalline → faceted
      (color / shape / visual-texture words do NOT escalate)`,
    maxSyllables: 4,
    defaultPropCount: { apprentice: 1, scholar: 2, sage: 3, archmage: 3 },
    objectExamples: "cork, aluminium foil, rubber eraser, clay, gravel, felt, mesh, wax candle, glass marble, pinecone, comb, frosted jar",
    feedbackCeiling: `
      - Standard vocabulary for age 9-10.
      - Words up to 4 syllables are fine.
      - Can introduce one new vocabulary word per feedback, defined in context.
      - Science terms should be explained once, then used freely.`,
  },

  "11-12": {
    propertyType: "advanced physical science + precise optics, form, edge",
    axes: [
      { name: "advanced-material", escalates: true, words: [
        "crystalline", "viscous", "cohesive", "tensile",
        "laminated", "amorphous", "granular", "faceted",
      ] },
      { name: "material", escalates: true, words: [
        "elastic", "brittle", "fibrous", "grainy", "coarse",
      ] },
      { name: "transparency", escalates: true, words: [
        "translucent", "opaque", "transparent", "pellucid", "frosted",
      ] },
      { name: "finish", escalates: true, words: [
        "lustrous", "reflective", "iridescent", "specular", "matte", "opalescent", "metallic",
      ] },
      { name: "edge", escalates: true, words: [
        "serrated", "scalloped", "tapered", "jagged", "beveled",
      ] },
      { name: "color-precise", escalates: true, words: [
        "vivid", "pale", "deep", "muted", "monochrome", "saturated",
      ] },
      { name: "form", escalates: false, words: [
        "cylindrical", "spherical", "conical", "polygonal", "tapered", "symmetrical", "elongated",
      ] },
    ],
    nounCategories: [
      { category: "implement",  examples: ["whisk", "tongs", "corkscrew", "sieve", "ladle"], escalates: true,  harder: "apparatus" },
      { category: "instrument", examples: ["protractor", "compass", "gauge", "caliper"],     escalates: true,  harder: "apparatus" },
      { category: "receptacle", examples: ["flask", "canister", "carton", "vessel"],         escalates: false },
      { category: "apparel",    examples: ["garment", "scarf", "mitten"],                    escalates: false },
      { category: "mechanism",  examples: ["hinge", "clasp", "latch", "spring"],             escalates: false },
    ],
    // RETIRED from 11-12: malleable, ductile, hygroscopic, thermoplastic,
    // ferromagnetic, permeable, porosity — invisible material behaviours.
    // Reorganised v6.0: translucent/pellucid → transparency; lustrous /
    // iridescent / refractive / opalescent → finish (visible optical effects);
    // metallic → finish. color-precise is now VALUE/SATURATION (vivid → pale →
    // deep → muted), which DOES escalate — giving the color family the upward
    // ladder plain hues never had.
    hardModePool: `
      translucent → pellucid (Latin-origin, same meaning, higher register)
      lustrous → specular → iridescent
      reflective → specular → refractive
      serrated → scalloped
      jagged → serrated
      crystalline → faceted → vitreous
      viscous → viscid → tenacious
      vivid → saturated → intense
      pale → muted → washed-out
      (form words do NOT escalate)`,
    maxSyllables: 5,
    defaultPropCount: { apprentice: 2, scholar: 3, sage: 3, archmage: 3 },
    objectExamples: "glass rod, wax block, felt sheet, resin block, polished metal, mica flake, salt crystal, soap bubble, prism, sieve",
    feedbackCeiling: `
      - Rich vocabulary. Age 11-12 level.
      - Can introduce etymology: "Pellucid comes from Latin pellucēre — to shine through."
      - Can use richer synonyms in feedback to plant seeds for the next level.
      - Archmage feedback should always introduce one word from the NEXT level up.`,
  },
};

// Build the flat `wordPool` view from axes once at module load (preserves the
// old contract: anything reading tax.wordPool still works, deduped).
for (const band of Object.values(TAXONOMY)) {
  band.wordPool = [...new Set(band.axes.flatMap((a) => a.words))];
}
