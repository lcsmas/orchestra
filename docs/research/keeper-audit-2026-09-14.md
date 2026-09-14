# Session keeper audit — 2026-09-14

Source at `8ea7b56` (v0.5.268, 0 behind origin/master); installed app 0.5.267;
CLI 2.1.270. Ground truth: 312 keeper logs in `~/.orchestra/keepers/`, the main
log `~/.orchestra/logs/orchestra.log` (since 2026-06-28), the orchestrator's
transcript, and the live process table. Every count below is from a command
recorded in the VERIFIED list at the end.

## Verdict

The keeper DAEMON (`src/keeper/index.ts`) holds its invariants in the field:
15/15 live keepers healthy, 0 orphan `claude` processes, 0 `uncaught`, linger ×68
and init-grace ×7 fired as designed, wedge backstop ×0. **The defects are in the
app-side stop→restart seam (`agent-sdk.ts` ↔ `keeper-client.ts`) and in what
happens to peer messages parked during a turn.** Four are confirmed from logs
(D1–D4), three are potential (D5–D7). The user-visible "session not responding"
maps to D4 (orchestrator idle with undelivered mail) followed by D1+D2 (the
automatic repair kills the healthy session and fails).

## D1 — A restart right after a graceful stop ATTACHES to the dying CLI

**Confirmed: 13/13 watchdog recycles since 2026-09-01 failed this way; the
watchdog has never succeeded once.**

Mechanism (per step, with anchors):

1. `sdkStop` (`agent-sdk.ts:4199`) lets the SDK end stdin → the facade sends
   `stdinEnd` → keeper begins EOF→SIGTERM→SIGKILL. `sessions.delete` runs at
   once; the CLI takes 0.5–15 s to actually exit (measured 775 ms at 14:34).
2. Any `ensureSession` in that window — `recycleSession` calls `sdkWake` 20 ms
   after `sdkStop` (`session-watchdog.ts:148,175`); also `sdkClear`→send,
   `sdkRewind`, a peer delivery — builds a new facade whose `hello`:
   - **preempts** the old socket (keeper `hello` = last wins) → the old
     facade's close handler (`keeper-client.ts:498`) emits synthetic exit −1 →
     consume() throws → a red `Claude Code process exited with code -1` row;
   - receives `helloAck{running:true, everStarted:true}` and **attaches**
     (`keeper-client.ts:545`) — the ack carries no `shuttingDown`, so a dying
     CLI is indistinguishable from a live one;
   - writes the wake prompt as a `stdin` frame, which the keeper **silently
     drops** while `shuttingDown` (`keeper/index.ts:231`);
   - the CLI then exits 0 → the new query's stream ends with no error.
3. The parked messages stay parked ("release … not delivered (none)").

Field trace (keeper log `36773f53`, main log, 2026-09-14):

```
14:34:09.907 main   session-watchdog: recycling wedged session ORCH — 2 parked
14:34:09.908 keeper shutdown: stdinEnd from client
14:34:09.956 keeper preempting previous client / client attached
14:34:09.958 main   consume loop errored: exited with code -1        (old session)
14:34:09.959 main   reattached to detached keeper session (cli pid=47575)  (new session → dying CLI)
14:34:10.215 main   inbox-tray: release for ORCH not delivered (none) — block left parked
14:34:10.683 keeper child exit code=0
```

Identical shape at 2026-09-01 18:57/20:12, 09-02 08:33/12:20/14:03, 09-07
18:37/20:28, 09-08 10:00/13:32, 09-09 17:42, 09-10 08:20, 09-14 14:34 (5
workspaces). The 6 keeper-log sequences `stdinEnd → preempting <50 ms later →
child exit 0` are the same events seen from the daemon side.

Same family, unawaited: `sdkStop`'s no-session path does `void killKeeper`
(`agent-sdk.ts:4208`), so `sdkClear` + an immediate send races the dying keeper
the same way. `sdkMcpRefresh` (`agent-sdk.ts:3869-3870`) is the ONE caller that
does it right: `await sdkStop` → `await killKeeper` → `ensureSession`.

Fix shape: (a) add `shuttingDown` to `helloAck`; the facade treats it as stale
(`await killKeeper` → launch fresh, never attach); (b) restart paths await
process death (`killKeeper` resolves only once the keeper pid is gone) — model
on `sdkMcpRefresh`; (c) the keeper answers a `stdin` frame during shutdown with
an `err` frame instead of dropping it. Gate: a test that stops then restarts
within 100 ms and asserts the wake prompt reaches a FRESH CLI.

## D2 — `consume()`'s `finally` deletes the SUCCESSOR session (delete by key)

**Confirmed by the `(none)` outcome on all 13 recycles.**

`agent-sdk.ts:1268` runs `sessions.delete(session.wsId)` — keyed on wsId, not
on identity. After `sdkStop` removed session A from the map, the restart
registers session B (`sessions.set`, `:1556`) while A's consume loop is still
alive (its CLI has not exited / its socket is about to be preempted). A's
`finally` then removes **B**. B's query and CLI keep running, but
`sdkHasSession` is false: peer deliveries return `'none'` (that is the only
way `sdkDeliverConfirmed` yields `'none'`, `sdk-delivery.ts:111`), the next user
send spawns a THIRD session whose hello preempts B (another −1 error row), and
`reconcileExited` (`:1277`) floors the dot. In the 14:34 trace, `(none)` is
logged 250 ms after B was registered and logged as reattached.

Fix: `if (sessions.get(session.wsId) === session) { sessions.delete(...);
reconcileExited(...) }`.

## D3 — `sdkStop` on a CLI that has not produced its first `result` does not stop it

**Confirmed: 26/26 of the 590–620 s exit-1 cluster are workspaces
deleted/hibernated 1–6 min after spawn; the CLI lived on inside the removed
worktree until its own ~600 s deadline.**

Mechanism: the SDK ends stdin only after the prompt iterator finishes AND
`waitForFirstResult()` (sdk.mjs `streamInput`: "Has bidirectional needs,
waiting for first result"); `interrupt()` is a control request the CLI does not
service before init completes; `transport.close()` uses `stdin.destroy()`
(no `_final` → no `stdinEnd` frame) plus `kill()`, which the facade
deliberately no-ops. So nothing reaches the keeper. `deleteWorkspace` proceeds
(`workspaces.ts:2498` → `sdkStopIfLive`), rm's the worktree under a live CLI,
and 602 s after spawn the CLI errors `Path … does not exist` and exits 1
(e.g. `00142567`: spawn 07:51:23, deleted 07:52:19, exit 1 08:01:26; five such
CLIs at once on 09-10 13:49, ~330 MB RSS each). The keeper logs show the client
attached the whole time and no `stdinEnd`.

Fix: delete/archive/hibernate/migrate/branch-switch paths `await killKeeper`
after `sdkStop` (as `sdkMcpRefresh` does); or `sdkStop` falls through to
`killKeeper` when the session has seen no `result` yet.

## D4 — Peer messages parked during a turn are never re-driven when the turn ends

**Confirmed: 25 `withdrew unstarted turn … after delivery timeout` for the
orchestrator today, all during working turns; 4 blocks (1351 B) still parked
in `~/.orchestra/inbox/36773f53-….txt` at 16:17.** This is the "not
responding" that peers and the human see on an orchestrator.

Mechanism: a peer delivery waits `DELIVERY_START_TIMEOUT_MS = 10 s`
(`sdk-delivery.ts:93`) for the turn to START; behind a running turn it never
does, so `dequeueUnstartedTurn` (`agent-sdk.ts:2441`) withdraws it and the
sender parks it in the durable inbox. The inbox is drained ONLY by the
`UserPromptSubmit` hook of a turn that starts — and nothing starts one when the
current turn ends. Watchdog layer 1 refuses (`queuedCount` is 0 after the
withdrawal); layer 2 is blind while `status === 'running'` and then, 15 min
after the turn ended normally (transcript: last `result` 14:19:54), "recycles"
an IDLE, healthy session — into D1/D2.

Fix: in `consume()`'s `result` branch, when the queue is empty and the inbox
holds blocks, release the first through `releaseInboxBlock` (the exactly-once
path) — re-drive at the turn boundary instead of waiting for the watchdog.

## Potential (not observed in the field)

- **D5 — `kill` frame has no SIGKILL escalation** (`keeper/index.ts:238`);
  `killKeeper`'s pid fallback SIGKILLs the KEEPER, which orphans a
  SIGTERM-ignoring CLI. 0 orphans measured today.
- **D6 — keeper `SIGTERM` handler kills the CLI instantly** (`:273`). `pkill -f
  orchestra` matches `~/.orchestra/bin/keeper.js` argv, so a manual kill-all
  defeats "survive quit" — 68 keeper SIGTERMs, clustered while the app was
  down (today 07:42 ×3, 10:26 ×3; no main-log line in either minute).
- **D7 — facade errors before `ready` (`helloAck timeout` 3 s, `keeper failed
  to start` 30 s) surface only as an `error` event on the handle; the SDK's
  handling of that after spawn is UNVERIFIED (0 / 2 field hits, outcome of the
  2 not traced).

## Not defects (checked)

Preempt/probe/detach/linger/init-grace/exit-frame semantics all match the doc;
`everStarted`-refuse + `killKeeper` awaited on reattach (15 hits, worked each
time); 0 `STRANDED turn gate` releases; 0 `helloAck timeout`; 0 `keeper connect
timeout`; 0 `uncaught` in keeper logs; `sessions.set` is coalesced by
`ensuring`. The 88 `exit code=1` are: 26 the D3 cluster, 36 immediate (0–1 s,
account migration / bad resume `No conversation found` ×2), rest turn errors
(usage limit) — none keeper-caused.

## VERIFIED (command → result)

- `git fetch && git rev-list --count HEAD..origin/master` → 0; `git log -1` → 8ea7b56.
- `ls ~/.orchestra/keepers | wc` → 312 logs / 15 pid / 15 sock; per-pid `kill -0` + `pgrep -P` → 15/15 keeper alive, 15/15 CLI child alive.
- `ps -eo pid,ppid,args | grep claude` → 15 CLIs, every parent is `keeper.js`; 0 with ppid 1.
- keeper-log event histogram (`grep -h '^\[keeper' *.log | sed … | sort | uniq -c`) → shutdown reasons 147 stdinEnd / 68 linger / 7 init-grace; 23 preempting; 6 escalate SIGTERM; 0 escalate SIGKILL; 0 uncaught.
- child exit codes → 159 ×0, 125 ×143, 88 ×1; spawn→exit-1 intervals → 36 ×0 s, 25 ×602–604 s, 1 ×458 s, tail.
- 602 s cluster ↔ `deleting workspace|hibernat` same day in main log → 26/26 matched (python over both logs).
- main log counts → `recycling wedged session` 13; `not delivered (none)` 13; `reattached to detached keeper` 140; `never-started CLI` 15; `STRANDED` 0; `helloAck timeout` 0; `keeper failed to start` 2; `consume loop errored` 186 (`code -1` on 5 workspaces).
- 14:34:09 trace: `grep -n 'recycling wedged' | sed -n` on main log + `grep '^\[keeper 2026-09-14' 36773f53….log`.
- ORCH transcript `~/.claude-mc/projects/…36773f53/e0fdcc86….jsonl` → 1766 rows today; last rows 14:19:36 tool_result → 14:19:54 assistant text + system (turn ended); nothing 14:19:54→14:34.
- `ls -la ~/.orchestra/inbox/36773f53*` → 1351 B, 4 blocks, mtime 16:17.
- sdk.mjs (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`, 1.3 MB): `getProcessExitError` throws only for `code !== 0 && !== null`; `streamInput` waits for first result before `transport.endInput()`; `close()` = `stdin.destroy()` + `process.kill(-pid,'SIGKILL')`.
- `DELIVERY_START_TIMEOUT_MS` → 10_000 (`sdk-delivery.ts:93`); `GATE_SILENCE_RELEASE_MS` → 10 min; `MAX_RECYCLES_PER_HOUR` → 3.

## NOT VERIFIED

- That the SDK closes the query on a handle `error` emitted after spawn (D7) — read from minified source, not driven.
- Why the two orchestrator CLIs spawned 07:35:40 and 07:38:17 never started within 149 s / 71 s (everStarted false; keeper stderr empty; the 07:44:56 spawn started in <4 s). Account migration A→B→A at 07:25/07:34 and "8 selected MCP servers not defined" are adjacent, not causal.
- The 3+3 keeper SIGTERMs at 07:42 and 10:26 being a manual `pkill` — inferred from app-down + same-second clustering only.
- Any fix — none implemented; every fix shape above is a hypothesis until its gate reddens on current code.
