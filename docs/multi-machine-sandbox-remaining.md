---
slug: multi-machine-sandbox-remaining
branch: multi-machine-sandbox-design
base: master
---

# handoff: multi-machine-sandbox-remaining

## goal
Finish the multi-machine sandbox feature for Orchestra (an Electron app that runs Claude Code agents in git worktrees). The architecture is settled — do NOT relitigate:
- **Central sandbox, thin clients.** The agent + git worktree + Claude session live in ONE always-on sandbox (a Docker container on a host). Each machine's Orchestra is a thin client streaming the terminal over ONE multiplexed WebSocket. One copy of the work that never moves → no file-sync, no path-rewriting, any OS.
- **File-sync is REJECTED.** Never build it.
- **Local node-pty stays the DEFAULT transport.** The remote path is a sibling, never a replacement. A workspace is EITHER local OR sandbox-hosted, never both editable at once.
- **Auth:** mount claude.ai OAuth creds; do NOT set `ANTHROPIC_API_KEY` (it silently disables MCP connectors).
- **Wire transport = WebSocket.** Reachability (Tailscale for home server, direct TLS for VPS) is baked into the endpoint URL and invisible to the protocol.

P1–P4.4 are DONE and pushed. This doc covers the REMAINING work (the items in `## state [untouched]`).

## state
- [done] P1 transport seam (`207c646`), P2 image+secrets (`c4a5dd1`,`81009b4`).
- [done] P3.1 wire protocol `src/shared/sandbox-protocol.ts` (`fa77926`).
- [done] P3.2 sandbox shim `sandbox/shim/` (`93266b9`) — runs in-container, built into the image at `/opt/orchestra/shim/dist`.
- [done] P3.3 host-side `src/main/transport/{remote.ts,sandbox-connection.ts}` (`58ded85`).
- [done] P4.1–4.3 remote path wired live + e2e tests (`05875ab`).
- [done] P4.4 per-machine node UI `src/renderer/host-grouping.ts` + Sidebar grouping (`8037518`).
- [done] Branch `multi-machine-sandbox-design` pushed to `origin` with upstream set. 35 app tests + 12 shim tests + 2 real-shim integration suites green; tsc clean except 2 pre-existing errors; vite build + Docker image build clean.
- [done] **(A) Sandbox provisioning** — container-owned checkout via one-way "import to sandbox" (the confirmed open-decision). Shim serves `GET /healthz` + `POST /import` on the SAME port as the WS server (`sandbox/shim/shim-import.ts`); payload = tgz of `meta.json` + `repo.bundle` (`git bundle --all`) + `worktree/` overlay (uncommitted changes, untracked files, gitignored `.orchestra`/`.claude` hook dirs). Host side: `src/main/sandbox-import.ts` (`importWorkspaceToSandbox`) stages + POSTs, then retires the local worktree and flips `ws.host` to `{kind:'sandbox',endpoint}`. `pruneOrphanedWorkspaces` and `deleteWorkspace` skip sandbox-hosted records. Dockerfile CMD now boots the shim (always-on sandbox). Wire protocol UNCHANGED (import rides HTTP, not frames). Note: the Claude conversation does NOT move — first sandbox spawn starts fresh (`hasInput` is reset on import).
- [done] **(B) UI affordance** — a cloud-upload row action on local git workspaces ("Import to sandbox") prompts for the endpoint (`dialog.prompt`, remembers `orchestra.lastSandboxEndpoint`) and calls `workspaces:importToSandbox` IPC. Imported rows regroup under their host node (P4.4 grouping).
- [done] **(C) Cross-machine ownership lock** — shim-brokered (the confirmed open-decision). Protocol gained `hello`/`takeControl` (client→shim) and `control` broadcasts (shim→client, `isDriver` per recipient). The shim now accepts MANY simultaneous clients — all receive data/exit/event (observers watch live) — but exactly one drives: first `hello` wins, `takeControl` is an explicit take-over, a reconnect bearing the driver's clientId resumes its drive, driver detach promotes the longest-attached identified client, and a lone legacy client (never says hello) adopts a vacant drive on first write. write/resize/kill/spawn from observers are dropped; hook `rpc`s go to the driver only. Election logic is the pure `DriveBroker` in `shim-core.ts`. Host: manager sends `hello` (id/name = hostname) on connect + after reconnect, mirrors `control` state per endpoint, pushes `sandbox:control` to the renderer; `SandboxControlBar` shows "Read-only — X is driving" + a Take control button above sandbox terminals.
- [done] **(D) Reconnect/backoff policy** — an unexpected socket drop with live sessions no longer unwinds them: `SandboxConnection` gained a disconnected state (`onDisconnect` handler, `attachSocket()` to resume on a fresh socket with sinks intact, `abandon()` to give up), and `sandbox-manager.ts` runs an exponential-backoff dial loop (`reconnect-policy.ts`: 1s→2s→…→30s cap, 3-min give-up window, 10s per-dial timeout) with "link lost / restored / gave up" banners stamped into the affected terminals. Spawns arriving mid-outage await the replaced `ready` promise. A drop with NO live sessions keeps the old evict-and-redial-on-next-spawn behavior; give-up unwinds with `EXIT_CONNECTION_LOST` exactly as before. The shim side needed no change (sessions already survive detach; last-writer-wins accepts the new socket).

## mental-model
- **The shim is the sandbox-side half of Orchestra.** It does in-container exactly what the app does locally: (1) spawns the agent PTY in `/workspace` on a `spawn` frame, relays `data`/`exit`; (2) tails `$ORCHESTRA_EVENTS_DIR/<wsid>.jsonl` → emits `event` frames; (3) serves the `$ORCHESTRA_SOCK` unix socket the agent POSTs to, forwarding the 5 hook routes as `rpc` frames and returning the host's `rpcReply` as the HTTP response. The agent notices no difference vs local. Source: `sandbox/shim/shim.ts` (+ pure `shim-core.ts`).
- **One WS multiplexes all sessions** via the per-frame `session` field (= workspace id). `SandboxConnection` (`src/main/transport/sandbox-connection.ts`) owns the socket + `FrameDecoder` and routes: `data`/`exit`→the session's `RemoteTransport`; `event`→`onEvent`; `rpc`→`onRpc` (which calls `reply` → `rpcReply`).
- **`createTransport` (`src/main/pty.ts`) chooses the backend per workspace:** `host.kind==='sandbox'` → `getSandboxConnection(endpoint)` + `createRemoteTransport`; else local node-pty. Remote spawn SKIPS the local cwd existence check and does NOT ship the host's `process.env` over the wire (only `extraEnv`); the shim supplies the in-container rendezvous paths (`ORCHESTRA_WS_ID`/`EVENTS_DIR`/`SOCK`).
- **`sandbox-manager.ts` is where protocol-pure code meets the live app:** one `SandboxConnection` per endpoint (lazy, cached, dropped on close), the `ws`→`SandboxSocket` adapter, and `onEvent`→`applyAgentEvent`, `onRpc`→`dispatch{Rename,Spawn,Peers,Read,Message}Request` (the SAME handlers `hooks-server.ts` uses).
- **For provisioning (A):** Claude keys its session by absolute cwd, so the sandbox MUST mount/checkout the worktree at `/workspace` (= `SANDBOX_WORKSPACE_DIR` in `src/shared/types.ts`, = the Dockerfile WORKDIR). Hooks live in the worktree's `.claude/settings.local.json` — for a remote workspace `index.ts` SKIPS local `installOrchestraHooks`, so the shim/image must ensure hooks exist in the container's `/workspace`. The shim already forces `ORCHESTRA_SOCK`/`EVENTS_DIR` env, so the hook helper will write/POST to the right in-container places once installed.
- **Tests use the strip-types runner** (`node --test --experimental-strip-types`): source imported by a test must use explicit `.ts` extensions and avoid TS parameter properties (constructor `private x`). `tsconfig` has `allowImportingTsExtensions` + `noEmit` for this; `vite build` is the real compile path and is unaffected.
- **`ws` optional native deps** (`bufferutil`,`utf-8-validate`) are externalized in `vite.config.ts` — without that the electron-main bundle fails to build.

## open-decisions
- [resolved 2026-07-06] Provisioning mechanism for (A): **container-owned checkout** confirmed with the user. Implemented as the one-way "import to sandbox" (bundle + overlay over HTTP POST /import; local worktree retired after the container confirms).
- [resolved 2026-07-06] Coordination channel for (C): **shim brokers it**, confirmed with the user. Implemented as the DriveBroker + hello/takeControl/control frames; no separate service.

## hardening (2026-07-06, post-C)
Six edge-case fixes landed after an audit:
- **Claude config ships with the import** — the payload's `claude-config/` entry packs the workspace's effective login/config (pinned account's `.credentials.json`, `.claude.json` = user-scope MCP servers, `settings.json`, `CLAUDE.md`, `skills/agents/commands` — include-list `CLAUDE_CONFIG_ENTRIES` in `import-core.ts`); the shim seeds container `~/.claude` (+`~/.claude.json`), per-entry best-effort so a legacy read-only creds mount wins instead of aborting. `syncAccountInheritance` runs before packing. Remote spawns now STRIP `CLAUDE_CONFIG_DIR` (a host path that would shadow the seeded login).
- **Non-destructive retire** — the local worktree moves to `~/.orchestra/trash/<name>-<ts>` (+ `git worktree prune`) instead of `rm -rf`, so gitignored files (.env, dev DBs) survive; destructive removal only as fallback.
- **Idempotent import** — host stamps `x-orchestra-session`; the shim persists an ImportRecord (`ORCHESTRA_IMPORT_META`, default `~/.orchestra/import-meta.json`) and replays 200 `{ok, alreadyProvisioned}` for a same-session retry (lost-response case) while rival imports still 409.
- **No observer black-hole** — an observer's spawn for a NOT-running session gets a targeted explanation line + exit frame; for a running session it remains the passive reattach path.
- **Per-install clientId** — persisted UUID at `userData/orchestra/client-id` (hostname stays the display name); identical hostnames no longer steal each other's drive.
- **Docs** — README now mandates named volumes (`sandbox-workspace:/workspace`, `sandbox-home:/home/agent`; container recreation otherwise destroys unpushed work) and carries an explicit no-auth security warning (private network only; import payload carries credentials in transit).

## next-action
A–D + hardening are DONE. Remaining: (1) the manual end-to-end run over a real network (import → agent works with seeded account/MCP → second machine read-only → take-over → link drop → auto-reconnect), see unverified; (2) minor leftovers — sidebar/`git:stats` polling still targets the retired local `worktreePath` for sandbox-hosted workspaces (harmless log noise), no export-back-to-local flow exists (push to origin is the recovery path), and `git bundle` does not carry submodules.

## pointers
- Ownership (C): pure election `DriveBroker` in `sandbox/shim/shim-core.ts` (+ 8 tests); frame gating + broadcasts in `sandbox/shim/shim.ts`; two-client e2e `sandbox/shim/control.integration.test.mjs` (also green in-image). Host mirror + `hello` in `sandbox-manager.ts` (`getSandboxControlState`/`takeSandboxControl`, `sandbox:control` push); IPC `sandbox:controlState`/`sandbox:takeControl`; UI `src/renderer/components/SandboxControlBar.tsx` (+ `.sandbox-control-*` styles), mounted above the pane row in App.tsx like SetupBanner.
- Reconnect (D): policy math `src/main/transport/reconnect-policy.ts` (+ `.test.ts`, 6 tests); disconnected-state lifecycle in `sandbox-connection.ts` (+ 9 new lifecycle tests in its `.test.ts`); the dial loop + banners in `sandbox-manager.ts` (`reconnectLoop`, `openSocket` with `CONNECT_TIMEOUT_MS`).
- Provisioning (A): shim side `sandbox/shim/shim-import.ts` (+ `shim-import.test.ts`, 9 tests; `import.integration.test.mjs` real-HTTP e2e, also runs in-image); host side `src/main/sandbox-import.ts` (staging + POST + retire) with pure helpers in `src/main/transport/import-core.ts` (+ `.test.ts`, 10 tests). IPC `workspaces:importToSandbox`; renderer action `importToSandbox` (store.ts), row button + `dialog.prompt` in Sidebar/Dialog.
- Wire protocol + framing: `src/shared/sandbox-protocol.ts` (+ `.test.ts`, 11 tests). Vendored copy in `sandbox/shim/sandbox-protocol.ts` kept in sync by `sandbox/shim/sync-protocol.mjs` (`npm run check-protocol` is the drift gate). The import flow rides plain HTTP on the shim port, NOT frames — no protocol change.
- Shim: `sandbox/shim/shim.ts`, pure `sandbox/shim/shim-core.ts` (+ `shim-core.test.ts`, 12 tests). Built into the image via `sandbox/Dockerfile`. Listens on `ORCHESTRA_SHIM_PORT` (default `8787`).
- Host transport: `src/main/transport/{remote.ts,sandbox-connection.ts,sandbox-manager.ts}`. Selection at `src/main/pty.ts` (`createTransport`), called from `pty:start` in `src/main/index.ts` (passes `ws.host`, uses `/workspace` cwd + skips local hook install for remote).
- Types: `WorkspaceHost` + `SANDBOX_WORKSPACE_DIR` + `CreateWorkspaceInput.host` in `src/shared/types.ts`. Persisted in `createWorkspace` `src/main/workspaces.ts`.
- UI grouping: `src/renderer/host-grouping.ts` (+ `.test.ts`, 9 tests), `src/renderer/components/Sidebar.tsx` (renderWs + node headers), styles `.host-group-header`/`.host-collapse`/`.host-dot` in `src/renderer/styles.css`.
- Run tests: `node --test --experimental-strip-types 'src/**/*.test.ts'` (app) and `... 'sandbox/shim/shim-core.test.ts'` (shim).
- Real-shim integration (need `sandbox/shim` built first: `cd sandbox/shim && npm i && npm run build`): host-side `node --experimental-strip-types src/main/transport/remote.integration.test.mjs`; raw-frame `node sandbox/shim/integration.test.mjs`; in-image `docker run --rm <image> node /opt/orchestra/shim/integration.test.mjs`.
- Build image: `docker build -t orchestra-sandbox sandbox/`. Secrets/auth contract: `docs/sandbox-env-contract.md`. Sandbox README: `sandbox/README.md`.
- Two PRE-EXISTING tsc errors unrelated to this work: `src/main/index.ts` (BrowserWindow|null) and `src/main/workspaces.ts:114` (arg count). Everything else is clean.

## unverified
- Real Docker `docker run` of the full sandbox serving a LIVE Orchestra client over a real network (Tailscale/TLS) was NOT done — the shim was verified via the in-image integration test (loopback) and the host transport via integration tests against a locally-spawned shim. The two halves have not been exercised over an actual remote link.
- The renderer node-grouping UI was verified by unit tests of `host-grouping.ts` (9 tests) and a clean build, NOT by a pixel screenshot (an isolated Electron instance hit a fatal GPU crash on this Asahi/Wayland host; software-rendering ran but capturing the right window risked grabbing the user's live screen, so it was abandoned). The grouping LOGIC is fully tested; the visual rendering is inferred.
- `eslint` is not installed / has no config in this repo; the `lint` npm script is non-functional (pre-existing). Verification rests on tsc + tests + build.
