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
 * Exports:
 *   liveLabel      — best current ML Kit label ("cushion") or null
 *   liveConfidence — 0-1 confidence score
 *   triggerManualScan — unchanged API, now pre-fills detectedLabel
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { useCameraDevice, useCameraPermission, Camera } from "react-native-vision-camera";
import { readAsStringAsync } from "expo-file-system/legacy";
import ImageLabelingTest from "@react-native-ml-kit/image-labeling";
console.log("ML Kit direct import:", ImageLabelingTest);

// ─── ML Kit — lazy loaded so app doesn't crash before EAS build ───────────────

let mlKitAvailable = false;
let ImageLabeling: any = null;

async function loadMLKit() {
  if (ImageLabeling) return true;
  try {
    const mod = await import("@react-native-ml-kit/image-labeling");
    ImageLabeling = mod.default ?? mod;
    mlKitAvailable = true;
	console.log("✅ ML Kit loaded successfully"); 
    return true;
  } catch {
    mlKitAvailable = false;
	console.log("❌ ML Kit not available:", e);
    return false;
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Only show/use labels above this confidence. */
const CONFIDENCE_THRESHOLD = 0.55;

/** How often the smart viewfinder samples a frame (ms). */
const SCAN_INTERVAL_MS = 1500;

/** Labels that are too generic to be useful — skip them. */
const SKIP_LABELS = new Set([
  "product", "technology", "material", "font", "pattern",
  "rectangle", "circle", "line", "black", "white", "grey", "gray",
  "snapshot", "image", "photo", "picture",
]);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DetectedObject {
  label:      string;
  confidence: number;
  bounds:     { x: number; y: number; width: number; height: number };
}

export interface ScanResult {
  primary:      DetectedObject | null;
  all:          DetectedObject[];
  frameBase64:  string | null;
}

interface UseObjectScannerOptions {
  onDetection: (result: ScanResult) => void;
  enabled?:    boolean;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useObjectScanner({ onDetection, enabled = true }: UseObjectScannerOptions) {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device     = useCameraDevice("back");
  const cameraRef  = useRef<Camera>(null);

  // ── ML Kit live label state ──────────────────────────────────────────────────
  const [liveLabel, setLiveLabel]           = useState<string | null>(null);
  const [liveConfidence, setLiveConfidence] = useState<number>(0);

  // Prevent concurrent snapshots (periodic + manual)
  const isScanningRef = useRef(false);
  // Keep latest liveLabel accessible inside triggerManualScan without stale closure
  const liveLabelRef  = useRef<string | null>(null);
  liveLabelRef.current = liveLabel;

  // Request camera permission on mount
  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);

  // Load ML Kit on mount (silently fails before EAS build)
  useEffect(() => {
    loadMLKit();
  }, []);

  // ── Periodic smart viewfinder ─────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) {
      // Reset live label when scanner is disabled
      setLiveLabel(null);
      setLiveConfidence(0);
      return;
    }

    const interval = setInterval(async () => {
      if (!cameraRef.current || isScanningRef.current || !mlKitAvailable) return;

      isScanningRef.current = true;
      try {
        // Low quality — we only need ML Kit labels, not a nice image
        const photo = await cameraRef.current.takeSnapshot({
          quality:      30,
          skipMetadata: true,
        });

        const uri = photo.path.startsWith("file://")
          ? photo.path
          : `file://${photo.path}`;

        const labels: Array<{ text: string; confidence: number }> =
          await ImageLabeling.label(uri);

        // Pick the highest-confidence non-generic label
        const best = (labels ?? [])
          .filter(
            (l) =>
              l.confidence >= CONFIDENCE_THRESHOLD &&
              !SKIP_LABELS.has(l.text.toLowerCase())
          )
          .sort((a, b) => b.confidence - a.confidence)[0];

        if (best) {
          // Capitalise first letter for display
          const label = best.text.charAt(0).toUpperCase() + best.text.slice(1).toLowerCase();
          setLiveLabel(label);
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

  // ── Manual scan (button tap) ──────────────────────────────────────────────────
  const triggerManualScan = useCallback(async () => {
    if (!cameraRef.current || !enabled || isScanningRef.current) return;

    isScanningRef.current = true;
    try {
      // High quality snapshot for Claude's image evaluation
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

      // Use ML Kit label if available, otherwise generic fallback
      const currentLabel  = liveLabelRef.current;
      const currentConf   = liveConfidence;

      // Run ML Kit on the high-quality snapshot too for freshest label
      let finalLabel  = currentLabel ?? "object";
      let finalConf   = currentLabel ? currentConf : 0.9;

      if (mlKitAvailable && ImageLabeling) {
        try {
          const freshLabels: Array<{ text: string; confidence: number }> =
            await ImageLabeling.label(uri);

          const freshBest = (freshLabels ?? [])
            .filter(
              (l) =>
                l.confidence >= CONFIDENCE_THRESHOLD &&
                !SKIP_LABELS.has(l.text.toLowerCase())
            )
            .sort((a, b) => b.confidence - a.confidence)[0];

          if (freshBest) {
            finalLabel = freshBest.text.charAt(0).toUpperCase() +
                         freshBest.text.slice(1).toLowerCase();
            finalConf  = freshBest.confidence;
          }
        } catch {
          // Use periodic label as fallback
        }
      }

      onDetection({
        primary: {
          label:      finalLabel,
          confidence: finalConf,
          bounds:     { x: 0, y: 0, width: 0, height: 0 },
        },
        all:          [],
        frameBase64:  base64,
      });
    } catch (e) {
      console.warn("[useObjectScanner] triggerManualScan failed:", e);
    } finally {
      isScanningRef.current = false;
    }
  }, [enabled, onDetection, liveConfidence]);

  return {
    cameraRef,
    device,
    hasPermission,
    frameProcessor: undefined,   // frame processor slot — reserved for future
    triggerManualScan,
    // v3.1 — ML Kit live state
    liveLabel,
    liveConfidence,
    mlKitReady: mlKitAvailable,
  };
}
