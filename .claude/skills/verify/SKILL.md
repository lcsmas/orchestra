---
name: verify
description: Drive a built Orchestra instance end-to-end to verify a UI change — isolated ORCHESTRA_HOME, CDP over a debug port, and a headless sway compositor so frames render without touching the user's desktop. Verification is ALWAYS both halves — state assertions AND a captured screenshot.
---

# Verify an Orchestra UI change by driving the real app

## Both halves — state AND pixels

Every UI verification produces TWO artifacts, because each is blind to what the
other catches:

1. **State assertions** (the oracle) — CDP `Runtime.evaluate` /
   `getComputedStyle`. Answers *is the value right*. Use this for anything
   expressible as state: a class is present, a computed color is `rgba(…)`, a
   rect is at x=371. State assertions cannot see paint: a widget with
   `opacity: 0` inherited from a hover class its container can never satisfy
   reports `visible`, appears in the DOM, and paints NOTHING. Same for a dead
   renderer process — the DOM is intact and the pane is a white rectangle with a
   sad-face bitmap.
2. **A captured screenshot** (the paint check) — `Page.captureScreenshot`, saved
   to a file whose path you state in the report. Answers *did it actually
   paint*. Screenshots cannot see values, and are a lossy instrument: a
   translucent surface over nothing reads as an opaque slab; a downscaled
   preview averages a small light region into its dark surroundings and reads as
   "not painting". When a screenshot contradicts the DOM oracle, **the oracle
   wins** — decode the raw pixel at named coordinates before believing the
   image.

So: assert state for correctness, screenshot for existence-of-paint, and report
both. For a change with no visible surface (pure main-process/logic), state that
in the report as its own line — a claim the reviewer can check, where silence is
indistinguishable from a skipped step.

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

Build first: `npx vite build` (produces `dist/` + `dist-electron/`). Typecheck
with `npx tsc --noEmit` — that is the static gate here (`pnpm run lint` is
declared but eslint is not installed, so it exits `command not found`). Always
rebuild before ANY drive — a stale bundle reproduces a false failure perfectly
in isolation.

**A boot/E2E gate asserts the ARTIFACT IDENTITY — the version string read out
of the running thing — and NEVER trusts the shared installed path.** The
installed build lives at ONE shared location (resolve it from
`~/.local/bin/orchestra`, which is a generated shim that `exec`s the real path —
currently `~/Applications/orchestra/release/Orchestra.AppImage`) and ~26 sibling
agents overwrite it continuously, so "I launched the path I built to" proves
nothing about WHICH build answered. Read the version back and compare it to the
version you built (`node -p "require('./package.json').version"`) — over CDP from
the app's own state, or straight out of the artifact:

```bash
AI=~/Applications/orchestra/release/Orchestra.AppImage   # resolve, don't assume
OFF=$("$AI" --appimage-offset)          # an AppImage is a squashfs at an OFFSET
rm -rf /tmp/ident && mkdir -p /tmp/ident
unsquashfs -o "$OFF" -d /tmp/ident/x "$AI" resources/app.asar  # path is POSITIONAL
cd /tmp/ident && npx --yes asar extract-file x/resources/app.asar package.json
node -p "require('/tmp/ident/package.json').version"   # ← the INSTALLED version
```

Three non-obvious steps, each of which silently breaks the chain: without
`--appimage-offset` unsquashfs sees the ELF header and not a filesystem;
`unsquashfs -e` does NOT take the member path (it is positional, after the
image); and **`asar extract-file` writes into the CURRENT DIRECTORY**, ignoring
any path you put in the argument — so you must `cd` somewhere disposable first,
or it drops a `package.json` into your worktree and you then read the WRONG
version (your own) while believing you read the installed one. That last failure
is the nastiest, because it yields a plausible matching number.

Report both numbers side by side; a mismatch VOIDS the drive. That this matters
is not hypothetical: the reviewer of this very change measured the installed
build at `0.5.255` and, minutes later on the same path, it read `0.5.256` — a
sibling had overwritten it in between. Same rule as the `/json` target-url check
below: identity by what the thing SAYS IT IS, never by where you found it.

**Pin the account before any live drive.** Seeding the store is a REQUIRED step,
not a convenience, and its `configDir` is derived from YOUR `CLAUDE_CONFIG_DIR`
(fallback `~/.claude`) — see the "pin the account in that seed" section of
[`LAUNCH-TRAPS.md`](LAUNCH-TRAPS.md). An unpinned rig falls back to the default
login, which can be OAuth-expired machine-wide, and that failure impersonates
the feature under test.

## Launch an isolated instance with CDP

```bash
env -u APPIMAGE ORCHESTRA_OZONE=wayland ORCHESTRA_OZONE_RELAUNCHED=1 \
  ORCHESTRA_HOME=<fresh tmp dir> ORCHESTRA_DEBUG_PORT=<unique port> \
  ./node_modules/electron/dist/electron .
```

When you launch the instance yourself, read
[`LAUNCH-TRAPS.md`](LAUNCH-TRAPS.md) first — inherited AppImage env (which
silently drives the INSTALLED build), port and tmp-dir collisions with sibling
agents, killing by resolved pid, sandbox `/tmp` isolation, store seeding, and
the headless compositor. Skip it only when you are attaching to an instance
someone else launched.

- Target discovery: `curl http://127.0.0.1:<port>/json` → `webSocketDebuggerUrl`
  of the `type: "page"` entry — **filtered by URL (`dist/index.html`), on EVERY
  connection, not just the first**: once the embedded browser panel navigates,
  its `WebContentsView` becomes a second `type:"page"` target on the SAME port,
  and `find(t => t.type === 'page')` on a reconnect grabs that page instead of
  the app (your keystrokes/queries land in the panel's document and every app
  assertion reads false against working code).
- **`Page.captureScreenshot` on the app target covers only the app renderer's
  own DOM**, so the browser panel's pane region shows `.browser-holder`'s white,
  whatever the sibling `WebContentsView` painted. The composed-window oracle is
  a compositor capture: `WAYLAND_DISPLAY=wayland-N grim -o HEADLESS-1 out.png`
  on the headless sway.

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
`type:'mouseWheel'` for scroll). The app's own feedback loops (ResizeObserver
re-pinning, controlled inputs, `isTrusted` checks) silently override a `.click()`
call or a `scrollTop` assignment plus a synthetic `Event`, and fabricate a
FAILURE against working code. Yield at least one frame between dispatched keys:
two keystrokes in one task means the second sees the pre-setState UI.

Terminal CONTENT is invisible to DOM assertions (the WebGL renderer paints to
canvas; `innerText` is empty) — that is exactly the case where the screenshot is
the only oracle, so read terminal output from screenshot pixels or the PTY log.

## What to check for overlay panes (Help, Insights)

They are absolute overlays over the main pane (the terminals stay mounted):
assert presence/absence of `.help-view` / `.insights-view`, their mutual
exclusion (opening one closes the other), close via `×`, and reopen from the
sidebar header buttons.

## Done when

Every line below holds, and each one is reported with the value that proves it.
An item you could not produce is reported as **NOT VERIFIED** with the reason,
rather than omitted:

- [ ] `npx vite build` and `npx tsc --noEmit` both ran on the current tree, and
      the drive used that build.
- [ ] The `/json` target `url` you drove contains YOUR worktree path, and the
      report quotes it. `app.asar` in that url means the drive is void.
- [ ] The ARTIFACT IDENTITY was asserted: the version string read out of the
      RUNNING instance is quoted beside the version you built, and they match.
      "It was at the installed path" is not an identity — that path is shared.
- [ ] The account was PINNED before the drive: the report quotes the seeded
      `accountId`, the seeded account's `id`, and the derived `configDir` value,
      which equals your own `${CLAUDE_CONFIG_DIR:-$HOME/.claude}`. A drive on
      the unpinned default login is reported as NOT VERIFIED.
- [ ] Every changed surface has at least one NAMED state assertion, printed as
      `pre-state -> post-state` and showing a DIFFERENCE. A surface whose
      pre-state already equalled the target is reported as such — the assertion
      proved nothing there.
- [ ] Every changed surface has at least one screenshot, its file path stated in
      the report, and each of those files has been READ and described in words.
- [ ] `md5sum` of every capture in the set is listed, and all values are
      distinct. Duplicate hashes mean a drive step no-opped.
- [ ] Overlay/popover surfaces additionally have a `getBoundingClientRect()`
      assertion showing the element fully inside the viewport.
- [ ] The instance you launched and its compositor are stopped, killed by
      resolved pid.
- [ ] The report names, per surface, which half proved what — so a reader can
      see that no surface rests on a single half.
