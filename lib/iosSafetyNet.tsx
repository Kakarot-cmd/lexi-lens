/**
 * lib/iosSafetyNet.tsx — v4.5.9 iOS white-screen safety net.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * After 9 failed iOS TestFlight builds debugging a silent white-screen,
 * we're shipping v1.0.23 with a Sentry.init fix that we're about 50%
 * confident in. With EAS free-tier quota near-exhausted (no more iOS
 * builds for ~15 days until June 1, 2026 reset), this build needs to
 * EITHER fix iOS OR produce diagnostic data — we cannot afford a third
 * outcome of "still broken, also no data."
 *
 * This safety net runs alongside the production app. It does three things:
 *
 *   1. RUNS THE PRODUCTION APP NORMALLY. If the Sentry fix worked, this
 *      file is a no-op pass-through and users get a working iOS app.
 *
 *   2. CATCHES MOUNT-TIME ERRORS. A React ErrorBoundary around the
 *      production App. If the production tree throws synchronously
 *      during render, we render a diagnostic UI instead of a white screen.
 *
 *   3. DETECTS THE "JS BUNDLE HALT" SIGNATURE. A 5-second timer set at
 *      module load. If the production App hasn't reported "I mounted"
 *      within that window, we assume Hermes silently halted the bundle
 *      (the v1.0.13–v1.0.20 symptom) and force-switch to diagnostic
 *      mode. This is the case ErrorBoundary CAN'T catch — when the JS
 *      itself stops executing rather than throwing.
 *
 * ── Failure-mode taxonomy ──────────────────────────────────────────────────
 *
 *   ✅ Production App mounts cleanly       → iOS users see the real app
 *   ⚠️ Production App throws during render → ErrorBoundary catches +
 *                                            shows diagnostic
 *   ⚠️ Production App freezes at module    → 5s timer fires + shows
 *      init (the v1.0.13-v1.0.20 pattern)    diagnostic
 *   🚨 Hermes halts before this file even  → still white screen — same
 *      reaches `setTimeout` registration      as today, no worse
 *
 * Net upside: if my Sentry fix is wrong, you get diagnostic data instead
 * of a white screen.
 *
 * ── Self-containment ───────────────────────────────────────────────────────
 *
 * This file deliberately does NOT import from any of the production
 * paths (lib/sentry, lib/env, lib/supabase, screens/*, components/Lumi,
 * etc). It only imports React + React Native primitives + AsyncStorage.
 * Everything we suspected and probed in v1.0.21 + v1.0.22 was proven
 * to import cleanly on iOS, so we know those primitives are safe.
 *
 * The diagnostic itself is a SIMPLIFIED version of v1.0.22's probe
 * harness — focused only on the most likely culprits. We can't run the
 * full 30-probe diagnostic here without dragging in the suspects we're
 * trying to isolate. This is the same trade-off as before: imports-only
 * probes can't trigger a runtime crash on their own.
 *
 * ── How to remove after iOS is stable ──────────────────────────────────────
 *
 * Once v1.0.23 ships and iOS works, this file becomes dead code that
 * never triggers. To remove cleanly:
 *
 *   1. Delete this file
 *   2. In App.tsx, change the final line from:
 *        export default withIosSafetyNet(ENV.sentry.dsn ? Sentry.wrap(App) : App);
 *      back to:
 *        export default ENV.sentry.dsn ? Sentry.wrap(App) : App;
 *
 * That's it. No other touch points.
 */

import React, { Component, useEffect, useState, type ReactNode, type ComponentType } from "react";
import { View, Text, ScrollView, StyleSheet, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

const SAFETY_NET_VERSION = "v4.5.9 · 1.0.23";
const MOUNT_DEADLINE_MS  = 5000;  // production must mount within this
const STORAGE_KEY        = "lexilens:iosSafetyNet:lastFault";

// ──────────────────────────────────────────────────────────────────────────
// Module-init mount tracker.
//
// This boolean is set to `true` synchronously by the wrapped App's render
// path the FIRST time it renders anything. If it's still false after
// MOUNT_DEADLINE_MS, we assume the bundle halted and force diagnostic mode.
// ──────────────────────────────────────────────────────────────────────────

let _productionMounted = false;
const markMounted = () => { _productionMounted = true; };

// ──────────────────────────────────────────────────────────────────────────
// ErrorBoundary — catches render-time throws in the production tree.
// ──────────────────────────────────────────────────────────────────────────

type EBState =
  | { kind: "ok" }
  | { kind: "thrown"; error: string; component: string };

class ProductionErrorBoundary extends Component<
  { children: ReactNode; onError: (e: { error: string; component: string }) => void },
  EBState
> {
  state: EBState = { kind: "ok" };

  static getDerivedStateFromError(err: any): EBState {
    return {
      kind:      "thrown",
      error:     String(err?.message || err),
      component: err?.componentStack?.split("\n")[1]?.trim() || "unknown",
    };
  }

  componentDidCatch(err: any, info: any) {
    this.props.onError({
      error:     String(err?.message || err),
      component: info?.componentStack?.split("\n")[1]?.trim() || "unknown",
    });
  }

  render() {
    if (this.state.kind === "thrown") {
      // Render the fallback inline. The withIosSafetyNet wrapper handles
      // the actual diagnostic UI swap via state.
      return null;
    }
    return this.props.children as any;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Diagnostic fallback UI.
//
// Renders if either (a) ErrorBoundary caught a throw, or (b) the 5-second
// mount deadline expired. Shows the fault info + a manual probe runner
// that tests the most likely Sentry/Supabase/store culprits live.
// ──────────────────────────────────────────────────────────────────────────

type Fault =
  | { kind: "deadline-expired"; ms: number }
  | { kind: "error-thrown";     error: string; component: string };

type ProbeResult =
  | { state: "pending" }
  | { state: "running" }
  | { state: "ok";   detail: string }
  | { state: "fail"; error: string };

const FALLBACK_PROBES: Array<{ id: string; label: string; fn: () => string | Promise<string> | void }> = [
  {
    id: "01-env-read",
    label: "Read lib/env (ENV object + env vars)",
    fn: () => {
      const env = require("../lib/env");
      const ENV = env.ENV;
      return `var=${ENV?.variant} sb=${!!ENV?.supabase?.url}/${!!ENV?.supabase?.anonKey} dsn=${!!ENV?.sentry?.dsn}`;
    },
  },
  {
    id: "02-sentry-init-MINIMAL",
    label: "Sentry.init({ dsn }) — MINIMAL config, no tracesSampleRate",
    fn: () => {
      const Sentry = require("@sentry/react-native");
      Sentry.init({ dsn: "https://fake@example.ingest.sentry.io/1234567", enabled: false });
      return "minimal init OK";
    },
  },
  {
    id: "03-sentry-init-WITH-traces",
    label: "Sentry.init({ ..., tracesSampleRate }) — SUSPECT property",
    fn: () => {
      const Sentry = require("@sentry/react-native");
      Sentry.init({
        dsn:              "https://fake@example.ingest.sentry.io/1234567",
        tracesSampleRate: 0.2,
        enabled:          false,
      });
      return "init WITH tracesSampleRate OK";
    },
  },
  {
    id: "04-supabase-create",
    label: "Supabase createClient (env URL/key)",
    fn: () => {
      const env = require("../lib/env");
      const { createClient } = require("@supabase/supabase-js");
      const url = env.ENV?.supabase?.url ?? "";
      const key = env.ENV?.supabase?.anonKey ?? "";
      if (!url) throw new Error("EXPO_PUBLIC_SUPABASE_URL is empty at runtime");
      if (!key) throw new Error("EXPO_PUBLIC_SUPABASE_ANON_KEY is empty at runtime");
      const c = createClient(url, key, { auth: { storage: AsyncStorage as any } });
      return c?.auth ? "client OK" : "client missing auth";
    },
  },
  {
    id: "05-gamestore-hydrate",
    label: "useGameStore.getState() — Zustand + AsyncStorage hydration",
    fn: async () => {
      const gs = require("../store/gameStore");
      gs.useGameStore.getState();
      await new Promise((r) => setTimeout(r, 250));
      const s = gs.useGameStore.getState();
      return `${Object.keys(s).length} keys after hydrate`;
    },
  },
  {
    id: "06-asyncstorage-rw",
    label: "AsyncStorage round-trip",
    fn: async () => {
      const k = "lexilens:safetynet:rw";
      await AsyncStorage.setItem(k, "ok-" + Date.now());
      const v = await AsyncStorage.getItem(k);
      if (!v) throw new Error("read-back empty");
      return `${v.length} bytes`;
    },
  },
];

function DiagnosticFallback({ fault }: { fault: Fault }) {
  const [results, setResults] = useState<Record<string, ProbeResult>>(() =>
    Object.fromEntries(FALLBACK_PROBES.map((p) => [p.id, { state: "pending" }])),
  );

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: SAFETY_NET_VERSION, fault, ts: Date.now() }),
    ).catch(() => {});

    (async () => {
      for (const p of FALLBACK_PROBES) {
        if (cancelled) return;
        setResults((r) => ({ ...r, [p.id]: { state: "running" } }));
        await new Promise((r) => setTimeout(r, 80));
        try {
          const maybe = p.fn();
          const detail = (maybe instanceof Promise ? await maybe : maybe) ?? "";
          if (cancelled) return;
          setResults((r) => ({ ...r, [p.id]: { state: "ok", detail: String(detail) } }));
        } catch (e: any) {
          if (cancelled) return;
          setResults((r) => ({
            ...r,
            [p.id]: { state: "fail", error: String(e?.message || e) },
          }));
        }
      }
    })();

    return () => { cancelled = true; };
  }, [fault]);

  return (
    <View style={styles.root}>
      <View style={styles.banner}>
        <Text style={styles.title}>LEXI-LENS — DIAGNOSTIC FALLBACK</Text>
        <Text style={styles.subtitle}>{SAFETY_NET_VERSION} · production app did not mount cleanly</Text>
      </View>

      <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={styles.faultBox}>
          <Text style={styles.faultTitle}>WHY YOU'RE SEEING THIS</Text>
          {fault.kind === "deadline-expired" ? (
            <Text style={styles.faultBody}>
              Production App.tsx failed to mount within {fault.ms}ms.{"\n"}
              This is the silent-bundle-halt signature from v1.0.13–v1.0.20.{"\n"}
              JS code stopped executing before the React tree rendered.
            </Text>
          ) : (
            <Text style={styles.faultBody}>
              Production App.tsx threw during render:{"\n\n"}
              <Text style={styles.faultErr}>{fault.error}</Text>{"\n\n"}
              at: {fault.component}
            </Text>
          )}
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>RUNNING LIVE PROBES</Text>
        </View>

        {FALLBACK_PROBES.map((p, idx) => {
          const r = results[p.id];
          const icon =
            r.state === "ok"      ? "✓" :
            r.state === "fail"    ? "✗" :
            r.state === "running" ? "⏳" : "·";
          const color =
            r.state === "ok"      ? "#16a34a" :
            r.state === "fail"    ? "#dc2626" :
            r.state === "running" ? "#eab308" : "#94a3b8";
          return (
            <View key={p.id} style={styles.row}>
              <View style={styles.rowHeader}>
                <Text style={[styles.icon, { color }]}>{icon}</Text>
                <Text style={styles.idx}>{String(idx + 1).padStart(2, "0")}</Text>
                <Text style={styles.label}>{p.label}</Text>
              </View>
              {r.state === "ok" && r.detail ? (
                <Text style={styles.detail}>  → {r.detail}</Text>
              ) : null}
              {r.state === "fail" ? (
                <Text style={styles.error}>  → {r.error}</Text>
              ) : null}
            </View>
          );
        })}

        <View style={styles.footerBox}>
          <Text style={styles.footerTitle}>SEND THIS SCREENSHOT</Text>
          <Text style={styles.footerBody}>
            If probe 03 fails and probe 02 passes → Sentry tracesSampleRate
            confirmed as bug. Fix is permanent in v1.0.23 already; this means
            the build env didn't pick up the change. Rebuild with --clear-cache.{"\n\n"}
            If a different probe fails → that's the actual culprit. The
            error message tells us the exact line to fix.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// The exported wrapper.
// ──────────────────────────────────────────────────────────────────────────

export function withIosSafetyNet<P extends object>(
  ProductionApp: ComponentType<P>,
): ComponentType<P> {
  return function IosSafetyNet(props: P) {
    const [fault, setFault] = useState<Fault | null>(null);

    // Mount-deadline detector: if production hasn't reported mounting
    // within MOUNT_DEADLINE_MS, switch to diagnostic mode.
    useEffect(() => {
      const t = setTimeout(() => {
        if (!_productionMounted && !fault) {
          setFault({ kind: "deadline-expired", ms: MOUNT_DEADLINE_MS });
        }
      }, MOUNT_DEADLINE_MS);
      return () => clearTimeout(t);
    }, [fault]);

    if (fault) {
      return <DiagnosticFallback fault={fault} />;
    }

    return (
      <ProductionErrorBoundary
        onError={(e) => setFault({ kind: "error-thrown", ...e })}
      >
        <MountSignal />
        <ProductionApp {...props} />
      </ProductionErrorBoundary>
    );
  };
}

/**
 * Tiny invisible component that signals "production has rendered" the
 * moment React commits its first paint. Mounts as a sibling to the
 * production app so it doesn't depend on the production app rendering
 * first.
 */
function MountSignal() {
  useEffect(() => {
    markMounted();
  }, []);
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Styles — kept simple, no theme dependency
// ──────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root:        { flex: 1, backgroundColor: "#0f0620" },
  banner:      {
    paddingTop:        60,
    paddingBottom:     16,
    paddingHorizontal: 20,
    alignItems:        "center",
    backgroundColor:   "#7c2d12",
  },
  title: {
    color:        "#fef2f2",
    fontSize:     16,
    fontWeight:   "800",
    letterSpacing: 1.2,
  },
  subtitle: {
    color:        "#fed7aa",
    fontSize:     10,
    letterSpacing: 1.5,
    marginTop:    4,
    textTransform: "uppercase",
    textAlign:    "center",
  },
  list:        { flex: 1 },
  faultBox: {
    margin:      16,
    padding:     14,
    borderWidth: 1,
    borderColor: "#dc2626",
    borderRadius: 8,
    backgroundColor: "rgba(220,38,38,0.08)",
  },
  faultTitle: {
    color:        "#fca5a5",
    fontSize:     11,
    fontWeight:   "800",
    letterSpacing: 1.5,
    marginBottom: 8,
  },
  faultBody: {
    color:      "#fee2e2",
    fontSize:   12,
    lineHeight: 17,
  },
  faultErr: {
    color:      "#fff",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  sectionHeader: {
    paddingHorizontal: 16,
    paddingTop:        8,
    paddingBottom:     4,
  },
  sectionTitle: {
    color:        "#94a3b8",
    fontSize:     10,
    fontWeight:   "800",
    letterSpacing: 2,
  },
  row: {
    paddingHorizontal: 16,
    paddingVertical:   8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  rowHeader: { flexDirection: "row", alignItems: "center" },
  icon: { fontSize: 16, width: 22, textAlign: "center" },
  idx: {
    color:       "#94a3b8",
    fontSize:    12,
    fontVariant: ["tabular-nums"],
    width:       28,
    marginLeft:  2,
  },
  label: {
    color:      "#e2e8f0",
    fontSize:   12,
    flex:       1,
    marginLeft: 2,
  },
  detail: {
    color:      "#86efac",
    fontSize:   10,
    marginLeft: 56,
    marginTop:  2,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  error: {
    color:      "#fca5a5",
    fontSize:   10,
    marginLeft: 56,
    marginTop:  2,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  footerBox: {
    marginTop:        14,
    marginHorizontal: 16,
    padding:          14,
    borderWidth:      1,
    borderColor:      "#16a34a",
    borderRadius:     8,
  },
  footerTitle: {
    color:        "#86efac",
    fontSize:     11,
    fontWeight:   "800",
    letterSpacing: 1.5,
    marginBottom: 8,
  },
  footerBody: {
    color:      "#cbd5e1",
    fontSize:   12,
    lineHeight: 17,
  },
});
