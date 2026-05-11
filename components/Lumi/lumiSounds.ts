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

let _soundEnabled   = true;    // default ON — kids hear Lumi immediately; parent can long-press to mute or toggle in ParentDashboard
let _hapticsEnabled = true;    // default ON  — silent, no bystander cost
let _initialized    = false;
let _players: Record<string, any> = {};

// ─── Sound key namespace ──────────────────────────────────────────────────────
// v6.5 — extended to cover all rotating pool members. Singletons (appear,
// scan, sleep, cheer) keep their original keys. Pools use suffixed keys:
//   greet_01..05         (daily greeting rotation)
//   scan_dialogue_01..05 (voiced rotation during evaluation)
//   success / success_alt_01..02
//   fail   / fail_encourage_01..02
//   boss_hint_01..03

export type LumiSoundKey =
  | 'appear'
  | 'scan'
  | 'sleep'
  | 'cheer'
  // Greet pool
  | 'greet_01' | 'greet_02' | 'greet_03' | 'greet_04' | 'greet_05'
  // Scan-dialogue pool (fires after scan SFX during evaluation)
  | 'scan_dialogue_01' | 'scan_dialogue_02' | 'scan_dialogue_03'
  | 'scan_dialogue_04' | 'scan_dialogue_05'
  // Success pool
  | 'success' | 'success_alt_01' | 'success_alt_02'
  // Fail pool (encouraging only)
  | 'fail' | 'fail_encourage_01' | 'fail_encourage_02'
  // Boss-help pool (gentle hint after 3 failed attempts)
  | 'boss_hint_01' | 'boss_hint_02' | 'boss_hint_03';

// ─── Pool definitions ─────────────────────────────────────────────────────────
// Pool name → array of LumiSoundKeys. The rotation picker chooses one per call
// with no-repeat-of-last-played logic so kids never hear the same line twice
// in a row. Single-element pools just return their only key.

type PoolName =
  | 'greet'
  | 'scan_dialogue'
  | 'success'
  | 'fail'
  | 'boss_hint';

const SOUND_POOLS: Record<PoolName, LumiSoundKey[]> = {
  greet:         ['greet_01', 'greet_02', 'greet_03', 'greet_04', 'greet_05'],
  scan_dialogue: ['scan_dialogue_01', 'scan_dialogue_02', 'scan_dialogue_03',
                  'scan_dialogue_04', 'scan_dialogue_05'],
  success:       ['success', 'success_alt_01', 'success_alt_02'],
  fail:          ['fail', 'fail_encourage_01', 'fail_encourage_02'],
  boss_hint:     ['boss_hint_01', 'boss_hint_02', 'boss_hint_03'],
};

// Tracks the most recent pick per pool so we can avoid back-to-back repeats.
// Module-level, resets on app reload — that's fine, the kid won't notice.
const _lastPlayed: Partial<Record<PoolName, LumiSoundKey>> = {};

/**
 * Random no-repeat picker. For a pool of length N, returns one of the N keys
 * uniformly at random EXCLUDING the most-recently-played one. Kids hear
 * variety without ever hearing the same line twice in a row.
 */
function pickFromPool(pool: PoolName): LumiSoundKey | null {
  const keys = SOUND_POOLS[pool];
  if (!keys || keys.length === 0) return null;
  if (keys.length === 1) {
    _lastPlayed[pool] = keys[0];
    return keys[0];
  }
  const last = _lastPlayed[pool];
  const candidates = last ? keys.filter(k => k !== last) : keys;
  const choice = candidates[Math.floor(Math.random() * candidates.length)];
  _lastPlayed[pool] = choice;
  return choice;
}

// Delay between the ambient scan SFX and the voiced scan-dialogue. The SFX
// leads (sparkle/wind-chime), then Lumi talks. 400ms feels natural — long
// enough that the two cues don't muddy each other.
const SCAN_DIALOGUE_DELAY_MS = 400;

// ─── State → pool + lead-SFX mapping ──────────────────────────────────────────
// Each state maps to (a) an optional lead SFX (single-shot ambient cue that
// fires immediately) and (b) an optional pool (rotating voice clip that fires
// after the SFX with SCAN_DIALOGUE_DELAY_MS, or immediately if no lead).

const STATE_TO_LEAD_SFX: Partial<Record<LumiState, LumiSoundKey>> = {
  guide:           'appear',
  scanning:        'scan',         // wind-chime sparkle leads the voice
  // 'looking-up' shares scanning behavior — handled in playLumiForState
  'boss-help':     'appear',
  'out-of-juice':  'sleep',
  cheering:        'cheer',
};

const STATE_TO_POOL: Partial<Record<LumiState, PoolName>> = {
  scanning:        'scan_dialogue',
  'looking-up':    'scan_dialogue',
  success:         'success',
  fail:            'fail',           // encouraging variants, NOT punitive
  'boss-help':     'boss_hint',
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
 *
 * v6.5 — two-layer audio:
 *   1. Lead SFX (e.g. 'scan' wind-chime) fires immediately for ambient cue
 *   2. Voice from the rotating pool (e.g. 'scan_dialogue') fires after
 *      SCAN_DIALOGUE_DELAY_MS so the two cues don't muddy each other
 *   3. States with no lead SFX play the pool clip immediately
 *   4. States with neither (e.g. 'idle') silently no-op
 */
export function playLumiForState(state: LumiState): void {
  if (_hapticsEnabled) {
    const fn = STATE_TO_HAPTIC[state];
    if (fn) {
      try { void fn(); } catch { /* no-op */ }
    }
  }
  if (!_soundEnabled || !audio) return;

  const leadSfx = STATE_TO_LEAD_SFX[state];
  const pool    = STATE_TO_POOL[state];
  const poolKey = pool ? pickFromPool(pool) : null;

  if (leadSfx) playSoundKey(leadSfx);

  if (poolKey) {
    if (leadSfx) {
      // Delay voice so the SFX leads cleanly
      setTimeout(() => playSoundKey(poolKey), SCAN_DIALOGUE_DELAY_MS);
    } else {
      playSoundKey(poolKey);
    }
  }
}

/** Fired by the daily-greeting bootstrap (separate from state transitions). */
export function playLumiGreeting(): void {
  if (_hapticsEnabled) {
    try { void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
  }
  if (_soundEnabled && audio) {
    // v6.5 — rotates through 5 greeting clips. Last-played guard ensures
    // no kid hears the same greeting two mornings in a row.
    const key = pickFromPool('greet');
    if (key) playSoundKey(key);
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
