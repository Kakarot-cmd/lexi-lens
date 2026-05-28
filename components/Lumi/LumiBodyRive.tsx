/**
 * components/Lumi/LumiBodyRive.tsx — Rive-backed Lumi body.
 *
 * Same LumiBodyProps as LumiBodySvg. Plug-compatible swap.
 *
 * ─── Behaviour ──────────────────────────────────────────────────────────────
 *
 *   • Lazy-resolves the .riv asset via expo-asset (works on iOS + Android,
 *     including dev menu reloads — no native bundle gymnastics required).
 *   • Mounts <Rive> with a single state machine (LumiSM). Pushes prop changes
 *     into Rive inputs on every render.
 *   • Reads AccessibilityInfo.isReduceMotionEnabled() once on mount and on
 *     OS-level changes; writes it to the `reducedMotion` Rive input.
 *   • If anything in the load path fails (require throws, decode fails,
 *     native module missing) → renders <LumiBodySvg> with the same props.
 *     The app keeps working even if the .riv ships broken.
 *
 * ─── Why this is a separate file ────────────────────────────────────────────
 *
 *   Importing 'rive-react-native' at module scope would pull the native
 *   module into the JS bundle even when LUMI_RIVE_ENABLED is false. The
 *   dispatcher in LumiBody.tsx imports this file behind a static check so
 *   bundlers can tree-shake the Rive import out of the SVG-only path.
 *   (Metro doesn't tree-shake aggressively, but keeping the import here
 *   means Rive can be removed entirely by deleting one import line.)
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  StyleSheet,
  View,
} from 'react-native';
import { Asset } from 'expo-asset';

import {
  LUMI_MOOD_INDEX,
  LUMI_STATE_INDEX,
  LUMI_THEME_INDEX,
  RIVE_ARTBOARD_NAME,
  RIVE_INPUT,
  RIVE_STATE_MACHINE_NAME,
} from './lumiRiveConfig';

import { LumiBodySvg, type LumiBodyProps, type LumiMood } from './LumiBodySvg';
import type { LumiState } from './lumiTypes';

// ─── Asset require ────────────────────────────────────────────────────────────
//
// Metro statically analyses `require()` calls and only accepts STRING LITERALS.
// A direct literal require would also fail at bundle time if the .riv file
// doesn't exist yet (Phase 1, before art lands).
//
// We use `require.context()` — Metro's officially-supported pattern for
// "lazy directory lookup that tolerates missing files." Metro scans
// `assets/lumi/` at bundle time:
//
//   • If lumi.riv is there → ctx.keys() returns ['./lumi.riv']
//   • If only spec docs are there → ctx.keys() returns []
//   • Either way, bundle succeeds.
//
// This requires `unstable_allowRequireContext: true` in metro.config.js
// (already set in the repo's existing config — kept by our v6.8 update).
//
// The directory `assets/lumi/` itself MUST exist (Metro will fail to scan
// a missing dir). It does — the spec markdown files live there.
//
// To rename / move the asset: change the path arg below AND the matching
// constant in lumiRiveConfig.ts (LUMI_RIVE_ASSET_REL_PATH).
function requireRivAsset(): number | null {
  try {
    // The require.context signature is non-standard; Metro adds it at
    // bundle time. We cast through `any` because @types/node doesn't know.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (require as any).context('../../assets/lumi', false, /\.riv$/);
    const keys: string[] = ctx.keys();
    if (keys.length === 0) return null;
    return ctx(keys[0]);
  } catch {
    return null;
  }
}

// We keep RiveRef strongly typed (its surface is small and stable) so the
// methods we call on the ref are checked. The component itself is typed as
// `any` because:
//   1. It's dynamically require()d behind LUMI_RIVE_ENABLED — TS can't see
//      it at compile time anyway.
//   2. rive-react-native exports it as a ForwardRefExoticComponent whose
//      ref-forwarding is part of React's JSX machinery, not its props type.
//      Re-declaring a plain props type here would strip ref support and
//      cause TS2769 ("Property 'ref' does not exist on type
//      IntrinsicAttributes & ...").
//   3. The LumiBodyRive wrapper presents a fully-typed API to the rest of
//      the app, so `any` is contained to this file.
type RiveRef = {
  setInputState:  (sm: string, name: string, value: number | boolean) => void;
  fireState?:     (sm: string, name: string) => void;
  reset?:         () => void;
};

// `any` is intentional — see comment above.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RiveModule = {
  Rive:       any;
  Fit?:       Record<string, string>;
  Alignment?: Record<string, string>;
};

// ─── Extended props (LumiBodyProps is fixed; we accept `state` optionally) ───

export interface LumiBodyRiveProps extends LumiBodyProps {
  /**
   * Optional finer-grained state. When LumiMascot is upgraded to pass this
   * through, Rive can distinguish e.g. `scanning` from `looking-up` even
   * though both map to mood='curious'. If absent, the Rive state machine
   * falls back to the mood-driven branches.
   */
  state?: LumiState;
}

// ─── Implementation ──────────────────────────────────────────────────────────

export function LumiBodyRive(props: LumiBodyRiveProps): React.ReactElement {
  const {
    size = 64,
    theme = 'normal',
    mood = 'happy' as LumiMood,
    state,
    colorTick = 0,
  } = props;

  // 1) Lazy-load the Rive module + the .riv asset. Both can fail; either
  //    failure flips us to the SVG fallback.
  const [{ riveModule, assetUri, failed }, setLoadState] = useState<{
    riveModule: RiveModule | null;
    assetUri:   string | null;
    failed:     boolean;
  }>({ riveModule: null, assetUri: null, failed: false });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // Dynamic require of the native module is still allowed because
        // 'rive-react-native' is a node_modules package name — Metro
        // resolves package-name requires by string literal match here.
        //
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const rive = require('rive-react-native');

        // Asset module ref (a number produced by Metro's asset registry).
        // If the .riv file isn't in the repo yet, requireRivAsset()
        // returns null and we fall back to SVG.
        const rivModuleRef = requireRivAsset();
        if (rivModuleRef == null) {
          if (!cancelled) {
            setLoadState({ riveModule: null, assetUri: null, failed: true });
          }
          return;
        }

        const asset = Asset.fromModule(rivModuleRef);
        if (!asset.localUri) {
          await asset.downloadAsync();
        }
        const uri = asset.localUri ?? asset.uri;

        if (!cancelled) {
          setLoadState({
            riveModule: { Rive: rive.default ?? rive.Rive, Fit: rive.Fit, Alignment: rive.Alignment },
            assetUri:   uri,
            failed:     false,
          });
        }
      } catch (e) {
        // Module missing, asset missing, native crash — fall back silently.
        // We don't log to Sentry here because the SVG fallback IS the working
        // state. Logging would generate noise on every dev that hasn't yet
        // installed rive-react-native.
        if (!cancelled) {
          setLoadState({ riveModule: null, assetUri: null, failed: true });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // 2) Track reduced-motion preference. Default to "respect OS".
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then(v => {
      if (alive) setReducedMotion(v);
    });
    const sub = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      v => setReducedMotion(v),
    );
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  // 3) Resolve the prop values to Rive input numbers (memoised — Rive is
  //    a native bridge call per write, no point spamming when props are
  //    React-stable).
  const inputs = useMemo(() => {
    const themeIdx = LUMI_THEME_INDEX[theme] ?? 0;
    const moodIdx  = LUMI_MOOD_INDEX[mood as LumiMood] ?? 0;
    const stateIdx = state ? (LUMI_STATE_INDEX[state] ?? -1) : -1;
    return { themeIdx, moodIdx, stateIdx };
  }, [theme, mood, state]);

  // 4) Push inputs into Rive on every change.
  const riveRef = useRef<RiveRef | null>(null);

  useEffect(() => {
    const r = riveRef.current;
    if (!r) return;
    try {
      r.setInputState(RIVE_STATE_MACHINE_NAME, RIVE_INPUT.moodIndex,     inputs.moodIdx);
      r.setInputState(RIVE_STATE_MACHINE_NAME, RIVE_INPUT.themeIndex,    inputs.themeIdx);
      if (inputs.stateIdx >= 0) {
        r.setInputState(RIVE_STATE_MACHINE_NAME, RIVE_INPUT.stateIndex,  inputs.stateIdx);
      }
      r.setInputState(RIVE_STATE_MACHINE_NAME, RIVE_INPUT.colorTick,     colorTick);
      r.setInputState(RIVE_STATE_MACHINE_NAME, RIVE_INPUT.reducedMotion, reducedMotion);
    } catch {
      // A bad input name (animator/file out of sync with this contract)
      // shouldn't crash. The animation continues with whatever inputs DID
      // take. Surface during dev via Rive's own console warnings.
    }
  }, [inputs, colorTick, reducedMotion]);

  // 5) Render. If load failed OR module/asset missing, fall back to SVG.
  if (failed || !riveModule || !assetUri) {
    return <LumiBodySvg {...props} />;
  }

  const { Rive, Fit, Alignment } = riveModule;

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      <Rive
        url={assetUri}
        artboardName={RIVE_ARTBOARD_NAME}
        stateMachineName={RIVE_STATE_MACHINE_NAME}
        autoplay
        fit={Fit?.Contain ?? 'contain'}
        alignment={Alignment?.Center ?? 'center'}
        style={styles.rive}
        onPlay={() => {
          // First frame ready — push inputs immediately (the input-effect
          // above may have fired before the ref was wired).
          const r = riveRef.current;
          if (!r) return;
          try {
            r.setInputState(RIVE_STATE_MACHINE_NAME, RIVE_INPUT.moodIndex,     inputs.moodIdx);
            r.setInputState(RIVE_STATE_MACHINE_NAME, RIVE_INPUT.themeIndex,    inputs.themeIdx);
            if (inputs.stateIdx >= 0) {
              r.setInputState(RIVE_STATE_MACHINE_NAME, RIVE_INPUT.stateIndex,  inputs.stateIdx);
            }
            r.setInputState(RIVE_STATE_MACHINE_NAME, RIVE_INPUT.reducedMotion, reducedMotion);
          } catch { /* see effect above */ }
        }}
        onError={() => {
          // Decode error after mount — flip to SVG.
          setLoadState(prev => ({ ...prev, failed: true }));
        }}
        ref={riveRef}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
  rive: {
    width:  '100%',
    height: '100%',
  },
});
