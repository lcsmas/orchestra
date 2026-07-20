# T0 — Whole-window diff harness

Compares the **whole** GTK window against the **whole** Electron window at
identical geometry against the same fixture, and emits a per-region difference
map **ranked by delta**. The ranking is the work order for the other M5 tracks.

```bash
docs/visual-reference/whole-window/run-diff.sh            # the diff
docs/visual-reference/whole-window/prove-detector.sh      # prove it can fire
```

Exit code of `run-diff.sh`: `0` all regions within threshold, `1` regions
differ (a **result**, not a harness failure), `2` refused to diff.

## Why it exists

M4 ran four verification waves scoped to individual regions and missed defects
the user saw instantly by opening both apps side by side. The defect class is
**cross-region**: correct token values applied to the *wrong surfaces*. No
single-region agent has the reference needed to notice that — each one sees only
its own region and reports it as internally consistent, which it is.

---

## HARNESS / TOOLING CLAIMS

*Separated deliberately. A false claim about a subject costs one re-measurement
and someone notices; a false claim about a **detection tool** gets a real gate
disabled and every failure after it is silent. Attack this section first.*

**The detector has been shown to fire.** `prove-detector.sh` injects a magenta
fill into `.sidebar-footer`, rebuilds (the CSS is `include_str!`-embedded, so a
source edit is invisible until recompiled), and requires the diff to rank that
region and report the injected value; then restores, rebuilds, and requires the
same region to read clean. Observed: **Δ235 with 62432 sentinel pixels in the
frame, then Δ3 with 0 sentinel pixels.** Both directions, same report.

**Three false verdicts were produced and corrected while building this.** They
are listed because each one is a live trap for anyone extending the harness:

1. **The oracle read only `background-color`.** `.sidebar` and `.toolbar` paint
   via `background: linear-gradient(...)` with no background-color, so
   `getComputedStyle().backgroundColor` returned `rgba(0,0,0,0)` —
   indistinguishable from genuinely transparent. The walk climbed to the root and
   reported *every* region as the same `rgb(11,13,16)`. That first run would have
   told five agents the toolbar is the root colour and the main pane matches,
   **inverting the known ground truth.** Fixed by resolving `background-image`
   and gradient stops. Sidebar regions moved Δ10 → Δ3 once corrected.

2. **A CDP port collision was reported as "THE DETECTOR DID NOT FIRE".** The run
   never reached the subject at all. An instrument failure wearing the costume of
   a subject verdict. Fixed structurally (kernel-allocated free port) *and* by
   making the proof distinguish "harness did not run" (exit 2) from "detector did
   not fire" (exit 1) — opposite conclusions with opposite fixes.

3. **The fault injection itself was inert, twice.** First `#main-area` — a GTK
   CSS *name* selector where the theme styles by *class* (`.main-area`), so the
   rule parsed cleanly and did nothing (GTK CSS's third outcome: accepted and
   inert). Then `.main-area` correctly, but that widget is almost entirely
   **occluded** by children (`#terminal-stack`, `.term-scroll`) that paint over
   it — a whole-frame scan found **zero** magenta pixels. Both times the script
   accused a working instrument. A mutation test whose mutation never reaches the
   screen is not a weaker test, it is an **inverted** one. The proof now gates on
   sentinel pixels appearing in the composited frame before it will render any
   verdict about the detector.

**Known limitation, stated rather than discovered later:** `main-pane` reads
Δ0, but its 94.4% dominance is the *terminal child's* fill, not `main-area`'s
own. The region as sampled is dominated by an occluding child. A Δ0 here means
"the content area's painted result matches", **not** "main-area's background
token is correct" — those are different claims and only the first is measured.
The M5 plan's headline `main-pane` Δ55 was measured on a different app state;
this harness's fixture shows the terminal, and that difference is unreconciled.

**Not covered:** every region below is a static fill or ink colour. Hover, focus,
scroll-position, menus, animation and the transitions gap are **structurally
invisible** to this harness (§3.3 of the plan) and are not claimed as passing.

---

## First ranked diff

1596x971, mock/seeded fixture, both halves state-matched, geometry asserted.

| Region | Electron (oracle) | GTK (frame px) | Δ | share | class |
|---|---|---|---|---|---|
| **ws-row** | rgb(26,31,38) | rgb(18,21,26) | **12** | 82.2% | fill |
| **toolbar** | rgb(21,24,30) | rgb(30,33,38) | **9** | 8.8% ⚠ | fill |
| header-strip | rgb(20,23,29) | rgb(18,21,26) | 3 | 91.9% | fill |
| sidebar-body | rgb(20,23,29) | rgb(18,21,26) | 3 | 70.6% | fill |
| sidebar-bottom | rgb(20,23,29) | rgb(18,21,26) | 3 | 96.7% | fill |
| main-pane | rgb(11,13,16) | rgb(11,13,16) | 0 | 94.4% | fill (see limitation) |
| app-root | rgb(11,13,16) | rgb(11,13,16) | 0 | 75.5% | fill |

**⚠ The toolbar row is UNRELIABLE as a colour claim.** Its 8.8% sample share
means the "dominant" colour is a thin plurality, not a characterisation — the
toolbar is mostly buttons, labels and icons, not fill. The Δ9 is reported but
should not be acted on without a fill-only re-measurement. This is exactly the
number the harness exists to flag rather than launder.

**Electron paints the sidebar and toolbar as translucent gradients**
(0.75–0.92 alpha, 2 stops each), composited over the app root before comparison.
A flat GTK fill can match the dominant colour and still differ across the
region's height — reported per-row in the provenance section, since the scalar
delta cannot express it.

**Coverage: 7 of 8 oracle regions compared.** `ws-name` (ink) was not probed —
GTK label bounds are not yet resolved. **UNVERIFIED, not passing.**

---

## Design

**Electron is read from its DOM oracle, never from pixels** — exact values with
alpha explicit, which sidesteps the translucency trap on the reference half
entirely, and separates *data-path* divergence from *rendering* divergence (a
screenshot cannot tell those apart, and filing the first as the second sends
someone to fix a correct renderer). Selectors were verified against source:
`.main-area` and `.status-bar` **do not exist** — the real main pane is `.main`
and **Electron has no status bar at all**, so the M5 plan's status-strip row has
no counterpart to diff.

**GTK is read as regional dominance from the composited window frame** — never a
widget-scoped snapshot, which renders offscreen over nothing and is structurally
blind to both translucency and occlusion. Required adding a `bounds` op to the
remote-control harness (`Measure` answers "how wide", never "where").

**Every number carries provenance**: dominant colour, sample share, region
bounds, surface class (fill vs ink — the alpha risk is on fills only), and the
instrument that produced it. Shares below 50% are flagged UNRELIABLE inline.

**Geometry is asserted, not assumed.** Both halves report achieved size and the
diff **refuses** to compare a mismatched pair — a pair captured at different
sizes yields perfectly precise numbers that mean nothing.

**Controls that gate absence claims:** the tree walker must see `main-window`
before any widget is reported absent; a `zeroAllocation` widget (exists, paints
nothing) is reported distinctly from an absent one; unmatched oracle selectors
are a hard failure, never a silent skip. An omitted region is otherwise
indistinguishable from a matching one.

## Files

| File | Role |
|---|---|
| `run-diff.sh` | Launches both apps, own headless sway each, orchestrates |
| `oracle-electron.mjs` | CDP DOM oracle — computed styles + bounds |
| `probe-gtk.py` | Frame capture + per-region dominance |
| `diff-report.py` | Pairs, composites alpha, ranks, reports coverage |
| `framescan.py` | Shared PNG decode (same decoder as the proof, deliberately) |
| `prove-detector.sh` | Fault injection: proves the detector fires and clears |
