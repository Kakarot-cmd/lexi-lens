/**
 * useObjectScanner.ts  —  Lexi-Lens Smart Viewfinder  v3.2
 *
 * What changed from v3.1:
 *
 *  ACCURACY
 *  ────────
 *  • Confidence threshold 0.55 → 0.65
 *    At 55% ML Kit is guessing. 65% keeps only real detections.
 *
 *  • Live snapshot quality 30 → 55
 *    30% JPEG artefacts actively hurt a CNN. 55% costs ~40ms extra
 *    but cuts misidentifications noticeably.
 *
 *  • Interval 1500 → 750 ms
 *    Children move the camera fast. 1.5 s lag makes the chip feel broken.
 *
 *  • SKIP_LABELS expanded 12 → 55 entries
 *    Colours, geometry, raw materials, environment terms, abstraction labels
 *    were slipping through and showing as object names. Blocked.
 *
 *  • Label stability gate (new)
 *    liveLabel only updates when the same top label appears in two
 *    consecutive frames. Kills the "Book → Technology → Book" flicker
 *    that made the chip untrustworthy.
 *
 *  FEEL — the "scan ready" signal (new)
 *  ────────────────────────────────────
 *  scanReady = true  when:  stable label exists  AND  confidence ≥ READY_THRESHOLD
 *  stableFrameCount  = 0 / 1 / 2 / 3+  (how locked-on ML Kit is)
 *
 *  These are exported so ScanScreen can change the button state:
 *  "Scan this object" → "✦ Cup — tap to scan!" with a pulse animation.
 *  Children now have a clear "go" signal instead of guessing when to press.
 *
 *  FIXES carried forward from v3.1
 *  ────────────────────────────────
 *  • normalizeLabels() — Shape A / Shape B ML Kit response shapes
 *  • isScanningRef mutex — no concurrent snapshot calls
 *  • AppState listener — re-requests permission on foreground return
 *  • liveConfidence via ref in triggerManualScan dep array
 */

import { AppState, AppStateStatus } from "react-native";
import { useEffect, useRef, useCallback, useState } from "react";
import {
  useCameraDevice,
  useCameraPermission,
  Camera,
} from "react-native-vision-camera";
import { readAsStringAsync } from "expo-file-system/legacy";

// ─── ML Kit lazy load ─────────────────────────────────────────────────────────

let mlKitAvailable = false;
let ImageLabeling: any = null;

async function loadMLKit(): Promise<boolean> {
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
//
// Rule: block ATTRIBUTE / CATEGORY / COLOUR / ENVIRONMENT / GEOMETRY labels.
// Keep only labels that name a concrete, graspable object.

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

  // Colour (ML Kit labels colour a lot)
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
  onDetection: (result: ScanResult) => void;
  enabled?:    boolean;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useObjectScanner({
  onDetection,
  enabled = true,
}: UseObjectScannerOptions) {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device    = useCameraDevice("back");
  const cameraRef = useRef<Camera>(null);

  const [liveLabel,       setLiveLabel]       = useState<string | null>(null);
  const [liveConfidence,  setLiveConfidence]  = useState<number>(0);
  const [stableFrameCount, setStableFrameCount] = useState<number>(0);
  const [scanReady,       setScanReady]       = useState<boolean>(false);

  /**
   * Top 3 ML Kit labels (text only, lowercased) for the property-hint engine.
   * Updated on every successful periodic tick. Empty when ML Kit found
   * nothing this frame. Pure data — no UI behaviour attached at this layer.
   */
  const [topLabels,       setTopLabels]       = useState<string[]>([]);

  // Mutex: prevent concurrent snapshots
  const isScanningRef = useRef(false);

  // Stale-closure-free reads for triggerManualScan
  const liveLabelRef = useRef<string | null>(null);
  const liveConfRef  = useRef<number>(0);
  liveLabelRef.current = liveLabel;
  liveConfRef.current  = liveConfidence;

  // Stability tracking across frames
  const prevCandidateRef   = useRef<string | null>(null);
  const stableCountRef     = useRef<number>(0);

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

  // ── ML Kit load ───────────────────────────────────────────────────────────
  useEffect(() => { loadMLKit(); }, []);

  // ── Periodic smart viewfinder ─────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) {
      // Clean slate when scanning stops
      setLiveLabel(null);
      setLiveConfidence(0);
      setStableFrameCount(0);
      setScanReady(false);
      setTopLabels([]);
      prevCandidateRef.current = null;
      stableCountRef.current   = 0;
      return;
    }

    const tick = setInterval(async () => {
      if (!cameraRef.current || isScanningRef.current || !mlKitAvailable) return;

      isScanningRef.current = true;
      try {
        const photo = await cameraRef.current.takeSnapshot({
          quality: LIVE_SCAN_QUALITY,
        });

        const uri = photo.path.startsWith("file://")
          ? photo.path
          : `file://${photo.path}`;

        const raw      = await ImageLabeling.label(uri);
        const sorted   = filterAndSort(raw);
        const best     = sorted[0];

        // Publish top labels for the property-hint engine.
        // Done eagerly (every frame, no stability gate) so hint glow tracks
        // what's in front of the camera right now — children get a faster
        // reaction than the chip name commit.
        setTopLabels(sorted.slice(0, 3).map((l) => l.text.toLowerCase()));

        if (best) {
          const candidate = capitalise(best.text);

          if (candidate === prevCandidateRef.current) {
            // Same label again — increment streak
            stableCountRef.current = Math.min(stableCountRef.current + 1, 5);
          } else {
            // New candidate — reset streak, don't commit yet
            stableCountRef.current   = 1;
            prevCandidateRef.current = candidate;
          }

          const count = stableCountRef.current;

          if (count >= STABILITY_FRAMES_REQUIRED) {
            // Commit label once it's proven stable
            setLiveLabel(candidate);
            setLiveConfidence(best.confidence);
            setStableFrameCount(count);
            setScanReady(
              count >= READY_FRAMES_REQUIRED &&
              best.confidence >= READY_THRESHOLD
            );
          }
        } else {
          // Nothing detected this frame
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
      const photo = await cameraRef.current.takeSnapshot({
        quality: MANUAL_SCAN_QUALITY,
      });

      const uri = photo.path.startsWith("file://")
        ? photo.path
        : `file://${photo.path}`;

      const base64 = await readAsStringAsync(uri, {
        encoding: "base64" as any,
      });

      // Start with the stable live label (via refs — no stale closure)
      let finalLabel = liveLabelRef.current ?? "object";
      let finalConf  = liveLabelRef.current ? liveConfRef.current : 0.5;

      // Fresh ML Kit pass on the higher-quality manual frame when available
      if (mlKitAvailable && ImageLabeling) {
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

      onDetection({
        primary: {
          label:      finalLabel,
          confidence: finalConf,
          bounds:     { x: 0, y: 0, width: 0, height: 0 },
        },
        all:         [],
        frameBase64: base64,
      });
    } catch (e) {
      console.warn("[useObjectScanner] triggerManualScan failed:", e);
    } finally {
      isScanningRef.current = false;
    }
  }, [enabled, onDetection]);

  return {
    cameraRef,
    device,
    hasPermission,
    frameProcessor:   undefined,
    triggerManualScan,
    liveLabel,
    liveConfidence,
    /** 0–5: how many consecutive frames agreed on liveLabel.
     *  Use to drive a "locking on" progress arc or similar. */
    stableFrameCount,
    /** true when ML Kit is confident + stable — a clear "tap now" signal
     *  for the scan button animation in ScanScreen. */
    scanReady,
    /** Top 3 ML Kit labels (lowercased) currently in frame. Empty when
     *  ML Kit found nothing this tick. Feeds the property-hint engine. */
    topLabels,
    mlKitReady:       mlKitAvailable,
    requestPermission,
  };
}
