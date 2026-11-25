// #608 — stepReconcile / stepEnd / the closing report, driven against hand-made ports (the dummy fleet of #605 is not needed: the steps read git + the PR host and one state file).
// `parkShim` stands for #603's `parkTicket` (a ticket + its transitive dependents) until that lands: the state carries `parked` in memory only (parseState does not know the field yet).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blankTicket, newState, readState, stateFile, type FanoutState, type TicketState } from './fanout-state.ts';
import { fileStatePort, releaseDependents, stepEnd, stepReconcile, writeBackFor, type EndCtx, type ParkFn, type RelaunchCtx, type StatePort } from './fanout-relaunch.ts';
import { buildReport, renderReport, reportExit, type PauseInfo } from './fanout-report.ts';
import { reconcile } from './fanout-state.ts';

const T0 = '2026-11-25T10:00:00.000Z';
const sha = (c: string): string => c.repeat(40);

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────
type Raw = Partial<TicketState> & { parked?: unknown };
function stateOf(tickets: Record<string, Raw>, extra: Record<string, unknown> = {}): FanoutState {
  const s = newState('run1', { now: T0 });
  const ts: Record<string, TicketState> = {};
  for (const [id, t] of Object.entries(tickets)) ts[id] = { ...blankTicket(T0), ...t } as TicketState;
  return { ...s, tickets: ts, plan: { tickets: Object.keys(tickets), declaredAt: T0 }, ...extra } as FanoutState;
}
const gated = (n: number, c: string, over: Raw = {}): Raw => ({ status: 'gated', verdict: 'approve', branch: `b${n}`, pr: n, head: sha(c), tree: sha(c.toUpperCase().toLowerCase()), ...over });

/** the world git and the PR host see */
class World {
  heads = new Map<string, string | null>();
  trees = new Map<string, string>();
  merged = new Set<string>();
  prs = new Map<number, { state: 'open' | 'merged' | 'closed'; head: string }>();
  fail = new Set<string>();
  calls: string[] = [];
  branch(b: string, head: string | null, tree?: string): this { this.heads.set(b, head); if (head) this.trees.set(head, tree ?? head); return this; }
  pr(n: number, state: 'open' | 'merged' | 'closed', head: string): this { this.prs.set(n, { state, head }); return this; }
  git = {
    head: async (b: string): Promise<string | null> => { this.calls.push(`head ${b}`); if (this.fail.has(b)) throw new Error('git: exit 128'); return this.heads.get(b) ?? null; },
    tree: async (s: string): Promise<string | null> => this.trees.get(s) ?? null,
    isMerged: async (b: string): Promise<boolean> => this.merged.has(b),
  };
  forge = { prState: async (n: number) => { this.calls.push(`pr ${n}`); if (this.fail.has(`pr${n}`)) throw new Error('gh: HTTP 502'); const p = this.prs.get(n); if (!p) throw new Error(`no PR ${n}`); return p; } };
}

/** #603's parkTicket, in memory: the ticket parked with its reason, its unmerged / undropped / unparked transitive dependents parked `upstream`. */
const parkShim: ParkFn = (state, id, why, now) => {
  const t = state.tickets;
  if (t[id].status === 'merged') throw new Error('park-merged');
  const out: Record<string, TicketState> = { ...t, [id]: { ...t[id], status: 'parked', parked: { ...why, at: now }, updatedAt: now } as unknown as TicketState };
  for (let more = true; more;) {
    more = false;
    for (const [d, dt] of Object.entries(out)) {
      if (dt.status === 'merged' || dt.status === 'dropped' || (dt.status as string) === 'parked') continue;
      if (dt.dependsOn.some((u) => (out[u].status as string) === 'parked')) { out[d] = { ...dt, status: 'parked', parked: { cause: 'upstream', blockedBy: id, reason: `blocked by ${id}`, at: now }, updatedAt: now } as unknown as TicketState; more = true; }
    }
  }
  return { ...state, tickets: out, updatedAt: now };
};

function memPort(init: FanoutState): StatePort & { cur: FanoutState; writes: number } {
  const p = { cur: init, writes: 0, read: () => p.cur, update: (f: (s: FanoutState) => FanoutState) => { p.cur = f(p.cur); p.writes++; return p.cur; } };
  return p;
}
function rctx(w: World, port: StatePort, log: string[] = []): RelaunchCtx {
  let tick = 0;
  return { now: () => new Date(Date.parse(T0) + ++tick * 1000).toISOString(), log: (l) => log.push(l), git: w.git, forge: w.forge, state: port, park: parkShim };
}
const status = (s: FanoutState, id: string): string => s.tickets[id].status as string;
const parkedOf = (s: FanoutState, id: string): { cause: string; reason: string; blockedBy?: string } => (s.tickets[id] as unknown as { parked: { cause: string; reason: string; blockedBy?: string } }).parked;

// ── reconcile: a hand merge is adopted ──────────────────────────────────────────────────────────────────────────
test('a merge made by hand (PR merged on the host, state gated) is adopted — and a second pass writes nothing', async () => {
  const w = new World().branch('b1', sha('a')).pr(1, 'merged', sha('a'));
  w.merged.add('b1');
  const port = memPort(stateOf({ A: gated(1, 'a') }));
  assert.equal(status(port.cur, 'A'), 'gated'); // the unfixed arm: without the step the ticket stays gated forever
  const log: string[] = [];
  const out = await stepReconcile(rctx(w, port, log));
  assert.deepEqual(out.adopted, ['A']);
  assert.equal(status(port.cur, 'A'), 'merged');
  assert.equal(port.cur.tickets.A.mergedHead, sha('a'));
  assert.match(log.join('\n'), /A: merged outside the loop/);
  const writes = port.writes, snap = JSON.stringify(port.cur);
  const again = await stepReconcile(rctx(w, port));
  assert.deepEqual(again.adopted, []);
  assert.equal(port.writes, writes, 'a settled world is not written again');
  assert.equal(JSON.stringify(port.cur), snap);
});

test('a PR merged on the host whose branch was then deleted (no ancestry to read) is adopted from the PR alone — on the RUN TARGET only', async () => {
  const w = new World().branch('b1', null).pr(1, 'merged', sha('a'));
  const port = memPort(stateOf({ A: gated(1, 'a') }));
  const out = await stepReconcile(rctx(w, port));
  assert.deepEqual(out.adopted, ['A']);
  assert.equal(status(port.cur, 'A'), 'merged');
});

test('a ticket already recorded merged is never parked and never re-written, whatever the host says about its head', async () => {
  const w = new World().branch('b1', sha('c')).pr(1, 'merged', sha('c')); // merged at cccc…, the verdict covered aaaa…
  w.merged.add('b1');
  const port = memPort(stateOf({ A: gated(1, 'a', { status: 'merged' }) }));
  const out = await stepReconcile(rctx(w, port));
  assert.deepEqual(out.parked, []);
  assert.equal(status(port.cur, 'A'), 'merged');
  assert.equal(port.writes, 0, 'no park, no write: a merged ticket is the loop\'s fact, not a parking case');
  assert.deepEqual(out.diverged.map((d) => d.kind), ['merged-at-ungated-head'], 'but the divergence stays visible');
});

test('MUST-FAIL arm: a hand merge on a head no verdict covered is NOT recorded as covered — the ticket is parked, not merged', async () => {
  const w = new World().branch('b1', sha('c')).pr(1, 'merged', sha('c'));
  w.merged.add('b1');
  const port = memPort(stateOf({ A: gated(1, 'a') })); // the approve verdict is on aaaa…, the merge landed cccc…
  const out = await stepReconcile(rctx(w, port));
  assert.deepEqual(out.adopted, []);
  assert.equal(status(port.cur, 'A'), 'parked');
  assert.equal(parkedOf(port.cur, 'A').cause, 'situation');
  assert.match(parkedOf(port.cur, 'A').reason, /merged at cccccccc/);
});

test('a merge the loop made before a kill that kept the state write is the same case: adopted once, no second merge possible (the step holds no merge port)', async () => {
  const w = new World().branch('b1', sha('a')).pr(1, 'merged', sha('a'));
  w.merged.add('b1');
  const port = memPort(stateOf({ A: gated(1, 'a'), B: { status: 'nominated', branch: 'b2', pr: 2, head: sha('b'), tree: sha('b'), dependsOn: ['A'] } }));
  w.branch('b2', sha('b')).pr(2, 'open', sha('b'));
  await stepReconcile(rctx(w, port));
  assert.equal(status(port.cur, 'A'), 'merged');
  assert.equal(status(port.cur, 'B'), 'nominated'); // untouched: B's connect / merge belongs to the loop's later steps
  assert.equal(Object.keys(rctx(w, port).forge).join(), 'prState', 'the ports this step is given cannot merge, open or close');
});

// ── reconcile: parking ──────────────────────────────────────────────────────────────────────────────────────────
test('a closed PR parks its ticket and the dependents of it; a second pass is a no-op', async () => {
  const w = new World().branch('b1', sha('a')).pr(1, 'closed', sha('a')).branch('b2', sha('b')).pr(2, 'open', sha('b'));
  const port = memPort(stateOf({
    A: gated(1, 'a'),
    B: { status: 'nominated', branch: 'b2', pr: 2, head: sha('b'), tree: sha('b'), dependsOn: ['A'] },
    C: { status: 'started', branch: 'b3', dependsOn: ['B'] },
    D: { status: 'started', branch: 'b4' },
  }));
  w.branch('b3', sha('d')).branch('b4', sha('e'));
  const out = await stepReconcile(rctx(w, port));
  assert.deepEqual(out.parked.map((p) => p.ticket), ['A']);
  assert.equal(parkedOf(port.cur, 'A').reason, 'PR #1 was closed without merging');
  assert.equal(status(port.cur, 'B'), 'parked');
  assert.deepEqual([parkedOf(port.cur, 'B').cause, parkedOf(port.cur, 'B').blockedBy], ['upstream', 'A']);
  assert.equal(status(port.cur, 'C'), 'parked'); // transitive
  assert.equal(status(port.cur, 'D'), 'started'); // independent: the others go on
  const snap = JSON.stringify(port.cur), writes = port.writes;
  const again = await stepReconcile(rctx(w, port));
  assert.deepEqual(again.parked, []);
  assert.equal(port.writes, writes);
  assert.equal(JSON.stringify(port.cur), snap);
});

test('a branch that is gone parks a ticket that PUBLISHED work (a PR or a recorded head) — a fresh one with neither is only not created yet', async () => {
  const w = new World().branch('b1', null).branch('b2', null);
  const port = memPort(stateOf({ A: { status: 'started', branch: 'b1', head: sha('a'), implementer: 'ws-a' }, B: { status: 'started', branch: 'b2', implementer: 'ws-b' } }));
  const out = await stepReconcile(rctx(w, port));
  assert.deepEqual(out.parked.map((p) => p.ticket), ['A']);
  assert.match(parkedOf(port.cur, 'A').reason, /branch b1 is gone/);
  assert.equal(status(port.cur, 'B'), 'started');
});

test('a PARKED ticket whose branch is trivially "contained" in the target is NOT adopted as merged (ancestry is no evidence for it); a covered PR merge of it IS', async () => {
  const w = new World().branch('b1', sha('a')).pr(1, 'open', sha('a'));
  w.merged.add('b1');
  const parked = parkShim(stateOf({ A: gated(1, 'a', { status: 'started' }) }), 'A', { cause: 'question', reason: 'NO SAFE OPTION: x' }, T0);
  const reality = { A: { branchHead: sha('a'), branchTree: sha('a'), mergedIntoTarget: true, pr: { state: 'OPEN' as const, headRefOid: sha('a'), baseRefName: 'master' } } };
  assert.ok(reconcile(parked, reality).writeBack.some((x) => x.patch.status === 'merged'), 'the unfixed rule WOULD adopt it');
  assert.deepEqual(writeBackFor(parked, reality, reconcile(parked, reality).writeBack), []);
  const out = await stepReconcile(rctx(w, memPort(parked)));
  assert.deepEqual(out.adopted, []);
  const merged = { A: { ...reality.A, pr: { state: 'MERGED' as const, headRefOid: sha('a'), baseRefName: 'master' } } };
  assert.deepEqual(writeBackFor(parked, merged, []).map((x) => [x.ticket, x.patch.status]), [['A', 'merged']]);
  const ungated = { A: { ...merged.A, pr: { state: 'MERGED' as const, headRefOid: sha('c'), baseRefName: 'master' } } };
  assert.deepEqual(writeBackFor(parked, ungated, []), [], 'merged at a head the verdict did not cover stays parked');
  const otherBase = { A: { ...merged.A, pr: { state: 'MERGED' as const, headRefOid: sha('a'), baseRefName: 'stack' } } };
  assert.deepEqual(writeBackFor(parked, otherBase, []), []);
});

test('a ticket parked for a merge at an ungated head STAYS parked on the next pass (its status no longer reads gated)', async () => {
  const w = new World().branch('b1', sha('c')).pr(1, 'merged', sha('c'));
  w.merged.add('b1');
  const port = memPort(stateOf({ A: gated(1, 'a') }));
  await stepReconcile(rctx(w, port));
  assert.equal(status(port.cur, 'A'), 'parked');
  const out = await stepReconcile(rctx(w, port));
  assert.deepEqual(out.adopted, []);
  assert.equal(status(port.cur, 'A'), 'parked');
});

test('releaseDependents: freed only when the recorded blocker is MERGED — never behind a dropped one or with no blocker; independent of ticket order; another parked upstream re-points', () => {
  const up = (blockedBy?: string): Raw => ({ status: 'parked', branch: 'bx', dependsOn: [], parked: { cause: 'upstream', reason: `blocked by ${blockedBy}`, ...(blockedBy ? { blockedBy } : {}) } });
  const ids = (s: FanoutState): string[] => Object.keys(s.tickets).filter((k) => status(s, k) !== 'parked');
  const mk = (a: 'merged' | 'dropped', order: string[]): FanoutState => {
    const all: Record<string, Raw> = { A: { status: a }, B: { ...up('A'), dependsOn: ['A'] }, C: { ...up('A'), dependsOn: ['B'] } };
    return stateOf(Object.fromEntries(order.map((k) => [k, all[k]])));
  };
  for (const order of [['A', 'B', 'C'], ['C', 'B', 'A']]) {
    const r = releaseDependents(mk('merged', order), T0);
    assert.deepEqual(r.released.sort(), ['B', 'C'], order.join());
    assert.deepEqual(ids(r.state).sort(), ['A', 'B', 'C']);
  }
  assert.deepEqual(releaseDependents(mk('dropped', ['A', 'B', 'C']), T0).released, []);
  assert.deepEqual(releaseDependents(stateOf({ A: { status: 'dropped' }, B: { ...up(), dependsOn: ['A'] } }), T0).released, [], 'no recorded blocker: not freed');
  const two = releaseDependents(stateOf({ A: { status: 'merged' }, X: { status: 'parked', parked: { cause: 'ci', reason: 'r' } }, B: { ...up('A'), dependsOn: ['A', 'X'] } }), T0);
  assert.deepEqual(two.released, []);
  assert.equal(parkedOf(two.state, 'B').blockedBy, 'X');
});

test('MUST-FAIL arm: a read that FAILED concludes nothing — no park, no adoption (unknown is not gone)', async () => {
  const w = new World().branch('b1', sha('a'));
  w.fail.add('b1'); w.fail.add('pr1');
  const port = memPort(stateOf({ A: gated(1, 'a') }));
  const log: string[] = [];
  const out = await stepReconcile(rctx(w, port, log));
  assert.deepEqual(out.unreadable, ['A']);
  assert.deepEqual(out.parked, []);
  assert.deepEqual(out.adopted, []);
  assert.equal(status(port.cur, 'A'), 'gated');
  assert.equal(port.writes, 0);
  assert.match(log.join('\n'), /could not read git\/gh/);
});

test('state says merged, git and the host say no: reported, never auto-corrected, never parked', async () => {
  const w = new World().branch('b1', sha('a')).pr(1, 'open', sha('a'));
  const port = memPort(stateOf({ A: gated(1, 'a', { status: 'merged' }) }));
  const out = await stepReconcile(rctx(w, port));
  assert.deepEqual(out.diverged.map((d) => d.kind), ['state-merged-reality-not']);
  assert.equal(status(port.cur, 'A'), 'merged');
  assert.equal(port.writes, 0);
});

test('the same head on a rebased sha (same tree) follows silently; a moved head resets the verdict (existing reconcile rules, through the ports)', async () => {
  const w = new World().branch('b1', sha('f'), sha('a')).pr(1, 'open', sha('f')); // tree aaaa… on a new commit
  const port = memPort(stateOf({ A: gated(1, 'a') }));
  await stepReconcile(rctx(w, port));
  assert.equal(port.cur.tickets.A.head, sha('f'));
  assert.equal(port.cur.tickets.A.verdict, 'approve'); // content unchanged: the verdict stands
  const w2 = new World().branch('b1', sha('9'), sha('9')).pr(1, 'open', sha('9'));
  const p2 = memPort(stateOf({ A: gated(1, 'a') }));
  await stepReconcile(rctx(w2, p2));
  assert.equal(p2.cur.tickets.A.verdict, 'none');
  assert.equal(status(p2.cur, 'A'), 'nominated');
});

// ── killed at every window of one merge: the same final state ──────────────────────────────────────────────────
test('killed at every window of a ticket\'s merge sequence and started again: the same final state, one merge', async () => {
  const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'updatedAt' && k !== 'reconciledAt').sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)])) : v);
  const norm = (s: FanoutState): string => JSON.stringify(canon(s)); // key order and timestamps are not state
  const finals: string[] = [];
  // W1 PR open + approved (merge not made) · W2 merged on the host, state still gated (kill between the merge and the write) · W3 merged and recorded
  for (const window of ['W1', 'W2', 'W3']) {
    const w = new World().branch('b1', sha('a')).pr(1, window === 'W1' ? 'open' : 'merged', sha('a'));
    if (window !== 'W1') w.merged.add('b1');
    const port = memPort(stateOf({ A: gated(1, 'a', window === 'W3' ? { status: 'merged', mergedHead: sha('a'), mergedTree: sha('a') } : {}) }));
    await stepReconcile(rctx(w, port));
    await stepReconcile(rctx(w, port)); // started again
    if (window === 'W1') { // the loop's merge step then runs: the host merges once
      w.prs.set(1, { state: 'merged', head: sha('a') }); w.merged.add('b1');
      await stepReconcile(rctx(w, port));
    }
    assert.equal(status(port.cur, 'A'), 'merged', window);
    finals.push(norm(port.cur));
  }
  assert.equal(new Set(finals).size, 1, 'W1, W2 and W3 end in the same state');
});

// ── the end step and the report ─────────────────────────────────────────────────────────────────────────────────
const tokens = (n: number) => async () => ({ tokens: n });
function ectx(port: StatePort, costOf: EndCtx['costOf'] = async () => null, log: string[] = []): EndCtx {
  return { now: () => T0, log: (l) => log.push(l), state: port, park: parkShim, costOf };
}

test('stepEnd: every ticket merged → done, exit 0, report = the merged list with the cost per ticket', async () => {
  const port = memPort(stateOf({ A: { status: 'merged', branch: 'b1', pr: 1 }, B: { status: 'merged', branch: 'b2', pr: 2, dependsOn: ['A'] } }));
  const e = await stepEnd(ectx(port, async (t) => (t === 'A' ? { tokens: 1200 } : null)));
  assert.equal(e.done, true);
  assert.equal(e.exit, 0);
  assert.deepEqual(e.report!.merged, ['A', 'B']);
  assert.deepEqual(e.report!.costPerTicket, { A: { tokens: 1200 }, B: null });
});

test('stepEnd: one ticket still in flight → not done (the loop goes on); MUST-FAIL arm: a ticket in flight is never reported as the end', async () => {
  const port = memPort(stateOf({ A: { status: 'merged' }, B: { status: 'started', branch: 'b2' } }));
  const e = await stepEnd(ectx(port));
  assert.deepEqual([e.done, e.exit, e.report], [false, null, null]);
});

test('stepEnd: a parked ticket ends the run with exit 3 and the report names cause and reason; its dependents are listed', async () => {
  const s = parkShim(stateOf({ A: { status: 'started', branch: 'b1' }, B: { status: 'started', branch: 'b2', dependsOn: ['A'] }, C: { status: 'merged' } }), 'A', { cause: 'question', reason: 'NO SAFE OPTION: the spec contradicts itself' }, T0);
  const e = await stepEnd(ectx(memPort(s)));
  assert.equal(e.exit, 3);
  assert.deepEqual(e.report!.parked, [
    { ticket: 'A', cause: 'question', reason: 'NO SAFE OPTION: the spec contradicts itself' },
    { ticket: 'B', cause: 'upstream', reason: 'blocked by A', blockedBy: 'A' },
  ]);
  assert.deepEqual(e.report!.merged, ['C']);
});

test('stepEnd: a paused run is done with exit 4 even with tickets in flight (resumable: run again)', async () => {
  const pause: PauseInfo = { at: T0, reason: 'check "build" is red on 3 PRs', check: 'build', prs: [1, 2, 3] };
  const port = memPort(stateOf({ A: { status: 'started' } }, { pause }));
  const e = await stepEnd(ectx(port));
  assert.equal(e.exit, 4);
  assert.deepEqual(e.report!.paused, pause);
  assert.deepEqual(e.report!.unfinished, ['A']);
  assert.match(renderReport(e.report!), /PAUSED .*build.*#1, #2, #3.*run again|run `orchestra fanout run --run run1` again/s);
});

test('stepEnd: a ticket behind a DROPPED upstream is parked, so the run ends instead of waiting for a merge that cannot come', async () => {
  const port = memPort(stateOf({ A: { status: 'dropped' }, B: { status: 'todo', dependsOn: ['A'] } }));
  const e = await stepEnd(ectx(port));
  assert.equal(e.done, true);
  assert.equal(e.exit, 3);
  assert.equal(e.report!.parked[0].ticket, 'B');
  assert.match(e.report!.parked[0].reason, /blocked by A \(dropped/);
  assert.deepEqual(e.report!.dropped, ['A']);
});

test('a cost the host cannot read is "not measured" (null), never 0 — and never fails the report', async () => {
  const port = memPort(stateOf({ A: { status: 'merged' } }));
  const e = await stepEnd(ectx(port, async () => { throw new Error('no transcript dir'); }));
  assert.equal(e.exit, 0);
  assert.equal(e.report!.costPerTicket.A, null);
  assert.match(renderReport(e.report!), /A not measured/);
});

test('the report EQUALS the state: every merged / parked / choice / finding line comes from it, a changed state changes the report, a rebuilt one is identical', () => {
  const s = parkShim(stateOf({
    A: { status: 'merged', branch: 'b1', pr: 11, findings: { m1: { severity: 'MINOR', evidence: 'measured' } as never, f2: { severity: 'MAJOR', settled: { how: 'fixed', at: T0, ref: sha('a') } } as never } },
    B: { status: 'started', branch: 'b2', pr: 12, findings: { f3: { severity: 'MAJOR', decision: { by: 'run1', text: 'accepted: out of scope', at: T0 } } as never, f4: { severity: 'BLOCKING', settled: { how: 'pr-body', at: T0, ref: 'PR #12 body' } } as never } },
    C: { status: 'started', branch: 'b3', dependsOn: ['B'] },
  }, { choices: [{ n: 1, ticket: 'A', question: 'which index?', rule: 'reversible-default', answer: 'take the reversible option', at: T0 }], flaky: [{ ticket: 'A', check: 'e2e' }] }), 'B', { cause: 'ci', reason: 'same failure after the fix: test/foo' }, T0);
  const r = buildReport(s, { A: { tokens: 10 }, B: { tokens: 20 }, C: null });
  assert.deepEqual(r.merged, ['A']);
  assert.deepEqual(r.parked.map((p) => [p.ticket, p.cause, p.reason]), [['B', 'ci', 'same failure after the fix: test/foo'], ['C', 'upstream', 'blocked by B']]);
  assert.deepEqual(r.choices, [{ n: 1, ticket: 'A', question: 'which index?', rule: 'reversible-default', answer: 'take the reversible option', pr: 11, branch: 'b1' }]);
  assert.deepEqual(r.findingsLeft.map((f) => `${f.ticket}/${f.finding}:${f.end}`), ['A/m1:open', 'B/f3:decided', 'B/f4:pr-body']); // f2 was fixed: not "left"
  assert.deepEqual(r.flaky, ['A/e2e']);
  const text = renderReport(r);
  for (const needle of ['merged: A', 'B  [ci]  same failure after the fix: test/foo', 'C  [upstream]  blocked by B', 'which index?', 'PR #11', 'A/m1', 'B/f3', 'accepted: out of scope', 'A/e2e', 'A 10 tokens', 'total 30 tokens']) assert.ok(text.includes(needle), needle);
  assert.equal(renderReport(buildReport(s, { A: { tokens: 10 }, B: { tokens: 20 }, C: null })), text, 'the same state renders the same report');
  const s2 = { ...s, tickets: { ...s.tickets, A: { ...s.tickets.A, status: 'dropped' as const } } };
  assert.notEqual(renderReport(buildReport(s2, {})), text, 'a different state is a different report');
  assert.equal(reportExit(r), 3);
});

test('reportExit: 0 merged · 3 parked · 4 paused (wins) · 1 unfinished without a reason; dropped does not fail the run', () => {
  const mk = (tickets: Record<string, Raw>, extra: Record<string, unknown> = {}): number => reportExit(buildReport(stateOf(tickets, extra)));
  assert.equal(mk({ A: { status: 'merged' } }), 0);
  assert.equal(mk({ A: { status: 'merged' }, B: { status: 'dropped' } }), 0);
  assert.equal(mk({ A: { status: 'parked', parked: { cause: 'ci', reason: 'x' } } }), 3);
  assert.equal(mk({ A: { status: 'parked', parked: { cause: 'ci', reason: 'x' } } }, { pause: { at: T0, reason: 'r', check: null, prs: [] } }), 4);
  assert.equal(mk({ A: { status: 'started' } }), 1);
  assert.equal(mk({}), 1, 'an empty run delivered nothing');
  assert.equal(mk({ A: { status: 'dropped' } }), 1, 'only dropped tickets delivered nothing');
});

test('fileStatePort: the real state file — reconcile writes it once, atomically, and a relaunch reads the same state', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relaunch-'));
  try {
    const file = stateFile(home, 'run1');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const s = stateOf({ A: gated(1, 'a') });
    const { plan: _p, ...bare } = s as FanoutState & { plan?: unknown };
    fs.writeFileSync(file, JSON.stringify(bare));
    const w = new World().branch('b1', sha('a')).pr(1, 'merged', sha('a'));
    w.merged.add('b1');
    const port = fileStatePort(home, 'run1');
    const ctx = { ...rctx(w, port), park: parkShim };
    await stepReconcile(ctx);
    assert.equal(readState(file)!.tickets.A.status, 'merged');
    const mtime = fs.statSync(file).mtimeMs, raw = fs.readFileSync(file, 'utf8');
    await stepReconcile(ctx);
    assert.equal(fs.readFileSync(file, 'utf8'), raw, 'a relaunch on a settled world rewrites nothing');
    assert.equal(fs.statSync(file).mtimeMs, mtime);
    assert.throws(() => fileStatePort(home, 'nope').read(), /no fanout state for run nope/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
