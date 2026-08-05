# Activity status, events spool, PTY & terminals

How Orchestra knows an agent's status (the sidebar dot) and how terminal I/O
flows. Files: `src/main/activity.ts`, `events-spool.ts` (+ `.test.ts`),
`pty.ts`, `logger.ts`; renderer `Terminal.tsx`, `RunTerminal.tsx`,
`term-write-queue.ts` (+ `.test.ts`).

## Activity is event-sourced, not polled
Claude Code lifecycle hooks append events to a durable JSONL spool; the spool
reader drains them and feeds `activity.ts`, which sets status. No terminal
scraping, no polling.

### Status model — activity.ts (~523 lines)
`WorkspaceStatus = 'idle'|'running'|'waiting'|'error'|'stopped'` (`types.ts:1`).
Event → status (`applyAgentEvent` `:471`):
- `submit` → `running` + `THINKING_TOOL_LABEL`; `pretool` → `running` + tool
  label; `posttool` → `running`, label back to `THINKING_TOOL_LABEL`, emit live
  context tokens.

  **The thinking label is the between-tools latency fix.** Measured on a live
  session: `pretool`→`posttool` pairs are 40–130 ms apart, but consecutive PAIRS
  are 2.5–6.5 s apart — the model generating, with no lifecycle event in the
  window. Status was correctly `running` throughout; what went blank was the
  label, so the row read as frozen. `submit`/`posttool` now label the gap
  instead of clearing it (`THINKING_TOOL_LABEL`, `shared/types.ts`), and
  `statusGlyphTitle` renders it as "Agent is thinking…" rather than the
  parenthesised tool form. Deliberately a LABEL, not a sixth `WorkspaceStatus`:
  `status === 'running'` is compared by equality in `shared/attention.ts` and
  the sidebar's hidden-urgency rollups, so a new state would silently drop
  thinking agents out of "working". The tooltip logic lives in
  `renderer/status-glyph-title.ts` (a plain `.ts` so node:test can import it;
  the `.tsx` component re-exports it) and is unit-tested + mutation-tested.
- `stop`/`stopfail` → `waiting` via `fireFinished` `:61` (chime + "finished"
  toast if window unfocused; recomputes merge state; persists context tokens).
  `applyAgentEvent` takes an optional `stopReason` (`AgentStopReason`) that
  `fireFinished` uses to word the toast — an errored / turn-limited /
  interrupted turn is still `waiting` (the human is still needed) but must not
  announce itself as "ready for review". Only the SDK path supplies it
  (`sdkEventToStopReason`); Claude Code's Stop hook has no reason field, so the
  spool path passes nothing and behaves exactly as before, except `stopfail`
  which implies `error`. Status stays a 5-state machine — the reason is metadata
  beside it, matching how the Messages API (`message_delta.stop_reason`) and
  Managed Agents (typed `stop_reason` on `session.status_idle`) both model
  turn-end.
- `notify` → `waiting` via `fireNeedsInput` `:109` ("needs input" toast).
- `session` (SessionStart; `tool` slot carries the payload `source`) →
  `source=clear|compact` resets the context badge via `resetContext` (0
  sentinel over `agent:context` + drops persisted `contextTokens`), else
  (startup/resume) recomputes it from the transcript.

`setStatus` `:37` **broadcasts the IPC before** the (fire-and-forget) store
write — the dot must never wait on the serialized store. The `changed` flag
gates side effects so a redundant `notify` after `stop` doesn't double-fire.
`reconcileExited` `:339` (called from the PTY exit handler) force-flips a stuck
`running` → `waiting` if the turn-end event never arrived — the dot can't outlive
the process.

Also here (piggybacked on polls, cached by ref-SHA): `detectAndUpdateMergeState`
`:152`, `detectAndUpdateBranchName` `:231` (adopts out-of-band `git branch -m`,
throttled 60s), `detectAndUpdateReleaseState` `:273` (PR cadence, not the hot
poll). Context tokens: `emitContext` `:433` / `computeContextTokens` `:370` reads
the transcript tail and sums `input + cache_creation + cache_read` on the last
non-sidechain assistant message; a `compact_boundary` system entry newer than
any assistant turn returns the 0 reset sentinel (pre-compact usage is stale).

### Events spool — events-spool.ts (~297 lines)
**Why a file, not a socket POST:** old curl-to-socket hooks blocked/dropped
events when the event loop was busy → stuck dot. Now hooks append (atomic,
sub-ms); the file is the source of truth.

- Location: `$ORCHESTRA_HOME/events` or `~/.orchestra/events`, file
  `<wsid>.jsonl` (+ `.seq` counter, `.jsonl.old` after rotation). `getEventsDir`
  `:88`.
- `drain(id)` `:106` guarantees: **(1)** never consume without an attached UI —
  `platform.hasAttachedUi()` (the Electron window is alive), so events are
  replayed once the window returns (early-return preserves the cursor for
  replay); **(2)** exactly-once via
  monotonic `seq` (skip ≤ lastSeq); **(3)** per-event try/catch so one throw
  can't abort the batch and strand a trailing `stop`. `maybeRotate` `:206`
  rotates only when quiescent (≥256 KiB, no partial line, size unchanged).
- `startEventsSpool(win)` `:235` **wipes the dir at startup** (any on-disk spool
  is stale; live status lives in store.json), then watches the dir + 1s
  safety-net poll. `stopEventsSpool` `:282`.
- **Multi-instance hazard:** dev + packaged instances must not share the events
  dir — the second instance's startup wipe would zero the first's spool. That's
  why `$ORCHESTRA_HOME` segregates dev. (Matches the known "stuck dot =
  shared events dir wiped by a 2nd instance" gotcha.)
- `events-spool.test.ts` replays the reader headlessly: normal turn ends
  `waiting`; mid-batch throw no longer strands `stop`; events seen while window
  absent replay once it returns; real hook under concurrency drops nothing.

## PTY — pty.ts (~422 lines)
Manages agent sessions over a **transport seam**. PTY id = `<wsId>` (agent),
`<wsId>:run`, or `<wsId>:nvim`. `createTransport(host, …)` `:21` picks the
backend per session: absent/local host → node-pty
(`transport/local-pty.ts`); `host.kind==='sandbox'` → a shared WebSocket to
the container's shim (`transport/remote.ts` + `sandbox-manager.ts` — see
[sandbox-transport.md](sandbox-transport.md)). Remote spawns skip the local
cwd check and ship only `extraEnv` (never the host's `process.env`).
`startPty(opts)` `:169` validates the worktree (local only), builds env
(`TERM=xterm-256color` plus the terminal-capability vars `COLORTERM=truecolor`
and `CLAUDE_CODE_FORCE_SYNC_OUTPUT=1` — Claude Code enables truecolor and
?2026 synchronized-output frames from a terminal-identity allowlist that a
bare xterm-256color doesn't match, so without these it renders 256-colour and
flickers; the renderer's write queue is what makes 2026 frames actually
atomic — plus the `ORCHESTRA_*` vars, PATH-prepended bin), spawns
(min 20×5), logs every chunk to `~/.orchestra/logs/<id>.log` (≤2 MB, trimmed),
and **coalesces output** before delivery: `queuePtyData` buffers into the
`outBuf`, flushing at 8 ms or 64 KiB (`FLUSH_MS`/`FLUSH_BYTES`) — one tiny
IPC per pty chunk would head-of-line-block the status-dot updates on the shared
renderer channel. Each flush goes through `platform.broadcastPtyData` — the
renderer's `pty:data` IPC; a false return (window mid-recreate) keeps the
retention behavior below. **Echo fast-path:** every `writePty` stamps `echoUntil =
now + ECHO_WINDOW_MS` (150 ms); while inside that window flushes use
`FLUSH_MS_ECHO` (2 ms) instead of 8 ms, so a keystroke's redraw isn't held the
full throughput window (the "small freeze while typing" fix). Sustained output
with no recent input falls straight back to `FLUSH_MS`. If the window can't
receive (`canSend` false — destroyed/being recreated), `flushPtyData` RETAINS
`outBuf` for the next flush instead of dropping it (capped at 8 MiB, oldest
half trimmed) — a silent drop permanently desyncs the renderer's xterm from
the child's diff-render model. The `onExit` handler flushes the tail, emits `pty:exit`,
and calls `reconcileExited` (guarded against a live replacement). `stopAll`
sets `shuttingDown` so exit handlers preserve `running` as a resume marker.
Other exports: `writePty`, `resizePty` (drops no-op resizes to avoid
SIGWINCH churn), `repaintPty` (SIGWINCH bounce: cols−1 then back, restore
guarded so a real resize landing inside the 40 ms window wins — the only
reliable heal when xterm's buffer diverges from Claude's per-cell diff-render
model, the "scattered words" garble; used by the `pty:start`/`nvim:start`/
`accounts:loginStart` already-running remount paths and the renderer-invoked
`pty:repaint` IPC), `stopPty`, `readScrollback` (last 256 KiB only),
`clearScrollback`, `isRunning`, `getPtySize` (live session's winsize, falling
back to a `lastSizes` map that survives `stopPty` — main-initiated respawns of
a stopped session, i.e. account-migration resume and `wakeAgentWithPrompt`,
reuse it so an open terminal keeps its real width instead of snapping to a
default 80×24 / 120×32; the renderer only re-asserts size on container/focus
changes, never on an out-of-band respawn).

## Session hibernation — hibernation.ts / hibernation-activity.ts / shared/hibernation.ts

Idle agents used to keep their processes forever: the renderer's 12-pane LRU
(`shared/mounted-panes.ts`) unmounts React components but never the backing
process, and `stopPty`/`sdkStop` fired only on explicit stop/delete/archive/quit
— so ~19 live agents held hundreds of MB of resident memory. The sweeper stops
long-idle agents and lets the existing resume paths bring them back.

- **Eligibility is pure** — `src/shared/hibernation.ts` `shouldHibernate(ws,
  signals)` + `resolveHibernateAfterMs` + `formatIdleDuration`, exhaustively
  unit-tested (`hibernation.test.ts`, incl. a positive-control baseline so the
  negative assertions can't pass vacuously). ALL must hold: a process is live;
  `status === 'idle'` (never `running`/`waiting`/`error`/`stopped` — `waiting`
  means the human is needed and the dot + inbox entry must survive); not the
  active workspace; not sandbox-hosted (`ws.host` absent); not archived; no live
  `<id>:run` PTY; idle ≥ threshold. Threshold from
  `ORCHESTRA_HIBERNATE_AFTER_MS`: unset/empty/garbage/`0` → 30 min default,
  `-1` → disabled (its own sentinel, since an env var with a default is not a
  kill switch), positive → verbatim (the e2e rig injects a few seconds).
- **The sweeper** — `src/main/hibernation.ts` `startHibernationSweeper()` (wired
  in index.ts beside the other pollers, torn down in `shutdownSubsystems`) runs
  `sweepHibernation()` on an unref'd `setInterval`. Per eligible workspace:
  `sdkStopIfLive` (the sdk-delivery seam) then `stopPty`, then `markHibernated`
  records `ws.hibernatedAt` and broadcasts `workspace:update` (mutation-site
  broadcast: persist in the background, broadcast immediately).
- **Both knobs are env-injectable, and that is a testability requirement, not a
  convenience.** The cadence is `ORCHESTRA_HIBERNATE_SWEEP_MS`
  (`resolveHibernateSweepMs`, default 5 min, floored at 1s, no disable sentinel
  — disabling is the threshold's job, and two kill switches for one feature can
  disagree). A rig needs a short THRESHOLD *and* a short CADENCE: with only the
  former, the sweep is observable only by waiting out a real 5-minute timer.
  The startup banner prints both as raw ms next to the friendly duration,
  because `formatIdleDuration` renders 5s and 55s identically as "<1m" and so
  cannot confirm an injection took.
- **The log line names the KILLED PID** (`… — idle 5m pty pid=12345`), sampled
  via `getPtyPid` (pty.ts) BEFORE `stopPty` — afterwards the session is gone
  from the registry and the pid is unrecoverable. This is what makes process
  death assertable with `ps -p <pid>`; an absent registry entry or UI text
  proves only that the app's own bookkeeping changed.
- **The sweep NEVER touches disk.** It acts only on state it owns — live
  process/session handles and store fields. `ORCHESTRA_HOME` relocates
  userData/logs/spool but NOT worktrees or scratch dirs, which stay under the
  real `~/.orchestra` alongside every sibling agent — so an fs call in the sweep
  path would be unsafe even to VERIFY on a busy machine. Guarded mechanically by
  `hibernation-no-disk.test.ts` (source-level: no `node:fs`/`child_process`
  import, no mutating fs call, and the activity leaf stays import-free), each
  assertion carrying a positive control and the whole guard mutation-tested.
- **Status is never touched.** A hibernated workspace stays `idle` — that IS its
  state. `hibernatedAt` carries the distinction, for the sidebar chip alone.
- **Last activity** lives in `src/main/hibernation-activity.ts`, a
  DEPENDENCY-FREE leaf: `applyAgentEvent` (activity.ts) stamps `noteActivity`
  for every lifecycle event — the one funnel both the spool-tailed terminal path
  and the structured path's `driveStatusFromEvent` pass through — and activity.ts
  cannot import hibernation.ts, which imports pty.ts, which imports activity.ts.
  In-memory only, which is the SAFE direction: after a restart the map is empty
  and the sweep falls back to an app-start floor, so nothing can be hibernated
  until it has been idle a full threshold *of this run*.
- **Restore** rides the paths that already resume: `clearHibernated(id)` is
  called from `ensureSession` (agent-sdk.ts — the single funnel for every SDK
  start/resume/wake, so no restore path can forget it), the `ptyStart` handler
  (which is also Terminal.tsx's press-any-key `claude --continue` relaunch),
  `wakeAgentWithPrompt` (covering its raw-PTY fallback), and workspace
  ACTIVATION. The renderer reports selection over the new
  `setActiveWorkspace` IPC (`workspaces:setActive`) — both so the sweeper never
  kills the pane under the user's cursor and because activating a hibernated row
  is a restore intent that drops the chip immediately.
- **Not an attention signal.** `computeAttention` (shared/attention.ts) ignores
  `hibernatedAt` entirely, guarded by a regression test — a hibernated agent must
  never fill the Needs-You inbox. The UI is one quiet `.ws-hibernated` "zZ" chip
  on the sidebar row plus a further-dimmed `.ws-dot.hibernated` (an explicit user
  bookmark still wins the dot), with a tooltip aging `hibernatedAt`.

## Terminal.tsx (agent view, ~479 lines)
xterm.js with addons: **FitAddon**, **WebLinksAddon** (opens via IPC),
themed via the shared `TERM_THEME` (`src/renderer/term-theme.ts` — app-chrome
bg/fg/cursor plus Ghostty's default ANSI-16 palette (Tomorrow Night); xterm's
stock ANSI colors are the legacy VGA set, which made Claude's TUI look harsher
in-app than in a native terminal),
**Unicode11Addon** (`:104` — align char widths with Claude's Ink TUI so emoji
don't cause overwrites), **WebglAddon** (`:117`, GPU; disposes on context-loss →
DOM fallback). Font stack leads with **"Orchestra Symbols"** (bundled mono
symbol-font subset) so circled-number/dingbat glyphs render at cell width — and
the texture atlas is cleared once the font loads (`:139`) to evict any cached
proportional fallback. (This is the "cramped ①②③" fix.)

**Shared write queue — term-write-queue.ts (`src/renderer/`, ~180 lines):**
PTY data reaches xterm through `createTermWriteQueue`, a dependency-free
module (node-testable; seams for RAF/clock injected in tests) used by both
Terminal.tsx and RunTerminal.tsx. It does three things:
- **RAF-batched writes (the dot-latency fix):** hands xterm at most
  `WRITE_BUDGET_BYTES = 256 KiB` per animation frame, then yields — a big
  tool-dump parsed in one sync tick used to jank the renderer and stall the
  shared IPC channel (the "~10s dot lag"). 256 KiB is tuned (xterm 5.5 +
  WebGL parses ~35–50 MB/s; 64 KiB is slower per-byte, 512 KiB regresses).
- **Atomic ?2026 sync frames (the flicker fix):** pty.ts advertises
  `CLAUDE_CODE_FORCE_SYNC_OUTPUT`, so Claude wraps every TUI redraw in
  `\x1b[?2026h…l`. xterm.js ignores mode 2026, so the queue supplies the
  atomicity: a drain slice never ends inside an open frame — it extends to
  the frame's close, or holds the frame until the close arrives (bounded by
  `SYNC_HOLD_MS = 150` so a lost close can't stall output). Split markers at
  chunk boundaries are held too, so tracking can't be defeated by IPC
  chunking.
- **Small-chunk fast path (input latency):** a chunk ≤ `FAST_PATH_BYTES = 4
  KiB` arriving with nothing scheduled (a keystroke echo) is written
  immediately instead of waiting up to a frame for the next RAF.

Terminal.tsx also has: custom floating scrollbar (no gutter), Ctrl+C→copy,
Ctrl+V image-paste (spill to temp file, bracketed-paste the path),
Shift+Enter→ESC+CR, lazy PTY start + size re-assert on visibility/focus.

**Cold-boot pill (the blank-first-open fix):** lazy-start means the first open
of a previously-running workspace cold-boots `claude --continue`; Claude opens
a ?2026 frame, paints only its small splash header (~500 B), then loads the
session silently for seconds — the pane read as a blank page with just the
Clawd logo. `beginBoot()` (called in `start()` right before `ptyStart`) shows a
centered "Resuming previous session…" / "Starting agent…" pill (label from an
imperative `useStore.getState()` read of `ws.hasInput` — no subscription);
cleared once cumulative PTY output ≥ `BOOT_PAINT_BYTES` (2 KiB — above the
splash, below any real TUI frame), or on user keystroke, PTY exit, spawn
failure, or a `BOOT_PILL_MAX_MS` (20 s) safety timeout. CSS
`.term-boot-pill` (styles.css) fades in after 250 ms so fast starts never
flash it.

**Stop without respawn (`agent:stop`, main index.ts):** the Resources page's
per-agent stop kills the agent PTY and deliberately does NOT respawn (the point
is freeing CPU/memory). `stopPty` disposes the transport listeners before
killing, so the exit handler's `reconcileExited` floor never fires on this path
— the handler reconciles explicitly, then emits `pty:stopped`. Terminal.tsx
handles it (and natural `pty:exit`) by un-latching `started` and printing a
"press any key to relaunch" notice; `term.onData` treats the first keystroke on
a dead session as a relaunch trigger (calls `start()`, does not forward the
key), so the next spawn resumes via `claude --continue`.

**Repaint-on-show (the garbled-frame fix):** a hidden tab is `visibility:hidden`
(not unmounted), so the PTY keeps streaming and `drainPending` keeps writing into
xterm while its WebGL canvas is offscreen/occluded — on some GPUs that leaves the
glyph texture atlas + composited canvas half-updated, so returning to the tab
shows scrambled glyph soup. The `isActive` effect (and `onVisible` for the active
pane) calls `repaint()` after the refit: `webgl.clearTextureAtlas()` +
`term.refresh(0, rows-1)` redraws every row from xterm's (always-correct) buffer.
`repaintRef`/`isActiveRef` bridge the value into the mount effect's long-lived
closures without stale captures. Both sites ALSO call
`window.orchestra.ptyRepaint` (→ `repaintPty` SIGWINCH bounce): `repaint()`
only redraws xterm's buffer, but when the buffer ITSELF has diverged from
Claude's per-cell diff-render model (diffs hop over "unchanged" cells, so
divergence accumulates as scattered-word fragments and never self-heals — the
2026-07-18 garbled-terminal bug; the byte stream and parser were proven clean
via @xterm/headless replay of the PTY log), only a child repaint reconverges
the two. Human-paced (window-shown / window-FOCUS / tab activation) and a
no-op resize when nothing diverged. The `onFocus` copy is load-bearing on
Linux: Chromium has NO window-occlusion detection on Wayland, so a window on
a hidden sway workspace keeps `visibilityState === 'visible'` and
visibilitychange never fires (verified via CDP against a headless-sway
instance) — window `focus` is the only return signal that actually fires
there.

## RunTerminal.tsx (run-script view, ~250 lines)
Simpler xterm than the agent view (no Unicode11/custom scrollbar, 5k
scrollback), but shares its performance path: WebGL renderer (same
context-loss→DOM-fallback guard) and the same shared write queue
(`createTermWriteQueue` from `term-write-queue.ts`) — a noisy dev server
can no longer jank the shared IPC channel. Scrollback replay on mount goes
through the same `queue.push` so a big replay is spread across frames too;
`onPtyExit` calls `queue.reset()` so stale output can't bleed into a session
restarted via the Run button. Start/Stop buttons drive a
`<wsId>:run` PTY (`bash -lc <script>` with `$ORCHESTRA_PORT`); Ctrl+C copies if
there's a selection else forwards to the script.

## logger.ts (~320 lines)
Synchronous (`appendFileSync`) lifecycle/error log — low volume at the default
level, so blocking I/O guarantees lines survive a crash. Dual sinks:
`<ORCHESTRA_HOME>/logs/orchestra.log` + platform Electron logs dir; rotate at
5 MB with one `.1` backup. `initLogger` attaches uncaught-exception/rejection
handlers. `revealLogs` opens it in the file manager.

**Levels + `$ORCHESTRA_LOG_LEVEL`.** Five levels
(`trace|debug|info|warn|error`), threshold from the env var, default `info`;
an unknown value warns and falls back to `info` (a typo must never silence the
log). `trace` is the per-event firehose (every IPC call, status transition,
spool event, SDK event); `debug` adds slow-operation and fallback detail. The
instrumentation is compiled in but dormant, so reproducing a bug is
`ORCHESTRA_LOG_LEVEL=trace orchestra` with no rebuild. `isLevelEnabled(level)`
lets a caller skip building an expensive meta payload; `ScopedLogger.traceEnabled()`
lets one take a costlier diagnostic path (git.ts evaluates each merge signal
separately under trace so the log names which one decided the verdict). The
startup banner prints the active level — so an absent line reads as "not
recorded at this level" rather than "the event didn't happen" — plus version,
pid, runtime and home.

**Scopes.** `scoped('pty')` tags every line `[pty]`, `.child('sub')` nests to
`[pty:sub]`. Tags are what make a verbose log greppable (`grep '\[spool\]'`
isolates one subsystem out of an interleaved trace). Live scopes: `activity`,
`pty`, `spool`, `store`, `git`, `sdk`, `ipc`, plus `[renderer] [<scope>]` for
renderer-originated lines.

`ScopedLogger.swallow(what, err)` is the explicit replacement for a silent
`catch {}` — it records at `warn` and continues. `time(what, fn)` brackets an
async op with entry/exit and a duration (or logs the throw with its elapsed
time). Meta formatting surfaces what `.stack` omits: errno fields
(`code`/`syscall`/`path`), `cause` chains, cycle-safe serialization, and a
4000-char clamp so one huge payload can't evict the history around a bug.

### Instrumented seams (added for bug-catching)
- **IPC** (`index.ts` `handle()`): every renderer→main call traced with args;
  calls ≥250 ms logged as `SLOW` at `debug`; failures always log args. Keystroke
  and secret channels are redacted by name (`NO_ARG_LOG`) — timing/counts only.
- **Renderer** (`src/renderer/log.ts`): previously there was **no** persistent
  renderer logging at all. `scoped()` mirrors the main API over the `logs:write`
  IPC into the same file; `installRendererCrashHandlers()` captures `error` and
  `unhandledrejection`; `initRendererLog()` mirrors the backend level via
  `logs:level`, overridable live from DevTools with `window.__orchestraLogLevel`.
  Errors are flattened before the IPC hop (an `Error` structured-clones to `{}`).
  `components/ErrorBoundary.tsx` logs the React **component stack** (which
  `window.onerror` never sees) and renders a readable fallback instead of the
  blank window a render throw otherwise produces.
- **Silent-failure removals:** store load/save (a corrupt `store.json` now logs
  at `error` and is preserved as `.corrupt-<ts>` instead of silently resetting
  all user data), spool read/parse failures, the pty output-drop path (the cause
  of "scattered word" garble), writes to a dead PTY, unhandled agent-event
  types, the events-dir startup wipe (fingerprint of the multi-instance
  stuck-dot bug), and the renderer store's startup fallbacks (which render a
  failed backend call as a legitimately-empty UI section).
