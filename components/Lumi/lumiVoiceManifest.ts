/**
 * components/Lumi/lumiVoiceManifest.ts
 *
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │  WHY THIS FILE EXISTS                                                  │
 * │                                                                        │
 * │  Before this manifest, two systems picked Lumi's "speech" independently:│
 * │    • lumiSounds.ts   picked an MP3   from scan_dialogue_01..05         │
 * │    • lumiQuotes.ts   picked a string from LUMI_QUOTES['scanning']      │
 * │                                                                        │
 * │  The audio said one thing. The bubble showed another. Kids heard       │
 * │  "Squinting at this one..." while reading "Hmm, let me peek..."        │
 * │                                                                        │
 * │  This manifest is the single source of truth: ONE entry per MP3,       │
 * │  containing the exact text spoken in that MP3. lumiSounds picks the    │
 * │  key, looks up the text here, and emits it to LumiMascot via callback. │
 * │  The bubble then renders the same string the audio is speaking.        │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ACTION REQUIRED ON FIRST DEPLOY
 * ─────────────────────────────────────────────────────────────────────────
 *   The strings below are seeded from `lumiQuotes.ts` as PLACEHOLDERS.
 *   Open your ElevenLabs script (lumi-tts-script-v1.md) and replace each
 *   entry with the EXACT phrase you generated into the MP3.
 *
 *   Run `npm run lumi:verify-manifest` (or eyeball it once) — strings should
 *   match the audio word-for-word so deaf-readers and audio-listeners both
 *   land on the same line.
 *
 * INVARIANTS
 * ─────────────────────────────────────────────────────────────────────────
 *   • Every LumiSoundKey that maps to a VOICE clip (not an SFX) must appear
 *     here. SFX-only keys (appear, scan, sleep, cheer) are absent — they
 *     have no speech.
 *   • Strings are short (≤ 8 words) — bubble has a maxWidth of 200px and
 *     wraps at 3 lines.
 *   • ✨ glyph is allowed. Other emoji are discouraged (TTS reads them aloud).
 */

import type { LumiSoundKey } from './lumiSounds';

/** Voice clips (excludes ambient SFX). */
export type LumiVoiceKey = Exclude<LumiSoundKey,
  | 'appear'
  | 'scan'
  | 'sleep'
  | 'cheer'
>;

/**
 * Each voice MP3 → the exact phrase it speaks.
 *
 * EDIT THIS to match your ElevenLabs script. The placeholders below are
 * seeded from `LUMI_QUOTES` so the app reads sanely until you sync them.
 */
export const LUMI_VOICE_MANIFEST: Record<LumiVoiceKey, string> = {
  // ── Greeting pool (one per first-open-of-day) ─────────────────────────
  greet_01: 'Good morning! My magic is full again ✨',
  greet_02: 'Hello, friend! Ready for adventure?',
  greet_03: 'Sunrise! My spark is fresh ✨',
  greet_04: 'Look who\'s back! Let\'s find magic.',
  greet_05: 'New day, new sparks ✨',

  // ── Scan-dialogue pool (rotates during evaluation) ────────────────────
  scan_dialogue_01: 'Hmm, let me peek...',
  scan_dialogue_02: 'What could it be? ✨',
  scan_dialogue_03: 'Ooh, sparkly! Looking closely...',
  scan_dialogue_04: 'Reading the magic...',
  scan_dialogue_05: 'A clue is hiding here ✨',

  // ── Success pool (rotates on correct verdict) ─────────────────────────
  success:          'You found it! ✨',
  success_alt_01:   'Magnificent!',
  success_alt_02:   'Sparkly match! Word-magic unlocked.',

  // ── Fail pool (encouraging — never punitive) ──────────────────────────
  fail:                'Hmm, not this time!',
  fail_encourage_01:   'Try with new eyes ✨',
  fail_encourage_02:   'Look around — magic is hiding!',

  // ── Boss-hint pool (after 3 failed attempts on a component) ───────────
  boss_hint_01: 'Psst — think about texture!',
  boss_hint_02: 'Soft? Hard? Smooth? Bumpy?',
  boss_hint_03: 'Search high AND low ✨',
};

/**
 * Look up the spoken text for a given voice key.
 *
 * Returns null if the key is an SFX (no speech) or missing from the manifest.
 * lumiSounds.ts uses this when picking from a pool to emit the matching text
 * to LumiMascot, so the bubble can render exactly what the audio is saying.
 */
export function getVoiceText(key: LumiSoundKey): string | null {
  // Narrow to LumiVoiceKey via the manifest's keys
  return (LUMI_VOICE_MANIFEST as Record<string, string>)[key] ?? null;
}

/**
 * Validates the manifest at boot. Logs a warning if any expected voice key
 * is missing — useful while iterating on the ElevenLabs script.
 *
 * Not called by default; wire from `initLumiSounds` if you want it noisy.
 */
export function auditVoiceManifest(allKeys: readonly LumiSoundKey[]): string[] {
  const sfxOnly = new Set<LumiSoundKey>(['appear', 'scan', 'sleep', 'cheer']);
  const missing: string[] = [];
  for (const k of allKeys) {
    if (sfxOnly.has(k)) continue;
    if (!(k in LUMI_VOICE_MANIFEST)) missing.push(k);
  }
  return missing;
}
