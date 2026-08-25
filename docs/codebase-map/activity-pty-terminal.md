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

  **`submit` and `pretool` also stamp `Workspace.lastTurnStartAt` (issue #88)**,
  by passing `turnStart: true` as `setStatus`'s 4th argument — the same
  piggyback trick `stopReason` uses, so the stamp rides the store write and the
  broadcast that already happen on the transition. This is the one chokepoint
  BOTH agent paths cross with the meaning "this workspace picked up work", and
  it is deliberately NOT `noteActivity`: that stamps on every event including
  unhandled ones (by design — an unrecognized hook still proves the agent is
  alive), so it measures ALIVENESS, whereas #88 needs CONSUMPTION. The field is
  monotonic — assigned only on a turn start, never cleared — because clearing it
  makes the stall age fall back to `createdAt`, which on an old workspace reads
  as a stall of days. The write is guarded by `setStatus`'s no-op check, which
  is correct: repeated `pretool`s inside one turn are not new turn starts.
  Guarded by `src/main/turn-start-stamp.test.ts` (a SOURCE check, because
  `activity.ts` cannot be imported under `node --test` — `./platform` is an
  extensionless directory import only Vite resolves; measured 2026-08-25).

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
- `stop`/`stopfail` → **`idle` + `autoUnread`** via `fireFinished` (chime +
  "finished" toast if window unfocused; recomputes merge state; persists context
  tokens).
  `applyAgentEvent` takes an optional `stopReason` (`AgentStopReason`) that
  `fireFinished` uses to word the toast — an errored / turn-limited /
  interrupted turn still lands `idle` + `autoUnread` (the human is still
  needed — see the three attention states below) but must not announce itself
  as "ready for review". Only the SDK path supplies it
  (`sdkEventToStopReason`); Claude Code's Stop hook has no reason field, so the
  spool path passes nothing and behaves exactly as before, except `stopfail`
  which implies `error`. Status stays a 5-state machine — the reason is metadata
  beside it, matching how the Messages API (`message_delta.stop_reason`) and
  Managed Agents (typed `stop_reason` on `session.status_idle`) both model
  turn-end.
- `notify` → `waiting` via `fireNeedsInput` `:109` ("needs input" toast).

**The stop reason is PERSISTED, not just toasted (issue #69).** Until v0.5.260
the reason was computed and thrown away after wording one OS toast — and that
toast is suppressed whenever the window is focused, so the user sitting in
front of the app never saw it. Since `fireFinished` sets `idle` for EVERY
terminal reason, a session that had exhausted its turn budget was
pixel-identical in the sidebar to one that finished cleanly.

### Queue-stall detection (issue #88)

"N deliveries are parked here and no turn has started in N minutes" — the
CAUSE-AGNOSTIC symptom, surfaced as an amber sidebar pill. Mechanizes the
lead-heartbeat convention after two same-day incidents where a fleet froze
silently and the human was the detector.

- **Policy** — `src/shared/queue-stall.ts`, pure and total like
  `usage-resume.ts`: `decideQueueStall(input)` / `workspaceQueueStall(ws, now)`
  → verdict or `null`. `QUEUE_STALL_THRESHOLD_MS` = 15 min (reasoned, not
  measured — the doc comment says so; safety rests on the `running` guard, not
  the number). Unit + mutation tested (`src/shared/queue-stall.test.ts`).
- **It is the COMPLEMENT of #69, not an overlay.** It stands down whenever
  `isActionableStopReason(lastStopReason)` — `max_turns` / `error` /
  `usage_limit` already carry a glyph naming the cause, and `usage_limit` is
  additionally being auto-resumed by #74 with a deliberately CALM glyph that a
  second alarm would undo. Routed through the shared predicate so a new
  actionable reason suppresses this badge automatically.
- **Inputs.** `queuedPrompts.length` + `parkedInboxCount` (one number on the
  badge, split in the tooltip); `lastTurnStartAt` (falling back to `createdAt`
  for a workspace that never ran); `status`; `hibernatedAt`; `archived`.
- **`Workspace.parkedInboxCount` is maintained by MAIN** — `inbox-tray.ts`'s
  `syncParkedCount`, called from `broadcastInbox`, plus `reconcileParkedCounts()`
  at startup (`src/main/index.ts`) because the shell hook drains inbox files
  while the app is closed. It exists because the renderer's `store.parkedInbox`
  cache is hydrated PER-PANE (`StructuredView`'s mount effect), so a workspace
  nobody has opened has no entry — which is exactly the fleet-freeze case, since
  nobody looking at the frozen agent is why it stays frozen.
- **Render** — `src/renderer/components/QueueStallBadge.tsx`, dropped into BOTH
  Sidebar render paths (spawn-tree rows and repo-section rows) so they cannot
  drift. A numeric PILL styled on `ws-hidden-count` (`.ws-stall-badge` in
  styles.css), not a new `WorkspaceStatusGlyph` shape: the glyph slot is the
  STATUS axis and #69 owns it for stop reasons, while a stall is orthogonal
  (like `loopingSince`/`autoUnread`) and has a count to show. A shared 30s
  clock re-derives the verdict, because the threshold is crossed by the passage
  of time alone — no store event fires at that moment, so an event-only badge
  would appear just when you were already looking.
- **Clears three ways**, all derived (nothing persisted, so it cannot go stale):
  a turn starts (`lastTurnStartAt` moves), the queue/inbox drains
  (`parkedCount === 0`), or the workspace goes `running`.

- `markStoppedOnMaxTurns(id)` (`src/main/activity.ts`) records that a turn died
  on the SDK turn limit (`setStatus(id,'idle','max_turns')` — a stopped session
  is idle; the REASON is the orthogonal axis). Called from `emitFrom`
  (agent-sdk.ts) OUTSIDE the `driveStatus` single-writer gate: that gate is TRUE
  only when a terminal PTY coexists, and MEASURED, 8 consecutive exhaustions in
  the no-PTY configuration wrote no reason anywhere — which is #69's whole bug.
  An E2E may NOT seed `lastStopReason`; a seeded value proves only that the
  renderer renders a field.
- `markStoppedOnUsageLimit(id, resetsAtMs)` (`src/main/activity.ts`) is the #74
  sibling for a turn killed by the account's USAGE LIMIT — the one reason that
  resolves by itself, and the only one the app auto-resumes from (see
  [accounts-usage.md](accounts-usage.md)). Same outside-the-gate exemption and
  the same rationale. It also writes `Workspace.usageLimitResetsAt` (epoch MS —
  the notice reports SECONDS; `resetsAtMsFromNotice` is the one conversion
  point). `clearStopReason(id)` is its counterpart, clearing ONLY a
  `usage_limit` marker once the resume driver has acted — without it every
  20s tick would re-decide to nudge.
- `setStatus` (`src/main/activity.ts`) takes a third arg, `stopReason`:
  `'max_turns' | 'error' | 'usage_limit'` records, `null` CLEARS, `undefined`
  leaves alone. It
  writes `Workspace.lastStopReason` / `lastStopReasonAt` on the SAME store write
  and broadcast as the status, so the dot and its explanation stay atomic. The
  marker is compared BEFORE the `ws.status === status` no-op short-circuit — a
  second budget death on an already-`idle` workspace is a real change to WHY it
  is idle, and would otherwise be swallowed.
- `fireFinished` passes the reason through; `submit`/`pretool` pass `null`, so
  the marker clears the moment the agent takes another turn.
- Broadcast with an EXPLICIT `undefined` on clear: `workspace:update` is a MERGE
  in the renderer and deleting a key cannot unset it (same trap as
  `loopingSince`).
- Rendered by `WorkspaceStatusGlyph` (`stopReason` prop) ABOVE the autoUnread
  bell — "stopped and consuming nothing" outranks "finished, unseen" — as a
  distinct SHAPE (octagon-alert for `max_turns`, circle-x for `error`,
  circle-pause for `usage_limit`), so the state survives greyscale and
  colour-blindness. The pause is deliberately MUTED rather than red: nothing is
  wrong and nobody is needed, since the app resumes it itself. Tooltip clauses
  live in `src/renderer/status-glyph-title.ts`.
- The allowlist deciding which reasons get a marker is the SHARED predicate
  `isActionableStopReason` (`src/shared/usage-resume.ts`), not a per-site
  literal. It is routed through **seven** sites — the five that pass the prop
  (`src/renderer/components/Sidebar.tsx` ×2,
  `src/renderer/components/InboxBell.tsx`,
  `src/renderer/components/JumpPalette.tsx`,
  `src/renderer/components/ResourcesView.tsx`) plus the two that CONSUME it: the
  `stopReason` prop type in `src/renderer/components/WorkspaceStatusGlyph.tsx`
  and the tooltip in `src/renderer/status-glyph-title.ts`. #74 originally
  mapped only the first five; routing those alone pushes an unmodelled reason
  into a narrower prop type (a tsc error) and drops the tooltip silently to the
  "Agent is idle" phrase.
- **Loop marker** — `Workspace.loopingSince` (persisted, orthogonal to `status`
  like `autoUnread`; full set/clear rules in its types.ts doc). `markLooping`
  (activity.ts, mirrors `markAutoUnread` incl. the explicit-`undefined`
  broadcast) is SET from the `pretool` case when `tool === 'ScheduleWakeup'`
  (the /loop skill re-arming — the one chokepoint both agent paths cross with
  the tool name), and CLEARED on `ScheduleWakeup({stop:true})` (SDK path only —
  agent-sdk.ts `emitFrom`, the spool hook line carries no tool input), on
  session `clear` (not `compact`), and in `reconcileExited` (process death
  kills the loop; checked BEFORE the `running` guard, since a looping agent is
  usually `idle` between wakeups).
  **The authoritative signal is level-triggered**: Claude Code's Stop /
  StopFailure payload carries `session_crons` — the CLI scheduler's own
  registry of pending ScheduleWakeup/CronCreate//loop wakeups (`[]` =
  definitively none). The spool hook (workspaces.ts `ORCHESTRA_HOOK_SCRIPT`)
  reduces it to a `crons` field on the spool line (`none`/`some`/`""`), and
  `applyAgentEvent`'s stop/stopfail case assigns the flag from it (before
  `fireFinished`, so toast suppression reads the fresh flag; `""`/absent = no
  opinion — old hook script or CLI). This is what makes the badge SELF-HEALING:
  a dynamic /loop that dies by simply not re-arming clears on that very
  turn-end, where the edge rules can't see "no call happened". `shouldHibernate` refuses a looping
  workspace — the sweeper would silently kill the loop (wakeups live inside the
  session process, and loop delays reach 60 min > the 30-min idle threshold).
  UI: a small cycle-arrows CORNER BADGE (`.ws-glyph-loop`, slow 4s spin,
  `currentColor` so it follows each state's hue) overlaid on every glyph shape
  by `WorkspaceStatusGlyph` (`looping` prop, passed by all five surfaces) —
  suppressed while hibernated; `statusGlyphTitle` appends "— looping".
  A looping row's turn-end still arms the BELL but skips the chime
  (App.tsx `onAgentFinished`) and the OS toast (`fireFinished`) — a 15-min
  loop would otherwise announce itself 4×/hour; a loop parked on a question
  (`fireNeedsInput`) still notifies.
  **Live detection is NOT sufficient**: Claude Code's daemon (CLI ≥2.1.233,
  `claude daemon run`) re-invokes /loop sessions at wakeup time OUTSIDE
  Orchestra — no `ORCHESTRA_WS_ID` (spool hook exits silently) and no attached
  SDK stream, so daemon-hosted iterations are invisible to both paths. The
  transcript is the ground truth that survives: `src/shared/loop-scan.ts`
  (pure `scanTranscriptTailForLoop`, 4-state verdict — looping / stopped /
  stale (armed but due+30min-slack passed = host dead) / unknown (bounded tail,
  clears NOTHING)) + `src/main/loop-scan.ts` (`startLoopScan` in index.ts:
  startup pass + 5-min sweep, stat-gated on transcript mtime; resolves the
  file via the pinned account's config dir + `mangleProjectDir` +
  `sdkSessionId`, falling back to newest `.jsonl`). The tail window is NOT
  fixed: `src/shared/tail-read.ts` (`readTailUntil`, node-testable) reads
  256 KiB chunks backwards until `"ScheduleWakeup"` is in the window (8 MiB
  cap) — a fixed window went permanently `unknown` once a chatty session
  pushed the deciding entry out of it, so a dead loop's badge could never
  clear. Backfills loops predating
  the flag and daemon ticks, clears self-stopped/dead loops. E2E gate:
  `scripts/verify-loop-badge-restore.mjs` (badge states incl. live spool
  detection, restart restore + its lingering-keeper negative control, and both
  transcript-backfill directions).
- **Keeper restart restore** — `restoreRunningFromKeeper` (activity.ts, beside
  `resumeRunning`): store.load() unconditionally floors persisted `running` →
  `idle` (its "no process survives a restart" comment predates the keeper), so
  a DETACHED keeper mid-turn showed a quiet row after relaunch until the user
  opened it (lazy attach is the only other path that re-asserts `running`).
  `reconcileKeepersAtStartup` (index.ts, the renamed orphan-keeper reap) probes
  each live keeper read-only (`probeKeeper` — never claims/attaches) and lifts
  `idle` → `running` only when `turnInFlight` (a lingering post-turn keeper
  stays idle), clearing a load-migrated bell and labeling the gap
  `THINKING_TOOL_LABEL`. The restored `running` resolves normally via the
  surviving spool's turn-end line (the startup wipe keeps live keepers' spool +
  cursor).

#### The three attention states (Orca parity)

"What the agent is doing" and "have I seen it" are TWO axes, because the second
is a property of the USER'S ATTENTION and must survive independently:

| State | Representation | Glyph |
|---|---|---|
| needs my input | `status: 'waiting'` | amber question mark |
| finished, not opened | `status: 'idle'` + `autoUnread` | amber filled bell |
| done, seen | `status: 'idle'` | green dot |

Glyphs match Orca's `StatusIndicator`/`WorktreeCardStatusSlot` one-for-one in
BOTH shape and colour:

| glyph | shape | token | = Tailwind |
|---|---|---|---|
| working | 2px ring, transparent top | `--glyph-working` | `yellow-500` |
| waiting | Lucide `MessageCircleQuestion` | `--glyph-attention` | `amber-500` |
| autoUnread | Orca's `FilledBellIcon` path | `--glyph-attention` | `amber-500` |
| idle | 8px dot (NOT a check) | `--glyph-done` | `emerald-500` |
| stopped/hibernated | 8px dot @ 40% | `--glyph-inactive` | `neutral-500` |

The four `--glyph-*` tokens are verbatim Tailwind v4.2.4 OKLCH defaults (the
version Orca pins), copied from its `theme.css`, not converted — verified
numerically against that file at build time. OKLCH is used as-is: confirmed
`CSS.supports` in this project's own Electron (Chromium 150).
- They are SEPARATE from `--green`/`--yellow`/`--red`, which have ~26 other
  consumers (diff gutters, chips, CI pills); repainting those to Orca's palette
  would restyle half the app rather than the status glyphs.
- The amber/yellow split is Orca's own — working ring `yellow-500` vs
  attention icons `amber-500` — so "busy" and "needs you" never read alike.
- `error` (red `circle-x`) has no Orca counterpart and keeps `--red`.
- `.ws-glyph-idle:not(.hibernated)` is load-bearing: a hibernated row reuses
  the idle glyph and must stay grey, not green.

`Workspace.autoUnread` (`types.ts`) is set by `fireFinished` when
`!(platform.isFocused() && getActiveWorkspaceId() === id)` — i.e. the turn ended
while the user was not looking at that workspace. Mirrors Orca's
`WorktreeMeta.isUnread` (set on completion when `!isVisibleForegroundPaneKey`,
cleared on interact — the "show until interact" model).
- Folding it into `status` is what made `waiting` ambiguous before: it meant
  BOTH "blocked on you" and "finished, unseen". `waiting` now means ONLY the
  first.
- The active-workspace pointer lives in `hibernation-activity.ts` (the
  dependency-free leaf) because `activity.ts` cannot import `hibernation.ts`
  without closing the activity → hibernation → pty → activity cycle. ONE
  variable, not a copy per consumer — two copies of "what is the user looking
  at" would drift invisibly.
- Cleared by `markSeen` (`api-handlers.ts`), which now also fires for an
  `autoUnread` row that is merely `idle` — the renderer's `setActive` gates on
  `status === 'waiting' || autoUnread`, else the bell would never clear.
  Written as an explicit `undefined`, never a dropped key: `workspace:update`
  is a MERGE, so an absent key means "no opinion" and leaves a stale bell.
- **Hibernation protection**: `shouldHibernate` (`shared/hibernation.ts`)
  refuses an `autoUnread` workspace. Those rows used to be `waiting` and were
  protected by the status gate; without this the sweeper would reap exactly the
  workspaces whose output the user has not read.
- `reconcileExited` resolves a dead PTY to `idle` + bell, never `waiting` — a
  dead process cannot answer, so `waiting` would park an unanswerable row in the
  inbox forever.
- Store load migrates a persisted `waiting` (written when it meant both) to
  `idle` + `autoUnread`: the claim still true either way is "there is unseen
  output here". Same hazard Orca names `restoredUnconfirmed`.
- `computeAttention` (`shared/attention.ts`) ranks the Needs-You inbox
  error > `waiting` > `autoUnread`, and counts a row that is both exactly once.
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
poll). Context tokens: `emitContext` `:590` / `computeContextTokens` `:523` reads
the transcript tail and sums `input + cache_creation + cache_read` on the last
non-sidechain assistant message. Since #15 this is the FALLBACK tier — a live
SDK session sources the structured view's gauge from `Query.getContextUsage()`
instead (`agent-sdk.ts sdkGetContextUsage`, see
`docs/codebase-map/structured-agent-view.md` § "Context gauge sourcing"); this
recompute still drives the sidebar badge and remains the only source for
detached/keeper/history/PTY sessions, which have no live Query to ask; a `compact_boundary` system entry newer than
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
- **The reader cursor's `lastSeq` PERSISTS across app runs** (`<wsid>.cursor`
  beside the spool, `{lastSeq}` written tmp+rename after each drained batch,
  reloaded when the in-memory cursor is first minted). This is the fix for
  "every notification triggers on reopen": the startup wipe KEEPS a live
  detached keeper's spool, the tailer re-reads it from offset 0, and the
  seq-dedup used to live only in memory — so every relaunch re-applied every
  kept line, and each replayed `stop`/`notify` re-fired its chime/OS toast for
  turns already seen before quitting. Only `lastSeq` is persisted (not the
  offset): a relaunch re-reads the file and dedups by seq, sidestepping
  offset-vs-rotation races at a cost bounded by ROTATE_BYTES. Lines a detached
  session wrote WHILE the app was closed sit above the persisted mark and
  still apply — and notify — exactly once. A missing/corrupt cursor degrades
  to one replay burst (pre-fix behavior), never a crash. Belt-and-braces in
  activity.ts: `fireFinished`/`fireNeedsInput` now gate ALL side effects (the
  unread bell, the chime broadcast, the OS toast) on `setStatus`'s `changed` —
  the broadcasts used to fire even for a redundant no-transition event, so
  any replayed line chimed regardless.
- `startEventsSpool(win)` `:235` **wipes the dir at startup** (any on-disk spool
  is stale; live status lives in store.json) — EXCEPT files belonging to a live
  detached keeper (`listLiveKeepers`), whose hooks are still appending; the
  wipe's extension regex covers `.jsonl`/`.jsonl.old`/`.seq`/`.cursor(.tmp)` so
  a kept workspace keeps its cursor too (dropping it would resurrect the
  replay bug for exactly the kept case). Then watches the dir + 1s
  safety-net poll. `stopEventsSpool` `:282`.
- **Multi-instance hazard:** dev + packaged instances must not share the events
  dir — the second instance's startup wipe would zero the first's spool. That's
  why `$ORCHESTRA_HOME` segregates dev. (Matches the known "stuck dot =
  shared events dir wiped by a 2nd instance" gotcha.)
- `events-spool.test.ts` replays the reader headlessly (a FAITHFUL COPY of
  `drain` incl. cursor persistence): normal turn ends `waiting`; mid-batch
  throw no longer strands `stop`; events seen while window absent replay once
  it returns; real hook under concurrency drops nothing; a kept spool replays
  NOTHING across a simulated relaunch while while-closed lines apply exactly
  once; a corrupt cursor degrades to one replay burst and self-repairs.

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
