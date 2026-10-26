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
  Orchestra's own renderer as a CDP target too). **Since #398 the CDP proxy is
  the ONLY debugger attacher** (`browser-cdp-seat.ts`, see *Single attacher*
  below): `browser-panel.ts` holds no debugger and runs every command through a
  proxy lease.
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
   │  CDP commands = a proxy lease (cdpSeat.send); capturePage() for screenshots
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
  primitives** over CDP commands leased from the proxy (`cdp()` → `cdpSeat`, #398): `capture` (JPEG via `capturePage`),
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
- **Shapes** (`browser-panel.ts`): `Tab {id, view, openedBy, designHold,
  designArmed, designOp, nav}`; `Panel {wsId, tabs, activeId, attachedId, bounded, bounds, pendingShow,
  state, view}` — `attachedId` is the tab whose view is in the window right now
  (`null` = not composited; replaces the old `visible`), `bounds` the last
  renderer rect (re-applied to a view on attach), `view` a getter for the ACTIVE
  tab's view (the three `scripts/verify-*browser-panel*.mjs` harnesses read it).
- **Exports**: `listTabs` · `getTab` · `getActiveTab` · `createTab(wsId,
  {url?, openedBy, activate?})` (no cap, no policy; `activate` defaults false;
  runs `ensurePanel` first, so a fresh workspace gets `t1` human then the new
  tab) · `activateTab` · `closeTab` (both THROW on an unknown id). Every
  pre-existing export keeps its signature and acts on the ACTIVE tab; the
  CDP primitives (`evaluate`, `capture`, `readPage`,
  `clickAt/Ref`, `typeText`, `formInput`, `scrollBy`, `designMode*`) and
  `navigate/goBack/goForward/reload` take an optional trailing `tabId`
  (`resolveTab`). `cdp()` stays internal.
- **Composition rule**: only the ACTIVE tab of the FOCUSED workspace is in the
  window (`attachActive` swaps; `activateTab`/`closeTab` on a hidden panel
  attach nothing). `capture`/`clickAt`/`typeText`/`scrollBy` on a non-active tab
  fail with "not the active tab" (a background tab produces no frames, same
  trap as a hidden panel); `evaluate`/`readPage`/`navigate` still work on it.
- **Teardown iterates every tab**: `destroyPanel` (workspace delete AND the
  archive path) calls `destroyTab` on each — the proxy seat's force-detach
  (`tabTeardownHook`, registered by `initBrowserCliHost`) then
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
- **An explicit `tabId` never builds a panel**: `evaluate`/`designModeArm` (via `liveTabFor`)/…
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
  SAME `cdp()` / `evaluate()` helpers the agent tools use, which run on a lease
  of the CDP proxy's debugger attach (#398) — design mode holds **no debugger of
  its own** (attaching twice to one target throws). While armed it keeps ONE
  lease (`Tab.designHold`, taken before the script is injected) so the 150 ms
  poll does not attach/detach on every tick and an agent command on the same tab
  cannot detach the debugger from under the picker; a pick, Escape or a disarm
  gives it back (the pick's cropped screenshot rides the same lease, released
  after it).
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
- **Arm and disarm run in order per tab** (`Tab.designOp`): the renderer fires
  `browserDesignArm` then (toggle off) `browserDesignDisarm` without awaiting, and
  arm now awaits its lease before injecting — an unordered disarm would find no
  lease, return, and leave an invisible click-swallowing overlay. `Tab.designArmed`
  is set synchronously by the arm so a disarm queued behind it targets that tab; `Tab.designGen` (bumped by every arm at call
  time) makes EVERY path that clears arm state end only the arm it was issued against: `endDesign(tab, gen)` REQUIRES the
  generation captured when that piece of work started and no-ops under a newer arm. The paths: the arm's own catch (A1 fails
  mid-install, e.g. "Execution context was destroyed", while a URL-change re-arm A2 is queued), the disarm's finally (an arm
  called while its teardown is in flight), the poll's finally (gen read BEFORE the `readRawPick` await, so a re-arm inside that
  round trip is not folded into the pick's generation, nor one during the screenshot), and a disarm superseded by a later arm
  (early return). Audited and not needing it: tab close / panel destroy (`destroyTab` voids the hold; the tab leaves the
  registry), the 120 s `sendOnLease` backstop (surfaces as the arm's/poll's own error → the guarded paths), workspace switch
  (`BrowserPanel` cleanup → `designModeDisarm` → `disarmTab`, guarded). Pinned by the table-driven `design arm ownership` test
  (one row per path) and one registry mutant per path. A
  disarm with nothing armed (after a pick / Escape — the page-side picker tore
  itself down) sends nothing and attaches nothing.
- **The renderer addresses design mode by workspace, not tab, and one `BrowserPanel` instance exists per workspace** (`App.tsx`
  keys it `key={active.id}` since #393: switching workspace UNMOUNTS the old instance). So: (a) a disarm
  with no `tabId` disarms EVERY tab of the workspace it is armed on (`armedTabs`), not the active one (an agent opening an
  activated tab mid-pick moves "active" away from the armed tab); (b) a pick or Escape is one-shot for the whole workspace
  (`designModePoll` tears down any other armed tab); (c) `BrowserPanel`'s cleanup effect on `[workspaceId]` is the ONLY thing that disarms the workspace it LEAVES (the new
  instance's effects only touch its own workspace) — before #398's lease this only left an orphan overlay on the old page, now it
  would also leave the lease. A
  poll for a workspace with no panel returns null and builds nothing.
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
  Label = `tabLabel` (title, else host, else "New tab"). URL bar: every state from main goes through `applyState` (also records `latestUrl`, which `onBlur` resets the bar from).
  **KNOWN PRE-EXISTING DEFECT, NOT FIXED:** after the first navigation of a blank tab the bar can stay EMPTY (seat 3, interleaved: 8/26 on the #393 code vs 3/26 on the code before it — not distinguishable; 4/14 on the older tip). Trace: submit → the input blurs 10–38 ms later → `onBlur` resets the bar to `latestUrl`, still `''` because main has not pushed the url yet → the input is refocused 1–11 ms later → the `browser:event` carrying the url is skipped (`urlFocused`) → `''` stays. A ref cannot help: both are `''` at the blur. A real fix has to keep the typed/submitted text through the blur (or not blur-reset while a navigation is in flight). Rig arm `urlbar` is only a PROBE: it never reproduced the empty bar (0/36), so a green arm proves nothing about it.
- **Tests:** `scripts/verify-browser-tabs-panel.mjs` (stub Electron: cap with no leaked view, ownership, last tab, one view composited, persist →
  fresh module instance → restore, destroy forgets) + `scripts/verify-browser-tabs-panel-mutants.mjs` (33 in-place mutants, byte-exact restore);
  built-app rig `scripts/e2e-browser-tabs.sh` (3 tabs → graceful restart → SIGKILL restart; compositor pixels via `grim`; cap; last tab; two workspaces; server-down tab; closed pane stays closed) +
  `scripts/e2e-browser-tabs-mutants.mjs` (10 rebuilt-app mutants). Fixture pages `scripts/fixtures/browser-site/pages/tabs-{a,b,c}.html`.
- **Traps:** a `WebContentsView` that is not the active tab of the focused workspace is NOT in the window (never composites); the rig's pixel
  clauses are the only oracle for that (DOM cannot see paint). `Browser.close` over the debug port is a graceful quit that reaches
  `before-quit` (the flush); a SIGKILL restart relies on the 400 ms debounce alone — both are driven.

## Profils navigateur (#400, ADR 0010) — attach, persist, delete

A **profil navigateur** is a named, persistent sign-in the HUMAN creates in Settings > Browser and attaches to a workspace from the
panel's URL bar. A workspace with none keeps **navigation éphémère** (the default). Spec #388 stories 18-26.

- **What a profile is.** `BrowserProfile {id, name, createdAt}` (`shared/types.ts`; id = `BrowserProfileId` = `bp-` + 12 hex, minted by main) in
  `store.json` (`browserProfiles`, `store.getBrowserProfiles()` normalizes it); the workspace carries `Workspace.browserProfileId?` (absent =
  ephemeral; a dangling id — profile deleted, store hand-edited — reads as ephemeral through `effectiveProfileId`). The partition is
  `persist:orchestra-profile-<id>` (on disk under `<userData>/Partitions/`), shared by every workspace that attaches it; the ephemeral one stays
  `orchestra-browser-<wsId>` (in memory, no directory). **ALL tabs of a workspace use ONE partition**: `Panel.partition` / `Panel.profileId`
  are fixed at `ensurePanel` (resolved through `setBrowserProfileResolver`, installed by `browser-profiles-host.ts`) and read by `buildTab` — the
  ONLY place a partition is chosen (restored tabs and agent tabs included). `BrowserPanelState.profileId?` is what the panel really runs on.
- **Pure rules — `src/shared/browser-profile.ts`** (`browser-profile.test.ts`): id/name validity (`checkProfileName`: 1..40 chars, unique
  case-insensitively among the OTHER profiles), `partitionFor(wsId, profileId|undefined)` / `profilePartition` (throws on a non-minted id — free
  text never reaches a partition name), `effectiveProfileId`, `decideAttach` (attach / switch / detach / unknown; `changed:false` = nothing to
  rebuild), `decideDelete` (the carriers to detach), `isHumanProfileCaller`, `PROFILE_AT_REST_WARNING` (the always-on create warning).
- **Service — `src/main/browser-profiles.ts`** (Electron-free, `browser-profiles.test.ts`): `create/rename/remove/attach`, serialized (a second click
  waits for the first). **Delete order matters**: every carrier is detached (record cleared — as an explicit `undefined`, because the renderer MERGES a
  `workspace:update`, an absent key would keep the old id there — and the open panel rebuilt ephemeral; the only writers into
  the partition die first, and are awaited) → the partition's storage is cleared → ONLY THEN the profile is forgotten; a failed clear keeps the profile (`storage`
  refusal, retryable) instead of dropping a profile whose sign-ins are still on disk. The emptied `Partitions/orchestra-profile-<id>` directory itself stays (a live session holds it); its cookie DB / storage are empty and its id is never reused. Attach records the id THEN rebuilds the panel, rolling the
  record back if the rebuild throws. Wiring to the store / `session` / panel: `browser-profiles-host.ts` (`clearStorage` = `clearStorageData`
  + `clearCache` + `clearAuthCache` + flush).
- **Moving a panel — `reprofilePanel(wsId, profileId|undefined)`** (`browser-panel.ts`): a view's partition cannot change, so EVERY tab is rebuilt in
  the new partition — **same tab ids, openers, active tab**, each reloaded at its URL (`restoreUrls` keeps the remembered URL until a navigation
  commits) — the old views (debuggers included) are destroyed and the active one re-composited. Same identity = no-op; a panel that is not open
  is NOT built (it takes the identity from the record at its first `ensurePanel`, restored tabs included). The rebuilt tabs of a workspace that
  is not on screen broadcast like any tab events do (the renderer's auto-open of a pane on a real URL is pre-existing, #393 review F2).
  A view that cannot be built rolls the whole move back (old tabs alive, old identity, old view composited, error surfaced — never a half-built
  panel). `webContents.close()` is ASYNC, so EVERY view close (`destroyTab`: a re-profile, a tab close, a panel teardown) is tracked (`trackClose`) and a
  delete waits for them (`settleClosedViews` → boolean, 3 s cap) before wiping the partition — a page's `pagehide` write must not repopulate a "deleted"
  profile; on a timeout the delete REFUSES (`storage`: profile kept, carriers already ephemeral, retry). Then `stopSignInPersistence`, then the wipe.
  Once the move is committed nothing may throw out of it (a close/re-composite failure is logged, never rolled back); `workspacesOnProfile` lets the delete
  also move off any OPEN panel that still runs on the profile though its record says otherwise.
- **The agent's CLI across a rebuild (seat-2 MAJOR).** A tab id keeps its number but the PAGE behind it is new. `makePanelPort.subscribeTabs` (`browser-cdp-host.ts`)
  snapshots each tab with its view (`webContents.id`) and diffs through the pure `diffTabs` (`shared/cdp-tab-diff.ts`): same id + different view = ONE `replaced`
  event (never a `changed`: before, the proxy only saw the old debugger's `detach`, and the agent-browser daemon kept sending `Runtime.evaluate` on the dead session
  id forever — `Session with given id not found`). The core (`cdp-proxy-core.ts` `onTabReplaced`) detaches the old sessions under the OLD target id, bumps the tab's
  `generation` (part of `targetIdFor`: the replacement is a NEW target), then emits `targetCreated(new)` BEFORE `targetDestroyed(old)` — the daemon (v0.39.2
  `drain_cdp_events`) drops a `targetCreated` for an id it still tracks when it lands in the same batch as that id's `targetDestroyed`, then empties its pages
  and opens a blank tab; a new id never meets that (the intermittency). An attach in flight across the swap gets `Target closed.` Rig arm `rebuild`: 10 attach/detach
  + 5 delete rebuilds in one boot, `get url` must answer the fixture page, and the daemon must never `Target.createTarget` nor meet a dead session. Lease holders
  (design mode, legacy tools) are not migrated: a lease taken across the swap errors on its next `send` (accepted gap).
  **#395/#397 note:** a CDP session / tab handle held across an attach or delete is on a destroyed view — re-list, re-attach.
- **Back to navigation éphémère forgets the old ephemeral session (review F9).** A workspace's ephemeral partition is an in-memory session that lives as long as the process,
  so detaching (or deleting its profile) would hand back sign-ins made BEFORE the attach. `assign(ws, null)` from a profile — and every carrier of a deleted profile — first
  clears that session (`clearEphemeral`: storage + cache + auth cache); attach / switch / an already-ephemeral detach never do (that session may be on screen).
- **ONLY the human can change a profile (story 26).** The five channels (`browserProfiles:list|create|rename|delete`, `browser:profileAttach`) are
  registered by `registerBrowserProfilesIpc` (`browser-profiles-ipc.ts`) — deliberately NOT in `api-handlers.ts`'s generic table (omitted from
  `ServableApi`; same split as `pause-ui-host.ts`). Every WRITE refuses (`not-human`, logged) unless the sender is the app's own main window top
  frame (`isHumanProfileCaller`; fail closed on an unknown frame / no main window). No CLI verb, no hooks-socket route, no `mcp__browser__*` tool,
  no mobile route exists — `browser-profiles-wiring.test.ts` scans every agent surface for the operations (with a positive control) and
  `scripts/e2e-browser-profiles.mjs` arm `human` drives them for real (CLI verbs → rc≠0, socket routes → `{}`, the agent's page has no bridge, a
  hidden FOREIGN window invoking all four write channels over the main-process inspector → `not-human`, nothing moved; the app's own window works).
  A spawn that names a profile is #401's rule (parent must hold it) and writes the record on the NEW workspace directly, never through this service.
- **Partition-wide / cross-site cookie access is refused for a profile workspace** (OPS ruling 2026-10-26; #395's fix round + its seam review + #400's review F2/F3).
  `agent-browser cookies clear` reaches the CDP as `Network.clearBrowserCookies`, which wipes the WHOLE partition — with a profile shared by workspaces A and B, A's agent
  would sign B out. The rule is `decideAgentCdp({method, params, profileId, pageUrl, frameUrls})` (`shared/browser-profile.ts`), asked by `makePanelPort.refuseMethod`
  (`browser-cdp-host.ts`; strict core contract: `null` or a NON-EMPTY string) with `panelProfileId(wsId)` read at call time, the TARGET tab's url and its live frame tree
  (`tabFrameUrls`). Refused while the panel carries a profile: CLEARS `Network.clearBrowserCookies`, `Storage.clearCookies`, `Storage.clearDataForOrigin`,
  `Storage.clearDataForStorageKey` (whatever `storageTypes` says) and partition-wide READS `Network.getAllCookies`, `Storage.getCookies`; the NAMED-SITE methods
  (`Network.getCookies|deleteCookies|setCookie|setCookies`, `Storage.setCookies`) only on the page's own HOST — **EXACT host, url-form and domain-form alike** (a url on the
  parent host addresses its host-only HttpOnly cookies that the page's JS cannot see; no PSL, so no parent-domain leniency at all); **`getCookies` WITHOUT `urls` also
  returns every SUBFRAME's cookies (CDP), so it is judged on the whole frame tree** (an SSO/IdP iframe on another host refuses it; an unknown tree refuses); and **every other
  `Network|Storage.*Cookie*` method is refused by default**. The real names the pinned agent-browser v0.39.2 emits were MEASURED through the CLI (rig arm `cdp`):
  `cookies get` → `Network.getCookies {}` (allowed on a page without foreign frames), `cookies clear` → `Network.clearBrowserCookies` (refused, never reached the debugger),
  `cookies set --url <other>` → `Network.setCookies` (refused). **What it does NOT stop (accepted, stated plainly):** the agent can navigate to another site of the profile and
  use that sign-in there (the point of a profile), and in-page script / `network requests|har` Cookie headers show what the page itself sends — it bounds what CDP can LIFT
  from the jar, not what a page can do. Ephemeral workspaces are never refused. **Agent-visible friction (by design, the refusal text says so):** on a profile workspace `cookies get` is refused while the page embeds a frame from another host (an SSO / IdP iframe) and works again on a page without one; `cookies clear` is always refused — delete the one cookie by name or ask the human.
- **Settings > Browser — `BrowserSettings.tsx`** (globe icon in the sidebar header, `store.browserSettingsOpen`): create / rename (id kept) /
  delete (the confirmation says how many workspaces lose it), the per-profile usage count, and the ALWAYS-on `[data-profile-warning="create"]` notice
  above the create field + a "not encrypted on disk" tag per row (ADR 0010: warn, never refuse — see At rest below for why it is unconditional).
- **URL bar — `BrowserPanel.tsx`**: a chip (`[data-browser-profile-chip]`, `data-profile-id`) beside the URL form shows the profile or
  "Ephemeral"; it opens an INLINE bar (`[data-browser-profile-bar]`: Ephemeral + every profile + "Manage profiles…") — inline on purpose, a dropdown
  would open under the native view, which paints above the DOM. Design mode is disarmed before the rebuild.
- **Persistence.** Cookies/localStorage live in the profile's `persist:` partition; a restart restores each workspace's tabs (#393) on it, signed in.
  `persistSignIns` (PROFILE sessions only, never an ephemeral one; one listener per session) does two things on every cookie `changed`: (1) **promotes
  SESSION cookies** — Electron 33 drops cookies without an expiry at quit (`persist_session_cookies` false; measured), and most admin/staging sites sign
  in with exactly those — by re-setting them with a **sliding 30-day expiry** (OPS ruling 2026-10-26; pure rule `shared/browser-cookie-promote.ts`: only
  `session && no expirationDate`, host-only stays host-only, secure → https url). It is **debounced per cookie** (250 ms after its last change: a site that
  rewrites a cookie every request costs one `set`) and done from the **LIVE cookie re-read** (`cookies.get`), never the event's snapshot — a cookie removed
  (logout) or rewritten with an expiry in the meantime is left alone, and the promoted copy's own expiry stops the `set → changed` echo from looping;
  (2) flushes the cookie store 1.5 s later (Chromium's own timer is ~30 s — a crash right after a sign-in lost it). `flushProfileStorage()` runs at quit;
  `stopSignInPersistence(partition)` detaches (a deleted profile must not get a cookie re-created by a late event). The read→write is guarded in TWO steps (seat-1 finding of #400, measured on the real app: a logout at 243-250 ms after the login was written back 12/200 times before the second step): (1) a per-cookie event sequence + an `alive` flag cancel the write when a removal or a newer value was already SEEN by the main process; (2) a removal the network service processes BETWEEN the read and the write reaches the main process only AFTER the write was issued, so after `cookies.set` — right away and again 300 ms later — if a GENUINE removal (a logout / expiry / eviction; NOT the `overwrite` our own write causes) arrived since the read started AND the live cookie is still exactly OUR copy (same value, expiry ±2 s), the copy is removed (`cookies.remove`) and the echo of that remove is swallowed once (it is neither a logout nor a promotion trigger; dropped 500 ms after the remove resolves). A user who logged in again meanwhile has a different live cookie and is left alone. Guarantee, stated plainly: a seen logout is never undone; an unseen one is undone within a few ms, not kept for 30 days. The cookie promoted is the one the EVENT named (`cookies.get({domain})` also returns subdomain siblings). Delete-profile clears everything including promoted cookies. The Settings copy says session-only cookies are kept 30 days after their last change.
  including promoted cookies. The Settings copy says session-only cookies are kept 30 days after their last change.
  **Accepted gap:** a partitioned (CHIPS) cookie reaches `changed` without its partition key in Electron 33's `Cookie`, so its promoted copy would land in the
  unpartitioned jar (a rare same-name collision with a first-party cookie); not detectable through the 33 API.
- **At rest (review F1).** The profile's Cookies DB holds every sign-in in CLEAR on this build: Electron's `EnableCookieEncryption` fuse is off (stock 33.4.11;
  the repo flips none) so `value` is plaintext and `encrypted_value` empty WHATEVER the keyring state (measured by rig clause
  `warning-matches-the-cookie-db-sign-in-is-stored-in-clear`; the same holds for `persist:claude-login-*`). Hence the create warning is unconditional and does not depend
  on #389's `SecretsState` (which governs `secrets.json`). Flipping the fuse in `afterPack` is a ONE-WAY change for existing persistent partitions: a separate
  decision (LEAD). A built-app rig must still pass `--password-store=basic` (the human's live keyring is never bound, G10b / incident Q2).
- **Accepted gaps.** (F8) A delete is LOGICAL: the oracle is cookie rows; SQLite free pages / leveldb tombstones / `Network Persistent State` stay on disk unmeasured, and
  nothing reconciles `Partitions/orchestra-profile-*` against the profile list at boot (a lost `store.json` leaves unlisted sign-ins with no UI to delete them).
- **Tests.** `browser-profile.test.ts`, `browser-profiles.test.ts`, `browser-profiles-ipc.test.ts`, `browser-panel-profiles.test.ts` (REAL panel over a stub
  Electron: which partition every tab is on; reprofile keeps ids/active/URLs, destroys old views, re-composites the new one),
  `browser-profiles-wiring.test.ts`; 138 in-place mutants `node scripts/mutate-browser-profiles.mjs` (`--check` = anchors live); built-app rig `scripts/e2e-browser-profiles.sh <app-dir>`
  (arms `settings,attach,human,restore,delete,flush,session,logout,rebuild,cdp` — `logout` sweeps session-cookie login→logout cycles at 225–275 ms in a profile workspace and in an ephemeral control and requires 0 resurrected; `cdp` drives the REAL `orchestra browser` CLI (host-resolved agent identity, pinned agent-browser) against a profile SHARED by two workspaces and reads the CDP methods it emitted from the proxy trace: `cookies get` → `Network.getCookies` (allowed), `cookies clear` → `Network.clearBrowserCookies` (refused, never reached the debugger), `cookies set --url <other site>` → `Network.setCookies` (refused) —, run ONLY through `scripts/e2e-contained-rig.sh` — the private runtime world of incident Q2 — with the driver taking `XDG_RUNTIME_DIR` from `scripts/lib/rig-runtime.mjs`, `--password-store=basic` handed to the app and its `ctl/scratch-env` clause asserting what the DRIVER handed it (`/proc/<pid>/environ` goes blind once a D-Bus address is set); oracles: the cookie jar read FROM each tab's page (`/whoami`), `Partitions/` and the cookie DB
  on disk, compositor pixels, store.json) + 24 rebuilt-app mutants `node scripts/e2e-browser-profiles-mutants.mjs`. Fixture: shared site (#395) + `pages/profiles.html`, `pages/profiles-logout.html`.

## IPC / seam

Request/response methods (`browserShow`/`Hide`/`Navigate`/`Back`/`Forward`/
`Reload`/`SetBounds`/`State`) are declared in `OrchestraAPI` (`shared/ipc.ts`),
registered in the `apiHandlers` table + `METHOD_IPC_CHANNELS`
(`api-handlers.ts`), and closured in `preload/index.ts` — wired mechanically to
ipcMain. Design mode adds three on the same path: `browserDesignArm` /
`browserDesignDisarm` / `browserDesignPoll` (`browser:designArm` /
`designDisarm` / `designPoll`). Tabs add `browserTabNew` / `browserTabActivate` / `browserTabClose` (`browser:tab*`, see Human tabs). Profils navigateur add `browserProfiles` / `browserProfileCreate|Rename|Delete` / `browserProfileAttach` (`browserProfiles:*`, `browser:profileAttach`) — registered by `browser-profiles-ipc.ts`, NOT this table (see Profils navigateur). The `browser:event` broadcast is declared as `onBrowserEvent`
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
  sends `resetCommands` (`shared/cdp-reset.ts`) and then detaches (since #398 this policy lives in the seat, below — every holder,
  agent session or design mode / legacy-tool lease, counts toward "the last session").
- **agent-browser quirks (v0.39.2)**: `tab close tN` prints "✓ closed" even when the proxy refused (a human-opened tab) —
  the registry is the truth; a click on a hidden pane is refused by agent-browser itself ("outside the viewport") before any
  input reaches us.
- **Single attacher (#398)**: `src/main/browser-cdp-seat.ts` is the ONLY file in `src/main` that touches `webContents.debugger`
  (`seatAcquire` = the one `attach('1.3')`, shared by refcount; `seatRelease` with the last holder starts the grace period, then
  detach — first `resetCommands` IF an agent session ever held the seat (`CdpProxyCore` marks a TabState `agent` when a client
  session attaches and passes it as `port.release(tabId, agentTouched)`; the mark is sticky until the seat drops), so design
  mode and the legacy tools alone write NOTHING to the human's page; a holder coming back cancels it; `seatForceDetach` at tab
  destroy via `bp.setTabTeardownHook`; `seatChannel` = the proxy's send/subscribe/onDetach). `makePanelPort.acquire/release` pair with it; the core takes ONE `port.acquire` per tab however many sessions attach at once (single-flight — a raced second acquire used to be released while the tab was held, arming the reset under a live session) and calls `port.release` once, when the last session goes. The app's own callers —
  design mode and the legacy `mcp__browser__*` tools (`browser-panel.ts` `cdp()`) — never attach: they call `cdpSeat.send` /
  `cdpSeat.hold` (registered by `initBrowserCliHost`, `panelCdpSeat` in `browser-cdp-host.ts`), which take an in-process
  **lease** on the workspace proxy (`CdpProxyCore.lease`, refcounted with the WebSocket clients; a lease that outlived a detach
  never decrements a newer attach) and send straight on the tab's channel (no bring-to-front, no screenshot chain: the legacy
  guards `requireComposited` / `withTimeout` still front them). `sendOnLease` gives the lease back when the command settles OR
  after 120 s (`LEASE_SEND_MAX_MS`), so a command a non-painting view never answers cannot pin the tab's debugger forever. So one agent-browser session, a design pick and a legacy call
  share ONE attach in any order, and the last holder out starts the grace. A workspace's first lease starts its proxy (no daemon:
  `Endpoint.daemon` is set only by `/browser`). `release` of a tab that never navigated: `acquire` kicks `about:blank` first.
  **Grep gate**: `node scripts/check-single-debugger-attacher.mjs [--list]` (CLEAN/DIRTY; every code use of `debugger` /
  `.attach(` / `sendCommand(` under `src/main` must sit in the seat; positive control: the same scan must find the seat's one
  `attach(` and the host must acquire it; `--self-test` injects a second attacher into a copy and requires DIRTY), pinned by
  `src/main/browser-single-attacher.test.ts`. Trace: `ORCHESTRA_CDP_TRACE=1` also logs `seat[<ws8>] <tab> acquire attached|shared`, `release kept|pending|detached`,
  `grace-over reset|plain`, `reset-command <method>`, `detached`, `force-detached`, each with `isAttached=<Electron's own
  answer>` — the rig counts attaches and reset commands from it.
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
  own debug port) and `scripts/e2e-browser-cli-mutants.sh <app-dir>` (32 in-place bundle mutants, restored byte-exact + `cmp` — `acquire-always-attach` moved to the #398 rig as `reacquire-in-grace-attaches-again`: the seat's shared-attach guard is only reachable by a re-acquire inside the grace, which that rig drives; `--check-anchors <app-dir>` proves each still matches once, no Electron).
  #398: `browser-cdp-seat.test.ts` (one attach per contents, refcount, force-detach, a fake debugger that THROWS on a second
  attach; grace, agent-only reset), `cdp-proxy-core.test.ts` (`lease`, `sendOnLease`, `agentTouched` arms),
  `browser-single-attacher.test.ts`, the registry arms in `browser-panel-tabs.test.ts` (design lease: no churn across polls,
  pick/cancel/disarm release, arm/disarm order, tab switch, no debugger without the seat), wiring pins in
  `browser-cli-wiring.test.ts`, with their must-FAIL scripts `scripts/mutate-browser-panel-tabs.mjs` (53 registry mutants) and
  `scripts/mutate-cdp-seat.mjs` (20 seat/lease mutants); and the built-app rig `scripts/e2e-browser-design-proxy.sh <app-dir>`
  (5 arms, 50 clauses: the static gate on source + bundle, the REAL toolbar → hover → click → composer pick on
  `pages/design.html`, toolbar-off / Escape / archive-while-armed / switch-workspace-while-armed / re-arm-inside-the-grace lifecycle, a pick while an
  `orchestra browser wait --fn` runs on the same tab, and design-armed-first with the agent attaching second; oracle = the app's
  own debug port + Electron's `isAttached()` in the trace; `ORCHESTRA_CDP_RELEASE_GRACE_MS=1500`; private-runtime world via `scripts/lib/rig-runtime.mjs`, the env HANDED to the app is asserted, not its `/proc/environ`) with
  `scripts/e2e-browser-design-proxy-mutants.sh <app-dir>` (9 bundle mutants: second attacher, detach skipped, lease leak, lease
  removed, screenshot dropped, reset without an agent, re-acquire inside the grace attaches again, switch leaves the old workspace
  armed (renderer chunk), release detaching under the agent). Two traps: an agent-browser daemon runs ONE command at a time per workspace, so a second CLI command queues behind an
  in-flight `wait`; several workspaces' composers are mounted at once (hidden ones first in DOM order) — read the visible one.
