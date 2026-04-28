/**
 * useObjectScanner.ts
 * Lexi-Lens — Phase 3.1: Smart Viewfinder with ML Kit
 *
 * Strategy: "Smart Viewfinder" — scan button stays, ML Kit adds live preview.
 *
 *   1. Every 1.5 s, takes a low-quality snapshot and runs ML Kit Image Labeling
 *      on-device. Updates `liveLabel` / `liveConfidence` state.
 *   2. `triggerManualScan` (scan button) uses the current `liveLabel` as the
 *      detectedLabel sent to Claude — Claude then only evaluates vocabulary
 *      properties, not object identification. ~50% cheaper API calls.
 *   3. If ML Kit is unavailable (pre-EAS build) or returns nothing, falls back
 *      to current behaviour: Claude identifies + evaluates.
 *
 * Install:
 *   npx expo install @react-native-ml-kit/image-labeling
 *   (requires EAS build — npx expo run:android — not Expo Go)
 *
 * FIXES applied:
 *   • [BUG]  TypeError: Cannot read property 'filter' of undefined
 *     @react-native-ml-kit/image-labeling returns one of two shapes on Android:
 *       Shape A (typical): ImageLabel[]             ← bare array
 *       Shape B (some builds): { labels: ImageLabel[] }  ← wrapped object
 *     Previously `?? []` only guarded null/undefined — a wrapped object passed
 *     straight through, `.filter` on a plain object is undefined → crash.
 *     Fixed with normalizeLabels() + pickBestLabel() helpers.
 *   • [BUG]  Syntax error — a prior edit accidentally deleted `.filter(` leaving
 *     a dangling arrow function as a bare statement. Fully rewritten.
 *   • [BUG]  catch { console.log(..., e) } — `e` undefined (no catch binding).
 *   • [LOGS] Removed 3 development console.log calls.
 *   • [CLEAN] Removed unused top-level ImageLabelingTest import.
 *   • [PERF] liveConfidence removed from triggerManualScan deps array — now read
 *     via ref, eliminating unnecessary callback recreation on every confidence tick.
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { useCameraDevice, useCameraPermission, Camera } from "react-native-vision-camera";
import { readAsStringAsync } from "expo-file-system/legacy";

// ─── ML Kit — lazy loaded so app doesn't crash before EAS build ───────────────

let mlKitAvailable = false;
let ImageLabeling: any = null;

async function loadMLKit(): Promise<boolean> {
  if (ImageLabeling) return true;
  try {
    const mod      = await import("@react-native-ml-kit/image-labeling");
    ImageLabeling  = mod.default ?? mod;
    mlKitAvailable = true;
    return true;
  } catch (e) {
    // Silent — app falls back to Claude-only identification automatically.
    // This path is normal in Expo Go before the first EAS native build.
    mlKitAvailable = false;
    return false;
  }
}

// ─── ML Kit response normaliser ───────────────────────────────────────────────
//
// @react-native-ml-kit/image-labeling has two possible return shapes depending
// on the native bridge version bundled in the EAS build:
//
//   Shape A  ImageLabel[]                 (bare array — most common)
//   Shape B  { labels: ImageLabel[] }     (wrapped — some Android builds)
//
// `?? []` only catches null/undefined — a wrapped object is truthy so it
// passed straight through, and `.filter` on a plain object is undefined:
//   "TypeError: Cannot read property 'filter' of undefined"
//
// normalizeLabels() handles both shapes and always returns a plain array.

function normalizeLabels(raw: unknown): Array<{ text: string; confidence: number }> {
  if (Array.isArray(raw)) return raw;
  if (raw !== null && typeof raw === "object") {
    const wrapped = (raw as Record<string, unknown>).labels;
    if (Array.isArray(wrapped)) return wrapped;
  }
  return [];
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

const CONFIDENCE_THRESHOLD = 0.55;

const SCAN_INTERVAL_MS = 1500;

const SKIP_LABELS = new Set([
  "product", "technology", "material", "font", "pattern",
  "rectangle", "circle", "line", "black", "white", "grey", "gray",
  "snapshot", "image", "photo", "picture",
]);

/** Normalise raw ML Kit output, filter generics + low confidence, return best. */
function pickBestLabel(
  raw: unknown
): { text: string; confidence: number } | undefined {
  return normalizeLabels(raw)
    .filter(
      (l) =>
        l.confidence >= CONFIDENCE_THRESHOLD &&
        !SKIP_LABELS.has(l.text.toLowerCase())
    )
    .sort((a, b) => b.confidence - a.confidence)[0];
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

  const [liveLabel,      setLiveLabel]      = useState<string | null>(null);
  const [liveConfidence, setLiveConfidence] = useState<number>(0);

  // Prevent concurrent snapshots (periodic + manual)
  const isScanningRef = useRef(false);

  // Refs so triggerManualScan can read latest values without stale closures
  // and without liveConfidence being in the useCallback dep array
  const liveLabelRef  = useRef<string | null>(null);
  const liveConfRef   = useRef<number>(0);
  liveLabelRef.current = liveLabel;
  liveConfRef.current  = liveConfidence;

  // Camera permission
  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);

  // Load ML Kit on mount — silently no-ops if native module isn't compiled yet
  useEffect(() => { loadMLKit(); }, []);

  // ── Periodic smart viewfinder ──────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) {
      setLiveLabel(null);
      setLiveConfidence(0);
      return;
    }

    const interval = setInterval(async () => {
      if (!cameraRef.current || isScanningRef.current || !mlKitAvailable) return;

      isScanningRef.current = true;
      try {
        // Low quality — only need ML Kit labels, not a nice image
        const photo = await cameraRef.current.takeSnapshot({
          quality:      30,
          skipMetadata: true,
        });

        const uri = photo.path.startsWith("file://")
          ? photo.path
          : `file://${photo.path}`;

        const raw  = await ImageLabeling.label(uri);
        const best = pickBestLabel(raw);

        if (best) {
          setLiveLabel(capitalise(best.text));
          setLiveConfidence(best.confidence);
        } else {
          setLiveLabel(null);
          setLiveConfidence(0);
        }
      } catch {
        // Silent — stale label stays until next cycle
      } finally {
        isScanningRef.current = false;
      }
    }, SCAN_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [enabled]);

  // ── Manual scan (button tap) ───────────────────────────────────────────────
  const triggerManualScan = useCallback(async () => {
    if (!cameraRef.current || !enabled || isScanningRef.current) return;

    isScanningRef.current = true;
    try {
      // High quality snapshot — sent to Claude for image evaluation
      const photo = await cameraRef.current.takeSnapshot({
        quality:      80,
        skipMetadata: true,
      });

      const uri = photo.path.startsWith("file://")
        ? photo.path
        : `file://${photo.path}`;

      const base64 = await readAsStringAsync(uri, {
        encoding: "base64" as any,
      });

      // Default: use whatever the periodic viewfinder last saw (via refs)
      let finalLabel = liveLabelRef.current ?? "object";
      let finalConf  = liveLabelRef.current ? liveConfRef.current : 0.9;

      // Prefer a fresh ML Kit pass on the high-quality frame when available
      if (mlKitAvailable && ImageLabeling) {
        try {
          const freshRaw  = await ImageLabeling.label(uri);
          const freshBest = pickBestLabel(freshRaw);
          if (freshBest) {
            finalLabel = capitalise(freshBest.text);
            finalConf  = freshBest.confidence;
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
  // liveConfidence intentionally NOT in deps — read via liveConfRef above

  return {
    cameraRef,
    device,
    hasPermission,
    frameProcessor: undefined,  // slot reserved for future frame processor
    triggerManualScan,
    liveLabel,
    liveConfidence,
    mlKitReady: mlKitAvailable,
  };
}
