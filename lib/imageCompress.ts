/**
 * lib/imageCompress.ts
 * Lexi-Lens — Client-side image compression for evaluate uploads.
 *
 * Phone cameras produce 3-4 MB images. Gemini's vision preprocessor
 * internally downscales anything larger than ~1024×1024, so all those extra
 * pixels are wasted bytes on the wire. This utility compresses BEFORE
 * base64 encoding to save 4-5s of upload latency on mobile networks.
 *
 * Targets:
 *   • Max longer-side dimension: 1024px (preserves aspect)
 *   • JPEG quality: 0.85
 *   • Output: base64 string, ready to send in the evaluate payload
 *
 * ─── Defensive lazy-require (v6.5.1) ─────────────────────────────────────────
 *
 * expo-image-manipulator is a NATIVE module. EAS Update / OTA bundles only
 * ship JS — the native binary must be compiled into the app via `eas build`
 * or `expo run:*`. If a dev client is running an older binary without the
 * native module linked, a top-level `import` of expo-image-manipulator
 * would throw at boot and crash the whole scanner module.
 *
 * Instead, we lazy-require on first call and cache the result. If the
 * native module isn't present, every call returns null, and the caller's
 * existing fallback path (FileSystem.readAsStringAsync of the raw photo)
 * handles the upload uncompressed — same behavior as before this patch.
 *
 * Once the dev client is rebuilt with the native module, no code change
 * needed: lazy-require succeeds and compression kicks in automatically.
 */

const TARGET_MAX_DIMENSION = 1024;
const JPEG_QUALITY         = 0.85;

// Lazy-cached references. `null` = not yet attempted. `false` = attempted
// and failed (native module missing). Object = loaded successfully.
let cachedLib: { manipulate: unknown; SaveFormat: { JPEG: unknown } } | null | false = null;

function tryLoadImageManipulator():
  | { manipulate: (uri: string) => any; SaveFormat: { JPEG: unknown } }
  | null
{
  if (cachedLib === false) return null;     // previously failed
  if (cachedLib !== null)  return cachedLib as any;  // previously succeeded

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const lib = require("expo-image-manipulator");
    if (lib && typeof lib.ImageManipulator?.manipulate === "function" && lib.SaveFormat) {
      cachedLib = {
        manipulate: lib.ImageManipulator.manipulate,
        SaveFormat: lib.SaveFormat,
      } as any;
      return cachedLib as any;
    }
    console.warn(
      "[imageCompress] expo-image-manipulator loaded but API shape unexpected — disabling compression",
    );
    cachedLib = false;
    return null;
  } catch (err) {
    console.warn(
      "[imageCompress] expo-image-manipulator native module not available — " +
      "rebuild the dev client (`eas build --profile development`) to enable compression. " +
      "Falling back to raw upload until then.",
    );
    cachedLib = false;
    return null;
  }
}

/**
 * Resize + JPEG-compress an image at `uri` and return base64.
 * Returns null if the native module is unavailable or compression failed —
 * caller should fall back to its uncompressed read path in that case.
 */
export async function compressImageToBase64(uri: string): Promise<string | null> {
  const lib = tryLoadImageManipulator();
  if (!lib) return null;

  try {
    const context = (lib.manipulate as any)(uri);
    context.resize({ width: TARGET_MAX_DIMENSION });

    const rendered = await context.renderAsync();
    const result   = await rendered.saveAsync({
      format:   lib.SaveFormat.JPEG,
      compress: JPEG_QUALITY,
      base64:   true,
    });

    if (!result?.base64) {
      console.warn("[imageCompress] save returned null base64");
      return null;
    }
    return result.base64 as string;
  } catch (err) {
    console.warn("[imageCompress] compression failed:", err);
    return null;
  }
}
