// #605 (ledger #613) — the DUMMY FLEET the loop is measured on: scripted agents, an in-memory git, a PR host and a CI, all on a VIRTUAL clock (`sleep` advances it and runs what is due), driven by `scenario.json` v1.
// The agents' effects go through the REAL modules wherever they exist (`startRun` for the launch, `decideReview`/`claimReviewer`/`recordWake` for the reviewer, `recordReview` for a verdict, `updateState` for the file):
// the only thing faked is the world around them. Every act is appended to an event log the judge (fanout-loop-judge.ts) reads. Refused unless ORCHESTRA_FANOUT_DUMMY=1 at the CLI.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FleetPort, ForgeCheck, ForgePort, GitPort, LoopMail } from './fanout-loop-ports.ts';
import { readLoopState, updateLoopState, withLoop, type Plan } from './fanout-loop-compat.ts';
import { decideReview, claimReviewer, recordWake, reviewerName, nthReviewer, settleReviewer } from './fanout-review.ts';
import { recordReview, reviewHeadOf } from './fanout-record.ts';
import { implementerName, startRun, type StartResult } from './fanout-start.ts';
import { applyTicketPatch, FanoutStateError, stateFile } from './fanout-state.ts';
import { judgeRun, type Ev, type Violation } from './fanout-loop-judge.ts';
import { DEFAULT_OPTIONS, runLoop, type LoopOptions, type LoopResult } from './fanout-loop.ts';

export const STEP_KINDS_IMPLEMENTER = ['code', 'nominate', 'fix', 'connect', 'wait'] as const;
export const STEP_KINDS_REVIEWER = ['approve', 'changes'] as const;
export interface Step { do: (typeof STEP_KINDS_IMPLEMENTER)[number] | (typeof STEP_KINDS_REVIEWER)[number]; afterMs?: number; findings?: string[]; head?: string }
export interface Scenario {
  version: 1;
  run?: string;
  repo: { tickets: Array<{ id: string; dependsOn: string[]; spec: string }>; plan?: Plan };
  agents?: Record<string, { implementer?: Step[]; reviewer?: Step[] }>;
  ci?: Record<string, string[]>;
  admissionHold?: Record<string, number>;
  events?: Record<string, Array<{ at: string; kind: 'question' | 'no-safe-option' }>>;
  faults?: { stealMail?: boolean; /** tickets whose agent never records `--follows` before it nominates */ noFollows?: string[] };
  timing?: { codeMs?: number; nominateMs?: number; connectMs?: number; reviewMs?: number; ciMs?: number };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export function parseScenario(raw: unknown): Scenario {
  const bad = (m: string): never => { throw new FanoutStateError(`scenario: ${m}`); };
  if (!isObj(raw) || raw.version !== 1) return bad('version must be 1');
  if (!isObj(raw.repo) || !Array.isArray(raw.repo.tickets) || raw.repo.tickets.length === 0) return bad('repo.tickets must be a non-empty list');
  const ids = new Set<string>();
  for (const t of raw.repo.tickets as unknown[]) {
    if (!isObj(t) || typeof t.id !== 'string' || !Array.isArray(t.dependsOn) || typeof t.spec !== 'string') return bad('a repo ticket is {id, dependsOn[], spec}');
    ids.add(t.id);
  }
  for (const t of raw.repo.tickets as Array<{ id: string; dependsOn: string[] }>) for (const d of t.dependsOn) if (!ids.has(d)) return bad(`${t.id} depends on unknown ${d}`);
  const steps = (v: unknown, kinds: readonly string[], where: string): void => {
    if (v === undefined) return;
    if (!Array.isArray(v)) return bad(`${where} must be a list of steps`);
    for (const s of v) if (!isObj(s) || typeof s.do !== 'string' || !kinds.includes(s.do)) bad(`${where}: a step is {do: ${kinds.join('|')}, afterMs?, findings?, head?}`);
  };
  for (const [tk, a] of Object.entries(isObj(raw.agents) ? raw.agents : {})) {
    if (!ids.has(tk)) return bad(`agents.${tk} is not a ticket`);
    if (!isObj(a)) return bad(`agents.${tk} must be an object`);
    steps(a.implementer, STEP_KINDS_IMPLEMENTER, `agents.${tk}.implementer`);
    steps(a.reviewer, STEP_KINDS_REVIEWER, `agents.${tk}.reviewer`);
  }
  for (const [tk, list] of Object.entries(isObj(raw.ci) ? raw.ci : {})) {
    if (tk !== '*' && !ids.has(tk)) return bad(`ci.${tk} is not a ticket`);
    if (!Array.isArray(list) || list.some((x) => x !== 'green' && !(typeof x === 'string' && /^red:\S+$/.test(x)))) return bad(`ci.${tk} is a list of "green" | "red:<check>"`);
  }
  for (const [tk, list] of Object.entries(isObj(raw.events) ? raw.events : {})) {
    if (!ids.has(tk)) return bad(`events.${tk} is not a ticket`);
    if (!Array.isArray(list) || list.some((e) => !isObj(e) || typeof e.at !== 'string' || (e.kind !== 'question' && e.kind !== 'no-safe-option'))) return bad(`events.${tk} is a list of {at, kind: question|no-safe-option}`);
  }
  return raw as unknown as Scenario;
}

/** The plan #604's agent would write: one interface per depended-on ticket, holding an exact name. */
export function planOf(sc: Scenario): Plan {
  if (sc.repo.plan) return sc.repo.plan;
  const depended = new Set(sc.repo.tickets.flatMap((t) => t.dependsOn));
  return { version: 1, tickets: sc.repo.tickets.map((t) => ({ id: t.id, title: t.id, spec: t.spec, dependsOn: t.dependsOn })), interfaces: Object.fromEntries([...depended].map((d) => [d, `\`${d}.api\` — the names ${d} provides`])) };
}

const DEFAULT_TIMING = { codeMs: 180_000, nominateMs: 30_000, connectMs: 120_000, reviewMs: 300_000, ciMs: 240_000 };
const EPOCH = Date.parse('2026-01-01T00:00:00Z');
const CHECK_NAMES = ['build', 'test', 'lint'];
const sha = (label: string): string => crypto.createHash('sha1').update(label).digest('hex');
const sameSha = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

interface Commit { parents: string[]; tree: string; at: number }
interface Pr { n: number; ticket: string; branch: string; state: 'open' | 'merged'; mergedHead?: string; openedAt: number; runs: Array<{ head: string; startedAt: number; doneAt: number; result: string }>; created: number }
interface Impl { ws: string; ticket: string; branch: string; steps: Step[]; idx: number; mode: 'held' | 'running' | 'asking' | 'connect' | 'stuck' | 'done'; asks: Array<{ up: string; head: string }>; fired: Set<string>; heldTicks: number }
interface Rev { ws: string; ticket: string; steps: Step[]; idx: number; armed: boolean }

export class DummyWorld {
  t = EPOCH;
  events: Ev[] = [];
  readonly commits = new Map<string, Commit>();
  readonly branches = new Map<string, string>();
  readonly prs = new Map<number, Pr>();
  readonly impls = new Map<string, Impl>();
  readonly revs = new Map<string, Rev>();
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
  }
  get timing(): typeof DEFAULT_TIMING { return { ...DEFAULT_TIMING, ...(this.sc.timing ?? {}) }; }
  iso(t = this.t): string { return new Date(t).toISOString(); }
  ev(ev: string, ticket: string | undefined, extra: Record<string, unknown> = {}): void { this.events.push({ t: this.t, ev, ...(ticket ? { ticket } : {}), ...extra }); }
  commit(parents: string[], label: string, tree: string): string {
    const id = sha(`${this.counter++}:${label}`);
    this.commits.set(id, { parents, tree: sha(`tree:${parents.map((p) => this.commits.get(p)?.tree ?? '').join(',')}:${tree}`), at: this.t });
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
  drainMail(): LoopMail[] {
    const out = this.mailbox.filter((m) => !m.read);
    for (const m of out) { m.read = true; this.ev('mail-read', m.ticket ?? undefined, { reader: 'loop', seq: m.seq, kind: m.kind }); }
    return out.map(({ read: _r, ...m }) => m);
  }

  // ── implementers ──
  scriptOf(ticket: string): Step[] {
    const given = this.sc.agents?.[ticket]?.implementer;
    if (given) return given;
    const deps = this.sc.repo.tickets.find((t) => t.id === ticket)?.dependsOn ?? [];
    return [{ do: 'code' }, { do: 'nominate' }, ...deps.map((): Step => ({ do: 'connect' }))];
  }
  spawnImpl(ticket: string, branch: string): { ws: string; held: boolean } {
    const ws = `ws-${branch}`;
    if (!this.branches.has(branch)) this.branches.set(branch, this.branches.get(this.target)!);
    const hold = this.sc.admissionHold?.[ticket] ?? 0;
    const a: Impl = { ws, ticket, branch, steps: this.scriptOf(ticket), idx: 0, mode: hold > 0 ? 'held' : 'running', asks: [], fired: new Set(), heldTicks: hold };
    this.impls.set(ws, a);
    this.ev('spawn', ticket, { ws, branch, held: hold > 0 });
    if (!hold) this.begin(a);
    return { ws, held: hold > 0 };
  }
  begin(a: Impl): void { a.mode = 'running'; this.ev('begin', a.ticket, { ws: a.ws }); this.arm(a); }
  private arm(a: Impl): void {
    const step = a.steps[a.idx];
    if (!step) { a.mode = 'done'; return; }
    const dflt = step.do === 'code' || step.do === 'fix' ? this.timing.codeMs : step.do === 'connect' ? this.timing.connectMs : this.timing.nominateMs;
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
    const step = a.steps[a.idx];
    if (!step) { a.mode = 'done'; return; }
    const evt = this.sc.events?.[a.ticket]?.find((e) => e.at === step.do && !a.fired.has(`${e.at}:${e.kind}`));
    if (evt) {
      a.fired.add(`${evt.at}:${evt.kind}`);
      if (evt.kind === 'no-safe-option') { this.post('ask', a.ws, a.ticket, `${'NO SAFE OPTION: '}the spec of ${a.ticket} contradicts itself`); this.ev('ask', a.ticket, { kind: 'no-safe-option', ws: a.ws }); a.mode = 'stuck'; return; }
      this.post('ask', a.ws, a.ticket, `Which of the two names should ${a.ticket} use?`); this.ev('ask', a.ticket, { kind: 'question', ws: a.ws }); a.mode = 'asking'; return;
    }
    switch (step.do) {
      case 'wait': {
        const deps = this.sc.repo.tickets.find((t) => t.id === a.ticket)?.dependsOn ?? [];
        const merged = (u: string): boolean => this.events.some((e) => e.ev === 'merge' && e.ticket === u);
        if (!deps.every(merged)) { this.after(30_000, () => this.runStep(a)); return; }
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
      default: break; // reviewer steps in an implementer script are refused by parseScenario
    }
    a.idx++;
    a.mode = 'running';
    this.arm(a);
  }
  /** The loop's ask to connect (a wake) reaches the agent. */
  wakeImpl(ws: string, text: string): void {
    const a = this.impls.get(ws);
    if (!a) return;
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
      this.revs.set(id, { ws: id, ticket, steps, idx: 0, armed: false });
      this.ev('review-spawn', ticket, { ws: id, head, action: act });
    } else if (act === 'wake') this.ev('review-wake', ticket, { ws: id, head });
    const r = this.revs.get(id);
    if (r && act !== 'noop') this.armReview(r);
    return { id };
  }
  private armReview(r: Rev): void {
    if (r.armed) return;
    r.armed = true;
    this.after(r.steps[r.idx]?.afterMs ?? this.timing.reviewMs, () => { r.armed = false; this.reviewStep(r); });
  }
  private reviewStep(r: Rev): void {
    const s = readLoopState(this.home, this.run)!;
    const t = s.tickets[r.ticket];
    const head = reviewHeadOf(t);
    if (!head) return;
    const step = r.steps[r.idx] ?? { do: 'approve' as const };
    r.idx++;
    const open = Object.entries(t.findings).filter(([, f]) => !f.settled && !f.decision).map(([id]) => id);
    const findings = step.do === 'changes' ? Object.fromEntries((step.findings ?? ['F1']).map((id) => [id, { severity: 'BLOCKING', evidence: 'argued', report: { input: 'the scripted input', happens: 'the scripted failure', where: 'src/x.ts:1', proof: 'scripted' } }])) : {};
    const tree = this.commits.get(head)?.tree ?? null;
    try {
      updateLoopState(this.home, this.run, (cur) => withLoop(recordReview(cur!, r.ticket, { head, verdict: step.do === 'changes' ? 'changes-requested' : 'approve', input: { findings: findings as never, fixed: step.do === 'approve' ? open : [] }, callerId: r.ws, callerVouched: true, tree, now: this.iso() }), cur!.loop));
      this.ev('review-record', r.ticket, { ws: r.ws, head, verdict: step.do === 'changes' ? 'changes-requested' : 'approve' });
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
  checks(n: number, head: string): ForgeCheck[] {
    const p = this.prs.get(n)!;
    const run = this.runFor(p, head);
    if (this.t < run.doneAt) return CHECK_NAMES.map((name) => ({ name, status: 'pending' as const }));
    const red = run.result.startsWith('red:') ? run.result.slice(4) : null;
    return CHECK_NAMES.map((name) => ({ name, status: name === red || (red && !CHECK_NAMES.includes(red) && name === 'test') ? ('red' as const) : ('green' as const), at: this.iso(run.doneAt), ...(name === red ? { logExtract: `FAIL ${name}` } : {}) }));
  }
  rerun(n: number): void { const p = this.prs.get(n)!; this.runFor(p, this.branches.get(p.branch)!, true); }
  merge(n: number, matchHead: string): { ok: boolean; reason?: string } {
    const p = this.prs.get(n)!;
    const head = this.branches.get(p.branch)!;
    if (p.state === 'merged') return { ok: false, reason: 'already merged' };
    if (!sameSha(head, matchHead)) return { ok: false, reason: 'head-moved' };
    const run = [...p.runs].reverse().find((r) => r.head === head);
    const ci = !run ? 'none' : this.t < run.doneAt ? 'pending' : run.result;
    const c = this.commit([this.branches.get(this.target)!, head], `merge:${p.ticket}`, `merge:${p.ticket}`);
    this.branches.set(this.target, c);
    p.state = 'merged';
    p.mergedHead = head;
    this.ev('merge', p.ticket, { n, head, ci, commit: c });
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
        home: i.home, now: () => w.iso(),
        implementerLive: (id) => w.impls.has(id),
        repoPath: () => undefined,
        spawn: async ({ name, reuseBranch }) => {
          const ticket = i.scenario.repo.tickets.find((t) => implementerName(t.id) === name)?.id ?? ticketOfBranch(name) ?? null;
          if (!ticket) return { ok: false, error: `the dummy fleet knows no ticket for ${name}` };
          const r = w.spawnImpl(ticket, reuseBranch ? name : name);
          return { ok: true, id: r.ws, branch: name, ...(r.held ? { held: { since: w.t } } : {}) };
        },
      });
    },
    live: (ws) => w.impls.has(ws) || w.revs.has(ws),
    async wake(ws, text) { w.wakeImpl(ws, text); },
    async send(to, text, kind) { if (kind === 'answer') w.answerImpl(to, text); else w.ev('send', undefined, { to, kind, text }); },
    async mail() { return w.drainMail(); },
    async spawnReviewer(ticket, head) { return w.spawnReviewer(ticket, head); },
    async costOf(ticket) { return { tokens: 1000 * w.events.filter((e) => e.ticket === ticket).length }; },
  };
  const forge: ForgePort = {
    async openPr({ branch, title }) { const t = ticketOfBranch(branch) ?? title.split(':')[0]; return { n: w.openPr(branch, t) }; },
    async prState(n) { const p = w.prs.get(n)!; return { state: p.state, head: p.mergedHead ?? w.branches.get(p.branch)! }; },
    async checks(n, head) { return w.checks(n, head); },
    async rerun(n) { w.rerun(n); },
    async merge(n, matchHead) { return w.merge(n, matchHead); },
    async close(n) { const p = w.prs.get(n); if (p) w.ev('pr-close', p.ticket, { n }); },
  };
  const git: GitPort = {
    async head(branch) { return w.branches.get(branch) ?? null; },
    async tree(s) { return w.commits.get(w.resolve(s) ?? '')?.tree ?? null; },
    async isMerged(branch, base) { return w.contains(branch, base); },
  };
  return { world: w, fleet, forge, git, now: () => w.iso(), plan, async sleep(ms) { w.tickHolds(); w.advance(ms); } };
}

export interface DummyRun { result: LoopResult; violations: Violation[]; world: DummyWorld; log: string[] }
/** The whole seam in one call: seed, run the loop on the dummy fleet, judge the event log, dump it. The CLI (`fanout run --scenario`) and the tests both go through here. */
export async function runDummyLoop(i: { home: string; run?: string; scenario: Scenario; options?: Partial<LoopOptions>; wrap?: (d: Dummy) => Dummy }): Promise<DummyRun> {
  const run = i.run ?? i.scenario.run ?? 'dummy-run';
  let d = buildDummy({ home: i.home, run, scenario: i.scenario });
  if (i.wrap) d = i.wrap(d);
  const log: string[] = [];
  const options: LoopOptions = { ...DEFAULT_OPTIONS, maxPasses: 5000, plan: d.plan, tickets: i.scenario.repo.tickets.map((t) => t.id), ...(i.options ?? {}) };
  const result = await runLoop({ home: i.home, run, caller: run, fleet: d.fleet, forge: d.forge, git: d.git, now: d.now, sleep: d.sleep, log: (l) => log.push(`${d.now()} ${l}`), options });
  d.world.dump();
  const s = readLoopState(i.home, run);
  const startAt: Record<string, number | null> = {};
  for (const t of i.scenario.repo.tickets) startAt[t.id] = s?.tickets[t.id]?.start?.at ? Date.parse(s.tickets[t.id].start!.at) : null;
  const violations = judgeRun({ events: d.world.events, deps: Object.fromEntries(i.scenario.repo.tickets.map((t) => [t.id, t.dependsOn])), tickets: i.scenario.repo.tickets.map((t) => t.id), startAt });
  return { result, violations, world: d.world, log };
}
export { stateFile };
