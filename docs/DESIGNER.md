# QPet designer sheet

QPet supports selectable pet themes. The original pixel mascot lives in `assets/pet/`; additional themes live in `assets/pets/<theme-id>/`. Keep the state filenames and sizes below so every mood remains interchangeable.

After replacing art:

```bash
npm run dev          # preview while iterating
npm run install:mac  # rebuild the installed app with your art
```

The renderer loads everything from `assets/` (`electron.vite.config.ts` → `publicDir`).

---

## What the app actually uses

Only these files appear in the running UI or package. Replace them first.

### Floating pet (required)

Shown in the always-on-top pet window. One sprite per mood.

| Mood (app) | State filename | Size | Meaning |
|------------|-----------------|------|---------|
| Sleeping / idle | `states/sleeping.png` | 256×256 | No active sessions |
| Working | `states/working.png` | 256×256 | Agent is running |
| Needs input | `states/awaiting-input.png` | 256×256 | Waiting for you |
| Ready | `states/success.png` | 256×256 | Task finished |
| Blocked | `states/error.png` | 256×256 | Error / blocked |

Theme paths and mood filenames are mapped in `src/renderer/src/pet-themes.ts`.

### Branding + app icon (required)

| Use | File to replace | Size |
|-----|-----------------|------|
| Tray header + Settings header | `assets/pet/glasses-pet-master-256.png` | 256×256 |
| macOS `.app` / DMG icon | `assets/pet/glasses-pet-master.png` | ≥1024×1024 square (current: 1254×1254) |

### Provider badges

The tray and Settings render these PNGs directly.

| Provider | File | Size |
|----------|------|------|
| ChatGPT (`codex` internally) | `assets/providers/codex.png` | 256×256 |
| Claude | `assets/providers/claude.png` | 256×256 |
| Cursor | `assets/providers/cursor.png` | 256×256 |
| Hermes | `assets/providers/hermes.png` | 256×256 |
| ClaudeClaw | `assets/providers/claudeclaw.png` | 256×256 |

Hermes artwork is derived from the official Hermes desktop icon. ClaudeClaw artwork is cropped from the official bundled ClaudeClaw banner. Preserve their upstream attribution when replacing or redistributing those marks.

---

## Present but unused at runtime

These ship in the repo as source / review art. Replacing them does **not** change the live pet until someone wires them up in code.

| File | Notes |
|------|--------|
| `assets/pet/states/idle.png` | Sheet state; live idle mood uses `sleeping.png` |
| `assets/pet/states/awaiting-approval.png` | Sheet state; not mapped |
| `assets/pet/states/notification.png` | Sheet state; not mapped |
| `assets/pet/glasses-pet-master-preview.png` | Large preview only |
| `assets/pet/pet-states.png` | 1024×512 sprite sheet (4×2 × 256 cells) |
| `assets/pet/pet-states-review.png` | Labeled review board |
| `assets/pet/pet-states.json` | Frame coords for the sheet |

If you redesign the full set, keep these in sync with the five live states so future wiring stays easy.

---

## Delivery checklist for designers

Hand back PNGs that match this checklist:

- [ ] 5 pet moods at **256×256**, filenames exactly as in the table above
- [ ] Branding mark at **256×256** → `glasses-pet-master-256.png`
- [ ] App icon square **≥1024×1024** → `glasses-pet-master.png`
- [ ] 5 provider badge images at **256×256**
- [ ] Transparent background with clean antialiased edges; do not bake in black or checkerboard pixels
- [ ] Character centered; leave a little padding so clipping / scaling looks clean
- [ ] Same silhouette and palette family across all moods so state changes read as expression, not a different character

### Classic theme style reference

- Pixel / chunky chibi creature
- Boxy brown body, pale face plate, round glasses, pink blush, stubby limbs
- Dark outline, limited palette, readable at small sizes (~64–128 CSS px on screen)

### Qmini theme style reference

- Canonical squat warm-stone body, three-piece tuft, warm-brown glasses, cyan headset, cyan Q emblem, tiny feet, and short side arms
- Smooth contemporary comic rendering with thick espresso outlines and simplified two-tone shading
- Readable at approximately 90 CSS pixels; avoid thin texture and fragile details
- Stored under `assets/pets/qmini/` and selectable in QPet Settings without replacing Classic

---

## Quick customize workflow

1. Open `assets/pet/` for Classic or `assets/pets/qmini/` for the smooth Qmini example.
2. Add or replace a complete theme using the exact state filenames above.
3. Run `npm run dev` and click through moods (start/stop provider sessions, or wait for idle).
4. When happy: `npm run install:mac` to refresh `~/Applications/QPet.app`.

### Want different filenames or more moods?

Add the theme definition in `src/renderer/src/pet-themes.ts`:

```ts
{
  id: 'my-theme',
  name: 'My Theme',
  description: 'Short picker description',
  brandImage: './pets/my-theme/master-256.png',
  stateDirectory: './pets/my-theme/states'
}
```

Motion / glow per state lives in `src/renderer/src/styles.css` under `.pet-button[data-state='…']`. Visual-only CSS changes stay safe; do not widen the preload/IPC surface.

---

## Folder map

```
assets/
  pet/
    glasses-pet-master.png          ← app icon (used)
    glasses-pet-master-256.png      ← UI branding (used)
    glasses-pet-master-preview.png  ← unused preview
    pet-states.png                  ← unused sheet
    pet-states-review.png           ← unused review
    pet-states.json                 ← unused sheet metadata
    states/
      sleeping.png                  ← used
      working.png                   ← used
      awaiting-input.png            ← used
      success.png                   ← used
      error.png                     ← used
      idle.png                      ← unused
      awaiting-approval.png         ← unused
      notification.png              ← unused
  providers/
    codex.png                       ← used
    claude.png                      ← used
    cursor.png                      ← used
    hermes.png                      ← used; official Hermes desktop source
    claudeclaw.png                  ← used; official ClaudeClaw banner source
  pets/
    qmini/
      qmini-master-256.png          ← selectable theme branding
      qmini-master.png              ← high-resolution transparent source
      pet-states.png                ← 4×2 source sheet
      pet-states-review.png         ← labeled review board
      pet-states.json               ← frame metadata
      qmini-90px-preview.png        ← actual-size readability review
      states/                       ← eight transparent 256×256 states
```
