# Lumi — Lexi-Lens Mascot

> *Lumi is a tiny spark of word-magic. Long ago, when the first stories were spoken, a little glow leaked out of every word and floated into the world. Lumi is the friendliest of those glows. She lives inside your Lens, and helps you see the magic in everyday things. When her spark runs low, she rests in the Tome until sunrise.*

---

## Why she exists

| Problem | How Lumi solves it |
|---|---|
| 1–3 second wait while ML Kit + Claude evaluate feels like dead air | She orbits the scan target with a glitter trail — the wait becomes "the magic happening" |
| `RateLimitWall.tsx` is a hard stop with no charm | She droops, dims, and says her spark is fizzled — turns the stop into a daily ritual hook |
| "Try again" feels punitive on failure | A sad-but-cute fairy softening the blow — keeps kids engaged through misses |
| The brand is faceless | A named character every parent and kid recognises — opens stickers, plushies, marketing |
| Anonymous AI assistants make parents nervous | A consistent friendly mascot signals curation and child-safety |

---

## Files in this folder

```
components/Lumi/
├─ index.ts                ← barrel export, import from here
├─ lumiTypes.ts            ← types: states, themes, props, animation profiles
├─ lumiQuotes.ts           ← speech-line dictionary keyed by intent
├─ lumiGreeting.ts         ← AsyncStorage helper for daily good-morning
├─ lumiSounds.ts           ← sound + haptic dispatcher (expo-audio optional)
├─ lumiSoundAssets.ts      ← MP3 require map (commented out by default)
├─ LumiBody.tsx            ← SVG body (react-native-svg), mood expressions, wing flap
├─ LumiTrail.tsx           ← glitter particle pool (12 max), Reanimated drift+fade
├─ LumiSpeechBubble.tsx    ← auto-dismiss bubble with tail
├─ LumiMascot.tsx          ← orchestrator — composes the above + sound dispatch
├─ LumiHUD.tsx             ← high-level wrapper for screens (recommended entry)
├─ LumiPlayground.tsx      ← dev-only preview of all 8 states
├─ README.md               ← you are here
├─ SOUND_ASSETS.md         ← spec for the 7 SFX files
└─ INTEGRATION_PATCHES.md  ← surgical patches for ScanScreen + 5 other screens
```

No new dependencies required to ship. Uses what's already in `package.json`:
`react-native-svg`, `react-native-reanimated@4.1.1`, `react-native-safe-area-context`,
`@react-native-async-storage/async-storage`, `expo-haptics`.

Optional: add `expo-audio` later when you want sound. Module degrades cleanly without it.

---

## Quick start

**Step 1.** Drop `components/Lumi/` into your project.

**Step 2.** Drop the new `App.tsx` into your repo root (replaces existing).

**Step 3.** Apply the 6 surgical patches in `INTEGRATION_PATCHES.md` to your existing screens (ScanScreen, RateLimitWall, OnboardingScreen, VictoryFusionScreen, QuestMapScreen, ParentDashboard). Each patch is 2-4 lines.

**Step 4.** Run on Android. Lumi appears, haptics fire, no sound (parent opt-in).

**Step 5 (optional, future).** When you want sound: install `expo-audio`, drop in 7 MP3s (spec in `SOUND_ASSETS.md`), uncomment the require lines in `lumiSoundAssets.ts`. Parents flip the toggle in ParentDashboard.

---

## State machine

| State | When to use | Visual |
|---|---|---|
| `idle` | Default ambient (QuestMap, SpellBook) | Gentle vertical bob |
| `guide` | Onboarding, first-time tooltips | Pulses with bubble + curious eyes |
| `scanning` | While `useLexiEvaluate` is awaiting Edge Function | Orbits 22px radius, glitter trail |
| `success` | Verdict matched | One-shot bounce + glitter burst |
| `fail` | Verdict no match | Gentle tilt, no trail, encouraging line |
| `boss-help` | Stuck after 3 failed scans on a quest | Hint bubble, light trail |
| `out-of-juice` | Rate-limit hit (HTTP 429 or `_rateLimit.limitReached`) | Asleep, dim, sleeping theme |
| `cheering` | Quest complete (overlay during VictoryFusionScreen) | Big jumps + lots of trail |

---

## Integration — per screen

All snippets are conceptual; the LumiMascot is a single component you drop into a screen. It overlays via `position="absolute"` with `pointerEvents="box-none"` so it never blocks touches except on its own body.

### 1. ScanScreen.tsx — the headline placement

```tsx
import { LumiMascot } from '@/components/Lumi';
// inside render, alongside camera:
<LumiMascot
  state={isEvaluating ? 'scanning' : 'idle'}
  hardMode={isHardMode}
  position="top-right"
/>
```

`isEvaluating` should be the boolean already exposed by `useLexiEvaluate`. After the Edge Function returns, briefly set state to `success` or `fail` (~1.2s) before going back to `idle`.

### 2. RateLimitWall.tsx — the daily-ritual hook

```tsx
<LumiMascot
  state="out-of-juice"
  position="top-center"
  size={96}                       // bigger here, she's the focus
/>
```

She'll show with the sleeping bubble line by default. The bubble does NOT auto-dismiss in this state (`durationMs={0}`).

### 3. OnboardingScreen.tsx — first-time guide

```tsx
<LumiMascot state="guide" message="Hi! I'm Lumi. Let's find magic in the world ✨" position="top-center" size={80} />
```

Walk through 3-4 onboarding steps by changing `message` per step.

### 4. QuestMapScreen.tsx — ambient brand presence

```tsx
<LumiMascot state="idle" position="bottom-right" size={48} />
```

Subtle, always there. Long-press to mute for the session.

### 5. VictoryFusionScreen.tsx — overlay cheering

```tsx
<LumiMascot
  state="cheering"
  hardMode={isHardMode}
  position="top-center"
  size={72}
/>
```

Renders on top of the existing `Boom.json` Lottie. The fusion animation stays the hero; Lumi is the cheering sidekick.

### 6. App.tsx — daily greeting bootstrap

```tsx
import { shouldGreetToday, markGreetedToday } from '@/components/Lumi';

useEffect(() => {
  shouldGreetToday().then(yes => {
    if (yes) {
      // show a one-off LumiMascot with state="guide" and the greeting line
      // dismiss after ~4s, then call markGreetedToday()
    }
  });
}, []);
```

Greeting line pool is in `lumiQuotes.ts → greeting`.

---

## Wiring the rate-limit detection

The Edge Function (per `supabase/functions/evaluate/index.ts`) already returns:
- HTTP 429 with body `{ error: 'rate_limit_exceeded', code: 'DAILY_QUOTA', ... }` when blocked
- HTTP 200 with `_rateLimit: { scansToday, dailyLimit, approachingLimit, limitReached }` on every successful scan

**Recommended flow:**

1. In `useLexiEvaluate.ts`, expose `dailyLimitReached: boolean` derived from either the 429 or `result._rateLimit.limitReached`.
2. ScanScreen reads this and routes to `<RateLimitWall />` when true.
3. RateLimitWall renders `<LumiMascot state="out-of-juice" />`.

When `approachingLimit` is true (≥ 80% of quota), surface that too — Lumi can briefly say `"Sparks getting low... a few left ✨"` via `<LumiMascot state="boss-help" message="Sparks getting low — a few scans left today" />`.

---

## Design choices worth knowing

- **No new global state.** LumiMascot is purely presentational — every screen owns its Lumi instance. Avoids Zustand reshape risk.
- **No hooks-in-map** in the trail — fixed pool of 12 `<Particle/>` components, each owns its own hooks.
- **All transforms on UI thread** for body internals (bob, blink, wing flap). Orbit motion is the only JS-side animation — runs only in `scanning` and `cheering` (~16ms interval).
- **Reduce Motion is honored** via `useReducedMotion()` from Reanimated. Drops bob, glitter, orbit. Body still renders with mood expression.
- **Long-press to mute.** Local-only — doesn't affect the prop. Useful for sensory-sensitive kids without forcing parents into settings.
- **Hard-mode variant** — automatic when `hardMode={true}`. Body switches to red gradient + crown overlay (matches existing VictoryFusionScreen red/crown variant).
- **Out-of-juice is a theme too** — sleeping eyes (closed arcs), dim grey body, tiny zZz, scale 0.85.
- **Bubble side auto-flips** — if Lumi is on the right half of the screen, bubble appears on her left, and vice versa.
- **Edge insets respected** — uses `react-native-safe-area-context` so she never sits under the notch or home indicator.

---

## Sound + haptics

| Subsystem | Default | Library | Notes |
|---|---|---|---|
| Haptics | **ON** | `expo-haptics` (already in `package.json`) | Silent, never bothers bystanders. Light impact on appear, selection on scan, success-notification on match, warning-notification on rate-limit. **No haptic on `fail`** — never punish kids for trying. |
| Sound | **OFF** (parent opt-in) | `expo-audio` (optional add) | Default off because kids play in cars, libraries, etc. Parent flips it on in ParentDashboard. **No sound on `idle` or `fail`.** |

### Wiring

In `App.tsx`:

```tsx
import { initLumiSounds } from '@/components/Lumi';
useEffect(() => { initLumiSounds(); }, []);
```

In `ParentDashboard.tsx` (add a toggle row):

```tsx
import {
  setLumiSoundEnabled, setLumiHapticsEnabled,
  isLumiSoundEnabled,  isLumiHapticsEnabled,
  isLumiAudioAvailable,
} from '@/components/Lumi';

// Hide the sound row if expo-audio isn't installed yet:
{isLumiAudioAvailable() && (
  <Switch value={isLumiSoundEnabled()} onValueChange={setLumiSoundEnabled} />
)}
<Switch value={isLumiHapticsEnabled()} onValueChange={setLumiHapticsEnabled} />
```

### Asset spec

See [`SOUND_ASSETS.md`](./SOUND_ASSETS.md) for the 7 SFX files (durations, vibe, free sources, an ffmpeg one-liner for placeholders).

### Module degradation

If `expo-audio` isn't installed, `lumiSounds.ts` catches the require failure and:
- All `play*` calls become silent no-ops for sound
- Haptics still fire normally
- `isLumiAudioAvailable()` returns `false` so the sound toggle in ParentDashboard can hide itself

This means you can ship Lumi today with haptics-only and add audio in a later release without touching `LumiMascot.tsx`.

---



| Resource | Cost |
|---|---|
| New JS modules | 8 files, ~700 LOC total |
| Native deps | 0 (uses existing) |
| Bundle delta | ~6–8 KB minified (no Lottie assets) |
| Per-frame JS work | 0 in idle / fail / out-of-juice states |
| Per-frame JS work | ~1 setState/16ms only during scanning + cheering |
| Glitter particles | Capped at 12 concurrent |

---

## Future enhancements (Phase 2+)

1. **Voice-over** — `expo-speech` to read bubbles aloud for pre-readers (ages 5-7). Toggle in ParentDashboard.
2. **Sticker pack** — render Lumi at high res into PNG stickers and hand the file to `expo-sharing` for "share Lumi" social hook.
3. **Lumi-of-the-day moods** — random mood variants (excited Monday, sleepy Friday) to give regulars a nudge of novelty.
4. **Mascot cosmetics tied to mastery tiers** — Apprentice Lumi → Sage Lumi cosmetic upgrades as the kid progresses (links to the existing tier system).
5. **Lumi in ParentDashboard** — different mood/copy aimed at parents ("Your kid mastered 3 words today!").
6. **Quest-specific hint pool** — pull hint text from `quests.required_properties` so `boss-help` says `"think about texture"` when texture is the missing property.

---

## QA checklist before shipping

- [ ] Renders on Android (primary platform, your active deploy target)
- [ ] Renders on iOS (when iOS build resumes)
- [ ] Honors Reduce Motion (Settings → Accessibility on Android)
- [ ] Long-press mute works and persists for the session only
- [ ] Bubble never blocks touches (camera scan button still hot)
- [ ] Glitter trail under 12 particles at all times
- [ ] No memory leak on rapid state cycling (mount LumiPlayground, switch states 100×)
- [ ] Hard-mode crown shows on isHardMode quests
- [ ] Out-of-juice fires on HTTP 429 and on `_rateLimit.limitReached`
- [ ] Daily greeting fires once per local calendar day, not per app open

---

## Why "Lumi"

Considered ~20 names against five filters: India-market pronunciation (your primary market), 2-syllable rhythm (kid-sticky), trademark cleanness, semantic match to *seeing/light/lens*, brand cohesion with "Lexi-Lens".

**Lumi wins because:**
- *Lumi-Lens* alliterates with the app name → instant brand cohesion, free marketing
- Lumen = light in Latin; she's literally the spark inside your Lens
- LOO-mee — pronounceable identically in Hindi, Tamil, Telugu, English
- Two soft syllables, trochaic stress (the rhythm pattern behind every sticky kids' brand)
- Maps perfectly to the rate-limit metaphor: *"out of light"* = *"out of juice"*
- Trademark-clean in edtech/kids categories

**Runners-up:** Mira (Indian cultural resonance), Glim (glimmer-derived, original), Wisp (will-o-the-wisp, magical solitary feel).
