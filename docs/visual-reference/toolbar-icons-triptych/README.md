# Toolbar icons + button hierarchy — before / after / reference

Evidence for the toolbar half of the "buttons and icons are not the same (ugly
on gtk port)" report.

| file | what it is |
|---|---|
| `1-before-gtk.png` | GTK at `0763830` (pre-change), text glyphs as icons |
| `2-after-gtk.png` | GTK at this branch's tip, real symbolic-SVG icons |
| `3-reference-electron.png` | the Electron toolbar, the target |

## How these were produced (and why the pair is comparable)

Both GTK frames come from **separately built binaries** — the "before" tree was
exported with `git archive 82d4469^` and built from scratch, so the two are
genuinely different artifacts, not one binary captured twice. Verified by
content rather than by timestamp:

```
before: strings … | grep -c orch-branch-symbolic  →  0   (control 'orchestra-gtk' → 34)
after : strings … | grep -c orch-branch-symbolic  →  3
```

Both were captured **at the same active workspace row** (`ws-row-ws-4`, the
`flaky-e2e-hunt` fixture), reported by the capture script rather than assumed —
a before/after pair that silently differs in selected row is a state mismatch
that still reads as a rigorous comparison.

The capture takes **no click at all**. `capture-gtk.sh` clicks a row to produce
its "selected" surfaces, and which row is already active at boot is
nondeterministic (documented in `drive-gtk.py`); for a toolbar pair that race is
pure liability, since the toolbar renders identically however the row became
active. The screenshot op is hard-failed if it writes < 500 bytes, because an
empty render node is reported as success and an all-transparent PNG is
indistinguishable from a real capture at thumbnail size.

All three files are hashed and asserted distinct — a drive step that silently
no-ops still produces an image.

## What changed, measured

Pure-paint properties (colour/background/border) produce **zero layout delta
while working perfectly**, so these were checked by sampling pixels, not by
measuring geometry. Accent-coloured pixels (blue clearly dominant, matching
Electron's `--accent: #6ea8ff`) in each region:

| region | before | after |
|---|---:|---:|
| branch chip | **0** | **307** |
| Open PR button | **0** | **324** |

Zero to hundreds in both — these are not marginal shifts that could be
antialiasing noise.

## Reading the frames

- **base chip** — `⑃` (U+2443 OCR INVERTED FORK) → a real git-branch mark.
- **branch chip** — `⎇` (U+2387 ALTERNATIVE KEY SYMBOL) → the *same* branch
  mark, so the two chips finally match; and it is now an accent-blue pill
  rather than flat grey, because the port had been styling
  `.branch-chip.current`, a class with no rule in `styles.css`. Electron's is
  `.branch-chip.head`.
- **caret** — absent before; Electron draws one, so the chip now has one.
- **Open PR** — was grey and indistinguishable from `Merge`; now accent-tinted
  with its pull-request mark, and `Merge` recedes to secondary. The icon and
  the trailing arrow are `::before`/`::after` CSS masks upstream, which GTK4
  cannot express, so they are real child widgets here.
- **restart / run** — bare `↻` and `▶` characters → 28×28 icon buttons.

## Known limitation

This covers the **toolbar only**. The sidebar still carried glyph substitutes
when these frames were taken; that work is tracked separately. Do not read this
triptych as evidence about sidebar chrome.
