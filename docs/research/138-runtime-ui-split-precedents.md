# Runtime / UI split precedents: launch, attach, single-instance, version skew

**Verdict: orca does NOT run "an app attached to a daemon". It runs ONE runtime per profile, and three interchangeable hosts compete for it (desktop Electron main, windowless `electron --serve`, plain-Node `orcad`). They share one exclusive file lock: the loser refuses (exit 3), and a supervised service waits in standby until the lock frees. The UI speaks the same RPC contract over IPC (local) or WebSocket (remote). Terminals live in a separate daemon, versioned per protocol, that outlives every handover between hosts. Skew is handled with protocol-integer ranges plus capability lists, never equal app versions. Only the lock holder migrates the store, and the CLI never opens SQLite. For #140 this means: run app and hostd as exclusive alternates behind one lock, not as two writers. A "shadow" daemon has no orca precedent, so it would have to be strictly read-only.**

Written 2026-10-25 for [#138](https://github.com/lcsmas/orchestra/issues/138) (map [#136](https://github.com/lcsmas/orchestra/issues/136), feeds decision [#140](https://github.com/lcsmas/orchestra/issues/140)). Builds on, does not repeat, `origin/research/orca-substrate-round2:docs/research/orca-substrate-round2.md` (wake mechanism, schema SQL, federation). That doc read orca @ `1fafccb2` and described the runtime as "Electron main". At the sha below that is only one of three hosts (§1.1).

Tags: **VERIFIED** = read in source at the pinned sha this session. **INFERRED** = my reasoning, not a citation. **UNVERIFIED** = not read. Nothing was built or executed. All repos were cloned shallow into a scratch dir and read with grep/sed only.

| Repo | Pinned sha | Read |
|---|---|---|
| `stablyai/orca` (MIT, Lovecast Inc.) | `92fd257bd96f8ee05f14cd2d7fbf95b2cf067a28` | CLI runtime client, serve/orcad, instance lock, terminal daemon, renderer stream client, profile/orchestration DB migration |
| `tailscale/tailscale` | `a1e51f4942dac054e67c1b32049d16058248ce80` | `tailscaled.service`, `safesocket`, LocalAPI client, IPN bus, Linux systray |
| `tmux/tmux` | `acee541d6ec53127ee34488a281e0b205890ef91` | `client.c`, `server.c`, `proc.c`, `compat/systemd.c` |
| `microsoft/vscode` (sparse: `src/vs/server`, `src/vs/platform/remote/common`) | `471b308a3d5dc85f7a582a993528c93e02939c90` | remote agent server handshake, reconnection, lifetime |
| Orchestra | `276cd058` (origin/master was 3 commits ahead at writing, all unrelated: session-budget, docs, version bump) | `src/main/index.ts`, `hooks-server.ts`, `bus.ts`, `cli/index.ts`, `shared/keeper-protocol.ts` |

Paths below are relative to each repo root.

---

## 1. orca

### 1.1 Launch: three hosts, one runtime

- **VERIFIED. `orca serve` is the windowless runtime.** It is "Start an Orca runtime server without opening a desktop window" (`src/cli/specs/serve.ts:7`). It runs in the foreground (`:26`). It exits **3** "when another Orca already serves this profile or cannot be shown to have stopped" (`:33`).
- **VERIFIED. Two headless backends.** `serveOnce` picks one (`src/cli/runtime/launch.ts:160-202`):
  - `orcad` is the default (`src/shared/orcad-local-serve-selection.ts:2-4`). It is a plain pinned Node process. The CLI does not decide the backend: it runs an app-side selection entry under `ELECTRON_RUN_AS_NODE` and parses one stdout line (`src/cli/runtime/serve-orcad-launch.ts:1,21-60`).
  - Electron `--serve` is the same app binary, spawned with `--serve` plus headless ozone switches (`launch.ts:218-232`). Packaged macOS stays on Electron "because orcad has no app updater" (`serve-orcad-launch.ts:30-37`).
- **VERIFIED. orcad runs the same runtime code as the desktop.** `orcad-entry.ts:90` imports `OrcaRuntimeService`, `:198` constructs it, and `:299` constructs `OrcaRuntimeRpcServer`. The host is swappable and the runtime is not forked.
- **VERIFIED. Service install = systemd user unit / LaunchAgent.**
  - `orca serve service install` writes a unit running `orca serve --supervise --no-pairing` (`serve.ts:62-75`).
  - The unit (`src/cli/runtime/serve-service-unit.ts:150-164`) sets `Type=simple`, `Restart=on-failure`, `RestartSec=10`, `StartLimitIntervalSec=900`/`StartLimitBurst=5`, `TimeoutStopSec=90`, **`KillMode=process`** and `WantedBy=default.target`.
  - Uninstall "stops the service … The terminal daemon and its sessions keep running" (`serve.ts:93`).
  - On Linux the service stops at logout unless `loginctl enable-linger` is on (`serve.ts:70`).
- **VERIFIED. The supervisor sits inside the CLI, not in systemd alone.**
  - `--supervise` restarts with growing delays. It gives up after 6 failures in 15 min (`src/cli/runtime/serve-supervisor-brake.ts:4,6`; `serve.ts:36`), then exits 0 "so the manager stops too".
  - Exit 3 (profile occupied) means **standby, not a failure**: "An occupied profile warrants standby, not a crash-brake failure" (`src/cli/runtime/serve-supervised-service.ts:271-279`).
  - Configuration refusals get distinct exit codes "so supervisors cannot restart-spin on them" (`src/main/orcad/main.ts:33-37`). A macOS startup abort parks for 30 min with exit 78 (`src/shared/serve-abort-park.ts:8`; `serve.ts:35`).
- **VERIFIED. The CLI never starts a runtime on demand.**
  - A normal call reads `orca-runtime.json` and fails with "Start the Orca app first" when it is missing (`src/cli/runtime/metadata.ts:11-31`).
  - Only `orca open` launches anything (`src/cli/handlers/core.ts:82-84` → `client.ts:279-310` → `launchOrcaApp`, a detached spawn, `launch.ts:60-127`). It then polls `status.get` every 250 ms for up to 15 s.
- **VERIFIED. On-demand launch exists only for REMOTE hosts.** orcad launched by a client over SSH ("managed") is the only kind that idles out (`src/main/orcad/orcad-managed-idle-exit.ts:18-30`). The timeout is 15 min (`src/shared/orcad-idle-exit.ts:6`), and live terminals block idle exit (`orcad-managed-idle-exit.ts:1`). A user-started or paired server "never idle[s] out".

### 1.2 Single instance, stale lock, stale socket

- **VERIFIED. One lock file shared by desktop and orcad.**
  - `orcad.lock` sits in the profile dir (`src/main/orcad/orcad-instance-lock.ts:38`). It is taken "before profile load to prevent concurrent writers" (`:1`; `orcad-lifecycle.ts:130`).
  - The desktop takes the SAME lock with `role: 'desktop'` (`src/main/startup/desktop-profile-instance-lock.ts:17-18`). Its header states the reason: "Electron's own instance lock cannot fence plain Node" (`:1`).
  - orcad's launcher sets the desktop profile so "its instance lock makes the two refuse each other" (`serve-orcad-launch.ts:82-83`).
- **VERIFIED. The desktop refuses to start while orcad holds the profile.** It does not attach to it. `acquireDesktopProfileLockOrExplain` returns false and exits with the single-instance code after an error box (`src/main/startup/main-process-preflight-failure.ts:8-19,36-44`).
- **VERIFIED. Lock record and stale rules.**
  - The record holds pid, start-time / Linux start ticks, bootId, uid identity, version, nonce, role, machineIdentity and host (`orcad-instance-lock.ts:42-59`).
  - Publication is atomic: the record is written to a staged file, then hard-`link`ed onto the lock path. `EEXIST` means held (`:160-178`).
  - Reclaim happens only when the holder is proven dead or a different incarnation (`:250-265`).
  - Refusals:
    - an unreadable or oversized lock: "Refusing to reclaim it without proof that its holder has exited" (`:205-214`);
    - a torn record: reclaimable only after a 10 s grace (`:39-40,216-226`);
    - a foreign uid (`:227-234`);
    - a holder on an unverifiable machine, such as a network home (`:235-249`);
    - a live pid with no bootId, i.e. possibly reused (`:253-255,268-284`).
  - Release re-reads the record and unlinks only when its nonce matches, "so a successor's live runtime cannot be unlocked" (`:298-319`).
  - Manual escape hatch: `orca serve --reclaim-stale-lock [--yes]` (`serve.ts:34`).
- **VERIFIED. Electron's `requestSingleInstanceLock` is kept as a second fence.** A duplicate `--serve` launch must not activate the desktop (`src/main/startup/single-instance-lock.ts:13-28`).
- **VERIFIED. The runtime socket name is unique per pid. Discovery goes through a metadata file.**
  - The socket is `o-<pid>-<suffix>.sock` (`src/main/runtime/runtime-rpc/runtime-rpc-socket-metadata.ts:5-6,58-61`).
  - At start, sockets of dead pids are swept. `ESRCH` means dead; `EPERM` means foreign and is left alone (`:8-42`).
  - Endpoints plus the auth token are published in `orca-runtime.json` (`src/shared/runtime-bootstrap.ts:17-23,42-46`). If publishing fails, the transports close "rather than serve invisibly" (`runtime-rpc-lifecycle.ts:131-137`).
  - A watch republishes the metadata if another process clobbers it (`:140-157`).
- **VERIFIED. The terminal daemon's socket name is STABLE per protocol version, and it has an ownership protocol.**
  - `src/main/daemon/AGENTS.md:8-11`: "Only a daemon publishing itself onto the canonical endpoint may mutate that directory entry … No actor removes a name it did not create."
  - The protocol (`:20-22`): bind a private name → exclusive `link` → on `EEXIST` prove the incumbent dead by connecting → re-check → `rename`.
  - Traps it records:
    - "Never collapse 'can't tell' into 'dead'" (a timeout or `EPERM` proves nothing) (`:26-28`);
    - "Do not add a sweeper" (`:39-41`);
    - "Never remove the endpoint on shutdown" (`:45-46`).
  - Origin of the protocol: `net.Server.close()` unlinked a live replacement's socket (`:13-18`).

### 1.3 Attach: how a UI and the CLI reach the runtime

- **VERIFIED. CLI → runtime: one NDJSON request per Unix-socket connection, with a token from the metadata file.** It connects per request (`src/cli/runtime/transport.ts:39`). A clean close with no frame is an error, not a wait (`:84-95`). Waits (`check --wait`, `terminal.wait`) are long-polls with a client grace (`src/cli/runtime/client.ts:187-211`).
- **VERIFIED. The CLI's liveness verdict uses metadata plus a probe.**
  - No metadata → `not_running`.
  - Metadata present but socket unreachable → pid-probe: alive = `starting`, dead = `stale_bootstrap` (`src/cli/runtime/status.ts:18-36,70-90`).
  - Only `ESRCH` proves absence (`src/cli/runtime/runtime-pid-liveness.ts:1-12`).
- **VERIFIED. The renderer is a client of the same RPC dispatcher, whatever the transport.**
  - Local: IPC `runtime:call` / `runtime:subscribe` dispatch into `RpcDispatcher({ runtime, methods: ALL_RPC_METHODS })` (`src/main/ipc/runtime.ts:76,94-132`).
  - Remote ("paired runtime environment"): the same method goes over WebSocket (`src/renderer/src/runtime/runtime-rpc-subscribe.ts:14-41`, `target.kind === 'local'` → `window.api.runtime.subscribe`, else `subscribeRuntimeEnvironment`).
- **VERIFIED. Push model: snapshot first, then deltas with epoch + seq, and resync on any gap.**
  - `runtime-layout-client.ts:1` describes "One transport-neutral layout.subscribe client for local/paired main".
  - The behaviour (`:24-36,150-173`):
    - the first frame is a snapshot;
    - a delta from another epoch or out of sequence makes the client resubscribe at once, within a budget of 3;
    - a lost stream reopens after 1 s, doubling to a 30 s cap, and its snapshot replaces the cache.
  - `method_not_found` / `forbidden` are treated as refusals that a retry cannot fix (`:20-21`).
  - Other streams: `terminal.subscribe`, `agentSession.subscribe`, `accounts.subscribe`, `notifications.subscribe`, `files.watch` (method names grepped across `src/main/runtime`, `src/shared`).
- **VERIFIED. A headless Electron serve can be promoted into a desktop in-process.**
  - `orca open` against a running serve opens a window in that same process. The second Electron instance hands over through `second-instance` (`single-instance-lock.ts:23-26`).
  - `desktopWindowStatus` reports `available` / `openable` / `blocked` (`src/main/startup/main-process-runtime-service.ts:50-57`; `client.ts:285-309`).
  - Promotion fails closed "unless daemon-backed PTYs can survive desktop promotion and renderer reattachment" (`src/main/startup/serve-desktop-activation.ts:14-24`).
- **UNVERIFIED.** Whether the desktop can attach to a *local* orcad as a paired environment. I found no such path. The desktop refuses on the held lock (above), and pairing appears to target remote hosts. Absence is claimed only for the files read.

### 1.4 Version skew and migration ownership

- **VERIFIED. Runtime protocol: ranges, never equality.**
  - `src/shared/protocol-version.ts:37-43`: "Runtime protocol ranges permit app-version drift across desktop/server/CLI/mobile … Raise minimum client/server versions to refuse unsupported peers; never require equal app versions." Values: `RUNTIME_PROTOCOL_VERSION = 3`, `MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION = 2`, `MIN_COMPATIBLE_RUNTIME_SERVER_VERSION = 2`.
  - Bump rule (`:37-38`): removed methods, required params, changed meaning, framing or auth. Optional fields and new methods are additive.
  - `evaluateRuntimeCompat` returns `client-too-old` / `server-too-old` with an explicit "Update Orca" message. A missing version counts as protocol 0 (`src/shared/protocol-compat.ts:18-58`).
  - The check runs on the first remote call through a `status.get` preflight (`src/cli/runtime/remote-runtime-compat-gate.ts:29-78`).
- **VERIFIED. Capabilities gate features.** Before any orchestration mutation, the CLI checks that the runtime advertises the orchestration-contract capability. Otherwise it throws `orchestration_migration_required`: "No effects were applied" (`client.ts:252-277`).
- **VERIFIED. Runtime-source fence.** A terminal launched by runtime X refuses to send mutations to a runtime from another install/profile. The check compares `hostDescriptor.installationId` and allows new incarnations of the same source (`src/cli/runtime/runtime-source-fence.ts:27-76`).
- **VERIFIED. The terminal daemon is versioned by socket name, so old daemons keep serving.**
  - Endpoints are `daemon-v<N>.sock` / `.pid` / `.token` (`src/main/daemon/daemon-spawner.ts:122-140`).
  - "daemons survive app updates, so wire behavior must be version-gated" (`daemon-protocol-version.ts:1`). `PROTOCOL_VERSION = 51` (`:12`), and the list of previous versions runs 1–50 (`:45-48`).
  - **Older** live daemons are adopted read-mostly: "Preserve old-protocol sessions without respawning into new code" (`daemon-legacy-adapters.ts:27-66`, esp. `:51`). Their records are deleted only when both the socket probe and the pid probe say dead (`:35-48`).
  - **Newer** daemons are never touched: "This build cannot speak the newer protocol; inspect its PID and endpoint without mutating its files". Restores are held (`daemon-newer-protocol-hold.ts:20-21,58-73`).
  - The hello carries `version`, `token`, `clientId` and `role: 'control'|'stream'`. Unknown fields are ignored by older daemons (`daemon-hello-protocol.ts:1-28`).
- **VERIFIED. The terminal daemon outlives the runtime.** "terminal daemons own separate endpoints and deliberately survive runtime lock release and restart" (`orcad-instance-lock.ts:1-2`). "Detached terminal daemons must outlive orcad; shutting them down here would kill terminals on restart" (`orcad-daemon-supervision.ts:1`).
- **VERIFIED. Migration owner = the single lock holder. The CLI never opens SQLite.** grep of `src/cli` for `sqlite|orchestration-db` (excluding tests) hits only help text and backup labels (`src/cli/handlers/profile-state.ts:43-176`, `bundled-skill-guides.ts`).
  - Profile DB:
    - a newer `user_version` is opened **read-only** (`src/main/persistence/profile-state/profile-state-database.ts:80-95`); the read-only path throws `newer-schema` (`:166-172`);
    - forward migration runs in one write transaction (`:215-234`);
    - "Failed backups must block data migration": a pre-migration copy is made once, by the "single live owner only" (`profile-state-pre-migration-backup.ts:4-17`).
  - Orchestration DB:
    - migration runs in one `BEGIN IMMEDIATE` (`src/main/runtime/orchestration/db/schema/migrate.ts:18-54`);
    - a **newer** stored version is returned as-is and the runtime proceeds, i.e. it tolerates and does not refuse (`orchestration-schema-version-skew.ts:183-190`);
    - a DB that claims a version without the columns is replayed from v6 (`:191-195`).

## 2. Tailscale (tailscaled + CLI + Linux systray)

- **VERIFIED. Launch: a system unit only.** `cmd/tailscaled/tailscaled.service:9-20` sets `ExecStart=/usr/sbin/tailscaled … --socket=/run/tailscale/tailscaled.sock`, `ExecStopPost=… --cleanup`, `Restart=on-failure`, `Type=notify`, `RuntimeDirectory=tailscale` and `StateDirectory=tailscale` (mode 0700). The tray is a separate user unit, `ExecStart=/usr/bin/tailscale systray` (`client/systray/tailscale-systray.service`).
- **VERIFIED. Stale socket: probe first, then unlink, with the race acknowledged.**
  - `safesocket/unixsocket.go:24-43` dials the path first. A live listener means "address already in use"; under launchd the error also says how to stop it. Otherwise the socket is removed and rebound.
  - The comment admits the race: "A 'proper' daemon usually uses a dance involving pidfiles … beyond the scope of our simple socket library" (`:31-34`).
- **VERIFIED. Attach: HTTP LocalAPI over the Unix socket, with a streaming bus.**
  - `client/local/local.go:1516-1541` does `GET /localapi/v0/watch-ipn-bus?mask=…` and decodes a JSON stream.
  - `NotifyInitialState` / `NotifyInitialPrefs` make "the first Notify message (sent immediately)" carry the current state, so the client gets a snapshot and then pushes (`ipn/backend.go:86-89`).
  - Reconnect in the systray is a fixed 3 s sleep loop: "If our watch connection breaks, wait a bit before reconnecting" (`client/systray/systray.go:517-531`).
- **VERIFIED. Version skew is a warning, not a refusal.**
  - The daemon stamps `Tailscale-Version` on every LocalAPI reply (`ipn/localapi/localapi.go:254`).
  - The client compares it with its own `IPCVersion()` (`client/local/local.go:189-190`). The CLI prints `Warning: client version %q != tailscaled server version %q` once (`cmd/tailscale/cli/cli.go:116-121`).
  - Each request also sends `Tailscale-Cap: <CurrentCapabilityVersion>` (`client/local/local.go:170`), so the server adapts to the client's capability integer.
- **INFERRED.** State (`tailscaled.state`) belongs to the daemon alone, because every client goes through LocalAPI. That leaves no shared-store migration problem.
- **UNVERIFIED.** The macOS/Windows GUIs (closed source).

## 3. tmux (server/client, on-demand)

- **VERIFIED. Launch: on demand by the first client, serialized by `flock`.**
  - `client_connect` (`client.c:105-176`): when `connect` gives `ECONNREFUSED`/`ENOENT`, the client takes `<socket>.lock` with `flock(LOCK_EX|LOCK_NB)`. If another client holds the lock, it waits for it, then retries the connect.
  - It "Always retr[ies] at least once, even if we got the lock, because another client could have taken the lock, started the server and released the lock between our connect() and flock()" (`:146-156`).
  - Only the lock holder unlinks the stale socket (`:159`) and forks the server (`:164`). The lock helper is at `:78-101`.
  - The server double-forks with `daemon(1,0)` (`proc.c:375-389`), binds, then unlinks the lock file (`server.c:177-243`, lock release at `:239-243`).
- **VERIFIED. systemd socket activation is optional.** `systemd_create_socket` uses `sd_listen_fds` (`compat/systemd.c:39-52`; called at `server.c:227-231`).
- **VERIFIED. Lifetime.** The `exit-empty` option makes the server exit when it has no sessions (`server.c:291`; `options-table.c:450`).
- **VERIFIED. Version skew: exact-match refuse.** `PROTOCOL_VERSION 8` travels in every imsg header (`tmux-protocol.h:23`; `proc.c:177`). A peer with another version gets `MSG_VERSION` and is marked bad (`proc.c:134-148`). The client prints `protocol version mismatch (client %d, server %u)` and exits 1 (`client.c:658-666`). The old server keeps running; the user kills it.

## 4. VS Code remote server (sparse read)

- **VERIFIED. Version skew: exact-commit refuse at the handshake.** `if (rendererCommit !== myCommit) return rejectWebSocketConnection('Client refused: version mismatch')` (`src/vs/server/node/remoteExtensionHostAgentServer.ts:350-357`).
- **VERIFIED. Reconnect.**
  - A client reconnects with a `reconnectionToken` (`:202-219`).
  - The server keeps the connection for a grace time after a disconnect: "will wait for reconnection … before disposing" (`remoteExtensionManagement.ts:58-79`). The grace time is configurable with `--reconnection-grace-time` (`serverEnvironmentService.ts:280`).
- **VERIFIED. Lifetime.** Auto-shutdown is opt-in (`enable-remote-auto-shutdown`, `serverEnvironmentService.ts:100`), with `SHUTDOWN_TIMEOUT = 5 min` (`serverLifetimeService.ts:13`).
- **UNVERIFIED.**
  - The default value of `ProtocolConstants.ReconnectionGraceTime` (in `ipc.net.ts`, not checked out).
  - The per-commit side-by-side install dir (`~/.vscode-server/bin/<commit>`), which lives in the closed-source Remote-SSH extension.

## 5. Not read

Docker Desktop and 1Password are closed source. Syncthing and Zed are open source but were not read in this pass. No claims are made about any of them.

---

## 6. Orchestra today (the facts the implications rest on)

- **VERIFIED.** `src/main/index.ts:990-993`: "This is the only backend fence: Orchestra's backend runs exclusively inside the Electron main process, so app-vs-app is the whole hazard space". It uses `app.requestSingleInstanceLock()`, keyed by userData = `$ORCHESTRA_HOME/userData` (`:168`).
- **VERIFIED.** `src/main/hooks-server.ts:137-147` **unlinks the socket unconditionally before bind**, with no liveness probe. The name is stable per `ORCHESTRA_HOME` on purpose, so that keepers' frozen `ORCHESTRA_SOCK` survives app restarts (`:74-82`). This is safe only because of the Electron lock above.
- **VERIFIED.** The CLI is also a bus migrator: `openBusForVerb` → `bus.openBus` → `migrate()` (`src/cli/index.ts:785`; `src/main/bus.ts:613-615`). A newer schema is refused: "newer than this build supports … upgrade Orchestra" (`bus.ts:580-586`). The migration is per-version `BEGIN IMMEDIATE` with a re-read under the lock (`:587-606`).
- **VERIFIED.** The keeper `hello` "CLAIM[s] the client slot (preempts any previous client — last wins)". `probe` is read-only and "does NOT claim the client slot" (`src/shared/keeper-protocol.ts:19-26`). Neither frame carries a protocol version. Malformed lines are tolerated because "the peer may be a different Orchestra version" (`:120`).

## 7. Implications for #140

**(a) Launch model: both, as exclusive alternates.**
- orca's shape:
  - a systemd **user** unit that runs a CLI-side supervisor (`--supervise`), with `KillMode=process` so the detached workers (our keepers) survive a service stop or restart;
  - a crash brake that gives up and exits 0, plus distinct exit codes for configuration refusals, so systemd stops instead of restart-spinning (orca §1.1);
  - the unit **stands by** (exit 3 loop) while the desktop holds the profile, and takes over when it quits.
- Pure CLI-on-demand has no local orca precedent. If we want it, tmux's recipe is the one to lift: `flock` on `<sock>.lock`, retry the connect after taking the lock, and only the lock holder unlinks and forks.
- Linger: the user unit dies at logout unless `enable-linger` is on (orca `serve.ts:70`).

**(b) Keeper and worktree ownership when both exist: one owner at a time, the lock holder.**
- In orca the desktop and orcad never co-own. Terminals live in a separate daemon that each new holder re-adopts (`orcad-instance-lock.ts:1-2`).
- Our keepers already have the right shape. But because `hello` is last-wins (§6), two hosts attached to the same keeper would steal the slot from each other on every reconnect. Exclusivity is therefore mandatory, not just a nice property (INFERRED).
- Electron's lock cannot fence plain Node. orca says so and added a shared file lock (`desktop-profile-instance-lock.ts:1`). We need the same lock, taken by the app AND hostd, before the bus, store or socket is touched.

**(c) Renderer attach protocol: the renderer speaks the host's RPC.**
- The same methods should run over IPC (in-app host) or the socket (hostd); orca dispatches both into one dispatcher (§1.3).
- Push is snapshot → `{epoch, seq}` deltas. A gap or epoch change means resubscribe for a fresh snapshot. A lost stream means backoff from 1 s to 30 s (orca), or a fixed 3 s (Tailscale).
- No polling except for liveness. Treat `method_not_found` as an old-host refusal, not a transient error.
- VS Code's reconnection token plus a server-side grace window is the extra piece we would need if a renderer reload must not drop in-flight streams.

**(d) Version-skew rule: integer protocol ranges plus capabilities, checked at handshake, and the lock holder migrates.**
- Handshake: refuse with a named "update X" message when outside the range (orca). Never require equal app versions. tmux and VS Code refuse on exact mismatch; Tailscale only warns.
- Long-lived workers: version their socket names. Adopt older ones attach-only, and never touch newer ones (orca's terminal daemon, §1.4).
- Bus schema: in orca the CLI never opens the DB, so only the lock holder migrates, after a backup. Orchestra's CLI migrates today (§6). #140 must decide whether that stays (see Q1–Q2).

**(e) Shadow strategy and promotion bar: no orca precedent.**
- orca is strictly exclusive. The desktop refuses to start while orcad holds the profile (`main-process-preflight-failure.ts:8-19`). Electron-serve is promoted into a desktop *in-process*; it is never mirrored.
- A mirror hostd would be an Orchestra invention. To be safe it would need:
  - only `readonly` bus connections;
  - only keeper `probe` frames, never `hello`;
  - no bind on the canonical socket path;
  - no worktree writes.
- The closest precedent for safe side-by-side running is orca's attach-only adoption of older daemons.
- Promotion = handing over the shared lock (the app quits or releases it, and the standby unit acquires it), not a flag flip on two live hosts (INFERRED).

## 8. New questions surfaced (not yet in map #136)

1. **Does the CLI keep migrating the bus once a hostd exists?**
   - orca's CLI never opens SQLite. Orchestra's does (`cli/index.ts:785`).
   - With three binaries on different versions, a newer CLI can migrate the bus under a running older hostd.
   - What does that hostd do on its next statement? It checked `user_version` only at open (`bus.ts:578-586`).
2. **Should an older host refuse or tolerate a newer bus schema?** orca does both: the profile DB opens read-only, while the orchestration DB proceeds on a newer schema (§1.4). Orchestra refuses today. Under a supervisor, a refusal must be a distinct "do not restart" exit, or systemd will spin.
3. **What file lock fences app vs hostd, and what are its stale-holder rules?**
   - orca: link-published record with pid, start ticks, bootId and nonce. It never reclaims on "can't tell", and its release is nonce-checked.
   - Does the keeper reaper's existing identity re-read (pid + `/proc` start time) give us this for free?
4. **The canonical socket under two possible binders.** `hooks-server.ts:137-147` unlinks blindly, and the stable name exists for keepers' frozen `ORCHESTRA_SOCK`.
   - After a handover, hostd must bind the SAME path or every running keeper's CLI goes dark.
   - Which publication rule do we adopt: orca's link/rename protocol, or Tailscale's probe-first (racy, by its own admission)?
5. **Is "app = pure client of a local hostd" actually wanted, or "app is EITHER the host OR a client"?** orca has no local desktop-attaches-to-orcad path (UNVERIFIED beyond the files read); its only client-of-runtime UI is the remote paired environment. #136's destination assumes the first option.
6. **Can a read-only mirror see enough to be a meaningful shadow?** Live turn streams require a claimed keeper slot (`hello`), which a mirror must never take. Can it observe only the bus and the events spool, and is that enough of a promotion bar?
7. **Keeper protocol versioning.** `hello` carries no version (§6). A hostd that updates out of step with the app will meet keepers spawned by either. Do we add a version integer plus orca's older-attach-only / newer-hold rule before hostd ships?
8. **Logout survival.** Does a fleet need to outlive logout? That decides whether `enable-linger` is a prerequisite or a documented caveat.

## 9. VERIFIED / NOT VERIFIED

**VERIFIED (read at the pinned sha):** every `path:line` above, by `sed -n` / `grep -n` in this session.

**NOT VERIFIED:**
- Any runtime behaviour. Nothing was built or run, and "read" is not "observed".
- orca local desktop → orcad pairing (absence claimed only for the files read).
- VS Code's default grace time and its per-commit install layout.
- The Tailscale macOS/Windows GUIs.
- Docker Desktop, 1Password, Syncthing, Zed.
- Whether orca's terminal daemon admits two concurrent runtime clients (moot under its exclusive lock, and not read).
