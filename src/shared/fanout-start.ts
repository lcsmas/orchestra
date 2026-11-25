// #587 PR B (ledger #591 I6) — `orchestra fanout start`, the host half, pure of Electron: launch the implementer of every plan ticket that has none LIVE, with the brief rendered by code.
// The app's spawn comes in as `deps` (src/main/fanout-acceptance-wiring.ts), so the tests and the rig drive this very function. The decision "is this impl- spawn a hand spawn" is `handSpawnRefusal`.
import { briefHash } from './fanout-brief-common.ts';
import { renderImplementerBrief } from './fanout-implementer-brief.ts';
import { roleOfName } from './fleet-roles.ts';
import { applyTicketPatch, planMissing, readState, seatRecordsOn, stateFile, updateState, SeatRefusal, type FanoutState } from './fanout-state.ts';

export interface StartDeps {
  home: string;
  now: () => string;
  /** #605 — the Boucle leads this run: the brief carries its loop section (src/shared/fanout-implementer-brief.ts `LOOP_BRIEF`). Absent = `state.loopPlan`. */
  loop?: boolean;
  /** Is this implementer workspace alive? A workspace that exists and is not archived is live (a stopped / hibernated one is woken by its coordinator, never replaced). */
  implementerLive: (id: string) => boolean;
  /** BLOCKING-1 (pre-review): a LIVE workspace of this run already named for `ticket` (`impl-<ticket>` or its `-N` suffix) that the state does not record as any ticket's implementer — the spawn answered and the state write was lost (a crash, a lock). It is ADOPTED, never duplicated. `recorded` = every implementer id the state holds; `others` = the other tickets' implementer names (so `impl-A-2` of ticket `A-2` is not taken for ticket `A`'s). null = none. */
  orphanImplementer?: (i: { run: string; ticket: string; name: string; recorded: string[]; others: string[] }) => { id: string; branch: string } | null;
  /** The coordinator's checkout (the repo the implementers work in). undefined = let the spawn inherit. */
  repoPath: (i: { run: string; ticket: string; repo: string | null }) => string | undefined;
  /** #599 — the repository the worktrees are made in (`repoPath` as `repoPath` answered it): its origin remote (URL or `owner/name`; null = unknown) and its default branch (null = unknown). Absent = every run is read as same-repo (the pre-#599 rule). */
  worktreeRepo?: (i: { run: string; repoPath: string | undefined }) => { remote: string | null; defaultBranch: string | null } | Promise<{ remote: string | null; defaultBranch: string | null }>;
  /** #599 — does `ref` resolve to a commit in the worktree repository (what `git branch <b> <ref>` needs)? Absent = no check. */
  refExists?: (i: { run: string; repoPath: string | undefined; ref: string }) => Promise<boolean>;
  /** The agent spawn: `held` = accepted but held by Admission (the workspace exists, its start is released later). `baseBranch` = the base of the worktree AND its diff / merge base: the run target when it lives in the worktree repository, ABSENT (= the repo's default branch) when the run's target is in another repository (#599). `reuseBranch` = a respawn: `name` IS the ticket's existing branch and the new worktree is put ON it (never a suffixed copy). */
  spawn: (i: { from: string; name: string; task: string; repoPath?: string; baseBranch?: string; reuseBranch?: boolean }) => Promise<{ ok: boolean; id?: string; branch?: string; held?: { since: number }; error?: string }>;
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

/** #599 — `owner/name` of a git remote (https, scp-style or ssh), lowercased, `.git` dropped; null = not a recognisable remote. */
export function repoSlugOf(remote: string | null | undefined): string | null {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?[^/]+\/|[^@/\s]+@[^:/\s]+:|)([^/\s:]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec((remote ?? '').trim());
  return m ? m[1].toLowerCase() : null;
}

/** #599 — where an implementer's worktree is cut from. `same`: the run target is a ref of the worktree repository (base = the target). `cross`: the run's target is in ANOTHER repository (`state.repo` is not the worktree repo's origin) — the worktree starts from the worktree repo's own default branch (`base` absent), the brief names the target. Unknown on either side = same (unchanged). */
export type StartBase = { kind: 'same'; base: string } | { kind: 'cross'; base: undefined; targetRepo: string; defaultBranch: string | null };
export function startBase(i: { stateRepo: string | null; target: string; worktreeRemote: string | null; defaultBranch: string | null }): StartBase {
  const want = repoSlugOf(i.stateRepo), have = repoSlugOf(i.worktreeRemote);
  if (want && have && want !== have) return { kind: 'cross', base: undefined, targetRepo: i.stateRepo!, defaultBranch: i.defaultBranch };
  return { kind: 'same', base: i.target };
}

/** Why `start` is refused for `state` and `caller` (null = fine): the I6 refusal names. */
/** `caller` = the workspace id the HOST vouched (never the bare env). */
export function startRefusal(state: FanoutState | null, run: string, caller: string | undefined): SeatRefusal | null {
  if (!state) return null;
  if (!seatRecordsOn(state)) return new SeatRefusal('start-off', `run ${run} has seatRecords=off: \`fanout start\` is a seatRecords rule (choose it before the first spawn: state set --switch seatRecords=on)`);
  if (!caller || caller !== run) return new SeatRefusal('start-caller', `only the run's coordinator (${run}) starts its implementers${caller ? `, not ${caller}` : ' — the host could not vouch this session (is Orchestra running, and is this the live session of the workspace? an ORCHESTRA_WS_ID in the env is not proof)'}`);
  const missing = planMissing(state);
  if (missing.length) return new SeatRefusal('plan-incomplete', `cannot start: ${missing.length} thing(s) missing from the plan: ${missing.join('; ')}`);
  // never launch an agent whose task is empty: a ticket to spawn needs the spec reference or its text (the run-12 failure class: an implementer with nothing to build)
  const bare = state.plan!.tickets.filter((id) => { const t = state.tickets[id]; return !!t && (t.status === 'todo' || (t.status === 'started' && !t.implementer)) && !t.spec && !t.specText; });
  if (bare.length) return new SeatRefusal('start-no-spec', `cannot start: ${bare.length} plan ticket(s) carry no spec and no text — ${bare.join(', ')} (register each: state set <ticket> --spec <file|url|ledger section> [--spec-text <file|->]); an implementer is never launched with an empty task`);
  return null;
}

/** #587 PR B — the hand-spawn rule: an `impl-` agent spawned by the coordinator of a run with seatRecords=on is refused unless `fanout start` itself spawns it. null = allowed (any other name, a run with the switch off or no state). */
export function handSpawnRefusal(i: { name: string; state: FanoutState | null; viaStart: boolean }): string | null {
  if (i.viaStart || !i.state || !seatRecordsOn(i.state) || roleOfName(i.name) !== 'implementer') return null;
  return `refusing to spawn ${i.name}: run ${i.state.run} has seatRecords=on — its implementers are launched by \`orchestra fanout start\` (the brief is rendered by code). Declare the plan (\`state set --plan\`, \`--plan-add\`) and run \`orchestra fanout start\`. Nothing was created.`;
}

/** The hand-spawn rule read from disk (the host side of `orchestra spawn`): `run` = the RUN of the caller (its own id for a coordinator, its direct parent's for a helper child: a helper cannot spawn the `impl-` agent the coordinator may not). Only an `impl-` name is looked at — anything else costs no read and answers null. A state that cannot be read never refuses. */
export function handSpawnRefusalFor(home: string, run: string | undefined, name: string, viaStart: boolean): string | null {
  if (viaStart || !run || roleOfName(name) !== 'implementer') return null;
  let state: FanoutState | null = null;
  try { state = readState(stateFile(home, run)); } catch { return null; }
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
    let baseOf: StartBase | null = null; // #599: ONE decision per call, taken before the first spawn (a missing same-repo target is refused once, not once per ticket)
    const resolveBase = async (ticket: string, repo: string | null, target: string): Promise<StartBase> => {
      if (baseOf) return baseOf;
      const repoPath = deps.repoPath({ run, ticket, repo });
      const wr = await deps.worktreeRepo?.({ run, repoPath });
      const b = startBase({ stateRepo: repo, target, worktreeRemote: wr?.remote ?? null, defaultBranch: wr?.defaultBranch ?? null });
      if (b.kind === 'same' && deps.refExists && !(await deps.refExists({ run, repoPath, ref: b.base }))) throw new SeatRefusal('start-base-missing', `the run's target branch ${b.base} does not exist in the repository the implementers work in${repoPath ? ` (${repoPath})` : ''} — create it there or fix the run's target (state init --target); nothing was started`);
      return (baseOf = b);
    };
    for (const ticket of state0.plan!.tickets) {
      const cur = readState(file)!; // each ticket sees the writes of the one before
      const t = cur.tickets[ticket];
      if (t.status !== 'todo' && t.status !== 'started') { out.skipped.push({ ticket, reason: t.status }); continue; }
      if (t.implementer && deps.implementerLive(t.implementer)) { out.skipped.push({ ticket, reason: 'live' }); continue; }
      const recordedIds = Object.values(cur.tickets).map((x) => x.implementer).filter((x): x is string => !!x);
      const orphan = deps.orphanImplementer?.({ run, ticket, name: implementerName(ticket), recorded: recordedIds, others: Object.keys(cur.tickets).filter((x) => x !== ticket).map(implementerName) });
      if (orphan) { // adopt the agent the state lost track of: record it, start nothing
        try { updateState(file, (s) => { if (!s) throw new Error(`no fanout state for run ${run}`); return applyTicketPatch(s, ticket, { implementer: orphan.id, branch: orphan.branch, status: 'started' }, deps.now()); }); out.skipped.push({ ticket, reason: 'live' }); } catch (e) { out.failed.push({ ticket, error: `${orphan.id} is live for ${ticket} but could not be recorded: ${e instanceof Error ? e.message : String(e)}` }); }
        continue;
      }
      const kind: 'spawn' | 'respawn' = t.implementer ? 'respawn' : 'spawn'; // a dead recorded implementer is replaced; a ticket set `started` by hand with none is a first spawn
      const onBranch = kind === 'respawn' && !!t.branch; // the dead agent's branch: same name, same PR / head, the new worktree is put ON it
      const base = await resolveBase(ticket, cur.repo, cur.target); // may throw start-base-missing: before this ticket's spawn, so before ANY spawn of the call
      const task = renderImplementerBrief({ state: cur, ticket, ...(deps.loop !== undefined ? { loop: deps.loop } : {}), ...(onBranch ? { continueFrom: { branch: t.branch!, head: t.head } } : {}), ...(base.kind === 'cross' ? { crossRepo: { targetRepo: base.targetRepo, defaultBranch: base.defaultBranch } } : {}) });
      let res: Awaited<ReturnType<StartDeps['spawn']>>;
      try {
        res = await deps.spawn({ from: run, name: onBranch ? t.branch! : implementerName(ticket), task, repoPath: deps.repoPath({ run, ticket, repo: cur.repo }), baseBranch: base.base, ...(onBranch ? { reuseBranch: true } : {}) }); // same repo: the worktree is cut from the run target; another repo (#599): from the worktree repo's default branch, the brief names the target
      } catch (e) { res = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
      if (!res.id || !res.branch) { out.failed.push({ ticket, error: res.error ?? 'spawn failed' }); continue; } // no workspace: nothing to record, a second call retries
      const id = res.id, branch = onBranch ? t.branch! : res.branch, hash = briefHash(task);
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
      if (!res.held) (kind === 'spawn' ? out.started : out.respawned).push({ ticket, ws: id, branch });
      if (res.held) out.waiting.push({ ticket, why: `${id} (${branch}): its start is held by Admission (low memory): the agent exists and starts by itself when memory is back` });
    }
    return out;
  });
}
