// #605 (spec #601, ledger #613) — the Boucle: `runLoop` leads a vague from its plan to its closing report through the shipped modules (start / review / record / deliver rules), under seatRecords=on, verifier=off.
// Disposable by design (decision 12): every pass re-reads the state, git and the forge; the only thing carried between passes is the stall clock. The #606 / #607 / #608 steps are stubs here (see `stepCorrections`, `stepCi`,
// `stepReconcile`): they fill their step, never reorder `LOOP_STEPS`.
import type { FleetPort, ForgePort, GitPort } from './fanout-loop-ports.ts';
import { applyPlan, parkTicket, pausedOf, parkedTickets, readLoopState, recordChoice, updateLoopState, withLoop, type LoopState, type Plan } from './fanout-loop-compat.ts';
import { buildReport, type Report } from './fanout-report.ts';
import { decideDelivery, decideUpstreams, type DeliverCheck, type UpstreamFacts } from './fanout-deliver.ts';
import { blockingMinors, applyTicketPatch, FanoutStateError, newState, planMissing, SeatRefusal, unmergedUpstreams, upstreamBlocker } from './fanout-state.ts';
import { recordedVerdictOf, reviewOn } from './fanout-record.ts';

export const LOOP_STEPS = ['reconcile', 'plan', 'start', 'mail', 'nominations', 'open', 'review', 'approvals', 'connect', 'ci', 'corrections', 'deliver', 'end'] as const;
export type LoopStep = (typeof LOOP_STEPS)[number];

/** Decision 5: the constant answer to a question; the agent's own pick goes in its PR body. */
export const FIXED_ANSWER = 'Take the reversible option, record it under `## Choices` in your PR body, continue. Do not wait for anyone.';
/** Decision 5: an `ask` whose FIRST line starts with this declares "no safe option" (contradictory spec, irreversible act): the ticket is parked. */
export const NO_SAFE_OPTION = 'NO SAFE OPTION: ';
/** An agent's ask is cut to this many chars before it is listed under `choices` (the state refuses longer). */
export const ASK_MAX = 2000;

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
  /** check names that must exist on a head before it can merge (decideDelivery's `requiredChecks`); absent = none declared */
  requiredChecks?: string[];
  /** how long an Admission hold may stay unreleased before it stops counting as a wait (default 12 h) */
  holdMs?: number;
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
/** A process death (a test's seam): never swallowed by `ctx.guard`. */
export class LoopKilled extends Error {}

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
  /** work is under way that the loop cannot see as a state change (a held start, a CI running, a reviewer reading): it counts as progress for the stall clock */
  busy: boolean;
  /** a BOUNDED wait: true (and the stall clock is fed) while `key` has been waited on for less than `boundMs`; false once it ran out — then the ticket is stalled for real. */
  waitOn(key: string, boundMs: number): boolean;
  /** run one ticket's (or one message's) share of a step: a thrown PORT error is logged and retried next pass — it never ends the run (a refusal or a kill does) */
  guard(label: string, fn: () => Promise<void>): Promise<boolean>;
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
  const heldNow = activeTickets(s).filter((id) => s.loop.held[id] && !s.tickets[id].head);
  const holdMs = deps.options.holdMs ?? 12 * 3_600_000;
  for (const id of heldNow) ctx.waitOn(`held:${id}`, holdMs); // an Admission hold reported earlier, not released yet: a wait, not a stall — for `holdMs`
  if (Object.keys(s.loop.held).some((id) => !heldNow.includes(id))) ctx.update((x) => ({ ...x, loop: { ...x.loop, held: Object.fromEntries(Object.entries(x.loop.held).filter(([id]) => heldNow.includes(id))) } }));
  const need = activeTickets(s).filter((id) => { const t = s.tickets[id]; return (t.status === 'todo' || t.status === 'started') && (!t.implementer || !deps.fleet.live(t.implementer)); });
  if (!need.length) return;
  if (deps.options.startCheck && !Object.values(s.tickets).some((t) => t.start)) await stepStartCheck(ctx);
  const r = await deps.fleet.start();
  for (const x of r.started) ctx.did(`started ${x.ticket} (${x.ws})`);
  for (const x of r.respawned) ctx.did(`restarted ${x.ticket} (${x.ws})`);
  if (r.waiting.length) ctx.update((y) => ({ ...y, loop: { ...y.loop, held: { ...y.loop.held, ...Object.fromEntries(r.waiting.map((x) => [x.ticket, true as const])) } } }));
  for (const x of r.waiting) { ctx.waitOn(`held:${x.ticket}`, holdMs); ctx.note(`waiting: ${x.ticket} — ${x.why}`); } // an Admission hold is a wait, not a fault, and not a stall
  for (const x of r.failed) ctx.note(`could not start ${x.ticket}: ${x.error} (tried again next pass)`);
}

/** Decision 5, fail CLOSED: the marker opening ANY line of the body (any case, spacing or punctuation) parks; only a body without it is a question that gets the fixed answer. */
export function parseNoSafeOption(body: string): { reason: string } | null {
  const m = /^[ \t\W_]*no[ \t_-]*safe[ \t_-]*option\b/im.exec(body); // the marker OPENS a line (any case/spacing/punctuation): a question that merely contains the words ("is there no safe option name collision?") stays a question
  if (!m) return null;
  const rest = body.slice(m.index + m[0].length).replace(/^[\s:.\-–—]+/, '').trim();
  return { reason: rest.split('\n')[0].slice(0, 300) || '(no reason given)' };
}

/** The loop is the ONLY reader of the run's mail (one `fleet.mail()` per pass). The mail is acked only AFTER its batch is processed, and each message is handled idempotently (`loop.handled`): a kill mid-batch loses nothing — the
 *  question's choice is written BEFORE its answer is sent (`listed` → send → `done`), so a restart answers it once more (harmless: a constant) and lists it once. */
export async function stepMail(ctx: LoopCtx): Promise<void> {
  const { deps } = ctx;
  const mails = [...(await deps.fleet.mail())].sort((a, b) => a.seq - b.seq);
  const failed: number[] = [];
  const markDone = (seq: number): void => { ctx.update((x) => ({ ...x, loop: { ...x.loop, handled: { ...x.loop.handled, [seq]: 'done' as const } } })); };
  for (const m of mails) {
    const ok = await ctx.guard(`mail #${m.seq}`, async () => {
      const s = ctx.st();
      const h = s.loop.handled[m.seq];
      if (h === 'done') return;
      const ticket = m.ticket ?? implementerTicket(s, m.sender);
      if (m.kind === 'ask') {
        const nso = parseNoSafeOption(m.body);
        if (nso) {
          if (ticket && s.tickets[ticket] && !isMerged(s, ticket)) {
            ctx.update((x) => { const y = recordChoice(parkTicket(x, ticket, { cause: 'question', reason: nso.reason }, deps.now()), { ticket, question: nso.reason, rule: 'no-safe-option', answer: 'parked' }, deps.now()); return { ...y, loop: { ...y.loop, handled: { ...y.loop.handled, [m.seq]: 'done' as const } } }; });
            ctx.did(`parked ${ticket}: no safe option — ${nso.reason}`);
          } else markDone(m.seq);
          return;
        }
        const first = m.body.split('\n')[0].slice(0, ASK_MAX); // `recordChoice` refuses longer text ([choice-bad]); the full text stays in the agent's PR body
        if (!h) ctx.update((x) => { const y = recordChoice(x, { ticket: ticket ?? m.sender, question: first, rule: 'reversible-default', answer: FIXED_ANSWER }, deps.now()); return { ...y, loop: { ...y.loop, handled: { ...y.loop.handled, [m.seq]: 'listed' as const } } }; });
        await deps.fleet.send(m.sender, FIXED_ANSWER, 'answer');
        markDone(m.seq);
        ctx.did(`answered ${ticket ?? m.sender}'s question with the fixed answer`);
      } else if ((m.kind === 'status' || m.kind === 'worker_done') && ticket && s.tickets[ticket]?.implementer === m.sender) {
        ctx.signals.add(ticket);
        ctx.update((x) => ({ ...x, loop: { ...x.loop, signalled: { ...x.loop.signalled, [ticket]: true as const }, handled: { ...x.loop.handled, [m.seq]: 'done' as const } } })); // durable before the ack: the mail is gone once acked
      } else markDone(m.seq);
    });
    if (!ok) failed.push(m.seq);
  }
  if (!mails.length) return;
  const ackTo = failed.length ? Math.min(...failed) - 1 : mails[mails.length - 1].seq; // never past a message that is not handled yet
  if (ackTo < mails[0].seq) return;
  const acked = await ctx.guard('ack', async () => { await deps.fleet.ack(ackTo); });
  if (acked) ctx.update((x) => ({ ...x, loop: { ...x.loop, handled: Object.fromEntries(Object.entries(x.loop.handled).filter(([k]) => Number(k) > ackTo)) } }));
}

/** A head enters the state only when the implementer SIGNALLED it and git shows it (git is read, the message is not trusted). A dependent is `nominated` only once it is connected to every unmerged upstream (the state's early-gate rule:
 *  `builtOn` = the upstream head it was asked to connect to, contained in its own head) — until then it stays `started` with its head recorded, and its PR waits for the connection. */
export async function stepNominations(ctx: LoopCtx): Promise<void> {
  const { deps } = ctx;
  for (const id of activeTickets(ctx.st())) await ctx.guard(`${id} nominations`, async () => {
    const s = ctx.st();
    const t = s.tickets[id];
    if (!t.branch) return;
    let head = t.head;
    let read = false; // a signalled ticket whose head git showed: its signal is spent when this iteration ends
    if (ctx.signals.has(id) || s.loop.signalled[id]) { const h = await deps.git.head(t.branch); if (h) { head = h; read = true; } }
    const spend = (): void => { if (read) ctx.update((x) => { const { [id]: _g, ...rest } = x.loop.signalled; return { ...x, loop: { ...x.loop, signalled: rest } }; }); };
    if (!head) return;
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
    // the state's early-gate rule decides: nominated needs, for every unmerged upstream, a candidate (nominated|gated) whose CURRENT content is what `builtOn` says this head was built on
    const view: LoopState = { ...s, tickets: { ...s.tickets, [id]: { ...t, head, builtOn, builtOnTree } } };
    const clear = unmergedUpstreams(s, id).every((u) => upstreamBlocker(view, view.tickets[id], u) === null);
    const want = clear ? (t.status === 'started' || t.status === 'nominated' ? 'nominated' : t.status) : (t.status === 'nominated' || t.status === 'gated' ? 'started' : t.status); // an upstream that moved under a nominated dependent: back to started until it is connected again
    if (!headChanged && !connected && want === t.status) { spend(); return; }
    const tree = headChanged ? await deps.git.tree(head) : t.tree;
    const patch = (status: string): Record<string, unknown> => ({ head, ...(connected ? { builtOn } : {}), status });
    const derived = { tree, ...(connected ? { builtOnTree } : {}) };
    try {
      ctx.update((x) => withLoop(applyTicketPatch(x, id, patch(want), deps.now(), derived), x.loop));
    } catch (e) {
      if (!(e instanceof FanoutStateError)) throw e;
      // the state refuses this nomination (e.g. `--follows` not recorded): the head is kept, the ticket stays as it was, the author is told what to fix — one ticket's omission never ends the run
      ctx.note(`${id}: cannot be ${want} yet — ${e.message}`);
      ctx.update((x) => withLoop(applyTicketPatch(x, id, { head, ...(connected ? { builtOn } : {}), status: t.status === 'nominated' || t.status === 'gated' ? 'started' : t.status }, deps.now(), derived), x.loop));
      if ((headChanged || connected) && t.implementer && deps.fleet.live(t.implementer)) await deps.fleet.send(t.implementer, `orchestra could not nominate ${id}: ${e.message}`, 'status');
    }
    spend();
    if (headChanged) ctx.did(`${id} ${want === 'nominated' ? 'nominated' : 'has a head'} at ${head.slice(0, 12)}`);
    if (connected) ctx.did(`${id} is connected to ${Object.keys(s.loop.asked[id] ?? {}).filter((u) => builtOn[u]).join(', ')}`);
  });
}

/** One PR per ticket (idempotent per branch). */
export async function stepOpen(ctx: LoopCtx): Promise<void> {
  const { deps } = ctx;
  for (const id of activeTickets(ctx.st())) await ctx.guard(`${id} open`, async () => {
    const t = ctx.st().tickets[id];
    if ((t.status !== 'nominated' && t.status !== 'gated') || !t.head || !t.branch || t.pr) return;
    const { n } = await deps.forge.openPr({ branch: t.branch, base: ctx.st().target, title: `${id}${t.spec ? `: ${t.spec}` : ''}`.slice(0, 120) });
    ctx.update((x) => withLoop(applyTicketPatch(x, id, { pr: n }, deps.now()), x.loop));
    ctx.did(`opened PR #${n} for ${id}`);
  });
}

/** The ticket's reviewer reads its current head: spawned once, woken on a new head, never twice on the same one. */
export async function stepReview(ctx: LoopCtx): Promise<void> {
  const { deps } = ctx;
  for (const id of activeTickets(ctx.st())) await ctx.guard(`${id} review`, async () => {
    const t = ctx.st().tickets[id];
    if (!t.pr || !t.head) return;
    if (reviewOn(t, t.head, t.tree)) return; // a verdict on this content is recorded
    const last = t.review?.briefs[t.review.briefs.length - 1];
    const rv = t.review?.reviewer?.id;
    if (last && sameSha(last.head, t.head) && (!rv || deps.fleet.live(rv))) { ctx.waitOn(`review:${id}:${t.head}`, deps.options.stallMs); return; } // briefed on this head and the reviewer is alive: it owes its record (bounded); a DEAD reviewer is replaced below
    const r = await deps.fleet.spawnReviewer(id, t.head);
    ctx.did(`reviewer ${r.id} reads ${id} at ${t.head.slice(0, 12)}`);
  });
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
  for (const id of activeTickets(ctx.st())) await ctx.guard(`${id} connect`, async () => {
    const s = ctx.st();
    const t = s.tickets[id];
    if (!t.implementer || !deps.fleet.live(t.implementer)) return;
    for (const up of t.dependsOn) {
      const u = s.tickets[up];
      const a = ctx.approved.get(up);
      if (!u || isMerged(s, up) || !a) continue;
      const asked = s.loop.asked[id]?.[up];
      if (asked && sameSha(asked, a.head) && s.loop.askedTo[id]?.[up] === t.implementer) continue; // once per (dependent, upstream, head, AUTHOR): a respawned author is asked again
      if (t.builtOn[up] && sameSha(t.builtOn[up], a.head)) continue;
      await deps.fleet.wake(t.implementer, renderConnectAsk({ ticket: id, upstream: up, branch: u.branch, head: a.head }));
      ctx.update((x) => ({ ...x, loop: { ...x.loop, asked: { ...x.loop.asked, [id]: { ...(x.loop.asked[id] ?? {}), [up]: a.head } }, askedTo: { ...x.loop.askedTo, [id]: { ...(x.loop.askedTo[id] ?? {}), [up]: t.implementer! } } } }));
      ctx.did(`asked ${id} to connect to ${up} at ${a.head.slice(0, 12)}`);
    }
  });
}

interface Ready { id: string; readyAt: number; order: number; head: string; pr: number }
/** Decision 10: recorded approval on the head + green CI on the head + upstreams merged — merged in READINESS order (the moment the last condition held), never declaration order. */
export async function stepDeliver(ctx: LoopCtx): Promise<void> {
  const { deps } = ctx;
  const s0 = ctx.st();
  const ready: Ready[] = [];
  const plan = s0.plan?.tickets ?? [];
  for (const id of activeTickets(s0)) await ctx.guard(`${id} deliver`, async () => {
    const t = s0.tickets[id];
    const a = ctx.approved.get(id);
    if (!a || !t.pr || !t.head) return;
    if (t.dependsOn.some((u) => !isMerged(s0, u))) return; // an unmerged upstream: never first
    const pr = await deps.forge.prState(t.pr);
    if (pr.state === 'closed') return;
    if (pr.state === 'merged') { // merged by hand: git and the forge overrule the state (#608 does the general case)
      ctx.update((x) => withLoop(applyTicketPatch(x, id, { status: 'merged' }, deps.now()), x.loop));
      ctx.did(`${id} was already merged on the forge: adopted`);
      return;
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
    if (!upDecision.ok) { ctx.note(`${id}: not deliverable — ${upDecision.reason}: ${upDecision.detail}`); return; }
    const checks = await deps.forge.checks(t.pr, t.head);
    // `decideDelivery`'s own guards, fed with what the forge says: the check set must be IDENTICAL on two polls of this head (kept in the sidecar) and a green check must have run ≥1 step
    const names = checks.map((c) => c.name).sort().join(',');
    const stable = s0.loop.checksSeen[t.head] === names;
    if (!stable) ctx.update((x) => ({ ...x, loop: { ...x.loop, checksSeen: { ...x.loop.checksSeen, [t.head!]: names } } }));
    const dc: DeliverCheck[] = checks.map((c) => ({ name: c.name, state: c.status === 'green' ? 'success' : c.status === 'red' ? 'failure' : 'pending', steps: c.steps ?? null }));
    const verdict = recordedVerdictOf(s0, id, t.head, t.tree);
    const rec = verdict.ok ? verdict.recorded : null;
    if (!rec) return; // no recorded verdict on this content: nothing to merge on (defence in depth: `ctx.approved` already says so)
    const dec = decideDelivery({
      pr: { state: 'OPEN', baseRefName: s0.target, headRefOid: pr.head, mergeable: 'MERGEABLE' }, checks: dc, into: s0.target, verifiedHead: t.head,
      verdict: { round: rec.round, blocking: rec.blocking, major: rec.major, minor: rec.minor, head: rec.head },
      waitedMs: 0, noChecksGraceMs: Number.MAX_SAFE_INTEGER, stable, requiredChecks: deps.options.requiredChecks ?? [],
    });
    if (dec.action === 'wait') { ctx.waitOn(`ci:${id}:${t.head}`, deps.options.stallMs); return; } // a CI running / registering is work under way (bounded)
    if (dec.action !== 'merge') { if (dec.action === 'refuse') ctx.note(`${id}: not deliverable — ${dec.reason}: ${dec.detail}`); return; }
    const upMergedAt = Math.max(0, ...t.dependsOn.map((u) => ms(s0.tickets[u].updatedAt)));
    const checkAt = Math.max(0, ...checks.map((c) => (c.at ? ms(c.at) : 0)));
    ready.push({ id, readyAt: Math.max(ms(a.at), checkAt, upMergedAt), order: plan.indexOf(id), head: dec.head, pr: t.pr });
  });
  ready.sort((x, y) => x.readyAt - y.readyAt || x.order - y.order);
  for (const r of ready) await ctx.guard(`${r.id} merge`, async () => {
    const res = await deps.forge.merge(r.pr, r.head, 'merge'); // a MERGE COMMIT, never a squash (decision 3: dependents connect by merge commit)
    if (!res.ok) { ctx.note(`${r.id}: merge refused by the forge — ${res.reason ?? 'unknown'}`); return; }
    ctx.update((x) => withLoop(applyTicketPatch(x, r.id, { status: 'merged' }, deps.now()), x.loop));
    ctx.did(`merged ${r.id} (PR #${r.pr})`);
  });
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
    deps, run: deps.run, pass, signals: new Set(), approved: new Map(), progress: [], finished: false, busy: false,
    waitOn: (key, boundMs) => {
      let since = ctx.st().loop.busySince[key];
      if (!since) { since = deps.now(); const at = since; ctx.update((x) => ({ ...x, loop: { ...x.loop, busySince: { ...x.loop.busySince, [key]: at } } })); }
      if (ms(deps.now()) - ms(since) <= boundMs) { ctx.busy = true; return true; }
      ctx.note(`${key}: waited ${Math.round((ms(deps.now()) - ms(since)) / 60_000)} min — no longer counted as progress`);
      return false;
    },
    guard: async (label, fn) => {
      try { await fn(); return true; } catch (e) {
        if (e instanceof LoopKilled || e instanceof SeatRefusal) throw e;
        ctx.note(`${label}: ${e instanceof Error ? e.message : String(e)} (retried next pass)`);
        return false;
      }
    },
    st: () => { const s = readLoopState(deps.home, deps.run); if (!s) throw new LoopRefusal('run-no-state', `no state for run ${deps.run}`); return s; },
    update: (fn) => updateLoopState(deps.home, deps.run, (cur) => fn(cur!)),
    did: (msg) => { ctx.progress.push(msg); deps.log(`[pass ${pass}] ${msg}`); },
  };
  return ctx;
}

/** What a stalled ticket is waiting for, read from the state (the park reason says it). */
function stuckWhy(s: LoopState, id: string): string {
  const t = s.tickets[id];
  if (!t.implementer) return 'has no implementer';
  if (!t.head) return 'has no candidate (no head recorded)';
  if (!t.pr) return 'is not nominated (no PR)';
  if (!reviewOn(t, t.head, t.tree)) return 'has no recorded review on its head';
  const open = t.dependsOn.filter((u) => !isMerged(s, u));
  return open.length ? `waits for ${open.join(', ')}` : 'is approved but not mergeable (CI or the forge)';
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
    if (ctx.progress.length || ctx.busy) lastProgress = ms(deps.now());
    const s = ctx.st();
    if (pausedOf(s)) return finish(4, `paused: ${pausedOf(s)!.reason}`);
    if (ctx.finished) return finish(parkedTickets(s).length ? 3 : 0);
    const stalled = ms(deps.now()) - lastProgress > deps.options.stallMs;
    if (stalled || passes >= deps.options.maxPasses) {
      const reason = stalled ? `stalled ${Math.round(deps.options.stallMs / 60_000)} min: ${activeTickets(s).map((id) => `${id} ${stuckWhy(s, id)}`).join('; ')}` : `pass limit ${deps.options.maxPasses}`;
      for (const id of activeTickets(s)) ctx.update((x) => (isParked(x, id) ? x : parkTicket(x, id, { cause: 'situation', reason }, deps.now())));
      deps.log(`ending: ${reason}; the unfinished tickets are parked`);
      return finish(3, reason);
    }
    await deps.sleep(deps.options.pollMs);
  }
}
