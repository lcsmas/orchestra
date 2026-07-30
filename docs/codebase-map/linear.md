# Linear integration

Turns a branch name into a verified Linear issue badge in the sidebar. Files:
`src/main/linear.ts`, `src/shared/linear.ts` (+ `.test.ts`, pure logic). UI:
`LinearSettings.tsx`.

## Flow
- `parseLinearIssueCandidate(branch)` (`shared/linear.ts:28`) — extracts a
  `TEAM-NUMBER` token (whole-token regex; `nmc-261-…`→`NMC-261`; permissive, may
  yield false candidates like `POLL-429`).
- `verifyLinearIssue(branch)` (`main/linear.ts:112`) — queries Linear GraphQL
  (`https://api.linear.app/graphql`, `Authorization: <key>` no Bearer) and only
  returns a `LinearIssue` (`types.ts`) if the returned `identifier` matches.
  Caches hits *and* misses; `noApiKey` latch (`:32`) stops retrying after 401/403
  until the user saves a new key (`resetLinearAuthState` `:52`).
- Key resolution (`:37`): stored key → `LINEAR_API_KEY` env → none.
  `getLinearKeySource` `:46`. Stored via `secrets.ts` (encrypted). UI:
  `LinearSettings.tsx` (test/save/clear). IPC: `linear:keySource`/`checkKey`/
  `saveKey`/`clearKey`.

## Pinned tickets — the sidebar's Tickets section

A *second*, independent Linear surface: issues pinned into the sidebar as rows
of their own, so work that has **not started** is visible next to running
agents. Files: `src/main/linear-tickets.ts`, `src/shared/linear-tickets-queue.ts`
(+ `.test.ts`), store collection in `store.ts`, UI in `Sidebar.tsx`.

A ticket is **not** a `Workspace` and deliberately not a fourth `kind` — see the
`PinnedTicket` doc comment (`types.ts`): a new kind would silently enrol tickets
in `pruneOrphanedWorkspaces`, `startAgentPty`, `allocatePort` and the
delete/archive/rename paths, none of which mean anything for a ticket.

- **Store**: `tickets?: PinnedTicket[]` (`store.ts`), with
  `upsertTicket`/`setTickets`/`removeTicket`/`getTicket` and
  `reconcileTicketWorkspaces` (clears a `workspaceId` pointing at a deleted
  workspace, so a ticket can't be stranded invisibly).
- **Fetch**: `fetchLinearIssue` / `fetchLinearIssues` (BATCHED — one request for
  every pinned key) / `fetchMyLinearIssues` in `main/linear.ts`. These
  deliberately **bypass the badge path's by-key session cache** (which would
  freeze a ticket's mutable workflow state) and its `noApiKey` latch, throwing
  `LinearRequestError` so an explicit CLI command fails **loud** rather than
  resolving to an indistinguishable `null`.
- **Dispatch** (`linear-tickets.ts`): `dispatchLinearAdd/List/Remove/Pin` +
  `spawnWorkspaceForTicket` + `refreshPinnedTickets`. Routes `/linearAdd`,
  `/linearList`, `/linearRemove`, `/linearPin` (`hooks-server.ts`).
- **CLI**: `orchestra linear add <url|TEAM-123> [--repo] [--spawn] [--model]`,
  `linear list [--mine]`, `linear rm`, `linear pin [--workspace]`.
- **IPC**: `tickets:list`/`refresh`/`remove`/`spawn`, push channel
  `tickets:update` (wholesale replacement, like `repos:update`). Renderer polls
  `refreshTickets` every **120 s**, visibility-gated (`App.tsx`).
- **UI**: `TicketRow` + the Tickets section between Orchestrators and Scratch in
  `Sidebar.tsx`, hidden when empty. Two invariants: the leading glyph is a
  hollow **diamond**, never the round `.ws-dot` (a ticket must not read as an
  agent with a status), and clicking opens Linear and **never calls
  `setActive`** (which keys off the workspace list; a ticket id would blank the
  main pane).

**Graduation** — the one interesting transition. Spawning from a ticket names
the branch key-first via `ticketBranchName` (`shared/linear.ts`), so the
*existing* branch-derived badge recognises the issue with no extra bookkeeping.
The ticket then carries a `workspaceId`, leaves the queue
(`shared/linear-tickets-queue.ts` `queuedTickets`), and its work shows as an
ordinary workspace row — an issue is never displayed twice.

**Nesting on spawn** — `spawnWorkspaceForTicket` (`main/linear-tickets.ts:166`)
takes an optional `from` (the calling workspace id) and passes
`detached: !from` to `dispatchSpawnRequest`, which nests via
`parentId: input.detached ? undefined : input.from`
(`main/workspaces.ts:1353`). So the two entry points differ deliberately:
`orchestra linear add --spawn` forwards the caller's id and the new workspace
nests under it (matching `orchestra spawn`), while the renderer's
`spawnFromTicket` button (`main/api-handlers.ts:928`) passes no `from` and the
workspace stays top-level — there is no calling agent to nest under. Before
v0.5.184 the CLI path hardcoded `detached: true`, so an orchestrator's
ticket-spawns always landed top-level with no way to override.

## Tests
`linear.test.ts` covers `parseLinearIssueCandidate` (normalization, path-style,
whole-token, permissiveness), the strict `parseLinearTicketRef` (URL + bare id,
rejects branch names and lookalike hosts), and `ticketBranchName` (key-first,
total, capped). `linear-tickets-queue.test.ts` covers the queue rule including
the dangling-workspace case. Both suites are mutation-checked.
