/**
 * lib/audio/gameAudio.ts — v1.0
 *
 * Game-wide audio engine: looping background music (BGM) + one-shot sound
 * effects (SFX). Sits ALONGSIDE the Lumi mascot voice system
 * (components/Lumi/lumiSounds.ts) — it does not replace or wrap it.
 *
 * WHY A SEPARATE MODULE
 *   Lumi owns the mascot's *voice* (rotating spoken clips, SFX→voice timing,
 *   speech-bubble text). This module owns everything else that makes the game
 *   feel alive between barks: a soft music bed per screen, screen-entry
 *   whooshes, and reward/feedback stings (success, fail, xp, victory…).
 *
 * DESIGN — DELIBERATELY COPIES LUMI'S HARD-WON PATTERN
 *   The Lumi system learned (v6.10) that batch-creating ~two dozen expo-audio
 *   players at cold start leaves them PERMANENTLY UNLOADED on iOS Release. So:
 *     • No players are created at startup. init() only localizes sources to
 *       file:// URIs (cheap asset copy) — the proven-audible configuration.
 *     • SFX players are created LAZILY on first play, reused, and capped via
 *       LRU eviction (release()'d beyond the cap). Identical to Lumi.
 *     • Playback waits for player.isLoaded before starting, with a forced final
 *       attempt so a cue is never silently dropped.
 *     • BGM is the one exception to "lazy": it is a single, long-lived looping
 *       player (one AVPlayerItem — nowhere near the concurrency ceiling that
 *       bricked the old 23-at-boot pool).
 *
 * AUDIO SESSION — COMPATIBLE WITH LUMI, NOT COMPETING
 *   Asserts the SAME setAudioModeAsync config Lumi uses
 *   (playsInSilentMode:true, interruptionMode:'mixWithOthers'). Because the
 *   config is identical, the two modules asserting it independently is
 *   idempotent and safe. 'mixWithOthers' is what lets the BGM bed, Lumi's
 *   voice, and SFX layer instead of cutting each other off. (It also means we
 *   don't hijack a parent's podcast — a deliberate, kid-app-friendly choice.
 *   If you ever want the game to duck/stop other apps' audio, change BOTH
 *   modules to a non-mixing mode together.)
 *
 * CROSS-PLATFORM
 *   JS-only, OTA-eligible. expo-audio is required defensively — if absent the
 *   whole module degrades to silent no-ops (haptics/voice unaffected).
 *
 * SETTINGS (independent of Lumi's toggle)
 *   skanlore.audio.musicEnabled  (default ON)
 *   skanlore.audio.sfxEnabled    (default ON)
 *   Parent-controlled in GameAudioSettingsCard. Lumi's *voice* stays on its own
 *   toggle in the Lumi section — three intentional, clearly-labeled controls.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Asset } from 'expo-asset';
import { BGM_ASSETS, SFX_ASSETS } from './gameAudioAssets';

// expo-audio is optional — degrade cleanly if absent.
let audio: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  audio = require('expo-audio');
} catch {
  audio = null;
}

// ─── Dev logger (no-op in prod) ───────────────────────────────────────────────
const dlog = (...a: unknown[]): void => { if (__DEV__) console.log('[gameAudio]', ...a); };
const dwarn = (...a: unknown[]): void => { if (__DEV__) console.warn('[gameAudio]', ...a); };

// ─── Keys ─────────────────────────────────────────────────────────────────────

export type BgmKey = 'map' | 'scan' | 'menu';

export type SfxKey =
  | 'tap'
  | 'screen_in'
  | 'success'
  | 'fail'
  | 'xp'
  | 'quest_clear'
  | 'achievement'
  | 'error';

// ─── Persistence keys ─────────────────────────────────────────────────────────

const KEY_MUSIC = 'skanlore.audio.musicEnabled';
const KEY_SFX   = 'skanlore.audio.sfxEnabled';

// ─── Tuning ───────────────────────────────────────────────────────────────────

/** SFX live-player cap (LRU). A few more than Lumi's 6 — SFX variety is higher,
 *  cues are short, and one BGM player is the only other live AVPlayerItem. */
const MAX_LIVE_SFX = 8;

/** Steady-state BGM bed volume. Low so Lumi's voice + SFX sit clearly on top. */
const BGM_VOLUME = 0.32;
/** SFX gain. Files are pre-leveled; this is a global trim. */
const SFX_VOLUME = 0.9;

/** Crossfade duration when switching BGM tracks (ms). */
const BGM_CROSSFADE_MS = 650;
/** Volume-ramp tick (ms). */
const RAMP_TICK_MS = 50;

/** setAudioModeAsync re-assert debounce (ms) — mirrors Lumi. */
const SESSION_REASSERT_DEBOUNCE_MS = 1500;

/** First-play readiness poll offsets (ms) — mirrors Lumi. */
const READY_POLL_MS = [0, 60, 150, 320, 650, 1100];

// ─── Module state ─────────────────────────────────────────────────────────────

let _initialized   = false;
let _musicEnabled  = true;
let _sfxEnabled    = true;
let _lastSessionMs = 0;

// SFX: lazy + LRU (identical to Lumi).
const _sfxPlayers: Partial<Record<SfxKey, any>> = {};
const _sfxLocalUri: Partial<Record<SfxKey, string>> = {};
const _sfxLru: SfxKey[] = [];

// BGM: one long-lived looping player.
const _bgmLocalUri: Partial<Record<BgmKey, string>> = {};
let _bgmPlayer: any = null;
let _bgmPlayerKey: BgmKey | null = null;   // which track _bgmPlayer holds
let _currentBgm: BgmKey | null = null;     // what's actually audible
let _desiredBgm: BgmKey | null = null;     // what SHOULD play (survives mute/bg)
let _bgmPaused = false;                     // backgrounded?
let _rampTimer: ReturnType<typeof setInterval> | null = null;

// ─── Session ──────────────────────────────────────────────────────────────────

async function ensureSession(force = false): Promise<void> {
  if (!audio?.setAudioModeAsync) {
    if (force) dwarn('ensureSession: setAudioModeAsync not exported');
    return;
  }
  const now = Date.now();
  if (!force && now - _lastSessionMs < SESSION_REASSERT_DEBOUNCE_MS) return;
  try {
    await audio.setAudioModeAsync({
      playsInSilentMode:          true,
      interruptionMode:           'mixWithOthers',
      shouldPlayInBackground:     false,
      shouldRouteThroughEarpiece: false,
    });
    _lastSessionMs = Date.now();
  } catch (err) {
    dwarn('ensureSession threw —', err);
  }
}

// ─── Localization (the only startup audio work — cheap, no players) ───────────

async function localizeAll(): Promise<void> {
  const jobs: Promise<void>[] = [];

  const localize = (module: number, sink: (uri: string) => void) => {
    jobs.push((async () => {
      try {
        const a = Asset.fromModule(module);
        if (!a.localUri) await a.downloadAsync();
        if (a.localUri) sink(a.localUri);
      } catch (err) {
        dwarn('localize failed —', err);
      }
    })());
  };

  (Object.keys(SFX_ASSETS) as SfxKey[]).forEach((k) =>
    localize(SFX_ASSETS[k], (uri) => { _sfxLocalUri[k] = uri; }));
  (Object.keys(BGM_ASSETS) as BgmKey[]).forEach((k) =>
    localize(BGM_ASSETS[k], (uri) => { _bgmLocalUri[k] = uri; }));

  await Promise.all(jobs);
  dlog('localized sfx', Object.keys(_sfxLocalUri).length, '/ bgm', Object.keys(_bgmLocalUri).length);
}

// ─── Public: lifecycle / settings ─────────────────────────────────────────────

export function isGameAudioAvailable(): boolean { return audio !== null; }
export function isMusicEnabled(): boolean { return _musicEnabled; }
export function isSfxEnabled(): boolean { return _sfxEnabled; }

/** Bootstrap. Call once at app start (dynamic import in App.tsx). */
export async function initGameAudio(): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  try {
    const [m, s] = await Promise.all([
      AsyncStorage.getItem(KEY_MUSIC),
      AsyncStorage.getItem(KEY_SFX),
    ]);
    if (m !== null) _musicEnabled = JSON.parse(m);
    if (s !== null) _sfxEnabled = JSON.parse(s);
  } catch { /* defaults stand */ }

  if (!audio) { dlog('init: expo-audio missing — silent no-op mode'); return; }

  await ensureSession(true);
  await localizeAll();
  // Warm the two SFX that fire on every navigation so the first one isn't late.
  prewarmSfx(['screen_in', 'tap']);
  dlog('init done. music =', _musicEnabled, 'sfx =', _sfxEnabled);
}

export async function setMusicEnabled(on: boolean): Promise<void> {
  _musicEnabled = on;
  try { await AsyncStorage.setItem(KEY_MUSIC, JSON.stringify(on)); } catch {}
  if (!audio) return;
  if (on) {
    await ensureSession(true);
    // Resume whatever the current screen wanted.
    if (_desiredBgm) void startBgm(_desiredBgm);
  } else {
    void stopBgm(/*keepDesired*/ true);
  }
}

export async function setSfxEnabled(on: boolean): Promise<void> {
  _sfxEnabled = on;
  try { await AsyncStorage.setItem(KEY_SFX, JSON.stringify(on)); } catch {}
  if (on && audio) await ensureSession(true);
}

// ─── BGM ──────────────────────────────────────────────────────────────────────

function clearRamp(): void {
  if (_rampTimer) { clearInterval(_rampTimer); _rampTimer = null; }
}

function setBgmVolume(v: number): void {
  try { if (_bgmPlayer && 'volume' in _bgmPlayer) _bgmPlayer.volume = Math.max(0, Math.min(1, v)); } catch {}
}

function rampBgmVolume(to: number, ms: number, onDone?: () => void): void {
  clearRamp();
  if (!_bgmPlayer) { onDone?.(); return; }
  const from = (() => { try { return typeof _bgmPlayer.volume === 'number' ? _bgmPlayer.volume : to; } catch { return to; } })();
  const steps = Math.max(1, Math.round(ms / RAMP_TICK_MS));
  let i = 0;
  _rampTimer = setInterval(() => {
    i += 1;
    const v = from + (to - from) * (i / steps);
    setBgmVolume(v);
    if (i >= steps) { clearRamp(); onDone?.(); }
  }, RAMP_TICK_MS);
}

function bgmSource(key: BgmKey): any {
  const uri = _bgmLocalUri[key];
  return uri ? { uri } : BGM_ASSETS[key];
}

/** Build (or rebuild) the single BGM player for `key`, looping, at volume 0. */
function makeBgmPlayer(key: BgmKey): any | null {
  if (!audio?.createAudioPlayer) return null;
  try {
    const p = audio.createAudioPlayer(bgmSource(key));
    try { if ('loop' in p) p.loop = true; } catch {}
    setBgmVolumeOn(p, 0);
    return p;
  } catch (err) {
    dwarn('makeBgmPlayer failed —', err);
    return null;
  }
}

function setBgmVolumeOn(p: any, v: number): void {
  try { if (p && 'volume' in p) p.volume = v; } catch {}
}

function releaseBgmPlayer(): void {
  clearRamp();
  const p = _bgmPlayer;
  _bgmPlayer = null;
  _bgmPlayerKey = null;
  _currentBgm = null;
  if (p) { try { p.pause?.(); } catch {} try { p.release?.(); } catch {} }
}

/**
 * Start (or crossfade to) a looping BGM bed. Idempotent for the same track.
 * Remembers the request as `_desiredBgm` so it survives mute + backgrounding.
 */
export async function startBgm(key: BgmKey): Promise<void> {
  _desiredBgm = key;
  if (!audio) return;
  if (!_musicEnabled || _bgmPaused) return;     // remembered; will resume later
  if (_currentBgm === key && _bgmPlayer) return; // already playing this bed

  await ensureSession(false);

  const playReady = (p: any) => {
    let done = false;
    const go = () => {
      if (done) return; done = true;
      try { p.play?.(); } catch (err) { dwarn('bgm play threw —', err); }
      rampBgmVolume(BGM_VOLUME, BGM_CROSSFADE_MS);
    };
    if (p?.isLoaded) { go(); return; }
    READY_POLL_MS.forEach((ms, idx) =>
      setTimeout(() => { if (!done && (p?.isLoaded || idx === READY_POLL_MS.length - 1)) go(); }, ms));
  };

  // Fade the outgoing bed (if any), then swap to the new player.
  const swapIn = () => {
    releaseBgmPlayer();
    const p = makeBgmPlayer(key);
    if (!p) return;
    _bgmPlayer = p;
    _bgmPlayerKey = key;
    _currentBgm = key;
    playReady(p);
    dlog('startBgm →', key);
  };

  if (_bgmPlayer && _currentBgm && _currentBgm !== key) {
    rampBgmVolume(0, BGM_CROSSFADE_MS, swapIn);
  } else {
    swapIn();
  }
}

/** Stop the bed. keepDesired=true (mute) remembers the track for re-enable. */
export async function stopBgm(keepDesired = false): Promise<void> {
  if (!keepDesired) _desiredBgm = null;
  if (!_bgmPlayer) { _currentBgm = null; return; }
  rampBgmVolume(0, BGM_CROSSFADE_MS, () => releaseBgmPlayer());
}

/** AppState → background. Pause the bed; remember to resume. */
export function pauseBgmForBackground(): void {
  _bgmPaused = true;
  clearRamp();
  try { _bgmPlayer?.pause?.(); } catch {}
}

/** AppState → active. Resume the remembered bed. */
export function resumeBgmFromForeground(): void {
  _bgmPaused = false;
  if (!audio || !_musicEnabled) return;
  void ensureSession(true).then(() => {
    if (_bgmPlayer && _bgmPlayerKey === _desiredBgm && _desiredBgm === _currentBgm) {
      try { _bgmPlayer.play?.(); } catch {}
      rampBgmVolume(BGM_VOLUME, BGM_CROSSFADE_MS);
    } else if (_desiredBgm) {
      void startBgm(_desiredBgm);
    }
  });
}

// ─── SFX (lazy + LRU, mirrors Lumi) ───────────────────────────────────────────

function touchSfxLru(key: SfxKey): void {
  const i = _sfxLru.indexOf(key);
  if (i !== -1) _sfxLru.splice(i, 1);
  _sfxLru.push(key);
}

function evictSfx(): void {
  while (_sfxLru.length > MAX_LIVE_SFX) {
    let victimIdx = -1;
    for (let i = 0; i < _sfxLru.length; i++) {
      const p = _sfxPlayers[_sfxLru[i]];
      if (!p || !p.playing) { victimIdx = i; break; }
    }
    if (victimIdx === -1) break;
    const victim = _sfxLru.splice(victimIdx, 1)[0];
    try { _sfxPlayers[victim]?.release?.(); } catch {}
    delete _sfxPlayers[victim];
  }
}

function getOrCreateSfx(key: SfxKey): any | null {
  const existing = _sfxPlayers[key];
  if (existing) { touchSfxLru(key); return existing; }
  if (!audio?.createAudioPlayer) return null;

  const uri = _sfxLocalUri[key];
  const source = uri ? { uri } : SFX_ASSETS[key];
  try {
    const p = audio.createAudioPlayer(source);
    try { if ('loop' in p) p.loop = false; } catch {}
    try { if ('volume' in p) p.volume = SFX_VOLUME; } catch {}
    _sfxPlayers[key] = p;
    touchSfxLru(key);
    evictSfx();
    return p;
  } catch (err) {
    dwarn('getOrCreateSfx failed for', key, '—', err);
    return null;
  }
}

function playSfxWhenReady(key: SfxKey, p: any): void {
  let done = false;
  const start = () => {
    if (done) return; done = true;
    try {
      if (typeof p.seekTo === 'function') p.seekTo(0);
      else if (typeof p.currentTime === 'number') p.currentTime = 0;
    } catch {}
    try { p.play?.(); } catch (err) { dwarn('sfx play threw —', key, err); }
  };
  if (p?.isLoaded) { start(); return; }
  READY_POLL_MS.forEach((ms, idx) =>
    setTimeout(() => { if (!done && (p?.isLoaded || idx === READY_POLL_MS.length - 1)) start(); }, ms));
}

/** Fire a one-shot SFX. No-op if SFX disabled / audio unavailable. */
export function playSfx(key: SfxKey): void {
  if (!_sfxEnabled || !audio) return;
  (async () => {
    try {
      await ensureSession(false);
      const p = getOrCreateSfx(key);
      if (p) playSfxWhenReady(key, p);
    } catch (err) {
      dwarn('playSfx threw —', key, err);
    }
  })();
}

/**
 * Pre-create a few latency-sensitive SFX players so their FIRST play is
 * instant instead of paying the ~350ms create+load on iOS. Safe because it's a
 * tiny, fixed set (the 23-at-boot pool is what bricked iOS, not 1–2 players).
 * The player loads in the background; nothing is played here.
 */
export function prewarmSfx(keys: SfxKey[]): void {
  if (!audio) return;
  for (const k of keys) {
    try { getOrCreateSfx(k); } catch { /* non-fatal */ }
  }
}

/**
 * Convenience: layer a non-voice game STING under a Lumi state transition.
 * Called from the single LumiMascot chokepoint. Sound-only (no haptics — Lumi
 * already owns haptics for these states, so we never double-buzz). Maps only
 * the core-loop moments; everything else is left to Lumi's voice.
 */
export function playGameSfxForLumiState(state: string): void {
  switch (state) {
    case 'success':  playSfx('success'); break;
    case 'fail':     playSfx('fail');    break;
    default: /* no sting — Lumi's voice carries the rest */ break;
  }
}

// ─── Diagnostics ──────────────────────────────────────────────────────────────

export function gameAudioStatus(): {
  audioAvailable:  boolean;
  musicEnabled:    boolean;
  sfxEnabled:      boolean;
  currentBgm:      BgmKey | null;
  desiredBgm:      BgmKey | null;
  bgmPaused:       boolean;
  liveSfxPlayers:  number;
  localizedSfx:    number;
  localizedBgm:    number;
} {
  return {
    audioAvailable: audio !== null,
    musicEnabled:   _musicEnabled,
    sfxEnabled:     _sfxEnabled,
    currentBgm:     _currentBgm,
    desiredBgm:     _desiredBgm,
    bgmPaused:      _bgmPaused,
    liveSfxPlayers: Object.keys(_sfxPlayers).length,
    localizedSfx:   Object.keys(_sfxLocalUri).length,
    localizedBgm:   Object.keys(_bgmLocalUri).length,
  };
}
