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
- `submit` → `running`; `pretool` → `running` + tool label; `posttool` →
  `running`, clear label, emit live context tokens.
- `stop`/`stopfail` → `waiting` via `fireFinished` `:61` (chime + "finished"
  toast if window unfocused; recomputes merge state; persists context tokens).
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
  the old "no renderer window" guard, generalized through the platform seam to
  `platform.hasAttachedUi()` (Electron window alive OR ≥1 ui-rpc client), so
  the daemon replays events once a frontend attaches (early-return preserves
  the cursor for replay); **(2)** exactly-once via
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
renderer's `pty:data` IPC plus binary ptyData frames to any attached ui-rpc
client (same post-coalescing cadence; see
[ui-rpc-backend.md](ui-rpc-backend.md)); a false return (window mid-recreate)
keeps the retention behavior below. **Echo fast-path:** every `writePty` stamps `echoUntil =
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

## Terminal.tsx (agent view, ~479 lines)
xterm.js with addons: **FitAddon**, **WebLinksAddon** (opens via IPC),
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

## logger.ts (~163 lines)
Synchronous (`appendFileSync`) lifecycle/error log — low volume, so blocking I/O
guarantees lines survive a crash. Dual sinks: `~/.orchestra/logs/orchestra.log`
+ platform Electron logs dir; rotate at 5 MB with one `.1` backup. `initLogger`
`:132` attaches uncaught-exception/rejection handlers. `revealLogs` opens it in
the file manager.
