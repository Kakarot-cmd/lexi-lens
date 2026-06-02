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

export const TAXONOMY: Record<string, {
  propertyType:     string;
  axes:             Axis[];
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
        "hard", "soft", "rough", "smooth", "shiny", "dull",
        "bumpy", "flat", "fuzzy", "squishy", "stretchy",
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
    // RETIRED from 5-6: heavy, light (weight ≈ guessable but unreliable from a
    // photo), wet, dry, hot, cold (temperature/moisture not visible), sticky,
    // crunchy, slippery (require touch/sound, not sight).
    hardModePool: `
      hard → solid
      soft → squishy → pliable
      shiny → gleaming → lustrous (pick ONE next step up, not both)
      rough → bumpy → textured
      stretchy → flexible
      (color / shape / size / count words do NOT escalate — see hard-mode rules)`,
    maxSyllables: 2,
    defaultPropCount: { apprentice: 1, scholar: 1, sage: 1, archmage: 1 },
    objectExamples: "spoon, pillow, stone, leaf, sock, cup, pencil, crayon, toy block, blanket, ball, book",
    feedbackCeiling: `
      - Maximum sentence length: 8 words.
      - No compound sentences ("and", "but", "because" are fine; semicolons are not).
      - Use ONLY words a 5-year-old knows. If in doubt, use a simpler word.
      - Forbidden in feedback: any word longer than 2 syllables, science terms, adjectives above this list.`,
  },

  "7-8": {
    propertyType: "physical state + color, shape, size",
    axes: [
      { name: "physical-state", escalates: true, words: [
        "transparent", "opaque", "flexible", "rigid", "hollow",
        "solid", "fragile", "durable", "elastic", "reflective",
      ] },
      { name: "sensory", escalates: true, words: [
        "smooth", "rough", "shiny", "dull", "bumpy", "fuzzy",
      ] },
      { name: "color", escalates: false, words: [
        "red", "blue", "green", "yellow", "orange", "purple",
        "pink", "brown", "black", "white", "grey", "gold", "silver",
      ] },
      { name: "shape", escalates: false, words: [
        "round", "square", "rectangular", "oval", "pointed", "curved", "flat", "narrow",
      ] },
      { name: "size", escalates: false, words: [
        "large", "small", "thin", "thick", "wide", "narrow",
      ] },
      { name: "pattern", escalates: false, words: [
        "striped", "spotted", "plain",
      ] },
    ],
    // RETIRED from 7-8: magnetic, absorbent, porous, waterproof, dense,
    // lightweight, insulating — none determinable from a still image.
    hardModePool: `
      transparent → see-through → clear → translucent (pick one step up)
      flexible → bendable → pliable
      rigid → stiff → inflexible
      reflective → mirror-like → glossy
      smooth → polished → sleek
      (color / shape / size / pattern words do NOT escalate)`,
    maxSyllables: 3,
    defaultPropCount: { apprentice: 1, scholar: 2, sage: 2, archmage: 2 },
    objectExamples: "mirror, sponge, ruler, candle, coin, balloon, rubber band, plastic bottle, glass, cup, leaf",
    feedbackCeiling: `
      - Use simple sentences. Some compound sentences are fine.
      - Vocabulary of a confident 7-year-old reader.
      - Avoid words above 3 syllables in feedback.
      - Science terms must be explained in parentheses if used: "transparent (you can see right through it)".`,
  },

  "9-10": {
    propertyType: "material science + color, shape, texture",
    axes: [
      { name: "material", escalates: true, words: [
        "elastic", "reflective", "crystalline", "fibrous", "grainy",
        "brittle", "translucent", "coarse", "granular", "layered",
      ] },
      { name: "physical-state", escalates: true, words: [
        "transparent", "opaque", "flexible", "rigid", "fragile", "durable",
      ] },
      { name: "color", escalates: false, words: [
        "crimson", "scarlet", "turquoise", "navy", "amber", "violet",
        "maroon", "beige", "metallic", "transparent",
      ] },
      { name: "shape", escalates: false, words: [
        "cylindrical", "spherical", "rectangular", "triangular", "tapered", "angular", "rounded",
      ] },
      { name: "texture-visual", escalates: false, words: [
        "ridged", "speckled", "woven", "smooth", "mottled",
      ] },
    ],
    // RETIRED from 9-10: conductive, dense, buoyant, permeable, insulating,
    // malleable, adhesive, porous — behaviour/material identity, not visible.
    hardModePool: `
      elastic → resilient → springy
      brittle → fragile → friable
      translucent → semi-transparent → pellucid (save pellucid for age 11-12)
      fibrous → filamentous
      reflective → specular
      crystalline → faceted
      (color / shape / visual-texture words do NOT escalate)`,
    maxSyllables: 4,
    defaultPropCount: { apprentice: 1, scholar: 2, sage: 3, archmage: 3 },
    objectExamples: "cork, aluminium foil, rubber eraser, clay, gravel, felt, mesh, wax candle, glass marble, pinecone",
    feedbackCeiling: `
      - Standard vocabulary for age 9-10.
      - Words up to 4 syllables are fine.
      - Can introduce one new vocabulary word per feedback, defined in context.
      - Science terms should be explained once, then used freely.`,
  },

  "11-12": {
    propertyType: "advanced physical science + precise color & form",
    axes: [
      { name: "advanced-material", escalates: true, words: [
        "translucent", "viscous", "lustrous", "pellucid",
        "iridescent", "crystalline", "refractive", "cohesive",
        "tensile", "laminated", "amorphous",
      ] },
      { name: "material", escalates: true, words: [
        "elastic", "brittle", "fibrous", "grainy", "coarse", "reflective",
      ] },
      { name: "color-precise", escalates: false, words: [
        "iridescent", "metallic", "translucent", "opalescent", "monochrome", "muted",
      ] },
      { name: "form", escalates: false, words: [
        "cylindrical", "spherical", "conical", "polygonal", "tapered", "symmetrical", "elongated",
      ] },
    ],
    // RETIRED from 11-12: malleable, ductile, hygroscopic, thermoplastic,
    // ferromagnetic, permeable, porosity — invisible material behaviours.
    // (Kept lustrous/refractive/iridescent: these ARE visible optical effects.)
    hardModePool: `
      translucent → pellucid (Latin-origin, same meaning, higher register)
      lustrous → specular → iridescent
      viscous → viscid → tenacious
      crystalline → faceted → vitreous
      reflective → specular → refractive
      (precise-color / form words do NOT escalate)`,
    maxSyllables: 5,
    defaultPropCount: { apprentice: 2, scholar: 3, sage: 3, archmage: 3 },
    objectExamples: "glass rod, wax block, felt sheet, resin block, polished metal, mica flake, salt crystal, soap bubble, prism",
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
