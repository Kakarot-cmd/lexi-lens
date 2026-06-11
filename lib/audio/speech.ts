/**
 * lib/audio/speech.ts — v1.0
 *
 * Word pronunciation via on-device TTS (expo-speech). Used to say a vocabulary
 * word aloud when a child taps its chip. On-device = offline, free, no per-word
 * recording, and it works for ANY word — which matters because the property
 * words are AI-generated per quest (generate-quest), not a fixed list.
 *
 * Deliberately SEPARATE from the game-audio engine (gameAudio.ts):
 *   • expo-speech drives the platform speech synthesiser (iOS AVSpeechSynthesizer
 *     / Android TextToSpeech), not expo-audio players, so it has its own path.
 *   • It is NOT gated by the music / SFX toggles. Tapping a word is an explicit
 *     "say this for me" request — muting background chimes shouldn't silence a
 *     child asking to hear a word. (If you'd rather gate it, add an
 *     isSfxEnabled() check in speakWord.)
 *
 * Audio session: on iOS the synthesiser uses the app's audio session, which the
 * game-audio engine sets to playback + mixWithOthers — so speech plays over the
 * silent switch and mixes with the music bed rather than cutting it off.
 *
 * Defensive require: if expo-speech isn't installed yet, every call is a silent
 * no-op so the bundle still builds. Run `npx expo install expo-speech` and
 * rebuild to enable it.
 */

let Speech: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  Speech = require('expo-speech');
} catch {
  Speech = null;
}

const dwarn = (...a: unknown[]): void => { if (__DEV__) console.warn('[speech]', ...a); };

/** Kid-friendly defaults: a touch slower than normal, slightly bright pitch. */
const DEFAULTS = {
  language: 'en-US',
  rate:     0.9,
  pitch:    1.05,
};

export function isSpeechAvailable(): boolean {
  return Speech != null && typeof Speech.speak === 'function';
}

export interface SpeakOptions {
  rate?:     number;
  pitch?:    number;
  language?: string;
  onDone?:   () => void;
}

/**
 * Speak a single word aloud. Cancels any in-flight utterance first so rapid
 * chip taps don't queue up. No-op if expo-speech is missing or the word is empty.
 */
export function speakWord(word: string | null | undefined, opts: SpeakOptions = {}): void {
  if (!isSpeechAvailable() || !word) return;
  const text = word.trim();
  if (!text) return;
  try {
    Speech.stop(); // interrupt the previous word
    Speech.speak(text, {
      language: opts.language ?? DEFAULTS.language,
      rate:     opts.rate     ?? DEFAULTS.rate,
      pitch:    opts.pitch    ?? DEFAULTS.pitch,
      onDone:   opts.onDone,
    });
  } catch (err) {
    dwarn('speakWord threw —', err);
  }
}

/** Stop any current utterance (e.g. when leaving the screen). */
export function stopSpeaking(): void {
  try { Speech?.stop?.(); } catch { /* no-op */ }
}

let speechWarmed = false;

/**
 * Warm the native TTS engine so the FIRST real word a child taps doesn't pay
 * the one-time cold-start. Android has to bind the TextToSpeech service and load
 * voice data on first use; iOS spins up AVSpeechSynthesizer + the voice. That
 * cost (~0.5–2s) lands on whoever taps first unless we pay it up front.
 *
 * Idempotent + fire-and-forget + inaudible:
 *   • getAvailableVoicesAsync() binds the engine (the slow part on Android)
 *     and produces no sound.
 *   • a single space at volume 0 exercises the actual speak pipeline silently.
 *
 * Call on ScanScreen mount — by the time the verdict/seek chips are tapped,
 * the engine is hot and pronunciation is immediate. Safe to call repeatedly;
 * only the first call does work.
 */
export function prewarmSpeech(): void {
  if (speechWarmed || !isSpeechAvailable()) return;
  speechWarmed = true;
  try {
    // Binds/initialises the engine without emitting audio.
    Speech.getAvailableVoicesAsync?.().catch(() => { /* ignore */ });
    // Warms the utterance path itself — space at volume 0 is inaudible.
    Speech.speak(' ', {
      language: DEFAULTS.language,
      rate:     DEFAULTS.rate,
      pitch:    DEFAULTS.pitch,
      volume:   0,
    });
  } catch (err) {
    speechWarmed = false; // allow a later mount to retry if this threw early
    dwarn('prewarmSpeech threw —', err);
  }
}
