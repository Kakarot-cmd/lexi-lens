/**
 * components/Lumi/lumiSounds.ts — v6.7
 *
 * Sound + haptic dispatcher for the Lumi mascot.
 *
 * v6.7 CHANGES (iOS audio fix + dev diagnostics)
 * ─────────────────────────────────────────────────────────────────────────────
 *  1. iOS audio session now uses `playsInSilentMode: true`.
 *     Previously `false`, which respected the iOS hardware silent switch and
 *     left Lumi completely mute on any iPhone with the silent toggle flipped.
 *     For a kids' RPG where Lumi's voice IS the engagement loop, silent-switch
 *     respect is the wrong default (matches Duolingo / Khan Academy Kids /
 *     Roblox behavior). Parents who want quiet can use the in-app sound toggle
 *     (ParentDashboard) or device volume to mute, both of which still work.
 *
 *  2. Dev-only `[lumi]` diagnostic logs in init, audio-session config,
 *     player preload, and play paths. Gated on __DEV__ so prod builds are
 *     unaffected (zero log calls). Lets us trace silent-failure modes from
 *     the Metro terminal without rebuilding.
 *
 * v6.6 CHANGES (sequencing, preserved)
 * ─────────────────────────────────────────────────────────────────────────────
 *  - SFX→Voice sequential (measured duration + 60ms gap, not fixed 400ms)
 *  - Voice picker emits spoken text to subscribers
 *  - Pending voice cancelled on rapid state changes
 *
 * BACK-COMPAT
 * ─────────────────────────────────────────────────────────────────────────────
 *   Public API surface is unchanged. `playLumiForState(state)` still works
 *   from existing call sites; `subscribeLumiText` is additive.
 *   `LumiSoundKey` types unchanged.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import type { LumiState } from './lumiTypes';
import { LUMI_SOUND_ASSETS } from './lumiSoundAssets';
import { getVoiceText } from './lumiVoiceManifest';

// expo-audio is optional — module degrades cleanly if absent.
// (Same pattern as v6.5 — don't change the resolution path.)
let audio: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  audio = require('expo-audio');
} catch {
  audio = null;
}

// ─── Dev logger (no-op in prod) ───────────────────────────────────────────────
// __DEV__ is replaced with `true` by Metro in dev, `false` in prod. The
// dead-code elimination at minify strips these calls entirely from the
// release bundle.
const dlog = (...args: unknown[]): void => {
  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.log('[lumi]', ...args);
  }
};
const dwarn = (...args: unknown[]): void => {
  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.warn('[lumi]', ...args);
  }
};

// ─── Keys ─────────────────────────────────────────────────────────────────────

export type LumiSoundKey =
  // Single-shot SFX
  | 'appear'
  | 'scan'
  | 'sleep'
  | 'cheer'
  // Greet pool
  | 'greet_01' | 'greet_02' | 'greet_03' | 'greet_04' | 'greet_05'
  // Scan-dialogue pool
  | 'scan_dialogue_01' | 'scan_dialogue_02' | 'scan_dialogue_03'
  | 'scan_dialogue_04' | 'scan_dialogue_05'
  // Success pool
  | 'success' | 'success_alt_01' | 'success_alt_02'
  // Fail pool
  | 'fail' | 'fail_encourage_01' | 'fail_encourage_02'
  // Boss-hint pool
  | 'boss_hint_01' | 'boss_hint_02' | 'boss_hint_03';

type PoolName = 'greet' | 'scan_dialogue' | 'success' | 'fail' | 'boss_hint';

const SOUND_POOLS: Record<PoolName, LumiSoundKey[]> = {
  greet:         ['greet_01', 'greet_02', 'greet_03', 'greet_04', 'greet_05'],
  scan_dialogue: ['scan_dialogue_01', 'scan_dialogue_02', 'scan_dialogue_03', 'scan_dialogue_04', 'scan_dialogue_05'],
  success:       ['success', 'success_alt_01', 'success_alt_02'],
  fail:          ['fail', 'fail_encourage_01', 'fail_encourage_02'],
  boss_hint:     ['boss_hint_01', 'boss_hint_02', 'boss_hint_03'],
};

// ─── Persistence keys ─────────────────────────────────────────────────────────

const KEY_SOUND   = 'lexilens.lumi.soundEnabled';
const KEY_HAPTICS = 'lexilens.lumi.hapticsEnabled';

// ─── Module state ─────────────────────────────────────────────────────────────

let _initialized   = false;
let _soundEnabled  = true;   // default ON (v6.5 flipped this from OFF)
let _hapticsEnabled = true;

const _players: Partial<Record<LumiSoundKey, any>> = {};
/** Measured duration in ms for each preloaded clip. 0 if unknown. */
const _durationsMs: Partial<Record<LumiSoundKey, number>> = {};

const assets = LUMI_SOUND_ASSETS;

// Last-played per pool — used for random-no-repeat picks.
const _lastPlayed: Partial<Record<PoolName, LumiSoundKey>> = {};

// Pending voice timer + sequence token. Token bumps on every dispatch so a
// late-firing timer from a previous state knows to no-op.
let _pendingVoiceTimer: ReturnType<typeof setTimeout> | null = null;
let _sequenceToken = 0;

// Text-listener registry. LumiMascot.subscribe → bubble re-renders.
type TextListener = (text: string | null) => void;
const _textListeners: Set<TextListener> = new Set();

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

/**
 * Look up a preloaded clip's duration. Returns the measured value, or a
 * conservative default if the player never reported one (older API, or
 * preload failed silently).
 */
function getClipDurationMs(key: LumiSoundKey, fallback: number): number {
  const d = _durationsMs[key];
  if (typeof d === 'number' && d > 0) return d;
  return fallback;
}

/**
 * Notify subscribers (LumiMascot) what Lumi is *currently* saying out loud.
 * Pass null to clear the bubble (e.g. on cancel / silence).
 */
function emitText(text: string | null): void {
  for (const fn of _textListeners) {
    try { fn(text); } catch { /* no-op */ }
  }
}

/** Cancel any pending voice timer and stop any running voice clip. */
function cancelPendingVoice(): void {
  if (_pendingVoiceTimer) {
    clearTimeout(_pendingVoiceTimer);
    _pendingVoiceTimer = null;
  }
}

// ─── State → pool + lead-SFX mapping ──────────────────────────────────────────

const STATE_TO_LEAD_SFX: Partial<Record<LumiState, LumiSoundKey>> = {
  guide:           'appear',
  scanning:        'scan',
  // 'looking-up' shares scanning behavior — handled in playLumiForState
  'boss-help':     'appear',
  'out-of-juice':  'sleep',
  cheering:        'cheer',
};

const STATE_TO_POOL: Partial<Record<LumiState, PoolName>> = {
  scanning:        'scan_dialogue',
  'looking-up':    'scan_dialogue',
  success:         'success',
  fail:            'fail',
  'boss-help':     'boss_hint',
};

// Gap between SFX end and voice start — gives the SFX tail a moment to
// breathe before Lumi starts talking. Too short = abrupt. Too long = dead air.
const SFX_VOICE_GAP_MS = 60;

// v6.8 — scanning state uses a fixed delay from CHIME START instead of
// SFX-duration + gap. The reason: the scan chime fades out over its tail,
// so the perceived end of the chime is well before its file duration ends.
// Stacking voice at file-end+60ms felt cramped on top of the trailing
// shimmer.
//
// 2500ms = chime peaks at ~600ms, fades through ~1.5s, then a beat of
// silence before voice. Tuned by ear on Android XR. If user reports
// "still feels too soon", push to 3000. If "too long, feels broken",
// drop to 2000. The current Gemini-default evaluate latency is ~3s, so
// going beyond 3500 risks voice firing AFTER the verdict card lands —
// which would feel like a bug, not a gentler beat.
const SCAN_VOICE_DELAY_FROM_CHIME_START_MS = 2500;

// Conservative fallback when player.duration is unknown (older API, etc).
// Slightly longer than the spec'd ~800ms SFX so we never overlap by accident.
const SCAN_SFX_FALLBACK_MS   = 950;
const APPEAR_SFX_FALLBACK_MS = 320;
const SLEEP_SFX_FALLBACK_MS  = 700;
const CHEER_SFX_FALLBACK_MS  = 900;

function fallbackForSfx(key: LumiSoundKey | undefined): number {
  switch (key) {
    case 'scan':   return SCAN_SFX_FALLBACK_MS;
    case 'appear': return APPEAR_SFX_FALLBACK_MS;
    case 'sleep':  return SLEEP_SFX_FALLBACK_MS;
    case 'cheer':  return CHEER_SFX_FALLBACK_MS;
    default:       return 600;
  }
}

type HapticFn = () => Promise<void> | void;

const STATE_TO_HAPTIC: Partial<Record<LumiState, HapticFn>> = {
  guide:           () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  scanning:        () => Haptics.selectionAsync(),
  success:         () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  'boss-help':     () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  'out-of-juice':  () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
  cheering:        () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
};

// ─── Public API ───────────────────────────────────────────────────────────────

/** Bootstrap. Call once at app startup (App.tsx useEffect). */
export async function initLumiSounds(): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  dlog('initLumiSounds: start, audio module =', audio ? 'available' : 'NULL (expo-audio missing)');

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

  dlog('initLumiSounds: persisted prefs loaded, soundEnabled =', _soundEnabled, 'hapticsEnabled =', _hapticsEnabled);

  if (_soundEnabled) {
    await configureLumiAudioSession();
    preloadPlayers();
    dlog('initLumiSounds: done. Players loaded =', Object.keys(_players).length, '/ expected =', Object.keys(assets).length);
  } else {
    dlog('initLumiSounds: sound disabled by prefs — skipping audio session config and preload');
  }
}

export async function setLumiSoundEnabled(on: boolean): Promise<void> {
  _soundEnabled = on;
  try { await AsyncStorage.setItem(KEY_SOUND, JSON.stringify(on)); } catch {}
  if (on && Object.keys(_players).length === 0) {
    await configureLumiAudioSession();
    preloadPlayers();
  }
}
export async function setLumiHapticsEnabled(on: boolean): Promise<void> {
  _hapticsEnabled = on;
  try { await AsyncStorage.setItem(KEY_HAPTICS, JSON.stringify(on)); } catch {}
}
export function isLumiSoundEnabled():   boolean { return _soundEnabled; }
export function isLumiHapticsEnabled(): boolean { return _hapticsEnabled; }
export function isLumiAudioAvailable(): boolean { return audio !== null; }

/**
 * Subscribe to "what Lumi is currently speaking" events.
 * LumiMascot uses this to keep the speech bubble in sync with the voice clip
 * actually playing through expo-audio.
 *
 * Returns an unsubscribe function (call it on component unmount).
 */
export function subscribeLumiText(listener: TextListener): () => void {
  _textListeners.add(listener);
  return () => { _textListeners.delete(listener); };
}

/**
 * Fire the sound + haptic mapped to a Lumi state.
 *
 * v6.6 sequencing:
 *   1. Haptic fires immediately (silent — never opt-in gated)
 *   2. Lead SFX (if any) plays immediately
 *   3. Voice clip (if any) is scheduled at SFX_DURATION + gap, NOT at a
 *      fixed 400ms
 *   4. When the voice clip plays, the matching phrase from lumiVoiceManifest
 *      is emitted to subscribers (bubble syncs)
 *   5. Any prior pending voice is cancelled so rapid state changes don't
 *      stack
 */
export function playLumiForState(state: LumiState): void {
  // Bump token — late-arriving timers from prior calls will no-op.
  _sequenceToken += 1;
  const myToken = _sequenceToken;

  // Cancel any voice still pending from a previous call.
  cancelPendingVoice();

  // Haptics ALWAYS try (they're not opt-in gated)
  if (_hapticsEnabled) {
    const fn = STATE_TO_HAPTIC[state];
    if (fn) { try { void fn(); } catch { /* no-op */ } }
  }

  if (!_soundEnabled || !audio) {
    // Sound off → also clear any stale bubble text
    emitText(null);
    return;
  }

  const leadSfx = STATE_TO_LEAD_SFX[state];
  const pool    = STATE_TO_POOL[state];
  const poolKey = pool ? pickFromPool(pool) : null;

  if (leadSfx) playSoundKey(leadSfx);

  if (!poolKey) return;

  // Resolve text NOW (before async wait) so we can emit it in sync with audio.
  const text = getVoiceText(poolKey);

  const fireVoice = () => {
    // Was this dispatch superseded mid-wait? If so, do nothing.
    if (myToken !== _sequenceToken) return;
    playSoundKey(poolKey);
    if (text != null) emitText(text);
    _pendingVoiceTimer = null;
  };

  if (leadSfx) {
    // v6.8 — for the scan chime specifically, voice fires at a fixed offset
    // from chime START (not chime END + gap). The chime fades over its tail
    // and stacking the voice right at file-end felt cramped. Other SFX
    // (appear, sleep, cheer) still use the original duration-aware path.
    const waitMs =
      leadSfx === 'scan'
        ? SCAN_VOICE_DELAY_FROM_CHIME_START_MS
        : getClipDurationMs(leadSfx, fallbackForSfx(leadSfx)) + SFX_VOICE_GAP_MS;
    _pendingVoiceTimer = setTimeout(fireVoice, waitMs);
  } else {
    // No lead SFX → voice plays immediately
    fireVoice();
  }
}

/** Special-case dispatcher for the once-a-day greeting. */
export function playLumiGreeting(): void {
  if (_hapticsEnabled) {
    try { void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
  }
  if (_soundEnabled && audio) {
    const key = pickFromPool('greet');
    if (key) {
      playSoundKey(key);
      const text = getVoiceText(key);
      if (text != null) emitText(text);
    }
  }
}

// ─── Internals ────────────────────────────────────────────────────────────────

async function configureLumiAudioSession(): Promise<void> {
  if (!audio?.setAudioModeAsync) {
    dwarn('configureLumiAudioSession: setAudioModeAsync not exported by expo-audio — skipping');
    return;
  }
  try {
    await audio.setAudioModeAsync({
      // v6.7: override iOS silent switch. Lumi is the engagement loop;
      // a kid (or parent) using the in-app mute is the right control surface,
      // not the hardware toggle. Matches Duolingo / Khan Academy Kids / Roblox.
      playsInSilentMode:           true,
      interruptionMode:            'mixWithOthers',
      shouldPlayInBackground:      false,
      shouldRouteThroughEarpiece:  false,
    });
    dlog('configureLumiAudioSession: setAudioModeAsync OK (playsInSilentMode: true)');
  } catch (err) {
    dwarn('configureLumiAudioSession: setAudioModeAsync threw —', err);
    // Non-fatal
  }
}

function preloadPlayers(): void {
  if (!audio?.createAudioPlayer) {
    dwarn('preloadPlayers: createAudioPlayer not exported by expo-audio — skipping');
    return;
  }
  let loaded = 0;
  let skipped = 0;
  for (const [key, asset] of Object.entries(assets)) {
    if (_players[key as LumiSoundKey]) continue;
    if (asset == null) { skipped += 1; continue; }
    try {
      const player = audio.createAudioPlayer(asset);
      // Make sure each cue is a one-shot
      if (typeof player?.setIsLoopingAsync === 'function') {
        try { player.setIsLoopingAsync(false); } catch {}
      }
      _players[key as LumiSoundKey] = player;

      // Capture duration as soon as it's available. expo-audio reports it on
      // `player.duration` (seconds, sometimes via status update). We try
      // multiple paths and fall back to silent if none work.
      tryCaptureDuration(key as LumiSoundKey, player);
      loaded += 1;
    } catch (err) {
      dwarn('preloadPlayers: failed to create player for', key, '—', err);
      // skip this cue, keep going
    }
  }
  dlog('preloadPlayers: loaded =', loaded, 'skipped (null asset) =', skipped);
}

/**
 * Capture clip duration into _durationsMs. expo-audio exposes `duration` on
 * the player (in seconds, becomes valid once asset metadata loads). On older
 * expo-av (createSound), duration comes via `getStatusAsync().durationMillis`.
 * Either path is fine — we tolerate either, or none (fallback constants).
 */
function tryCaptureDuration(key: LumiSoundKey, player: any): void {
  // Polling: expo-audio populates player.duration shortly after creation.
  // Two checks at 250ms and 1000ms cover the common load times without
  // requiring an event subscription that may not fire on iOS bridgeless.
  const captureNow = () => {
    try {
      // expo-audio (new): seconds → ms
      if (typeof player?.duration === 'number' && player.duration > 0) {
        _durationsMs[key] = Math.round(player.duration * 1000);
        return true;
      }
      // expo-av (old): getStatusAsync → durationMillis
      if (typeof player?.getStatusAsync === 'function') {
        // Don't await — fire and forget; we'll poll again
        player.getStatusAsync().then((st: any) => {
          if (st?.durationMillis > 0) _durationsMs[key] = st.durationMillis;
        }).catch(() => { /* ignore */ });
      }
    } catch { /* ignore */ }
    return false;
  };

  if (!captureNow()) {
    setTimeout(captureNow, 250);
    setTimeout(captureNow, 1000);
  }
}

function playSoundKey(key: LumiSoundKey): void {
  const player = _players[key];
  if (!player) {
    dwarn('playSoundKey: no player for', key, '— preload may have failed');
    return;
  }
  try {
    if (typeof player.seekTo === 'function')                 player.seekTo(0);
    else if (typeof player.setPositionAsync === 'function')  player.setPositionAsync(0);

    if (typeof player.play === 'function') {
      player.play();
      dlog('playSoundKey:', key, '→ play() called');
    } else if (typeof player.playAsync === 'function') {
      player.playAsync();
      dlog('playSoundKey:', key, '→ playAsync() called');
    } else {
      dwarn('playSoundKey:', key, '— neither play() nor playAsync() available on player');
    }
  } catch (err) {
    dwarn('playSoundKey:', key, '— threw —', err);
    // soft-fail
  }
}

/** Diagnostics for ParentDashboard. */
export function lumiAudioStatus(): {
  audioAvailable: boolean;
  soundEnabled:   boolean;
  hapticsEnabled: boolean;
  playersLoaded:  number;
  durationsKnown: number;
  expectedCues:   number;
} {
  return {
    audioAvailable: audio !== null,
    soundEnabled:   _soundEnabled,
    hapticsEnabled: _hapticsEnabled,
    playersLoaded:  Object.keys(_players).length,
    durationsKnown: Object.keys(_durationsMs).length,
    expectedCues:   Object.keys(assets).length,
  };
}