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
- **`src/main/browser-popups.ts`** (#396) — user-gesture tracker (`trackUserGesture` / `consumeUserGesture`) + the per-workspace registry of popup child windows
  (`registerPopupWindow` / `livePopupWindows` / `closePopupWindows` / `closePopupsOpenedBy` / `setPopupWindowsVisible`); the routing flow itself is `routePopup` in `browser-panel.ts` (see Popups).
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
  size); popups are routed by `routePopup` (see Popups, #396).
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
  what is active afterwards = right neighbour, else left; **closing the LAST tab → `replaceWithBlank`**), `decidePopup` (the popup routing, see Popups #396). #397 consumes the ownership rule.
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
  Label = `tabLabel` (title, else host, else "New tab"). URL bar: every state from main goes through `applyState` (also records `latestUrl`, which `onBlur` resets the bar from).
  **KNOWN PRE-EXISTING DEFECT, NOT FIXED:** after the first navigation of a blank tab the bar can stay EMPTY (seat 3, interleaved: 8/26 on the #393 code vs 3/26 on the code before it — not distinguishable; 4/14 on the older tip). Trace: submit → the input blurs 10–38 ms later → `onBlur` resets the bar to `latestUrl`, still `''` because main has not pushed the url yet → the input is refocused 1–11 ms later → the `browser:event` carrying the url is skipped (`urlFocused`) → `''` stays. A ref cannot help: both are `''` at the blur. A real fix has to keep the typed/submitted text through the blur (or not blur-reset while a navigation is in flight). Rig arm `urlbar` is only a PROBE: it never reproduced the empty bar (0/36), so a green arm proves nothing about it.
- **Tests:** `scripts/verify-browser-tabs-panel.mjs` (stub Electron: cap with no leaked view, ownership, last tab, one view composited, persist →
  fresh module instance → restore, destroy forgets) + `scripts/verify-browser-tabs-panel-mutants.mjs` (33 in-place mutants, byte-exact restore);
  built-app rig `scripts/e2e-browser-tabs.sh` (3 tabs → graceful restart → SIGKILL restart; compositor pixels via `grim`; cap; last tab; two workspaces; server-down tab; closed pane stays closed) +
  `scripts/e2e-browser-tabs-mutants.mjs` (10 rebuilt-app mutants). Fixture pages `scripts/fixtures/browser-site/pages/tabs-{a,b,c}.html`.
- **Traps:** a `WebContentsView` that is not the active tab of the focused workspace is NOT in the window (never composites); the rig's pixel
  clauses are the only oracle for that (DOM cannot see paint). `Browser.close` over the debug port is a graceful quit that reaches
  `before-quit` (the flush); a SIGKILL restart relies on the 400 ms debounce alone — both are driven.

## Popups (#396) — `_blank` → tab, OAuth → native child window, budget

A page-opened window never loads into the opener's view any more (that broke every `window.opener` OAuth flow). `setWindowOpenHandler` is installed
per contents by `watchPopups` (tab views AND popup child windows) and answers through `routePopup` in `src/main/browser-panel.ts`.

- **Pure policy — `decidePopup(req, ctx)` in `src/shared/browser-tab-policy.ts`** (`browser-tab-policy.test.ts`): `PopupRouteDecision` =
  `new-tab{activate,pageInitiated}` | `child-window{pageInitiated}` | `external` | `refuse{reason: cap|budget|rate|unsafe-url|unsafe-features|no-gesture-external|name-in-use}`.
  Rules, in order: **OS hand-off is an ALLOWLIST** — only `mailto:`/`tel:` (on a click) ever reach `shell.openExternal`; every other scheme (`javascript:`, `data:`, `file:`, `ssh:`, `smb:`, `zoommtg:`, internal pages…) is refused, because an agent's CDP click counts as a click
  (review F3); a `webContents` key in the features string is refused (`featuresSmuggleWebContents`: Electron spreads the page's value over the real guest handle); **cap** = tabs + live popup windows ≥ `BROWSER_TAB_CAP` (8, shared, refuses even a click; the human's `+` / `tryOpenTab` counts the windows too);
  a named popup whose name a window opened by ANOTHER OPENER holds is refused (`name-in-use`, F5); **budget** = a no-gesture popup while `POPUP_BUDGET` (3) page-initiated ones (tabs + windows) are still open; **rate** = a no-gesture popup once `POPUP_RATE_MAX` (6) page-initiated ones were OPENED
  in the last `POPUP_RATE_WINDOW_MS` (60 s), closed or not — the budget alone is concurrent, so open/close churn was unbounded (F4). Route: a popup that needs
  `window.opener` — **named** (`frameName` not ''/`_blank`/`_self`/`_parent`/`_top`) or **sized** (`disposition:'new-window'` WITH a features string — a features-less `new-window` is a shift-clicked link: a tab) and without an explicit
  `noopener` feature — is a child window; everything else is a tab, activated only for a clicked foreground link (not `background-tab`, not page-initiated).
  Electron reports `features:'noopener'` only for `window.open(…,'noopener')`, never for `rel=noopener` anchors (measured), so that is the only opt-out.
- **User gesture — `src/main/browser-popups.ts`:** Electron's handler does not say whether a gesture started the popup, so `trackUserGesture`
  records the last activating `input-event` (`mouseDown`/`keyDown`/`rawKeyDown`/`touchEnd`, also CDP-dispatched input = how the agent clicks) per
  contents and `consumeUserGesture` reads it within `USER_GESTURE_WINDOW_MS` (5 s, Chromium's activation window) and **consumes it: one input opens
  one popup** (a click that fires 20 `window.open` = 1 shown popup + 19 on the budget); **a main-frame `did-navigate` clears it** (a click on page A is no gesture for the page it navigated to — it would let that page open an OS handler or skip the budget). `evaluate(…, userGesture:true)` fires no input event: counted as page-initiated.
  The gesture is per webContents, not per frame (accepted gap: a click anywhere lets a cross-origin iframe use it for 5 s).
- **New tab:** `createTab(wsId,{url,openedBy,activate})` with `openedBy` **inherited from the opener tab** (an agent tab's popups are agent-closable, the human's are not);
  the handler denies Electron's own window. Page-opened tabs are tracked in `pageOpenedTabs` (a WeakSet — closing the tab gives its budget back); the per-minute opens in `notePageInitiatedOpen` / `recentPageInitiatedOpens`.
- **Child window — built by OUR `createWindow` factory, never from the page's features (review F1).** Electron builds a popup's options as `{ show:true, width:800, height:600, ...parseFeatures(<the PAGE's features>), ...ours }` — so
  `alwaysOnTop,frame=no,transparent,fullscreen,kiosk,modal,closable=no,focusable=no,width=4000` would give a hostile page a screen-covering, frameless, un-closable window (measured on 33.4.11's shipped `guest-window-manager`). `routePopup`
  therefore answers `{action:'allow', createWindow, overrideBrowserWindowOptions:{webPreferences:{sandbox,contextIsolation,nodeIntegration:false}}}` (the override is what Electron derives the GUEST's own preferences from) and
  `createPopupWindow` (the factory) builds the window from **`buildChildWindowOptions`** (`src/shared/browser-popup-window.ts`, pure): an ALLOWLIST of `webContents` (the real guest, only when it is an object), `parent` = the app window, `show:false`, `resizable:false`
  (**a resizable child window is TILED beside the app by sway — halving it; a fixed-size one floats**, measured), `autoHideMenuBar`, the pinned `webPreferences`, and a `width`/`height` clamped to [200×150, 90% of the app window] (junk or zero sizes fall back to 480×520; Electron itself merges 800×600 first, so a feature-less named popup is 800×600 clamped to 90%). No position, no frame / transparency / z-order / fullscreen / kiosk / modal /
  closable / focusable key — they take their safe defaults by being absent. Electron REQUIRES the factory to return the guest it handed over (it throws "Invalid webContents" otherwise); a guest we may not give a window (panel gone, cap filled meanwhile) is `close()`d and handed back, never left windowless.
  With `createWindow` there is no `did-create-window`: the factory registers the window itself (`registerPopupWindow`), installs the same handler on ITS contents (nested popups follow the same policy and budget) and shows it only if its workspace is the one on screen
  (`focusedWsId`; a page-initiated one with `showInactive`; the gestured one with `show` — accepted gap: it takes OS focus). **The decision travels in the factory's closure** (the old per-opener `pendingPopup` slot could mix two approvals up across cross-process frames, F6).
  The title is ours (`popupWindowTitle`: `<origin> — <sanitised page title>`; `page-title-updated` is prevented; control + bidi characters stripped, cut at 80) so a frameless-looking page cannot pass for someone else (F2).
  Child windows are NOT in the tab registry (the CDP proxy #395 and agent tab tools do not see them), but they ARE billed to their workspace in the #394 tab-memory source (`setBrowserTabSource.tabs()` lists them as `w<n>`; the Resources chip counts them as tabs) and they hold cap slots.
- **Page-driven bounds are vetoed (review F-a):** Electron APPLIES a page's `window.resizeTo` / `moveTo` by default and `resizable:false` does not stop it (measured on 33.4.11: a 400×329 popup became the whole 1600×1000 screen), so the creation-time clamp would last only until the page's first script.
  `content-bounds-updated` is vetoed (`preventDefault`) on every popup window and, as defence in depth, on tabs (measured: a TAB's resizeTo does not move the app window).
- **External protocols (review F-b):** a link click or a redirect to `ssh:` / `zoommtg:` / `smb:` … inside a tab or popup never goes through `window.open`: Chromium's external-protocol path asks the SESSION for the `openExternal` permission and then runs `xdg-open` (measured with a recording shim: a plain `ssh://` link
  click reached it; a CDP agent click is a user activation). `guardExternalProtocols` (once per panel session; popup windows inherit the opener's session) answers that request with the SAME allowlist as the popup path (`isOsHandoffUrl`: `mailto:`/`tel:`), logs a refusal with the SCHEME only, and keeps Electron's default (granted) for every other permission.
- **Electron's frame-name registry is process-global (F5):** `window.open(url, 'oauth')` loads into ANY live window registered under that name — across tabs, workspaces and partitions — and that window's `window.opener` is still the tab that created it, so a hostile tab could retarget another tab.
  `PopupWindow.frameName` + `frameNameHeldByOther(name, opener)` make the policy refuse a named popup while a window of that name was opened by a DIFFERENT opener (another workspace OR another tab of the same one); the holder itself reuses its window (the browser resolves a same-context name natively; no new window, no cap slot).
  Names held by windows Orchestra did not create (login windows) are unknown here.
- **Electron's own per-embedder factory slot (backstop):** Electron keeps ONE `createWindow` / options slot per embedder, set in `-will-add-new-contents` and consumed in `-add-new-contents`; if another popup's approval lands in between (cross-process frames — NOT measured in the built app: a 40-call same-frame storm never overlapped), a popup takes Electron's DEFAULT path:
  a window built from the PAGE's features, no registry, `did-create-window` emitted. Our factory never emits that event, so `watchPopups` destroys any window it announces (`popup window created outside the allowlist factory`). A rare OAuth popup lost in that interleave is the price of never leaving the hostile window up.
- **Guest-less path:** if Electron ever calls the factory without a guest (the legacy `-new-window` path; unreachable today: it carries no frame name and no features), the factory builds the window pinned to the OPENER's session and loads the URL itself.
- **Rate is counted when a window really opens** (in the factory / the tab creation), not at approval: a reused named window or a refused guest consumes none.
- **No leaked windows:** the registry (`livePopupWindows`) prunes destroyed windows on read, so counts cannot drift; windows die with their opener (`wc.once('destroyed')` → `closePopupsOpenedBy`, recursive)
  and with the workspace (`destroyPanel` → `closePopupWindows`, belt and braces for an opener that never announces its end; **every delete path reaches `destroyPanel`: `teardownWorkspace` calls it**, so the socket `orchestra delete`, bulk delete and repo removal no longer leak the panel — only archive and the two IPC wrappers did before); `hidePanel` hides them, `showPanel` brings them back (`showInactive`),
  so a sign-in window never floats over another workspace's UI. A refusal is logged `popup refused (<reason>) ws=… url=<origin>` (origin only: OAuth URLs carry tokens in the query) — no UI notice.
- **Not handled (accepted gaps):** no UI notice for a refused popup (log only) — in particular a `name-in-use` refusal is silent and keyed on library defaults (Auth0 `auth0:authorize:popup`, Google `oauth2`…): two tabs signing in at once, or an abandoned popup, block the second sign-in with a log line only; the `did-create-window` backstop destroys the stray window AFTER it was created (alive for a tick, uncounted by the rate cap) and a legitimate popup that loses that race dies with it (needs two cross-process frames; unmeasured); an UNNAMED, feature-less `window.open(url)` that relies on `window.opener` becomes a tab with no opener (spec: "unnamed → tab");
  a `target=_blank` form POST loads as GET (pre-existing); `referrer` is not forwarded; the gesture is per webContents, not per frame; the namespace import of `electron` in `browser-panel.ts` exists because the #391/#393 stub harnesses do not export `BrowserWindow`.
- **Tests:** `browser-tab-policy.test.ts` (every routing clause), `src/shared/browser-popup-window.test.ts` (the builder against Electron's own parse + merge, replicated in `electron-guest-window.testlib.ts`: hostile keys, sizes, smuggled webContents, prototype pollution, title), `src/main/browser-popups.test.ts` (gesture window/consume, registry, frame names, rate),
  `src/main/browser-panel-popups.test.ts` (real `browser-panel.ts` over a stubbed `electron`, driven the way Electron 33 drives it — handler, then the factory with the merged options, which must return the guest: tab, budget / rate storms, cap shared with windows, hostile features, factory refusals, F5, F2, #394 billing, hide/show, no leaks),
  `src/main/browser-popups-wiring.test.ts` (every delete path destroys the panel); `scripts/mutate-browser-popups.mjs` (in-place mutants, byte-exact restore; `browser-popups-wiring.test.ts` matches code only, anchored, with controls for the commented-out / conditional shapes). Hostile-features probe by verifier seat 3 (`hostile-features-probe.mjs` on the verifier branch `verif-barriere-navigateur-3-388`, not in this tree; adapter = `buildChildWindowOptions` fed by Electron's REAL shipped merge: 29 hostile strings, run 29/29 green).
  Built app: `scripts/e2e-browser-popups.sh <app-dir>` (own headless sway in the private runtime world; arms `blank,oauth,xsite,hostile,extproto,storm,ws,cleanup` — `extproto` clicks `ssh://` / `zoommtg://` links in a tab and in a popup against a RECORDING `xdg-open` shim on the app's PATH, with a mailto click as the positive control — storm phases `s1,s2,s2b,s2c,s3,s4,churn` selectable alone: the rig itself spaces its page-initiated opens under the 6/min rate cap) —
  the OAuth flow completes through a real child window, same-site and CROSS-SITE (`localhost` vs `127.0.0.1`), titled with its origin, floating, cookie in the opener's jar; a hostile `features` popup stays bounded and floating and its page's `resizeTo(4000,4000)`/`moveTo(0,0)` changes nothing; a `webContents` feature is refused; storms capped (script / mixed / named / near the cap / one click / churn); a click→navigate gives the next page no gesture; shift-click = tab; archive leaves nothing —
  + `scripts/e2e-browser-popups-mutants.mjs` (rebuilt-app mutants incl. `R0-unfixed-same-view-handler`, today's handler, and R14–R20 for the hostile-features, bounds and external-protocol fixes). Fixture pages `scripts/fixtures/browser-site/pages/popups-{opener,oauth,blank,storm,hostile,extproto}.html`.

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

## CDP proxy + `orchestra browser` CLI (#395, ADR 0009)

Agents drive the panel from Bash with `orchestra browser <cmd>` (snapshot, click `@eN`, fill, press, wait, upload,
dialog, screenshot, cookies/storage, console/network, tabs…). The `mcp__browser__*` tools keep working beside it
(removed by #399). Spec #388; ledger #405.

```
agent Bash ── orchestra browser click @e2                       src/cli/index.ts  case 'browser'
   │  prepareBrowserCommand (rewrite, THEN allowlist the final argv) ─► POST /browser {id, key} ─► hooks socket   src/shared/browser-cli.ts
   ▼                                   (ADR 0008: id + ORCHESTRA_SESSION_KEY, verified by the host)
dispatchBrowserRequest ── ensureEndpoint(wsId) ── ensureDaemon ──► {binary, wsUrl, env}   src/main/browser-cdp-host.ts
   │  the CLI runs: agent-browser click @e2   (child of the CLI; env = allowlist + the host's AGENT_BROWSER_* incl. AGENT_BROWSER_CDP=<wsUrl>)
   ▼
agent-browser CLIENT ──unix socket──► agent-browser DAEMON (HOST-owned, started with AGENT_BROWSER_CDP in its env)   src/main/agent-browser-daemon.ts
   ▼  WebSocket  ws://127.0.0.1:<port>/<token>/devtools/browser/<id>
startCdpProxy  (Host/Origin/token guard) ──► CdpProxyCore (fake Target.* + /json)    src/main/browser-cdp-proxy.ts · src/shared/cdp-proxy-core.ts
   ▼  CdpPanelPort → browser-panel.ts tabs registry (listTabs/getTab/createTab/activateTab/closeTab, tabContents)
webContents.debugger.sendCommand(method, params, sessionId)   (one attach per tab, shared with the legacy tools / design mode)
```

- **One loopback proxy per workspace** (`127.0.0.1:0`), created lazily by the first `/browser` call, closed by
  `destroyPanel` (workspace delete/archive) and at quit. `checkLoopbackRequest` (`shared/cdp-loopback-guard.ts`) refuses
  ANY `Origin` header and any `Host` other than `127.0.0.1:<port>` / `localhost:<port>` before routing; on top of it
  every path starts with an unguessable token (`/<token>/json/version`, `/<token>/devtools/browser/<id>`) that the host hands
  only to the verified session — a process scanning loopback ports learns nothing. **The token never appears in an argv**:
  `/proc/<pid>/cmdline` is world-readable on this host (no hidepid; `environ` is 0400), so the URL reaches agent-browser only as
  `AGENT_BROWSER_CDP` in the client's / daemon's ENVIRONMENT (verified on v0.39.2 with the real binary: env-only works, the
  daemon's cmdline is empty). The host's route reply and the CLI's memory still hold it (same-uid, ADR 0008). Token, Origin
  and Host are separate clauses with their own rig mutants. Only the BROWSER websocket endpoint is served (`/json/list`
  advertises no page-level urls). **Pre-auth sockets are bounded** (`CdpProxyLimits`): 64 concurrent sockets, a 10 s clock on
  every accepted socket (silent / half-sent requests are destroyed), `headersTimeout` 10 s (slow-header drip) — `ws`'s
  `handleUpgrade` lifts the clock for an admitted websocket, which may then idle for the daemon's 10 minutes.
- **Faked browser surface** (`CdpProxyCore`): `Target.setDiscoverTargets/getTargets/getTargetInfo/attachToTarget(flatten)/
  attachToBrowserTarget/detachFromTarget/activateTarget/createTarget/closeTarget/setAutoAttach/getBrowserContexts`,
  `Browser.getVersion`, `Browser.close` (no-op: an agent never closes the human's panel). Target ids are 32-hex derived
  from a per-proxy nonce (never the registry's `t1`); the ACTIVE tab is listed first. Page-level commands are forwarded
  to the tab's `webContents.debugger` with no session id; auto-attached child sessions (iframes) keep theirs.
  `Target.createTarget` → `createTab({openedBy:'agent', activate:true})` (interim cap 8 in `makePanelPort` until the
  tab policy #393/#397 sits in front); `closeTarget` refuses a tab the human opened. `Page.bringToFront` /
  `Target.activateTarget` → `activateTab`; an input/capture command on a non-active tab activates it first. The same
  browser-level rules apply to a TAB session: `Page.close` / `Target.closeTarget|createTarget|…` / `Browser.*` sent on one never
  reach the page debugger (they would close the human's tab or the panel); only the page's own `Target.setAutoAttach` is forwarded.
  `Browser.getWindowForTarget|setWindowBounds|setContentsSize` are answered (fixed frame / ignored): erroring on `set viewport`
  made agent-browser drop its connection.
- **Screenshots** (`shared/cdp-capture.ts`): `invalidate()` → keep the real `Page.captureScreenshot` pending with 1×1 probes
  at 250/750/1750/3750 ms → deadline 5 s → `capturePage()` (1 s bound) → a NAMED error. A clip /
  `captureBeyondViewport` request has no fallback (never a wrong image). Fault: the primary hanging has NOT been
  reproduced in Electron (the primary answered in every rig run) — the chain is unit-tested with injected timers only.
- **Hidden panel**: `framesError` makes `Input.*` and `Page.captureScreenshot` fail FAST with "this workspace's Browser
  pane is not on screen" (a non-composited view hangs them, see Gotchas); `snapshot`/`eval`/`get`/`open` work. agent-browser's
  own pre-click check can answer first ("Element '@e2' is outside the viewport") — also nothing dispatched.
- **The agent-browser daemon is HOST-owned.** The client keeps its refs (`@e1`…) in a daemon between calls; one started by
  an agent's first call would sit in that member's kernel scope as a Reliquat (Veille delay, kill + notice). The host
  runs `agent-browser get url` itself with `AGENT_BROWSER_CDP=<wsUrl>` in its env (`ensureDaemon`: `connect` insists on an argument, and an
  argument would put the token in a world-readable cmdline; socket probe; env = `abEnv` + the URL: no PATH, no secrets),
  gives it a scratch HOME + an empty `{}` config (a repo's `./agent-browser.json` can declare plugins), a short hashed
  socket dir under `$XDG_RUNTIME_DIR` (`orch-ab-<hash of ORCHESTRA_HOME>`), idle timeout 10 min, and closes it on
  panel destroy / quit (`terminateDaemonsOf`: SIGTERM by pid-file, identity re-read from `/proc/<pid>/environ` — synchronous, quit
  does not wait on the graceful `close`; then `removeSocketDir` deletes OUR hashed `orch-ab-<hash>` dir only) / next boot
  (`listSessions` sweep). Every `/browser` call re-runs `prepareLayout` (a vanished socket dir must not fail every call until
  restart). The daemon runs with `AGENT_BROWSER_NO_AUTO_DIALOG=1`: by default it auto-dismisses alert()/beforeunload, which on
  a shared panel could answer the HUMAN's own dialog unseen; every dialog now waits for an explicit `dialog accept|dismiss|status`. `ensureDaemon` is single-flight per session (two
  parallel `connect`s raced and one failed, measured). The binary is copied out of the bundle to
  `<ORCHESTRA_HOME>/browser-cli/bin/` before use (an AppImage mount can go away).
- **CLI policy** (`shared/browser-cli.ts`): an allowlist of commands; refused: `connect close session install upgrade
  plugin auth profiles dashboard stream chat mcp batch read inspect …` and every flag that re-points the client
  (`--cdp --session --namespace --profile --auto-connect --headed --config --provider --proxy …`). The COMMAND must be the
  first token (only the valueless `--json` may lead) and refused flags are refused ANYWHERE, `--` included: agent-browser
  parses global options wherever they stand, so a leading value-taking option (`--screenshot-dir open session info`) or a
  flag after `--` (`session -- --session x`) used to slip through (pre-review B2, verified on v0.39.2). File arguments
  (`screenshot|pdf` path, `upload` files, `network har` path, `--curl|--baseline|--output`) are made absolute by the CLI
  (`absolutizeBrowserArgs`): the daemon is the host's, so a relative path would land in the app's cwd. The child's env is
  an allowlist of the caller's (`PATH LANG TERM TMPDIR …`) + the host's — the caller's `AGENT_BROWSER_*` never pass.
  Identity: `{id, key}` must verify against the session-key registry (ADR 0008); NO env fallback (a browser command acts
  on a panel) — no key, a stale key or another workspace's key is refused, an unknown id likewise.
- **Stale refs**: agent-browser v0.39.2 reports a ref that no longer resolves as `Could not locate element with role=… name=…`
  (an unknown one as `Unknown ref: eN`); the CLI maps either, for a command that used `@eN`, to
  `browser_stale_ref: @eN no longer resolves…` (and `{"code":"browser_stale_ref"}` under `--json`).
- **agent-browser v0.39.2 vs the faked surface (measured with the real binary)**: connect = `Target.setDiscoverTargets`,
  `getTargets`, `attachToTarget{flatten}`, then `Runtime.evaluate "1"` on the new session (it hangs on a tab that never
  navigated → `acquire` loads `about:blank` first, else "tab is not responding"); per command it calls
  `Browser.getVersion`; `WebMCP.enable` goes to Electron and may error (tolerated); `tab new` = `Target.createTarget`;
  `tab close` of the last tab is refused client-side; `connect <url>` starts a detached daemon (ppid 1) and returns,
  later calls without `--cdp` reuse it; `close` only disconnects (our proxy no-ops `Browser.close`); a daemon whose proxy
  died reconnects when the next call carries a new `--cdp`.
- **State an agent leaves on the shared tab.** `set viewport|device|media|offline|geo|headers` and `network route` live on the
  tab's debugger session, and in Electron 33 **`detach()` alone does not clear an `Emulation.setDeviceMetricsOverride`**
  (measured: innerWidth stayed 360). When the agent's last session has been gone for 15 s (`RELEASE_GRACE_MS`,
  `ORCHESTRA_CDP_RELEASE_GRACE_MS` for rigs; a session coming back cancels it — agent-browser reconnects lazily), the host
  sends `resetCommands` (`shared/cdp-reset.ts`) and then detaches; the legacy tools re-attach on demand. The renderer's pane
  already attaches this debugger (design-mode disarm on mount), so the proxy almost always SHARES it.
- **agent-browser quirks (v0.39.2)**: `tab close tN` prints "✓ closed" even when the proxy refused (a human-opened tab) —
  the registry is the truth; a click on a hidden pane is refused by agent-browser itself ("outside the viewport") before any
  input reaches us.
- **Coexistence with the legacy path** (until #398): `makePanelPort.acquire` attaches `webContents.debugger` only if nobody
  has (`isAttached()`) and sets `tab.debuggerAttached`; the core takes ONE `port.acquire` per tab however many sessions attach
  at once (single-flight — a raced second acquire used to be released while the tab was held, arming the reset under a live
  session) and calls `port.release` once, when the last session goes. `release` does NOT detach at once: it arms the 15 s
  grace (above), after which the agent's overrides are undone and the debugger detached; design mode / MCP tools keep sharing
  the attach and re-attach on demand.
- **Pinned binary**: `scripts/agent-browser-pins.json` (v0.39.2, SHA-256 per asset, linux-arm64 + linux-x64),
  `scripts/agent-browser-fetch.cjs` (plain CommonJS, run IN-PROCESS by the `beforePack` hook `scripts/before-pack.cjs` — which
  also runs #390's pinned-Node hook — so EVERY packaging path gets it under whatever Node it uses: release.yml packs on Node 20,
  which has no `--experimental-strip-types`; proven by running the whole chain under Node 20.19.5 for arm64 AND x64, and by the old
  chain failing there with `bad option`; `pnpm run fetch:agent-browser` runs the same file; `afterPack` re-hashes the packaged file; cache under `$XDG_CACHE_HOME/orchestra-build`) → `build/agent-browser/agent-browser` (git-ignored) → `extraResources` →
  `<resources>/agent-browser/agent-browser`. `ORCHESTRA_AGENT_BROWSER_BIN` overrides (rigs).
- **File arguments and `--flag=value`**: `prepareBrowserCommand` rewrites BEFORE it validates — only the KNOWN value flags
  (`--screenshot-format|-quality|-dir`, `--depth`, `--curl|--baseline|--output`, …) are split from `--flag=value` into `--flag value`
  (agent-browser parsed the `=` form as the positional, and a file literally named `--screenshot-quality=30` appeared in the host's
  cwd); anything else with an `=` is data and stays ONE token (`type @e2 --api-key=sk-123`). The allowlist then judges the argv the
  client will actually receive, so no rewrite can manufacture a refused flag (`--json=--cdp 9222`, `--screenshot-format=--cdp`).
- **Tab policy seam**: #393 (human tabs, tab policy) is merged; `makePanelPort.createTab` (interim cap of 8) and `closeTab` (bare
  `bp.closeTab` after refusing a tab the human opened) deliberately do NOT call `tryCreateTab|tryCloseTab` — that wiring (and the
  last-tab / persisted-snapshot case) belongs to #397, which owns agent tabs against this seam. `cookies clear` / `storage clear`
  act on the tab's whole partition: harmless on the ephemeral per-workspace partition, but a shared profile (#400) would be
  reached — #400/#401 must decide whether to refuse them for a workspace holding a profile.
- **Policy seam** (`CdpPanelPort.refuseMethod?(method, params, tab)`, core `tabCommand`): called for EVERY page-level command of a tab
  session (root and auto-attached child sessions) BEFORE the debugger, with the tab as the registry sees it NOW (its url scopes
  origin-bound policy); the verdict contract is STRICT: only `null` allows, a non-empty string refuses with that text, and anything else (`''`, falsy values, `undefined` from a present hook, a Promise from an async hook, an object) or a throw refuses fail-CLOSED with a generic message — the exception text never reaches the agent. `Target.sendMessageToTarget` and
  `Target.exposeDevToolsProtocol` are refused outright (a command smuggled inside one would skip any per-method policy). The host's
  `makePanelPort` does not set the hook yet: #400 wires its profile policy there. **One shared predicate**
  `isBrowserLevelMethod(method)` (`src/shared/cdp-proxy-core.ts`, exported: `Page.close`, `Browser.*`, the browser-level `Target.*` set)
  is applied to a root tab session AND to every auto-attached CHILD session (iframe / worker) BEFORE the root/child split in `dispatch`:
  `Page.close` becomes `Target.closeTarget` of the owning tab (close ownership), `Browser.close` is a no-op, the rest answer "wasn't
  found" — none reach the debugger. Without it a worker session's `Browser.close` reached Electron's debugger and tore the page down
  (measured by the `child-session` arm's mutant). Consumers such as #397's close ownership call this predicate, never a copy. `orchestra browser get cdp-url` is refused and
  `redactEndpoint` scrubs the endpoint/token from all client output.
- **Tracing**: `ORCHESTRA_CDP_TRACE=1` logs every client request / reply / forwarded command to the app log.
- **Gates**: `shared/cdp-loopback-guard.test.ts`, `cdp-capture.test.ts`, `cdp-proxy-core.test.ts`, `browser-cli.test.ts`,
  `agent-browser-binary.test.ts`, `main/cdp-proxy` (`browser-cdp-proxy.test.ts`, `agent-browser-daemon.test.ts`); built-app rig
  `scripts/e2e-browser-cli.sh <app-dir>` (18 arms against the fixture site `scripts/fixtures/browser-site`, oracle = the app's
  own debug port) and `scripts/e2e-browser-cli-mutants.sh <app-dir>` (33 in-place bundle mutants, restored byte-exact + `cmp`; `--check-anchors <app-dir>` proves each still matches once, no Electron).
