/**
 * boom_excerpt.ts — minimal metadata shape from Boom.json
 * Reconstructed from project_knowledge_search of assets/lottie/Boom.json.
 *
 * The full file is ~80 KB of bezier path data; this excerpt captures the
 * top-level Lottie schema fields plus a representative layer to validate
 * the Lottie format and the layer/composition timing relationship.
 */

export const BOOM_JSON_HEAD = {
  v:    "5.5.7",
  meta: { g: "LottieFiles AE 0.1.20", a: "", k: "", d: "", tc: "none" },
  fr:   30,
  ip:   0,
  op:   30,
  w:    512,
  h:    512,
  nm:   "BigBadaBoom",
  ddd:  0,
  assets: [] as unknown[],
  // Layer count from search results: layers ind 1 through 10
  layerCount: 10,
} as const;

// Representative layer extents observed in the file:
// most explosion shape layers have ip: 4-5, op: 60-65
// background rectangle (Shape Layer 15) has ip: 60, op: 60 (sentinel)
export const LAYER_EXTENTS = {
  shapeLayersIp:        [4, 5, 5, 4, 5, 4, 5, 4],   // explosion bursts
  shapeLayersOp:        [64, 65, 65, 60, 65, 64, 65, 64],
  backgroundLayerIp:    60,
  backgroundLayerOp:    60,
} as const;
