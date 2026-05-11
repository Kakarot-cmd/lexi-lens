/**
 * components/Lumi/lumiSoundAssets.ts
 *
 * Lumi's audio asset require map.
 *
 * ─── HOW TO ENABLE SOUNDS ────────────────────────────────────────────────────
 *
 *   1. Place 7 MP3 files at:
 *        assets/sounds/lumi/lumi-appear.mp3
 *        assets/sounds/lumi/lumi-scan.mp3
 *        assets/sounds/lumi/lumi-success.mp3
 *        assets/sounds/lumi/lumi-fail.mp3      (optional — kept silent by default)
 *        assets/sounds/lumi/lumi-sleep.mp3
 *        assets/sounds/lumi/lumi-cheer.mp3
 *        assets/sounds/lumi/lumi-greet.mp3
 *
 *   2. `npx expo install expo-audio`
 *
 *   3. Uncomment the require() lines below.
 *
 *   4. In App.tsx (or wherever you bootstrap):
 *        import { initLumiSounds } from '@/components/Lumi';
 *        useEffect(() => { initLumiSounds(); }, []);
 *
 *   5. Wire a parent-controlled toggle in ParentDashboard:
 *        await setLumiSoundEnabled(true);
 *
 * Until step 3 is done, the Lumi mascot still works — sounds are just no-ops,
 * haptics still fire (haptics are silent and never need parent opt-in).
 *
 * Asset spec:  see SOUND_ASSETS.md in this folder.
 */

import type { LumiSoundKey } from './lumiSounds';

export const LUMI_SOUND_ASSETS: Partial<Record<LumiSoundKey, number>> = {
  // ── v6.5 — full rotating-pool asset map (23 clips) ──────────────────────

  // Single-shot SFX
  appear:                require('../../assets/sounds/lumi/lumi-appear.mp3'),
  scan:                  require('../../assets/sounds/lumi/lumi-scan.mp3'),
  sleep:                 require('../../assets/sounds/lumi/lumi-sleep.mp3'),
  cheer:                 require('../../assets/sounds/lumi/lumi-cheer.mp3'),

  // Greet pool (5 — one picked per first-open-of-day)
  greet_01:              require('../../assets/sounds/lumi/lumi-greet-01.mp3'),
  greet_02:              require('../../assets/sounds/lumi/lumi-greet-02.mp3'),
  greet_03:              require('../../assets/sounds/lumi/lumi-greet-03.mp3'),
  greet_04:              require('../../assets/sounds/lumi/lumi-greet-04.mp3'),
  greet_05:              require('../../assets/sounds/lumi/lumi-greet-05.mp3'),

  // Scan-dialogue pool (5 — voiced "Hmm... let me see..." rotation during evaluation)
  scan_dialogue_01:      require('../../assets/sounds/lumi/lumi-scan-dialogue-01.mp3'),
  scan_dialogue_02:      require('../../assets/sounds/lumi/lumi-scan-dialogue-02.mp3'),
  scan_dialogue_03:      require('../../assets/sounds/lumi/lumi-scan-dialogue-03.mp3'),
  scan_dialogue_04:      require('../../assets/sounds/lumi/lumi-scan-dialogue-04.mp3'),
  scan_dialogue_05:      require('../../assets/sounds/lumi/lumi-scan-dialogue-05.mp3'),

  // Success pool (3 — main + 2 alts)
  success:               require('../../assets/sounds/lumi/lumi-success.mp3'),
  success_alt_01:        require('../../assets/sounds/lumi/lumi-success-alt-01.mp3'),
  success_alt_02:        require('../../assets/sounds/lumi/lumi-success-alt-02.mp3'),

  // Fail pool (3 — encouraging only, never punitive)
  fail:                  require('../../assets/sounds/lumi/lumi-fail.mp3'),
  fail_encourage_01:     require('../../assets/sounds/lumi/lumi-fail-encourage-01.mp3'),
  fail_encourage_02:     require('../../assets/sounds/lumi/lumi-fail-encourage-02.mp3'),

  // Boss-help pool (3 — gentle hint after 3 failed attempts)
  boss_hint_01:          require('../../assets/sounds/lumi/lumi-boss-hint-01.mp3'),
  boss_hint_02:          require('../../assets/sounds/lumi/lumi-boss-hint-02.mp3'),
  boss_hint_03:          require('../../assets/sounds/lumi/lumi-boss-hint-03.mp3'),
};
