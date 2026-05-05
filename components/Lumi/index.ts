/**
 * components/Lumi/index.ts
 *
 * Barrel export for the Lumi mascot module.
 *
 * Usage in screens (high-level — recommended):
 *   import { LumiHUD } from '@/components/Lumi';
 *   <LumiHUD screen="scan" evaluationStatus={status} hardMode={isHardMode} />
 *
 * Usage with full control (low-level):
 *   import { LumiMascot } from '@/components/Lumi';
 *   <LumiMascot state="scanning" hardMode />
 *
 * App.tsx bootstrap:
 *   import { initLumiSounds } from '@/components/Lumi';
 *   useEffect(() => { initLumiSounds(); }, []);
 */

// ─── Components ───────────────────────────────────────────────────────────────

export { LumiHUD }          from './LumiHUD';
export { LumiMascot }       from './LumiMascot';
export { LumiBody }         from './LumiBody';
export { LumiTrail }        from './LumiTrail';
export { LumiSpeechBubble } from './LumiSpeechBubble';

// ─── Quote system ─────────────────────────────────────────────────────────────

export {
  pickLumiQuote,
  LUMI_QUOTES,
} from './lumiQuotes';

// ─── Daily greeting ───────────────────────────────────────────────────────────

export {
  shouldGreetToday,
  markGreetedToday,
  resetGreeting,
} from './lumiGreeting';

// ─── Sound + haptic system ────────────────────────────────────────────────────

export {
  initLumiSounds,
  setLumiSoundEnabled,
  setLumiHapticsEnabled,
  isLumiSoundEnabled,
  isLumiHapticsEnabled,
  isLumiAudioAvailable,
  playLumiForState,
  playLumiGreeting,
  lumiAudioStatus,
} from './lumiSounds';

export type { LumiSoundKey } from './lumiSounds';

// ─── Types ────────────────────────────────────────────────────────────────────

export type {
  LumiState,
  LumiPosition,
  LumiTheme,
  LumiThemeTokens,
  LumiMascotProps,
  LumiAnimationProfile,
  QuoteIntent,
} from './lumiTypes';

export type { LumiMood, LumiBodyProps } from './LumiBody';
export type { LumiTrailProps }          from './LumiTrail';
export type { LumiSpeechBubbleProps }   from './LumiSpeechBubble';
export type { LumiHUDProps, LumiScreen, LumiEvaluationStatus } from './LumiHUD';
