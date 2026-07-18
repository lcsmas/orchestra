# Platform seam, ui-rpc server & headless daemon

The dual-frontend backend layer added in the GTK4-port M1 milestone
(`docs/gtk4-port-plan.md` §1/§2/§4; wire contract frozen in
`docs/ui-rpc-protocol.md`). One TypeScript backend now serves two faces: the
Electron renderer over ipcMain (unchanged channels) and external UI clients
(the GTK app, tests) over a Unix-socket RPC. Files: `src/main/platform/`
(`index.ts`, `electron.ts`, `headless.ts`), `src/main/api-handlers.ts`,
`src/main/ui-rpc.ts` (+ `.test.ts`), `src/main/daemon.ts`,
`src/main/backend-lock.ts` (+ `.test.ts`), `src/main/deps.ts`,
`src/main/login-url.ts`, `src/shared/ui-rpc-protocol.ts` (+ `.test.ts`),
`scripts/dump-rpc-fixtures.ts`, `vite.daemon.config.ts`.

## The platform seam — src/main/platform/

`platform` (`index.ts:120`) is the one interface backend modules use instead
of Electron: `broadcast(channel, ...args)` (replaces every
`webContents.send`), `broadcastPtyData` (returns false ⇒ pty.ts retains its
buffer, preserving the never-drop contract), `isFocused()` (Electron window
focus OR any ui-rpc client's `focus` frame), `hasAttachedUi()` (gates the
events-spool drain), `notify()` (native toast and/or `ui:notify` event),
`openExternal`/`showItemInFolder`/`openPath`, `openAccountLoginUrl` (Electron:
isolated login BrowserWindow + `accounts:loginUrl` event; headless: event
only), `getUserDataDir`/`getLogsDir`/`getAppVersion`/`getAppMetrics`, and a
safeStorage facade (headless reports unavailable → secrets.ts's 0600-plaintext
fallback). Entry points install an implementation via `initPlatform` before
anything else runs: index.ts → `createElectronPlatform(() => mainWindow)`,
daemon.ts → `createHeadlessPlatform()` (xdg-open, env-derived paths,
`process.cpuUsage()` self-metrics). `index.ts` also hosts the ui-rpc client
sink registry (`setUiClientSink`) both implementations fan out through, plus
`orchestraHome()` (`$ORCHESTRA_HOME` or `~/.orchestra`). Nothing in
`platform/index.ts` or `headless.ts` imports electron — that is what lets the
daemon bundle run under plain Node. As a result NO subsystem module takes a
`BrowserWindow` parameter anymore (the 2026-07 sweep removed them all).

## Shared handler table — api-handlers.ts

Every request/response handler extracted from index.ts, keyed by
`OrchestraAPI` MEMBER name (not IPC channel). `METHOD_IPC_CHANNELS` maps each
member to its historical ipcMain channel; index.ts wires the table in one loop
(channel names unchanged — preload/renderer untouched), and ui-rpc.ts
dispatches `req` frames into the same entries. `pickDirectory` is deliberately
absent (frontend-local; stays an inline Electron handler in index.ts). Three
protocol-added methods ride the table: `deps:status` (deps.ts probe),
`app:info` (version/backendKind/home/logPath), `pty:scrollback` (base64 of
pty.ts readScrollback). `login-url.ts` holds the Electron-free
`dispatchLoginUrlRequest` (isClaudeAuthUrl gating stays backend-side);
login-browser.ts keeps only the BrowserWindow half, imported solely by the
electron platform impl.

## Wire protocol — shared/ui-rpc-protocol.ts

Length-prefixed frames (`[u32 BE][payload]`, 16 MiB cap) like
sandbox-protocol.ts, with first-byte payload discrimination: `0x7B` JSON
(hello/helloOk/req/res/event/focus/ping/pong), `0x01` ptyData (S→C binary),
`0x02` ptyWrite (C→S binary). `WIRE_EVENT_CHANNELS` maps internal IPC channel
names → wire names (`on` prefix stripped, camelCase; `pty:data` excluded —
binary only; includes the M1 additions `ui:notify`→`uiNotify` and
`accounts:loginUrl`→`accountsLoginUrl`). Pure data + streaming decoder;
unit-tested under `node --test`.

## The server — ui-rpc.ts

`startUiRpcServer({handlers, appVersion, backendKind, ...})`: socket at
`$XDG_RUNTIME_DIR/orchestra-ui-<pid>.sock` (mode 0600) + pointer file
`<orchestraHome>/ui-sock`, hello→helloOk handshake (proto 1; mismatch answered
with ours, client decides), multi-client, per-client focus tracking, idle
ping (15 s) → pong grace (5 s) → drop. `req` dispatch walks the injected
handler table (DI so tests drive fakes over a temp socket — see
`ui-rpc.test.ts`); binary ptyWrite frames route through the table's own
`ptyWrite` so the hasInput flip and heavy-resume gate can't be bypassed.
Registers itself as the platform sink; PTY output rides pty.ts's existing
coalesced flush (`flushPtyData` → `platform.broadcastPtyData`) — no second
buffer layer. Started by BOTH index.ts (backendKind 'electron') and daemon.ts
('daemon'). Its imports carry explicit `.ts` extensions so the node test
runner resolves the closure (same for platform/index, logger, backend-lock).

## The daemon — daemon.ts + backend-lock.ts

`node dist-electron/daemon.js` (or later `Orchestra.AppImage daemon`): shell-env
merge, headless platform, logger, backend lock, store, cli shims, hooks
server, events spool (drain gate generalized to "≥1 attached UI client OR
Electron window" via `platform.hasAttachedUi()`), ui-rpc server, usage/
account/prompt-queue/self-tune/sandbox-backup schedulers, orphan prune, repo
sync; SIGINT/SIGTERM → orderly shutdown + lock release. `backend-lock.ts` is
the app↔daemon mutual exclusion (`<orchestraHome>/backend.lock`, pid-probe
liveness, atomic write): the events-spool startup wipe means two backends must
never share a home — the Electron app takes the same lock right after
`requestSingleInstanceLock` and refuses (error box) if a daemon owns the home.
Built by `vite.daemon.config.ts` (all node builtins external — a missed one
gets vite's empty browser shim and crashes at runtime; electron external ON
PURPOSE so a stray import fails loudly). `agentCliBinDir()` now lives under
`orchestraHome()` so an isolated daemon/dev instance can't clobber the
packaged app's agent shim; the plain-Node shim target is `node <dir>/cli.js`.

## Conformance fixtures — scripts/dump-rpc-fixtures.ts

`pnpm run fixtures:rpc` boots the real handler table on the headless platform
against a seeded fixed-path home (`/tmp/orchestra-rpc-fixtures`, HOME
redirected, tiny real git repo) and writes
`native/orchestra-rpc/fixtures/{method.*,event.*,binary.ptyData,manifest}.json`
— the serde drift gate for the Rust `orchestra-rpc` crate (plan §2). Runs are
byte-deterministic (fixed seeds + a UUID/epoch-ms normalization pass);
non-capturable methods (spawns, sandbox, network, machine state) are listed
with reasons in `manifest.json`. The event-sample table is a mapped type over
`OrchestraAPI`'s `on*` members, so adding a push channel breaks the fixtures
build until a sample exists.
