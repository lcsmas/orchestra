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
  (mirroring the nvim pane): **per-workspace** open state (`browserOpenIds:
  Set<wsId>` — a single boolean here was the "opening the browser opens it for
  every workspace" bug: switching workspaces kept the pane open and silently
  created a native `WebContentsView` per workspace visited), `browserWidth`, a
  toolbar toggle beside the file-pane toggle, a `.pane-resizer`, and inline
  `flex: 0 0 ${browserWidth}px`. Agent navigation auto-opens the pane **for the
  navigating workspace only** (any `browser:event` with a real URL adds that
  wsId to the set — revealed when the user is or switches there). Its
  `isActive` is gated off when a full-page overlay (Insights / Resources /
  Help) covers the pane row, because a `WebContentsView` composits **above**
  the DOM and would otherwise show through — and also whenever a **modal
  overlay** is up (`overlayUp`, a MutationObserver watching for
  `.dialog-backdrop` / `.modal-backdrop` / `.jump-overlay` while the pane is
  open): a centered dialog would otherwise render invisibly BEHIND the native
  view while its backdrop swallows clicks, reading as a frozen app.
- **`src/renderer/styles.css`** — `.browser-pane` / `.browser-panel` /
  `.browser-toolbar` / `.browser-url-input` / `.browser-holder` etc., styled with
  the app's own tokens (`--bg`, `--text`, `--accent`, …) so the chrome blends
  with the surrounding window.

## Design mode — the element picker

A user-facing element picker over the same panel (Orca parity): the user arms
**Design Mode** from the browser toolbar (crosshair button), hovers to see the
element under the cursor outlined, and clicks to pick it. The pick — trimmed
`outerHTML`, a computed-style subset, a cropped element screenshot, the selector
path and page URL — lands in that workspace's **agent composer** as one
attachment (image + fenced text block).

```
BrowserPanel crosshair toggle          src/renderer/components/BrowserPanel.tsx
   │  browserDesignArm(wsId)
   ▼
designModeArm → Runtime.evaluate(DESIGN_MODE_SCRIPT)   src/main/browser-panel.ts
   │  in-page overlay: mousemove highlight + capturing click handler
   ▼  click → window.__orchestraDesignPick = {chain, outerHTML, computed, box}
renderer polls browserDesignPoll (150ms while armed)
   │  main: reads+clears the global, Page.captureScreenshot with a padded clip
   ▼  shapePick() — trim HTML, subset styles, build selector path
store.addDesignPick(wsId, pick)                        src/renderer/store.ts
   ▼  queued per workspace; survives an unmounted composer
Composer effect → takeDesignPicks() (atomic read+clear) src/renderer/components/StructuredView.tsx
   ▼  appendPickToDraft() into the textarea + screenshot into pendingImages
```

- **`src/shared/design-mode.ts`** — every pure part, unit-tested
  (`design-mode.test.ts`, 31 cases): `STYLE_PROPS` (the 12-property computed
  subset), `trimHtml`/`HTML_CAP`, `subsetStyles`, `shapePick`, `clipForBox`
  (pads the element box then clamps BOTH origin and extent to the viewport —
  an element flush to the top-left pads to a negative origin CDP rejects),
  `selectorSegment`/`buildSelectorPath` (prefers id → stable classes →
  `nth-of-type`, drops hashed css-modules/styled-components/emotion classes and
  Tailwind arbitrary values, keeps the TAIL when too deep), `formatPickBlock`
  and `appendPickToDraft`.
- **`src/main/browser-panel.ts`** — `designModeArm` / `designModeDisarm` /
  `designModePoll`, plus the injected `DESIGN_MODE_SCRIPT`. Goes through the
  SAME `cdp()` / `evaluate()` helpers the agent tools use — **no second
  `debugger.attach`** (attaching twice to one target throws).
- **`src/renderer/store.ts`** — `designPicks: Record<wsId, DesignPick[]>` plus
  `addDesignPick` / `takeDesignPicks` (reads and clears in one `set`, so a pick
  is drained exactly once).

### Why an in-page overlay and not `Overlay.setInspectMode`

CDP's `Overlay.setInspectMode` + `Overlay.inspectNodeRequested` is the native
picker seam and was the first choice. It does not work for this panel: the
**pick event fires, but nothing is drawn** — the inspect highlight is painted by
the DevTools *frontend* overlay layer, which a `WebContentsView` with no
DevTools frontend attached never composites. A picker the user cannot see is not
the feature, so the highlight + hit-testing live in the page instead. That also
keeps the shared debugger free of any long-lived event subscription.

### Design-mode gotchas

- The overlay sets `pointer-events: none` on its own chrome, and picking starts
  from `document.elementFromPoint` (which skips `pointer-events:none` nodes) —
  so **design mode cannot capture its own highlight box**.
- **A navigation destroys the injected overlay** (new document), silently
  disarming the picker. `BrowserPanel` re-arms on every `state.url` change while
  armed.
- The pick is **polled, not pushed** (150ms, only while armed) precisely because
  there is no CDP event subscription. Poll failure disarms the UI, so the
  toolbar never shows "armed" over a page with no overlay behind it.
- Picking is **one-shot**: a pick disarms design mode, so a stray second click
  can't capture something the user didn't mean to send. The toolbar re-arms.
- Armed state lives in the component, **not** the store — it must die with the
  panel, or an unmounted panel would leave an invisible click-swallowing overlay
  in that page. The PICK, conversely, lives in the store, which is what lets it
  survive a composer that was never mounted.
- **Iterating a `CSSStyleDeclaration` yields only LONGHANDS.** `margin`,
  `padding`, `border` and `border-radius` are shorthands and never appear in the
  `cs[i]` enumeration, so an index-walk collector silently drops exactly the
  four box/border values design mode exists to report — and it fails *silently*,
  producing a plausible-looking block missing only those rows. Measured on a
  real page: **383 enumerated properties, 0 of them shorthands**, while
  `getPropertyValue('margin')` returns `6px` fine. `DESIGN_MODE_SCRIPT` walks
  the enumeration *and then* asks for the shorthands explicitly. Caught by
  driving the real picker, not by a unit test (the test fixture had supplied
  shorthands directly, so it could not have caught it); pinned now by
  `subsetStyles surfaces the SHORTHAND box/border properties`.
- **`DESIGN_MODE_SCRIPT` is a template literal — no backticks inside it.** A
  backtick in a comment there silently terminates the string and breaks the
  build (`TS1005`/esbuild parse error) far from the edit.
- `designModeDisarm` **swallows evaluation failures**. The renderer disarms on
  unmount, on going inactive, and after every pick, so it routinely lands on a
  page that is mid-navigation or already gone (`Inspected target navigated or
  closed`). There is nothing to clean up in that case, so surfacing it would log
  an ERROR on a normal path.
- The screenshot is **best-effort**: a failed `Page.captureScreenshot` still
  delivers the pick's text half rather than aborting the whole capture.

## IPC / seam

Request/response methods (`browserShow`/`Hide`/`Navigate`/`Back`/`Forward`/
`Reload`/`SetBounds`/`State`) are declared in `OrchestraAPI` (`shared/ipc.ts`),
registered in the `apiHandlers` table + `METHOD_IPC_CHANNELS`
(`api-handlers.ts`), and closured in `preload/index.ts` — wired mechanically to
ipcMain. Design mode adds three on the same path: `browserDesignArm` /
`browserDesignDisarm` / `browserDesignPoll` (`browser:designArm` /
`designDisarm` / `designPoll`). The `browser:event` broadcast is declared as `onBrowserEvent`
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
- **`view.webContents` can become `undefined` — the typing lies.** Electron
  declares `readonly webContents: WebContents` (non-nullable) on
  `WebContentsView`, but sets it to `undefined` once the underlying WebContents
  is destroyed. Verified against real Electron 33: after `webContents.close()`,
  `typeof view.webContents === 'undefined'`. So the natural guard
  `panel.view.webContents.isDestroyed()` **throws on exactly the case it exists
  to detect** (`TypeError: Cannot read properties of undefined (reading
  'isDestroyed')`) — and TypeScript cannot catch it, because the declared type
  says the property is always there. A view can lose its contents WITHOUT
  `destroyPanel` running (renderer/GPU crash of the sandboxed panel page,
  Chromium reclaiming it, window teardown), leaving a husk in the `panels` map.
  Because the renderer pushes bounds continuously (`ResizeObserver` + window
  resize), one dead view produced a **burst** of failures — 98 in a single
  v0.5.161 session. Every dereference now goes through **`liveContents(panel)`**
  (returns the contents or `undefined`) and lookups go through
  **`reapIfDead(wsId)`**, which detaches the husk from the window and evicts it
  so the next call rebuilds a fresh panel. Regression harness:
  `scripts/verify-browser-panel-dead-view.mjs`.
- `showPanel` refuses to attach a view that has never been positioned
  (`panel.bounded`), deferring to the first `setBounds`; otherwise an
  agent-opened panel composites at a garbage rect while the pane is closed.
  Views also get an explicit `setBackgroundColor`, since an unpainted
  `WebContentsView` composites black by default.
- **Agents must never attach a view for a non-focused workspace.**
  `browser-panel.ts` tracks `focusedWsId` — the workspace whose panel the
  RENDERER composites (set by `showPanel`, cleared by `hidePanel`, both
  renderer-driven). The agent `navigate` tool goes through `revealForAgent`,
  which only reaches `showPanel` when its workspace IS the focused one;
  otherwise it just ensures the panel exists. Calling `showPanel` directly from
  the agent path (the old behavior) let a BACKGROUND workspace's agent hide the
  active workspace's panel and composite its own view — at stale bounds — over
  whatever the user was looking at. Regression harness:
  `scripts/verify-browser-panel-focus-steal.mjs`.
- **A non-composited view produces NO frames — screenshots and CDP input hang
  or lie.** Measured on Electron 33: `capturePage()` on a never-attached view
  silently returns an empty 0x0 image; on a detached-after-shown view it
  **hangs forever**; CDP `Page.captureScreenshot` hangs in both cases; CDP
  mouse input hangs or queues events that fire on a later attach.
  `Runtime.evaluate` / `loadURL` work fine detached. So `capture`, `clickAt`,
  `typeText` and `scrollBy` guard with `requireComposited()` (a clear,
  actionable error naming the tools that DO still work) and every
  capture/input CDP call is wrapped in `withTimeout` — a hung promise here is
  an agent tool call that never returns. `navigate`/`read_page`/`evaluate`/
  `form_input` remain fully usable from a background workspace.
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
