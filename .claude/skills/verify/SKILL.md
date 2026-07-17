---
name: verify
description: Drive a built Orchestra instance end-to-end to verify a UI change — isolated ORCHESTRA_HOME, CDP over a debug port, and (for screenshots) a headless sway compositor so frames render without touching the user's desktop.
---

# Verify an Orchestra UI change by driving the real app

Build first: `npx vite build` (produces `dist/` + `dist-electron/`). Do NOT use
`pnpm run lint` here (OOMs); `npx tsc --noEmit` is the typecheck.

## Launch an isolated instance with CDP

```bash
ORCHESTRA_HOME=<fresh tmp dir> ORCHESTRA_DEBUG_PORT=9322 npx electron .
```

- `ORCHESTRA_HOME` relocates userData/worktrees/events — never touches the real
  `~/.orchestra` or the user's running Orchestra.
- `ORCHESTRA_DEBUG_PORT` enables CDP (`src/main/index.ts` also sets
  `remote-allow-origins=*`, so websockets don't 403).
- Target discovery: `curl http://127.0.0.1:<port>/json` → `webSocketDebuggerUrl`
  of the `type: "page"` entry.

## Drive it (dep-free node, no MCP needed)

Native `WebSocket` + `Runtime.evaluate` (`returnByValue: true`) for DOM
assertions and clicks; `Page.captureScreenshot` for pixels. Keep a timeout race
around screenshots — they hang forever if the window can't produce frames.

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
