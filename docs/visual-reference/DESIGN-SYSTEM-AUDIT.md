# Cross-cutting design-system audit — GTK4 vs Electron

**Commit audited:** `7521d70` · **Date:** 2026-07-20 · **Verdict basis:** rendered
pixels and controlled probes, not source reading.

Scope: the design system itself — type scale, colour tokens, spacing rhythm,
depth cues, chrome — rather than any single surface. A wrong token repeats across
dozens of surfaces, so the findings below are intended to explain many
individually-reported per-surface defects as single root causes.

**Excluded by brief:** sidebar header button row, toolbar icon glyphs (sibling
agent actively rewriting). **Declared engine substitutions** (terminal, diff
view, backdrop blur) are classified CANNOT-BE-IDENTICAL, not DIFFERS.

---

## 1. Ranked defect list

Ranked by user-visible impact × breadth of surfaces affected.

| # | Defect | Measured | Impact |
|---|---|---|---|
| 1 | **Main pane background is two token steps too dark** | Electron `(26,31,38)` = `bg-3` (±0); GTK `(11,13,16)` = `bg` (±0) | Largest surface in the app. Wrong base under every pane-hosted widget |
| 2 | **Transitions are absent** | Electron 44 `transition` declarations; GTK **1** | Every hover/state change **snaps**. Best single explanation of "feels different" |
| 3 | **Sidebar 75px too wide** | **Content** width 339px vs 414px, agreed by 64/66 independent scanlines. (A "76px" figure quoted elsewhere measures *to the border column* — same finding, different reference edge) | Displaces the origin of every main-pane measurement |
| 4 | **Dialog card geometry** | Electron `width:420px` declared → 420×215; GTK unconstrained → 378×241 | GTK shrink-wraps: 42px narrower, 26px taller |
| 5 | **Divider seam is 3px of structure where Electron has 1px** — *not* a colour defect | Electron: `x=339` `(36,42,51)` = `border`, one column. GTK: `x=414` `(27,27,27)` stock `GtkPaned` separator **+** `x=415,416` `(36,42,51)` = `border` (2px) | ⚠️ **Do not fix by recolouring.** GTK already paints the correct token; recolouring the separator yields a **3px border** — worse than the defect. Remove the `GtkPaned` separator and narrow the border to 1px |
| 6 | **`accent_2` token wrong** | GTK `#7c6ef2` → painted `rgb(124,110,242)`; Electron `#8b7cff` → `rgb(139,124,255)`. Δ −15/−14/−13 | Use sites: `.usage-bar-fill.meter-accent-2`, `.insights-row-icon` |
| 7 | **`.ws-name` one step too large** | GTK 13px vs Electron 12px/500 — renders 9px wider, 1px taller | Every workspace row |
| 8 | **`.ws-sub` one step too small** | GTK 10px vs Electron 11px | Every workspace row |
| 9 | `backdrop-filter` | Electron 14 uses; GTK 0 | **CANNOT-BE-IDENTICAL** (declared engine substitution) |

---

## 2. Per-surface verdicts

| Surface / role | Verdict | Evidence |
|---|---|---|
| Colour tokens (13 of 14) | **MATCHES** | Exact per-channel equality vs Electron `:root` |
| `accent_2` | **DIFFERS** | Painted delta, pixel-sampled (defect 6) |
| Text tokens (`text`, `text-dim`, `accent`) | **MATCHES** | `(230,233,239)`, `(139,149,167)`, `(110,168,255)` identical both sides |
| Sidebar background | **MATCHES** | `(18,21,26)` = `bg-2` both sides, dominant over 4754 samples |
| Main pane background | **DIFFERS** | 100% vs 99% regional dominance (defect 1) |
| Sidebar width | **DIFFERS** | 339 vs 414 (defect 3) |
| Divider — colour | **MATCHES** | GTK paints `(36,42,51)` = `border` exactly, at `x=415,416` |
| Divider — structure | **DIFFERS** | 3px seam vs 1px (defect 5) |
| Spacing rhythm | **MATCHES** | `Box::new(_, 8)` = `.ws-item gap:8px`; `_,5` = `.ws-pills gap:5px`; `_,8` = `.dialog-actions gap:8px` |
| `.pill` typography | **MATCHES** | 9px/600/0.2px + `padding:0 5px`, measured identical |
| `.dlg-title` / `.dlg-body` | **MATCHES** | 15px/600/−0.01em, 13px — faithful port |
| Dialog card gradient | **MATCHES** | `(26,31,38)→(24,28,35)` vs `(25,30,37)→(24,28,36)`, within 1–2 levels |
| Dialog card size | **DIFFERS** | defect 4 |
| `.ws-name` / `.ws-sub` | **DIFFERS** | defects 7, 8 |
| Depth cues (shadows/gradients/insets) | **MATCHES** | 39 box-shadows incl. 12 inset; 7 gradients; spot-checked as faithful ports |
| Transitions | **DIFFERS** | defect 2 |
| Toolbar band tint | **INDICATIVE ONLY** | Shift visible (`bg-2`-ish vs `bg-3`-ish) but dominance only 29%/8% — too fragmented to call, and region is excluded |
| **Focus states** | **CANNOT-VERIFY** | A headless toplevel never takes focus, so `has_focus()` stays `False` and a focus test **cannot fail** — its silence carries no information |
| **Hover states** | **CANNOT-VERIFY** | No pointer on the headless seat; hover is never entered |
| Terminal, diff view, backdrop blur | **CANNOT-BE-IDENTICAL** | Declared engine substitutions |

**To close the CANNOT-VERIFY rows** a rig with a **live seat providing both
pointer and keyboard** is required — a real (or nested) compositor with input
devices, driving focus/hover and sampling pixels in each state. The current
headless-sway rig structurally cannot produce a failing focus/hover test, so no
result from it should be read as "matching".

---

## 3. Root causes behind other agents' per-surface findings

- **Defect 1** puts the wrong base colour under every pane-hosted widget. Any
  agent reporting "this widget's background is slightly off" in the main pane is
  most likely seeing this one assignment error.
- **Defect 3** displaces the x-origin of the entire main pane; any x-offset
  measured against the window rather than the pane inherits a 75px error.
- **Defect 2** will read as "the app feels cheap/abrupt" and will never appear as
  a static-screenshot defect, because a snapshot cannot show a missing easing.

---

## 4. Tokenisation mapping (for the follow-up fix task)

theme.css carries **47 hex literals against 14 `@define-color` tokens**. Six
literals restate a value that is *already* a token — these are the drift surface
where independently-appended blocks can diverge without any selector conflict:

| Literal | Should reference | Used with |
|---|---|---|
| `#0b0d10` | `@bg` | `background-color` |
| `#4a8cff` | `@accent_strong` | `background-color`, `background-image` |
| `#5bd68b` | `@green` | `background-color`, `box-shadow` |
| `#6ea8ff` | `@accent` | `background-color`, `box-shadow` |
| `#e6e9ef` | `@text` | `color` |
| `#ff6b6b` | `@red` | `background-color`, `box-shadow` |

Only **3** GTK colours have no Electron counterpart in either notation:
`#7c6ef2` (defect 6) and `#8fbcff` / `#1b2029`, both belonging to `.boot-pill`,
a GTK-only widget with no Electron equivalent — **legitimate**, not defects.

---

## 5. Porting hazard worth annotating

**GTK4 CSS has no `gap` property.** The parser rejects it outright
(`No property named "gap"`), measured inert on a `GtkBox` against a positive
control proving the probe could detect spacing (`Box(spacing=20)` → +29px).

Anyone translating an Electron `gap` into `theme.css` will have it **silently do
nothing**. Inter-element spacing must be the `Box::new(orientation, N)`
constructor argument. The current port does this correctly at 125 non-zero
sites — this is a trap for *future* work, not a present defect. A comment near
the spacing rules in theme.css would stop the next person rediscovering it.

---

## 6. Capture manifest

All captures regenerated at `7521d70` via `recapture.sh` (both halves together);
`check-fresh.sh` passes. **14/14 distinct by md5 — zero duplicates**, so no
silently no-opped drive is being counted as a verified surface.

| md5 | file |
|---|---|
| `6506a06299236680cc221623847c0300` | electron-full-window.png |
| `1d932f24eeda032fcd19448c2b482a0c` | gtk-full-window.png |
| `3a7b580d3cda724d145958bc847755c2` | electron-sidebar.png |
| `b2ae4182e864e1c565046882b34dbbc2` | gtk-sidebar.png |
| `00099b7292e25e6d8a3f8fb161bed292` | electron-workspace-selected.png |
| `fa0687172904fdef55121047058808d6` | gtk-workspace-selected.png |
| `20e648221ba4430e49fcd50dc9b05a40` | electron-main-pane.png |
| `760c6095696b3ce1178c7d4a2e440f76` | gtk-main-pane.png |
| `6bf4f3514498b8136c89216b2c058f40` | electron-toolbar.png |
| `ff673975e9ef819e6bce98a21203c707` | gtk-toolbar.png |
| `2729c81ca0b112381ed4922fa2515d5e` | electron-sidebar-selected.png |
| `f68ec3313eca75cedadf25376bcc7332` | gtk-sidebar-selected.png |
| `e4c7e23426e38df3635394a8472c9111` | electron-dialog.png |
| `4313653a6ca51c0d8f5a5ad07f197756` | gtk-dialog.png |

### Harness defect found while capturing — READ BEFORE USING THESE PAIRS

**The two drivers select different rows.** `drive-gtk.py` honours
`ORCHESTRA_CAPTURE_ROW` (pinning `ws-4`, *flaky-e2e-hunt*, with a loud
absent-row failure and an already-active guard). `drive-electron.mjs` **ignores
that variable** and takes the first inactive row, which landed on *m2-sidebar*.

So these four pairs are **STATE-MISMATCHED and must not be used for per-surface
verdicts**: `*-workspace-selected`, `*-main-pane`, `*-toolbar`,
`*-sidebar-selected`. No finding in this report is drawn from them.

Every finding above comes from the **full-window** pair (boot state on both
sides, genuinely matched) or the **dialog** and **sidebar** crops.

**Status (fixed on the integration branch after this audit):**
`drive-electron.mjs` now honours `ORCHESTRA_CAPTURE_ROW` with a loud failure
listing rendered rows plus an already-active guard mirroring `drive-gtk.py`;
`recapture.sh` moved off the `ws-4` pin (auto-selected at boot, which
hard-failed the run) to a mid-list row, and got `chmod +x` for the RC=126 this
audit hit.

> **Known gap — selected-state pairs are still not trustworthy.** Reading the
> env var is necessary but *not sufficient*: another agent pinned `ws-4` in its
> own Electron driver and got "absent", so the two halves **do not share a
> row-addressing scheme**. Until the same selector resolves the same workspace
> on both sides, a pinned run can still compare different rows — the failure
> mode this pin exists to prevent.

---

## 7. Claims withdrawn during this audit

Recorded because a report that shows what it withdrew is more trustworthy than
one showing only what survived. Each died to a control or a re-measurement.

1. **"8 invented colour literals."** My comparison matched hex only; Electron
   writes those colours in `rgba()` decimal, so **faithful ports looked
   invented**. `#b38bff`=`rgba(179,139,255)`, `#f08080`=`rgba(240,128,128)`,
   `#dc5050`=`rgba(220,80,80)` are exact. True orphan count is **3**.
2. **"Spacing rhythm has no GTK equivalent."** Two independent lines of evidence
   agreed and were still wrong: CSS `gap` genuinely is inert, *and* a
   control-backed source search for `set_spacing` returned 0. The idiom is the
   `Box::new(_, N)` constructor arg — 125 non-zero sites. Verdict is MATCHES.
3. **"`.pill` and `.dlg-title` typography differ."** My reference block omitted
   the `padding:0 5px` / `margin-bottom:6px` the real selectors carry, so I
   measured an unmatched pair. Re-measured matched: both **MATCH exactly**.
4. **"Background hierarchy is inverted."** Only the main-pane half survived. The
   sidebar claim came from a **single sample point** that landed on a transient
   row element; regional dominance shows GTK's sidebar is `bg-2`, **correct**.
5. **"Depth cues missing wholesale"** (the brief's premise, inferred from a CSS
   line-count ratio). Measured: 39 box-shadows, 12 inset highlights, 7
   gradients, spot-checked as faithful ports. The real gap is transitions.

6. **"The divider colour has no blue tint."** Superseded by a sibling's
   column-by-column measurement and re-confirmed on these captures: GTK paints
   the `border` token **exactly**, at `x=415,416`. My single sample landed on
   `x=414`, the first column of a 3-column structure. The defect is structural
   (a stock `GtkPaned` separator Electron lacks, plus a 2px border where
   Electron has 1px), not chromatic — and **acting on my version would have
   made it worse**: recolouring the separator yields a 3px border, a change
   that passes review, appears to address the report, and degrades the thing it
   repairs.

### Method conclusion — the transferable part

**Sample regionally from the first measurement; never let a point sample become
a verdict.** Of the six claims withdrawn here, *four* were point-sample
artifacts (3, 4, 6, and the sidebar half of 4). The sibling who caught (6) was
not more careful — they used column-by-column regional dominance from the
start and so never generated the artifact to retract. That is the difference
between a method that produces errors you must be sharp enough to catch, and
one that does not produce them. Prefer the second: regional dominance across
the whole region, or a controlled probe with both a known-good and a
known-inert control.

The corollary matters as much: a point sample on a structured surface does not
fail loudly. It returns a clean, specific, actionable, **wrong** number — and
in case (6) that number pointed at a "fix" that would have degraded the app.

**The other pattern worth carrying forward:** in (1) and (2) the instrument was sound
and its controls *passed* — it was blind to an alternative **notation**
(`rgba()` vs hex; constructor-arg vs setter). Passing controls prove a probe can
detect what it looks for; they say nothing about whether it is looking in the
only place the thing can live. The extra question — *could this be expressed
another way?* — is what caught both, and it costs one thought rather than one
rig. In (3) and (4) the failure was different: precise measurement of an
**unmatched pair** or an **unrepresentative sample**, which degrades not into
noise but into a sharper wrong number and more confidence in it.
