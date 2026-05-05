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
  // ── Uncomment after files are in place ──────────────────────────────────
  // appear:  require('../../assets/sounds/lumi/lumi-appear.mp3'),
  // scan:    require('../../assets/sounds/lumi/lumi-scan.mp3'),
  // success: require('../../assets/sounds/lumi/lumi-success.mp3'),
  // fail:    require('../../assets/sounds/lumi/lumi-fail.mp3'),
  // sleep:   require('../../assets/sounds/lumi/lumi-sleep.mp3'),
  // cheer:   require('../../assets/sounds/lumi/lumi-cheer.mp3'),
  // greet:   require('../../assets/sounds/lumi/lumi-greet.mp3'),
};
