# Design proposal — Linear tickets in the sidebar (`orchestra linear`)

**Status:** proposal, unmerged. Branch `linear-tickets-in-sidebar-design`.
**Date:** 2026-07-23.
**Scope of this doc:** current wiring (verified at source), the proposed CLI
command + data flow, the sidebar rendering change, config/auth needs, open
questions. No implementation shipped — see "Why nothing was implemented".

---

## 1. What the user asked for

> Let LINEAR TICKETS appear in the left-sidebar list, and add an Orchestra CLI
> command that enables this.

That sentence has **two materially different readings**, and they lead to
different implementations. Section 6 (Open questions, Q1) is the fork; this
proposal designs primarily for reading **(B)** and explains why.

- **(A) Ticket-as-badge, richer.** Tickets stay attached to workspaces (the
  existing model) and the CLI just lets an agent *pin* a ticket to a workspace
  whose branch name doesn't encode the key. Small, low-risk, no new row type.
- **(B) Ticket-as-row.** A Linear ticket becomes its own entry in the sidebar
  list — visible *before* any worktree exists for it — as a backlog/queue you
  can see next to running agents, and which you can turn into a workspace with
  one click. This is what "tickets appear in that sidebar list" most naturally
  means, and it's the only reading where a new CLI command is actually load-
  bearing (in reading (A) the command is a nicety).

---

## 2. Current wiring (verified against source, 2026-07-23)

### 2.1 Linear today: a badge derived from the branch name, nothing more

The entire existing Linear integration is a **read-only, branch-name-derived,
renderer-polled badge**. There is no ticket entity anywhere in Orchestra.

| Step | Location | Behaviour |
|---|---|---|
| Parse candidate key | `src/shared/linear.ts:28` `parseLinearIssueCandidate` | Regex over the *branch name* → `TEAM-NUMBER` (e.g. `nmc-261-x` → `NMC-261`). Deliberately permissive; not a source of truth. |
| Verify against Linear | `src/main/linear.ts:112` `verifyLinearIssue(branch)` | One GraphQL POST to `https://api.linear.app/graphql`, `Authorization: <key>` (**no** `Bearer`). Returns a `LinearIssue` only if the returned `identifier` matches the asked-for key. Caches hits *and* misses by key (`:26`, `:148`); latches `noApiKey` on absent key / 401 / 403 (`:32`, `:136`). |
| Key resolution | `src/main/linear.ts:37` `resolveApiKey` | stored (encrypted, `secrets.ts`) → `LINEAR_API_KEY` env → none. |
| IPC | `src/main/api-handlers.ts:259` (`linear:verify`), handler `:907–913` | Looks up the workspace, returns `null` for `kind === 'scratch'`, else `verifyLinearIssue(ws.branch)`. |
| Renderer poll | `src/renderer/App.tsx:302–305` | `startVisiblePoll(refreshAllLinear, 60_000)` — 60 s, visibility-gated, re-armed on workspace-set change. |
| Renderer state | `src/renderer/store.ts:59–62`, action `:520–532` | `linear: Record<workspaceId, LinearIssue \| null>`. `refreshAllLinear` fans out `mapBounded` over non-archived ids. |
| Render | `src/renderer/components/Sidebar.tsx:400–464` `PrLinearBadges` (Linear span `:421–433`) | Read at `:1745` (`linear[w.id] ?? null`), rendered at `:2030`, participates in `hasPills` `:1792`. Spawn-tree rows render it only under the `childIsGit` guard `:1352`. |

**Two consequences that shape the design:**

1. `LinearIssue` (`src/shared/types.ts:387–394`) carries only
   `{ identifier, url, title }` — no state, assignee, team, or priority. A
   ticket *row* wants at least state and assignee, so the GraphQL document
   (`ISSUE_QUERY`, `linear.ts:19`) and the type both need widening.
2. The issue is **never persisted and never broadcast** — it lives only in the
   renderer's `linear` map, keyed by workspace id, and is re-derived from the
   branch name every 60 s. Nothing in `store.json` knows about Linear.

### 2.2 The sidebar list is already heterogeneous — but not *typed* as such

`Sidebar.tsx` (2396 lines, one component) renders, inside `.ws-list`:

| Section | Anchor |
|---|---|
| Orchestrators (pinned first) | `:1512–1536` — header `:1514`, rows via `renderSpawnTreeRows` `:1534` |
| Scratch | `:1537–1561` |
| Repo sections (`repoOrder.map`) | `:1562–2127` — repo header `:1593`, base-sync bar `:1688`, rows `:1723` |
| Host groups (local vs sandbox), only when a repo mixes both | `:2090–2123` |
| Archived accordion | `:2178–2299` |

Grouping is two memos over pure helpers:

- `buildSpawnForest(list)` `:490–517` → `{childrenOf, roots, rootOf}` from `parentId` (dangling parent degrades to root).
- `flattenSubtree` `:523–542`, `collectDescendants` `:548–562`, `groupRootsByRepo` `:570–580`.
- Memo A (sections) `:910–936`: `orchestratorRoots` = roots with `kind === 'orchestrator'` `:920`; `scratchRoots` `:930`.
- Memo B (repo groups) `:1159–1171`: `repoRoots = forest.roots.filter(w => !isScratchLike(w))` `:1160`.

Three separate row renderers, no shared row component:
`renderSpawnTreeRows` `:1188–1393` (orchestrator/scratch), `renderWs`
`:1730–2072` (repo rows, full git chrome), archived rows `:2229–2295`.

**The critical finding:** there is already a repo-header row, a section header,
a sync bar, a host-group header and an archived toggle in that list — but each
is hand-written JSX at its own site. **There is no `SidebarEntry` union type;
every leaf of every list-like data structure is a `Workspace`.** So introducing
a genuinely non-workspace *row* means either adding a fourth hand-written
branch, or inventing that union — the latter being a large refactor of a
2400-line component. This is the single biggest cost driver in reading (B), and
it directly motivates the recommendation in §3.

### 2.3 How CLI commands are wired (the full path, three files)

```
orchestra <cmd> …                       src/cli/index.ts
  → getSocketPath()                     :42   $ORCHESTRA_SOCK → ~/.orchestra/sock pointer → error
  → request('/route', body)             :65   plain http.request over { socketPath }, POST JSON
      ↓ unix socket
  hooks-server.ts route if/else chain    :140–281   validates arg types, calls dispatch*
      ↓
  workspaces.ts dispatch*Request         returns { ok, … }; broadcasts to renderer as needed
```

Concrete anchors to copy from:

- **CLI**: `switch (command)` `src/cli/index.ts:221`; `USAGE` string `:123–156`;
  helpers `takeFlag` `:192`, `takeBoolFlag` `:201`, `table` `:110`,
  `fail` `:208`; self-identity `resolveSelfWorkspaceId` `:180` (reads
  `ORCHESTRA_WS_ID`, falls back to `ORCHESTRA_WS_ID_IDENTITY` — the SDK path
  withholds the former).
- **Route**: `src/main/hooks-server.ts:140–281`. Every route is POST; body cap
  4 KB except `/spawn` and `/message` at 1 MB (`:113`). Add a branch in that
  chain; type-check each field explicitly (the existing style) and reply
  `send(200, {ok:false, error})` on bad input rather than a non-2xx.
- **Dispatch**: e.g. `dispatchSpawnRequest` `src/main/workspaces.ts:1266–1318`.
  Note `:1290` — an agent may only name a repo the user has **already added**.
  Same trust boundary applies to anything the new command accepts.
- **Broadcast**: `platform.broadcast('workspace:update', ws)` (many sites, e.g.
  `:396`, `:507`, `:1010`); renderer upserts at `src/renderer/store.ts:536–559`.

Adding a subcommand is therefore **four edits**: CLI case + USAGE, route branch,
dispatch function, and (if it changes persisted state) a broadcast. No
registration table, no codegen.

---

## 3. Proposal

### 3.1 The command

```
orchestra linear add <ticket-url|TEAM-123> [--repo <path>] [--spawn] [--model <m>]
orchestra linear list [--mine] [--team <KEY>] [--state <name>]
orchestra linear rm <TEAM-123>
orchestra linear pin <TEAM-123> [--workspace <id>]
```

Rationale for a **noun-first `linear` namespace** rather than a flat
`orchestra add-ticket`: the existing CLI is flat (`peers`, `spawn`, `rename`),
but every flat verb operates on *workspaces*. Linear is a second noun with at
least four verbs; nesting keeps `orchestra --help` legible and leaves room for
`linear sync` / `linear open` later. Cost: `main()`'s `switch` gains one case
that re-dispatches on `args[0]`.

| Subcommand | Behaviour |
|---|---|
| `add` | Resolve the ticket against Linear, persist it as a **pinned ticket** (§3.2), broadcast, so it appears in the sidebar. `--spawn` immediately creates a worktree for it (branch derived from `identifier` + slugified title) and links the two. Idempotent on identifier. |
| `list` | Query Linear and print a table (identifier / state / title / assignee). Read-only; no persistence. `--mine` = `assignee: { isMe: { eq: true } }`. This is the "list-tickets-as-workspaces" half of the request, in its cheapest form. |
| `rm` | Un-pin (removes the row; never touches Linear). |
| `pin` | Reading (A): attach a ticket to an existing workspace whose branch doesn't encode the key. Defaults to the calling workspace via `resolveSelfWorkspaceId`. |

Accepted ticket forms: a full URL
(`https://linear.app/<org>/issue/NMC-261/<slug>`) or a bare identifier
(`NMC-261`, case-insensitive). Parsing is pure and belongs in
`src/shared/linear.ts` next to `parseLinearIssueCandidate`, with tests — the
existing `linear.test.ts` is the model.

### 3.2 Data model — a new store collection, NOT a fake workspace

**Recommendation: add `tickets: PinnedTicket[]` to the store; do NOT model a
ticket as a `Workspace`.**

```ts
// src/shared/types.ts
export interface PinnedTicket {
  /** Canonical Linear identifier, e.g. "NMC-261". Primary key. */
  identifier: string;
  url: string;
  title: string;
  /** Linear workflow state name ("In Progress") + type ("started"). */
  state?: { name: string; type: string };
  assignee?: { name: string } | null;
  /** Repo this ticket is earmarked for — drives which sidebar section it
   *  renders in, and the default --repo for a later spawn. Optional. */
  repoPath?: string;
  /** Workspace created for this ticket, once one exists. */
  workspaceId?: string;
  pinnedAt: number;
  /** Last successful refresh from Linear (epoch ms), for staleness display. */
  refreshedAt?: number;
}
```

The tempting shortcut — create a `Workspace` with `kind: 'ticket'` so it flows
through the existing list for free — **should be rejected**. The codebase-map
and `types.ts` are explicit that `kind` selects an *execution environment*
(`types.ts:56–71`), and every consumer keys off it via `isScratchLike`
(`types.ts:246`) / `canOrchestrate` (`:261`). A fourth kind would silently
acquire the full workspace surface: `pruneOrphanedWorkspaces`
(`workspaces.ts:544`) would try to reconcile it against `git worktree list`,
`startAgentPty` could be reached from `pty:start`, `allocatePort`
(`store.ts:185`) would burn a port, delete/archive/rename would all need new
guards, and `store.load()`'s status migration would touch it. That is exactly
the failure the `canOrchestrate` design note warns about (`types.ts:63–86`:
flipping `kind` to gain a *tree* property strips the *git* identity) — the same
mistake in the other direction.

A separate collection costs one store field, one broadcast channel, and one
sidebar section, and cannot leak into any workspace code path.

### 3.3 Data flow

```
orchestra linear add NMC-261
  → POST /linearAdd { identifier|url, repoPath?, from }
  → dispatchLinearAddRequest (new, src/main/linear-tickets.ts)
      · parseLinearTicketRef()          pure, shared/linear.ts (+ tests)
      · fetchLinearIssue(identifier)    main/linear.ts — widened query
        ↳ no API key → { ok:false, error:'no Linear API key…' }   (fail loud in CLI,
          unlike the badge path which fails silent by design)
      · store.upsertTicket(ticket)      new store method, atomic like the rest
      · platform.broadcast('tickets:update', store.tickets)
  → CLI prints "Pinned NMC-261 — <title>"

renderer: preload channel 'tickets:update' → store.ts `tickets: PinnedTicket[]`
          + one-shot load via a `listTickets()` IPC on boot
          + refresh poll (see below)
Sidebar: new "Tickets" section, rendered like Orchestrators/Scratch
```

**Refresh.** Reuse the established pattern: a `startVisiblePoll` in `App.tsx`
alongside the existing four (stats 8 s `:276`, PRs 12 s `:295`, sizes 30 s
`:288`, linear 60 s `:302`). Tickets change slowly → **120 s**, visibility-gated.
It must call a *ticket-specific* refresh (`tickets:refresh` IPC → one batched
GraphQL `issues(filter:{ id:{ in: [...] } })` query, one request for all pinned
tickets), **not** N× `verifyLinearIssue`: that function's by-key cache
(`linear.ts:26`) caches for the whole session and would freeze a ticket's state
at its first observed value. Ticket state is exactly the mutable thing the badge
cache was designed to assume immutable — this is the one place the existing
Linear module cannot be reused as-is.

### 3.4 Sidebar rendering

Add a **"Tickets" section** with the same shape as Orchestrators/Scratch:
`.repo-header` markup (`Sidebar.tsx:1514–1533` is the copy source), `cursor:
default`, a `+` button opening a small "pin a ticket" input, and rows.

Placement: **after Orchestrators, before Scratch** — tickets are intent
(not-yet-started work), so they read as a queue above the running sections
without displacing the coordinator view. Section is **hidden entirely when
empty** (same as today's sections, which render `null` with no roots), so users
who never pin a ticket see zero change.

The row is a **fourth, thin renderer** (`renderTicketRow`), ~40 lines, modelled
on the archived row (`:2229–2295`) rather than `renderWs` — it needs none of the
git chrome:

```
[◇]  NMC-261  Diagnosis pictures                    [In Progress] [→]
 │    │       └ title, ellipsized                    │             └ spawn workspace
 │    └ identifier (monospace-ish, like the badge)   └ Linear state pill
 └ state-colored diamond (distinct from the round .ws-dot, so a ticket
   never reads as an agent with a status)
```

Interactions:
- **Click row** → `window.orchestra.openExternal(ticket.url)`. It must **not**
  call `setActive` — `setActive` (`store.ts:199–219`) sets `activeId` from the
  workspace list and dismisses every full-pane surface; a ticket id is not a
  workspace id and `App.tsx:353` (`find(w => w.id === activeId)`) would resolve
  `undefined` and render the empty state. Keeping tickets out of `activeId`
  entirely is what makes this change safe.
- **`→` button** → create a workspace for the ticket (branch from
  `identifier`+slug, repo from `ticket.repoPath` or a picker) and set
  `workspaceId`. Once linked, the ticket row **collapses into the workspace
  row** — i.e. the ticket disappears from the Tickets section and the existing
  Linear badge takes over, which it already does correctly because the derived
  branch name carries the key. That "graduation" is the nicest property of this
  design: no dual representation, and it reuses the badge pipeline untouched.
- **`✕`** → un-pin.

Type-level change is minimal: no `SidebarEntry` union is introduced. The Tickets
section is a sibling of the workspace sections, iterating `PinnedTicket[]` — so
the two grouping memos (`:910`, `:1159`), all three existing row renderers, the
forest helpers and every drag/drop path are **untouched**.

### 3.5 Config / auth

**No new credential.** `resolveApiKey` (`main/linear.ts:37`) already gives
stored-key → `LINEAR_API_KEY` env → none, with a settings UI
(`LinearSettings.tsx`, encrypted via `secrets.ts`) and an env-notice in the
sidebar (`Sidebar.tsx:2312–2321`). The personal API key already carries read
scope for `issue`/`issues`/`viewer`.

Three deltas required:

1. **Widen the GraphQL document.** `ISSUE_QUERY` (`linear.ts:19`) fetches only
   `identifier url title`; add `state { name type }` and `assignee { name }`.
   Safe for the badge path (it ignores extra fields via `coerceIssue` `:67`).
2. **A batched list query** for refresh and for `linear list --mine`:
   `issues(filter:…){ nodes { identifier url title state{name type} assignee{name} } }`.
3. **`noApiKey` must not silence the CLI.** The latch (`:32`) is right for a
   60 s background poll and wrong for an explicit user command: after any 401 in
   the session, `orchestra linear add` would fail with no explanation. The
   ticket path must either bypass the latch or surface it as an explicit
   `'Linear API key missing or rejected — set one in Settings → Linear'`. The CLI
   is the one caller that should fail **loud**, not closed.

### 3.6 Files touched (estimate)

| File | Change | LOC |
|---|---|---|
| `src/shared/types.ts` | `PinnedTicket`; widen `LinearIssue` with optional `state`/`assignee` | ~35 |
| `src/shared/linear.ts` | `parseLinearTicketRef(urlOrId)` (pure) | ~20 |
| `src/shared/linear.test.ts` | cases for URL/id/garbage/case-folding | ~40 |
| `src/main/linear.ts` | widened query, `fetchLinearIssue`, `fetchLinearIssues` (batched), latch-bypass for explicit calls | ~70 |
| `src/main/linear-tickets.ts` (new) | `dispatchLinearAdd/List/Rm/Pin` | ~140 |
| `src/main/store.ts` | `tickets` collection + `upsertTicket`/`removeTicket` | ~40 |
| `src/main/hooks-server.ts` | 4 route branches | ~40 |
| `src/main/api-handlers.ts` + `src/shared/ipc.ts` + `src/preload/index.ts` | `tickets:list`/`refresh`/`remove` + `tickets:update` channel | ~50 |
| `src/cli/index.ts` | `linear` case + sub-dispatch + USAGE | ~110 |
| `src/renderer/store.ts` | `tickets` state, load, event wiring | ~45 |
| `src/renderer/App.tsx` | 120 s visible poll | ~5 |
| `src/renderer/components/Sidebar.tsx` | Tickets section + `renderTicketRow` | ~90 |
| `src/renderer/styles.css` | `.ticket-item`, state pill, diamond | ~60 |
| `docs/codebase-map/linear.md` | document the new flow (required by CLAUDE.md) | ~30 |

**≈ 775 LOC across 14 files.** That is not a "small and low-risk" change, which
is why this stops at a proposal (see §5).

---

## 4. Reading (A) — the cheap subset, if (B) is too much

If the user actually wants tickets *attached to work*, not a backlog queue,
almost all of the above collapses to:

- `Workspace.linearIssueKey?: string` (one optional field, persisted).
- `orchestra linear pin <TEAM-123> [--workspace <id>]` → one route, one
  dispatch, one broadcast.
- `api-handlers.ts:907` uses `ws.linearIssueKey ?? ws.branch` as the lookup key.
- **Zero sidebar changes** — the badge renders exactly as it does today.

**≈ 90 LOC across 5 files**, no new store collection, no new row type, no new
poll. This is genuinely low-risk and could ship immediately. It does **not**
put tickets in the sidebar list as independent entries, so it only satisfies the
request under reading (A).

---

## 5. Why nothing was implemented

The task said implementation is permitted only "if the change is small and
low-risk", with the priority on design. Reading (B) is ~775 LOC across 14 files
and touches the store schema, a new socket route family, and the sidebar — none
of which is small, and the row-vs-badge fork (§6 Q1) is a product decision, not
a technical one. Shipping either half before that fork is resolved risks
building the wrong thing well. Reading (A) *is* small and could be implemented
on request in well under an hour.

---

## 6. Open questions (need a human decision)

**Q1 — Row or badge? (the fork)** Should a pinned ticket be its own sidebar row
that exists before any worktree (reading B, §3), or just a way to attach a
ticket to an existing workspace's badge (reading A, §4)? Everything else follows
from this. *My recommendation: **B**, because "tickets appear in that sidebar
list" says row, and because the graduation behaviour (§3.4) means B strictly
contains A's value.*

**Q2 — Where do pinned tickets come from?** Manual `linear add` only, or should
`linear list --mine` be pinnable in bulk / auto-synced (e.g. "always show my
In-Progress issues")? Auto-sync means a saved Linear filter in the store and a
much stronger case for the batched query — but also a sidebar that changes
without the user doing anything, which cuts against how every other section
works today.

**Q3 — Section placement and emptiness.** Proposal puts Tickets between
Orchestrators and Scratch and hides it when empty. Alternative: a per-repo
sub-list (tickets earmarked for that repo, under its repo header), which reads
better for multi-repo users but complicates `repoOrder` and the orphan-repo
fallback (`Sidebar.tsx:1166–1169`).

**Q4 — Does `→ spawn` write back to Linear?** Moving the issue to "In Progress"
and/or posting a comment with the branch name is a natural next step and needs
only a mutation on the same key — but it is the first **write** Orchestra would
ever make to Linear, which is a different trust posture from today's read-only
badge. *Recommendation: not in v1; make it an explicit opt-in later.*

**Q5 — Multi-org / team scoping.** `parseLinearIssueCandidate` is org-agnostic
and the API key implies exactly one org. If a user has two Linear orgs there is
today no way to express that, and `linear list --team` would need a team-key
filter. Probably out of scope, but it should be a *stated* limitation rather
than an accidental one.

**Q6 — Naming.** `orchestra linear add` vs `orchestra ticket add` vs flat
`orchestra add-ticket`. Nesting under `linear` is proposed (§3.1); if Orchestra
ever grows Jira/GitHub-issue support, `ticket` ages better as the noun with
`--provider linear` as the default. *Recommendation: `linear` now — YAGNI, and
renaming a CLI subcommand later is cheap.*

---

## 7. Verification notes

Every anchor above was read at source in this worktree on 2026-07-23 (not taken
from `docs/codebase-map/`, which warns its line numbers drift). Line numbers are
against commit `e7d6fa1` (v0.5.147). Nothing in the running app was touched: no
build was run against `release/Orchestra.AppImage`, no process was signalled.
