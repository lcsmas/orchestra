---
name: verify
description: Drive a built Orchestra instance end-to-end to verify a UI change — isolated ORCHESTRA_HOME, CDP over a debug port (Electron) or the remote-control socket (GTK), and (for screenshots) a headless sway compositor so frames render without touching the user's desktop.
---

# Verify an Orchestra UI change by driving the real app

**First: which frontend did you change?** Orchestra has TWO, sharing one
backend over a ui-rpc socket (`docs/gtk4-port-plan.md`, `docs/ui-rpc-protocol.md`):

- **Electron** (`src/renderer/`) — this document. CDP over a debug port.
- **GTK** (`native/orchestra-gtk/`) — CDP does not apply. Launch with
  `--remote-control <sock>` and drive via its harness ops
  (`list_widgets` / `click` / `type` / `key` / `get` / `screenshot` / `action`);
  see `native/e2e/` and `native/orchestra-gtk/scripts/*.sh` for working drives,
  and source `native/env.sh` first. A backend-affecting change should be
  verified on BOTH frontends — that is the point of the coexistence design.

Everything below (isolated `ORCHESTRA_HOME`, headless sway for frames) applies
to both.

Build first: `npx vite build` (produces `dist/` + `dist-electron/`). Do NOT use
`pnpm run lint` here (OOMs); `npx tsc --noEmit` is the typecheck. For the GTK
app, rebuild the binary before ANY drive that execs it — `cargo test` does not
refresh `target/debug/orchestra-gtk`, and a stale binary reproduces a false
failure perfectly in isolation.

## Launch an isolated instance with CDP

```bash
ORCHESTRA_HOME=<fresh tmp dir> ORCHESTRA_DEBUG_PORT=<unique port> npx electron .
```

- Pick a UNIQUE debug port (e.g. 93xx picked from your workspace id) — sibling
  agents run identical harnesses and 9322 specifically has collided; after
  connecting, confirm the `/json` target's `url` points at YOUR worktree.
- `ORCHESTRA_HOME` relocates userData (store/logs/login dirs) and the events
  spool — but NOT scratch dirs or worktrees, which the app still creates under
  the real `~/.orchestra`; clean up any workspace you let it create.
- `ORCHESTRA_DEBUG_PORT` enables CDP (`src/main/index.ts` also sets
  `remote-allow-origins=*`, so websockets don't 403).
- Target discovery: `curl http://127.0.0.1:<port>/json` → `webSocketDebuggerUrl`
  of the `type: "page"` entry.

## Drive it (dep-free node, no MCP needed)

Native `WebSocket` + `Runtime.evaluate` (`returnByValue: true`) for DOM
assertions and clicks; `Page.captureScreenshot` for pixels. Keep a timeout race
around screenshots — they hang forever if the window can't produce frames.
Terminal CONTENT is invisible to DOM assertions (the WebGL renderer paints to
canvas; `innerText` is empty) — verify terminal output via screenshot pixels or
the PTY log instead.

## Screenshots need a compositor that renders the window

On the user's desktop the test window usually sits on a hidden Sway workspace →
no frames → `Page.captureScreenshot` hangs. Don't steal focus. Instead run a
second, headless sway and launch the app inside it:

```bash
WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WAYLAND_DISPLAY= \
  SWAYSOCK=/tmp/.../sway-headless.sock sway -c <minimal config> &
# it creates the next /run/user/1000/wayland-N socket; then:
WAYLAND_DISPLAY=wayland-N ELECTRON_OZONE_PLATFORM_HINT=wayland \
  ORCHESTRA_HOME=<tmp> ORCHESTRA_DEBUG_PORT=9322 npx electron . --ozone-platform=wayland
```

Minimal config can be just `output HEADLESS-1 resolution 1600x1000` (a "Could
not find config for output" warning is harmless). Screenshots then work over
plain CDP. Kill both processes when done.

## What to check for overlay panes (Help, Insights)

They are absolute overlays over the main pane (never unmount the terminals):
assert presence/absence of `.help-view` / `.insights-view`, their mutual
exclusion (opening one closes the other), close via `×`, and reopen from the
sidebar header buttons.
