/**
 * RecentSessionsPanel.tsx
 * ───────────────────────
 * N5 — Recent Sessions panel for ParentDashboard.
 * Deliberately matches the warm cream/amber aesthetic of ParentDashboard
 * (illuminated-manuscript feel, P.* palette equivalents, no gamification pressure).
 *
 * Drop-in usage:
 *   <RecentSessionsPanel
 *     childId={selectedChild?.id}
 *     childName={selectedChild?.display_name}
 *     refreshKey={sessionRefreshKey}
 *   />
 *
 * Self-contained: loading / empty / error / 7d↔30d toggle built in.
 * All Supabase access goes through services/sessionsService.ts.
 * Zero new dependencies.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from "react-native";
import {
  classifyEngagement,
  getRecentSessions,
  getSessionsSummary,
  type EngagementLevel,
  type QuestSession,
  type SessionsSummary,
} from "../services/sessionsService";
import * as SentryShim from "../lib/sentry";

// ─── Palette (mirrors ParentDashboard P.*) ────────────────────────────────

const P = {
  cream:        "#fdf8f0",
  parchment:    "#f5edda",
  warmBorder:   "#e8d5b0",
  inkBrown:     "#3d2a0f",
  inkMid:       "#6b4c1e",
  inkLight:     "#9c7540",
  inkFaint:     "#c4a97a",
  amberAccent:  "#d97706",
  amberLight:   "#fef3c7",
  amberBorder:  "#fde68a",
  greenBadge:   "#166534",
  greenBg:      "#f0fdf4",
  greenBorder:  "#86efac",
};

// ─── Observability shim ───────────────────────────────────────────────────

function trace(b: {
  category: string;
  message:  string;
  level?:   "info" | "warning" | "error";
  data?:    Record<string, unknown>;
}): void {
  const fn = (SentryShim as { addBreadcrumb?: (b: unknown) => void }).addBreadcrumb;
  if (typeof fn === "function") fn(b);
}

// ─── Types ────────────────────────────────────────────────────────────────

interface Props {
  childId?:    string | null;
  childName?:  string;
  /** Bump to force a reload — increment on pull-to-refresh. */
  refreshKey?: number;
}

type WindowDays = 7 | 30;

// ─── Main component ───────────────────────────────────────────────────────

export function RecentSessionsPanel({ childId, childName, refreshKey }: Props) {
  const [windowDays, setWindowDays] = useState<WindowDays>(7);
  const [summary,    setSummary]    = useState<SessionsSummary | null>(null);
  const [sessions,   setSessions]   = useState<QuestSession[]>([]);
  const [loading,    setLoading]    = useState(false);
  const [errored,    setErrored]    = useState(false);
  const [expanded,   setExpanded]   = useState(false);

  const load = useCallback(async () => {
    if (!childId) { setSummary(null); setSessions([]); return; }
    setLoading(true);
    setErrored(false);
    try {
      const [s, list] = await Promise.all([
        getSessionsSummary(childId, { windowDays }),
        getRecentSessions(childId, { windowDays, limit: 20 }),
      ]);
      setSummary(s);
      setSessions(list);
      trace({ category: "sessions", level: "info", message: "RecentSessionsPanel loaded", data: { windowDays, count: list.length } });
    } catch {
      setErrored(true);
      trace({ category: "sessions", level: "error", message: "RecentSessionsPanel load threw" });
    } finally {
      setLoading(false);
    }
  }, [childId, windowDays]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const visibleSessions = useMemo(
    () => (expanded ? sessions : sessions.slice(0, 5)),
    [sessions, expanded],
  );

  const engagement = summary ? classifyEngagement(summary) : null;
  const noActivity = !summary || summary.sessionCount === 0;

  if (!childId) {
    return (
      <Card>
        <PanelHeader windowDays={windowDays} onWindowChange={setWindowDays} />
        <EmptyState title="No child selected" subtitle="Pick a child profile to see their session history." />
      </Card>
    );
  }

  if (loading && !summary) {
    return (
      <Card>
        <PanelHeader windowDays={windowDays} onWindowChange={setWindowDays} />
        <View style={s.loadingBox}>
          <ActivityIndicator color={P.amberAccent} />
        </View>
      </Card>
    );
  }

  if (errored) {
    return (
      <Card>
        <PanelHeader windowDays={windowDays} onWindowChange={setWindowDays} />
        <View style={s.errorBox}>
          <Text style={s.errorText}>Couldn't load sessions just now.</Text>
          <TouchableOpacity onPress={load} style={s.retryBtn}>
            <Text style={s.retryBtnText}>Try again</Text>
          </TouchableOpacity>
        </View>
      </Card>
    );
  }

  if (noActivity) {
    return (
      <Card>
        <PanelHeader windowDays={windowDays} onWindowChange={setWindowDays} />
        <EmptyState
          title={childName ? `${childName} hasn't played in the last ${windowDays} days` : `No sessions in the last ${windowDays} days`}
          subtitle="Sessions appear here as soon as a quest is started."
        />
      </Card>
    );
  }

  return (
    <Card>
      <PanelHeader windowDays={windowDays} onWindowChange={setWindowDays} />
      <SummaryCard summary={summary!} engagement={engagement!} />
      <View style={s.list}>
        {visibleSessions.map((session) => (
          <SessionRow key={session.id} session={session} />
        ))}
      </View>
      {sessions.length > 5 && (
        <TouchableOpacity onPress={() => setExpanded((x) => !x)} style={s.expandBtn} accessibilityRole="button">
          <Text style={s.expandBtnText}>
            {expanded ? "Show fewer" : `Show all ${sessions.length} sessions`}
          </Text>
        </TouchableOpacity>
      )}
    </Card>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────

function Card({ children }: { children: React.ReactNode }) {
  return <View style={s.card}>{children}</View>;
}

function PanelHeader({ windowDays, onWindowChange }: { windowDays: WindowDays; onWindowChange: (v: WindowDays) => void }) {
  return (
    <View style={s.header}>
      <Text style={s.headerTitle}>📅  Recent Sessions</Text>
      <View style={s.toggleWrap}>
        {([7, 30] as WindowDays[]).map((v) => {
          const active = v === windowDays;
          return (
            <TouchableOpacity key={v} onPress={() => onWindowChange(v)} style={[s.togglePill, active && s.togglePillActive]} accessibilityRole="button" accessibilityState={{ selected: active }}>
              <Text style={[s.togglePillText, active && s.togglePillTextActive]}>{v}d</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function SummaryCard({ summary, engagement }: { summary: SessionsSummary; engagement: EngagementLevel }) {
  const minutesActive = Math.round(summary.totalDurationSec / 60);
  const avgMinutes    = Math.round(summary.avgDurationSec   / 60);

  return (
    <View style={s.summaryBox}>
      <EngagementPill level={engagement} />
      <XpSparkline values={summary.dailyXp} />
      <View style={s.statRow}>
        <Chip label="Active days" value={`${summary.activeDays}`} />
        <Chip label="Quests"      value={`${summary.totalQuests}`} />
        <Chip label="XP earned"   value={`${summary.totalXp}`} highlight />
        <Chip label="Avg. session" value={avgMinutes > 0 ? `${avgMinutes}m` : `${summary.avgDurationSec}s`} />
      </View>
      <Text style={s.footnote}>
        {minutesActive >= 1
          ? `${minutesActive} min of play across ${summary.sessionCount} session${summary.sessionCount === 1 ? "" : "s"}.`
          : `${summary.sessionCount} session${summary.sessionCount === 1 ? "" : "s"} so far.`}
      </Text>
    </View>
  );
}

function EngagementPill({ level }: { level: EngagementLevel }) {
  const meta: Record<EngagementLevel, { label: string; bg: string; border: string; fg: string }> = {
    active: { label: "🔥 Active this week",  bg: P.greenBg,    border: P.greenBorder, fg: P.greenBadge   },
    casual: { label: "✨ Casual this week",   bg: P.amberLight, border: P.amberBorder, fg: P.amberAccent  },
    quiet:  { label: "🌙 Quiet this week",   bg: P.parchment,  border: P.warmBorder,  fg: P.inkLight     },
  };
  const m = meta[level];
  return (
    <View style={[s.pill, { backgroundColor: m.bg, borderColor: m.border }]}>
      <Text style={[s.pillText, { color: m.fg }]}>{m.label}</Text>
    </View>
  );
}

function Chip({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <View style={[s.chip, highlight && s.chipHighlight]}>
      <Text style={[s.chipValue, highlight && s.chipValueHighlight]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      <Text style={s.chipLabel} numberOfLines={1}>{label}</Text>
    </View>
  );
}

function XpSparkline({ values }: { values: number[] }) {
  const max   = Math.max(1, ...values);
  const BAR_H = 40;
  return (
    <View style={s.sparkWrap}>
      <View style={s.sparkRow}>
        {values.map((v, i) => (
          <View
            key={i}
            style={[s.sparkBar, {
              height:          v === 0 ? 2 : Math.max(4, Math.round((v / max) * BAR_H)),
              backgroundColor: v === 0 ? P.warmBorder : P.amberAccent,
              opacity:         i === values.length - 1 ? 1 : v === 0 ? 1 : 0.75,
            }]}
            accessible
            accessibilityLabel={`Day ${i + 1}: ${v} XP`}
          />
        ))}
      </View>
      <Text style={s.sparkCaption}>Daily XP — last {values.length} days</Text>
    </View>
  );
}

const SessionRow = React.memo(function SessionRow({ session }: { session: QuestSession }) {
  return (
    <View style={s.row}>
      <View style={s.rowLeft}>
        <Text style={s.rowWhen} numberOfLines={1}>{formatRelative(session.started_at)}</Text>
        <Text style={s.rowMeta} numberOfLines={1}>
          {formatDuration(session.duration_sec)} · {session.quests_finished === 1 ? "1 quest" : `${session.quests_finished ?? 0} quests`}
        </Text>
      </View>
      <Text style={s.rowXp}>+{session.xp_earned ?? 0} XP</Text>
    </View>
  );
});

function EmptyState({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View style={s.emptyBox}>
      <Text style={s.emptyTitle}>{title}</Text>
      <Text style={s.emptySubtitle}>{subtitle}</Text>
    </View>
  );
}

// ─── Formatters ───────────────────────────────────────────────────────────

function formatRelative(iso: string): string {
  const d         = new Date(iso);
  const now       = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString())       return `Today, ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { weekday: "short" })}, ${d.toLocaleDateString([], { day: "numeric", month: "short" })}`;
}

function formatDuration(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60)   return `${sec}s`;
  const m  = Math.floor(sec / 60);
  const s  = sec % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  const h  = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}

// ─── Styles ───────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  card: {
    backgroundColor: P.parchment,
    borderRadius:    14,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    overflow:        "hidden",
    marginTop:       12,
  },
  header: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    paddingHorizontal: 16,
    paddingVertical:   12,
    borderBottomWidth: 1,
    borderBottomColor: P.warmBorder,
  },
  headerTitle:          { fontSize: 15, fontWeight: "700", color: P.inkBrown },
  toggleWrap:           { flexDirection: "row", backgroundColor: P.cream, borderRadius: 20, borderWidth: 1, borderColor: P.warmBorder, padding: 3 },
  togglePill:           { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  togglePillActive:     { backgroundColor: P.amberLight },
  togglePillText:       { fontSize: 12, fontWeight: "600", color: P.inkLight },
  togglePillTextActive: { color: P.amberAccent },
  summaryBox:           { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: P.warmBorder, gap: 10 },
  pill:                 { alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, borderWidth: 1 },
  pillText:             { fontSize: 12, fontWeight: "600" },
  sparkWrap:            { width: "100%" },
  sparkRow:             { flexDirection: "row", alignItems: "flex-end", gap: 3, height: 40 },
  sparkBar:             { flex: 1, borderRadius: 3, minWidth: 6 },
  sparkCaption:         { marginTop: 5, fontSize: 11, color: P.inkFaint },
  statRow:              { flexDirection: "row", gap: 8 },
  chip:                 { flex: 1, backgroundColor: P.cream, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 6, alignItems: "center", borderWidth: 1, borderColor: P.warmBorder },
  chipHighlight:        { backgroundColor: P.amberLight, borderColor: P.amberBorder },
  chipValue:            { fontSize: 17, fontWeight: "700", color: P.inkBrown },
  chipValueHighlight:   { color: P.amberAccent },
  chipLabel:            { marginTop: 2, fontSize: 11, color: P.inkLight },
  footnote:             { fontSize: 12, color: P.inkFaint },
  list:                 {},
  row:                  { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: P.warmBorder, backgroundColor: "#fff" },
  rowLeft:              { flex: 1, paddingRight: 12 },
  rowWhen:              { fontSize: 14, fontWeight: "600", color: P.inkBrown },
  rowMeta:              { marginTop: 2, fontSize: 12, color: P.inkLight },
  rowXp:                { fontSize: 14, fontWeight: "700", color: P.amberAccent },
  expandBtn:            { paddingVertical: 12, alignItems: "center", borderTopWidth: 1, borderTopColor: P.warmBorder, backgroundColor: P.cream },
  expandBtnText:        { fontSize: 13, fontWeight: "600", color: P.amberAccent },
  loadingBox:           { paddingVertical: 32, alignItems: "center" },
  errorBox:             { paddingVertical: 24, paddingHorizontal: 16, alignItems: "center" },
  errorText:            { fontSize: 13, color: P.inkMid, marginBottom: 10 },
  retryBtn:             { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: P.amberLight, borderWidth: 1, borderColor: P.amberBorder },
  retryBtnText:         { fontSize: 13, fontWeight: "600", color: P.amberAccent },
  emptyBox:             { paddingVertical: 28, paddingHorizontal: 18, alignItems: "center" },
  emptyTitle:           { fontSize: 14, fontWeight: "600", color: P.inkBrown, textAlign: "center" },
  emptySubtitle:        { marginTop: 4, fontSize: 12, color: P.inkLight, textAlign: "center", maxWidth: 280 },
});
