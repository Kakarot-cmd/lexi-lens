/**
 * lib/audio/gameAudioAssets.ts
 *
 * require() map for game-wide audio: looping background-music beds (BGM) and
 * one-shot sound effects (SFX). This is the SISTER of components/Lumi/
 * lumiSoundAssets.ts — Lumi owns the mascot's *voice*; this module owns the
 * *music bed* and the *UI / game-feedback* sounds that play between Lumi's
 * barks (button taps, screen entry, success/fail stings, victory fanfare …).
 *
 * ─── PLACEHOLDER ASSETS — READ THIS ───────────────────────────────────────────
 *   Every file referenced below currently ships as a synthesized PLACEHOLDER
 *   (ffmpeg tone art) so the engine compiles and is audible on-device today.
 *   They are intentionally gentle but they are NOT final art. Swap each file
 *   in place — keep the exact same filename — with a licensed, kid-friendly
 *   asset and NOTHING in code has to change. See lib/audio/SOUND_ASSETS.md for
 *   the per-file spec, duration targets, and royalty-free sourcing.
 *
 * ─── ADDING / REMOVING A CUE ──────────────────────────────────────────────────
 *   1. Drop the .mp3 in assets/sounds/sfx/ or assets/sounds/bgm/.
 *   2. Add a key to SfxKey / BgmKey (in gameAudio.ts) and a require() line here.
 *   3. (SFX) optionally map a screen/event to it in screenAudio.ts or call
 *      playSfx('yourKey') at the trigger site.
 *
 * NOTE: Metro statically resolves require(); a require() to a missing file
 *       FAILS THE BUILD. Only list files that actually exist on disk.
 */

import type { BgmKey, SfxKey } from './gameAudio';

/** Looping background-music beds. One long-lived player, crossfaded on change. */
export const BGM_ASSETS: Record<BgmKey, number> = {
  map:  require('../../assets/sounds/bgm/bgm_map.mp3'),
  scan: require('../../assets/sounds/bgm/bgm_scan.mp3'),
  menu: require('../../assets/sounds/bgm/bgm_menu.mp3'),
};

/** One-shot sound effects. Lazy players + LRU, identical to the Lumi pattern. */
export const SFX_ASSETS: Record<SfxKey, number> = {
  tap:         require('../../assets/sounds/sfx/tap.mp3'),
  screen_in:   require('../../assets/sounds/sfx/screen_in.mp3'),
  success:     require('../../assets/sounds/sfx/success.mp3'),
  fail:        require('../../assets/sounds/sfx/fail.mp3'),
  xp:          require('../../assets/sounds/sfx/xp.mp3'),
  quest_clear: require('../../assets/sounds/sfx/quest_clear.mp3'),
  achievement: require('../../assets/sounds/sfx/achievement.mp3'),
  error:       require('../../assets/sounds/sfx/error.mp3'),
};
