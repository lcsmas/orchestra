// Pinned Linear tickets — the sidebar's "Tickets" section.
//
// A pinned ticket is work that has NOT started yet, made visible next to the
// agents that are running. It is deliberately not a Workspace (see
// `PinnedTicket` in shared/types.ts): it has no worktree, no branch, no agent,
// and none of the lifecycle those imply.
//
// The lifecycle has exactly one interesting transition, "graduation": once a
// workspace exists for a ticket, the ticket leaves the Tickets section and the
// existing branch-derived Linear badge on that workspace row takes over. That
// works with no extra bookkeeping because the branch we spawn is key-first
// (`ticketBranchName`), so the badge pipeline recognises it on its own.
//
// Every dispatch here mirrors the socket-route convention used by
// workspaces.ts: return a `{ ok, ... }` envelope rather than throwing, so the
// CLI can print a real reason and exit non-zero.

import { parseLinearTicketRef, ticketBranchName } from '../shared/linear';
import type { LinearIssue, PinnedTicket } from '../shared/types';
import {
  LinearRequestError,
  fetchLinearIssue,
  fetchLinearIssues,
  fetchMyLinearIssues,
} from './linear';
import { platform } from './platform';
// Routed through the same dispatch `/spawn` uses rather than calling
// createWorkspace directly: it already pairs creation with the headless agent
// start (which is module-private), so a ticket spawn and an agent spawn stay
// one code path instead of two that can drift.
import { dispatchSpawnRequest } from './workspaces';
import { store } from './store';
import { log } from './logger';

/** Broadcast the full pinned list. The renderer replaces its state wholesale —
 *  same shape as the initial `tickets:list` fetch, so no merge logic is needed
 *  on the other side (the pattern `repos:update` already uses). */
function broadcastTickets(): void {
  platform.broadcast('tickets:update', store.tickets);
}

/** Turn a thrown error into the `{ ok:false, error }` envelope. A
 *  LinearRequestError already carries a user-facing message; anything else is
 *  unexpected and gets logged so it isn't silently flattened. */
function toError(e: unknown, fallback: string): { ok: false; error: string } {
  if (e instanceof LinearRequestError) return { ok: false, error: e.message };
  log.warn('linear ticket request failed', e);
  return { ok: false, error: e instanceof Error ? e.message : fallback };
}

/** Build the stored record from a freshly-fetched issue, preserving the fields
 *  that are Orchestra's rather than Linear's (when it was pinned, which repo it
 *  is earmarked for, which workspace graduated it). */
function toTicket(
  issue: LinearIssue,
  prev: PinnedTicket | undefined,
  extra: { repoPath?: string } = {},
): PinnedTicket {
  const ticket: PinnedTicket = {
    identifier: issue.identifier,
    url: issue.url,
    title: issue.title,
    pinnedAt: prev?.pinnedAt ?? Date.now(),
    refreshedAt: Date.now(),
  };
  if (issue.state) ticket.state = issue.state;
  if (issue.assignee !== undefined) ticket.assignee = issue.assignee;
  // An explicit repoPath wins; otherwise keep whatever the ticket already had.
  const repoPath = extra.repoPath ?? prev?.repoPath;
  if (repoPath) ticket.repoPath = repoPath;
  if (prev?.workspaceId) ticket.workspaceId = prev.workspaceId;
  return ticket;
}

export interface TicketAddResult {
  ok: boolean;
  ticket?: PinnedTicket;
  /** Set when `spawn` was requested and a workspace was created for it. */
  workspaceId?: string;
  branch?: string;
  error?: string;
}

/**
 * Pin a ticket by URL or identifier, after verifying it exists in Linear.
 *
 * Verification is not optional: a sidebar row for a ticket that doesn't exist
 * is worse than no row, and the identifier the user typed is the only thing we
 * would otherwise have to trust.
 */
export async function dispatchLinearAddRequest(input: {
  ref: string;
  repoPath?: string;
  spawn?: boolean;
  model?: string;
  from?: string;
}): Promise<TicketAddResult> {
  const identifier = parseLinearTicketRef(input.ref ?? '');
  if (!identifier) {
    return {
      ok: false,
      error:
        `not a Linear ticket reference: ${String(input.ref).slice(0, 80)} ` +
        `(expected e.g. NMC-261 or https://linear.app/<org>/issue/NMC-261/...)`,
    };
  }

  // Only a repo the user has already registered — the same trust boundary
  // `/spawn` enforces (workspaces.ts). An agent must not be able to point
  // Orchestra at an arbitrary filesystem path.
  let repoPath = input.repoPath?.trim() || undefined;
  if (repoPath && !store.repos.some((r) => r.path === repoPath)) {
    return { ok: false, error: `unknown repoPath: ${repoPath}` };
  }
  // Inherit the caller's repo when it has one, so an agent inside a worktree
  // can pin a ticket for its own repo without naming it.
  if (!repoPath && input.from) {
    repoPath = store.getWorkspace(input.from)?.repoPath || undefined;
  }

  let issue: LinearIssue | null;
  try {
    issue = await fetchLinearIssue(identifier);
  } catch (e) {
    return toError(e, 'failed to reach Linear');
  }
  if (!issue) return { ok: false, error: `no such Linear issue: ${identifier}` };

  const ticket = toTicket(issue, store.getTicket(identifier), { repoPath });
  await store.upsertTicket(ticket);
  broadcastTickets();

  if (!input.spawn) return { ok: true, ticket };

  // --spawn: create the workspace immediately and graduate the ticket.
  if (!repoPath) {
    return {
      ok: true,
      ticket,
      error:
        'pinned, but not spawned: no repo to spawn into ' +
        '(pass --repo, or run from a workspace that has one)',
    };
  }
  const spawned = await spawnWorkspaceForTicket(identifier, repoPath, input.model);
  if (!spawned.ok) return { ok: true, ticket, error: spawned.error };
  return { ok: true, ticket: spawned.ticket ?? ticket, workspaceId: spawned.workspaceId, branch: spawned.branch };
}

export interface TicketSpawnResult {
  ok: boolean;
  ticket?: PinnedTicket;
  workspaceId?: string;
  branch?: string;
  error?: string;
}

/**
 * Create a workspace for a pinned ticket and graduate the ticket.
 *
 * The branch is key-first (`nmc-305-grade-sync-…`), which is what lets the
 * existing branch-derived badge take over on the new workspace row — the
 * ticket's identity survives the transition without being stored twice.
 *
 */
export async function spawnWorkspaceForTicket(
  identifier: string,
  repoPath: string,
  model?: string,
): Promise<TicketSpawnResult> {
  const ticket = store.getTicket(identifier);
  if (!ticket) return { ok: false, error: `ticket not pinned: ${identifier}` };
  if (ticket.workspaceId && store.getWorkspace(ticket.workspaceId)) {
    return {
      ok: false,
      error: `${identifier} already has a workspace (${ticket.workspaceId})`,
    };
  }
  if (!store.repos.some((r) => r.path === repoPath)) {
    return { ok: false, error: `unknown repoPath: ${repoPath}` };
  }

  const branch = ticketBranchName(ticket.identifier, ticket.title);
  // The opening prompt carries the ticket itself, so the agent starts with the
  // issue in front of it rather than just a branch name.
  const task =
    `Work on Linear issue ${ticket.identifier}: ${ticket.title}\n` +
    `${ticket.url}\n\n` +
    `Start by reading the issue, then plan before implementing.`;
  try {
    const res = await dispatchSpawnRequest({ repoPath, branch, task, model, detached: true });
    if (!res.ok || !res.id) {
      return { ok: false, error: res.error ?? 'failed to spawn workspace for ticket' };
    }
    // Graduate: the ticket now has a workspace, so it leaves the Tickets
    // section and that workspace's branch badge takes over.
    const updated: PinnedTicket = { ...ticket, workspaceId: res.id, repoPath };
    await store.upsertTicket(updated);
    broadcastTickets();
    return { ok: true, ticket: updated, workspaceId: res.id, branch: res.branch };
  } catch (e) {
    return toError(e, 'failed to spawn workspace for ticket');
  }
}

export interface TicketRemoveResult {
  ok: boolean;
  identifier?: string;
  error?: string;
}

/** Un-pin a ticket. Never touches Linear — this removes an Orchestra row, it
 *  does not close, delete or modify the issue. */
export async function dispatchLinearRemoveRequest(input: {
  ref: string;
}): Promise<TicketRemoveResult> {
  const identifier = parseLinearTicketRef(input.ref ?? '');
  if (!identifier) return { ok: false, error: `not a Linear ticket reference: ${input.ref}` };
  const removed = await store.removeTicket(identifier);
  if (!removed) return { ok: false, error: `not pinned: ${identifier}` };
  broadcastTickets();
  return { ok: true, identifier };
}

export interface TicketListResult {
  ok: boolean;
  /** Pinned tickets (the sidebar's own list) — always present on success. */
  tickets?: PinnedTicket[];
  /** Live Linear results, when `mine` was requested. */
  issues?: LinearIssue[];
  error?: string;
}

/** List pinned tickets, or (with `mine`) the viewer's open Linear issues. */
export async function dispatchLinearListRequest(input: {
  mine?: boolean;
}): Promise<TicketListResult> {
  if (!input.mine) return { ok: true, tickets: store.tickets };
  try {
    return { ok: true, tickets: store.tickets, issues: await fetchMyLinearIssues() };
  } catch (e) {
    return toError(e, 'failed to list Linear issues');
  }
}

export interface TicketPinResult {
  ok: boolean;
  identifier?: string;
  workspaceId?: string;
  error?: string;
}

/**
 * Attach a ticket to an EXISTING workspace whose branch name doesn't encode the
 * key (the Option-A behaviour, kept because it is genuinely useful on its own).
 *
 * The ticket is stored as already-graduated — pinned, with `workspaceId` set —
 * so it does not appear in the Tickets queue (work has started) but the
 * renderer can still surface its identifier on that workspace's row.
 */
export async function dispatchLinearPinRequest(input: {
  ref: string;
  workspaceId?: string;
  from?: string;
}): Promise<TicketPinResult> {
  const identifier = parseLinearTicketRef(input.ref ?? '');
  if (!identifier) return { ok: false, error: `not a Linear ticket reference: ${input.ref}` };
  const workspaceId = input.workspaceId?.trim() || input.from;
  if (!workspaceId) {
    return { ok: false, error: 'no workspace: pass --workspace <id> (or run inside a workspace)' };
  }
  const ws = store.getWorkspace(workspaceId);
  if (!ws) return { ok: false, error: `unknown workspace: ${workspaceId}` };

  let issue: LinearIssue | null;
  try {
    issue = await fetchLinearIssue(identifier);
  } catch (e) {
    return toError(e, 'failed to reach Linear');
  }
  if (!issue) return { ok: false, error: `no such Linear issue: ${identifier}` };

  const ticket = toTicket(issue, store.getTicket(identifier), {
    repoPath: ws.repoPath || undefined,
  });
  ticket.workspaceId = workspaceId;
  await store.upsertTicket(ticket);
  broadcastTickets();
  return { ok: true, identifier, workspaceId };
}

/**
 * Refresh every pinned ticket from Linear in ONE batched request.
 *
 * Deliberately does not reuse `verifyLinearIssue`: that path caches by key for
 * the whole session, which is correct for "does this issue exist?" (an answer
 * that never changes) and wrong here, where the mutable workflow STATE is the
 * entire reason the row exists — a cached hit would pin a ticket at "Todo"
 * forever.
 *
 * A ticket Linear doesn't return keeps its previous values rather than being
 * dropped: a row vanishing on a transient blip is worse than a slightly stale
 * state chip.
 */
export async function refreshPinnedTickets(): Promise<PinnedTicket[]> {
  // Clear graduation pointers to workspaces that no longer exist, so a ticket
  // whose workspace was deleted comes back into the queue instead of staying
  // invisibly pinned.
  if (await store.reconcileTicketWorkspaces()) broadcastTickets();

  const tickets = store.tickets;
  if (tickets.length === 0) return tickets;

  const fresh = await fetchLinearIssues(tickets.map((t) => t.identifier));
  if (fresh.size === 0) return tickets;

  let mutated = false;
  const next = tickets.map((t) => {
    const issue = fresh.get(t.identifier.toUpperCase());
    if (!issue) return t;
    const updated = toTicket(issue, t);
    // Only count a real change, so an unchanged refresh doesn't rewrite
    // store.json or churn the renderer every two minutes.
    if (
      updated.title !== t.title ||
      updated.url !== t.url ||
      updated.state?.name !== t.state?.name ||
      updated.state?.type !== t.state?.type ||
      (updated.assignee?.name ?? null) !== (t.assignee?.name ?? null)
    ) {
      mutated = true;
      return updated;
    }
    return t;
  });

  if (mutated) {
    await store.setTickets(next);
    broadcastTickets();
  }
  return next;
}
