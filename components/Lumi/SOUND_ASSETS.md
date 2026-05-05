# Lumi Sound Asset Spec

7 short SFX files. Place them at `assets/sounds/lumi/`, then uncomment the require lines in `lumiSoundAssets.ts`.

## Format (all files)

| Setting | Value |
|---|---|
| Container | `.mp3` (best cross-platform support in `expo-audio`) |
| Sample rate | 44.1 kHz |
| Bit rate | 128 kbps |
| Channels | Mono is fine for SFX (smaller bundle) |
| Loudness target | −18 LUFS integrated, −1 dBTP true peak |
| Master key | C major pentatonic (so cues never clash if two fire close together) |
| Attack | Soft (avoid hard transients — they sound aggressive on phone speakers) |

## The 7 cues

| File | Used when | Vibe | Duration | Notes |
|---|---|---|---|---|
| `lumi-appear.mp3` | Lumi enters / `guide` / `boss-help` | Soft chime, "ting", magical reveal | ~250 ms | One bell-like note + gentle reverb tail |
| `lumi-scan.mp3` | While `scanning` (Edge Function evaluating) | Ambient sparkle, wind-chime arpeggio | ~800 ms | Plays once per scan, NOT looped |
| `lumi-success.mp3` | Verdict matched | Bright ding + sparkle "swish" | ~400 ms | Should feel like a small reward, not a fanfare |
| `lumi-fail.mp3` | Verdict mismatch | (kept silent by default — file is optional) | ~250 ms | If included, soft single low "boop" — never harsh |
| `lumi-sleep.mp3` | `out-of-juice` (rate-limit hit) | Wind-down, descending soft notes | ~600 ms | Sleepy, content — not sad |
| `lumi-cheer.mp3` | `cheering` (quest victory overlay) | Mini fanfare, ascending arpeggio | ~800 ms | The biggest sound in the pack — celebratory, brief |
| `lumi-greet.mp3` | First open of the day | Sunrise chime, two soft notes rising | ~500 ms | Plays once per local calendar day (see lumiGreeting.ts) |

## Free / royalty-free sources

| Source | License | Notes |
|---|---|---|
| [freesound.org](https://freesound.org) | Filter to CC0 (public domain) or CC-BY (attribution) | Search: "soft chime", "fairy sparkle", "wind chime mallet" |
| [Mixkit](https://mixkit.co/free-sound-effects/) | Royalty-free, no attribution required | Categories: Game / Magic / UI |
| [Zapsplat](https://www.zapsplat.com) | Free with account, attribution required on free tier | Better quality; UI/Magic categories |
| [Pixabay sound effects](https://pixabay.com/sound-effects/) | Pixabay license (no attribution) | Search: "fairy", "magical", "chime" |

## Generating placeholders quickly (so the bundle ships)

If you want to wire everything up before sourcing real audio, drop in 200ms of silence per file. ffmpeg one-liner:

```bash
mkdir -p assets/sounds/lumi
for n in appear scan success fail sleep cheer greet; do
  ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t 0.2 \
    -q:a 9 -acodec libmp3lame "assets/sounds/lumi/lumi-$n.mp3"
done
```

Or with sox:

```bash
for n in appear scan success fail sleep cheer greet; do
  sox -n -r 44100 -c 1 "assets/sounds/lumi/lumi-$n.mp3" trim 0 0.2
done
```

## QA checklist

- [ ] All 7 files exist at `assets/sounds/lumi/`
- [ ] All require lines uncommented in `lumiSoundAssets.ts`
- [ ] `expo-audio` installed via `npx expo install expo-audio`
- [ ] `initLumiSounds()` called once in App.tsx
- [ ] Toggle exposed in ParentDashboard (calls `setLumiSoundEnabled`)
- [ ] iOS silent switch respected — verify by flipping iPhone ringer off and confirming no audio
- [ ] Android volume rocker controls SFX volume (it should — uses media stream by default)
- [ ] Loudness consistent across cues (no jumpscare from one being louder)
- [ ] All cues are one-shot (no infinite scan-loop nightmare)
- [ ] No SFX on `idle` or `fail` states
