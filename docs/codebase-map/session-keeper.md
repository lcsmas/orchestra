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

## Kill/quit semantics

| Scenario | Outcome |
|---|---|
| App quit / crash | no-op `kill()` + socket drop = detach; turn keeps running |
| Explicit stop (interrupt/clear/rewind/archive/delete/hibernate/migrate/branch-switch) | graceful close → keeper escalation; `killKeeper` covers the no-session case → CLI + keeper die |
| Keeper crash | facade emits synthetic exit (−1) → consume() ledger close; resume-by-id recovers |
| CLI crash | attached: `exit` frame → existing error path; detached: keeper cleans up, relaunch resumes |
| Turn ends detached | linger → graceful exit; relaunch = plain resume + backfill |
| Workspace deleted while closed | startup orphan reap (+ linger bounds it anyway) |

Not covered while detached (by design): queued sends/`pendingLocalContext`
die with the app; permission prompts park in the CLI and redeliver on attach;
background-task cards / cost readouts rebuild or reset on reattach.
