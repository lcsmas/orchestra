// #435 (ADR 0012, spec #431 story 11) — the task given to `orchestra spawn` IS the dispatch: the host records it on the bus as a
// `dispatch` from the spawner to the new agent, minting the capability, BEFORE the agent starts — so the child's `worker_done --cap`
// is accepted with no step from its parent. Platform-free (collaborators injected, like bus-run-anchor.ts) so a test drives the
// SHIPPED functions over a real bus.sqlite: workspaces.ts (`./store`/`./platform`) cannot load under `node --test`.
//
// Ordering is the guarantee: create child (parent now owns its run — #434) → write dispatch → start the agent. A failed write starts
// nothing and removes the just-created workspace, so no agent ever runs without its dispatch. No spawner (a human click), no task, or
// a `--detached` child (parentless, its own mission — a dispatch across unrelated runs is refused, #436) = NO dispatch.

import type { BusDb } from './bus.ts';
import { mintCapability, ownRunRecipientSql, send } from './bus.ts';
import { getRun } from './bus-runs.ts';
import { memberRunOf, runIdOf, type RunLookup, type RunNode } from '../shared/run-position.ts';

export type SpawnDispatchOutcome =
  | { kind: 'none'; reason: 'no-spawner' | 'detached' | 'sandbox' | 'empty-task' }
  | { kind: 'recorded'; runId: string; seq: number }
  | { kind: 'failed'; error: string };

export interface SpawnDispatchInput {
  /** The spawner's workspace id (`/spawn` `from`); absent = a human click. */
  spawner?: string;
  /** `--detached`: the child has no parent. */
  detached?: boolean;
  /** The child's workspace is a sandbox one (the bus is the host's; ADR 0012 out of scope). */
  remote?: boolean;
  /** The just-created child. */
  child: RunNode;
  task: string;
  /** Advance the child's read cursor past the dispatch in the SAME transaction (the child already holds the task as its opening prompt: no wake turn for it).
   *  Only for a brand-new child — a restart of an older one must not skip the mail it has not read. */
  preAck?: boolean;
}

export interface SpawnDispatchDeps {
  /** The boot bus, or null when it failed to open. */
  getBus: () => BusDb | null;
  lookup: RunLookup;
}

/** Record the spawn task as the spawner's dispatch to the child. Never throws: a failure is an outcome the caller turns into a refused spawn. */
export function recordSpawnDispatch(deps: SpawnDispatchDeps, a: SpawnDispatchInput): SpawnDispatchOutcome {
  if (!a.spawner) return { kind: 'none', reason: 'no-spawner' };
  if (a.detached || a.child.parentId !== a.spawner) return { kind: 'none', reason: 'detached' };
  if (a.remote) return { kind: 'none', reason: 'sandbox' };
  if (!a.task.trim()) return { kind: 'none', reason: 'empty-task' };
  try {
    const spawner = deps.lookup(a.spawner);
    if (!spawner) return { kind: 'failed', error: `the spawner ${a.spawner} is not in the store` };
    // The dispatch lives in the spawner's own run, which the child is a MEMBER of (a first spawn made the spawner its owner — #434); the child may own a run of its own by now (it spawned, or was promoted).
    const runId = runIdOf(spawner, deps.lookup);
    if (memberRunOf(a.child, deps.lookup) !== runId) {
      return { kind: 'failed', error: `the spawner and its child are in different runs (${runId} vs ${memberRunOf(a.child, deps.lookup)})` };
    }
    const db = deps.getBus();
    if (!db) return { kind: 'failed', error: 'the bus is not open' };
    const run = getRun(db, runId);
    if (!run) return { kind: 'failed', error: `run ${runId} has no row on the bus` };
    if (run.closed_at !== null) return { kind: 'failed', error: `run ${runId} is closed` };
    // ONE transaction: the dispatch row and its capability land together or not at all (a dispatch with no capability would reject every worker_done).
    const seq = db.transaction((): number => {
      const cursor = (db.prepare('SELECT acked_seq FROM cursors WHERE run_id = ? AND reader = ?').get(runId, a.child.id) as { acked_seq: number } | undefined)?.acked_seq ?? 0;
      const earlierUnread = (db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE run_id = ? AND sequence > ? AND ${ownRunRecipientSql()}`).get(runId, cursor, a.child.id, a.child.id) as { c: number }).c;
      const s = send(db, { runId, sender: spawner.id, kind: 'dispatch', body: a.task, recipient: a.child.id });
      mintCapability(db, runId, s, a.child.id);
      // The ack bump (`ack()` in bus.ts does exactly this): MAX so a cursor already past it never moves back. A LATER dispatch has a higher seq and wakes as usual.
      // Only when NO earlier unread mail is visible to the child: the cursor is one high-water mark per (run, reader), so a bump would hide it — then the child is woken instead.
      if (a.preAck && earlierUnread === 0) db.prepare('INSERT INTO cursors (run_id, reader, acked_seq) VALUES (?,?,?) ON CONFLICT(run_id, reader) DO UPDATE SET acked_seq = MAX(acked_seq, excluded.acked_seq)').run(runId, a.child.id, s);
      return s;
    })();
    return { kind: 'recorded', runId, seq };
  } catch (e) {
    return { kind: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}

/** A start (restart / wake / retry) of a child that HAS a parent while its opening brief is still owed: if no dispatch to it exists in its run, write it first (same function, no pre-ack —
 *  the child may hold unread mail), else leave it. `failed` = refuse the start: no agent may run without its dispatch. */
export function ensureOwedDispatch(deps: SpawnDispatchDeps, child: RunNode, task: string): SpawnDispatchOutcome | { kind: 'present' } {
  if (!child.parentId || !deps.lookup(child.parentId)) return { kind: 'none', reason: 'detached' }; // parentless (or its parent is gone): nobody to dispatch it
  try {
    const db = deps.getBus();
    if (!db) return { kind: 'failed', error: 'the bus is not open (cannot check the owed dispatch)' };
    // The dispatch sits in the run the child is a MEMBER of (its parent's) — also looked up there when it owns a run of its own by now (spawned a helper / was promoted before its brief was delivered).
    const runs = [runIdOf(child, deps.lookup), memberRunOf(child, deps.lookup)].filter((r): r is string => !!r);
    const has = db.prepare(`SELECT 1 FROM messages WHERE kind = 'dispatch' AND recipient = ? AND run_id IN (${runs.map(() => '?').join(',')}) LIMIT 1`).get(child.id, ...runs);
    if (has) return { kind: 'present' };
    return recordSpawnDispatch(deps, { spawner: child.parentId, child, task });
  } catch (e) {
    return { kind: 'failed', error: `owed-dispatch check: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export type StartAfterDispatch<R> = { ran: true; result: R; dispatch: SpawnDispatchOutcome } | { ran: false; error: string; kept?: string };

/** The ordering seam of `dispatchSpawnRequest`: write the dispatch, THEN start. A failed write never starts the agent; the workspace
 *  is torn down (a teardown that itself fails is reported as `kept`, still stopped). */
export async function startAfterDispatch<R>(a: {
  record: () => SpawnDispatchOutcome;
  start: () => Promise<R>;
  teardown: () => Promise<void>;
}): Promise<StartAfterDispatch<R>> {
  let dispatch: SpawnDispatchOutcome;
  try {
    dispatch = a.record();
  } catch (e) {
    dispatch = { kind: 'failed', error: e instanceof Error ? e.message : String(e) }; // a throw while GATHERING the inputs is a failed write too: never fall through to the start
  }
  if (dispatch.kind === 'failed') {
    try {
      await a.teardown();
      return { ran: false, error: `could not record the task as your dispatch (${dispatch.error}). The agent was NOT started and its workspace was removed — nothing is running.` };
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return { ran: false, error: `could not record the task as your dispatch (${dispatch.error}), and removing the new workspace failed (${why}). The workspace was kept STOPPED with no dispatch: do NOT restart it — delete it (\`orchestra delete <id> --yes\`) and spawn again.`, kept: why };
    }
  }
  return { ran: true, result: await a.start(), dispatch };
}
