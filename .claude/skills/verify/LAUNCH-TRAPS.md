# Launch traps — reached only when you launch the instance yourself

Everything here bites between "I typed the launch command" and "I have a CDP
target I trust". Each entry is a failure that presents as a working drive
against the wrong subject, so each one ends in an assertion.

## You are a child of the installed AppImage — strip its env

Your agent process is a child of the running Orchestra AppImage. As of the
`stripProcessLocalEnv` fix (`shared/child-env.ts`) the app no longer passes
`APPIMAGE`/`APPDIR`/`ARGV0`/`OWD` to the PTYs it spawns — but you inherit them
from ANY older installed build, which is most of the time, so keep stripping
them explicitly. The ozone-relaunch block (`src/main/index.ts:67-91`) re-execs
`$APPIMAGE` when the platform hint disagrees — so `npx electron .` silently
hands off to the *packaged* app, which happily reports a healthy CDP target
while running code from months ago.

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

Keep `APPIMAGE` unset for a second reason: `cli-shim.ts` rewrites
`~/.local/bin/orchestra` on every GUI startup from that value, so a stub path
silently breaks the user's real `orchestra` command. With `APPIMAGE` unset the
shim install no-ops on Linux; if a run did set it, restore
`~/.local/bin/orchestra` afterwards.

## Pick a port and a tmp dir that no sibling agent shares

- **Port**: pick a UNIQUE debug port (e.g. 93xx derived from your workspace id).
  Sibling agents run identical harnesses and 9322 specifically has collided.
  After connecting, confirm the `/json` target's `url` points at YOUR worktree.
- **Tmp dir**: name it after YOUR workspace, e.g. `orch-<workspace-id>`. Sibling
  agents run this same harness concurrently and clean up with globs, so a shared
  prefix like `orch-verify*` gets your `ORCHESTRA_HOME` deleted mid-drive
  (observed: the app died and the seeded store vanished between two runs).

## Kill by resolved pid

`pkill -f <your tmp path>` kills your own shell — the pattern appears in the
Bash tool's own command line. Resolve the pid first (`ss -ltnp | grep <port>`)
and kill by that pid. Keep a Bash call containing a kill free of any other
command: if the kill takes out the wrapper shell, every later command in that
same invocation silently never runs.

## Run every step with the Bash sandbox DISABLED

A sandboxed call gets a private `/tmp`, so the sway config / store seed you
write in one call is invisible to the unsandboxed app in the next — presenting
as "sway: config not found" and an empty sidebar.

## Seed state instead of clicking it in

Write `<home>/userData/orchestra/store.json`
(`{repos, workspaces, accounts, selfTuneRuns}`) before launch. Point
`worktreePath` at REAL git-registered worktrees (`git worktree list`) —
`pruneOrphanedWorkspaces` deletes records it can't verify, silently emptying a
fabricated store.

## What the env vars actually reach

- `ORCHESTRA_HOME` relocates userData (store/logs/login dirs) and the events
  spool — but NOT scratch dirs or worktrees, which the app still creates under
  the real `~/.orchestra`; clean up any workspace you let it create.
- `ORCHESTRA_DEBUG_PORT` enables CDP (`src/main/index.ts` also sets
  `remote-allow-origins=*`, so websockets don't 403).

## The compositor that renders frames

The headless sway recipe is owned by the **`headless-sway-e2e` skill** — invoke
it for the compositor launch, the socket-discovery steps and its own gotchas.
What that recipe needs from this app: `WAYLAND_DISPLAY=wayland-N`
`ELECTRON_OZONE_PLATFORM_HINT=wayland` plus the sanitized-env launch above, and
a minimal config of `output HEADLESS-1 resolution 1600x1000` (a "Could not find
config for output" warning is harmless). Kill the compositor and the app when
the drive ends.

A hidden window produces no frames, which blocks CDP INPUT and hit-testing too,
not just pixels (clicks silently no-op) — on the user's desktop the test window
usually sits on a hidden Sway workspace and `Page.captureScreenshot` hangs.
The headless compositor is what makes both halves possible, and it leaves the
user's focus alone.
