# Transient-surface parity audit — dialogs, modals, popovers, banners

**Wave 2. Report only — nothing was fixed.** Captures and probes live beside
this file; provenance in `CAPTURED-AT.json`.

Every verdict below comes from a **rendered frame** of both apps driven into a
state, not from reading source. Where I could not get both halves into the same
state, the verdict is CANNOT-VERIFY and says what rig would close it.

---

## Coverage: 14 of 19 surfaces

| # | Surface | Verdict |
|---|---|---|
| 1 | Dialog card geometry | **DIFFERS** — 378×272 vs 420×251 |
| 2 | Dialog tone set | **DIFFERS** — 3 tones vs 4; danger missing |
| 3 | Dialog tone on delete path | **DIFFERS** — GTK `tone-info` where Electron uses `dialog-danger` |
| 4 | Dialog detail line | **DIFFERS** — full-bright vs dimmed |
| 5 | Dialog tone icon | **DIFFERS** — one `.dlg-icon` vs 4 `.dialog-icon-<tone>` |
| 6 | Backdrop **dim** | **DIFFERS (defect)** — 0.3% vs 38.0% luminance drop |
| 7 | Backdrop **blur** | **CANNOT-BE-IDENTICAL** — GTK4 has no `backdrop-filter` |
| 8 | Modal presentation model | **DIFFERS** — separate OS toplevel vs in-page overlay |
| 9 | Repo-scripts modal | **MATCHES** (638 vs 640 px) — inventory "STUB" is **stale** |
| 10 | Repo-scripts placeholders | **DIFFERS** — tooltip vs visible greyed text |
| 11 | Linear settings modal | **DIFFERS** (458 vs 520) — inventory "ABSENT" is **stale** |
| 12 | Sound settings modal | **DIFFERS** — 418×553 vs 520×720 |
| 13 | Accounts settings modal | **DIFFERS** — 620×680 vs 560×854 |
| 14 | Branch picker popover | **CANNOT-VERIFY as a pair** + GTK-side defect found |

### Not reached — where the next wave should start

1. **Prompt-queue banner** (`queue-banner`) — built statically, `visible=False`
   at boot; needs a queued-prompt event to show.
2. **Setup banner** (`setup-banner`) — same, needs a workspace mid-setup.
3. **Sandbox control bar** (`sandbox-control-bar`) — same, needs a sandbox
   workspace focused.
4. **Account login modal** (`accounts/login_modal.rs`) — reachable only through
   a real login flow.
5. **Context menus / right-click surfaces** — the harness synthesizes
   `Button::emit_clicked` and row selection; it has **no right-click op**, and
   headless sway advertises no pointer. Not reachable by construction.

All five are *unreached*, not *absent*. Three of them (1–3) are **built at boot
and only flip `visible`** — see "controls that cannot fire", below.

---

## Findings

### 1. Backdrop: the dim is a defect, the blur is not — file them separately

This is the finding most at risk of being wrongly closed.

`.dialog-backdrop` (styles.css) carries **two separable properties**:

```css
background: rgba(6, 8, 12, 0.6);            /* a flat alpha fill */
backdrop-filter: blur(14px) saturate(120%); /* GTK4 has no equivalent */
```

Measured on a `grim` **output grab** (the only instrument that can see this —
see below), over the sidebar region `(0,0)-(520,970)`, `n=504400`, identical
content in both frames so the delta is the scrim alone:

| | closed | open | delta |
|---|---:|---:|---:|
| **GTK** mean luminance | 29.34 | 29.78 | **−1.5%** (wrong direction = noise) |
| **Electron** mean luminance | 30.40 | 18.86 | **−38.0%** |
| **Electron** spread | 18.13 | 11.80 | **−34.9%** (collapse) |

GTK paints **no scrim at all**. The dim is a plain alpha fill any toolkit can
draw — a GTK app can tint its own main window while a child window is up — so
**DIM is a DEFECT**. Only **BLUR is CANNOT-BE-IDENTICAL**.

> Guard this split. Finding #8 (separate OS toplevels) *mechanically explains*
> the missing scrim, and a proven architectural fact is the most seductive
> possible reason to close a fixable defect. "Separate toplevel, therefore no
> in-page backdrop, therefore nothing to do" sounds complete and is wrong.

### 2. Dialog tone: the destructive path renders as informational

Read from the **live widget tree** with the delete-orchestrator dialog open:

| | GTK | Electron |
|---|---|---|
| root classes | `orch-dialog tone-info` | `dialog dialog-danger` |
| icon glyph | `ⓘ` | red `!` in a red ring |
| confirm button | "Confirm", `text-button suggested` (blue) | "Delete" (red) |

`dialogs.rs:29-33` defines exactly three tones (Info/Error/Success). Confirmed
at binary level with controls in one command — `tone-warning` **0**,
`tone-danger` **0**, against positives `orch-dialog` 8 and `tone-info` 2, and a
known-absent negative control at 0.

So the app's most destructive action is styled as an informational prompt.
Inventory row 56 says `confirm_destructive` exists but is not wired to the
delete path; the rendered frames confirm the user-visible consequence.

### 3. Dialog detail line is not dimmed

Measured on the composited card, dominant non-background ink:

| | message line | detail line |
|---|---|---|
| **GTK** | (230,233,239) | **(230,233,239)** — same as message |
| **Electron** | (230,233,239) | **(139,149,167)** — dimmed |

`.dialog-detail { color: var(--text-dim) }` computes to `rgb(139,149,167)`.

> **Why this verdict is trustworthy despite a compositing hazard:** GTK captures
> are RGBA and my first reading composited them onto black, fabricating
> `bg=(0,0,0) ink=(255,255,255)`. The corrected measurement has a **built-in
> differential control**: both apps agree *exactly* on the message ink
> (230,233,239) while diverging only on the detail line. A compositing artifact
> would have shifted **both**. The matched line proves the pipeline is faithful,
> which is what licenses the unmatched one.

### 4. Geometry

Both apps pinned to **1600×973**, asserted per capture.

| Surface | GTK | Electron | Δw | Governing rule |
|---|---|---|---:|---|
| Dialog card | 378×272 | 420×251 | −42 | `.dialog` **420px** |
| Repo-scripts modal | 638×900 | 640×854 | **−2** | `.repo-scripts-modal` **640px** |
| Linear settings | 458×321 | 520×273 | −62 | `.modal` **520px** |
| Sound settings | 418×553 | 520×720 | −102 | `.modal` **520px** (inherited) |
| Accounts settings | 620×680 | 560×854 | **+60** | `.accounts-settings` **560px** |

**`.linear-settings { width: 460px }` is DEAD CSS.** It sits at stylesheet
offset 16372; the base `.modal { width: 520px }` sits at 70326. Equal
specificity, later rule wins → **520px governs**, confirmed by measurement.
Anyone "fixing" GTK's Linear modal to 460px would be porting a cancelled rule.

Repo-scripts is the only near-match. Accounts is the only case where GTK is
*wider* than Electron.

### 5. Modal presentation model (inventory row 131) — proven, not asserted

Confirmed on **two independent instruments** while a GTK modal was open:

- compositor: a **third toplevel** `orchestra-gtk 460x323` beside the 1600×973
  main window;
- `list_widgets`: `linear-settings` is a **sibling** of `main-window`, not a
  descendant (`['main-window', 'GtkWindow', 'sound-settings', 'accounts-settings']`).

Electron modals are in-page `.modal-backdrop` overlays; GTK modals are separate
OS windows. This is *why* there is no scrim — there is no in-page backdrop
element, because there is no in-page anything.

### 6. Repo-scripts placeholders route to tooltips

Electron's third textarea has an empty value and a multi-line `placeholder`
rendering as visible greyed guidance. GTK's ARCHIVE box renders **nothing**
(397 capture bytes vs ~2300 for its populated siblings).

`repo_scripts.rs:153-157` documents the reason: GtkTextView has no placeholder
API, so the hint goes to `set_tooltip_text` "instead of faking text the save
path would then persist." A defensible tradeoff with a real user-visible cost —
guidance is invisible until hover.

### 7. Branch picker — CANNOT-VERIFY as a pair, plus a GTK-side defect

**Not comparable:** GTK's mock serves 4 branches; Electron's seeded store serves
**0** for the same workspace, so its popover renders empty (320×149, 0 items).
Different data states — no pair verdict. *Closing rig: seed branch data into the
Electron fixture, or point both at one backend.*

**GTK-side observation (single-app, so reported as such):** only the selected
row paints legibly.

| row | allocation | dominant ink (alpha read, not composited) |
|---|---|---|
| `develop` (selected) | 248×20 | `(74,140,255,255)` opaque blue, 51.9% share |
| `master` | 71×**10** | `(255,255,255,**202**)`, 7.1% share, 254/710 px visible |
| `spike/vte` | 95×**13** | `(255,255,255,**72**)`, 7.1% share, 336/1235 px visible |

All four names exist in the widget tree, so this is **rendering, not missing
data**. Unselected rows allocate ~half the height of the selected one and their
glyphs are semi-transparent. Needs a fix agent to diagnose.

Contradicting inventory row 122: the search **magnifier icon is present**, as is
the keyboard footer.

### 8. Stale inventory — the false verdicts run toward ABSENT

`docs/gtk4-parity-inventory.md` is **wrong in the dangerous direction** for my
region:

- row 130 "Linear settings modal — **ABSENT**": `modals/linear.rs` is **500
  lines**; rendered frame attached; 9 named widgets.
- row 41 "Repo scripts modal — **STUB**": `modals/repo_scripts.rs` is **607
  lines**; rendered frame attached; 11 named widgets.

A source-derived "missing" verdict in that document should not be trusted
without a frame.

---

## Instrument log — what broke, and why the numbers survive it

Recorded because each failure produced a **plausible, specific, actionable
wrong answer** rather than an error.

1. **Three instruments answered the scrim question, two structurally could
   not.** A widget-scoped snapshot renders *offscreen* via `WidgetPaintable`, so
   it cannot see anything behind the widget. A main-window snapshot cannot
   contain a *sibling* toplevel, so it returns a clean frame with no modal in
   it. Only a `grim` output grab sees the composited result. **None of the three
   errored; all produced a plausible image.**
   → Before choosing an instrument, ask whether the surface is a **descendant**
   of what you are snapshotting.

2. **Occlusion and wrong-window look identical.** A sibling agent's overlay was
   *present but painted over*; mine was *present but not in this window*. One
   frame cannot distinguish them, and both read as "the surface is missing."

3. **RGBA composited onto black** fabricated `bg=(0,0,0) ink=(255,255,255)`.
   Caught because it is implausible on its face. Fixed by reading alpha directly
   (branch rows) or compositing onto the card's own opaque colour (dialog).
   Note: **regional dominance gives no protection here** — a translucent surface
   sampled at 88% share yields a *sharper* wrong answer.

4. **Comparability precedes precision.** sway silently **tiled both apps at
   800px**. Electron's `.linear-settings` then computed to 339px — squeezed by
   its backdrop parent, not by its own rule. A tighter measurement on an
   unmatched pair yields a sharper wrong number and more confidence in it.

5. **Setting geometry is not holding it.** Window state reverted three times
   (fullscreen stolen, focus stolen, workspace switch dismissing a GTK modal).
   `focus.sh` now **prints and asserts** achieved geometry, exiting nonzero
   unless focused+visible at full width.

6. **Opening a surface before focusing it destroyed the surface.** A compositor
   move dismissed a GTK modal *while the geometry assertion passed* — a green
   control on a vanished target. Corrected order: focus → open → re-assert
   presence **in the same breath as** the capture.

7. **An in-band failure went unread.** `click('ws-delete-ws-1')` returned
   `ok:false, "no widget named …"` (only some rows carry a delete button) and I
   read only the after-state — nearly filing "delete dialog does not open" as an
   app defect. **Assert the op result first, then the state.**

8. **A negative from a guessed identifier is an unrun test, not a finding.** I
   guessed `sound-modal`/`accounts-modal`; the real toplevels are
   `sound-settings`/`accounts-settings`. Both are fully built. Enumerate
   toplevels first, then assert.

9. **A capture named for the wrong surface.** `e-sound-settings.png` initially
   showed the *Linear* modal over a blurred sound modal — a dismiss step had not
   closed the previous one. Recaptured after asserting **exactly one** modal
   open. Duplicate-hash guards ran on every capture set (all distinct).

10. **A property of my environment read as a property of the subject.** sway
    reports `border_width=2 titlebar_h=27` — I nearly filed "GTK modals carry a
    titlebar Electron modals lack." It is **my compositor's decoration policy**,
    applied to both windows identically. Filed as CANNOT-VERIFY; closing rig
    needs the client's own decoration mode (CSD vs SSD / xdg-decoration). *The
    tell was that both apps were affected identically — a single-app measurement
    would have looked conclusive.*

### Controls that cannot fire, by mechanism

`queue-banner`, `setup-banner` and `sandbox-control-bar` are **built at boot and
only flip `visible`** (all three report `visible=False` in the boot tree, inside
a `main-banners` box that is `visible=True`). Their subtrees are **identical
open and closed**, so a descendant-count control is structurally incapable of
detecting them. Nothing inside the control set could report this — it came from
reading the tree, not the results. Any future sweep of those three must drive a
real state change and assert on `visible` or on pixels.

### Controls that did run

- **Walker positive control** — `main-window` asserted visible before trusting
  any absence; a walker bug then fails *as* a walker bug.
- **Binary content controls** — `tone-warning`/`tone-danger` zeros paired with
  known-present positives and a known-absent negative *in the same command*.
- **Per-widget allocation gate** — capture **byte size** with a sibling in the
  same container as positive control. `linear-key-remove` (0 bytes) is correctly
  hidden (`visible=False`, no key set) — **not** a defect; `linear-key-status`
  is `visible=True` with an empty label, benign but state-dependent.
- **A/B toggle control** — sidebar `backdrop-filter` off → backdrop 339px→1596px,
  proving the containing-block trap below rather than asserting it.
- **Duplicate-hash guards** — every capture set, all distinct.

---

## Incidental finding, outside my region (Electron bug)

**Sound and Linear modals are trapped inside the sidebar.** Their
`.modal-backdrop` renders inside `DIV.ws-list` and computes to **339px** wide
despite `position: fixed; inset: 0`.

Cause: `ASIDE.sidebar` has `backdrop-filter: blur(18px) saturate(...)`, which
per CSS spec makes it a **containing block for `position: fixed` descendants**.

Proven by A/B toggle, not inferred: with the sidebar's `backdrop-filter`
neutralised the backdrop goes **339px → 1596px** and the modal renders at its
designed 520px.

Consequence: two modals are clamped to sidebar width and their scrim covers only
the sidebar. Not mine to fix; flagging because it corrupts any width measurement
taken against them.
