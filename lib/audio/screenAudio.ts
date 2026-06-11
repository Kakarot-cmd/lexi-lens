/**
 * lib/audio/screenAudio.ts — v1.0
 *
 * The bridge between navigation and the audio engine. App.tsx already routes
 * every navigation state change through one handler (onStateChange →
 * navigationRef.getCurrentRoute()); we tap that single point so each screen
 * gets the right music bed and a soft entry whoosh — no per-screen edits.
 *
 * Add a new screen → add one line to SCREEN_BGM (and optionally NO_ENTRY_SFX).
 */

import { playSfx, startBgm, type BgmKey } from './gameAudio';

/** Which BGM bed each route plays. Unlisted routes keep the current bed. */
const SCREEN_BGM: Record<string, BgmKey> = {
  // Welcome / pre-game
  Auth:               'menu',
  Onboarding:         'menu',
  OnboardingBackstory:'menu',
  Paywall:            'menu',
  // The adventure hub + parent surfaces
  ChildSwitcher:      'map',
  QuestMap:           'map',
  SpellBook:          'map',
  QuestGenerator:     'map',
  ParentDashboard:    'map',
  // Focused scanning
  Scan:               'scan',
};

/** Routes that should NOT get an entry whoosh (kept clean). */
const NO_ENTRY_SFX = new Set<string>([
  'Scan', // Lumi's scan chime owns this moment
]);

// React Navigation's onStateChange can fire several times during a push
// animation, and getCurrentRoute() briefly reports intermediate routes — so a
// single tap can look like map→scan→map→scan. We coalesce per-frame flapping,
// but with TWO windows, because the two cues have opposite needs:
//
//   • BGM  — switching beds tears the player down and rebuilds it (~350ms iOS
//            load). It must only react to the SETTLED route, so a longer window
//            is fine; the latency is inaudible for music.
//   • Whoosh — a UI sound that must feel tied to the tap. A long window made it
//            land ~350ms late ("not matching the action"). Reused pooled player,
//            so firing it promptly is cheap and safe — short window.
const BGM_SETTLE_MS    = 300;
const WHOOSH_SETTLE_MS  = 110;

let _committedBgm:    string | null = null;
let _committedWhoosh: string | null = null;
let _pendingRoute:    string | null = null;
let _bgmTimer:    ReturnType<typeof setTimeout> | null = null;
let _whooshTimer: ReturnType<typeof setTimeout> | null = null;

function commitBgm(): void {
  _bgmTimer = null;
  const r = _pendingRoute;
  if (!r || r === _committedBgm) return;
  _committedBgm = r;
  const bed = SCREEN_BGM[r];
  if (bed) void startBgm(bed); // engine no-ops if it's already the active bed
}

function commitWhoosh(): void {
  _whooshTimer = null;
  const r = _pendingRoute;
  if (!r || r === _committedWhoosh) return;
  const isFirst = _committedWhoosh === null;
  _committedWhoosh = r;
  if (!isFirst && !NO_ENTRY_SFX.has(r)) playSfx('screen_in');
}

/**
 * Call on every navigation state change with the active route name.
 * The whoosh commits fast (feels tied to the tap); the music bed commits on a
 * longer settle (no player teardown thrash). Both coalesce mid-transition flaps.
 */
export function onScreenChange(routeName: string | null | undefined): void {
  if (!routeName) return;
  _pendingRoute = routeName;
  if (_whooshTimer) clearTimeout(_whooshTimer);
  if (_bgmTimer)    clearTimeout(_bgmTimer);
  _whooshTimer = setTimeout(commitWhoosh, WHOOSH_SETTLE_MS);
  _bgmTimer    = setTimeout(commitBgm,    BGM_SETTLE_MS);
}

/** Reset (e.g. on sign-out) so the next cold navigation isn't treated as a transition. */
export function resetScreenAudio(): void {
  if (_whooshTimer) clearTimeout(_whooshTimer);
  if (_bgmTimer)    clearTimeout(_bgmTimer);
  _whooshTimer = null;
  _bgmTimer = null;
  _committedBgm = null;
  _committedWhoosh = null;
  _pendingRoute = null;
}
