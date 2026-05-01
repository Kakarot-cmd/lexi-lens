/**
 * MasteryRadarPanel.tsx
 * ─────────────────────
 * N3 — Vocabulary Mastery Radar for ParentDashboard.
 *
 * Renders a 6-axis hexagonal radar plotting the child's average mastery score
 * across sensory domains: texture, colour, structure, sound, shape, material.
 *
 * Visual matches the warm cream/amber ParentDashboard palette so the panel
 * sits next to the Streak Heatmap and Recent Sessions like a sibling, not a
 * grafted-on chart.
 *
 * Drop-in usage:
 *   <MasteryRadarPanel
 *     childId={selectedChild?.id}
 *     childName={selectedChild?.display_name}
 *     refreshKey={sessionRefreshKey}
 *   />
 *
 * On mount it:
 *   1. Fetches whatever's already classified (renders immediately).
 *   2. Fires-and-forgets the classify-words EF for any unclassified words.
 *   3. After ~5s, refetches once to pick up new classifications.
 *   4. Shows "X words being classified…" footnote while in flight.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from "react-native";
import Svg, { Polygon, Line, Circle, Text as SvgText, G } from "react-native-svg";
import {
  classifyMissingWords,
  getMasteryRadar,
  RADAR_DOMAINS,
  type Domain,
  type DomainStat,
  type MasteryRadarData,
} from "../services/masteryRadarService";
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

// ─── Props ────────────────────────────────────────────────────────────────

interface Props {
  childId?:    string | null;
  childName?:  string;
  refreshKey?: number;
}

// ─── Main panel ───────────────────────────────────────────────────────────

export function MasteryRadarPanel({ childId, childName, refreshKey }: Props) {
  const [data,        setData]        = useState<MasteryRadarData | null>(null);
  const [loading,     setLoading]     = useState(false);
  const [errored,     setErrored]     = useState(false);
  const [classifying, setClassifying] = useState<number>(0);

  // Track active timers so we can clean up on unmount or child switch
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!childId) {
      setData(null);
      return;
    }
    setLoading(true);
    setErrored(false);
    try {
      const result = await getMasteryRadar(childId);
      setData(result);
    } catch {
      setErrored(true);
      trace({ category: "mastery-radar", level: "error", message: "load threw" });
    } finally {
      setLoading(false);
    }
  }, [childId]);

  // Fire-and-forget classification, then refetch once after a short delay
  const triggerClassification = useCallback(async (unclassifiedCount: number) => {
    if (!childId || unclassifiedCount === 0) return;
    setClassifying(unclassifiedCount);

    const result = await classifyMissingWords(childId);
    if (result && result.classified > 0) {
      // Clear any existing timer before scheduling a new one
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
      refetchTimerRef.current = setTimeout(() => {
        load().finally(() => setClassifying(0));
      }, 800); // small delay so DB write fully settles before re-read
    } else {
      setClassifying(0);
    }
  }, [childId, load]);

  // Initial load + after refreshKey bump
  useEffect(() => {
    load();
    return () => {
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    };
  }, [load, refreshKey]);

  // After the first load lands, kick off classification if needed
  useEffect(() => {
    if (data && data.unclassifiedCount > 0 && classifying === 0) {
      triggerClassification(data.unclassifiedCount);
    }
    // We deliberately don't include `classifying` in deps — it's only checked
    // to prevent a re-trigger loop. The useEffect re-runs whenever data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, triggerClassification]);

  // ─── Branches ───────────────────────────────────────────────────────────

  if (!childId) {
    return (
      <Card>
        <Header title="Vocabulary Map" />
        <Empty title="No child selected" subtitle="Pick a child to see their domain coverage." />
      </Card>
    );
  }

  if (loading && !data) {
    return (
      <Card>
        <Header title="Vocabulary Map" />
        <View style={styles.loadingBox}>
          <ActivityIndicator color={P.amberAccent} />
        </View>
      </Card>
    );
  }

  if (errored || !data) {
    return (
      <Card>
        <Header title="Vocabulary Map" />
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>Couldn't load the map just now.</Text>
          <TouchableOpacity onPress={load} style={styles.retryBtn}>
            <Text style={styles.retryBtnText}>Try again</Text>
          </TouchableOpacity>
        </View>
      </Card>
    );
  }

  const totalWords = data.totalClassified + data.unclassifiedCount + data.otherCount;
  const hasAnyData = data.byDomain.some((d) => d.wordCount > 0);

  if (totalWords === 0) {
    return (
      <Card>
        <Header title="Vocabulary Map" />
        <Empty
          title={childName ? `${childName}'s map is empty` : "No words yet"}
          subtitle="Once a few quests are done, the radar fills in across six sensory domains."
        />
      </Card>
    );
  }

  if (!hasAnyData && data.unclassifiedCount > 0) {
    // Words exist but nothing classified yet — first run, classification pending
    return (
      <Card>
        <Header title="Vocabulary Map" />
        <View style={styles.firstClassifyBox}>
          <ActivityIndicator color={P.amberAccent} />
          <Text style={styles.firstClassifyTitle}>
            Building {childName ? `${childName}'s` : "your child's"} vocabulary map…
          </Text>
          <Text style={styles.firstClassifySub}>
            Sorting {data.unclassifiedCount} word{data.unclassifiedCount === 1 ? "" : "s"} into sensory domains. This usually takes a few seconds.
          </Text>
        </View>
      </Card>
    );
  }

  return (
    <Card>
      <Header title="Vocabulary Map" />
      <View style={styles.body}>
        <Radar data={data.byDomain} />
        <DomainList data={data.byDomain} />
        <Footnote
          totalClassified={data.totalClassified}
          unclassified={data.unclassifiedCount}
          otherCount={data.otherCount}
          classifyingNow={classifying > 0}
        />
      </View>
    </Card>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────

function Card({ children }: { children: React.ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

function Header({ title }: { title: string }) {
  return (
    <View style={styles.header}>
      <Text style={styles.headerTitle}>🧭  {title}</Text>
    </View>
  );
}

/** The hexagonal SVG radar itself. */
function Radar({ data }: { data: DomainStat[] }) {
  const SIZE   = 280;          // overall canvas
  const CX     = SIZE / 2;
  const CY     = SIZE / 2 + 4; // nudge down to give labels breathing room at top
  const RADIUS = 92;           // outer ring radius
  const N      = data.length;  // 6

  // Pre-compute vertex positions for each domain
  const geom = useMemo(() => {
    return data.map((stat, i) => {
      const angle  = (Math.PI * 2 * i) / N - Math.PI / 2; // start at top
      const value  = Math.max(0, Math.min(1, stat.avgMastery));
      const r      = RADIUS * value;
      const labelR = RADIUS + 22;
      return {
        domain:  stat.domain,
        angle,
        x:       CX + Math.cos(angle) * r,
        y:       CY + Math.sin(angle) * r,
        labelX:  CX + Math.cos(angle) * labelR,
        labelY:  CY + Math.sin(angle) * labelR,
        spokeX:  CX + Math.cos(angle) * RADIUS,
        spokeY:  CY + Math.sin(angle) * RADIUS,
      };
    });
  }, [data]);

  const polygonPoints = geom.map((g) => `${g.x},${g.y}`).join(" ");

  // 4 concentric guide rings at 25/50/75/100%
  const guideRings = [0.25, 0.5, 0.75, 1.0].map((pct) => {
    const r = RADIUS * pct;
    return data.map((_, i) => {
      const a = (Math.PI * 2 * i) / N - Math.PI / 2;
      return `${CX + Math.cos(a) * r},${CY + Math.sin(a) * r}`;
    }).join(" ");
  });

  return (
    <View style={styles.radarWrap}>
      <Svg width={SIZE} height={SIZE} accessibilityLabel="Vocabulary mastery radar">
        {/* Guide rings — outer is solid, inner are dashed */}
        <G>
          {guideRings.map((points, i) => (
            <Polygon
              key={`ring-${i}`}
              points={points}
              fill="none"
              stroke={P.warmBorder}
              strokeWidth={1}
              strokeDasharray={i < 3 ? "3,3" : undefined}
              strokeOpacity={i < 3 ? 0.6 : 1}
            />
          ))}
        </G>

        {/* Spokes */}
        <G>
          {geom.map((g, i) => (
            <Line
              key={`spoke-${i}`}
              x1={CX} y1={CY}
              x2={g.spokeX} y2={g.spokeY}
              stroke={P.warmBorder}
              strokeWidth={1}
              strokeOpacity={0.5}
            />
          ))}
        </G>

        {/* Data polygon — translucent amber fill */}
        <Polygon
          points={polygonPoints}
          fill={P.amberAccent}
          fillOpacity={0.22}
          stroke={P.amberAccent}
          strokeWidth={2}
        />

        {/* Vertex dots */}
        <G>
          {geom.map((g, i) => (
            <Circle
              key={`dot-${i}`}
              cx={g.x} cy={g.y} r={4}
              fill={P.amberAccent}
            />
          ))}
        </G>

        {/* Labels around the perimeter */}
        <G>
          {geom.map((g, i) => (
            <SvgText
              key={`label-${i}`}
              x={g.labelX}
              y={g.labelY}
              fontSize={11}
              fontWeight="600"
              fill={P.inkMid}
              textAnchor="middle"
              alignmentBaseline="middle"
            >
              {capitalise(g.domain)}
            </SvgText>
          ))}
        </G>
      </Svg>
    </View>
  );
}

/** Compact list under the radar — domain · word count · % bar. */
function DomainList({ data }: { data: DomainStat[] }) {
  return (
    <View style={styles.domainList}>
      {data.map((stat) => (
        <DomainRow key={stat.domain} stat={stat} />
      ))}
    </View>
  );
}

function DomainRow({ stat }: { stat: DomainStat }) {
  const pct = Math.round(stat.avgMastery * 100);
  return (
    <View style={styles.domainRow}>
      <Text style={styles.domainName}>{capitalise(stat.domain)}</Text>
      <View style={styles.barTrack}>
        <View
          style={[
            styles.barFill,
            { width: `${Math.max(2, pct)}%`, opacity: stat.wordCount === 0 ? 0.25 : 1 },
          ]}
        />
      </View>
      <Text style={styles.domainCount}>
        {stat.wordCount === 0 ? "—" : `${stat.wordCount} word${stat.wordCount === 1 ? "" : "s"}`}
      </Text>
    </View>
  );
}

function Footnote({
  totalClassified,
  unclassified,
  otherCount,
  classifyingNow,
}: {
  totalClassified: number;
  unclassified:    number;
  otherCount:      number;
  classifyingNow:  boolean;
}) {
  const parts: string[] = [];
  parts.push(`${totalClassified} word${totalClassified === 1 ? "" : "s"} mapped`);
  if (otherCount > 0)    parts.push(`${otherCount} other`);
  if (unclassified > 0 && !classifyingNow) parts.push(`${unclassified} pending`);

  return (
    <View style={styles.footnoteRow}>
      <Text style={styles.footnote}>{parts.join(" · ")}</Text>
      {classifyingNow ? (
        <View style={styles.classifyingPill}>
          <ActivityIndicator size="small" color={P.amberAccent} />
          <Text style={styles.classifyingText}>Classifying {unclassified}…</Text>
        </View>
      ) : null}
    </View>
  );
}

function Empty({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View style={styles.emptyBox}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptySubtitle}>{subtitle}</Text>
    </View>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Suppress unused warning for RADAR_DOMAINS re-export consumers
void RADAR_DOMAINS;
type _Domain = Domain;

// ─── Styles ───────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  card: {
    backgroundColor: P.parchment,
    borderRadius:    14,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    overflow:        "hidden",
    marginTop:       12,
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical:   12,
    borderBottomWidth: 1,
    borderBottomColor: P.warmBorder,
  },
  headerTitle: { fontSize: 15, fontWeight: "700", color: P.inkBrown },

  body: { paddingHorizontal: 16, paddingVertical: 14 },

  // Radar
  radarWrap: { alignItems: "center", justifyContent: "center", paddingVertical: 4 },

  // Domain list under the radar
  domainList: {
    marginTop: 12,
    backgroundColor: P.cream,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: P.warmBorder,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  domainRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 7,
    gap: 10,
  },
  domainName: {
    width: 70,
    fontSize: 12,
    fontWeight: "600",
    color: P.inkMid,
  },
  barTrack: {
    flex: 1,
    height: 6,
    backgroundColor: P.warmBorder,
    borderRadius: 3,
    overflow: "hidden",
  },
  barFill: {
    height: 6,
    backgroundColor: P.amberAccent,
    borderRadius: 3,
  },
  domainCount: {
    minWidth: 56,
    textAlign: "right",
    fontSize: 11,
    color: P.inkLight,
  },

  // Footnote
  footnoteRow: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 8,
  },
  footnote: { fontSize: 11, color: P.inkFaint, flex: 1 },
  classifyingPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: P.amberLight,
    borderWidth: 1,
    borderColor: P.amberBorder,
  },
  classifyingText: { fontSize: 11, fontWeight: "600", color: P.amberAccent },

  // First-time classification (no data yet)
  firstClassifyBox: {
    paddingVertical: 32,
    paddingHorizontal: 24,
    alignItems: "center",
    gap: 10,
  },
  firstClassifyTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: P.inkBrown,
    textAlign: "center",
  },
  firstClassifySub: {
    fontSize: 12,
    color: P.inkLight,
    textAlign: "center",
    maxWidth: 280,
    lineHeight: 17,
  },

  // States
  loadingBox: { paddingVertical: 40, alignItems: "center" },
  errorBox:   { paddingVertical: 24, paddingHorizontal: 16, alignItems: "center" },
  errorText:  { fontSize: 13, color: P.inkMid, marginBottom: 10 },
  retryBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: P.amberLight,
    borderWidth: 1,
    borderColor: P.amberBorder,
  },
  retryBtnText: { fontSize: 13, fontWeight: "600", color: P.amberAccent },

  emptyBox:      { paddingVertical: 28, paddingHorizontal: 18, alignItems: "center" },
  emptyTitle:    { fontSize: 14, fontWeight: "600", color: P.inkBrown, textAlign: "center" },
  emptySubtitle: {
    marginTop: 4,
    fontSize: 12,
    color: P.inkLight,
    textAlign: "center",
    maxWidth: 280,
    lineHeight: 17,
  },
});
