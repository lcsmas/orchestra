# Main pane + overlay parity — verified against rendered frames

**Report only. No `*.rs` and no `theme.css` was modified.**

Scope: everything right of the sidebar, plus the three full-page overlays.
Captured at tip `b611436` (rebased onto the icons/header + design-system
merges), both frontends at **1600×1000** in matched states.

**Resources / Insights / Help were driven against a REAL DAEMON, not the mock.**
They were gated on a backend existing synchronously at init and were dead
no-ops in every real session until the overlay-gating fix, so every prior
"verification" of them was done under `ORCHESTRA_GTK_MOCK`. The GTK capture
script drops the mock flag entirely and lets the app auto-spawn
`dist-electron/daemon.js` against the same seeded store the Electron half
reads. The footer in every GTK overlay capture reads `backend: daemon v0.5.84`,
which is the proof it was not the mock.

---

## Ranked defects — worst first by user-visible impact

### 1. Sidebar is 179px too wide — and it got worse, not better ⚠️ REGRESSION

| | Electron | GTK | Delta |
|---|---:|---:|---:|
| Sidebar width | **337px** | **516px** | **+179px** |

Measured by column-persistence voting over the full window height, confirmed
independently by first-strong-edge scans at y=300/400/600/700. Identical figure
in **both** the seeded and empty-store states, on four different captures.

**This is a regression against the previously reported +75px.** Earlier in this
workstream the gap was measured at 337 vs 412. After the icons/header merge gave
the header buttons text labels plus a wordmark, GTK's sidebar grew to 516px. The
header row is now the binding constraint on sidebar width.

Impact is not confined to the sidebar: it steals 179px from the main pane on
every screen, and it displaces the x-origin of every main-pane surface. Any
pane-relative geometry anyone measured before this merge is void.

### 2. Main-pane background is two token steps too dark — in the workspace state only

Region x≥40 relative to each side's own pane edge, y 200–940, **regional
dominance** (not a point sample):

| State | Electron | GTK |
|---|---|---|
| Workspace selected | **(26,31,38)** — 100.0% of 899,840px | **(11,13,16)** — 99.1% of 811,040px |
| Welcome / empty | (11,13,16) — 86.1% | (11,13,16) — 84.6% ✅ match |

Both sides land exactly on a defined token, so this is a wrong **assignment**,
not a wrong value.

**Fix direction matters here and is easy to get backwards.** The welcome/empty
branch already paints correctly. Only the **workspace-content branch** is wrong.
Fixing this at the pane root would "fix" the state that is already correct and
regress it.

### 3. Resources: stat tiles and token-usage cards are clipped at the right edge

`gtk-overlay-resources.png` vs `electron-overlay-resources.png`. In GTK the
"Worktrees on disk" tile and the `mobile-club` token card run past the window's
right edge and are cut mid-content. Electron fits its tile row within the pane.

Given defect 1 removes 179px of pane width, this is plausibly downstream of the
sidebar rather than a defect in Resources' own layout — **whoever fixes it
should re-check after the sidebar width is corrected**, because it may resolve
on its own. Flagged as a distinct symptom because it is what a user actually
sees, but it is not independently root-caused.

### 4. Tab strip: active-tab state is carried by a different mechanism

| | Electron | GTK |
|---|---|---|
| Active tab classes | `tab active` | `tab toggle` |

GTK never applies an `active` class; it uses GTK's ToggleButton state instead.
The classes are not equivalent, so any `theme.css` rule written against `.tab.active`
is dead. This is a concrete reason the tab strip cannot match by CSS alone.

---

## Per-surface verdicts

| Surface | Verdict | Evidence |
|---|---|---|
| **Help overlay** | **MATCHES (structurally)** | Live daemon. Allocates 176,078 B — the largest of the three. All sections, panels and item rows render with real content. |
| **Insights overlay** | **MATCHES (structurally)** | Live daemon, 109,280 B. Last-run steps, log body, Reports row, History, LESSONS.md panel all populated from real backend data. |
| **Resources overlay** | **DIFFERS** | Live daemon, 64,035 B. Renders with real CPU/memory/disk/token data, but see defect 3 (right-edge clipping). |
| **Welcome screen** | **MATCHES (close)** | Heading, tagline, 3 CTAs with correct primary/secondary hierarchy, 6-card grid in 3×2, help chip below — all present and closely matched. Pane background matches exactly. |
| **Main-pane background (workspace)** | **DIFFERS** | Defect 2. |
| **Sidebar width / pane origin** | **DIFFERS** | Defect 1. |
| **Tab strip** | **DIFFERS** | Defect 4. |
| **Status/footer strip** | **MATCHES** | `gtk-statusstrip.png`; reads `backend: daemon v0.5.84 · frontend v0.5.84`. |
| **Terminal pane** | **CANNOT-BE-IDENTICAL** | Declared substitution (VTE vs xterm.js). |
| **Diff view** | **CANNOT-BE-IDENTICAL** | Declared substitution (GtkSourceView vs Monaco). |

### Overlay entry points differ (structural, not styling)

Read from source with controls, not guessed:

| Overlay | Electron | GTK |
|---|---|---|
| Resources | sidebar **footer** link (`Sidebar.tsx:2266`) | sidebar **header** button |
| Insights | sidebar **insights row** (`Insights.tsx:70`) | sidebar **header** button |
| Help | sidebar header icon (`Sidebar.tsx:1364`) | sidebar header button ✅ |

Two of the three are reached from a different place than in Electron.

---

## NOT REACHED — where the next wave should start

Stated plainly because a surface I did not reach is a finding, not a gap to hide:

- **Run pane empty/guidance state.** The Run tab was captured, but the fixture's
  workspace has no run script, and its worktree path does not exist, so the pane
  showed a backend error rather than the guidance state. Needs a fixture whose
  worktree exists.
- **Main-pane empty state (non-welcome).** The `.empty` loading state is distinct
  from the welcome screen; only the welcome branch was driven.
- **Diff/Run tab pixel comparison.** Captures exist for both halves but I did not
  complete a measured comparison; the terminal pane's engine substitution makes
  the region-level comparison less meaningful without per-widget scoping.
- **Overlay internals at widget level.** Only overlay roots plus 2 child widgets
  each were allocation-probed. The res-tile grid, agents table, sparkline,
  session chips, limit meters, help panels and insights history rows were **not**
  individually verified.
- **Nvim pane.** Toggle exists, pane never mounts — not re-verified here.

---

## Method notes (two of my own instruments were wrong first)

Both are recorded because in each case my **passing controls did not catch it** —
domain judgement did.

1. **A single scanline is a point sample in the other axis.** My first pane-edge
   detector probed one row and locked onto the welcome *card's* left edge
   (689px) instead of the sidebar boundary (337px) — a clean, specific, wrong
   reference that would have made every pane-relative measurement wrong by
   ~350px while looking precise. Caught only because 689px is absurd against a
   sidebar visibly ~340px wide. Fixed with column-persistence voting.

2. **A control suite can be structurally blind on exactly one item, and nothing
   inside it can tell you which.** Resources and Insights *populate* on open, so
   a descendant-count jump was an independent control. Help is built *statically*
   at mount and only flips `set_visible`, so that control **cannot fire** for it —
   leaving `visible=True` as the sole evidence for precisely the one overlay
   where the present-but-zero-allocation failure mode is undetectable by my other
   probe. The tell was not a failed test; it was noticing Help opens by a
   *different mechanism*, i.e. reading the code rather than the results.
   Re-tested with widget-scoped screenshot bytes + sibling controls: Help
   allocates 176,078 B and survives.

   **Bytes > 0 proves allocation, not correctness** — a widget can allocate and
   paint the wrong colour or paint clipped. It is a necessary gate before pixel
   comparison, never a verdict.

3. **Colour is always regional dominance with the share reported**, never a point
   sample. A point sample on a surface with rows/hover/selection painted over it
   yields a sharp wrong number and more confidence in it — that exact error
   produced, then required retracting, a "GTK sidebar is one step too light"
   finding elsewhere in this workstream. Reporting the share lets a reader judge
   representativeness instead of taking the triple on trust.

---

## Capture manifest

All captures fresh at tip `b611436`. Every capture md5'd; **no duplicates**
within a matched set (the drivers fail the run on a duplicate, because a drive
step that silently no-ops still writes a plausible screenshot).

| md5 | bytes | file |
|---|---:|---|
| c7503e2cc26503703578080b9cfc89c0 | 23287 | mainpane-welcome/electron-welcome-feature-grid.png |
| 9f101d9eb44733e46a05cd06e6e3a399 | 108703 | mainpane-welcome/electron-welcome-full.png |
| e18ccf64d2129db73026e63cf1a7bc15 | 57947 | mainpane-welcome/electron-welcome-pane.png |
| ca68e8e93530924a96c47bccce1c944d | 27351 | mainpane-welcome/gtk-welcome-feature-grid.png |
| 8cbf1ab888905a8c49623c8571a3fc13 | 102571 | mainpane-welcome/gtk-welcome-full.png |
| 3c04731e2894cae09337cc92e3476bf8 | 54929 | mainpane-welcome/gtk-welcome-pane.png |
| 107882e1f083031a33dfef5a4df2d322 | 34462 | mainpane/electron-mainpane-tab-diff.png |
| 24e5cd9cfd83a8ab5aca5b2bbd1af438 | 27064 | mainpane/electron-mainpane-tab-run.png |
| b346ddd1ed2fa8b90534dbd17e91261b | 32392 | mainpane/electron-mainpane-terminal.png |
| 4a56253f14858f6c55838b21a231c30a | 288306 | mainpane/electron-overlay-help.png |
| b4d8c077b8b1d33ec0db11c83fee1f44 | 141174 | mainpane/electron-overlay-insights.png |
| 058f21a4da66c257cd8272c5b7d5b59c | 178126 | mainpane/electron-overlay-resources.png |
| a1093fa48047f6af78c44fa724f607f8 | 11041 | mainpane/electron-tabstrip.png |
| e9bcafea5d0e4a96f55889cfe6311e2e | 35483 | mainpane/gtk-mainpane-tab-diff.png |
| 0f12df08b7563410e5f2a2efd2eabbd5 | 26976 | mainpane/gtk-mainpane-tab-run.png |
| a3c353a54345ac53d7eca3eec0358ad9 | 30999 | mainpane/gtk-mainpane-terminal.png |
| b27a2043c2dfc224ac97f6c03b867ba7 | 267463 | mainpane/gtk-overlay-help.png |
| 683b09a8077071cd63e26b81fed92d66 | 200112 | mainpane/gtk-overlay-insights.png |
| 1cab3207cb1feee6074278be70cc50e3 | 144588 | mainpane/gtk-overlay-resources.png |
| ecf17bcce5c1ccfeb06d0265c621f0b3 | 3326 | mainpane/gtk-statusstrip.png |
| 3fac5aa25057f91fbfd551441dd666cc | 14282 | mainpane/gtk-tabstrip.png |

Allocation probe results (live daemon, per-widget screenshot bytes; each overlay
root is the sibling positive control for its own children, so the capture path
proves itself in the same command):

```
resources-overlay  64035 B   res-live 444        res-close 263
insights-overlay  109280 B   insights-run-btn 919  insights-close 263
help-overlay      176078 B   help-close 263      help-guide-link 1989
```

No zero-allocation widgets among those probed.

### Reproducing

```bash
docs/visual-reference/capture-gtk-mainpane.sh                    # GTK, real daemon
docs/visual-reference/capture-electron-mainpane.sh               # Electron, seeded
ORCHESTRA_WELCOME_RUN=1 docs/visual-reference/capture-gtk-mainpane.sh \
  docs/visual-reference/mainpane-welcome                         # welcome, empty store
docs/visual-reference/measure-pair.py <electron.png> <gtk.png>   # regional dominance
```
