# GTK4 exact-parity plan (M5)

**Goal, restated in one line so a wrong reading dies here:** the GTK frontend
must look and behave *identically* to the Electron frontend — not "close", not
"the ported surfaces match". Every difference a user can see is a defect.

**Status of the previous milestone, honestly:** M4 shipped five surfaces and
four verification waves, and the user then listed twelve visible defects in one
sitting. That list was better than the waves produced. This document starts
from why, because repeating the method would repeat the result.

---

## 0. Why four verification waves missed what one user saw in a minute

Each cause below is structural, not effort. The plan is built to remove them.

**A source-derived inventory anchored everything.** `gtk4-parity-inventory.md`
was written once by reading code and guessing widget identifiers, so its
negatives fail one direction — toward claiming implemented things are missing.
Four surfaces it calls ABSENT are fully built. Every agent was briefed from it,
so its blind spots became theirs.

**Verification was scoped to what had been ported.** Agents were asked "does the
pill match?", never "does the app look the same?". A surface nobody ported was a
surface nobody checked, and the reports honestly said so — the coverage number
was never the parity number.

**Static screenshots cannot see the defects the user listed.** Hover states,
the collapse-scroll jump, VTE scrambling under load, and menu behaviour are all
*interaction* defects. A frame-by-frame comparison is structurally blind to
them, and the transitions gap (44 in Electron vs 1 in GTK) is invisible in any
still image.

**Nobody looked at the whole window against the whole window.** Agents owned
regions. The user opened both apps side by side. That comparison — the cheapest
one available — was never in any brief.

---

## 1. Ground truth, measured on the live pair

Both apps at 1496x892 against the same live backend, captured with a visibility
assertion before each grab.

Region dominance, 3px sampling, both windows in the same state:

| Region | GTK | Electron | Δ |
|---|---|---|---|
| Header strip | rgb(18,21,26) | rgb(26,31,38) | **30** |
| Sidebar body | rgb(18,21,26) | rgb(18,21,27) | 1 — matches |
| Sidebar bottom | rgb(11,13,16) | rgb(18,21,25) | **24** |
| Toolbar | rgb(26,31,38) | rgb(26,31,38) | 0 — matches |
| **Main pane** | **rgb(11,13,16)** | **rgb(26,31,38)** | **55** |
| Status strip | rgb(18,21,26) | rgb(26,31,38) | **30** |

**Four of six regions are wrong, and it is ONE error class repeated:** GTK
assigns the wrong background *layer* — `bg` where Electron uses `bg-3`, `bg-2`
where Electron uses `bg-3`. The token VALUES are correct; they are applied to
the wrong surfaces. That is why a CSS read finds nothing and why per-surface
audits missed it — each agent saw only its own region and had no cross-region
reference.

This single class accounts for most of "colorimetry is not the same".

**Method note this proves:** the whole-window region diff is one command and
found in seconds what four scoped verification waves did not. It runs FIRST in
every future pass.

---

## 2. The user's defect list, as the work spine

Ordered by visible impact. Each is a work item; none is closed until it has
paired evidence at the same window size against the same backend state.

| # | Defect (user's words) | First read | Owner track |
|---|---|---|---|
| 1 | colorimetry / not the same colours | main pane rgb(55,55,55) vs (26,31,38); unthemed surfaces | **T1 tokens** |
| 2 | font size | GTK rows visibly larger; no shared type scale | **T2 type** |
| 3 | font style | weights and family differ per role | **T2 type** |
| 4 | buttons are not the same | shape, padding, hierarchy | **T3 controls** |
| 5 | hovers are not the same | transitions 44 vs 1 — most states snap or are absent | **T3 controls** |
| 6 | some icons are not the same | pipeline exists; coverage and metrics incomplete | **T3 controls** |
| 7 | "+ New" menu missing | Electron has one menu; GTK has three separate buttons | **T4 chrome** |
| 8 | base branch / branch switcher display | GTK shows a raw UUID where Electron shows a repo name | **T4 chrome** |
| 9 | unread workspaces blue-*labelled* | **confirmed at source, exact fix known** — see below | **T5 sidebar** |
| 10 | list jumps to top when collapsing a repo | scroll position not preserved across rebuild | **T5 sidebar** |
| 11 | VTE scrambled / buggy | **FIXED** — font internal-name mismatch, not TUI config; see below | **T6 terminal** |
| 12 | (implicit) everything above under real data | fixtures never exercised these states | **all tracks** |

Item 8 is visible in the live capture: the GTK repo header reads
`605ea8c3-d852-4398-8044-a9abdff2cb70` where Electron reads `ORCHESTRA`.

### Item 9, traced to the exact line (worked example of the method)

The user said "unread tagged workspace are blue labeled, they should just have
the blue dot". Confirmed at source, and the precise version differs slightly
from both readings:

| | Electron | GTK |
|---|---|---|
| Name | `styles.css:1414` — `color: var(--text)` + `font-weight: 700` | `theme.css:475` — `color: @accent` |
| Dot | `styles.css:1408` — accent + `box-shadow: 0 0 6px rgba(110,168,255,.6)` | `theme.css:138` |
| Bookmark toggle | `styles.css:1420` — accent tint | `theme.css:471` |

So Electron makes the name **brighter and bolder, not blue** — blue lives on the
dot and the bookmark toggle. GTK colours the name accent, which is the blue
label the user sees. Fix: `color: @text; font-weight: 700`, and port the dot's
glow.

Note the Electron rule EXISTS (`.ws-item.unread .ws-name`), so a check for
"does Electron style the unread name?" answers YES and would have confirmed the
GTK behaviour as correct. Only reading what the rule SETS finds the defect —
the cited-rule-vs-operative-value trap, in the smallest possible form.

### Item 11, and why every suspect in the brief was wrong

The plan named three suspects — sync-output (DEC 2026), palette divergence,
resize/reflow. The cause was none of them, and it was **two silent failures that
are each a no-op alone**:

1. `orchestra-symbols.ttf` declared `family="Adwaita Mono"` — inherited from the
   face it was subset from. Fontconfig matches on the **internal** name, so
   nothing could request it.
2. `terminal_font()` asked for bare `"JetBrains Mono"`, never naming the subset,
   so Pango had no reason to prefer it even once reachable.

Registration returned success, the face *was* registered, the glyphs *did*
paint. Only the **advance** was wrong: U+2460 measured 20.0px = 2.22 cells
against a 9.0px cell, so each circled number overflowed and shifted the rest of
the line — the user's "①②③ crushed together". After the fix: 1.00 cells, with
U+0041 and U+2500 held at 1.00 as controls in both runs.

**The transferable part:** every signal short of measuring an advance reported
healthy, which is why it survived several review passes. And the Electron half
*cannot* warn you — its `@font-face` **assigns** the family name, so the same
mis-named file works there by accident of CSS semantics. A cross-frontend port
inherits an asset whose correctness is framework-dependent.

**Gate proven, not assumed:** the test asserts the *name*, not that registration
succeeded — a registration test would have passed throughout this bug's life.
Mutation-tested against the real pre-fix font: RC=0 fixed, RC=101 mutated, with
the failure text naming the cause. *(My own first run of that mutation returned
101 from a **build** failure — env not sourced, test never ran. A non-zero exit
answering an adjacent question, agreeing with what I expected. Re-run properly
before it was believed.)*

**Deliberately not fixed, with reasons:**
- *Emoji presentation* — Pango routes `Emoji_Presentation` codepoints (✅ ❌) to
  an emoji font regardless of the fallback list; they paint ~19px in a 2-cell
  slot. Those glyphs are width-2 in Claude's accounting too, so VTE reserving 2
  cells is **correct**: a ~1px paint overflow, not a grid desync. Recorded in
  code so nobody "fixes" it into a real bug.
- *Cell size* — GTK 9.0×20.0px vs Electron 8.0×18.0px (**+12.5%**);
  `mod.rs:31` "JetBrains Mono 11" (14.67 CSS px) vs `Terminal.tsx:100`
  fontSize 13. Real, measured, and it changes how many columns fit a pane.
  Tracked as its own defect — changing cell size without an Electron-side
  visual pair trades one parity defect for another.

**Still open on T6:** never driven with real Claude Code (the repro feeds
Claude-shaped bytes to a real VTE); `bold_is_bright` / `allow_bold` /
`audible_bell` / `text_blink` / `mouse_autohide` unassessed; no real user-path
pane drive, since the mock does not serve `ptyStart`.

---

## 3. Method changes — the part that makes this different from M4

**3.1 Whole-window diff is the primary gate, and it runs first.**
Before any per-surface work: capture both apps at identical size against the
same live backend, and produce a per-region difference map. The regions that
differ most set the work order. No agent picks its own scope.

**3.2 Electron is read from its own oracle, never inferred from pixels.**
Computed styles and `getBoundingClientRect` over CDP give exact values with
alpha explicit. Pixels are for the GTK side, where no oracle exists. This
sidesteps the translucency trap that produced several false findings in M4, and
it caught a data-path bug that pixels alone reported as a rendering defect.

**3.3 Interaction defects need an interaction harness.**
Hover, focus, collapse-scroll and menu behaviour cannot be verified from stills.
Required: a real seat (pointer + keyboard) under headless sway, driving
hover/click/scroll and capturing before/after pairs. Items 5, 7 and 10 are
unverifiable without it — and "unverifiable" must be reported as such, never as
a pass.

**3.3a When a check comes back agreeing with you, verify it answered the
question you asked and not an adjacent one.** This is the general form of most
false verdicts in this milestone, and unlike the oracle rule below it applies
everywhere, including where no oracle exists.

Two instances from one exchange, same defect, different instruments:

| Asked | What the signal actually answered |
|---|---|
| "did the assertion fail?" | `cargo test` RC=101 — *did the command fail* (it was a **build** failure; the test never ran) |
| "does this rule govern?" | a matching CSS selector — *does a rule with this name exist* (`.account-badge.inline` outranked it) |

Both agreed with what the checker expected, neither failed loudly, and both fail
**in the passing direction**. Expectation-agreement is the trigger for the
check, not a reason to skip it.

Corollary for mutation tests specifically: a non-zero exit is not evidence the
gate fired. Confirm the harness *ran* — a `running N tests` line and a
`test result:` line — and that the panic is in the intended test.

**3.3b When an oracle exists, reading source instead is a downgrade that can
invert the answer.** Not merely weaker — capable of returning the opposite
result. A type-scale pass compared GTK against Electron's *bare* `.account-badge`
rule (10.5px) and "fixed" a correct 10px, because `.account-badge.inline`
outranks it and all five call sites emit `inline`. Zero bare instances: 10.5px
is dead style that never governs. `getComputedStyle` returns the operative value
with the cascade already resolved and would have said 10px on the first call.
The failure is the *substitution*, not its execution — so the rule is about
instrument choice, not care.

Consequence for status: of the 34 type-scale selectors, **31 are measured and 3
are argued** — `.pr-badge`, `.res-cell`, `.diff-indicator` were cleared by
reading call sites and judging which variant dominates, which is the same step
that produced the error above. They are OPEN, not verified.

**3.4 The inventory is demoted from spec to lead list.**
Its ABSENT/STUB verdicts are treated as unverified. Enumerate the real widget
namespace and assert against it; never search for the identifier the doc names.
Known false entries are recorded in §5.

**3.5 Every claim carries its provenance.**
State the surface class beside every colour figure (fill vs ink — the alpha risk
is on fills only), the sample share and region bounds for every dominance
number, and which instrument produced it. Two numbers reading "88.8%" and
"88.9%" in M4 had opposite validity; only the surface class distinguished them.

---

## 4. Tracks

Each track is one agent. All are report-and-fix except T0, which gates the rest.

**T0 — Whole-window diff harness** *(blocks everything; do first)*
Paired capture at identical geometry against the same backend, per-region
difference map, ranked output. Deliverable is the harness plus the first ranked
diff. This replaces "agents pick regions" with "measurement picks regions".

**T1 — Design tokens and colorimetry**
Start from the main pane rgb(55,55,55). Enumerate every surface's actual painted
colour against Electron's computed values. Fix at the token level; the port has
47 hardcoded literals against 14 tokens, which is how four CSS blocks drifted
without a single selector conflict. Tokenise as part of the fix.

**T2 — Type scale**
Every text role: family, size, weight, letter-spacing, measured rendered rather
than read from source. Electron's computed styles are the reference.

**T3 — Controls: buttons, hovers, icons**
Button geometry and hierarchy; the transitions gap (44 vs 1) so states ease
rather than snap; icon coverage and metrics. Requires the T-interaction harness
for hover states.

**T4 — Chrome: the New menu and branch display**
Port Electron's single "+ New" menu. Fix the repo header showing a raw UUID.
Branch switcher presentation.

**T5 — Sidebar behaviour**
Unread indicator as a dot, not a coloured label. Preserve scroll position across
collapse/expand rebuilds.

**T6 — Terminal fidelity**
VTE scrambling under Claude Code's TUI. Suspects, in order: no sync-output
(DEC 2026) handling, colour palette divergence, resize/reflow during rapid
redraw. Compare against Electron's xterm.js configuration — this is a
*configuration* question before it is a rendering one.

---

## 5. Known-false inventory entries

Do not act on these without re-deriving:

- Welcome screen — listed ABSENT, fully renders
- Linear settings — listed ABSENT, 500 lines with a rendered frame
- Repo scripts — listed STUB, 607 lines with a rendered frame
- `.usage-bar-fill` — listed dead in two rows, 2 live refs in
  `overlays/resources.rs`
- `usage-bars-slot` — listed as an open defect, deliberately removed

The failure is directional: the survey searched a namespace it guessed, so
renamed surfaces are invisible to it. **Sweep renames specifically.**

---

## 5b. Unowned leads (carried so they are not lost between waves)

- **Terminal cell size** — GTK 9.0×20.0px vs Electron 8.0×18.0px (+12.5%).
  `terminal/mod.rs:31` vs `Terminal.tsx:100`. Needs an Electron-side visual pair
  before changing.
- **`.mini` pill strip** — GTK emits the class at `sidebar/widgets.rs:1105`,
  `theme.css` has no `.mini` descendant rule. Electron renders those PR badges
  at 8px, GTK at 9px.
- **Focus and `:active` states** — never verified by anyone in M4 or M5.
  Electron animates `transform` on `:active`; `transform` is inert in GTK4 CSS,
  so this is **not** closable by adding a rule. Needs a design decision.
- **3 argued type-scale selectors** — see §3.3b.

## 6. Definition of done

A surface is done when:

1. Its value matches Electron's **computed** value, not an approximation.
2. Paired captures at identical size and state show no visible difference.
3. Interaction states (hover, focus, active) are verified with a real seat, or
   reported UNVERIFIABLE with the rig that would close them.
4. The evidence names its instrument, region bounds, sample share and surface
   class.

The milestone is done when a whole-window diff of both apps, in the same state,
shows no region above threshold — **and the user, looking at both, cannot tell
them apart.** That last clause is the actual bar; every measurement above is
instrumentation for it.
