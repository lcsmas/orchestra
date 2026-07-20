# Sidebar surfaces — wave 2 parity audit (GTK4 vs Electron)

**Commit audited: `6ca9a83`.** **Report only — no `*.rs`, no `theme.css`, no UI code modified.**

Region: every sidebar surface in `docs/gtk4-parity-inventory.md` — inventory
rows **24–86** (shell, header chrome, sections, rows, pills/badges, archived,
notices, footer, usage bars, Insights strip).

## Coverage: 41 of 63 surfaces (65%)

⚠️ **The denominator in the brief was wrong and this corrects it.** The brief
said "58 surfaces"; inventory rows 24–90 are actually **67**, and rows **87–90
are the Insights *overlay*** — a different region (overlays), not a sidebar
surface. The sidebar region is rows **24–86 = 63 surfaces**.

The ledger is derived per-row, not asserted: every one of the 63 rows is
classified as covered or not, with **0 unclassified** (assertion enforced in the
counting script). **All 22 unreached surfaces are named individually** in
[Not reached](#not-reached) — an unreached surface tells the next wave where to
start, so it is a finding, never an omission.

**COVERED** means a verdict backed by rendered evidence: pixels from a
composited frame, per-widget render bytes, or live-DOM ground truth.

---

## Read this first: provenance of every number

Not all evidence in this document has the same standing. Conflating the classes
is how a sound finding and an artifact end up carrying equal weight.

| Claim type | Source | Why |
|---|---|---|
| **Electron colour / geometry** | **Live DOM** — computed `rgba()` with alpha explicit, real `getBoundingClientRect()` | Inferring these from pixels re-opens the translucency problem on the *reference* side. The DOM is an oracle; use it. |
| **GTK colour** | **Full-window captures only** | GTK has no computed-style oracle. Full-window is the only capture here that composites over an opaque backdrop (see method note 2). |
| **GTK presence / allocation** | Per-widget screenshot **byte size**, with a sibling positive control | `visible=True` and `list_widgets` both pass on widgets that paint nothing. |
| **GTK text shape** (no-icons, lowercase `5h`) | Widget-scoped crops | Shape/ink, not tint — unaffected by translucency. |
| **CSS rule ranking** | `theme.css` parsed for **all** matching blocks | A cited rule that is outranked is not the operative rule. |

**Every dominance figure below states the surface class**, because "88.9%
dominance" is the same shape of evidence that produced a *retracted* finding
elsewhere today. The distinguishing fact is **what the surface is**, not how
many pixels agree.

---

## How the pair was produced

Both frontends driven to the **same seeded state at 1600×1000** and captured at
`6ca9a83`, each inside its **own headless sway** (never the user's `wayland-1`).

**Freshness.** `check-fresh.sh` reported the committed set STALE on arrival
(taken at an older tip; `widgets.rs` and `theme.css` had changed since). All
captures were regenerated. ⚠️ Note `check-fresh.sh` **exits 0 even when it
reports staleness** — its exit code is not a gate, only its text is.

**Build provenance.** Release build with `RC` captured on its own line, then the
**artifact** verified rather than the exit code: `strings` on the binary
carrying **both** a known-present control (`ws-row-` = 1, `usage-bar-label` = 2)
and a known-absent control (`zzznonsensecontrol` = 0) in the same command.

**Capture integrity.** 14 captures, **14 unique md5s, 0 duplicates**. A drive
step that silently no-ops still yields a screenshot that looks successful.

### The row-addressing gap is CLOSED — selected-state pairs are now valid

The brief listed this as open: `drive-gtk.py` addresses rows by **widget name**,
`drive-electron.mjs` by **rendered text**, so no single `ORCHESTRA_CAPTURE_ROW`
satisfied both and selected-state pairs were untrustworthy.

Closed as follows, and **this is how**: both fixtures were read at source and
agree that `ws-3` **is** `chime-volume` (`backend/mock.rs:152` /
`seed-store.mjs:148`, identical `name`/`branch`). So each driver was given its
own pin naming **the same workspace** — `ws-row-ws-3` for GTK, `chime-volume`
for Electron. Both drivers then reported selecting it. Selected-state verdicts
below are drawn from that genuinely matched pair.

⚠️ **`drive-electron.mjs` now honours `ORCHESTRA_CAPTURE_ROW`** (matching on
`textContent.includes`). The first wave measured 0 occurrences of that string in
that file; it has since been added. Re-derive, do not inherit.

### Two harness defects hit during this run

1. **The pinned row is stale AGAIN.** `recapture.sh` pins `ws-row-ws-mc-1`, but
   `ws-mc-1` is **auto-selected at boot** on this tip, so the already-active
   guard hard-failed the run. (This is the second such drift: `ws-4` was the
   pin before `ws-mc-1`.) The guard is working correctly and caught it.
2. **`recapture.sh`'s comment is now false.** It states auto-selection "only
   ever lands on TREE-TOP rows (orch-1, orch-scratch-kid, ws-2)" and that a
   mid-list pin is therefore safe. `ws-mc-1` **is** mid-list and **is**
   auto-selected — measured on the running app, all 14 rows enumerated with
   their classes. That false comment is what made the stale pin look safe.
   Verified-good pin at this tip: **`ws-row-ws-3`** (not active at boot).

---

## Ranked findings

### W1 — THREE duplicated CSS rule pairs with conflicting values *(NEW)*

**DIFFERS (structural).** `theme.css` defines the same selector twice, with
different values, in three cases. Later wins; the earlier block is **dead**.

| Selector | Operative (wins) | Dead |
|---|---|---|
| `.sidebar-footer` | `padding: 8px` (:1305) | `padding: 4px 10px` (:556) |
| `.sidebar-title` | `@accent`, 15px, ls 0.2px | `@text_dim`, 11px, `padding: 12px 14px` |
| `.sidebar-header` | `padding: 14px 16px` + `border-bottom` | `padding: 8px 8px 4px 12px` |

This is a **concrete instance of the drift the design-system audit predicted**:
independently-appended style blocks colliding with **no selector conflict a
merge-time check would catch** — both blocks are valid CSS and neither errors.
It is evidence for tokenisation, not three stray rules.

### W2 — `sidebar-footer` name collision PERSISTS *(re-confirmed, still open)*

**DIFFERS (structural).** Two live widgets are named `sidebar-footer`:
`sidebar/mod.rs:1313` and `app.rs:625`. Confirmed **at source and at runtime**
(the tree walk returns the name **×2**).

A harness hazard as well as a defect: a name-addressed selector silently
resolves to whichever the walk hits first. Observed directly — the per-widget
capture of `sidebar-footer` returned the *sidebar's* footer, not `app.rs`'s
usage-bars box. Nothing in the result says which one you got.

### W3 — Sidebar divider: a stock separator Electron does not have

**DIFFERS.** Column-persistence voting, y200–900, **100% consistency per
column** (opaque surface — no translucency risk):

| | Electron | GTK |
|---|---|---|
| x=339 | `(36,42,51)` border token, 100% — the **entire** divider (1px) | — |
| x=518 | — | `(27,27,27)` stock `GtkPaned` separator, 100% |
| x=519–520 | — | `(36,42,51)` border token, 100% (**2px**) |

GTK paints the correct token; the defects are **structural**: an extra 1px stock
separator Electron lacks entirely, plus a border 2px where Electron is 1px.

⚠️ **The obvious fix is wrong.** Recolouring the `(27,27,27)` column to the
border token — the fix a "wrong divider colour" report implies — yields a
**3px** border, degrading it. Suppress the separator and halve the border.
*Re-confirmed on my own controls; matches the first wave's D3.*

### W4 — Section titles lose their colour coding *(re-confirmed)*

**DIFFERS.** Electron ground truth from the **live DOM**:

| Header | Electron (DOM computed) | GTK |
|---|---|---|
| ORCHESTRATORS | `rgb(126,231,135)` green | `@text_dim` grey |
| SCRATCH | `rgb(227,179,65)` amber | `@text_dim` grey |
| repo (ORCHESTRA) | `rgb(139,149,167)` grey | `@text_dim` grey — **matches** |

**Carries its own positive control**: the repo header is grey on *both* sides
and reads identically, so the sampler is not colour-blind and the two mismatches
are real. Root cause: Electron scopes colour per section
(`.orchestrator-section .repo-name`, `.scratch-section .repo-name`); GTK has
**neither class** — 0 rules for both, confirmed in a sweep whose controls passed.

Both sides otherwise agree: 10px / 600 / `letter-spacing: 0.8px` /
`text-transform: uppercase`.

### W5 — `.setup-pill.failed` text is saturated red, not pale pink

**DIFFERS.** Measured from **composited full-window frames** with a backdrop
guard asserting the region really sits on the sidebar base before any colour is
reported (Electron `(18,21,27)` ✓, GTK `(18,21,26)` ✓).

| | Electron | GTK |
|---|---|---|
| Fill | `(55,31,35)` **33.0%** — the composited `rgba(220,80,80,0.18)` tint | — |
| Text | **exactly** `(255,180,180)` `#ffb4b4`, 15.2% | **exactly** `(255,107,107)` `@red`, **88.9%** |

⚠️ **Scope of the 88.9%**: this is a **text/glyph** measurement. Text is opaque
on both sides by design, so the translucency artifact that invalidated a
similar-looking "88.8% dominance" figure elsewhere today **does not apply here**.
The alpha risk was only ever on the *fill*, and the fill is reported as the
composited value, not the token.

Also: **`.setup-pill.running` has no GTK rule** — the blue running variant
(Electron `rgba(110,168,255,0.18)` / `rgb(184,212,255)`, read from the DOM) is
absent. Base pill geometry **matches**: 9px / 600 / `0 5px` / radius 9999px.

### W6 — Usage-bar labels are not uppercased *(re-confirmed, rendered)*

**DIFFERS.** Rendered widget crop shows GTK painting **`5h`**; Electron's DOM
gives `text-transform: uppercase`, `letter-spacing: 0.4px`, so it paints `5H`.
GTK's operative rule is `.usage-bar-label { color: @text; font-weight: 600 }` —
**neither property present**.

Not the "parses but does nothing" trap: `text-transform: uppercase` is
**observably working** elsewhere in GTK — `.repo-name` carries it and the
section headers render uppercase from lowercase source strings. That is an
observed positive control, not an assumption.

### W7 — Footer: no icons, no Resources link, different class

**DIFFERS.** Rendered crop shows GTK painting **`GitHub  Logs  Linear` as plain
text, no icons**. Electron's DOM reports **4** `.sidebar-footer-link` elements
(Resources / lcsmas-orchestra / Logs / Linear) each with an icon.

- GTK's class is `.footer-link`; Electron's is `.sidebar-footer-link`
- `.sidebar-footer-link` has **0 GTK rules** and **0 Rust references**
  (controls: `ws-row` = 6 refs, `zzznonsensecontrol` = 0, same command) — so
  `.sidebar-footer-link.active` and the external-link `svg:last-child` dimming
  have no GTK counterpart
- **No Resources link** in the GTK footer (it lives in the sidebar header)

### W8 — GTK ships a debug status strip in user-facing chrome

**DIFFERS (GTK-only).** At the same y-band, the two apps show different content:
Electron paints the Insights strip + footer links; GTK paints a usage bar,
"Accounts", and **`backend: mock v0.1.0 · frontend v0.5.84`**. Confirms
inventory row 33 (a developer surface in shipped chrome) **on a rendered frame**.

### W9 — Row content: the `·` separator is missing in GTK

**DIFFERS (minor).** Same workspace (`chime-volume`), same selected state, both
frontends. Electron renders `chime-volume · default`; GTK renders
`chime-volume default` with no middot separator. Status dot, name and MERGED
pill match in position and colour.

### W10 — Released pills: a DATA-PATH bug, not a parity defect *(NEW — file separately)*

**This is a real bug, in the data path rather than the UI.** It is listed here
because a screenshot cannot distinguish it from a rendering defect.

GTK paints two released pills (`0.5.88`, `0.5.89`) on `chime-volume`; Electron
paints none. Both fixtures carry identical data (`releasedAt: base`,
`releasedVersions: ['0.5.88','0.5.89']`) and Electron's render gate
(`Sidebar.tsx:1902`, gated on `w.releasedAt`) is correct.

Asking the running app settles it — `listWorkspaces()` returns:

```
releasedAt: null,  releasedVersion: null,  releasedVersions: null
keys present: ["releasedAt","releasedVersions","releasedVersion"]
```

The **keys survive and the values are stripped** between store and renderer.
`.released-pill` count in the DOM is **0** — the elements are not built at all,
so it is neither clipping nor zero-size.

⚠️ **Filing this as a rendering defect would send someone to fix a renderer that
is behaving correctly on the data it was given** — and the natural "fix" (making
the renderer compensate for missing data) would be a genuine regression.

---

## Surfaces that MATCH

| Surface | Evidence |
|---|---|
| **Sidebar background** | GTK `(18,21,26)` vs Electron `(18,21,27)` — 1/255, over **81,200 samples** each (opaque surface). Replicates the first wave and again fails to reproduce a withdrawn "one token step too light" claim. |
| **Active-row accent bar** | Located by **scanning** for the accent, not a fixed band. Boot: Electron y147–176 (30px), GTK y90–117 (28px). Selected (**same workspace**): Electron y523–565 (43px), GTK y467–511 (45px). Both **exactly** `(110,168,255)`, 2px wide (x0–1), on both sides in both states. |
| **`.ws-empty-hint` styling** | GTK **does** have a rule — `padding: 20px; color: @text_dim; font-size: 12px` — matching Electron's inline `padding: 20px; color: var(--text-dim); fontSize: 12`. ⚠️ **Corrects the first wave's D5**, which stated "0 CSS rules either side". |
| **Section header type** | 10px / 600 / ls 0.8px / uppercase both sides (only the *colour* differs — W4). |
| **Base `.pill` geometry** | 9px / 600 / `0 5px` / radius 9999px both sides. |
| **`.repo-sync` row** | Renders on both; GTK 1218–2131 bytes across 4 widgets with sibling controls passing. |
| **Insights strip** | Renders (2509 bytes); purple icon, bold title, right-aligned meta. |
| **Design tokens** | `@red #ff6b6b`, `@text_dim #8b95a7`, `@accent #6ea8ff`, `@text #e6e9ef` — identical literals both sides. Defects are per-rule application, not wrong tokens. |

---

## Corrections to inherited claims

Re-derived rather than inherited, per instruction. **Three inventory/first-wave
claims are wrong at this tip.**

| Claim | Status | Evidence |
|---|---|---|
| `usage-bars-slot` is a dead mount point (inventory 76, first-wave D11) | **CLOSED — no longer true** | Deliberately **removed**, with an explanatory comment at `sidebar/mod.rs:779`. Absent from the live tree while `usage-bars` renders **7647 bytes**. Someone would have "fixed" a deliberate removal. |
| `.usage-bar-fill.meter-*` CSS is dead — "no Rust applies it" (inventory 80, 99) | **FALSE** | **2 Rust references** — `overlays/resources.rs:986` and `:1166`. The class is live, just used by the Resources page rather than the sidebar bars (which use `.usage-bar-track`, 4 refs). Controls in the same command: `ws-row` = 6, `zzznonsensecontrol` = 0. |
| `.ws-empty-hint` has 0 CSS rules either side (first-wave D5) | **FALSE for GTK** | GTK rule exists and matches Electron's inline style (see MATCH table). The *glyph/bold* half of D5 is untouched by this. |
| Two competing `sidebar-footer` widgets (first-wave D12) | **STILL TRUE** | Re-confirmed at source **and** runtime ×2 (W2). |

---

## CANNOT-VERIFY

| Surface | Reason | Rig that would close it |
|---|---|---|
| Row **hover** state | No pointer in the headless seat | A GTK `SimpleActionGroup` action emitting the same message the hover controller does |
| **`.sidebar-footer-version`** stamp | Electron's footer row is **clipped at the sidebar edge** at the current width — the Linear link and version stamp are cut off, not absent. A sibling is actively changing sidebar width, so any verdict would be stale on arrival | Re-measure after the width fix lands |
| **Archived** section internals (bar, rows, checkboxes, bulk-delete progress) | Below the visible fold with 14 fixture rows; expanding it is a drive step, but the rows still fall outside the viewport | A scroll step in both drivers, or a smaller fixture |
| **Usage-bars hover popover** (`.usage-bars-panel`) | Zero allocation while closed — correct for a closed popover, but means it is unreachable without a pointer | Same action-group approach as hover |
| **`.pr-badge`** variants, `.ws-size`, `.ws-hidden-count`, `.orchestrator-pill` | **0 instances in the Electron DOM in this state** — the fixture does not exercise them. Their GTK rules exist but nothing carries them here | A fixture row with PRs, a size, hidden agents |
| Sidebar **width/scroll drag** | Requires pointer drag on the Paned separator | Same headless-seat limit |

<a name="not-reached"></a>
## Not reached — all 22, named individually

**No rendered evidence** for these. They are the next wave's starting list.
Grouped by what would close them, since the fix is shared within each group.

**Needs a pointer / gesture the headless seat cannot synthesize (6)** — closable
with a `SimpleActionGroup` action emitting the same message the controller does:

| Row | Surface | Why not reached |
|---|---|---|
| 53 | Row action buttons (unread/archive/delete/sandbox) | hover-revealed states |
| 70 | Account migrate popover `AccountBadge.tsx:253` | needs right-click |
| 82 | Usage panel account row `UsageBars.tsx:175` | inside closed popover |
| 83 | Usage panel mini bar `UsageBars.tsx:132` | inside closed popover |
| 50 | Inline rename input `Sidebar.tsx:1270` | needs a rename drive step |
| 56 | Delete confirmation tone | needs a destructive drive I declined to run |

**Fixture does not exercise the state (7)** — closable by adding fixture data to
**both** `mock.rs` and `seed-store.mjs` in the same change:

| Row | Surface | Why not reached |
|---|---|---|
| 59 | Orchestrator pill `Sidebar.tsx:1868` | 0 instances in fixture state |
| 62 | Unpushed pill `Sidebar.tsx:1928` | 0 Electron instances |
| 63 | Compact diff indicator `Sidebar.tsx:1936` | 0 Electron instances |
| 66 | PR badge open/merged/closed `Sidebar.tsx:421` | 0 instances in fixture |
| 67 | "+N more PRs" badge `Sidebar.tsx:441` | 0 instances |
| 68 | Linear issue badge `Sidebar.tsx:408` | 0 instances |
| 69 | Account badge on rows `AccountBadge.tsx:311–384` | present, but `sev-*` variants not exercised |
| 54 | Row spinner `Sidebar.tsx:1332` | needs a workspace in a transient state |

**Below the visible fold (4)** — closable with a scroll step in both drivers, or
a smaller fixture:

| Row | Surface | Why not reached |
|---|---|---|
| 45 | Host group + header `Sidebar.tsx:2029` | sandbox rows below the fold |
| 72 | Archived selection bar `Sidebar.tsx:2117` | below fold |
| 73 | Archived bulk-delete progress `Sidebar.tsx:2105` | below fold |
| 74 | Archived row `Sidebar.tsx:2147` | below fold |

**Present but not isolated in pixels (4)** — a drive/crop gap, not a blocker:

| Row | Surface | Why not reached |
|---|---|---|
| 27 | Help icon button `Sidebar.tsx:1362` | on the status strip, not the header |
| 28 | Sound/bell button `Sidebar.tsx:1370` | on the status strip |
| 49 | Row collapse caret `Sidebar.tsx:1234` | in the tree; not isolated in pixels |
| 41 | **Repo scripts modal** `RepoScriptsModal.tsx:124` | stub dialog; opening it not driven |

Also unverified within a *covered* row: **repo drag states**
(`.repo-dragging`, `.repo-drop-before/after`, row 37) — needs a pointer drag.

---

## Method notes — three ways a measurement lied during this audit

Recorded because each produced a **plausible, specific, actionable WRONG**
result rather than an error, and all three were caught by controls rather than
by noticing something looked off.

**1. `$?` from the wrong command → a false "dependencies present".**
`ls .localdeps 2>&1 | head -3; echo $?` printed **RC=0 while `ls` failed** —
the code came from `head`. That is what made a missing `.localdeps` look
present. Every subsequent check captured `RC=$?` on its own line and verified by
**artifact presence**, never the printed code.

**2. Widget-scoped snapshots of translucent surfaces — and the parent is not
always enough.** A widget-scoped snapshot renders a translucent surface over
**nothing**, so a correct tint reads as an opaque slab. The standard remedy is
"snapshot a parent" — **that was insufficient here**: a row-scoped capture came
back **91.0% pure black `(0,0,0)`** because the *row* background is itself
transparent. The rule needs to be **snapshot an ancestor that paints an opaque
background** (here, only the full window).

Mechanical guard adopted: **after any ancestor-scoped snapshot, assert the
backdrop is the expected background colour before trusting any colour in it.**
A pure-black or unexpectedly-dark dominant means you are still compositing over
nothing. ⚠️ **Bound the backdrop sample by the surface height, not a constant** —
this guard's first run sampled 5px above a ~7px band, landed *inside* the pill,
and refused valid data by reading the very tint it exists to validate. The
error direction is favourable: too close fails **loudly**; too far crosses into
another element and **passes wrongly**.

**3. A tree-driven probe reported four widgets as zero-allocation.**
Four `repo-sync` widgets read **0 bytes** in a long sequential probe; re-run
with positive controls they render at **1218–2131 bytes**. The zeros were a
**layout-timing artifact of my own loop**, not a property of the widgets — four
false ABSENT verdicts would have shipped. So "zero bytes" has a false-positive
mode beyond occlusion: **measuring before layout settles**.

**Two instrument audits that changed a conclusion:**

- A `grep` sweep with `--include=*.rs` **unquoted** returned **0 for every
  class** — including `ws-row`, which I had just proven has 6 references. zsh
  rejected the glob and every count was a false zero. The **positive control is
  the only reason this was caught**; without it, six classes would have been
  reported dead, one of them provably live.
- My `applied?` column samples classes only on **named** widgets, so `.ws-dot`
  and `.repo-name` read `no` while both are demonstrably added in Rust. **No
  verdict in this report is drawn from that column** — the dead-class claims
  (W7) come from Rust reference counts with both controls in the same command.

**A method rule this audit relied on repeatedly:** an assertion pinned to a
*fixed region* silently tests whichever element happens to sit there. The
accent-bar verdict was nearly filed as ABSENT-in-GTK from a fixed band that was
simply pointing at a non-active row; **scanning** for the feature and reporting
where it was found turned a false defect into a MATCH — in both states.

---

## Capture manifest

All regenerated at `6ca9a83`. **13 files, 13 unique md5s, 0 duplicates.**

| File | What it SHOWS |
|---|---|
| `e-bottom.png` / `g-bottom.png` | Bottom strip — Electron Insights+footer vs GTK usage bar+Accounts+debug strip (W8) |
| `e-footer-wide.png` / `g-footer-wide.png` | Footer rows; Electron's clipped at the sidebar edge |
| `e-row-chime.png` / `g-row-chime.png` | **Same workspace, same selected state** — the matched pair (W9, W10) |
| `e-row-chime-boot.png` / `g-row-chime-boot.png` | Same row unselected, showing the pill difference is not a selection effect |
| `w-sidebar-footer.png` | GTK footer: text-only links, no icons (W7) |
| `w-usage-bar-5h.png` | GTK usage bar rendering `5h` lowercase (W6) |
| `w-insights-row.png` | GTK Insights strip |
| `electron-dom.json` | Electron ground truth: 52 selectors, computed styles with alpha explicit, exact rects |
| `gtk-css.txt` | GTK rule sweep with full cascade ranking (operative vs outranked) |

Source full-window pair: `gtk-full-window.png` `86ded2d7…`,
`electron-full-window.png` `5adde89a…`.

---

## Excluded by instruction

Sidebar **width** (Electron 337px content / GTK 516px) and pane-x-offset are
**not reported as defects** — a sibling is actively fixing them. They appear
only as the reason pane-relative geometry is measured from each side's own edge.
