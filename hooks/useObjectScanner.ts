/**
 * useObjectScanner.ts  —  Lexi-Lens Smart Viewfinder  v6.2 (Phase 1)
 *
 * v6.2 changes (ML Kit kill-switch — premium UX overhaul):
 *  • ML_KIT_ENABLED constant at top — flip to false to disable ML Kit
 *    entirely without touching call sites. Default: false (Phase 1).
 *  • When disabled: loadMLKit() short-circuits, periodic ticker no-ops,
 *    triggerManualScan still captures + base64-encodes the frame but skips
 *    the ML Kit labeling pass. Result: every scan ships to the Edge
 *    Function with detectedLabel="object" — equivalent to current iOS
 *    behavior, applied to Android too.
 *  • Function preserved end-to-end (vs deletion) so flipping the constant
 *    back to true restores ML Kit behavior. Useful if Phase 4 architectural
 *    decisions revisit the question.
 *  • All previously-tracked state (liveLabel, liveConfidence, scanReady,
 *    topLabels, stableFrameCount) stays in the return shape but is always
 *    null/0/false when disabled. Existing call sites in ScanScreen.tsx
 *    have been updated to no longer rely on these (the ScanButton's pulse
 *    no longer gates on scanReady).
 *
 * v3.3 (carried):
 *  • Platform.OS guard on ML Kit import — Google ML Kit is Android-only.
 *  • captureFrame() — iOS: takePhoto({ flash:"off" }), Android: takeSnapshot().
 *  • useRef<Camera | null>(null) — React 19 strict ref typing.
 *  • onScanError callback — surfaces capture failures to UI.
 */

import { AppState, AppStateStatus, Platform } from "react-native";
import { useEffect, useRef, useCallback, useState } from "react";
import {
  useCameraDevice,
  useCameraPermission,
  Camera,
} from "react-native-vision-camera";
import { readAsStringAsync } from "expo-file-system/legacy";
import { compressImageToBase64 } from "../lib/imageCompress";

// ─── ML Kit kill-switch (v6.2 Phase 1) ────────────────────────────────────────
//
// Flip to true to re-enable ML Kit's live framing labels and per-scan label
// override. Default is false in v6.2 because production data (2026-05-10)
// showed >50% of ML Kit labels were embarrassing (generic "object" or basket
// labels like "tableware"), and Lumi mascot is now the sole framing-phase
// visual presence on the ScanScreen.
//
// When false:
//   • loadMLKit() short-circuits to false — never imports the ML Kit native module
//   • Periodic ticker is a no-op
//   • triggerManualScan() captures + base64-encodes the frame (still needed for
//     evaluate) but skips the ML Kit labeling pass, sending detectedLabel="object"
//     and confidence=0.5 to the Edge Function (equivalent to iOS behavior).
//
const ML_KIT_ENABLED = false;

// ─── ML Kit lazy load (Android only when enabled) ────────────────────────────

let mlKitAvailable = false;
let ImageLabeling: any = null;

async function loadMLKit(): Promise<boolean> {
  if (!ML_KIT_ENABLED) return false;       // v6.2: kill-switch
  if (Platform.OS !== "android") return false;
  if (ImageLabeling) return true;
  try {
    const mod      = await import("@react-native-ml-kit/image-labeling");
    ImageLabeling  = mod.default ?? mod;
    mlKitAvailable = true;
    return true;
  } catch {
    mlKitAvailable = false;
    return false;
  }
}

// ─── ML Kit response normaliser ───────────────────────────────────────────────

function normalizeLabels(
  raw: unknown
): Array<{ text: string; confidence: number }> {
  if (Array.isArray(raw)) return raw;
  if (raw !== null && typeof raw === "object") {
    const wrapped = (raw as Record<string, unknown>).labels;
    if (Array.isArray(wrapped)) return wrapped;
  }
  return [];
}

// ─── Tuning ───────────────────────────────────────────────────────────────────

const CONFIDENCE_THRESHOLD      = 0.65;
const READY_THRESHOLD           = 0.75;
const STABILITY_FRAMES_REQUIRED = 2;
const READY_FRAMES_REQUIRED     = 3;
const SCAN_INTERVAL_MS          = 750;
const LIVE_SCAN_QUALITY         = 55;
const MANUAL_SCAN_QUALITY       = 85;

// ─── Skip list ────────────────────────────────────────────────────────────────

const SKIP_LABELS = new Set([
  "product", "technology", "material", "pattern", "design", "art",
  "element", "object", "item", "thing", "detail", "component",
  "snapshot", "image", "photo", "picture", "photography",
  "screenshot", "display", "screen", "digital",
  "rectangle", "circle", "line", "square", "triangle", "shape",
  "font", "symbol", "icon", "logo", "sign",
  "black", "white", "grey", "gray", "red", "blue", "green",
  "yellow", "brown", "orange", "pink", "purple", "colour", "color",
  "monochrome",
  "metal", "plastic", "wood", "glass", "paper", "fabric",
  "cloth", "rubber", "ceramic", "leather", "textile",
  "concrete", "stone", "rock", "liquid",
  "indoor", "outdoor", "room", "interior", "exterior",
  "background", "wall", "floor", "ceiling", "surface", "texture",
  "lighting", "light", "shadow", "reflection", "space", "area",
  "still life", "close-up", "macro", "flat lay", "overhead",
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function filterAndSort(
  raw: unknown
): Array<{ text: string; confidence: number }> {
  return normalizeLabels(raw)
    .filter(
      (l) =>
        l.confidence >= CONFIDENCE_THRESHOLD &&
        !SKIP_LABELS.has(l.text.toLowerCase().trim())
    )
    .sort((a, b) => b.confidence - a.confidence);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// ─── Platform-aware capture ───────────────────────────────────────────────────
//
// iOS     → takePhoto({ flash: "off" })
//           Works with photo={true} on Camera. qualityPrioritization was
//           removed in VisionCamera v4 — do NOT pass it (TS2353).
// Android → takeSnapshot({ quality })
//           Faster preview grab. Requires video={true} on Camera component.

async function captureFrame(
  camera: Camera,
  quality: number
): Promise<{ path: string }> {
  if (Platform.OS === "ios") {
    const photo = await camera.takePhoto({ flash: "off" });
    return { path: photo.path };
  }
  return camera.takeSnapshot({ quality });
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DetectedObject {
  label:      string;
  confidence: number;
  bounds:     { x: number; y: number; width: number; height: number };
}

export interface ScanResult {
  primary:     DetectedObject | null;
  all:         DetectedObject[];
  frameBase64: string | null;
}

interface UseObjectScannerOptions {
  onDetection:  (result: ScanResult) => void;
  /** Called when the hardware capture itself fails so the UI can show a toast. */
  onScanError?: (message: string) => void;
  enabled?:     boolean;
}

interface UseObjectScannerReturn {
  // React 19: useRef<T | null>(null) → RefObject<T | null>  (TS2322 fix)
  cameraRef:         React.RefObject<Camera | null>;
  device:            ReturnType<typeof useCameraDevice>;
  hasPermission:     boolean;
  frameProcessor:    undefined;
  triggerManualScan: () => Promise<void>;
  liveLabel:         string | null;
  liveConfidence:    number;
  stableFrameCount:  number;
  scanReady:         boolean;
  topLabels:         string[];
  mlKitReady:        boolean;
  requestPermission: () => Promise<boolean>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useObjectScanner({
  onDetection,
  onScanError,
  enabled = true,
}: UseObjectScannerOptions): UseObjectScannerReturn {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device    = useCameraDevice("back");
  // React 19 requires RefObject<Camera | null> — not RefObject<Camera>
  const cameraRef = useRef<Camera | null>(null);

  const [liveLabel,        setLiveLabel]        = useState<string | null>(null);
  const [liveConfidence,   setLiveConfidence]   = useState<number>(0);
  const [stableFrameCount, setStableFrameCount] = useState<number>(0);
  const [scanReady,        setScanReady]        = useState<boolean>(false);
  const [topLabels,        setTopLabels]        = useState<string[]>([]);

  const isScanningRef    = useRef(false);
  const liveLabelRef     = useRef<string | null>(null);
  const liveConfRef      = useRef<number>(0);
  liveLabelRef.current   = liveLabel;
  liveConfRef.current    = liveConfidence;

  const prevCandidateRef = useRef<string | null>(null);
  const stableCountRef   = useRef<number>(0);

  // ── Permissions ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);

  useEffect(() => {
    const sub = AppState.addEventListener(
      "change",
      (nextState: AppStateStatus) => {
        if (nextState === "active" && !hasPermission) requestPermission();
      }
    );
    return () => sub.remove();
  }, [hasPermission, requestPermission]);

  // ── ML Kit load (Android only) ────────────────────────────────────────────
  useEffect(() => { loadMLKit(); }, []);

  // ── Periodic smart viewfinder (Android + ML Kit only — disabled in v6.2) ─
  useEffect(() => {
    if (!enabled) {
      setLiveLabel(null);
      setLiveConfidence(0);
      setStableFrameCount(0);
      setScanReady(false);
      setTopLabels([]);
      prevCandidateRef.current = null;
      stableCountRef.current   = 0;
      return;
    }

    // v6.2: ML Kit kill-switch. When disabled, no ticker fires on any platform.
    if (!ML_KIT_ENABLED) return;

    // iOS: no ML Kit → skip the interval entirely (carried)
    if (Platform.OS !== "android") return;

    const tick = setInterval(async () => {
      if (!cameraRef.current || isScanningRef.current || !mlKitAvailable) return;

      isScanningRef.current = true;
      try {
        const photo = await captureFrame(cameraRef.current, LIVE_SCAN_QUALITY);
        const uri   = photo.path.startsWith("file://")
          ? photo.path
          : `file://${photo.path}`;

        const raw    = await ImageLabeling.label(uri);
        const sorted = filterAndSort(raw);
        const best   = sorted[0];

        setTopLabels(sorted.slice(0, 3).map((l) => l.text.toLowerCase()));

        if (best) {
          const candidate = capitalise(best.text);

          if (candidate === prevCandidateRef.current) {
            stableCountRef.current = Math.min(stableCountRef.current + 1, 5);
          } else {
            stableCountRef.current   = 1;
            prevCandidateRef.current = candidate;
          }

          const count = stableCountRef.current;

          if (count >= STABILITY_FRAMES_REQUIRED) {
            setLiveLabel(candidate);
            setLiveConfidence(best.confidence);
            setStableFrameCount(count);
            setScanReady(
              count >= READY_FRAMES_REQUIRED &&
              best.confidence >= READY_THRESHOLD
            );
          }
        } else {
          stableCountRef.current   = 0;
          prevCandidateRef.current = null;
          setLiveLabel(null);
          setLiveConfidence(0);
          setStableFrameCount(0);
          setScanReady(false);
        }
      } catch {
        // Silent — stale label persists until next tick
      } finally {
        isScanningRef.current = false;
      }
    }, SCAN_INTERVAL_MS);

    return () => clearInterval(tick);
  }, [enabled]);

  // ── Manual scan (button tap) ──────────────────────────────────────────────
  const triggerManualScan = useCallback(async () => {
    if (!cameraRef.current || !enabled || isScanningRef.current) return;

    isScanningRef.current = true;
    try {
      // Step 1: Capture — platform-aware, errors surfaced via onScanError
      let photo: { path: string };
      try {
        photo = await captureFrame(cameraRef.current, MANUAL_SCAN_QUALITY);
      } catch (captureErr) {
        const msg = captureErr instanceof Error
          ? captureErr.message
          : "Camera capture failed";
        console.warn("[useObjectScanner] captureFrame failed:", captureErr);
        onScanError?.(msg);
        return;
      }

      // Step 2: Compress + base64-encode
      // v6.5 — compress to 1024px JPEG q0.85 BEFORE base64 encoding. Saves
      // 4-5 seconds of upload time on mobile networks; Gemini's vision
      // preprocessor downscales to ~1024px internally so we lose no signal
      // the model would have used. Falls back to raw readAsStringAsync if
      // compression fails (corrupt image, manipulator unavailable, etc.).
      const uri = photo.path.startsWith("file://")
        ? photo.path
        : `file://${photo.path}`;

      let base64: string;
      try {
        const compressed = await compressImageToBase64(uri);
        if (compressed) {
          base64 = compressed;
        } else {
          console.warn("[useObjectScanner] compression returned null, falling back to raw read");
          base64 = await readAsStringAsync(uri, { encoding: "base64" as any });
        }
      } catch (readErr) {
        console.warn("[useObjectScanner] frame encoding failed:", readErr);
        onScanError?.("Could not read camera frame. Please try again.");
        return;
      }

      // Step 3: Determine label
      // v6.2: with ML_KIT_ENABLED=false, finalLabel always="object" / conf=0.5.
      // The Edge Function identifies the object from the raw image and returns
      // resolvedObjectName as canonical truth. iOS already worked this way.
      let finalLabel = liveLabelRef.current ?? "object";
      let finalConf  = liveLabelRef.current ? liveConfRef.current : 0.5;

      // Fresh ML Kit pass on high-quality frame (Android only, ML Kit enabled only)
      if (ML_KIT_ENABLED && Platform.OS === "android" && mlKitAvailable && ImageLabeling) {
        try {
          const freshSorted = filterAndSort(await ImageLabeling.label(uri));
          if (freshSorted.length > 0) {
            finalLabel = capitalise(freshSorted[0].text);
            finalConf  = freshSorted[0].confidence;
          }
        } catch {
          // Fall back to periodic label
        }
      }

      // Step 4: Dispatch → useLexiEvaluate → Claude Edge Function
      onDetection({
        primary: {
          label:      finalLabel,
          confidence: finalConf,
          bounds:     { x: 0, y: 0, width: 0, height: 0 },
        },
        all:         [],
        frameBase64: base64,
      });
    } finally {
      isScanningRef.current = false;
    }
  }, [enabled, onDetection, onScanError]);

  return {
    cameraRef,
    device,
    hasPermission,
    frameProcessor:   undefined,
    triggerManualScan,
    liveLabel,
    liveConfidence,
    stableFrameCount,
    scanReady,
    topLabels,
    mlKitReady:       mlKitAvailable,
    requestPermission,
  };
}
