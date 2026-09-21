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
| Frame protocol + shutdown policy | `src/shared/keeper-protocol.ts` (+ `.test.ts`) | Newline-JSON frames (`hello`/`probe`/`spawn`/`stdin`/`stdinEnd`/`kill` → `helloAck`/`stdout`/`exit`/`err`, b64 payloads), line splitter, and the PURE linger/wedge state machine (`createKeeperState`, time injected). |
| The daemon | `src/keeper/index.ts` → `dist-electron/keeper.js` (`vite.keeper.config.ts`, `build:keeper`) | Owns the CLI child; one claimed client at a time (`hello` claims + preempts — last wins; `probe` is read-only). Always drains stdout (discards while detached — the CLI's own transcript is the catch-up story). Only `stdinEnd`/`kill` terminate (EOF → 10s → SIGTERM → 5s → SIGKILL); a bare socket drop is a detach. Cleans `<wsId>.sock/.pid` and exits when the child dies. Integration-tested in `src/keeper/keeper.test.ts` against a fake CLI. |
| App-side client | `src/main/keeper-client.ts` | `installKeeper()` copies the bundle to `$ORCHESTRA_HOME/bin/keeper.js` at startup (a live keeper must not depend on the asar/AppImage mount after quit); `makeKeeperSpawn(wsId)` is the SDK `spawnClaudeCodeProcess` implementation (connect-or-launch behind a `SpawnedProcess` facade); `probeKeeper`/`killKeeper`/`listLiveKeepers`/`setAppQuitting`. Files live in `$ORCHESTRA_HOME/keepers/` (`<wsId>.sock/.pid/.log`). |

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
- **Explicit stops genuinely kill**: `sdkStop`'s live path rides the graceful
  close (interrupt → stdin EOF → keeper escalation — preserves the CLI's
  transcript flush); its NO-SESSION path calls `killKeeper(wsId)` — critical
  post-relaunch, where `/clear`, delete, archive, hibernate, branch switch and
  account migration must not leave an orphan CLI running a discarded
  conversation (`sdkStopIfLive` in sdk-delivery.ts therefore always calls
  `stop`, even with no live session).
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
- Startup: `installKeeper()` before the window; `reapOrphanKeepers()` AFTER
  `createMainWindow()` — the store loads in there, and reaping against an
  unloaded store kills every legitimate keeper (E2E-caught bug).
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
- **Gates.** Pure policy: `src/shared/session-wedge.test.ts` (backoff growth +
  ordering). Module end-to-end: `src/main/session-watchdog.test.ts` drives the
  R2 redelivery rig AND `scripts/wedge90-rigs/flap-budget.mjs` (14 real ticks:
  recycles at [0,2,6] gaps [2,4] widening, flap-limit surfaces at tick 7 →
  `watchdog:flap-limit` + `NOTIFY`; the pre-#97 build recycled [0,1,2] and never
  surfaced). Both rigs run through `scripts/.r2-register.mjs` because the module
  can't be imported bare under the strip-types runner (`./platform` dir-import).

## Kill/quit semantics

| Scenario | Outcome |
|---|---|
| App quit / crash | no-op `kill()` + socket drop = detach; turn keeps running |
| Explicit stop (interrupt/clear/rewind/archive/delete/hibernate/migrate/branch-switch) | graceful close → keeper escalation; `killKeeper` covers the no-session case → CLI + keeper die |
| Keeper crash | facade emits synthetic exit (−1) → consume() ledger close; resume-by-id recovers |
| CLI crash | attached: `exit` frame → existing error path; detached: keeper cleans up, relaunch resumes |
| Turn ends detached | linger → graceful exit; relaunch = plain resume + backfill |
| Workspace deleted while closed | startup orphan reap (+ linger bounds it anyway) |
| `orchestra restart` (issue #111, structured branch) | `sdkRestart(wsId,{fresh,trigger?})` in `agent-sdk.ts` — default = `sdkStop`→`killKeeper`→`ensureSession` (same teardown+respawn recipe as `sdkMcpRefresh`, resumes `sdkSessionId` → same transcript); `--fresh` = `sdkClear` (vierge). Composes existing exports only, no change to `sdkStop`/`consume` (issue #124 boundary). The CLI/socket wiring + PTY-mode branch live in `main/restart-workspace.ts` / `shared/restart-mode.ts` — see `hooks-cli-socket.md`. **#148: before tearing down, `sdkRestart` sets `session.restartRequested` (the intent marker) and records a `Workspace.sdkRestarts` entry, so the exit(-1) the teardown makes the keeper synthesize is rendered as a NEUTRAL restart row (not the red error box) both live and on backfill — see `structured-agent-view.md`.** **#179: the mid-turn refusal is now `decideRestartGuard` (`shared/resume-guard.ts`), not a bare `turnGate!==null` throw — a session that has never emitted a stream message (`firstMessageSeen===false`, a boot-wedged opening turn) is INTERRUPTIBLE: `sdkRestart` tears it down and redelivers the opening prompt via `recoverPendingPrompts` (the #174 seam, exactly once), converging instead of refusing forever (the field ~27s loop). A genuinely working session — `turnGate` held AND `firstMessageSeen===true` — is still politely refused.** |

### #178 — never-started restart starts FRESH (no phantom resume)

A `sdkSessionId` can outlive its transcript — MINTED by an earlier partial or by
`sdkWake` adoption, never by a boot-wedged session (which emits no `system/init`,
so consume() never reaches `persistSessionId`, agent-sdk.ts:~1185). Resuming such
a **phantom id** dead-ends the consume loop on `No conversation found with session
ID: <id>` (the field incident, ws 0c092cd5, once the wedged session died). The
reactive heal (`isBadResumeError`) only clears the id AFTER the failure. The
PROACTIVE fix (`shared/resume-guard.ts`) validates the resume target at every
seam BEFORE the launch:

- **(a) structured resume** — `ensureSessionInner` computes `resolveResumeId(ws.sdkSessionId, transcriptExistsFor)` (the ONLY `query({resume})`); a phantom id (no `.jsonl` on disk) or the `''` cleared marker → `undefined` → FRESH. The orchestrator-brief fresh gate keys on the resolved id too.
- **(b) terminal `--continue`** — both PTY launch sites (`startAgentPty`, the raw-PTY wake fallback) gate `resuming` on `shouldContinuePty({hasInput, fresh, newestTranscriptExists(ws)})`, not `hasInput` alone: a phantom terminal workspace `--continue`s into nothing (`No conversation found to continue`, exit 1) — start fresh instead.
- **(c) routing classifier** (`shared/restart-mode.ts`) — a phantom id stays `structured` DELIBERATELY: it decides the SURFACE, and the structured path (seam a) owns the fresh-start heal. Do NOT reroute a phantom here.
- **(d) `sdkWake` adoption** — already gates on `fs.existsSync(<id>.jsonl)`; it never mints a phantom. The reused precedent for (a).

The discriminator is transcript-exists (not the live `firstMessageSeen`, which is
unavailable at ensureSession time). Redelivery of the opening prompt on a
fresh-start always routes through `recoverPendingPrompts` (the #174 seam) — never
a parallel path. Guards: `shared/resume-guard.test.ts` (decision, both arms) +
`main/resume-guard-binding.test.ts` (each seam is wired).

Not covered while detached (by design): queued sends/`pendingLocalContext`
die with the app; permission prompts park in the CLI and redeliver on attach;
background-task cards / cost readouts rebuild or reset on reattach.
