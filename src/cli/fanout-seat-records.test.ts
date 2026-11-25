// #587 (vague #585, ledger #591: I1 + I2) — the `seatRecords` switch and its first rules: the plan and the shared interfaces are DECLARED before the first spawn.
// off: byte-identical to master (golden hashes taken from master @e4d7c5ff). on: must-FAIL arms per clause, through the production verbs (`runFanout`). Mutants: scripts/e2e-fanout-seat-records.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFanout, SEAT_USAGE, FANOUT_USAGE, type FanoutDeps } from './fanout-state.ts';
import { DEFAULT_SWITCHES, V378_DEFAULT_SWITCHES, SeatRefusal, applyTicketPatch, interfaceOf, newState, parseState, planMissing, readState, readyTickets, seatRecordsOn, stateFile, switchesOf, type FanoutState } from '../shared/fanout-state.ts';
import { briefHash, renderDecisions, renderInterfaces, renderSwitchesLine } from '../shared/fanout-brief-common.ts';
import { claimAcceptor } from '../shared/fanout-acceptance.ts';
import { renderVerifiedFanoutSkill } from '../shared/verified-fanout-skill.ts';

const NOW = '2026-11-24T10:00:00.000Z';
const H1 = 'a'.repeat(40);
const H2 = 'c'.repeat(40);
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const offline = () => ({ code: 1, stdout: '', stderr: 'offline' });

function mkHome(t: { after: (fn: () => void) => void }): string {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'fanout-seat-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const mkDeps = (home: string, stdin = ''): FanoutDeps => ({ env: { ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: 'r1' }, cwd: home, runner: offline, now: () => NOW, readStdin: () => stdin });
const sh = (d: FanoutDeps, ...a: string[]) => runFanout(['state', ...a], d);
const set = (d: FanoutDeps, ...a: string[]) => sh(d, 'set', '--run', 'r1', ...a);
const show = (d: FanoutDeps): string => sh(d, 'show', '--run', 'r1').stdout;
const load = (d: FanoutDeps): FanoutState => readState(stateFile(d.env.ORCHESTRA_HOME!, 'r1'))!;
/** A run with the switch ON: A (interface owner), B depends on A, plan A,B; nothing spawned yet. */
function onRun(t: { after: (fn: () => void) => void }, o: { declared?: boolean } = {}): FanoutDeps {
  const d = mkDeps(mkHome(t));
  assert.equal(sh(d, 'init', '--run', 'r1', '--switch', 'seatRecords=on').code, 0);
  if (o.declared !== false) {
    assert.equal(set(d, '--plan', 'A,B').code, 0);
    assert.equal(set(d, 'A', '--depends-on', 'none').code, 0);
    assert.equal(set(d, 'B', '--depends-on', 'A').code, 0);
    assert.equal(set(d, 'A', '--interface', 'table t(id, name)').code, 0);
  }
  return d;
}
const refused = (r: { code: number; stderr: string }, name: string): void => {
  assert.equal(r.code, 2, `exit 2 expected, got ${r.code}: ${r.stderr}`);
  assert.ok(r.stderr.startsWith(`[${name}] `), `stderr must start with [${name}]: ${r.stderr}`);
};

// ── off: the default render is byte-identical to master ─────────────────────────────────────────────────

test('off: state show / state file keys / usage / skill text are byte-identical to master (golden hashes of master e4d7c5ff)', (t) => {
  const d = mkDeps(mkHome(t));
  const steps: string[][] = [
    ['init', '--run', 'r1'],
    ['set', '--run', 'r1', 'A', '--status', 'started', '--branch', 'a-br', '--head', H1],
    ['set', '--run', 'r1', 'B', '--depends-on', 'A', '--frozen-interface', 'ledger#1'],
    ['set', '--run', 'r1', 'B', '--status', 'started'],
    ['set', '--run', 'r1', 'C', '--depends-on', 'none'],
    ['set', '--run', 'r1', '--switch', 'earlyGate=off'],
    ['show', '--run', 'r1'],
  ];
  let out = '';
  for (const st of steps) { const r = sh(d, ...st); out += `$ ${st.join(' ')}\n${r.code}\n${r.stdout}${r.stderr}`; }
  const sm = JSON.parse(fs.readFileSync(stateFile(d.env.ORCHESTRA_HOME!, 'r1'), 'utf8'));
  out += `STATEKEYS ${Object.keys(sm).join(',')} / ${Object.keys(sm.tickets.A).join(',')}\n`;
  out = out.replaceAll(d.env.ORCHESTRA_HOME!, '<HOME>');
  assert.equal(sha(out), '09ba5cc6f96e18df0085f331f956fa91d8dab038a2bfad38b2103819eeec6047', `the default render moved:\n${out}`);
  assert.equal(sha(FANOUT_USAGE), '8ebefd4fa73cb2d669c329c8381856437c135478341f56569ba61d5fe3bb8090', 'fanout --help is not the default render of master');
  assert.equal(sha(renderVerifiedFanoutSkill()), 'a9073a594a19c8018dfcd34ebf4abbfc2e7c3eca5e28b9899bf398186480950a', 'the default skill text is not master\'s');
  assert.ok(!show(d).includes('seatRecords'), 'a default-off switch is not printed');
  assert.ok(!/plan \(#587\)|ready \(todo/.test(show(d)), 'no seat lines under off');
});

test('switch: default off in BOTH profiles; on is stored explicit, printed with its origin, frozen at the first spawn; an unknown value is refused', (t) => {
  assert.equal(DEFAULT_SWITCHES.seatRecords, 'off');
  assert.equal(V378_DEFAULT_SWITCHES.seatRecords, 'off');
  assert.equal(switchesOf(undefined).seatRecords, 'off');
  assert.equal(switchesOf({ switchDefaults: 'v0.5.378' }).seatRecords, 'off');
  assert.equal(seatRecordsOn(undefined), false);
  const d = mkDeps(mkHome(t));
  sh(d, 'init', '--run', 'r1');
  const r = set(d, '--switch', 'seatRecords=on');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /seatRecords=on \(explicit\)/);
  assert.match(show(d), /preNominationChecks=off \(default\) · seatRecords=on \(explicit\) — not frozen yet/);
  assert.equal(seatRecordsOn(load(d)), true);
  assert.deepEqual(load(d).switches, { seatRecords: 'on' });
  const bad = set(d, '--switch', 'seatRecords=maybe');
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /switch seatRecords must be on\|off \(got "maybe"\)/);
  set(d, '--switch', 'seatRecords=off');
  assert.match(show(d), /seatRecords=off \(explicit\)/, 'an explicit off IS printed');
});

test('off: every seatRecords verb is refused [seat-records-off] (exit 2); `--depends-on none` stays a ticket id', (t) => {
  const d = mkDeps(mkHome(t));
  sh(d, 'init', '--run', 'r1');
  refused(set(d, '--plan', 'A,B'), 'seat-records-off');
  refused(set(d, '--plan-add', 'A'), 'seat-records-off');
  refused(set(d, 'A', '--interface', 'x'), 'seat-records-off');
  refused(set(d, 'A', '--follows', 'B=1'), 'seat-records-off');
  refused(set(d, 'A', '--json', JSON.stringify({ interface: 'x' })), 'seat-records-off');
  assert.equal(set(d, 'C', '--depends-on', 'none').code, 0);
  assert.deepEqual(load(d).tickets.C.dependsOn, ['none'], 'under off `none` is a ticket id, as on master');
  assert.equal(load(d).tickets.C.depsDeclared, undefined, 'under off no new field is ever written');
  assert.equal(set(d, 'A', '--status', 'started').code, 0, 'off: a started ticket with no plan is fine');
});

test('seat-help: the seatRecords verbs have their own help; the main usage is untouched', () => {
  const r = runFanout(['seat-help'], mkDeps(os.tmpdir()));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `${SEAT_USAGE}\n`);
  assert.match(SEAT_USAGE, /\[plan-incomplete\].*\[interface-blank\].*\[interface-reason-missing\].*\[interface-stale\]/s);
});

// ── on: the plan is declared before the first spawn ─────────────────────────────────────────────────────

test('on must-FAIL: the first spawn / `--status started|nominated|gated` with no plan, a ticket missing, no declared dependencies — each named in the list', (t) => {
  const d = onRun(t, { declared: false });
  let r = set(d, 'A', '--status', 'started');
  refused(r, 'plan-incomplete');
  assert.match(r.stderr, /no plan declared/);
  assert.match(r.stderr, /A: dependencies not declared/);
  assert.equal(set(d, '--plan', 'A,B,C').code, 0);
  set(d, 'A', '--depends-on', 'none');
  r = set(d, 'A', '--status', 'started');
  refused(r, 'plan-incomplete');
  assert.match(r.stderr, /B: in the plan but not in the state/, 'a plan ticket absent from the state is listed');
  assert.match(r.stderr, /C: in the plan but not in the state/);
  assert.ok(!/A: dependencies not declared/.test(r.stderr), 'a declared ticket is not listed');
  set(d, 'B', '--depends-on', 'A');
  set(d, 'C', '--depends-on', 'none');
  r = set(d, 'A', '--status', 'started');
  refused(r, 'plan-incomplete');
  assert.match(r.stderr, /A: B depends on it but it has no interface/, 'a depended-on ticket without an interface is listed');
  for (const st of ['started', 'nominated', 'gated']) refused(set(d, 'A', '--status', st, '--head', H1), 'plan-incomplete');
  assert.equal(load(d).tickets.A.status, 'todo', 'a refused write changes nothing');
  assert.equal(set(d, 'A', '--implementer', 'ws-1').code, 2, 'recording the first implementer IS the first spawn');
  refused(set(d, 'A', '--implementer', 'ws-1'), 'plan-incomplete');
});

test('on: a ticket with no dependent needs no interface; the plan complete lets the first spawn through; the switch freezes with it', (t) => {
  const d = onRun(t, { declared: false });
  set(d, '--plan', 'A,B');
  set(d, 'A', '--depends-on', 'none');
  set(d, 'B', '--depends-on', 'none');
  const r = set(d, 'A', '--status', 'started');
  assert.equal(r.code, 0, r.stderr);
  assert.match(show(d), /seatRecords=on \(explicit\) — frozen /);
  assert.equal(planMissing(load(d)).length, 0);
  assert.equal(set(d, '--switch', 'seatRecords=off').code, 1, 'the switch changed after the first spawn is refused');
  assert.match(set(d, '--switch', 'seatRecords=off').stderr, /cannot change/);
});

test('on: a blank interface is refused; v1 needs no reason; the plan listing then clears', (t) => {
  const d = onRun(t, { declared: false });
  set(d, '--plan', 'A,B'); set(d, 'A', '--depends-on', 'none'); set(d, 'B', '--depends-on', 'A');
  refused(set(d, 'A', '--interface', ''), 'interface-blank');
  refused(set(d, 'A', '--interface', '   \n  '), 'interface-blank');
  refused(sh(d, 'set', '--run', 'r1', 'A', '--interface', '-'), 'interface-blank'); // stdin is empty
  assert.equal(load(d).tickets.A.iface ?? null, null);
  const r = set(d, 'A', '--interface', 'table t(id, name)');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(interfaceOf(load(d), 'A'), { version: 1, text: 'table t(id, name)', history: [] });
  assert.equal(interfaceOf(load(d), 'B'), null);
  assert.equal(set(d, 'A', '--status', 'started').code, 0);
});

test('on: --interface reads stdin (-) and a file; --interface-reason without --interface is a usage error', (t) => {
  const d = onRun(t, { declared: false });
  const home = d.env.ORCHESTRA_HOME!;
  fs.writeFileSync(path.join(home, 'iface.md'), 'query q { x }\n');
  assert.equal(set(d, 'A', '--interface', 'iface.md').code, 0);
  assert.equal(load(d).tickets.A.iface!.text, 'query q { x }\n');
  const d2 = { ...d, readStdin: () => 'from stdin' };
  assert.equal(set(d2, 'B', '--interface', '-').code, 0);
  assert.equal(load(d).tickets.B.iface!.text, 'from stdin');
  assert.equal(set(d, 'C', '--interface', 'a\r\nb').code, 0);
  assert.equal(load(d).tickets.C.iface!.text, 'a\nb', 'stored with LF endings (a CRLF text is the same text)');
  const r = set(d, 'A', '--interface-reason', 'why');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--interface-reason needs --interface/);
});

// ── on: a change is a new version with a reason; a nomination names the version it follows ───────────────

test('on must-FAIL: an interface change with no reason (or a blank one) is refused; with a reason it is v2 and the old text is kept; the same text is no change', (t) => {
  const d = onRun(t);
  refused(set(d, 'A', '--interface', 'table t(id, name, age)'), 'interface-reason-missing');
  refused(set(d, 'A', '--interface', 'table t(id, name, age)', '--interface-reason', '  '), 'interface-reason-missing');
  assert.equal(load(d).tickets.A.iface!.version, 1);
  const r = set(d, 'A', '--interface', 'table t(id, name, age)', '--interface-reason', 'age needed by B');
  assert.equal(r.code, 0, r.stderr);
  const f = interfaceOf(load(d), 'A')!;
  assert.equal(f.version, 2);
  assert.equal(f.text, 'table t(id, name, age)');
  assert.deepEqual(f.history, [{ version: 1, text: 'table t(id, name)', reason: 'age needed by B', at: NOW }]);
  assert.equal(set(d, 'A', '--interface', 'table t(id, name, age)').code, 0, 'the same text again is not a change (no reason asked)');
  assert.equal(load(d).tickets.A.iface!.version, 2);
});

test('on must-FAIL: a dependent nominated with no follows → [interface-unfollowed]; on an old version → [interface-stale] with the reason; on the current one it is accepted', (t) => {
  const d = onRun(t);
  assert.equal(set(d, 'A', '--branch', 'a', '--head', H2, '--status', 'nominated').code, 0); // #506: a dependent is nominated on its upstream's verified candidate
  const nominate = (...extra: string[]) => set(d, 'B', '--branch', 'b', '--head', H1, '--built-on', `A=${H2}`, '--status', 'nominated', ...extra);
  refused(nominate(), 'interface-unfollowed');
  assert.match(nominate().stderr, /--follows A=1/);
  set(d, 'A', '--interface', 'table t(id, name, age)', '--interface-reason', 'age needed by B');
  set(d, 'A', '--interface', 'table t(id, name, age, city)', '--interface-reason', 'city needed by C');
  const old = nominate('--follows', 'A=1');
  refused(old, 'interface-stale');
  assert.match(old.stderr, /follows A v1 but A's interface is now v3 \(v1→v2: age needed by B; v2→v3: city needed by C\)/);
  const mid = nominate('--follows', 'A=2');
  refused(mid, 'interface-stale');
  assert.match(mid.stderr, /\(v2→v3: city needed by C\)/);
  assert.ok(!/v1→v2/.test(mid.stderr), 'only the changes AFTER the followed version');
  assert.equal(load(d).tickets.B.status, 'todo', 'a refused nomination changes nothing');
  const ok = nominate('--follows', 'A=3');
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(load(d).tickets.B.status, 'nominated');
  assert.match(ok.stdout, /follows=A@v3/);
});

test('on: gated on an old version is refused too; a change AFTER the nomination makes the next gate refuse', (t) => {
  const d = onRun(t);
  assert.equal(set(d, 'A', '--branch', 'a', '--head', H2, '--status', 'nominated').code, 0);
  const r0 = set(d, 'B', '--branch', 'b', '--head', H1, '--built-on', `A=${H2}`, '--status', 'nominated', '--follows', 'A=1');
  assert.equal(r0.code, 0, r0.stderr);
  assert.equal(load(d).tickets.B.status, 'nominated');
  set(d, 'A', '--interface', 'table t(id, name, age)', '--interface-reason', 'age');
  refused(set(d, 'B', '--head', 'd'.repeat(40)), 'interface-stale'); // a new head on a nominated candidate that follows an old version is not a way round
  refused(set(d, 'B', '--status', 'gated'), 'interface-stale');
  assert.equal(set(d, 'B', '--follows', 'A=2', '--status', 'gated').code, 0);
});

test('on: --follows is checked — an upstream not in dependsOn, with no interface, or a version that does not exist is refused; dropping a dependency drops its follow', (t) => {
  const d = onRun(t);
  refused(set(d, 'B', '--follows', 'Z=1'), 'follows-invalid');
  set(d, 'Q', '--depends-on', 'none', '--interface', 'q');
  refused(set(d, 'B', '--follows', 'Q=1'), 'follows-invalid'); // Q holds an interface but B does not depend on it
  assert.match(sh(d, 'set', '--run', 'r1', 'B', '--follows', 'Q=1').stderr, /not in dependsOn/);
  refused(set(d, 'B', '--follows', 'A=9'), 'follows-invalid');
  assert.equal(set(d, 'B', '--follows', 'A=1').code, 0);
  assert.deepEqual(load(d).tickets.B.follows, { A: 1 });
  set(d, 'B', '--depends-on', 'A,Q');
  assert.equal(set(d, 'B', '--follows', 'Q=1').code, 0);
  assert.deepEqual(load(d).tickets.B.follows, { A: 1, Q: 1 }, 'a second --follows adds to the first');
  set(d, 'B', '--depends-on', 'A');
  assert.deepEqual(load(d).tickets.B.follows, { A: 1 }, 'a follow on a dependency that is gone goes with it');
  assert.equal(set(d, 'B', '--depends-on', 'none').code, 0);
  assert.equal(load(d).tickets.B.follows, undefined, 'a follow on a dropped dependency goes with it');
  set(d, 'C', '--depends-on', 'B');
  refused(set(d, 'C', '--follows', 'B=1'), 'follows-invalid'); // B holds no interface
  const bad = set(d, 'B', '--follows', 'A');
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--follows expects/);
});

// ── on: a ticket added later goes through the same rule ──────────────────────────────────────────────────

test('on: a follow-up added after the first spawn is listed as missing until declared — then the same rule applies to it', (t) => {
  const d = onRun(t);
  set(d, 'A', '--status', 'started');
  set(d, 'B', '--depends-on', 'none');
  assert.equal(set(d, '--plan', 'A,B,F').code, 2, '--plan after the first spawn is refused');
  refused(set(d, '--plan', 'A,B,F'), 'plan-frozen');
  assert.equal(set(d, '--plan', '').code, 1, 'an empty plan is refused');
  assert.equal(set(d, '--plan-add', 'F').code, 0, '--plan-add works after the first spawn');
  for (const st of ['started', 'nominated', 'gated']) refused(set(d, 'B', '--status', st, '--head', H1), 'plan-incomplete'); // the run has spawned: each of the three still asks
  assert.deepEqual(load(d).plan!.tickets, ['A', 'B', 'F']);
  let r = set(d, 'B', '--status', 'started');
  refused(r, 'plan-incomplete');
  assert.match(r.stderr, /F: in the plan but not in the state/);
  refused(set(d, 'F', '--implementer', 'ws-f'), 'plan-incomplete'); // a seat recorded on a ticket is a spawn, the later ones too
  refused(set(d, 'F', '--verifier', 'ws-v'), 'plan-incomplete');
  set(d, 'F', '--follow-up-of', 'A', '--fixes', 'x');
  r = set(d, 'B', '--status', 'started');
  assert.match(r.stderr, /F: dependencies not declared/);
  set(d, 'F', '--depends-on', 'A');
  r = set(d, 'B', '--status', 'started');
  assert.equal(r.code, 0, `A holds an interface, F declared: ${r.stderr}`);
  set(d, 'G', '--depends-on', 'F');
  r = set(d, 'B', '--status', 'started');
  assert.match(r.stderr, /F: G depends on it but it has no interface/, 'a depended-on ticket added later needs its interface too');
});

test('on: a dropped ticket needs no declared dependencies; the interface of a dropped dependent is not demanded', (t) => {
  const d = onRun(t);
  set(d, 'C', '--depends-on', 'A');
  assert.ok(planMissing(load(d)).length === 0, 'C declared, A has an interface');
  set(d, 'D', '--status', 'dropped');
  assert.ok(!planMissing(load(d)).some((m) => m.startsWith('D:')), 'dropped: not listed');
  set(d, 'E', '--depends-on', 'B');
  set(d, 'E', '--status', 'dropped');
  assert.ok(!planMissing(load(d)).some((m) => m.startsWith('B:')), 'the dropped dependent no longer demands B\'s interface');
});

test('on: a dependent starts against the held interface (no --frozen-interface needed); `state show` lists the ready tickets and drops them once started', (t) => {
  const d = onRun(t);
  assert.match(show(d), /plan \(#587\): A, B \(declared .*\) — complete\ninterfaces \(#587\): A v1\nready \(todo, not started\): A, B\n/);
  const r = set(d, 'B', '--status', 'started');
  assert.equal(r.code, 0, `A is unmerged but holds an interface: ${r.stderr}`);
  assert.match(show(d), /ready \(todo, not started\): A\n/);
});

test('on: a declared todo ticket is not ready while the plan is incomplete', (t) => {
  const d = onRun(t, { declared: false });
  set(d, '--plan', 'A,B,C'); set(d, 'A', '--depends-on', 'none'); set(d, 'B', '--depends-on', 'none');
  assert.deepEqual(readyTickets(load(d)), [], 'C is in the plan and not in the state');
  assert.match(show(d), /ready \(todo, not started\): none — the plan is incomplete/);
  set(d, 'C', '--depends-on', 'none');
  assert.deepEqual(readyTickets(load(d)), ['A', 'B', 'C']);
});

test('on: `state show` says what is missing and that nothing is ready while the plan is incomplete', (t) => {
  const d = onRun(t, { declared: false });
  set(d, '--plan', 'A,B');
  assert.match(show(d), /plan \(#587\): A, B \(declared .*\) — INCOMPLETE, 2 missing: A: in the plan but not in the state.*B: in the plan but not in the state.*\nready \(todo, not started\): none — the plan is incomplete\n/s);
});

// ── a v1 state file loads; the stored fields are validated ───────────────────────────────────────────────

test('a state file of master (no plan / depsDeclared / iface / follows) loads and shows as before; the new stored fields round-trip and bad ones are refused', (t) => {
  const d = mkDeps(mkHome(t));
  sh(d, 'init', '--run', 'r1');
  set(d, 'A', '--status', 'started');
  const file = stateFile(d.env.ORCHESTRA_HOME!, 'r1');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const k of ['depsDeclared', 'iface', 'follows']) assert.ok(!(k in raw.tickets.A), `${k} is never written under off`);
  assert.ok(!('plan' in raw));
  assert.equal(parseState(raw).tickets.A.status, 'started');
  const on = onRun(t);
  const round = parseState(JSON.parse(JSON.stringify(load(on))));
  assert.deepEqual(round.tickets.A.iface, { version: 1, text: 'table t(id, name)', history: [] });
  assert.deepEqual(round.plan, { tickets: ['A', 'B'], declaredAt: NOW });
  assert.equal(round.tickets.B.depsDeclared, true);
  const bad = (mut: (s: any) => void): void => { const j = JSON.parse(JSON.stringify(load(on))); mut(j); assert.throws(() => parseState(j)); };
  bad((j) => { j.tickets.A.iface.version = 0; });
  bad((j) => { j.tickets.A.iface.text = '  '; });
  bad((j) => { j.tickets.A.iface.version = 3; });
  bad((j) => { j.tickets.A.iface.extra = 1; });
  bad((j) => { j.tickets.B.follows = { A: 0 }; });
  bad((j) => { j.tickets.B.depsDeclared = 'yes'; });
  bad((j) => { j.plan.tickets = []; });
  bad((j) => { j.plan.extra = 1; });
});

test('applyTicketPatch (library path): the refusals are SeatRefusal with their name; `[switch-frozen]` keeps its existing wording', (t) => {
  const s0 = newState('r1', { now: NOW, switches: { seatRecords: 'on' } });
  assert.throws(() => applyTicketPatch(s0, 'A', { status: 'started' }, NOW), (e: unknown) => e instanceof SeatRefusal && e.refusal === 'plan-incomplete' && e.message.startsWith('[plan-incomplete] '));
  assert.throws(() => applyTicketPatch(s0, 'A', { interface: ' ' }, NOW), (e: unknown) => e instanceof SeatRefusal && e.refusal === 'interface-blank');
  assert.equal(readyTickets(s0).length, 0);
  assert.equal(interfaceOf(s0, 'nope'), null);
});

test('on: a recorded follow that went stale does not MERGE; a stale head update on a nominated dependent is refused (merge is not a way round)', (t) => {
  const d = onRun(t);
  assert.equal(set(d, 'A', '--branch', 'a', '--head', H2, '--status', 'nominated').code, 0);
  assert.equal(set(d, 'B', '--branch', 'b', '--head', H1, '--built-on', `A=${H2}`, '--status', 'nominated', '--follows', 'A=1').code, 0);
  set(d, 'A', '--interface', 'table t(id, name, age)', '--interface-reason', 'age');
  const m = set(d, 'B', '--status', 'merged');
  refused(m, 'interface-stale');
  assert.match(m.stderr, /cannot be merged/);
  assert.equal(load(d).tickets.B.status, 'nominated');
});

test('on: a merge with no recorded follow is not the nomination\'s rule (A merged first, B merges)', (t) => {
  const d = onRun(t);
  assert.equal(set(d, 'A', '--status', 'merged').code, 0);
  const r = set(d, 'B', '--status', 'merged');
  assert.equal(r.code, 0, r.stderr);
});

test('on: `--depends-on A,none` / a JSON dependsOn naming `none` is refused (no ticket called none)', (t) => {
  const d = onRun(t);
  const r = set(d, 'B', '--depends-on', 'A,none');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /"none" is not a ticket id/);
  assert.equal(set(d, 'B', '--json', JSON.stringify({ dependsOn: ['none'] })).code, 1);
  assert.deepEqual(load(d).tickets.B.dependsOn, ['A']);
});

test('on: the acceptance writer spawn (claimAcceptor, the host\'s only door) is a spawn: refused while the plan is incomplete', (t) => {
  const d = onRun(t, { declared: false });
  set(d, '--switch', 'acceptance=on');
  set(d, '--plan', 'A'); set(d, 'A', '--depends-on', 'none', '--spec', 'x');
  set(d, '--plan-add', 'Z');
  const cur = load(d);
  assert.throws(() => claimAcceptor(cur, 'A', 'accept-A', NOW), (e: unknown) => e instanceof SeatRefusal && e.refusal === 'plan-incomplete' && /Z: in the plan but not in the state/.test(e.message));
  set(d, 'Z', '--depends-on', 'none');
  const claimed = claimAcceptor(load(d), 'A', 'accept-A', NOW);
  assert.equal(claimed.tickets.A.accept?.acceptor?.name, 'accept-A');
});

test('a stored depsDeclared:false (I2 types it boolean) loads as not declared; a non-boolean is refused', (t) => {
  const on = onRun(t);
  const j = JSON.parse(JSON.stringify(load(on)));
  j.tickets.B.depsDeclared = false;
  assert.equal(parseState(j).tickets.B.depsDeclared, undefined);
  j.tickets.B.depsDeclared = 'yes';
  assert.throws(() => parseState(j), /depsDeclared must be a boolean/);
});

// ── PR A: the run's decisions + the shared brief helpers ─────────────────────────────────────────────────

test('decisions: --run-decision appends numbered, verbatim decisions (coordinator only); blank refused; off refused; from a file and stdin', (t) => {
  const d = onRun(t, { declared: false });
  const home = d.env.ORCHESTRA_HOME!;
  let r = set(d, '--run-decision', 'No new dependency.');
  assert.equal(r.code, 0, r.stderr);
  fs.writeFileSync(path.join(home, 'dec.md'), 'Money is integer cents.\n');
  assert.equal(set(d, '--run-decision', 'dec.md').code, 0);
  assert.equal(set({ ...d, readStdin: () => 'from stdin' }, '--run-decision', '-').code, 0);
  assert.deepEqual(load(d).decisions, [
    { n: 1, text: 'No new dependency.', by: 'r1', at: NOW },
    { n: 2, text: 'Money is integer cents.', by: 'r1', at: NOW },
    { n: 3, text: 'from stdin', by: 'r1', at: NOW },
  ]);
  assert.match(show(d), /decisions \(#587\): 3\n  1\. No new dependency\.\n  2\. Money is integer cents\.\n  3\. from stdin\n/);
  refused(set(d, '--run-decision', '  '), 'decision-blank');
  r = set(d, 'A', '--run-decision', 'x');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /run-level/);
  refused(set({ ...d, env: { ...d.env, ORCHESTRA_WS_ID: 'someone-else' } }, '--run-decision', 'forged'), 'decision-caller');
  refused(set({ ...d, env: { ORCHESTRA_HOME: home } }, '--run-decision', 'no identity'), 'decision-caller');
  assert.equal(load(d).decisions!.length, 3, 'a refused decision writes nothing');
  const off = mkDeps(mkHome(t));
  sh(off, 'init', '--run', 'r1');
  refused(set(off, '--run-decision', 'x'), 'seat-records-off');
});

test('decisions: a stored list is validated (numbered from 1, no gap, no unknown field, non-blank)', (t) => {
  const d = onRun(t);
  set(d, '--run-decision', 'one'); set(d, '--run-decision', 'two');
  const good = JSON.parse(JSON.stringify(load(d)));
  assert.equal(parseState(good).decisions!.length, 2);
  const bad = (mut: (s: any) => void): void => { const j = JSON.parse(JSON.stringify(good)); mut(j); assert.throws(() => parseState(j)); };
  bad((j) => { j.decisions[1].n = 3; });
  bad((j) => { j.decisions[0].text = ' '; });
  bad((j) => { j.decisions[0].extra = 1; });
  bad((j) => { j.decisions = []; });
  bad((j) => { j.decisions[0].by = ''; });
});

test('brief-common: briefHash is sha256 hex; decisions / switches / interfaces render from the state, verbatim', (t) => {
  assert.equal(briefHash('x'), sha('x'));
  const d = onRun(t);
  assert.equal(renderDecisions(load(d)), 'Decisions of the run: none recorded.');
  set(d, '--run-decision', 'No new dependency.'); set(d, '--run-decision', 'Cents only.');
  assert.equal(renderDecisions(load(d)), 'Decisions of the run (binding, verbatim — recorded by the coordinator):\n1. No new dependency.\n2. Cents only.');
  assert.equal(renderSwitchesLine(load(d)), 'Switches of this run: earlyGate=on · acceptance=off · minorPolicy=legacy · verifier=on · preNominationChecks=off · seatRecords=on.');
  set(d, 'A', '--interface', 'table t(id, name, age)', '--interface-reason', 'age needed');
  const out = renderInterfaces(load(d), ['A', 'B']);
  assert.match(out, /### A — interface v2 \(changes: v1→v2: age needed\)\ntable t\(id, name, age\)/);
  assert.match(out, /### B: no interface declared/);
  assert.match(out, /--follows <ticket>=<version>/);
  assert.equal(renderInterfaces(load(d), []), 'Interfaces you build against: none.');
  assert.equal(renderInterfaces(load(d), ['A']), renderInterfaces(load(d), ['A']), 'deterministic');
});
