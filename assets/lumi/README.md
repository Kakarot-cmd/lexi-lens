# `assets/lumi/`

This directory holds Rive assets for the Lumi mascot (v6.8+).

## Current contents

| File                          | Purpose                                          | Status     |
| ----------------------------- | ------------------------------------------------ | ---------- |
| `lumi.riv`                    | Compiled Rive state machine + art (mood swap)    | ✅ landed   |
| `LUMI_RIVE_SPEC.md`           | Animator handoff contract (input names, ranges)  | ✅ landed   |
| `CHARACTER_SHEET_BRIEF.md`    | Art prep checklist for Pixelmator + AI workflow  | ✅ landed   |
| `README.md`                   | This file                                        | ✅ landed   |

## `lumi.riv` v6.8 capabilities

The current Rive file implements **mood-swap only**:

- 6 mood timelines (`mood_happy`, `mood_curious`, `mood_excited`, `mood_thinking`, `mood_sad`, `mood_sleeping`)
- 1 state machine (`LumiSM`) with 5 typed inputs declared per `lumiRiveConfig.ts`
- 6 `Any State` → `mood_X` transitions conditioned on `moodIndex == 0..5`
- 300ms ease-in-out cross-fade between moods

**Not yet implemented in `lumi.riv` (planned for v6.9+):**

- `themeIndex` palette swap (normal / hard-mode / sleeping / rainbow)
- `colorTick` rainbow hue rotation
- `reducedMotion` loop suppression (no continuous loops exist yet to suppress)
- `stateIndex` finer-grained behaviour layering

The unused inputs are declared in the state machine so the JS runtime can write
to them without erroring; they're simply ignored in the current `.riv` build.
This means a v6.9 update can be shipped via a new `.riv` file without any JS
change — `LumiBodyRive.tsx` is forward-compatible.

## Why this directory must exist (even when empty of `.riv`)

`components/Lumi/LumiBodyRive.tsx` uses `require.context('../../assets/lumi', false, /\.riv$/)`
to lazily resolve the Rive asset. Metro scans this directory at bundle time:

- Directory missing → bundle fails
- Directory exists, no `.riv` inside → bundle succeeds, runtime fallback to SVG body
- Directory exists, `.riv` inside → loads Rive body when `LUMI_RIVE_ENABLED = true`

That's why this README and the spec docs live here — they keep the directory
non-empty in source control so the bundler is always happy, even after the
`.riv` is checked in.

## Asset budget

| Constraint        | Target               | Actual (v6.8)         |
|-------------------|----------------------|------------------------|
| `lumi.riv` size   | ≤ 500 KB             | 621 KB (within ~25% — acceptable) |
| Render canvas     | 64–96 px target      | Same                   |
| Frame rate        | 60 fps iOS XR / mid-tier Android | Target            |

The 621 KB size uses WebP 75% lossy compression on the 5 embedded master PNGs.
Visual blur from lossy compression is invisible at the 64-96px render size.

## See also

- `components/Lumi/lumiRiveConfig.ts` — feature flag + Rive input contract
- `docs/LUMI_RIVE_INTEGRATION_RUNBOOK.md` — deployment playbook
- `LUMI_RIVE_SPEC.md` — the Rive editor contract
- `CHARACTER_SHEET_BRIEF.md` — art prep workflow
