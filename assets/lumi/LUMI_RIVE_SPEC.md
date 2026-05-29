# `LUMI_RIVE_SPEC.md` — Lumi v6.8 Rive contract & rigging walkthrough

**Scope of this doc:** master PNGs → rigged `lumi.riv` file living at `assets/lumi/lumi.riv`.
**Previous doc:** `CHARACTER_SHEET_BRIEF.md` (art prep).
**Next doc:** `docs/LUMI_RIVE_INTEGRATION_RUNBOOK.md` (build & ship).

This is also the **animator handoff contract**. The runtime code in `components/Lumi/LumiBodyRive.tsx` reads everything declared here verbatim. Drift between this doc and the `.riv` file = runtime input write fails silently. Treat the names/indices below as immutable once shipped.

---

## 1 · The contract (immutable)

Read this section first. The next sections (editor walkthrough) only matter if you're the one rigging the file. The contract matters even if someone else rigs it.

### 1.1 Artboard and state machine names

| Item              | Required value | Code reference                          |
|-------------------|----------------|-----------------------------------------|
| Artboard name     | `Lumi`         | `RIVE_ARTBOARD_NAME` in `lumiRiveConfig.ts`    |
| State machine name| `LumiSM`       | `RIVE_STATE_MACHINE_NAME` in `lumiRiveConfig.ts` |

**Case-sensitive.** A typo here = native module rejects the file at load time → `LumiBodyRive` flips to SVG fallback → flag is effectively never on.

### 1.2 State machine inputs (the 5 typed inputs)

The Rive state machine **MUST** declare exactly these 5 inputs, with these names, these types, and these accepted value ranges. Names from `lumiRiveConfig.ts → RIVE_INPUT`.

| Input name     | Rive type | Range / values    | What drives it from React           | What it must do in the state machine                                                                                |
|----------------|-----------|-------------------|-------------------------------------|---------------------------------------------------------------------------------------------------------------------|
| `moodIndex`    | Number    | 0, 1, 2, 3, 4, 5  | Resolved from `mood` prop via `LUMI_MOOD_INDEX` | Drive base pose (face expression + body posture). See §1.3 table for index→mood.                                |
| `themeIndex`   | Number    | 0, 1, 2, 3        | Resolved from `theme` prop via `LUMI_THEME_INDEX` | Drive palette swap on dress + wings + accessory. See §1.4 table for index→theme.                                |
| `stateIndex`   | Number    | -1, 0..8          | Resolved from optional `state` prop via `LUMI_STATE_INDEX`; `-1` if no `state` prop | Drive finer behaviour layered on top of mood (e.g. `scanning` adds head tilt to `thinking` pose). If `-1`, ignore. |
| `reducedMotion`| Boolean   | true / false      | OS `AccessibilityInfo.isReduceMotionEnabled()` | When `true`, ALL continuous loops (hover, wing flap, hair sway, sparkles) **stop on a static pose**. Mood/theme transitions still apply, but instantly with no tween. |
| `colorTick`    | Number    | 0, 1, 2, 3, 4, 5  | `LumiMascot` colour timer when `theme === 'rainbow'`; otherwise 0 | Only meaningful when `themeIndex === 3` (rainbow). Selects one of 6 hue rotations to apply to dress + wing fills. Ignored otherwise. |

**Drift rule.** Renaming an input here = silently-failing animation. The runtime catches the throw and continues with whatever inputs *did* take — no Sentry breadcrumb, no console error (intentional: SVG fallback is the safety net). **Test by changing each prop in `LumiPlayground.tsx` and watching the rig respond.**

### 1.3 `moodIndex` → mood mapping

| Index | Mood       | Base pose to use      | Face expression                        |
|-------|------------|-----------------------|----------------------------------------|
| 0     | `happy`    | `lumi_idle`           | Soft smile, eyes neutral and bright    |
| 1     | `curious`  | `lumi_idle`           | Slight smirk, one eyebrow raised, eyes wider |
| 2     | `excited`  | `lumi_success`        | Open-mouth smile, eyes wide and shining |
| 3     | `thinking` | `lumi_scanning`       | Closed-mouth, eyes looking up-and-left, slight frown of concentration |
| 4     | `sad`      | `lumi_sad`            | Down-turned mouth, eyes half-lidded, tear visible |
| 5     | `sleeping` | `lumi_sleeping`       | Eyes closed, mouth slightly open, "Zzz" floating above |

### 1.4 `themeIndex` → theme mapping

| Index | Theme         | Palette behaviour                                                              |
|-------|---------------|--------------------------------------------------------------------------------|
| 0     | `normal`      | Default warm gold/amber dress, cream wings, no accessory                       |
| 1     | `hard-mode`   | Crimson dress, pink-tinted wings, gold crown on head                           |
| 2     | `sleeping`    | Muted purple dress, violet-tinted wings, "Zzz" symbol active                   |
| 3     | `rainbow`     | Dress + wing fills cycle through 6 hues driven by `colorTick`. See §1.5.       |

### 1.5 `stateIndex` → state mapping

These are the 9 states from `lumiTypes.ts → LumiState`. Index from `LUMI_STATE_INDEX` in `lumiRiveConfig.ts`. **`stateIndex` is optional** — if the React side doesn't pass it (current LumiMascot doesn't yet), the input arrives as `-1` and the state machine ignores it, falling back to mood-only behaviour. That's the safety design.

| Index | State           | Layer this on top of mood                                                                    |
|-------|-----------------|----------------------------------------------------------------------------------------------|
| 0     | `idle`          | No extra animation. Hover + breathing only.                                                  |
| 1     | `guide`         | Add a gentle "look at user" eye-tracking idle. Wave hand slowly once per 4s.                 |
| 2     | `scanning`      | Add faster wing flap + head tilt. Pose locks to `lumi_scanning` master regardless of mood.   |
| 3     | `looking-up`    | Eyes flick upward, slight head tilt back. Subtle "I'm thinking" effect on top of thinking pose. |
| 4     | `success`       | Pose locks to `lumi_success` master + burst of sparkles around hands for 1.2s.               |
| 5     | `fail`          | Pose locks to `lumi_sad` master + small wing droop. **No exclamation marks, no theatrics.** |
| 6     | `boss-help`     | Pose locks to `lumi_scanning` + glowing outline on body for 800ms-loop.                      |
| 7     | `out-of-juice`  | Pose locks to `lumi_sleeping` + slower hover. No "Zzz" unless `themeIndex === 2` (sleeping theme). |
| 8     | `cheering`      | Pose locks to `lumi_success` + repeated micro-bounces (3 per sec). More animated than plain success. |

### 1.6 Asset budget

| Constraint        | Limit                | Reason                                                                  |
|-------------------|----------------------|-------------------------------------------------------------------------|
| `lumi.riv` size   | ≤ 500 KB             | Bundle bloat. Compresses well; cap is generous for Path A (pose-swap).  |
| Path A bundle     | ~150 KB typical     | 5 PNGs at 1024×1024 + state machine = ~120–180 KB after Rive compression |
| Path B bundle     | ~350 KB typical     | 40+ layers add up. Stay under 500 KB.                                   |
| Render canvas     | 64–96 px target      | Lumi renders at `size={96}` in ScanScreen, `size={64}` elsewhere        |
| Frame rate target | 60 fps on iOS XR / mid-tier Android |  Rive is GPU-accelerated; both platforms comfortable at this size. |

### 1.7 Cross-platform behaviour

`rive-react-native@9.8.3` renders identical pixels on iOS and Android via native bridges to Rive's C++ runtime. There are **no platform-specific assets, no `Platform.OS` branches in art, no fallbacks per-OS.** If you see a behaviour gap between platforms in QA, it's a `rive-react-native` issue, not an asset issue — file upstream rather than working around in the art.

---

## 2 · Rive editor walkthrough (zero-Rive-experience start)

If you're rigging the file yourself, this section. If someone else is rigging it, hand them this doc and stop reading here.

### 2.1 Account + new file setup

1. Go to **rive.app** → Sign up (free tier is fine; the .riv export is unrestricted).
2. New File → "Animation" template → blank artboard.
3. Rename the artboard to `Lumi` (top-left, click the name to edit). Case matters — see §1.1.
4. Set artboard size to **1024 × 1024 px** (right panel → Size).

### 2.2 Import the master PNGs

Path A:

1. Drag all 5 master PNGs (`lumi_idle_master.png` etc.) into the Rive canvas.
2. Each becomes an image asset. **Position all 5 at canvas centre, stacked on top of each other.**
3. In the layer panel (left side), rename each to its pose name (e.g. `lumi_idle`).
4. Set all but `lumi_idle` to opacity 0% (right panel). Idle is visible by default.

Path B:

1. Drag the layer PNGs in **group by pose**. Create a Rive "Group" per pose, drop the 8–13 layer PNGs of that pose into the group.
2. Position layers using the centred 1024×1024 canvas — Pixelmator already did the alignment work.
3. Set all groups except `lumi_idle` to opacity 0%.

### 2.3 Declare the 5 state machine inputs

Right panel → **State Machine** tab → click the small `+` next to "Inputs". For each of the 5 inputs:

| Input        | Type     | Default | Notes                                                                       |
|--------------|----------|---------|-----------------------------------------------------------------------------|
| `moodIndex`  | Number   | 0       | Name MUST be exact. Rive treats input names as case-sensitive identifiers. |
| `themeIndex` | Number   | 0       | Same.                                                                       |
| `stateIndex` | Number   | -1      | Default `-1` means "ignore".                                                |
| `reducedMotion` | Boolean | false  | Toggle, not a number.                                                       |
| `colorTick`  | Number   | 0       | Only consulted when `themeIndex === 3`.                                     |

**Critical:** Rive defaults new state machines to a name like `State Machine 1`. Rename it to `LumiSM` in the State Machine tab (the dropdown at the top of the right panel). Mismatch = native module load failure.

### 2.4 Wire moodIndex → pose swap (Path A)

This is the core animation. We're creating 6 states in the state machine, one per mood, each setting one pose's opacity to 100% and the others to 0%.

1. State machine tab → drag-create 6 states in the graph view: `mood_happy`, `mood_curious`, `mood_excited`, `mood_thinking`, `mood_sad`, `mood_sleeping`.
2. For each state, create a Rive Timeline that sets:
   - The corresponding pose's image opacity to 100%
   - All other 4 poses' opacity to 0%
   - (Curious uses idle pose, so `mood_curious` is identical to `mood_happy` in Path A — that's fine.)
3. Connect each state to the others with transitions. **Condition on each transition: `moodIndex == <target index>`.**
4. Set transition duration: **180ms ease-in-out**. Avoid 0 (jarring) or >300ms (laggy feel).
5. Wrap the whole 6-state mood graph in a **"Mood Layer"** (Rive supports layered state machines; this isolates mood from the next layer).

### 2.5 Wire themeIndex → palette swap (Path A)

Theme palette swap is done with Rive's **Solo blend mode**. Create 4 colour-overlay sublayers per pose (or globally, depending on your skill level):

1. Add a coloured rectangle layer matching the canvas size, set blend mode to **Multiply**, drop opacity to ~30%.
2. Duplicate 4× — one for each theme palette. Colour each per `CHARACTER_SHEET_BRIEF.md` §7 (gold / crimson / muted purple / rainbow base).
3. Create a "Theme Layer" in the state machine with 4 states (`theme_normal`, `theme_hard`, `theme_sleeping`, `theme_rainbow`), each setting one overlay's opacity to 100% and others to 0%.
4. Conditions: `themeIndex == 0/1/2/3`.

For **rainbow** (themeIndex 3), bind the overlay's hue rotation to the `colorTick` input via a Rive constraint: `hue = colorTick * 60°`. (Rive's Constraint system supports this; check community templates for "colour cycle hue rotation".)

### 2.6 Wire stateIndex → behaviour overlay (optional, do later)

For v6.8 first ship, **skip this.** `stateIndex` arrives as `-1` from React (because `LumiMascot` doesn't pass `state` yet), so anything you author here is dead code. Add this in a v6.9 polish pass once mood + theme are shipping clean.

When you do add it, the pattern is the same: a third state machine layer with 9 states, conditions on `stateIndex == 0..8`, each layering on top of the active mood pose.

### 2.7 Wire reducedMotion → freeze loops

Find every continuous animation you've added (hover, wing flap, hair sway, sparkles). For each, add a Rive constraint: `play if reducedMotion == false`. Single boolean gate per loop. ~10 min work, hugely important for accessibility.

### 2.8 Test in the Rive editor before exporting

Rive has a **Preview** mode (top right). Click play, then in the right panel manually toggle each input through its range. Verify:

- [ ] `moodIndex` 0 → 5 cycles through 6 poses smoothly
- [ ] `themeIndex` 0 → 3 swaps palette without flickering
- [ ] `themeIndex = 3` + `colorTick` 0 → 5 cycles rainbow hues
- [ ] `reducedMotion = true` freezes the hover loop on the current pose
- [ ] `stateIndex = -1` keeps mood-based behaviour active (no override)

If any of these fail, fix in editor before exporting. Once exported, fixes require re-exporting and re-bundling the native app.

### 2.9 Export

File → Export → **Runtime (.riv)**. Save as `lumi.riv`. Check file size: should be 100–400 KB for Path A, 200–500 KB for Path B. If over 500 KB, review your image assets — Rive may be embedding them uncompressed.

Drop into `assets/lumi/lumi.riv`. The repo already has the directory and the README placeholder; `require.context()` will pick up the new file on next bundle.

---

## 3 · Verification before flipping the flag

Once `lumi.riv` is in `assets/lumi/`:

1. **Dev rig dry-run** (no rebuild yet): `LUMI_RIVE_ENABLED` is still `false` in `lumiRiveConfig.ts`. Confirm `npx tsc --noEmit` passes and `npx expo export --platform android` still bundles cleanly. (Tests that `require.context()` correctly resolves the new file without breaking the bundle when the flag is off.)
2. **LumiPlayground manual test prep**: in `lumiRiveConfig.ts`, temporarily change `LUMI_RIVE_ENABLED = true` and run on the iOS XR via local Xcode (the native module is now needed — see runbook). Open the dev navigator to LumiPlayground, cycle through all 9 states with all 4 themes. Verify visual parity with the contract above.
3. **Revert the flag to `false`** if shipping the asset commit without the binary change. Or proceed straight to the runbook if shipping both together.

---

## 4 · What to do when something doesn't load

The fallback hierarchy is:

```
LUMI_RIVE_ENABLED = false                  → LumiBodySvg (existing v6.7 art)
LUMI_RIVE_ENABLED = true, .riv missing     → LumiBodySvg (graceful)
LUMI_RIVE_ENABLED = true, native missing   → LumiBodySvg (graceful)
LUMI_RIVE_ENABLED = true, .riv decode fail → LumiBodySvg (graceful — `onError` flips state)
LUMI_RIVE_ENABLED = true, input write fail → Animation continues with stale input value (silent)
LUMI_RIVE_ENABLED = true, all good         → LumiBodyRive renders
```

The first 4 levels are designed-in safety. The 5th (input write fail) is the failure mode you'll want to catch in QA — it manifests as "Lumi looks right but doesn't react to mood changes." Fix by checking input name spelling in Rive against `RIVE_INPUT` in `lumiRiveConfig.ts`.

---

## 5 · Handoff checkpoint

When this doc's steps are complete, you have:

- `assets/lumi/lumi.riv` (the rigged file) committed to the repo
- All 9 states × 4 themes verified in the Rive editor preview
- Bundle still passes `npx expo export` with flag off

Proceed to `docs/LUMI_RIVE_INTEGRATION_RUNBOOK.md` for the native rebuild and flag flip.
