/**
 * components/Lumi/LumiBody.tsx — dispatcher.
 *
 * Routes between the Rive-backed body and the original procedural SVG body
 * based on `LUMI_RIVE_ENABLED` in lumiRiveConfig.ts.
 *
 * Public API:
 *   • `LumiBody`        — the dispatcher component (drop-in replacement for
 *                          the old single-file LumiBody)
 *   • `LumiMood`        — re-exported from LumiBodySvg
 *   • `LumiBodyProps`   — re-exported from LumiBodySvg
 *
 * Existing imports anywhere in the app keep working without changes:
 *   import { LumiBody, type LumiMood } from './LumiBody';
 *
 * Optional extended import for screens / orchestrator that want to pass
 * full `state` through to Rive:
 *   import { LumiBody, type LumiBodyProps } from './LumiBody';
 *   <LumiBody mood="curious" state="scanning" ... />
 *
 * The `state` prop is forwarded to Rive when the Rive backend is active;
 * the SVG backend ignores unknown props (so passing it is safe either way).
 */

import React from 'react';

import { LumiBodySvg, type LumiBodyProps, type LumiMood } from './LumiBodySvg';
import { LUMI_RIVE_ENABLED } from './lumiRiveConfig';
import type { LumiState } from './lumiTypes';

// Optional richer prop. Marked optional so the existing LumiMascot call site
// keeps compiling — it can be added in a separate small patch (see
// docs/LUMI_RIVE_INTEGRATION_RUNBOOK.md → "Step 8 — pass state through").
export interface LumiBodyDispatchedProps extends LumiBodyProps {
  state?: LumiState;
}

// Lazy-imported Rive body — only loaded when the flag is on. Keeps the
// 'rive-react-native' import out of the SVG-only critical path so a missing
// native module (during early integration) doesn't break the SVG fallback.
let _LumiBodyRive: React.ComponentType<LumiBodyDispatchedProps> | null = null;
if (LUMI_RIVE_ENABLED) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  _LumiBodyRive = require('./LumiBodyRive').LumiBodyRive;
}

export function LumiBody(props: LumiBodyDispatchedProps): React.ReactElement {
  if (LUMI_RIVE_ENABLED && _LumiBodyRive) {
    const Rive = _LumiBodyRive;
    return <Rive {...props} />;
  }
  return <LumiBodySvg {...props} />;
}

// Re-exports so existing imports of LumiMood / LumiBodyProps from './LumiBody'
// continue to resolve. Don't remove these.
export type { LumiMood, LumiBodyProps };
