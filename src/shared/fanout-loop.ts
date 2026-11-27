// #605 (spec #601, ledger #613) — the Boucle: `runLoop` leads a vague from its plan to its closing report through the shipped modules (start / review / record / deliver rules), under seatRecords=on, verifier=off.
// Disposable by design (decision 12): every pass re-reads the state, git and the forge; the only thing carried between passes is the stall clock. The #606 / #607 / #608 steps are stubs here (see `stepCorrections`, `stepCi`,
// `stepReconcile`): they fill their step, never reorder `LOOP_STEPS`.
import type { FleetPort, ForgePort, GitPort } from './fanout-loop-ports.ts';
import { readLoopState, updateLoopState, withLoop, type LoopState } from './fanout-loop-side.ts';
import { applyPlan, type Plan } from './fanout-plan.ts';
import { buildReport, collectCosts, reportExit, type Report } from './fanout-report.ts';
import { LoopKilled } from './fanout-loop-kill.ts';
import { flakyAtMerge, stepCi as runCi, stepPauseWatch as runPauseWatch, stepStartCheck as runStartCheck } from './fanout-loop-ci.ts';
import { runCorrections } from './fanout-loop-corrections.ts';
import { renderRunChoices } from './fanout-brief-common.ts';
import { stepOpenPoints as runOpenPoints } from './fanout-loop-points.ts';
import { openPointBlocked } from './fanout-open-point.ts';
import { fileStatePort, stepEnd as runEnd, stepReconcile as runReconcile } from './fanout-relaunch.ts';
import { decideDelivery, decideUpstreams, type DeliverCheck, type UpstreamFacts } from './fanout-deliver.ts';
import { blockingMinors, applyTicketPatch, type FanoutState, FanoutStateError, newState, parkTicket, parkedTickets, pausedOf, planMissing, recordChoice, CHOICES_MAX, SeatRefusal, unmergedUpstreams, upstreamBlocker } from './fanout-state.ts';
import { countsThrough, recordedVerdictOf, reviewOn } from './fanout-record.ts';

export const LOOP_STEPS = ['reconcile', 'plan', 'start', 'mail', 'nominations', 'open', 'review', 'approvals', 'connect', 'ci', 'corrections', 'deliver', 'end'] as const;
export type LoopStep = (typeof LOOP_STEPS)[number];

/** Decision 5 (#645): the constant answer to EVERY question — no ask parks a ticket. An irreversible need is a script in the PR that is never run, recorded as a choice whose `--taken` starts `irreversible:`. */
export const FIXED_ANSWER = 'Take the reversible option unless the spec imposes the action; an irreversible need is code or a script in your PR that you never run. Record it with `orchestra fanout choice <your ticket> --question "<the question>" --taken "<the option>"` (for an irreversible need: `--taken "irreversible: <what, run by hand>"`), continue. Do not wait for anyone.';
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
  /** how many times a dead reviewer / implementer is replaced per (ticket, head) before the ticket is parked (default 2): a replacement is progress, so an agent that dies every time must not feed the stall clock for ever */
  maxReplacements?: number;
  /** #607 — the start check (`--start-check`): checks still pending after this long refuse the start (default 30 min) / no check at all after this long = a missing check (default 2 min) */
  startCheckTimeoutMs?: number;
  startCheckMissingMs?: number;
  /** #607 — a re-run's red whose job id did not change and carries no id: wait this long before trusting it (default 0) / a re-run still showing the old run after this long is given up (default 10 min) */
  rerunSettleMs?: number;
  rerunExpireMs?: number;
  /** #628 — a delivery refusal order (SYNC …) to an implementer: how long its head may stay unchanged before the next order (default 15 min); 2 orders with no new head replace the implementer */
  orderWaitMs?: number;
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
  sleep(loopMs: number): Promise<void>;
  log(line: string): void;
  options: LoopOptions;
  /** #625 — asks for the plan of `options.tickets` when no plan is given: resolves once a plan is ACCEPTED (live: the shipped `fanout plan --tickets … --run <id>`), throws a SeatRefusal when the plan step ended without one. Absent = `--plan` is required. */
  planner?: (tickets: string[]) => Promise<void>;
}
export interface LoopResult { exit: 0 | 1 | 2 | 3 | 4; report: Report; passes: number; reason?: string }

export class LoopRefusal extends SeatRefusal {}
/** A process death (a test's seam): never swallowed by `ctx.guard`. */
export { LoopKilled };

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
  /** log a line once per distinct text, again when it repeats on a later pass — at most once per `NOTE_REPEAT_PASSES` (a log filter, not state: a restart merely logs it again) */
  note(line: string): void;
  /** work is under way that the loop cannot see as a state change (a held start, a CI running, a reviewer reading): it counts as progress for the stall clock */
  busy: boolean;
  /** a BOUNDED wait: true (and the stall clock is fed) while `key` has been waited on for less than `boundMs`; false once it ran out — then the ticket is stalled for real. */
  waitOn(key: string, boundMs: number): boolean;
  /** run one ticket's (or one message's) share of a step: a thrown PORT error is logged and retried next pass — it never ends the run (a refusal or a kill does) */
  guard(label: string, fn: () => Promise<void>): Promise<boolean>;
  st(): LoopState;
  update(fn: (s: LoopState) => FanoutState | LoopState): LoopState;
  did(msg: string): void;
}

/** A note that repeats is printed again after this many passes (a stuck ticket must stay visible). */
export const NOTE_REPEAT_PASSES = 10;
const loopSameSha = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);
const loopMs = (iso: string): number => Date.parse(iso);

export const ticketMerged = (s: LoopState, id: string): boolean => s.tickets[id]?.status === 'merged';
export const ticketParked = (s: LoopState, id: string): boolean => s.tickets[id]?.status === 'parked'; // #603: parked is a STATUS (startRun skips it)
/** Plan tickets still to deliver: not merged, not dropped, not parked. */
export const activeTickets = (s: LoopState): string[] => (s.plan?.tickets ?? []).filter((id) => { const t = s.tickets[id]; return !!t && t.status !== 'merged' && t.status !== 'dropped' && t.status !== 'parked'; });
const implementerTicket = (s: LoopState, ws: string): string | null => Object.entries(s.tickets).find(([, t]) => t.implementer === ws)?.[0] ?? null;

export function renderConnectAsk(i: { ticket: string; upstream: string; branch: string | null; head: string; /** #675 — `renderRunChoices(state)`: '' / absent = none (the message is byte-identical) */ choices?: string }): string {
  return [
    `CONNECT ${i.upstream} ${i.head}`,
    `${i.ticket}: your upstream ${i.upstream}${i.branch ? ` (branch ${i.branch})` : ''} was approved at ${i.head}. Connect once: merge it into your branch with a MERGE COMMIT (git merge --no-ff ${i.head} — never rebase, never squash),`,
    'rebuild on its real names, push, then send a status. Keep going on your own ticket meanwhile; do not wait for anything else.',
    ...(i.choices ? ['', '## Choices of the run', i.choices] : []),
  ].join('\n');
}

// ── steps ────────────────────────────────────────────────────────────────────────────────────────────────────
/** #608 — git and the forge overrule the state at each start: a merge made by hand is adopted, a closed PR parks its ticket, a parked ticket whose blocker merged is released. Nothing before the state exists (the plan step creates it). */
export async function stepReconcile(ctx: LoopCtx): Promise<void> {
  const { deps } = ctx;
  if (readLoopState(deps.home, deps.run)) await adoptBranchTwins(ctx); // #683: before the reality read, so the twin's head and PR are what reconcile sees
  if (!readLoopState(deps.home, deps.run)) return;
  // `readReality` turns a failed read into "unknown" (never "gone"); a process death (LoopKilled, the tests' seam) must still end the pass
  let killed: LoopKilled | null = null;
  const trap = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => { try { return await f(...a); } catch (e) { if (e instanceof LoopKilled) killed = e; throw e; } };
  const o = await runReconcile({ now: deps.now, log: (l) => ctx.note(l), git: { head: trap((b) => deps.git.head(b)), tree: trap((x) => deps.git.tree(x)), isMerged: trap((b, base) => deps.git.isMerged(b, base)) }, forge: { prState: trap((n) => deps.forge.prState(n)) }, state: fileStatePort(deps.home, deps.run), park: parkTicket });
  if (killed) throw killed;
  for (const id of o.adopted) ctx.did(`adopted ${id}: merged outside the loop`);
  for (const id of o.released) ctx.did(`released ${id}: its parked upstream was merged`);
  for (const p of o.parked) ctx.did(`parked ${p.ticket} [${p.cause}]: ${p.reason}`);
}
/** #683 — a started ticket whose tracked branch is not on the remote but whose separator twin is (`impl/X` pushed for `impl-X`): the ticket follows the twin (head, PR as if tracked), said in the log. Unreadable remote ⇒ nothing adopted. */
export async function adoptBranchTwins(ctx: LoopCtx): Promise<void> {
  const { deps } = ctx;
  if (!deps.git.twin) return;
  for (const id of activeTickets(ctx.st())) {
    const t = ctx.st().tickets[id];
    if (!t?.branch || t.status === 'todo') continue;
    if (await deps.git.head(t.branch)) continue;
    const tw = await deps.git.twin(t.branch);
    if (!tw || tw === t.branch) continue;
    ctx.update((x) => withLoop(applyTicketPatch(x, id, { branch: tw }, deps.now()), x.loop));
    ctx.did(`adopted ${tw} as the branch of ${id}: ${t.branch} is not on the remote, ${tw} is (same name apart from its separators)`);
  }
}
/** #607 — what a CI step reads from the loop: the deps, the state (read now) and the atomic write (the loop's own side file rides along untouched). */
const ciCtxOf = (ctx: LoopCtx): Parameters<typeof runCi>[0] => ({
  deps: { run: ctx.deps.run, now: ctx.deps.now, sleep: ctx.deps.sleep, log: (l) => ctx.note(l), fleet: ctx.deps.fleet, forge: ctx.deps.forge, git: ctx.deps.git, options: ctx.deps.options },
  state: ctx.st(),
  update: (m) => ctx.update((x) => m(x)),
});
/** #607 (decision 9) — the optional start check: an empty PR into the target, its checks awaited, closed. A red or missing check refuses the start (`[run-start-check-<red|missing|timeout|unsupported|identity>]`, exit 2): nothing was launched. */
export async function stepStartCheck(ctx: LoopCtx): Promise<void> {
  const r = await runStartCheck(ciCtxOf(ctx));
  if (!r.ok) throw new LoopRefusal(`run-${r.code}`, r.detail);
  if (r.ok && r.flaky?.length) { // #654: red, then green on the one re-run — listed for the report
    const names = r.flaky;
    ctx.update((x) => ({ ...x, startFlaky: [...new Set([...(x.startFlaky ?? []), ...names])], updatedAt: ctx.deps.now() }));
    for (const n of names) ctx.did(`flaky: start-check/${n}`);
  }
  if (!r.skipped) ctx.did('start check passed (an empty pull request, its checks green, closed)');
}
/** #607 (decision 8) — red CI: one re-run of the red jobs, then the author gets the check name and the log extract, the same failure after its fix parks the ticket; the same check red on several PRs pauses the run (the loop stops after this step). */
export async function stepCi(ctx: LoopCtx): Promise<void> {
  const r = await runCi(ciCtxOf(ctx));
  for (const id of r.reran) ctx.did(`re-ran the red CI jobs of ${id}`);
  for (const id of r.told) ctx.did(`told the author of ${id} which check is red`);
  for (const id of r.parked) ctx.did(`parked ${id}: the same CI failure after its fix`);
  for (const f of r.flaky) ctx.did(`flaky: ${f}`);
  const pause = pausedOf(ctx.st());
  if (pause && r.paused) ctx.did(`PAUSED: ${pause.reason}`);
}
/** #655 — an automatic pause: the loop stays alive, re-runs the red checks with backoff and lifts the pause on the first green (a pause set by hand is untouched). */
export async function stepPauseWatch(ctx: LoopCtx): Promise<void> {
  const r = await runPauseWatch(ciCtxOf(ctx));
  for (const n of r.reran) ctx.did(`pause: re-ran the red checks of #${n}`);
  if (r.lifted) ctx.did(`pause lifted by itself after ${Math.round(r.waitedMs / 60_000)} min: the red check is green again`);
}
/** #606 — findings in ONE batch to the same author, the same reviewer reads the fix, the same situation (open findings + tree) twice parks the ticket. */
export async function stepCorrections(ctx: LoopCtx): Promise<void> {
  const out = await runCorrections({ deps: ctx.deps, guard: ctx.guard });
  for (const o of out) {
    if (o.action === 'sent') ctx.did(`${o.ticket}: round ${o.round} sent to ${o.to} (${o.findings.join(', ')})`);
    else if (o.action === 'parked') ctx.did(`parked ${o.ticket}: ${o.why} (${o.findings.join(', ')})`);
    else if (o.action === 'reviewer-woken') ctx.note(`${o.ticket}: reviewer ${o.reviewer} reads ${o.head.slice(0, 12)}`); // NOT progress: the host op is a no-op on a head the reviewer already holds, so a silent reviewer would feed the stall clock every pass for ever
    else if (o.action === 'blocked') ctx.note(`${o.ticket}: corrections blocked — ${o.why}`);
  }
  await runOpenPoints(ctx); // #676: the open points of the tickets: an order to the `about` implementer, a follow-up ticket when it is merged, the fixed rule when nobody addresses it
}

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
  if (!o.plan && o.tickets?.length && deps.planner) { // #625: no plan file, tickets named: the plan agent is spawned (by the shipped `fanout plan`) and awaited
    ctx.did(`asking for a plan of ${o.tickets.join(', ')} (the plan agent is spawned)`);
    await deps.planner(o.tickets);
    s = ctx.st();
    if (s.plan && planMissing(s).length === 0) { ctx.did(`plan accepted: ${s.plan.tickets.join(', ')}`); return; }
    throw new LoopRefusal('run-plan-incomplete', `the plan agent's plan is incomplete: ${planMissing(s).join('; ')}`);
  }
  if (!o.plan) throw new LoopRefusal('run-plan-needed', `run ${deps.run} has no complete plan${s.plan ? `: ${planMissing(s).join('; ')}` : ''} — pass --plan <plan.json> (#604's file) or --tickets a,b,c (the plan agent is spawned)`);
  const plan = o.plan;
  updateLoopState(deps.home, deps.run, (cur) => ({ ...withLoop(applyPlan(cur!, plan, deps.now()), cur!.loop) }));
  ctx.did(`plan applied: ${plan.tickets.map((t) => t.id).join(', ')}`);
  const after = ctx.st();
  if (planMissing(after).length) throw new LoopRefusal('run-plan-incomplete', `the plan is incomplete: ${planMissing(after).join('; ')}`);
}

/** Decision 3: every implementer starts at once, on the frozen names. A start held by Admission is a wait, never a fault. A dead implementer is replaced at most `maxReplacements` times per (ticket, head), then the ticket is parked. */
export async function stepStart(ctx: LoopCtx): Promise<void> {
  const { deps } = ctx;
  const s = ctx.st();
  const holdMs = deps.options.holdMs ?? 12 * 3_600_000;
  const cap = deps.options.maxReplacements ?? 2;
  // a hold EPISODE is over once the ticket shows a head other than the one it had when it was held: its entry and its age go
  const heldNow = activeTickets(s).filter((id) => id in s.loop.held && (s.tickets[id].head ?? '') === s.loop.held[id]);
  for (const id of heldNow) ctx.waitOn(`held:${id}`, holdMs); // reported earlier, not released yet: a wait, not a stall — for `holdMs`
  const over = Object.keys(s.loop.held).filter((id) => !heldNow.includes(id));
  if (over.length) ctx.update((x) => ({ ...x, loop: { ...x.loop, held: Object.fromEntries(Object.entries(x.loop.held).filter(([id]) => !over.includes(id))), busySince: Object.fromEntries(Object.entries(x.loop.busySince).filter(([k]) => !over.some((id) => k === `held:${id}`))) } }));
  let need = activeTickets(s).filter((id) => { const t = s.tickets[id]; return (t.status === 'todo' || t.status === 'started') && (!t.implementer || !deps.fleet.live(t.implementer)); });
  for (const id of need) { // an implementer that is recorded but gone is a DEATH: replaced up to the cap
    const t = s.tickets[id];
    if (!t.implementer || s.loop.orders[id]?.replacing) continue; // #628: released on purpose — not a death, never charged to the cap
    const n = s.loop.replaced[`impl:${id}:${t.head ?? ''}`] ?? 0;
    if (n >= cap) {
      const reason = `implementer died ${n} times (replaced ${n}×, last at ${t.head ? t.head.slice(0, 12) : 'no head'})`;
      ctx.update((x) => (ticketParked(x, id) ? x : parkTicket(x, id, { cause: 'situation', reason }, deps.now())));
      ctx.did(`parked ${id}: ${reason}`);
    }
  }
  const s2 = ctx.st();
  need = need.filter((id) => !ticketParked(s2, id));
  if (!need.length) return;
  if (deps.options.startCheck && !Object.values(s.tickets).some((t) => t.start)) await stepStartCheck(ctx);
  const r = await deps.fleet.start();
  for (const x of r.started) ctx.did(`started ${x.ticket} (${x.ws})`);
  for (const x of r.respawned) {
    if (s.loop.orders[x.ticket]?.replacing) { ctx.update((y) => ({ ...y, loop: { ...y.loop, orders: { ...y.loop.orders, [x.ticket]: { ...y.loop.orders[x.ticket], replacing: undefined, n: 0 } } } })); ctx.did(`replaced the implementer of ${x.ticket} (${x.ws}) on its branch`); continue; }
    const key = `impl:${x.ticket}:${s.tickets[x.ticket]?.head ?? ''}`;
    ctx.update((y) => ({ ...y, loop: { ...y.loop, replaced: { ...y.loop.replaced, [key]: (y.loop.replaced[key] ?? 0) + 1 } } }));
    ctx.did(`restarted ${x.ticket} (${x.ws})`);
  }
  if (r.waiting.length) {
    const fresh = r.waiting; // `startRun` reports a held start exactly once, in the call that spawned it: each report is a NEW hold episode and starts its own clock
    ctx.update((y) => ({ ...y, loop: { ...y.loop, held: { ...y.loop.held, ...Object.fromEntries(r.waiting.map((x) => [x.ticket, y.tickets[x.ticket]?.head ?? ''])) }, busySince: Object.fromEntries(Object.entries(y.loop.busySince).filter(([k]) => !fresh.some((x) => k === `held:${x.ticket}`))) } }));
  }
  for (const x of r.waiting) { ctx.waitOn(`held:${x.ticket}`, holdMs); ctx.note(`waiting: ${x.ticket} — ${x.why}`); } // an Admission hold is a wait, not a fault, and not a stall
  for (const x of r.failed) ctx.note(`could not start ${x.ticket}: ${x.error} (tried again next pass)`);
}

/** An agent's text goes into `choices` / a park reason: control characters would be refused by the state ([choice-bad]) and the message would be retried for ever. */
const loopClean = (t: string): string => t.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').trim() || '(empty)';
/** `recordChoice`, except past the state's cap (`CHOICES_MAX`): the choice is NOT listed (said in the log) — the answer still goes out; a refused listing would poison every restart. */
function listChoice(x: FanoutState, e: Parameters<typeof recordChoice>[1], now: string, note: (l: string) => void): FanoutState {
  if ((x.choices?.length ?? 0) >= CHOICES_MAX) { note(`choices are full (${CHOICES_MAX}): "${e.question.slice(0, 60)}" is not listed (it stays in the agent's PR body)`); return x; }
  return recordChoice(x, e, now);
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
        const first = loopClean(m.body.split('\n')[0]).slice(0, ASK_MAX); // `recordChoice` refuses longer text ([choice-bad]); the full text stays in the agent's PR body
        if (!h) ctx.update((x) => { const y = listChoice(x, { ticket: ticket ?? m.sender, question: first, rule: 'reversible-default', answer: FIXED_ANSWER }, deps.now(), ctx.note); return { ...y, loop: { ...x.loop, handled: { ...x.loop.handled, [m.seq]: 'listed' as const } } }; });
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
      if (builtOn[up] && loopSameSha(builtOn[up], asked)) continue;
      if (!(await deps.git.isMerged(asked, head))) continue;
      builtOn[up] = asked;
      const tr = await deps.git.tree(asked);
      if (tr) builtOnTree[up] = tr; else delete builtOnTree[up];
      connected = true;
    }
    const headChanged = !t.head || !loopSameSha(head, t.head);
    // #629: the implementer cannot record `--follows` (role guard: one writer) — the loop does, for every upstream with an interface this ticket is connected to (it sent the CONNECT) or whose merge it builds on
    const followsNew: Record<string, number> = {};
    for (const up of t.dependsOn) { const f = s.tickets[up]?.iface; if (f && t.follows?.[up] === undefined && (builtOn[up] || ticketMerged(s, up))) followsNew[up] = f.version; }
    const followed = Object.keys(followsNew).length > 0;
    // the state's early-gate rule decides: nominated needs, for every unmerged upstream, a candidate (nominated|gated) whose CURRENT content is what `builtOn` says this head was built on
    const view: LoopState = { ...s, tickets: { ...s.tickets, [id]: { ...t, head, builtOn, builtOnTree } } };
    const clear = unmergedUpstreams(s, id).every((u) => upstreamBlocker(view, view.tickets[id], u) === null);
    const want = clear ? (t.status === 'started' || t.status === 'nominated' ? 'nominated' : t.status) : (t.status === 'nominated' || t.status === 'gated' ? 'started' : t.status); // an upstream that moved under a nominated dependent: back to started until it is connected again
    if (!headChanged && !connected && !followed && want === t.status) { spend(); return; }
    const tree = headChanged ? await deps.git.tree(head) : t.tree;
    const patch = (status: string): Record<string, unknown> => ({ head, ...(connected ? { builtOn } : {}), ...(followed ? { follows: { ...t.follows, ...followsNew } } : {}), status });
    const derived = { tree, ...(connected ? { builtOnTree } : {}) };
    let written: string = want; // what the state HOLDS afterwards: the log says this, never what was wanted
    try {
      ctx.update((x) => withLoop(applyTicketPatch(x, id, patch(want), deps.now(), derived), x.loop));
    } catch (e) {
      if (!(e instanceof FanoutStateError)) throw e;
      // the state refuses this nomination (e.g. `--follows` not recorded): the head is kept, the ticket stays as it was, the author is told what to fix — one ticket's omission never ends the run
      ctx.note(`${id}: cannot be ${want} yet — ${e.message}`);
      written = t.status === 'nominated' || t.status === 'gated' ? 'started' : t.status;
      ctx.update((x) => withLoop(applyTicketPatch(x, id, { head, ...(connected ? { builtOn } : {}), status: written }, deps.now(), derived), x.loop));
      if ((headChanged || connected) && t.implementer && deps.fleet.live(t.implementer)) await deps.fleet.send(t.implementer, `orchestra could not nominate ${id}: ${e.message}`, 'status');
    }
    spend();
    if (followed && written === want) ctx.did(`${id}: recorded follows ${Object.entries(followsNew).map(([u, v]) => `${u}=${v}`).join(',')}`);
    if (headChanged) ctx.did(`${id} ${written === 'nominated' ? 'nominated' : 'has a head'} at ${head.slice(0, 12)}`);
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
    if (last && loopSameSha(last.head, t.head) && (!rv || deps.fleet.live(rv))) { ctx.waitOn(`review:${id}:${t.head}`, deps.options.stallMs); return; } // briefed on this head and the reviewer is alive: it owes its record (bounded); a DEAD reviewer is replaced below
    const key = `rev:${id}:${t.head}`;
    const died = last && loopSameSha(last.head, t.head) ? ctx.st().loop.replaced[key] ?? 0 : 0; // the briefed reviewer is gone: a replacement, up to the cap
    if (last && loopSameSha(last.head, t.head)) {
      const cap = deps.options.maxReplacements ?? 2;
      if (died >= cap) {
        const reason = `reviewer died ${died} times on ${t.head.slice(0, 12)}`;
        ctx.update((x) => (ticketParked(x, id) ? x : parkTicket(x, id, { cause: 'situation', reason }, deps.now())));
        ctx.did(`parked ${id}: ${reason}`);
        return;
      }
    }
    const r = await deps.fleet.spawnReviewer(id, t.head);
    if (last && loopSameSha(last.head, t.head)) ctx.update((x) => ({ ...x, loop: { ...x.loop, replaced: { ...x.loop.replaced, [key]: died + 1 } } })); // counted AFTER the spawn succeeded: a host op that fails (busy, down) is retried, never charged to the cap
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
    if (openPointBlocked(s, id)) continue; // #676: an unsettled open point (raised by this ticket, about it, or carried by it) holds the approval — the merge and the CONNECT of its dependents
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
      if (!u || ticketMerged(s, up) || !a) continue;
      const asked = s.loop.asked[id]?.[up];
      if (asked && loopSameSha(asked, a.head) && s.loop.askedTo[id]?.[up] === t.implementer) continue; // once per (dependent, upstream, head, AUTHOR): a respawned author is asked again
      if (t.builtOn[up] && loopSameSha(t.builtOn[up], a.head)) continue;
      await deps.fleet.wake(t.implementer, renderConnectAsk({ ticket: id, upstream: up, branch: u.branch, head: a.head, choices: renderRunChoices(ctx.st()) }));
      const moved = !!asked && !loopSameSha(asked, a.head); // #649: a CONNECT sent again because the upstream moved (a respawned author re-asked on the SAME head is not one)
      ctx.update((x) => ({ ...x, loop: { ...x.loop, ...(moved ? { reconnects: { ...x.loop.reconnects, [id]: (x.loop.reconnects[id] ?? 0) + 1 } } : {}), asked: { ...x.loop.asked, [id]: { ...(x.loop.asked[id] ?? {}), [up]: a.head } }, askedTo: { ...x.loop.askedTo, [id]: { ...(x.loop.askedTo[id] ?? {}), [up]: t.implementer! } } } }));
      ctx.did(`asked ${id} to connect to ${up} at ${a.head.slice(0, 12)}`);
    }
  });
}

/** #628 — refusals another step already has a rule for (CI waits and parks, the corrections / review steps, the nominations step reading a moved head, an unfinished upstream, a closed PR): noted only. Every OTHER refusal goes to the ticket's implementer. */
export const RULED_REFUSALS: ReadonlySet<string> = new Set(['head-moved', 'ci-red', 'no-checks', 'zero-steps', 'review-blocking', 'verdict-head-mismatch', 'upstream-not-merged', 'upstream-changed', 'pr-closed', 'record-missing', 'no-verdict', 'timeout', 'acceptance-pending', 'gh-failed', 'pr-not-open', 'pr-mismatch', 'no-ticket']);
export function renderSyncOrder(i: { ticket: string; target: string; pr: number; reason: string; detail: string }): string {
  const conflict = i.reason === 'merge-conflict';
  return [
    conflict ? `SYNC ${i.target}` : `FIX ${i.reason}`,
    `${i.ticket}: the forge refuses to merge PR #${i.pr}: ${i.reason}${i.detail ? ` — ${i.detail}` : ''}.`,
    `${conflict ? 'Merge' : 'Fix what it names; if it is about the base, merge'} ${i.target} into your branch with a MERGE COMMIT (git fetch origin && git merge --no-ff origin/${i.target} — never rebase, never squash), resolve the conflicts, run the checks, push,`,
    'then send a status with the new head sha. Do not wait for anything else.',
  ].join('\n');
}
/** #628 — a delivery refusal the loop has no rule for goes to the ticket's implementer with the raw reason (`merge-conflict` = the SYNC order). Orders are spaced by `orderWaitMs`; 2 orders with the head unchanged replace the implementer
 *  with a fresh one on the same branch, and the order goes out again. Never a park, never a global limit (owner, 2026-11-26). */
async function orderImplementer(ctx: LoopCtx, id: string, reason: string, detail: string): Promise<void> {
  if (RULED_REFUSALS.has(reason)) return;
  const { deps } = ctx;
  const t = ctx.st().tickets[id];
  if (!t.implementer || !t.head || !t.pr) return;
  const o = ctx.st().loop.orders[id];
  const replacing = !!o?.replacing;
  const now = deps.now();
  if (!deps.fleet.live(t.implementer)) { // dead: `stepStart` puts a fresh one on the branch, the order follows next pass (a ticket released on purpose must read `started` for that)
    if (replacing && t.status !== 'started') ctx.update((x) => withLoop(applyTicketPatch(x, id, { status: 'started' }, now), x.loop));
    return;
  }
  const sameHead = !!o && loopSameSha(o.head, t.head);
  const send = async (n: number): Promise<void> => {
    await deps.fleet.wake(t.implementer!, renderSyncOrder({ ticket: id, target: ctx.st().target, pr: t.pr!, reason, detail }));
    ctx.update((x) => ({ ...x, loop: { ...x.loop, orders: { ...x.loop.orders, [id]: { head: t.head!, n, at: now, reason } } } }));
    ctx.did(`${id}: ${reason} — order ${n} sent to ${t.implementer}`);
  };
  if (!sameHead) return send(1); // a new head = progress: the count starts again
  if (replacing) { // released on purpose but still alive (the release failed): again
    await deps.fleet.replace(id);
    return;
  }
  if (o.n === 0) return send(1); // a fresh implementer: it gets the order at once
  if (loopMs(now) - loopMs(o.at) < (deps.options.orderWaitMs ?? 15 * 60_000)) { ctx.busy = true; return; } // the implementer is on it
  if (o.n < 2) return send(o.n + 1);
  // 2 orders, the head never moved: a fresh implementer on the same branch (state first: `started` is what `fanout start` respawns; the release after — a failed release is retried)
  ctx.update((x) => ({ ...withLoop(applyTicketPatch(x, id, { status: 'started' }, now), x.loop), loop: { ...x.loop, orders: { ...x.loop.orders, [id]: { ...o, n: 0, at: now, replacing: true as const } } } }));
  await deps.fleet.replace(id);
  ctx.did(`${id}: ${o.n} orders without a new head — implementer ${t.implementer} replaced by a fresh one on the same branch`);
}

interface Ready { id: string; readyAt: number; order: number; head: string; pr: number; dependents: number }
/** #649 — per ticket, how many UNFINISHED tickets (not merged, not dropped) depend on it, directly or through others. Cycle-safe. */
export function transitiveDependents(tickets: Record<string, { dependsOn: string[]; status: string }>): Record<string, number> {
  const open = Object.keys(tickets).filter((id) => tickets[id].status !== 'merged' && tickets[id].status !== 'dropped');
  const out: Record<string, number> = Object.fromEntries(Object.keys(tickets).map((id) => [id, 0]));
  for (const d of open) {
    const seen = new Set<string>();
    const walk = (id: string): void => { for (const u of tickets[id]?.dependsOn ?? []) if (u in tickets && !seen.has(u)) { seen.add(u); walk(u); } };
    walk(d);
    for (const u of seen) if (u !== d) out[u]++;
  }
  return out;
}
/** #649 — the merge order of the tickets ready in one pass: the most transitive dependents first (a chain root moves every dependent when another merge lands before it), then READINESS order. Never waits for a ticket that is not ready. */
export const sortReady = <T extends { dependents: number; readyAt: number; order: number }>(ready: T[]): T[] => [...ready].sort((x, y) => y.dependents - x.dependents || x.readyAt - y.readyAt || x.order - y.order);
/** Decision 10 + #649: recorded approval on the head + green CI on the head + upstreams merged — merged most-depended-on first, then in READINESS order (the moment the last condition held), never declaration order. */
export async function stepDeliver(ctx: LoopCtx): Promise<void> {
  const { deps } = ctx;
  const s0 = ctx.st();
  const ready: Ready[] = [];
  const plan = s0.plan?.tickets ?? [];
  const dependents = transitiveDependents(s0.tickets);
  for (const id of activeTickets(s0)) await ctx.guard(`${id} deliver`, async () => {
    const t = s0.tickets[id];
    const a = ctx.approved.get(id);
    if (!a || !t.pr || !t.head) return;
    if (t.dependsOn.some((u) => !ticketMerged(s0, u))) return; // an unmerged upstream: never first
    const pr = await deps.forge.prState(t.pr);
    if (pr.state === 'closed') return;
    if (pr.state === 'merged') { // merged by hand: git and the forge overrule the state (#608 does the general case)
      ctx.update((x) => withLoop(applyTicketPatch(flakyAtMerge(x, id, deps.now()), id, { status: 'merged' }, deps.now()), x.loop));
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
    // #637 (#512's content key, as `fanout deliver` reads it): a head with another sha and the SAME git tree is covered by the verdict (`reviewOn` matched it), and so is a PR head that differs from the state's
    const covering = reviewOn(t, t.head, t.tree); // matched by sha or by tree: a different sha here IS the same tree
    const verdictSameTree = !!covering && !loopSameSha(covering.head, t.head);
    const prTree = loopSameSha(pr.head, t.head) ? null : await deps.git.tree(pr.head);
    const headSameTree = !!prTree && !!t.tree && prTree === t.tree;
    const dec = decideDelivery({
      pr: { state: 'OPEN', baseRefName: s0.target, headRefOid: pr.head, mergeable: 'MERGEABLE' }, checks: dc, into: s0.target, verifiedHead: t.head,
      verdict: { round: rec.round, blocking: rec.blocking, major: rec.major, minor: rec.minor, head: rec.head },
      waitedMs: 0, noChecksGraceMs: Number.MAX_SAFE_INTEGER, stable, requiredChecks: deps.options.requiredChecks ?? [], verdictSameTree, headSameTree, treesDiffer: !loopSameSha(pr.head, t.head) && !!prTree && !headSameTree,
    });
    if (dec.action === 'wait') { ctx.waitOn(`ci:${id}:${t.head}`, deps.options.stallMs); return; } // a CI running / registering is work under way (bounded)
    if (dec.action !== 'merge') { if (dec.action === 'refuse') { ctx.note(`${id}: not deliverable — ${dec.reason}: ${dec.detail}`); await orderImplementer(ctx, id, dec.reason, dec.detail); } return; }
    const upMergedAt = Math.max(0, ...t.dependsOn.map((u) => loopMs(s0.tickets[u].updatedAt)));
    const checkAt = Math.max(0, ...checks.map((c) => (c.at ? loopMs(c.at) : 0)));
    ready.push({ id, readyAt: Math.max(loopMs(a.at), checkAt, upMergedAt), order: plan.indexOf(id), head: dec.head, pr: t.pr, dependents: dependents[id] ?? 0 });
  });
  for (const r of sortReady(ready)) await ctx.guard(`${r.id} merge`, async () => {
    const res = await deps.forge.merge(r.pr, r.head, 'merge'); // a MERGE COMMIT, never a squash (decision 3: dependents connect by merge commit)
    if (!res.ok) { ctx.note(`${r.id}: merge refused by the forge — ${res.reason ?? 'unknown'}${res.detail ? `: ${res.detail}` : ''}`); await orderImplementer(ctx, r.id, res.reason ?? 'unknown', res.detail ?? ''); return; }
    ctx.update((x) => withLoop(applyTicketPatch(flakyAtMerge(x, r.id, deps.now()), r.id, { status: 'merged' }, deps.now()), x.loop));
    ctx.did(`merged ${r.id} (PR #${r.pr})`);
  });
}

/** #608 — a ticket waiting behind a DROPPED upstream is parked (it can never be ready); the run is finished when every plan ticket is merged, dropped or parked (a parked ticket parks its dependents). The report itself is built at the exit (`finish`), with the per-ticket token costs. */
export async function stepEnd(ctx: LoopCtx): Promise<void> {
  const { deps } = ctx;
  await runEnd({ now: deps.now, log: (l) => ctx.note(l), state: fileStatePort(deps.home, deps.run), park: parkTicket, costOf: (t) => deps.fleet.costOf(t) });
  ctx.finished = activeTickets(ctx.st()).length === 0;
}

const LOOP_STEP_FNS: Record<LoopStep, (ctx: LoopCtx) => Promise<void>> = {
  reconcile: stepReconcile, plan: stepPlan, start: stepStart, mail: stepMail, nominations: stepNominations, open: stepOpen, review: stepReview,
  approvals: stepApprovals, connect: stepConnect, ci: stepCi, corrections: stepCorrections, deliver: stepDeliver, end: stepEnd,
};

export function newCtx(deps: LoopDeps, pass: number, seen: Map<string, number>): LoopCtx {
  const ctx: LoopCtx = {
    note: (line) => { const last = seen.get(line); if (last === undefined || pass - last >= NOTE_REPEAT_PASSES) { seen.set(line, pass); deps.log(`[pass ${pass}] ${line}`); } },
    deps, run: deps.run, pass, signals: new Set(), approved: new Map(), progress: [], finished: false, busy: false,
    waitOn: (key, boundMs) => {
      let since = ctx.st().loop.busySince[key];
      if (!since) { since = deps.now(); const at = since; ctx.update((x) => ({ ...x, loop: { ...x.loop, busySince: { ...x.loop.busySince, [key]: at } } })); }
      if (loopMs(deps.now()) - loopMs(since) <= boundMs) { ctx.busy = true; return true; }
      ctx.note(`${key}: waited ${Math.round((loopMs(deps.now()) - loopMs(since)) / 60_000)} min — no longer counted as progress`);
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
  const lastRev = (t.reviews ?? [])[(t.reviews ?? []).length - 1];
  if (lastRev?.verdict === 'changes-requested' && (loopSameSha(lastRev.head, t.head) || (!!lastRev.tree && lastRev.tree === t.tree))) return `has changes requested by its reviewer (open: ${countsThrough(t, lastRev.n).open.join(', ') || 'none recorded'}) and no fix yet`;
  if (!reviewOn(t, t.head, t.tree)) return 'has no recorded review on its head';
  const open = t.dependsOn.filter((u) => !ticketMerged(s, u));
  return open.length ? `waits for ${open.join(', ')}` : 'is approved but not mergeable (CI or the forge)';
}

export async function runLoop(deps: LoopDeps): Promise<LoopResult> {
  let lastProgress = loopMs(deps.now());
  let passes = 0;
  const seen = new Map<string, number>();
  const finish = async (exit: LoopResult['exit'], reason?: string): Promise<LoopResult> => {
    const s = readLoopState(deps.home, deps.run) ?? withLoop({ version: 1, run: deps.run, target: deps.options.target, repo: null, tickets: {}, updatedAt: deps.now(), reconciledAt: null });
    const report = buildReport(s, await collectCosts(s, (t) => deps.fleet.costOf(t)), s.loop.reconnects); // story 21: the cost per ticket is READ from the transcripts, not left null
    // a finished run with nothing parked exits through the report's own rule (0, or 1 when nothing merged at all)
    return { exit: exit === 0 ? reportExit(report) === 1 ? 1 : 0 : exit, report, passes, ...(reason ? { reason } : {}) };
  };
  for (;;) {
    passes++;
    const ctx = newCtx(deps, passes, seen);
    try {
      for (const step of LOOP_STEPS) {
        await LOOP_STEP_FNS[step](ctx);
        // a paused run (decision 8: the same check red on several PRs, or a pause set by hand) starts, merges and answers nothing more until it is resumed
        if (step === 'reconcile' || step === 'ci') { const cur = readLoopState(deps.home, deps.run); if (cur && pausedOf(cur)) break; }
      }
    } catch (e) {
      if (e instanceof SeatRefusal) { deps.log(`refused ${e.message}`); return await finish(2, e.message); }
      throw e;
    }
    if (ctx.progress.length || ctx.busy) lastProgress = loopMs(deps.now());
    const s = ctx.st();
    // #655: an automatic pause is waited out (the wait is progress, never a stall); only a pause set by hand ends the run
    if (pausedOf(s)?.auto) { await stepPauseWatch(ctx); lastProgress = loopMs(deps.now()); if (!pausedOf(ctx.st())) continue; }
    else if (pausedOf(s)) return await finish(4, `paused: ${pausedOf(s)!.reason}`);
    if (ctx.finished) return await finish(parkedTickets(s).length ? 3 : 0);
    const stalled = loopMs(deps.now()) - lastProgress > deps.options.stallMs;
    if (stalled || passes >= deps.options.maxPasses) {
      const reason = stalled ? `stalled ${Math.round(deps.options.stallMs / 60_000)} min: ${activeTickets(s).map((id) => `${id} ${stuckWhy(s, id)}`).join('; ')}` : `pass limit ${deps.options.maxPasses}`;
      for (const id of activeTickets(s)) ctx.update((x) => (ticketParked(x, id) ? x : parkTicket(x, id, { cause: 'situation', reason }, deps.now())));
      deps.log(`ending: ${reason}; the unfinished tickets are parked`);
      return await finish(3, reason);
    }
    await deps.sleep(deps.options.pollMs);
  }
}
