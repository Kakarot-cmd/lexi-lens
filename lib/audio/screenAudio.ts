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

/**
 * Master switch for the screen-change whoosh. OFF by default: a music bed plays
 * continuously, so a sound on every navigation tends to fatigue more than it
 * delights, and tap feedback belongs on buttons rather than global nav. Flip to
 * true to bring it back (optionally swap assets/sounds/sfx/screen_in.mp3 for a
 * cuter pop/twinkle/boop). The leading-edge timing below works either way.
 */
const SCREEN_WHOOSH_ENABLED = false;

// React Navigation's onStateChange can fire several times during a push
// animation, and getCurrentRoute() briefly reports intermediate routes — so a
// single tap can look like map→scan→map→scan. The two cues handle that
// flapping differently, because they have opposite needs:
//
//   • BGM  — switching beds tears the player down and rebuilds it (~350ms iOS
//            load). It must only react to the SETTLED route, so a trailing
//            settle window is right; the latency is inaudible for music.
//   • Whoosh — a UI sound that must feel tied to the tap. So it fires on the
//            LEADING edge — the instant the route first changes — then locks
//            out briefly to swallow the flap, so one tap = one prompt whoosh.
const BGM_SETTLE_MS  = 300;
const WHOOSH_LOCK_MS = 350;

let _committedBgm:    string | null = null;
let _committedWhoosh: string | null = null;
let _pendingRoute:    string | null = null;
let _bgmTimer:    ReturnType<typeof setTimeout> | null = null;
let _whooshLockUntil = 0;

function commitBgm(): void {
  _bgmTimer = null;
  const r = _pendingRoute;
  if (!r || r === _committedBgm) return;
  _committedBgm = r;
  const bed = SCREEN_BGM[r];
  if (bed) void startBgm(bed); // engine no-ops if it's already the active bed
}

function fireWhoosh(route: string): void {
  if (route === _committedWhoosh) return;            // same screen — nothing to do
  const wasFirst = _committedWhoosh === null;        // never whoosh INTO the first screen
  const now = Date.now();
  if (now < _whooshLockUntil) {                      // mid-transition flap: track, don't fire
    _committedWhoosh = route;
    return;
  }
  _committedWhoosh = route;
  _whooshLockUntil = now + WHOOSH_LOCK_MS;
  if (SCREEN_WHOOSH_ENABLED && !wasFirst && !NO_ENTRY_SFX.has(route)) playSfx('screen_in');
}

/**
 * Call on every navigation state change with the active route name.
 * The whoosh commits fast (feels tied to the tap); the music bed commits on a
 * longer settle (no player teardown thrash). Both coalesce mid-transition flaps.
 */
export function onScreenChange(routeName: string | null | undefined): void {
  if (!routeName) return;
  _pendingRoute = routeName;
  fireWhoosh(routeName);                    // leading-edge → instant, tied to the tap
  if (_bgmTimer) clearTimeout(_bgmTimer);   // BGM still settles (player swap is costly)
  _bgmTimer = setTimeout(commitBgm, BGM_SETTLE_MS);
}

/** Reset (e.g. on sign-out) so the next cold navigation isn't treated as a transition. */
export function resetScreenAudio(): void {
  if (_bgmTimer) clearTimeout(_bgmTimer);
  _bgmTimer = null;
  _whooshLockUntil = 0;
  _committedBgm = null;
  _committedWhoosh = null;
  _pendingRoute = null;
}
