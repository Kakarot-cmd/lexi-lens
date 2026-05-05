/**
 * components/Lumi/lumiQuotes.ts
 *
 * Lumi's spoken lines.
 *
 * Rules:
 *   • Max ~8 words per line (ages 5-7 reading speed).
 *   • Warm, never sarcastic, never punitive on failure.
 *   • Lore-consistent: Lumi is a "spark of word-magic" who lives in the Lens.
 *   • Sparkles with ✨ allowed, no other emoji clutter.
 *   • Never names a specific object (the Edge Function does that).
 *
 * Adding lines: keep arrays balanced (3-6 lines per intent). Pick is random.
 */

import type { QuoteIntent } from './lumiTypes';

// ─── Quote pool ───────────────────────────────────────────────────────────────

export const LUMI_QUOTES: Record<QuoteIntent, readonly string[]> = {
  greeting: [
    'Good morning! My magic is full again ✨',
    'Hello, friend! Ready for adventure?',
    'Sunrise! My spark is fresh ✨',
    'Look who\'s back! Let\'s find magic.',
  ],

  onboarding: [
    'Hi! I\'m Lumi, your spark guide ✨',
    'Point your Lens at things to see their magic!',
    'Find what the quest asks for. I\'ll help!',
    'Tap the scan button when you\'re ready ✨',
  ],

  scanning: [
    'Hmm, let me peek...',
    'What could it be? ✨',
    'Ooh, sparkly!',
    'Looking closely...',
    'Almost...',
    'Reading the magic...',
  ],

  'success-match': [
    'You found it! ✨',
    'Magnificent!',
    'Sparkly match!',
    'Word-magic unlocked ✨',
    'You did it!',
  ],

  'success-partial': [
    'Close! Some sparks matched ✨',
    'Half the magic — keep going!',
    'On the right path!',
    'Some sparks lit up ✨',
  ],

  'fail-mismatch': [
    'Hmm, not this time!',
    'Try with new eyes ✨',
    'What ELSE could it be?',
    'Look around — magic is hiding!',
    'Almost! Let\'s try another.',
  ],

  'boss-hint': [
    'Psst — think about texture!',
    'Try something around the room ✨',
    'Small things often have big magic!',
    'Look closely at edges and shapes.',
  ],

  'rate-limit': [
    'My spark is fizzled ✨ See you tomorrow!',
    'Out of magic for today — rest time!',
    'Sleepy sparks... back at sunrise ✨',
    'Tome time. Fresh magic tomorrow!',
  ],

  victory: [
    'We did it! ✨',
    'Quest complete! You\'re amazing!',
    'Sparkle storm! ✨✨',
    'The magic is yours!',
  ],

  'idle-flavor': [
    '',                          // mostly silent
    '',
    '',
    'What shall we find next?',
    'Sparks waiting ✨',
  ],
} as const;

// ─── Quote selection ──────────────────────────────────────────────────────────

/**
 * Returns a stable random line for the given intent.
 * Uses a salt (timestamp by default) so repeated calls in the same render
 * don't shuffle. Pass a stable salt (e.g. quest id) to keep the same line
 * for an entire scene.
 */
export function pickLumiQuote(intent: QuoteIntent, salt?: string): string {
  const pool = LUMI_QUOTES[intent];
  if (!pool || pool.length === 0) return '';
  const seed = salt ? hashString(salt) : Date.now();
  return pool[seed % pool.length] ?? '';
}

/** Cheap deterministic hash so the same salt picks the same line. */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
