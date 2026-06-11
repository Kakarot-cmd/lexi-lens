/**
 * lib/audio/index.ts
 *
 * Barrel for the game-wide audio module (music bed + UI/feedback SFX).
 * Lumi's mascot VOICE lives separately in components/Lumi — import that for
 * voice/haptics. This module is everything else.
 */

export {
  initGameAudio,
  playSfx,
  playGameSfxForLumiState,
  startBgm,
  stopBgm,
  pauseBgmForBackground,
  resumeBgmFromForeground,
  setMusicEnabled,
  setSfxEnabled,
  isMusicEnabled,
  isSfxEnabled,
  isGameAudioAvailable,
  gameAudioStatus,
} from './gameAudio';

export type { BgmKey, SfxKey } from './gameAudio';

export { onScreenChange, resetScreenAudio } from './screenAudio';

export { speakWord, stopSpeaking, isSpeechAvailable, prewarmSpeech } from './speech';
export type { SpeakOptions } from './speech';
