/**
 * App.tsx — DIAGNOSTIC BUILD v1.0.21 (INSTRUMENTED)
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * After three days and 9 iOS builds, we still don't know what's actually
 * killing iOS Release builds on TestFlight. Symptoms:
 *   • Android: works
 *   • iOS v1.0.11 (no Lumi, no expo-audio, no react-native-worklets): worked
 *   • iOS v1.0.13–v1.0.18: white screen, no .ips
 *   • iOS v1.0.19 (minimal App.tsx): worked (red screen rendered)
 *   • iOS v1.0.20 (lazy-loaded screens): white screen, no .ips
 *
 * Constraint: no Mac available, so we can't read iOS console.log or attach
 * Xcode. The diagnostic has to be visible IN-APP on the device itself.
 *
 * ── Strategy ────────────────────────────────────────────────────────────────
 *
 * This file replaces the production App.tsx with a probe harness. It mounts
 * a single screen showing a numbered checklist. Each item probes one suspect
 * — a require()/import we believe might be silently failing in iOS Hermes
 * Release mode. Probes run sequentially after first render so that:
 *
 *   1. The shell UI mounts before any risky import is touched (guaranteed
 *      visible feedback even if a later probe halts JS execution).
 *   2. Each probe wraps its require() in try/catch + setState — a failure
 *      shows as a visible row with the error message rather than silently
 *      crashing the bundle.
 *   3. Each probe writes its status to AsyncStorage BEFORE attempting
 *      anything risky, so the last-attempted probe is recoverable later
 *      even if the entire app dies.
 *
 * ── How to read the result on TestFlight ────────────────────────────────────
 *
 * IDEAL outcome: app boots, you see a checklist, every row turns green.
 *   That means the broken thing is NOT in this probe list — and the actual
 *   bug is in production App.tsx code we haven't tested yet (navigation
 *   mount, Sentry.wrap, store init, etc).
 *
 * MOST LIKELY outcome: probe list partially renders, then either:
 *   (a) ONE row shows ✗ with an error message → that's the culprit, fix it.
 *   (b) the screen freezes mid-probe (last visible item is ⏳ pending) →
 *       the NEXT probe is the culprit.
 *   (c) the screen never shows anything (white screen) → the failure is
 *       in the imports above this comment, OR in the React/AsyncStorage
 *       layer itself.
 *
 * WORST CASE: white screen, nothing on screen. Then we know the failure
 * is in React itself or one of these top-level imports. We comment them
 * out one at a time across the next build.
 *
 * ── What this file deliberately does NOT import at the top level ─────────────
 *
 *   ✗ Sentry (would call initSentry at module top — risky)
 *   ✗ lib/env (calls assertEnvOrWarn at module top)
 *   ✗ lib/supabase (creates client at module init)
 *   ✗ NavigationContainer (its own complex init)
 *   ✗ Any screen files
 *   ✗ Lumi anything
 *
 * The ONLY external imports are:
 *   • React + React Native primitives (proven to load — v1.0.19 worked)
 *   • @react-native-async-storage/async-storage (proven to load —
 *     supabase needed it in v1.0.19)
 *
 * Everything else is loaded via dynamic require() inside try/catch.
 *
 * ── Restore command after testing ───────────────────────────────────────────
 *
 *   git checkout main -- App.tsx
 *
 * Or revert just this file from the working tree using the commit hash
 * before this one.
 */

import { useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  StatusBar,
  Platform,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

const BUILD_TAG = "v1.0.21 instrumented · 2026-05-14";
const STORAGE_KEY = "lexilens:diagnostic:probe-log";

// Each probe describes one thing to test. Order matters — they run
// sequentially so a halt at probe N tells us N+1 is the suspect.
//
// `fn` MUST be synchronous and SHOULD throw on failure. Inside fn it's
// safe to call require() because we don't reach that code until the
// component is mounted and we've already painted the row.
type ProbeResult =
  | { state: "pending" }
  | { state: "running" }
  | { state: "ok"; detail?: string }
  | { state: "fail"; error: string };

type Probe = {
  id: string;
  label: string;
  fn: () => string | void;  // optional detail string on success
};

// Probes are ordered cheapest-and-most-fundamental first.
// If probe 4 is the bug, probes 1-3 will all be green.
const PROBES: Probe[] = [
  {
    id: "01-react-native",
    label: "React Native primitives (Platform, View, Text)",
    fn: () => `Platform.OS=${Platform.OS} v=${Platform.Version}`,
  },
  {
    id: "02-async-storage-write",
    label: "AsyncStorage write",
    fn: () => {
      // Verify the module exists and exposes the API we expect.
      const has = typeof AsyncStorage?.setItem === "function";
      if (!has) throw new Error("AsyncStorage.setItem is not a function");
      return "import OK";
    },
  },
  {
    id: "03-supabase-import",
    label: "@supabase/supabase-js import",
    fn: () => {
      const mod = require("@supabase/supabase-js");
      if (!mod?.createClient) throw new Error("createClient missing");
      return "createClient exported";
    },
  },
  {
    id: "04-url-polyfill",
    label: "react-native-url-polyfill/auto",
    fn: () => {
      // This polyfill mutates globals at require time. If it crashes,
      // every subsequent supabase call will be broken.
      require("react-native-url-polyfill/auto");
      return "polyfill loaded";
    },
  },
  {
    id: "05-zustand",
    label: "zustand store",
    fn: () => {
      const { create } = require("zustand");
      if (typeof create !== "function") throw new Error("create is not a function");
      const store = create((set: any) => ({ x: 0, inc: () => set({ x: 1 }) }));
      if (typeof store !== "function") throw new Error("store factory broken");
      return "store factory OK";
    },
  },
  {
    id: "06-sentry-import",
    label: "@sentry/react-native import (no init)",
    fn: () => {
      const Sentry = require("@sentry/react-native");
      if (!Sentry?.init) throw new Error("Sentry.init missing");
      return "module OK, init NOT called";
    },
  },
  {
    id: "07-reanimated-import",
    label: "react-native-reanimated import",
    fn: () => {
      const RA = require("react-native-reanimated");
      if (!RA?.default) throw new Error("Animated default missing");
      const missing = ["useSharedValue", "withTiming", "withRepeat"].filter(
        (k) => typeof RA[k] !== "function",
      );
      if (missing.length) throw new Error(`missing fns: ${missing.join(",")}`);
      return "Animated + hook fns exported";
    },
  },
  {
    id: "08-worklets-import",
    label: "react-native-worklets import (top suspect)",
    fn: () => {
      const W = require("react-native-worklets");
      // The worklets runtime auto-initializes on require. If iOS Hermes
      // Release silently halts, THIS is one of the most likely places.
      const hasFn =
        typeof W?.runOnJS === "function" ||
        typeof W?.scheduleOnRN === "function";
      if (!hasFn) throw new Error("scheduleOnRN/runOnJS missing");
      return "worklets module OK";
    },
  },
  {
    id: "09-worklets-core-import",
    label: "react-native-worklets-core import",
    fn: () => {
      const WC = require("react-native-worklets-core");
      if (!WC) throw new Error("module returned falsy");
      return "module OK";
    },
  },
  {
    id: "10-expo-audio-import",
    label: "expo-audio import",
    fn: () => {
      const A = require("expo-audio");
      if (!A) throw new Error("module returned falsy");
      return "module OK";
    },
  },
  {
    id: "11-vision-camera-import",
    label: "react-native-vision-camera import",
    fn: () => {
      const VC = require("react-native-vision-camera");
      if (!VC?.Camera) throw new Error("Camera component missing");
      return "Camera exported";
    },
  },
  {
    id: "12-navigation-container",
    label: "@react-navigation/native NavigationContainer",
    fn: () => {
      const NN = require("@react-navigation/native");
      if (!NN?.NavigationContainer) throw new Error("NavigationContainer missing");
      return "import OK";
    },
  },
  {
    id: "13-native-stack",
    label: "@react-navigation/native-stack",
    fn: () => {
      const NS = require("@react-navigation/native-stack");
      if (!NS?.createNativeStackNavigator) throw new Error("createNativeStackNavigator missing");
      return "import OK";
    },
  },
  {
    id: "14-safe-area",
    label: "react-native-safe-area-context",
    fn: () => {
      const SA = require("react-native-safe-area-context");
      if (!SA?.SafeAreaProvider) throw new Error("SafeAreaProvider missing");
      return "import OK";
    },
  },
  {
    id: "15-lumi-mascot",
    label: "components/Lumi/LumiMascot",
    fn: () => {
      const L = require("./components/Lumi/LumiMascot");
      if (!L?.LumiMascot) throw new Error("LumiMascot export missing");
      return "import OK";
    },
  },
  {
    id: "16-reanimated-runtime-call",
    label: "Reanimated runtime: useSharedValue() call (THE BIG ONE)",
    fn: () => {
      // This is what actually triggers Reanimated's worklet runtime
      // initialization. If the worklets bytecode is the bug, this is
      // where it surfaces. Calling useSharedValue outside a component
      // is technically unsupported — Reanimated may throw a "hook context"
      // error, which is benign and reported as such. The error we CARE
      // about is a native-side init failure.
      const RA = require("react-native-reanimated");
      try {
        const sv = RA.useSharedValue(0);
        return `useSharedValue returned ${typeof sv}`;
      } catch (e: any) {
        const msg = String(e?.message || e);
        if (
          msg.includes("Reanimated") &&
          (msg.includes("native") || msg.includes("worklets") || msg.includes("initialize"))
        ) {
          throw new Error(`Reanimated native init failed: ${msg}`);
        }
        return `(hook context error — benign): ${msg.slice(0, 80)}`;
      }
    },
  },
];

export default function App() {
  const [results, setResults] = useState<Record<string, ProbeResult>>(() =>
    Object.fromEntries(PROBES.map((p) => [p.id, { state: "pending" }])),
  );

  // After first paint, run probes sequentially. The setTimeout yields control
  // back to the renderer between probes so each row visibly updates.
  useEffect(() => {
    let cancelled = false;

    const log: Array<{ id: string; ok: boolean; detail: string }> = [];

    async function run() {
      for (const probe of PROBES) {
        if (cancelled) return;

        setResults((r) => ({ ...r, [probe.id]: { state: "running" } }));

        await AsyncStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            tag: BUILD_TAG,
            lastAttempted: probe.id,
            log,
            ts: Date.now(),
          }),
        ).catch(() => {});

        // Give React one frame to paint the "running" state.
        await new Promise((resolve) => setTimeout(resolve, 50));

        try {
          const detail = probe.fn() ?? "";
          if (cancelled) return;
          setResults((r) => ({ ...r, [probe.id]: { state: "ok", detail } }));
          log.push({ id: probe.id, ok: true, detail });
        } catch (e: any) {
          if (cancelled) return;
          const msg = String(e?.message || e);
          setResults((r) => ({
            ...r,
            [probe.id]: { state: "fail", error: msg },
          }));
          log.push({ id: probe.id, ok: false, detail: msg });
        }

        await AsyncStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            tag: BUILD_TAG,
            lastCompleted: probe.id,
            log,
            ts: Date.now(),
          }),
        ).catch(() => {});
      }
    }

    run().catch((e) => {
      console.warn("[probe] runner threw:", e);
    });

    return () => { cancelled = true; };
  }, []);

  const failed = Object.entries(results).find(([, r]) => r.state === "fail");
  const allDone = Object.values(results).every(
    (r) => r.state === "ok" || r.state === "fail",
  );

  const bannerColor = failed
    ? "#dc2626"           // red — found a culprit
    : allDone
      ? "#16a34a"         // green — all probes passed
      : "#0f0620";        // brand dark — still running

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={bannerColor} />
      <View style={[styles.banner, { backgroundColor: bannerColor }]}>
        <Text style={styles.title}>LEXI-LENS DIAGNOSTIC</Text>
        <Text style={styles.subtitle}>{BUILD_TAG}</Text>
        <Text style={styles.summary}>
          {failed
            ? `✗ FAILED at: ${failed[0]}`
            : allDone
              ? `✓ All ${PROBES.length} probes passed`
              : `Running ${Object.values(results).filter((r) => r.state !== "pending").length}/${PROBES.length}…`}
        </Text>
      </View>

      <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 40 }}>
        {PROBES.map((probe, idx) => {
          const r = results[probe.id];
          const icon =
            r.state === "ok"
              ? "✓"
              : r.state === "fail"
                ? "✗"
                : r.state === "running"
                  ? "⏳"
                  : "·";
          const color =
            r.state === "ok"
              ? "#16a34a"
              : r.state === "fail"
                ? "#dc2626"
                : r.state === "running"
                  ? "#eab308"
                  : "#94a3b8";
          return (
            <View key={probe.id} style={styles.row}>
              <View style={styles.rowHeader}>
                <Text style={[styles.icon, { color }]}>{icon}</Text>
                <Text style={styles.idx}>
                  {String(idx + 1).padStart(2, "0")}
                </Text>
                <Text style={styles.label} numberOfLines={2}>
                  {probe.label}
                </Text>
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

        {failed ? (
          <View style={styles.footerBox}>
            <Text style={styles.footerTitle}>NEXT STEP</Text>
            <Text style={styles.footerBody}>
              Send a screenshot of this screen. The row with ✗ is the
              culprit. The next build fixes that specific thing.
            </Text>
          </View>
        ) : null}

        {allDone && !failed ? (
          <View style={[styles.footerBox, { borderColor: "#16a34a" }]}>
            <Text style={[styles.footerTitle, { color: "#16a34a" }]}>
              ALL PROBES PASSED
            </Text>
            <Text style={styles.footerBody}>
              Every suspect module imports cleanly on this iOS device. The
              white screen in v1.0.20 is caused by something downstream of
              these imports — most likely the NavigationContainer mount,
              one of the screen components, or Sentry.wrap. The next build
              probes those.
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0f0620" },
  banner: {
    paddingTop: 60,
    paddingBottom: 16,
    paddingHorizontal: 20,
    alignItems: "center",
  },
  title: {
    color: "#fef2f2",
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: 1.5,
  },
  subtitle: {
    color: "#fecaca",
    fontSize: 11,
    letterSpacing: 2,
    marginTop: 2,
    textTransform: "uppercase",
  },
  summary: {
    color: "#fef2f2",
    fontSize: 14,
    fontWeight: "600",
    marginTop: 10,
  },
  list: { flex: 1 },
  row: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  rowHeader: { flexDirection: "row", alignItems: "center" },
  icon: { fontSize: 18, width: 24, textAlign: "center" },
  idx: {
    color: "#94a3b8",
    fontSize: 13,
    fontVariant: ["tabular-nums"],
    width: 32,
    marginLeft: 4,
  },
  label: {
    color: "#e2e8f0",
    fontSize: 14,
    flex: 1,
    marginLeft: 4,
  },
  detail: {
    color: "#86efac",
    fontSize: 11,
    marginLeft: 68,
    marginTop: 2,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  error: {
    color: "#fca5a5",
    fontSize: 11,
    marginLeft: 68,
    marginTop: 2,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  footerBox: {
    marginTop: 20,
    marginHorizontal: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: "#dc2626",
    borderRadius: 8,
  },
  footerTitle: {
    color: "#fca5a5",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1.5,
    marginBottom: 8,
  },
  footerBody: {
    color: "#cbd5e1",
    fontSize: 13,
    lineHeight: 18,
  },
});
