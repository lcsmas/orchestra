// #605 (spec #601, ledger #613) — the Boucle: `runLoop` leads a vague from its plan to its closing report through the shipped modules (start / review / record / deliver rules), under seatRecords=on, verifier=off.
// Disposable by design (decision 12): every pass re-reads the state, git and the forge; the only thing carried between passes is the stall clock. The #606 / #607 / #608 steps are stubs here (see `stepCorrections`, `stepCi`,
// `stepReconcile`): they fill their step, never reorder `LOOP_STEPS`.
import type { FleetPort, ForgePort, GitPort } from './fanout-loop-ports.ts';
import { applyPlan, parkTicket, pausedOf, parkedTickets, readLoopState, recordChoice, updateLoopState, withLoop, type LoopState, type Plan } from './fanout-loop-compat.ts';
import { buildReport, type Report } from './fanout-report.ts';
import { decideDelivery, decideUpstreams, type DeliverCheck, type UpstreamFacts } from './fanout-deliver.ts';
import { blockingMinors, applyTicketPatch, FanoutStateError, newState, planMissing, SeatRefusal, unmergedUpstreams } from './fanout-state.ts';
import { recordedVerdictOf, reviewOn } from './fanout-record.ts';

export const LOOP_STEPS = ['reconcile', 'plan', 'start', 'mail', 'nominations', 'open', 'review', 'approvals', 'connect', 'ci', 'corrections', 'deliver', 'end'] as const;
export type LoopStep = (typeof LOOP_STEPS)[number];

/** Decision 5: the constant answer to a question; the agent's own pick goes in its PR body. */
export const FIXED_ANSWER = 'Take the reversible option, record it under `## Choices` in your PR body, continue. Do not wait for anyone.';
/** Decision 5: an `ask` whose FIRST line starts with this declares "no safe option" (contradictory spec, irreversible act): the ticket is parked. */
export const NO_SAFE_OPTION = 'NO SAFE OPTION: ';

export interface LoopOptions {
  /** The plan to apply when the state holds none (#604's file, or the dummy scenario's). null = the state must already hold a complete plan. */
  plan: Plan | null;
  tickets: string[] | null;
  target: string;
  repo: string | null;
  startCheck: boolean;
  minorPolicy: 'legacy' | 'refuse' | 'spec' | 'demonstrated';
  pollMs: number;
  /** No progress for this long ⇒ every unfinished ticket is parked (cause `situation`) and the run ends: the loop never waits for a person (decision 11). */
  stallMs: number;
  maxPasses: number;
}
export const DEFAULT_OPTIONS: LoopOptions = { plan: null, tickets: null, target: 'main', repo: null, startCheck: false, minorPolicy: 'demonstrated', pollMs: 60_000, stallMs: 4 * 3_600_000, maxPasses: 100_000 };

export interface LoopDeps {
  home: string;
  run: string;
  caller: string;
  fleet: FleetPort;
  forge: ForgePort;
  git: GitPort;
  now(): string;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  options: LoopOptions;
}
export interface LoopResult { exit: 0 | 2 | 3 | 4; report: Report; passes: number; reason?: string }

export class LoopRefusal extends SeatRefusal {}

export interface Approval { head: string; at: string; round: number }
export interface LoopCtx {
  deps: LoopDeps;
  run: string;
  pass: number;
  /** tickets whose implementer said it nominated (status / worker_done mail read THIS pass) */
  signals: Set<string>;
  /** ticket → the recorded approval on its CURRENT head (0 BLOCKING, 0 MAJOR open) */
  approved: Map<string, Approval>;
  progress: string[];
  finished: boolean;
  /** log a line once per distinct text (a log filter, not state: a restart merely logs it again) */
  note(line: string): void;
  st(): LoopState;
  update(fn: (s: LoopState) => LoopState): LoopState;
  did(msg: string): void;
}

const sameSha = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);
const ms = (iso: string): number => Date.parse(iso);

export const isMerged = (s: LoopState, id: string): boolean => s.tickets[id]?.status === 'merged';
export const isParked = (s: LoopState, id: string): boolean => !!s.loop.parked[id];
/** Plan tickets still to deliver: not merged, not dropped, not parked. */
export const activeTickets = (s: LoopState): string[] => (s.plan?.tickets ?? []).filter((id) => { const t = s.tickets[id]; return !!t && t.status !== 'merged' && t.status !== 'dropped' && !isParked(s, id); });
const implementerTicket = (s: LoopState, ws: string): string | null => Object.entries(s.tickets).find(([, t]) => t.implementer === ws)?.[0] ?? null;

export function renderConnectAsk(i: { ticket: string; upstream: string; branch: string | null; head: string }): string {
  return [
    `CONNECT ${i.upstream} ${i.head}`,
    `${i.ticket}: your upstream ${i.upstream}${i.branch ? ` (branch ${i.branch})` : ''} was approved at ${i.head}. Connect once: merge it into your branch with a MERGE COMMIT (git merge --no-ff ${i.head} — never rebase, never squash),`,
    'rebuild on its real names, push, then send a status. Keep going on your own ticket meanwhile; do not wait for anything else.',
  ].join('\n');
}

// ── steps ────────────────────────────────────────────────────────────────────────────────────────────────────
/** #608 fills this (git + the forge overrule the state at each start: a merge made by hand is adopted). */
export async function stepReconcile(_ctx: LoopCtx): Promise<void> { /* #608 */ }
/** #607 fills this: the start check (an empty PR, its checks awaited, closed). A red check there = the run does not start. */
export async function stepStartCheck(_ctx: LoopCtx): Promise<void> { /* #607 */ }
/** #607 fills this: the red-CI rules (one re-run, the check name + log extract to the author, the pause on the same check red on several PRs). */
export async function stepCi(_ctx: LoopCtx): Promise<void> { /* #607 */ }
/** #606 fills this: findings in ONE batch to the same author, the same reviewer reads the fix, the same situation twice parks. */
export async function stepCorrections(_ctx: LoopCtx): Promise<void> { /* #606 */ }

/** The state exists with its switches, the plan is declared and complete. */
export async function stepPlan(ctx: LoopCtx): Promise<void> {
  const { deps } = ctx;
  const o = deps.options;
  let s = readLoopState(deps.home, deps.run);
  if (!s) {
    s = updateLoopState(deps.home, deps.run, (cur) => cur ?? withLoop(newState(deps.run, { target: o.target, repo: o.repo, switches: { seatRecords: 'on', minorPolicy: o.minorPolicy, verifier: 'off' }, now: deps.now() })));
    ctx.did('state initialised (seatRecords=on)');
  }
  if (s.plan && planMissing(s).length === 0) return;
  if (!o.plan) throw new LoopRefusal('run-plan-needed', `run ${deps.run} has no complete plan${s.plan ? `: ${planMissing(s).join('; ')}` : ''} — pass --plan <plan.json> (#604's file)`);
  const plan = o.plan;
  updateLoopState(deps.home, deps.run, (cur) => ({ ...withLoop(applyPlan(cur!, plan, deps.now()), cur!.loop) }));
  ctx.did(`plan applied: ${plan.tickets.map((t) => t.id).join(', ')}`);
  const after = ctx.st();
  if (planMissing(after).length) throw new LoopRefusal('run-plan-incomplete', `the plan is incomplete: ${planMissing(after).join('; ')}`);
}

/** Decision 3: every implementer starts at once, on the frozen names. A start held by Admission is a wait, never a fault. */
export async function stepStart(ctx: LoopCtx): Promise<void> {
  const { deps } = ctx;
  const s = ctx.st();
  const need = activeTickets(s).filter((id) => { const t = s.tickets[id]; return (t.status === 'todo' || t.status === 'started') && (!t.implementer || !deps.fleet.live(t.implementer)); });
  if (!need.length) return;
  if (deps.options.startCheck && !Object.values(s.tickets).some((t) => t.start)) await stepStartCheck(ctx);
  const r = await deps.fleet.start();
  for (const x of r.started) ctx.did(`started ${x.ticket} (${x.ws})`);
  for (const x of r.respawned) ctx.did(`restarted ${x.ticket} (${x.ws})`);
  for (const x of r.waiting) ctx.note(`waiting: ${x.ticket} — ${x.why}`);
  for (const x of r.failed) ctx.note(`could not start ${x.ticket}: ${x.error} (tried again next pass)`);
}

/** The loop is the ONLY reader of the run's mail (one `fleet.mail()` per pass). */
export async function stepMail(ctx: LoopCtx): Promise<void> {
  const { deps } = ctx;
  const mails = [...(await deps.fleet.mail())].sort((a, b) => a.seq - b.seq);
  for (const m of mails) {
    const s = ctx.st();
    const ticket = m.ticket ?? implementerTicket(s, m.sender);
    if (m.kind === 'ask') {
      const first = m.body.split('\n')[0];
      if (first.startsWith(NO_SAFE_OPTION)) {
        const reason = first.slice(NO_SAFE_OPTION.length).trim() || '(no reason given)';
        if (ticket && s.tickets[ticket] && !isMerged(s, ticket)) {
          ctx.update((x) => recordChoice(parkTicket(x, ticket, { cause: 'question', reason }, deps.now()), { ticket, question: reason, rule: 'no-safe-option', answer: 'parked' }, deps.now()));
          ctx.did(`parked ${ticket}: no safe option — ${reason}`);
        }
      } else {
        await deps.fleet.send(m.sender, FIXED_ANSWER, 'answer');
        ctx.update((x) => recordChoice(x, { ticket: ticket ?? m.sender, question: first, rule: 'reversible-default', answer: FIXED_ANSWER }, deps.now()));
        ctx.did(`answered ${ticket ?? m.sender}'s question with the fixed answer`);
      }
    } else if ((m.kind === 'status' || m.kind === 'worker_done') && ticket && s.tickets[ticket]?.implementer === m.sender) {
      ctx.signals.add(ticket);
    }
  }
}

/** A head enters the state only when the implementer SIGNALLED it and git shows it (git is read, the message is not trusted). A dependent is `nominated` only once it is connected to every unmerged upstream (the state's early-gate rule:
 *  `builtOn` = the upstream head it was asked to connect to, contained in its own head) — until then it stays `started` with its head recorded, and its PR waits for the connection. */
export async function stepNominations(ctx: LoopCtx): Promise<void> {
  const { deps } = ctx;
  for (const id of activeTickets(ctx.st())) {
    const s = ctx.st();
    const t = s.tickets[id];
    if (!t.branch) continue;
    let head = t.head;
    if (ctx.signals.has(id)) { const h = await deps.git.head(t.branch); if (h) head = h; }
    if (!head) continue;
    const builtOn = { ...t.builtOn };
    const builtOnTree = { ...t.builtOnTree };
    let connected = false;
    for (const [up, asked] of Object.entries(s.loop.asked[id] ?? {})) {
      if (builtOn[up] && sameSha(builtOn[up], asked)) continue;
      if (!(await deps.git.isMerged(asked, head))) continue;
      builtOn[up] = asked;
      const tr = await deps.git.tree(asked);
      if (tr) builtOnTree[up] = tr; else delete builtOnTree[up];
      connected = true;
    }
    const headChanged = !t.head || !sameSha(head, t.head);
    const admissible = unmergedUpstreams(s, id).every((u) => builtOn[u]);
    const toNominated = admissible && t.status === 'started';
    if (!headChanged && !connected && !toNominated) continue;
    const tree = headChanged ? await deps.git.tree(head) : t.tree;
    const patch = (status: string): Record<string, unknown> => ({ head, ...(connected ? { builtOn } : {}), status });
    const derived = { tree, ...(connected ? { builtOnTree } : {}) };
    try {
      ctx.update((x) => withLoop(applyTicketPatch(x, id, patch(admissible && (t.status === 'started' || t.status === 'nominated') ? 'nominated' : t.status), deps.now(), derived), x.loop));
    } catch (e) {
      if (!(e instanceof FanoutStateError) || t.status !== 'nominated') throw e;
      ctx.update((x) => withLoop(applyTicketPatch(x, id, patch('started'), deps.now(), derived), x.loop)); // the upstream moved under it: back to started until it is connected again
    }
    if (headChanged) ctx.did(`${id} ${admissible ? 'nominated' : 'has a head'} at ${head.slice(0, 12)}`);
    if (connected) ctx.did(`${id} is connected to ${Object.keys(s.loop.asked[id] ?? {}).filter((u) => builtOn[u]).join(', ')}`);
  }
}

/** One PR per ticket (idempotent per branch). */
export async function stepOpen(ctx: LoopCtx): Promise<void> {
  const { deps } = ctx;
  for (const id of activeTickets(ctx.st())) {
    const t = ctx.st().tickets[id];
    if ((t.status !== 'nominated' && t.status !== 'gated') || !t.head || !t.branch || t.pr) continue;
    const { n } = await deps.forge.openPr({ branch: t.branch, base: ctx.st().target, title: `${id}${t.spec ? `: ${t.spec}` : ''}`.slice(0, 120) });
    ctx.update((x) => withLoop(applyTicketPatch(x, id, { pr: n }, deps.now()), x.loop));
    ctx.did(`opened PR #${n} for ${id}`);
  }
}

/** The ticket's reviewer reads its current head: spawned once, woken on a new head, never twice on the same one. */
export async function stepReview(ctx: LoopCtx): Promise<void> {
  const { deps } = ctx;
  for (const id of activeTickets(ctx.st())) {
    const t = ctx.st().tickets[id];
    if (!t.pr || !t.head) continue;
    if (reviewOn(t, t.head, t.tree)) continue; // a verdict on this content is recorded
    const last = t.review?.briefs[t.review.briefs.length - 1];
    if (last && sameSha(last.head, t.head)) continue; // briefed on this head: the reviewer owes its record
    const r = await deps.fleet.spawnReviewer(id, t.head);
    ctx.did(`reviewer ${r.id} reads ${id} at ${t.head.slice(0, 12)}`);
  }
}

/** Approved = a RECORDED approve on the current content with nothing blocking left open. The loop never types a verdict. */
export async function stepApprovals(ctx: LoopCtx): Promise<void> {
  ctx.approved.clear();
  const s = ctx.st();
  for (const id of activeTickets(s)) {
    const t = s.tickets[id];
    if (!t.head) continue;
    const r = recordedVerdictOf(s, id, t.head, t.tree);
    if (!r.ok || r.recorded.verdict !== 'approve' || r.recorded.blocking > 0 || r.recorded.major > 0) continue;
    if (blockingMinors(s, id).length) continue;
    const entry = reviewOn(t, t.head, t.tree);
    if (entry) ctx.approved.set(id, { head: t.head, at: entry.at, round: r.recorded.round });
  }
}

/** Decision 4: a dependent is asked to connect to its upstream when the upstream's reviewer approved it — not at nomination, not at merge. Once per (dependent, upstream, head); a changed upstream asks again. */
export async function stepConnect(ctx: LoopCtx): Promise<void> {
  const { deps } = ctx;
  for (const id of activeTickets(ctx.st())) {
    const s = ctx.st();
    const t = s.tickets[id];
    if (!t.implementer || !deps.fleet.live(t.implementer)) continue;
    for (const up of t.dependsOn) {
      const u = s.tickets[up];
      const a = ctx.approved.get(up);
      if (!u || isMerged(s, up) || !a) continue;
      const asked = s.loop.asked[id]?.[up];
      if (asked && sameSha(asked, a.head)) continue;
      if (t.builtOn[up] && sameSha(t.builtOn[up], a.head)) continue;
      await deps.fleet.wake(t.implementer, renderConnectAsk({ ticket: id, upstream: up, branch: u.branch, head: a.head }));
      ctx.update((x) => ({ ...x, loop: { ...x.loop, asked: { ...x.loop.asked, [id]: { ...(x.loop.asked[id] ?? {}), [up]: a.head } } } }));
      ctx.did(`asked ${id} to connect to ${up} at ${a.head.slice(0, 12)}`);
    }
  }
}

interface Ready { id: string; readyAt: number; order: number; head: string; pr: number }
/** Decision 10: recorded approval on the head + green CI on the head + upstreams merged — merged in READINESS order (the moment the last condition held), never declaration order. */
export async function stepDeliver(ctx: LoopCtx): Promise<void> {
  const { deps } = ctx;
  const s0 = ctx.st();
  const ready: Ready[] = [];
  const plan = s0.plan?.tickets ?? [];
  for (const id of activeTickets(s0)) {
    const t = s0.tickets[id];
    const a = ctx.approved.get(id);
    if (!a || !t.pr || !t.head) continue;
    if (t.dependsOn.some((u) => !isMerged(s0, u))) continue; // an unmerged upstream: never first
    const pr = await deps.forge.prState(t.pr);
    if (pr.state === 'closed') continue;
    if (pr.state === 'merged') { // merged by hand: git and the forge overrule the state (#608 does the general case)
      ctx.update((x) => withLoop(applyTicketPatch(x, id, { status: 'merged' }, deps.now()), x.loop));
      ctx.did(`${id} was already merged on the forge: adopted`);
      continue;
    }
    // upstreams: merged on the forge at the head this ticket was built on, and this head sits on it
    const facts: UpstreamFacts[] = [];
    for (const up of t.dependsOn) {
      const u = s0.tickets[up];
      const upPr = u.pr ? await deps.forge.prState(u.pr) : null;
      const builtOn = t.builtOn[up] ?? null;
      facts.push({
        id: up, accepted: !!u.mergedAccepted, builtOn,
        pr: upPr ? { state: upPr.state === 'merged' ? 'MERGED' : upPr.state === 'closed' ? 'CLOSED' : 'OPEN', baseRefName: s0.target, headRefOid: upPr.head, mergeCommit: null } : null,
        sameTree: null,
        dependentOnBuiltOn: builtOn ? await deps.git.isMerged(builtOn, t.head) : upPr ? await deps.git.isMerged(upPr.head, t.head) : null,
        dependentOnMerge: null,
      });
    }
    const upDecision = decideUpstreams(facts.map((f) => (f.builtOn === null ? { ...f, builtOn: f.pr?.headRefOid ?? null } : f)), s0.target); // never connected: it must at least contain the merged head
    if (!upDecision.ok) { ctx.note(`${id}: not deliverable — ${upDecision.reason}: ${upDecision.detail}`); continue; }
    const checks = await deps.forge.checks(t.pr, t.head);
    const dc: DeliverCheck[] = checks.map((c) => ({ name: c.name, state: c.status === 'green' ? 'success' : c.status === 'red' ? 'failure' : 'pending', steps: 1 }));
    const verdict = recordedVerdictOf(s0, id, t.head, t.tree);
    const rec = verdict.ok ? verdict.recorded : null;
    const dec = decideDelivery({
      pr: { state: 'OPEN', baseRefName: s0.target, headRefOid: pr.head, mergeable: 'MERGEABLE' }, checks: dc, into: s0.target, verifiedHead: t.head,
      verdict: rec ? { round: rec.round, blocking: rec.blocking, major: rec.major, minor: rec.minor, head: rec.head } : undefined,
      waitedMs: 0, noChecksGraceMs: Number.MAX_SAFE_INTEGER, stable: true,
    });
    if (dec.action !== 'merge') { if (dec.action === 'refuse') ctx.note(`${id}: not deliverable — ${dec.reason}: ${dec.detail}`); continue; }
    const upMergedAt = Math.max(0, ...t.dependsOn.map((u) => ms(s0.tickets[u].updatedAt)));
    const checkAt = Math.max(0, ...checks.map((c) => (c.at ? ms(c.at) : 0)));
    ready.push({ id, readyAt: Math.max(ms(a.at), checkAt, upMergedAt), order: plan.indexOf(id), head: dec.head, pr: t.pr });
  }
  ready.sort((x, y) => x.readyAt - y.readyAt || x.order - y.order);
  for (const r of ready) {
    const res = await deps.forge.merge(r.pr, r.head);
    if (!res.ok) { deps.log(`${r.id}: merge refused by the forge — ${res.reason ?? 'unknown'}`); continue; }
    ctx.update((x) => withLoop(applyTicketPatch(x, r.id, { status: 'merged' }, deps.now()), x.loop));
    ctx.did(`merged ${r.id} (PR #${r.pr})`);
  }
}

/** The run is finished when every plan ticket is merged, dropped or parked (a parked ticket parks its dependents). */
export async function stepEnd(ctx: LoopCtx): Promise<void> {
  const s = ctx.st();
  ctx.finished = activeTickets(s).length === 0;
}

const STEPS: Record<LoopStep, (ctx: LoopCtx) => Promise<void>> = {
  reconcile: stepReconcile, plan: stepPlan, start: stepStart, mail: stepMail, nominations: stepNominations, open: stepOpen, review: stepReview,
  approvals: stepApprovals, connect: stepConnect, ci: stepCi, corrections: stepCorrections, deliver: stepDeliver, end: stepEnd,
};

function newCtx(deps: LoopDeps, pass: number, seen: Set<string>): LoopCtx {
  const ctx: LoopCtx = {
    note: (line) => { if (!seen.has(line)) { seen.add(line); deps.log(`[pass ${pass}] ${line}`); } },
    deps, run: deps.run, pass, signals: new Set(), approved: new Map(), progress: [], finished: false,
    st: () => { const s = readLoopState(deps.home, deps.run); if (!s) throw new LoopRefusal('run-no-state', `no state for run ${deps.run}`); return s; },
    update: (fn) => updateLoopState(deps.home, deps.run, (cur) => fn(cur!)),
    did: (msg) => { ctx.progress.push(msg); deps.log(`[pass ${pass}] ${msg}`); },
  };
  return ctx;
}

export async function runLoop(deps: LoopDeps): Promise<LoopResult> {
  let lastProgress = ms(deps.now());
  let passes = 0;
  const seen = new Set<string>();
  const finish = (exit: LoopResult['exit'], reason?: string): LoopResult => {
    const s = readLoopState(deps.home, deps.run);
    return { exit, report: s ? buildReport(s, deps) : buildReport(withLoop({ version: 1, run: deps.run, target: deps.options.target, repo: null, tickets: {}, updatedAt: deps.now(), reconciledAt: null }), deps), passes, ...(reason ? { reason } : {}) };
  };
  for (;;) {
    passes++;
    const ctx = newCtx(deps, passes, seen);
    try {
      for (const step of LOOP_STEPS) await STEPS[step](ctx);
    } catch (e) {
      if (e instanceof SeatRefusal) { deps.log(`refused ${e.message}`); return finish(2, e.message); }
      throw e;
    }
    if (ctx.progress.length) lastProgress = ms(deps.now());
    const s = ctx.st();
    if (pausedOf(s)) return finish(4, `paused: ${pausedOf(s)!.reason}`);
    if (ctx.finished) return finish(parkedTickets(s).length ? 3 : 0);
    const stalled = ms(deps.now()) - lastProgress > deps.options.stallMs;
    if (stalled || passes >= deps.options.maxPasses) {
      const reason = stalled ? `no progress for ${Math.round(deps.options.stallMs / 60_000)} min` : `pass limit ${deps.options.maxPasses}`;
      for (const id of activeTickets(s)) ctx.update((x) => (isParked(x, id) ? x : parkTicket(x, id, { cause: 'situation', reason }, deps.now())));
      deps.log(`ending: ${reason}; the unfinished tickets are parked`);
      return finish(3, reason);
    }
    await deps.sleep(deps.options.pollMs);
  }
}
