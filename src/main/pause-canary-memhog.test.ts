// Pause canary 1b — memory-hog exercise (#324): every instrument of the drill has a must-FAIL fixture — a hog that survived, a replaced keeper, a missing notice row, an escalation to the wrong
// recipient, a stray message to the LEAD, a leaked process, an absent metric all read RED. The same instruments are proven on a REAL keeper in REAL scopes by `pnpm run canary:memhog-proof`.
// Mutants of memhog-bars.mjs against THIS file: `node scripts/pause-canary/mutate-bars.mjs --memhog`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — plain .mjs harness module, no declaration file
import { MEMHOG_BARS, KNOWN_RED, evaluateMemhogCycle, summarizeMemhogCycle, evaluateSurvivors, evaluateLiveUntouched, evaluateChainRun, chainVerdict, fmtCap, hogMarker, hasMarker, parseSwarm, readByCoordinator, splitChecks, drillVerdict, missingChecks, REQUIRED_CYCLE_CHECKS, memhogArmVerdict, voidOrFail, backstopWhy, backstopDelta, canaryWord, canaryExit, renderMemhogTable } from '../../scripts/pause-canary/memhog-bars.mjs';
// @ts-expect-error — plain .mjs harness module, no declaration file
import { mustFailVerdict } from '../../scripts/pause-canary/bars.mjs';

type Check = { id: string; ok: boolean; detail: string };
type W = Record<string, any>;
const OPS = 'aaaaaaaa-0000-4000-8000-000000000002';
const CAP = 0.25;
const capBytes = Math.round(CAP * 1024 ** 3);
const worker = (i: number, over: W = {}): W => {
  const id = `aaaaaaaa-0000-4000-8000-0000000000${10 + i}`;
  const marker = `memhog-w${i}-c1`;
  return {
    k: `w${i}`, id, up: true, marker,
    scope: { inRig: true, unit: `orchestra-rig-wh-h3-${id}-x.scope`, memoryMax: capBytes, swapMax: '0', high: 'max', policy: 'continue' },
    swarm: { children: 1, killed: 1, survived: 0 },
    oomKillDelta: 1,
    records: [{ level: 'hard', command: `python3 swarm.py 1 400 5 ${marker}`, source: 'kernel' }],
    session: { keeperSame: true, cliSame: true, keeperAlive: true, cliAlive: true, answered: true, scopeActive: true, capState: 'active' },
    memberKillRows: [`Command "python3 swarm.py 1 400 5 ${marker}" killed: Plafond mémoire 0.25 GB reached`],
    coordMsgs: [{ kind: 'escalation', recipient: OPS, body: `w${i} (${id}): python3 swarm.py killed at the hard level (0.25 GB)` }],
    coordRead: 1,
    backstop: { kLeafKills: 0, beyondWorkKills: 0 },
    ...over,
  };
};
const good = (over: W = {}, n = 3, wover: W = {}) => ({
  exercise: 'memhog', cycle: 1, expectWorkers: n, capGb: CAP, opsId: OPS, leadSeen: 0, tMemberToldS: 1.2, tCoordToldS: 1.4,
  workers: Array.from({ length: n }, (_, i) => worker(i + 1, wover)), ...over,
});
const red = (cs: Check[]) => cs.filter((c) => !c.ok).map((c) => c.id);
const redOf = (over: W = {}, wover: W | ((i: number) => W) = {}, n = 3) => red(evaluateMemhogCycle({ ...good({ ...over }, n), workers: Array.from({ length: n }, (_, i) => worker(i + 1, typeof wover === 'function' ? wover(i + 1) : wover)), ...(over.workers ? { workers: over.workers } : {}) }));

test('a clean cycle is GREEN on every check, and the table counts every worker everywhere', () => {
  const m = good();
  assert.deepEqual(red(evaluateMemhogCycle(m)), []);
  assert.deepEqual(summarizeMemhogCycle(m), { workers: 3, killed: 3, sessions: 3, memberTold: 3, coordTold: 3, kills: 3, backstopKills: 0, backstopOk: 3 });
  assert.match(renderMemhogTable([{ exercise: 'memhog', cycle: 1, expectWorkers: 3, summary: summarizeMemhogCycle(m), checks: evaluateMemhogCycle(m), tMemberToldS: 1.2, tCoordToldS: 1.4 }]), /\| memhog \| 1 \| 3\/3 \| 3\/3 \| 3\/3 \| 3\/3 \| 3\/3 \| 3 \| 0 \| 1\.2 \| 1\.4 \| PASS \|/);
});

test('the cap level is a PARAMETER, not 0.25: a 0.29 GB cap is green only with a 0.29 GB scope, a 0.29 GB row wording and a 0.29 GB escalation', () => {
  const cap = 0.29;
  const w = (i: number, o: W = {}) => worker(i, { scope: { inRig: true, unit: 'u.scope', memoryMax: Math.round(cap * 1024 ** 3), swapMax: '0', high: 'max', policy: 'continue' }, memberKillRows: ['Command "x" killed: Plafond mémoire 0.29 GB reached'], coordMsgs: [{ kind: 'escalation', recipient: OPS, body: `w${i} (${worker(i).id}) killed at the hard level (0.29 GB)` }], ...o });
  const m = { ...good(), capGb: cap, workers: [w(1), w(2), w(3)] };
  assert.deepEqual(red(evaluateMemhogCycle(m)), []);
  assert.deepEqual(red(evaluateMemhogCycle({ ...m, capGb: 0.25 })).sort(), ['bar:cap_scope_applied', 'bar:coordinator_told', 'bar:member_told']);
});

test('the table counts per worker: ONE worker that fails an instrument lowers exactly that column', () => {
  const m = good();
  const broken = { ...m, workers: [m.workers[0], { ...m.workers[1], swarm: { children: 1, killed: 0, survived: 1 }, session: { ...m.workers[1].session, answered: false }, memberKillRows: [], coordMsgs: [], coordRead: 0 }, m.workers[2]] };
  assert.deepEqual(summarizeMemhogCycle(broken), { workers: 3, killed: 2, sessions: 2, memberTold: 2, coordTold: 2, kills: 3, backstopKills: 0, backstopOk: 3 });
});

test('cap OFF (no scope, the hog survives, nobody told) reads RED on exactly the cap bars — the session bar stays green (nothing killed it)', () => {
  const off = (i: number) => worker(i, { scope: { inRig: false, unit: null, memoryMax: null, swapMax: null, high: null, policy: null }, swarm: { children: 1, killed: 0, survived: 1 }, oomKillDelta: 0, records: [], memberKillRows: [], coordMsgs: [], coordRead: 0, session: { keeperSame: true, cliSame: true, keeperAlive: true, cliAlive: true, answered: true, scopeActive: false, capState: 'none' } });
  const r = redOf({}, off);
  for (const id of ['bar:cap_scope_applied', 'bar:hog_killed', 'bar:cap_holds_after_kill', 'bar:member_told', 'bar:coordinator_told', 'bar:only_coordinator_told']) assert.ok(r.includes(id), `${id} must be RED with the cap OFF (got ${r})`);
  assert.ok(!r.includes('bar:session_survives'), 'a session nobody killed is intact even without a cap');
});

test('scope: a missing scope, a wrong memory.max (±1 page ok), an open swap, a MemoryHigh throttle, a group-kill policy are each RED', () => {
  const s = (o: W) => ({ inRig: true, unit: 'u.scope', memoryMax: capBytes, swapMax: '0', high: 'max', policy: 'continue', ...o });
  assert.deepEqual(redOf({}, { scope: s({ memoryMax: capBytes + 65536 }) }), [], '+1 page is the asked cap');
  for (const bad of [{ inRig: false }, { memoryMax: capBytes + 65537 }, { memoryMax: null }, { memoryMax: undefined }, { swapMax: 'max' }, { swapMax: undefined }, { high: '134217728' }, { policy: 'stop' }, { policy: undefined }]) {
    assert.deepEqual(redOf({}, { scope: s(bad) }), ['bar:cap_scope_applied'], JSON.stringify(bad));
  }
  assert.deepEqual(redOf({}, { scope: undefined }), ['bar:cap_scope_applied']);
});

test('hog killed: a survivor, a kernel count of 0, a tool that printed nothing, a kill no record names, and a record naming ANOTHER worker\'s hog are each RED', () => {
  assert.deepEqual(redOf({}, { swarm: { children: 1, killed: 0, survived: 1 }, oomKillDelta: 0, memberKillRows: [], coordMsgs: [], coordRead: 0 }).filter((x) => x === 'bar:hog_killed'), ['bar:hog_killed']);
  assert.deepEqual(redOf({}, { swarm: { children: 2, killed: 1, survived: 1 } }), ['bar:hog_killed'], 'one survivor among the children');
  assert.deepEqual(redOf({}, { oomKillDelta: 0 }).includes('bar:hog_killed'), true, 'the tool says killed but the kernel counted none');
  assert.deepEqual(redOf({}, { swarm: undefined }), ['bar:hog_killed']);
  assert.deepEqual(redOf({}, { oomKillDelta: undefined }).includes('bar:hog_killed'), true);
  assert.deepEqual(redOf({}, { records: [] }), ['bar:hog_killed'], 'killed but unnamed');
  assert.deepEqual(redOf({}, { records: [{ level: 'hard', command: 'python3 swarm.py 1 400 5 memhog-w9-c1' }] }), ['bar:hog_killed'], 'a record naming another worker\'s hog is not this worker\'s kill');
  assert.deepEqual(redOf({}, (i) => (i === 1 ? { records: [{ level: 'soft', command: 'python3 swarm.py 1 400 5 memhog-w1-c1' }] } : {})), ['bar:hog_killed'], 'a warning-level record naming the right hog is not a kill');
  assert.deepEqual(redOf({}, { marker: '' }).includes('bar:hog_killed'), true, 'an empty marker would match every command');
});

test('the hog marker is a WHOLE argument: a record naming `…-c11` does not satisfy `…-c1`', () => {
  assert.equal(hasMarker('python3 swarm.py 1 400 5 memhog-w1-c1', 'memhog-w1-c1'), true);
  assert.equal(hasMarker('python3 swarm.py 1 400 5 memhog-w1-c11', 'memhog-w1-c1'), false);
  assert.equal(hasMarker('python3 swarm.py 1 400 5 xmemhog-w1-c1', 'memhog-w1-c1'), false);
  assert.equal(hasMarker(null, 'memhog-w1-c1'), false);
  assert.equal(hasMarker('anything', ''), false);
  assert.equal(hasMarker('', ''), false, 'an empty marker matches nothing — not even an empty command');
  assert.deepEqual(redOf({}, (i) => (i === 1 ? { marker: 'memhog-w1-c1', records: [{ level: 'hard', command: 'python3 swarm.py 1 400 5 memhog-w1-c11' }] } : {})), ['bar:hog_killed'], 'cycle 11\'s kill is not cycle 1\'s');
});

test('session survives: a replaced or vanished keeper, a replaced or vanished CLI, a CLI that stopped answering, or no facts are each RED; the other worker\'s intact session does not hide it', () => {
  const ses = (o: W) => ({ keeperSame: true, cliSame: true, keeperAlive: true, cliAlive: true, answered: true, scopeActive: true, capState: 'active', ...o });
  for (const bad of [{ keeperSame: false, keeperAlive: false }, { keeperSame: false, keeperAlive: true }, { cliSame: false, cliAlive: false }, { cliSame: false, cliAlive: true }, { answered: false }, { answered: undefined }]) {
    const dead = (bad as W).keeperAlive === false || (bad as W).cliAlive === false;   // a DEAD keeper/CLI is a #343 signal too; a replaced-but-alive one is not
    assert.deepEqual(redOf({}, (i) => (i === 2 ? { session: ses(bad) } : {})).sort(), (dead ? ['bar:no_backstop_kill', 'bar:session_survives'] : ['bar:session_survives']).sort(), JSON.stringify(bad));
  }
  assert.deepEqual(redOf({}, { session: undefined }).sort(), ['bar:cap_holds_after_kill', 'bar:no_backstop_kill', 'bar:session_survives']);
  const r = evaluateMemhogCycle({ ...good(), workers: [worker(1), worker(2, { session: ses({ cliSame: false, cliAlive: false }) }), worker(3)] }).find((c: Check) => c.id === 'bar:session_survives');
  assert.match(r.detail, /2\/3 workers/);
  assert.match(r.detail, /w2: CLI GONE/);
});

test('cap holds after the kill: a stopped scope or a keeper that reports cap.state ≠ active is RED while the session bar stays green', () => {
  assert.deepEqual(redOf({}, { session: { keeperSame: true, cliSame: true, keeperAlive: true, cliAlive: true, answered: true, scopeActive: false, capState: 'active' } }), ['bar:cap_holds_after_kill']);
  assert.deepEqual(redOf({}, { session: { keeperSame: true, cliSame: true, keeperAlive: true, cliAlive: true, answered: true, scopeActive: true, capState: 'not-applied' } }), ['bar:cap_holds_after_kill']);
});

test('member told: no row, one row too many, a row not worded as the #322 notice, the wrong cap in the wording, or no stream reading are each RED', () => {
  const row = (t: string) => ({ memberKillRows: [t] });
  assert.deepEqual(redOf({}, row('A command (probably python3) killed: Plafond mémoire 0.25 GB reached')), [], 'the "probably" wording is the same notice');
  assert.deepEqual(redOf({}, { memberKillRows: [] }), ['bar:member_told']);
  assert.deepEqual(redOf({}, { memberKillRows: ['Command "x" killed: Plafond mémoire 0.25 GB reached', 'Command "x" killed: Plafond mémoire 0.25 GB reached'] }), ['bar:member_told']);
  assert.deepEqual(redOf({}, row('something happened')), ['bar:member_told']);
  assert.deepEqual(redOf({}, row('Command "x" killed: Plafond mémoire 0.30 GB reached')), ['bar:member_told'], 'the row must name the asked cap');
  assert.deepEqual(redOf({}, row('Command "x" killed: Plafond mémoire 0x25 GB reached')), ['bar:member_told'], 'the dot is a dot');
  assert.deepEqual(redOf({}, { memberKillRows: undefined }), ['bar:member_told']);
});

test('coordinator told: no escalation, a duplicate, the wrong recipient, a body that names neither the workspace nor the level, or a relève that does not return it are each RED', () => {
  const m = (o: W = {}) => [{ kind: 'escalation', recipient: OPS, body: 'w1 (aaaaaaaa-0000-4000-8000-000000000011): x killed at the hard level (0.25 GB)', ...o }];
  const w1 = (o: W) => (i: number) => (i === 1 ? o : {});
  assert.deepEqual(redOf({}, w1({ coordMsgs: [], coordRead: 0 })).includes('bar:coordinator_told'), true);
  assert.deepEqual(redOf({}, w1({ coordMsgs: [...m(), ...m()], coordRead: 2 })).includes('bar:coordinator_told'), true, 'two escalations for one kill');
  assert.deepEqual(redOf({}, w1({ coordMsgs: m({ recipient: 'someone-else' }) })).includes('bar:coordinator_told'), true, 'an escalation addressed to someone else does not tell THE coordinator');
  assert.deepEqual(redOf({}, w1({ coordMsgs: [...m(), ...m({ recipient: 'the-lead' })] })), ['bar:only_coordinator_told'], 'a stray copy to the LEAD is the stray bar\'s business: the coordinator WAS told, exactly once');
  assert.deepEqual(redOf({}, w1({ coordMsgs: m({ body: 'killed at the hard level (0.25 GB)' }) })).includes('bar:coordinator_told'), true, 'must name the workspace');
  assert.deepEqual(redOf({}, w1({ coordMsgs: m({ body: 'aaaaaaaa-0000-4000-8000-000000000011 killed' }) })).includes('bar:coordinator_told'), true, 'must name the level');
  assert.deepEqual(redOf({}, w1({ coordRead: 0 })), ['bar:coordinator_told'], 'written but not readable by the coordinator\'s own relève');
  assert.deepEqual(redOf({}, w1({ coordRead: undefined })), ['bar:coordinator_told']);
  assert.deepEqual(redOf({}, w1({ coordMsgs: [{ kind: 'status', recipient: OPS, body: 'w1 (aaaaaaaa-0000-4000-8000-000000000011) warning level' }, ...m()] })), [], 'a warning-level `status` is not a kill escalation and does not count against it');
});

test('only the coordinator is told: a copy to the LEAD, a stray recipient, a body naming another sender, an unmeasured LEAD relève, or nothing at all on the bus are each RED', () => {
  assert.deepEqual(redOf({ leadSeen: 1 }), ['bar:only_coordinator_told']);
  assert.deepEqual(redOf({ leadSeen: undefined }), ['bar:only_coordinator_told']);
  assert.deepEqual(redOf({ leadSeen: null }), ['bar:only_coordinator_told']);
  assert.deepEqual(redOf({}, (i) => (i === 3 ? { coordMsgs: [{ kind: 'escalation', recipient: OPS, body: 'w1 (aaaaaaaa-0000-4000-8000-000000000011) hard level (0.25 GB)' }] } : {})).includes('bar:only_coordinator_told'), true, 'w3\'s message names w1');
  assert.deepEqual(redOf({}, { coordMsgs: [], coordRead: 0 }).includes('bar:only_coordinator_told'), true, 'no message = nothing attributed = NOT MEASURED, never a pass');
});

test('workers: fewer workers measured than expected, none, or one that never came up is RED on workers_up and the per-worker bars', () => {
  const m = good();
  assert.deepEqual(red(evaluateMemhogCycle({ ...m, workers: m.workers.slice(0, 2) })).includes('workers_up'), true);
  assert.deepEqual(red(evaluateMemhogCycle({ ...m, workers: m.workers.slice(0, 2) })).includes('bar:hog_killed'), true, 'a missing worker is not a vacuous pass of the others');
  assert.deepEqual(red(evaluateMemhogCycle({ ...m, workers: [] })).includes('workers_up'), true);
  assert.deepEqual(red(evaluateMemhogCycle({ ...m, expectWorkers: 0, workers: [] })).includes('workers_up'), true, 'a drill that expects no worker proved nothing');
  assert.deepEqual(red(evaluateMemhogCycle({ ...m, workers: undefined })).includes('bar:session_survives'), true);
  assert.deepEqual(red(evaluateMemhogCycle({ ...m, workers: [m.workers[0], { ...m.workers[1], up: false }, m.workers[2]] })), ['workers_up']);
});

test('published metrics: absent = RED (they can never be silently dropped); a value is green with no bar', () => {
  assert.deepEqual(redOf({ tMemberToldS: null }), ['published:time_to_member_told_s']);
  assert.deepEqual(redOf({ tCoordToldS: Number.NaN }), ['published:time_to_coordinator_told_s']);
  assert.deepEqual(redOf({ tMemberToldS: 900, tCoordToldS: 900 }), [], 'there is no latency bar in the ticket: 15 minutes is published, not failed');
});

test('survivors and live config: any leftover process or scope, an unmeasured count, or a changed snapshot is RED', () => {
  assert.equal(evaluateSurvivors({ procs: 0, units: 0 }).ok, true);
  assert.equal(evaluateSurvivors({ procs: 1, units: 0 }).ok, false);
  assert.equal(evaluateSurvivors({ procs: 0, units: 2 }).ok, false);
  assert.equal(evaluateSurvivors({ procs: 0 }).ok, false);
  assert.equal(evaluateSurvivors(null).ok, false);
  const snap = { '.claude': { n: 43, links: 3, manifest: 'abc' }, liveBusPresent: true };
  assert.equal(evaluateLiveUntouched(snap, JSON.parse(JSON.stringify(snap))).ok, true);
  assert.equal(evaluateLiveUntouched(snap, { ...snap, '.claude': { n: 42, links: 3, manifest: 'abc' } }).ok, false);
  assert.equal(evaluateLiveUntouched(snap, null).ok, false);
  assert.equal(evaluateLiveUntouched(null, snap).ok, false);
});

const chainRun = (o: W = {}) => ({ planned: MEMHOG_BARS.chainPlanned, done: MEMHOG_BARS.chainPlanned, killsTotal: MEMHOG_BARS.chainPlanned, inScope: true, cliSeen: true, lostAfter: null, backstop: { kLeafKills: 0, beyondWorkKills: 0 }, keeperAlive: true, cliAlive: true, answered: true, ...o });

test('Q9 chain (a BAR since #332): a session lost after 7 kills reads RED on the chain bar AND the backstop bar and green on the premise; a full survived chain is green; a chain that killed nothing is a VOID premise', () => {
  const lost = evaluateChainRun(chainRun({ done: 8, killsTotal: 7, lostAfter: 7, keeperAlive: false, cliAlive: false, answered: false }));
  assert.deepEqual(red(lost), ['q9:session_survives_chain', 'bar:no_backstop_kill'], 'a dead keeper + CLI is a #343 signal too');
  assert.match(lost.find((c: Check) => c.id === 'q9:session_survives_chain').detail, /LOST after 7 .*keeper GONE, CLI GONE/);
  assert.deepEqual(red(evaluateChainRun(chainRun({ killsTotal: 0, lostAfter: 0, done: 1, keeperAlive: false, cliAlive: false, answered: false }))), ['q9:session_survives_chain', 'bar:no_backstop_kill'], 'a session lost at the VERY FIRST kill (the counter dies with the scope: 0 read) is a loss, not an unexercised chain');
  assert.deepEqual(red(evaluateChainRun(chainRun({ inScope: false }))), ['premise_chain_killed_tools'], 'no capped scope: nothing was measured');
  assert.match(evaluateChainRun(chainRun({ answered: false })).find((c: Check) => c.id === 'q9:session_survives_chain').detail, /ALIVE BUT DID NOT ANSWER/, 'a session that is alive but silent says so — not « lost after N kills »');
  assert.deepEqual(red(evaluateChainRun(chainRun())), []);
  assert.deepEqual(red(evaluateChainRun(chainRun({ killsTotal: 0 }))).includes('premise_chain_killed_tools'), true, 'cap OFF: nothing was killed');
  assert.deepEqual(red(evaluateChainRun(chainRun({ killsTotal: 12 }))).includes('premise_chain_killed_tools'), true, 'a "survived" chain that killed 12 of 30 tools did not exercise the cap');
  assert.deepEqual(red(evaluateChainRun(chainRun({ done: 29 }))), ['q9:session_survives_chain'], 'a chain cut short is not a survival');
  assert.deepEqual(red(evaluateChainRun(chainRun({ answered: false }))), ['q9:session_survives_chain']);
  assert.deepEqual(red(evaluateChainRun(chainRun({ keeperAlive: undefined }))), ['q9:session_survives_chain', 'bar:no_backstop_kill']);
});

test('Q9 chain (review 2, finding 6): a CLI that never initialised, or a CLI lost with NO kernel kill while the keeper lives, is a VOID premise — never a FAIL « session lost »', () => {
  const never = evaluateChainRun(chainRun({ cliSeen: false, killsTotal: 0, lostAfter: 0, done: 1, keeperAlive: true, cliAlive: false, answered: false }));
  assert.ok(red(never).includes('premise_chain_killed_tools'));
  assert.match(never.find((c: Check) => c.id === 'premise_chain_killed_tools').detail, /the CLI never initialised/);
  assert.equal(chainVerdict([never]).verdict, 'VOID');
  const neverKeeperGone = evaluateChainRun(chainRun({ cliSeen: false, killsTotal: 0, lostAfter: 0, done: 1, keeperAlive: false, cliAlive: false, answered: false }));
  assert.ok(red(neverKeeperGone).includes('premise_chain_killed_tools'), 'the keeper is gone but the CLI never came up: a start failure, not the cap');
  assert.equal(chainVerdict([neverKeeperGone]).verdict, 'VOID');
  const noKill = evaluateChainRun(chainRun({ killsTotal: 0, lostAfter: 0, done: 2, keeperAlive: true, cliAlive: false, answered: false }));
  assert.ok(red(noKill).includes('premise_chain_killed_tools'), 'the CLI vanished with nothing killed and the keeper alive: not the cap');
  assert.equal(chainVerdict([noKill]).verdict, 'VOID');
  const afterKill = evaluateChainRun(chainRun({ killsTotal: 2, lostAfter: 2, done: 3, keeperAlive: true, cliAlive: false, answered: false }));
  assert.deepEqual(red(afterKill), ['q9:session_survives_chain', 'bar:no_backstop_kill'], 'the CLI vanished AFTER a kernel kill: the cap reached it');
  assert.equal(chainVerdict([afterKill]).verdict, 'FAIL');
  const keeperGone = evaluateChainRun(chainRun({ killsTotal: 0, lostAfter: 0, done: 1, keeperAlive: false, cliAlive: false, answered: false }));
  assert.deepEqual(red(keeperGone), ['q9:session_survives_chain', 'bar:no_backstop_kill'], 'the keeper went with the scope at the first kill (the counter died with it)');
});

test('Q9 chain: a recorded loss is a loss even if the liveness flags were read after a respawn', () => {
  assert.deepEqual(red(evaluateChainRun(chainRun({ lostAfter: 3 }))), ['q9:session_survives_chain']);
});

test('chain verdict (Q9 is a BAR since #332): FAIL while any run loses the session or trips the backstop, PASS only when none does, VOID without evidence — and the chain checks decide a drill like any bar', () => {
  const lost = evaluateChainRun(chainRun({ done: 8, killsTotal: 7, lostAfter: 7, keeperAlive: false, cliAlive: false, answered: false }));
  const ok = evaluateChainRun(chainRun());
  const none = evaluateChainRun(chainRun({ killsTotal: 0 }));
  const bsOnly = evaluateChainRun(chainRun({ backstop: { kLeafKills: 1, beyondWorkKills: 1 } }));   // the session SURVIVED, but the kernel killed something in the keeper leaf
  assert.equal(chainVerdict([lost, lost, lost]).verdict, 'FAIL');
  assert.equal(chainVerdict([ok, lost, ok]).verdict, 'FAIL', 'one lost session in three is the regression');
  assert.equal(chainVerdict([ok, ok, ok]).verdict, 'PASS');
  assert.equal(chainVerdict([ok, bsOnly, ok]).verdict, 'FAIL', 'a surviving session that tripped the backstop once is still a #343 episode');
  assert.match(chainVerdict([ok, bsOnly]).detail, /1\/2 run\(s\) lost the session or tripped the scope backstop \(backstop kill: .*k\)? ?oom_kill \+1/);
  assert.equal(chainVerdict([none, lost]).verdict, 'VOID');
  assert.equal(chainVerdict([]).verdict, 'VOID');
  assert.match(chainVerdict([lost, lost]).detail, /2\/2 run\(s\) lost the session or tripped the scope backstop \(session lost after 7 kill\(s\); session lost after 7 kill\(s\)\)/);
  assert.match(chainVerdict([evaluateChainRun(chainRun({ answered: false }))]).detail, /alive but unresponsive/);
  assert.deepEqual(Object.keys(KNOWN_RED), [], 'Q9 was promoted by emptying the table');
  const s = splitChecks([...lost, ...evaluateMemhogCycle(good())]);
  assert.deepEqual(s.knownRed, []);
  assert.deepEqual(s.barsRed.map((c: Check) => c.id), ['q9:session_survives_chain', 'bar:no_backstop_kill']);
  assert.equal(drillVerdict([...lost, ...evaluateMemhogCycle(good())]), 'FAIL', 'a lost chain session now fails a drill');
  assert.equal(drillVerdict([...ok, ...evaluateMemhogCycle(good())]), 'PASS');
  assert.equal(drillVerdict([...evaluateMemhogCycle(good({ tMemberToldS: null }))]), 'FAIL', 'a missing published metric fails the drill');
  assert.equal(drillVerdict([{ id: 'bar:no_survivors', ok: false, detail: 'LEAK' }]), 'FAIL');
  assert.equal(drillVerdict([]), 'FAIL', 'an empty list is NOT a pass');
  assert.equal(drillVerdict([{ id: 'bar:no_survivors', ok: true, detail: '' }]), 'FAIL', 'a drive that died before measuring leaves only the runner\'s check: NOT a pass');
  const cyc = evaluateMemhogCycle(good());
  assert.equal(drillVerdict(cyc), 'PASS', 'control: a complete green list is');
  for (const id of REQUIRED_CYCLE_CHECKS) assert.equal(drillVerdict(cyc.filter((c: Check) => c.id !== id)), 'FAIL', `${id} absent`);
  assert.deepEqual(missingChecks(cyc.filter((c: Check) => c.id !== 'bar:hog_killed')), ['bar:hog_killed']);
  assert.equal(drillVerdict(cyc, [...REQUIRED_CYCLE_CHECKS, 'bar:no_survivors']), 'FAIL', 'the runner can demand its own checks too');
});


test('arm verdict: the named instrument RED + precision. Unreached rig, a RED premise, a stayed-green instrument and an over-red sabotage are each NOT "AS-EXPECTED"', () => {
  assert.equal(memhogArmVerdict({ reached: true, premiseRed: [], hit: ['bar:hog_killed'] }), 'AS-EXPECTED (RED)');
  assert.equal(memhogArmVerdict({ reached: true, premiseRed: [], hit: [] }), 'MUTANT-SURVIVED');
  assert.equal(memhogArmVerdict({ reached: false, premiseRed: [], hit: ['bar:hog_killed'] }), 'RIG-BROKE');
  assert.equal(memhogArmVerdict({ reached: true, premiseRed: ['premise_hog_ran'], hit: ['bar:hog_killed'] }), 'RIG-BROKE');
  assert.equal(memhogArmVerdict({ reached: true, premiseRed: [], hit: ['bar:member_told'], overRed: ['bar:coordinator_told'] }), 'OVER-RED');
  assert.equal(memhogArmVerdict({ reached: true, premiseRed: [], hit: [], overRed: ['bar:coordinator_told'] }), 'MUTANT-SURVIVED');
  assert.equal(mustFailVerdict({ reached: true, premiseRed: [], hit: ['x'] }), 'AS-EXPECTED (RED)');
});

test('measurement helpers: the hog marker is unique per worker and cycle; the swarm line parses or is null; "read" means a lot taken AND acked that covers the sequence', () => {
  assert.equal(hogMarker('w1', 2), 'memhog-w1-c2');
  assert.notEqual(hogMarker('w1', 1), hogMarker('w1', 11), 'distinct per cycle (`hasMarker` matches whole arguments, c1 is a prefix of c11)');
  assert.deepEqual(parseSwarm('x\nswarm: children=1 survived=0 killed=1\n'), { children: 1, survived: 0, killed: 1 });
  assert.equal(parseSwarm('hog: touched 40 MB'), null);
  assert.equal(parseSwarm(undefined), null);
  const lots = [{ from_seq: 10, to_seq: 20, acked_at: 5 }, { from_seq: 20, to_seq: 30, acked_at: null }];
  assert.equal(readByCoordinator([10, 11, 20, 21, 30], lots), 2, '11 and 20 are in the acked lot (10,20]; 10 is its excluded lower bound; 21 and 30 are in a lot never acked');
  assert.equal(readByCoordinator([15], []), 0);
  assert.equal(readByCoordinator([15], [{ from_seq: 10, to_seq: 20 }]), 0, 'no acked_at at all is not an ack');
});

test('fmtCap words the cap exactly as the product does (integers bare, else <= 2 decimals): the 1 GiB cap of the LEAD\'s Q11 run is « 1 GB », not « 1.00 GB »', () => {
  assert.equal(fmtCap(0.25), '0.25 GB');
  assert.equal(fmtCap(0.29), '0.29 GB');
  assert.equal(fmtCap(0.75), '0.75 GB');
  assert.equal(fmtCap(1), '1 GB');
  assert.equal(fmtCap(1.5), '1.5 GB');
  assert.equal(fmtCap(6), '6 GB');
  const one = { ...good(), capGb: 1, workers: [1, 2, 3].map((i) => worker(i, { scope: { inRig: true, unit: 'u.scope', memoryMax: 1024 ** 3, swapMax: '0', high: 'max', policy: 'continue' }, memberKillRows: ['Command "x" killed: Plafond mémoire 1 GB reached'], coordMsgs: [{ kind: 'escalation', recipient: OPS, body: `w${i} (${worker(i).id}) killed at the hard level (1 GB)` }] })) };
  assert.deepEqual(red(evaluateMemhogCycle(one)), [], 'a 1 GiB cap with the product\'s wording is green');
  assert.deepEqual(red(evaluateMemhogCycle({ ...one, workers: one.workers.map((w: W) => ({ ...w, memberKillRows: ['Command "x" killed: Plafond mémoire 1.00 GB reached'] })) })), ['bar:member_told'], 'and « 1.00 GB » is not what the product says');
});

test('renderMemhogTable: an ABORTED cycle (no summary) is a row, not a TypeError that loses the report (review 2, finding 8)', () => {
  const m = good();
  const table = renderMemhogTable([{ exercise: 'memhog-app', cycle: 1, expectWorkers: 3, summary: summarizeMemhogCycle(m), checks: evaluateMemhogCycle(m), tMemberToldS: 1, tCoordToldS: 1 }, { exercise: 'memhog-app', cycle: 2, expectWorkers: 3, checks: [] }]);
  assert.match(table, /\| memhog-app \| 1 \| 3\/3 .* PASS \|/);
  assert.match(table, /\| memhog-app \| 2 \| n\/a .* ABORTED/);
});

test('voidOrFail: a drill the host cut short is VOID — unless a bar was already measured RED (then FAIL, the RED is evidence); a RED published timing or a green list stays VOID', () => {
  const bar = (id: string, ok: boolean) => ({ id, ok, detail: 'x' });
  assert.equal(voidOrFail([]), 'VOID');
  assert.equal(voidOrFail(undefined), 'VOID');
  assert.equal(voidOrFail([bar('bar:hog_killed', true), bar('bar:member_told', true)]), 'VOID');
  assert.equal(voidOrFail([bar('bar:hog_killed', true), bar('bar:member_told', false)]), 'FAIL');
  assert.equal(voidOrFail([bar('published:time_to_member_told_s', false)]), 'VOID', 'a published timing is not a bar');
  assert.equal(voidOrFail([bar('q9:session_survives_chain', false)]), 'FAIL', 'the chain is a BAR since #332: a RED measured before the cut is evidence');
});

test('#343 backstop bar: a k-leaf kill, a scope kill beyond the work leaf\'s, a dead keeper or a dead CLI are each RED with the signal named; absent counters are NOT MEASURED (RED), never zero; a clean worker is green', () => {
  assert.deepEqual(redOf({}, {}), [], 'control: zero counters, both alive');
  const one = (o: W) => redOf({}, (i) => (i === 2 ? o : {}));
  assert.deepEqual(one({ backstop: { kLeafKills: 1, beyondWorkKills: 1 } }), ['bar:no_backstop_kill'], 'a kill INSIDE the keeper leaf');
  assert.deepEqual(one({ backstop: { kLeafKills: 0, beyondWorkKills: 2 } }), ['bar:no_backstop_kill'], 'a scope-level kill the work leaf does not own');
  assert.deepEqual(one({ backstop: undefined }), ['bar:no_backstop_kill'], 'no counters');
  assert.deepEqual(one({ backstop: { kLeafKills: null, beyondWorkKills: 0 } }), ['bar:no_backstop_kill']);
  assert.deepEqual(one({ backstop: { kLeafKills: 0, beyondWorkKills: undefined } }), ['bar:no_backstop_kill']);
  const ses = (o: W) => ({ keeperSame: true, cliSame: true, keeperAlive: true, cliAlive: true, answered: true, scopeActive: true, capState: 'active', ...o });
  assert.deepEqual(one({ session: ses({ keeperAlive: false, keeperSame: false }) }).sort(), ['bar:no_backstop_kill', 'bar:session_survives']);
  assert.deepEqual(one({ session: ses({ cliAlive: false, cliSame: false }) }).sort(), ['bar:no_backstop_kill', 'bar:session_survives']);
  assert.match(backstopWhy(worker(1, { backstop: { kLeafKills: 1, beyondWorkKills: 1 } })), /^BACKSTOP episode: keeper-leaf \(k\) oom_kill \+1, scope oom_kill \+1 beyond the work leaf's$/);
  assert.match(backstopWhy(worker(1, { session: ses({ keeperAlive: false, cliAlive: false }) })), /keeper dead, CLI dead/);
  assert.equal(backstopWhy(worker(1)), null);
  assert.match(String(backstopWhy(worker(1, { backstop: undefined }))), /^NOT MEASURED/);
  const detail = evaluateMemhogCycle(good({}, 3, { backstop: { kLeafKills: 1, beyondWorkKills: 1 } })).find((c: Check) => c.id === 'bar:no_backstop_kill')!.detail;
  assert.match(detail, /0\/3 workers had NO scope-backstop kill/);
  assert.ok(REQUIRED_CYCLE_CHECKS.includes('bar:no_backstop_kill'), 'a drill without the backstop check is not a PASS');
  const m = good({}, 3, {});
  m.workers[1] = worker(2, { backstop: { kLeafKills: 1, beyondWorkKills: 3 } });
  assert.equal(summarizeMemhogCycle(m).backstopKills, 3, 'the verdict COUNTS the episodes (beyond-work total, the k-leaf ones included)');
  assert.equal(summarizeMemhogCycle(m).backstopOk, 2);
  assert.match(renderMemhogTable([{ exercise: 'memhog', cycle: 1, expectWorkers: 3, summary: summarizeMemhogCycle(m), checks: evaluateMemhogCycle(m), tMemberToldS: 1, tCoordToldS: 1 }]), /\| 3 \| 3 \| 1\.0 \| 1\.0 \| FAIL \(no_backstop_kill\) \|/);
});

test('backstopDelta: the window\'s kills are the k-leaf counter\'s rise and the rise of (scope − work); an unreadable or DECREASING counter is null, never zero', () => {
  const c = (k: number | null, scope: number | null, work: number | null) => ({ k, scope, work });
  assert.deepEqual(backstopDelta(c(0, 2, 2), c(0, 5, 5)), { kLeafKills: 0, beyondWorkKills: 0 }, 'three kills, all in the work leaf: the hog kills of the cap');
  assert.deepEqual(backstopDelta(c(0, 2, 2), c(1, 6, 5)), { kLeafKills: 1, beyondWorkKills: 1 }, 'one more in k, counted by the (hierarchical) scope too');
  assert.deepEqual(backstopDelta(c(0, 0, 0), c(0, 2, 0)), { kLeafKills: 0, beyondWorkKills: 2 }, 'a kill at the scope level itself');
  assert.equal(backstopDelta(null, c(0, 0, 0)), null);
  assert.equal(backstopDelta(c(0, 0, 0), null), null);
  assert.equal(backstopDelta(c(0, 0, 0), c(null, 0, 0)), null);
  assert.equal(backstopDelta(c(0, 0, 0), c(0, null, 0)), null);
  assert.equal(backstopDelta(c(0, 0, 0), c(0, 0, null)), null);
  assert.equal(backstopDelta(c(3, 5, 2), c(2, 5, 2)), null, 'a counter that went down is another cgroup, not an improvement');
  assert.equal(backstopDelta(undefined, undefined), null);
});

test('the verdict word and its exit code: PASS needs the memhog drill green AND the full shape AND the chain PASS; a chain asked for and not PASS never leaves a green word; no exit code 5 any more (Q9 is a bar)', () => {
  const w = (o: W) => canaryWord({ hasMh: true, hasCh: true, mhVerdict: 'PASS', full: true, chV: 'PASS', chainSurvBad: false, liveOk: true, ...o });
  assert.equal(w({}), 'PASS');
  assert.equal(w({ full: false }), 'PARTIAL');
  assert.equal(w({ chV: 'FAIL' }), 'FAIL', 'the chain lost a session / tripped the backstop');
  assert.equal(w({ chV: 'FAIL', full: false }), 'FAIL');
  assert.equal(w({ chV: 'VOID' }), 'VOID');
  assert.equal(w({ chV: 'INCOMPLETE' }), 'FAIL', 'a chain cut short is not measured');
  assert.equal(w({ chV: 'ERROR' }), 'FAIL');
  assert.equal(w({ mhVerdict: 'FAIL' }), 'FAIL');
  assert.equal(w({ mhVerdict: 'VOID' }), 'VOID');
  const chainOnly = (o: W) => canaryWord({ hasMh: false, hasCh: true, mhVerdict: null, full: false, chV: 'PASS', chainSurvBad: false, liveOk: true, ...o });
  assert.equal(chainOnly({}), 'PASS');
  assert.equal(chainOnly({ chV: 'FAIL' }), 'FAIL');
  assert.equal(chainOnly({ chV: 'VOID' }), 'VOID');
  assert.equal(chainOnly({ chainSurvBad: true }), 'FAIL', 'a leak fails whatever ran');
  assert.equal(chainOnly({ liveOk: false }), 'FAIL', 'a changed live config fails whatever ran');
  assert.equal(canaryWord({ hasMh: false, hasCh: false, mhVerdict: null, full: false, chV: null, chainSurvBad: false, liveOk: true }), 'NOT-RUN');
  assert.deepEqual(['PASS', 'PARTIAL', 'VOID', 'NOT-RUN', 'FAIL', 'KNOWN-RED-GONE', 'KNOWN-RED'].map(canaryExit), [0, 4, 3, 3, 1, 1, 1], 'the old KNOWN-RED words fall to 1: nothing exits 5');
});

test('splitChecks: with a KNOWN-RED table the listed ids are published, never decisive when RED, and a GREEN one is reported; with the shipped (empty) table every check is a bar', () => {
  const checks = [{ id: 'bar:a', ok: true, detail: '' }, { id: 'x:known', ok: false, detail: '' }, { id: 'bar:b', ok: false, detail: '' }];
  const table = { 'x:known': { what: 'x', ticket: 'x', ref: 'x' } };
  const s = splitChecks(checks, table);
  assert.deepEqual(s.known.map((c: Check) => c.id), ['x:known']);
  assert.deepEqual(s.bars.map((c: Check) => c.id), ['bar:a', 'bar:b']);
  assert.deepEqual(s.barsRed.map((c: Check) => c.id), ['bar:b'], 'a RED known-red check never fails the drill');
  assert.deepEqual(s.knownRed.map((c: Check) => c.id), ['x:known']);
  assert.equal(splitChecks([{ id: 'x:known', ok: true, detail: '' }], table).knownGreen.length, 1);
  const shipped = splitChecks(checks);
  assert.deepEqual(shipped.known, [], 'the shipped table is empty: nothing is excused');
  assert.deepEqual(shipped.barsRed.map((c: Check) => c.id), ['x:known', 'bar:b']);
});

test('cap holds: a degradation line in the keeper log is RED on bar:cap_holds_after_kill with its text, even when the state reads active (OPS 7283)', () => {
  const ses = (o: W) => ({ keeperSame: true, cliSame: true, keeperAlive: true, cliAlive: true, answered: true, scopeActive: true, capState: 'active', ...o });
  assert.deepEqual(redOf({}, { session: ses({ capDegradations: [] }) }), []);
  assert.deepEqual(redOf({}, { session: ses({ capDegradations: undefined }) }), [], 'the stand-in path without a log reading is not penalised here (its state is the live probe)');
  assert.deepEqual(redOf({}, { session: ses({ capDegradations: ['memory cap: TRIPWIRE — nothing is capped'] }) }), ['bar:cap_holds_after_kill']);
  const d = evaluateMemhogCycle({ ...good(), workers: [worker(1), worker(2, { session: ses({ capDegradations: ['memory cap: TRIPWIRE — nothing is capped', 'x'] }) }), worker(3)] }).find((c: Check) => c.id === 'bar:cap_holds_after_kill')!.detail;
  assert.match(d, /w2: keeper\.log reports 2 degradation line\(s\): "memory cap: TRIPWIRE — nothing is capped"/);
});

test('review 4: a measured chain FAIL is never hidden by a VOID memhog drill; an empty or incomplete chain run is VOID, not PASS; COUNTED backstop kills outrank a premise RED (but a premise RED without counted kills stays VOID); a missing alive fact is RED', () => {
  const w = (o: W) => canaryWord({ hasMh: true, hasCh: true, mhVerdict: 'PASS', full: true, chV: 'PASS', chainSurvBad: false, liveOk: true, ...o });
  assert.equal(w({ mhVerdict: 'VOID', chV: 'FAIL' }), 'FAIL', 'm2');
  assert.equal(w({ mhVerdict: 'VOID', chV: 'PASS' }), 'VOID');
  assert.equal(w({ mhVerdict: 'VOID', chV: 'VOID' }), 'VOID');
  assert.equal(w({ mhVerdict: 'FAIL', chV: 'FAIL' }), 'FAIL');
  assert.equal(canaryWord({ hasMh: false, hasCh: true, mhVerdict: null, full: false, chV: 'FAIL', chainSurvBad: false, liveOk: true }), 'FAIL');
  assert.equal(chainVerdict([[]]).verdict, 'VOID', 'm3: a run with no checks measured nothing');
  assert.equal(chainVerdict([evaluateChainRun(chainRun()), []]).verdict, 'VOID');
  const noBs = evaluateChainRun(chainRun()).filter((c: Check) => c.id !== 'bar:no_backstop_kill');
  assert.equal(chainVerdict([noBs]).verdict, 'VOID', 'a run lacking the backstop check is incomplete');
  // a CLI killed by the BACKSTOP: keeper alive, the work leaf saw no kill (premise RED), but k / the scope did
  const bsKilled = evaluateChainRun(chainRun({ killsTotal: 0, lostAfter: 0, done: 2, keeperAlive: true, cliAlive: false, answered: false, backstop: { kLeafKills: 1, beyondWorkKills: 1 } }));
  assert.ok(red(bsKilled).includes('premise_chain_killed_tools'));
  assert.equal(chainVerdict([bsKilled]).verdict, 'FAIL', 'counted backstop kills are evidence whatever the premise says');
  assert.match(chainVerdict([bsKilled]).detail, /backstop kill/);
  const noKill = evaluateChainRun(chainRun({ killsTotal: 0, lostAfter: 0, done: 2, keeperAlive: true, cliAlive: false, answered: false }));
  assert.equal(chainVerdict([noKill]).verdict, 'VOID', 'control: the same loss with ZERO counted kills is still a premise failure');
  const ses = (o: W) => ({ keeperSame: true, cliSame: true, keeperAlive: true, cliAlive: true, answered: true, scopeActive: true, capState: 'active', ...o });
  assert.match(String(backstopWhy(worker(1, { session: ses({ keeperAlive: undefined }) }))), /keeper dead/, 'unknown liveness is RED, never alive');
  assert.match(String(backstopWhy(worker(1, { session: ses({ cliAlive: undefined }) }))), /CLI dead/);
  assert.match(String(backstopWhy(worker(1, { session: undefined }))), /keeper dead, CLI dead/);
});

test('review m7: bar:hog_killed pins the kernel delta to what the hog tool reaped — a kill the tool does not own (a stray, a second episode) or one it missed is RED even when the notices and escalations match the delta', () => {
  assert.deepEqual(redOf({}, {}), [], 'control: delta 1 == killed 1');
  const stray = worker(2, { oomKillDelta: 2, memberKillRows: [`Command "x" killed: Plafond mémoire 0.25 GB reached`, `Command "x" killed: Plafond mémoire 0.25 GB reached`], coordMsgs: [1, 2].map(() => ({ kind: 'escalation', recipient: OPS, body: `w2 (aaaaaaaa-0000-4000-8000-000000000012): python3 swarm.py killed at the hard level (0.25 GB)` })), coordRead: 2 });
  const d = evaluateMemhogCycle({ ...good(), workers: [worker(1), stray, worker(3)] }).find((c: Check) => c.id === 'bar:hog_killed')!;
  assert.equal(d.ok, false);
  assert.match(d.detail, /w2: the kernel counted oom_kill \+2 but the hog tool reaped killed=1/);
  const missed = evaluateMemhogCycle({ ...good(), workers: [worker(1, { swarm: { children: 2, killed: 2, survived: 0 } }), worker(2), worker(3)] }).find((c: Check) => c.id === 'bar:hog_killed')!;
  assert.match(missed.detail, /w1: .*killed=2/, 'the tool reaped 2 but the kernel counted 1');
});

test('review m7 (messages): the hog-killed reasons stay DISTINCT — an absent kernel reading says NOT MEASURED, a zero count against a reaped hog says so, a mismatch names both numbers', () => {
  const why = (o: W) => evaluateMemhogCycle({ ...good(), workers: [worker(1, o), worker(2), worker(3)] }).find((c: Check) => c.id === 'bar:hog_killed')!.detail;
  assert.match(why({ oomKillDelta: undefined }), /w1: NOT MEASURED \(no memory\.events reading\)/);
  assert.match(why({ oomKillDelta: null }), /w1: NOT MEASURED \(no memory\.events reading\)/);
  assert.match(why({ oomKillDelta: 0 }), /w1: the tool says killed=1 but the kernel counted oom_kill \+0/);
  assert.match(why({ oomKillDelta: 2 }), /w1: the kernel counted oom_kill \+2 but the hog tool reaped killed=1/);
  assert.match(why({ swarm: { children: 1, killed: 0, survived: 1 } }), /w1: hog NOT killed: killed=0 survived=1/);
});
