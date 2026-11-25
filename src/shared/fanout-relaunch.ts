// #608 (spec #601 stories 22–23, decision 12) — the loop's `reconcile` and `end` steps: at EVERY start git and the PR host overrule the state (a merge made by hand is adopted, a closed PR parks its ticket, nothing is concluded from a read that failed),
// and the run ends with a report DERIVED from the state. No agent is started here: adopting live agents / respawning dead ones on their branch is `startRun` (fanout-start.ts), reviewers are claim/settle (fanout-review.ts) — both already idempotent; this step only makes the STATE true first.
// #605's `stepReconcile(ctx)` / `stepEnd(ctx)` stubs call these with the ports the loop already holds. Ports and the park helper are structural (the frozen names of ledger #613), so this file builds before #603 / #605 land.
import { applyWriteBack, readState, reconcile, sameContent, stateFile, updateState, type Divergence, type FanoutState, type Reality, type TicketReality, type TicketState } from './fanout-state.ts';
import { buildReport, collectCosts, isParked, parkedOf, reportExit, type ParkCauseView, type Report, type TokenCost } from './fanout-report.ts';

// ── ports: the structural subset of the frozen GitPort / ForgePort this step reads (read-only: it never merges, opens or closes anything) ──
export interface RelaunchGit { head(branch: string): Promise<string | null>; tree(sha: string): Promise<string | null>; isMerged(branch: string, base: string): Promise<boolean> }
export interface RelaunchForge { prState(n: number): Promise<{ state: 'open' | 'merged' | 'closed'; head: string }> }
/** The run's state file: read it, or change it atomically (one lock, one write — a kill leaves it before or after, never between). */
export interface StatePort { read(): FanoutState; update(mutate: (cur: FanoutState) => FanoutState): FanoutState }
/** #603 `parkTicket(state, id, {cause, reason}, now)`: parks the ticket AND its transitive dependents (`upstream`). */
export type ParkFn = (state: FanoutState, id: string, why: { cause: ParkCauseView; reason: string }, now: string) => FanoutState;

export function fileStatePort(home: string, run: string): StatePort {
  const file = stateFile(home, run);
  return {
    read: () => { const s = readState(file); if (!s) throw new Error(`no fanout state for run ${run}`); return s; },
    update: (mutate) => updateState(file, (cur) => { if (!cur) throw new Error(`no fanout state for run ${run}`); return mutate(cur); }),
  };
}

export interface RelaunchCtx { now: () => string; log: (line: string) => void; git: RelaunchGit; forge: RelaunchForge; state: StatePort; park: ParkFn }

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const short = (sha: string | null | undefined): string => (sha ?? '?').slice(0, 8);

/** What git and the PR host say about every ticket that has a branch or a PR. A read that throws is `error` — UNKNOWN, never "gone" (reconcile concludes nothing from it). The loop merges into the run target, so a PR's base is the target. */
export async function readReality(state: FanoutState, ctx: Pick<RelaunchCtx, 'git' | 'forge'>): Promise<Reality> {
  const reality: Reality = {};
  for (const [id, t] of Object.entries(state.tickets)) {
    if (t.status === 'dropped' || (!t.branch && t.pr === null)) continue;
    const r: TicketReality = {};
    const errors: string[] = [];
    if (t.branch) {
      try {
        const head = await ctx.git.head(t.branch);
        r.branchHead = head;
        if (head) {
          r.branchTree = await ctx.git.tree(head);
          r.mergedIntoTarget = await ctx.git.isMerged(t.branch, state.target);
        }
      } catch (e) { errors.push(`git ${t.branch}: ${msg(e)}`); delete r.branchHead; delete r.branchTree; delete r.mergedIntoTarget; }
    }
    if (t.pr !== null) {
      try {
        const p = await ctx.forge.prState(t.pr);
        r.pr = { state: p.state === 'merged' ? 'MERGED' : p.state === 'closed' ? 'CLOSED' : 'OPEN', headRefOid: p.head || null, baseRefName: state.target };
        r.prTree = p.head ? await ctx.git.tree(p.head).catch(() => undefined) : undefined; // unreadable tree = UNKNOWN: the sha comparison stands
      } catch (e) { errors.push(`PR #${t.pr}: ${msg(e)}`); }
    }
    if (errors.length) r.error = errors.join('; ');
    reality[id] = r;
  }
  return reality;
}

export interface ReconcileOutcome {
  /** tickets whose merge happened outside the loop (or whose merge the loop made and a kill kept from recording): the state now says merged. */
  adopted: string[];
  /** parked by this step, with the reason. */
  parked: Array<{ ticket: string; cause: ParkCauseView; reason: string }>;
  /** tickets a parked upstream was holding that are free again because it was merged by hand. */
  released: string[];
  /** divergences this step reports and does not act on (state claims merged, reality does not; a PR head moved…). */
  diverged: Divergence[];
  unreadable: string[];
}

const TERMINAL = new Set(['merged', 'dropped']);

/** The park rules, one per divergence kind that leaves a ticket nobody can continue without a person: only these three. null = not a parking divergence. */
function parkReason(d: Divergence, t: TicketState): { cause: ParkCauseView; reason: string } | null {
  if (d.kind === 'pr-closed-unmerged') return { cause: 'situation', reason: `PR #${t.pr} was closed without merging` };
  // only a ticket that PUBLISHED something (a PR or a recorded head) loses work when its branch vanishes; a fresh one is merely not created yet (nothing is pushed before the CI wave: the port reads the refs the agent works on)
  if (d.kind === 'branch-gone' && (t.pr !== null || t.head)) return { cause: 'situation', reason: `branch ${t.branch} is gone: nothing to respawn an agent on` };
  if (d.kind === 'merged-at-ungated-head') return { cause: 'situation', reason: d.detail.split(': re-gate')[0].slice(0, 300) };
  return null;
}

/** Free the tickets a parked upstream held, once that upstream is MERGED (a parked ticket merged by hand — adoption beats parking). A dependent still held by ANOTHER parked upstream stays parked, re-pointed at it; one with no recorded blocker, or whose blocker is dropped, is never freed here (`stepEnd` owns those). Decided on the state as it was BEFORE any release, so the result does not depend on ticket order. */
export function releaseDependents(state: FanoutState, now: string): { state: FanoutState; released: string[] } {
  const heldBy = (t: TicketState): string | null => { const p = parkedOf(t); return isParked(t) && p?.cause === 'upstream' && p.blockedBy && state.tickets[p.blockedBy]?.status === 'merged' ? p.blockedBy : null; };
  const freeing = new Set(Object.entries(state.tickets).filter(([, t]) => heldBy(t)).map(([id]) => id));
  const tickets = { ...state.tickets };
  const released: string[] = [];
  for (const id of freeing) {
    const t = state.tickets[id];
    const stillParked = t.dependsOn.find((u) => isParked(state.tickets[u]) && !freeing.has(u));
    if (stillParked) { tickets[id] = { ...t, parked: { ...parkedOf(t)!, blockedBy: stillParked, reason: `blocked by ${stillParked}`, at: now }, updatedAt: now } as TicketState; continue; }
    const { parked: _gone, ...rest } = t as TicketState & { parked?: unknown };
    tickets[id] = { ...rest, status: t.branch || t.implementer ? 'started' : 'todo', updatedAt: now } as TicketState;
    released.push(id);
  }
  return { state: freeing.size ? { ...state, tickets, updatedAt: now } : state, released };
}

/** The write-backs reconcile may apply. For a PARKED ticket reconcile's rules are blind (its ancestry rule trusts any status but `started`, and the ungated-head check only reads `gated|merged`): a parked ticket is adopted only when its PR is MERGED on the target AND at the content the recorded head covers; every other write-back to it is dropped. */
export function writeBackFor(state: FanoutState, reality: Reality, wb: ReturnType<typeof reconcile>['writeBack']): ReturnType<typeof reconcile>['writeBack'] {
  const kept = wb.filter((w) => !isParked(state.tickets[w.ticket]));
  for (const [id, t] of Object.entries(state.tickets)) {
    const pr = reality[id]?.pr;
    if (!isParked(t) || !t.head || pr?.state !== 'MERGED' || pr.baseRefName !== state.target || !pr.headRefOid) continue;
    if (sameContent(pr.headRefOid, reality[id]?.prTree, t.head, t.tree)) kept.push({ ticket: id, patch: { status: 'merged' }, seen: t.updatedAt, why: 'a parked ticket merged by hand at the head it was recorded on' });
  }
  return kept;
}

/** The `reconcile` step. Reads git + the PR host once, then ONE atomic state update: write back what reality is ahead on (a hand merge), free what that hand merge releases, park what only a person could continue. Idempotent: a second call on the same world changes nothing (no timestamp churn — the state is written only when something changed). */
export async function stepReconcile(ctx: RelaunchCtx): Promise<ReconcileOutcome> {
  const state0 = ctx.state.read();
  const reality = await readReality(state0, ctx);
  const plan = reconcile(state0, reality);
  const writeBack = writeBackFor(state0, reality, plan.writeBack);
  const out: ReconcileOutcome = { adopted: [], parked: [], released: [], diverged: [], unreadable: [] };
  for (const d of plan.divergences) {
    if (d.kind === 'reality-unreadable') { out.unreadable.push(d.ticket); ctx.log(`reconcile: ${d.ticket}: ${d.detail}`); }
  }
  const toPark = plan.divergences.map((d) => ({ d, why: parkReason(d, state0.tickets[d.ticket]) })).filter((x): x is { d: Divergence; why: { cause: ParkCauseView; reason: string } } => x.why !== null && !isParked(state0.tickets[x.d.ticket]) && !TERMINAL.has(state0.tickets[x.d.ticket].status));
  if (!writeBack.length && !toPark.length) {
    out.diverged = plan.divergences.filter((d) => d.kind !== 'reality-unreadable' && !(parkReason(d, state0.tickets[d.ticket]) && isParked(state0.tickets[d.ticket])));
    for (const d of out.diverged) ctx.log(`reconcile: ${d.ticket}: ${d.kind}: ${d.detail}`);
    return out;
  }
  const after = ctx.state.update((cur) => {
    const before = cur;
    const now = ctx.now();
    let s = writeBack.length ? applyWriteBack(cur, writeBack, now) : cur;
    out.adopted = Object.keys(s.tickets).filter((id) => s.tickets[id].status === 'merged' && before.tickets[id].status !== 'merged');
    // a ticket merged by hand leaves `parked`: the merge is a fact, the park was a decision about a ticket that is now done
    s = { ...s, tickets: Object.fromEntries(Object.entries(s.tickets).map(([id, t]) => [id, out.adopted.includes(id) && isParked(before.tickets[id]) ? (({ parked: _p, ...rest }) => rest as TicketState)(t as TicketState & { parked?: unknown }) : t])) };
    const rel = releaseDependents(s, now);
    s = rel.state; out.released = rel.released;
    out.parked = [];
    for (const { d, why } of toPark) {
      const t = s.tickets[d.ticket];
      if (!t || TERMINAL.has(t.status) || isParked(t)) continue; // adopted or already parked meanwhile
      s = ctx.park(s, d.ticket, why, now);
      out.parked.push({ ticket: d.ticket, ...why });
    }
    return s;
  });
  out.diverged = plan.divergences.filter((d) => d.kind !== 'reality-unreadable' && !(parkReason(d, state0.tickets[d.ticket]) && isParked(after.tickets[d.ticket])) && !out.adopted.includes(d.ticket)); // a parking kind is handled once its ticket is parked; on a ticket recorded merged it stays visible
  for (const id of out.adopted) ctx.log(`reconcile: ${id}: merged outside the loop (or by the loop before a kill) — adopted`);
  for (const id of out.released) ctx.log(`reconcile: ${id}: its parked upstream was merged — released`);
  for (const p of out.parked) ctx.log(`reconcile: ${p.ticket}: parked [${p.cause}] ${p.reason}`);
  for (const d of out.diverged) ctx.log(`reconcile: ${d.ticket}: ${d.kind}: ${d.detail}`);
  return out;
}

export interface EndCtx { now: () => string; log: (line: string) => void; state: StatePort; park: ParkFn; costOf: (ticket: string) => Promise<TokenCost | null> }
export interface EndOutcome {
  /** true = the loop stops now: every ticket is merged / parked / dropped, or the run is paused. */
  done: boolean;
  /** the process exit code when `done` (frozen, #605): 0 · 3 · 4 · 1; null while the run goes on. */
  exit: 0 | 1 | 3 | 4 | null;
  report: Report | null;
}

/** A ticket waiting on a DROPPED upstream can never be ready (dropped is the human's word, not a merge): park it, so the run ends instead of looping on it forever. */
function parkBehindDropped(state: FanoutState, ctx: EndCtx): FanoutState {
  let s = state;
  for (const [id, t] of Object.entries(state.tickets)) {
    if (TERMINAL.has(t.status) || isParked(t)) continue;
    const dropped = t.dependsOn.find((u) => s.tickets[u]?.status === 'dropped');
    if (dropped && !isParked(s.tickets[id])) s = ctx.park(s, id, { cause: 'upstream', reason: `blocked by ${dropped} (dropped, never merged)` }, ctx.now());
  }
  return s;
}

/** The `end` step: is the run over? When it is, the report — built from the state and the transcripts' token counts, nothing else. */
export async function stepEnd(ctx: EndCtx): Promise<EndOutcome> {
  let state = ctx.state.read();
  const blocked = Object.entries(state.tickets).some(([, t]) => !TERMINAL.has(t.status) && !isParked(t) && t.dependsOn.some((u) => state.tickets[u]?.status === 'dropped'));
  if (blocked) state = ctx.state.update((cur) => parkBehindDropped(cur, ctx));
  const paused = (state as { pause?: unknown }).pause;
  const unfinished = Object.values(state.tickets).some((t) => !TERMINAL.has(t.status) && !isParked(t));
  if (!paused && unfinished) return { done: false, exit: null, report: null };
  const report = buildReport(state, await collectCosts(state, ctx.costOf));
  const exit = reportExit(report);
  ctx.log(`end: ${paused ? 'paused' : 'every ticket merged, parked or dropped'} → exit ${exit}`);
  return { done: true, exit, report };
}
