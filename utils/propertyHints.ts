/**
 * propertyHints.ts  —  Lexi-Lens property hint engine
 * ────────────────────────────────────────────────────
 *
 * Phase A of the chip-relevance system.
 *
 * Job: take the labels ML Kit just produced and a list of pending property
 * words for the current quest, and decide which (if any) of those properties
 * the visible object likely satisfies.
 *
 * This is intentionally NOT AI. It runs in microseconds, on-device, with no
 * dependencies. The signal is a soft glow, not a verdict — Claude still has
 * the final say. The goal is to point children toward likely objects without
 * spoiling the answer.
 *
 * How it works:
 *
 *   1. Each property word maps to a set of object keywords known to typically
 *      satisfy it. e.g. "soft" → cushion, pillow, sponge, blanket, fabric…
 *      The mapping is curated from common-sense object→property associations
 *      (a sponge is soft, a brick is not). It's deliberately conservative.
 *
 *   2. We lowercase + trim every ML Kit label, then check whether ANY label
 *      appears in the property's keyword set. If yes → property is "hinted".
 *
 *   3. We never hint properties the child has already found (those chips are
 *      already in their done state).
 *
 *   4. We also never hint MORE THAN HALF the pending properties at once —
 *      if the engine "hints" 3 of 3 words, the signal is meaningless. A hint
 *      should be a nudge, not a giveaway.
 *
 * Negative-property handling:
 *   The taxonomy contains pairs like soft/hard, rough/smooth, heavy/light.
 *   When a label suggests one side strongly (a brick is hard), we DON'T
 *   actively de-hint the opposite — children might still discover unexpected
 *   matches (a smooth brick face). We just don't add a positive hint.
 *
 * Coverage scope:
 *   Currently covers the 5-6 and 7-8 age band vocabulary pools (basic
 *   sensory + functional descriptors). The 9-10 + bands use richer words
 *   (translucent, malleable, etc.) — those will mostly fall through to "no
 *   hint", which is the right behaviour: harder words deserve real thinking,
 *   not keyword shortcuts.
 */

// ─── Property → object keyword map ────────────────────────────────────────────
//
// Each entry: a property word (lower-case) → set of ML Kit labels (lower-case)
// that commonly possess that property. Sets used for O(1) membership checks.
//
// Curation rules:
//   • Only include objects where the property is a CORE characteristic.
//     "Cushion" goes in soft (always). "Cat" does NOT go in soft (sometimes,
//     but a kid scanning a picture of a cat for "soft" should still think).
//   • Include both ML Kit's likely labels and child-friendly synonyms.
//   • Each list capped at ~15 entries to keep the hint conservative.

const PROPERTY_HINTS: Record<string, ReadonlySet<string>> = {
  // ── Sensory: texture ──────────────────────────────────────────────────────
  soft: new Set([
    "cushion", "pillow", "sponge", "blanket", "towel", "stuffed toy",
    "teddy bear", "plush", "fur", "yarn", "wool sweater", "marshmallow",
    "bread", "tissue", "feather",
  ]),
  hard: new Set([
    "brick", "stone", "rock", "ceramic tile", "wood block", "chair",
    "table", "shelf", "bookcase", "metal object", "tool", "hammer",
    "kettle", "skateboard", "helmet",
  ]),
  rough: new Set([
    "brick", "tree bark", "sandpaper", "rope", "concrete", "burlap",
    "stone wall", "carpet", "rug", "doormat", "tree trunk", "pinecone",
    "coconut", "loofah",
  ]),
  smooth: new Set([
    "mirror", "glass", "ceramic mug", "ceramic plate", "marble", "metal sheet",
    "phone", "tablet", "laptop", "screen", "porcelain", "vase", "bottle",
    "polished wood", "windscreen",
  ]),
  bumpy: new Set([
    "lego", "raspberry", "strawberry", "pineapple", "golf ball", "honeycomb",
    "waffle", "knobby tire", "bubble wrap", "pinecone", "lemon", "lizard",
  ]),
  flat: new Set([
    "paper", "book cover", "tablet", "phone", "screen", "plate",
    "table top", "floor", "card", "envelope", "mat", "rug", "panel",
    "tile", "wall",
  ]),
  fuzzy: new Set([
    "stuffed toy", "teddy bear", "blanket", "sweater", "wool", "fleece",
    "cat", "rug", "moss", "peach", "kiwi", "felt",
  ]),
  sticky: new Set([
    "tape", "glue", "honey", "syrup", "sticker", "post-it",
    "lollipop", "marshmallow", "candy",
  ]),
  squishy: new Set([
    "cushion", "pillow", "sponge", "stress ball", "marshmallow", "bread",
    "stuffed toy", "plush", "jelly", "balloon", "stuffed animal",
  ]),
  crunchy: new Set([
    "biscuit", "cookie", "cracker", "chip", "cereal", "toast", "leaf",
    "dry leaf", "crispy",
  ]),
  slippery: new Set([
    "ice", "soap", "wet floor", "banana peel", "fish", "polished floor",
    "tile", "glass surface",
  ]),
  stretchy: new Set([
    "rubber band", "balloon", "scrunchie", "sock", "t-shirt", "elastic",
    "gum", "spandex", "hair tie", "leggings",
  ]),

  // ── Sensory: appearance ───────────────────────────────────────────────────
  shiny: new Set([
    "mirror", "metal sheet", "spoon", "fork", "knife", "kettle",
    "bell", "coin", "phone", "ring", "watch", "polished surface",
    "chrome", "trophy",
  ]),
  dull: new Set([
    "cardboard", "paper bag", "concrete", "stone", "rust", "dry leaf",
    "old book", "burlap", "matt surface",
  ]),
  bright: new Set([
    "lamp", "torch", "sun", "candle", "screen", "television",
    "neon", "led",
  ]),

  // ── Sensory: weight ───────────────────────────────────────────────────────
  heavy: new Set([
    "brick", "stone", "rock", "anvil", "weight", "kettlebell",
    "dumbbell", "bookcase", "log", "bag of cement",
  ]),
  light: new Set([
    "feather", "balloon", "tissue", "leaf", "paper", "cotton ball",
    "bubble", "foam", "marshmallow", "empty box",
  ]),

  // ── Sensory: temperature (state, not actively read) ──────────────────────
  hot: new Set([
    "kettle", "stove", "candle flame", "lamp bulb", "iron",
    "radiator", "fire",
  ]),
  cold: new Set([
    "ice", "ice cream", "freezer", "refrigerator", "snowball",
    "icicle",
  ]),

  // ── Sensory: moisture ─────────────────────────────────────────────────────
  wet: new Set([
    "puddle", "water", "wet towel", "dishrag", "raindrop",
    "fish", "ice cube",
  ]),
  dry: new Set([
    "leaf", "dry leaf", "sand", "paper", "cardboard", "biscuit",
    "towel", "wood",
  ]),

  // ── Functional / shape ────────────────────────────────────────────────────
  round: new Set([
    "ball", "soccer ball", "basketball", "tennis ball", "orange",
    "apple", "tomato", "globe", "wheel", "coin", "plate", "clock",
    "bowl", "egg", "balloon", "cup",
  ]),
  curved: new Set([
    "banana", "boomerang", "umbrella handle", "bowl", "spoon",
    "horn", "arch", "hook", "vase", "teapot",
  ]),
  square: new Set([
    "cube", "dice", "rubik cube", "tile", "frame", "envelope",
    "tissue box", "cardboard box", "block", "checkerboard",
  ]),
  long: new Set([
    "pencil", "pen", "ruler", "stick", "rope", "snake", "noodle",
    "spaghetti", "hose", "wire", "cable", "scarf", "broom",
  ]),
  short: new Set([
    "thumb", "stub", "tack", "pin", "candle stub", "eraser",
    "button",
  ]),
  hollow: new Set([
    "cup", "mug", "bowl", "vase", "bottle", "tube", "pipe",
    "drum", "balloon", "tunnel", "ring",
  ]),
  solid: new Set([
    "brick", "stone", "rock", "block", "ball", "log",
    "metal bar", "ice cube", "candle",
  ]),

  // ── Material descriptors (taught as properties at higher tiers) ───────────
  metallic: new Set([
    "spoon", "fork", "knife", "kettle", "key", "coin", "bell",
    "scissors", "wrench", "hammer", "nail", "ring", "watch",
    "chain", "lamp",
  ]),
  wooden: new Set([
    "chair", "table", "pencil", "ruler", "shelf", "log", "stick",
    "plank", "broom handle", "drumstick", "spoon",
  ]),
  plastic: new Set([
    "bottle", "container", "toy", "lego", "remote", "phone case",
    "bucket", "straw", "spoon", "bag",
  ]),
  fluffy: new Set([
    "cloud", "cotton", "marshmallow", "stuffed toy", "feather",
    "wool", "rabbit", "cat", "dandelion",
  ]),
  flexible: new Set([
    "rubber band", "rope", "hose", "wire", "ribbon",
    "scarf", "spaghetti", "noodle", "leaf",
  ]),
  transparent: new Set([
    "glass", "window", "bottle", "lens", "magnifying glass",
    "plastic wrap", "ice cube", "bubble",
  ]),
  reflective: new Set([
    "mirror", "polished metal", "screen", "water", "spoon",
    "kettle", "phone", "window",
  ]),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalise an ML Kit label for lookup: lowercase, trim, collapse whitespace.
 * ML Kit returns a mix of one-word and multi-word labels ("Cup", "Stuffed toy").
 */
function normaliseLabel(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Does any of the labels appear in the keyword set?
 * Substring match in both directions so "stuffed toy bear" and "stuffed toy"
 * both hit "stuffed toy".
 */
function anyLabelMatches(labels: string[], keywordSet: ReadonlySet<string>): boolean {
  for (const label of labels) {
    const norm = normaliseLabel(label);
    if (keywordSet.has(norm)) return true;
    // Loose match: ML Kit returns "stuffed toy bear" → "stuffed toy" still hits
    for (const kw of keywordSet) {
      if (norm.includes(kw) || kw.includes(norm)) return true;
    }
  }
  return false;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface PropertyHintInput {
  /** ML Kit's currently visible labels — typically 1-3 entries. */
  labels: string[];
  /** Property words still pending (not yet found) for the current quest. */
  pendingProperties: string[];
}

export interface PropertyHintResult {
  /** Set of property words ML Kit's labels suggest might apply. */
  hintedWords: Set<string>;
  /** Whether the hint should be displayed at all (suppressed if too many hits). */
  shouldShowHints: boolean;
}

/**
 * Run the hint engine. Pure function — call inside a useMemo with deps
 * [labels.join("|"), pendingProperties.join("|")] to avoid recomputing
 * every render.
 *
 * Returns:
 *   • hintedWords        — properties that look like they might match
 *   • shouldShowHints    — false when the engine hints too many words at once
 *                          (avoids becoming a giveaway)
 */
export function computePropertyHints(input: PropertyHintInput): PropertyHintResult {
  const { labels, pendingProperties } = input;

  // No labels or no pending words → nothing to hint
  if (labels.length === 0 || pendingProperties.length === 0) {
    return { hintedWords: new Set(), shouldShowHints: false };
  }

  const hinted = new Set<string>();

  for (const word of pendingProperties) {
    const lookup = word.toLowerCase().trim();
    const set    = PROPERTY_HINTS[lookup];
    if (!set) continue;
    if (anyLabelMatches(labels, set)) hinted.add(word);
  }

  // Suppression rule: never hint MORE THAN HALF of pending properties at once.
  // If pending = 3 and we hint 2+, the signal becomes a giveaway.
  // Children should still feel they're solving the puzzle.
  const cap = Math.max(1, Math.floor(pendingProperties.length / 2));
  const shouldShowHints = hinted.size > 0 && hinted.size <= cap;

  return {
    hintedWords:     shouldShowHints ? hinted : new Set(),
    shouldShowHints,
  };
}

/**
 * Coverage info — how many of the pending properties does the engine
 * have keyword data for? Useful for diagnostics or to gate the system
 * (e.g. don't show the glow at all if coverage is < 50%).
 */
export function hintEngineCoverage(pendingProperties: string[]): {
  covered: number;
  total:   number;
  ratio:   number;
} {
  const covered = pendingProperties.filter(
    (w) => PROPERTY_HINTS[w.toLowerCase().trim()] !== undefined
  ).length;
  return {
    covered,
    total: pendingProperties.length,
    ratio: pendingProperties.length === 0 ? 0 : covered / pendingProperties.length,
  };
}

/** For tests / debugging. */
export const __PROPERTY_HINTS_INTERNAL = PROPERTY_HINTS;
