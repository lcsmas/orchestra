# Orca agent rows vs Orchestra child rows (workers / ops): status indicators

Compiled 2026-10-30. Answers « tu es sûr que c'est pareil pour le worker / ops ? ». Companion to
[`orca-sidebar-ui.md`](orca-sidebar-ui.md) (§2 row anatomy, §3 status indicators). This note corrects that file's §3 table
on two points (see §1.3).

**Pinned shas**

| Repo | sha | note |
|---|---|---|
| [stablyai/orca](https://github.com/stablyai/orca), shallow clone, read only | `daf806bb411c087e96961051e171322036cf13e0` | `git log -1` re-checked this session |
| Orchestra | `98fe09ff` (v0.5.357), `HEAD..origin/master` = 0 | `Sidebar.tsx` has **uncommitted prototype edits** (+31 lines above the call sites). Anchors cite **HEAD**, with working-tree lines in brackets |

Orca anchors are GitHub permalinks at `daf806bb`, relative to `src/renderer/src/` unless the path starts with `shared/`
(meaning `src/shared/`). Tags: **VERIFIED** = read in code this session. **INFERRED** = my derivation, e.g. px from
Tailwind classes. **UNVERIFIED** = not checked. The screenshot was described to me by the caller; I did not see the image.


---

## Short answer

**No, it is not the same.** In Orchestra, a child row (worker or ops) renders the **exact same `WorkspaceStatusGlyph`,
at the same 12px size**, as a root row. Both Sidebar render paths do this (VERIFIED, §2). Orca's agent rows use a
**different glyph component** (`AgentStateDot`), with a different vocabulary from its workspace lane:

- done is a **10px `CircleCheck`**, not a dot;
- working is a **6px** spinner, not 8px;
- blocked is a **red dot**, not the orange question icon;
- three agent-only states exist: interrupted, monitoring, and missing-evidence.

So our child rows currently copy Orca's **workspace lane**, not its **agent rows**. The root-level glyph differences already
found (question hue, spinner size and timing, error shape, manual unread) apply to children too, and children add more
differences on top (§3).

---

## 1. Orca agent rows (VERIFIED unless tagged)

### 1.1 Which component draws the glyph

| Layer | Anchor | What it does |
|---|---|---|
| Card body | [`sidebar/WorktreeCardAgents.tsx:61-67`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/WorktreeCardAgents.tsx#L61-L67) | Returns `null` when the worktree has 0 agent rows. Rows come from per-worktree selectors ([`useWorktreeAgentRows.ts:47`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/useWorktreeAgentRows.ts#L47)) |
| Display mode | [`shared/constants.ts:41`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/shared/constants.ts#L41) | `DEFAULT_AGENT_ACTIVITY_DISPLAY_MODE = 'compact'`. The screenshot shows **compact** mode. `full` mode uses `DashboardAgentRow` with the same `AgentStateDot` at `stateDotSize="sm"` ([`WorktreeCardAgents.tsx:259-283`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/WorktreeCardAgents.tsx#L259-L283)) |
| Compact row | [`sidebar/worktree-card-compact-agent-row.tsx:107-316`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-compact-agent-row.tsx#L107-L316) | `CompactAgentRow` |
| State → prop | [`worktree-card-compact-agent-row.tsx:130-131`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-compact-agent-row.tsx#L130-L131) | `dotState = dotStateOverride ?? getAgentDotState(agent)`. The override comes from program-status presentation |
| Mapping | [`lib/agent-row-dot-state.ts:8-37`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/lib/agent-row-dot-state.ts#L8-L37) | Row state `working\|blocked\|waiting\|done\|idle\|unverifiable` maps 1:1, except `working` plus `workingMode==='monitoring'`, which becomes `monitoring`. A child row's own `displayState` wins. Otherwise the main-agent verdict wins ([`shared/agent-main-agent-verdict.ts:41-57`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/shared/agent-main-agent-verdict.ts#L41-L57)): failure or interruption → `failed`; cancel or superseded while done → `interrupted`; unconfirmed while done → `unconfirmed` |
| Row-state origin | [`shared/agent-status-types.ts:50`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/shared/agent-status-types.ts#L50), [`shared/agent-row-decay-state.ts:8-20`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/shared/agent-row-decay-state.ts#L8-L20) | Hook states are `working\|blocked\|waiting\|done`. A silent row decays to `unverifiable` while its PTY is still live, and to `idle` once the PTY is gone |
| Glyph | [`components/AgentStateDot.tsx:103-201`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/AgentStateDot.tsx#L103-L201) | Renders the glyph, always `size="sm"` in compact rows ([`:225-231`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-compact-agent-row.tsx#L225-L231)) |

### 1.2 Every agent state: glyph, size, colour, animation (`size="sm"` = 10px box, [`AgentStateDot.tsx:111-113`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/AgentStateDot.tsx#L111-L113))

| `AgentDotState` | Glyph | Painted size | Colour token | Animation | Anchor |
|---|---|---|---|---|---|
| `working` | CSS ring, `border-2` with transparent top | **6px** (`size-1.5`), 2px border (INFERRED: leaves a 2px hole) | `--agent-working` = yellow-500, both themes | `agent-spinner-rotate 86400s steps(1036800)`: 1 turn/s in **12 steps/s**, phase-synced on `animationstart`. Reduced motion: static, top filled | [`:127-135`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/AgentStateDot.tsx#L127-L135), [`AgentWorkingSpinner.tsx:30-41`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/AgentWorkingSpinner.tsx#L30-L41), [`main.css:1684-1698`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/assets/main.css#L1684-L1698) |
| `monitoring` | lucide `Activity` | 10px | yellow-500 | none | [`:136-144`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/AgentStateDot.tsx#L136-L144) |
| `waiting`, `permission` | lucide `MessageCircleQuestion` | 10px | `--agent-question` = orange-600 (light) / **orange-500 (dark)** | none | [`:165-173`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/AgentStateDot.tsx#L165-L173), [`AgentQuestionIcon.tsx:9-19`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/AgentQuestionIcon.tsx#L9-L19), [`main.css:228,339`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/assets/main.css#L228) |
| `blocked` | **filled dot** | 6px | `bg-red-500` | none | [`:174-193`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/AgentStateDot.tsx#L174-L193) (test pins it: `AgentStateDot.test.ts:80-85`) |
| `failed` | filled dot | 6px | `bg-red-500` | none | same |
| `done` | **lucide `CircleCheck`** (outlined circle + check) | **10px** | `text-emerald-500` | none | [`:145-154`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/AgentStateDot.tsx#L145-L154) |
| `interrupted` (user Stop) | filled dot | 6px | `bg-muted-foreground` | none | [`:186-188`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/AgentStateDot.tsx#L186-L188) |
| `idle` | filled dot | 6px | `bg-neutral-500/40` | none | [`:189`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/AgentStateDot.tsx#L189) |
| `unverifiable`, `unconfirmed` | lucide `CircleDashed` | 10px | amber-500 | none | [`:155-164`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/AgentStateDot.tsx#L155-L164) |
| with `progress` 0–100 (working / waiting / blocked / permission only) | SVG progress ring, r=6, stroke 3, track at 25% opacity | 10px | working → yellow, attention → orange | `stroke-dasharray` 500ms ease-out | [`:77-87,120-126`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/AgentStateDot.tsx#L77-L87), [`AgentProgressRing.tsx:13-62`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/AgentProgressRing.tsx#L13-L62) |

Every state has a hover tooltip (`StateIndicatorTooltip`) and an `aria-label` ([`:35-61`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/AgentStateDot.tsx#L35-L61)).
**Unread has no glyph on agent rows**: an unvisited row only turns its lead text `font-semibold text-foreground`, against
`font-normal text-muted-foreground/90` otherwise ([`worktree-card-compact-agent-row.tsx:203-206`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-compact-agent-row.tsx#L203-L206)).

### 1.3 Why the workspace shows a DOT and the agent row a CHECK

- This is intentional and written down twice in the code: *"completion uses a check while sidebar StatusIndicator uses an emerald dot"*
  ([`AgentStateDot.tsx:16`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/AgentStateDot.tsx#L16)), and *"A check distinguishes reported completion from
  live/idle dots; sidebar StatusIndicator intentionally differs"* ([`:146`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/AgentStateDot.tsx#L146)).
- Mechanism: the workspace lane draws `done` **and `active`** with the same `size-2 bg-emerald-500` dot
  ([`sidebar/StatusIndicator.tsx:98-114`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/StatusIndicator.tsx#L98-L114), comment *"Quiet active terminals
  share the completed-session dot"*). The lane's green therefore means "fine / quiet", not "finished". An agent row's `done`
  comes from the agent's own hook (`AgentStatusState 'done'`) with no failure verdict, so it can claim completion.
  The check is that claim.
- **Corrections to `orca-sidebar-ui.md` §3** (VERIFIED):
  1. The agent row draws `blocked` as a **red 6px dot**. The workspace lane has no `blocked`: the rollup folds
     blocked and waiting into `permission`, drawn as the orange question icon ([`shared/worktree-status-rollup.ts:43-45`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/shared/worktree-status-rollup.ts#L43-L45)).
     The §3 row "failed / blocked … same" conflates the two surfaces.
  2. `unverifiable` exists only on agent rows. The lane has only `unconfirmed`, drawn through `AgentStateDot size="md"`.

### 1.4 The rest of the row (screenshot elements)

| Element | Rule | Anchor |
|---|---|---|
| Row box | `flex h-6 items-center gap-1 px-1 rounded-sm text-[11px] leading-none`: 24px tall, 4px gaps (INFERRED px). Focused row gets `bg-worktree-sidebar-accent` | [`:286-298`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-compact-agent-row.tsx#L286-L298) |
| Order | state glyph → brand icon → `lead - trail` (one `truncate` span) → model chip (if any) → `+N` children (if collapsed) → cache timer → time | [`:208-283`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-compact-agent-row.tsx#L208-L283) |
| **Brand icon** | `AgentTypeIcon` at **13px** (14px in full mode). Known agents get their brand logo (Claude asterisk, OpenAI, …). Other programs get a letter; unknown gets "?". **Hidden for `rowSource==='subagent'`**: *"nesting conveys identity"* | [`lib/agent-type-icon.tsx:8-24`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/lib/agent-type-icon.tsx#L8-L24), [`row.tsx:128-129,232-236`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-compact-agent-row.tsx#L128-L129) |
| **Text priority (lead)** | conversation name → orchestration `displayName` / `taskTitle` / dispatch TASK preview → raw prompt → state label | [`row.tsx:28-34`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-compact-agent-row.tsx#L28-L34), [`shared/agent-row-primary-text.ts:39-54`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/shared/agent-row-primary-text.ts#L39-L54) |
| Text priority (trail) | program attention → verdict line → "no update for X" → stopping label → "Monitoring…" → tool preview → program message → last assistant message → agent-type label | [`row.tsx:36-79`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-compact-agent-row.tsx#L36-L79) |
| Lead/trail swap | when the state is `monitoring` or stopping, the status text leads so that truncation cuts the prompt | [`worktree-card-compact-agent-line-order.ts:5-18`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-compact-agent-line-order.ts#L5-L18) |
| **Time** | `formatShortTimeAgo`: `now` / `Nm` / `Nh` / `Nd`, floored. Measured from **when the agent entered done** (`lastEnteredDoneAt`), else from its start. `10px tabular-nums text-muted-foreground/60`, refreshed by a 30s clock. The screenshot's "6h / 7h / 8h" on done agents = time since they finished (INFERRED) | [`row.tsx:81-88,191-200`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-compact-agent-row.tsx#L81-L88), [`lib/short-time-ago.ts:2-16`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/lib/short-time-ago.ts#L2-L16), [`dashboard/agent-finished-timestamp.ts:9-29`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/dashboard/agent-finished-timestamp.ts#L9-L29), [`WorktreeCardAgents.tsx:194`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/WorktreeCardAgents.tsx#L194) |
| **"N agents ⌄" header** | `CompactAgentSummaryButton`, shown **only in compact mode, with >1 root agent, outside send-target mode**. Label: `` `${rootCount} agents` `` | [`WorktreeCardAgents.tsx:354-399`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/WorktreeCardAgents.tsx#L354-L399) |
| Header default | **collapsed** (`compactRootListExpanded: false`), kept per worktree in an in-memory LRU of 512 entries; a reload resets it. A screenshot showing "3 agents" plus rows therefore means the user opened it | [`worktree-card-agents-expansion-state.ts:10-16`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-agents-expansion-state.ts#L10-L16) |
| Header collapsed | a 24px pill (border, accent/35 background) with up to 3 **state clusters**. Each cluster is `AgentStateDot` plus up to 3 overlapped 16px brand discs and `+N`. Clusters are ordered waiting > blocked > failed > working > monitoring > unconfirmed > interrupted > done > unverifiable > idle | [`worktree-card-compact-agents.tsx:139-175`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-compact-agents.tsx#L139-L175), [`worktree-card-agent-summary.ts:11-25`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-agent-summary.ts#L11-L25) |
| Header expanded | plain `font-medium muted` text "3 agents", no pill | [`worktree-card-compact-agents.tsx:134-137`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-compact-agents.tsx#L134-L137) |
| Chevron | lucide `ChevronDown`, `size-3` (12px), **right edge**. Rotated `-90°` (pointing right) when collapsed. 150ms rotation, with a 180ms grid-rows reveal animation | [`:177-183`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/worktree-card-compact-agents.tsx#L177-L183), [`main.css:1672-1680`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/assets/main.css#L1672-L1680) |
| Nested agents (lineage) | A coordinator's dispatched children nest under its row (`orchestration.parentPaneKey` / `coordinatorHandle`), indented by `margin-left 12px` + `padding-left 4px` + a 1px left rule. They render through the **same recursive `CompactAgentRow` and the same `AgentStateDot`** as their parent | [`WorktreeCardAgents.tsx:295-352`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/sidebar/WorktreeCardAgents.tsx#L295-L352), [`dashboard/agent-row-lineage-model.ts:27-55`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/dashboard/agent-row-lineage-model.ts#L27-L55), [`main.css:1641-1645`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/assets/main.css#L1641-L1645) |

---

## 2. Orchestra child rows: what renders their status (VERIFIED)

- **Pinned spawn trees** (`renderSpawnTreeRows`, `Sidebar.tsx:1397` [1431]): child rows get `ws-child` plus `--ws-depth` (`:1445-1446` [1479-1480]),
  then `<PauseAwareGlyph><WorkspaceStatusGlyph …/></PauseAwareGlyph>` at **`:1526-1534` [1560-1568]**.
- **Repo sections** (`renderWs`, `Sidebar.tsx:2098` [2136]): the same `<WorkspaceStatusGlyph>` at **`:2240-2248` [2278-2286]**.
- Both sites pass **identical props** (`status, hibernated, unread=markedUnread, autoUnread, looping, stopReason
  (actionable only), title`) and **no `size`**, and no prop depends on `depth`. No CSS rule targets `.ws-child .ws-glyph`
  (`grep ws-child styles.css` finds only `:1426-1428` indent and `:2281` name colour).
  **A worker or ops child is pixel-identical to a root in its glyph.** The only child-specific styling is indent
  (`12px + min(depth,3)×16px`) and a dimmer name (`#8d95a1`).
- "Worker" and "ops" are not typed: `Workspace` has no role field (`src/shared/types.ts:116` `kind` is
  `worktree|scratch|orchestrator`). A child is just a workspace with a `parentId`.
- `PauseAwareGlyph` (`src/renderer/components/pause/PauseRow.tsx:13-16`) swaps in a pause glyph for fleet members during a
  Pause. Orca has no equivalent.

### 2.1 Our states → nearest Orca agent state

Sources: `WorkspaceStatusGlyph.tsx:102-225`, `styles.css:1590-1722`, `types.ts:4,327,411,438,465,495,972-982`, `usage-resume.ts:85-91`.

| Orchestra input (precedence order) | Our glyph | Nearest Orca agent state |
|---|---|---|
| `hibernatedAt` set | 8px grey dot, 40% | `idle` (PTY gone) |
| `idle\|stopped` + `stopReason max_turns` | octagon-alert 12px, `--red` | **none**. Closest is `failed` |
| `idle\|stopped` + `stopReason usage_limit` | circle-pause 12px, `--text-dim` | **none** |
| `idle\|stopped` + `stopReason error` | circle-x 12px, `--red` | `failed` |
| `idle\|stopped` + `autoUnread` | filled bell 12px, amber | `done` + unvisited (bold text, **no bell**) |
| `running` | 10px ring, 2px border, 0.8s linear smooth | `working` |
| `waiting` | message-circle-question 12px, amber-500 | `waiting` / `permission` |
| `error` | circle-x 12px, `--red` | `failed` |
| `idle` | **8px green dot** | **`done`** (a turn ended) **or** `idle` (never ran). Our `idle` merges the two |
| `stopped` | 8px grey dot, 40% | `idle` |
| `markedUnread` (manual) | glyph turns `--accent` blue | none (Orca's manual-unread bell is lane-only) |
| `loopingSince` | ↻ corner badge, 9px | none |
| last stop `interrupted` | **not stored**: `finishedStopReason` turns it into `null` (`src/main/activity.ts:305-315,720`), so it renders as idle | `interrupted` (muted dot) |

---

## 3. State-by-state: Orca agent row vs Orchestra child row

| State | Orca agent row | Orchestra child row | Verdict |
|---|---|---|---|
| Box | 10px | 12px | **different** |
| Working | 6px ring, 12-step/s, yellow-500 | 10px ring, smooth 0.8s/turn, yellow-500 | **different** (size + motion). Hue same |
| Question / waiting | 10px, **orange**-500 | 12px, **amber**-500 | **different** (size + hue). Shape same |
| Turn finished, clean | **10px emerald `CircleCheck`** | **8px emerald dot** | **different (shape)**: the user's question |
| Finished, unseen | check + bold lead text | amber bell (shape replaces the check/dot) | **different** |
| Failed / error | 6px red dot | 12px red circle-x | **different** |
| Blocked (distinct from a question) | 6px red dot | does not exist (blocked = `waiting`) | **missing in Orchestra** |
| Interrupted by user | 6px muted dot | not distinguishable (green dot or bell) | **missing in Orchestra** |
| Idle / never ran | 6px grey dot, 40% | `idle` = green dot; `stopped` = 8px grey dot, 40% | **different** (never-run reads green for us) |
| Monitoring background tasks | 10px `Activity`, yellow | none | **missing in Orchestra** |
| No recent update / unconfirmed | 10px `CircleDashed`, amber | none | **missing in Orchestra** |
| Progress 0–100 | filling ring | none | **missing in Orchestra** |
| Budget stop (max_turns) | none | octagon, red | **missing in Orca** |
| Usage-limit pause | none | circle-pause, dim | **missing in Orca** |
| Hibernated | `idle` dot (+ dimmed card text when the workspace sleeps) | grey dot (same as stopped) | **same in spirit** |
| /loop | none | ↻ badge | **missing in Orca** |
| Manual bookmark | none on agent rows | blue tint | **missing in Orca** |
| Fleet Pause | none | `PauseGlyph` | **missing in Orca** |
| Rest of row | brand icon 13px, task text, model chip, `Nh` time, 11px text | branch name 12px, badges; no icon, no time (the status note sits on a second line) | **different** |
| Parent/child glyph | parent and child share `AgentStateDot` | parent and child share `WorkspaceStatusGlyph` | **same pattern**, different vocabulary |

---

## 4. Concept mismatch, and what it implies

- **Orca agent row = one agent (a terminal pane, a retained row or a subagent) inside ONE worktree.** The card's lane glyph
  is a **rollup** of those agents (`worktree-status-rollup.ts`). Orca's nested lineage (coordinator → dispatched agents) also
  lives inside one card, because rows are selected per worktree (VERIFIED). A dispatched agent in another worktree would show
  as a root in its own card (INFERRED; not exercised).
- **Orchestra child = a whole workspace** (own worktree or scratch dir, own session, own status), rendered as a sidebar row
  of the same kind as its parent. The parent's glyph is the **orchestrator's own session**, not a rollup. Children reach the
  parent only through the collapsed `ws-hidden-count` urgency (`Sidebar.tsx:1431,2107`).
  So our child row plays **both** Orca roles at once: it is a "workspace" (own lane status) and an "agent" (a row under a
  parent).
- Consequence: copying the agent-row glyph onto our children is legitimate, because each child is exactly one Claude session,
  which is what an Orca agent row represents. But the semantics Orca relies on are missing in our data:
  - **`done` vs `idle`**: Orca's check needs a reported completion with a success verdict. Our `idle` also covers a workspace
    that never ran. `lastStopReason` cannot tell them apart, because `end_turn` and `interrupted` are **never persisted**
    (`activity.ts:305-315`). The usable discriminator is **`lastTurnStartAt !== undefined`** (`types.ts:354`: monotonic,
    stamped on turn start, never cleared). INFERRED: idle with `lastTurnStartAt` set means "at least one turn ended, and the
    last end was not max_turns, usage_limit or error".
  - **interrupted**: would need `finishedStopReason` to keep `'interrupted'` (a main-process change; it is not actionable, so
    the glyph prop would need a separate field).
- **Brand icon: not meaningful for us.** Every Orchestra agent is Claude, so a constant asterisk carries zero bits. Orca itself
  drops the icon where it carries no identity (subagent rows, `row.tsx:128-129`). If anything goes in that slot, the
  **model** is the real variable (`Workspace.model`, `types.ts:159`). Orca shows it as a 10px mono chip with `max-w-24`
  (`row.tsx:251-261`). Same for the "N agents" header: our orchestrator row already is the header, with a right-edge chevron
  and hidden count, so a second summary row would duplicate it.

---

## 5. Port recommendation: the child-row glyph

Goal in one line: **depth > 0 rows render Orca's `AgentStateDot` vocabulary at `sm`, without losing the Orchestra-only
stop shapes (#69/#74), the bell, the loop badge or the pause glyph.**

1. **Size: pass `size="sm"` at both child call sites** (`Sidebar.tsx:1526` [1560] and `:2240` [2278]: `size={isChild ? 'sm' : undefined}`).
   `.ws-glyph-sm` already exists (`styles.css:1604-1606`: 10px box, 10px svg, 8px spinner), so this matches Orca's 10px box
   (`AgentStateDot.tsx:111`) at no new cost.
2. **Clean finish = `CircleCheck`**: add a prop, e.g. `finished` = `w.status==='idle' && w.lastTurnStartAt !== undefined`, passed
   from the same two sites (children only). In `WorkspaceStatusGlyph.tsx:205-217`, when `finished` is set render lucide
   `circle-check` (`<circle cx=12 cy=12 r=10/><path d="m9 12 2 2 4-4"/>`) in `--glyph-done`. A never-run child keeps the dot.
   Mirrors [`AgentStateDot.tsx:145-154`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/components/AgentStateDot.tsx#L145-L154).
3. **Spinner at child size**: change `.ws-glyph-sm .ws-glyph-spin` (`styles.css:1606`) to 6px with a 2px border, plus the stepped
   timing `animation: ws-glyph-spin 1s steps(12, end) infinite` (INFERRED equivalent of Orca's 12 steps/s at 1 turn/s;
   [`main.css:1684-1698`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/assets/main.css#L1684-L1698)). The root-level spinner decision stays separate.
4. **Question hue**: `--glyph-attention` (`styles.css:115`) is amber. Orca's agent question is orange-500 dark / orange-600
   light ([`main.css:228,339`](https://github.com/stablyai/orca/blob/daf806bb411c087e96961051e171322036cf13e0/src/renderer/src/assets/main.css#L228)). This is the same decision as at the root level; make it once for both.
5. **Keep Orchestra's shapes where Orca has no state**: octagon (max_turns), circle-pause (usage_limit), bell (autoUnread),
   ↻ badge, `PauseGlyph`. Orca's agent row shows unseen-done only as bold text; our bell is the stronger signal and matches
   Orca's own lane. **Error** stays a circle-x unless the user wants Orca's 6px red dot; that would undo #69's "shape, not
   only colour" rule.
6. **Not recommended**: the brand icon and the "N agents" summary row (§4). Optional: a model chip in the brand-icon slot.
7. **Follow-ups needing main-process data**: `interrupted` (keep it in `finishedStopReason`, `activity.ts:305-315`) and
   `monitoring` (background tasks). Both are absent from the workspace record today.

Map upkeep if this lands: `docs/codebase-map/renderer-ipc-ui.md` (Sidebar glyph) and the `WorkspaceStatusGlyph` header
comment (`:11-19` claims "matches Orca one-for-one", which is true only for the lane).

---

## VERIFIED

- Orca sha `daf806bb` (`git -C $TMPDIR/orca log -1`). Orchestra `HEAD..origin/master` = 0. `styles.css`, `WorkspaceStatusGlyph.tsx` and `types.ts` are unmodified vs HEAD (`git diff --stat HEAD`).
- Every glyph, size, token and animation in §1.2 (read `AgentStateDot.tsx`, `AgentWorkingSpinner.tsx`, `AgentQuestionIcon.tsx`, `AgentProgressRing.tsx`, `main.css:92-94,228-232,339-340,1684-1698`).
- Blocked = red dot on the agent row (code plus test `AgentStateDot.test.ts:80-85`). The lane folds blocked into permission (`worktree-status-rollup.ts:43-45`).
- Dot vs check is intentional (`AgentStateDot.tsx:16,146`; `StatusIndicator.tsx:98-114`, done == active).
- Compact is the default mode. The summary header appears only for >1 root agent outside send-target mode, defaults to collapsed and resets on reload. The chevron rotates −90° when collapsed.
- Brand icon is 13px, hidden for subagents. Time format and its done-time anchor. Text-priority chain.
- Both Orchestra call sites pass identical props, no `size`, nothing depth-dependent. No `.ws-child .ws-glyph` CSS.
- `end_turn` and `interrupted` are cleared, never stored (`activity.ts:305-315,720`). `lastTurnStartAt` is monotonic (`types.ts:335-354` doc).

## NOT VERIFIED

- The screenshot itself (described by the caller; not opened by me). Its build date versus `daf806bb` is unknown.
- Nothing was rendered: no Orca build run, no pixel measurement. All px values are INFERRED from Tailwind classes.
- Whether Orca coordinator-dispatched agents live in the same worktree in practice (it decides whether Orca ever shows cross-worktree nesting).
- The `lastTurnStartAt` discriminator for `CircleCheck` (§5.2) is reasoned from the type doc and the stamp site description, not exercised on a real child. Also unchecked: whether a `/clear` or `restart --fresh` leaves it set (it would then show a check on a fresh session).
- `steps(12)` reproducing Orca's motion exactly (Orca uses a 1-day keyframe for phase sync; ours would not be phase-synced across rows).
- `hiddenUrgency` logic beyond its first line (`status === 'error'`).
