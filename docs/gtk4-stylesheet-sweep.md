# GTK4 stylesheet dead-rule sweep — `native/orchestra-gtk/src/theme.css`

**Status: REPORT ONLY. No CSS was deleted, and this document recommends no
deletion.** Every deletion decision returns to the coordinator. See
[§8 Why nothing here is a delete list](#8-why-nothing-here-is-a-delete-list).

Swept: `native/orchestra-gtk/src/theme.css`, 1462 lines, **895 declarations**
across 316 distinct classes.

---

## 1. Headline result

**The sweep found no verified-dead rule other than the one already annotated in
the tree.** That is a genuine finding, not a failure to look: 895 declarations
were each measured against a calibrated baseline with a same-class positive
control in the same run.

| Class | Count | Meaning |
|---|---:|---|
| **VERIFIED-LIVE** | **745** | Rendered delta vs a calibrated baseline, control detected in the same run |
| **UNVERIFIABLE-ON-THIS-RIG** | **67** | Terminal state — the rig structurally cannot reach the condition |
| **VERIFIED-DEAD-WITH-POSITIVE-CONTROL** | **1** | `.ws-login-badge { box-shadow: none }` (:371) |
| **NOT-APPLICABLE** (reported, not classified) | 82 | Baseline artifacts of my own probe — see §5 |
| Unresolved | **0** | — |

VERIFIED-LIVE breaks down as 722 confirmed on the first pass, plus 23 recovered
from false-zeros on re-test (10 `font-size`, 10 `border-color`, 3 `opacity`).

**The single most important number in this report is the 82.** Those are
declarations my probe initially reported as having no effect, *which are not
dead* — they were artifacts of my own baseline. Had I reported the first run's
raw output, this document would have listed 108 dead rules, ~all of them wrong,
each with a clean-looking measurement attached.

---

## 2. Instrument, and what each choice defends against

Everything was rendered fresh at this branch tip on an **isolated headless sway
compositor** (`WAYLAND_DISPLAY=wayland-2`; the user's live session is
`wayland-1` and was never touched).

| Design choice | Hazard it closes |
|---|---|
| Snapshot a **padded parent container**, not the styled widget | `WidgetPaintable` clips to widget bounds, so an OUTER `box-shadow` paints outside the capture. A widget-scoped probe calls every working glow dead. |
| **Per-declaration positive control of the same property class, in the same run** | A probe that has gone blind reports every rule dead — identical to this task's expected finding. A blind row reports INVALID, not DEAD. |
| **Run-level known-inert control** | Guards the opposite failure: a probe that always moves makes every rule look live. |
| **Explicit outer-glow scope control** | Proves the parent-scoping actually works rather than assuming it. Run aborts if it fails. |
| **Property-class routing** (layout → `measure()`, paint → pixel digest) | Judging paint by `measure()` manufactures false negatives across most of this stylesheet. |
| **OFF baseline that itself paints** | A transparent baseline makes "works but paints nothing visible" and "does nothing" indistinguishable. |

### Run-level controls (all green — run VALID)

```
KNOWN-GOOD paint       [background-color: rgb(255,0,0)]  -> DETECTED
KNOWN-GOOD layout      [min-width: 140px]                -> DETECTED
KNOWN-GOOD text-layout [font-size: 34px]                 -> DETECTED
KNOWN-INERT [-orchestra-nonexistent-sweep-prop: 12px]    -> ZERO (good)
SCOPE-CTL   outer glow [box-shadow: 0 0 12px 6px …]      -> CAPTURED
```

The scope control **CAPTURED**, which is the load-bearing one: it demonstrates
by measurement that this rig sees outer glows, so the `.ws-dot` glows were never
at risk of a false dead verdict here.

### Excluded evidence source (deliberate, not an oversight)

**No committed PNG under `docs/visual-reference/` was sampled.** Those captures
were last written at commit `8924229`, before two milestones landed; the GTK
toolbar renders 36px flat there against 48px with a monotonic gradient ramp at
the tip. Sampling them would have reported the **live** `.toolbar
background-image` rule as flat — a third instrument-failure family alongside the
two in my brief:

- a broken probe reports **everything** dead;
- a widget-scoped snapshot reports every **outer glow** dead;
- a stale reference artifact reports **live rules as flat**.

All three produce clean, specific, actionable, wrong findings. Recorded here so
the next reader does not "fix" the omission by sampling them.

---

## 3. Re-derivation of the two existing verdicts

Both re-derived on my own controls. I **agree with both verdicts** — and
**disagree with the stated reason for one of them.**

### 3a. `box-shadow: none` (theme.css:371) — AGREE it is dead, REASON IS WRONG

Tested on the real widget type (`.ws-login-badge` is a `gtk::Button`,
widgets.rs:810), geometry held constant:

```
as-shipped (box-shadow:none)   digest=686c5a7a5f73  geo=(24,623)
box-shadow: initial            digest=686c5a7a5f73  geo=(24,623)   <- IDENTICAL
POSITIVE CTL magenta glow      digest=2263226500c9  geo=(24,623)   <- DETECTED
```

Byte-identical against `initial` while the control moved → **VERIFIED-DEAD WITH
POSITIVE CONTROL.** Confirms the tree.

**But the annotation's reason is false.** It says *"GTK's flat/plain buttons
simply carry no default box-shadow to suppress."* Measured on a bare
`GtkButton` with no orchestra classes:

```
bare button as-is          digest=04b0441a0e0a
bare button shadow:initial digest=70dd210da178   <- DIFFER
=> default-chrome present: True
```

A plain GtkButton **does** carry a default box-shadow. The rule is dead for a
different reason: `.ws-login-badge`'s own `background: none; border: none`
already flatten the button, so by the time `box-shadow: none` applies there is
nothing left to suppress. **The verdict survives; the explanation should be
corrected**, because the current wording would mislead anyone applying the same
reasoning to a button that *hasn't* been flattened.

This also cost me a near-miss worth recording: an earlier pass on a plain
`GtkBox` showed `box-shadow: none` **MOVED**, which looked like it contradicted
the tree. It didn't — a Box has no default chrome, so that row was measuring
something else entirely. Testing on the wrong widget type can flip this verdict
in *either* direction.

### 3b. `outline: none` (theme.css:377) — AGREE, unverifiable, and now proven so

The tree says the test cannot fail. Confirmed directly rather than assumed:

```
after grab_focus(): has_focus=False  is_focus=True  window_active=False
```

The headless toplevel never activates, so `has_focus()` stays False and the
focus ring never paints. A "no difference" result here **cannot fail**, so its
silence carries no information. **UNVERIFIABLE — do not delete.** Same for
`entry { caret-color }` (`has_focus=False` on a focused `GtkEntry`): a caret
only paints in a focused editable.

---

## 4. The animation verdicts — where the tree's own probe fails

`docs/visual-reference/paint-effect-probe.py animated` reports `.ws-dot.running`
as **1/6 distinct frames — "category (c): parses but paints ONE unchanging
frame"**, i.e. dead.

**That verdict is wrong, and its own docstring predicts why.** Every frame
sampled `rgba=(0,0,0,0)` — fully transparent, nothing captured. The pulse is an
outer ring painted outside the 8px dot's bounds, and the widget-scoped snapshot
clips it away. Re-run parent-scoped, both controls behaving:

```
KNOWN-GOOD control (opacity fade)     distinct=8/8   <- probe can detect
KNOWN-INERT control (no animation)    distinct=1/8   <- probe can return zero
.ws-dot.running (ws-dot-pulse)        distinct=8/8   -> ANIMATES (LIVE)
.ws-dot.unread  (animation: none)     distinct=1/8   -> static, as intended
```

`.ws-dot.running` is **VERIFIED-LIVE at 8/8**. `.ws-dot.unread { animation:
none }` is confirmed live in the useful sense — it genuinely suppresses the
pulse, tested against a sibling that pulses.

**Action for the coordinator:** the tree's `paint-effect-probe.py` animated mode
is widget-scoped and will report any outer-painting animation as dead. It needs
the same parent-scoping its own static-mode docstring recommends.

---

## 5. The 82 NOT-APPLICABLE — my own baseline, not the stylesheet

The first run produced 108 NOEFFECT rows. **All five run-level controls were
green.** 82 of those rows were still wrong, in three distinct ways that share a
symptom and share nothing else — so one better probe would not have fixed them:

### A. min/max non-binding — 40 rows
`min-*` only binds when it **exceeds** natural size. My baseline pinned the probe
child at 40×40, so `min-width: 8px` could never bind. Re-tested against an
unpinned child — **all 11 distinct values bind**, controls detecting:

```
min-width: 8px    -> BINDS  (m=0x0 -> 8x0)    ctl[min-width:120px]=DETECTED
min-height: 20px  -> BINDS  (m=0x0 -> 0x20)   ctl[min-height:90px]=DETECTED
min-width: 260px  -> BINDS  (m=0x0 -> 260x0)  ctl=DETECTED
… 11/11 bind
```
**NOT-APPLICABLE in the first run, LIVE on re-test. Never dead.**

### B. value equals baseline — 23 rows
`font-size: 13px` read zero because my baseline *was* 13px; `border-color` read
zero because the baseline had `border: none` (no border to colour); `opacity: 1`
read zero against an already-opaque baseline. Re-tested against differing
baselines, all with controls detecting:

```
font-size:13px vs 9px baseline -> DELTA 33x11 -> 48x16
border-color: @red/@green/@accent (with 3px border width) -> DELTA (ctl DETECTED)
opacity:1 overriding 0.3 -> DELTA (ctl 0.3->0.05 DETECTED)
```
**All 23 recovered as VERIFIED-LIVE.**

### C. defensive zeroing needing threat construction — 42 rows
`border: none` (20), `box-shadow: none` (13, excluding the resolved
`.ws-login-badge` one counted as VERIFIED-DEAD in §3a), `padding: 0` (5),
`border-radius: 0` (3), `margin: 0` (1).

**A defensive-zeroing rule cannot be tested without constructing the threat it
defends against.** The success criterion and the no-op produce *identical*
observations — "nothing bad happened". Tested against a baseline that already
lacks the thing, the two states are byte-identical, and the zero says nothing
about the property. Given the threat, the same declarations suppress it:

```
border:none   vs a bordered box  -> SUPPRESSES  (m=8x8 -> 0x0, ctl DETECTED)
padding:0     vs a padded label  -> SUPPRESSES  (84x40 -> 48x16, ctl DETECTED)
min-height:0  vs a tall box      -> SUPPRESSES  (0x70 -> 0x0, ctl DETECTED)
```

These 42 are reported as **NOT-APPLICABLE / needs-threat**, not dead. Whether
each *specific* one has a threat to defend against on its *specific* widget is a
per-widget question. §3a is exactly that question answered for the 43rd member
of this family — `.ws-login-badge { box-shadow: none }` — and the answer there
was "no threat, genuinely dead", which is why it is the one VERIFIED-DEAD row
and is *not* counted in the 42. Resolving the remaining 42 the same way is
scoped follow-up work, not something this rig settles in bulk.

### How the contamination was caught — worth recording

**Not by a control firing.** All five run-level controls were green throughout.
It was caught by reading the output and noticing `.ws-dot min-width: 8px →
NOEFFECT` is nonsense on its face — an 8px minimum against a 40px pinned child
*cannot* bind.

The controls were the right controls for a different question ("can the rig
detect at all?") than the one that was failing ("is the baseline appropriate for
*this* rule?"). **A green control suite is not a claim that every verdict under
it is sound.** Domain knowledge did work here that no control could have done.

---

## 6. UNVERIFIABLE — 67 declarations, and the rig that would close each

A large UNVERIFIABLE count is the honest terminal state. These are **not**
"tried and found dead" — the conditions are unreachable, so the tests **cannot
fail**, and a test that cannot fail carries no information in either direction.

| Cause | Count | Why unreachable | **Rig that would close it** |
|---|---:|---|---|
| `:hover` | 46 | No pointer on a headless seat; GTK hover needs real crossing events | Live app under headless sway + `Input.dispatchMouseEvent`-equivalent pointer synthesis via the remote-control harness, or a `wlr-virtual-pointer` seat |
| `:selected` | 9 | Requires a realised `GtkListBox` with a selection model and real rows | Drive the live app's sidebar via `--remote-control` click op and capture the selected row |
| `:checked` | 4 | Toggle state on real `GtkToggleButton`s in the toolbar | Live app; toggle via the remote-control action group |
| `:disabled` | 3 | Requires the widget's real sensitivity logic | Live app in the state that disables the control (e.g. Insights run button mid-run) |
| `:active` | 2 | Press-and-hold state; needs a pointer held down | Pointer synthesis as for `:hover` |
| `:focus-within` | 1 | Toplevel never activates headlessly (`window_active=False`) | A **focused** window on a real/nested compositor seat |
| `outline` (focus ring) | 1 | Proven: `has_focus=False` after `grab_focus()` | Same focused-window rig |
| `caret-color` | 1 | Caret only paints in a focused editable | Same focused-window rig |

**A single follow-up rig closes most of this**: the live `orchestra-gtk` binary
under headless sway with a real seat providing pointer + keyboard focus, driven
through the existing `--remote-control` harness. That converts ~64 of the 67
from terminal-unverifiable into ordinarily-testable.

---

## 7. Reachability — a deadness class the pixel probe cannot see

A rule can render perfectly in isolation and still be dead because **no widget
ever carries the class**. That is invisible to any rendering probe, so this is a
second, independent instrument: all 316 classes in `theme.css` cross-referenced
against literal class strings in `native/orchestra-gtk/src/**/*.rs`.

**Four classes have no occurrence anywhere in the Rust source:**

| Class | theme.css | Declarations |
|---|---|---|
| `.term-toolbar` | :82 | 3 |
| `.term-tab` | :87 | 3 |
| `.run-action` | :92 | 2 |
| `.ws-branch` | :130 | 2 |

Verified against six known-present controls (`ws-dot`, `sidebar-title`, `pill`,
`run-empty`, `term-scroll`, `orch-dialog`) which all came back present, across
three independent instruments.

**This is a finding, not a verdict.** "No widget carries this class" fits two
readings equally, and the evidence cannot choose between them:

1. **Stale CSS** — the toolbar was restyled and these rules were left behind
   (`.term-toolbar`/`.term-tab`/`.run-action` look like one cluster, and §7 of
   the stylesheet defines a newer `.toolbar`/`.tab` family that appears to have
   superseded them).
2. **Missing widget** — the styling is correct and the widget that should carry
   it was never built, or lost its class in a refactor. `.ws-branch` is
   suspicious this way: the sidebar shows branch names, and a `.ws-branch` rule
   with no `.ws-branch` widget may be a *bug*, not dead CSS.

Choosing between "delete the rule" and "fix the widget" is precisely the
judgement my brief says I cannot make without an author present. **Both readings
go to the coordinator.**

### Instrument-failure note

My first reachability re-check ran `grep -ro --include=*.rs`; zsh consumed the
unquoted glob and returned **0 for all eight terms, including known-present
controls**. Absence and instrument-failure were byte-identical in that output.
Without controls in that same command I would have filed four additional classes
as unreachable off a broken tool. All counts above come from quoted-glob runs
plus a Python AST-ish extraction, cross-checked.

---

## 8. Why nothing here is a delete list

A verified-dead line still needs a judgement this sweep cannot make: *should
this rule exist?* The four M4 branches each had an author and a stated intent,
so "does this do what it says" was answerable. 1462 lines with no author present
supports "is this rule inert" per-rule and almost never "should it be here".

Concretely, three findings above are inert-but-arguably-wanted:

- `box-shadow: none` (§3a) is genuinely dead **today** — but only because
  sibling declarations flatten the button first. Delete it and a future change
  restoring the button's background silently restores GTK's default shadow. That
  is a judgement about intent, not about pixels.
- The 43 defensive-zeroing rules (§5C) are each dead *iff* their specific widget
  carries no chrome to suppress. That is 43 separate per-widget questions.
- The four unreachable classes (§7) may be dead CSS *or* evidence of a missing
  widget.

Recommendation, offered as input rather than action: **prefer annotating over
deleting** for anything inert. A deletion destroys the finding and the next
reader re-derives it — or preserves it through a refactor believing it
load-bearing. The existing `.ws-login-badge` annotations are the right pattern;
this report's §3a suggests one correction to their wording.

---

## Appendix — reproducing this

Rigs live in the session scratchpad (not committed; they hardcode absolute paths
and are one-shot):

| Script | Purpose |
|---|---|
| `inventory.py` | Parse `theme.css` → 895 declarations. Carries its own control: asserts comment-stripping removes exactly the 2 *prose* occurrences of `background: none` inside annotation blocks while keeping the 2 real declarations — proving the parser does the specific transformation it claims, not merely that it produced output. |
| `sweep.py` | Main pass. Parent-scoped, per-declaration same-class control, aborts on any run-level control failure. |
| `rebind.py` | Re-tests contamination families A (min/max non-binding), B/C (threat construction, widget-type dependence). |
| `rederive.py` | Independent re-derivation of the two annotated verdicts on the real widget type. |
| `anim.py` | Parent-scoped animation verdicts with known-good + known-inert controls. |
| `residue.py` | Re-tests `font-size` / `border-color` / `opacity` against differing baselines; probes focus reachability. |

All runs: `WAYLAND_DISPLAY=wayland-2 GSK_RENDERER=cairo` on an isolated headless
sway. No committed PNG was read. No `*.rs` file was modified. No CSS was deleted.
