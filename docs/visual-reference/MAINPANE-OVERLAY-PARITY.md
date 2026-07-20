# Overlay + main-pane parity — rendered-frame verification

**Report only. No `*.rs`, no `theme.css`, no UI code was modified.** The only
code changed is the Electron *driver* (`drive-electron-mainpane.mjs`), which had
a control that passed while the camera saw a different surface — see
[Rig defect found and fixed](#rig-defect-found-and-fixed-electron-driver).

Scope: the three full-page overlays (Resources, Insights, Help) plus the
main-pane surfaces (welcome screen, tab strip, Run pane, diff pane, status
strip). Both frontends driven into matched states at **1600×1000**, GTK against
a **real daemon** (no `ORCHESTRA_GTK_MOCK`), and every verdict below is anchored
to a captured frame in `docs/visual-reference/mainpane/`.

---

## Coverage: 18 of 21 surfaces verified

| | Count |
|---|---:|
| MATCHES | 5 |
| DIFFERS (measured) | 8 |
| ABSENT | 2 |
| GTK-only addition | 1 |
| CANNOT-VERIFY (reason given) | 2 |
| **Reached with a rendered frame** | **18 / 21** |
| **Not reached** | **3** (named in [Not reached](#not-reached-3-surfaces)) |

---

## Provenance split — read before quoting any number

Not every number here shares a provenance, and mixing them silently corrupts
background/gap readings:

- **Window-scoped frames** (`*-overlay-*.png`, `gtk-welcome-full.png`,
  `electron-welcome-full.png`) — alpha 255 at 100.0%, fully composited.
  **Every colour, fill, gap and geometry number in this report comes from
  these.**
- **Widget-scoped frames** (`gtk-welcome-pane.png` **47.8% alpha-zero**,
  `gtk-welcome-feature-grid.png` **9.6% alpha-zero**) — usable as evidence of
  *presence/allocation only*. **Do not measure backgrounds, gaps or seams on
  these**: a widget-scoped snapshot renders a translucent or unfilled area with
  nothing behind it.

That hazard is live in this harness, and it is scoped in a way that defeats
casual review — it leaves **opaque fills correct** and silently rewrites only
the numbers nobody spot-checks. Measured on the same feature-card region:

| Scope | Card fill | Gap between cards |
|---|---|---|
| Widget (`gtk-welcome-feature-grid.png`) | `rgb(18,21,26)` 73.5% | `rgb(0,0,0)` **a=0 void** 11.1% |
| Window (`gtk-welcome-full.png`) | `rgb(18,21,26)` 75.6% | `rgb(11,13,16)` 10.4% |

The fill agrees; only the background is fabricated. (Hazard flagged by the
`gtk4-native-port` agent; confirmed live here, and confirmed *not* to have
reached any verdict below.)

**Measurement discipline.** All colour verdicts are regional dominance over a
stated region with the sample share and pixel count given, never point samples.
Edge/geometry verdicts use column-persistence voting.

---

## Findings

### 1. Resources stat tiles are CLIPPED at the window edge — DIFFERS

**The first-wave observation is confirmed, and all three of its open confounds
are now closed.**

Tile-band content extent, regional scan `y[60,180)` / `y[55,195)`:

| | Rightmost content column | Gap to window edge |
|---|---:|---:|
| **GTK** | **1595** (of 1596) | **0px** |
| **Electron** | 1487 (of 1596) | 108px |

The 5th tile ("Live agents") is cut off mid-card in GTK; Electron leaves a
108px right margin.

Confounds closed:

1. **Is it the sidebar width?** *No — and this is the load-bearing measurement.*
   Measured tile borders sit at x = 520, 823, 1120, 1416 → a **284px pitch**.
   Five tiles therefore need `5×284 + 4×12 gap + 36 pad = **1504px**`:

   | Pane width | Fits? |
   |---|---|
   | GTK pane today (1077px) | ✗ |
   | Electron pane (1256px) | ✗ |
   | **GTK pane after the sidebar fix (1257px)** | **✗** |

   The row overflows even at Electron's own pane width, so **the sidebar fix
   will not resolve this.** (My first pass reasoned from *hypothetical* 150–200px
   tiles and concluded "independent of sidebar width" — the measured 284px pitch
   is what actually settles it. The hypothetical arithmetic was wrong and is
   corrected here rather than quietly dropped.)
2. **Does Electron clip identically?** No — 108px of margin, and its
   `.res-tiles` is `display:grid; grid-template-columns: repeat(auto-fit,
   minmax(150px,1fr))`, which **reflows onto a second row** when width is short.
3. **Is the row scrollable by design?** No.
   `resources.rs` sets `scroll.set_hscrollbar_policy(gtk::PolicyType::Never)`,
   so the clipped tile is **unreachable**, not merely off-screen.

**Root cause** (construction, not CSS — GTK's `.res-tiles { }` rule is empty):
GTK builds a `gtk::Box::new(Horizontal, 12)` with `set_homogeneous(true)`, a
single non-wrapping row. Electron uses an auto-fit grid that reflows.

Frames: `gtk-overlay-resources.png`, `electron-overlay-resources.png`.

### 2. Help item names are the wrong colour — DIFFERS

Regional scan over the item-name rows (text pixels only, `sum>200`):

| | Dominant text colour | Share | Region |
|---|---|---:|---|
| **GTK** | **`rgb(110,168,255)` — blue** | 5.0% of 3830 text px | x[553,760) y[150,300) |
| **Electron** | `rgb(230,233,239)` — neutral | 13.3% of 1443 text px | x[369,520) y[160,300) |

**Root cause, confirmed at source** (the rule that actually governs, not a
guessed one):

- Electron `styles.css`: `.help-item-name { font-weight: 600; color: var(--text); }`
- GTK `theme.css`: `.help-item-name { color: @accent; font-size: 12px; font-weight: 600; }`

A one-token difference — `@accent` where the reference uses neutral body text.
Every help item name reads as a hyperlink in GTK.

### 3. Help item layout model differs — DIFFERS

- **Electron**: `.help-item { display: grid; grid-template-columns: 150px 1fr; gap: 10px; }`
  → name in a 150px left column, description beside it.
- **GTK** (`help.rs`): `gtk::Box::new(gtk::Orientation::Vertical, 1)`
  → name **above** description, stacked.

Visible in both frames; the GTK panel is consequently taller per item.

### 4. Overlay headers: Electron hides them under the toolbar, GTK does not — DIFFERS

This is the finding that cost three wrong hypotheses, and it is only settleable
by measurement. Live geometry from the running Electron renderer:

```
main      x=340 y=0 1256x971  pos=relative z=auto
toolbar   x=340 y=0 1256x48   pos=relative z=20
insights  x=340 y=0 1256x971  pos=absolute z=5
```

Measured stacking order: **`.res-page` (25) > `.toolbar` (20) > `.insights-view`
(5) = `.help-view` (5)**.

So in Electron the Resources page covers the toolbar and shows its own header,
while **Insights and Help render their headers *underneath* the 48px toolbar,
which stays visible**. GTK draws a full-width header for all three overlays and
has no equivalent toolbar overlap.

Whether Electron's behaviour is intentional or its own latent defect is an
author question — but the two frontends demonstrably differ, and GTK is not
reproducing Electron's presentation.

### 5. Run pane: no run toolbar and no run-status label — ABSENT

Electron's Run tab renders a per-pane toolbar with a green **▶ Run** button and
a **STOPPED** status label. GTK renders neither; the pane is bare below the
setup banner.

Source check with both controls in the same command (positive control
`toolbar-tabs` → 1 file / present in theme.css; negative control `zzqqxx` → 0 /
false):

| Token | GTK `*.rs` files | GTK `theme.css` |
|---|---:|---:|
| `run-status` | 0 | absent |
| `term-toolbar` | 0 | absent |
| `run-action` | 0 | absent |
| `STOPPED` | 0 | absent |

Confirms inventory rows 108/109 with rendered evidence.

Frames: `gtk-mainpane-tab-run.png`, `electron-mainpane-tab-run.png`.

### 6. Tab strip alignment differs — DIFFERS

Both strips are **48px** tall. Content clusters by column-persistence voting:

| | Clusters (x ranges) |
|---|---|
| **Electron** | `14-255` … gap … `819-939`, `970-1009`, `1028-1039`, `1096-1197`, `1220-1233` |
| **GTK** | `14-417`, `450-472`, `511-522`, `592-690`, `720-756` … `1071-1083` |

Electron pushes tabs and actions **right**; GTK runs them **continuously from
the left**, leaving only the pane-toggle at the far right.

**Root cause:** Electron's `.title { flex: 1; }` expands to push subsequent
children right. GTK instead puts the expansion on the *tabs* box —
`tabs.set_halign(Center); tabs.set_hexpand(true);` (comment: "tabs (center)") —
and its `title` box has no hexpand.

### 7. Welcome screen — MATCHES (and the inventory is stale)

`docs/gtk4-parity-inventory.md` rows 4–7 list the welcome screen, action
buttons, feature grid and help button as **ABSENT**. **That is no longer true.**
GTK renders the heading, tagline, 3 CTA buttons, a 6-card feature grid and the
"Everything Orchestra can do" button.

Card-band regional comparison (window-scoped frames only):

| | Card fill | Gap | Border |
|---|---|---|---|
| **GTK** (93,236 px) | `rgb(18,21,26)` **75.6%** | `rgb(11,13,16)` 10.4% | `rgb(36,42,51)` 2.6% |
| **Electron** (99,756 px) | `rgb(18,21,26)` **77.6%** | `rgb(11,13,16)` 9.8% | `rgb(36,42,51)` 1.9% |

Identical values with near-identical sample shares.

> **Scope caveat:** the two welcome runs use different stores (GTK's harness
> action clears the active workspace against a *seeded* store; Electron's
> welcome only renders with an *empty* store). The **sidebars are therefore not
> comparable** in this pair — this verdict covers the welcome **pane** only.

### 8. Overlay panel/tile surface treatment — MATCHES

Dominant fill, window-scoped regions:

| Surface | GTK | Electron |
|---|---|---|
| Help panel | `rgb(18,21,26)` 89.3% / 211,150 px | `rgb(18,21,26)` 87.4% / 176,945 px |
| Insights panel | `rgb(18,21,26)` 96.9% / 164,800 px | `rgb(18,21,26)` 60.6% / 207,910 px |
| Resources tile | `rgb(18,21,26)` 92.3% / 63,800 px | `rgb(18,21,26)` 85.5% / 139,050 px |

Card/panel colour is ported correctly across all three overlays. The remaining
overlay differences are **structural, not chromatic**.

### 9. Help body content — MATCHES

All four panels ("The core loop", "Agents that spawn agents", "Review & ship",
"Terminals & status") and their items are present with **verbatim identical
copy** on both sides. Only colour (finding 2) and layout (finding 3) differ.

### 10. Insights overlay structure — MATCHES (with a state caveat)

GTK renders Last-run + per-step rows, the transcript block, Reports chips,
History and the LESSONS.md panel — the full Electron section set, in the same
order, on the same panel treatment.

> **State caveat:** the two runs show **different data**. GTK ran a live
> self-tune against the real daemon (Jul 20, failed, 6 steps, populated
> transcript); Electron shows the seeded Jul 18 completed run with "No
> transcript available". Section *inventory and ordering* are comparable;
> per-row content is not.

### 11. Status strip — GTK-only addition

GTK renders a 1576×16 strip: `backend: daemon v0.5.84 · frontend v0.5.84`.
Electron has no such element — `status-strip` and `status-text` appear in **0**
`.tsx` files and are absent from `styles.css` (positive control `version` → 2
files / present in CSS; negative control `zzqqxx` → 0 / absent). Electron shows
the version in the sidebar footer instead.

Not a parity gap; a GTK addition, recorded so it is not mistaken for one.

### 12. Diff pane — CANNOT-VERIFY (state mismatch, not a defect)

The two frontends are in genuinely different backend states:

- **Electron**: "No changes yet — The agent hasn't modified any files in this worktree."
- **GTK**: "Diff unavailable — backend error (Error): Cannot use simple-git on a directory that does not exist"

The fixture's repo paths are deliberately non-existent (so the boot-path orphan
pruner leaves the rows alone), and the two backends surface that differently.
Comparing these frames would compare error handling, not diff rendering.

**Rig that would close it:** seed a real temporary git worktree with a known
dirty file so both sides render an actual diff.

---

## Not reached (3 surfaces)

Named, per the coverage rule — an unreached surface tells the next wave where to
start.

1. **Resources agents table with live rows.** Both sides rendered the *empty*
   state ("No agent processes right now"), so `.res-agent-row`, `.res-chips`,
   `.res-col-*` and the expanded process list were never exercised. Needs a
   fixture with a running agent PTY.
2. **Resources CPU sparkline geometry** (`.res-tile-spark`, hand-drawn
   `DrawingArea` vs SVG path). Both captures show a flat 0% trace, so curve/fill
   geometry is untested. Needs sustained synthetic CPU load during capture.
3. **Insights per-row content parity** (history rows, diff lines, lesson
   entries). Blocked by the state mismatch in finding 10 — the two sides must be
   pinned to the *same* self-tune run.

---

## Harness reach limit (blocks per-element probing on two overlays)

`remote_control.rs::find_widget` resolves **only** `widget_name()` — there is no
CSS-class or type selector. Named widgets available:

| Overlay | Lines | Named widgets |
|---|---:|---|
| Resources | 1363 | `resources-overlay`, `res-live`, `res-close` (**3**) |
| Insights | 932 | `insights-overlay`, `insights-row`, `insights-run-btn`, `insights-close`, `insights-section`, `insights-transcript`, `insights-lessons` (7) |
| Help | 286 | `help-overlay`, `help-close`, `help-guide-link` (**3**) |

So Resources' stat tiles, sparkline, agent rows, token cards and disk rows —
and every Help panel/item — are **unaddressable**: they cannot be
allocation-probed or widget-screenshotted. All verdicts about them here are
**pixel-derived from window-scoped frames**, which is why findings 1–3 are
stated as regional measurements rather than per-widget assertions.

**To close:** add `set_widget_name()` to the tile/panel/row containers.

---

## Allocation gate (necessary, not sufficient)

Widget-scoped screenshot bytes, with the overlay root as the sibling positive
control that makes a zero meaningful. Bytes > 0 proves **allocation**, not
correctness — it gates the pixel comparison rather than replacing it.

| Overlay | Root bytes | Probe children |
|---|---:|---|
| Resources | 63,309 | `res-live` 444, `res-close` 263 |
| Insights | 109,124 | `insights-run-btn` 919, `insights-close` 263 |
| Help | 176,078 | `help-close` 263, `help-guide-link` 1,989 |

No zero-allocation widgets. Open-controls: Resources 30→112 descendants,
Insights 77→111, Help `visible False→True` (Help is built **statically** and only
flips visibility, so a descendant-count control is structurally blind to it —
which is why both control types are asserted).

---

## Rig defect found and fixed (Electron driver)

The driver's overlay control was `count('.insights-view')` — DOM presence,
sampled right after the click. It **passed while the screenshot showed a
different surface**. Three hypotheses died before a measurement settled it, and
that sequence is the useful part:

1. *"The sidebar also renders `.insights-view`"* — **wrong**; `App.tsx:668`
   gates it on `insightsOpen`.
2. *"A leftover Resources page painted over it"* — **wrong**; header-band md5s
   of all four captures came back **all-distinct**, so no capture was a
   duplicate of another.
3. **Correct, and only from measured geometry:** the toolbar is `z-index: 20`
   and `.insights-view` is `z-index: 5`, so the toolbar legitimately paints over
   the overlay header (finding 4).

What settled it was asking the live page for boxes and computed z-index, not
better reasoning about the source.

Fixes applied to `drive-electron-mainpane.mjs` (driver only):

- `closeAllOverlays()` closes **every** overlay root before each open, via each
  overlay's own close button. Escape alone is unreliable — `ResourcesView.tsx:394`
  binds it through a React `useEffect` listener that a synthetic
  document-level dispatch does not reliably reach. The entry points are
  **toggles** (`Insights.tsx:69`), so an un-reset state makes the click *close*
  the overlay.
- `onStage()` re-probes **immediately before the shot** (so control and capture
  describe the same frame) and requires the root to be **topmost** via
  `elementFromPoint` hit-testing.

**Mutation-tested**, because a check nobody has seen fail is not a check:
pointing the Insights root at `.insights-view-ZZZ-mutant` made the control fail
as intended (`! control FAILED ... {"present":false}`), and reverting restored
the pass. Post-fix, all three overlays report `TOPMOST` with their real headings
(`"Insights & Improvements"`, `"Resources…"`, `"What Orchestra can do…"`).

**General rule this generalises to:** every widget-tree signal — DOM presence,
`visible=True`, `list_widgets`, element size, even a topmost hit-test — is
**upstream of what the camera sees**. Assert against the painted frame or
measured z-order.

---

## Reproducing

```bash
./native/setup-localdeps.sh                      # once per worktree
source native/env.sh && cargo build -p orchestra-gtk --release \
  --manifest-path native/Cargo.toml              # NOT from the repo root (exits 101)
npx vite build && pnpm run build:daemon          # Electron renderer + daemon.js

docs/visual-reference/capture-gtk-mainpane.sh  <outdir>   # real daemon, no mock
ORCHESTRA_DEBUG_PORT=<free-port> \
  docs/visual-reference/capture-electron-mainpane.sh <outdir>
ORCHESTRA_WELCOME_RUN=1 ORCHESTRA_DEBUG_PORT=<free-port> \
  docs/visual-reference/capture-electron-mainpane.sh <outdir>   # empty-store welcome
```

**Pick a free CDP port**: 9377 is the default and collides with sibling agents
on this machine (observed: `bind() failed: Address already in use`, which
surfaces only as "CDP never came up").

**Row matching across halves.** The two drivers do not share a row-addressing
scheme — `drive-gtk.py` addresses by **widget name**, `drive-electron.mjs` by
**rendered text**. For this run they resolve to the **same workspace**, verified
against the shared seed: exactly one entry satisfies both predicates —
`id=ws-4`, `branch=flaky-e2e-hunt`. So the selected-state pairs here are
matched. Anyone changing the pin must re-verify that correspondence.

Both halves ran in their own headless sway; no window reached the user's
desktop.
