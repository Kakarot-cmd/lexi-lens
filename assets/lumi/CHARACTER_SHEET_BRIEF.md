# `CHARACTER_SHEET_BRIEF.md` — Lumi v6.8 art prep (prompt → master PNGs)

**Scope of this doc:** zero → 5 pose-locked master PNGs ready for Rive import.
**Next doc:** `LUMI_RIVE_SPEC.md` (PNGs → rigged `.riv`).
**Tools assumed available:** Pixelmator Pro (macOS), Adobe Express Premium (Firefly), an AI image generator with character reference (Midjourney recommended; Firefly Style Reference as fallback).

---

## 0 · The standing decision (do not deviate)

Per `LexiLens_Roadmap_v7_5.html` §Lumi v6.8: the pipeline is **AI-generate → Pixelmator Pro cleanup + layer separation → Rive AI/Community templates + custom rigging**. **5 character-sheet PNGs locked first** before any rigging starts.

The single biggest failure mode in this work is **inconsistent characters across poses** — 5 prompts run independently produce 5 different fairies. Everything in this doc exists to prevent that.

---

## 1 · The 5 poses (locked list)

These are the canonical 5. Map directly to the 6 moods in `lumiRiveConfig.ts` (we double up `happy`/`excited` and re-use `idle` for `curious`/`thinking` mood swaps in code):

| # | Pose name        | Rive mood lookup | Description                                                                                  |
|---|------------------|------------------|----------------------------------------------------------------------------------------------|
| 1 | `lumi_idle`      | happy / curious  | Floating, neutral smile, wings half-open, slight hover. **Master reference pose** — everything else descends from this one. |
| 2 | `lumi_scanning`  | thinking         | Head tilted, one hand near brow shielding eyes, wings beating faster (motion blur OK), looking forward and slightly down. |
| 3 | `lumi_success`   | excited          | Arms up in celebration, eyes wide and bright, wings fully spread, sparkles around hands.     |
| 4 | `lumi_sad`       | sad              | Head down, wings drooping, small tear at corner of eye, shoulders forward. Subtle, not theatrical. |
| 5 | `lumi_sleeping`  | sleeping         | Eyes closed, "Zzz" symbol, body curled, wings folded, peaceful expression.                  |

The Rive state machine maps **9 `stateIndex` values** to combinations of these 5 poses + animation modifiers (see `LUMI_RIVE_SPEC.md`). You don't draw 9 poses — you draw 5 and let Rive interpolate.

---

## 2 · Character lock — the master reference image

**Step 2.1.** Generate `lumi_idle` first. This is the **master reference (cref)** that locks every subsequent pose to the same character.

### Master prompt (use verbatim, tune temperature/style only)

```
A cute young fairy mascot for a children's vocabulary learning app,
chibi proportions (big head, small body), 
warm gold and amber dress with soft glow,
translucent butterfly-shaped wings with subtle iridescent veins,
short tousled chestnut hair,
large round expressive eyes (hazel),
small upturned nose, gentle smile,
hovering pose, arms relaxed at sides,
full body visible, head-to-toe centered in frame,
solid #20143a deep purple background,
soft front lighting, no harsh shadows,
illustration style, flat-shaded with subtle gradients,
clean linework, no photorealism,
no text, no logos, no UI elements
--ar 1:1 --style raw --v 6
```

### Tool-specific notes

| Tool                    | Approach                                                                                              |
|-------------------------|-------------------------------------------------------------------------------------------------------|
| **Midjourney**          | Run the prompt. Pick the strongest output (clearest face, symmetrical wings). Get the image URL — that's your `--cref <url>` anchor for poses 2–5. |
| **Adobe Express / Firefly** | Generate idle pose, then use **Style Reference** with that exact image for poses 2–5. Firefly's character consistency is weaker than Midjourney's `--cref`; budget extra retries. |
| **Other (DALL-E, etc.)** | If no cref equivalent exists, generate idle in your tool of choice, then use **Pixelmator Pro's Generative Fill** in subsequent poses by *editing* the idle PNG (move arms, close eyes) instead of re-generating from scratch. Highest consistency, slowest workflow. |

### Reject-and-regenerate criteria for the idle master

Before locking the idle as the cref, the master must satisfy ALL of these. If any fail, regenerate.

- [ ] Face features (eye shape, nose, mouth) clearly readable at 96×96 px (your in-app render size). Test by exporting at 96 px and looking.
- [ ] Wings are clearly butterfly-shaped, **not bird-feathered**, **not insectoid-mantis**. Reject if creepy.
- [ ] Dress has identifiable colour blocks (top half ≠ bottom half OK, but no chaotic patterns — palette swap won't work).
- [ ] Background is a clean solid (you'll erase it; messy backgrounds make removal hard).
- [ ] Symmetrical pose (asymmetric idle makes mood-driven mirroring harder).
- [ ] Full body in frame — feet visible, top of head 5–10% from top edge. No cropping.
- [ ] No accidental extra fingers, fused limbs, or AI artefacts on face. **Look closely.**

---

## 3 · Generate poses 2–5 with the cref locked

For each remaining pose, use the same master prompt with **two changes only**:

1. Swap the pose description line (e.g., `"hovering pose, arms relaxed at sides"` → `"head tilted, one hand at brow, scanning forward"`).
2. Add `--cref <master-image-url>` (Midjourney) or set Style Reference = master image (Firefly).

Keep palette, hair, wing style, dress colour blocks, and proportions identical across all 5. The **only** changes between poses are body pose, hand position, eye expression, mouth shape, and accessory presence (Zzz on sleeping, tear on sad).

### Consistency self-check (after generating all 5)

Open all 5 in Pixelmator at 1:1, side-by-side. Ask honestly:

- Does this look like the **same character** in 5 moments? Or 5 different fairies wearing similar outfits?
- Are wing vein patterns recognisable across poses? (They won't be identical — wings move — but the *shape language* should match.)
- Is the face the same character? (Most common failure mode — eyes drift, nose shape shifts.)

**If any pose feels off, regenerate just that one with stricter cref weight.** Don't compromise. The whole project rides on this step.

---

## 4 · Pixelmator Pro cleanup (per pose)

For each of the 5 master PNGs:

| # | Step                                                                                              | Tool                                     |
|---|---------------------------------------------------------------------------------------------------|------------------------------------------|
| 1 | Background removal → transparent alpha                                                            | Selection → Subject → Invert → Delete    |
| 2 | Edge clean-up (purple fringes from old background)                                                | Refine Edge → Decontaminate Colors       |
| 3 | Palette sanity — confirm dress, wings, hair, skin tones match across 5 poses; nudge with Hue/Saturation if drift | Adjust Colors → Hue/Saturation per region |
| 4 | Crop to consistent canvas — **1024 × 1024 px, character centred, head 8% from top, feet 6% from bottom** | Crop tool with custom 1024 preset        |
| 5 | Export as `lumi_<pose>_master.png` (24-bit + alpha)                                                | File → Export → PNG, "Transparency: Yes" |

You should now have:

```
lumi_idle_master.png
lumi_scanning_master.png
lumi_success_master.png
lumi_sad_master.png
lumi_sleeping_master.png
```

Save these in your local working dir, **NOT in the repo** — the repo only gets the final `.riv` file. Master PNGs are 5–10 MB total; they shouldn't bloat git.

---

## 5 · Layer separation — the rigging prep

Rive needs the character broken into independently-animatable parts. **You have two viable paths.** Pick one based on how much polish you want and how much Rive experience you're willing to build up.

### Path A — Pose-swap (recommended for v6.8 first ship)

**Skip layer separation entirely.** Drop the 5 master PNGs into Rive as 5 keyframes. The state machine cross-fades between them based on `moodIndex` / `stateIndex` inputs. Animation is limited to:

- Cross-fade between poses on mood change (~200ms ease-in-out)
- Continuous Y-axis float (hover) on the active pose
- Wing flap as a subtle scale-pulse on the whole pose

**Outcome:** decent expressive Lumi, ~2 hours of Rive work, no bone rigging needed.

**Trade-off:** can't animate mouth/eye independently — the whole character cross-fades. Acceptable at 96px render size; kids won't notice the loss vs. articulated rig.

### Path B — Articulated rig (post-v6.8, when you want polish)

Separate each master PNG into layers. Per pose, expect 8–13 layers:

| Layer name pattern         | Notes                                                              |
|----------------------------|--------------------------------------------------------------------|
| `<pose>_bg_shadow`         | Soft drop shadow under feet (optional)                             |
| `<pose>_wing_left_back`    | Wing behind body — drawn first, slightly larger                    |
| `<pose>_wing_right_back`   | Mirror of above                                                    |
| `<pose>_body`              | Dress + torso, no head, no arms                                    |
| `<pose>_arm_left`          | Including hand                                                     |
| `<pose>_arm_right`         | Mirror                                                             |
| `<pose>_head_base`         | Head shape + skin tone, NO eyes/mouth                              |
| `<pose>_hair`              | Separate so it can sway                                            |
| `<pose>_eye_left`          | Open variant                                                       |
| `<pose>_eye_left_closed`   | Closed variant (used for blink and sleeping)                       |
| `<pose>_eye_right` + `_closed` | Mirror                                                          |
| `<pose>_mouth`             | Default expression                                                 |
| `<pose>_wing_left_front` (optional) | Highlight wing if visible in front                        |
| `<pose>_accessory`         | Crown (hard-mode), Zzz (sleeping), tear (sad) — pose-specific      |

**Pixelmator Pro layer separation workflow per pose:**

1. Duplicate master PNG as a working file
2. Use **Magic Wand** + **Refine Edge** to select each region; **Cmd-J** to lift to new layer
3. Where layers overlap (e.g., arm behind wing), use **Repair (Generative Fill)** to reconstruct the hidden pixels behind the lifted layer — Pixelmator's content-aware fill handles this well on a solid-coloured character
4. Name layers per the table above (Rive will import layer names as bone target names)
5. Export each layer as a transparent PNG at the same canvas size: `lumi_<pose>_<layer>.png`

**Outcome:** mouth open/close, blink, eye direction, wing flap as independent animations. Beautiful, but adds 3–5 hours of separation work per pose × 5 poses = ~20 hours.

### My recommendation for THIS ship

**Path A.** Get Lumi v6.8 shipped flag-on first. If post-launch engagement data (Phase 5 PROD-data-gated) shows Lumi is the retention driver, then Path B becomes Tier 1.5 work. Don't gold-plate before you have data.

---

## 6 · Hand-off checkpoint

When everything in Section 4 is done (Path A) OR Section 5 (Path B), you have either:

- **Path A:** 5 master PNGs at 1024×1024 with transparency
- **Path B:** 5 master PNGs + ~40–65 layer PNGs

Proceed to `LUMI_RIVE_SPEC.md` for the Rive editor walkthrough and state machine contract.

---

## 7 · Quick reference — palette tokens for the 4 themes

Rive's `themeIndex` input drives palette swaps. The character must work in all 4. When generating/cleaning art, keep these tokens recognisable so the colour swap in Rive doesn't muddy mid-tones.

| Token             | Normal (`themeIndex = 0`) | Hard mode (`= 1`) | Sleeping (`= 2`) | Rainbow (`= 3`)                  |
|-------------------|---------------------------|-------------------|------------------|----------------------------------|
| Dress primary     | `#f5c842` (warm gold)     | `#dc2626` (crimson) | `#6b46c1` (muted purple) | Cycles through colorTick 0–5     |
| Dress secondary   | `#fbbf24` (amber)         | `#991b1b`         | `#4c1d95`        | Complementary cycle              |
| Wing fill         | `#fef3c7` (cream)         | `#fecaca`         | `#c4b5fd`        | Iridescent (per-frame shift)     |
| Hair              | `#92400e` (chestnut)      | `#92400e` (same)  | `#92400e` (same) | `#92400e` (same — hair never recolours) |
| Skin              | `#fed7aa` (peach)         | `#fed7aa` (same)  | `#fed7aa` (same) | `#fed7aa` (same — skin never recolours) |
| Accessory         | none                      | gold crown        | "Zzz" symbol     | small sparkles                   |

**Generate the art in normal palette.** Rive applies palette swaps via Solo blend modes on dress/wing layers. Skin and hair never recolour — keep them as-is across all themes.

---

## 8 · What's NOT in this brief

- Rive editor steps (`LUMI_RIVE_SPEC.md`)
- State machine configuration (`LUMI_RIVE_SPEC.md`)
- Build / deploy / flag flip (`docs/LUMI_RIVE_INTEGRATION_RUNBOOK.md`)
- iOS-specific or Android-specific art differences — **there are none.** Rive renders identical pixels on both platforms.

---

## 9 · Sanity check before moving on

- [ ] All 5 poses generated with cref locked, consistency verified by side-by-side review
- [ ] All 5 cleaned up in Pixelmator Pro: transparent background, edge-clean, 1024×1024 canvas, palette stable
- [ ] Exported as `lumi_<pose>_master.png` × 5
- [ ] Decided Path A (pose-swap) or Path B (articulated rig). If A, no further prep — move to `LUMI_RIVE_SPEC.md`. If B, layers exported per Section 5.
- [ ] Backed up the master PNGs somewhere safe (iCloud / Drive). The Rive editor is web-based and not a version control system.

Done? Move to `assets/lumi/LUMI_RIVE_SPEC.md`.
