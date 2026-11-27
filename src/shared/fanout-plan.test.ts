// #604 (ledger #613 FROZEN v1) — the plan CHECK: every ticket present, no cycle, each interface holds an exact name, no free text; applyPlan records it as the run's plan; no run decision after it.
// Each rule has a must-pass and a must-fail arm. Mutants: scripts/e2e-fanout-plan.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAN_REASON_CODES, PlanError, applyPlan, checkPlan, interfaceNames, isExactName, parsePlan, planHash, validatePlan, type Plan, type PlanContract, type PlanReasonCode } from './fanout-plan.ts';
import { planAgentName, renderPlanBrief } from './fanout-plan-brief.ts';
import { roleOfName } from './fleet-roles.ts';
import { SeatRefusal, addDecision, newState, parseState, planMissing, readyTickets, setSwitches, type FanoutState } from './fanout-state.ts';

const NOW = '2026-11-25T10:00:00.000Z';
const ids = ['A', 'B', 'C'];
const good = (): Plan => ({
  version: 1,
  tickets: [
    { id: 'A', title: 'orders table', spec: 'ledger #1 §A', specText: 'The orders table.\n\n## Acceptance criteria\n- [ ] has a status column', dependsOn: [] },
    { id: 'B', title: 'orders API', spec: 'ledger #1 §B', specText: 'The orders API, built on the table.', dependsOn: ['A'] },
    { id: 'C', title: 'unrelated', spec: 'ledger #1 §C', specText: 'Something unrelated to the orders.', dependsOn: [] },
  ],
  interfaces: { A: 'column `orders.status`, event `OrderCreated`' },
});
const codes = (r: { reasons: Array<{ code: PlanReasonCode }> }): PlanReasonCode[] => r.reasons.map((x) => x.code);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const seatState = (): FanoutState => newState('r1', { now: NOW, switches: { seatRecords: 'on' } });

test('must-pass: a complete plan is ok, in both forms (object and JSON text)', () => {
  assert.deepEqual(checkPlan(good(), ids), { ok: true, reasons: [] });
  assert.equal(validatePlan(good(), ids).ok, true);
  assert.equal(validatePlan(JSON.stringify(good()), ids).ok, true);
  assert.deepEqual(parsePlan(JSON.stringify(good())).tickets.map((t) => t.id), ids);
});

test('must-fail: a ticket of the run missing from the plan', () => {
  const p = good(); p.tickets = p.tickets.filter((t) => t.id !== 'C');
  const r = checkPlan(p, ids);
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['plan-ticket-missing']);
  assert.match(r.reasons[0].detail, /ticket C/);
});

test('must-fail: a ticket in the plan that is not in the run', () => {
  const p = good(); p.tickets.push({ id: 'Z', title: 'extra', spec: 's', specText: 'extra ticket text', dependsOn: [] });
  const r = checkPlan(p, ids);
  assert.deepEqual(codes(r), ['plan-ticket-unknown']);
  assert.match(r.reasons[0].detail, /ticket Z/);
});

test('must-fail: a ticket named twice', () => {
  const p = good(); p.tickets.push({ ...p.tickets[2] });
  assert.deepEqual(codes(checkPlan(p, ids)), ['plan-duplicate-ticket']);
});

test('must-fail: a cycle (2 and 3 tickets), and a self-dependency is a bad dependency', () => {
  const two = good(); two.tickets[0].dependsOn = ['B']; two.interfaces.B = 'route `POST /orders`';
  const r2 = checkPlan(two, ids);
  assert.deepEqual(codes(r2), ['plan-cycle']);
  assert.match(r2.reasons[0].detail, /A -> B -> A|B -> A -> B/);
  const three = good(); three.tickets[0].dependsOn = ['C']; three.tickets[2].dependsOn = ['B']; three.interfaces.C = '`c.col`'; three.interfaces.B = '`b.col`';
  assert.deepEqual(codes(checkPlan(three, ids)), ['plan-cycle']);
  const self = good(); self.tickets[2].dependsOn = ['C'];
  assert.ok(codes(checkPlan(self, ids)).includes('plan-bad-dependency'));
});

test('must-fail: a dependency on a ticket that is not in the plan', () => {
  const p = good(); p.tickets[1].dependsOn = ['A', 'Q'];
  const r = checkPlan(p, ids);
  assert.deepEqual(codes(r), ['plan-bad-dependency']);
  assert.match(r.reasons[0].detail, /B depends on Q/);
});

test('must-fail: an interface keyed on a ticket that is not in the plan', () => {
  const p = good(); p.interfaces.Q = 'column `q.col`';
  const r = checkPlan(p, ids);
  assert.deepEqual(codes(r), ['plan-ticket-unknown']);
  assert.match(r.reasons[0].detail, /interfaces\.Q/);
});

test('must-fail: a depended-on ticket with no interface (absent, blank)', () => {
  const none = good(); none.interfaces = {};
  assert.deepEqual(codes(checkPlan(none, ids)), ['plan-interface-missing']);
  const blank = good(); blank.interfaces.A = '   ';
  assert.deepEqual(codes(checkPlan(blank, ids)), ['plan-interface-missing']);
});

test('must-fail: an interface with no exact name in backticks (prose, empty ticks, one char, punctuation only, unbalanced)', () => {
  for (const text of ['the orders table with its status column', 'see `` here', 'the ` x ` column', 'uses `->` and `::`', 'half `orders.status']) {
    const p = good(); p.interfaces.A = text;
    assert.deepEqual(codes(checkPlan(p, ids)), ['plan-interface-no-name'], text);
  }
  const p = good(); p.interfaces.A = `a span that is no name: \`${'x'.repeat(250)}\``; // a name is short: 250 characters between two ticks is a sentence
  assert.deepEqual(codes(checkPlan(p, ids)), ['plan-interface-no-name']);
  assert.deepEqual(interfaceNames('column `orders.status`, `POST /orders`, `OrderCreated`'), ['orders.status', 'POST /orders', 'OrderCreated']);
});

test('must-fail: free text — a decision, a note, an order at the top or on a ticket; an over-long title; a multi-line spec', () => {
  for (const key of ['decisions', 'notes', 'order']) {
    const p = { ...clone(good()), [key]: 'build A first, then wait for it to merge' };
    assert.ok(codes(validatePlan(p, ids)).includes('plan-free-text'), key);
    assert.throws(() => parsePlan(p), (e) => e instanceof PlanError && e.reasons.some((r) => r.code === 'plan-free-text'));
  }
  const onTicket = clone(good()) as { tickets: Array<Record<string, unknown>> }; onTicket.tickets[1].note = 'wait for A';
  assert.ok(codes(validatePlan(onTicket, ids)).includes('plan-free-text'));
  const long = clone(good()); long.tickets[0].title = 'x'.repeat(121);
  assert.ok(codes(validatePlan(long, ids)).includes('plan-free-text'));
  const ok120 = clone(good()); ok120.tickets[0].title = 'x'.repeat(120); ok120.tickets[0].specText = 'y'.repeat(130);
  assert.equal(validatePlan(ok120, ids).ok, true);
  const multi = clone(good()); multi.tickets[0].spec = 'ledger\nand wait for B';
  assert.ok(codes(validatePlan(multi, ids)).includes('plan-free-text'));
});

test('must-fail: not JSON, wrong version, wrong types — plan-bad-json', () => {
  for (const raw of ['not json {', '[]', '"x"', JSON.stringify({ ...good(), version: 2 }), JSON.stringify({ version: 1, tickets: 'A', interfaces: {} }), JSON.stringify({ version: 1, tickets: [], interfaces: 3 }), JSON.stringify({ version: 1, tickets: [{ id: 'A b', title: 't', spec: 's', dependsOn: [] }], interfaces: {} })]) {
    assert.ok(codes(validatePlan(raw, ids)).includes('plan-bad-json'), raw);
  }
  const noDeps = clone(good()) as { tickets: Array<Record<string, unknown>> }; delete noDeps.tickets[0].dependsOn;
  assert.ok(codes(validatePlan(noDeps, ids)).includes('plan-bad-json'));
});

test('every reason code of the frozen list is reachable (no dead code)', () => {
  const seen = new Set<PlanReasonCode>();
  const feed = (raw: unknown, want = ids): void => { for (const c of codes(validatePlan(raw, want))) seen.add(c); };
  feed('nope'); feed({ ...good(), notes: 'x' });
  const miss = good(); miss.tickets.pop(); feed(miss);
  const unk = good(); unk.tickets.push({ id: 'Z', title: 't', spec: 's', specText: 'text', dependsOn: [] }); feed(unk);
  const nost = good(); nost.tickets[0].specText = ''; feed(nost);
  const shortt = good(); shortt.tickets[0].specText = 'x'; feed(shortt);
  const k1 = good(); k1.contracts = [{ id: 'c1', owner: 'A', must: '', consumers: ['B'] }]; feed(k1);
  const k2 = good(); k2.contracts = [{ id: 'c1', owner: 'Q', must: 'does x', consumers: ['B'] }]; feed(k2);
  const k3 = good(); k3.contracts = [{ id: 'c1', owner: 'A', must: 'does x', consumers: ['A'] }]; feed(k3);
  const k4 = good(); k4.contracts = [{ id: 'c1', owner: 'A', must: 'does x', consumers: ['B'] }, { id: 'c1', owner: 'A', must: 'does y', consumers: ['C'] }]; feed(k4);
  const dup = good(); dup.tickets.push({ ...dup.tickets[0] }); feed(dup);
  const cyc = good(); cyc.tickets[0].dependsOn = ['B']; feed(cyc);
  const noi = good(); noi.interfaces = {}; feed(noi);
  const non = good(); non.interfaces.A = 'prose'; feed(non);
  const bad = good(); bad.tickets[1].dependsOn = ['Q']; feed(bad);
  assert.deepEqual([...seen].sort(), [...PLAN_REASON_CODES].sort());
});

test('#675 must-fail: an empty / absent / blank specText is refused plan-spec-text-missing; one shorter than the title, plan-spec-text-short; free text in it is no key', () => {
  for (const v of ['', '   \n ', undefined, 7]) {
    const p = clone(good()) as { tickets: Array<Record<string, unknown>> }; if (v === undefined) delete p.tickets[1].specText; else p.tickets[1].specText = v;
    assert.deepEqual(codes(validatePlan(p, ids)), ['plan-spec-text-missing'], String(v));
  }
  const short = clone(good()); short.tickets[0].specText = 'orders'; // 6 chars < the 12 of its title
  assert.deepEqual(codes(validatePlan(short, ids)), ['plan-spec-text-short']);
  const exact = clone(good()); exact.tickets[0].specText = 'orders table'; // as long as its title: accepted
  assert.equal(validatePlan(exact, ids).ok, true);
  const ctl = clone(good()); ctl.tickets[0].specText = 'text with a \u0000 control char';
  assert.ok(codes(validatePlan(ctl, ids)).includes('plan-free-text'));
});

test('#675: applyPlan stores specText verbatim in tickets.<id>.specText (CRLF → LF) next to the spec reference; planHash covers it', () => {
  const st = applyPlan(seatState(), good(), NOW);
  assert.equal(st.tickets.A.specText, 'The orders table.\n\n## Acceptance criteria\n- [ ] has a status column');
  assert.equal(st.tickets.A.spec, 'ledger #1 §A');
  const crlf = clone(good()); crlf.tickets[0].specText = 'The orders table.\r\n- [ ] has a status column';
  assert.equal(applyPlan(seatState(), crlf, NOW).tickets.A.specText, 'The orders table.\n- [ ] has a status column');
  const other = clone(good()); other.tickets[1].specText = 'a different description of B';
  assert.notEqual(planHash(other), planHash(good()), 'a changed ticket text is a different plan');
});

test('#675: the plan brief asks for specText verbatim', () => {
  const b = renderPlanBrief(['A', 'B'], { run: 'r1' });
  assert.match(b, /"specText": "<the ticket's FULL description, verbatim>"/);
  assert.match(b, /refuses an empty one or one shorter than the title/);
});

const withContract = (c: Partial<PlanContract> = {}): Plan => { const p = good(); p.contracts = [{ id: 'c1', owner: 'A', must: 'every path that sets the status dispatches OrderCreated through one function', consumers: ['B', 'C'], ...c }]; return p; };
test('#680 must-pass: a contract (owner, one sentence, consumers) is a valid plan; a plan with none (absent or []) is as before', () => {
  assert.equal(validatePlan(withContract(), ids).ok, true);
  assert.equal(validatePlan({ ...clone(good()), contracts: [] }, ids).ok, true);
  assert.equal(validatePlan(JSON.stringify(withContract()), ids).plan?.contracts?.[0].consumers.join(), 'B,C');
  assert.equal(parsePlan({ ...clone(good()), contracts: [] }).contracts, undefined);
});

test('#680 must-fail: unknown owner / unknown consumer / empty must / consumer = owner / no consumer / twice the same id / free text in a contract', () => {
  assert.deepEqual(codes(validatePlan(withContract({ owner: 'Z' }), ids)), ['plan-contract-unknown-ticket']);
  assert.deepEqual(codes(validatePlan(withContract({ consumers: ['B', 'Z'] }), ids)), ['plan-contract-unknown-ticket']);
  assert.deepEqual(codes(validatePlan(withContract({ must: '  ' }), ids)), ['plan-contract-empty']);
  assert.deepEqual(codes(validatePlan(withContract({ consumers: [] }), ids)), ['plan-contract-empty']);
  assert.deepEqual(codes(validatePlan(withContract({ consumers: ['A', 'B'] }), ids)), ['plan-contract-self']);
  const dup = withContract(); dup.contracts!.push({ ...dup.contracts![0] });
  assert.deepEqual(codes(validatePlan(dup, ids)), ['plan-contract-duplicate']);
  const note = clone(withContract()) as { contracts: Array<Record<string, unknown>> }; note.contracts[0].note = 'wait for A';
  assert.ok(codes(validatePlan(note, ids)).includes('plan-free-text'));
  assert.ok(codes(validatePlan(withContract({ must: 'two\nlines' }), ids)).includes('plan-free-text'));
  assert.ok(codes(validatePlan({ ...clone(good()), contracts: 'x' }, ids)).includes('plan-bad-json'));
  assert.ok(codes(validatePlan(withContract({ id: 'a b' }), ids)).includes('plan-bad-json'));
});

test('#680: applyPlan records the contracts in the state (strict reader round-trip); planHash covers them and is unchanged for a plan with none', () => {
  const st = applyPlan(seatState(), withContract(), NOW);
  assert.deepEqual(st.contracts, withContract().contracts);
  assert.deepEqual(parseState(JSON.parse(JSON.stringify(st))).contracts, st.contracts);
  assert.equal(applyPlan(seatState(), good(), NOW).contracts, undefined);
  assert.notEqual(planHash(withContract()), planHash(good()));
  assert.equal(planHash({ ...good(), contracts: [] }), planHash(good()), 'an empty list is no contract');
  assert.throws(() => parseState({ ...JSON.parse(JSON.stringify(st)), contracts: [{ id: 'c1', owner: 'A', must: 'x y', consumers: ['A'] }] }), /cannot consume its own contract/);
});

test('#680: the plan brief asks for one contract per sentence that names another ticket\'s behaviour, from a fixed text', () => {
  const b = renderPlanBrief(['A', 'B'], { run: 'r1' });
  assert.match(b, /"contracts": \[ \{ "id": "<short id>", "owner": "<ticket>", "must": "<the behaviour, one sentence>", "consumers": \["<ticket>"\] \} \]/);
  assert.match(b, /write ONE contract for every sentence of a ticket that names ANOTHER ticket's behaviour/);
  assert.equal(renderPlanBrief(['A', 'B'], { run: 'r1' }), b, 'deterministic');
});

test('validatePlan reports ALL reasons at once (one retry can fix them all)', () => {
  const p = { ...clone(good()), notes: 'x' } as Record<string, unknown> & Plan;
  p.tickets = p.tickets.filter((t) => t.id !== 'C'); p.interfaces = {};
  assert.deepEqual(codes(validatePlan(p, ids)).sort(), ['plan-free-text', 'plan-interface-missing', 'plan-ticket-missing']);
});

test('applyPlan: records the plan, the dependencies, the interfaces v1, the specs and the marker; the run is ready to start', () => {
  const st = applyPlan(seatState(), good(), NOW);
  assert.deepEqual(st.plan?.tickets, ids);
  assert.deepEqual(st.tickets.B.dependsOn, ['A']);
  assert.equal(st.tickets.B.depsDeclared, true);
  assert.equal(st.tickets.C.depsDeclared, true);
  assert.deepEqual(st.tickets.A.iface, { version: 1, text: 'column `orders.status`, event `OrderCreated`', history: [] });
  assert.equal(st.tickets.A.spec, 'ledger #1 §A');
  assert.deepEqual(st.loopPlan, { at: NOW, hash: planHash(good()), attempts: 1 });
  assert.deepEqual(planMissing(st), []);
  assert.deepEqual(readyTickets(st), ids);
  assert.deepEqual(parseState(JSON.parse(JSON.stringify(st))).loopPlan, st.loopPlan); // survives the strict reader
  assert.equal(applyPlan(seatState(), good(), NOW, 2).loopPlan?.attempts, 2);
});

test('applyPlan: a dependency may name a LATER ticket of the plan; a plan that fails the check is never recorded', () => {
  const p = good(); p.tickets = [p.tickets[1], p.tickets[0], p.tickets[2]];
  assert.deepEqual(applyPlan(seatState(), p, NOW).tickets.B.dependsOn, ['A']);
  const bad = good(); bad.interfaces = {};
  assert.throws(() => applyPlan(seatState(), bad, NOW), (e) => e instanceof SeatRefusal && e.refusal === 'plan-invalid');
});

test('applyPlan: refused under seatRecords=off; the same plan again is a no-op; another plan is refused', () => {
  assert.throws(() => applyPlan(newState('r1', { now: NOW }), good(), NOW), (e) => e instanceof SeatRefusal && e.refusal === 'seat-records-off');
  const st = applyPlan(seatState(), good(), NOW);
  assert.equal(applyPlan(st, good(), '2026-11-25T11:00:00.000Z'), st);
  const other = good(); other.tickets[0].title = 'another';
  assert.throws(() => applyPlan(st, other, NOW), (e) => e instanceof SeatRefusal && e.refusal === 'plan-already-applied');
  const otherNames = good(); otherNames.interfaces.A = 'column `orders.state`'; // same tickets, other names: another plan
  assert.throws(() => applyPlan(st, otherNames, NOW), (e) => e instanceof SeatRefusal && e.refusal === 'plan-already-applied');
});

test('applyPlan: refused once the run has spawned (a started ticket) — nothing is rewritten under a live seat; a ticket named like an Object member is a plain ticket', () => {
  let st = seatState();
  st = applyPlan(st, good(), NOW);
  const spawned = { ...st, loopPlan: undefined, plan: undefined, tickets: { ...st.tickets, A: { ...st.tickets.A, status: 'started' as const } } } as FanoutState;
  delete (spawned as { loopPlan?: unknown }).loopPlan; delete (spawned as { plan?: unknown }).plan;
  assert.throws(() => applyPlan(spawned, good(), NOW), (e) => e instanceof SeatRefusal && e.refusal === 'plan-after-spawn');
  const odd = good(); odd.tickets[0].id = 'constructor'; odd.tickets[1].dependsOn = ['constructor']; odd.interfaces = {};
  const r = checkPlan(odd, ['constructor', 'B', 'C']);
  assert.deepEqual(codes(r), ['plan-interface-missing']); // not a TypeError on the inherited member
});

test('no run decision after the plan; and none BEFORE it either (it would ride in every brief verbatim: [plan-after-decision])', () => {
  const before = addDecision(seatState(), 'Write code only after every upstream is merged', 'r1', NOW);
  assert.equal(before.decisions?.length, 1);
  assert.throws(() => applyPlan(before, good(), NOW), (e) => e instanceof SeatRefusal && e.refusal === 'plan-after-decision');
  assert.equal(applyPlan(seatState(), good(), NOW).decisions, undefined);
  const st = applyPlan(seatState(), good(), NOW);
  assert.throws(() => addDecision(st, 'wait for the upstream candidate', 'r1', NOW), (e) => e instanceof SeatRefusal && e.refusal === 'decision-after-plan');
  void setSwitches;
});

test('the loopPlan marker cannot be forged with an extra key or a bad hash', () => {
  const st = JSON.parse(JSON.stringify(applyPlan(seatState(), good(), NOW)));
  assert.throws(() => parseState({ ...st, loopPlan: { ...st.loopPlan, note: 'x' } }), /unknown/i);
  assert.throws(() => parseState({ ...st, loopPlan: { ...st.loopPlan, hash: 'abc' } }), /sha256/);
});

test('brief: ≤ 1 screen for 7 tickets, lists every ticket and the schema, names the one command, deterministic, no order to wait', () => {
  const t7 = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
  const b = renderPlanBrief(t7, { run: 'c77b2530-198b' });
  assert.ok(b.split('\n').length <= 40, `${b.split('\n').length} lines`);
  assert.ok(b.length <= 3_500, `${b.length} chars`);
  for (const id of t7) assert.match(b, new RegExp(`^- ${id}$`, 'm'));
  assert.match(b, /"version": 1/);
  assert.match(b, /orchestra fanout plan submit <file> --run c77b2530-198b/);
  assert.match(b, /ONCE more/);
  assert.match(b, /under \$TMPDIR \(scratch only[^\n]*run decision is blocked\)[^\n]*submit -/); // the real explorer guard: scratch Write allowed, a repository file / a run decision blocked
  assert.doesNotMatch(b, /denied/);
  assert.match(b, /ONE token/);
  assert.equal(renderPlanBrief(t7, { run: 'c77b2530-198b' }), b);
  assert.doesNotMatch(b, /wait for|after .* merge|one at a time/i);
  assert.match(b, /tickets themselves declare/);
});

test('the agent name is explo-plan-<run8> and carries the explorer role', () => {
  assert.equal(planAgentName('c77b2530-198b-4dc9-bc1b-ef387ad5efdf'), 'explo-plan-c77b2530');
  assert.equal(planAgentName('é!'), 'explo-plan-e');
  assert.equal(planAgentName('---'), 'explo-plan-run');
  assert.equal(roleOfName(planAgentName('c77b2530-198b')), 'explorer');
});

test('names (review r1 m1): ONE token or `METHOD /path`; a backticked sentence, a placeholder, digits are no name; prose around names is allowed', () => {
  for (const ok of ['orders.status', 'POST /orders', 'OrderCreated', '/orders/:id', 'GET /orders?customer=<id>', 'order_lines.order_id', 'Mutation.createOrder', 'v1']) assert.equal(isExactName(ok), true, ok);
  for (const no of ['do not start A until B is merged to master', 'the thing', '10', 'it', 'TODO', 'tbd', 'FIXME', 'x', '--', 'a b', 'POST orders', 'FETCH /orders', 'x'.repeat(81), 'POST /orders now']) assert.equal(isExactName(no), false, no);
  for (const text of ['`do not start A until B is merged to master`', 'the `thing` that A needs', '`10`', '`it`', '`TODO`', 'Wait. `do not write code until B merges`']) {
    const p = good(); p.interfaces.A = text;
    assert.deepEqual(codes(checkPlan(p, ids)), ['plan-interface-no-name'], text);
  }
  const prose = good(); prose.interfaces.A = 'Build against `orders.status` (pending|paid) and the event `OrderCreated`; the rest is up to you.';
  assert.equal(checkPlan(prose, ids).ok, true);
  assert.deepEqual(interfaceNames('`orders.status`, `a long sentence about nothing`, `POST /orders`'), ['orders.status', 'POST /orders']);
});

test('an EMPTY plan is [plan-ticket-missing] (a refusal with a reason, not "could not run")', () => {
  const empty = { version: 1, tickets: [], interfaces: {} };
  assert.deepEqual(codes(validatePlan(empty, [])), ['plan-ticket-missing']);
  assert.deepEqual(codes(validatePlan(empty, ids)), ['plan-ticket-missing', 'plan-ticket-missing', 'plan-ticket-missing', 'plan-ticket-missing']);
  assert.throws(() => applyPlan(seatState(), empty as unknown as Plan, NOW), (e) => e instanceof SeatRefusal && e.refusal === 'plan-invalid');
});
