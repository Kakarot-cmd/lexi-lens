# `LUMI_v6_8_CLEANUP_WORKSHEET.md` — Pixelmator pass on the 5 master PNGs

**Scope:** the 5 uploads (`lumi_idle.png`, `lumi_scanning.png`, `lumi_success.png`, `lumi_sad.png`, `lumi_sleeping.png`) → 5 cleaned masters ready for Rive import.

**Time budget:** 1–2 hours total. Pixelmator Pro only. Optional Adobe Firefly assist for the brooch consistency step.

**Input file specs (verified):**
- All five at 1086×1448, RGB (no alpha), background `#231145`
- Total size: ~1.1 MB across 5 files

**Output file specs (target):**
- 1024×1024 each, RGBA (transparent background)
- Head at ~8% from top, character centred on X axis
- Total size: should land at ~1.5–2.5 MB across 5 files (alpha adds bytes)

---

## 0 · Setup (one time)

1. Create working dir: `~/Pictures/Lumi_v6_8/working/` (NOT in the repo — masters never go to git)
2. Copy all 5 source PNGs into that dir
3. Pixelmator Pro → Preferences → Editing → set default canvas behaviour so crop preserves alpha
4. Save a Pixelmator preset: "Lumi Master Crop" → 1024×1024 px, no resampling on crop

---

## 1 · Per-file checklist

Each file follows the same 6-step pass. Differences flagged inline.

### `lumi_idle.png` → `lumi_idle_master.png` (MASTER REFERENCE)

This one is the canonical reference — every other pose must match this character's Y position and head size.

- [ ] Open in Pixelmator Pro
- [ ] **Background removal:** Select → Subject → Invert Selection → Edit → Cut. You should now see the Pixelmator transparency checkerboard around the character.
- [ ] **Edge decontamination:** Select → Refine Edge → Decontaminate Colors slider to ~30%. Removes the purple fringe from the old background where it bled into wing translucency.
- [ ] **Brooch paint-in (optional but recommended):** Use the lasso to select the chest area where the brooch belongs (look at `lumi_success.png` for reference shape and position). Edit → Generative Fill → prompt: `"gold flower brooch with small pearl centre, matching the dress style"`. Run 3–4 variants, pick the cleanest. **This is the cref-drift fix.**
- [ ] **Crop to 1024×1024:** Image → Canvas Size → 1024×1024. Position character so:
  - Top of head curl at **Y = 82 px** from top (8%)
  - Character centred horizontally
  - Feet should land around Y = 940 px (~92% down) — there should be ~6% padding below feet
- [ ] **Export:** File → Export → PNG → "Include Alpha Channel: ON" → save as `lumi_idle_master.png`
- [ ] **Verify the master Y-position:** open in Preview, note the exact pixel Y of the top-of-head curl. **This becomes the reference for the other 4 poses.**

### `lumi_scanning.png` → `lumi_scanning_master.png`

Cref-faithful to idle. Hand-at-brow pose. No major framing differences from idle.

- [ ] Open
- [ ] Background removal (same Select Subject → Invert → Cut)
- [ ] Edge decontaminate
- [ ] **Brooch paint-in** (same reason as idle — cref drift fix)
- [ ] Crop to 1024×1024, head at Y = 82 px (must match idle exactly — alignment is critical for cross-fade)
- [ ] Export as `lumi_scanning_master.png`
- [ ] **Cross-check vs idle:** open both in Pixelmator side by side. Toggle visibility. The head should stay in place when you switch between layers. If it jumps, re-crop.

### `lumi_success.png` → `lumi_success_master.png`

Already has the brooch. Arms-up dynamic pose. **More sparkles to preserve.**

- [ ] Open
- [ ] **Background removal — extra care:** Select Subject may eat the surrounding sparkles. Inspect the selection. If sparkles are missed: Select → Add Similar (with sparkle colour sample) BEFORE inverting. OR: lasso-add the sparkle clusters manually. Don't lose them — the sparkles are mood-critical.
- [ ] Edge decontaminate
- [ ] No brooch fix needed (already present)
- [ ] Crop to 1024×1024, head at Y = 82 px (match idle)
  - **The character is offset right in the source** — re-centre horizontally during crop
  - The right-side sparkles will be cropped slightly; preserve the densest concentration
- [ ] Export as `lumi_success_master.png`

### `lumi_sad.png` → `lumi_sad_master.png`

Already has the brooch. Tear at corner of eye is the diagnostic detail — don't lose it during edge cleanup.

- [ ] Open
- [ ] Background removal
- [ ] Edge decontaminate **carefully near the tear** — Decontaminate Colors can dim the gold highlight on the tear. If it does, undo and use a more conservative ~15% setting.
- [ ] No brooch fix needed
- [ ] Crop to 1024×1024 — **THE FRAMING NEEDS MORE BOTTOM PADDING THAN OTHERS.** Feet are very close to the bottom in source. After background removal, lift the entire character up ~40 px before crop, so feet land at Y = 940 px like the others.
- [ ] Export as `lumi_sad_master.png`

### `lumi_sleeping.png` → `lumi_sleeping_master.png`

Curled sitting pose — fundamentally different framing from the standing poses. Will use a hard cut, not cross-fade, in Rive.

- [ ] Open
- [ ] **Background removal — preserve the "Zzz" marker.** Select Subject may miss the floating Z's. After Select Subject, manually lasso-add the Zzz cluster before inverting.
- [ ] Edge decontaminate
- [ ] No brooch (chest hidden by hands — fine)
- [ ] Crop to 1024×1024. **DIFFERENT POSITIONING for this one:** the character is curled, not standing. Centre the *body mass* (torso) at canvas centre, head at Y = 250 px (about 25% from top), no need to match the standing-pose head Y position. The Rive cross-fade strategy for this pose is a hard opacity cut (see `LUMI_RIVE_SPEC.md`), so its position doesn't need to align with the others.
- [ ] Export as `lumi_sleeping_master.png`

---

## 2 · Cross-file consistency check (the critical step)

Open all 5 exported masters in Pixelmator as separate layers in a single document. Set the document to 1024×1024.

| Check | Pass criterion |
|---|---|
| Toggle visibility of idle ↔ scanning ↔ success ↔ sad. Top of head curl should NOT move. | Head Y position within ±5 px across the 4 standing poses |
| Brooch presence on idle, scanning, success, sad | All 4 show a gold flower brooch (only if you opted for the paint-in step) |
| Hair colour, eye colour, skin tone consistent | Use Pixelmator's Color Picker to spot-sample matching pixels — should be within ±5 RGB |
| Wing silhouette recognisable across poses | Wing shape language matches; individual veins won't be identical, that's fine |
| Background fully transparent in all 5 | Place a bright red layer behind; no purple remnants visible anywhere |

If any check fails, fix in the offending file and re-export. **Don't proceed to Rive with mismatches** — they're 10× harder to fix after the rig is built.

---

## 3 · Backup before moving on

The masters are not in git. Back them up to iCloud / Drive / wherever. Rive's editor is web-based and not a version control system.

```
~/Pictures/Lumi_v6_8/working/lumi_*_master.png  (5 files, ~2 MB total)
```

Suggested cloud path: `Drive/LexiLens/lumi_v6_8_masters/`

---

## 4 · Decision point: Path A or Path B for Rive?

Per `CHARACTER_SHEET_BRIEF.md` Section 5:

- **Path A — pose swap:** drop the 5 masters into Rive, cross-fade between them. ~2 hours of Rive work. Mood transitions are pose cross-fades; no articulated facial expressions independently of pose.
- **Path B — articulated rig:** layer-separate each master into 8–13 PNGs in Pixelmator, drop into Rive with skeletal rig. ~20 hours of work. Independent mouth/eye/wing animation.

**Re-recommending Path A.** Given:
- The art is detail-heavy (intricate dress, wings) which makes Pixelmator layer-separation slow and error-prone
- At 64×64 render, facial detail blurs out anyway — articulated face animation is wasted work
- You have no PROD engagement data showing Lumi is the retention driver — gold-plating before data is the wrong call per your gating principle
- Path A can ship in one session; Path B is a week of art work

**Path A is the right call for v6.8.** Path B is a v6.9+ candidate if engagement data justifies it.

---

## 5 · When this worksheet is complete

- [ ] All 5 `lumi_<pose>_master.png` files exported with alpha, 1024×1024
- [ ] Cross-file consistency check passed (head alignment across 4 standing poses)
- [ ] Master files backed up outside the repo
- [ ] Decision logged: Path A (pose swap)

Move to `LUMI_RIVE_SPEC.md` Section 2 — the Rive editor walkthrough.

---

## 6 · Common Pixelmator gotchas

| Gotcha | Fix |
|---|---|
| Select Subject misses the wing edges (transparent veins) | After Select Subject, switch to Quick Mask, paint in the missed wing areas manually |
| Decontaminate Colors washes out gold highlights | Use a lower percentage (~15%) instead of the default 30% |
| Crop tool resamples and softens the art | In the crop tool options, untick "Resample" — pure pixel crop only |
| PNG export defaults to no alpha | File → Export → check "Include Alpha Channel" explicitly |
| Generative Fill output doesn't match dress style | Add `"in the style of the existing dress, gold petal texture, soft glow"` to the prompt and run more variants |

---

## 7 · What to send back when done

A 6th file: `lumi_consistency_check.png` — a 5-up grid (1024×5120 or thumbnail grid) showing all 5 masters together in one image, with transparent backgrounds. This is the visual proof for Rive import readiness. Pixelmator → File → New → 5120 wide × 1024 tall → paste each master at X = 0, 1024, 2048, 3072, 4096 → export.

Optional but it makes the next conversation faster — I can verify the consistency check in one look.
