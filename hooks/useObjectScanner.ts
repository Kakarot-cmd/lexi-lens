import { useEffect, useRef, useCallback } from "react";
import { useCameraDevice, useCameraPermission, Camera } from "react-native-vision-camera";
import { readAsStringAsync } from "expo-file-system/legacy";

export interface DetectedObject {
  label: string;
  confidence: number;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface ScanResult {
  primary: DetectedObject | null;
  all: DetectedObject[];
  frameBase64: string | null;
}

interface UseObjectScannerOptions {
  onDetection: (result: ScanResult) => void;
  enabled?: boolean;
}

export function useObjectScanner({ onDetection, enabled = true }: UseObjectScannerOptions) {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice("back");
  const cameraRef = useRef<Camera>(null);

  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);

  const triggerManualScan = useCallback(async () => {
    if (!cameraRef.current || !enabled) return;
    try {
      const photo = await cameraRef.current.takeSnapshot({
        quality: 80,
        skipMetadata: true,
      });

      const uri = photo.path.startsWith("file://")
        ? photo.path
        : `file://${photo.path}`;

      // Use string literal "base64" instead of EncodingType enum
      const base64 = await readAsStringAsync(uri, {
        encoding: "base64" as any,
      });

      onDetection({
        primary: {
          label: "object",
          confidence: 0.9,
          bounds: { x: 0, y: 0, width: 0, height: 0 },
        },
        all: [],
        frameBase64: base64,
      });
    } catch (e) {
      console.warn("Snapshot failed", e);
    }
  }, [enabled, onDetection]);

  return {
    cameraRef,
    device,
    hasPermission,
    frameProcessor: undefined,
    triggerManualScan,
  };
}