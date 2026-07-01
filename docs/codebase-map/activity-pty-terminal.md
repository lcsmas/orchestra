# Activity status, events spool, PTY & terminals

How Orchestra knows an agent's status (the sidebar dot) and how terminal I/O
flows. Files: `src/main/activity.ts`, `events-spool.ts` (+ `.test.ts`),
`pty.ts`, `logger.ts`; renderer `Terminal.tsx`, `RunTerminal.tsx`.

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
non-sidechain assistant message.

### Events spool — events-spool.ts (~297 lines)
**Why a file, not a socket POST:** old curl-to-socket hooks blocked/dropped
events when the event loop was busy → stuck dot. Now hooks append (atomic,
sub-ms); the file is the source of truth.

- Location: `$ORCHESTRA_HOME/events` or `~/.orchestra/events`, file
  `<wsid>.jsonl` (+ `.seq` counter, `.jsonl.old` after rotation). `getEventsDir`
  `:88`.
- `drain(id)` `:106` guarantees: **(1)** never consume without a renderer window
  (early-return preserves the cursor for replay); **(2)** exactly-once via
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

## PTY — pty.ts (~383 lines)
Manages node-pty sessions. PTY id = `<wsId>` (agent), `<wsId>:run`, or
`<wsId>:nvim`. `startPty(opts)` `:155` validates the worktree, builds env
(`TERM=xterm-256color`, the `ORCHESTRA_*` vars, PATH-prepended bin), spawns
(min 20×5), logs every chunk to `~/.orchestra/logs/<id>.log` (≤2 MB, trimmed),
and **coalesces output** before IPC: `queuePtyData` `:141` buffers into the
`outBuf`, flushing at 8 ms or 64 KiB (`FLUSH_MS`/`FLUSH_BYTES` `:58`) — one tiny
IPC per pty chunk would head-of-line-block the status-dot updates on the shared
renderer channel. The `onExit` handler `:272` flushes the tail, emits `pty:exit`,
and calls `reconcileExited` (guarded against a live replacement). `stopAll` `:376`
sets `shuttingDown` so exit handlers preserve `running` as a resume marker.
Other exports: `writePty`, `resizePty` `:344` (drops no-op resizes to avoid
SIGWINCH churn), `stopPty`, `readScrollback` `:92` (last 256 KiB only),
`clearScrollback`, `isRunning`.

## Terminal.tsx (agent view, ~479 lines)
xterm.js with addons: **FitAddon**, **WebLinksAddon** (opens via IPC),
**Unicode11Addon** (`:104` — align char widths with Claude's Ink TUI so emoji
don't cause overwrites), **WebglAddon** (`:117`, GPU; disposes on context-loss →
DOM fallback). Font stack leads with **"Orchestra Symbols"** (bundled mono
symbol-font subset) so circled-number/dingbat glyphs render at cell width — and
the texture atlas is cleared once the font loads (`:139`) to evict any cached
proportional fallback. (This is the "cramped ①②③" fix.)

**RAF-batched writes (the latency fix):** a big tool-dump entering xterm in one
sync tick janks the renderer and stalls the shared IPC channel → the famous
"~10s dot lag". `drainPending` (`:323`) hands xterm at most
`WRITE_BUDGET_BYTES = 256 KiB` per `requestAnimationFrame`, then yields. 256 KiB
is tuned (xterm 5.5 + WebGL parses ~35–50 MB/s; 64 KiB is slower per-byte, 512
KiB regresses). Also: custom floating scrollbar (no gutter), Ctrl+C→copy,
Ctrl+V image-paste (spill to temp file, bracketed-paste the path),
Shift+Enter→ESC+CR, lazy PTY start + size re-assert on visibility/focus.

**Repaint-on-show (the garbled-frame fix):** a hidden tab is `visibility:hidden`
(not unmounted), so the PTY keeps streaming and `drainPending` keeps writing into
xterm while its WebGL canvas is offscreen/occluded — on some GPUs that leaves the
glyph texture atlas + composited canvas half-updated, so returning to the tab
shows scrambled glyph soup. The `isActive` effect (and `onVisible` for the active
pane) calls `repaint()` after the refit: `webgl.clearTextureAtlas()` +
`term.refresh(0, rows-1)` redraws every row from xterm's (always-correct) buffer.
`repaintRef`/`isActiveRef` bridge the value into the mount effect's long-lived
closures without stale captures.

## RunTerminal.tsx (run-script view, ~227 lines)
Simpler xterm (no Unicode11/WebGL/custom scrollbar, 5k scrollback). Start/Stop
buttons drive a `<wsId>:run` PTY (`bash -lc <script>` with `$ORCHESTRA_PORT`);
writes inline (no budget); restores prior scrollback on mount; Ctrl+C copies if
there's a selection else forwards to the script.

## logger.ts (~163 lines)
Synchronous (`appendFileSync`) lifecycle/error log — low volume, so blocking I/O
guarantees lines survive a crash. Dual sinks: `~/.orchestra/logs/orchestra.log`
+ platform Electron logs dir; rotate at 5 MB with one `.1` backup. `initLogger`
`:132` attaches uncaught-exception/rejection handlers. `revealLogs` opens it in
the file manager.
