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
  keys every panel by `wsId` (a panel = an ordered list of tabs, each its own
  `WebContentsView`, with one ACTIVE tab — see *Tabs registry* below); the
  agent's browser MCP server is built per-session in `agent-sdk.ts` and each tool
  closes over its own `wsId`. So a workspace's agent can only ever drive that
  workspace's panel — multiple workspaces get fully isolated browsers.

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

- **`src/main/browser-panel.ts`** — the per-workspace tabs registry
  (`Map<wsId, Panel>`, `Panel.tabs: Tab[]`, one `WebContentsView` per tab),
  attached to the main window's `contentView`.
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

## Tabs registry (v1, #391)

The registry is workspace → ordered tabs with one active tab. #391 is the
**prefactor**: it still creates exactly ONE tab (`t1`, `openedBy:'human'`) in
`ensurePanel` and exposes **no tab IPC** — the renderer sees no change. The
human tab UI (#393), tab memory (#394), the CDP proxy (#395) and agent tabs
(#397) build on the exports below.

- **Types** (`shared/types.ts`): `BrowserTabId` (`t1`, `t2`, … minted per
  workspace by `nextTabId`, from a counter that lives OUTSIDE `panels` so an
  evicted-and-rebuilt panel never reuses an id), `BrowserTabOpener`
  (`'human'|'agent'`), `BrowserTabInfo {id,url,title,loading,active,openedBy}`.
  `BrowserPanelState` gained `tabs` (ordered) + `activeTabId` (`''` while there
  is no tab); its url/title/loading/nav/error fields keep mirroring the ACTIVE
  tab (`computeState`), so `BrowserPanel.tsx` only grew two literal fields.
- **Shapes** (`browser-panel.ts`): `Tab {id, view, openedBy, debuggerAttached,
  nav}`; `Panel {wsId, tabs, activeId, attachedId, bounded, bounds, pendingShow,
  state, view}` — `attachedId` is the tab whose view is in the window right now
  (`null` = not composited; replaces the old `visible`), `bounds` the last
  renderer rect (re-applied to a view on attach), `view` a getter for the ACTIVE
  tab's view (the three `scripts/verify-*browser-panel*.mjs` harnesses read it).
- **Exports**: `listTabs` · `getTab` · `getActiveTab` · `createTab(wsId,
  {url?, openedBy, activate?})` (no cap, no policy; `activate` defaults false;
  runs `ensurePanel` first, so a fresh workspace gets `t1` human then the new
  tab) · `activateTab` · `closeTab` (both THROW on an unknown id). Every
  pre-existing export keeps its signature and acts on the ACTIVE tab; the
  debugger/CDP primitives (`attachDebugger`, `evaluate`, `capture`, `readPage`,
  `clickAt/Ref`, `typeText`, `formInput`, `scrollBy`, `designMode*`) and
  `navigate/goBack/goForward/reload` take an optional trailing `tabId`
  (`resolveTab`). `cdp()` stays internal.
- **Composition rule**: only the ACTIVE tab of the FOCUSED workspace is in the
  window (`attachActive` swaps; `activateTab`/`closeTab` on a hidden panel
  attach nothing). `capture`/`clickAt`/`typeText`/`scrollBy` on a non-active tab
  fail with "not the active tab" (a background tab produces no frames, same
  trap as a hidden panel); `evaluate`/`readPage`/`navigate` still work on it.
- **Teardown iterates every tab**: `destroyPanel` (workspace delete AND the
  archive path) calls `destroyTab` on each — debugger detach then
  `webContents.close()`. A teardown that only handled the active tab would leak
  native views that paint black over the app (pinned by
  `browser-panel-tabs.test.ts` + its mutant set).
- **Dead-view reaping is per tab** (`reapIfDead`): a dead non-last tab is
  dropped (its neighbour becomes active, re-attached if it was composited); when
  the LAST live tab dies the whole panel is evicted and `ensurePanel` rebuilds
  it. `panel.tabs` is left intact on whole-panel eviction so a stale holder's
  `panel.view` still reads the husk instead of throwing.
- **Closing the last tab** evicts the panel (destroys the tab, empty state
  broadcast, `panel.tabs` left intact for stale holders) — a placeholder; what
  it should mean for the user is #393's call. The rebuilt panel has
  `bounded=false`, so it only composits after the next `setBounds`/`showPanel`.
- **Multi-step primitives pin ONE tab** (`clickAt` press+release, `clickRef`,
  `designModePoll`): the tab is resolved once, so an `activateTab` between two
  CDP calls cannot split a click across tabs. `getState` reaps dead tabs.
- `setBounds` sizes EVERY tab view (a tab swapped in later is already the right
  size); `setWindowOpenHandler` still loads `target=_blank` in the SAME tab
  (popup routing is #396).
- **An explicit `tabId` never builds a panel**: `attachDebugger`/`evaluate`/…
  and `navigate` resolve it first and throw "not found" — a stale id after
  `closeTab(last)`/`destroyPanel` must fail, not resurrect a blank native view
  (only the DEFAULT, active-tab form opens a panel on demand). `emitState` also
  requires `panels.get(wsId) === panel`: an evicted panel keeps its `tabs`, so
  without it a late did-* event from a still-live (async-closing) tab publishes
  a ghost state for a deleted workspace or over the rebuilt panel.
  `listTabs`/`getTab`/`getActiveTab` reap on every read.
- **Tests**: `src/main/browser-panel-tabs.test.ts` (78 tests: 29 registry arms + an explicit-tabId loop over all 16 entry points x 3 stale situations + an enumeration guard; N>1 tabs, real
  module over a stubbed `electron` loader hook; `__bpAsyncClose` models
  Electron's async `close()`) + `scripts/mutate-browser-panel-tabs.mjs`
  (37 in-place mutants, byte-exact restore). The registry itself cannot be
  imported by `node --test` without that hook (it imports `electron`).
  Real Electron: `scripts/e2e-browser-tabs-registry.sh <app-dir>` (own headless
  sway) — `app` arm drives the unchanged renderer flow on the built app (pane
  open, URL bar, back, hide/show; one tab `t1`, pixels via grim), `probe` arm
  (`e2e-browser-tabs-probe.cjs`) runs the bundled registry over real
  `WebContentsView`s with N>1 tabs; `--mutant destroy-active-only|no-detach-prev`
  must redden its named clause. Real-Electron trap: `webContents.close()` is
  ASYNC — `view.webContents` is still live right after it.
- `'human'` literals in `src/main/*.ts` are counted by
  `pause-gates-wiring.test.ts` (pause-bypass origins); `openedBy: 'human'` is
  stripped there — write the tab opener in that exact form.

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

## Human tabs (#393) — cap, ownership, restore

The panel holds up to **8 tabs per workspace** (human + agent combined); the human opens / switches / closes them in a strip above the
URL bar, and each workspace's tabs come back after an app restart. The tabs registry itself is #391 (`Tab` / `Panel`, `createTab` /
`closeTab` / `activateTab`: no cap, no policy); everything below sits in FRONT of it.

- **Pure policy — `src/shared/browser-tab-policy.ts`** (unit-tested, `browser-tab-policy.test.ts`): `BROWSER_TAB_CAP`, `decideTabOpen`
  (the cap; refusal carries a user-facing message), `decideTabClose` (**the human closes any tab, an agent only `openedBy:'agent'`**;
  what is active afterwards = right neighbour, else left; **closing the LAST tab → `replaceWithBlank`**), `decidePopup` (the #396 seam:
  `PopupRouteDecision = {route:'same-view'|'external'}` today = the pre-tabs behaviour; #396 adds arms). #397 consumes the ownership rule.
- **Main entry points — `tryOpenTab` / `tryCloseTab` / `tryActivateTab`** in `src/main/browser-panel.ts`: ask the policy FIRST, so a refused open
  allocates no `WebContentsView` (no leak) and a refused close destroys nothing. They RESOLVE `BrowserTabResult` (`{ok:true,state,tabId?}` |
  `{ok:false,reason:'cap'|'not-owner'|'unknown-tab',message,state}`) — never throw across IPC. Anything acting for the human or the agent
  goes through them; the bare registry calls stay unguarded by design.
- **Last tab:** the BARE `closeTab` on the last tab (the #395 CDP host calls it) evicts the panel AND forgets its saved tabs (`persistence?.save(wsId, null)`, #393 F1) — else the next `ensurePanel` would restore the tab just closed. `tryCloseTab` builds the blank human replacement BEFORE closing (the registry's `closeTab` on the only tab evicts the panel),
  so a panel never has zero tabs and the agent primitives always find an active one. The new tab gets a fresh id (ids are never reused).
- **Persistence — `src/shared/browser-tab-state.ts` + `src/main/browser-tabs-store.ts`:** `<userData>/orchestra/browser-tabs.json`
  (`{version:1, workspaces:{<wsId>:{tabs:[{url,openedBy}], activeIndex}}}`), a SEPARATE small file (not `store.json`: a navigation rewrites it
  and `browser-panel.ts` must stay loadable by the stub harnesses without the workspace store). `initBrowserPanels(accessor, store?)` injects the
  store; without one (the harnesses) there is simply no restore/persist. `publish()` → `savePanelTabs` snapshots (only a REGISTERED panel — a
  mid-restore / closed-last / destroyed panel never overwrites the record); the store coalesces writes (400 ms) and writes tmp + rename;
  `flushBrowserTabs()` runs from `shutdownSubsystems` (quit). An UNREADABLE file (EIO/EACCES/EMFILE — not missing, not corrupt) is never overwritten: no write until a re-read works, then this session merges over the disk copy (`readFailed`, `forgotten`). Parse is defensive: only `http(s)`/`file` URLs restore (anything else comes back
  as a blank tab), capped at 8, bad active index → 0, a corrupt file → a fresh start.
- **Restore is LAZY:** at the workspace's FIRST `ensurePanel` after boot (opening the pane, or an agent navigating), not for every workspace at
  startup — 20 workspaces' pages must not load at boot. All saved tabs are built and loaded, the saved one is active. A restored tab keeps its
  remembered URL (`restoreUrls`) until a navigation COMMITS to a restorable URL (`did-navigate` handler), so a snapshot taken while the load
  is starting or ended on an error page (server down at boot) never blanks it — in real Electron `getURL()` keeps the failed URL anyway (rig arm `down`). `destroyPanel` (delete / archive) forgets the entry even if this process never opened the panel.
- **Auto-open vs a closed pane (#393 F2):** `App.tsx` marks a workspace's pane open on a `browser:event` only when `decideBrowserAutoOpen` (`browser-tab-policy.ts`) says the ACTIVE tab did something an agent does — a new `(activeTabId, url)` key, OR the active tab STARTED loading (a same-url navigate/reload changes no key; `did-start-loading` is its only signal; the memo is `{key, loading}` per workspace, never cleared when the user closes the pane). A background tab's title / loading / in-page event re-publishes the active tab's unchanged url and used to re-open a pane the user had closed (up to 8 live tabs feed that stream). An agent `navigate` still opens it, same url or not (rig arm `reopen`).
- **IPC (human-facing, additive):** `browserTabNew(wsId, url?)` / `browserTabActivate(wsId, tabId)` / `browserTabClose(wsId, tabId)`
  (`browser:tabNew|tabActivate|tabClose`, `shared/ipc.ts` → `api-handlers.ts` → `preload/index.ts`). State still arrives on `browser:event`
  (`state.tabs` / `activeTabId`; `state.url` etc. mirror the ACTIVE tab, so the URL bar follows it).
- **Renderer — `BrowserPanel.tsx`:** `.browser-tabs` strip (`role=tablist`; each `.browser-tab` carries `data-tab-id` / `data-opened-by`, a
  `×`, and `+` at the end), a `role=alert` `.browser-tab-notice` for a refusal (5 s). `<BrowserPanel key={active.id}>` in `App.tsx` so tab ids (restarting at `t1` per workspace) never cross workspaces. Design mode is DISARMED before the active tab changes
  (`runTabOp`): the overlay lives in the page of the tab being left and would otherwise stay armed, click-swallowing and invisible to the UI.
  Label = `tabLabel` (title, else host, else "New tab"). URL bar: every state from main goes through `applyState`, which also records `latestUrl` — `onBlur` resets the bar from THAT ref, not the render-lagging `state.url` (the bar went empty after a first navigation when the input blurred before React committed; rig arm `urlbar` is a regression net — the race is not reachable from CDP, the unfixed form survives it).
- **Tests:** `scripts/verify-browser-tabs-panel.mjs` (stub Electron: cap with no leaked view, ownership, last tab, one view composited, persist →
  fresh module instance → restore, destroy forgets) + `scripts/verify-browser-tabs-panel-mutants.mjs` (33 in-place mutants, byte-exact restore);
  built-app rig `scripts/e2e-browser-tabs.sh` (3 tabs → graceful restart → SIGKILL restart; compositor pixels via `grim`; cap; last tab; two workspaces; server-down tab; closed pane stays closed) +
  `scripts/e2e-browser-tabs-mutants.mjs` (10 rebuilt-app mutants). Fixture pages `scripts/fixtures/browser-site/pages/tabs-{a,b,c}.html`.
- **Traps:** a `WebContentsView` that is not the active tab of the focused workspace is NOT in the window (never composites); the rig's pixel
  clauses are the only oracle for that (DOM cannot see paint). `Browser.close` over the debug port is a graceful quit that reaches
  `before-quit` (the flush); a SIGKILL restart relies on the 400 ms debounce alone — both are driven.

## IPC / seam

Request/response methods (`browserShow`/`Hide`/`Navigate`/`Back`/`Forward`/
`Reload`/`SetBounds`/`State`) are declared in `OrchestraAPI` (`shared/ipc.ts`),
registered in the `apiHandlers` table + `METHOD_IPC_CHANNELS`
(`api-handlers.ts`), and closured in `preload/index.ts` — wired mechanically to
ipcMain. Design mode adds three on the same path: `browserDesignArm` /
`browserDesignDisarm` / `browserDesignPoll` (`browser:designArm` /
`designDisarm` / `designPoll`). Tabs add `browserTabNew` / `browserTabActivate` / `browserTabClose` (`browser:tab*`, see Human tabs). The `browser:event` broadcast is declared as `onBrowserEvent`
(`shared/ipc.ts`), pushed through `platform.broadcast`, and subscribed in
preload. Panel teardown rides the workspace-delete handlers
(`browserPanel.destroyPanel(id)` beside `sdkStopMany`) **and the archive path** —
`archiveWorkspace` (`workspaces.ts:579`) calls `destroyPanel` for every workspace
in the archived subtree, so an orchestrator archives its children's panels too.

## Tab memory (#394)

Each tab's renderer RSS is billed to its owning workspace on the Resources page, the 60 s monitor line and `bus-status` (design, shared-pid split, limits: `resources.md` § Browser tab memory). The panel's only part: `initBrowserPanels` registers a read-only **tab source** (`setBrowserTabSource`, `src/main/browser-tab-memory.ts`) — every live tab's `{ wsId, tabId, webContents.getOSProcessId() }` read from `panels` through `liveContents(tab)`, plus the main window's UI renderer pid as `nonTabPids` (never billed). It never reaps or publishes: the sampler must not change panel state. A new tab, a closed tab and a reaped dead tab need no extra wiring — the source is read per sample, so the figure follows the registry.

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
- `Target.createTarget` is unsupported in Electron, so a CDP client cannot open
  a tab itself — new tabs come from `createTab` (the registry), which the CDP
  proxy (#395) will expose. Until agent tabs land the agent's `navigate` reuses
  the one (active) tab.
- Bounds are device-independent pixels relative to the window content; apply
  them **after** the view is added (next animation frame) so the placeholder has
  laid out.

## Usage census (#392, spec #388 success metric)

`scripts/browser-usage-census.mjs` counts the agent browser calls in the Claude Code transcripts (`~/.claude*/projects/**/*.jsonl`, **read-only**) so the "agents moved from my Chrome to the panel" claim can be re-measured after profils navigateur ship. Run: `node scripts/browser-usage-census.mjs [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--root <projects-dir>]… [--format json|table|both]` (default: JSON on stdout, table on stderr; UTC days, both bounds inclusive; exit 3 on a scan of 0 files — never a silent zero baseline).

- **Counted = `tool_use` blocks of `assistant` records**, de-duplicated by tool_use id, grouped as `chrome-main` (`mcp__chrome-main__*`), `chrome-devtools`, `panel-mcp` (`mcp__browser__*`) and `orchestra-browser-cli` (a `Bash` block whose command RUNS `orchestra browser <sub>`; one block = one call). Sessions = distinct `sessionId` per surface.
- **Not counted** (the traps, each pinned by `src/shared/browser-usage-census.test.ts` + the fixture `scripts/fixtures/browser-usage-census/`): tool listings (`attachment` deferred-tools / `system` init), prose and `tool_result` text naming a tool, `api-request-blob` records (replays of a request — 211 of the 1,280 raw `chrome-main` hits on 2026-10-25), and `orchestra browser` inside a quoted string or heredoc (`shellSkeleton` strips those; `$(…)` / backticks / `sh -c '…'` payloads are scanned).
- Must-FAIL: the test mutates a scratch copy of the script (names-anywhere, plain-substring CLI match, no id de-dup) and requires the fixture control (one call + listings → exactly 1) to redden.
