# Embedded browser panel

A per-workspace in-window browser — an Electron `WebContentsView` overlaid on
the React renderer — that **both** the user drives manually (URL bar, back /
forward, reload) **and** the agent drives programmatically (navigate, read the
page, screenshot, click, type). It mirrors the Claude Code desktop app's
"Browser pane": that app's bundle carries the comment *"Adapted from
chrome-devtools-mcp patterns but using Electron's internal `webContents.debugger`
API instead of an external CDP connection"* — Orchestra does exactly that, so
there is **no `--remote-debugging-port`, no spawned Chromium, no puppeteer, and
no MCP subprocess**. Everything runs in-process against a view Orchestra owns.

## Why this shape

- **Native `webContents.debugger` (in-process CDP), not an external MCP.** The
  agent's browser tools call CDP commands (`Input.dispatchMouseEvent`,
  `Runtime.evaluate`, …) on the panel view's own debugger, and screenshot via
  the native `webContents.capturePage()`. No debug port means no security
  surface and no target-ambiguity problem (an app-wide debug port would expose
  Orchestra's own renderer as a CDP target too).
- **One independent browser per workspace, by construction.** `browser-panel.ts`
  keys every `WebContentsView` by `wsId`; the agent's browser MCP server is built
  per-session in `agent-sdk.ts` and each tool closes over its own `wsId`. So a
  workspace's agent can only ever drive that workspace's panel — multiple
  workspaces get fully isolated browsers.

## Data path

```
Agent (SDK query) ── mcp__browser__navigate / read_page / screenshot / click …
   │  in-process SDK MCP server (createSdkMcpServer)      src/main/agent-browser-tools.ts
   ▼
browser-panel.ts primitives (navigate / capture / evaluate / clickAt …)
   │  drive the WebContentsView via webContents.debugger + capturePage()
   ▼
WebContentsView (contentView.addChildView)               src/main/browser-panel.ts
   │  did-navigate / page-title-updated / did-*-loading
   ▼
platform.broadcast('browser:event', wsId, BrowserPanelState)
   ▼
preload onBrowserEvent → BrowserPanel URL bar / tab       src/renderer/components/BrowserPanel.tsx

User ── URL bar / nav buttons ──► window.orchestra.browser{Navigate,Back,…}(wsId)
   │  IPC (browser:*), same handler table                 src/main/api-handlers.ts
   ▼  drive the SAME WebContentsView — one surface, shared by user + agent
```

## Key files

- **`src/main/browser-panel.ts`** — the per-workspace `WebContentsView` registry
  (`Map<wsId, WebContentsView>`), attached to the main window's `contentView`.
  Owns navigation (`navigate`/`goBack`/`goForward`/`reload`), visibility
  (`showPanel`/`hidePanel` — only the active workspace's panel composits at a
  time), bounds sync (`setBounds` — the native view is positioned over the
  renderer's `.browser-pane` placeholder rect), and the **agent-driving
  primitives** over `webContents.debugger`: `capture` (JPEG via `capturePage`),
  `evaluate` (`Runtime.evaluate`), `readPage` (in-page DOM walk → `[ref_N]`
  accessibility outline), `clickAt`/`clickRef` (`Input.dispatchMouseEvent`),
  `typeText`/`formInput`, `scrollBy`. `initBrowserPanels(accessor)` is called
  once from `index.ts` with the live main-window accessor. Reuses
  `login-browser.ts`'s session-partition + UA-normalization + context-menu
  pattern.
- **`src/main/agent-browser-tools.ts`** — `buildBrowserToolServer(wsId)` returns
  an **in-process SDK MCP server** (`createSdkMcpServer` + `tool()`), loaded via
  a **cached dynamic `import()`** (the SDK is pure-ESM; a static value import
  would emit `require()` in the CJS main bundle and crash Electron at boot with
  `ERR_REQUIRE_ESM`). Tools: `navigate`, `read_page`, `screenshot`, `click`,
  `type`, `form_input`, `evaluate`, `scroll` — all routed through
  `browser-panel.ts` against the captured `wsId`. Uses `zod` (added as a direct
  dep, pinned to the SDK's peer version) for the tool input schemas.
- **`src/main/agent-sdk.ts`** — builds the browser MCP server per local session
  and passes it into `query({ mcpServers: { browser: … } })` (so the tools
  appear to the model as `mcp__browser__*`). Skipped for remote/sandbox sessions
  (no local `WebContentsView` to drive).
- **`src/renderer/components/BrowserPanel.tsx`** — the renderer chrome: URL bar
  (controlled input, only synced from state when unfocused), back/forward/reload
  buttons, loading spinner, error strip, and a `.browser-holder` placeholder.
  A `ResizeObserver` on the holder pushes its rect to main via `browserSetBounds`
  so the native view tracks it; subscribes to `onBrowserEvent` for URL/title
  updates (both manual and agent-driven). Shows/hides the native view as it
  becomes active/inactive and on unmount.
- **`src/renderer/App.tsx`** — the panel is a third flex child of `.pane-row`
  (mirroring the nvim pane): `browserOpen`/`browserWidth` state, a toolbar
  toggle beside the file-pane toggle, a `.pane-resizer`, and inline
  `flex: 0 0 ${browserWidth}px`. Its `isActive` is gated off when a full-page
  overlay (Insights / Resources / Help) covers the pane row, because a
  `WebContentsView` composits **above** the DOM and would otherwise show through.
- **`src/renderer/styles.css`** — `.browser-pane` / `.browser-panel` /
  `.browser-toolbar` / `.browser-url-input` / `.browser-holder` etc., styled with
  the app's own tokens (`--bg`, `--text`, `--accent`, …) so the chrome blends
  with the surrounding window.

## IPC / seam

Request/response methods (`browserShow`/`Hide`/`Navigate`/`Back`/`Forward`/
`Reload`/`SetBounds`/`State`) are declared in `OrchestraAPI` (`shared/ipc.ts`),
registered in the `apiHandlers` table + `METHOD_IPC_CHANNELS`
(`api-handlers.ts`), and closured in `preload/index.ts` — wired mechanically to
ipcMain. The `browser:event` broadcast is declared as `onBrowserEvent`
(`shared/ipc.ts`), pushed through `platform.broadcast`, and subscribed in
preload. Panel teardown rides the workspace-delete handlers
(`browserPanel.destroyPanel(id)` beside `sdkStopMany`) **and the archive path** —
`archiveWorkspace` (`workspaces.ts:579`) calls `destroyPanel` for every workspace
in the archived subtree, so an orchestrator archives its children's panels too.

## Gotchas

- The native view paints **above** the renderer DOM — it ignores React
  z-index. Hide it (drive `isActive=false`) whenever an overlay covers the pane
  row; `BrowserPanel` already does this.
- **A leaked view paints BLACK over the app.** The renderer's `BrowserPanel`
  hides the view on unmount, but an AGENT can open a panel through its MCP
  browser tools (`agent-browser-tools.ts` calls `showPanel` directly) with **no
  renderer component ever mounted** — so there is no React cleanup, and any
  main-side lifecycle event that removes the workspace from the UI must tear the
  panel down explicitly. Missing that on `archiveWorkspace` is what made
  archiving paint a black rectangle over the whole window (fixed; regression
  harness: `scripts/verify-archive-browser-panel.mjs`). The main process logs
  **nothing** when this happens — no crash, no `render-process-gone` — so an
  archive followed by a user-forced restart is the only trace in the log.
- `showPanel` refuses to attach a view that has never been positioned
  (`panel.bounded`), deferring to the first `setBounds`; otherwise an
  agent-opened panel composites at a garbage rect while the pane is closed.
  Views also get an explicit `setBackgroundColor`, since an unpainted
  `WebContentsView` composites black by default.
- The SDK MCP builder must be loaded via dynamic `import()` — a static import of
  `@anthropic-ai/claude-agent-sdk` crashes the packaged app at boot
  (`ERR_REQUIRE_ESM`). Verify the emitted bundle has **0**
  `require("@anthropic-ai/claude-agent-sdk")` and **≥1**
  `import("@anthropic-ai/claude-agent-sdk")`.
- `Target.createTarget` is unsupported in Electron, so there is no "new tab" for
  the agent — it reuses the one panel view. That's fine: the agent's `navigate`
  reuses the existing view.
- Bounds are device-independent pixels relative to the window content; apply
  them **after** the view is added (next animation frame) so the placeholder has
  laid out.
