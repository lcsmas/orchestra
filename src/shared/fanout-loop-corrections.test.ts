// #606 — stepCorrections against HAND-MADE ports (ledger #613 FROZEN NAMES v1). Every rule has a must-pass and a must-fail arm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, switchesOf, type FanoutState, type FindingRecord, type ReviewEntry, type TicketState } from './fanout-state.ts';
import { runCorrections, stepCorrections, type CorrectionsCtx, type CorrectionsStore } from './fanout-loop-corrections.ts';

const T = '2026-11-25T10:00:00.000Z';
const sha = (c: string): string => c.repeat(40);
const DEMO = { input: 'POST /orders with an empty body {}', observed: 'src/orders.ts:12 throws a TypeError and answers 500', expected: 'a 400 answer naming the missing field', file: 'src/orders.ts', head: sha('1') };

interface World {
  state: FanoutState;
  woken: Array<{ ws: string; text: string }>;
  started: number;
  reviewerCalls: Array<{ ticket: string; head: string }>;
  heads: Record<string, string>;
  trees: Record<string, string>;
  live: Set<string>;
  failWake: boolean;
  /** what spawnReviewer answers: the recorded reviewer (the shipped host op) or a NEW one (a naive loop) */
  reviewerAnswer: 'same' | 'new';
  ctx: CorrectionsCtx;
}

function world(opts: { policy?: 'legacy' | 'demonstrated' | 'spec'; tickets?: string[] } = {}): World {
  let state = newState('run1', { switches: { seatRecords: 'on', minorPolicy: opts.policy ?? 'demonstrated' }, now: T });
  for (const id of opts.tickets ?? ['A']) {
    const t: TicketState = {
      branch: `impl-${id}`, pr: 1, head: sha('1'), verdict: 'none', dependsOn: [], builtOn: {}, frozenInterface: null, mergedAccepted: null, status: 'nominated', acceptance: null, tree: 't1',
      builtOnTree: {}, findings: {}, followUpOf: null, mergedHead: null, mergedTree: null, forgottenMerges: [], fixes: [], spec: null, specText: null, implementer: `ws-${id}`, verifier: null, accept: null,
      review: { reviewer: { id: `rv-${id}`, name: `review-${id}`, at: T }, head: sha('1'), base: null, briefs: [] }, reviews: [], updatedAt: T,
    };
    state = { ...state, tickets: { ...state.tickets, [id]: t } };
  }
  const w: World = {
    state, woken: [], started: 0, reviewerCalls: [], heads: Object.fromEntries((opts.tickets ?? ['A']).map((id) => [`impl-${id}`, sha('1')])), trees: { [sha('1')]: 't1' },
    live: new Set((opts.tickets ?? ['A']).flatMap((id) => [`ws-${id}`, `rv-${id}`])), failWake: false, reviewerAnswer: 'same', ctx: null as unknown as CorrectionsCtx,
  };
  const store: CorrectionsStore = { read: () => w.state, update: (fn) => (w.state = fn(w.state)) };
  w.ctx = {
    store,
    deps: {
      home: '/nowhere', run: 'run1', now: () => T, log: () => {},
      fleet: {
        live: (ws) => w.live.has(ws),
        wake: async (ws, text) => { if (w.failWake) throw new Error('boom'); w.woken.push({ ws, text }); },
        start: async () => { // the shipped startRun: a replacement ONLY for a ticket with no live implementer
          w.started++;
          for (const [id, t] of Object.entries(w.state.tickets)) if (t.implementer && !w.live.has(t.implementer)) { const n = `${t.implementer}-r`; w.live.add(n); w.state = { ...w.state, tickets: { ...w.state.tickets, [id]: { ...t, implementer: n } } }; }
        },
        spawnReviewer: async (ticket, head) => { w.reviewerCalls.push({ ticket, head }); return { id: w.reviewerAnswer === 'same' ? w.state.tickets[ticket].review!.reviewer!.id! : 'rv-other' }; },
      },
      git: { head: async (b) => w.heads[b] ?? null, tree: async (h) => w.trees[h] ?? null },
    },
  };
  return w;
}
const finding = (severity: FindingRecord['severity'], text: string, extra: Partial<FindingRecord> = {}): FindingRecord => ({ severity, text, by: 'rv-A', raisedOn: sha('1'), ...extra });
/** the reviewer's recorded verdict (what `orchestra fanout record` writes), on `head` / `tree` */
function review(w: World, id: string, head: string, tree: string, verdict: ReviewEntry['verdict'], raise: Record<string, FindingRecord> = {}, closed: string[] = []): void {
  const t = w.state.tickets[id];
  const entry: ReviewEntry = { n: (t.reviews?.length ?? 0) + 1, reviewer: `rv-${id}`, head, tree, verdict, findings: Object.keys(raise), closed, at: T };
  w.state = { ...w.state, tickets: { ...w.state.tickets, [id]: { ...t, findings: { ...t.findings, ...raise }, reviews: [...(t.reviews ?? []), entry] } } };
}
/** the author pushed: the branch now has `head` with content `tree` */
const push = (w: World, id: string, head: string, tree: string): void => { w.heads[`impl-${id}`] = head; w.trees[head] = tree; };
const roundsOf = (w: World, id: string): Array<{ n: number; fingerprint: string }> => (w.state.tickets[id] as TicketState & { rounds?: Array<{ n: number; fingerprint: string }> }).rounds ?? [];
const parkedOf = (w: World, id: string): { cause: string; reason: string } | undefined => (w.state.tickets[id] as TicketState & { parked?: { cause: string; reason: string } }).parked;

// ── 1. one batch per round; a plain MINOR is listed, not sent ───────────────────────────────────────────────
test('ONE batch per round to the live author: BLOCKING + MAJOR + demonstrated MINOR; the plain MINOR is noted, not sent', async () => {
  const w = world();
  review(w, 'A', sha('1'), 't1', 'changes-requested', { b1: finding('BLOCKING', 'null deref'), m1: finding('MAJOR', 'no retry'), n1: finding('MINOR', 'wrong status', { demonstration: DEMO }), p1: finding('MINOR', 'rename x') });
  const out = await runCorrections(w.ctx);
  assert.equal(w.woken.length, 1, 'one message for the round, never one per finding');
  assert.equal(w.woken[0].ws, 'ws-A');
  for (const id of ['b1', 'm1', 'n1']) assert.match(w.woken[0].text, new RegExp(`\\b${id}\\b`));
  assert.doesNotMatch(w.woken[0].text, /\bp1\b/, 'a plain MINOR is not sent');
  assert.deepEqual(out, [{ ticket: 'A', action: 'sent', to: 'ws-A', round: 1, findings: ['b1', 'm1', 'n1'], noted: ['p1'], replaced: false }]);
  assert.match(w.woken[0].text, /demonstrated — input: POST \/orders with an empty body/);
});
test('MUST-FAIL arm of the batch: a mutant that sent one message per finding would fail the count (3 findings → 1 message, not 3)', async () => {
  const w = world();
  review(w, 'A', sha('1'), 't1', 'changes-requested', { b1: finding('BLOCKING', 'a'), b2: finding('BLOCKING', 'b'), b3: finding('BLOCKING', 'c') });
  await runCorrections(w.ctx);
  assert.notEqual(w.woken.length, 3);
  assert.equal(w.woken.length, 1);
});
test('minorPolicy=legacy is honoured: a demonstrated MINOR is NOT sent under legacy (sent under demonstrated)', async () => {
  const legacy = world({ policy: 'legacy' });
  assert.equal(switchesOf(legacy.state).minorPolicy, 'legacy');
  review(legacy, 'A', sha('1'), 't1', 'changes-requested', { b1: finding('MAJOR', 'real'), n1: finding('MINOR', 'minor demonstrated', { demonstration: DEMO }) });
  await runCorrections(legacy.ctx);
  assert.match(legacy.woken[0].text, /\bb1\b/);
  assert.doesNotMatch(legacy.woken[0].text, /\bn1\b/);
  const demo = world({ policy: 'demonstrated' });
  review(demo, 'A', sha('1'), 't1', 'changes-requested', { b1: finding('MAJOR', 'real'), n1: finding('MINOR', 'minor demonstrated', { demonstration: DEMO }) });
  await runCorrections(demo.ctx);
  assert.match(demo.woken[0].text, /\bn1\b/);
});
test('a review that approves, or holds only plain MINORs, sends nothing', async () => {
  const w = world();
  review(w, 'A', sha('1'), 't1', 'approve', { p1: finding('MINOR', 'rename') });
  assert.deepEqual(await runCorrections(w.ctx), []);
  assert.equal(w.woken.length, 0);
});

// ── 2. disposable: killed and started again ─────────────────────────────────────────────────────────────────────
test('a second pass on the same state (the loop restarted) sends nothing more', async () => {
  const w = world();
  review(w, 'A', sha('1'), 't1', 'changes-requested', { b1: finding('BLOCKING', 'x') });
  await runCorrections(w.ctx);
  await runCorrections(w.ctx);
  await stepCorrections(w.ctx);
  assert.equal(w.woken.length, 1);
  assert.equal(roundsOf(w, 'A').length, 1);
  assert.equal(roundsOf(w, 'A')[0].n, 1, 'recorded under the review number');
});
test('a failed wake records no round: the next pass sends it', async () => {
  const w = world();
  review(w, 'A', sha('1'), 't1', 'changes-requested', { b1: finding('BLOCKING', 'x') });
  w.failWake = true;
  const out = await runCorrections(w.ctx);
  assert.deepEqual(out, [{ ticket: 'A', action: 'blocked', why: 'wake-failed' }]);
  assert.equal(roundsOf(w, 'A').length, 0);
  w.failWake = false;
  await runCorrections(w.ctx);
  assert.equal(w.woken.length, 1);
});

// ── 3. the same author; a fresh one only when dead ──────────────────────────────────────────────────────────────
test('MUST-FAIL: no second author for a live one — start() is never called while the author is live', async () => {
  const w = world();
  review(w, 'A', sha('1'), 't1', 'changes-requested', { b1: finding('BLOCKING', 'x') });
  await runCorrections(w.ctx);
  assert.equal(w.started, 0);
  assert.equal(w.woken[0].ws, 'ws-A');
  assert.doesNotMatch(w.woken[0].text, /You replace the previous author/);
});
test('a DEAD author is replaced through start (one replacement), and the fresh one gets the batch with the hand-over line', async () => {
  const w = world();
  w.live.delete('ws-A');
  review(w, 'A', sha('1'), 't1', 'changes-requested', { b1: finding('BLOCKING', 'x') });
  const out = await runCorrections(w.ctx);
  assert.equal(w.started, 1);
  assert.equal(w.woken.length, 1);
  assert.equal(w.woken[0].ws, 'ws-A-r');
  assert.match(w.woken[0].text, /You replace the previous author/);
  assert.equal(out[0].action, 'sent');
});
test('a dead author that start could not replace: nothing is lost, nothing recorded', async () => {
  const w = world();
  w.live.delete('ws-A');
  review(w, 'A', sha('1'), 't1', 'changes-requested', { b1: finding('BLOCKING', 'x') });
  w.ctx.deps.fleet.start = async () => { w.started++; };
  const out = await runCorrections(w.ctx);
  assert.deepEqual(out, [{ ticket: 'A', action: 'blocked', why: 'no-live-author' }]);
  assert.equal(roundsOf(w, 'A').length, 0);
});

// ── 4. the same reviewer reads the fix ──────────────────────────────────────────────────────────────────────────
test('the author pushed a new head: the recorded reviewer is asked ONCE for it (same id), nothing before the push', async () => {
  const w = world();
  review(w, 'A', sha('1'), 't1', 'changes-requested', { b1: finding('BLOCKING', 'x') });
  await runCorrections(w.ctx);
  assert.equal(w.reviewerCalls.length, 0, 'head unchanged: no reviewer call');
  push(w, 'A', sha('2'), 't2');
  const out = await runCorrections(w.ctx);
  assert.deepEqual(w.reviewerCalls, [{ ticket: 'A', head: sha('2') }]);
  assert.deepEqual(out, [{ ticket: 'A', action: 'reviewer-woken', head: sha('2'), reviewer: 'rv-A' }]);
});
test('MUST-FAIL: a fix read by ANOTHER reviewer while the first is live is reported, never accepted', async () => {
  const w = world();
  review(w, 'A', sha('1'), 't1', 'changes-requested', { b1: finding('BLOCKING', 'x') });
  await runCorrections(w.ctx);
  push(w, 'A', sha('2'), 't2');
  w.reviewerAnswer = 'new';
  const out = await runCorrections(w.ctx);
  assert.deepEqual(out, [{ ticket: 'A', action: 'reviewer-changed', expected: 'rv-A', got: 'rv-other' }]);
});
test('a dead reviewer is replaced by the host op (the answer may differ): not a violation', async () => {
  const w = world();
  review(w, 'A', sha('1'), 't1', 'changes-requested', { b1: finding('BLOCKING', 'x') });
  await runCorrections(w.ctx);
  push(w, 'A', sha('2'), 't2');
  w.live.delete('rv-A');
  w.reviewerAnswer = 'new';
  const out = await runCorrections(w.ctx);
  assert.equal(out[0].action, 'reviewer-woken');
});
test('the fix is read and approved on the new head: nothing left to do for corrections', async () => {
  const w = world();
  review(w, 'A', sha('1'), 't1', 'changes-requested', { b1: finding('BLOCKING', 'x') });
  await runCorrections(w.ctx);
  push(w, 'A', sha('2'), 't2');
  review(w, 'A', sha('2'), 't2', 'approve', {}, ['b1']);
  assert.deepEqual(await runCorrections(w.ctx), []);
  assert.equal(w.reviewerCalls.length, 0);
});

// ── 5. termination: the same situation seen twice parks the ticket ──────────────────────────────────────────────
test('a fix that changes the tree and leaves a NEW finding is a second round, not a park (must-pass)', async () => {
  const w = world();
  review(w, 'A', sha('1'), 't1', 'changes-requested', { b1: finding('BLOCKING', 'x') });
  await runCorrections(w.ctx);
  push(w, 'A', sha('2'), 't2');
  review(w, 'A', sha('2'), 't2', 'changes-requested', { b2: finding('MAJOR', 'y', { raisedOn: sha('2') }) }, ['b1']);
  const out = await runCorrections(w.ctx);
  assert.equal(out[0].action, 'sent');
  assert.equal(w.woken.length, 2);
  assert.equal(roundsOf(w, 'A').length, 2);
  assert.equal(parkedOf(w, 'A'), undefined);
});
test('the SAME open finding on a CHANGED tree (a partial fix) is a second round, not a park: the tree is part of the situation', async () => {
  const w = world();
  review(w, 'A', sha('1'), 't1', 'changes-requested', { b1: finding('BLOCKING', 'x') });
  await runCorrections(w.ctx);
  push(w, 'A', sha('2'), 't2');
  review(w, 'A', sha('2'), 't2', 'changes-requested', {}); // b1 still open
  const out = await runCorrections(w.ctx);
  assert.equal(out[0].action, 'sent');
  assert.equal(w.woken.length, 2);
  assert.equal(parkedOf(w, 'A'), undefined);
});
test('MUST-FAIL: a round on an UNCHANGED tree (new sha, same content, same open findings) parks the ticket and sends no second batch', async () => {
  const w = world();
  review(w, 'A', sha('1'), 't1', 'changes-requested', { b1: finding('BLOCKING', 'x') });
  await runCorrections(w.ctx);
  push(w, 'A', sha('2'), 't1'); // an empty / reworded commit: the tree is the same
  review(w, 'A', sha('2'), 't1', 'changes-requested', {}); // the reviewer reads it: b1 still open
  const out = await runCorrections(w.ctx);
  assert.equal(out[0].action, 'parked');
  assert.equal(w.woken.length, 1, 'no second batch');
  assert.equal(parkedOf(w, 'A')?.cause, 'situation');
  assert.match(parkedOf(w, 'A')!.reason, /seen twice/);
  assert.equal(w.state.tickets.A.status as string, 'parked');
});
test('MUST-FAIL: two fixes that UNDO each other park the ticket — the reviewer cannot reuse an id, so the same CONTENT again is what repeats', async () => {
  const w = world();
  review(w, 'A', sha('1'), 't1', 'changes-requested', { a1: finding('BLOCKING', 'A is broken') });
  await runCorrections(w.ctx);
  push(w, 'A', sha('2'), 't2'); // fixes A, breaks B
  review(w, 'A', sha('2'), 't2', 'changes-requested', { b1: finding('BLOCKING', 'B is broken', { raisedOn: sha('2') }) }, ['a1']);
  await runCorrections(w.ctx);
  assert.equal(w.woken.length, 2);
  push(w, 'A', sha('3'), 't1'); // fixes B by undoing the fix of A: content of round 1 again
  review(w, 'A', sha('3'), 't1', 'changes-requested', { a2: finding('BLOCKING', 'A is broken again', { raisedOn: sha('3') }) }, ['b1']);
  const out = await runCorrections(w.ctx);
  assert.equal(out[0].action, 'parked');
  assert.equal((out[0] as { why: string }).why, 'same-tree');
  assert.equal(w.woken.length, 2, 'the third batch is never sent');
});
test('a park takes the dependents with it (cause upstream, blockedBy)', async () => {
  const w = world({ tickets: ['A', 'B'] });
  w.state = { ...w.state, tickets: { ...w.state.tickets, B: { ...w.state.tickets.B, dependsOn: ['A'], status: 'started', reviews: [] } } };
  review(w, 'A', sha('1'), 't1', 'changes-requested', { b1: finding('BLOCKING', 'x') });
  await runCorrections(w.ctx);
  push(w, 'A', sha('2'), 't1');
  review(w, 'A', sha('2'), 't1', 'changes-requested', {});
  await runCorrections(w.ctx);
  const b = w.state.tickets.B as TicketState & { parked?: { cause: string; blockedBy?: string; reason: string } };
  assert.deepEqual([b.parked?.cause, b.parked?.blockedBy, b.parked?.reason], ['upstream', 'A', 'blocked by A']);
});
test('a parked ticket is left alone by later passes', async () => {
  const w = world();
  review(w, 'A', sha('1'), 't1', 'changes-requested', { b1: finding('BLOCKING', 'x') });
  await runCorrections(w.ctx);
  push(w, 'A', sha('2'), 't1');
  review(w, 'A', sha('2'), 't1', 'changes-requested', {});
  await runCorrections(w.ctx);
  const before = w.woken.length;
  push(w, 'A', sha('3'), 't3');
  assert.deepEqual(await runCorrections(w.ctx), []);
  assert.equal(w.woken.length, before);
  assert.equal(w.reviewerCalls.length, 0);
});

// ── review r1 findings (pre-review) ──────────────────────────────────────────────────────────────────────────────
test('a later settle of a finding never makes the round look undone: no second batch (restart after a state change)', async () => {
  const w = world();
  review(w, 'A', sha('1'), 't1', 'changes-requested', { b1: finding('BLOCKING', 'x'), b2: finding('MAJOR', 'y') });
  await runCorrections(w.ctx);
  w.state = { ...w.state, tickets: { ...w.state.tickets, A: { ...w.state.tickets.A, findings: { ...w.state.tickets.A.findings, b2: { ...w.state.tickets.A.findings.b2, settled: { how: 'fixed', at: T, ref: sha('1') } } } } } };
  await runCorrections(w.ctx);
  assert.equal(w.woken.length, 1);
});
test('a reviewer that changes its mind about UNCHANGED content (other findings, adjacent review) gets a round, not a park', async () => {
  const w = world();
  review(w, 'A', sha('1'), 't1', 'changes-requested', { b1: finding('BLOCKING', 'x') });
  await runCorrections(w.ctx);
  push(w, 'A', sha('2'), 't1');
  review(w, 'A', sha('2'), 't1', 'changes-requested', { b2: finding('BLOCKING', 'y', { raisedOn: sha('2') }) }, ['b1']);
  assert.equal((await runCorrections(w.ctx))[0].action, 'sent');
  assert.equal(parkedOf(w, 'A'), undefined);
});
test('catching up after a restart: several unrecorded reviews → ONE batch (the latest), every round recorded under its review number', async () => {
  const w = world();
  review(w, 'A', sha('1'), 't1', 'changes-requested', { b1: finding('BLOCKING', 'x') });
  push(w, 'A', sha('2'), 't2');
  review(w, 'A', sha('2'), 't2', 'changes-requested', { b2: finding('BLOCKING', 'y', { raisedOn: sha('2') }) }, ['b1']);
  const out = await runCorrections(w.ctx);
  assert.equal(w.woken.length, 1);
  assert.match(w.woken[0].text, /\bb2\b/);
  assert.deepEqual(roundsOf(w, 'A').map((r) => r.n), [1, 2]);
  assert.equal(out.length, 1);
});
test('an unrecorded review on an OLD head (the author already pushed) is recorded, not sent', async () => {
  const w = world();
  review(w, 'A', sha('1'), 't1', 'changes-requested', { b1: finding('BLOCKING', 'x') });
  push(w, 'A', sha('2'), 't2');
  const out = await runCorrections(w.ctx);
  assert.equal(w.woken.length, 0);
  assert.deepEqual(roundsOf(w, 'A').map((r) => r.n), [1]);
  assert.deepEqual(out, [{ ticket: 'A', action: 'reviewer-woken', head: sha('2'), reviewer: 'rv-A' }]);
});
test('a round is recorded under the review NUMBER, not its rank (review 2 approved, review 3 changes → n = 3)', async () => {
  const w = world();
  review(w, 'A', sha('1'), 't1', 'approve');
  review(w, 'A', sha('1'), 't1', 'approve');
  review(w, 'A', sha('1'), 't1', 'changes-requested', { b1: finding('BLOCKING', 'x') });
  await runCorrections(w.ctx);
  assert.deepEqual(roundsOf(w, 'A').map((r) => r.n), [3]);
});
test('catching up: an older review that reads the SAME content as the head is not sent either — only the latest review is', async () => {
  const w = world();
  review(w, 'A', sha('1'), 't1', 'changes-requested', { b1: finding('BLOCKING', 'x') });
  push(w, 'A', sha('2'), 't1');
  review(w, 'A', sha('2'), 't1', 'changes-requested', { b2: finding('BLOCKING', 'y', { raisedOn: sha('2') }) }, ['b1']);
  await runCorrections(w.ctx);
  assert.equal(w.woken.length, 1);
  assert.match(w.woken[0].text, /\bb2\b/);
  assert.doesNotMatch(w.woken[0].text, /\bb1\b/);
});

// ── the process-finding stall (pre-review MAJOR; OPS default: the author's status mail wakes the same reviewer) ──────
const processWorld = async (): Promise<World> => {
  const w = world();
  review(w, 'A', sha('1'), 't1', 'changes-requested', { p1: finding('MINOR', 'say so in the PR body', { kind: 'process', demonstration: DEMO }) });
  await runCorrections(w.ctx);
  return w;
};
test('a process finding: the batch tells the author how it is closed (PR body + a commit + one status)', async () => {
  const w = await processWorld();
  assert.match(w.woken[0].text, /edit the PR body, then push a commit/);
});
test('the author ANSWERS a process batch by status mail with no new head: the SAME reviewer is woken to re-read the PR body + head (raw wake, no second reviewer)', async () => {
  const w = await processWorld();
  w.woken.length = 0;
  w.ctx.mails = [{ kind: 'status', sender: 'ws-A', ticket: 'A', body: 'PR body edited' }];
  const out = await runCorrections(w.ctx);
  assert.deepEqual(out, [{ ticket: 'A', action: 'reviewer-woken', head: sha('1'), reviewer: 'rv-A' }]);
  assert.equal(w.woken.length, 1);
  assert.equal(w.woken[0].ws, 'rv-A');
  assert.match(w.woken[0].text, /re-read the PR body and the head/);
  assert.equal(w.reviewerCalls.length, 0);
});
test('MUST-FAIL: no answer → the reviewer is not woken; a mail from someone else or a plain `ask` is not an answer', async () => {
  const w = await processWorld();
  w.woken.length = 0;
  assert.deepEqual(await runCorrections(w.ctx), []);
  w.ctx.mails = [{ kind: 'status', sender: 'ws-other', ticket: null, body: 'hi' }, { kind: 'ask', sender: 'ws-A', ticket: 'A', body: 'question?' }];
  assert.deepEqual(await runCorrections(w.ctx), []);
  assert.equal(w.woken.length, 0);
});
test('the answer arrives with a DEAD reviewer: the host op replaces it (same call as a new head)', async () => {
  const w = await processWorld();
  w.live.delete('rv-A');
  w.ctx.mails = [{ kind: 'worker_done', sender: 'ws-A', ticket: 'A', body: 'done' }];
  await runCorrections(w.ctx);
  assert.equal(w.reviewerCalls.length, 1);
});
test('an empty commit (new sha, same tree) wakes the reviewer: the finding can only be closed on a LATER head', async () => {
  const w = await processWorld();
  push(w, 'A', sha('2'), 't1');
  const out = await runCorrections(w.ctx);
  assert.deepEqual(out, [{ ticket: 'A', action: 'reviewer-woken', head: sha('2'), reviewer: 'rv-A' }]);
});
