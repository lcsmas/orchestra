# Spike: detached session keeper — measured SDK behavior

Phase-0 spike for the detached session keeper (structured agents surviving app
close). Driver/prototype: `scripts/spike-keeper.mjs` (throwaway; keeper
prototype + scenario driver). SDK `@anthropic-ai/claude-agent-sdk` **0.3.216**
(claude CLI 2.1.216), Linux, node 22. Every scenario ran against the real
`claude` binary with `model: 'haiku'` turns.

## Scorecard

| # | Assertion | Result |
|---|---|---|
| S1 | `query()` + `spawnClaudeCodeProcess` returning a unix-socket-bridged `SpawnedProcess` facade completes a normal turn | **PASS** |
| S2 | Client process dies mid-turn (tool running) → keeper + CLI survive, turn completes fully detached | **PASS** — `detach-proof.txt` written by the tool ~20s after the client died; transcript JSONL written to completion on disk |
| S3 | Fresh `query({resume: id, spawnClaudeCodeProcess: attach})` against the already-running CLI | **PASS** — the SDK's initial `initialize` handshake succeeds against a mid-session CLI; a fresh `system/init` is emitted; a new turn runs. **`reinitialize()` is NOT required for plain attach.** |
| S4 | Parked `can_use_tool` (permissionMode `default`, Bash prompt) redelivered after detach → reattach | **PASS** — redelivered **automatically** on the initial attach handshake (before any explicit `reinitialize()`); approving ran the parked tool and completed the turn |
| S5 | In-process MCP (`createSdkMcpServer`) call in flight while detached | **Measured** (see below) |
| S6 | AppImage FUSE-unmount survival | **Deferred** to the E2E pass (needs a packaged build) |
| S7 | Prompt-generator end → SDK EOFs stdin → CLI exits gracefully | **PASS** — `stdinEnd` → child `exit code=0` ~500ms later; keeper cleaned socket + exited |
| S8 | `q.interrupt()` over the bridged transport mid-tool-turn | **PASS** — result `error_during_execution` ~4s after interrupt (matches the existing interrupt classification in consume()) |

## S5 detail — in-flight `mcp_message` across detach

- The pending tool call is **NOT redelivered** to the new client on attach, and
  **`reinitialize()` does not rescue it either** (resolved OK, turn stayed
  wedged; only `tool_progress` heartbeats flowed). This confirms the
  `reinitialize()` doc: it carries `can_use_tool` / `request_user_dialog`,
  not `mcp_message`.
- **`q.interrupt()` cleanly un-wedges** the stuck turn
  (`error_during_execution`), after which the session is fully healthy:
  a fresh turn calling the same in-process MCP tool routed to the NEW client's
  server and succeeded.
- Consequence for Orchestra: a browser-tool call in flight when the app closes
  wedges that turn until reattach + user interrupt (Esc) — or the keeper's
  detached wedge backstop. Fresh browser-tool calls after reattach work.
  Documented degradation, not a blocker (the browser pane can't exist without
  the app anyway).

## Load-bearing mechanics verified

- **The SDK's exit sweep is defeated by a no-op `kill()`.** sdk.mjs registers
  every spawned handle (custom-spawn included) in a module set SIGTERM'd from
  `process.on('exit')`. The facade's `kill()` being a no-op is sufficient on
  POSIX; the sweep fired visibly (`handle.kill(SIGTERM) — no-op`) in every
  detach scenario and the CLI survived. (win32 uses `stdin.end()` in the sweep
  instead — the real implementation gates the stdinEnd frame on an appQuitting
  flag there.)
- **`SpawnOptions.signal` is the graceful-close follower**, firing only after
  stdin-EOF + ~2s grace — safe to ignore in the facade; the keeper owns
  escalation.
- **Attach ordering:** the facade buffers stdin writes until the socket
  connect + `helloAck` completes, then flushes; the SDK tolerates this
  (its initialize request simply arrives late).
- **Transcript catch-up:** the CLI keeps writing
  `$CLAUDE_CONFIG_DIR/projects/<mangled-cwd>/<sessionId>.jsonl` while
  detached — the existing `sdkHistory` backfill covers everything missed.
- **Early-exit-at-attach error shape:** if the CLI exits right as a client
  attaches, the SDK surfaces a misleading "binary … failed to launch
  (musl/libc)" error. Probe (`helloAck.running`) before attaching rather than
  attaching blind.

## Follow-up (implementation phase)

The shipped implementation is documented in
`docs/codebase-map/session-keeper.md`; its end-to-end gate is
`scripts/verify-keeper-detach.mjs` (13 checks on the real built app — the run
that landed this feature passed 13/13, and along the way the gate caught two
real bugs: `reapOrphanKeepers` running before `store.load()` killed every
legitimate keeper at startup, and a client that held its socket after the
`exit` frame left a zombie keeper serving a dead child). S6 (AppImage FUSE
survival with the PATH-node runtime) remains open — it needs a packaged
AppImage host; the runtime-selection code path is in
`keeper-client.ts resolveKeeperRuntime` and degrades to current behavior when
no PATH node exists.
