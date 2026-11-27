// #605 (ledger #613) — the DUMMY FLEET the loop is measured on: scripted agents, an in-memory git, a PR host and a CI, all on a VIRTUAL clock (`sleep` advances it and runs what is due), driven by `scenario.json` v1.
// The agents' effects go through the REAL modules wherever they exist (`startRun` for the launch, `decideReview`/`claimReviewer`/`recordWake` for the reviewer, `recordReview` for a verdict, `updateState` for the file):
// the only thing faked is the world around them. Every act is appended to an event log the judge (fanout-loop-judge.ts) reads. Refused unless ORCHESTRA_FANOUT_DUMMY=1 at the CLI.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FleetPort, ForgeCheck, ForgePort, GitPort, LoopMail } from './fanout-loop-ports.ts';
import { readLoopState, updateLoopState, withLoop } from './fanout-loop-side.ts';
import type { Plan } from './fanout-plan.ts';
import { decideReview, claimReviewer, recordWake, reviewerName, nthReviewer, settleReviewer } from './fanout-review.ts';
import { recordImplementerChoice, recordReview, reviewHeadOf } from './fanout-record.ts';
import { criteriaLines } from './fanout-criteria.ts';
import { contractsOf } from './fanout-contracts.ts';
import { LOOP_BRIEF } from './fanout-implementer-brief.ts';
import { implementerName, startRun, type StartResult } from './fanout-start.ts';
import { applyPlan } from './fanout-plan.ts';
import { recordOpenPoint } from './fanout-open-point.ts';
import { applyTicketPatch, effectiveSpec, FanoutStateError, newState, stateFile } from './fanout-state.ts';
import { judgeRun, type Ev, type Violation } from './fanout-loop-judge.ts';
import { DEFAULT_OPTIONS, runLoop, type LoopOptions, type LoopResult } from './fanout-loop.ts';

export const STEP_KINDS_IMPLEMENTER = ['code', 'nominate', 'fix', 'connect', 'sync', 'retree', 'wait', 'die', 'choice', 'point', 'address'] as const; // die = the implementer's workspace ends (its branch stays); choice = `fanout choice` (#675: with `narrows` when the option cuts a ticket sentence)
export const STEP_KINDS_REVIEWER = ['approve', 'changes', 'die', 'silent'] as const; // die = the reviewer's workspace ends with no record; silent = alive, never records
export interface Step { do: (typeof STEP_KINDS_IMPLEMENTER)[number] | (typeof STEP_KINDS_REVIEWER)[number]; afterMs?: number; findings?: string[]; head?: string;
  /** `choice` step (#675): the recorded question / option / narrowed ticket sentence */
  question?: string; taken?: string; narrows?: string;
  /** `changes` step (#675): the findings' severity (default BLOCKING), the ticket sentence they quote (`specSentence`) and the choice number the record cites with `--on-choice` */
  severity?: string; sentence?: string; onChoice?: number;
  /** `changes` step (#680): the contracts of the plan this reviewer finds UNMET (the others it answers met) */
  unmet?: string[];
  /** `point` step (#691): the ticket the open point is about and its text; `approve` step: the open point numbers this approval lists as addressed */
  about?: string; text?: string; addressed?: number[] }
export interface Scenario {
  version: 1;
  run?: string;
  repo: { tickets: Array<{ id: string; dependsOn: string[]; spec: string; /** #675: the ticket's description the plan carries (default: one line, no criteria) */ specText?: string }>; plan?: Plan; /** #680: the contracts the plan carries (owner / consumers are scenario tickets) */ contracts?: Array<{ id: string; owner: string; must: string; consumers: string[] }> };
  agents?: Record<string, { implementer?: Step[]; /** the script of the 2nd+ implementer of the ticket (a respawn); default = `implementer` */ respawn?: Step[]; reviewer?: Step[] }>;
  ci?: Record<string, string[]>;
  /** #607's start check: what the checks of the EMPTY probe PR say — `green` (default) | `red:<check>` | `missing` (no check at all) */
  startCheck?: string;
  admissionHold?: Record<string, number>;
  events?: Record<string, Array<{ at: string; kind: 'question' | 'no-safe-option'; /** the ask's exact body (default: a well-formed one) */ body?: string }>>;
  /** the state already holds a COMPLETE plan written by hand (no `loopPlan` marker) when the loop starts: `stepPlan` adopts it and starts */
  prePlanned?: boolean;
  faults?: { stealMail?: boolean; /** tickets whose agent never records `--follows` before it nominates */ noFollows?: string[]; /** ticket → ms after its CI starts before the `build`/`test` checks register (only `lint` exists before) */ noChecks?: string[]; lateCheck?: Record<string, number>; /** tickets whose green checks report 0 steps */ zeroStepCi?: string[]; /** #628: tickets whose merge the forge refuses with `merge-conflict` while their branch lacks the target's tip (until their `sync` step merges it in) */ conflictOnStale?: string[]; /** #689: tickets whose PR READS `mergeable: CONFLICTING` while their branch lacks the target's tip — and, as on GitHub, no Actions run starts on it (only an external check shows) */ conflictVisible?: string[]; /** #625: the plan is NOT handed to the loop — the planner port (the plan agent) writes it */ viaPlanner?: boolean; /** the HOST's hard pause of the run (a 429 on the pool, a human): from `afterMs` every agent is frozen (steps and reviews wait, a message to it is parked) until `afterMs + forMs` (the auto-resume); `forMs` null = never lifted */ pause?: Array<{ afterMs: number; forMs: number | null; by?: string }> };
  timing?: { codeMs?: number; nominateMs?: number; connectMs?: number; reviewMs?: number; ciMs?: number };
}

const dummyIsObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export function parseScenario(raw: unknown): Scenario {
  const bad = (m: string): never => { throw new FanoutStateError(`scenario: ${m}`); };
  if (!dummyIsObj(raw) || raw.version !== 1) return bad('version must be 1');
  if (!dummyIsObj(raw.repo) || !Array.isArray(raw.repo.tickets) || raw.repo.tickets.length === 0) return bad('repo.tickets must be a non-empty list');
  const ids = new Set<string>();
  for (const t of raw.repo.tickets as unknown[]) {
    if (!dummyIsObj(t) || typeof t.id !== 'string' || !Array.isArray(t.dependsOn) || typeof t.spec !== 'string') return bad('a repo ticket is {id, dependsOn[], spec}');
    ids.add(t.id);
  }
  for (const t of raw.repo.tickets as Array<{ id: string; dependsOn: string[] }>) for (const d of t.dependsOn) if (!ids.has(d)) return bad(`${t.id} depends on unknown ${d}`);
  const steps = (v: unknown, kinds: readonly string[], where: string): void => {
    if (v === undefined) return;
    if (!Array.isArray(v)) return bad(`${where} must be a list of steps`);
    for (const s of v) if (!dummyIsObj(s) || typeof s.do !== 'string' || !kinds.includes(s.do)) bad(`${where}: a step is {do: ${kinds.join('|')}, afterMs?, findings?, head?}`);
  };
  for (const [tk, a] of Object.entries(dummyIsObj(raw.agents) ? raw.agents : {})) {
    if (!ids.has(tk)) return bad(`agents.${tk} is not a ticket`);
    if (!dummyIsObj(a)) return bad(`agents.${tk} must be an object`);
    steps(a.implementer, STEP_KINDS_IMPLEMENTER, `agents.${tk}.implementer`);
    steps(a.respawn, STEP_KINDS_IMPLEMENTER, `agents.${tk}.respawn`);
    steps(a.reviewer, STEP_KINDS_REVIEWER, `agents.${tk}.reviewer`);
  }
  if (raw.startCheck !== undefined && !(typeof raw.startCheck === 'string' && /^(green|missing|red:\S+)$/.test(raw.startCheck))) return bad('startCheck is "green" | "missing" | "red:<check>"');
  for (const [tk, list] of Object.entries(dummyIsObj(raw.ci) ? raw.ci : {})) {
    if (tk !== '*' && !ids.has(tk)) return bad(`ci.${tk} is not a ticket`);
    if (!Array.isArray(list) || list.some((x) => x !== 'green' && !(typeof x === 'string' && /^red:\S+$/.test(x)))) return bad(`ci.${tk} is a list of "green" | "red:<check>"`);
  }
  for (const [tk, list] of Object.entries(dummyIsObj(raw.events) ? raw.events : {})) {
    if (!ids.has(tk)) return bad(`events.${tk} is not a ticket`);
    if (!Array.isArray(list) || list.some((e) => !dummyIsObj(e) || typeof e.at !== 'string' || (e.kind !== 'question' && e.kind !== 'no-safe-option'))) return bad(`events.${tk} is a list of {at, kind: question|no-safe-option}`);
  }
  return raw as unknown as Scenario;
}

/** The plan #604's agent would write: one interface per depended-on ticket, holding an exact name. */
export function planOf(sc: Scenario): Plan {
  if (sc.repo.plan) return sc.repo.plan;
  const depended = new Set(sc.repo.tickets.flatMap((t) => t.dependsOn));
  const contracts = sc.repo.contracts ?? [];
  const shared = (a: string, b: string): boolean => contracts.some((c) => [c.owner, ...c.consumers].includes(a) && [c.owner, ...c.consumers].includes(b));
  const none = sc.repo.tickets.flatMap((t) => t.dependsOn.filter((d) => !shared(d, t.id)).map((d) => `${d}-${t.id}`)); // #682: a dummy edge with no contract is stated to share none
  return { version: 1, tickets: sc.repo.tickets.map((t) => ({ id: t.id, title: t.id, spec: t.spec, specText: t.specText ?? `Dummy ticket ${t.id} (${t.spec}).`, dependsOn: t.dependsOn })), interfaces: Object.fromEntries([...depended].map((d) => [d, `\`${d}.api\` — kind: function; shape: () => void; where: src/${d}.ts`])), ...(contracts.length ? { contracts } : {}), ...(none.length ? { noSharedBehaviour: [...new Set(none)] } : {}) };
}

const DUMMY_TIMING = { codeMs: 180_000, nominateMs: 30_000, connectMs: 120_000, reviewMs: 300_000, ciMs: 240_000 };
const DUMMY_EPOCH = Date.parse('2026-01-01T00:00:00Z');
const DUMMY_CHECK_NAMES = ['build', 'test', 'lint'];
const dummySha = (label: string): string => crypto.createHash('sha1').update(label).digest('hex');
const dummySameSha = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

interface Commit { parents: string[]; tree: string; at: number }
interface Pr { n: number; ticket: string; branch: string; state: 'open' | 'merged' | 'closed'; mergedHead?: string; openedAt: number; runs: Array<{ head: string; startedAt: number; doneAt: number; result: string }>; created: number }
interface Impl { ws: string; ticket: string; branch: string; steps: Step[]; idx: number; mode: 'held' | 'running' | 'asking' | 'connect' | 'stuck' | 'done'; asks: Array<{ up: string; head: string }>; syncs: number; points: number; fired: Set<string>; heldTicks: number; /** idle-rule: the last time the agent did anything (a step, a wake it read) — its idle clock when no step is pending */ lastActive: number }
interface Rev { ws: string; ticket: string; steps: Step[]; idx: number; armed: boolean; lastActive: number }

export class DummyWorld {
  t = DUMMY_EPOCH;
  events: Ev[] = [];
  readonly commits = new Map<string, Commit>();
  readonly branches = new Map<string, string>();
  readonly prs = new Map<number, Pr>();
  readonly impls = new Map<string, Impl>();
  readonly revs = new Map<string, Rev>();
  private revCursor = new Map<string, number>();
  private mailbox: Array<LoopMail & { read: boolean }> = [];
  private timers: Array<{ at: number; n: number; fn: () => void }> = [];
  private n = 0;
  private counter = 0;
  readonly home: string;
  readonly run: string;
  readonly sc: Scenario;
  readonly target: string;
  constructor(home: string, run: string, sc: Scenario, target = 'main') {
    this.home = home; this.run = run; this.sc = sc; this.target = target;
    const root = this.commit([], 'root', 'root');
    this.branches.set(target, root);
    for (const p of sc.faults?.pause ?? []) {
      this.after(p.afterMs, () => { this.paused = true; this.pauseBy = p.by ?? 'host:usage_limit'; this.pauseSince = this.t; this.ev('host-pause', undefined, { by: this.pauseBy }); });
      if (p.forMs !== null) this.after(p.afterMs + p.forMs, () => { this.paused = false; this.ev('host-resume', undefined, {}); const parked = this.parked.splice(0); for (const f of parked) f(); });
    }
  }
  /** the host pause of the run: agents are frozen, messages to them parked until the lift */
  paused = false;
  pauseBy = 'host:usage_limit';
  pauseSince = 0;
  private parked: Array<() => void> = [];
  /** the loop acted on the fleet while the run was paused (spawn / wake / replace / release): the rule says it never does */
  private actedWhilePaused(what: string, ticket: string | undefined): void { if (this.paused) this.ev('act-while-paused', ticket, { what }); }
  get timing(): typeof DUMMY_TIMING { return { ...DUMMY_TIMING, ...(this.sc.timing ?? {}) }; }
  iso(t = this.t): string { return new Date(t).toISOString(); }
  ev(ev: string, ticket: string | undefined, extra: Record<string, unknown> = {}): void { this.events.push({ t: this.t, ev, ...(ticket ? { ticket } : {}), ...extra }); }
  commit(parents: string[], label: string, tree: string): string {
    const id = dummySha(`${this.counter++}:${label}`);
    this.commits.set(id, { parents, tree: dummySha(`tree:${parents.map((p) => this.commits.get(p)?.tree ?? '').join(',')}:${tree}`), at: this.t });
    return id;
  }
  resolve(ref: string): string | null { return this.branches.get(ref) ?? (this.commits.has(ref) ? ref : null); }
  contains(x: string, base: string): boolean {
    const want = this.resolve(x), from = this.resolve(base);
    if (!want || !from) return false;
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) { const c = stack.pop()!; if (c === want) return true; if (seen.has(c)) continue; seen.add(c); stack.push(...(this.commits.get(c)?.parents ?? [])); }
    return false;
  }
  after(ms: number, fn: () => void): void { this.timers.push({ at: this.t + ms, n: this.n++, fn }); }
  /** Run everything due up to `t + ms`, in time order; the clock ends at the target. */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.n - b.n);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = target;
  }
  /** One loop sleep = one Admission tick for every held start. */
  tickHolds(): void { for (const a of this.impls.values()) if (a.mode === 'held' && --a.heldTicks <= 0) this.begin(a); }

  // ── mail ──
  post(kind: string, sender: string, ticket: string | null, body: string): void {
    const seq = this.mailbox.length + 1;
    if (this.sc.faults?.stealMail) { this.ev('mail-read', ticket ?? undefined, { reader: 'thief', seq, kind }); this.mailbox.push({ seq, kind, sender, ticket, body, read: true }); return; }
    this.mailbox.push({ seq, kind, sender, ticket, body, read: false });
    this.ev('mail-posted', ticket ?? undefined, { seq, kind, sender, body: body.split('\n')[0] });
  }
  /** Unread = not ACKED: a message the loop was handed stays here until `ackMail` (a kill mid-batch loses nothing). */
  drainMail(): LoopMail[] {
    const out = this.mailbox.filter((m) => !m.read);
    for (const m of out) this.ev('mail-read', m.ticket ?? undefined, { reader: 'loop', seq: m.seq, kind: m.kind });
    return out.map(({ read: _r, ...m }) => m);
  }
  ackMail(upTo: number): void { for (const m of this.mailbox) if (m.seq <= upTo) m.read = true; }

  // ── implementers ──
  private spawns = new Map<string, number>();
  scriptOf(ticket: string): Step[] {
    const nth = (this.spawns.get(ticket) ?? 0) + 1;
    this.spawns.set(ticket, nth);
    const given = (nth > 1 ? this.sc.agents?.[ticket]?.respawn : undefined) ?? this.sc.agents?.[ticket]?.implementer;
    if (given) return given;
    const deps = this.sc.repo.tickets.find((t) => t.id === ticket)?.dependsOn ?? [];
    return [{ do: 'code' }, { do: 'nominate' }, ...deps.map((): Step => ({ do: 'connect' }))];
  }
  spawnImpl(ticket: string, branch: string, briefHasLoop = false): { ws: string; held: boolean } {
    this.actedWhilePaused('spawn', ticket);
    const ws = `ws-${branch}`;
    if (!this.branches.has(branch)) this.branches.set(branch, this.branches.get(this.target)!);
    const hold = this.sc.admissionHold?.[ticket] ?? 0;
    const a: Impl = { ws, ticket, branch, steps: this.scriptOf(ticket), idx: 0, mode: hold > 0 ? 'held' : 'running', asks: [], syncs: 0, points: 0, fired: new Set(), heldTicks: hold, lastActive: this.t };
    this.impls.set(ws, a);
    this.ev('spawn', ticket, { ws, branch, held: hold > 0, briefHasLoop });
    if (!hold) this.begin(a);
    return { ws, held: hold > 0 };
  }
  begin(a: Impl): void { a.lastActive = this.t; a.mode = 'running'; this.ev('begin', a.ticket, { ws: a.ws }); this.arm(a); }
  private arm(a: Impl): void {
    const step = a.steps[a.idx];
    if (!step) { a.mode = 'done'; return; }
    const dflt = step.do === 'code' || step.do === 'fix' || step.do === 'address' ? this.timing.codeMs : step.do === 'connect' || step.do === 'sync' ? this.timing.connectMs : this.timing.nominateMs;
    this.after(step.afterMs ?? dflt, () => this.runStep(a));
  }
  private commitOn(a: Impl, label: string): string {
    const head = this.branches.get(a.branch)!;
    const c = this.commit([head], `${a.branch}:${label}`, `${a.ticket}:${label}`);
    this.branches.set(a.branch, c);
    return c;
  }
  runStep(a: Impl): void {
    if (a.mode !== 'running') return;
    if (this.paused) { this.after(10_000, () => this.runStep(a)); return; } // frozen by the host pause
    const step = a.steps[a.idx];
    if (!step) { a.mode = 'done'; return; }
    const evt = this.sc.events?.[a.ticket]?.find((e) => e.at === step.do && !a.fired.has(`${e.at}:${e.kind}`));
    if (evt) {
      a.fired.add(`${evt.at}:${evt.kind}`);
      if (evt.kind === 'no-safe-option') { this.post('ask', a.ws, a.ticket, evt.body ?? `${'NO SAFE OPTION: '}the spec of ${a.ticket} contradicts itself`); this.ev('ask', a.ticket, { kind: 'no-safe-option', ws: a.ws }); a.mode = 'asking'; return; } // #645: the loop no longer reads the marker — the agent gets the fixed answer and goes on
      this.post('ask', a.ws, a.ticket, evt.body ?? `Which of the two names should ${a.ticket} use?`); this.ev('ask', a.ticket, { kind: 'question', ws: a.ws }); a.mode = 'asking'; return;
    }
    switch (step.do) {
      case 'wait': {
        const deps = this.sc.repo.tickets.find((t) => t.id === a.ticket)?.dependsOn ?? [];
        const merged = (u: string): boolean => this.events.some((e) => e.ev === 'merge' && e.ticket === u);
        if (!deps.every(merged)) { this.after(30_000, () => this.runStep(a)); return; }
        break;
      }
      case 'die': { this.impls.delete(a.ws); this.ev('impl-died', a.ticket, { ws: a.ws }); return; }
      case 'choice': {
        updateLoopState(this.home, this.run, (cur) => withLoop(recordImplementerChoice(cur!, a.ticket, { question: step.question ?? 'which option?', taken: step.taken ?? 'the reversible one', ...(step.narrows !== undefined ? { narrows: step.narrows } : {}), callerId: a.ws, callerVouched: true, now: this.iso() }), cur!.loop));
        this.ev('choice', a.ticket, { ws: a.ws, narrows: step.narrows ?? null });
        break;
      }
      case 'code': { const c = this.commitOn(a, `code${a.idx}`); this.ev('code', a.ticket, { head: c }); break; }
      case 'fix': { const c = this.commitOn(a, `fix${a.idx}`); this.ev('fix', a.ticket, { head: c }); this.post('status', a.ws, a.ticket, `fixed — head ${c}`); break; }
      case 'nominate': {
        const deps = this.sc.repo.tickets.find((t) => t.id === a.ticket)?.dependsOn ?? [];
        if (deps.length && !this.sc.faults?.noFollows?.includes(a.ticket)) updateLoopState(this.home, this.run, (cur) => withLoop(applyTicketPatch(cur!, a.ticket, { follows: Object.fromEntries(deps.map((d) => [d, cur!.tickets[d].iface?.version ?? 1])) }, this.iso()), cur!.loop)); // what a real implementer records before it nominates (`state set --follows`)
        this.ev('nominate', a.ticket, { head: this.branches.get(a.branch) }); this.post('status', a.ws, a.ticket, `nominated ${a.branch}`); break; }
      case 'connect': {
        const ask = a.asks.shift();
        if (!ask) { a.mode = 'connect'; return; }
        const head = this.branches.get(a.branch)!;
        const c = this.commit([head, ask.head], `${a.branch}:connect:${ask.up}`, `${a.ticket}+${ask.up}`);
        this.branches.set(a.branch, c);
        this.ev('connect-done', a.ticket, { up: ask.up, asked: ask.head, head: c });
        this.post('status', a.ws, a.ticket, `connected to ${ask.up} — head ${c}`);
        break;
      }
      case 'point': { // #691: `fanout open-point <this ticket> --about <about> --text <t>`, raised by the ticket's own implementer
        updateLoopState(this.home, this.run, (cur) => withLoop(recordOpenPoint(cur!, a.ticket, { about: step.about ?? '', text: step.text ?? `${a.ticket} needs ${step.about} to do the thing`, callerId: a.ws, callerVouched: true, now: this.iso() }).state, cur!.loop));
        this.ev('point', a.ticket, { ws: a.ws, about: step.about });
        break;
      }
      case 'address': { // #691: waits for the loop's OPEN POINT order, then pushes the head that addresses it
        if (a.points <= 0) { a.mode = 'connect'; return; }
        a.points--;
        const c = this.commitOn(a, `address${a.idx}`);
        this.ev('point-fix', a.ticket, { head: c });
        this.post('status', a.ws, a.ticket, `addressed the open point — head ${c}`);
        break;
      }
      case 'retree': { // #637: a new commit that adds NOTHING (a merge of what the branch already holds): another sha, the SAME git tree — the recorded verdict still covers it (#512)
        const head = this.branches.get(a.branch)!;
        const c = this.commit([head], `${a.branch}:retree${a.idx}`, 'retree');
        this.commits.get(c)!.tree = this.commits.get(head)!.tree;
        this.branches.set(a.branch, c);
        this.ev('retree', a.ticket, { head: c, from: head });
        this.post('status', a.ws, a.ticket, `re-connected, same content — head ${c}`);
        break;
      }
      case 'sync': { // #628: the SYNC order — the target merged into the branch with a MERGE COMMIT, pushed, the new head reported
        if (a.syncs <= 0) { a.mode = 'connect'; return; }
        a.syncs--;
        const head = this.branches.get(a.branch)!;
        const c = this.commit([head, this.branches.get(this.target)!], `${a.branch}:sync`, `${a.ticket}+${this.target}`);
        this.branches.set(a.branch, c);
        this.ev('sync-done', a.ticket, { head: c });
        this.post('status', a.ws, a.ticket, `synced with ${this.target} — head ${c}`);
        break;
      }
      default: break; // reviewer steps in an implementer script are refused by parseScenario
    }
    a.idx++;
    a.mode = 'running';
    a.lastActive = this.t;
    this.arm(a);
  }
  /** idle-rule: ms the agent has been idle (alive, no step pending, nothing running) — null while it is running a step; the loop's `idleFor`. */
  idleFor(ws: string): number | null {
    const a = this.impls.get(ws);
    if (a) {
      if ((a.mode === 'running' && !this.paused) || a.mode === 'held') return null; // a paused member's turn was interrupted: it reads idle (the bug this rig pins is the loop acting on that)
      const rest = a.steps.slice(a.idx).map((x) => x.do);
      if ((a.syncs > 0 && rest.includes('sync')) || (a.points > 0 && rest.includes('address')) || (a.asks.length > 0 && rest.includes('connect'))) return null; // an order its script will act on is QUEUED for it, as a real host reads it (idleReading)
      return this.t - a.lastActive;
    }
    const r = this.revs.get(ws);
    return r ? (r.armed && !this.paused ? null : this.t - r.lastActive) : null;
  }
  /** idle-rule: the loop ends a silent reviewer on purpose (the host archives it). */
  releaseReviewer(ticket: string): void { this.actedWhilePaused('release-reviewer', ticket); for (const [ws, r] of this.revs) if (r.ticket === ticket) { this.revs.delete(ws); this.ev('review-released', ticket, { ws }); } }
  /** The loop's ask to connect (a wake) reaches the agent. */
  wakeImpl(ws: string, text: string): void {
    if (this.paused) { this.actedWhilePaused('wake', this.impls.get(ws)?.ticket ?? this.revs.get(ws)?.ticket); this.parked.push(() => this.wakeImpl(ws, text)); return; } // a message to a paused member is parked until the lift
    const rv = this.revs.get(ws);
    if (rv) { // idle-rule: the loop's REMINDER to a silent reviewer: it reads it (its idle clock restarts) and goes on with its next scripted step
      rv.lastActive = this.t;
      this.ev('review-reminder', rv.ticket, { ws, text: text.split('\n')[0] });
      this.armReview(rv);
      return;
    }
    const a = this.impls.get(ws);
    if (!a) return;
    a.lastActive = this.t;
    if (/^Corrections for /.test(text)) { this.ev('corrections-batch', a.ticket, { ws, text }); return; } // #606: ONE batch to the author (the dummy author's script says what it does next)
    if (/^CI is red on your pull request/.test(text)) { this.ev('ci-told', a.ticket, { ws, text }); return; } // #607: the author is told which check is red (the dummy author does not react: its script says what it does next)
    if (/^(SYNC|FIX) /.test(text)) { // #628: a delivery refusal order — the author acts on it only when its script has a `sync` step left
      this.ev('sync-order', a.ticket, { ws, text: text.split('\n')[0] });
      a.syncs++;
      if (a.mode === 'connect') { a.mode = 'running'; this.after(1_000, () => this.runStep(a)); }
      return;
    }
    if (/^OPEN POINT /.test(text)) { // #676: the order to the `about` ticket's implementer — it acts on it only when its script has an `address` step left
      this.ev('point-order', a.ticket, { ws, text: text.split('\n')[0] });
      a.points++;
      if (a.mode === 'connect') { a.mode = 'running'; this.after(1_000, () => this.runStep(a)); }
      return;
    }
    const m = /^CONNECT (\S+) ([0-9a-f]{40})/.exec(text);
    if (!m) return;
    this.ev('connect-ask', a.ticket, { up: m[1], head: m[2], to: ws });
    a.asks.push({ up: m[1], head: m[2] });
    if (a.mode === 'connect') { a.mode = 'running'; this.after(1_000, () => this.runStep(a)); }
  }
  answerImpl(ws: string, text: string): void {
    const a = this.impls.get(ws);
    this.ev('send', a?.ticket, { to: ws, kind: 'answer', text });
    if (a && a.mode === 'asking') { a.mode = 'running'; this.ev('answered', a.ticket, {}); this.after(10_000, () => this.runStep(a)); }
  }

  // ── reviewers ──
  spawnReviewer(ticket: string, head: string): { id: string } {
    this.actedWhilePaused('review-spawn', ticket);
    const now = this.iso();
    const res: { id: string; act: 'spawn' | 'replace' | 'wake' | 'noop' } = { id: '', act: 'noop' };
    updateLoopState(this.home, this.run, (cur) => {
      const s = cur!;
      const t = s.tickets[ticket];
      const d = decideReview(t, head, now, (x) => this.revs.has(x));
      res.act = d.action;
      if (d.action === 'noop') { res.id = d.id ?? ''; return s; }
      if (d.action === 'wake') { res.id = t.review!.reviewer!.id!; return withLoop(recordWake(s, ticket, { head, base: null, text: 'dummy delta brief', now }), s.loop); }
      const name = reviewerName(ticket, nthReviewer(t));
      res.id = `ws-${name}`;
      return withLoop(settleReviewer(claimReviewer(s, ticket, { kind: d.action, name, head, base: null, text: 'dummy brief', now }), ticket, { id: res.id }, now), s.loop);
    });
    const { id, act } = res;
    if (act === 'spawn' || act === 'replace') {
      const steps = this.sc.agents?.[ticket]?.reviewer ?? [];
      this.revs.set(id, { ws: id, ticket, steps, idx: this.revCursor.get(ticket) ?? 0, armed: false, lastActive: this.t }); // a replacement reviewer carries on the ticket's script
      this.ev('review-spawn', ticket, { ws: id, head, action: act });
    } else if (act === 'wake') this.ev('review-wake', ticket, { ws: id, head });
    const r = this.revs.get(id);
    if (r && act !== 'noop') this.armReview(r);
    return { id };
  }
  private armReview(r: Rev): void {
    if (r.armed) return;
    r.armed = true;
    const fire = (): void => { if (this.paused) { this.after(10_000, fire); return; } r.armed = false; r.lastActive = this.t; this.reviewStep(r); }; // frozen by the host pause: the review waits
    this.after(r.steps[r.idx]?.afterMs ?? this.timing.reviewMs, fire);
  }
  private reviewStep(r: Rev): void {
    const s = readLoopState(this.home, this.run)!;
    const t = s.tickets[r.ticket];
    const head = reviewHeadOf(t);
    if (!head) return;
    const step = r.steps[r.idx] ?? { do: 'approve' as const };
    r.idx++;
    this.revCursor.set(r.ticket, r.idx);
    if (step.do === 'die') { this.revs.delete(r.ws); this.ev('review-died', r.ticket, { ws: r.ws }); return; }
    if (step.do === 'silent') { this.ev('review-silent', r.ticket, { ws: r.ws }); return; }
    const open = Object.entries(t.findings).filter(([, f]) => !f.settled && !f.decision && f.onChoice === undefined).map(([id]) => id);
    const findings = step.do === 'changes' ? Object.fromEntries((step.findings ?? (step.unmet ? [] : ['F1'])).map((id) => [id, { severity: step.severity ?? 'BLOCKING', evidence: 'argued', ...(step.sentence !== undefined ? { text: 'the scripted challenge of a choice', specSentence: step.sentence } : {}), ...(step.severity === undefined || step.severity === 'BLOCKING' || step.severity === 'MAJOR' ? { report: { input: 'the scripted input', happens: 'the scripted failure', where: 'src/x.ts:1', proof: 'scripted' } } : {}) }])) : {};
    const nCriteria = criteriaLines(effectiveSpec(s, t).specText).length;
    const criteria = nCriteria ? Object.fromEntries(Array.from({ length: nCriteria }, (_, k) => [String(k + 1), 'met' as const])) : undefined; // the dummy reviewer finds every numbered criterion met (a scenario that needs `unmet` scripts findings instead)
    const mine = contractsOf(s, r.ticket); // #680: a dummy reviewer answers every contract of its ticket (met, unless its script says unmet; a consumer's met carries an evidence line)
    const contracts = mine.length ? Object.fromEntries(mine.map((x) => [x.c.id, step.do === 'changes' && step.unmet?.includes(x.c.id) ? 'unmet' as const : 'met' as const])) : undefined;
    const contractEvidence = mine.length ? Object.fromEntries(mine.filter((x) => x.role === 'consumer' && contracts![x.c.id] === 'met').map((x) => [x.c.id, `src/${r.ticket}.ts:1`])) : undefined;
    const onChoice = step.do === 'changes' && step.onChoice !== undefined ? Object.fromEntries((step.findings ?? ['F1']).map((id) => [id, step.onChoice!])) : undefined;
    const tree = this.commits.get(head)?.tree ?? null;
    try {
      updateLoopState(this.home, this.run, (cur) => withLoop(recordReview(cur!, r.ticket, { head, verdict: step.do === 'changes' ? 'changes-requested' : 'approve', input: { findings: findings as never, fixed: step.do === 'approve' ? open : [], ...(step.do === 'approve' && step.addressed?.length ? { addressed: step.addressed } : {}), ...(criteria ? { criteria } : {}), ...(contracts ? { contracts } : {}), ...(contractEvidence && Object.keys(contractEvidence).length ? { contractEvidence } : {}) }, callerId: r.ws, callerVouched: true, tree, now: this.iso(), ...(onChoice ? { onChoice } : {}) }), cur!.loop));
      this.ev('review-record', r.ticket, { ws: r.ws, head, tree, verdict: step.do === 'changes' ? 'changes-requested' : 'approve' });
      this.post('worker_done', r.ws, r.ticket, `recorded ${step.do} on ${head}`);
    } catch (e) { this.ev('review-error', r.ticket, { error: e instanceof Error ? e.message : String(e) }); }
  }

  // ── forge ──
  openPr(branch: string, ticket: string): number {
    for (const p of this.prs.values()) if (p.branch === branch) return p.n;
    const n = this.prs.size + 1;
    this.prs.set(n, { n, ticket, branch, state: 'open', openedAt: this.t, runs: [], created: 0 });
    this.ev('pr-open', ticket, { n, branch });
    return n;
  }
  private ciResult(p: Pr): string {
    if (p.branch.startsWith('orchestra-start-check-')) return this.sc.startCheck ?? 'green';
    const list = this.sc.ci?.[p.ticket] ?? this.sc.ci?.['*'] ?? [];
    return list[p.created++] ?? 'green';
  }
  private runFor(p: Pr, head: string, fresh = false): Pr['runs'][number] {
    const existing = [...p.runs].reverse().find((r) => r.head === head);
    if (existing && !fresh) return existing;
    const startedAt = fresh ? this.t : Math.max(this.commits.get(head)?.at ?? this.t, p.openedAt);
    const run = { head, startedAt, doneAt: startedAt + this.timing.ciMs, result: this.ciResult(p) };
    p.runs.push(run);
    this.ev('ci-start', p.ticket, { n: p.n, head, doneAt: run.doneAt, result: run.result });
    return run;
  }
  /** #689: what the forge says of the PR's mergeability — CONFLICTING for a `conflictVisible` ticket whose branch lacks the target's tip */
  mergeableOf(p: Pr): 'MERGEABLE' | 'CONFLICTING' {
    return p.state === 'open' && !!this.sc.faults?.conflictVisible?.includes(p.ticket) && !this.contains(this.branches.get(this.target)!, this.branches.get(p.branch)!) ? 'CONFLICTING' : 'MERGEABLE';
  }
  checks(n: number, head: string): ForgeCheck[] {
    const p = this.prs.get(n)!;
    if (this.mergeableOf(p) === 'CONFLICTING') return [{ name: 'vercel', status: 'green' }]; // no merge ref → no Actions run, only an external status (steps unknown)
    const run = this.runFor(p, head);
    const steps = this.sc.faults?.zeroStepCi?.includes(p.ticket) ? 0 : 3;
    if (this.sc.faults?.noChecks?.includes(p.ticket) || (p.branch.startsWith('orchestra-start-check-') && this.sc.startCheck === 'missing')) return []; // the forge shows no check at all
    const late = this.sc.faults?.lateCheck?.[p.ticket];
    const lint: ForgeCheck = { name: 'lint', jobId: `job-${p.n}-${p.runs.indexOf(run)}-lint`, status: 'green', steps, at: this.iso(run.startedAt) };
    if (late !== undefined && this.t < run.startedAt + late) return [lint]; // the workflow has not registered its other checks yet
    if (this.t < run.doneAt) return DUMMY_CHECK_NAMES.map((name) => (name === 'lint' ? lint : { name, jobId: `job-${p.n}-${p.runs.indexOf(run)}-${name}`, status: 'pending' as const }));
    const red = run.result.startsWith('red:') ? run.result.slice(4) : null;
    return DUMMY_CHECK_NAMES.map((name) => ({ name, jobId: `job-${p.n}-${p.runs.indexOf(run)}-${name}`, steps, status: name === red || (red && !DUMMY_CHECK_NAMES.includes(red) && name === 'test') ? ('red' as const) : ('green' as const), at: this.iso(run.doneAt), ...(name === red ? { logExtract: `FAIL ${name}` } : {}) }));
  }
  closePr(n: number): void { const p = this.prs.get(n); if (p && p.state === 'open') { p.state = 'closed'; this.ev('pr-close', p.ticket, { n }); } }
  rerun(n: number): void { const p = this.prs.get(n)!; this.runFor(p, this.branches.get(p.branch)!, true); }
  merge(n: number, matchHead: string, method: string): { ok: boolean; reason?: string; detail?: string } {
    const p = this.prs.get(n)!;
    if (method !== 'merge') { this.ev('merge-refused', p.ticket, { n, method }); return { ok: false, reason: `method ${method}: only a merge commit keeps the dependents' history (squash/rebase rewrite it)` }; }
    const head = this.branches.get(p.branch)!;
    if (p.state !== 'open') return { ok: false, reason: `the PR is ${p.state}` };
    if ((this.sc.faults?.conflictOnStale?.includes(p.ticket) || this.mergeableOf(p) === 'CONFLICTING') && !this.contains(this.branches.get(this.target)!, head)) { this.ev('merge-refused', p.ticket, { n, reason: 'merge-conflict' }); return { ok: false, reason: 'merge-conflict', detail: 'the branch lacks the target tip' }; }
    if (!dummySameSha(head, matchHead)) return { ok: false, reason: 'head-moved' };
    const run = [...p.runs].reverse().find((r) => r.head === head);
    const ci = !run ? 'none' : this.t < run.doneAt ? 'pending' : run.result;
    const c = this.commit([this.branches.get(this.target)!, head], `merge:${p.ticket}`, `merge:${p.ticket}`);
    this.branches.set(this.target, c);
    p.state = 'merged';
    p.mergedHead = head;
    this.ev('merge', p.ticket, { n, head, tree: this.commits.get(head)?.tree, ci, commit: c });
    return { ok: true };
  }
  dump(): void {
    const file = path.join(this.home, 'fanout-dummy', `${this.run}.events.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ run: this.run, endedAt: this.t, events: this.events }, null, 1)}\n`);
  }
}

export interface Dummy { world: DummyWorld; fleet: FleetPort; forge: ForgePort; git: GitPort; now(): string; sleep(ms: number): Promise<void>; plan: Plan }

/** Wire the world to the three ports. `caller` = the run id (the shipped `startRun` accepts only the run's own coordinator). */
export function buildDummy(i: { home: string; run: string; scenario: Scenario; target?: string }): Dummy {
  const w = new DummyWorld(i.home, i.run, i.scenario, i.target ?? 'main');
  const plan = planOf(i.scenario);
  const ticketOfBranch = (b: string): string | null => readLoopState(i.home, i.run) ? (Object.entries(readLoopState(i.home, i.run)!.tickets).find(([, t]) => t.branch === b)?.[0] ?? null) : null;
  const fleet: FleetPort = {
    async start(): Promise<StartResult> {
      return startRun(i.run, i.run, {
        home: i.home, now: () => w.iso(), loop: true,
        implementerLive: (id) => w.impls.has(id),
        repoPath: () => undefined,
        spawn: async ({ name, task, reuseBranch }) => {
          const ticket = i.scenario.repo.tickets.find((t) => implementerName(t.id) === name)?.id ?? ticketOfBranch(name) ?? null;
          if (!ticket) return { ok: false, error: `the dummy fleet knows no ticket for ${name}` };
          const r = w.spawnImpl(ticket, reuseBranch ? name : name, task.includes(LOOP_BRIEF));
          return { ok: true, id: r.ws, branch: name, ...(r.held ? { held: { since: w.t } } : {}) };
        },
      });
    },
    live: (ws) => w.impls.has(ws) || w.revs.has(ws),
    idleFor: (ws) => w.idleFor(ws),
    async replaceReviewer(ticket) { w.releaseReviewer(ticket); },
    async wake(ws, text) { w.wakeImpl(ws, text); },
    async send(to, text, kind) { if (kind === 'answer') w.answerImpl(to, text); else w.ev('send', undefined, { to, kind, text }); },
    async mail() { return w.drainMail(); },
    async ack(upTo) { w.ackMail(upTo); },
    async spawnReviewer(ticket, head) { return w.spawnReviewer(ticket, head); },
    async costOf(ticket) { return { tokens: 1000 * w.events.filter((e) => e.ticket === ticket).length }; },
    async replace(ticket) { for (const [ws, a] of w.impls) if (a.ticket === ticket) { w.impls.delete(ws); w.ev('impl-replaced', ticket, { ws }); w.paused && w.ev('act-while-paused', ticket, { what: 'replace' }); } },
    async runPause() { return w.paused ? { by: w.pauseBy, since: w.pauseSince, resuming: false } : null; },
  };
  const forge: ForgePort = {
    async openPr({ branch, title }) { const t = ticketOfBranch(branch) ?? title.split(':')[0]; return { n: w.openPr(branch, t) }; },
    async prState(n) { const p = w.prs.get(n)!; return { state: p.state, head: p.mergedHead ?? w.branches.get(p.branch)!, mergeable: w.mergeableOf(p) }; },
    async checks(n, head) { return w.checks(n, head); },
    async rerun(n) { w.rerun(n); },
    async merge(n, matchHead, method) { return w.merge(n, matchHead, method); },
    async close(n) { w.closePr(n); },
  };
  const git: GitPort = {
    async head(branch) { return w.branches.get(branch) ?? null; },
    async tree(s) { return w.commits.get(w.resolve(s) ?? '')?.tree ?? null; },
    async isMerged(branch, base) { return w.contains(branch, base); },
    async emptyBranch(branch, base) { const h = w.resolve(base)!; w.branches.set(branch, h); return { head: h }; },
    async deleteBranch(branch) { w.branches.delete(branch); w.ev('branch-delete', undefined, { branch }); },
  };
  return { world: w, fleet, forge, git, now: () => w.iso(), plan, async sleep(ms) { w.tickHolds(); w.advance(ms); } };
}

export interface DummyRun { result: LoopResult; violations: Violation[]; world: DummyWorld; log: string[] }
/** The whole seam in one call: seed, run the loop on the dummy fleet, judge the event log, dump it. The CLI (`fanout run --scenario`) and the tests both go through here. */
export async function runDummyLoop(i: { home: string; run?: string; scenario: Scenario; options?: Partial<LoopOptions>; wrap?: (d: Dummy) => Dummy }): Promise<DummyRun> {
  const run = i.run ?? i.scenario.run ?? 'dummy-run';
  let d = buildDummy({ home: i.home, run, scenario: i.scenario });
  if (i.wrap) d = i.wrap(d);
  if (i.scenario.prePlanned) { // a plan written by hand (#587 `state set`), not by #604: complete, with NO `loopPlan` marker
    updateLoopState(i.home, run, () => { const { loopPlan: _m, ...hand } = applyPlan(newState(run, { target: 'main', switches: { seatRecords: 'on', minorPolicy: 'demonstrated', verifier: 'off' }, now: d.now() }), d.plan, d.now()); return withLoop(hand); });
  }
  const log: string[] = [];
  const viaPlanner = !!i.scenario.faults?.viaPlanner;
  const options: LoopOptions = { ...DEFAULT_OPTIONS, maxPasses: 2500, plan: viaPlanner ? null : d.plan, tickets: i.scenario.repo.tickets.map((t) => t.id), ...(i.options ?? {}) };
  // #625: what `orchestra fanout plan` does for the loop — the plan agent writes the plan (virtual time passes), the state records it, the agent is released (#629)
  const planner = viaPlanner ? async (tickets: string[]): Promise<void> => {
    d.world.ev('plan-agent-spawn', undefined, { tickets });
    await d.sleep(60_000);
    updateLoopState(i.home, run, (cur) => withLoop(applyPlan(cur!, d.plan, d.now(), 1), cur!.loop));
    d.world.ev('plan-accepted', undefined, {});
    d.world.ev('plan-agent-released', undefined, {});
  } : undefined;
  const result = await runLoop({ home: i.home, run, caller: run, fleet: d.fleet, forge: d.forge, git: d.git, now: d.now, sleep: d.sleep, log: (l) => log.push(`${d.now()} ${l}`), options, ...(planner ? { planner } : {}) });
  d.world.dump();
  const s = readLoopState(i.home, run);
  const startAt: Record<string, number | null> = {};
  // the FIRST launch of each ticket (a respawn overwrites the state's `start.at`, which would read as a start AFTER the first merge)
  for (const t of i.scenario.repo.tickets) { const first = d.world.events.find((e) => e.ev === 'spawn' && e.ticket === t.id); startAt[t.id] = first ? Date.parse(d.world.iso(first.t)) : s?.tickets[t.id]?.start?.at ? Date.parse(s.tickets[t.id].start!.at) : null; }
  const violations = judgeRun({ events: d.world.events, deps: Object.fromEntries(i.scenario.repo.tickets.map((t) => [t.id, t.dependsOn])), tickets: i.scenario.repo.tickets.map((t) => t.id), startAt });
  return { result, violations, world: d.world, log };
}
export { stateFile };
