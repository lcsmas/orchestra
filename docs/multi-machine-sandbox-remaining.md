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
- [untouched] **(C) Cross-machine ownership lock** — "one machine drives, others read-only + take-over". Deliberately NOT faked: there is no cross-machine coordination channel (each Orchestra has its own local `store.json`). Needs shared state first (the shim brokering attach, or a small coordination service).
- [untouched] **(D) Reconnect/backoff policy** — today `sandbox-manager.ts` drops a closed connection and reconnects on the NEXT spawn only. No retry/backoff while a session is live.

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
- [open] Coordination channel for (C): extend the shim to broker "who is attached / who owns the drive" (keeps it dependency-free, one component) vs. a separate small service. Leaning: shim brokers it — it already terminates the single connection per sandbox and sees every client attach (last-writer-wins is already implemented there).

## next-action
(C) cross-machine ownership lock and (D) reconnect/backoff are the remaining items. (D) is smaller and self-contained: give `sandbox-manager.ts` a retry/backoff policy while a session is live instead of dropping the connection until the next spawn. (C) needs the coordination-channel open-decision above resolved with the user first. Also worth doing: a manual end-to-end run of the full flow against a real `docker run` sandbox over a real network (see unverified).

## pointers
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
