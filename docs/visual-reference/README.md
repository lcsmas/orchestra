# Visual reference pair — Electron vs GTK (M4-V0)

Side-by-side captures of **both Orchestra frontends showing the same seeded
state at the same window size**, plus the scripts that regenerate them. This is
the evidence base for the visual-parity work: per `docs/gtk4-port-plan.md` §0
(revised 2026-07-20), parity is now behavioural **and** visual, and "nothing in
this workstream is done without a paired capture".

The concrete work list derived from this pair is **`DIFF-NOTES.md`**.

## The pair

| Surface | Electron | GTK |
|---|---|---|
| Full window | `electron-full-window.png` | `gtk-full-window.png` |
| Sidebar | `electron-sidebar.png` | `gtk-sidebar.png` |
| Workspace selected (full window) | `electron-workspace-selected.png` | `gtk-workspace-selected.png` |
| Main pane | `electron-main-pane.png` | `gtk-main-pane.png` |
| Toolbar | `electron-toolbar.png` | `gtk-toolbar.png` |
| Sidebar, row selected | `electron-sidebar-selected.png` | `gtk-sidebar-selected.png` |
| Confirm dialog | `electron-dialog.png` | `gtk-dialog.png` |

Both sides render **14 workspace rows** from the same fixture, at **1600×1000**.

`sidebar-selected` is captured *after* the drive expands the Archived section
(both drivers assert it opened), but with 14 rows the archived block sits below
the visible fold — so the crop shows the **selected-row** sidebar, which is what
it is named for. It is still a useful surface: it is where the active-row accent
bar (DIFF-NOTES A2) is most directly comparable. A dedicated archived-chrome
surface would need a scroll step and is left as a follow-up.

Both drivers **md5 every capture and fail the run if any two are identical** —
a click that silently no-ops otherwise yields a duplicate screenshot that looks
like a successful capture but proves nothing. This guard caught two such no-ops
while building the pair.

## Two pairs, and why the mock pair's state does NOT fully match

There are **two** reference pairs here, answering two different questions.

### The mock pair (top level) — the deterministic E2E default

The GTK app serves its fixture from compiled-in Rust
(`native/orchestra-gtk/src/backend/mock.rs`, `ORCHESTRA_GTK_MOCK=1`); the
Electron app reads a `store.json` off disk. So `seed-store.mjs` **mirrors
`mock.rs` field for field** into an Electron store. Both frontends deserialize
the same wire `Workspace` type, so the SEED is an exact mirror.

> **If you change `mock.rs`, update `seed-store.mjs` in the same change** —
> otherwise the seeds stop describing the same state.

**BUT an exact seed mirror does NOT make the captured state match**, and this is
the trap the mock pair fell into. The GTK mock SERVES every field from the
fixture, but Electron does not READ the seed for git/gh/du/usage-derived
fields — it **recomputes them live** (`src/main/activity.ts`,
`src/main/workspaces.ts`, `src/main/git.ts`) and OVERWRITES the seed. The repo
paths are deliberately non-existent, so those live computations ERROR into empty
states: no PR badges (just a `PR?` error), no size/version/unpushed pills, no
repo-sync `↓N`, and the usage strip reads the developer's real `~/.claude`. So
in the mock pair, **most "parity differences" are STATE differences, not
rendering ones** — a mock can never mirror a field the other side computes live.
(Measured: the seeds were confirmed field-for-field identical, yet the captures
diverged on ~7 of 9 surfaces.)

The mock pair is still the right default for deterministic E2E and it is the
ONLY pair that renders the rich pill zoo (a live backend against absent repos
renders none of it). Just do not read it as a rendering-parity yardstick.

### The shared-backend pair (`real-backend/`) — the trustworthy rendering yardstick

To compare RENDERING, both frontends must show the SAME data. `recapture-real.sh`
→ `capture-real-pair.sh` runs **both frontends against ONE Electron backend**:
Electron owns the backend lock and serves a ui-rpc socket for external frontends
(`src/main/ui-rpc.ts` writes `<ORCHESTRA_HOME>/ui-sock`); the GTK app, launched
**without** `ORCHESTRA_GTK_MOCK` against that same home, discovers the socket
(`native/orchestra-gtk/src/backend.rs` `discover_socket`) and attaches as a
second client (`app.rs` `attach_flow` — no daemon spawn, no lock contention).
Each frontend gets its own headless sway (two clients in one compositor get
tiled to ~half width), but they share ONE backend, so the data is identical by
construction. Any remaining difference in this pair is a **real rendering /
layout / feature difference** — including the fact that the GTK sidebar shows no
PR badges where Electron shows a `PR?` on identical data (the sidebar never
polls `findPR` per row — a real feature gap, not state noise).

The capture asserts (not assumes) the attach: it reads the GTK footer
`status-text` over remote-control and requires `backend: electron`, rejecting a
mock/daemon/none fallback that would silently produce a plausible non-shared
capture.

This pair does NOT exercise the pill zoo (absent repos → empty git/gh/usage on
both sides). That is the correct trade: it proves DATA PARITY, which the mock
pair cannot; the mock pair proves the pill zoo, which this one cannot.

The fixture deliberately exercises: orchestrator/scratch spawn trees (incl. a
cross-repo grandchild), repo groups, every status dot, unread rows, the pill zoo
(merged / released ×2 / unpushed / size / setup / context), **accounts actually
pinned** on `ws-1`→work and `ws-2`→perso (an unassigned row renders "default"
and hides the badge styling entirely), env notices, an Insights row, usage bars,
and three archived rows for the multi-select and delete-confirm surfaces.

Repo paths are intentionally non-existent (`/home/user/repos/...`): the boot
path's orphan pruner (`src/main/workspaces.ts:658`) skips repos whose path is
absent, so the seeded rows survive to first paint instead of being torn down.
A finished `selfTuneRuns` entry is seeded so the scheduler doesn't spawn a
headless `claude` mid-capture.

## Which commit is this set? — `CAPTURED-AT.json`

**A reference set that cannot tell you it is out of date is a yardstick that
lies quietly.** `CAPTURED-AT.json` records, per capture, the commit it was taken
at plus its md5, and **`check-fresh.sh` exits non-zero when rendering-affecting
code changed since the captures were taken**:

```bash
docs/visual-reference/check-fresh.sh          # is this set current?
docs/visual-reference/check-fresh.sh --at X   # is it evidence about commit X?
```

> **Staleness is per-file-per-commit, not a property of this directory.**
> A capture taken at commit X is *valid evidence about X*. It becomes a lie only
> when read as evidence about a **later** commit. The check reports which
> surfaces were taken at which commit and never says "the set is stale" flatly.

**What counts as stale is deliberately not "taken at a commit other than
HEAD".** That rule is unusably strict: committing the captures necessarily
creates a new HEAD, so a correctly-regenerated set would fail its own check one
second after being written — and *a check that cries wolf is a check people
learn to ignore*, which is the exact failure this tooling exists to prevent.
(This is observed, not theorised — the first version of the script did it.)
Instead the check asks whether anything under a **watched set of
rendering-affecting paths** (`native/orchestra-gtk/src`, `src/renderer`,
`src/main`, `src/shared`, `src/preload`, and the seed/driver scripts) changed
between the capture commit and the target. The list is deliberately wide: a
false "stale" costs one recapture, a false "fresh" costs a wrong verdict about
whether a milestone landed. When it fails it **names the files that changed**,
so the message is actionable rather than merely alarming.

Fail-closed by design: a missing manifest, a capture missing from disk, a
capture edited after the manifest was written, or a capture commit that is
unreachable from the target all FAIL. An unanswerable question is not a pass.

This is not hypothetical. Every GTK capture here was last written at `8924229`
(M4-V2's own commit), and two milestones landed after it — `387c34f` (V3:
header/env-notice/toolbar) and `82a990a` (V4: dialogs). Sampling the *committed*
`gtk-toolbar.png` then gave **36px tall and flat colour**, which reads as a
clean, specific, actionable finding: *"V3's toolbar work did nothing."* It was
wrong. A fresh capture at the tip gives **48px with a three-step gradient**.
Nothing failed and nothing warned — a stale file simply answered the question.
The verifier escaped only by checking the file's `git log` rather than its
contents. **Those captures were never invalid for V2, which was genuinely
verified against them**; they were only stale for V3 and V4.

Sidecar JSON rather than PNG metadata, deliberately: a `tEXt` chunk is invisible
in a diff, a file listing and in review, so a set whose provenance silently
stopped being updated looks identical to a current one. A JSON file shows up in
`git diff` as a changed hash next to changed binaries — new PNGs *without* a
manifest change is an obvious tell. It also survives PNG optimizers, which strip
ancillary chunks by default.

## Regenerating

**One command does both halves and records provenance:**

```bash
./native/setup-localdeps.sh          # once per worktree: rootless GTK deps
docs/visual-reference/recapture.sh   # builds, captures both, writes the manifest
```

`recapture.sh` rebuilds `target/**release**/orchestra-gtk` (the binary
`capture-gtk.sh` actually execs — `cargo test` does *not* refresh it), runs both
capture scripts, writes `CAPTURED-AT.json`, and then runs `check-fresh.sh`
against what it just produced. It refuses to run with uncommitted changes under
`native/orchestra-gtk` or `src/`, because the captures would show those changes
while the manifest recorded `HEAD` — provenance that is a lie.

Regenerating **one half alone is a trap**: the pair's value is that both sides
show the same state at the same size, so a half-regenerated set compares a fresh
frontend against a stale one and calls the difference a parity defect.

### The row pin is not optional

`recapture.sh` exports `ORCHESTRA_CAPTURE_ROW=ws-row-ws-4`. The app auto-selects
a row at boot and **which** row differs *between builds*, not merely between
runs. Auto-selection only ever lands on **tree-top** rows (`orch-1`,
`orch-scratch-kid`, `ws-2`), so the pin must be a **mid-list row that is never
auto-selected**. `drive-gtk.py` fails loudly on an absent row (`:131`) and
refuses an already-`.active` one (`:142`) rather than falling back to a racy
scan — a pair that quietly differs in selected row still looks like a rigorous
comparison. Pin correctly and it is one-shot; do not add a retry loop.

Both halves run the app in their **own headless sway**, so no window ever
appears on your desktop.

## Files

| File | What it is |
|---|---|
| `DIFF-NOTES.md` | **The V1–V4 work list** — concrete differences, both sides cited |
| `seed-store.mjs` | Mirrors `mock.rs` into an Electron `store.json` |
| `capture-electron.sh` | Headless sway + isolated `ORCHESTRA_HOME` + CDP |
| `drive-electron.mjs` | Dep-free CDP driver (screenshots each surface) |
| `capture-gtk.sh` | Headless sway + `ORCHESTRA_GTK_MOCK=1` + remote-control |
| `drive-gtk.py` | Harness driver over the `--remote-control` socket |
| `recapture.sh` | **Regenerate the MOCK pair (both halves) + manifest** |
| `capture-real-pair.sh` | **Shared-backend capture** — both frontends on ONE Electron backend (GTK mock OFF, attaches to Electron ui-rpc); writes to `real-backend/` |
| `recapture-real.sh` | **Regenerate the SHARED-BACKEND pair + manifest** (sibling of `recapture.sh`) |
| `write-manifest.mjs` | Records commit + md5 per capture (works on either dir) |
| `check-fresh.sh` | **Fails loudly when a capture is not from `HEAD`** |
| `CAPTURED-AT.json` | The provenance manifest itself (one per pair dir) |
| `real-backend/` | The shared-backend pair + its own `CAPTURED-AT.json` |

## Gotchas worth keeping

- **Sway must pick its own `wayland-N` socket.** A bare `sway -c /dev/null`
  produces no display and the app dies with "Failed to open display"; the config
  must set an output resolution (`output HEADLESS-1 resolution 1600x1000`), and
  the scripts diff the socket list before/after to learn which display appeared.
- **Same size on both sides or the comparison is worthless** — 1600×1000 is
  pinned in both scripts.
- **`.del` is the diff-count span, not a delete button.** The dialog surface is
  reached the real way: expand Archived → select-all → bulk delete.
- **The GTK harness's screenshot op awaits two frame-clock ticks itself**, and
  with no `name` it targets the topmost dialog toplevel — which is how
  `gtk-dialog.png` captures a modal that is its own surface.
- **Rebuild before driving.** `cargo test` does not refresh
  `target/release/orchestra-gtk`; a stale binary reproduces a false result
  perfectly.
