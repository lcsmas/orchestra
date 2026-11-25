// #587 PR B (ledger #591 I6) — `orchestra fanout start`, the host half, pure of Electron: launch the implementer of every plan ticket that has none LIVE, with the brief rendered by code.
// The app's spawn comes in as `deps` (src/main/fanout-acceptance-wiring.ts), so the tests and the rig drive this very function. The decision "is this impl- spawn a hand spawn" is `handSpawnRefusal`.
import { briefHash } from './fanout-brief-common.ts';
import { renderImplementerBrief } from './fanout-implementer-brief.ts';
import { roleOfName } from './fleet-roles.ts';
import { applyTicketPatch, planMissing, readState, seatRecordsOn, stateFile, updateState, SeatRefusal, type FanoutState } from './fanout-state.ts';

export interface StartDeps {
  home: string;
  now: () => string;
  /** Is this implementer workspace alive? A workspace that exists and is not archived is live (a stopped / hibernated one is woken by its coordinator, never replaced). */
  implementerLive: (id: string) => boolean;
  /** The coordinator's checkout (the repo the implementers work in). undefined = let the spawn inherit. */
  repoPath: (i: { run: string; ticket: string; repo: string | null }) => string | undefined;
  /** The agent spawn: `held` = accepted but held by Admission (the workspace exists, its start is released later). `baseBranch` = a respawn continues from the dead agent's branch. */
  spawn: (i: { from: string; name: string; task: string; repoPath?: string; baseBranch?: string }) => Promise<{ ok: boolean; id?: string; branch?: string; held?: { since: number }; error?: string }>;
}

export interface StartResult {
  started: Array<{ ticket: string; ws: string; branch: string }>;
  respawned: Array<{ ticket: string; ws: string; branch: string }>;
  waiting: Array<{ ticket: string; why: string }>;
  skipped: Array<{ ticket: string; reason: string }>;
  /** additive to I6: a spawn that failed (the ticket stays as it was; a second call retries it). */
  failed: Array<{ ticket: string; error: string }>;
}

/** `impl-<ticket>`: a spawn name the naming policy accepts (letters, digits, . _ - only). */
export function implementerName(ticket: string): string {
  const slug = ticket.normalize('NFD').replace(/\p{M}+/gu, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').replace(/\.{2,}/g, '.').slice(0, 60);
  return `impl-${slug || 'ticket'}`;
}

/** Why `start` is refused for `state` and `caller` (null = fine): the I6 refusal names. */
export function startRefusal(state: FanoutState | null, run: string, caller: string | undefined): SeatRefusal | null {
  if (!state) return null;
  if (!seatRecordsOn(state)) return new SeatRefusal('start-off', `run ${run} has seatRecords=off: \`fanout start\` is a seatRecords rule (choose it before the first spawn: state set --switch seatRecords=on)`);
  if (!caller || caller !== run) return new SeatRefusal('start-caller', `only the run's coordinator (${run}) starts its implementers${caller ? `, not ${caller}` : ' (no workspace identity: ORCHESTRA_WS_ID is empty)'}`);
  const missing = planMissing(state);
  if (missing.length) return new SeatRefusal('plan-incomplete', `cannot start: ${missing.length} thing(s) missing from the plan: ${missing.join('; ')}`);
  return null;
}

/** #587 PR B — the hand-spawn rule: an `impl-` agent spawned by the coordinator of a run with seatRecords=on is refused unless `fanout start` itself spawns it. null = allowed (any other name, a run with the switch off or no state). */
export function handSpawnRefusal(i: { name: string; state: FanoutState | null; viaStart: boolean }): string | null {
  if (i.viaStart || !i.state || !seatRecordsOn(i.state) || roleOfName(i.name) !== 'implementer') return null;
  return `refusing to spawn ${i.name}: run ${i.state.run} has seatRecords=on — its implementers are launched by \`orchestra fanout start\` (the brief is rendered by code). Declare the plan (\`state set --plan\`, \`--plan-add\`) and run \`orchestra fanout start\`. Nothing was created.`;
}

/** The hand-spawn rule read from disk (the host side of `orchestra spawn`): only an `impl-` name by a caller that owns a fanout state is looked at — anything else costs no read and answers null. A state that cannot be read never refuses. */
export function handSpawnRefusalFor(home: string, from: string | undefined, name: string, viaStart: boolean): string | null {
  if (viaStart || !from || roleOfName(name) !== 'implementer') return null;
  let state: FanoutState | null = null;
  try { state = readState(stateFile(home, from)); } catch { return null; }
  return handSpawnRefusal({ name, state, viaStart });
}

const locks = new Map<string, Promise<unknown>>();
/** One `start` at a time per run (the host is one process): two concurrent calls never spawn two agents for one ticket. */
function serial<T>(run: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(run) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(run, next.catch(() => undefined));
  return next;
}

/** Start (or respawn) the implementer of every plan ticket that has none live. A refusal throws a SeatRefusal; a held start is a WAIT; a failed spawn is listed, never thrown. */
export function startRun(run: string, caller: string | undefined, deps: StartDeps): Promise<StartResult> {
  return serial(run, async () => {
    const file = stateFile(deps.home, run);
    const state0 = readState(file);
    if (!state0) throw new SeatRefusal('start-off', `no fanout state for run ${run}`);
    const refusal = startRefusal(state0, run, caller);
    if (refusal) throw refusal;
    const out: StartResult = { started: [], respawned: [], waiting: [], skipped: [], failed: [] };
    for (const ticket of state0.plan!.tickets) {
      const cur = readState(file)!; // each ticket sees the writes of the one before
      const t = cur.tickets[ticket];
      if (t.status !== 'todo' && t.status !== 'started') { out.skipped.push({ ticket, reason: t.status }); continue; }
      if (t.implementer && deps.implementerLive(t.implementer)) { out.skipped.push({ ticket, reason: 'live' }); continue; }
      const kind: 'spawn' | 'respawn' = t.implementer || t.status === 'started' ? 'respawn' : 'spawn';
      const task = renderImplementerBrief({ state: cur, ticket, ...(kind === 'respawn' && t.branch ? { continueFrom: { branch: t.branch, head: t.head } } : {}) });
      let res: Awaited<ReturnType<StartDeps['spawn']>>;
      try {
        res = await deps.spawn({ from: run, name: implementerName(ticket), task, repoPath: deps.repoPath({ run, ticket, repo: cur.repo }), ...(kind === 'respawn' && t.branch ? { baseBranch: t.branch } : {}) });
      } catch (e) { res = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
      if (!res.id || !res.branch) { out.failed.push({ ticket, error: res.error ?? 'spawn failed' }); continue; } // no workspace: nothing to record, a second call retries
      const id = res.id, branch = res.branch, hash = briefHash(task);
      let recorded = false;
      for (let k = 0; ; k++) { // the agent exists once the spawn answered: losing its id (a lock timeout…) would strand the ticket, so the write is retried
        try {
          updateState(file, (s) => {
            if (!s) throw new Error(`no fanout state for run ${run}`);
            const now = deps.now();
            const next = applyTicketPatch(s, ticket, { implementer: id, branch, status: 'started' }, now);
            const tk = next.tickets[ticket];
            return { ...next, tickets: { ...next.tickets, [ticket]: { ...tk, start: { at: now, kind, briefHash: hash, briefs: (t.start?.briefs ?? 0) + 1 } } } };
          });
          recorded = true;
          break;
        } catch (e) { if (k >= 3) { out.failed.push({ ticket, error: `spawned ${id} but could not record it: ${e instanceof Error ? e.message : String(e)}` }); break; } }
      }
      if (!recorded) continue;
      if (!res.ok) { out.failed.push({ ticket, error: `${res.error ?? 'the agent failed to start'} (workspace ${id} was kept and is recorded as the implementer: restart it, do not start again)` }); continue; } // a KEPT child: recorded so a second call never spawns a duplicate
      (kind === 'spawn' ? out.started : out.respawned).push({ ticket, ws: id, branch });
      if (res.held) out.waiting.push({ ticket, why: 'its start is held by Admission (low memory): the agent exists and starts by itself when memory is back' });
    }
    return out;
  });
}
