/**
 * components/Lumi/lumiSounds.ts — v6.10
 *
 * Sound + haptic dispatcher for the Lumi mascot.
 *
 * v6.10 CHANGES (iOS Release: preloaded players were dead on arrival)
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHAT v6.9 GOT RIGHT, AND WHAT IT MISSED
 *    v6.9 correctly fixed asset *localization*: every clip is downloaded to a
 *    file:// URI before use (see localizeAllSources below — kept). On-device
 *    diagnostics in a Release build confirmed it: localizedSources = 23/23,
 *    and a one-off RAW player (create → wait → play) was AUDIBLE.
 *
 *    But the MODULE path stayed silent, and the diagnostic showed the smoking
 *    gun: of the 23 players preloaded at startup, durationsKnown = 0 — i.e.
 *    NONE of them ever finished loading their audio, despite being created at
 *    app boot with ample time. A single fresh on-demand player loads in
 *    ~350ms; 23 created in a synchronous loop at cold start all stay unloaded.
 *
 *  ROOT CAUSE
 *    Batch-creating ~two dozen expo-audio players (each backing an iOS
 *    AVPlayerItem) in one tight startup loop leaves them in a non-loaded
 *    state — iOS does not ready that many concurrent items created that way,
 *    and they never recover. The RAW test worked precisely because it did the
 *    one thing the module didn't: create a SINGLE player on demand and play it.
 *
 *  FIX — replicate the proven RAW pattern: LAZY, ON-DEMAND PLAYERS
 *    • No players are created at startup anymore. Startup only LOCALIZES the
 *      sources (cheap; just materializes bundled assets to file:// URIs).
 *    • A player is created the first time a cue actually plays, from its
 *      localized URI — exactly the configuration proven audible on-device.
 *    • Players are retained and REUSED on subsequent plays (instant), capped at
 *      MAX_LIVE_PLAYERS via LRU eviction so we never hold a large pool of live
 *      AVPlayerItems again. Evicted players are release()'d.
 *    • Playback waits for `player.isLoaded` (the real readiness flag) before
 *      starting, so a freshly-created player is audible on its first play.
 *    • The audio session is re-asserted (debounced) right before play — the
 *      RAW path's setAudioModeAsync-then-play ordering — as cheap insurance
 *      against a session that went inactive while idle.
 *
 *  CROSS-PLATFORM
 *    Identical, safe on Android. Lazy creation from a localized file URI is the
 *    same path Android already handled; reducing the live-player count only
 *    helps. No native changes — JS-only, OTA-eligible.
 *
 * ── carried forward from v6.9 ─────────────────────────────────────────────────
 *  Asset localization via Asset.fromModule(...).downloadAsync() before playback
 *  (so iOS AVPlayer can infer the mp3 type from a real file:// extension).
 *
 * ── carried forward from v6.7 ─────────────────────────────────────────────────
 *  iOS audio session uses `playsInSilentMode: true` so Lumi is heard with the
 *  hardware ringer off (kids' app; the in-app sound toggle is the mute control,
 *  not the silent switch). Dev-only `[lumi]` diagnostics, gated on __DEV__.
 *
 * ── carried forward from v6.6 ─────────────────────────────────────────────────
 *  SFX→Voice sequential (measured duration + gap; scan uses a fixed offset).
 *  Voice picker emits spoken text to subscribers; pending voice cancelled on
 *  rapid state changes.
 *
 * BACK-COMPAT
 * ─────────────────────────────────────────────────────────────────────────────
 *   Public API surface is unchanged. `lumiAudioStatus()` keeps every field; the
 *   numbers now reflect the lazy model:
 *     • playersLoaded   — LIVE retained players (0 at boot is now CORRECT;
 *                         grows as cues play, capped at MAX_LIVE_PLAYERS)
 *     • localizedSources— clips materialized to file:// at init (the real
 *                         "did this build run the fix" signal; expect = cues)
 *     • durationsKnown  — retained players that have reported a duration
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { Asset } from 'expo-asset';
import type { LumiState } from './lumiTypes';
import { LUMI_SOUND_ASSETS } from './lumiSoundAssets';
import { getVoiceText } from './lumiVoiceManifest';

// expo-audio is optional — module degrades cleanly if absent.
let audio: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  audio = require('expo-audio');
} catch {
  audio = null;
}

// ─── Dev logger (no-op in prod) ───────────────────────────────────────────────
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

// ─── Tuning ───────────────────────────────────────────────────────────────────

// Max simultaneously-retained players. Cues fire at most 2 at once (lead SFX +
// voice); 6 gives generous reuse headroom while keeping live AVPlayerItems far
// below any iOS concurrency ceiling — the thing that killed the old 23-at-boot
// pool. Least-recently-used players beyond this are release()'d.
const MAX_LIVE_PLAYERS = 6;

// Re-assert the audio session at most this often (ms). The RAW test's
// distinguishing trait was setAudioModeAsync immediately before play; we
// replicate that, debounced, so rapid cues don't thrash the session.
const SESSION_REASSERT_DEBOUNCE_MS = 1500;

// First-play readiness polling. A freshly-created player may not be loaded the
// instant we want to play it; we check isLoaded at these offsets and play the
// moment it's ready, with a final forced attempt so we never swallow a cue.
const READY_POLL_MS = [0, 60, 150, 320, 650, 1100];

// ─── Module state ─────────────────────────────────────────────────────────────

let _initialized    = false;
let _soundEnabled   = true;   // default ON (v6.5 flipped this from OFF)
let _hapticsEnabled = true;

/** Live, retained players (lazy — created on first play, reused after). */
const _players: Partial<Record<LumiSoundKey, any>> = {};
/** Localized file:// URI per cue, populated at init. */
const _localUriByKey: Partial<Record<LumiSoundKey, string>> = {};
/** Measured duration in ms per cue. 0/absent if unknown. */
const _durationsMs: Partial<Record<LumiSoundKey, number>> = {};
/** Most-recently-used last → eviction takes from the front. */
const _lru: LumiSoundKey[] = [];
/** Timestamp of last successful setAudioModeAsync (debounce gate). */
let _lastSessionAssertMs = 0;

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

function getClipDurationMs(key: LumiSoundKey, fallback: number): number {
  const d = _durationsMs[key];
  if (typeof d === 'number' && d > 0) return d;
  return fallback;
}

function emitText(text: string | null): void {
  for (const fn of _textListeners) {
    try { fn(text); } catch { /* no-op */ }
  }
}

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

const SFX_VOICE_GAP_MS = 60;

// v6.8 — scanning state uses a fixed delay from CHIME START. See history.
const SCAN_VOICE_DELAY_FROM_CHIME_START_MS = 2500;

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

  dlog('initLumiSounds: prefs loaded, soundEnabled =', _soundEnabled, 'hapticsEnabled =', _hapticsEnabled);

  if (_soundEnabled) {
    await ensureSessionActive(true);
    await localizeAllSources();
    dlog(
      'initLumiSounds: done. localized =', Object.keys(_localUriByKey).length,
      '/ expected =', Object.keys(assets).length,
      '(players are created lazily on first play)',
    );
  } else {
    dlog('initLumiSounds: sound disabled by prefs — skipping session + localization');
  }
}

export async function setLumiSoundEnabled(on: boolean): Promise<void> {
  _soundEnabled = on;
  try { await AsyncStorage.setItem(KEY_SOUND, JSON.stringify(on)); } catch {}
  if (on) {
    // Make sure sources are localized + session live; players still lazy.
    await ensureSessionActive(true);
    if (Object.keys(_localUriByKey).length === 0) await localizeAllSources();
  }
}
export async function setLumiHapticsEnabled(on: boolean): Promise<void> {
  _hapticsEnabled = on;
  try { await AsyncStorage.setItem(KEY_HAPTICS, JSON.stringify(on)); } catch {}
}
export function isLumiSoundEnabled():   boolean { return _soundEnabled; }
export function isLumiHapticsEnabled(): boolean { return _hapticsEnabled; }
export function isLumiAudioAvailable(): boolean { return audio !== null; }

export function subscribeLumiText(listener: TextListener): () => void {
  _textListeners.add(listener);
  return () => { _textListeners.delete(listener); };
}

/** Fire the sound + haptic mapped to a Lumi state. (Sequencing unchanged.) */
export function playLumiForState(state: LumiState): void {
  _sequenceToken += 1;
  const myToken = _sequenceToken;

  cancelPendingVoice();

  if (_hapticsEnabled) {
    const fn = STATE_TO_HAPTIC[state];
    if (fn) { try { void fn(); } catch { /* no-op */ } }
  }

  if (!_soundEnabled || !audio) {
    emitText(null);
    return;
  }

  const leadSfx = STATE_TO_LEAD_SFX[state];
  const pool    = STATE_TO_POOL[state];
  const poolKey = pool ? pickFromPool(pool) : null;

  if (leadSfx) playSoundKey(leadSfx);

  if (!poolKey) return;

  const text = getVoiceText(poolKey);

  const fireVoice = () => {
    if (myToken !== _sequenceToken) return;
    playSoundKey(poolKey);
    if (text != null) emitText(text);
    _pendingVoiceTimer = null;
  };

  if (leadSfx) {
    const waitMs =
      leadSfx === 'scan'
        ? SCAN_VOICE_DELAY_FROM_CHIME_START_MS
        : getClipDurationMs(leadSfx, fallbackForSfx(leadSfx)) + SFX_VOICE_GAP_MS;
    _pendingVoiceTimer = setTimeout(fireVoice, waitMs);
  } else {
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

/**
 * Idempotent-ish audio-session activation. Re-asserts setAudioModeAsync at most
 * once per SESSION_REASSERT_DEBOUNCE_MS (or always when force=true). Models the
 * RAW path's "configure session right before play" — the trait that made the
 * one-off RAW player audible — without thrashing the session on rapid cues.
 */
async function ensureSessionActive(force = false): Promise<void> {
  if (!audio?.setAudioModeAsync) {
    if (force) dwarn('ensureSessionActive: setAudioModeAsync not exported — skipping');
    return;
  }
  const now = Date.now();
  if (!force && now - _lastSessionAssertMs < SESSION_REASSERT_DEBOUNCE_MS) return;
  try {
    await audio.setAudioModeAsync({
      playsInSilentMode:           true,
      interruptionMode:            'mixWithOthers',
      shouldPlayInBackground:      false,
      shouldRouteThroughEarpiece:  false,
    });
    _lastSessionAssertMs = Date.now();
    dlog('ensureSessionActive: setAudioModeAsync OK (playsInSilentMode: true)');
  } catch (err) {
    dwarn('ensureSessionActive: setAudioModeAsync threw —', err);
  }
}

/**
 * Localize every bundled clip to a file:// URI (v6.9 fix, retained). This is
 * the ONLY audio work done at startup now — it's cheap (asset copy, not
 * AVPlayerItem creation) and makes lazy player creation fast + release-safe.
 * NO players are created here. That batch was what broke iOS Release.
 */
async function localizeAllSources(): Promise<void> {
  await Promise.all(
    Object.entries(assets).map(async ([key, asset]) => {
      if (asset == null) return;
      try {
        const a = Asset.fromModule(asset as number);
        if (!a.localUri) await a.downloadAsync();
        if (a.localUri) _localUriByKey[key as LumiSoundKey] = a.localUri;
      } catch (err) {
        dwarn('localizeAllSources: failed for', key, '—', err);
        // Non-fatal — getOrCreatePlayer falls back to the raw module.
      }
    }),
  );
  dlog('localizeAllSources: localized', Object.keys(_localUriByKey).length, 'of', Object.keys(assets).length);
}

/** Move a key to MRU position. */
function touchLru(key: LumiSoundKey): void {
  const i = _lru.indexOf(key);
  if (i !== -1) _lru.splice(i, 1);
  _lru.push(key);
}

/** Release the least-recently-used idle player(s) until under the cap. */
function evictIfNeeded(): void {
  while (_lru.length > MAX_LIVE_PLAYERS) {
    // Find the oldest player that isn't currently playing.
    let victimIdx = -1;
    for (let i = 0; i < _lru.length; i++) {
      const k = _lru[i];
      const p = _players[k];
      if (!p || !p.playing) { victimIdx = i; break; }
    }
    if (victimIdx === -1) break; // everything live is playing — let it ride
    const victim = _lru.splice(victimIdx, 1)[0];
    const p = _players[victim];
    try { p?.release?.(); } catch { /* no-op */ }
    delete _players[victim];
    dlog('evictIfNeeded: released player', victim, '→ live =', _lru.length);
  }
}

/**
 * Lazily create (or reuse) the player for a cue. Creation mirrors the proven
 * RAW path: a single player from a localized file:// URI. Retained for reuse;
 * subject to LRU eviction.
 */
function getOrCreatePlayer(key: LumiSoundKey): any | null {
  const existing = _players[key];
  if (existing) {
    touchLru(key);
    return existing;
  }
  if (!audio?.createAudioPlayer) {
    dwarn('getOrCreatePlayer: createAudioPlayer not exported');
    return null;
  }

  const localUri = _localUriByKey[key];
  const rawModule = assets[key] as number | undefined;
  if (!localUri && rawModule == null) {
    dwarn('getOrCreatePlayer: no source for', key);
    return null;
  }
  const source = localUri ? { uri: localUri } : rawModule;

  try {
    const player = audio.createAudioPlayer(source);
    try { if (player && 'loop' in player) player.loop = false; } catch {}
    try { if (player && 'volume' in player) player.volume = 1.0; } catch {}

    _players[key] = player;
    touchLru(key);
    evictIfNeeded();

    attachDurationCapture(key, player);
    dlog('getOrCreatePlayer: created', key, '(localized =', !!localUri, ') live =', _lru.length);
    return player;
  } catch (err) {
    dwarn('getOrCreatePlayer: create failed for', key, '—', err);
    return null;
  }
}

/**
 * Capture duration into _durationsMs as soon as the player reports it. Prefers
 * the playbackStatusUpdate event; falls back to a couple of polls of
 * player.duration. Purely for SFX→voice timing + diagnostics; never blocks play.
 */
function attachDurationCapture(key: LumiSoundKey, player: any): void {
  const set = (secs: unknown) => {
    if (typeof secs === 'number' && secs > 0) _durationsMs[key] = Math.round(secs * 1000);
  };
  try {
    if (typeof player?.addListener === 'function') {
      const sub = player.addListener('playbackStatusUpdate', (st: any) => {
        if (st?.duration > 0) {
          set(st.duration);
          try { sub?.remove?.(); } catch { /* no-op */ }
        }
      });
    }
  } catch { /* fall through to polling */ }

  const poll = () => { if (!_durationsMs[key]) set(player?.duration); };
  setTimeout(poll, 250);
  setTimeout(poll, 1000);
}

/**
 * Play a loaded player from the start; if not yet loaded, wait for readiness
 * (the RAW test's behavior) then play — with a final forced attempt so a cue is
 * never silently dropped.
 */
function playWhenReady(key: LumiSoundKey, player: any): void {
  let done = false;

  const start = () => {
    if (done) return;
    done = true;
    try {
      // Restart from 0 for reused players (fresh ones are already at 0).
      if (typeof player.seekTo === 'function') { player.seekTo(0); }
      else if (typeof player.currentTime === 'number') { player.currentTime = 0; }
    } catch { /* non-fatal */ }
    try {
      player.play();
      dlog('playWhenReady:', key, '→ play()');
    } catch (err) {
      dwarn('playWhenReady:', key, '→ play() threw —', err);
    }
  };

  // Already loaded → go now.
  if (player?.isLoaded) { start(); return; }

  // Otherwise poll readiness; play the moment it's loaded.
  READY_POLL_MS.forEach((ms, idx) => {
    setTimeout(() => {
      if (done) return;
      if (player?.isLoaded || idx === READY_POLL_MS.length - 1) start();
    }, ms);
  });
}

function playSoundKey(key: LumiSoundKey): void {
  if (!_soundEnabled || !audio) return;
  // Async so we can re-assert the session before play (RAW-path ordering)
  // without blocking the synchronous dispatch in playLumiForState.
  (async () => {
    try {
      await ensureSessionActive(false);
      const player = getOrCreatePlayer(key);
      if (!player) { dwarn('playSoundKey: no player for', key); return; }
      playWhenReady(key, player);
    } catch (err) {
      dwarn('playSoundKey:', key, '— threw —', err);
    }
  })();
}

/** Diagnostics for ParentDashboard / LumiAudioDiagnostics. */
export function lumiAudioStatus(): {
  audioAvailable:   boolean;
  soundEnabled:     boolean;
  hapticsEnabled:   boolean;
  playersLoaded:    number;
  localizedSources: number;
  durationsKnown:   number;
  expectedCues:     number;
} {
  return {
    audioAvailable:   audio !== null,
    soundEnabled:     _soundEnabled,
    hapticsEnabled:   _hapticsEnabled,
    // Live retained players (lazy). 0 at boot is expected; grows as cues play.
    playersLoaded:    Object.keys(_players).length,
    localizedSources: Object.keys(_localUriByKey).length,
    durationsKnown:   Object.keys(_durationsMs).length,
    expectedCues:     Object.keys(assets).length,
  };
}
