# Detached session keeper

Structured (SDK) agent sessions SURVIVE Orchestra quitting: the `claude`
subprocess belongs not to Electron main but to a tiny detached daemon — the
**keeper** — that relays its stream-json stdio over a per-workspace unix
socket. Quitting the app just drops the socket (a *detach*); an in-flight turn
keeps running, and the next app launch transparently *reattaches*. Measured SDK
behavior backing the whole design: `docs/spikes/keeper-findings.md`. E2E gate:
`scripts/verify-keeper-detach.mjs` (13 checks: survive-quit, detached turn
completion, relaunch reattach + transcript, explicit-stop kill).

## Pieces

| Piece | File | Role |
|---|---|---|
| Frame protocol + shutdown policy | `src/shared/keeper-protocol.ts` (+ `.test.ts`) | Newline-JSON frames (`hello`/`probe`/`spawn`[+ optional `dockerRelay`, #291]/`stdin`/`stdinEnd`/`kill` → `helloAck`/`stdout`/`exit`/`err`, b64 payloads), line splitter, and the PURE linger/wedge state machine (`createKeeperState`, time injected). |
| The daemon | `src/keeper/index.ts` → `dist-electron/keeper.js` (`vite.keeper.config.ts`, `build:keeper`) | Owns the CLI child; one claimed client at a time (`hello` claims + preempts — last wins; `probe` is read-only). Always drains stdout (discards while detached — the CLI's own transcript is the catch-up story). Only `stdinEnd`/`kill` terminate — BOTH via the shared `escalateKill` helper (stdinEnd: EOF → 10s → SIGTERM → 5s → SIGKILL; a `kill` frame: its signal now → 5s → SIGKILL, audit D5 — a CLI that ignores SIGTERM is never left alive); a bare socket drop is a detach. Cleans `<wsId>.sock/.pid` and exits when the child dies — **only files it OWNS (#202)**: the pid file names the owner (`unlinkOwnedFiles`; sock `(ino,ctime)` fallback while no pid file exists), so a sibling that took the paths over is never orphaned. **Singleton start (#202):** bind FIRST — `EADDRINUSE` = someone owns the path; a live keeper answering a `probe` (3 tries to ride out a racing daemon's bind→listen gap — µs, no deterministic arm holds it open; an unanswered connect counts as live — fail closed, pinned by `daemon_refuses_hung`) → log + `exit(0)` touching NOTHING; only a provably stale socket is unlinked — UNDER an exclusive takeover claim (`<pidPath>.claim`, created atomically with its pid via tmp+`link`, `utimes` right before each `link` so its age counts from ACQUISITION; stale after 5 s / dead holder, broken by renaming it ASIDE and re-verifying what was moved), with a re-probe inside the claim, so two daemons racing over a stale socket end as ONE keeper (L1; `stale_two_launch`, 0/240 trials vs master ~85%); the pid file is written after bind via tmp+rename. Integration-tested in `src/keeper/keeper.test.ts` against a fake CLI. |
| App-side client | `src/main/keeper-client.ts` | `installKeeper()` copies the bundle to `$ORCHESTRA_HOME/bin/keeper.js` at startup (a live keeper must not depend on the asar/AppImage mount after quit); `makeKeeperSpawn(wsId)` is the SDK `spawnClaudeCodeProcess` implementation (connect-or-launch behind a `SpawnedProcess` facade); `probeKeeper`/`killKeeper`/`listLiveKeepers`/`setAppQuitting`. **#202:** `serializeKeeperOp(wsId, …)` runs the facade's connect-or-launch and `killKeeper` for ONE workspace strictly one at a time (N concurrent starts no longer each launch a daemon; a kill queued after a start kills it). `killKeeper(wsId, reason)` signals a pid-file pid ONLY when `keeperPidState` (argv read at signal time; `unknown` never signalled) says it is this workspace's keeper — a stale pid file after a reboot names a reused pid — and its post-kill `sweepStaleKeeperFiles` unlinks only files with no live owner (pid gone/other; nobody answering on the sock). The kill socket is dropped on the keeper's `exit` frame (was an idle 3 s close-wait per delete: single delete of a live keeper now ~130 ms) and the sweep never touches `<ws>.log` (L7). One log line per kill: `keeper[<ws>] killing keeper (… pid=<P>, reason=<r>)`. **Wedged keeper (review K4/D1):** before any signal `killKeeper` snapshots the keeper's `/proc` descendants (pid + start-time); ONLY if the kill frame is never processed (SIGSTOPped keeper) and it must SIGKILL the keeper after the grace does `killSurvivingDescendants` SIGKILL snapshot members that are still the SAME process (`isSameLiveProcess`: start-time equal, not a zombie; else the CLI is orphaned to init with no keeper root — nothing reaches it), one WARN each. A HEALTHY kill (restart / clear / MCP refresh) never touches the agent's background jobs (`k4_bg_restart_spares`); a DELETE does: `stopStructuredSession` snapshots the tree BEFORE `sdkStop` and `killKeeperTree`s it after (`k4_bg_delete_kills`); `sweepStaleKeeperFiles` also removes a crashed daemon's `<ws>.pid.claim` / `.claim.<pid>.tmp` / `.claim.stale.<pid>` when the pid they name is dead (D7; a live one is kept) and waits (≤500 ms) for a verifiably-dead owner's socket to stop answering (a dying thread group still holds its fds). **Delete race (A3 review F4):** `forbidKeeperLaunch(wsId)` (called first thing in `stopStructuredSession`) tombstones the workspace — the facade's serialized op then refuses (`workspace … was deleted — keeper start refused`), so a wake that raced the delete cannot launch a keeper nobody will kill. Files live in `$ORCHESTRA_HOME/keepers/` (`<wsId>.sock/.pid/.log`). The keeper's `.log` tees the child's *bare* stderr; `killKeeper` leaves it (L7) — only `listLiveKeepers` prunes a DEAD keeper's `.log` at startup; the verbose per-session `--debug-file` capture that OUTLIVES workspace deletion lives separately under `logs/sessions/` (#177 — see `activity-pty-terminal.md`). |

## The bridge facade (the load-bearing subtleties)

- **`kill()` is unconditionally a NO-OP.** sdk.mjs registers every spawned
  handle (custom spawns included) in a set SIGTERM'd from `process.on('exit')`
  — surviving that sweep IS the feature. Real termination authority is the
  keeper's stdinEnd escalation; explicit stops reach it via the SDK's graceful
  close (stdin end → `final()` → `stdinEnd` frame).
- **win32 caveat:** the same exit sweep calls `stdin.end()` instead of
  `kill()`, so the `stdinEnd` frame is gated on `setAppQuitting()` (set in
  `before-quit`/`window-all-closed`, index.ts) — quit means detach, never
  shutdown.
- One persistent frame router per socket, installed BEFORE `hello` — an
  attached CLI streams stdout the instant the claim lands, and flowing-mode
  data with no listener is silently LOST, not buffered.
- stdin writes buffer until the handshake completes; the SDK's initialize
  request simply arrives late (verified fine).
- On an `exit` frame the facade **destroys the socket** — the keeper only
  cleans up once its client disconnects, and holding the connection left a
  zombie keeper serving a dead child (caught by the E2E gate).
- Stale keeper (`helloAck.running === false` on an existing socket): kill it
  and launch fresh — a dead child slot is never reused (`spawn` on one is
  refused with `err: stale keeper`).
- **A DYING CLI is refused, not attached (audit D1, #124).** `helloAck`/probe
  carry **`shuttingDown`** (set the moment `beginShutdown`/a `kill` frame/linger
  escalation starts). A CLI mid-teardown still reads `running:true` until its
  `exit` lands, so the facade attach gate is
  `ack.running && ack.everStarted !== false && ack.shuttingDown !== true` — a
  `shuttingDown` keeper is treated exactly like stale (`killKeeper` + launch
  fresh). Symmetrically, a `stdin` frame that arrives while `shuttingDown` is
  answered with `{t:'err', msg:'shutting down'}` instead of being silently
  dropped — the old drop let a restart's wake prompt vanish into a keeper whose
  CLI then exited 0. Gates: `keeper.test.ts` (the DAEMON: probe-during-shutdown, stdin-err) and
  `pnpm run test:keeper-facade-restart` (the CLIENT decision — real `makeKeeperSpawn` against a real
  keeper, two-sided: refuses a shutting-down keeper → fresh pids, AND still attaches a healthy live one).

## Attach / lifecycle flow

- `ensureSession` (agent-sdk.ts) passes `spawnClaudeCodeProcess:
  makeKeeperSpawn(wsId)` for LOCAL sessions (sandbox/remote unchanged). The
  facade self-decides spawn-vs-attach via `helloAck.running`.
- **Reattach is lazy** (no mass resume at startup — index.ts philosophy):
  opening a workspace's structured view fires `agentSdkHistory`
  (api-handlers.ts) → `sdkAttachIfDetached(wsId)` (agent-sdk.ts) → probe →
  `ensureSession` attaches. The SDK's initialize handshake works mid-session
  and **redelivers parked canUseTool permission requests**; no
  `reinitialize()` needed (spike S3/S4). History backfill paints everything
  missed while detached; live events layer on top.
  Laziness has one status-side complement: `reconcileKeepersAtStartup`
  (index.ts — the orphan-keeper reap, extended) probes each live keeper
  READ-ONLY at launch and calls `restoreRunningFromKeeper` (activity.ts) when
  `turnInFlight`, because store.load() floors persisted `running` → `idle` and
  nothing else re-asserts it until the user opens the row. Probe ≠ attach: the
  probe frame never claims the client slot, so this restores the sidebar dot
  without violating no-mass-resume.
- **A hung CLI never parks a teardown** (2026-09-23): control requests to a CLI
  that stopped reading stdin never resolve (SDK `interrupt()` measured pending
  >40 s). `sdkStop` bounds `interrupt()` (`STOP_INTERRUPT_TIMEOUT_MS`, 5 s) and
  on timeout awaits `killKeeper`; `sdkRewind`/`sdkRewindPreview` bound
  `rewindFiles` (10 s / 5 s, files then reported unrestored). An explicit
  restart of a started turn silent ≥ `RESTART_STALL_MS` (2 min, `resume-guard.ts`
  verdict `'stalled'`) tears down and redelivers pending prompts instead of
  refusing. Gate: `pnpm run test:hung-cli` (`scripts/e2e-hung-cli-teardown.mjs`).
- **SessionStart hook events are not proof of life**: the SDK yields
  `system/hook_*` ~1 s before `system/init` (fresh and resumed). consume() sets
  `firstMessageSeen` only via `isProofOfLifeMessage` (`session-wedge.ts`) —
  counting hooks made the #174/#180 boot-wedge heal and #179 'fresh' restart
  unreachable in the field.
- **Network trouble is visible, not silent**: a sent turn with no proof of life
  for `BOOT_STALL_NOTICE_MS` (30 s) sets `Workspace.bootStallSince` (cleared with
  `null` on proof of life / teardown / store load) → `BootStallRow` above the
  composer (timer + Relancer) and `BootStallBadge` in the sidebar
  (`components/BootStall*.tsx`, copy in `shared/boot-stall.ts`). Watchdog
  recycles record `watchdog-boot`/`watchdog-stall` restarts (auto-restart row);
  the first `api_retry` of a sequence leaves a persistent warning notice.
  Pixels: `pnpm run test:network-visibility-shot` (needs RIG_WAYLAND).
- **Explicit stops genuinely kill**: `sdkStop`'s live path rides the graceful
  close (interrupt → stdin EOF → keeper escalation — preserves the CLI's
  transcript flush) for a session that has produced a `result` AND answered
  interrupt; its NO-SESSION path `await`s `killKeeper(wsId)` (audit D1: a
  fire-and-forget `void killKeeper` let an immediate restart race the dying
  keeper) — critical post-relaunch, where `/clear`, delete, archive, hibernate,
  branch switch and account migration must not leave an orphan CLI running a
  discarded conversation (`sdkStopIfLive` in sdk-delivery.ts therefore always
  calls `stop`, even with no live session).
- **Stop before the first `result` KILLS the CLI (audit D3, #124).** `Session`
  carries a latched **`sawResult`** flag (set in consume()'s `result` branch).
  The SDK ends stdin only after `waitForFirstResult()` resolves and `interrupt()`
  is unserviced before init completes, so a graceful `sdkStop` on a CLI that has
  never produced a `result` reaches the keeper with nothing (no `stdinEnd`, no
  `kill`) and the CLI would live on inside a since-removed worktree until its own
  ~600 s deadline (measured: 26/26 of the exit-1 cluster). `sdkStop` therefore
  `await`s `killKeeper` when `interruptHung || !sawResult` (latched before any
  await). Rig: `pnpm run test:keeper-stop-semantics` (`s3_noresult_kills` / `s3_result_no_kill` isolate the
  `!sawResult` clause with a fast-resolving interrupt; `stop_hung` in `test:hung-cli` covers the
  hung-interrupt clause).
- **A session's teardown removes ONLY itself (audit D2, #124).** consume()'s
  `finally` runs `sessions.delete`/`reconcileExited` only when
  `sessions.get(wsId) === session` — else A's unwinding loop would evict the
  SUCCESSOR B a stop→restart just registered (B keeps running but `sdkHasSession`
  reads false; peer deliveries return `'none'`). `sdkStop`'s OWN delete is identity-guarded the same way —
  it awaits `interrupt()`, and a peer delivery can register the successor in that window (rig arm
  `s2_sdkstop_only_self`).
- **A -1 preempt of a STOPPING session is labelled as the stop it is (audit D1,
  #124).** `classifyConsumeTermination` gains a `stopped` outcome, keyed on
  `preemptedWhileStopping` (`session.stopping && /exited with code -1/`) — a
  quiet "Session stopped" notice, never the red error box. Precedence:
  cleared → restarted → stopped → interrupted → error (a real crash of a live
  session leaves `stopping` false → error). Gates: `restart-notice.test.ts` (the pure decision) and
  `test:keeper-stop-semantics` `s1_stopped_label` / `s1_crash_still_errors` (the WIRING in consume()'s
  catch — a stopping session's -1 → quiet notice, a live session's -1 → still the red error).
- **Watchdog recycle awaits keeper death (audit D1, #124).** `recycleSession`
  (session-watchdog.ts) `await`s `killKeeper` after `sdkStop` before the
  redelivery/`sdkWake` spawns a replacement — a `sawResult`-true stalled session
  rides the graceful close and returns before the CLI exits, the 0.5–15 s window
  in which the old recycle's wake reattached to the dying CLI (13/13 field
  recycles). Belt-and-braces with the facade `shuttingDown` refusal above.
- **Parked inbox mail is re-driven at the turn boundary (audit D4, #124).** In
  consume()'s `result` branch, when `session.queue` is empty and
  `readInbox(wsId)` is non-empty, the FIRST block is released through
  `releaseInboxBlock` (the exactly-once path, the ONLY remover) — one block per
  boundary; the turn it starts produces its own `result` which re-drives the
  next. Fire-and-forget after `releaseTurnGate` (the gate is open). Closes the
  "not responding" where peer mail sat parked until the watchdog recycled a
  healthy idle session. ONE re-drive in flight at a time (`Session.inboxRedriveInFlight`; the
  delivery-start window leaves `queue.length` at 0, so a 2nd result would otherwise deliver the SAME block
  twice); the whole decision is the pure `shouldRedriveInbox` (session-wedge.ts) — keep it the ONLY
  copy of the guard (a duplicate pre-filter masked every mutant of it). Rig: `pnpm run test:inbox-redrive`
  (`in_window_double` pins the window open by re-registering the delivery seam with a latched
  `sendAwaitingStart` — `sendCalls` 1 fixed / 2 mutant).
- **Shutdown policy** (daemon-side, from the pure state machine): detached +
  turn complete (`"type":"result"` seen on stdout; `system` lines are neutral
  so an attach's fresh init doesn't hold an idle CLI) → linger 15 min
  (`ORCHESTRA_KEEPER_LINGER_MS`) then graceful exit — post-turn, resume-by-id
  makes a live process redundant, so idle `claude`s never accumulate. Detached
  + turn in flight + NO stdout for 2h (`ORCHESTRA_KEEPER_WEDGE_MS`) → wedge
  backstop (covers e.g. an in-flight browser-MCP call nobody can answer —
  spike S5: not redelivered on attach; `interrupt()` un-wedges). Detached +
  the session NEVER streamed turn activity (`everStarted` false) → **init
  grace** 10s (`ORCHESTRA_KEEPER_INIT_GRACE_MS`): a client death during
  session INIT (hooks/MCP handshake) orphans the init and wedges the CLI
  ~60s with the sent prompt stuck in ITS queue — reproduced from a real
  quit-right-after-send — and nothing pre-turn is worth keeping alive.
- **The quit-right-after-send window** (user-reported: empty view on reopen,
  prompt vanished, output later with no Working indicator) is closed by three
  cooperating pieces beyond the init grace:
  - `helloAck` carries **`everStarted`/`turnInFlight`** from the state
    machine. `sdkAttachIfDetached` REFUSES to attach to a never-started CLI —
    `await killKeeper(wsId)` (awaited: fire-and-forget once bridged a fresh
    query onto the dying keeper's SIGTERM'd child — "exited with code 143")
    then falls through to the recovery path; the facade's stale branch does
    the same. `killKeeper` resolves only once the keeper PROCESS is dead.
  - **`ws.sdkPendingPrompts`** (types.ts): every sent prompt persists until
    its turn's `result` (set in `sdkSend`, cleared in `consume()`).
    `recoverPendingPrompts` (agent-sdk.ts, called from the `agentSdkHistory`
    handler AFTER `sdkAttachIfDetached` so the resend can't race the attach)
    re-sends any entry the on-disk transcript lacks — the normal echo
    restores the bubble, `running`, and the status dot. Entries the
    transcript covers just clear (the turn ran, possibly detached).
    ⚠️ **Consumption is decided by IDENTITY, not by text (issue #57 fault a).**
    Entries are `PendingPrompt{id,key,text,peer?}` (`src/shared/pending-prompts.ts`),
    not bare strings, and `recoverPendingPrompts` compares `pendingPromptKey`
    against the keys of the backfilled transcript's user messages. The old
    predicate — `!userTexts.some((t) => t.includes(p))` — was unsound for
    INTER-AGENT messages: `sdkSend` stores the full `formatPeerMessage`
    envelope while the backfill strips the header and reply footer to render a
    compact peer row (issue #56), so the stored string is strictly LONGER than
    anything on disk and `includes()` was false **by construction**. Every
    reopen therefore re-sent an already-consumed message — the user-reported
    "same message queued 3 times" (measured: 421-char envelope → 255-char
    rendered body). `pendingPromptKey` normalizes BOTH sides to the inner body
    so the match survives that rewrite; legacy `string[]` stores migrate via
    `normalizePendingPrompts`.
    ⚠️ **`key` is a TRANSCRIPT-MATCHING key, not an identity — entries also
    carry a per-send `id`, and consumption is counted as a MULTISET**
    (`countConsumedKeys` + `filterUnconsumedPrompts`). Because the key is
    body-derived, two senders posting the same body share it; deciding
    consumption by set membership meant ONE consumed occurrence suppressed ALL
    such entries, so the second sender's message was silently LOST (measured:
    2 pending, 1 transcript occurrence, 0 recovered). Each occurrence now
    cancels at most ONE entry, restoring the ticket's required asymmetry — at
    worst re-send a message that ran, never swallow one that did not.
    Recovery now also re-sends **one turn per
    prompt, re-tagged with its original `PeerOrigin`** (it used to
    `missing.join('\n')`, fusing N orders from different senders into one
    untagged human-looking turn). Writes go through a per-workspace serialized
    chain (`appendPendingPrompt`/`clearPendingPrompts`/`mutatePendingPrompts`)
    because the old `void persistWorkspacePatch(...)` was a read-modify-write
    across an `await`: two concurrent sends both read the pre-append array and
    one entry was silently LOST (measured). Gates:
    `scripts/verify-peer-redelivery.mjs` (both arms, driving the REAL backfill
    over a real captured envelope) + `src/shared/pending-prompts.test.ts`.
    ⚠️ **"Absent from the transcript" does NOT mean "lost" — a prompt the LIVE
    session still holds is skipped (issue #112).** `recoverPendingPrompts` first
    calls `partitionLivePrompts(pending, livePromptIds(wsId))`
    (`agent-sdk.ts`); `livePromptIds` returns the uuids of `session.queue`
    entries **plus `session.gateTurnUuid`** (a yielded turn has left the queue
    but may not have flushed its user line yet), and an empty set when no
    session is live — which is exactly the quit case, so the guard costs that
    path nothing. Live entries are neither re-sent nor cleared:
    `keepOnlyPendingPrompts` writes them back, and the owning session clears
    them at its own turn boundary. **Why it matters:** the CLI writes a user
    line only once it STARTS the turn, and on a big repo (a 55 KB `CLAUDE.md`
    with 25 `@imports` + MCP handshakes) init takes tens of seconds — so a task
    sent 4 seconds ago is byte-for-byte indistinguishable from one lost to a
    quit. `startWorkspaceAgentHeadless` hits that window on EVERY spawn: it
    sends the task, then the renderer mounts the new workspace's
    `StructuredView` (panes mount for the whole LRU set, not just the active
    one) which calls `agentSdkHistory` → straight into here. Field log, 4s
    after the spawn: `re-sending 1 pending prompt(s) lost to a quit`. The
    spawned agent got its brief TWICE (issue #112: two PRs for one brief) and
    the clear destroyed the real insurance.
    ⚠️ **`PendingPrompt.id` IS the turn's `rewindId`** — the same uuid that
    becomes `SDKUserMessage.uuid` and therefore `session.queue[n].uuid`. That
    is what makes the live check an exact identity match instead of a body
    heuristic (two sends of the same brief, one live and one lost, separate
    correctly). Minting a fresh `randomUUID()` there silently disarms the whole
    guard — `livePromptIds` would match nothing, ever.
    ⚠️ **The turn-`result` clear in `consume()` is no longer blanket either**
    (same issue): it keeps entries whose turns are STILL in `session.queue`
    behind the one that just ended, which a full clear used to delete unrun.
    Gates: `src/main/spawn-prompt-duplication.test.ts` (12 tests — the pure
    decision executed, an explicit control reproducing the pre-fix
    misclassification, plus source assertions pinning all three wiring points;
    each verified to redden on its mutant) **and
    `scripts/e2e-spawn-prompt-duplication.mjs`**, which drives the REAL
    `sdkSend` + `recoverPendingPrompts` against a REAL store. Its `slow_init`
    arm is the discriminating one — MEASURED 3/3 deterministic: **2 deliveries
    unfixed, 1 fixed**. ⚠️ Two observables were VACUOUS first and are recorded
    in that file so they are not re-tried: counting prompts YIELDED to the SDK
    iterator (a duplicate parks at the turn gate and is never yielded) and
    counting `sdkPendingPrompts` (the resend re-appends, restoring the count).
    The sound observable is the `user-message` `agent:event` broadcast — the
    transcript bubble itself. The `exactly_once` arm passes on the unfixed code
    too (its turn completes before the pass can misjudge it) and is labelled
    non-discriminating in the file rather than counted as a gate.
  - **`session/attach`** (`AgentSessionAttachEvent`, types.ts): emitted from
    the keeper-spawn `onAttached` callback when a genuine mid-turn reattach
    happens; the fold flips `running`/`turnStartedAt` so the reattached turn
    shows the Working indicator instead of streaming into an "idle" pane.
    Maps to `submit` in `sdkEventToStatusEvent` (dot parity).
  - `ensureSession` is **start-coalesced** (`ensuring` map): a send racing
    the lazy reattach would otherwise pass the `sessions.get` check twice and
    spawn two rival query()/keeper clients.
- Startup: `installKeeper()` before the window; `reconcileKeepersAtStartup()` AFTER
  `createMainWindow()` — the store loads in there, and reaping against an
  unloaded store kills every legitimate keeper (E2E-caught bug). Its orphan/duplicate
  reap is `reapKeepersNow()` (resource-monitor.ts — store-loaded guard, identity
  re-verified, `resources.md`), never a bare `killKeeper` on `store.getWorkspace`.
  `startEventsSpool`'s wipe skips live keepers' spool files (events-spool.ts).

## Environment durability

`buildSdkEnv` freezes the child env at spawn, and the child now outlives the
app — two changes keep that env valid across restarts:

- **`getHookSocketPath()` is stable per ORCHESTRA_HOME** (hash of the home
  path, hooks-server.ts), not per-PID: `$ORCHESTRA_SOCK` frozen in a
  keeper-hosted CLI keeps resolving the CURRENT app instance (hooks hard-gate
  on the env var; the CLI prefers env over the pointer file). One binder per
  home is the single-instance lock's guarantee; dev/prod homes hash apart.
- `buildSdkEnv` deletes any inherited `ORCHESTRA_SOCK` before setting its own
  (same hygiene as `ORCHESTRA_WS_ID`).

## Self-healing watchdog (issue #90/#97)

A keeper-hosted session can WEDGE — stop starting turns while messages wait —
and every external probe still reads healthy (see the defect walkthrough atop
`src/shared/session-wedge.ts`). `src/main/session-watchdog.ts` treats it on one
main-side timer (`TICK_MS` = 60s, single-writer so N open windows don't act N
times).

- **Two independent layers per tick (`watchdogTick`).** Layer 1 force-releases a
  stranded turn gate (`decideGateRelease` → `sdkReleaseStrandedGate`) only when
  the SAME turn was seen silent across two ticks (`GATE_SILENCE_RELEASE_MS`, a
  10-min PROGRESS bound, not a duration cap). Layer 2 is a cause-agnostic
  recycle: `decideSessionRecycle` (fed #88's `workspaceQueueStall` verdict PLUS
  the destructive path's own `lastStreamAt` progress evidence, review R1) →
  `recycleSession` (`sdkStop` then `sdkWake` on the SAME conversation, parked
  mail re-driven via `releaseInboxBlock` exactly-once).
- **Layer 2b: the BOOT wedge (#174/#180).** `decideBootWedge` catches a session
  that accepted its opening turn but never emitted a stream message
  (`firstMessageSeen === false`) and has been silent since spawn — the shape
  layers 1/2 miss (nothing queued behind a started turn). Its verdict feeds the
  SAME `decideSessionRecycle` (`stalled ?? bootWedge`). The window is its OWN
  shorter constant `BOOT_SILENCE_MS` = 3 min (#180), passed as `silenceMs:` at the
  lone call site (`session-watchdog.ts` ~line 428) — NOT the 10-min default; layers
  1/2 keep the 10-min `GATE_SILENCE_RELEASE_MS`. Sized from #176 §4 (metarepo init
  2–6 s, worst legit silence 30 s MCP connect timeout, ≥6x margin). Progress bound
  is untouched: the first message resets `lastStreamAt`, so a slow-but-live boot is
  never restarted.
- **Anti-flap = COUNT + WIDENING BACKOFF (`session-wedge.ts`).**
  `MAX_RECYCLES_PER_HOUR` = 3 in `RECYCLE_WINDOW_MS` = 1h caps recycles;
  `recycleBackoffMs(n)` = `RECYCLE_BACKOFF_BASE_MS`·2^(n−1) (base 2 min, capped
  at `RECYCLE_BACKOFF_MAX_MS` 15 min) then spaces them so a session that
  re-wedges instantly can't burn its budget on consecutive ticks. The decision
  is a 4-way union: `none` / `recycle` / `backoff` (under budget, interval not
  elapsed — logged at info, no surface) / `flap-limit` (budget spent). Order in
  `decideSessionRecycle`: not-stalled/not-live → progress-refusal → flap ceiling
  → backoff → recycle. All thresholds are UNBASELINED, named constants.
- **flap-limit SURFACES to a human (`surfaceFlapLimit`, #97).** A log line is not
  a surface: it emits `platform.broadcast('watchdog:flap-limit', {workspaceId,
  recyclesInWindow, stalledForMin})` (in-app) AND `platform.notify({kind:
  'needsInput', …})` (OS toast, NOT focus-suppressed — this is the one watchdog
  outcome that genuinely needs a human, and #88's stall badge may be suppressed
  for the same ws). **Edge-triggered** (review F1): a `stoodDown` Set fires the
  surface ONCE on the transition into stand-down and clears when `inWindow`
  drops back below budget — the log line stays level-triggered, but a
  non-suppressed toast every 60s tick for the whole window would be a storm.
- **Layer 2b bound: BOOT-WEDGE gives up + ESCALATES (#197).** The #174/#180 heal
  restarts a never-started session on a FRESH start; when the fresh CLI re-wedges
  (heavy repo, same init that wedged it first), it looped forever with only the
  #97 flap-limit toast (no fleet-visible surface — field 2026-09-28 W6b, ~75 s ×
  5). Now `decideBootHeal({consecutiveFreshStarts})` (`session-wedge.ts`) caps at
  `MAX_BOOT_RESTARTS` = 3 (LEAD D2, ledger #198): the watchdog counts consecutive
  boot-wedge recycles in `bootRestartLedger` (`session-watchdog.ts`) and RESETS
  the count the instant the session shows PROOF OF LIFE (`firstMessageSeen`, via
  `clearBootHealState`) — so a session that recovers on restart k<N is never
  escalated. At the bound it STOPS restarting, marks the workspace visibly wedged
  (`Workspace.bootWedgedSince` — a distinct red `BootWedged*` surface beside the
  transient yellow `BootStall*`, both in `components/BootStall.tsx`/`BootStallView.tsx`,
  copy `shared/boot-stall.ts:bootWedgedCopy`), and emits ONE bus `escalation` row
  to the coordinator carrying restart count + last error + transcript size
  (`bootWedgeEscalationBody` in `shared/bus-liveness.ts`; `sdkTranscriptBytes` in
  `agent-sdk.ts`). The give-up is checked BEFORE the #90/#97 flap-limit dispatch
  DELIBERATELY (both bounds = 3 and count the same recycles, so the generic
  flap-limit would else win with only a toast). It reuses the app's own escalation
  path — the `escalation` kind + `send` verb (like `bus-liveness.ts writeEscalation`),
  SWITCH-GATED on the run's frozen `liveness` flag (fired ON, counted OFF), never a
  hand-written insert into `~/.orchestra/bus.sqlite`. Both are edge-triggered
  (`bootEscalated` Set) so the escalation + mark fire ONCE per wedge, cleared on
  proof of life. The wave-run resolver is injected at boot
  (`setBootWedgeRunResolver(resolveWaveRunId)`, index.ts) for the strip-types
  reason the liveness/wake rosters are.
- **Gates.** Pure policy: `src/shared/session-wedge.test.ts` (backoff growth +
  ordering; `decideBootHeal` bound + escalate-past-bound) and
  `src/shared/bus-liveness.test.ts` (`bootWedgeEscalationBody` carries count +
  last error + MB size). Module end-to-end: `src/main/session-watchdog.test.ts`
  drives the R2 redelivery rig AND `scripts/wedge90-rigs/flap-budget.mjs` (14 real
  ticks: recycles at [0,2,6] gaps [2,4] widening, flap-limit surfaces at tick 7 →
  `watchdog:flap-limit` + `NOTIFY`; the pre-#97 build recycled [0,1,2] and never
  surfaced). **#197: `src/main/boot-heal-bound.test.ts` drives
  `scripts/e2e-boot-heal-bound.mjs` — a faked-CLI boot-wedged session through the
  REAL `watchdogTick` over a REAL bus: `bounded` (3 restarts then ONE escalation,
  edge-triggered; ok:false on master — verified in a throwaway origin/master
  worktree), `recovers` (revive on restart k<N → never escalated), `reset` (proof
  of life clears the counter → a later episode escalates again).** All rigs run
  through `scripts/.r2-register.mjs` because the module can't be imported bare
  under the strip-types runner (`./platform` dir-import).

## One keeper per workspace (track A2, #201/#202/#203)

Ledger #224; rig `scripts/e2e-keeper-lifecycle.mjs` (wrapper `src/main/keeper-lifecycle.test.ts`,
`SUBJECT_REPO=<tree>` drives another tree — every arm marked `mustFailOnMaster` in the rig is RED on the pre-fix master). Field shape
(2026-09-28): two keepers 1.5 s apart for one workspace, each with its own CLI, then the exiting one
unlinked the shared sock/pid so the survivors were unreachable by `killKeeper`. Three cooperating fixes:
(1) client per-ws serialization + owned-only sweep (this file, Pieces), (2) daemon singleton start +
owned-only cleanup, (3) the reaper's duplicate pass (`resources.md`). The **tracked keeper** = the
pid-file keeper (written only by the keeper that owns the socket). Not pinned by a deterministic arm:
`listLiveKeepers` still prunes a stale pid file's sock unconditionally (microsecond window vs a successor's bind).

## Docker relay (#291, epic #284, ADR 0004 on branch `memory-guard`)

Behind the per-run **`docker_relay`** bus switch (frozen at run creation, default OFF — `bus.md`), a keeper hosts a unix-socket
Docker proxy and the member's CLI gets `DOCKER_HOST=unix://<keepers>/<ws>.docker.sock`. The relay forwards every call to the REAL
daemon socket and stamps `orchestra.ws` / `orchestra.run` (`src/shared/docker-labels.ts` — the frozen contract #292/#293 list
containers by) on every `POST /containers/create`: `docker run`, `docker compose`, client libraries. Ownership lives on the container.

| Piece | File | Role |
|---|---|---|
| Decision (app) | `src/main/docker-relay-switch.ts` `dockerRelaySpecFor(runId, remote)` ← `agent-sdk.ts ensureSessionInner` | Reads the run's FROZEN switch off the bus (down / no row ⇒ OFF); sandbox-hosted (`remote`) never; win32 never. Result rides the `spawn` frame as `dockerRelay: {runId}` (`makeKeeperSpawn`'s 3rd arg, `keeper-client.ts`). OFF ⇒ the frame and the CLI env are byte-identical to before. |
| Pure | `src/shared/docker-relay.ts` | `isContainerCreate`; `stampContainerCreateBody` (TEXTUAL JSON edit — parse/stringify would turn `9223372036854775807` into 2^63 and Docker would refuse the create; invalid UTF-8 / unknown shapes ⇒ forwarded untouched); `relaySocketPath` (`<ws>.docker.sock`, never `.pid`); `resolveRelayUpstream` (async; explicit `ORCHESTRA_DOCKER_SOCKET` → member `DOCKER_HOST` → `docker context inspect` → `/var/run/docker.sock`; a tcp/ssh endpoint or a missing socket ⇒ NO relay, never a silent redirect to the local daemon; an inherited RELAY `DOCKER_HOST` — `isRelaySocketPath`, any `*.docker.sock` — is ignored and hidden from the context lookup, else two relays stack and the outer one's labels overwrite the inner's). |
| Server | `src/keeper/docker-relay.ts` | node `http` server: normal calls re-framed per request (headers flushed at once, bodies piped — streams/chunked uploads fine); an `Upgrade` call (attach, exec start, buildkit `/grpc`+`/session`) replays its head to the daemon and becomes a RAW byte pipe. Create body buffered, stamped (ours appended LAST — a forged client `orchestra.ws` loses), `content-length` recomputed. Socket 0600; `maxHeaderSize` 1 MB (node's 16 KB default fails big `X-Registry-Config` calls that work without the relay); `keepAliveTimeout` 0. `superviseDockerRelay` restarts it when unhealthy (listener closed / socket file gone), backoff 1→30 s, never gives up. |
| Wiring | `src/keeper/index.ts` | `spawn` + `dockerRelay` ⇒ `withDockerRelay` (async: stdin/stdinEnd/kill frames arriving meanwhile are held in `deferredFrames` and replayed in order — NEVER dropped) → CLI env + `DOCKER_HOST` only when the relay is listening; any failure ⇒ env untouched (`docker relay disabled: <why>` in `<ws>.log`). `SIGUSR2` = "the relay crashed" (registered only when a relay exists; the supervisor brings it back). `cleanupAndExit` stops it. |
| Real-socket client | `src/main/docker-api.ts` | FI-1.2 (ledger #295): the APP's own client (list/inspect/stop/start/stats), real socket only — an inherited relay `DOCKER_HOST` is ignored. #292/#293 import it. |

Traps: (1) the relay is IN-PROCESS on purpose — a keeper is ~60 MB RSS, a child relay would double that per member; (2) libuv silently TRUNCATES an
over-long unix path and binds that — `createDockerRelay.bind` refuses > 107 bytes itself; (3) `listLiveKeepers` treats every `*.pid` as a workspace id, so the
relay has no pid file; its stale socket is swept with the keeper's (`sweepStaleKeeperFiles` / `listLiveKeepers`, `keeperRelaySocketPath`); (4) the run label is the
member's run AT SPAWN (like `$ORCHESTRA_RUN_ID`) — a reparent needs an `orchestra restart` to re-stamp; (5) `res.writeHead(code, undefined, headers)` DROPS the headers —
always pass a string reason phrase; (6) `docker context inspect` runs ASYNC (`execFile`): a sync exec stops the keeper answering probes while the CLI runs (the app's helloAck waits 3 s); (7) the unix-path limit is 107 bytes on Linux, 103 on macOS (`maxSocketPathBytes`) — a longer relay path ⇒ no relay, DOCKER_HOST unset. Gates: `src/shared/docker-relay.test.ts`, `src/keeper/docker-relay.test.ts` (fake daemon: stream flushed live, hijack both ways, 4 MB / chunked 3 MB, keep-alive create, supervisor + its no-supervisor control),
`src/keeper/keeper-docker-relay.test.ts` (built keeper: env OFF byte-identical, relay-can't-start ⇒ unset, SIGUSR2 restart, deferral order), `src/main/docker-relay-switch.test.ts` (real scratch bus, frozen ON/OFF),
`src/main/docker-api.test.ts`; HEAVY real-dockerd rig `scripts/e2e-docker-relay.sh` (9 arms; needs the heavy-rig token; `MUST_FAIL=1 KEEPER_JS=<master keeper bundle>` is the must-FAIL run) and `scripts/docker-relay-mutants.mjs` (46 in-place mutants, byte-exact restore + `cmp`; `--check` verifies anchors, `--rig` runs the rig-marked ones against real dockerd).

## Kill/quit semantics

| Scenario | Outcome |
|---|---|
| App quit / crash | no-op `kill()` + socket drop = detach; turn keeps running |
| Explicit stop (interrupt/clear/rewind/archive/delete/hibernate/migrate/branch-switch) | graceful close → keeper escalation; `killKeeper` covers the no-session case → CLI + keeper die |
| Keeper crash | facade emits synthetic exit (−1) → consume() ledger close; resume-by-id recovers |
| CLI crash | attached: `exit` frame → existing error path; detached: keeper cleans up, relaunch resumes |
| Turn ends detached | linger → graceful exit; relaunch = plain resume + backfill |
| Workspace deleted (app running) | `teardownWorkspace`/`pruneOrphanedWorkspaces` → `stopStructuredSession` (#201): session stopped + `killKeeper` awaited, files swept |
| Workspace deleted while closed / duplicate keepers | startup `reapKeepersNow` + the 60 s monitor sweep (#203; +linger bounds it anyway) |
| `orchestra restart` (issue #111, structured branch) | `sdkRestart(wsId,{fresh,trigger?})` in `agent-sdk.ts` — default = `sdkStop`→`killKeeper`→`ensureSession` (same teardown+respawn recipe as `sdkMcpRefresh`, resumes `sdkSessionId` → same transcript); `--fresh` = `sdkClear` (vierge). Composes existing exports only, no change to `sdkStop`/`consume` (issue #124 boundary). The CLI/socket wiring + PTY-mode branch live in `main/restart-workspace.ts` / `shared/restart-mode.ts` — see `hooks-cli-socket.md`. **#228: a stopped legacy terminal-only workspace (`hasInput`, no `sdkSessionId`) is NOT routed to `sdkRestart` directly (it would resume nothing) — the classifier's `wake` mode calls `sdkWakeRestart`, which runs `adoptTerminalTranscript` (shared with `sdkWake`) first, then `sdkRestart`.** **#148: before tearing down, `sdkRestart` sets `session.restartRequested` (the intent marker) and records a `Workspace.sdkRestarts` entry, so the exit(-1) the teardown makes the keeper synthesize is rendered as a NEUTRAL restart row (not the red error box) both live and on backfill — see `structured-agent-view.md`.** **#179: the mid-turn refusal is now `decideRestartGuard` (`shared/resume-guard.ts`), not a bare `turnGate!==null` throw — a session that has never emitted a stream message (`firstMessageSeen===false`, a boot-wedged opening turn) is INTERRUPTIBLE: `sdkRestart` tears it down and redelivers the opening prompt via `recoverPendingPrompts` (the #174 seam, exactly once), converging instead of refusing forever (the field ~27s loop). A genuinely working session — `turnGate` held AND `firstMessageSeen===true` — is still politely refused.** |

### #178 — never-started restart starts FRESH (no phantom resume)

A `sdkSessionId` can outlive its transcript — MINTED by an earlier partial or by
`sdkWake` adoption, never by a boot-wedged session (which emits no `system/init`,
so consume() never reaches `persistSessionId`, agent-sdk.ts:~1185). Resuming such
a **phantom id** dead-ends the consume loop on `No conversation found with session
ID: <id>` (the field incident, ws 0c092cd5, once the wedged session died). The
reactive heal (`isBadResumeError`) only clears the id AFTER the failure. The
PROACTIVE fix (`shared/resume-guard.ts`) validates the resume target at every
seam BEFORE the launch:

- **(a) structured resume** — `ensureSessionInner` computes `resolveResumeId(ws.sdkSessionId, id => remote ? true : transcriptExistsFor(ws, id))` (the ONLY `query({resume})`); a phantom LOCAL id (no `.jsonl` on disk) or the `''` cleared marker → `undefined` → FRESH. The orchestrator-brief fresh gate keys on the resolved id too. **REMOTE/SANDBOX (reviewer-restart F1) — DORMANT while sandbox agents are PAUSED (#226, see [sandbox-transport.md](sandbox-transport.md): `ensureSessionInner` refuses before this line, so `remote` is always false; restored with #220):** the transcript probe is a LOCAL-disk check — a sandbox session's transcript lives in the container, so probing local disk would always say "phantom" and silently discard the remote conversation. The probe returns `true` for `remote` (`ws.host?.kind === 'sandbox'`), so a real remote id resumes (trust it) while undefined/`''` still start fresh. The phantom dead-end this seam defends is LOCAL-only.
- **(b) terminal `--continue`** — the PTY launch site (`startAgentPty`; the raw-PTY wake fallback was removed, #227) gates `resuming` on `shouldContinuePty({hasInput, fresh, newestTranscriptExists(ws)})`, not `hasInput` alone: a phantom terminal workspace `--continue`s into nothing (`No conversation found to continue`, exit 1) — start fresh instead.
- **(c) routing classifier** (`shared/restart-mode.ts`) — a phantom id stays `structured` DELIBERATELY: it decides the SURFACE, and the structured path (seam a) owns the fresh-start heal. Do NOT reroute a phantom here.
- **(d) `sdkWake` adoption** — already gates on `fs.existsSync(<id>.jsonl)`; it never mints a phantom. The reused precedent for (a). Since #228 the body lives in `adoptTerminalTranscript` (agent-sdk.ts), shared by `sdkWake` and the legacy restart (`sdkWakeRestart`).

The discriminator is transcript-exists (not the live `firstMessageSeen`, which is
unavailable at ensureSession time). Redelivery of the opening prompt on a
fresh-start always routes through `recoverPendingPrompts` (the #174 seam) — never
a parallel path. `recoverPendingPrompts` is a thin COALESCING wrapper over
`recoverPendingPromptsInner` (reviewer-restart F3): the open path, the watchdog's
`recycleSession`, and the never-started restart can race the same recovery, so an
in-flight `Map<wsId, Promise>` dedups them (same idiom as `ensuring`) — no double
opening-prompt delivery. Guards: `shared/resume-guard.test.ts` (decision, both
arms + the remote composition) + `main/resume-guard-binding.test.ts` (each seam is
wired, incl. the remote-aware probe and the coalescing wrapper).

Not covered while detached (by design): queued sends/`pendingLocalContext`
die with the app; permission prompts park in the CLI and redeliver on attach;
background-task cards / cost readouts rebuild or reset on reattach.
