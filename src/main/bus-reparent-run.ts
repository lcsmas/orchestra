// #439 — attach / detach re-derive the run of the moved agent and its subtree ON THE BUS (ADR 0012): the run row's parent pointer
// follows the tree, and the agent's UNREAD mail follows the agent. Platform-free (BusDb only) so the tests drive these real functions
// over a real SQLite bus; `reconcileRunAfterReparent` (workspaces.ts) feeds them workspace ids and never lets them throw into an admin op (D1).

import type { BusDb } from './bus.ts';
import { getRelatedRunIds } from './bus-runs.ts';
import { computeAnchorInfo, maybeStartRunAtAnchor, runAnchorProbe, type BusRunAnchorDeps } from './bus-run-anchor.ts';
import { coordinates, coordinatorOf, isCoordinatorKind, memberRunOf, runIdOf, type RunNode } from '../shared/run-position.ts';
import { moveRefusal, strandedExchanges, type OpenExchange } from '../shared/move-exchanges.ts';
import { pausedCarrierForWorkspace } from './bus-pause.ts';

/** `runs.closed_at` of `runId`: null = open, undefined = no such row. */
export function runClosedAt(db: BusDb, runId: string): number | null | undefined {
  const row = db.prepare('SELECT closed_at AS c FROM runs WHERE id = ?').get(runId) as { c: number | null } | undefined;
  return row ? row.c : undefined;
}

/** The runs a reader can see mail in (own ∪ ancestors ∪ descendants, via `parent_run_id`) — the snapshot taken BEFORE a move. */
export function relatedRunsOf(db: BusDb, runId: string): string[] {
  return getRelatedRunIds(db, runId).ids;
}

export type RepointOutcome = 'repointed' | 'unchanged' | 'no-row' | 'refused-closed' | 'refused-cycle' | 'refused-no-parent-row';

/**
 * Re-point the run owned by a moved coordinator at the run it is NOW a member of (`parent_run_id` is written once by `startRun`; before
 * #439 nothing ever updated it after an attach/detach — #434 m1). `kind` follows (mission = no parent, vague = has one). Never points at
 * a CLOSED run (#437), at a run whose row is missing (dangling pointer), or at one of its own descendants (a cycle in the run tree).
 */
export function repointRun(db: BusDb, runId: string, newParentRunId: string | null): RepointOutcome {
  const row = db.prepare('SELECT parent_run_id AS p, kind FROM runs WHERE id = ?').get(runId) as { p: string | null; kind: string } | undefined;
  if (!row) return 'no-row';
  const kind = newParentRunId === null ? 'mission' : 'vague';
  if (newParentRunId !== null) {
    const closed = runClosedAt(db, newParentRunId);
    if (closed === undefined) return 'refused-no-parent-row';
    if (closed !== null) return 'refused-closed';
    const seen = new Set<string>();
    for (let cur: string | null | undefined = newParentRunId; cur && !seen.has(cur); ) {
      if (cur === runId) return 'refused-cycle';
      seen.add(cur);
      cur = (db.prepare('SELECT parent_run_id AS p FROM runs WHERE id = ?').get(cur) as { p: string | null } | undefined)?.p;
    }
  }
  if (row.p === newParentRunId && row.kind === kind) return 'unchanged';
  db.prepare('UPDATE runs SET parent_run_id = ?, kind = ? WHERE id = ?').run(newParentRunId, kind, runId);
  return 'repointed';
}

export interface ForwardResult {
  /** Messages copied into the destination run. */
  forwarded: number;
  /** The source runs mail was taken from. */
  fromRuns: string[];
  /** The destination was CLOSED (#437) — nothing moved; the mail stays where it is. */
  refusedClosed?: boolean;
}

/**
 * MAIL FOLLOWS THE AGENT. Take `reader`'s UNREAD directed mail (recipient = reader, sequence past its cursor in that run — an
 * outstanding unacked lot counts as unread, the bus's own at-least-once rule) out of `fromRunIds` and file a copy in `toRunId`
 * (the run the agent now checks), in one immediate transaction:
 *   - copies get fresh sequences (> any cursor the reader holds in `toRunId`, so nothing is hidden behind an old ack) and keep sender,
 *     kind, body, thread and time; a `dispatch` copy takes its capability row along (the end-of-work report is verified in the new run);
 *   - the reader's cursor in each source run advances past what was copied and its outstanding lot there is closed — so a second call,
 *     or the agent coming back later, finds nothing: DELIVERED ONCE. Mail already acked is never touched; run-wide broadcasts (recipient
 *     NULL) belong to the run left and stay there.
 * Never copies into a closed run. Idempotent.
 */
export function forwardUnreadMail(db: BusDb, reader: string, fromRunIds: readonly string[], toRunId: string): ForwardResult {
  const out: ForwardResult = { forwarded: 0, fromRuns: [] };
  const sources = [...new Set(fromRunIds)].filter((r) => r !== toRunId);
  if (sources.length === 0) return out;
  if (runClosedAt(db, toRunId) != null) return { ...out, refusedClosed: true };
  const cursor = db.prepare('SELECT acked_seq AS s FROM cursors WHERE run_id = ? AND reader = ?');
  const unread = db.prepare('SELECT * FROM messages WHERE run_id = ? AND recipient = ? AND sequence > ? ORDER BY sequence');
  const insert = db.prepare('INSERT INTO messages (run_id, thread_id, sender, recipient, kind, body, created_at) VALUES (?,?,?,?,?,?,?)');
  const caps = db.prepare('SELECT * FROM dispatch_capabilities WHERE run_id = ? AND dispatch_seq = ?');
  const insertCap = db.prepare(
    'INSERT OR IGNORE INTO dispatch_capabilities (run_id, dispatch_seq, token_hash, recipient, state, minted_at, resolved_at) VALUES (?,?,?,?,?,?,?)',
  );
  const bump = db.prepare(
    'INSERT INTO cursors (run_id, reader, acked_seq) VALUES (?,?,?) ON CONFLICT(run_id, reader) DO UPDATE SET acked_seq = MAX(acked_seq, excluded.acked_seq)',
  );
  const closeLots = db.prepare('UPDATE deliveries SET acked_at = ? WHERE run_id = ? AND reader = ? AND acked_at IS NULL');
  db.transaction(() => {
    for (const from of sources) {
      const cur = (cursor.get(from, reader) as { s: number } | undefined)?.s ?? 0;
      const rows = unread.all(from, reader, cur) as Array<{
        sequence: number; thread_id: string | null; sender: string; recipient: string | null; kind: string; body: string; created_at: number;
      }>;
      if (rows.length === 0) continue;
      for (const m of rows) {
        const newSeq = Number(insert.run(toRunId, m.thread_id, m.sender, m.recipient, m.kind, m.body, m.created_at).lastInsertRowid);
        if (m.kind === 'dispatch') {
          for (const c of caps.all(from, m.sequence) as Array<{ token_hash: string; recipient: string | null; state: string; minted_at: number; resolved_at: number | null }>) {
            insertCap.run(toRunId, newSeq, c.token_hash, c.recipient, c.state, c.minted_at, c.resolved_at);
          }
        }
      }
      bump.run(from, reader, rows[rows.length - 1].sequence);
      closeLots.run(Date.now(), from, reader);
      out.forwarded += rows.length;
      out.fromRuns.push(from);
    }
  }).immediate();
  return out;
}

export interface RederiveReport {
  /** The run id the agent's bus address belongs to now. */
  home: string;
  /** Its run row did not exist before and was started now (notice to rewrite). */
  startedRow: boolean;
  repoint?: RepointOutcome;
  mail?: ForwardResult;
}

/**
 * #439 — the whole bus half of "attach and detach re-derive the run of the moved agent", for ONE agent, AFTER the store moved the tree.
 * Runs whether or not its run id changed (#433 M1: the noop branch used to skip it):
 *   1. the run row it now belongs to exists — its own mission / vague when it coordinates (top-level or an owner), else its new parent's
 *      (the parent's row first, so no pointer ever dangles);
 *   2. the run it OWNS is re-pointed at the run it is now a member of (`repointRun`; #434 m1);
 *   3. its unread mail in runs that were related to it before (`relatedBefore`, snapshotted pre-move) and are not now — plus the run its plain
 *      `check` read before (`oldHome`), still related or not — follows it into `runIdOf` (`forwardUnreadMail`).
 * Throws only on a bus failure; the caller (`reconcileRunAfterReparent`) logs it (D1).
 */
export function rederiveRunOnBus(
  deps: BusRunAnchorDeps,
  db: BusDb,
  ws: RunNode,
  lookup: (id: string) => RunNode | undefined,
  relatedBefore?: readonly string[],
  /** The run the agent's plain `check` read BEFORE the move (`runIdOf`): when it differs from `home` the agent can no longer reach mail left there — even if that run is still an ancestor. */
  oldHome?: string,
): RederiveReport {
  const probe = runAnchorProbe(deps);
  const parent = coordinatorOf(ws, lookup);
  if (parent) maybeStartRunAtAnchor(deps, computeAnchorInfo(parent, lookup, probe));
  const anchor = computeAnchorInfo(ws, lookup, probe);
  const had = probe(anchor.anchorId);
  maybeStartRunAtAnchor(deps, anchor);
  const report: RederiveReport = { home: runIdOf(ws, lookup), startedRow: !had && probe(anchor.anchorId) };
  if (coordinates(ws) && probe(ws.id)) report.repoint = repointRun(db, ws.id, memberRunOf(ws, lookup));
  if (relatedBefore) {
    const after = new Set(relatedRunsOf(db, report.home));
    report.mail = forwardUnreadMail(db, ws.id, [...relatedBefore.filter((r) => !after.has(r)), ...(oldHome ? [oldHome] : [])], report.home);
  }
  return report;
}

/** #439 — the open gates and unanswered asks that involve one of `memberIds` and a workspace OUTSIDE them (the input of the move refusal, R2).
 *  An ask is answered by a reply from its recipient to its sender threaded to the question — in ANY run: a stranger's ask is filed in the recipient's run and its reply in the asker's (#436, `ANSWER_RUN_SQL`); a sequence is global, so the thread id is unambiguous. */
export function openExchangesOf(db: BusDb, memberIds: readonly string[]): OpenExchange[] {
  if (memberIds.length === 0) return [];
  const ids = new Set(memberIds);
  const json = JSON.stringify([...ids]);
  const out: OpenExchange[] = [];
  const gates = db.prepare(
    `SELECT id, run_id, asked_by, recipient FROM decision_gates WHERE resolved_at IS NULL
        AND (asked_by IN (SELECT value FROM json_each(?)) OR recipient IN (SELECT value FROM json_each(?)))`,
  ).all(json, json) as Array<{ id: number; run_id: string; asked_by: string; recipient: string | null }>;
  for (const g of gates) {
    const inside = ids.has(g.asked_by) ? g.asked_by : g.recipient!;
    const other = ids.has(g.asked_by) ? g.recipient : g.asked_by;
    if (other && !ids.has(other)) out.push({ kind: 'gate', ref: g.id, run: g.run_id, member: inside, counterparty: other });
  }
  const asks = db.prepare(
    `SELECT q.sequence, q.run_id, q.sender, q.recipient FROM messages q
      WHERE q.kind = 'question' AND q.recipient IS NOT NULL
        AND (q.sender IN (SELECT value FROM json_each(?)) OR q.recipient IN (SELECT value FROM json_each(?)))
        AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.thread_id = CAST(q.sequence AS TEXT)
                          AND r.sender = q.recipient AND r.recipient = q.sender)`,
  ).all(json, json) as Array<{ sequence: number; run_id: string; sender: string; recipient: string }>;
  for (const q of asks) {
    const inside = ids.has(q.sender) ? q.sender : q.recipient;
    const other = ids.has(q.sender) ? q.recipient : q.sender;
    if (!ids.has(other)) out.push({ kind: 'ask', ref: q.sequence, run: q.run_id, member: inside, counterparty: other, toMember: ids.has(q.recipient) });
  }
  return out;
}

/**
 * #439 (review M1) — mail TO agents left behind: unread directed mail filed in a run the moved subtree OWNS (a worker_done / digest its member sent
 * to a recipient that stays) whose run is no longer related to that recipient's home is copied into the recipient's home, exactly once
 * (`forwardUnreadMail`). `homeOf` answers a recipient's post-move home run (undefined = not a workspace: skipped); `skip` = agents already handled
 * as movers. Returns one result per (recipient) that had something to forward.
 */
export function forwardMailToOthers(
  db: BusDb,
  subtreeIds: readonly string[],
  homeOf: (id: string) => string | undefined,
  skip: ReadonlySet<string>,
): Array<{ reader: string; res: ForwardResult }> {
  const out: Array<{ reader: string; res: ForwardResult }> = [];
  const runs = (db.prepare('SELECT id FROM runs WHERE coordinator IN (SELECT value FROM json_each(?))').all(JSON.stringify([...subtreeIds])) as Array<{ id: string }>).map((r) => r.id);
  if (runs.length === 0) return out;
  const recipients = (db.prepare('SELECT DISTINCT recipient AS r FROM messages WHERE recipient IS NOT NULL AND run_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(runs)) as Array<{ r: string }>).map((x) => x.r);
  for (const reader of recipients) {
    if (skip.has(reader)) continue;
    const home = homeOf(reader);
    if (!home) continue;
    const after = new Set(relatedRunsOf(db, home));
    const res = forwardUnreadMail(db, reader, runs.filter((r) => !after.has(r)), home);
    if (res.forwarded > 0 || res.refusedClosed) out.push({ reader, res });
  }
  return out;
}

/**
 * #439 (OPS ruling R2) — null when moving `id` under `newParentId` (null = detach) is allowed, else the refusal text: the mover or a subtree member
 * holds an OPEN gate / UNANSWERED ask whose counterparty would lie outside its related runs after the move. The post-move tree is SIMULATED from `all`
 * (no write): the mover's parent changes, a link-only ownership ends, the target becomes an owner. A dispatch never refuses (every spawned child has one).
 */
export function moveRefusalFor(db: BusDb, all: ReadonlyArray<RunNode & { canOrchestrate?: boolean; branch?: string }>, id: string, newParentId: string | null): string | null {
  const ws = all.find((w) => w.id === id);
  if (!ws) return null;
  const members: string[] = [id];
  for (let i = 0; i < members.length; i++) for (const w of all) if (w.parentId === members[i] && !members.includes(w.id)) members.push(w.id);
  // OPS ruling R3: a move must not be an escape hatch from a Pause (spec story 2) — refused while the mover or a subtree member is a member of a PAUSED run
  // (hard or douce; the gate's own live-tree walk, a member already released by a Reprise may move). A move INTO a paused run stays allowed: its next start is gated.
  for (const id2 of members) {
    const node = all.find((w) => w.id === id2)!;
    const carrier = pausedCarrierForWorkspace(db, node, (x) => all.find((w) => w.id === x));
    if (carrier) return `run ${carrier.runId} en pause — lift it with orchestra run resume first`;
  }
  const exchanges = openExchangesOf(db, members);
  if (exchanges.length === 0) return null;
  const linkOnly = ws.ownsRun === true && ws.canOrchestrate !== true && !isCoordinatorKind(ws) && !all.some((w) => w.parentId === id); // run-position: non-run — simulating the ownership WRITE of an attach
  const after = all.map((w) =>
    w.id === id ? { ...w, parentId: newParentId ?? undefined, ...(newParentId && linkOnly ? { ownsRun: undefined } : {}) }
      : newParentId && w.id === newParentId ? { ...w, ownsRun: true } : w);
  const byId = new Map(after.map((w) => [w.id, w]));
  const stranded = strandedExchanges(exchanges, (x) => byId.get(x), after, (x) => all.find((w) => w.id === x));
  return stranded.length ? moveRefusal(stranded, (x) => byId.get(x)?.branch ?? x) : null;
}
