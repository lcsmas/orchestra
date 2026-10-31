# Orca coordinator / worker semantics vs Orchestra: what "done", "selected" and "working" mean

Compiled 2026-10-30. Answers three doubts about porting Orca's look as layout **B** + glyph set **G1**. Companion to
[`orca-sidebar-ui.md`](orca-sidebar-ui.md) and [`orca-agent-rows-status.md`](orca-agent-rows-status.md). This note
**corrects** the second note's claim that "done comes from the agent's own hook, so it can claim completion" (§1.3).
The hook part is true. The "completion" part is true only for in-process subagent rows. For a worker it means a turn ended.

**Pinned shas**

| Repo | sha | note |
|---|---|---|
| [stablyai/orca](https://github.com/stablyai/orca), shallow clone, read only, nothing executed | `daf806bb411c087e96961051e171322036cf13e0` | `git rev-parse HEAD` in the clone |
| Orchestra | `98fe09ff`, `HEAD..origin/master` = 0 (fetched this session) | `Sidebar.tsx` and `WorkspaceStatusGlyph.tsx` carry **uncommitted prototype edits**. Their anchors are **working-tree** lines. Every other Orchestra file is unmodified vs HEAD |

Orca anchors are GitHub permalinks at `daf806bb` (reference links at the end). Tags: **VERIFIED** = I read it in
code this session. **INFERRED** = my derivation, not exercised. **UNVERIFIED** = not checked.


---

## Verdicts

| Q | Verdict | One line |
|---|---|---|
| Q1: does Orca's green check mean "task finished"? | **No (partly by convention)** | On a worker or coordinator row, the check means the **turn ended** (Stop hook). It never reads dispatch, task or `worker_done` state. Orca's workers block on `ask` and are told that `worker_done` ends their turn, so in Orca a turn end usually coincides with task end. In Orchestra it does not. **G1's `idle + lastTurnStartAt` is misleading** |
| Q2: does selecting a coordinator expand and outline its children? | **Outline: yes. Expand: no** | When expanded, lineage children render **inside the parent card's surface**, so one fill and border encloses parent + children. This happens when the parent **or any descendant** is active. Selection never expands anything: children are expanded **by default**, and a click only activates |
| Q3: does a parent spin while a child works? | **No** for lineage children and for the coordinator's own agent row. **Yes** for agents inside the same worktree | The card lane is an aggregate over every agent **in that worktree** (permission > failed > working > monitoring > … > done). It does **not** aggregate lineage child worktrees. A collapsed lineage shows "N children" with **no state at all** |

---

## Q1. What Orca's `done` / CircleCheck means

### 1.1 Every producer of `AgentStatusState 'done'` (VERIFIED unless tagged)

| Producer | Anchor | Means | Rendered as |
|---|---|---|---|
| Claude `Stop` hook | [`claude-events.ts:81,129-139`][e81] | `isTurnBoundary` → `reportedStateName = 'done'`. Comment: *"Plain Stop has unknown outcome"* (`:82`) | `CircleCheck`, unless a verdict says otherwise |
| Claude `StopFailure` | same, `outcome: 'failure'` (`:83-90`) | API/model error ended the turn | `failed` red dot ([`agent-main-agent-verdict.ts`][verdict] `agentVerdictDisplayMark`) |
| `Stop` with `is_interrupt` / inferred cancel | `claude-events.ts:83-90`, [`server-status-inference.ts:150-187`][infer] | the user pressed Stop | `interrupted` muted dot |
| Manual `/compact` (`PostCompact`, `trigger: manual`) | `claude-events.ts:127,136-138` | compact finished with no Stop | `CircleCheck` |
| `SessionStart` (`startup`/`resume`/`clear`) | [`claude-events.ts:54-77`][e54] | new session, **before any prompt**. Stamped `sessionBoundary: true` | `CircleCheck` (**INFERRED**: no sidebar code reads `sessionBoundary`; grep of `components/sidebar` is empty) |
| Terminal launch identity | [`server-ingest-terminal.ts:60`][ingest] | provider session seen at launch | `done` (INFERRED to render the same) |
| Retained row (pane gone) | [`worktree-agent-rows.ts:262`][retained] | the agent's pane is closed | `state: 'done'` hard-coded |
| In-process subagent child (`childRow`) | [`agent-status-child-work-display.ts:52-85`][childdisp] | `settled` + outcome `succeeded` → `done`; `failed` → `failed`; `cancelled` → `interrupted`; **live but idle → `idle` (grey), never a check** | `CircleCheck` only when settled |

Decay: `done` never decays. Only `working|blocked|waiting` decay to `unverifiable`/`idle` when stale
([`worktree-agent-rows.ts:175-188`][decay]). So a check stays until the next hook.

### 1.2 Orchestration state never reaches the glyph (VERIFIED)

- `AgentStatusOrchestrationContext.dispatchStatus` (`pending|dispatched|completed|failed|circuit_broken`,
  [`agent-status-types.ts:62`][ctx]) exists on the entry. In the renderer it is read in exactly two places: the context
  equality/merge ([`agent-status-orchestration-context.ts:11,46`][ctxmerge]) and **hibernation eligibility**.
- Orca's own code says the two differ: *"Why: provider done hooks can fire mid-Dispatch; only runtime-confirmed settlement
  makes sleep safe."* ([`agent-hibernation-pane-eligibility.ts:50-55`][hib]). **This is the ground truth for Q1.**
- The dot path `getAgentDotState` → `agentRowDisplayDotState` → `agentVerdictDisplayMark ?? agentRowDotState(state)`
  ([`worktree-card-agent-summary.ts:27-29`][summary], [`agent-row-dot-state.ts:8-37`][dot]) reads only `state`,
  `workingMode`, `interrupted`, `mainAgent.outcome` and `childRow`. It does not read `orchestration`.
- `orchestration.attention` (categories incl. `root_completion`, `failure`) is computed in main
  ([`orchestration-fleet-attention.ts`][attn]). Its only renderer reads are equality checks. No glyph consumes it.
- `worker_done` in `src/renderer`: one hit. [`activity-thread-display.ts:144-157`][wdtext] strips the text "worker_done sent"
  from message previews.
- Task-level UI elsewhere: none. The `'completed'` hits in `components/sidebar` are linked-issue state
  (`WorktreeCardMetadataStatusBadges.tsx:72`, `WorktreeReferenceStack.tsx:87`) and the user's manual kanban lane
  (`WorkspaceKanbanStatusLane.tsx:118`). Dashboard buckets are dot states (`done` → `done`,
  [`dashboard-card-bucket.ts`][bucket]). Fleet/task outcome projections (`orchestration-fleet-outcome-resolution.ts`,
  `-worker-projection.ts`) are imported only by `src/main` RPC and CLI methods.

### 1.3 Why Orca's check still *looks* like task completion: protocol, not data (VERIFIED)

- The worker preamble says *"worker_done ends your turn for this task … stop, return to an idle prompt"*
  ([`preamble.ts:190-212`][pre190]).
- `orca orchestration ask` **blocks until the coordinator answers** ([`preamble.ts:108-117`][pre108]). A worker waiting
  for an answer therefore stays `working`. It does not end its turn.
- Net effect (INFERRED): a well-behaved Orca worker ends its first turn right after `worker_done`, so turn-done ≈ task-done
  in practice. A worker that ends its turn early (crash, or a model that stops without reporting) still shows a check.
- `worker_done --outcome failed` does **not** turn the dot red. The row is red only for a `StopFailure`/interruption
  verdict.

### 1.4 Orchestra (VERIFIED)

| Fact | Anchor |
|---|---|
| `WorkspaceStatus = 'idle' \| 'running' \| 'waiting' \| 'error' \| 'stopped'`. `idle` = the last turn ended | `src/shared/types.ts:4` |
| `lastTurnStartAt` is set on a turn-start transition (throttled refresh) and never cleared. It means "ran at least one turn" | `types.ts:335-354`, `src/main/activity.ts:205-229` |
| **`orchestra ask` never waits**: *"Park a question … print its id and EXIT — never waits (the answer comes back as an ordinary bus message)"*. The asker ends its turn and is woken later | `src/cli/help.ts:222-232` |
| `worker_done` carries **no outcome** (`--type` kinds + `--cap`; no `--outcome`) | `help.ts:178-193` |
| Task-level "done" **exists in main**: `readReleasedReaders(db, {reader, runId}[])` = sent `worker_done` in its run AND no later `dispatch` to it. OPS coordinators are also read in the parent run (#204) | `src/main/bus-liveness.ts:163-229` |
| …but it feeds **only** the liveness escalation exclusion (`setLivenessReleased`). Its key is `reader = ws.id`, `runId = resolveWaveRunId(ws)`. `hasTask = !!ws.lastTask` marks a fleet member | `src/main/index.ts:633-641`, `src/main/bus-liveness-roster.ts:29,33,44` |
| Renderer access to bus data: only the read-only Bus pane snapshot (`bus:snapshot`, raw `BusMessageView` rows incl. `kind`). No per-workspace task field. `grep worker_done src/renderer` = 0 hits | `src/main/bus-pane.ts:53,370`, `src/shared/bus-view.ts:81` |
| Bus asks (`readWaitingReaders`) also stay in main. A worker parked on a bus `ask` shows as plain `idle` | `src/main/bus-wake.ts:541`, only consumer `bus-liveness.ts` |

### 1.5 Conclusion for G1

The prototype rule is `status === 'idle' && lastTurnStartAt` → check (`prototype-sidebar-variant.ts:62-65`,
`WorkspaceStatusGlyph.tsx:156-164`). It means **"between turns"**. In Orchestra a worker or OPS is between turns
routinely **mid-task**:
- waiting for a bus `ask` answer;
- an OPS waiting for its members' `worker_done`;
- a member that idles after a `status` message.

So a mid-wave tree would be covered in green checks. That rule is **misleading**. It is less true than in Orca, where
`ask` blocks.

**Correct mapping** (task semantics, matching what Orca's check *conveys* via its protocol):

| Child state | G1 glyph |
|---|---|
| `running` | small spinner (unchanged) |
| `waiting`, `error`, stop reasons, bell, pause | unchanged |
| `idle` **and** task done+released (`readReleasedReaders` true) | **CircleCheck**, emerald |
| `idle`, ran a turn, task not released (between turns, mid-task) | the existing **emerald dot**. That is Orca's lane "quiet / alive" ([`StatusIndicator.tsx:98-114`][lane]) |
| `idle`, never ran / `stopped` / hibernated | grey dot at 40% |
| Not a fleet member (`!lastTask`, no bus run) | never a check. No task-level signal exists, so use the dot |

Note: an Orchestra check would mean **"reported done"**, not "succeeded" (no outcome field).

### 1.6 What this changes for B+G1

1. **Main, new derived field.** Add `Workspace.taskDoneAt?: number` (`src/shared/types.ts`, commented beside `lastTask`).
   Set it when `readReleasedReaders([{reader: ws.id, runId: resolveWaveRunId(ws)}])` holds; clear it when a later
   `dispatch` re-tasks the member. Broadcast it with an explicit `undefined` on clear, per the merge rule at
   `activity.ts:219-223`.
   - Cheapest hook: the liveness sweep already evaluates this set every tick (`bus-liveness.ts:337`). Diff the set and
     patch the workspaces that changed.
   - Map entry: `docs/codebase-map/bus.md` §done-released.
2. **`prototype-sidebar-variant.ts:62-65`**: `protoFinished: !!w.taskDoneAt` instead of `!!w.lastTurnStartAt`. Pass
   `ranTurn: !!w.lastTurnStartAt` separately.
3. **`WorkspaceStatusGlyph.tsx:156`**: keep the check gate (`status === 'idle' && !autoUnread`), fed by the new prop.
4. **`prototype-sidebar.css:218-221`**: the "not the check ⇒ grey" rule becomes "not ran a turn ⇒ grey". Idle mid-task
   keeps the emerald dot.
5. Until (1) exists, **ship G1 without the check** (dot only). An unearned check is worse than no check.

---

## Q2. Selecting a coordinator: expansion and outline

### 2.1 Lineage children live inside the parent's surface (VERIFIED)

- [`worktree-card-surface.tsx:48-113`][surface]: the card surface `<div data-worktree-card-surface …
  className="… ml-1 overflow-hidden rounded-lg border …">` contains the parent content **and**
  `{lineageChildren && <div class="space-y-1 mt-3|mt-1.5" data-worktree-lineage-children style={marginLeft:14px}>}`.
  - Nested children are full `WorktreeCard`s, each with its own surface.
  - The 14px is `LINEAGE_CHILDREN_INLINE_OFFSET` = 18 + 2 − 4 − 2 ([`indentation.ts:1-16,189-198`][indent]).
- Active style keys on the **surface**: `data-worktree-card-active="primary"` → dark: `border fg 18% over sidebar-border`,
  `bg fg 10%`, `shadow 0 1px 2px fg 3%`. Light: `border 40%`, `bg fg 8%`, `shadow fg 4%`
  ([`main.css:1377-1391`][css]).
  - Because the children are DOM descendants of that surface, **the fill and border enclose parent + children as one
    group**.
- **When** the group is active ([`virtual-row-dispatch.tsx:107-143`][vrd], [`item-row.tsx:107-181`][itemrow]):
  - A top-level parent with expanded children becomes one virtual row `type: 'lineage-group'`
    ([`renderable-rows.ts:19-52`][rr]).
  - `childIsActive = children.some(c => c.worktree.id === activeWorktreeId)`. `children` = **all descendants** in the
    group.
  - The parent gets `isActiveSurface = forceActiveSurface || isActiveWorktree`, with variant `'primary'`. Comment: *"a
    child-active parent should look active without the active-card side effects"*.
  - So the group is outlined when **the parent or any descendant** is active.
- Stacking (INFERRED from the classes):
  - When a descendant is active, its own nested surface is *also* active-filled (`fg 10%` over `fg 10%`).
  - Intermediate ancestors are **not** forced: `renderWorktreeItemRow(ctx, child, true, …)` passes no
    `forceActiveSurface` (`item-row.tsx:245`).
- **Collapsed** lineage: `renderable-rows.ts:27` emits a plain row with no children → only the parent card fills.
- **Interaction guard**: a nested row stops click/pointer propagation, so a child click does not activate the parent
  (`item-row.tsx:150-167`).

### 2.2 Expansion is not tied to selection (VERIFIED)

| Disclosure | Default | Changed by | Anchor |
|---|---|---|---|
| Lineage children (child worktrees) | **expanded**. `lineageCollapsed = collapsedGroups.has(key)`, and `collapsedGroups` starts empty (persisted via `window.api.ui.set`) | the "N children" chip (`Workflow` icon + chevron, outline `chip` button) | [`row-builders.ts:100-106`][rb], [`secondary-rows.tsx:94-133`][chip], [`ui-slice-preference-actions.ts:160-170`][uipref] |
| Agent lineage under a coordinator agent row | **expanded** (`collapsedLineageParents` empty) | that row's `+N` toggle | [`worktree-card-agents-expansion-state.ts:10-13`][exp], [`WorktreeCardAgents.tsx:245,305`][wca] |
| "N agents" summary pill (>1 root agent, compact mode) | **collapsed**, in-memory LRU of 512, reset on reload | the pill button | same files, `WorktreeCardAgents.tsx:357-392` |
| Inline agent rows at all | on (card property `inline-agents`) | the "Show properties" menu | [`use-worktree-card-secondary-details.ts:96-100`][secdet] |

- Card click = `onImmediateActivate` + `activateWorktreeFromSidebar` only
  ([`use-worktree-card-activation-actions.ts:50-93`][click]). It has no toggle call, and nothing in `WorktreeCardAgents`
  reads the active worktree.
- The one auto-expand is a sidebar **reveal** (scroll-to-current, terminal requests). It expands collapsed
  **ancestors** of the revealed worktree, not its own children
  ([`worktree-reveal-group-keys.ts:72-83`][reveal], [`use-pending-reveal.ts:196-215`][pending]).
- So "selecting expands the list" is not in the code. Children look expanded because that is the default.

### 2.3 Orchestra today and how B reproduces it

Today (VERIFIED):
- Children are sibling `.ws-item` rows with `ws-child` + `--ws-depth`.
- `.active` styles one row only:
  - base `styles.css:1402-1405`: `--bg-3` + 2px accent left border;
  - B proto `prototype-sidebar.css:77-81`: `fg 10%` fill + `fg 18%` border.
- Click = `setActive(w.id)` only (`Sidebar.tsx:1482`, `:2174`). Fold state = `collapsedOrch`, default expanded
  (`:813-822`).
- Pinned trees (orchestrators, scratch) already have one `<div className="ws-tree">` per root (`:1454`). Repo sections
  render a **flat** row list (`:2439`), split by host when the repo is mixed (`:2435`).

B change, reproducing Orca's rule *"group outlined iff the root has visible children and the root or any visible
descendant is active"*:

1. **Wrapper everywhere.** In the repo-section path (`Sidebar.tsx:2420-2465`), group `visibleItems` into runs that start
   at each `depth === 0` row, and wrap each run in `<div className="ws-tree">`, as `renderSpawnTreeRows` does.
   - With `groupByHost`, wrap inside each host group. A tree split across hosts gets one wrapper per host part
     (accepted limitation).
2. **Flag the group.** On the wrapper, set `ws-tree group-active` when the root is not folded, has ≥1 visible child,
   and `activeId` ∈ {root} ∪ visible descendants. The visible rows are already computed as `visibleRows` /
   `visibleItems`.
3. **CSS** (`prototype-sidebar.css`, B block):
   - `.sidebar[data-proto-variant='B'] .ws-tree.group-active { background: fg 10%; border: 1px solid fg 18%;
     border-radius: 8px; box-shadow: 0 1px 2px fg 3%; margin: 0 6px 0 4px; }`
   - Inside it: `.ws-item { margin-left/right: 0; }`; `.ws-item.active { background: fg 10%; border-color: transparent; }`.
     This gives the stacked inner fill Orca shows for an active child. Drop the row border so the group border is the
     only outline.
   - Keep the rail and ticks (`:96-115`) inside the group.
4. **No auto-expand on select.** That matches Orca. Optional, Orca-like: when `activeId` sits under a folded ancestor
   (e.g. activated from the Bus pane or a notification), unfold its ancestors only.

---

## Q3. Spinner rollup

### 3.1 How Orca derives the card status (VERIFIED)

Chain: `WorktreeCardStatusSlot` ([`:117`][slot]) → `useWorktreeActivityStatus(worktreeId)`
([`use-worktree-activity-status.ts:14-85`][uwas]) → `resolveWorktreeStatus` = title heuristic + `rankWorktreeStatus`
([`worktree-status.ts:45-73,181-215`][ws]).

- **Scope = every agent entry attributed to that worktree id**
  ([`worktree-agent-activity-summary.ts:116-171`][sum]): all panes and tabs, plus retained rows.
  - Attribution is the entry's own tab's worktree first, then `entry.worktreeId`, then the **parent pane's** worktree
    only as a fallback ([`agent-status-worktree-attribution.ts:21-41`][attr]).
  - So a dispatched worker counts toward the coordinator's card **only if its terminal lives in the same worktree**.
- **Lineage child worktrees are not aggregated.** The status is per `worktreeId`. Nothing in `lib/worktree-status.ts`,
  `worktree-status-rollup.ts` or `use-worktree-activity-status.ts` reads lineage.
- **Collapsed lineage** chip label = `` `${n} child|children` `` and nothing else
  ([`use-worktree-card-workspace-actions.ts:104-109`][chiplabel]). A collapsed parent hides child activity entirely.
- **Coordinator's own agent row**: own entry only. In-process child work (Claude subagents, background shells) folds into
  the lead (`done` + child working → `working`, child waiting → `waiting`; [`agent-lead-status-fold.ts:23-41`][fold]).
  Orchestration-dispatched workers are separate panes and do **not** fold. A coordinator row can show a check while its
  nested worker rows spin (INFERRED from the code path; not rendered).

Precedence, [`rankWorktreeStatus` `worktree-status-rollup.ts:71-112`][rank] (flags from
`applyAgentPaneActivityFlags` `:37-68`):

`permission` (blocked/waiting, or the title heuristic) > `failed` (fresh) > `working` > `monitoring` > retained `failed`
> `unconfirmed` > `interrupted` > `done` (live or retained) > heuristic `active` (green dot) / `inactive` (grey).

The summary pill uses a different order: `waiting > blocked > failed > working > monitoring > unconfirmed > interrupted
> done > unverifiable > idle` ([`worktree-card-agent-summary.ts:11-25`][summary]).

### 3.2 Orchestra comparison (VERIFIED)

| | Orca | Orchestra |
|---|---|---|
| Unit behind one status glyph | a worktree (N agents) | a workspace = **one** session |
| Parent glyph | aggregate of same-worktree agents; **not** lineage children | own session only |
| Child worktree activity on parent, expanded | visible as nested cards inside the parent surface | visible as child rows |
| …collapsed | **nothing** ("N children") | `ws-hidden-count` pill coloured by `hiddenUrgency`: `error > waiting/autoUnread/markedUnread > running` (`Sidebar.tsx:1466-1472`, `:2147-2153`) |
| Order of attention vs failure | permission **above** failed | error **above** waiting |

An Orchestra child is a separate workspace, so it maps to Orca's **lineage child card**, not to a same-worktree agent.
On that axis Orca does no rollup.

### 3.3 What this changes for B+G1

1. **Keep the parent glyph = own status.** Orca does not roll lineage children into the parent, and a spinner on an idle
   orchestrator would misstate its own session (e.g. who is consuming tokens). No change to `WorkspaceStatusGlyph` call
   sites.
2. **Keep the hidden-count pill.** It is strictly more informative than Orca's stateless "N children" chip.
   - Optional parity: reorder `hiddenUrgency` to `waiting (incl. autoUnread/markedUnread) > error > running` at
     `Sidebar.tsx:1466` and `:2147`. That puts attention first, as in Orca's `rankWorktreeStatus` and summary order.
   - This is a judgement call: our order puts error first on purpose.
3. **Once Q1's `taskDoneAt` exists**, add a lowest-rank pill state `done` (all hidden children released) so a folded,
   finished wave reads green rather than blank. Variant C's `ProtoHiddenDots` (`Sidebar.tsx`, proto block) maps `idle`
   to green today and should use the same rule.

---

## VERIFIED

- Orca sha `daf806bb411c087e96961051e171322036cf13e0`. Orchestra `HEAD..origin/master` = 0 after `git fetch`.
- Every `done` producer in §1.1 was read at source: Claude Stop/StopFailure/PostCompact/SessionStart, inferred
  cancellation, launch identity, retained rows, child display.
- `dispatchStatus` renderer readers are exactly the merge and hibernation (grep of `src/renderer` + `src/shared`). The
  hibernation comment admits that done ≠ settled. `worker_done` in the renderer is preview-text stripping only.
- Worker preamble: `ask` blocks, and `worker_done` ends the turn (`preamble.ts:101-212`).
- Lineage children render inside the surface. Group active when parent or any descendant is active
  (`childIsActive` / `forceActiveSurface`). The active CSS is on the surface.
- No expansion on click. Lineage and agent lineage default expanded. The summary pill defaults collapsed. Reveal expands
  ancestors only.
- Card status scope is per worktree, with worktree attribution order as given. No lineage rollup. Precedence as listed.
  The collapsed chip is stateless.
- Orchestra:
  - `ask` never waits; `worker_done` has no outcome.
  - `readReleasedReaders` exists, and only liveness consumes it. No renderer path to it.
  - Prototype rule = `idle && lastTurnStartAt`. `hiddenUrgency` order. Click = `setActive` only. Pinned trees are
    wrapped in `.ws-tree`; repo sections are flat.

## NOT VERIFIED

- **Nothing was rendered.** No Orca build was run and no Orchestra prototype was driven. The stacked fill on an active
  child, and a coordinator row showing a check over spinning workers, are read from classes and code paths only.
- Whether `SessionStart`/launch-identity `done` rows actually render a check before the first prompt. No sidebar filter
  on `sessionBoundary` was found, but rows could be filtered upstream in a selector I did not read.
- Retained-row lifecycle (when a closed pane becomes retained, and when it is dropped). Only `state: 'done'` at creation
  was read.
- How often Orca dispatches workers into the coordinator's worktree versus new lineage worktrees. This decides whether
  Orca users usually see the same-worktree rollup (spinner on parent) or the lineage case (no rollup).
- The proposed `taskDoneAt` derivation: designed against `readReleasedReaders` + `resolveWaveRunId`, not implemented or
  tested.
  - Whether the liveness sweep runs when the run's `liveness` switch is OFF (if not, the field needs its own reader).
  - The re-dispatch clear edge.
- Orca's reveal triggers were sampled (`terminal-request-ipc-bridge.ts:105`, `use-reveal-requests.ts:182`), not
  enumerated.

[e81]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/shared/agent-hook-listener/providers/claude-events.ts#L81-L139
[e54]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/shared/agent-hook-listener/providers/claude-events.ts#L54-L77
[verdict]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/shared/agent-main-agent-verdict.ts#L41-L57
[infer]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/main/agent-hooks/server/server-status-inference.ts#L150-L187
[ingest]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/main/agent-hooks/server/server-ingest-terminal.ts#L50-L62
[retained]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-agent-rows.ts#L250-L264
[decay]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-agent-rows.ts#L175-L188
[childdisp]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/shared/agent-status-child-work-display.ts#L52-L85
[ctx]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/shared/agent-status-types.ts#L58-L72
[ctxmerge]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/store/slices/agent-status/agent-status-orchestration-context.ts#L4-L52
[hib]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/lib/agent-hibernation-pane-eligibility.ts#L50-L55
[summary]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-agent-summary.ts#L11-L29
[dot]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/lib/agent-row-dot-state.ts#L8-L37
[attn]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/shared/orchestration-fleet-attention.ts#L1-L80
[wdtext]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/lib/activity-thread-display.ts#L144-L157
[bucket]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/dashboard/dashboard-card-bucket.ts#L6-L19
[pre190]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/main/runtime/orchestration/preamble.ts#L190-L212
[pre108]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/main/runtime/orchestration/preamble.ts#L101-L117
[lane]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/StatusIndicator.tsx#L98-L114
[surface]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-surface.tsx#L48-L113
[indent]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-list/rows/indentation.ts#L1-L16
[css]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/assets/main.css#L1377-L1391
[vrd]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-list/rows/virtual-row-dispatch.tsx#L107-L143
[itemrow]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-list/rows/item-row.tsx#L107-L181
[rr]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-list/listing/renderable-rows.ts#L19-L52
[rb]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/shared/sidebar-list/row-builders.ts#L100-L106
[chip]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-secondary-rows.tsx#L94-L133
[uipref]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/store/slices/ui/ui-slice-preference-actions.ts#L160-L170
[exp]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-agents-expansion-state.ts#L10-L13
[wca]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/WorktreeCardAgents.tsx#L200-L392
[secdet]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/use-worktree-card-secondary-details.ts#L96-L100
[click]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/use-worktree-card-activation-actions.ts#L50-L93
[reveal]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-list/navigation/worktree-reveal-group-keys.ts#L72-L83
[pending]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-list/navigation/use-pending-reveal.ts#L196-L215
[slot]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/WorktreeCardStatusSlot.tsx#L117
[uwas]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/use-worktree-activity-status.ts#L14-L85
[ws]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/lib/worktree-status.ts#L45-L215
[sum]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-agent-activity-summary.ts#L116-L171
[attr]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/shared/agent-status-worktree-attribution.ts#L21-L41
[chiplabel]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/use-worktree-card-workspace-actions.ts#L104-L109
[fold]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/shared/agent-lead-status-fold.ts#L23-L41
[rank]: https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/shared/worktree-status-rollup.ts#L37-L112
