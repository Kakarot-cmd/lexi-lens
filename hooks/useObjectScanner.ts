/**
 * useObjectScanner.ts  —  Lexi-Lens Smart Viewfinder  v3.3
 *
 * What changed from v3.2 → v3.3:
 *
 *  iOS COMPATIBILITY  (the reason for this patch)
 *  ──────────────────────────────────────────────
 *  • ML Kit is Google-only (Android).  On iOS loadMLKit() is skipped
 *    entirely — mlKitAvailable stays false, periodic tick is a no-op,
 *    and the live chip never appears.  That was already true in v3.2 but
 *    nothing surfaced the failure, so children just got a frozen screen.
 *
 *  • takeSnapshot() on iOS requires the Camera to have video={true}.
 *    Without it VisionCamera v4 throws "No video data output configured"
 *    on the first tap. The error was silently swallowed → "nothing happens".
 *
 *    FIX: Platform.OS === "ios"
 *      → takePhoto({ qualityPrioritization: "speed", flash: "off" })
 *         (works without video={true}, uses the photo output pipeline)
 *      Android → takeSnapshot() unchanged (faster, same quality for ML Kit)
 *
 *  • onScanError callback added.  ScanScreen now shows a toast / alert when
 *    the snap itself fails rather than silently swallowing the error.
 *    This surfaces real hardware failures (permission race, AVSession reset)
 *    instead of leaving the child staring at a frozen button.
 *
 *  • iOS live-label fallback: since ML Kit never runs on iOS the live chip
 *    is hidden, but the manual scan still works — it sends the raw photo
 *    to Claude with label="object" and lets Claude do the identification.
 *    This is actually the same quality as Android's first-tap fallback.
 *
 *  Everything else (stability gate, skip list, property-hint labels,
 *  isScanningRef mutex, AppState listener) is unchanged from v3.2.
 */

import { AppState, AppStateStatus, Platform } from "react-native";
import { useEffect, useRef, useCallback, useState } from "react";
import {
  useCameraDevice,
  useCameraPermission,
  Camera,
} from "react-native-vision-camera";
import { readAsStringAsync } from "expo-file-system/legacy";

// ─── ML Kit lazy load (Android only) ─────────────────────────────────────────
//
// @react-native-ml-kit/image-labeling ships Google ML Kit binaries.
// Google ML Kit has no iOS runtime — importing it on iOS throws immediately.
// We guard the entire import with a Platform check so the module is never
// even attempted on iOS.  mlKitAvailable stays false; the periodic tick
// becomes a cheap no-op and we fall through to Claude for identification.

let mlKitAvailable = false;
let ImageLabeling: any = null;

async function loadMLKit(): Promise<boolean> {
  // Hard guard — never attempt on iOS
  if (Platform.OS !== "android") return false;
  if (ImageLabeling) return true;
  try {
    const mod     = await import("@react-native-ml-kit/image-labeling");
    ImageLabeling = mod.default ?? mod;
    mlKitAvailable = true;
    return true;
  } catch {
    mlKitAvailable = false;
    return false;
  }
}

// ─── ML Kit response normaliser ───────────────────────────────────────────────
// Handles both return shapes:
//   Shape A  ImageLabel[]              (bare array — most common)
//   Shape B  { labels: ImageLabel[] }  (wrapped — some Android builds)

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

/** Minimum confidence to show or use a label at all. */
const CONFIDENCE_THRESHOLD = 0.65;

/**
 * Minimum confidence for scanReady = true.
 * Higher than CONFIDENCE_THRESHOLD so the "go" signal only fires when
 * ML Kit is genuinely confident, not borderline.
 */
const READY_THRESHOLD = 0.75;

/** How many consecutive frames a label must win before it's committed. */
const STABILITY_FRAMES_REQUIRED = 2;

/** How many consecutive stable frames before scanReady fires. */
const READY_FRAMES_REQUIRED = 3;

/** Live preview interval. 750ms = responsive. 1500ms was too sluggish. */
const SCAN_INTERVAL_MS = 750;

/** JPEG quality for the periodic live chip. 55 is enough for ML Kit. */
const LIVE_SCAN_QUALITY = 55;

/** JPEG quality for the manual scan frame sent to Claude. */
const MANUAL_SCAN_QUALITY = 85;

// ─── Skip list ────────────────────────────────────────────────────────────────

const SKIP_LABELS = new Set([
  // Too generic
  "product", "technology", "material", "pattern", "design", "art",
  "element", "object", "item", "thing", "detail", "component",

  // Photography / meta
  "snapshot", "image", "photo", "picture", "photography",
  "screenshot", "display", "screen", "digital",

  // Geometry & typography
  "rectangle", "circle", "line", "square", "triangle", "shape",
  "font", "symbol", "icon", "logo", "sign",

  // Colour
  "black", "white", "grey", "gray", "red", "blue", "green",
  "yellow", "brown", "orange", "pink", "purple", "colour", "color",
  "monochrome",

  // Raw material (too vague as an identity label)
  "metal", "plastic", "wood", "glass", "paper", "fabric",
  "cloth", "rubber", "ceramic", "leather", "textile",
  "concrete", "stone", "rock", "liquid",

  // Environment / scene
  "indoor", "outdoor", "room", "interior", "exterior",
  "background", "wall", "floor", "ceiling", "surface", "texture",
  "lighting", "light", "shadow", "reflection", "space", "area",

  // Style descriptors
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
  /** Called when the hardware capture itself fails (not an ML Kit miss). */
  onScanError?: (message: string) => void;
  enabled?:     boolean;
}

interface UseObjectScannerReturn {
  cameraRef:         React.RefObject<Camera>;
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

// ─── Platform-aware capture ───────────────────────────────────────────────────
//
// Android  →  takeSnapshot()  (fast, grabs the preview buffer)
// iOS      →  takePhoto()     (uses AVCapturePhotoOutput, works without video={true})
//
// Note: the Camera component in ScanScreen still needs  video={true}
// on Android for takeSnapshot to work.  On iOS photo={true} is sufficient.

async function captureFrame(
  camera: Camera,
  quality: number
): Promise<{ path: string }> {
  if (Platform.OS === "ios") {
    // takePhoto returns a PhotoFile; path is always absolute without "file://"
    const photo = await camera.takePhoto({
      qualityPrioritization: "speed",
      flash:                 "off",
    });
    return { path: photo.path };
  } else {
    // takeSnapshot returns a SnapshotData; path may or may not have "file://"
    return camera.takeSnapshot({ quality });
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useObjectScanner({
  onDetection,
  onScanError,
  enabled = true,
}: UseObjectScannerOptions): UseObjectScannerReturn {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device    = useCameraDevice("back");
  const cameraRef = useRef<Camera>(null);

  const [liveLabel,        setLiveLabel]        = useState<string | null>(null);
  const [liveConfidence,   setLiveConfidence]   = useState<number>(0);
  const [stableFrameCount, setStableFrameCount] = useState<number>(0);
  const [scanReady,        setScanReady]        = useState<boolean>(false);
  const [topLabels,        setTopLabels]        = useState<string[]>([]);

  // Mutex: prevent concurrent snapshots
  const isScanningRef = useRef(false);

  // Stale-closure-free reads for triggerManualScan
  const liveLabelRef = useRef<string | null>(null);
  const liveConfRef  = useRef<number>(0);
  liveLabelRef.current = liveLabel;
  liveConfRef.current  = liveConfidence;

  // Stability tracking across frames
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

  // ── Periodic smart viewfinder (Android + ML Kit only) ────────────────────
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

    // iOS has no ML Kit → skip the whole interval, nothing to poll
    if (Platform.OS !== "android") return;

    const tick = setInterval(async () => {
      if (!cameraRef.current || isScanningRef.current || !mlKitAvailable) return;

      isScanningRef.current = true;
      try {
        const photo = await captureFrame(cameraRef.current, LIVE_SCAN_QUALITY);

        const uri = photo.path.startsWith("file://")
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
      // ── Step 1: Capture frame (platform-aware) ──────────────────────────
      let photo: { path: string };
      try {
        photo = await captureFrame(cameraRef.current, MANUAL_SCAN_QUALITY);
      } catch (captureErr) {
        // Surface capture failures — these are real device/permission errors
        const msg = captureErr instanceof Error
          ? captureErr.message
          : "Camera capture failed";
        console.warn("[useObjectScanner] captureFrame failed:", captureErr);
        onScanError?.(msg);
        return; // finally still runs and resets mutex
      }

      // ── Step 2: Read as base64 ──────────────────────────────────────────
      const uri = photo.path.startsWith("file://")
        ? photo.path
        : `file://${photo.path}`;

      let base64: string;
      try {
        base64 = await readAsStringAsync(uri, { encoding: "base64" as any });
      } catch (readErr) {
        console.warn("[useObjectScanner] readAsStringAsync failed:", readErr);
        onScanError?.("Could not read camera frame. Please try again.");
        return;
      }

      // ── Step 3: Determine label ─────────────────────────────────────────
      // Start with the stable live label (stale-closure-free via refs).
      // On iOS this is always null (no ML Kit) → falls back to "object",
      // which is fine — Claude identifies from the image itself.
      let finalLabel = liveLabelRef.current ?? "object";
      let finalConf  = liveLabelRef.current ? liveConfRef.current : 0.5;

      // Fresh ML Kit pass on the higher-quality frame (Android only)
      if (Platform.OS === "android" && mlKitAvailable && ImageLabeling) {
        try {
          const freshSorted = filterAndSort(await ImageLabeling.label(uri));
          if (freshSorted.length > 0) {
            finalLabel = capitalise(freshSorted[0].text);
            finalConf  = freshSorted[0].confidence;
          }
        } catch {
          // Fall back to periodic label already set above
        }
      }

      // ── Step 4: Dispatch ────────────────────────────────────────────────
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
      // Always reset mutex, even if an inner return fired early
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
