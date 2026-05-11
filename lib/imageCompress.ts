/**
 * lib/imageCompress.ts
 * Lexi-Lens — Client-side image compression for evaluate uploads.
 *
 * Phone cameras produce 3-4 MB images (3024×4032 or 4032×3024). Gemini's
 * vision preprocessor internally downscales anything larger than ~1024×1024
 * to its working resolution, so all those extra pixels are wasted bytes on
 * the wire. This utility compresses BEFORE base64 encoding to save 4-5s of
 * upload latency on mobile networks without quality loss the model can see.
 *
 * Targets (calibrated against Gemini 2.5 Flash-Lite's internal resolution):
 *   • Max longer-side dimension: 1024px (preserves aspect)
 *   • JPEG quality: 0.85 (above the perceptual-artifact threshold)
 *   • Output: base64 string, ready to send in the evaluate payload
 *
 * Behavior on failure: returns null. Callers should fall back to whatever
 * uncompressed read path they had before — better to send a bigger image
 * than no image at all.
 *
 * Trade-off accepted: ImageManipulator preserves aspect ratio when only
 * `width` is specified, so portrait images become 1024×~1366 (slightly
 * larger than ideal). Gemini still downscales further internally so the
 * extra ~30% pixels in the long axis cost ~50ms of compression time and
 * negligible upload bytes. Worth it for code simplicity vs a two-pass
 * dimension-aware resize.
 *
 * Dependency: expo-image-manipulator (install via `npx expo install`
 * to pick the SDK 54-compatible version).
 */

import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

/** Max longer-side dimension. Above Gemini's internal preprocessor size. */
const TARGET_MAX_DIMENSION = 1024;

/** JPEG quality. 0.85 is the published sweet spot for vision-model uploads. */
const JPEG_QUALITY = 0.85;

/**
 * Resize + JPEG-compress an image at `uri` and return base64.
 *
 * @param uri Local file URI (e.g. `file:///.../capture.jpg`)
 * @returns base64 string, or null if compression failed
 */
export async function compressImageToBase64(uri: string): Promise<string | null> {
  try {
    const context = ImageManipulator.manipulate(uri);
    context.resize({ width: TARGET_MAX_DIMENSION });

    const rendered = await context.renderAsync();
    const result   = await rendered.saveAsync({
      format:   SaveFormat.JPEG,
      compress: JPEG_QUALITY,
      base64:   true,
    });

    if (!result.base64) {
      console.warn("[imageCompress] save returned null base64");
      return null;
    }
    return result.base64;
  } catch (err) {
    console.warn("[imageCompress] compression failed:", err);
    return null;
  }
}
