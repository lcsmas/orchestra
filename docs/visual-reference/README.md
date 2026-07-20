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

## Why the state matches on both sides

The GTK app serves its fixture from compiled-in Rust
(`native/orchestra-gtk/src/backend/mock.rs`, `ORCHESTRA_GTK_MOCK=1`); the
Electron app reads a `store.json` off disk. So `seed-store.mjs` **mirrors
`mock.rs` field for field** into an Electron store. Both frontends deserialize
the same wire `Workspace` type, so the mirror is exact.

> **If you change `mock.rs`, update `seed-store.mjs` in the same change** —
> otherwise the two halves of the pair stop showing the same state and the
> comparison proves nothing.

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

## Regenerating

Both capture scripts run the app inside their **own headless sway** — no window
ever appears on your desktop. Each writes its PNGs into this directory.

### Electron

```bash
npx vite build                              # produces dist/ + dist-electron/
docs/visual-reference/capture-electron.sh   # seeds, launches, screenshots
```

### GTK

```bash
./native/setup-localdeps.sh                 # once per worktree: rootless GTK deps
source native/env.sh
cargo build -p orchestra-gtk --release --manifest-path native/Cargo.toml
docs/visual-reference/capture-gtk.sh
```

Regenerate both, then compare the matching pair.

## Files

| File | What it is |
|---|---|
| `DIFF-NOTES.md` | **The V1–V4 work list** — concrete differences, both sides cited |
| `seed-store.mjs` | Mirrors `mock.rs` into an Electron `store.json` |
| `capture-electron.sh` | Headless sway + isolated `ORCHESTRA_HOME` + CDP |
| `drive-electron.mjs` | Dep-free CDP driver (screenshots each surface) |
| `capture-gtk.sh` | Headless sway + `ORCHESTRA_GTK_MOCK=1` + remote-control |
| `drive-gtk.py` | Harness driver over the `--remote-control` socket |

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
