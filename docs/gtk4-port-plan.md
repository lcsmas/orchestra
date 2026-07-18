# GTK4 Native Port — Full 1:1 Plan

*2026-07-18. Follow-up to `docs/native-ui-exploration.md` (feasibility) and
`prototypes/gtk4-shell/` (working VTE+Relm4 prototype). Goal set by the owner:
a **feature-complete native GTK4 Orchestra that lives alongside the Electron
app** — neither replaces the other; both stay installed, maintained, and
usable, including simultaneously.*

Everything below was inventoried from `docs/codebase-map/*.md` (all 11 docs)
and verified against `src/shared/ipc.ts` (105 API members: 83 request/response
methods + 22 push channels), `src/shared/types.ts`, and the component tree.
Line anchors reference v0.5.84+.

---

## 0. Definition of "1:1"

Behavioral feature parity: every capability, workflow, indicator, and
persistence behavior of the Electron app exists and behaves the same in the
GTK app. NOT pixel identity, and NOT identical internals. Known unavoidable
substitutions (all approved-by-plan, listed in §10):

| Electron | GTK | Consequence |
|---|---|---|
| xterm.js + WebGL | VTE 0.80 (GSK GPU) | different scrollback UX internals; faster |
| Monaco DiffEditor | GtkSourceView 5 dual-pane | same info (side-by-side, intra-line), different editor chrome |
| Chromium OAuth `BrowserWindow` | WebKitGTK 6 `WebView` | same isolation model (per-account data manager) |
| Web Audio chime synth | pre-rendered PCM via GStreamer | same ~20 sounds, synthesized offline to WAV at build time |
| CDP E2E harness | built-in remote-control debug socket (§8) | equivalent driveability, different protocol |

## 1. Architecture: one backend, N frontends

The heavy logic never leaves TypeScript. The port adds a **UI-RPC seam** in
front of the existing main process and a Rust/GTK client behind it.

```
                    ┌────────────────────────────────────────────┐
                    │  BACKEND (TypeScript, unchanged logic)     │
                    │  workspaces.ts git.ts activity.ts pty.ts   │
                    │  events-spool accounts usage self-tune     │
                    │  sandbox transports hooks-server store     │
                    ├────────────────────────────────────────────┤
                    │  NEW: platform seam (src/main/platform/)   │
                    │  NEW: ui-rpc server (src/main/ui-rpc.ts)   │
                    └───────┬──────────────────────────┬─────────┘
             hosts it as    │                          │  hosts it as
        ┌───────────────────┴───────┐      ┌───────────┴──────────────────┐
        │ Electron app (today's)    │      │ orchestra daemon             │
        │ + serves ui-rpc when run  │      │ (`Orchestra.AppImage daemon` │
        │                           │      │  or `node daemon.js`)        │
        └───────────▲───────────────┘      └───────────▲──────────────────┘
                    │ ipcRenderer (unchanged)           │ ui-rpc socket
        ┌───────────┴───────────────┐      ┌───────────┴──────────────────┐
        │ React renderer (unchanged)│      │ orchestra-gtk (Rust, NEW)    │
        └───────────────────────────┘      └──────────────────────────────┘
```

### 1.1 Coexistence contract (the "live together" rules)

1. **One backend per `ORCHESTRA_HOME` at a time** — enforced by extending the
   existing single-instance lock to the daemon (lockfile + liveness probe).
   Rationale: the events-spool startup wipe, store write serialization, and
   hooks-socket pointer all assume one owner (the documented two-instance
   stuck-dot hazard).
2. **The Electron app IS a valid backend host.** When it runs, it also serves
   the ui-rpc socket. A GTK frontend attaching to a running Electron Orchestra
   gets the same store, same PTYs, same everything — two faces, one state.
3. **The GTK app is a pure frontend.** On startup: discover ui-rpc socket
   (pointer file `~/.orchestra/ui-sock`, env `ORCHESTRA_UI_SOCK` override) →
   attach. If absent → spawn the daemon (`Orchestra.AppImage daemon`,
   discovered via the existing `~/.local/bin/orchestra` shim's APPIMAGE, else
   `$ORCHESTRA_DAEMON_CMD`) and attach. GTK app exit leaves the daemon running
   by default (agents keep working — same always-on philosophy as the sandbox);
   `--stop-daemon-on-exit` opts out.
4. **Multi-client is first-class.** The ui-rpc server accepts N concurrent
   clients (Electron renderer counts as an implicit client); events and PTY
   data broadcast to all; any client may write (same-user trust domain — this
   is NOT the sandbox driver model). The spool's "never consume without a
   renderer" guard generalizes to "without ≥1 attached UI client".
5. **Both apps ship from this repo, one release pipeline** (§9). Version
   numbers stay in lockstep; the ui-rpc protocol carries a version handshake
   and the frontend refuses a mismatched backend (clear error dialog, both
   directions).

### 1.2 The daemon

`src/main/daemon.ts` — a second entry that bootstraps the existing subsystems
without any `BrowserWindow`: shell-env merge, `ORCHESTRA_HOME`, store load,
hooks server, events spool, usage pollers, repo sync, self-tune scheduler,
sandbox auto-backup, orphan prune, cli-shim install, ui-rpc server. Runs under
BOTH the Electron runtime (`Orchestra.AppImage daemon` — canonical for users;
keeps `safeStorage`) and plain Node (`node dist-electron/daemon.js` — dev).
The **platform seam** (§4) makes the same modules work in all three modes
(Electron-GUI / Electron-headless / plain Node).

## 2. UI-RPC protocol (the contract — freeze FIRST)

Transport: Unix domain socket (Windows named pipe later; out of v1 scope),
mode 0600, path `$XDG_RUNTIME_DIR/orchestra-ui-<pid>.sock` + pointer file.
Framing: **reuse the sandbox-protocol codec** (`src/shared/sandbox-protocol.ts`
— 4-byte BE length + JSON, streaming decoder, 16 MiB cap) with a new frame
vocabulary; add one **binary frame type** (`0x01` prefix byte variant) for PTY
data so terminal bytes are never base64'd or JSON-escaped.

Frame types:

| Frame | Direction | Shape |
|---|---|---|
| `hello` | C→S | `{t:'hello', proto: 1, appVersion, clientKind:'gtk'\|'electron'\|'test', focused: bool}` |
| `helloOk` | S→C | `{t:'helloOk', proto: 1, appVersion, backendKind:'electron'\|'daemon'}` |
| `req` | C→S | `{t:'req', id: u32, method: string, params: unknown[]}` |
| `res` | S→C | `{t:'res', id, ok: true, result}` / `{t:'res', id, ok: false, error: {message, name?}}` |
| `event` | S→C | `{t:'event', channel: string, args: unknown[]}` — the 22 `on*` channels, channel names = today's IPC channel names |
| `ptyData` (binary) | S→C | `[0x01][u32 idLen][id utf8][bytes…]` |
| `ptyWrite` (binary) | C→S | `[0x02][u32 idLen][id utf8][bytes…]` (fast path; JSON `pty:write` req also accepted) |
| `focus` | C→S | `{t:'focus', focused: bool}` — feeds the `focused` flag on `agent:finished`/`needsInput` (any-client-focused = focused) |
| `ping`/`pong` | both | liveness, 15s idle |

**Methods = the `OrchestraAPI` interface verbatim** (`src/shared/ipc.ts:36`,
83 methods). The server is a mechanical table: method name → the same handler
`index.ts` registers for IPC today (refactor: extract handler registration
into `src/main/api-handlers.ts` consumed by BOTH `ipcMain.handle` wiring and
the ui-rpc server — single source of truth, no drift possible). Three methods
are **frontend-local by design** and NOT served over RPC (each frontend
implements natively): `pickDirectory` (GtkFileDialog), `openExternal`
(gtk::show_uri; backend keeps its own internal shell.openExternal for
main-side paths), `saveClipboardImage` stays an RPC (backend owns temp-file
I/O; bytes travel in the request).

New backend-side additions (small, additive, Electron app unaffected):

- `ui:notify` event `{wsId, kind:'finished'|'needsInput', title, body}` —
  emitted by `activity.ts` through the platform seam so a GTK client can post
  a native notification with click-to-focus. Electron mode keeps `new
  Notification()` behavior when no external client wants it (seam decides).
- `workspace:focusRequest` event (notification click → focus workspace n) —
  today's `onWorkspaceFocus` already covers this; reuse.
- `deps:status` req — expose the existing dependency probe (git/gh/claude)
  result so the GTK app can render the startup warning (today a
  `showMessageBox`).
- `app:info` req — version, backendKind, ORCHESTRA_HOME, log path.

**Conformance fixtures**: a script (`scripts/dump-rpc-fixtures.ts`) captures
real request/response/event JSON per method against a seeded store; the Rust
crate replays them in `cargo test` to prove serde compatibility. The fixture
corpus is regenerated in CI and drift fails the build on either side.

## 3. Repo layout

```
native/                      # Rust workspace (workspace Cargo.toml)
  orchestra-rpc/             # frame codec, typed OrchestraAPI client,
                             #   serde mirror of types.ts, conformance tests
  orchestra-gtk/             # the Relm4 app
    src/app.rs               # root component, window, layout grid
    src/sidebar/…            # §5.1
    src/terminal/…           # §5.2
    src/diff/…               # §5.3
    src/accounts/…           # §5.4
    src/resources.rs …       # §5.5
    src/theme.css            # ported palette (styles.css tokens)
    src/remote_control.rs    # §8 debug harness
  chime-gen/                 # build-time tool: synthesize the ~20 chimes to WAV
                             #   (port of chime.ts's oscillator recipes)
src/main/platform/           # NEW seam (electron.ts / headless.ts impls)
src/main/api-handlers.ts     # NEW extracted handler table
src/main/ui-rpc.ts           # NEW server
src/main/daemon.ts           # NEW entry
docs/ui-rpc-protocol.md      # NEW frozen spec (written in M0)
prototypes/gtk4-shell/       # kept as historical reference, not shipped
```

System deps (build): `gtk4-devel`, `vte291-gtk4-devel`, `gtksourceview5-devel`,
`webkitgtk6.0-devel`, `gstreamer1-devel` (runtime plugins base). All available
in Fedora/Debian repos; the rootless `.localdeps` trick from
`prototypes/gtk4-shell/setup-localdeps.sh` extends to CI-less dev boxes.

## 4. Backend workstream (TypeScript) — exact Electron touchpoints

Verified surface to abstract (from feasibility §2.1 + source):

| Touchpoint | Sites | Headless/daemon impl |
|---|---|---|
| `webContents.send` (~100 sites, 22 channels) | everywhere | `platform.broadcast(channel, args)` → Electron window AND ui-rpc clients |
| `dialog.showOpenDialog` | `index.ts:709` | frontend-local (§2) |
| startup `showMessageBox` | `index.ts:1196` | `deps:status` req + GTK dialog |
| `new Notification()` | `activity.ts:90-133` | seam: Electron native OR `ui:notify` event |
| `safeStorage` | `secrets.ts:67,81` | Electron: keep; plain Node: existing 0600 plaintext fallback path |
| `shell.openExternal/showItemInFolder/openPath` | `index.ts:426`, `logger.ts:122`, `self-tune.ts:142` | `xdg-open` spawn |
| `clipboard.writeText` | `login-browser.ts:49` | n/a in daemon (login browser is frontend-side in GTK, §5.4) |
| `app.getPath/getVersion` | store/usage/logs/etc | env-derived paths (ORCHESTRA_HOME already overrides); version from package.json |
| `app.getAppMetrics()` | `resources.ts:137` | daemon: own `/proc` self-sample (the file already samples /proc for agents); Electron rows appear only when Electron hosts |
| single-instance lock | `index.ts:1230` | shared lockfile protocol covering app+daemon (§1.1) |
| Ozone/Wayland relaunch | `index.ts:36-90` | Electron-only; daemon/GTK skip entirely |
| `BrowserWindow` (main + login) | `index.ts:314`, `login-browser.ts:66` | main window n/a; login browser moves frontend-side for GTK (§5.4) with a backend `loginUrl` event bridge |

Login-browser bridge detail: today `/loginUrl` (socket) and
`accounts:loginOpenUrl` (IPC) route claude-auth URLs into an Electron
`BrowserWindow` with partition `persist:claude-login-<id>`. Under the seam,
when the serving backend has no Electron (daemon) or the requesting client is
GTK, the URL is forwarded as event `accounts:loginUrl {accountId, url}` to
clients; the GTK app opens its WebKit window (§5.4). `isClaudeAuthUrl`
gating stays backend-side (single source of truth).

Deliverables: platform seam + api-handlers extraction + ui-rpc server + daemon
entry + fixtures dump script + vite config for `daemon.js` + tests (rpc server
unit tests with a fake client; spool multi-client gating; lock contention).
**The Electron app must be byte-for-byte behaviorally unchanged** when no
external client attaches — verified by running the existing test suite and the
sandbox `app-e2e.mjs` unmodified.

## 5. GTK frontend — complete feature inventory

Component-by-component parity ledger. Each ☐ is an acceptance-checkable item;
"anchor" = Electron source of truth for behavior questions.

### 5.1 Sidebar (anchor: `Sidebar.tsx`, 83 K — the biggest single workstream)

- ☐ Sections in order: Orchestrator trees → Scratch trees → per-repo groups
  (workspaces threaded as spawn trees) → Archived (collapsible).
- ☐ SpawnForest semantics: `childrenOf`/`roots`/`rootOf`; child of a live
  parent nests indented; dangling parent → floats to repo section; section
  count badges show ROOT count not row count.
- ☐ Subtree collapse: per-row caret on rows with children; depth-filtered
  render walk; hidden-descendant count pill tinted by most-urgent hidden
  status (error > waiting > running); persisted (ids).
- ☐ Host grouping within a repo (`host-grouping.ts` port): bucket per
  sandbox node, collapsible headers, all-local ⇒ flat identical list.
- ☐ Status dot: idle/running/waiting/error/stopped colors + glow, `unread`
  accent-blue override + bold name; live tool label (`agent:tool`) and
  context-tokens badge (`agent:context`, 0-sentinel resets).
- ☐ Row pills: diverged/merged/unpushed-↑N (merge-state), released-versions,
  PR badge (open/merged counts, click → PR URL), Linear issue badge (click →
  issue URL), size badge (btrfs exclusive vs apparent tooltip variant; hidden
  under 50 MB on active rows).
- ☐ Row actions: inline branch rename (with `branchManuallySet` pinning);
  unread toggle; archive/unarchive; delete (confirm dialog); switch-branch
  (BranchPicker popover); setup gear → RepoScriptsModal; ☁↑ import-to-sandbox
  (endpoint prompt) / ☁↓ eject by `ws.host`; account badge → migrate menu
  (WorkspaceAccountMenu equivalent, § 5.4).
- ☐ Drag-reorder workspaces AND repos (GTK drag-source/drop-target;
  `reorderWorkspaces`/`reorderRepos`).
- ☐ Repo header: name, base-branch sync pill (behind/ahead, syncing spinner,
  click = `syncRepoBase`), "+" new workspace (left-click default base;
  right-click → base-branch popover fed by `listRepoBranches`), settings gear.
- ☐ Archived section: collapse persist, multi-select, bulk delete with
  "Deleting N of M" progress (`onWorkspacesDeleteProgress`).
- ☐ New scratch / new orchestrator buttons; add-repo button (native folder
  picker → `addRepo`).
- ☐ Env notices from `getEnvStatus` (generic `EnvStatusItem` render;
  dismissed-state persisted).
- ☐ Insights section row (§5.5) between list and usage bars.
- ☐ Usage bars footer (§5.4) + Resources button + Help `?` button.
- ☐ Welcome empty state with `welcome-features` grid (anchor `App.tsx`).
- ☐ Sidebar width drag-resize, persisted.

### 5.2 Terminal stack (anchors: `Terminal.tsx`, `RunTerminal.tsx`,
`NvimView.tsx`, `term-write-queue.ts`, `pty.ts`)

Model: backend owns every PTY (unchanged — logging, coalescing, transports,
sandbox, scrollback, queue delivery all live there). The GTK terminal is a
**feed-mode VTE**: no `spawn_async`; `vte_terminal_feed()` renders backend
`ptyData` frames, the `commit` signal forwards keystrokes as `ptyWrite`,
GTK resize → `ptyResize`. This preserves — for free — every backend behavior:
8 ms/64 KiB coalescing + 150 ms echo fast-path, 2 MB scrollback ring replay,
SIGWINCH repaint bounce, sandbox reconnect banners, `pty:stopped` semantics.

- ☐ One kept-alive VTE per workspace in a GtkStack (scrollback survives
  switches — proven in prototype); lazy `ptyStart` on first visible fit.
- ☐ Scrollback replay on (re)mount via `readScrollback` → feed.
- ☐ ?2026 sync frames: VTE ≥ 0.76 handles mode 2026 natively (verify on real
  stream in M2; else port the write-queue frame-holding logic to the feed
  path). RAF-batching is NOT ported — VTE's GdkFrameClock scheduling replaces
  it (prototype: 19 MB/s with zero app-side batching).
- ☐ Boot pill: "Resuming previous session… / Starting agent…" overlay, shown
  on start, cleared at ≥2 KiB output / keystroke / exit / 20 s; 250 ms fade-in.
- ☐ `pty:stopped` + natural exit: "[agent stopped — press any key to
  relaunch]" notice; first keystroke on dead session triggers `ptyStart`
  (not forwarded).
- ☐ `pty:restart` event → clear + respawn flow (branch switch).
- ☐ Repaint-on-show: on tab activation/window focus call `ptyRepaint`
  (backend SIGWINCH bounce) — VTE needs no atlas clear, but the child-side
  reconvergence is still required (divergence is a child-diff-model issue).
- ☐ Keyboard parity: Ctrl+C copies selection else forwards; Ctrl+V text
  paste; Ctrl+V with image → GTK clipboard read → `saveClipboardImage` →
  bracketed-paste the path; Shift+Enter → ESC+CR.
- ☐ URL matching (VTE regex match) → frontend `gtk::show_uri`.
- ☐ Custom floating-scrollbar look (VTE in GtkScrolledWindow, styled overlay
  policy) — approximate, not pixel-cloned.
- ☐ Run terminal: Start/Stop buttons over `<id>:run` PTY (`runScriptStart/
  Stop/Status/Scrollback`), 5 k scrollback, same feed path.
- ☐ Nvim pane: `<id>:nvim` PTY, resizable split (width persisted), toolbar
  toggle.
- ☐ Font: JetBrains Mono w/ fallback; bundle the "Orchestra Symbols" subset
  font into the GTK build (fontconfig app-font load) so ①②③ metrics match.
- ☐ Terminal palette/colors from styles.css tokens (prototype's palette).

### 5.3 Main pane, toolbar, diff, dialogs (anchors: `App.tsx`,
`DiffView.tsx`, `BranchPicker.tsx`, `Dialog.tsx`, `SetupBanner.tsx`)

- ☐ Toolbar: base→feature branch chip (BranchPicker dropdown: searchable
  branch list, current-first, `switchBranch`); tabs Terminal / Diff / Run
  (Run only when run script configured); restart-agent button
  (`restartAgent`); run start/stop toggle; PR button (state from `findPR`,
  click opens PR / creation URL); nvim toggle; workspace title.
- ☐ Diff view: file list with +/- badges & A/M/D classification; side-by-side
  GtkSourceView panes with synced scroll, line-level add/del backgrounds,
  intra-line word highlights (`similar` crate), language by extension
  (SourceView language manager), read-only, 300 KB truncation notice; 4 s
  visible-poll preserving file selection; empty-state "no uncommitted
  changes" (diff is vs HEAD — same semantics).
- ☐ Merge button behavior = `mergeWorktree` ("requested" → agent-performed
  merge; show the same toast/pill flow).
- ☐ Dialog system: alert/confirm/error/success/prompt (single-line input)
  with tone styling, Enter/Esc, promise-shaped (GTK: AdwMessageDialog-like
  custom, since we stay pure GTK4: modal GtkWindow + transient-for).
- ☐ SetupBanner overlay while `setupStatus` running/failed: live log tail
  (`readSetupLog` poll), retry button (`retrySetup`).
- ☐ PromptQueueBanner: shown when account limited or queue non-empty;
  composer textarea queues via `queuePrompt`; list with per-item remove;
  "Send now" `flushQueuedPrompts`; limit state via shared `usageLimitedUntil`
  logic (port the pure function to Rust with fixture tests).
- ☐ SandboxControlBar: amber read-only banner + Take control
  (`sandboxControlState`/`takeSandboxControl`/`onSandboxControl`).
- ☐ Overlays never unmount terminals (GtkStack + overlay pattern from
  prototype; Resources/Insights/Help are GtkOverlay children).
- ☐ Esc closes topmost overlay; overlay mutual exclusion (help vs insights).
- ☐ View state: `activeId`, per-workspace tab selection, `markSeen` on
  select, unread auto-clear on select.

### 5.4 Accounts, usage, login, queue (anchors: `AccountsSettings.tsx`,
`AccountLoginModal.tsx`, `AccountBadge.tsx`, `UsageBars.tsx`,
`login-browser.ts`)

- ☐ UsageBars strip: 5h/7d bars (+Fable bar when present), account name on
  5h head, "updated Xm ago" on 7d head, hover panel of all accounts sorted
  hottest-first with per-row bars/errors/expiry; color tint ≥75 warn / ≥90
  crit; `loginColor` stable HSL hash (port).
- ☐ AccountsSettings window: add/edit/remove accounts (label + configDir
  template with `~`/`${VAR}` expansion preview), scratch-default radio-like
  checkbox, inheritance checkboxes/chips from `listGlobalInheritables`,
  save → `setAccounts`; per-repo account assignment (`setRepoAccount`) in
  RepoScriptsModal.
- ☐ AccountLoginModal: VTE (feed-mode) hosting `account-login:<id>` PTY via
  `accountLoginStart/Stop`; link-click routing via `accountLoginOpenUrl`;
  closes on `onAccountLoginDone`; then `refreshAccounts`.
- ☐ **Per-account OAuth browser window (GTK-side)**: WebKitGTK 6 WebView with
  a per-account persistent `WebsiteDataManager` (base dirs under
  `<userData>/gtk-login-partitions/<id>`), UA string stripped of
  Orchestra/WebKit-specific markers mirroring `login-browser.ts:35-38`
  behavior, opened on `accounts:loginUrl` events (§4), right-click →
  open-in-system-browser escape hatch, closed on login-done/stop. Backend
  keeps `isClaudeAuthUrl` gating.
- ☐ Workspace/repo account badges + WorkspaceAccountMenu (migrate to
  account / default login → `migrateWorkspaceAccount`, busy state, error
  dialog on failure).
- ☐ Context badge (`WorkspaceContextBadge` port — token count formatting).

### 5.5 Resources, Insights, Help, Sound (anchors: `ResourcesView.tsx`,
`Insights.tsx`, `Help.tsx`, `SoundSettings.tsx`, `chime.ts`)

- ☐ Resources overlay: 2 s visible-poll of `sampleResources`; stat tiles
  (agent CPU + fleet sparkline, agent mem, app mem, worktrees disk, live
  count); Agents table (dot, branch, session-kind chips, 3-min CPU trace
  sparkline (90 samples, client-side ring), cpu/mem/procs/disk/ctx, expand →
  process list, per-row stop with mid-turn confirm → `stopAgent`, remote
  "runs in sandbox" note); App processes table; Token usage by login cards
  (meters incl. Fable/extra, reset countdowns, error/expired notes, pinned
  workspaces, hottest-first); data-on-disk section. CPU/mem stay accent-hued;
  yellow/red reserved for token limits.
- ☐ Insights: sidebar section row (idle summary / per-step spinner rows);
  full overlay with run history (click-to-select), step list, live transcript
  (`getSelfTuneOutput` seed + `onSelfTuneOutput` append into a scrolled
  monospace view), Run-now (`startSelfTune`), per-login open-report buttons
  (`openSelfTuneReport`), LESSONS.md read-only panel with added-bullet
  highlights and "N new since last run" header, lessons-diff block.
- ☐ Help overlay: static per-feature-area guide content (port copy), link to
  docs/guide/.
- ☐ Chime: `chime-gen` renders the ~20 `chime.ts` recipes to WAVs at build
  time; playback via GStreamer (`playbin`); plays on `agent:finished` when
  workspace not focused; SoundSettings picker with preview, persisted.
- ☐ Desktop notifications (GNotification): "finished" / "needs input" with
  click-to-present + select workspace; suppressed when focused (parity with
  `fireFinished`/`fireNeedsInput` focus logic via the `focus` frame).

### 5.6 App shell & persistence

- ☐ gtk::Application id `dev.orchestra.gtk` (DBus single-instance of the
  FRONTEND; the backend lock is separate, §1.1).
- ☐ Frontend state file `$ORCHESTRA_HOME/gtk-ui-state.json`: sidebar width,
  nvim width, collapsed sections, collapsed subtree ids, dismissed env
  notices, chime selection, last active workspace, window geometry — the
  localStorage parity list.
- ☐ Theme: port styles.css tokens (already done in prototype) + full CSS
  pass for all new widgets; light theme NOT ported (Electron app is
  dark-only — parity).
- ☐ Startup dependency warning (`deps:status`) dialog.
- ☐ Version display + backend-kind indicator (subtle footer text: "backend:
  electron|daemon vX.Y.Z").
- ☐ Renderer-log forwarding (`log` method) for GTK-side warnings so
  diagnostics land in the shared orchestra.log; `revealLogs` menu item.
- ☐ `orchestraDebug` equivalent: `ORCHESTRA_GTK_DEBUG=1` env + runtime toggle
  writing the same diagnostic log.

## 6. What does NOT change (explicitly out of the port)

- All hooks scripts, the events spool, the `orchestra` CLI, the hooks socket
  routes, sandbox shim/image/protocol, release tooling for Electron, the
  React renderer, self-tune pipeline — untouched (backend-side).
- Windows/macOS for the GTK app: out of v1 scope (Linux/Wayland first; the
  Electron app remains the cross-platform face).
- The tmux session broker (feasibility rec #1) is orthogonal and NOT part of
  this plan.

## 7. Rust engineering standards

- Workspace pinned: gtk4-rs 0.11.x / relm4 0.11 / vte4 0.10 / sourceview5 /
  webkit6 / serde / tokio (socket IO) / similar / gstreamer-rs. `cargo clippy
  -D warnings`, `cargo fmt --check` in CI.
- serde structs mirror `types.ts` field-for-field (camelCase rename-all);
  every optional TS field is `Option<T>`; unknown-field tolerance ON
  (backend may be newer). Conformance fixtures (§2) are the drift gate.
- Relm4 structure: one root component; factories for sidebar rows (live
  updates — unlike the prototype's static list); message enums mirror event
  channels; a single `RpcHandle` (tokio task + channels) owns the socket.
- No `unsafe` except where a binding requires it (none known).

## 8. Testing & verification strategy

1. **Backend**: existing `node --test` suite must stay green untouched; new
   tests for api-handlers extraction, ui-rpc server (fake client), multi-
   client spool gating, lock contention, daemon boot under plain node.
2. **Contract**: fixture conformance both directions (§2), protocol version
   handshake tests.
3. **Rust unit**: pure logic ports (usageLimitedUntil, loginColor hash,
   forest/tree building, host grouping — each with fixture parity against the
   TS originals' test vectors).
4. **Remote-control harness** (the CDP replacement, built in M1 not last):
   `orchestra-gtk --remote-control <sock>` opens a JSON debug socket:
   `{list_widgets}`, `{click: name}`, `{type: text}`, `{screenshot: path}`,
   `{get: property}` — implemented over GTK's widget tree + accessible names.
   Compiled in always, activated only by flag (same trust model as
   `ORCHESTRA_DEBUG_PORT`). All E2E flows drive this inside headless sway
   (recipe proven; seat-input limitation is exactly why this harness exists).
5. **E2E parity walks**: scripted scenarios against a seeded
   `ORCHESTRA_HOME` (fixtures from `orchestra-e2e-seeding` memory): create/
   spawn/rename/archive/delete; terminal roundtrip incl. claude TUI; diff on
   a dirty worktree; account login (up to the human-click OAuth wall —
   documented manual step); queue add/flush; resources stop/relaunch;
   insights run with `ORCHESTRA_SELF_TUNE_CMD` fake; sandbox import/eject
   against a local container (reuse `sandbox/app-e2e.mjs` seeding approach).
6. **Coexistence tests**: Electron GUI + GTK attached simultaneously (both
   see the same workspace update within 1 s; PTY typed from either renders
   in both); daemon lock vs Electron lock mutual exclusion; version-mismatch
   refusal.
7. **The parity ledger itself** (§5's ☐ lists) is the release gate: every box
   checked with a linked E2E script or manual verification note.

## 9. Packaging, release, CI

- `cargo build --release` wired into `package.json` scripts
  (`build:gtk`) but NOT into the default `pnpm run build` (Electron release
  cadence must not grow a Rust toolchain dependency overnight). Separate CI
  job (matrix: x64 + arm64, Fedora + Ubuntu containers) builds
  `orchestra-gtk-<arch>` binaries; `release.sh` gains `--with-gtk` to attach
  them to the same GitHub release. `.desktop` file "Orchestra (Native)",
  icon reuse from `build/icon.svg`.
- Version lockstep: the Rust crate reads version from the repo `package.json`
  at build time (build.rs) — one bump, both artifacts.
- Docs: `docs/gtk-app.md` (install, daemon modes, coexistence rules,
  troubleshooting), update `docs/codebase-map/` with a `native-ui.md` doc +
  routing-table row (per repo convention).

## 10. Risks & mitigations

| Risk | Level | Mitigation |
|---|---|---|
| VTE feed-mode gaps (mode 2026 through feed, huge replays) | M | M2 spike week 1: replay real Claude PTY logs through feed-mode VTE (the terminal-garble playbook's corpus); fallback = port write-queue holding logic |
| WebKitGTK OAuth acceptance (Google embedded-webview blocks) | M/H | mirror UA strategy; system-browser escape hatch exists; worst case documented manual flow (matches the known attestation wall) |
| serde/type drift over time | M | fixtures in CI both sides; unknown-field tolerance; protocol version handshake |
| api-handlers refactor destabilizes Electron app | M | mechanical extraction PR gated on full existing test suite + `app-e2e.mjs`; zero behavior changes allowed in that PR |
| Side-by-side diff quality vs Monaco | M | accept "different chrome, same information" (§0); intra-line via `similar`; ship unified-view toggle as bonus |
| Two-frontend write races (both type into one PTY) | L | same-user trust; PTY input interleaving is inherent (same as two keyboards); no gating by design |
| GTK a11y/remote-control harness underpowered vs CDP | M | build it FIRST (M1), treat as product code with tests; AT-SPI fallback |
| Scope: Sidebar.tsx is 83 K | H | dedicated workstream + the ledger; factories from day one; explicit sub-milestones inside WS-Sidebar |

## 11. Swarm execution plan

Method: `verified-fanout` — N implementation agents in isolated worktrees +
ONE build-verifier agent gating merges into the integration branch
(`gtk4-native-port`). I (this session) stay orchestrator: brief agents, review
interfaces, sequence merges, keep this plan current.

### M0 — contract freeze (orchestrator, this session, before spawning)
Write `docs/ui-rpc-protocol.md` (from §2), scaffold `native/` workspace with
`orchestra-rpc` skeleton types. Everything downstream codes against it.

### M1 — foundation (3 agents + verifier, parallel)
- **A1 backend-seam**: platform seam, api-handlers extraction, ui-rpc server,
  daemon entry, locks, fixtures script, tests. Definition of done: daemon
  boots under node + AppImage, serves all 83 methods + 22 events, Electron
  app regression-free.
- **A2 rpc-crate**: `orchestra-rpc` — codec (binary frames incl. pty),
  typed client, serde types for ALL of types.ts, conformance test rig
  consuming A1's fixtures, tokio connection actor w/ reconnect.
- **A3 gtk-skeleton**: window/layout/theme/settings-file/dialog system/
  single-instance/daemon-discovery+spawn/remote-control harness/headless-sway
  CI screenshot smoke. Uses mocked RpcHandle until A2 lands, then wires real.
- **V verifier**: owns a full env (node+pnpm+rust+localdeps+docker+headless
  sway); every merge = tsc + vite build + node tests + cargo build/clippy/
  test + smoke screenshot + Electron regression suite.

M2 cleanup backlog (pre-existing issues surfaced by M1 verification, fix
deliberately, not smuggled in): `logger.ts` primary sink hardcodes
`~/.orchestra/logs` even when `ORCHESTRA_HOME` overrides the home — an
isolated daemon/dev instance writes the user's real log file — and
`app:info.logPath` reports that out-of-home path. Fix = derive the primary
sink from `ORCHESTRA_HOME`, with its own regression note (affects Electron
dev instances too).

### M2 — feature workstreams (6 agents + same verifier; spawn as M1 merges)
- **B1 sidebar** (§5.1 ledger)
- **B2 terminals** (§5.2; includes the VTE feed spike as task 1)
- **B3 diff+toolbar+dialog-flows** (§5.3)
- **B4 accounts+login-browser+queue** (§5.4)
- **B5 resources+insights+help+sound** (§5.5)
- **B6 packaging+CI+e2e-scenarios+docs** (§8.5, §9)

Interface discipline: B-agents may NOT touch `orchestra-rpc` types or the
protocol; contract changes go through the orchestrator (one PR, fixtures
regenerated, both sides updated atomically).

### M3 — parity audit
One agent walks every ☐ in §5 against the live app pair (Electron vs GTK,
same seeded home), files gaps, orchestrator triages, B-agents fix. Release
gate: ledger 100 %, coexistence tests green, docs done.

Fixture-corpus extension (from the M1 A1 report — diff/branch shapes are
already captured off a seeded dirty repo; `fixtures/manifest.json` lists the
rest with reasons): the uncaptured result shapes are create* (random branch
labels), sandbox ops (need a live endpoint), PTY-spawning methods,
startSelfTune, findPR/verifyLinear with real remote data, worktree
sizes/resources (machine state), syncRepoBase (network). Close the two
highest-drift-risk ones in M3: a recorded-gh-response seam for `findPR`, and
a fake-sandbox endpoint for the import/eject/control shapes.

Estimated effort (from prototype calibration): M0 ≈ a session; M1 ≈ 1–2 weeks
of agent-time; M2 ≈ 3–6 weeks wall-clock with 6 parallel agents (Sidebar and
Accounts are the long poles); M3 ≈ 1 week. Consistent with the 2–3 month
full-parity estimate in `prototypes/gtk4-shell/NOTES.md`.
