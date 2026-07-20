# Native GTK4 frontend (`orchestra-gtk`)

The native frontend added by the GTK4 port (`docs/gtk4-port-plan.md`). A
Rust/Relm4/GTK4 app that is a pure **frontend** over the ui-rpc socket — the
same backend the Electron app serves (`docs/codebase-map/ui-rpc-backend.md`).
Crate: `native/orchestra-gtk`; shared wire types + client:
`native/orchestra-rpc` (`docs/ui-rpc-protocol.md`). User-facing behavior and
troubleshooting live in `docs/gtk-app.md`.

Modules (`native/orchestra-gtk/src/`): `main.rs` (flag parse + GApplication),
`app.rs` (Relm4 root component: window, sidebar, banner, status strip, attach
flow), `backend.rs` (the `Backend` trait + `MockBackend` + `RpcBackend` stub +
discovery/probe), `daemon.rs` (daemon auto-spawn), `dialogs.rs` (promise-shaped
alert/confirm/prompt/error/success), `remote_control.rs` (the CDP-replacement
test harness), `state.rs` (UI-state persistence), `theme.css`. The sidebar
factories, terminals (vte4), and diff (gtksourceview5) are separate M2
workstreams that land in their own modules.

## Version lockstep — build.rs + lib.rs

`native/orchestra-gtk/build.rs` reads the repo `package.json` version at build
time and emits it as `ORCHESTRA_APP_VERSION` (rerun-if-changed on
`package.json`). `orchestra_gtk::app_version()` (`lib.rs:17`) returns it, and
every footer / handshake / mock site uses it instead of `CARGO_PKG_VERSION`, so
the native binary and the Electron app of the same release always agree. A
runtime test (`lib.rs` `version_tests`) asserts the baked value equals
`package.json` — the lockstep the attach handshake depends on.

## Backend discovery & the attach probe — backend.rs

`discover_socket(home)` (`backend.rs:73`): `$ORCHESTRA_UI_SOCK` (must exist)
else the `<home>/ui-sock` pointer file; returns a path only if the socket is on
disk. `mock_requested()` (`backend.rs:112`): the `mock` cargo feature or
`ORCHESTRA_GTK_MOCK=1`.

`probe_backend(sock)` (`backend.rs:93`) is the attach gate: one `RpcClient`
connect with reconnect off, capture `helloOk`, close. It returns the
`ServerInfo` (for the footer + appVersion comparison) or an `RpcError` — the
caller distinguishes `RpcError::ProtoMismatch` (refuse) from everything else
(retryable). The persistent transport that carries live workspace/PTY traffic
is a sibling workstream; `RpcBackend` is still A3's `NotWired` stub, so this
one-shot probe is the whole of the GTK app's ui-rpc footprint today.

## Daemon auto-spawn — daemon.rs

Pure-std module (no GTK — unit-tested headlessly). When discovery misses:

- `locate_daemon_command(user_home)` (`daemon.rs:57`) → `DaemonCommand`
  (`daemon.rs:35`) in the plan's order: `$ORCHESTRA_DAEMON_CMD` (via `sh -c`)
  → the `~/.local/bin/orchestra` shim's AppImage (`appimage_from_shim`,
  `daemon.rs:86` — only shims carrying the cli-shim.ts marker are trusted) → a
  dev checkout's `dist-electron/daemon.js` (walk up from the exe/cwd).
- `spawn_daemon(cmd, home)` (`daemon.rs:137`): detached (own process group — it
  outlives the app), `ORCHESTRA_HOME` pinned, early stdout+stderr → captured to
  `<home>/logs/daemon-spawn.log` (so a pre-logger crash like the backend-lock
  refusal stays diagnosable). Returns `SpawnedDaemon` (`daemon.rs:125`).
- `wait_for_socket(daemon, home, timeout)` (`daemon.rs:193`) → `WaitOutcome`
  (`daemon.rs:177`): `Ready(sock)`, `Exited{code, output_tail}`, or `TimedOut`.
  `reap_in_background` (`daemon.rs:228`) / `stop_daemon(pid)` (`daemon.rs:240`,
  best-effort SIGTERM for `--stop-daemon-on-exit`).
- On exit: `read_backend_lock(home)` (`daemon.rs:271`, mirrors backend-lock.ts's
  `<home>/backend.lock`) + `diagnose_exit(output_tail, home)` (`daemon.rs:289`)
  → `ExitDiagnosis` (`daemon.rs:278`): `LockHeld{kind, pid}` vs `Other`, which
  decides the §1.1 story below.

## The attach flow — app.rs

`Init` (`app.rs:27`) carries `stop_daemon_on_exit`. The worker side runs off the
GTK thread (every step blocks): `spawn_attach` (`app.rs:184`) spawns a std
thread running `attach_flow(home, allow_spawn, send)` (`app.rs:198`), which
discovers-or-spawns and reports progress as `AttachUpdate` (`app.rs:38`)
messages. `probe_and_send` (`app.rs:345`) turns the handshake into
`Attached` / `Refused` / `Failed`. `report_daemon_exit` (`app.rs:266`) turns a
dead spawned daemon into the right dialog:

- lock held by **electron** + socket now present → attach to it, with an
  `AttachNote::ElectronOwnsHome` (`app.rs:60`) info dialog ("two faces, one
  state");
- lock held by electron, no socket → "Orchestra (Electron) owns this home"
  guidance;
- other lock held → stale-lock guidance;
- other exit → "Daemon failed to start" with exit code + spawn-log tail.

The UI side (`on_attach`, `app.rs:776`) applies each update on the GTK loop:
banner text, attach (hide banner, build `RpcBackend`, record a spawned pid for
`--stop-daemon-on-exit`, populate sidebar + footer via `footer_text`,
`app.rs:156`), the **protocol-mismatch refusal** dialog (fatal, stops retries)
vs the **appVersion warning** dialog (non-fatal, attach proceeds). The 3 s
retry timer runs discovery-only (one auto-spawn attempt per launch).

## Overlay lifecycle — app.rs + overlays/mod.rs

Resources / Insights / Help are `gtk::Overlay` children layered over the main
pane (`Overlays::new`, `overlays/mod.rs:48`, three `add_overlay` calls). They
need a backend to poll and stream against, so **they are built on the attach
path, not at init** (`app.rs:1333`).

This is the part that is easy to get wrong: `make_backend()` (`app.rs:265`)
returns `Some` only for the mock, so on every real launch there is no backend at
init and the init-time construction (`app.rs:895`) is skipped. If the attach
handler does not rebuild them, all three entry points are accepted-but-dead
no-ops for the whole session — the clicks succeed and nothing appears, so
nothing fails loudly. Under the mock a backend exists at init, which hides the
bug entirely; **verify these surfaces against a real daemon, never the mock.**

Symmetrically, `ConnectionState::Disconnected` (`app.rs:1098`) tears them down
via `Overlays::unmount` (`overlays/mod.rs:93`), the counterpart to the
`add_overlay` calls: the reconnect's attach builds a fresh set, so without the
unmount every reconnect stacks another three overlays over the main pane. The
accounts controller directly above it follows the same build-on-attach /
drop-on-disconnect shape — match it rather than inventing a new one.

Event routing: the overlays hold an `Rc<dyn Backend>` for request/response
`call`s only. Their event input is **pushed** to them by App's single pump via
`overlays.dispatch` (`app.rs:1156` → `overlays/mod.rs:145`). They must never
open their own `events()` loop — `async_channel` is work-stealing MPMC, so a
second consumer silently round-robins frames away from the sidebar.

Entry points live in the **sidebar header** (`sidebar/mod.rs`, Electron parity
with `Sidebar.tsx:1362–1385`) and route out as
`SidebarOutput::HeaderAction` → `Msg::ToggleOverlay` (`app.rs:1211`).

## Remote-control harness — remote_control.rs

The CDP replacement (plan §8.4), compiled in always, activated by
`--remote-control <sock>`. Newline-JSON over a unix socket:
`list_widgets`/`click`/`type`/`key`/`get`/`screenshot`. Events are synthesized
GTK-side (headless sway advertises no seat input); screenshots render offscreen
via `WidgetPaintable → GSK render_texture` (no visible frame needed). Widget
names: `main-window`, `sidebar-list`, `ws-row-<id>`, `status-text`,
`backend-banner`/`backend-banner-text`, `dialog-title|body|entry|confirm|cancel`.
Consumed by `native/e2e/` and `orchestra-gtk/scripts/smoke.sh`.

## Re-parenting surface (promote / demote / attach)

The sidebar was read-only on tree shape — it *rendered* orchestrator trees but
had no action to change them, and promote/attach existed only as CLI/socket
routes with nothing on the ui-rpc wire. Three ops now carry them
(`docs/ui-rpc-protocol.md`), each returning the **bare updated `Workspace`** (no
`{ok,…}` envelope — that lives at the frame level only):

| Op | Rust client | Meaning |
|---|---|---|
| `promoteWorkspace(id)` | `client.rs:1034` | worktree gains `canOrchestrate`; scratch swaps `kind` |
| `demoteWorkspace(id)` | `client.rs:1040` | clears the capability, detaches children |
| `setWorkspaceParent(id, parentId\|null)` | `client.rs:1046` | attach / detach |

`Workspace::can_orchestrate()` (`native/orchestra-rpc/src/types/workspace.rs:144`)
mirrors the TS helper — use it for tree/parent decisions and `is_scratch_like`
for git ones (see [workspaces.md](workspaces.md) for why they must not be
conflated).

UI lives in `sidebar/widgets.rs` (coordinator pill `ws-coordinator-<id>`,
buttons `ws-promote-<id>` / `ws-demote-<id>` / `ws-attach-<id>`, and the
`DropZone` band) and `sidebar/mod.rs` (`Msg::Promote/Demote/SetParent/DropOnto`,
routed through the existing `fire_and_forget`). **Only `can_orchestrate()` rows
accept a drop** — the middle third of such a row adopts, outer thirds reorder;
other rows keep the plain half/half reorder split.

Per the single-consumer rule, these components open no stream of their own: they
`call()` and let the resulting `workspace:update` broadcast drive the re-render
(see the `gtk-backend-single-consumer-fanout` invariant in `app.rs`).

E2E drives it headlessly via the remote-control actions `sidebar.promote`,
`sidebar.demote`, and `sidebar.set-parent` (param `"<ws>|<parent>"`; a bare
`"<ws>"` detaches) — GTK cannot synthesize pointer drags without a seat.

## Welcome / no-workspace screen — main_pane.rs

`build_welcome()` (`main_pane.rs`) renders the Electron welcome branch
(`src/renderer/App.tsx:381-418`): heading, tagline, a three-button CTA row, a
3×2 feature-card grid, and the ghost help button. Values are ported from
`src/renderer/styles.css` with the source line cited at each rule; the paint
half lives in the `.welcome-*` block appended to `theme.css`, the layout half
(gaps, margins, grid spacing) is set in Rust because GTK CSS has no flex/grid
gap.

Two non-obvious points:

- **The CTAs are scoped to `.empty-actions`**, not styled as bare
  `.primary`/`.secondary`. `theme.css` already defines a flat `.primary` for the
  Insights run button that does *not* match Electron's gradient
  `button.primary`; widening it would silently restyle Insights.
- **`MainPane::welcome_ctas()`** exposes the four buttons so `app.rs` can route
  them at its overlay/spawn `Msg`s. Until it does, they render correctly but do
  nothing.

`mainpane.clear-active` is a remote-control action that drops the active
workspace so E2E can reach this screen — the app auto-selects a workspace at
boot and no user affordance deselects, so the welcome screen is otherwise
undrivable. The pane also reflects which stack branch is on stage as
`showing-empty` / `showing-content` on `main-area`: GTK reports
`is_visible() == true` for a `GtkStack`'s *off-screen* child as well as its
current one (measured — both branches report true at once), so a drive that
asserts on `visible` cannot fail and proves nothing. Assert on the css class.

## Packaging, CI, E2E

- **Packaging** (`native/packaging/`): `orchestra-gtk.desktop`, `gen-icons.mjs`
  (renders `build/icon.svg` via `@resvg/resvg-js`, in a standalone
  `package.json` so it stays out of the Electron install). Root `package.json`:
  `build:gtk`, `build:gtk:icons`, `e2e:gtk`.
- **Release**: `scripts/release.sh --with-gtk` attaches `orchestra-gtk-<arch>`
  to the same GitHub release; the `build-gtk` matrix in
  `.github/workflows/release.yml` does it per-arch on tags.
- **CI**: `.github/workflows/native.yml` — fedora:42 x64+arm64 with real
  `-devel` packages (no localdeps in CI): fmt/clippy(`-D warnings`)/test/release
  build + TS suite + RPC fixtures drift gate + conformance, plus an `e2e` job
  (headless sway, software-rendered) running `native/e2e/`.
- **E2E** (`native/e2e/`): drives the real binary via remote-control in headless
  sway — version-mismatch refusal, appVersion warning, daemon auto-spawn,
  backend-lock exclusion; coexistence live-update is harnessed but skipped until
  the persistent transport lands. See `native/e2e/README.md`.

## Related src/main fixes (this milestone)

The port surfaced two `ORCHESTRA_HOME`-ignoring hardcoded paths in the Node
backend, fixed so isolated homes (dev instances, E2E) don't scribble into the
real `~/.orchestra`: `src/main/logger.ts` (primary log sink + `app:info.logPath`)
and `src/main/pty.ts` (`LOG_DIR` for per-workspace PTY logs). Both now route
through `orchestraHome()` (`src/main/platform/index.ts`).
