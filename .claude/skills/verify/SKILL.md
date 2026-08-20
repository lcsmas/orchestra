---
name: verify
description: Drive a built Orchestra instance end-to-end to verify a UI change — isolated ORCHESTRA_HOME, CDP over a debug port, and a headless sway compositor so frames render without touching the user's desktop. Verification is ALWAYS both halves — state assertions AND a captured screenshot.
---

# Verify an Orchestra UI change by driving the real app

## Both halves are mandatory — state AND pixels

Every UI verification produces TWO artifacts. Neither substitutes for the other,
and a drive that produced only one is NOT verified:

1. **State assertions** (the oracle) — CDP `Runtime.evaluate` /
   `getComputedStyle`. Answers *is the value right*. Prefer this for anything
   expressible as state: a class is present, a computed color is `rgba(…)`, a
   rect is at x=371.
2. **A captured screenshot** (the paint check) — `Page.captureScreenshot`, saved
   to a file whose path you state in the report. Answers *did it actually
   paint*.

They are not redundant, because each is blind to what the other catches:

- State assertions cannot see paint. A widget with `opacity: 0` inherited from a
  hover class its container can never satisfy reports `visible`, appears in the
  DOM/widget tree, and paints NOTHING. Same for a dead renderer process — the
  DOM is intact and the pane is a white rectangle with a sad-face bitmap.
- Screenshots cannot see values, and are a lossy instrument. A translucent
  surface over nothing reads as an opaque slab; a downscaled preview averages a
  small light region into its dark surroundings and reads as "not painting".
  When a screenshot contradicts the DOM oracle, **the oracle wins** — decode the
  raw pixel at named coordinates before believing the image.

So: assert state for correctness, screenshot for existence-of-paint, and report
both. If the change is genuinely invisible (pure main-process/logic), say so
explicitly rather than silently dropping the screenshot — that is a claim the
reviewer can check, where silence is indistinguishable from a skipped step.

**Popovers/overlays need a POSITION assertion, not just presence** — assert
`getBoundingClientRect()` is fully inside the viewport (`left >= 0 && right <=
innerWidth`). v0.5.187 shipped an inbox popover at left=-276px: present in the
DOM, all content assertions green, 276 of its 320px outside the window. DOM
assertions are structurally blind to paint position; the user found it in
first real use. And **read every screenshot you capture** — the one unread
shot of that drive's set was the one containing the bug.

**Screenshot hygiene** (a no-op drive still captures a frame): hash every capture
in a set and fail on byte-identical duplicates, and assert the state actually
CHANGED (pre-state differs from post-state) rather than trusting that your click
did anything. A set of "7 verified surfaces" that is really 5 has shipped here
before. Name each file for what it SHOWS, not what the drive intended.

Orchestra is a single Electron app: one backend in the main process, one React
renderer (`src/renderer/`). You verify a UI change by launching an isolated
instance and driving it over CDP, with isolated `ORCHESTRA_HOME` and headless
sway for frames.

Build first: `npx vite build` (produces `dist/` + `dist-electron/`). Do NOT use
`pnpm run lint` here (OOMs); `npx tsc --noEmit` is the typecheck. Always rebuild
before ANY drive — a stale bundle reproduces a false failure perfectly in
isolation.

## Launch an isolated instance with CDP

```bash
env -u APPIMAGE ORCHESTRA_OZONE=wayland ORCHESTRA_OZONE_RELAUNCHED=1 \
  ORCHESTRA_HOME=<fresh tmp dir> ORCHESTRA_DEBUG_PORT=<unique port> \
  ./node_modules/electron/dist/electron .
```

- **Never let a test instance run with a fake `APPIMAGE`.** `cli-shim.ts`
  rewrites `~/.local/bin/orchestra` on every GUI startup from that value, so a
  stub path silently breaks the user's real `orchestra` command. Either launch
  with `APPIMAGE` unset (the shim install then no-ops on Linux) or restore
  `~/.local/bin/orchestra` afterwards.
- Pick a UNIQUE debug port (e.g. 93xx picked from your workspace id) — sibling
  agents run identical harnesses and 9322 specifically has collided; after
  connecting, confirm the `/json` target's `url` points at YOUR worktree.
- Run every step of the drive with the Bash sandbox DISABLED. A sandboxed call
  gets a private `/tmp`, so the sway config / store seed you write in one call
  is invisible to the unsandboxed app in the next — presenting as "sway: config
  not found" and an empty sidebar.
- Seeding state beats clicking it in: write `<home>/userData/orchestra/store.json`
  (`{repos, workspaces, accounts, selfTuneRuns}`) before launch. Point
  `worktreePath` at REAL git-registered worktrees (`git worktree list`) —
  `pruneOrphanedWorkspaces` deletes records it can't verify, silently emptying
  a fabricated store.
- `ORCHESTRA_HOME` relocates userData (store/logs/login dirs) and the events
  spool — but NOT scratch dirs or worktrees, which the app still creates under
  the real `~/.orchestra`; clean up any workspace you let it create.
- `ORCHESTRA_DEBUG_PORT` enables CDP (`src/main/index.ts` also sets
  `remote-allow-origins=*`, so websockets don't 403).
- Target discovery: `curl http://127.0.0.1:<port>/json` → `webSocketDebuggerUrl`
  of the `type: "page"` entry — **filtered by URL (`dist/index.html`), on EVERY
  connection, not just the first**: once the embedded browser panel navigates,
  its `WebContentsView` becomes a second `type:"page"` target on the SAME port,
  and `find(t => t.type === 'page')` on a reconnect grabs that page instead of
  the app (your keystrokes/queries land in the panel's document and every app
  assertion reads false against working code).
- **`Page.captureScreenshot` on the app target does NOT include sibling
  `WebContentsView`s** (the browser panel) — it captures the app renderer's own
  DOM, so the pane region shows `.browser-holder`'s white, whatever the panel
  painted. The composed-window oracle is a compositor capture:
  `WAYLAND_DISPLAY=wayland-N grim -o HEADLESS-1 out.png` on the headless sway.
- **Strip the inherited AppImage env, or you will verify the INSTALLED build.**
  Your agent process is a child of the running Orchestra AppImage. As of the
  `stripProcessLocalEnv` fix (shared/child-env.ts) the app no longer passes
  `APPIMAGE`/`APPDIR`/`ARGV0`/`OWD` to the PTYs it spawns — but you inherit them
  from ANY older installed build, which is most of the time, so keep stripping
  them explicitly. The ozone-relaunch block
  (`src/main/index.ts:67-91`) re-execs `$APPIMAGE` when the platform hint
  disagrees — so `npx electron .` silently hands off to the *packaged* app,
  which happily reports a healthy CDP target while running code from months ago.
  Launch with the env sanitized and the relaunch suppressed:

  ```bash
  env -u APPIMAGE -u APPDIR -u OWD -u ARGV0 \
    WAYLAND_DISPLAY=wayland-N ELECTRON_OZONE_PLATFORM_HINT=wayland \
    ORCHESTRA_OZONE=wayland ORCHESTRA_OZONE_RELAUNCHED=1 \
    ORCHESTRA_HOME=<tmp> ORCHESTRA_DEBUG_PORT=<port> \
    ./node_modules/electron/dist/electron . --ozone-platform=wayland
  ```

  Then ASSERT it: the `/json` target `url` must contain your worktree path.
  `app.asar` in that url means you are driving the installed build — abort.
- **Name your tmp dir after YOUR workspace, not `orch-verify*`.** Sibling agents
  run this same harness concurrently and clean up with globs; a shared prefix
  gets your `ORCHESTRA_HOME` deleted mid-drive (observed: the app died and the
  seeded store vanished between two runs).
- **`pkill -f <your tmp path>` kills your own shell** — the pattern appears in
  the Bash tool's own command line. Resolve the pid first
  (`ss -ltnp | grep <port>`) and kill by pid.

## Drive it (dep-free node, no MCP needed)

Native `WebSocket` + `Runtime.evaluate` (`returnByValue: true`) for DOM
assertions and clicks; `Page.captureScreenshot` for pixels — you need BOTH, per
the top of this doc. Keep a timeout race around screenshots — they hang forever
if the window can't produce frames.

**Park the cursor before reading computed styles.** CDP's pointer position
persists across script runs, so a previous drive's click leaves a row `:hover`-ed
— which brightens `--av-text-faint` to `--av-text-dim` and makes two rows that
should match differ for a reason unrelated to the change. Dispatch a
`mouseMoved` to a neutral corner first.

**Resolve `--av-*` custom properties from inside the agent view, not `:root`.**
They are declared on the agent-view scope; a probe parented to `document.body`
resolves `var(--av-error)` to nothing and inherits the ambient colour — so a
"the header is not red" assertion passes against a value the app never paints.
Cross-check the resolved colour against an element that IS supposed to be red
(e.g. the `.av-tool-status-error` pill) before trusting it.

Drive gestures through TRUSTED input (`Input.dispatchMouseEvent`, including
`type:'mouseWheel'` for scroll) — never a `.click()` call or a `scrollTop`
assignment plus a synthetic `Event`. The app's own feedback loops (ResizeObserver
re-pinning, controlled inputs, `isTrusted` checks) silently override synthetic
writes and fabricate a FAILURE against working code. Yield at least one frame
between dispatched keys: two keystrokes in one task means the second sees the
pre-setState UI.

Terminal CONTENT is invisible to DOM assertions (the WebGL renderer paints to
canvas; `innerText` is empty) — that is exactly the case where the screenshot is
the only oracle, so read terminal output from screenshot pixels or the PTY log.

## Screenshots need a compositor that renders the window

Since the screenshot half is mandatory, so is this section — a hidden window
produces no frames, which blocks CDP INPUT and hit-testing too, not just pixels
(clicks silently no-op). On the user's desktop the test window usually sits on a
hidden Sway workspace → `Page.captureScreenshot` hangs. Don't steal focus.
Instead run a second, headless sway and launch the app inside it:

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
