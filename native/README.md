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
scripts unnecessary (sourcing `env.sh` stays harmless). Current dep set is
gtk4 + vte4; M2 workstreams extend `DEPS` in `setup-localdeps.sh`
(gtksourceview5, webkitgtk6, gstreamer).

`cargo clippy`/`cargo fmt` are not in Fedora's `cargo` package: extract the
`clippy` and `rustfmt` RPMs the same rootless way and put their `usr/bin` on
`PATH`.

## Running the GTK app

```bash
source env.sh
ORCHESTRA_GTK_MOCK=1 cargo run -p orchestra-gtk      # fixture workspaces, no backend
cargo run -p orchestra-gtk                            # discover a real backend
```

- **Backend discovery** (`ui-rpc-protocol.md` §1): `$ORCHESTRA_UI_SOCK`
  overrides; else the pointer file `$ORCHESTRA_HOME/ui-sock` (default
  `~/.orchestra/ui-sock`). No backend → non-blocking banner + 3 s retry.
  Daemon auto-spawn is an M2 stub (`backend::spawn_daemon_stub`).
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
| `{"op":"screenshot","path":"/tmp/x.png"}` | offscreen render via WidgetPaintable → PNG (optional `name`) |

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
