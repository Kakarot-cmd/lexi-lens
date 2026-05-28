# `assets/lumi/`

This directory holds Rive assets for the Lumi mascot.

## Expected contents

| File                          | Purpose                                          | Required?              |
| ----------------------------- | ------------------------------------------------ | ---------------------- |
| `lumi.riv`                    | The compiled Rive state machine + art           | When `LUMI_RIVE_ENABLED = true` |
| `LUMI_RIVE_SPEC.md`           | Animator handoff contract (input names, ranges)  | Always                 |
| `CHARACTER_SHEET_BRIEF.md`    | Art prep checklist for Pixelmator + AI workflow  | Always                 |
| `character_sheet_front.psd`   | Locked Lumi design (master ref for AI cref)      | Recommended            |
| `layers/`                     | Per-pose PNG layer exports for Rive import       | Pre-Rive               |

## Why this directory must exist (even when empty of `.riv`)

`components/Lumi/LumiBodyRive.tsx` uses `require.context('../../assets/lumi', false, /\.riv$/)`
to lazily resolve the Rive asset. Metro scans this directory at bundle time:

- Directory missing → bundle fails
- Directory exists, no `.riv` inside → bundle succeeds, runtime fallback to SVG body
- Directory exists, `.riv` inside → loads Rive body when `LUMI_RIVE_ENABLED = true`

That's why this README and the spec docs live here — they keep the directory
non-empty in source control so the bundler is always happy, even before art lands.

## See also

- `components/Lumi/lumiRiveConfig.ts` — feature flag + Rive input contract
- `docs/LUMI_RIVE_INTEGRATION_RUNBOOK.md` — deployment playbook
