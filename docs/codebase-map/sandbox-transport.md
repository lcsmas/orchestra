# Multi-machine sandbox & transport

The remote-agent stack: a workspace's agent, git checkout and Claude session
live in ONE always-on Docker container; every Orchestra is a thin client
streaming the terminal over a single multiplexed WebSocket. Files:
`src/shared/sandbox-protocol.ts`, `src/main/transport/*`,
`src/main/sandbox-import.ts`, `sandbox/` (image + in-container shim), renderer
`host-grouping.ts` + `SandboxControlBar.tsx`. Feature history + open items:
`docs/multi-machine-sandbox-remaining.md`; manual verification:
`docs/sandbox-two-host-checklist.md`.

## Settled architecture (do not relitigate)
Central sandbox, thin clients. **File-sync was evaluated and REJECTED.** Local
node-pty stays the DEFAULT transport — a workspace is EITHER local OR
sandbox-hosted (`Workspace.host`, `types.ts:69`), never both. Reachability
(Tailscale, TLS) is baked into the endpoint URL and invisible to the protocol.
The shim has **no auth** — private networks only (documented in
`sandbox/README.md`).

## Transport seam — src/main/transport/
`pty.ts:21 createTransport(host, …)` picks the backend per session:
`host.kind==='sandbox'` → `getSandboxConnection(endpoint)` +
`createRemoteTransport`; else local node-pty. Everything above the seam
(`startPty` `pty.ts:169`, scrollback, IPC coalescing) is transport-agnostic.

| Piece | file:line | Purpose |
|---|---|---|
| `SessionTransport` / `TransportSpawnOptions` | `types.ts:49` / `:20` | The interface both backends implement (`pid` is undefined for remote). |
| `createLocalPtyTransport` | `local-pty.ts:50` | node-pty wrapped in the interface. |
| `createRemoteTransport` | `remote.ts:105` | One per session; maps write/resize/kill → frames, data/exit ← frames. Sends `spawn` eagerly. |
| `SandboxConnection` | `sandbox-connection.ts:90` | One per endpoint, shared by all its sessions (multiplex key = frame `session` = workspace id). Routes `data`/`exit` → registered `SessionSink`s, `event` → activity, `rpc` → hook dispatchers, `control` → ownership UI. |
| `EXIT_CONNECTION_LOST` | `sandbox-connection.ts:311` | −1 exit synthesized when a connection is abandoned. |
| `getSandboxConnection` | `sandbox-manager.ts:331` | Lazy, cached per endpoint; 10s dial timeout (`:211`). Sends `hello` after open. |
| `dispatchRpc` | `sandbox-manager.ts:77` | Mirrors hooks-server's route table (rename/spawn/peers/read/message) for remote agents. |
| `closeAllSandboxConnections` | `sandbox-manager.ts:384` | Shutdown; aborts reconnect loops. |

### Reconnect/backoff (item D)
An unexpected drop with live sessions does NOT unwind them: the connection
enters a **disconnected** state (`onDisconnect` handler,
`sandbox-connection.ts:85`) holding its sinks; `reconnectLoop`
(`sandbox-manager.ts:266`) redials with `reconnect-policy.ts` backoff
(1s→2s→…→30s cap, give-up after 3 min) and `attachSocket`
(`sandbox-connection.ts:128`) resumes the SAME transports on the fresh socket
(decoder reset; stale-socket events ignored). Terminals get yellow/green/red
link banners via `notifySessions` (`:146`). Give-up → `abandon()` (`:138`) →
the old EXIT_CONNECTION_LOST unwind. The entry's `ready` promise is swapped
during an outage so a spawn arriving mid-reconnect waits instead of writing
into the void. Deliberate `close()` always tears down (never looks like an
outage). The shim keeps PTYs running through all of it.

### Cross-machine ownership (item C)
Many machines attach; all stream every `data`/`exit`/`event`; exactly ONE — the
driver — may write. Brokered shim-side by the pure `DriveBroker`
(`sandbox/shim/shim-core.ts:110`): first `hello` wins (`:123`), `takeControl`
is an explicit take-over (`:141`), a reconnect bearing the driver's clientId
resumes its drive, driver detach promotes the longest-attached identified
client (`:159`), a lone legacy client adopts a vacant drive on first write
(`adoptIfVacant` `:150`). Frame gating in `shim.ts` `mayDrive` (`:462`) +
`onFrame` (`:473`); hook `rpc`s go to the driver only (`forwardRpc` `:348`).
Host identity = persisted per-install UUID (`sandbox-manager.ts:168`,
`userData/orchestra/client-id`; hostname is only the display name). `control`
broadcasts land in the renderer via `sandbox:control` push →
`SandboxControlBar.tsx` (amber "Read-only — X is driving" + Take control,
mounted above the pane row in `App.tsx` like SetupBanner).

## Wire protocol — src/shared/sandbox-protocol.ts
Length-prefixed (4-byte BE uint32 + UTF-8 JSON) frames over any byte stream;
`MAX_FRAME_BYTES` 16 MiB (`:39`). `encodeFrame` `:176`, streaming `FrameDecoder`
`:201`, discriminant guard `isFrame` `:267`. Client→sandbox: `hello`,
`takeControl`, `spawn`, `write`, `resize`, `kill`, `rpcReply`. Sandbox→client:
`data`, `exit`, `event`, `rpc`, `control`. A **byte-identical copy is vendored**
at `sandbox/shim/sandbox-protocol.ts` (the shim builds as a self-contained
Docker context); `sandbox/shim/sync-protocol.mjs` regenerates it and
`npm run check-protocol` is the drift gate. Provisioning deliberately rides
plain HTTP on the same port, NOT frames — no 16 MiB cap, no host→shim RPC
correlation machinery.

## The shim — sandbox/shim/ (in-container half of Orchestra)
`shim.ts` runs as the container's PID-1-ish process (image CMD) and does
in-container exactly what the app does locally: spawns the agent PTY on a
`spawn` frame (`startSession` `:143`; forces `ORCHESTRA_WS_ID`/`EVENTS_DIR`/
`SOCK` env), tails the activity spool → `event` frames (`drainSpool` `:281`, a
port of events-spool.ts via pure `parseSpoolChunk` `shim-core.ts:40`), and
serves the `$ORCHESTRA_SOCK` unix socket forwarding the five hook routes as
`rpc` frames (`startHookSocket` `:380`). One HTTP server on
`ORCHESTRA_SHIM_PORT` (default 8787) carries WS upgrades + the admin plane
(`startWsServer` `:538`): `GET /healthz`, `POST /import`, `GET /export`.
Sessions survive client detach — the whole point of the always-on sandbox.

## Provisioning: import / export / eject / backups
Payload grammar (both directions): tgz of `meta.json` + `repo.bundle`
(`git bundle --all`) + `worktree/` overlay (uncommitted modifications,
untracked-not-ignored files, and the gitignored `.orchestra`/`.claude` hook
dirs) + `claude-config/` (import only).

**Import (host → container), one-way with fail-safes:**
- Host `importWorkspaceToSandbox` — `sandbox-import.ts:188`. Quiesce PTYs →
  `stageImportPayload` (`:54`) → POST → **retire local worktree to
  `~/.orchestra/trash/<name>-<ts>`** (rename + `git worktree prune`; never
  `rm -rf` — gitignored files like `.env` survive) → flip record to
  `host:{kind:'sandbox'}` (+ `hasInput:false`; the conversation doesn't move)
  → immediate first backup.
- **Login/config ships with it**: `CLAUDE_CONFIG_ENTRIES`
  (`transport/import-core.ts:71` — credentials, `.claude.json` MCP registry,
  settings, CLAUDE.md, skills/agents/commands) packed from the pinned
  account's dir (or `~/.claude`), inheritance synced first; the shim seeds
  container `~/.claude` (+`~/.claude.json`) per-entry best-effort
  (`installClaudeConfig` `shim-import.ts:123`), creds chmod 600. Remote spawns
  **strip `CLAUDE_CONFIG_DIR`** (a host path would shadow the seeded login) —
  `workspaces.ts` startAgentPty.
- Shim `runImport` — `shim-import.ts:158`: clone bundle `--no-checkout` into
  the (empty) `/workspace`, checkout branch, repoint `origin`, overlay, seed
  config, persist an `ImportRecord` (`:90`). Failure wipes back to empty
  (retryable). **Idempotency:** host stamps `x-orchestra-session`
  (`IMPORT_SESSION_HEADER`, both `import-core.ts:84` and `shim-import.ts:353`);
  a provisioned shim replays 200 `{ok, alreadyProvisioned}` for a matching
  retry (lost-response case), 409 for rivals. One container = ONE workspace.
- Guards: `pruneOrphanedWorkspaces` and `deleteWorkspace` skip
  sandbox-hosted records (`workspaces.ts:572` / `:491`) — no local worktree to
  reconcile/reap; delete only detaches.

**Export / backups / eject (container → host):**
- Shim `runExport`/`createExportHandler` — `shim-import.ts:251`/`:297`.
- `backupSandboxWorkspace` — `sandbox-import.ts:339`: GET /export →
  `~/.orchestra/backups/<wsid>/backup-<ts>.tgz`, newest 5 kept. Runs right
  after import and on a 30-min timer (`startSandboxAutoBackup` `:370`,
  `ORCHESTRA_SANDBOX_BACKUP_MINUTES`).
- `ejectWorkspaceFromSandbox` — `sandbox-import.ts:397` ("Return to this
  machine"): export (saved as one more backup) → force-fetch bundle branch →
  recreate worktree at the ORIGINAL path when free (conversation continuity) →
  overlay → reinstall hooks → `host` back to local. Import is fully reversible.

## Image — sandbox/Dockerfile + README
`node:22-bookworm` + git/gh/psql/uv-python/bun/nvim + `claude` (native
installer) + the shim built in-image (node-pty compiles for the platform),
non-root `agent` (uid 1001), `WORKDIR /workspace`, `EXPOSE 8787`, **CMD runs
the shim** (always-on). Run with named volumes `-v sandbox-workspace:/workspace
-v sandbox-home:/home/agent` — container recreation otherwise destroys unpushed
work. Secrets contract: `docs/sandbox-env-contract.md` (never set
`ANTHROPIC_API_KEY` — it silently disables MCP connectors).

## IPC / UI surface
Handlers in `index.ts`: `workspaces:importToSandbox` `:643`,
`workspaces:ejectFromSandbox` `:647`, `sandbox:backup` `:651`,
`sandbox:controlState` `:655`, `sandbox:takeControl` `:661`; push channel
`sandbox:control`; `startSandboxAutoBackup()` at `:318`. Sidebar row actions:
☁↑ import (`Sidebar.tsx:800`, endpoint prompt via the `dialog.prompt` kind) and
☁↓ eject (`:823`) — one or the other by `w.host`. `host-grouping.ts`
`groupByHost` returns null when all-local so the flat sidebar path is
byte-identical to pre-feature.

## Tests
Unit: protocol 11 · shim-core (incl. DriveBroker) 20 · shim-import 12 ·
import-core 10 · reconnect-policy 6 · sandbox-connection lifecycle 22.
Integration (`sandbox/shim/`, chained by `npm run test:integration`, all also
green in-image): `integration.test.mjs` (PTY/spool/rpc over real sockets),
`import.integration.test.mjs` (+config seed, idempotent retry, rival 409),
`control.integration.test.mjs` (two clients: election, observer streaming,
gating, take-over, promotion), `roundtrip.integration.test.mjs` (file-level
fidelity of every file class through import→export→restore).
**`sandbox/app-e2e.mjs`** is the real-app battle test: launches the actual
built Electron (isolated `ORCHESTRA_HOME`) + a real `docker run` container and
drives create→import→agent-work→eject over CDP.

## Known gaps
No "Attach to sandbox" UI for a second machine (store.json hand-edit —
checklist step 3.1); shim unauthenticated (by design, private nets);
conversation history doesn't cross the wire; submodules not in `git bundle`;
stats polling logs noise against the retired local path.

Line numbers drift — verify against live source before relying on them.
