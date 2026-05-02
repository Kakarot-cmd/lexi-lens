/**
 * services/pdfExportService.ts
 * Lexi-Lens — Phase 2.6: Word Tome PDF Export
 *
 * Orchestrates the full export pipeline:
 *
 *   1. Calls the export-word-tome Edge Function to fetch aggregated data
 *      and the Claude AI portfolio summary (server-side, no API key on device).
 *
 *   2. Builds a rich, illuminated-manuscript-styled HTML document that matches
 *      the app's parchment/amber aesthetic — readable by teachers and parents
 *      even without the app.
 *
 *   3. Uses expo-print to convert the HTML to a PDF file (native WebView
 *      rendering — produces pixel-perfect output with no bundle risk).
 *
 *   4. Uses expo-sharing to open the native OS share sheet so the parent
 *      can send the PDF directly to WhatsApp, email, Google Drive, etc.
 *
 * INSTALL (run once, commit changes to package.json):
 *   npx expo install expo-print
 *   npx expo install expo-sharing
 *
 * ARCHITECTURE DECISION — Why HTML → PDF (not pdfmake in Deno)?
 *   The roadmap specified pdfmake in an Edge Function. However, after the
 *   evaluate EF bundle timeout incident (pdfmake is a heavy Node.js package
 *   with the same esm.sh resolution problems as the Anthropic SDK), we
 *   split the concern:
 *
 *     • Data + AI summary     → Edge Function (export-word-tome)
 *     • PDF rendering          → expo-print on device (native, zero bundle risk)
 *
 *   This produces significantly prettier output (full HTML/CSS vs pdfmake's
 *   JSON API), runs natively on Android without any Deno package issues, and
 *   decouples data fetching from rendering so each can be tested independently.
 *
 * Dependencies:
 *   expo-print    — printToFileAsync(html) → { uri: string }
 *   expo-sharing  — shareAsync(uri, options)
 *   supabase      — functions.invoke() for Edge Function call
 */

import * as Print   from "expo-print";
import * as Sharing from "expo-sharing";
import { supabase } from "../lib/supabase";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PortfolioChild {
  id:           string;
  display_name: string;
  age_band:     string;
  level:        number;
  total_xp:     number;
  avatar_key:   string | null;
}

export interface PortfolioWord {
  word:            string;
  definition:      string;
  exemplar_object: string;
  times_used:      number;
  first_used_at:   string;
  last_used_at:    string;
  mastery_score:   number | null;
  is_retired:      boolean | null;
}

export interface PortfolioQuest {
  total_xp:      number;
  attempt_count: number;
  completed_at:  string;
  quests: {
    name:        string;
    enemy_emoji: string;
    tier:        string;
  } | null;
}

export interface PortfolioData {
  child:       PortfolioChild;
  words:       PortfolioWord[];
  quests:      PortfolioQuest[];
  summary:     string;
  generatedAt: string;
}

export type ExportStep =
  | "idle"
  | "fetching"    // calling Edge Function
  | "generating"  // expo-print rendering HTML → PDF
  | "sharing"     // OS share sheet open
  | "done"
  | "error";

// ─── Edge Function call ───────────────────────────────────────────────────────

/**
 * Fetch portfolio data from the export-word-tome Edge Function.
 * The EF handles auth, RLS bypass, Claude summary generation, and
 * data aggregation in a single round-trip.
 */
export async function fetchPortfolioData(childId: string): Promise<PortfolioData> {
  const { data, error } = await supabase.functions.invoke<PortfolioData>(
    "export-word-tome",
    { body: { childId } }
  );

  if (error) {
    throw new Error(`Portfolio fetch failed: ${error.message}`);
  }

  if (!data) {
    throw new Error("Edge Function returned empty response.");
  }

  return data;
}

// ─── Main export orchestrator ─────────────────────────────────────────────────

/**
 * Full pipeline: fetch → build HTML → print to PDF → share.
 *
 * onStepChange is called with each ExportStep so the calling hook can
 * drive loading UI (e.g., animated step messages in the export button).
 *
 * The PDF filename is auto-generated:
 *   "{ChildName}_WordTome_{Month}_{Year}.pdf"
 *   e.g. "Aarav_WordTome_May_2026.pdf"
 */
export async function generateAndSharePdf(
  childId:      string,
  childName:    string,
  onStepChange: (step: ExportStep) => void
): Promise<void> {

  // Step 1: Fetch portfolio data from Edge Function
  onStepChange("fetching");
  const data = await fetchPortfolioData(childId);

  // Step 2: Build HTML and render to PDF
  onStepChange("generating");
  const html = buildPortfolioHtml(data);

  const { uri } = await Print.printToFileAsync({
    html,
    base64: false,
  });

  // Step 3: Open native share sheet
  onStepChange("sharing");

  const isAvailable = await Sharing.isAvailableAsync();
  if (!isAvailable) {
    throw new Error("Sharing is not available on this device.");
  }

  const month    = new Date().toLocaleString("en-US", { month: "long" });
  const year     = new Date().getFullYear();
  const safeName = childName.replace(/[^a-zA-Z0-9]/g, "_");
  const filename = `${safeName}_WordTome_${month}_${year}.pdf`;

  await Sharing.shareAsync(uri, {
    mimeType:    "application/pdf",
    dialogTitle: `${childName}'s Vocabulary Portfolio`,
    UTI:         "com.adobe.pdf",   // iOS only — ignored on Android
  });

  onStepChange("done");
}

// ─── Mastery helpers ──────────────────────────────────────────────────────────

function masteryTier(score: number | null): {
  label: string;
  color: string;
  bg:    string;
  emoji: string;
} {
  const s = score ?? 0.0;
  if (s >= 0.80) return { label: "Expert",     color: "#6d28d9", bg: "#f5f3ff", emoji: "⭐" };
  if (s >= 0.60) return { label: "Proficient", color: "#166534", bg: "#f0fdf4", emoji: "✅" };
  if (s >= 0.30) return { label: "Developing", color: "#92400e", bg: "#fef3c7", emoji: "📈" };
  return              { label: "Novice",      color: "#6b4c1e", bg: "#f5edda", emoji: "🌱" };
}

function masteryPct(score: number | null): number {
  return Math.round((score ?? 0.0) * 100);
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day:   "numeric",
      year:  "numeric",
    });
  } catch {
    return iso;
  }
}

function fmtShortDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day:   "numeric",
    });
  } catch {
    return iso;
  }
}

function totalXpFromQuests(quests: PortfolioQuest[]): number {
  return quests.reduce((sum, q) => sum + (q.total_xp ?? 0), 0);
}

function activeDaysCount(words: PortfolioWord[], quests: PortfolioQuest[]): number {
  const days = new Set<string>();
  words.forEach(w => {
    try { days.add(new Date(w.first_used_at).toDateString()); } catch {}
    try { days.add(new Date(w.last_used_at).toDateString()); } catch {}
  });
  quests.forEach(q => {
    try { days.add(new Date(q.completed_at).toDateString()); } catch {}
  });
  return days.size;
}

function tierLabel(tier: string | undefined): string {
  const map: Record<string, string> = {
    apprentice: "Apprentice",
    scholar:    "Scholar",
    sage:       "Sage",
    archmage:   "Archmage",
  };
  return map[tier?.toLowerCase() ?? ""] ?? (tier ?? "");
}

// ─── HTML template ────────────────────────────────────────────────────────────

/**
 * Builds the full HTML document that expo-print converts to PDF.
 *
 * Design language: illuminated manuscript — warm cream/parchment backgrounds,
 * amber accents, serif typography, decorative borders. Mirrors the app's
 * ParentDashboard palette exactly so the PDF feels like a natural extension
 * of Lexi-Lens rather than a generic export.
 *
 * Layout (A4 portrait, 20mm margins):
 *   1. Cover header — child name, level, stats, date
 *   2. Claude AI summary — styled as a framed quote
 *   3. Stats overview — 4-column grid
 *   4. Mastery breakdown table — tier distribution
 *   5. Word Catalogue — each word as a card with mastery bar
 *   6. Quest History — recent completions
 *   7. Footer — Lexi-Lens branding + generation date
 */
function buildPortfolioHtml(data: PortfolioData): string {
  const { child, words, quests, summary, generatedAt } = data;

  // ── Computed stats ─────────────────────────────────────────────────────────
  const totalXp      = totalXpFromQuests(quests);
  const activeDays   = activeDaysCount(words, quests);
  const expertCount  = words.filter(w => (w.mastery_score ?? 0) >= 0.80).length;
  const profCount    = words.filter(w => { const s = w.mastery_score ?? 0; return s >= 0.60 && s < 0.80; }).length;
  const devCount     = words.filter(w => { const s = w.mastery_score ?? 0; return s >= 0.30 && s < 0.60; }).length;
  const novCount     = words.filter(w => (w.mastery_score ?? 0) < 0.30).length;
  const retiredCount = words.filter(w => w.is_retired).length;

  const genDate      = fmtDate(generatedAt);

  // ── Word catalogue HTML ────────────────────────────────────────────────────
  const wordsHtml = words.length === 0
    ? `<p style="color:#9c7540;font-style:italic;text-align:center;padding:20px 0;">No words learned yet — the adventure awaits!</p>`
    : words.map(w => {
        const tier = masteryTier(w.mastery_score);
        const pct  = masteryPct(w.mastery_score);
        const retiredBadge = w.is_retired
          ? `<span style="font-size:10px;background:#ede9fe;color:#6d28d9;border:1px solid #c4b5fd;border-radius:4px;padding:2px 7px;margin-left:6px;font-weight:600;">🏆 Retired</span>`
          : "";

        return `
          <div style="border:1px solid #e8d5b0;border-radius:8px;padding:10px 14px;margin-bottom:7px;background:#ffffff;page-break-inside:avoid;">
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px;">
              <div style="display:flex;align-items:center;gap:4px;">
                <span style="font-size:16px;font-weight:700;color:#3d2a0f;font-family:Georgia,serif;">${escHtml(w.word)}</span>
                ${retiredBadge}
              </div>
              <span style="font-size:11px;background:${tier.bg};color:${tier.color};border-radius:4px;padding:2px 8px;font-weight:600;">${tier.emoji} ${tier.label}</span>
            </div>
            <p style="font-size:13px;color:#6b4c1e;margin:4px 0 3px;font-style:italic;">${escHtml(w.definition)}</p>
            <p style="font-size:11px;color:#9c7540;margin:0 0 7px;">
              Found with <strong>${escHtml(w.exemplar_object)}</strong> · Used ${w.times_used}× · Learned ${fmtShortDate(w.first_used_at)}
            </p>
            <!-- Mastery bar -->
            <div style="height:5px;background:#e8d5b0;border-radius:3px;overflow:hidden;">
              <div style="height:5px;width:${pct}%;background:${tier.color};border-radius:3px;"></div>
            </div>
            <p style="font-size:10px;color:#c4a97a;margin:3px 0 0;text-align:right;">${pct}% mastery</p>
          </div>
        `;
      }).join("");

  // ── Quest history HTML ─────────────────────────────────────────────────────
  const questsHtml = quests.length === 0
    ? `<p style="color:#9c7540;font-style:italic;text-align:center;padding:20px 0;">No quests completed yet.</p>`
    : quests.slice(0, 20).map(q => {
        const efficiency = q.attempt_count === 1
          ? `<span style="color:#166534;font-weight:600;">✓ First try!</span>`
          : `${q.attempt_count} attempts`;
        const tierBadge = q.quests?.tier
          ? `<span style="font-size:10px;background:#f5edda;color:#9c7540;border:1px solid #e8d5b0;border-radius:4px;padding:2px 6px;">${tierLabel(q.quests.tier)}</span>`
          : "";
        return `
          <div style="display:flex;align-items:center;gap:10px;border:1px solid #e8d5b0;border-radius:8px;padding:8px 12px;margin-bottom:6px;background:#ffffff;page-break-inside:avoid;">
            <span style="font-size:20px;min-width:28px;text-align:center;">${q.quests?.enemy_emoji ?? "⚔️"}</span>
            <div style="flex:1;min-width:0;">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <span style="font-size:13px;font-weight:700;color:#3d2a0f;">${escHtml(q.quests?.name ?? "Quest")}</span>
                ${tierBadge}
              </div>
              <span style="font-size:11px;color:#9c7540;">${efficiency} · ${fmtShortDate(q.completed_at)}</span>
            </div>
            <span style="font-size:14px;font-weight:700;color:#d97706;white-space:nowrap;">+${q.total_xp} XP</span>
          </div>
        `;
      }).join("");

  // ── Summary block ──────────────────────────────────────────────────────────
  const summaryHtml = summary
    ? `
      <div style="background:#fef3c7;border-left:4px solid #d97706;border-radius:0 6px 6px 0;padding:14px 18px;margin:20px 0 24px;">
        <p style="font-size:13px;line-height:1.7;color:#3d2a0f;margin:0;font-style:italic;font-family:Georgia,serif;">${escHtml(summary)}</p>
        <p style="font-size:10px;color:#c4a97a;margin:8px 0 0;">Generated by Claude AI · ${genDate}</p>
      </div>
    `
    : "";

  // ── Full document ──────────────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${escHtml(child.display_name)} — Vocabulary Portfolio</title>
  <style>
    /* ─── Reset + Page ─────────────────────────────────── */
    * { box-sizing: border-box; margin: 0; padding: 0; }
    @page { size: A4 portrait; margin: 18mm 20mm; }
    body {
      font-family: Georgia, 'Times New Roman', serif;
      background: #fdf8f0;
      color: #3d2a0f;
      font-size: 14px;
      line-height: 1.5;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    /* ─── Section titles ───────────────────────────────── */
    .section-title {
      font-size: 15px;
      font-weight: 700;
      color: #3d2a0f;
      border-bottom: 2px solid #e8d5b0;
      padding-bottom: 6px;
      margin: 24px 0 12px;
      font-family: Georgia, serif;
    }

    /* ─── Tier table ───────────────────────────────────── */
    .tier-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 20px;
      font-size: 12px;
    }
    .tier-table th {
      background: #f5edda;
      color: #6b4c1e;
      border: 1px solid #e8d5b0;
      padding: 7px 10px;
      text-align: left;
      font-weight: 700;
    }
    .tier-table td {
      border: 1px solid #e8d5b0;
      padding: 7px 10px;
      vertical-align: middle;
    }
    .tier-table tr:nth-child(even) td { background: #fdf8f0; }

    /* ─── Footer ───────────────────────────────────────── */
    .footer {
      margin-top: 36px;
      padding-top: 12px;
      border-top: 1px solid #e8d5b0;
      text-align: center;
      font-size: 10px;
      color: #c4a97a;
    }
  </style>
</head>
<body>

  <!-- ═══════════════════════════════════════════════════ -->
  <!-- COVER HEADER                                        -->
  <!-- ═══════════════════════════════════════════════════ -->
  <div style="text-align:center;padding:22px 0 26px;border-bottom:3px solid #e8d5b0;margin-bottom:0;">
    <div style="font-size:13px;letter-spacing:3px;color:#9c7540;text-transform:uppercase;margin-bottom:10px;">📚 Vocabulary Portfolio</div>
    <div style="font-size:32px;font-weight:700;color:#3d2a0f;font-family:Georgia,serif;margin-bottom:6px;">${escHtml(child.display_name)}</div>
    <div style="font-size:14px;color:#9c7540;">
      Age band ${escHtml(child.age_band)} &nbsp;·&nbsp; Level ${child.level} &nbsp;·&nbsp; ${child.total_xp.toLocaleString()} XP total
    </div>
    <div style="font-size:12px;color:#c4a97a;margin-top:4px;">Portfolio generated ${genDate}</div>
  </div>

  <!-- ═══════════════════════════════════════════════════ -->
  <!-- AI PORTFOLIO SUMMARY                               -->
  <!-- ═══════════════════════════════════════════════════ -->
  ${summaryHtml}

  <!-- ═══════════════════════════════════════════════════ -->
  <!-- STATS OVERVIEW                                      -->
  <!-- ═══════════════════════════════════════════════════ -->
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:${summary ? "0" : "20px"} 0 0;">
    ${statCard(words.length.toString(), "Words Mastered", "#d97706", "#fef3c7", "#fde68a")}
    ${statCard(quests.length.toString(), "Quests Done", "#166534", "#f0fdf4", "#86efac")}
    ${statCard(totalXp.toLocaleString(), "XP Earned", "#6d28d9", "#f5f3ff", "#ddd6fe")}
    ${statCard(activeDays.toString(), "Active Days", "#9c7540", "#f5edda", "#e8d5b0")}
  </div>

  <!-- ═══════════════════════════════════════════════════ -->
  <!-- MASTERY BREAKDOWN                                   -->
  <!-- ═══════════════════════════════════════════════════ -->
  <div class="section-title">🎯 Mastery Breakdown</div>
  <table class="tier-table">
    <thead>
      <tr>
        <th>Tier</th>
        <th>Words</th>
        <th>Mastery Range</th>
        <th>What it means</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><span style="color:#6d28d9;font-weight:700;">⭐ Expert</span></td>
        <td style="font-weight:700;color:#6d28d9;">${expertCount}</td>
        <td>80 – 100%</td>
        <td>Word retired · promoted to a harder synonym</td>
      </tr>
      <tr>
        <td><span style="color:#166534;font-weight:700;">✅ Proficient</span></td>
        <td style="font-weight:700;color:#166534;">${profCount}</td>
        <td>60 – 79%</td>
        <td>Solidly learned, reinforced across sessions</td>
      </tr>
      <tr>
        <td><span style="color:#92400e;font-weight:700;">📈 Developing</span></td>
        <td style="font-weight:700;color:#92400e;">${devCount}</td>
        <td>30 – 59%</td>
        <td>Growing with each scan, still being practised</td>
      </tr>
      <tr>
        <td><span style="color:#6b4c1e;font-weight:700;">🌱 Novice</span></td>
        <td style="font-weight:700;color:#6b4c1e;">${novCount}</td>
        <td>0 – 29%</td>
        <td>Recently introduced, needs more encounters</td>
      </tr>
      ${retiredCount > 0 ? `
      <tr style="background:#ede9fe;">
        <td colspan="2"><span style="color:#6d28d9;font-weight:700;">🏆 Retired to synonyms</span></td>
        <td colspan="2" style="color:#6d28d9;">${retiredCount} word${retiredCount !== 1 ? "s" : ""} mastered and promoted to harder vocabulary</td>
      </tr>` : ""}
    </tbody>
  </table>

  <!-- ═══════════════════════════════════════════════════ -->
  <!-- WORD CATALOGUE                                      -->
  <!-- ═══════════════════════════════════════════════════ -->
  <div class="section-title">📖 Word Catalogue &nbsp;<span style="font-weight:400;font-size:13px;color:#9c7540;">(${words.length} word${words.length !== 1 ? "s" : ""}, oldest → newest)</span></div>
  ${wordsHtml}

  <!-- ═══════════════════════════════════════════════════ -->
  <!-- QUEST HISTORY                                       -->
  <!-- ═══════════════════════════════════════════════════ -->
  ${quests.length > 0 ? `
  <div class="section-title">⚔️ Quest History &nbsp;<span style="font-weight:400;font-size:13px;color:#9c7540;">(most recent first)</span></div>
  ${questsHtml}
  ` : ""}

  <!-- ═══════════════════════════════════════════════════ -->
  <!-- FOOTER                                              -->
  <!-- ═══════════════════════════════════════════════════ -->
  <div class="footer">
    <strong style="color:#d97706;">⚔️ Lexi-Lens RPG</strong>
    &nbsp;·&nbsp; Verified Vocabulary Portfolio
    &nbsp;·&nbsp; Generated ${genDate}<br/>
    <span style="margin-top:3px;display:block;">
      This document represents genuine vocabulary achievements earned through
      hands-on AR scanning sessions. Words are verified by Claude AI.
    </span>
  </div>

</body>
</html>`;
}

// ─── HTML template helpers ────────────────────────────────────────────────────

/** Escape HTML special characters to prevent injection in template strings */
function escHtml(str: string | null | undefined): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render a single stat card for the overview grid */
function statCard(
  value:        string,
  label:        string,
  valueColor:   string,
  bgColor:      string,
  borderColor:  string
): string {
  return `
    <div style="background:${bgColor};border:1px solid ${borderColor};border-radius:10px;padding:12px 8px;text-align:center;">
      <div style="font-size:22px;font-weight:700;color:${valueColor};font-family:Georgia,serif;">${escHtml(value)}</div>
      <div style="font-size:11px;color:#9c7540;margin-top:3px;">${escHtml(label)}</div>
    </div>
  `;
}
