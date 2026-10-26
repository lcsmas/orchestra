# Linear integration

Pinned Linear tickets only. The per-workspace Linear badge (`orchestra link
--linear`, `verifyLinear`, the link backfill and the SessionStart link nudge) was
removed on 2026-10-26 as UI clutter. Files: `src/main/linear.ts`,
`src/main/linear-tickets.ts`, `src/shared/linear.ts` (+ `.test.ts`). UI:
`LinearSettings.tsx`, the Tickets section in `Sidebar.tsx`.

## API key
Linear GraphQL (`https://api.linear.app/graphql`, `Authorization: <key>`, no
Bearer). Key resolution (`resolveApiKey`): stored key → `LINEAR_API_KEY` env →
none; `getLinearKeySource` drives the "Linear not configured" notice
(`env-status.ts`). Stored via `secrets.ts` (encrypted when a keyring answers — see `workspaces.md` § Secrets; the dialog shows `SecretsNotice` when it does not). UI: `LinearSettings.tsx`
(test/save/clear). IPC: `linear:keySource`/`checkKey`/`saveKey`/`clearKey`.

## Pinned tickets — the sidebar's Tickets section

Issues pinned into the sidebar as rows
of their own, so work that has **not started** is visible next to running
agents. Files: `src/main/linear-tickets.ts`, `src/shared/linear-tickets-queue.ts`
(+ `.test.ts`), store collection in `store.ts`, UI in `Sidebar.tsx`.

A ticket is **not** a `Workspace` and deliberately not a fourth `kind` — see the
`PinnedTicket` doc comment (`types.ts`): a new kind would silently enrol tickets
in `pruneOrphanedWorkspaces`, the agent session start, `allocatePort` and the
delete/archive/rename paths, none of which mean anything for a ticket.

- **Store**: `tickets?: PinnedTicket[]` (`store.ts`), with
  `upsertTicket`/`setTickets`/`removeTicket`/`getTicket` and
  `reconcileTicketWorkspaces` (clears a `workspaceId` pointing at a deleted
  workspace, so a ticket can't be stranded invisibly).
- **Fetch**: `fetchLinearIssue` / `fetchLinearIssues` (BATCHED — one request for
  every pinned key) / `fetchMyLinearIssues` in `main/linear.ts`. Uncached (the
  row shows mutable workflow state), throwing `LinearRequestError` so an
  explicit CLI command fails **loud** rather than resolving to `null`.
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
the branch key-first via `ticketBranchName` (`shared/linear.ts`). The ticket
then carries a `workspaceId`, leaves the queue
(`shared/linear-tickets-queue.ts` `queuedTickets`), and its work shows as an
ordinary workspace row — an issue is never displayed twice.

**A failed START still graduates (#227 F4):** `spawnWorkspaceForTicket` graduates the ticket to the kept child whenever `dispatchSpawnRequest` created one (`res.id`), even with `ok:false`, and returns `{ok:false, error, workspaceId}`; a retry hits the "already has a workspace — Restart it" guard instead of spawning a duplicate. `dispatchLinearAddRequest` reports the graduated ticket + workspace WITH the error.

**Nesting on spawn** — `spawnWorkspaceForTicket` (`main/linear-tickets.ts:166`)
takes an optional `from` (the calling workspace id) and passes
`detached: !from` to `dispatchSpawnRequest`, which nests via
`parentId: input.detached ? undefined : input.from`
(`main/workspaces.ts:1353`). So the two entry points differ deliberately:
`orchestra linear add --spawn` forwards the caller's id and the new workspace
nests under it (matching `orchestra spawn`; but it passes no `--name`/`namedBy` and keeps its key-first branch and nudge — the required spawn name is keyed on the `/spawn` route, #382 / #380 D4), while the renderer's
`spawnFromTicket` button (`main/api-handlers.ts:928`) passes no `from` and the
workspace stays top-level — there is no calling agent to nest under. Before
v0.5.184 the CLI path hardcoded `detached: true`, so an orchestrator's
ticket-spawns always landed top-level with no way to override.

## Tests
`linear.test.ts` covers the strict `parseLinearTicketRef` (URL + bare id,
rejects branch names and lookalike hosts), and `ticketBranchName` (key-first,
total, capped). `linear-tickets-queue.test.ts` covers the queue rule including
the dangling-workspace case. Both suites are mutation-checked.
