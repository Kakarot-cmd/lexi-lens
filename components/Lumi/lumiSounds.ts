/**
 * components/Lumi/lumiSounds.ts
 *
 * Lumi sound + haptic dispatcher.
 *
 * Architecture:
 *   • Module-level singleton (no React state) — call from anywhere.
 *   • Pure functional API: initLumiSounds, setLumiSoundEnabled,
 *     setLumiHapticsEnabled, playLumiForState, playLumiGreeting.
 *   • Settings persist to AsyncStorage:
 *       lumi:soundEnabled    (default false)
 *       lumi:hapticsEnabled  (default true)
 *
 * Cross-platform:
 *   • expo-haptics is REQUIRED — already in package.json.
 *   • expo-audio is OPTIONAL — guarded by try/require so missing dep
 *     leaves haptics working and sound silent. Install it later when
 *     you're ready to ship audio.
 *   • Audio session is configured once via configureLumiAudioSession()
 *     so iOS silent-mode is respected by default.
 *
 * Asset bundling:
 *   • Asset require() calls live in lumiSoundAssets.ts — commented out
 *     by default, so Metro doesn't try to bundle missing MP3s. Add files
 *     to assets/sounds/lumi/ then uncomment the require lines.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import type { LumiState } from './lumiTypes';

// ─── Optional expo-audio ──────────────────────────────────────────────────────

// We require() expo-audio at module init. If the dep isn't installed, audio
// becomes a no-op; haptics still work fully.
let audio: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  audio = require('expo-audio');
} catch {
  audio = null;
}

// Asset map (separate file so Metro doesn't choke on missing MP3s).
let assets: Record<string, any> = {};
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  assets = require('./lumiSoundAssets').LUMI_SOUND_ASSETS ?? {};
} catch {
  assets = {};
}

// ─── Persisted settings ───────────────────────────────────────────────────────

const KEY_SOUND   = 'lumi:soundEnabled';
const KEY_HAPTICS = 'lumi:hapticsEnabled';

let _soundEnabled   = false;   // default OFF — parent opt-in
let _hapticsEnabled = true;    // default ON  — silent, no bystander cost
let _initialized    = false;
let _players: Record<string, any> = {};

// ─── Sound key namespace ──────────────────────────────────────────────────────

export type LumiSoundKey =
  | 'appear'
  | 'scan'
  | 'success'
  | 'fail'
  | 'sleep'
  | 'cheer'
  | 'greet';

// ─── State → sound + haptic mapping ───────────────────────────────────────────

const STATE_TO_SOUND: Partial<Record<LumiState, LumiSoundKey>> = {
  guide:           'appear',
  scanning:        'scan',
  success:         'success',
  // 'fail':       intentionally absent — no "wrong" sound for kids
  'boss-help':     'appear',
  'out-of-juice':  'sleep',
  cheering:        'cheer',
};

type HapticFn = () => Promise<void> | void;

const STATE_TO_HAPTIC: Partial<Record<LumiState, HapticFn>> = {
  guide:           () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  scanning:        () => Haptics.selectionAsync(),
  success:         () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  // 'fail':       intentionally absent — no haptic punishment
  'boss-help':     () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  'out-of-juice':  () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
  cheering:        () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Bootstrap. Call once at app startup (e.g. inside App.tsx useEffect).
 * Loads saved prefs, configures the audio session, and preloads players
 * if sound is enabled and expo-audio is available.
 */
export async function initLumiSounds(): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  // Load persisted prefs
  try {
    const [s, h] = await Promise.all([
      AsyncStorage.getItem(KEY_SOUND),
      AsyncStorage.getItem(KEY_HAPTICS),
    ]);
    if (s !== null) _soundEnabled   = JSON.parse(s);
    if (h !== null) _hapticsEnabled = JSON.parse(h);
  } catch {
    // fail-safe: defaults stand
  }

  // Configure audio session + preload players (only if sound is on)
  if (_soundEnabled) {
    await configureLumiAudioSession();
    preloadPlayers();
  }
}

/** Toggle sound on/off. Persists across launches. */
export async function setLumiSoundEnabled(enabled: boolean): Promise<void> {
  _soundEnabled = enabled;
  try { await AsyncStorage.setItem(KEY_SOUND, JSON.stringify(enabled)); } catch {}
  if (enabled && audio && Object.keys(_players).length === 0) {
    await configureLumiAudioSession();
    preloadPlayers();
  }
}

/** Toggle haptics on/off. Persists across launches. */
export async function setLumiHapticsEnabled(enabled: boolean): Promise<void> {
  _hapticsEnabled = enabled;
  try { await AsyncStorage.setItem(KEY_HAPTICS, JSON.stringify(enabled)); } catch {}
}

export function isLumiSoundEnabled():   boolean { return _soundEnabled; }
export function isLumiHapticsEnabled(): boolean { return _hapticsEnabled; }

/** Returns false if expo-audio isn't installed. UI can hide the sound toggle. */
export function isLumiAudioAvailable(): boolean { return audio !== null; }

/**
 * Fire the sound + haptic mapped to a Lumi state.
 * Safe to call on every state change — guarded against missing assets.
 */
export function playLumiForState(state: LumiState): void {
  if (_hapticsEnabled) {
    const fn = STATE_TO_HAPTIC[state];
    if (fn) {
      try { void fn(); } catch { /* no-op */ }
    }
  }
  if (_soundEnabled && audio) {
    const key = STATE_TO_SOUND[state];
    if (key) playSoundKey(key);
  }
}

/** Fired by the daily-greeting bootstrap (separate from state transitions). */
export function playLumiGreeting(): void {
  if (_hapticsEnabled) {
    try { void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
  }
  if (_soundEnabled && audio) {
    playSoundKey('greet');
  }
}

// ─── Internals ────────────────────────────────────────────────────────────────

async function configureLumiAudioSession(): Promise<void> {
  if (!audio?.setAudioModeAsync) return;
  try {
    await audio.setAudioModeAsync({
      // Respect iOS silent switch by default. Set true if you want sound
      // to play even when the user has the ringer muted.
      playsInSilentMode:        false,
      // Mix with other apps (e.g. background music) instead of ducking.
      interruptionMode:         'mixWithOthers',
      shouldPlayInBackground:   false,
      shouldRouteThroughEarpiece: false,
    });
  } catch {
    // Audio session config errors are non-fatal — sounds just won't play.
  }
}

function preloadPlayers(): void {
  if (!audio?.createAudioPlayer) return;
  for (const [key, asset] of Object.entries(assets)) {
    if (_players[key]) continue;
    if (asset == null) continue;
    try {
      const player = audio.createAudioPlayer(asset);
      // Make sure each cue is a one-shot
      if (typeof player?.setIsLoopingAsync === 'function') {
        try { player.setIsLoopingAsync(false); } catch {}
      }
      _players[key] = player;
    } catch {
      // skip this cue, keep going
    }
  }
}

function playSoundKey(key: LumiSoundKey): void {
  const player = _players[key];
  if (!player) return;
  try {
    if (typeof player.seekTo === 'function')         player.seekTo(0);
    else if (typeof player.setPositionAsync === 'function') player.setPositionAsync(0);

    if (typeof player.play === 'function')           player.play();
    else if (typeof player.playAsync === 'function') player.playAsync();
  } catch {
    // soft-fail
  }
}

/** Diagnostics for ParentDashboard. */
export function lumiAudioStatus(): {
  audioAvailable: boolean;
  soundEnabled:   boolean;
  hapticsEnabled: boolean;
  playersLoaded:  number;
  expectedCues:   number;
} {
  return {
    audioAvailable: audio !== null,
    soundEnabled:   _soundEnabled,
    hapticsEnabled: _hapticsEnabled,
    playersLoaded:  Object.keys(_players).length,
    expectedCues:   Object.keys(assets).length,
  };
}
