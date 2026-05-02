/**
 * hooks/usePdfExport.ts
 * Lexi-Lens — Phase 2.6: Word Tome PDF Export
 *
 * React hook that drives the PDF export state machine.
 *
 * State flow:
 *
 *   idle
 *    │ exportPdf() called
 *    ▼
 *   fetching ──────────────────── "📚 Gathering your Word Tome..."
 *    │ Edge Function returns data
 *    ▼
 *   generating ─────────────────── "🎨 Crafting your portfolio..."
 *    │ expo-print renders HTML → PDF file
 *    ▼
 *   sharing ─────────────────────── "✉️ Opening share sheet..."
 *    │ OS share sheet shown to user
 *    ▼
 *   done ────────────────────────── "✅ Portfolio shared!"
 *
 *   Any step can fail → error ─── error message set, reset() restores idle
 *
 * Usage:
 *
 *   const { exportPdf, status, statusMessage, isExporting, error, reset } =
 *     usePdfExport();
 *
 *   // Trigger export
 *   await exportPdf(childId, child.display_name);
 *
 *   // Show loading UI
 *   {isExporting && <Text>{statusMessage}</Text>}
 *   {status === "error" && <Text>{error}</Text>}
 *
 * Error handling philosophy (mirrors MasteryService pattern):
 *   Non-throwing. All errors are caught and surfaced via the `error` field.
 *   The caller never needs try/catch — just read `status` and `error`.
 *
 * Sentry:
 *   Breadcrumbs are added at each step for observability. Errors are captured
 *   via captureGameError() consistent with the rest of the codebase.
 */

import { useState, useCallback, useRef } from "react";
import { generateAndSharePdf, type ExportStep } from "../services/pdfExportService";
import { addGameBreadcrumb, captureGameError } from "../lib/sentry";

// ─── Types ────────────────────────────────────────────────────────────────────

export type { ExportStep };

export interface UsePdfExportResult {
  /** Current step in the export pipeline */
  status: ExportStep;

  /** Human-readable message to show in the UI during each step */
  statusMessage: string;

  /** True during fetching, generating, and sharing steps */
  isExporting: boolean;

  /** Error message if status === "error", null otherwise */
  error: string | null;

  /** Start the export pipeline for the given child */
  exportPdf: (childId: string, childName: string) => Promise<void>;

  /** Reset back to idle (call after an error to allow retry) */
  reset: () => void;
}

// ─── Status messages ──────────────────────────────────────────────────────────

const STATUS_MESSAGES: Record<ExportStep, string> = {
  idle:       "",
  fetching:   "📚 Gathering your Word Tome...",
  generating: "🎨 Crafting your portfolio...",
  sharing:    "✉️ Opening share sheet...",
  done:       "✅ Portfolio shared!",
  error:      "Something went wrong.",
};

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function usePdfExport(): UsePdfExportResult {
  const [status, setStatus] = useState<ExportStep>("idle");
  const [error,  setError]  = useState<string | null>(null);

  // Guard against calling exportPdf while another export is in flight
  const isInFlight = useRef(false);

  const exportPdf = useCallback(async (childId: string, childName: string) => {
    if (isInFlight.current) return;
    isInFlight.current = true;

    setError(null);
    setStatus("fetching");

    addGameBreadcrumb({
      category: "pdf_export",
      message:  `PDF export started for child ${childId}`,
      level:    "info",
      data:     { childId, childName },
    });

    try {
      await generateAndSharePdf(childId, childName, (step) => {
        setStatus(step);

        addGameBreadcrumb({
          category: "pdf_export",
          message:  `Export step: ${step}`,
          level:    "info",
          data:     { step, childId },
        });
      });

      // generateAndSharePdf sets status to "done" via onStepChange before returning
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "PDF export failed.";
      setError(msg);
      setStatus("error");

      captureGameError(
        err instanceof Error ? err : new Error(msg),
        {
          context: "pdf_export",
          screen:  "ParentDashboard",
          childId,
        }
      );

      addGameBreadcrumb({
        category: "pdf_export",
        message:  `Export error: ${msg}`,
        level:    "error",
        data:     { childId, error: msg },
      });
    } finally {
      isInFlight.current = false;
    }
  }, []);

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
    isInFlight.current = false;
  }, []);

  const isExporting = status === "fetching" || status === "generating" || status === "sharing";

  return {
    status,
    statusMessage: STATUS_MESSAGES[status],
    isExporting,
    error,
    exportPdf,
    reset,
  };
}
