# Game Audio — Asset Spec & Sourcing (`lib/audio/SOUND_ASSETS.md`)

This module ships with **synthesized placeholder audio** so the system compiles
and is audible on-device today. The placeholders are deliberately gentle, but
they are *programmer art* (ffmpeg tones), not final assets. Replace each file
**in place, keeping the exact filename** — no code changes needed.

This module is the sibling of `components/Lumi/SOUND_ASSETS.md`. Lumi owns the
mascot **voice**; this owns the **music bed** and **UI/feedback SFX**.

---

## Format contract

| Property | Value |
|---|---|
| Container/codec | MP3 (matches the existing Lumi clips; broad RN support) |
| Sample rate | 44.1 kHz |
| Channels | Mono is fine for SFX; stereo OK for BGM |
| Loudness | Pre-level so SFX sit ~ at Lumi voice level; BGM is trimmed to a bed in-engine (`BGM_VOLUME = 0.32`) |
| BGM loop | Must loop **seamlessly** — match start/end amplitude, no edge fades |

If you change a filename or add a cue, update the `require()` map in
`lib/audio/gameAudioAssets.ts` and the `SfxKey` / `BgmKey` unions in
`lib/audio/gameAudio.ts`.

---

## SFX — `assets/sounds/sfx/`

| File | Key | When it fires | Target feel | Placeholder |
|---|---|---|---|---|
| `tap.mp3` | `tap` | Generic button press (call `playSfx('tap')`) | Soft, short, ~80–150 ms | ✅ |
| `screen_in.mp3` | `screen_in` | Screen entry (auto, via `onScreenChange`) | Gentle whoosh, ~300–500 ms | ✅ |
| `success.mp3` | `success` | Correct scan (auto, under Lumi voice) | Bright rising chime | ✅ |
| `fail.mp3` | `fail` | Incorrect scan (auto, under Lumi voice) | Soft, *encouraging* — never harsh | ✅ |
| `xp.mp3` | `xp` | XP / coin pickup (call `playSfx('xp')`) | Quick sparkle | ✅ |
| `quest_clear.mp3` | `quest_clear` | Victory screen reveal (auto) | Triumphant fanfare, ~1–2 s | ✅ |
| `achievement.mp3` | `achievement` | Badge unlock (call `playSfx('achievement')`) | Warm shimmer | ✅ |
| `error.mp3` | `error` | Rate-limit / error (call `playSfx('error')`) | Soft low boop, not alarming | ✅ |

## BGM — `assets/sounds/bgm/` (looping beds)

| File | Key | Screens | Target feel | Placeholder |
|---|---|---|---|---|
| `bgm_map.mp3` | `map` | QuestMap, ChildSwitcher, SpellBook, QuestGenerator, ParentDashboard | Warm, adventurous, low-key | ✅ |
| `bgm_scan.mp3` | `scan` | Scan | Sparse, focused | ✅ |
| `bgm_menu.mp3` | `menu` | Auth, Onboarding, Backstory, Paywall | Gentle welcome | ✅ |

Screen→bed mapping lives in `lib/audio/screenAudio.ts`.

---

## Wiring already done (auto, no extra calls)

- Per-screen **BGM** + **entry whoosh** — `App.tsx` `onStateChange` → `onScreenChange`.
- **success / fail** stings — layered at the single `LumiMascot` state chokepoint.
- **quest_clear** fanfare — `VictoryFusionScreen` on reveal.
- App background → BGM pause; foreground → resume.

## Optional one-liners (sprinkle where you want them)

```
import { playSfx } from '../lib/audio';

playSfx('tap');          // any TouchableOpacity onPress
playSfx('xp');           // when XP/coins are awarded
playSfx('achievement');  // AchievementToast mount
playSfx('error');        // RateLimitWall mount
```

---

## Royalty-free sourcing (kid-safe, license-clean)

Composition / one-off SFX:
- **Kenney.nl** — CC0 game audio packs (UI, casual). Zero-attribution, ideal for placeholders→final.
- **Freesound.org** — filter by CC0; check each license.
- **Pixabay Music / Sound Effects** — royalty-free, commercial-OK.
- **Incompetech (Kevin MacLeod)** — CC-BY loops; gentle "kids/adventure" beds (attribution required — add to credits).
- **OpenGameArt.org** — filter CC0.

For a children's product, keep beds **under ~0.35 perceived loudness**, avoid
sudden transients, and make `fail` reassuring rather than punishing — the
placeholders are tuned that way as a reference.

> **Before shipping to stores:** confirm every replacement's license permits
> commercial use and note any attribution in the app credits.
