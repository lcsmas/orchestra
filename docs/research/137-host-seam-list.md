# #137: the fleet-host seam list (Electron couplings per host service)

**Verdict: the host moves almost unchanged. 131 of the 143 `src/main` modules (about 46k of 51k lines) stop
importing Electron once three import edges are cut. After that they reach Electron only at runtime,
through the existing 18-method platform seam. So the extraction needs:**

- a second `OrchestraPlatform` implementation (one existed until 2026-07-26);
- an attach transport;
- six `ipcMain` registrars moved behind it;
- a decision on four Electron-only capabilities: `safeStorage`, the login `BrowserWindow`, the
  agent-driven `WebContentsView`, and `Notification`.

Compiled 2026-10-25 for [#137](https://github.com/lcsmas/orchestra/issues/137), a child of the map
[#136](https://github.com/lcsmas/orchestra/issues/136), feeding the decision ticket
[#140](https://github.com/lcsmas/orchestra/issues/140).

**Pinned.** Every `path:line` below is at `276cd0586b3c08c33657f9fcb80225ad3f30d7ef`. While I worked,
`origin/master` moved to `7d760353`. That change touches no file under `src/main`, `src/preload`,
`src/cli` or `vite.config.ts` (checked with `git diff --name-only 276cd058 7d760353`), so the anchors
still hold there.

**Method.**

1. `grep` for every `from 'electron'` in `src/main` and `src/shared`. It finds exactly 10 modules.
2. A regex import-graph walker over `src/main` and `src/shared`. It follows value imports, including
   multi-line `import {…} from` and dynamic `import()`, and skips `import type`. It reports the
   shortest path from each module to `electron`.
3. Positive control: the walker finds all 10 grep hits as direct importers. Cutting the three leak
   edges below leaves exactly 12 Electron-reaching modules, and they are all frontend or registrar
   code.
4. Runtime coupling: `grep` for every `platform.<method>` call site.

Tags: unmarked claims were read in source this session. **INFERRED** marks my reasoning.

## 1. What already exists: the platform seam

- `src/main/platform/index.ts:39-90`: `interface OrchestraPlatform`, with `readonly kind: 'electron'`
  (`:41`). It has 18 methods:
  - push: `broadcast`, `broadcastPtyData`, `canBroadcast`;
  - UI state: `isFocused`, `hasAttachedUi`;
  - OS surfaces: `notify`, `openExternal`, `showItemInFolder`, `openPath`;
  - login window: `openAccountLoginUrl`, `closeAccountLogin`;
  - paths and metadata: `getUserDataDir`, `getLogsDir`, `getAppVersion`, `getAppMetrics`;
  - `safeStorage`: `isEncryptionAvailable`, `encryptString`, `decryptString`.

  The file's header says the point is that "no subsystem module holds a BrowserWindow or imports
  electron directly" (`:4-7`).
- The only implementation is `src/main/platform/electron.ts:1`:
  `import { app, safeStorage, shell, BrowserWindow, Notification } from 'electron';`. It is installed
  at `src/main/index.ts:279`: `initPlatform(createElectronPlatform(() => mainWindow));`.
- `onBroadcast` (`platform/index.ts:113`) is an in-process tap on every push. The Accès mobile phone
  feed is built on it (`acces-mobile-feed.ts:4`).
- **Prior art, deleted.** Commit `edd73e17` (2026-07-18) added the following:
  - `platform/headless.ts`;
  - a ui-rpc server (`ui-rpc.ts` and `shared/ui-rpc-protocol.ts`): `[u32 BE len]` framing, JSON
    control frames, binary PTY frames, `UI_RPC_PROTO = 1`;
  - `daemon.ts`;
  - `backend-lock.ts`, an app-vs-daemon lock at `<home>/backend.lock`;
  - `vite.daemon.config.ts`.

  Commit `572c8d2b` (2026-07-26) deleted all of it along with the GTK frontend. Its message says
  "The Electron single-instance lock replaces the app-vs-daemon backend lock". Read it with
  `git show 572c8d2b^:src/main/platform/headless.ts`.

## 2. The three static leaks: the only reason host modules import Electron today

| Edge | Literal line | What it drags in |
|---|---|---|
| `workspaces.ts` → `browser-panel.ts` | `src/main/workspaces.ts:138` `import { destroyPanel as destroyBrowserPanel } from './browser-panel';` (used at `:653`, on archive) | `browser-panel.ts:1` `import { WebContentsView, Menu, clipboard, session, shell } from 'electron';`. Every module that imports `workspaces.ts` reaches Electron through this edge: `hooks-server`, `agent-sdk`, `pty` (via `transport/sandbox-manager`), `hibernation`, `session-watchdog`, `prompt-queue`, `loop-scan`, `wake-roster`, `sandbox-import`, `pause-trap-host`, `veille-reliquats-host`, `linear-tickets`, `restart-workspace`. |
| `agent-sdk.ts` → `agent-browser-tools.ts` | `src/main/agent-sdk.ts:97` `import { buildBrowserToolServer } from './agent-browser-tools';` (called at `:1822` for every local session) | `agent-browser-tools.ts:12` `import * as bp from './browser-panel';`. The `mcp__browser__*` tools drive the Electron `WebContentsView`. |
| `acces-mobile-routes.ts` → `app-update-host.ts` | `src/main/acces-mobile-routes.ts:6` `import { appIdentity, appUpdateState, relaunchApp } from './app-update-host';` | `app-update-host.ts:4` `import { app, ipcMain } from 'electron';`, which provides `app.getVersion()` (`:86`) and `app.quit()` (`:115-116`). |

With those three edges excluded, the walker's remaining Electron-reaching set is exactly:

- `index.ts`;
- `platform/electron.ts`, `login-browser.ts`, `browser-panel.ts`, `agent-browser-tools.ts`, `voice.ts`;
- `api-handlers.ts` (`:152` `import * as browserPanel from './browser-panel';`);
- the six registrars `bus-pane.ts`, `pause-ui-host.ts`, `memory-banner-host.ts`, `watchers-host.ts`,
  `app-update-host.ts` and `voice.ts`.

Together these 12 files are 4,998 lines. That is the "131 of 143" in the verdict.

## 3. Seam table: host services started by `src/main/index.ts`

"Static" means an import line. "Runtime" means a `platform.*` call, which is already behind the seam.
The consumer channel names are the preload subscriptions in `src/preload/index.ts` (31 `ipcRenderer.on`
calls). The push listeners are almost all in `src/renderer/store.ts`.

| Service (start site) | Electron coupling | Consumer (renderer surface ← channel) | First-cut verdict |
|---|---|---|---|
| **Hooks server / local socket**, 28 routes (`/spawn` `/message` `/peers` `/deleteWorkspace` `/verifyLanded` `/busStatus` `/identity` `/loginUrl` …). Started at `index.ts:461` `await startHooksServer();` | **Static** through leak 1: `hooks-server.ts:6-27` imports `./workspaces`. **Runtime**: `/loginUrl` → `login-url.ts:26` `platform.openAccountLoginUrl(...)` opens an Electron `BrowserWindow` (`login-browser.ts:4`). The socket path comes from `orchestraHome()` and `$XDG_RUNTIME_DIR` (`hooks-server.ts:87-96`, pointer at `:109`). | No direct renderer consumer. The clients are the CLI and the hook scripts. Route side effects reach the UI as `workspace:update` and `repos:update` (`workspaces.ts`, 37 `platform.broadcast` calls). | **Moves once leak 1 is cut.** Seam: `/loginUrl` must forward to an attached app. Its single-binder guarantee is the single-instance lock (`hooks-server.ts:82`), so it needs a new lock (§4.1). |
| **Session identity `/identity`** (`hooks-server.ts:613` → `session-identity-host.ts`) | None. `session-identity.ts:4-7` imports only `node:crypto`, `node:fs`, `node:path` and a shared type. `session-identity-host.ts:5-9` imports `orchestraHome`, `bus`, `wave-run-id`, `store` and `logger`, none of which import Electron. This matches the issue's existing comment. | None. The CLI is the client. | **Moves unchanged.** |
| **Keeper install + supervision.** `index.ts:1044` `installKeeper();`, `:1055` `void reconcileKeepersAtStartup();`, quit at `:1071` / `:1082` `setAppQuitting()` | None statically: `keeper-client.ts` imports `orchestraHome` (`:60`) and `APPIMAGE_PATH` (`:66`). **Runtime ABI**: the keeper runs on a PATH `node`, or on `process.execPath` with `ELECTRON_RUN_AS_NODE: '1'` (`keeper-client.ts:508-522`). The bundle is copied out of `__dirname` (`:481`). | Indirect: `restoreRunningFromKeeper` → `workspace:update` (`activity.ts`). Cap states go to the Resources page (`index.ts:626`). | **Moves unchanged.** Quit-means-detach (`keeper-client.ts:93-99`) becomes "daemon stop"; app quit becomes a plain client detach. |
| **Structured agent sessions** (`agent-sdk.ts`, the SDK session manager; started on demand) | **Static**: leaks 1 and 2. **Runtime**: `platform.broadcast('agent:event', …)` is the only event choke point (`agent-sdk.ts:642`). MCP OAuth calls `platform.openExternal(url)` (`:5353`). An API-key account's key is decrypted through `safeStorage` at spawn (`agent-sdk.ts:858` → `secrets.ts:145` `platform.decryptString`). | Agent view ← `agent:event` (`store.ts`). Permission replies come back on `agent:sdkPermissionReply` (`api-handlers.ts:333`). | **Needs seams**: (a) cut leak 2 by moving browser tools behind an "agent browser" port that reaches the app; (b) the push stream; (c) the secrets source (§4.3). The rest moves unchanged. |
| **Worktree / git ops + workspace lifecycle** (`workspaces.ts`, `git.ts`; boot `index.ts:367` `ensureRoot()`, `:765` `pruneOrphanedWorkspaces()`) | **Static**: leak 1, the archive's `destroyBrowserPanel` (`workspaces.ts:653`). **Runtime**: `platform.broadcast` × 37 (`workspace:update`, `workspace:removed`, `workspaces:removed`, `repos:update`, `pty:restart`). | Sidebar and every pane ← `workspace:update` (`store.ts`). | **Moves once leak 1 becomes an event** ("workspace archived" → the app destroys its own panel). |
| **Base-branch sync** (`repo-sync.ts`; `index.ts:789` prime + sync, `:793` `mainWindow.on('focus', …syncAllRepos…)`) | Runtime `platform.broadcast('repo:syncState')`. The trigger is **window focus**. | Sidebar sync state ← `repo:syncState`. | **Moves.** Seam: "a client gained focus" becomes a client→host call. |
| **Bus open** (`index.ts:416-456` `initBus()`) | None statically. **Native ABI**: better-sqlite3 is a raw V8 addon. "node and Electron have different ABIs (127 vs 130 for electron 33.4.11) … The AppImage ships ONLY the ABI-130 build" (`bus-binding.ts:19-20`). The failure push is a direct `mainWindow?.webContents.send('bus:unavailable', …)` (`index.ts:449`). | `bus:unavailable` has **no preload subscriber**, so it is a dead push (grep of `src/preload`, `src/renderer`). | **Moves**, but it constrains the runtime (§4.2). |
| **Bus pane reads + switch write + human-gate resolve** (`index.ts:828` `registerBusPaneIpc()`, `:843` `bus:setSwitches`, `:853` `bus:resolveHumanGate`) | **Static**: `bus-pane.ts:16` `import { ipcMain } from 'electron';`. The handlers at `:370-377` are `bus:snapshot`, `bus:listRuns`, `bus:switches`, `bus:capSummary`, `bus:humanGates`. | Bus pane (`BusPane.tsx`), the ask row and sidebar Asks (`store.ts`) ← `human-gates:update`. | **Needs a seam: registrar → transport.** The projection functions (`busSnapshot` `:270`, `busCapSummary` `:253`) move unchanged; only the `ipcMain.handle` lines are frontend glue. |
| **Bus wake** (`index.ts:549-574`, `startBusWake()`) | None (walker: no path; `bus-wake.ts:35-49` imports bus, admission, watchers and logger). The deliverer is injected (`index.ts:573` → `sdk-delivery.ts`, registered by `agent-sdk.ts:5957`). | None. It writes to agents, not to the UI. | **Moves unchanged.** It inherits agent-sdk's seams at runtime. |
| **Liveness** (`index.ts:590-605`, `startBusLiveness()`) | None (walker: no path). Its clock is the activity idle clock (`index.ts:575-580`), fed by the events spool → `applyAgentEvent`. | None (escalates on the bus). | **Moves unchanged**, but it depends on §4.6 (spool drain gate). |
| **Events spool** (`index.ts:477` `startEventsSpool()`) | Runtime gate: `if (!started \|\| !platform.hasAttachedUi()) return;` (`events-spool.ts:172`): "don't consume events we can't apply". It applies through `applyAgentEvent` (`events-spool.ts:5`). | Indirect: `workspace:update`, `agent:*` via `activity.ts`. | **Moves**, but `hasAttachedUi()` must not gate it in the daemon (§4.6). |
| **Activity** (`activity.ts`, driven by the spool and the SDK) | Runtime: 14 `platform.broadcast` calls (`workspace:update`, `agent:finished`, `agent:needs-input`, `agent:tool`, `agent:context`). `platform.isFocused()` (`:322`, `:533`, `:778`) and the renderer-reported active workspace (`:329`, `:778`) decide "seen". `platform.notify` (`:378`, `:543`) posts an OS toast. | Status dot (`store.ts`), chime and toasts (`App.tsx` ← `agent:finished`, `agent:needs-input`). | **Needs seams**: per-client focus and active-workspace state, and notify forwarded to a client. |
| **Session watchdog** (`index.ts:522`) | **Static** via leak 1 (`→ agent-sdk → workspaces`). Runtime: `platform.broadcast('watchdog:flap-limit', …)` (`session-watchdog.ts:520`) and `platform.notify` (`:525`). | `watchdog:flap-limit` has **no preload subscriber** (dead push). Its only live surface is the toast. | **Moves once leak 1 is cut.** Notify seam as for Activity. |
| **Hibernation / Veille** (`index.ts:650-651`) | **Static** via `pty → sandbox-manager → workspaces` (leak 1). Runtime: `workspace:update` ×2. It reads `getActiveWorkspaceId()` (`hibernation.ts:175`, `:201`), which the renderer sets through `workspaces:setActive` (`api-handlers.ts:304`, `:778-779`). | Sidebar ← `workspace:update`. | **Moves.** Seam: the active workspace becomes per-client state (who is "looking at" a workspace with N clients?). |
| **Inbox watcher, human gates, prompt-queue flusher** (`index.ts:483`, `:487`, `:493-494`) | Runtime `platform.broadcast` (`inbox:update`, `human-gates:update`, `workspace:update`). `prompt-queue` is static via leak 1 (`prompt-queue.ts:5` `./workspaces`). | Composer inbox tray, Asks, queue badges (`store.ts`). | **Moves once leak 1 is cut.** |
| **Pause trap + Pause UI + memory Pause** (`index.ts:631-639`, `:496-497`, `:834`) | `pause-trap.ts`: none. `pause-trap-host.ts`: static via leak 1 (`→ agent-sdk`). `pause-ui-host.ts:8` `import { ipcMain } from 'electron';` with `pause:overview`, `pause:pause`, `pause:resume`, `pause:release` (`:94-105`). The watcher `startPauseUiWatcher` (`:137`) lives in the same file and pushes `pause:update`. | The Pause overview and badges (`store.ts`) ← `pause:update`. | **Needs a seam: registrar → transport.** Split `startPauseUiWatcher` / `broadcastPauseOverview` (host) from `registerPauseUiIpc` (glue). The trap and the memory Pause move unchanged. |
| **Memory guard, Admission, Docker hold, memory alert, memory notices** (`index.ts:467-475`, `:608-626`, `:641`) | None (walker: no path for `memory-guard`, `admission`, `docker-hold-host`, `memory-alert-host`, `memory-notice`, `memory-notice-bus`). The notices' live emit is injected (`sdkEmitMemNotice` → `agent:event`). | `bus-status` over the socket, Settings, and the agent view (via `agent:event`). | **Moves unchanged.** |
| **Memory banner** (`index.ts:643`, `:835`) | `memory-banner-host.ts:4` `import { ipcMain } from 'electron';`, which handles `memoryGuard:banner` (`:44`). It pushes `memoryGuard:bannerUpdate` through `platform.broadcast`. | App banner (`store.ts`). | **Needs a seam: registrar → transport** (`startMemoryBanner` `:51` is host-side). |
| **Resource monitor + reaper; Resources sampler** (`index.ts:530`; `resources:sample` `api-handlers.ts:368`) | Runtime `platform.getAppMetrics()` (`resource-monitor.ts:262`, `resources.ts:150`), backed by Electron's `app.getAppMetrics()` (`platform/electron.ts:111`). | Resources page (`ResourcesView.tsx`) ← `resources:sample` (a pull). | **Moves.** Seam: the daemon reports its own `/proc` sample (the deleted headless impl used `process.cpuUsage` and `rss`). "Electron processes" then means the app's processes, which only the app can report. |
| **Directory watchers** (`index.ts:473` `pushWatchersToRenderer()`, `:837` `registerWatchersIpc()`) | `watchers.ts`: runtime `platform.broadcast('watchers:update')` only. `watchers-host.ts:3` `import { ipcMain } from 'electron';` handles `watchers:status` (`:10`). | Watcher health (`store.ts`) ← `watchers:update`. | **Moves.** Registrar → transport for `watchers:status`. |
| **Sandbox transports + auto-backup** (`index.ts:538` `startSandboxAutoBackup()`; `closeAllSandboxConnections` in shutdown) | **Static** via leak 1 (`transport/sandbox-manager.ts` → `workspaces`). Runtime: `platform.getUserDataDir()` for the per-install owner `client-id` (`sandbox-manager.ts:161`) and `platform.broadcast('sandbox:control')` (`:343`). | `SandboxControlBar.tsx` ← `sandbox:control`. | **Moves once leak 1 is cut.** `client-id` is the ownership identity, so app and daemon must not both claim it (§4.1). |
| **PTYs: Run script, nvim, account-login terminals** (`pty.ts`, `transport/local-pty.ts`) | Runtime `platform.broadcastPtyData` / `canBroadcast` / `pty:exit`. The retention contract: when the window can't receive, delivery returns `false` and the caller keeps its buffer (`platform/electron.ts:27-36`). node-pty "is N-API (ABI-stable)" (`local-pty.ts:20`; `bus-binding.ts:7`). Static via leak 1. | `RunTerminal.tsx`, `NvimView.tsx`, `AccountLoginModal.tsx` ← `pty:data`. | **Needs a seam: a PTY byte stream with per-client replay** (the deleted ui-rpc used binary frames with scrollback on attach). Ownership is an open question (§5). |
| **Accès mobile sidecar** (`index.ts:463` `startAccesMobileHost()`) | **Static** via leak 3 (and leak 1 through `acces-mobile-feed → agent-sdk`). The server process already runs under `ELECTRON_RUN_AS_NODE: '1'` (`acces-mobile-host.ts:153`), spawned with `process.execPath` and an fd-3 pipe (`:162-163`). The feed is the `onBroadcast` tap (`acces-mobile-feed.ts:4`). | The phone, over the fd-3 RPC (`acces-mobile-host.ts:166`). No renderer. | **Moves**, and it should be spawned by the daemon so the fd-3 parent and the push tap stay in-process. Seam: `relaunchApp` / `appIdentity` (leak 3) — whose version, and which process is relaunched? |
| **Usage + account usage polling, account inheritance, Linear tickets / link backfill, loop scan, self-tune sweep** (`index.ts:363-366`, `:479-481`, `:534`, `:656`, `:1060`) | Runtime only: `getUserDataDir` (`usage.ts:77`, `self-tune.ts:54`), `getAppVersion` (`account-usage.ts:52`), `openPath` (`self-tune.ts:133`), and broadcasts (`usage:update`, `accounts:usageUpdate`, `accounts:workspaceAccounts`, `tickets:update`, `selfTune:*`). `loop-scan` and `linear-tickets` are static via leak 1. The account-usage API key goes through `safeStorage` (`account-usage.ts:307`). | Usage bars, account badges, ticket badges, Insights (`store.ts`). | **Moves.** Secrets seam as for agent sessions. |
| **Foundations: store, secrets, logger** (`index.ts:358` `store.load()`) | Runtime: `store.ts:103` `platform.getUserDataDir()` → `app.getPath('userData')` (`platform/electron.ts:91`), relocated by `app.setPath('userData', …)` when `ORCHESTRA_HOME` is set (`index.ts:168`). `logger.ts:102` `getLogsDir()` → `app.getPath('logs')`. `secrets.ts:85`, `:99-100`, `:132-133`, `:145` use `safeStorage`. | — | **Moves.** It needs a headless userData resolver (prior art: `defaultUserDataDir()`, deleted `headless.ts:28`) and a secrets decision (§4.3). |
| **Env bootstrap + CLI shims** (`index.ts:123` `stripProcessLocalEnv`, `:150-153` `shellEnvSync()`, `:1039` / `:1061` shim installs) | `cli-shim.ts:148-151` already branches on `process.versions.electron`: a plain-Node host gets `"node" cli.js`. | — | **Moves unchanged.** The daemon must run the same env repair before any spawn (a systemd or desktop launch gets a bare env; see the comment at `index.ts:126-139`). |
| **Stays in the app** | `index.ts:1` `import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron';`: window, crash and reload recovery, `dialog:pickDir` (`:859`), the dependency dialog. `browser-panel.ts:1`, `login-browser.ts:4` `import { BrowserWindow, Menu, clipboard, session, shell } from 'electron';`, `voice.ts:27` (`voice:*`), `app-update-host.ts:4` (`appUpdate:*`). | Browser pane ← `browser:event`, login modal ← `accounts:loginDone`, mic ← `voice:event`, update banner ← `appUpdate:update`. | **Stays in the app.** The api-handlers table (153 entries, `api-handlers.ts:252-406`) mixes host methods with frontend-local ones (`browser*`, `openExternal`, `accountLogin*`, `revealLogs`, `openSelfTuneReport`). It needs splitting. |

## 4. Constraints for #140

1. **Single-writer fences are Electron's today.** `index.ts:991-993`: "This is the only backend fence:
   Orchestra's backend runs exclusively inside the Electron main process", which is
   `app.requestSingleInstanceLock()` keyed by userData. Four things depend on it:
   - the hooks socket's one-binder guarantee (`hooks-server.ts:82`);
   - the events-spool startup wipe (`events-spool.ts:345-365`);
   - the `store.json` tmp+rename writer (`store.ts:199-205`);
   - the sandbox `client-id` owner.

   The daemon needs its own lock. Prior art is the deleted `backend-lock.ts` (`<home>/backend.lock`,
   pid-probed). A shadow-mode daemon (map Fog item 5) must not write any of these four.
2. **Runtime and ABI.** The AppImage ships only the ABI-130 better-sqlite3 (`bus-binding.ts:19-20`).
   So a daemon on system node needs a second binding build. The alternative is to run as
   `ELECTRON_RUN_AS_NODE=1 <AppImage>`, as the keeper fallback (`keeper-client.ts:508-522`) and Accès
   mobile (`acces-mobile-host.ts:153`) already do. node-pty is N-API, so it does not constrain this.

   Main is one CJS bundle (`vite.config.ts:16-21`, `main.js`), so the daemon needs its own entry.

   INFERRED: under `ELECTRON_RUN_AS_NODE` Electron's built-in APIs are unavailable, so the three
   leaks (§2) must be cut before the daemon bundle can boot.
3. **`safeStorage` is the hardest coupling.** Per-account API keys and the Linear key are encrypted
   with Electron `safeStorage` (`secrets.ts:132-133`). They are decrypted at agent spawn
   (`agent-sdk.ts:858`) and during usage polling (`account-usage.ts:307`). The deleted headless impl
   returned `isEncryptionAvailable() → false` (`headless.ts:172`), so `enc: true` secrets were
   unreadable. On this host `secrets.json` has `enc: false` (I read only the key names), so the gap
   would stay hidden here.

   INFERRED: this pushes the process-model choice toward one of three options:
   - a windowless *Electron* daemon (`app.whenReady` without a window);
   - re-encrypting through a keyring the daemon can reach;
   - the app handing keys to the daemon at attach.
4. **userData path parity.** `store.json`, `secrets.json`, `usage.json` and `client-id` live under
   `app.getPath('userData')`. On this host that is `~/.config/orchestra` (observed). With
   `ORCHESTRA_HOME` set it is `$ORCHESTRA_HOME/userData` (`index.ts:168`). The daemon must resolve the
   same directory without Electron.
5. **The attach protocol has to carry four things:**
   - 31 push channels (the preload list);
   - a PTY byte stream with the retention-or-replay contract (`platform/electron.ts:27-36`);
   - 153 table methods plus 6 registrar families (`bus:*`, `pause:*`, `memoryGuard:banner`,
     `watchers:status`, `appUpdate:*`, `voice:*`) and the two index.ts writes (`bus:setSwitches`,
     `bus:resolveHumanGate`);
   - client→host UI state: focus (`isFocused`), active workspace (`workspaces:setActive`), and
     window focus as the sync trigger (`index.ts:793`).

   With N clients (desktop and phone), "focused" and "active" need a definition.
6. **The events-spool drain is gated on an attached UI** (`events-spool.ts:172`). The deleted headless
   impl answered `uiClientCount() > 0` (`headless.ts:102`). INFERRED: a daemon with no client would
   stop draining. Activity would freeze, and liveness's idle clock with it. That is the exact
   "keep coordinating with the app closed" case the map wants.
7. **Human-blocking points need a client.** Permission replies (`agent:sdkPermissionReply`),
   AskUserQuestion, `/loginUrl` (an Electron window), MCP OAuth `openExternal`, `mcp__browser__*`
   (a `WebContentsView`) and `notify` toasts all need one. With no client attached, each must either
   queue or fail closed. The deleted impl forwarded `ui:notify` and `accounts:loginUrl` as events.
8. **Version skew.** Today four binaries share state:
   - the app and the CLI both migrate the bus (`cli/index.ts:785` `openBus`);
   - an older binary refuses a newer DB (`bus.ts:580` `if (current > SCHEMA_VERSION)` → throw);
   - the keeper is a byte-compared installed copy (`keeper-client.ts:487-489`).

   A daemon adds a fifth state-owner. "Relaunch" (`app-update-host.ts:101-117`, and the phone's
   `acces-mobile-routes.ts:136`) currently restarts the host and the UI together. Once they are split,
   the relaunch target must be chosen.

## 5. New questions surfaced (not yet on the map)

1. **Do Run-script, nvim and login PTYs move to the daemon, so they survive app close, or stay
   app-owned?** Hibernation reads `isRunning('<id>:run')` (`hibernation.ts:22`), and archive stops
   them (`workspaces.ts:643-644`). So they are host-coupled today.
2. **What does an agent's `mcp__browser__*` do with no app attached?** It could be refused, routed
   to a headless Chromium (the Reliquats browser bridge already manages orphaned headless Chromium),
   or kept app-only.
3. **Is `safeStorage` a requirement, or can secrets move to a daemon-reachable store?** This decides
   between an Electron-runtime daemon and a node one (§4.3).
4. **Revive the deleted ui-rpc (`edd73e17`…`572c8d2b`) as the attach protocol, or extend the hooks
   HTTP socket?** The removal commit gives the GTK frontend's removal as its reason, not a flaw in
   the daemon (INFERRED from the commit message).
5. **Should `hasAttachedUi()` gate anything in a daemon** (§4.6)? Its premise, "never consume events
   no UI can apply", stops holding once the host itself applies them.
6. **Two dead pushes: `bus:unavailable` (`index.ts:449`) and `watchdog:flap-limit`
   (`session-watchdog.ts:520`).** Neither has a preload subscriber. Wire them into the protocol or
   retire them?
7. **Split `api-handlers.ts`** into host-served and frontend-local tables before extraction, so the
   daemon bundle does not import `browser-panel` (`api-handlers.ts:152`)?
8. **Leak 1 is one archive-time call** (`workspaces.ts:653`). Does turning it into a
   "workspace archived" event also cover the agent-opened panel case its comment describes
   (`:645-652`) when the app is not running?
