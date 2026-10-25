# What Orchestra could take from Orca (browser, architecture, Linux)

Compiled 2026-10-25. Companion to [`orca-model-lineage.md`](orca-model-lineage.md), which covers where orca's fleet bus
comes from, and [`sota-multi-agent-orchestration.md`](sota-multi-agent-orchestration.md). Orca's bus mechanisms are already
inventoried in [#104](https://github.com/lcsmas/orchestra/issues/104), [#106](https://github.com/lcsmas/orchestra/issues/106),
[#110](https://github.com/lcsmas/orchestra/issues/110), [#267](https://github.com/lcsmas/orchestra/issues/267) and
[#268](https://github.com/lcsmas/orchestra/issues/268). This note covers the bus only where something changed after 2026-10-04 (§6).

**Pinned shas** (all read this session):

| Repo | sha / tag | date |
|---|---|---|
| [stablyai/orca](https://github.com/stablyai/orca) (shallow clone, depth 100, read only, nothing executed) | `6b255983ae39934fb411cdfb9287f6d6fa527674` | 2026-10-25T06:17-07:00 |
| orca latest release | [`v1.4.240`](https://github.com/stablyai/orca/releases/tag/v1.4.240) | 2026-10-25T04:02Z |
| Orchestra (this repo) | `e89f21d0` (v0.5.352) | `git rev-list --count HEAD..origin/master` = **0** |

Orca's `package.json` at that sha says `1.4.214`, while releases are at 1.4.240. CI stamps the release version, so
`package.json` is not the shipped version. Orca anchors below are `path:line` at `6b255983`.

Tags: **VERIFIED** = I read the file, release or PR this session. **VERIFIED (sub-agent, spot-checked)** = found by a read-only
sub-agent, with the key lines re-read by me. **INFERRED** = my reasoning, not stated by a source. **UNVERIFIED** = not read.

---

## Question

What could Orchestra take from Orca, the competing Electron app for parallel coding agents in git worktrees, now that it
ships on Linux? Two areas get special attention: (1) the embedded browser, and (2) the overall architecture. For each item: does
Orchestra already have it, have a weaker version, or lack it?

**One correction to the premise.** Linux is not new for Orca. The first published release,
[`v1.0.12`](https://github.com/stablyai/orca/releases/tag/v1.0.12) (2026-03-21, four days after the repo was created on
2026-03-17), already shipped an AppImage and an amd64 `.deb`. Later additions:

- **`.rpm` target**, plus renaming the CLI to `orca-ide`: [PR #3025](https://github.com/stablyai/orca/pull/3025), merged 2026-05-29.
- **Linux arm64** AppImage/deb/rpm: [PR #4755](https://github.com/stablyai/orca/pull/4755). It was opened 2026-06-06, one RC was built from it the same day (`v1.4.51-rc.1`), it merged 2026-06-22, and the first stable release with arm64 was `v1.4.92` on 2026-06-23.

All VERIFIED through `gh api repos/stablyai/orca/releases` (986 releases) and the two PRs.

## Short answer

Ranked by value for Orchestra divided by effort:

1. **Pick a working Linux keyring on sway (tiny effort, real security bug).** On compositors Chromium does not recognise (sway,
   Hyprland, river, niri), `safeStorage` falls back to `basic_text` or reports itself unavailable. Orca selects
   `--password-store=gnome-libsecret` before `ready`, but only when an **unlocked** Secret Service collection exists
   ([#21827](https://github.com/stablyai/orca/issues/21827); `src/main/startup/select-linux-keyring-backend.ts`,
   `linux-keyring-backend-selection.ts`). **On this host Orchestra's Linear API key is stored in plaintext.**
   `~/.config/orchestra/orchestra/secrets.json` has `enc=false`; the file is mode 0600, and the plaintext path is
   `src/main/secrets.ts:99-107` (VERIFIED, value not read). Caveat: at check time nothing owned `org.freedesktop.secrets` on the
   session bus, so porting the selector alone does not fix this host. A Secret Service provider must also be running.
2. **A per-workspace loopback CDP proxy over `webContents.debugger`, driven by an off-the-shelf CDP client (medium effort).**
   Orca does not hand-write browser tools. Each tab gets a `127.0.0.1:0` WebSocket that fakes the browser-level `Target.*` and
   `/json` surface for that one page. Orca then runs the vercel-labs `agent-browser` CLI against it, which provides snapshot
   with `@eN` refs, console, network, HAR, request interception, cookies, dialogs, downloads, viewport and PDF. Orchestra
   hand-codes 8 MCP tools (§2.2).
3. **Screenshots that work while the panel is in the background (medium effort).** Orca combines `webContents.invalidate()`,
   1×1 frame probes at 250/750/1750/3750 ms, an 8 s deadline, a `capturePage()` fallback and a renderer "paint hold" lease.
   Orchestra documents that a non-composited view gives no frames and refuses `screenshot`/`click`/`type`/`scroll` for
   background workspaces (§2.3).
4. **Persistent named browser profiles, cookie import, and OAuth-safe popups (medium effort).** Orchestra's partition is
   non-persistent and per workspace, so every workspace starts logged out. It also loads every popup into the same view,
   which breaks `window.opener`-dependent OAuth (§2.4).
5. **Design-mode upgrades (small effort).** Orca reads the React fiber `_debugSource` to get the component name and
   `file:line`, draws its overlay inside a closed shadow root, and has a markup (draw-on-screenshot) mode. Orchestra already
   has the picker (§2.5).
6. **A pinned, hash-checked Node bundled in the AppImage for detached daemons (small to medium effort).** It comes with a
   packaging-time PTY round-trip smoke test. Orchestra's keeper runs on whatever `node` is on PATH under an AppImage, and
   otherwise on the AppImage's own binary, which can disappear when the mount goes away (§4).
7. **Scheduled automations (medium effort).** Cron/RRULE schedules with a cheap shell `--precheck` that records a skipped run,
   targeting a repo (new worktree) or an existing workspace. Orchestra has nothing comparable (§3).
8. **Remote structured sessions via a deployed host runtime (large effort, strategic).** Orca deploys `orcad` over SSH. The
   remote host runs PTYs **and** the Claude Agent SDK chat, and the laptop pairs through a tunnel. That is the shape Orchestra's
   paused sandbox agents need ([#220](https://github.com/lcsmas/orchestra/issues/220): reconcile sandbox agents with the Agent
   view; see `docs/codebase-map/sandbox-transport.md` §PAUSED).

---

## 1. Orca at a glance (VERIFIED unless tagged)

- **Product:** "The AI Orchestrator for 100x builders… Run Codex, ClaudeCode, OpenCode or Pi side-by-side — each in its own worktree" (`README.md`). MIT licence, about 105k stars (`gh api repos/stablyai/orca`).
- **Release cadence:** about 1 release/day, stable plus RC; hourly, daily and adhoc channels publish to **separate repos** (`orca-hourly`, …) so they don't evict stable releases from the ten-entry update feed (`config/electron-builder.config.cjs:95-104`).
- **Stack:** Electron **43.8.1** (Orchestra: `^33.2.1`), `node-pty`, xterm.js **6.1 beta** with WebGL, Monaco, `@anthropic-ai/claude-agent-sdk` 0.3.284, `agent-browser ~0.27.0`, `electron-updater`, `playwright-core` (`package.json:212-324`).
- **Engineering style worth noting:** a lint gate built from about 25 **ratchet** scripts, each with a checked-in baseline file (`check:max-lines-ratchet`, `check:flaky-test-pattern-ratchet`, …; `package.json` `lint`; `config/*-baseline.txt`). Also `pnpm fixtures:shot <id>`, which screenshots presentational components without starting Electron (`AGENTS.md`).
- **Doc vs code mismatches.** Orca's docs site (`docs/site/content/docs/**`) overstates three things, so I trust the code:
  - Design Mode's "cropped screenshot sent as one attachment": saved annotations drop the screenshot (`src/shared/browser-grab-types.ts:89-92`).
  - Usage tracking's "No API calls": it does call `https://api.anthropic.com/api/oauth/usage` (`src/main/rate-limits/claude-oauth-usage-request.ts:18`).
  - "Attribution" of AI lines in the diff gutter (`review/attribution.mdx`): `grep -ril attribution src` finds no line-provenance code.

## 2. Browser deep dive

### 2.1 Architecture side by side

| | Orca | Orchestra (`docs/codebase-map/browser-panel.md`) |
|---|---|---|
| Page host | `<webview>` created **in the renderer**, one per tab, many tabs per worktree (`src/renderer/src/components/browser-pane/host-guest/browser-page-webview.ts:55-83`). Panes are positioned with a CSS anchor and never reparented, because reparenting destroys the guest (`…/BrowserPaneOverlayLayer.tsx:21`). Main checks every attach against an allowlist of partitions and refuses renderer-supplied preloads (`src/main/window/main-window-webview-security.ts:55-75`) | `WebContentsView` owned by **main**, one per workspace, overlaid on a placeholder rect (`src/main/browser-panel.ts`). It paints above the DOM, so it must be hidden under every modal |
| Headless | `OffscreenBrowserBackend`: a hidden sandboxed `BrowserWindow` per page for `orca serve` (`src/main/browser/offscreen-browser-backend.ts:12-58`); Xvfb is started automatically on Linux (`src/main/startup/ensure-virtual-display.ts`) | none |
| Agent transport | CLI → NDJSON over a 0600 unix socket → main RPC `browser.*` → `AgentBrowserBridge` → spawns `agent-browser --session orca-tab-<id> --cdp <port> <cmd> --json` (`src/main/browser/agent-browser-bridge-execution.ts:85-91`) → `CdpWsProxy` → `webContents.debugger` | in-process SDK MCP server `mcp__browser__*` (`src/main/agent-browser-tools.ts`) → `webContents.debugger` / `capturePage()` |
| Tool surface | snapshot, screenshot, click, fill, type, goto, eval, wait, tab list/create/switch/close, cookie, viewport, intercept, HAR capture, console, network, mouse, set device/offline/headers/credentials, dialog, storage, download, highlight, exec (`src/cli/specs/browser-basic.ts:25-258`, `browser-advanced.ts:6-260`) | navigate, read_page, screenshot, click, type, form_input, evaluate, scroll |
| MCP | **none**; agents use the `orca` CLI from a skill | yes (in-process SDK MCP) |
| External debug port | none in production. The proxy port is internal to the bridge (sub-agent; `--remote-debugging-port` appears only in test probes) | none in a packaged app by default; dev builds or a set `ORCHESTRA_DEBUG_PORT` open an app-wide port with `remote-allow-origins=*` (`src/main/index.ts:348-354`) |

Both apps rejected an app-wide `--remote-debugging-port` for the same reason: it would expose the app's own renderer as a
target. Orca's answer is a **per-page** debug endpoint that Orca itself serves.

### 2.2 Mechanism to port: the per-page loopback CDP proxy (VERIFIED)

- `src/main/browser/cdp-ws-proxy.ts:69-133`: an http + ws server on `listen(0, '127.0.0.1')` for each tab session.
- `src/main/browser/cdp-loopback-request-guard.ts`: rejects any request that carries an `Origin` header, and any `Host` other than `127.0.0.1:<port>`/`localhost:<port>`. This blocks web pages and DNS rebinding.
- `src/main/browser/cdp-target-discovery.ts:17-79`: **fakes the browser-level surface** for a single page. It answers `/json/version` and `/json/list`, `Target.getTargets`/`getTargetInfo`/`setDiscoverTargets`/`attachToBrowserTarget`/`attachToTarget`/`detachFromTarget`, and `Browser.getVersion`. That is what lets a stock CDP client (Playwright-style `connectOverCDP`) treat one `webContents` as "a browser".
- `cdp-ws-proxy.ts:173-262` intercepts some methods instead of forwarding them:
  - `Page.bringToFront`/`Target.activateTarget` are acknowledged without taking focus.
  - `Page.captureScreenshot` and `Page.printToPDF` go to native paths.
  - `Input.*` is routed to the guest.
  - `Page.navigate`/`reload` run with lifecycle-event replay.
  - Everything else is forwarded to `webContents.debugger` (`cdp-debugger-channel.ts:23-35`; attach fails if DevTools is open on that tab).
- Snapshot refs (`@e1`, …) are per tab and go stale after navigation; a stale ref maps to `browser_stale_ref` (`agent-browser-bridge-process.ts:94-99`, sub-agent).

**For Orchestra (INFERRED):** keep the SDK MCP entry point, but put a `CdpWsProxy` per workspace behind it. Then either shell
out to `agent-browser` (a bundled per-arch binary, `electron-builder.config.cjs:633`), or point `chrome-devtools-mcp` at
it. Either way agents get console logs, network, HAR, dialogs and cookies without new hand-written tools. This keeps
Orchestra's existing invariant, "a workspace's agent can only drive its own panel": the proxy is keyed by `wsId`. Two
constraints:

- **One debugger attach per target.** Orchestra already routes design mode through the shared `cdp()` helper for this reason, so the proxy must become the only attacher.
- **No new tabs.** `Target.createTarget` is unsupported in Electron (browser-panel.md), so a tab-creating client must be mapped onto Orchestra's own panel creation.
- UNVERIFIED: whether `chrome-devtools-mcp` (puppeteer) works against a faked single-page browser target.

### 2.3 Mechanism to port: screenshots while the panel is hidden (VERIFIED)

- `src/main/browser/cdp-screenshot.ts:10-12,136-184,232-282`:
  - before `Page.captureScreenshot` it calls `webContents.invalidate()`;
  - it schedules cheap 1×1 JPEG **frame probes** at `[250, 750, 1750, 3750]` ms, which "can produce the frame needed by the pending capture";
  - it bounds the stall under agent-browser's 30 s timeout;
  - it falls back to `webContents.capturePage()` with a 1 s timeout;
  - full-page capture uses `Page.getLayoutMetrics` + `captureBeyondViewport`.
- Paint hold: `src/main/browser/browser-manager-visibility.ts:9-39`. `holdPaintForCapture` counts holds per page and sends `browser:capturePaintHold`. The renderer takes an "automation visibility lease" that lifts throttling for the guest (sub-agent: `browser-automation-visibility.ts:62-80`).
- Focus: agent input is guarded so it never steals the user's focus (sub-agent: `agent-input-focus-guard.ts`).

**For Orchestra (INFERRED):** this does not transfer one-to-one. Orca's `<webview>` stays in the DOM, so it can be kept
painted while visually hidden. Orchestra's `WebContentsView` produces **no** frames while detached, and its doc measured
0x0 or hanging captures. The portable parts are the invalidate + probe + deadline + fallback chain. For the background
case, the analogue is Orca's `OffscreenBrowserBackend`: a hidden `BrowserWindow` per background panel, or re-hosting the
same `webContents` there. That would lift Orchestra's `requireComposited()` refusal for background agents.
UNVERIFIED: whether a `show:false` window paints on Electron 33 under sway.

### 2.4 Profiles, cookies, popups (VERIFIED sub-agent, partition names spot-checked)

- **Partitions:** the default is `persist:orca-browser` (`src/shared/constants.ts:48`). Each named profile gets `persist:orca-profile-<seg>-browser-session-<id>` (`src/shared/orca-profiles.ts:343-353`). Agents use the profile active in the pane (`docs/site/content/docs/browser/profiles.mdx`).
- **Cookie import** from Chrome, Edge, Brave, Arc, Helium, Firefox and Safari (`src/shared/browser-cookie-import-sources.ts`; pipeline `src/main/browser/cookies/`). On Linux, Chromium v10 cookies use the `peanuts` key and v11 cookies fetch their key with `secret-tool lookup` (`cookies/sources/browser-cookie-key.ts:34,68-82`).
- **Popups:** `_blank` and unnamed popups become tabs, and page-initiated popups (no user gesture) count against a budget. Popups that depend on `window.opener`, such as OAuth, get a **native child window** (`browser-manager-guest-popup-policy.ts:30-80`).
- **Other:** per-profile permission prompts that can be remembered; HTTP auth; certificate-error proceed; a WebAuthn account picker; a scoped Google sign-in UA; a downloads shelf.
- **Dev-server discovery:** URLs printed in PTY output plus a listening-port scan appear on the new-tab page (`src/main/ports/advertised-url-watcher.ts`, `local-workspace-port-scanner.ts`).
- **Orchestra:** the partition is `orchestra-browser-<wsId>` and deliberately **not** `persist:` (`src/main/browser-panel.ts:123-129`). The popup handler loads every http(s) popup into the same view and denies the window (`:228-235`), so opener-based OAuth flows cannot complete. There are no profiles, no cookie import and no downloads handling. `browser-panel.ts` has no `will-download` or `setPermissionRequestHandler`, which is one search surface (VERIFIED by grep).

### 2.5 Design mode: Orchestra already has it, three small upgrades

- Orchestra built it as "Orca parity" (`browser-panel.md` §Design mode): an in-page overlay, `outerHTML`, a computed-style subset, a cropped screenshot and a selector path, delivered into the composer.
- Orca's version (`src/main/browser/grab-guest-*.ts`; VERIFIED for the React part):
  - **React component name and source `file:line`** from `fiber._debugSource` (`grab-guest-react-script.ts:73-75`), with a secret filter. This is the most useful addition: the agent gets the file to edit, not only a selector.
  - The overlay lives in a full-viewport div at z-index 2147483647 with a **closed shadow root** (`grab-guest-overlay-script.ts:3-20`), so page CSS cannot restyle it.
  - Bare `C`/`S` keys copy the element or its screenshot (`browser-guest-grab-shortcuts.ts:35-76`), and a Markup mode lets the user draw on a screenshot (`annotate/useMarkupMode.ts`).
  - Accessibility info, nearby text and size budgets (`grab-guest-foundation-script.ts:15-26`).
- Orchestra's version is stronger on one point: its pick **keeps** the screenshot in the composer attachment, whereas Orca drops it from saved annotations (§1).

### 2.6 Remote-host browser bridges (VERIFIED sub-agent, not spot-checked)

- An SSH host's CLI can drive the desktop browser through a command allowlist (`src/shared/desktop-browser-bridge-protocol.ts`).
- Pages hosted on the server stream to the desktop with CDP `Page.startScreencast` (`browser-screencast-stream.ts:148-185`).
- Relevant to Orchestra only once remote agents exist (§3, row "Remote").

## 3. Architecture comparison

| Area | Orca | Orchestra | Verdict |
|---|---|---|---|
| Process model | Electron main + sandboxed renderer. A **detached terminal daemon** (`ELECTRON_RUN_AS_NODE`, `detached:true`) owns the PTYs, mirrors each into `@xterm/headless` and saves history (`src/main/daemon/daemon-launched-child-spawn.ts:75-136`, `headless-emulator.ts`, `history-manager.ts`). On Linux the daemon escapes the app cgroup with `systemd-run --user --scope` (`daemon-cgroup-scope.ts:10,277`, VERIFIED). `orcad` is a pure-Node host runtime used for serve, SSH and WSL | Per-workspace **keeper** daemons for SDK sessions, in systemd scopes with a memory cap (`docs/codebase-map/session-keeper.md`) | already have |
| How agents run | Default: the agent CLI in a PTY (about 23 agents, with managed hooks). "Chat UI" is experimental and multi-transport: Claude through the **Claude Agent SDK `query()`** (`src/main/claude/claude-stream-json-connection.ts:137`, VERIFIED), Codex through `app-server`, pi through JSONL-RPC, others through ACP v1.21 (`src/main/acp/`). Chat and terminal convert into each other ("Continue in Chat UI"; `agents/native-chat.mdx`) | SDK-only Agent view, Claude only (ADR 0007; `structured-agent-view.md`) | already have (Orca is converging on Orchestra's model for Claude); skip multi-agent |
| Status detection | Hooks, then OSC 7501 in the PTY stream, then title glyphs and a screen-rules engine whose rules JSON is **live-updated from GitHub releases** (sub-agent: `agent-state-rules-live-update.ts:43`) | SDK events + hooks (`activity-pty-terminal.md`) | skip (an SDK-first app doesn't need screen scraping) |
| Session survival / restore | The daemon survives Cmd-Q, updates and crashes, then warm-reattaches; a reboot restores layout and scrollback only (`model/session-restore.mdx`) | The keeper survives quit; attach/reattach (`session-keeper.md`) | already have |
| Hibernation | Experimental, off by default, 30 min; resumes with `claude --resume` (`agents/hibernation.mdx`) | Veille, 5 min, with the Reliquat wait (`activity-pty-terminal.md`) | already have (Orchestra's is stronger) |
| Terminal | xterm.js 6.1 beta + WebGL with DOM fallback, kitty keyboard protocol, Ghostty **config import** (not the Ghostty renderer); `max-active-webgl-contexts=128` (`configure-process.ts:312`) | xterm 5.5 + WebGL for Run/nvim/login PTYs only | skip (terminals are secondary in Orchestra) |
| Worktrees | `git worktree add` with a **pre-created checkout pool** (`.orca-preparing`, `src/main/worktree-create-preparation-pool.ts`, sub-agent); `orca.yaml` setup/archive scripts, `sharedDirectories`, `.worktreeinclude` | worktrees + setup scripts (`workspaces.md`) | adapt (a warm pool would cut spawn latency; measure first) |
| Status line / "checkpoints" | A free-text worktree comment plus a kanban status `todo/in-progress/in-review/completed` (`cli/worktree-checkpoints.mdx`) | `orchestra-status` note | already have (the kanban field is optional) |
| Persistence | Moved from `orca-data.json` to **`node:sqlite` document store** (schema v3, domain → JSON + revision + hash) in 1.4.214 (sub-agent: `profile-state-database-schema.ts`, `legacy-json/README.md`) | `store.json` + `bus.sqlite` (better-sqlite3) | skip for now (Orchestra's store races were fixed in place, #205) |
| IPC / CLI transport | about 600 Zod-typed RPC methods with a generated catalog checked in CI; the CLI talks NDJSON over a 0600 socket with a 24-byte token | typed `OrchestraAPI` IPC; CLI over the local socket with host-resolved identity (`hooks-cli-socket.md`, ADR 0008) | already have |
| Remote | SSH worktrees: `orcad` is deployed to the host, the laptop pairs through an SSH tunnel, remote PTYs are leased, `/proc/net/tcp` port forwarding (`ssh.mdx`). "Remote Orca Server" pairs a desktop over Tailscale (`remote-servers.mdx`) | Docker sandbox transport, **paused** for SDK sessions (#226/#220, `sandbox-transport.md`) | adapt (large): the remote runtime hosts the SDK session; pair over Tailscale like Accès mobile |
| Mobile | Native Expo/React Native app; direct WebSocket over LAN/Tailscale **or** the Orca Relay cloud splicer with NaCl-box E2EE and APNs/FCM push (`cloud/`, `src/shared/e2ee-crypto.ts`) | PWA behind `tailscale serve`, private fd-3 channel (ADR 0006, `acces-mobile.md`) | skip the app and relay; consider **Web Push** for "agent finished" (INFERRED; `acces-mobile.md` mentions no push) |
| Notifications / unread | Agent-finished pings, a bell, mark-unread, per-category custom sounds, macOS dock badge (`notifications.mdx`) | `InboxBell`, unread toggle, chime, `Notification` (`renderer-ipc-ui.md:215,417`; `src/main/platform/electron.ts:55`) | already have |
| Diff / review | Monaco DiffEditor; diff comments sent to the agent (`src/shared/diff-comments-format.ts`); AI commit message, "Fix with AI" on hook failure | `DiffPane` with annotations (`src/renderer/components/DiffPane.tsx:19-21`, `shared/diff-annotations`) | already have |
| Git hosts / trackers | GitHub (via `gh`), Linear (`@linear/sdk`), Jira, GitLab, Bitbucket, Gitea, Azure DevOps | GitHub via `gh`, Linear badges (`git.md`, `linear.md`) | skip |
| Editor | Monaco + virtualized file explorer + quick-open over bundled ripgrep | nvim pane (`NvimView.tsx`), `JumpPalette` | skip |
| Usage / accounts | Isolated homes per account (`CLAUDE_CONFIG_DIR`), usage from transcripts **and** the OAuth usage endpoint | multi-account + usage bars (`accounts-usage.md`) | already have |
| Automations | In-process 60 s scheduler, cron/RRULE, `--precheck` shell probe, repo or workspace target, also headless under orcad (sub-agent: `src/main/automations/service.ts:46-123`; `cli/automations.mdx`) | none (grep `cron\|rrule\|automation` in `src`: no scheduler) | **take** |
| Computer use (Linux) | Python AT-SPI sidecar; GDK root-window screenshots; refuses `xdotool` on Wayland (sub-agent: `native/computer-use-linux/runtime.py`) | none | skip (X11-shaped; little use on sway) |
| Auto-update | `electron-updater`: the AppImage updates itself; `.deb`/`.rpm` get a "Copy Install Command" built from absolute paths, and Orca never escalates privileges itself; distro-managed builds (AUR, Nix) are detected and left alone (`install.mdx`) | `release.sh --install` swaps the local AppImage, plus the « Nouvelle version installée » banner (`build-release.md`, `src/shared/app-update.ts`); no `electron-updater` (grep) | skip (single-user, self-built) |
| Lint / quality gates | oxlint + about 25 ratchet baselines + `fixtures:shot` component screenshots | `tsc --noEmit` only; `pnpm run lint` is broken (CLAUDE.md) | adapt: a ratchet baseline is a cheap way to start gating without fixing the backlog |

## 4. Linux specifics

**Packaging** (`config/electron-builder.config.cjs:605-688`, VERIFIED):

- **Targets:** `AppImage`, `deb` and `rpm` for x64 and arm64. The CLI and executable are named `orca-ide`, because GNOME's screen reader Orca owns `/usr/bin/orca`. `StartupWMClass: 'orca'` makes GNOME docks group the window correctly. `mimeTypes` covers markdown/csv/tsv and omits `mdx`, because Ubuntu 24.04 maps it to a Genesis ROM type.
- **Package dependencies:** deb/rpm depend on python3-gi/AT-SPI, `xdotool`, `xclip` and `xvfb` (`xorg-x11-server-Xvfb` on rpm), and install the CLI onto PATH from `after-install.sh`.
- **Release assets** for v1.4.240 include `orca-ide-1.4.240.aarch64.rpm` (21 downloads) next to `x86_64.rpm` (4336), which suggests a small arm64 Linux user base.
- **glibc floor:** a gate checks every bundled binary against Ubuntu 20.04 (glibc 2.31 / GLIBCXX_3.4.28 / CXXABI_1.3.12) (`config/scripts/verify-linux-glibc-floor.cjs:5-14`). For a cross-built slice the check also verifies the architecture.
- **Pinned Node inside the AppImage only:** `config/scripts/appimage-node-runtime.cjs` and `src/shared/appimage-node-runtime.ts`. The comment explains why: "AppImage needs it because mounted files can vanish" under a running daemon. `.deb`/`.rpm` exclude it through fpm. At packaging time the bundled Node must pass a PTY round trip (`verifyAppImageNodeRuntimeServesPty`).
- **Orchestra comparison:** Orchestra builds AppImage only (`package.json:184-197`; CI on x64 and arm64, `build-release.md`). Its keeper copies `keeper.js` out of the mount, but under an AppImage it runs on **PATH `node`**, an unpinned version, or else on the AppImage's own binary "accepting lazy-unmount semantics" (`src/main/keeper-client.ts:501-522`). Orca's approach is a direct template.

**Runtime workarounds Orca carries for Linux** (all VERIFIED; relevance to Fedora Asahi aarch64 + sway noted):

| Workaround | Orca anchor | Relevance here |
|---|---|---|
| Keyring selection for unrecognised desktops: probe for an unlocked Secret Service and pass `--password-store=gnome-libsecret`; skip locked collections (they stall startup by 76 s); keep Chromium's choice on recognised desktops | `src/main/startup/linux-keyring-backend-selection.ts`, `select-linux-keyring-backend.ts`, issue [#21827](https://github.com/stablyai/orca/issues/21827) (names sway) | **High.** Orchestra stores the Linear key plaintext here (`enc=false`, VERIFIED). `src/main/secrets.ts` also stores per-account Anthropic API keys the same way |
| Wayland clipboard publisher: a native helper using `ext_data_control_v1` / `zwlr_data_control_v1` (wlroots, so sway), with a GTK/Xwayland fallback on Mutter. It works around [Electron #54645](https://github.com/electron/electron/issues/54645), where a rejected write leaves a stale cached read | `native/wayland-clipboard/README.md`, `src/main/window/clipboard-text-publisher.ts`; issue [#23229](https://github.com/stablyai/orca/issues/23229) "Clipboard gets stuck on Wayland (sway/wlroots)" | Medium. Applies only if Orchestra copies on native Wayland. Not checked whether Orchestra runs native Wayland or XWayland, or whether it hits this bug |
| Wayland: `disable-gpu-sandbox` and skip the early GPU-channel features (#5319) | `src/main/startup/configure-process.ts:314-333` | Low to medium. Orchestra has its own ozone relaunch logic (`src/main/index.ts:54-112`) and no such switch. Only worth it if GPU-process failures show up |
| `/dev/shm` under 512 MiB means `disable-dev-shm-usage` | `src/main/startup/linux-dev-shm-policy.ts` | Low on the desktop; relevant inside the Docker sandbox image |
| Headless: force `--ozone-platform=x11` and start Xvfb automatically, because Electron `--headless` crashes on page load | `src/shared/headless-serve-ozone-platform.ts`, `src/main/startup/ensure-virtual-display.ts:15-32` | Low. Orchestra drives E2E in a second headless sway instead |
| ARM64 Linux: patch `ws` so a heartbeat is never an empty socket write (EFAULT dropped every client every 15 s) | [PR #26200](https://github.com/stablyai/orca/pull/26200) | Check. Orchestra's sandbox transport and Accès mobile use WebSockets on aarch64; I have not checked whether the bug reproduces with Orchestra's `ws` version |
| Open Linux issues Orca has not fixed | [#8972](https://github.com/stablyai/orca/issues/8972) white border on tiling WMs; [#33137](https://github.com/stablyai/orca/issues/33137) notifications fail to focus the window on Wayland | Shows that sway/tiling support is still rough even for Orca |

Nothing in Orca mentions Asahi or 16 KiB pages: a grep over `src`, `config`, `native` and `docs/site`, plus issue search for
"asahi", found nothing. This host runs `getconf PAGESIZE` = 16384. Orca's arm64 artifacts are built on `ubuntu-24.04-arm`
(4 KiB pages, PR #4755). Whether they run on Asahi's 16k kernel is UNVERIFIED. Orchestra's own AppImage does.

## 5. Bus/orchestration: what changed after 2026-10-04 (VERIFIED, PR bodies read)

- **Native-chat workers.** A dispatch worker can now be a Claude Agent SDK chat and not only a terminal agent ([#22972](https://github.com/stablyai/orca/pull/22972), [#26776](https://github.com/stablyai/orca/pull/26776), [#25078](https://github.com/stablyai/orca/pull/25078)). Orca is moving toward Orchestra's SDK-member model.
- **Delivery holds.** A mailbox pointer is no longer typed into a pane while Claude shows an AskUserQuestion, permission or plan dialog ([#33366](https://github.com/stablyai/orca/pull/33366)). Choosing the highlighted option for the user was the bug. It is also held while the composer has an unsent draft, for at most 10 min after the last keystroke ([#33429](https://github.com/stablyai/orca/pull/33429)).
  - Orchestra delivers through the SDK, not the PTY, so the draft half does not apply.
  - Whether a bus wake can arrive while an `AskUserQuestion` is pending, and what the SDK does then, is UNVERIFIED for Orchestra. It is worth one probe.
- **Chat worker errors escalate.** A request failure in an assigned chat worker now sends one high-priority escalation to the coordinator; there is a setting, and old errors are not replayed ([#31941](https://github.com/stablyai/orca/pull/31941)). Orchestra's equivalents, #227 (SDK start failure reported) and #197 (boot-wedge escalation), cover start failures. Not checked whether a mid-session request error escalates.
- **Run home.** Sends to a Run whose home is another computer are refused ([#33005](https://github.com/stablyai/orca/pull/33005)). Not applicable to Orchestra today.

## 6. Skip list (with reasons)

- **Support for many agents (about 23 CLIs), ACP, Codex app-server:** Orchestra is Claude-only by design (ADR 0007).
- **Status from PTY screen scraping** (OSC 7501, title glyphs, rules JSON live-updated from GitHub): an SDK-first app has structured events. A rules file fetched from the network at runtime is also a supply-chain surface.
- **Native mobile app + Orca Relay cloud + APNs/FCM:** it needs App Store and cloud operations. Orchestra chose a Tailscale PWA (ADR 0006); only Web Push is worth a look.
- **Monaco editor, file explorer, ripgrep quick-open, Markdown/PDF viewers:** Orchestra delegates editing to nvim.
- **deb/rpm, the glibc-floor gate, signed apt/yum repo, `electron-updater` channels, Homebrew cask:** Orchestra is self-built and self-installed by one user through `release.sh`.
- **Computer use on Linux:** X11-shaped (GDK root screenshots, `xdotool` refused on Wayland). It would do little on sway.
- **Jira/GitLab/Bitbucket/Gitea/Azure DevOps, i18n catalogs, Windows/WSL guest, macOS Swift helpers:** out of scope for this user.
- **Xvfb-based headless serve:** Orchestra's headless-sway rig already covers this.
- **Moving `store.json` to `node:sqlite`:** no current pain that justifies the migration. Revisit if the store grows.

## 7. Verified

- Linux shipped from the first release, v1.0.12 (2026-03-21); rpm from PR #3025 (2026-05-29); arm64 from PR #4755 (stable v1.4.92, 2026-06-23). Commands: `gh api --paginate repos/stablyai/orca/releases`, `gh pr view 4755/3025`.
- The v1.4.240 asset list and download counts: `gh release view -R stablyai/orca`.
- Orca's Linux packaging and Chromium switches: `config/electron-builder.config.cjs:605-688`, `src/main/startup/*.ts` (read).
- The CDP proxy, loopback guard, Target faking, screenshot probes, paint hold, React `_debugSource` and screenshot drop: files read at the anchors in §2.
- The daemon's `systemd-run --scope`; Claude Agent SDK `query()` for chat; the OAuth usage URL: lines re-read.
- Orchestra: `secrets.json` `enc=false` on this host (fields read with `python3 -I`, value not printed); `browser-panel.ts:123-129,228-235`; `keeper-client.ts:501-522`; `secrets.ts:99-107`; `package.json` linux block; 0 commits behind `origin/master`.

## 8. NOT VERIFIED

- Whether Orca's arm64 AppImage runs on Fedora Asahi (16 KiB pages) under sway. Nothing was installed or run.
- Whether `chrome-devtools-mcp` / puppeteer accepts Orca-style faked single-page `Target.*` (only `agent-browser` is proven by Orca's own use).
- Whether a hidden `show:false` `BrowserWindow` produces frames on Electron 33 under sway (the background-screenshot port in §2.3).
- Whether this host has a Secret Service that could be unlocked (`org.freedesktop.secrets` had no owner at check time; `org.kde.secretservicecompat` is only activatable). So the keyring port's effect here is unmeasured.
- Whether Orchestra is affected by the Wayland clipboard bug (Electron #54645) or the arm64 `ws` empty-write EFAULT (orca #26200).
- What Orchestra does when a bus wake arrives during a pending AskUserQuestion (§5).
- Sub-agent-only claims not re-read by me: the worktree preparation pool, the `node:sqlite` schema details, the automations scheduler internals, the mobile E2EE/relay files, the computer-use sidecar lines, the remote browser bridges/screencast.
- Orca's website: only `onorca.dev/download` was fetched, and it lists a "Linux Universal AppImage" with no architecture. All other doc claims come from the in-repo `docs/site` sources at the pinned sha. I searched for no YouTube or blog material.
