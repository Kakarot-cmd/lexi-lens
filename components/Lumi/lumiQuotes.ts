/**
 * components/Lumi/lumiQuotes.ts — v2
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
 * v2 enrichment:
 *   • Idle-flavor pool expanded to 10 lines, ~half empty (so Lumi has natural
 *     quiet windows — kids don't get spammed with bubbles every 11 seconds).
 *   • All other pools enriched with more playful, varied copy.
 */

import type { QuoteIntent } from './lumiTypes';

export const LUMI_QUOTES: Record<QuoteIntent, readonly string[]> = {
  greeting: [
    'Good morning! My magic is full again ✨',
    'Hello, friend! Ready for adventure?',
    'Sunrise! My spark is fresh ✨',
    'Look who\'s back! Let\'s find magic.',
    'New day, new sparks ✨',
    'Tome opened — let\'s play!',
  ],

  onboarding: [
    'Hi! I\'m Lumi, your spark guide ✨',
    'Point your Lens at things to see their magic!',
    'Find what the quest asks for. I\'ll help!',
    'Tap the scan button when you\'re ready ✨',
    'Look around — magic is everywhere!',
  ],

  scanning: [
    'Hmm, let me peek...',
    'What could it be? ✨',
    'Ooh, sparkly!',
    'Looking closely...',
    'Almost...',
    'Reading the magic...',
    'A clue is hiding here ✨',
    'Steady... steady...',
  ],

  // v6.2 Phase 2 — looking-up pool. Shown briefly while CC1 (canonical
  // classifier) runs, before the full evaluate kicks in. Quotes lean into
  // the "I'm peering at this thing" beat without committing to a verdict
  // yet. Pool kept small (5) — anything CC1 takes long enough to read
  // more than one quote is a tail-latency outlier we'd rather not draw
  // attention to.
  'looking-up': [
    'Squinting at this one...',
    'Let me get a closer look ✨',
    'Hmm, what IS this?',
    'Recognising the shape...',
    'Almost got it ✨',
  ],

  'success-match': [
    'You found it! ✨',
    'Magnificent!',
    'Sparkly match!',
    'Word-magic unlocked ✨',
    'You did it!',
    'Boom — sparks lit up ✨',
    'Brilliant find!',
    'Yes! That was it!',
  ],

  'success-partial': [
    'Close! Some sparks matched ✨',
    'Half the magic — keep going!',
    'On the right path!',
    'Some sparks lit up ✨',
    'Almost there — try one more!',
  ],

  'fail-mismatch': [
    'Hmm, not this time!',
    'Try with new eyes ✨',
    'What ELSE could it be?',
    'Look around — magic is hiding!',
    'Almost! Let\'s try another.',
    'No sparks yet. Look closer ✨',
    'Different shape, different magic!',
  ],

  'boss-hint': [
    'Psst — think about texture!',
    'Try something around the room ✨',
    'Small things often have big magic!',
    'Look closely at edges and shapes.',
    'Soft? Hard? Smooth? Bumpy?',
    'Search high AND low ✨',
  ],

  'rate-limit': [
    'My spark is fizzled ✨ See you tomorrow!',
    'Out of magic for today — rest time!',
    'Sleepy sparks... back at sunrise ✨',
    'Tome time. Fresh magic tomorrow!',
    'Zzz... see you on the morning ✨',
  ],

  victory: [
    'We did it! ✨',
    'Quest complete! You\'re amazing!',
    'Sparkle storm! ✨✨',
    'The magic is yours!',
    'Heroes of the Tome ✨',
    'That was magnificent!',
  ],

  // Idle-flavor — ~50/50 mix of empty (quiet) and chatty.
  // pickLumiQuote picks deterministically per salt; the salt rotates every
  // ~11s in idle, so Lumi speaks roughly half the rotations.
  'idle-flavor': [
    '',                              // quiet
    '',
    '',
    '',
    '',
    'What shall we find next? ✨',
    'Sparks waiting...',
    'Tap to scan something!',
    'Magic is hiding nearby ✨',
    'Open the dungeon map ✨',
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
