# Orchestra (Native) — the GTK4 frontend

Orchestra ships two frontends over **one** backend:

- **Orchestra** — the Electron app (the historical GUI).
- **Orchestra (Native)** — `orchestra-gtk`, a native GTK4/Relm4 frontend
  (`native/orchestra-gtk`). Lighter, no Chromium; a pure **frontend** that
  talks to a backend over the ui-rpc socket.

Both are two faces of one running backend: attach either (or both) to the same
`ORCHESTRA_HOME` and they mirror each other's state. This doc covers install,
the daemon/attach modes, the coexistence rules, and troubleshooting. The design
is `docs/gtk4-port-plan.md` §1.1; the wire contract is `docs/ui-rpc-protocol.md`.

## Backend vs frontend

Everything of substance — worktrees, PTYs, git, accounts — lives in the
backend (the TypeScript code in `src/main/`). A backend can be hosted by:

- the **Electron app** (it serves the ui-rpc socket in addition to its own
  renderer), or
- the **daemon** (`dist-electron/daemon.js`, a headless Node process, no GUI).

**One backend per `ORCHESTRA_HOME`** — enforced by `backend.lock` (pid-probed;
a dead pid's lock is auto-reclaimed). The GTK app never hosts a backend; it
attaches to one, or spawns the daemon if none is running.

## Install

Released tags carry `orchestra-gtk-x64` and `orchestra-gtk-arm64` binaries
(attached by CI / `release.sh --with-gtk`). Install one plus the desktop entry:

```bash
install -Dm755 orchestra-gtk-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/') \
  ~/.local/bin/orchestra-gtk
# desktop entry + icons (rewrite Exec=/Icon= to your paths):
install -Dm644 native/packaging/orchestra-gtk.desktop \
  ~/.local/share/applications/orchestra-gtk.desktop
```

The version is baked in at build time from the repo `package.json`
(`build.rs`), so the binary and the Electron app of the same release always
report the same version — that lockstep is what the handshake below relies on.

## Daemon / attach modes

On launch the GTK app resolves a backend in this order:

1. **`$ORCHESTRA_UI_SOCK`** — an explicit socket path (must exist).
2. **`$ORCHESTRA_HOME/ui-sock`** — the pointer file a running backend writes.
3. **Auto-spawn the daemon** — no socket found → locate a daemon command and
   start it detached under the current `ORCHESTRA_HOME`, then wait for its
   ui-sock. Location order:
   - **`$ORCHESTRA_DAEMON_CMD`** — a full command line (run via `sh -c`; the
     E2E suite points this at `node dist-electron/daemon.js`);
   - the **`~/.local/bin/orchestra` CLI shim** — its `exec "<AppImage>"` line
     names the installed AppImage, invoked as `<AppImage> daemon`;
   - a **dev checkout** — `dist-electron/daemon.js` found by walking up from
     the binary / cwd.

While discovery/spawn runs, the app stays open with a non-blocking banner; it
retries discovery every 3 s (one auto-spawn attempt per launch — repeated
spawns would fight the backend lock).

By default a daemon the GTK app spawned **keeps running** after the window
closes (agents work headless — plan §1.1 rule 3). Pass `--stop-daemon-on-exit`
to SIGTERM it on close instead.

### Flags

| Flag | Effect |
|---|---|
| `--remote-control <sock>` | Open the JSON debug/test socket (see `native/README.md`). Also switches the app to a non-unique GApplication. |
| `--stop-daemon-on-exit` | SIGTERM a daemon **we** spawned when the window closes (never a discovered backend). |
| `ORCHESTRA_GTK_MOCK=1` (env) | Serve five fixture workspaces, no backend — for demos/tests. |

## The attach handshake — version negotiation

Attach is gated by a one-shot handshake probe (`backend::probe_backend`):
the app connects, sends `hello`, reads `helloOk`, and closes. Two mismatch
cases, deliberately different (plan §1.1 rule 5 + protocol §3):

- **Protocol mismatch** (the frozen ui-rpc `proto` version differs) → **refused.**
  No attach, a refusal dialog, and retrying is pointless (it can't heal). Both
  apps ship from the same release in lockstep, so this means they're from
  *different* releases — update the older side.
- **appVersion mismatch** (same protocol, different app version) → a **non-fatal
  warning** dialog; the app attaches anyway. In lockstep this shouldn't happen,
  but it degrades gracefully if it does.

## Coexistence rules (plan §1.1)

- **Two faces, one state.** Electron + GTK attached to the same home mirror
  each other — a change in one appears in the other.
- **The Electron app is a valid backend host.** If the GTK app tries to spawn a
  daemon but the Electron app already owns the home (holds `backend.lock`) *and*
  serves the ui-rpc socket, the GTK app attaches to **it** — you'll see an
  informational "attached to the Electron app" note, not an error.
- **Mutual exclusion.** A second backend refusing to start for a home that's
  already owned is correct behavior, not a bug.

## Troubleshooting

**"backend refused: incompatible ui-rpc protocol"** — the GTK binary and the
backend are from different releases. Update whichever is older; they must match
on protocol.

**"Orchestra (Electron) owns this home but serves no UI socket"** — the Electron
app holding the lock predates ui-rpc. Update it, or quit it and the GTK app will
spawn/find a daemon on the next retry.

**"Backend lock held … but no UI socket found"** — usually a backend still
booting (the app keeps retrying). If the named pid is not running, the lock is
stale; the next backend start reclaims a dead pid's lock automatically. If it
persists, check `$ORCHESTRA_HOME/logs/orchestra.log` and remove
`$ORCHESTRA_HOME/backend.lock`.

**"daemon exited during startup"** — the spawned daemon died before serving its
socket. The dialog quotes the exit code and the tail of
`$ORCHESTRA_HOME/logs/daemon-spawn.log`.

**Rootless dev runs: blank account-login WebView** — WebKitGTK 6's helper
processes live in `/usr/libexec`, which the rootless localdeps prefix can't
provide. Bind the localdeps webkit libexec over `/usr/libexec` with a `bwrap`
tmpfs overlay (a `WEBKIT_EXEC_PATH` override does not work). Moot for installed
packages and CI (system webkit's libexec exists). See `native/README.md`.

## See also

- `native/README.md` — build (rootless localdeps), remote-control harness,
  packaging, E2E.
- `native/e2e/README.md` — the E2E scenario suite.
- `docs/codebase-map/native-ui.md` — the codebase map for this subsystem.
- `docs/gtk4-port-plan.md`, `docs/ui-rpc-protocol.md` — design + wire contract.
