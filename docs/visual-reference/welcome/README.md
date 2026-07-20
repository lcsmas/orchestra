# Welcome screen — GTK4 parity evidence

Parity inventory row #4 (`docs/gtk4-parity-inventory.md`): the GTK welcome
screen showed two lines of grey text where Electron shows a heading, a CTA row
and a 6-card grid. This directory holds the rendered proof for the port.

## Captures

| file | what it is |
|---|---|
| `gtk-welcome-before.png` | GTK at HEAD (`0763830`) — the two-line empty state |
| `gtk-welcome-after.png` | GTK on this branch |
| `electron-welcome-reference.png` | Electron, the source of truth |
| `triptych.png` | the three side by side |

All three are **distinct by md5** (the builder fails on duplicates): a drive
step that silently no-ops still writes an image, so identical hashes would look
like three successful captures while proving nothing.

Both GTK captures come from the SAME drive with the SAME assertions, against
release binaries built from their respective trees. The "before" binary is HEAD
plus *only* the `mainpane.clear-active` harness action — HEAD cannot be driven
to the welcome screen at all, and comparing a drivable build against an
undrivable one would compare two different things.

## How the state is reached, and why the assertion isn't vacuous

The app auto-selects a workspace at boot and no user affordance deselects, so
the welcome screen is otherwise unreachable under the harness.
`mainpane.clear-active` drops the active workspace.

The drive asserts a **transition**, not a state: it first waits for
`showing-content` (a workspace active), then fires the action, then requires
`showing-empty`. Without the pre-state wait the assertion would pass on a
welcome screen that was already up because auto-select had not yet landed — a
boot race this drive hit in practice.

`visible` cannot be used here: GTK reports `is_visible() == true` for a
`GtkStack`'s off-screen child as well as its current one, so **both** branches
report true simultaneously (measured) and an assertion on it can never fail.

## Evidence by property class

Getting the class wrong inverts the verdict, so each property is listed with the
class that decides it.

### LAYOUT-affecting → measured delta (`layout-probe.py`, `ls-probe.py`)

Controls, both required and both behaved:
- KNOWN-GOOD `font-size 13→19.5px`: `dw=+68 dh=+8` — the probe can detect.
- KNOWN-INERT `text-shadow`: `dw=0 dh=0` — the probe can return zero.

| property | delta | verdict |
|---|---|---|
| title `font-size: 19.5px` | +68w +8h | works |
| title `font-weight: 600` | +4w over size alone | works |
| title `letter-spacing: -0.2px` | −4w (isolated) | works |
| feature-name `font-size: 12px` | −9w −1h | works |
| feature-name `font-weight: 600` | +3w over size alone | works |
| feature-desc `font-size: 11px` | −59w −2h | works |
| card `padding: 10px 12px` | −35w +18h | works |
| card `min-width: 160px` | 0 at 210px; +145w on a short label | **N/A, not dead** |

`letter-spacing` initially read as "no effect" because it was measured against a
13px baseline where the font-size change dominated. Isolated at constant
font-size it shows a monotonic dose-response (−0.2px→−4w, −1px→−19w,
−2px→−38w, +2px→+38w), which is stronger evidence than a single delta.

`min-width: 160px` does not bind at the shipped 210px card width. That is the
min/max trap: a zero delta means NOT-APPLICABLE. Tested at a binding value on a
short label it moves 15→160px, so the rule is live, just not the operative
bound here.

### PURE-PAINT → pixel sample (`paint-check.py`, `paint-cta.py`)

A zero layout delta is EXPECTED for these and is not failure evidence.
Controls: known-good = two points that must differ (card vs pane background)
→ detects; known-inert = two points inside one flat fill must match → returns
zero. The first known-inert sample landed on a glyph edge and was re-taken on a
144px flat run rather than interpreted.

| rule | sampled | expected |
|---|---|---|
| card `background: var(--bg-2)` | `#12151a` | `#12151a` |
| card `border: 1px var(--border)` | `#242a33` | `#242a33` |
| pane background | `#0b0d10` | `#0b0d10` |
| title colour `var(--text)` | `#e6e9ef` | `#e6e9ef` |
| tagline colour `var(--text-dim)` | `#8b95a7` | `#8b95a7` |
| feature-name `var(--text)` | `#e6e9ef` | `#e6e9ef` |
| feature-desc `var(--text-dim)` | `#8b95a7` | `#8b95a7` |
| help-btn colour `var(--text-dim)` | `#8b95a7` | `#8b95a7` |
| help-btn `background: transparent` | `#0b0d10` = pane bg | transparent |
| primary CTA gradient | `#77b1ff`→`#4c8eff`, top lighter | `#7ab4ff`→`#4a8cff` |
| secondary CTA `var(--bg-3)` | `#1a1f26` | `#1a1f26` |
| card `border-radius: 8px` | corner is pane bg, +9px in is card | rounded |

Text colours are read from the brightest pixel of the glyph run: antialiasing
blends most glyph pixels toward the background, and only the core stroke reaches
the specified colour.

### ANIMATED

None. The welcome screen ports no animated property, so no frame-hash evidence
is needed.

## Reproducing

```
bash docs/visual-reference/welcome/capture-welcome.sh \
  native/target/release/orchestra-gtk /tmp/after.png after
```

Headless sway only — the script refuses `wayland-1` (the user's session). A
hidden window yields no frames, which makes screenshots hang and clicks
silently no-op.
