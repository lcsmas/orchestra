# native/ — Rust workspace for the GTK4 Orchestra frontend

Two crates (plan: `docs/gtk4-port-plan.md`; wire contract:
`docs/ui-rpc-protocol.md`):

- **`orchestra-rpc`** — ui-rpc frame codec, serde mirrors of
  `src/shared/types.ts`, and (M1-A2) the typed client + connection actor.
- **`orchestra-gtk`** — the Relm4/GTK4 app. M1 ships the shell skeleton:
  window/layout/theme, UI-state persistence, dialog system, backend
  discovery, mock mode, and the remote-control test harness.

## Building (rootless — no sudo needed)

This machine has the GTK4 *runtime* but not the `-devel` packages, and no
sudo. The Rust `-sys` crates only need pkg-config `.pc` files and linkable
`.so` symlinks, so:

```bash
cd native
./setup-localdeps.sh   # dnf download (no root) + rpm2cpio into .localdeps/
source env.sh          # PKG_CONFIG_PATH + RUSTFLAGS -L + LD_LIBRARY_PATH
cargo build -p orchestra-gtk
cargo test --workspace
```

`.localdeps/` is gitignored — every checkout runs `setup-localdeps.sh` once.
On a machine with sudo, `dnf install gtk4-devel vte291-gtk4-devel` makes both
scripts unnecessary (sourcing `env.sh` stays harmless). `setup-localdeps.sh`
covers the full M2 surface (gtk4, vte4, gtksourceview5, webkitgtk6, gstreamer).

`cargo clippy`/`cargo fmt` are not in Fedora's `cargo` package: extract the
`clippy` and `rustfmt` RPMs the same rootless way and put their `usr/bin` on
`PATH`. (Same trick works for `ShellCheck`/`actionlint` when touching CI.)

> **Rootless WebKit caveat:** WebKitGTK 6's web/network-process helpers are
> compiled into `/usr/libexec`, which the localdeps prefix can't provide.
> Account-login WebViews under a rootless dev run need a `bwrap` tmpfs overlay
> binding the localdeps webkit libexec over `/usr/libexec` (a `WEBKIT_EXEC_PATH`
> env override does **not** work). Moot for an installed package and for CI
> (system webkit's libexec exists).

## Running the GTK app

```bash
source env.sh
ORCHESTRA_GTK_MOCK=1 cargo run -p orchestra-gtk      # fixture workspaces, no backend
cargo run -p orchestra-gtk                            # discover a real backend
```

- **Backend discovery** (`ui-rpc-protocol.md` §1): `$ORCHESTRA_UI_SOCK`
  overrides; else the pointer file `$ORCHESTRA_HOME/ui-sock` (default
  `~/.orchestra/ui-sock`). No backend → non-blocking banner + 3 s retry.
- **Attach + daemon auto-spawn** (`src/daemon.rs`, plan §1.1): discovery
  miss → locate a backend (`$ORCHESTRA_DAEMON_CMD` → the `~/.local/bin/
  orchestra` shim's AppImage → a dev checkout's `dist-electron/daemon.js`),
  spawn it detached under the current `ORCHESTRA_HOME`, wait for the ui-sock,
  and attach. Attach is gated by a one-shot handshake probe
  (`backend::probe_backend`): a **protocol** mismatch is refused (dialog, no
  attach); an **appVersion** mismatch is a non-fatal warning; a backend-lock
  loss to the Electron app attaches to it instead ("two faces, one state").
  `--stop-daemon-on-exit` SIGTERMs a daemon we spawned on close (default:
  leave it running). See `docs/gtk-app.md` for the full story.
- **Mock mode**: `ORCHESTRA_GTK_MOCK=1` (or the `mock` cargo feature) serves
  five fixture workspaces so the shell renders without any backend.
- **UI state** persists to `$ORCHESTRA_HOME/gtk-ui-state.json` (sidebar
  width, window geometry, last-active workspace), debounced 400 ms + flushed
  on close.
- The status strip's `debug` menu demoes the promise-shaped dialog system
  (alert/confirm/prompt/error/success).

## Remote-control harness (the CDP replacement — plan §8.4)

`orchestra-gtk --remote-control <sock-path>` opens a unix socket speaking
newline-delimited JSON, one response per request line. Events are synthesized
GTK-side because headless sway's seat has no pointer/keyboard — compositor
input never reaches the client.

| Request | Reply |
|---|---|
| `{"op":"list_widgets"}` | `{"ok":true,"widgets":[{name,type,visible,children…}]}` — all toplevels |
| `{"op":"click","name":"ws-row-ws-1"}` | button click / row select+activate / menu popup / activate |
| `{"op":"type","text":"hi","name":"dialog-entry"}` | insert into named editable (name optional → focus widget) |
| `{"op":"key","name":"Escape"}` | `Escape` cancels / `Return` confirms the topmost dialog |
| `{"op":"get","name":"status-text","prop":"label"}` | prop ∈ label \| visible \| css (label = window title / label text / entry text) |
| `{"op":"screenshot","path":"/tmp/x.png"}` | offscreen render via WidgetPaintable → PNG; optional `name` targets any toplevel/widget, default = topmost open dialog, else main window |

Widget names: every meaningful widget has a `widget_name` (`main-window`,
`sidebar-list`, `ws-row-<id>`, `status-text`, `debug-menu`, `backend-banner`,
`dialog-title|entry|confirm|cancel`, …). Anonymous widgets keep their GType
name; a `#N` suffix picks the Nth match (`GtkModelButton#2` = third menu
item). Passing `--remote-control` also switches the GApplication to
NON_UNIQUE so parallel test runs don't DBus-activate each other.

## Smoke test

```bash
./orchestra-gtk/scripts/smoke.sh
```

Builds, launches mock mode inside a **fresh headless sway** (never the user's
desktop), drives the harness (widget tree, title, footer, screenshot),
prints PASS/FAIL. Screenshot artifact: `target/smoke/smoke.png`; logs are
kept in the run dir on failure.

## E2E scenarios

`native/e2e/` drives the real binary through the remote-control socket for
protocol/lifecycle behavior (attach, refusal, daemon spawn, backend-lock
exclusion, coexistence). Dependency-free Node:

```bash
(cd native && cargo build -p orchestra-gtk)   # release or debug
node native/e2e/run.mjs            # or: pnpm run e2e:gtk
```

See `native/e2e/README.md` for the scenario list and which ones skip pending
sibling workstreams.

## Packaging (plan §9)

- **Version lockstep**: `build.rs` bakes the repo `package.json` version into
  the crate (`ORCHESTRA_APP_VERSION`, exposed as `orchestra_gtk::app_version()`)
  — one bump, both the Electron and native artifacts. A test asserts they match.
- **`build:gtk`** (root `package.json`) = `cargo build --release -p
  orchestra-gtk`. NOT wired into the default `pnpm run build` — the Electron
  release cadence must not grow a Rust-toolchain dependency.
- **Desktop entry + icons**: `native/packaging/orchestra-gtk.desktop`
  ("Orchestra (Native)") and `gen-icons.mjs`, which renders `build/icon.svg`
  (the shared brand source) into a hicolor PNG tree via `@resvg/resvg-js` (a
  pure-Rust rasterizer — no system cairo/rsvg). `@resvg` lives in a standalone
  `native/packaging/package.json` so it never enters the Electron install;
  `pnpm run build:gtk:icons` installs it and renders.
- **Release**: `scripts/release.sh --with-gtk` cargo-builds the native binary
  and attaches `orchestra-gtk-<arch>` to the same GitHub release; CI
  (`.github/workflows/native.yml` + the `build-gtk` matrix in `release.yml`)
  builds both arches in a `fedora:42` container with the real `-devel`
  packages (no localdeps in CI — that's a dev-box hack).
