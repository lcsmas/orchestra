// #554 — one switch per feature (earlyGate, acceptance, minorPolicy), frozen for the run and printed in the state. Every arm drives the PRODUCTION path of the feature
// the switch turns off: `state set` / `state show`, the stack reader + reconcile (earlyGate), the host spawn + the acceptance verbs + the gate + deliver (acceptance),
// the follow-up reader the gate and deliver share (minorPolicy), the skill render + installer (all three). Mutants of every clause: scripts/e2e-fanout-switches.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { runFanout, switchVerbRun, type FanoutDeps, type Runner } from './fanout-state.ts';
import { runAcceptance } from './fanout-acceptance.ts';
import { deliver, realDeps, upstreamsFromState, type DeliverDeps, type DeliverOpts, type GhResult } from './fanout-deliver.ts';
import { gatePr, realGateDeps, stackFromState, type GateOpts } from './fanout-gate.ts';
import { followUpFromState } from './fanout-followup.ts';
import { dispatchFanoutAcceptance, type AcceptanceHostDeps } from '../shared/fanout-acceptance-host.ts';
import { applyTicketPatch, blockingMinors, followUpRefusal, mergeBlockRefusal, newState, DEFAULT_SWITCHES, V378_DEFAULT_SWITCHES, defaultsProfileOf, switchSourceOf, stampDefaults, SWITCH_NAMES, SWITCH_VALUES, firstSpawnSignal, parseState, readState, reconcile, stackView, stateFile, switchesOf, switchesStamp, switchesForRun, type Switches } from '../shared/fanout-state.ts';
import { AcceptanceOffError, amendHarnessInto, amendInto, claimAcceptor, freezeInto, waiveInto } from '../shared/fanout-acceptance.ts';
import { renderSwitchBlocks } from '../shared/fanout-switch-render.ts';
import { ACCEPTANCE_REFERENCE_PATH, VERIFIED_FANOUT_SKILL, VERIFIED_FANOUT_SKILL_TEMPLATE, renderVerifiedFanoutSkill, verifiedFanoutReferenceWanted } from '../shared/verified-fanout-skill.ts';
import { VERIFIED_FANOUT_FILES, VERIFIED_FANOUT_V2_REFERENCES } from '../shared/verified-fanout-files.ts';
import { installVerifiedFanoutSkill } from '../main/verified-fanout-install.ts';

const NOW = '2026-11-23T10:00:00.000Z';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const offline: Runner = () => ({ code: 1, stdout: '', stderr: 'offline' });

function mkHome(t: { after: (fn: () => void) => void }): string {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'fanout-sw-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const deps = (home: string, ws = 'r1'): FanoutDeps => ({ env: { ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: ws }, cwd: home, runner: offline, now: () => NOW, readStdin: () => '' });
const init = (d: FanoutDeps, sw?: string) => runFanout(['state', 'init', '--run', 'r1', ...(sw ? ['--switch', sw] : [])], d);
const set = (d: FanoutDeps, ...a: string[]) => runFanout(['state', 'set', '--run', 'r1', ...a], d);
const show = (d: FanoutDeps) => runFanout(['state', 'show', '--run', 'r1'], d).stdout;
const stateOf = (home: string) => readState(stateFile(home, 'r1'))!;
/** process.env is what the production readers (gate / deliver / follow-up) consult: point it at the scratch home for one arm. */
function withEnv<T>(home: string, fn: () => T): T {
  const prev = { h: process.env.ORCHESTRA_HOME, w: process.env.ORCHESTRA_WS_ID };
  process.env.ORCHESTRA_HOME = home; process.env.ORCHESTRA_WS_ID = 'r1';
  const restore = (): void => { for (const [k, v] of [['ORCHESTRA_HOME', prev.h], ['ORCHESTRA_WS_ID', prev.w]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  try { const r = fn(); if (r instanceof Promise) return r.finally(restore) as T; restore(); return r; } catch (e) { restore(); throw e; }
}

// ── the table, the verbs, the freeze ─────────────────────────────────────────────────────────────────────

test('defaults (#559, the v0.5.375 profile): earlyGate on, acceptance off, minorPolicy legacy; a new state is stamped and stores no switch; `state show` prints each value as a default', (t) => {
  assert.deepEqual(switchesOf(undefined), { earlyGate: 'on', acceptance: 'off', minorPolicy: 'legacy', verifier: 'on', preNominationChecks: 'off' });
  assert.deepEqual(DEFAULT_SWITCHES, { earlyGate: 'on', acceptance: 'off', minorPolicy: 'legacy', verifier: 'on', preNominationChecks: 'off' });
  assert.deepEqual(V378_DEFAULT_SWITCHES, { earlyGate: 'on', acceptance: 'on', minorPolicy: 'spec', verifier: 'on', preNominationChecks: 'off' }, 'the v0.5.378 set stays as the named legacy constant');
  const d = deps(mkHome(t));
  assert.equal(init(d).code, 0);
  const raw = JSON.parse(fs.readFileSync(stateFile(d.env.ORCHESTRA_HOME!, 'r1'), 'utf8')) as Record<string, unknown>;
  assert.equal('switches' in raw, false, 'an untouched state stores no switch');
  assert.equal(raw.switchDefaults, 'v0.5.375', 'a new run is stamped with the defaults profile it was born on');
  assert.match(show(d), /switches \(#554, #559, #563\): earlyGate=on \(default\) · acceptance=off \(default\) · minorPolicy=legacy \(default\) · verifier=on \(default\) · preNominationChecks=off \(default\) — not frozen yet/);
});

test('set --switch / init --switch: written, printed by `state show`; unknown name, unknown value, a name twice, an empty list, a ticket or another flag beside it: all REFUSED', (t) => {
  const d = deps(mkHome(t));
  assert.equal(init(d, 'earlyGate=off').code, 0);
  assert.deepEqual(stateOf(d.env.ORCHESTRA_HOME!).switches, { earlyGate: 'off' }, 'only what was chosen is stored');
  const r = set(d, '--switch', 'acceptance=off,minorPolicy=legacy');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /earlyGate=off \(explicit\) · acceptance=off \(explicit\) · minorPolicy=legacy \(explicit\) · verifier=on \(default\) · preNominationChecks=off \(default\) — not frozen yet/, 'a value equal to the default is still reported explicit');
  assert.match(show(d), /switches \(#554, #559, #563\): earlyGate=off \(explicit\) · acceptance=off \(explicit\) · minorPolicy=legacy \(explicit\)/);
  const bad: Array<[string[], RegExp]> = [
    [['--switch', 'earlyGaet=off'], /unknown switch "earlyGaet"/],
    [['--switch', 'earlyGate=maybe'], /switch earlyGate must be on\|off \(got "maybe"\)/],
    [['--switch', 'minorPolicy=on'], /switch minorPolicy must be legacy\|refuse\|spec\|demonstrated/],
    [['--switch', 'acceptance=off,acceptance=on'], /given twice/],
    [['--switch', ''], /expects <name>=<value>/],
    [['--switch', 'acceptance'], /expects <name>=<value>/],
    [['T1', '--switch', 'acceptance=off'], /run-level/],
    [['--switch', 'acceptance=off', '--status', 'started'], /run-level/],
  ];
  for (const [a, why] of bad) { const x = set(d, ...a); assert.equal(x.code, 1, a.join(' ')); assert.match(x.stderr, why, a.join(' ')); }
  assert.match(init(deps(mkHome(t)), 'bogus=on').stderr, /unknown switch "bogus"/);
  assert.deepEqual(stateOf(d.env.ORCHESTRA_HOME!).switches, { earlyGate: 'off', acceptance: 'off', minorPolicy: 'legacy' }, 'no refused call wrote anything');
});

test('FREEZE at the first spawn: a ticket past todo records the freeze next to the explicit switches; every later change is refused with the reason — even to the same value', (t) => {
  const d = deps(mkHome(t));
  init(d, 'earlyGate=off');
  assert.equal(set(d, 'A', '--status', 'todo').code, 0);
  assert.equal(stateOf(d.env.ORCHESTRA_HOME!).switchesFrozen, undefined, 'a ticket still at todo is no spawn');
  assert.equal(set(d, '--switch', 'minorPolicy=refuse').code, 0, 'still changeable before the first spawn');
  assert.equal(set(d, 'A', '--status', 'started', '--branch', 'a').code, 0);
  const s = stateOf(d.env.ORCHESTRA_HOME!);
  assert.deepEqual(s.switches, { earlyGate: 'off', minorPolicy: 'refuse' }, 'the explicit values stay, the defaults are not copied in');
  assert.equal(s.switchesFrozen?.at, NOW);
  assert.match(s.switchesFrozen!.by, /first spawn of the run: ticket A is started/);
  for (const v of ['earlyGate=on', 'earlyGate=off', 'acceptance=off', 'acceptance=on', 'minorPolicy=spec']) {
    const r = set(d, '--switch', v);
    assert.equal(r.code, 1, v);
    assert.match(r.stderr, /cannot change: frozen 2026-11-23T10:00:00\.000Z \(first spawn of the run: ticket A is started\) — a switch is fixed for the run/, v);
  }
  assert.deepEqual(stateOf(d.env.ORCHESTRA_HOME!).switches, { earlyGate: 'off', minorPolicy: 'refuse' });
  assert.match(show(d), /earlyGate=off \(explicit\) · acceptance=off \(default\) · minorPolicy=refuse \(explicit\) · verifier=on \(default\) · preNominationChecks=off \(default\) — frozen 2026-11-23T10:00:00\.000Z \(first spawn of the run: ticket A is started\)/);
  assert.match(runFanout(['state', 'show', '--run', 'r1'], d).stdout, /switches/);
});

test('FREEZE detector (ledger D1, state-side): a recorded implementer, a recorded verifier, a claimed acceptance writer each freeze; a state older than #554 with a started ticket is locked without a record', async (t) => {
  const sig = (flag: string) => (flag === '--implementer' ? /has an implementer \(ws-1\)/ : /has a verifier \(ws-1\)/);
  for (const flag of ['--implementer', '--verifier']) {
    // a run on the DEFAULTS persists nothing (review T3 delta m2: a pre-#554 binary still reads it) — the lock is recomputed from the tickets
    const d0 = deps(mkHome(t));
    init(d0);
    assert.equal(set(d0, 'A', flag, 'ws-1').code, 0);
    const raw0 = JSON.parse(fs.readFileSync(stateFile(d0.env.ORCHESTRA_HOME!, 'r1'), 'utf8')) as Record<string, unknown>;
    assert.equal('switches' in raw0 || 'switchesFrozen' in raw0, false, 'a default run writes neither key');
    assert.equal(raw0.switchDefaults, 'v0.5.375', 'but it keeps its defaults stamp');
    const r0 = set(d0, '--switch', 'acceptance=off');
    assert.equal(r0.code, 1, flag);
    assert.match(r0.stderr, sig(flag), 'refused from the state signal alone');
    // a run that set a switch records who froze it; the stored switches stay the explicit ones
    const d = deps(mkHome(t));
    init(d, 'minorPolicy=refuse');
    assert.equal(set(d, 'A', flag, 'ws-1').code, 0);
    assert.deepEqual(stateOf(d.env.ORCHESTRA_HOME!).switches, { minorPolicy: 'refuse' });
    assert.match(stateOf(d.env.ORCHESTRA_HOME!).switchesFrozen!.by, sig(flag));
    assert.equal(set(d, '--switch', 'acceptance=off').code, 1, flag);
  }
  // an explicit value equal to the default is STORED (reportable as explicit), not dropped
  const dd = deps(mkHome(t)); init(dd, 'acceptance=on'); set(dd, '--switch', 'acceptance=off');
  assert.deepEqual(stateOf(dd.env.ORCHESTRA_HOME!).switches, { acceptance: 'off' });
  assert.match(show(dd), /acceptance=off \(explicit\)/);
  // the writer claim (the host's door) freezes too
  const home = mkHome(t);
  const d = deps(home);
  init(d, 'minorPolicy=refuse,acceptance=on');
  assert.equal(set(d, 'A', '--spec', 's.md').code, 0);
  assert.equal(stateOf(home).switchesFrozen, undefined, 'a spec alone spawns nothing yet');
  const hd: AcceptanceHostDeps = { home, now: () => NOW, isWorkspace: () => true, repoPath: () => undefined, spawn: async () => ({ ok: true, id: 'w1' }), post: () => {} };
  assert.equal((await dispatchFanoutAcceptance({ op: 'spawn', run: 'r1', ticket: 'A' }, hd)).ok, true);
  assert.match(stateOf(home).switchesFrozen!.by, /has an acceptance writer \(accept-A\)/);
  assert.equal(set(d, '--switch', 'earlyGate=off').code, 1);
  // a state written before #554 (no record) with a started ticket: the detector still locks it
  const old = parseState({ version: 1, run: 'r1', target: 'master', repo: null, tickets: { A: { status: 'started', verdict: 'none' } }, updatedAt: NOW, reconciledAt: null });
  assert.equal(firstSpawnSignal(old), 'ticket A is started');
  assert.equal(defaultsProfileOf(old), 'v0.5.378', 'a state written before #559 that has spawned keeps the v0.5.378 defaults');
  const h2 = mkHome(t);
  fs.mkdirSync(path.join(h2, 'fanout', 'r1'), { recursive: true });
  fs.writeFileSync(stateFile(h2, 'r1'), JSON.stringify(old));
  assert.match(set(deps(h2), '--switch', 'earlyGate=off').stderr, /the run already spawned \(ticket A is started\)/);
});

test('a stored state with an unknown switch / value / frozen shape is REFUSED on read (a hand edit cannot smuggle one in)', () => {
  const base = { version: 1, run: 'r1', target: 'master', repo: null, tickets: {}, updatedAt: NOW, reconciledAt: null };
  assert.throws(() => parseState({ ...base, switches: { turbo: 'on' } }), /unknown switch "turbo"/);
  assert.throws(() => parseState({ ...base, switches: { earlyGate: 'sometimes' } }), /earlyGate must be on\|off/);
  assert.throws(() => parseState({ ...base, switchesFrozen: { at: 'nope', by: 'x' } }), /switchesFrozen needs/);
  assert.deepEqual(parseState({ ...base, switches: { acceptance: 'off' } }).switches, { acceptance: 'off' }, 'a stored switch set is read as written, nothing filled in');
  assert.throws(() => parseState({ ...base, switchDefaults: 'v9' }), /switchDefaults must be/);
});

// ── earlyGate ────────────────────────────────────────────────────────────────────────────────────────────

/** A upstream nominated+verified at A, B depends on A and was built on A's head. */
function stacked(home: string, sw?: string): FanoutDeps {
  const d = deps(home);
  init(d, sw);
  assert.equal(set(d, 'A', '--status', 'nominated', '--branch', 'a', '--head', A, '--verdict', 'pass').code, 0);
  assert.equal(set(d, 'B', '--depends-on', 'A', '--frozen-interface', 'iface', '--status', 'started', '--branch', 'b', '--built-on', `A=${A}`).code, 0);
  return d;
}

test('earlyGate on (default): B is nominated and gated on A\'s verified candidate; `stack` says wait-upstream; the same candidate keeps its builtOn at deliver', (t) => {
  const home = mkHome(t);
  const d = stacked(home);
  assert.equal(set(d, 'B', '--status', 'nominated', '--head', B).code, 0);
  assert.equal(set(d, 'B', '--status', 'gated', '--verdict', 'pass').code, 0);
  assert.equal(withEnv(home, () => stackFromState({ ticket: 'B', run: 'r1' }))!.order, 'wait-upstream');
  assert.equal(withEnv(home, () => upstreamsFromState({ ticket: 'B', run: 'r1' }))![0].builtOn, A);
});

test('earlyGate OFF: B waits for A\'s MERGE — nominated / gated / merged all refused while A is open, even on A\'s verified candidate; `stack` says blocked; deliver reads no builtOn; the merge unblocks it', (t) => {
  const home = mkHome(t);
  const d = stacked(home, 'earlyGate=off');
  for (const st of ['nominated', 'gated', 'merged']) {
    const r = set(d, 'B', '--status', st, '--head', B);
    assert.equal(r.code, 1, st);
    assert.match(r.stderr, st === 'merged' ? /cannot be merged: upstream A not merged yet/ : /earlyGate is off for this run: a dependent may START against a frozen interface but is not nominated or gated before its upstream is MERGED/, st);
  }
  const stack = withEnv(home, () => stackFromState({ ticket: 'B', run: 'r1' }))!;
  assert.equal(stack.order, 'blocked');
  assert.match(stack.upstreams[0].why!, /earlyGate=off for this run: a dependent waits for its upstream's MERGE/);
  const up = withEnv(home, () => upstreamsFromState({ ticket: 'B', run: 'r1' }))![0];
  assert.equal(up.builtOn, null, 'the built-on content check (#506) is absent');
  assert.equal(up.builtOnTree, null);
  // reconcile: a hand-forced nominated dependent is a divergence only when the gate is off
  const forced = JSON.parse(JSON.stringify(stateOf(home))) as Record<string, any>;
  forced.tickets.B.status = 'nominated'; forced.tickets.B.head = B;
  assert.ok(reconcile(parseState(forced), {}).divergences.some((x) => x.ticket === 'B' && x.kind === 'nominated-before-upstream-merged'));
  forced.switches.earlyGate = 'on';
  assert.ok(!reconcile(parseState(forced), {}).divergences.some((x) => x.ticket === 'B' && x.kind === 'nominated-before-upstream-merged'), 'the same facts with the switch on: admitted');
  // once A is merged, B is nominated normally
  assert.equal(set(d, 'A', '--status', 'merged').code, 0);
  assert.equal(set(d, 'B', '--status', 'nominated', '--head', B).code, 0);
});

// ── acceptance ───────────────────────────────────────────────────────────────────────────────────────────

test('acceptance on: `state set --spec` leaves the spawn request for the host; the host spawns the accept- writer', async (t) => {
  const home = mkHome(t);
  const d = deps(home); init(d, 'acceptance=on');
  const r = set(d, 'T1', '--spec', 'docs/spec.md#T1');
  assert.deepEqual(r.hostCalls?.map((c) => c.body.op), ['spawn']);
  let spawned = 0;
  const hd: AcceptanceHostDeps = { home, now: () => NOW, isWorkspace: () => true, repoPath: () => undefined, spawn: async () => { spawned++; return { ok: true, id: 'w1' }; }, post: () => {} };
  assert.deepEqual(await dispatchFanoutAcceptance(r.hostCalls![0].body, hd), { ok: true, op: 'spawn', id: 'w1', name: 'accept-T1' });
  assert.equal(spawned, 1);
});

test('acceptance OFF: no spawn request, no host spawn (the claim itself refuses), no pending notice, no acceptance lines in `state show`', async (t) => {
  const home = mkHome(t);
  const d = deps(home); init(d, 'acceptance=off');
  const r = set(d, 'T1', '--spec', 'docs/spec.md#T1');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.hostCalls, undefined, 'state set asks the host for no writer');
  assert.doesNotMatch(r.stderr, /acceptance-pending/);
  const r2 = set(d, 'T2', '--status', 'started', '--branch', 't2');
  assert.doesNotMatch(r2.stderr, /no --spec|acceptance-pending/, 'a ticket with no spec is not warned about a gate that is off');
  assert.doesNotMatch(show(d), /acceptance \(#515\)|pending|unspecified/);
  let spawned = 0;
  const hd: AcceptanceHostDeps = { home, now: () => NOW, isWorkspace: () => true, repoPath: () => undefined, spawn: async () => { spawned++; return { ok: true, id: 'w1' }; }, post: () => {} };
  // even a request that bypasses the CLI (a direct host call) spawns nothing
  const res = await dispatchFanoutAcceptance({ op: 'spawn', run: 'r1', ticket: 'T1' }, hd);
  assert.equal(res.ok, false);
  assert.match(String((res as { error?: string }).error), /acceptance switch is OFF/);
  assert.equal(spawned, 0, 'no writer spawned');
  assert.equal(stateOf(home).tickets.T1.accept, null, 'no claim recorded');
});

test('acceptance OFF: freeze / amend / amend --harness-only / waive / spawn are REFUSED (exit 2, naming the switch) before any git or test work; `show` still answers', (t) => {
  const home = mkHome(t);
  const d = deps(home); init(d, 'acceptance=off'); set(d, 'T1', '--spec', 's.md');
  const verbs: string[][] = [
    ['freeze', 'T1', '--run', 'r1', '--files', 't/x.test.js', '--run-cmd', 'node --test t/x.test.js'],
    ['amend', 'T1', '--run', 'r1', '--decision', 'https://github.com/o/r/issues/1#issuecomment-2', '--spec-sentence', 'a spec sentence here', '--files', 't/x.test.js'],
    ['amend', 'T1', '--run', 'r1', '--harness-only', '--reason', 'setup', '--files', 't/x.test.js'],
    ['waive', 'T1', '--run', 'r1', '--decision', 'https://github.com/o/r/issues/1#issuecomment-2', '--reason', 'cannot'],
    ['spawn', 'T1', '--run', 'r1'],
  ];
  for (const v of verbs) {
    const r = runAcceptance(v, d);
    assert.equal(r.code, 2, v.join(' '));
    assert.match(r.stderr, /refused: .*acceptance switch is OFF for this run/, v.join(' '));
  }
  assert.equal(runAcceptance(['show', 'T1', '--run', 'r1'], d).code, 0);
  // control: with the switch on the same `spawn` verb is not refused for that reason
  const home2 = mkHome(t);
  const d2 = deps(home2); init(d2, 'acceptance=on'); set(d2, 'T1', '--spec', 's.md');
  assert.doesNotMatch(runAcceptance(['spawn', 'T1', '--run', 'r1', '--replace'], d2).stderr, /switch is OFF/);
});

test('acceptance OFF: the PURE transitions refuse on their own (a caller that skips the verb\'s early check still cannot freeze / amend / waive / claim)', () => {
  const st = parseState({ version: 1, run: 'r1', target: 'master', repo: null, switches: { acceptance: 'off' }, tickets: { T1: { spec: 's.md' } }, updatedAt: NOW, reconciledAt: null });
  const src = { branch: 'acceptance/r1', head: A };
  const calls: Array<[string, () => unknown]> = [
    ['freezeInto', () => freezeInto(st, 'T1', { files: { 't/x.test.js': 'f'.repeat(64) }, run: 'node --test t/x.test.js', source: src, now: NOW })],
    ['amendInto', () => amendInto(st, 'T1', { files: {}, decision: 'd', specSentence: 's', bodySha256: 'f'.repeat(64), source: src, now: NOW })],
    ['amendHarnessInto', () => amendHarnessInto(st, 'T1', { files: {}, reason: 'r', assertionsHash: 'f'.repeat(64), source: src, now: NOW })],
    ['waiveInto', () => waiveInto(st, 'T1', { decision: 'd', reason: 'r', now: NOW })],
    ['claimAcceptor', () => claimAcceptor(st, 'T1', 'accept-T1', NOW)],
  ];
  for (const [name, f] of calls) assert.throws(f, (e) => e instanceof AcceptanceOffError && /acceptance switch is OFF/.test((e as Error).message), name);
});

const gateGh = async (args: string[]): Promise<GhResult> => {
  if (args[0] === 'api') return { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
  if (args[0] === 'pr' && args[1] === 'list') return { code: 0, stdout: '[]', stderr: '' };
  return { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
};
async function gate(home: string, head: string): Promise<Awaited<ReturnType<typeof gatePr>>> {
  const opts: GateOpts = { branch: 't1', into: 'master', head, requireChecks: [], ticket: 'T1', run: 'r1', settleMs: 0 };
  return withEnv(home, () => gatePr(opts, { ...realGateDeps(), gh: gateGh, log: () => {}, now: () => Date.parse(NOW), sleep: async () => {} }));
}

test('gate: a ticket with a spec and nothing frozen — acceptance ON ⇒ pending (exit 3, a frozen test is asked for); acceptance OFF ⇒ answered, no acceptance clause, no wait', async (t) => {
  const on = mkHome(t); { const d = deps(on); init(d, 'acceptance=on'); set(d, 'T1', '--spec', 's.md'); }
  const gOn = await gate(on, A);
  assert.equal(gOn.exit, 3);
  assert.equal(gOn.result.reason, 'acceptance-pending');
  const off = mkHome(t); { const d = deps(off); init(d, 'acceptance=off'); set(d, 'T1', '--spec', 's.md'); }
  const gOff = await gate(off, A);
  assert.equal(gOff.exit, 0, JSON.stringify(gOff.result));
  assert.equal(gOff.result.verdict, 'gate');
  assert.equal(gOff.result.reason, undefined);
  assert.equal(gOff.result.acceptance, undefined, 'no acceptance clause in the answer');
  assert.equal(readState(stateFile(off, 'r1'))!.tickets.T1.accept, null, 'no wait window opened on the ticket');
});

function deliverRig() {
  let merged = false;
  const gh = async (args: string[]): Promise<GhResult> => {
    const [a, b] = args;
    const ok = (s: string): GhResult => ({ code: 0, stdout: s, stderr: '' });
    if (a === 'api') return /\/commits\/[0-9a-f]{40}$/.test(args[args.length - 1]) ? ok('{}') : { code: 1, stdout: '', stderr: 'HTTP 404' };
    if (a === 'pr' && b === 'list') return ok(JSON.stringify([{ number: 7, url: 'https://github.com/o/r/pull/7', state: merged ? 'MERGED' : 'OPEN', headRefOid: A }]));
    if (a === 'pr' && b === 'create') return ok('https://github.com/o/r/pull/7\n');
    if (a === 'pr' && b === 'view') {
      if (args.includes('state,mergeCommit')) return ok(JSON.stringify({ state: merged ? 'MERGED' : 'OPEN', mergeCommit: { oid: 'c'.repeat(40) } }));
      return ok(JSON.stringify({ state: merged ? 'MERGED' : 'OPEN', baseRefName: 'master', headRefOid: A, mergeable: 'MERGEABLE', statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/o/r/actions/runs/900/job/901' }] }));
    }
    if (a === 'run' && b === 'view') return ok(JSON.stringify({ jobs: [{ databaseId: 901, steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run tests', conclusion: 'success' }] }] }));
    if (a === 'pr' && b === 'merge') { merged = true; return ok(''); }
    return { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  };
  const dd: DeliverDeps = { ...realDeps(), gh, sleep: async () => {}, now: () => 0, log: () => {} };
  return { dd, merged: () => merged };
}
const dopts = (o: Partial<DeliverOpts> = {}): DeliverOpts => ({ branch: 't1', into: 'master', ticket: 'T1', verifiedHead: A, noReviewGate: true, strategy: 'merge', timeoutMs: 600_000, intervalMs: 10_000, noChecksGraceMs: 30_000, requireChecks: [], run: 'r1', ...o });

test('deliver: a ticket with a spec and nothing frozen — acceptance ON ⇒ refused acceptance-pending, nothing merged; acceptance OFF ⇒ merges, no acceptance gate anywhere', async (t) => {
  const on = mkHome(t); { const d = deps(on); init(d, 'acceptance=on'); set(d, 'T1', '--spec', 's.md'); }
  const rOn = deliverRig();
  const dOn = await withEnv(on, () => deliver(dopts(), rOn.dd));
  assert.equal(dOn.exit, 2);
  assert.equal(dOn.result.reason, 'acceptance-pending');
  assert.equal(rOn.merged(), false);
  const off = mkHome(t); { const d = deps(off); init(d, 'acceptance=off'); set(d, 'T1', '--spec', 's.md'); }
  const rOff = deliverRig();
  const dOff = await withEnv(off, () => deliver(dopts(), rOff.dd));
  assert.equal(dOff.exit, 0, JSON.stringify(dOff.result));
  assert.equal(dOff.result.acceptanceGate, undefined);
  assert.equal(dOff.result.acceptanceChecked, undefined);
  assert.equal(rOff.merged(), true);
  // and a ticket with NO spec at all (the 'unspecified' refusal) passes with the switch off
  const off2 = mkHome(t); { const d = deps(off2); init(d, 'acceptance=off'); set(d, 'T1', '--status', 'started', '--branch', 't1'); }
  const r2 = deliverRig();
  assert.equal((await withEnv(off2, () => deliver(dopts(), r2.dd))).exit, 0);
});

// ── minorPolicy ──────────────────────────────────────────────────────────────────────────────────────────

/** T1 merged with a MAJOR and a MINOR finding; F1 follows T1 fixing `fixes`. */
function followUp(home: string, sw: string | undefined, fixes: string): { d: FanoutDeps; r: ReturnType<typeof set> } {
  const d = deps(home);
  init(d, sw);
  assert.equal(set(d, 'T1', '--status', 'merged', '--branch', 't1', '--head', A, '--finding', 'MAJ=MAJOR,MIN=MINOR').code, 0);
  const r = set(d, 'F1', '--follow-up-of', 'T1', '--fixes', fixes, '--status', 'nominated', '--branch', 'f1', '--head', B);
  return { d, r };
}
const reader = (home: string) => withEnv(home, () => followUpFromState({ ticket: 'F1', run: 'r1', head: B, branch: 'f1' }));

test('minorPolicy refuse (= #514): a follow-up fixing only a MINOR is refused by state, gate reader and deliver reader; one fixing a MAJOR passes', (t) => {
  const bad = mkHome(t);
  const { r } = followUp(bad, 'minorPolicy=refuse', 'MIN');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /fixes only MINOR finding\(s\)/);
  const ok = mkHome(t);
  assert.equal(followUp(ok, 'minorPolicy=refuse', 'MAJ').r.code, 0);
  assert.equal(reader(ok).refusal, null);
  // the shared reader (gate + deliver) on a hand-built nominated MINOR-only follow-up
  const forced = JSON.parse(JSON.stringify(stateOf(ok))) as Record<string, any>;
  forced.tickets.F1.fixes = ['MIN'];
  fs.writeFileSync(stateFile(ok, 'r1'), JSON.stringify(forced));
  assert.equal(reader(ok).refusal?.reason, 'followup-minor-only');
});

test('minorPolicy legacy (= before #514): a MINOR-only follow-up, a finding-less one and a further candidate on a merged ticket all pass — state, gate reader, deliver reader', (t) => {
  const home = mkHome(t);
  const { r } = followUp(home, 'minorPolicy=legacy', 'MIN');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(reader(home).refusal, null);
  const d = deps(home);
  // finding-less follow-up
  assert.equal(set(d, 'F2', '--follow-up-of', 'T1', '--status', 'nominated', '--branch', 'f2', '--head', 'c'.repeat(40)).code, 0);
  // the merged ticket itself re-nominated on another head (undeclared follow-up under #514)
  assert.equal(set(d, 'T1', '--status', 'nominated', '--head', 'd'.repeat(40)).code, 0);
  assert.equal(withEnv(home, () => followUpFromState({ ticket: 'T1', run: 'r1', head: 'e'.repeat(40), branch: 't1' })).refusal, null);
  // the same facts under refuse are refused (the control: the switch is what changed)
  const home2 = mkHome(t);
  const d2 = deps(home2); init(d2, 'minorPolicy=refuse');
  set(d2, 'T1', '--status', 'merged', '--branch', 't1', '--head', A);
  assert.match(set(d2, 'T1', '--status', 'nominated', '--head', 'd'.repeat(40)).stderr, /follow-up/);
});

test('minorPolicy legacy is the default (#559): a MINOR-only follow-up passes with no switch given; spec, set explicitly, keeps the BLOCKING|MAJOR follow-up path and its MINOR semantics (#552)', (t) => {
  const home = mkHome(t);
  const def = followUp(home, undefined, 'MIN');
  assert.equal(def.r.code, 0, def.r.stderr);
  assert.equal(switchesOf(stateOf(home)).minorPolicy, 'legacy');
  assert.equal(reader(home).refusal, null);
  const spec = mkHome(t);
  assert.equal(followUp(spec, 'minorPolicy=spec', 'MAJ').r.code, 0);
  assert.equal(switchesOf(stateOf(spec)).minorPolicy, 'spec');
  assert.equal(followUp(mkHome(t), 'minorPolicy=spec', 'MIN').r.code, 1, 'spec: a MINOR with no spec sentence is still refused as a follow-up');
  assert.equal(reader(spec).refusal, null);
});

test('minorPolicy x #552, all three on the same facts: a MINOR with an accepted spec sentence blocks the merge and may be a follow-up ONLY under spec; refuse and legacy differ exactly as defined', () => {
  const SPEC = 'The endpoint returns 404 for an unknown id.\nThe list is sorted.';
  const build = (minorPolicy: Switches['minorPolicy']) => {
    let st = newState('r1', { switches: { minorPolicy }, now: NOW });
    st = applyTicketPatch(st, 'T1', { status: 'started', branch: 't1', spec: 'spec.md' }, NOW, { specText: SPEC });
    st = applyTicketPatch(st, 'T1', { findings: { MAJ: 'MAJOR', SENT: { severity: 'MINOR', evidence: 'measured', specSentence: 'The list is sorted.', report: { input: 'GET /list', happens: 'unsorted', where: 'list.ts:1', proof: 'node t.js' } }, PLAIN: 'MINOR' } }, NOW);
    return st;
  };
  const fu = (st: ReturnType<typeof build>, fixes: string[]) => {
    const m = applyTicketPatch(st, 'T1', { status: 'merged', head: A }, NOW);
    try { return followUpRefusal(applyTicketPatch(m, 'F1', { followUpOf: 'T1', fixes }, NOW), 'F1'); } catch (e) { return { reason: /fixes only MINOR/.test((e as Error).message) ? 'followup-minor-only' : (e as Error).message }; } // `state set` refuses at registration, the gate/deliver reader on a hand-built state
  };
  const spec = build('spec'), refuse = build('refuse'), legacy = build('legacy');
  assert.deepEqual(blockingMinors(spec, 'T1'), ['SENT'], 'spec: the sentence-breaking MINOR blocks the merge');
  assert.match(mergeBlockRefusal(spec, 'T1')!.detail, /SENT/);
  assert.deepEqual(blockingMinors(refuse, 'T1'), [], 'refuse: a MINOR never blocks');
  assert.deepEqual(blockingMinors(legacy, 'T1'), [], 'legacy: a MINOR never blocks');
  assert.equal(fu(spec, ['SENT']), null, 'spec: a follow-up may fix the sentence-breaking MINOR');
  assert.equal(fu(spec, ['PLAIN'])?.reason, 'followup-minor-only', 'spec: a MINOR with no sentence stays refused');
  assert.equal(fu(refuse, ['SENT'])?.reason, 'followup-minor-only', 'refuse (#514): any MINOR-only follow-up is refused');
  assert.equal(fu(refuse, ['MAJ']), null);
  assert.equal(fu(legacy, ['PLAIN']), null, 'legacy: unrestricted');
  assert.equal(fu(legacy, ['SENT']), null);
});

test('minorPolicy x the lost-sentence guard (review T1 delta2 m1): re-capturing a spec that drops an open sentence is refused ONLY under spec; refuse and legacy protect nothing and allow it', () => {
  const SPEC = 'The endpoint returns 404 for an unknown id.\nThe list is sorted.';
  const build = (minorPolicy: Switches['minorPolicy']) => {
    let st = newState('r1', { switches: { minorPolicy }, now: NOW });
    st = applyTicketPatch(st, 'T1', { status: 'started', branch: 't1', spec: 'spec.md' }, NOW, { specText: SPEC });
    return applyTicketPatch(st, 'T1', { findings: { SENT: { severity: 'MINOR', evidence: 'measured', specSentence: 'The list is sorted.', report: { input: 'GET /list', happens: 'unsorted', where: 'list.ts:1', proof: 'node t.js' } } } }, NOW);
  };
  const recapture = (st: ReturnType<typeof build>) => applyTicketPatch(st, 'T1', { spec: 'spec2.md' }, NOW, { specText: 'The endpoint returns 404 for an unknown id.' });
  assert.throws(() => recapture(build('spec')), /no longer contains the specSentence of SENT/);
  for (const m of ['refuse', 'legacy'] as const) assert.doesNotThrow(() => recapture(build(m)), m);
  // spec control: the same re-capture keeping the sentence is allowed
  assert.doesNotThrow(() => applyTicketPatch(build('spec'), 'T1', { spec: 'spec2.md' }, NOW, { specText: SPEC }));
});

// ── the skill text, per switch (ledger D2) ───────────────────────────────────────────────────────────────

const COMBOS: Switches[] = [];
for (const e of SWITCH_VALUES.earlyGate) for (const a of SWITCH_VALUES.acceptance) for (const m of SWITCH_VALUES.minorPolicy) COMBOS.push({ earlyGate: e, acceptance: a, minorPolicy: m });

const FULL_ON = { acceptance: 'on', minorPolicy: 'spec' } as const; // the v0.5.378 defaults for those two switches (earlyGate on in both profiles)

test('skill render: every combination renders, leaves no directive behind, and the default render IS the bundled text — with NO acceptance section and no spec-sentence MINOR rule (#559)', () => {
  assert.equal(COMBOS.length, 16); // 2 × 2 × 4 (#572: minorPolicy has four values)
  for (const c of COMBOS) {
    const text = renderVerifiedFanoutSkill(c);
    assert.doesNotMatch(text, /<!--\/?sw/, JSON.stringify(c));
    assert.ok(text.includes('# Verified fan-out'), JSON.stringify(c));
  }
  assert.equal(VERIFIED_FANOUT_SKILL, renderVerifiedFanoutSkill(DEFAULT_SWITCHES));
  assert.equal(VERIFIED_FANOUT_SKILL, renderVerifiedFanoutSkill({}));
  for (const needle of ['--built-on <upstream>=<head>', 'ONE follow-up branch', 'only a BLOCKING/MAJOR in its own diff reopens it']) assert.ok(VERIFIED_FANOUT_SKILL.includes(needle), `default render lost ${needle}`);
  for (const needle of ['## 1b. Acceptance tests', 'references/acceptance-tests.md', 'Routing rule', 'unsettled spec-sentence MINOR', 'finding-unsettled', 'no follow-up PR']) assert.ok(!VERIFIED_FANOUT_SKILL.includes(needle), `default render still says ${needle}`);
  // acceptance=on + minorPolicy=spec: every feature's text is back
  const full = renderVerifiedFanoutSkill(FULL_ON);
  for (const needle of ['## 1b. Acceptance tests', 'references/acceptance-tests.md', 'Routing rule', 'unsettled spec-sentence MINOR', 'finding-unsettled']) assert.ok(full.includes(needle), needle);
});

// sha256 of what v0.5.378 rendered for a run on ITS defaults (earlyGate on, acceptance on, minorPolicy spec): SKILL.md + every installed file. Regenerate: node --experimental-strip-types scripts/diff-fanout-skill-vs-375.mjs --tag v0.5.378 --switches acceptance=on,minorPolicy=spec  (must print "no difference").
const V378_RENDER_SHA256: Record<string, string> = {
  'SKILL.md': '2b7ed8dd33184ffbdbf939d00a3826f874986229eb9eb5ab615f7aa06e3253e6',
  'references/meta-rules.md': 'a203d4a735e79e7339c7ed88617e4f403cc80d4fd547d8e943f7cd7956aa5bcd',
  'references/prose.md': '68ce78da7a108a475c211afe24b8cdb661e7d6391b69f5134f34126b6499c3ed',
  'references/traps.md': '2da64c32010533252c26e8ffe069a8a8c86d374e96cf20849963c49ac4187560',
  'references/working-with-agents.md': '8fc47556e2ee1f7f4542660484cbb6fd3b99780b38fed8f4013a3f6d106bf1f7',
  'scripts/ledger-set': 'c6e24d3a56a9d6498f2d191f11979fa6f0a5e5370187d23ba8a1ca89af9ad0f6',
  'references/acceptance-tests.md': 'f8cdec046e92091d0cc3dc5dd7adcfd8640a8bb505eed68946fe024ce82efdd8',
  'references/budget-and-gates.md': 'f181c77bbc2c5e47b80982ec098cb9e4fb01d5b46cd8b8c66527a261bd97dbe7',
  'references/closeout-and-gates.md': 'f4d7f7a7b0c3013d36590a0364a84128757b0b5346b9fe64b1c1d5a2dcae45c7',
  'references/fleet-bus.md': 'bf6aa4ba306934656d9a88f30bc8b8ab149067e3bc612eeb1e2ba9ab60d2606a',
  'references/lead-ops-tiers.md': '268ff1e15fd4450415e764218ae37cac817f704bb193e2f89b776cce67df766b',
  'references/verifier-and-review.md': '530fb0662a317327d11db370123bd9b327ec74defc1a846b8c35ad83af4d74ce',
};

test('#559 skill render: with acceptance=on,minorPolicy=spec the installed SKILL.md and every reference are BYTE-IDENTICAL to what v0.5.378 rendered (sha256), the default install differs only by the features it turns off', async (t) => {
  const sha = (x: string): string => createHash('sha256').update(x).digest('hex');
  const dir = mkHome(t);
  assert.equal(await installVerifiedFanoutSkill(dir, undefined, FULL_ON), 'written');
  const got: Record<string, string> = {};
  for (const p of Object.keys(V378_RENDER_SHA256)) got[p] = sha(fs.readFileSync(path.join(dir, 'verified-fanout', p), 'utf8'));
  assert.deepEqual(got, V378_RENDER_SHA256);
  // the default install: no acceptance reference, and the SKILL.md / verifier reference are the ones that changed
  const def = path.join(dir, 'def');
  await installVerifiedFanoutSkill(def);
  assert.equal(fs.existsSync(path.join(def, 'verified-fanout', ACCEPTANCE_REFERENCE_PATH)), false);
  assert.notEqual(sha(fs.readFileSync(path.join(def, 'verified-fanout', 'SKILL.md'), 'utf8')), V378_RENDER_SHA256['SKILL.md']);
  assert.equal(sha(fs.readFileSync(path.join(def, 'verified-fanout', 'references/fleet-bus.md'), 'utf8')), V378_RENDER_SHA256['references/fleet-bus.md'], 'a reference no switch touches is unchanged');
});

test('skill render: acceptance OFF leaves NO acceptance sentence; earlyGate OFF no early-gate sentence (and says the dependent waits); legacy no #514 follow-up sentence', () => {
  const ACC = ['## 1b. Acceptance tests', 'acceptance-tests.md', '`accept-`', '--spec <', '--acceptance <receipt', 'acceptance-pending', 'frozen-test-changed', 'acceptance-unproven', 'acceptance/<run>'];
  const off = renderVerifiedFanoutSkill({ acceptance: 'off' });
  for (const n of ACC) assert.ok(!off.includes(n), `acceptance=off still says ${JSON.stringify(n)}`);
  assert.ok(off.includes('--built-on') && off.includes('At most ONE follow-up'), 'acceptance=off removes only its own text');
  assert.ok(!off.includes('Routing rule'), 'the #510 B routing rule belongs to the acceptance feature');
  const early = renderVerifiedFanoutSkill({ earlyGate: 'off', acceptance: 'on' });
  assert.ok(!early.includes('--built-on'), 'earlyGate=off still names --built-on');
  assert.ok(!early.includes('say wait or re-gate'));
  assert.ok(!early.includes('is gated on its upstream\'s candidate'));
  assert.match(early, /A dependent track waits for its upstream's MERGE/);
  assert.ok(early.includes('## 1b. Acceptance tests'), 'earlyGate=off removes only its own text');
  const legacy = renderVerifiedFanoutSkill({ minorPolicy: 'legacy', acceptance: 'on' });
  for (const n of ['no follow-up PR', '(BLOCKING/MAJOR) or `noted`', 'refuse a MINOR-only']) assert.ok(!legacy.includes(n), `legacy still says ${JSON.stringify(n)}`);
  assert.match(legacy, /A review round with 0 BLOCKING and 0 MAJOR merges on its current gate; a\nMINOR that touches correctness or a ticket promise goes to the candidate's ONE\nfollow-up branch/, 'legacy = the v0.5.375 sentence');
  assert.ok(legacy.includes('only a BLOCKING/MAJOR in its own diff reopens it'));
  assert.ok(legacy.includes('## 1b. Acceptance tests') && legacy.includes('--built-on'), 'legacy removes only its own text');
  // #552's text (the spec policy) reads under spec ONLY; refuse / legacy never see it, in SKILL.md or in the references
  const SPEC_TEXT = ['unsettled spec-sentence MINOR', 'A MINOR refuses only when it quotes a spec sentence', 'finding-unsettled'];
  for (const n of SPEC_TEXT) { assert.ok(renderVerifiedFanoutSkill({ minorPolicy: 'spec' }).includes(n), n); for (const m of ['refuse', 'legacy'] as const) assert.ok(!renderVerifiedFanoutSkill({ minorPolicy: m }).includes(n), `${m} still says ${n}`); }
  assert.ok(renderVerifiedFanoutSkill({ minorPolicy: 'refuse' }).includes('A MINOR never refuses'));
  assert.ok(renderVerifiedFanoutSkill({ minorPolicy: 'legacy' }).includes('A MINOR never refuses'));
  const vr = (m: Switches['minorPolicy']) => renderSwitchBlocks(VERIFIED_FANOUT_V2_REFERENCES.find((f) => f.path === 'references/verifier-and-review.md')!.content, { minorPolicy: m });
  assert.ok(vr('spec').includes('A MINOR that breaks a sentence of the ticket') && !vr('refuse').includes('A MINOR that breaks a sentence') && !vr('legacy').includes('A MINOR that breaks a sentence'));
  // refuse keeps today's #514 text
  assert.ok(renderVerifiedFanoutSkill({ minorPolicy: 'refuse' }).includes('At most ONE follow-up branch per candidate'));
  // everything off at once
  const all = renderVerifiedFanoutSkill({ earlyGate: 'off', acceptance: 'off', minorPolicy: 'legacy' });
  for (const n of [...ACC, '--built-on', 'Routing rule']) assert.ok(!all.includes(n), n);
});

test('skill render: the references — the acceptance one is shipped only with acceptance on', () => {
  assert.equal(verifiedFanoutReferenceWanted(ACCEPTANCE_REFERENCE_PATH, { acceptance: 'on' }), true);
  assert.equal(verifiedFanoutReferenceWanted(ACCEPTANCE_REFERENCE_PATH, { acceptance: 'off' }), false);
  assert.equal(verifiedFanoutReferenceWanted('references/fleet-bus.md', { acceptance: 'off' }), true);
  assert.ok(VERIFIED_FANOUT_V2_REFERENCES.some((f) => f.path === ACCEPTANCE_REFERENCE_PATH));
});

test('skill render: a malformed directive THROWS — never a silently kept or dropped block', () => {
  assert.throws(() => renderSwitchBlocks('<!--sw earlyGate=on-->\nx', {}), /unterminated/);
  assert.throws(() => renderSwitchBlocks('x\n<!--/sw-->', {}), /no open block/);
  assert.throws(() => renderSwitchBlocks('<!--sw earlyGate=on-->\n<!--sw acceptance=on-->\n<!--/sw-->\n<!--/sw-->', {}), /do not nest/);
  assert.throws(() => renderSwitchBlocks('<!--sw turbo=on-->\n<!--/sw-->', {}), /unknown switch turbo/);
  assert.throws(() => renderSwitchBlocks('<!--sw earlyGate=maybe-->\n<!--/sw-->', {}), /no value maybe/);
  assert.throws(() => renderSwitchBlocks('<!--sw earlyGate on-->\n<!--/sw-->', {}), /malformed/);
  assert.equal(renderSwitchBlocks('a\n<!--sw acceptance=off-->\nb\n<!--/sw-->\nc', { acceptance: 'off' }), 'a\nb\nc');
  assert.equal(renderSwitchBlocks('a\n<!--sw acceptance=off-->\nb\n<!--/sw-->\nc', { acceptance: 'on' }), 'a\nc');
  assert.equal(VERIFIED_FANOUT_SKILL_TEMPLATE.split('\n').filter((l) => l.startsWith('<!--sw ')).length, VERIFIED_FANOUT_SKILL_TEMPLATE.split('\n').filter((l) => l === '<!--/sw-->').length);
});

test('installer: the SKILL.md and the reference files written for a run follow its switches; a copy left by an earlier install is removed; the stamp carries a non-default set only', async (t) => {
  const dir = mkHome(t);
  const skills = path.join(dir, 'skills');
  const accRef = path.join(skills, 'verified-fanout', ACCEPTANCE_REFERENCE_PATH);
  assert.equal(await installVerifiedFanoutSkill(skills), 'written');
  assert.equal(fs.existsSync(accRef), false, '#559: the default install ships no acceptance reference');
  assert.ok(!fs.readFileSync(path.join(skills, 'verified-fanout', 'SKILL.md'), 'utf8').includes('## 1b. Acceptance tests'));
  assert.equal(await installVerifiedFanoutSkill(skills, undefined, { acceptance: 'on' }), 'written');
  assert.ok(fs.existsSync(accRef));
  assert.ok(fs.readFileSync(path.join(skills, 'verified-fanout', 'SKILL.md'), 'utf8').includes('## 1b. Acceptance tests'));
  assert.equal(await installVerifiedFanoutSkill(skills, undefined, { acceptance: 'off', earlyGate: 'off' }), 'written');
  assert.equal(fs.existsSync(accRef), false, 'the earlier copy of the acceptance reference is gone');
  const md = fs.readFileSync(path.join(skills, 'verified-fanout', 'SKILL.md'), 'utf8');
  assert.ok(!md.includes('## 1b. Acceptance tests') && !md.includes('--built-on') && !md.includes('<!--sw'));
  assert.ok(fs.existsSync(path.join(skills, 'verified-fanout', 'references/fleet-bus.md')), 'the other references stay');
  assert.ok(VERIFIED_FANOUT_FILES.every((f) => fs.existsSync(path.join(skills, 'verified-fanout', f.path))));
  assert.equal(switchesStamp('V1', { ...DEFAULT_SWITCHES }), 'V1', 'a default run keeps the plain version');
  assert.equal(switchesStamp('V1', { earlyGate: 'off', acceptance: 'off', minorPolicy: 'spec', preNominationChecks: 'off' }), 'V1+sw:earlyGate=off,minorPolicy=spec');
  assert.equal(switchesStamp('V1', { ...V378_DEFAULT_SWITCHES }), 'V1+sw:acceptance=on,minorPolicy=spec', 'a run that keeps the v0.5.378 defaults is stamped (it re-renders once, the stamp names why)');
  assert.deepEqual(SWITCH_NAMES, ['earlyGate', 'acceptance', 'minorPolicy', 'verifier', 'preNominationChecks']);
});

test('wiring (source-pinned): installOrchestraHooks renders from the run\'s frozen switches, stamps the non-default set, and the skills op re-installs through it', () => {
  const ws = fs.readFileSync(new URL('../main/workspaces.ts', import.meta.url), 'utf8');
  const wiring = fs.readFileSync(new URL('../main/fanout-acceptance-wiring.ts', import.meta.url), 'utf8');
  const inst = ws.slice(ws.indexOf('export async function installOrchestraHooks('));
  assert.match(inst, /const fanoutSwitches = roleWs \? switchesForRun\(orchestraHome\(\), resolveWaveRunId\(roleWs\)\) : \{ \.\.\.DEFAULT_SWITCHES \};/);
  assert.match(inst, /const stampValue = switchesStamp\(HOOKS_VERSION, fanoutSwitches\);/);
  assert.match(inst, /\.trim\(\) === stampValue\) return;/, 'the skip gate compares the stamp WITH the switches');
  assert.match(inst, /installVerifiedFanoutSkill\(skillsDir, [^\n]*, fanoutSwitches\),/);
  assert.match(inst, /'\.hooks-version'\), stampValue\)/, 'the stamp written is the switched one');
  assert.doesNotMatch(inst, /=== HOOKS_VERSION/);
  assert.match(wiring, /refreshSkills: async \(ids\) => \{[^]*installOrchestraHooks\(ws\.worktreePath\)/);
  // the stamp itself: a default run keeps the plain version, a flipped run re-renders once
  assert.notEqual(switchesStamp('V', { ...DEFAULT_SWITCHES, acceptance: 'on' }), switchesStamp('V', { ...DEFAULT_SWITCHES }));
});

test('earlyGate off: `resume` / stack advice says MERGED, never the #506 candidate/--built-on route; a recorded builtOn is ignored when the upstream merges elsewhere', (t) => {
  const home = mkHome(t);
  const d = deps(home); init(d, 'earlyGate=off');
  set(d, 'A', '--status', 'started', '--branch', 'a');
  set(d, 'B', '--depends-on', 'A', '--frozen-interface', 'iface');
  const plan = (st: ReturnType<typeof stateOf>) => reconcile(st, {}).tickets.B.next;
  assert.match(plan(stateOf(home)).detail, /is MERGED \(earlyGate=off\)/);
  assert.doesNotMatch(plan(stateOf(home)).detail, /verified candidate|--built-on/);
  set(d, 'B', '--status', 'started', '--branch', 'b');
  assert.match(plan(stateOf(home)).detail, /MERGED \(earlyGate=off\)/);
  assert.doesNotMatch(plan(stateOf(home)).detail, /--built-on|nominated\|gated/);
  // control: on = the #506 advice
  const home2 = mkHome(t);
  const d2 = deps(home2); init(d2);
  set(d2, 'A', '--status', 'started', '--branch', 'a'); set(d2, 'B', '--depends-on', 'A', '--frozen-interface', 'iface');
  assert.match(reconcile(stateOf(home2), {}).tickets.B.next.detail, /verified candidate/);
  // builtOn recorded with the switch off, upstream merged at another head: no upstream-changed / re-gate
  const forced = JSON.parse(JSON.stringify(stateOf(home))) as Record<string, any>;
  forced.tickets.B.builtOn = { A: A }; forced.tickets.A.status = 'merged'; forced.tickets.A.head = B; forced.tickets.A.mergedHead = B; forced.tickets.B.status = 'nominated'; forced.tickets.B.head = 'c'.repeat(40);
  const off = reconcile(parseState(forced), {});
  assert.ok(!off.divergences.some((x) => x.kind === 'upstream-changed'), 'off: no built-on content check');
  assert.equal(stackView(parseState(forced), 'B')!.upstreams[0].state, 'merged', 'off: the stack does not compare builtOn either');
  forced.switches.earlyGate = 'on';
  assert.ok(reconcile(parseState(forced), {}).divergences.some((x) => x.kind === 'upstream-changed'), 'on: the same facts are an upstream-changed');
  assert.equal(stackView(parseState(forced), 'B')!.upstreams[0].state, 'changed');
});

test('acceptance OFF: `acceptance show --brief` does not describe a gate that is off', (t) => {
  const home = mkHome(t);
  const d = deps(home); init(d, 'acceptance=off'); set(d, 'T1', '--status', 'started', '--branch', 't1');
  const r = runAcceptance(['show', 'T1', '--run', 'r1', '--brief'], d);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stdout, /acceptance-pending|unspecified/);
  assert.match(r.stdout, /acceptance switch is OFF/);
});

const hd2 = (home: string): AcceptanceHostDeps => ({ home, now: () => NOW, isWorkspace: () => true, repoPath: () => undefined, spawn: async () => ({ ok: true }), post: () => {} });

test('FREEZE, host side (review T3 m1): a run owner that already SPAWNED (children seen by the host, nothing recorded in the state) cannot change a switch; init --switch too; host silent = the state alone decides, said on stderr', async (t) => {
  const home = mkHome(t);
  const d = deps(home); init(d);
  assert.equal(stateOf(home).switchesFrozen, undefined, 'nothing recorded in the state: the state-side detector sees no spawn');
  const spawned: FanoutDeps = { ...d, spawned: ['child-1', 'child-2'] };
  for (const v of ['acceptance=off', 'acceptance=on']) {
    const r = set(spawned, '--switch', v);
    assert.equal(r.code, 1, v);
    assert.match(r.stderr, /cannot change: the run owner already spawned 2 workspace\(s\) \(child-1, child-2\)/, v);
  }
  assert.equal('switches' in stateOf(home), false, 'refused: nothing written');
  assert.match(init({ ...deps(mkHome(t)), spawned: ['c'] }, 'earlyGate=off').stderr, /already spawned 1 workspace/);
  assert.equal(set({ ...d, spawned: [] }, '--switch', 'acceptance=off').code, 0, 'the host saw no child');
  const silent = set({ ...d, spawned: null }, '--switch', 'earlyGate=off');
  assert.equal(silent.code, 0);
  assert.match(silent.stderr, /the host could not say whether the run has spawned/);
  // the host question: asked only for init|set --switch, for the caller's own run
  assert.equal(switchVerbRun(['state', 'set', '--switch', 'acceptance=off'], { ORCHESTRA_WS_ID: 'r1' }), 'r1');
  assert.equal(switchVerbRun(['state', 'init', '--run', 'x', '--switch', 'acceptance=off'], { ORCHESTRA_WS_ID: 'r1' }), 'x');
  assert.equal(switchVerbRun(['state', 'set', 'T1', '--status', 'started'], { ORCHESTRA_WS_ID: 'r1' }), null);
  assert.equal(switchVerbRun(['state', 'show'], { ORCHESTRA_WS_ID: 'r1' }), null);
  // review T3 delta m1: a custom --run id is no workspace — its owner is the caller (`from`), so its children refuse the flip too
  const hc: AcceptanceHostDeps = { ...hd2(home), isWorkspace: (id) => id === 'owner', childrenOf: (run) => (run === 'owner' ? ['kid'] : []) };
  assert.deepEqual(await dispatchFanoutAcceptance({ op: 'children', run: 'custom1', from: 'owner' }, hc), { ok: true, op: 'children', children: ['kid'] });
  assert.deepEqual(await dispatchFanoutAcceptance({ op: 'children', run: 'custom1', from: 'stranger' }, hc), { ok: true, op: 'children', children: [] });
  assert.deepEqual(await dispatchFanoutAcceptance({ op: 'children', run: 'custom1' }, hc), { ok: true, op: 'children', children: [] });
  // the host op itself: the run owner's children only, and only for a live workspace
  const hd: AcceptanceHostDeps = { home, now: () => NOW, isWorkspace: (id) => id !== 'ghost', repoPath: () => undefined, spawn: async () => ({ ok: true }), post: () => {}, childrenOf: (run) => (run === 'r1' ? ['c1'] : ['zzz']) };
  assert.deepEqual(await dispatchFanoutAcceptance({ op: 'children', run: 'r1' }, hd), { ok: true, op: 'children', children: ['c1'] });
  assert.deepEqual(await dispatchFanoutAcceptance({ op: 'children', run: 'ghost' }, hd), { ok: true, op: 'children', children: [] });
  // wiring: the CLI asks the host before the write; production answers with the owner's direct children
  const idx = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  assert.match(idx, /const switchRun = args\[0\] === 'acceptance' \? null : switchVerbRun\(args, process\.env\);\n\s+if \(switchRun\) \{[^]*op: 'children'[^]*fanoutDeps\.spawned = /);
  assert.match(fs.readFileSync(new URL('../main/fanout-acceptance-wiring.ts', import.meta.url), 'utf8'), /childrenOf: \(run\) => store\.workspaces\.filter\(\(w\) => w\.parentId === run\)\.map\(\(w\) => w\.id\)/);
});

test('skill render (review T3 m2): EVERY installed file is rendered by the switches — with all three off no file of the install teaches the early gate, the acceptance flow or the #514 follow-up rule; an install with acceptance on keeps them', async (t) => {
  const dir = mkHome(t);
  const walk = (p: string): string[] => fs.readdirSync(p, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(p, e.name)) : [path.join(p, e.name)]));
  const TEACHES = [/acceptance-tests/, /`accept-`/, /frozen test/i, /--spec </, /--built-on/, /gated on its upstream's candidate/, /re-gates when that moves/, /refuse a MINOR-only/, /no follow-up PR/];
  const off = path.join(dir, 'off');
  await installVerifiedFanoutSkill(off, undefined, { earlyGate: 'off', acceptance: 'off', minorPolicy: 'legacy' });
  const files = walk(off);
  assert.ok(files.length >= 10, `${files.length} files installed`);
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /<!--\/?sw /, `${f}: a directive leaked`);
    for (const re of TEACHES) assert.doesNotMatch(text, re, `${path.relative(off, f)} still teaches ${re}`);
  }
  const on = path.join(dir, 'on');
  await installVerifiedFanoutSkill(on, undefined, { acceptance: 'on', minorPolicy: 'spec' });
  const all = walk(on).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  for (const re of [/gated on its upstream's candidate/, /acceptance-tests/, /At most ONE follow-up branch per candidate\*\*, only for a BLOCKING\/MAJOR \(or a spec-sentence MINOR/]) assert.match(all, re);
  assert.match(fs.readFileSync(path.join(off, 'verified-fanout/references/budget-and-gates.md'), 'utf8'), /nominated and\s+gated only after its upstream is merged/);
});

test('host `skills` op: re-renders the caller\'s and the run owner\'s skill (only known workspaces), asked by `state init|set --switch`', async (t) => {
  const home = mkHome(t);
  const d = deps(home, 'r1');
  const a = init(d, 'acceptance=off');
  assert.deepEqual(a.hostCalls, [{ route: '/fanoutAcceptance', body: { op: 'skills', run: 'r1', from: 'r1' } }]);
  assert.deepEqual(set(d, '--switch', 'earlyGate=off').hostCalls, [{ route: '/fanoutAcceptance', body: { op: 'skills', run: 'r1', from: 'r1' } }]);
  assert.equal(init(deps(mkHome(t))).hostCalls, undefined, 'init without --switch asks nothing');
  const seen: string[][] = [];
  const hd: AcceptanceHostDeps = { home, now: () => NOW, isWorkspace: (id) => id !== 'ghost', repoPath: () => undefined, spawn: async () => ({ ok: true }), post: () => {}, refreshSkills: async (ids) => { seen.push(ids); return ids; } };
  assert.deepEqual(await dispatchFanoutAcceptance({ op: 'skills', run: 'r1', from: 'impl-9' }, hd), { ok: true, op: 'skills', refreshed: ['impl-9', 'r1'] });
  assert.deepEqual(await dispatchFanoutAcceptance({ op: 'skills', run: 'r1', from: 'ghost' }, hd), { ok: true, op: 'skills', refreshed: ['r1'] });
  assert.equal(seen.length, 2);
});

// ── #559 — the defaults are the v0.5.375 profile; a run in flight is never re-read with other defaults ──────────

const SPEC559 = 'The endpoint returns 404 for an unknown id.\nThe list is sorted.';
const SENT559 = { severity: 'MINOR', evidence: 'measured', specSentence: 'The list is sorted.', report: { input: 'GET /list', happens: 'unsorted', where: 'list.ts:1', proof: 'node t.js' } };
/** A state exactly as v0.5.378 persisted a run on ITS defaults (acceptance on, minorPolicy spec): spawned, a spec-sentence MINOR open, NO switch stored, NO defaults marker. */
function v378Shaped(): Record<string, any> {
  let st = newState('r1', { switches: { acceptance: 'on', minorPolicy: 'spec' }, now: NOW });
  st = applyTicketPatch(st, 'T1', { status: 'started', branch: 't1', spec: 'spec.md' }, NOW, { specText: SPEC559 });
  st = applyTicketPatch(st, 'T1', { findings: { SENT: SENT559, PLAIN: 'MINOR' } }, NOW);
  const raw = JSON.parse(JSON.stringify(st)) as Record<string, any>;
  delete raw.switches; delete raw.switchDefaults; delete raw.switchesFrozen;
  return raw;
}
const putRaw = (home: string, raw: unknown): void => { fs.mkdirSync(path.dirname(stateFile(home, 'r1')), { recursive: true }); fs.writeFileSync(stateFile(home, 'r1'), JSON.stringify(raw)); };

test('#559 must-PASS: a default run spawns NO acceptance writer (CLI request, host claim) and its gate and deliver ask for no frozen test', async (t) => {
  const home = mkHome(t);
  const d = deps(home); init(d);
  const r = set(d, 'T1', '--spec', 'docs/spec.md#T1');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.hostCalls, undefined, 'no spawn request for the host');
  assert.doesNotMatch(r.stderr, /acceptance-pending|no --spec/);
  let spawned = 0;
  const hd: AcceptanceHostDeps = { home, now: () => NOW, isWorkspace: () => true, repoPath: () => undefined, spawn: async () => { spawned++; return { ok: true, id: 'w1' }; }, post: () => {} };
  const res = await dispatchFanoutAcceptance({ op: 'spawn', run: 'r1', ticket: 'T1' }, hd);
  assert.equal(res.ok, false);
  assert.match(String((res as { error?: string }).error), /acceptance switch is OFF/);
  assert.equal(spawned, 0);
  const g = await gate(home, A);
  assert.equal(g.exit, 0, JSON.stringify(g.result));
  assert.equal(g.result.acceptance, undefined, 'the gate asks for no frozen test');
  const rig = deliverRig();
  const dv = await withEnv(home, () => deliver(dopts(), rig.dd));
  assert.equal(dv.exit, 0, JSON.stringify(dv.result));
  assert.equal(rig.merged(), true);
});

test('#559 must-PASS: an explicit `acceptance: on` still spawns the writer; an explicit `minorPolicy: spec` still blocks the merge on a literal spec sentence', async (t) => {
  const home = mkHome(t);
  const d = deps(home); init(d, 'acceptance=on,minorPolicy=spec');
  const r = set(d, 'T1', '--spec', 'docs/spec.md#T1');
  assert.deepEqual(r.hostCalls?.map((c) => c.body.op), ['spawn']);
  const hd: AcceptanceHostDeps = { home, now: () => NOW, isWorkspace: () => true, repoPath: () => undefined, spawn: async () => ({ ok: true, id: 'w1' }), post: () => {} };
  assert.deepEqual(await dispatchFanoutAcceptance(r.hostCalls![0].body, hd), { ok: true, op: 'spawn', id: 'w1', name: 'accept-T1' });
  let st = newState('r1', { switches: { minorPolicy: 'spec' }, now: NOW });
  st = applyTicketPatch(st, 'T1', { status: 'started', branch: 't1', spec: 'spec.md' }, NOW, { specText: SPEC559 });
  st = applyTicketPatch(st, 'T1', { findings: { SENT: SENT559 } }, NOW);
  assert.deepEqual(blockingMinors(st, 'T1'), ['SENT']);
  // the same facts on a DEFAULT run: the sentence blocks nothing
  let def = newState('r1', { now: NOW });
  def = applyTicketPatch(def, 'T1', { status: 'started', branch: 't1', spec: 'spec.md' }, NOW, { specText: SPEC559 });
  def = applyTicketPatch(def, 'T1', { findings: { SENT: SENT559 } }, NOW);
  assert.deepEqual(blockingMinors(def, 'T1'), []);
  assert.equal(mergeBlockRefusal(def, 'T1'), null);
});

test('#559 must-FAIL: a v0.5.378-shaped state (spawned, no marker, no explicit value) is NOT re-read with the new defaults — acceptance still on, the spec sentence still blocks, MINOR-only follow-ups still refused; `show` says so', async (t) => {
  const raw = v378Shaped();
  const st = parseState(raw);
  assert.equal(defaultsProfileOf(st), 'v0.5.378');
  assert.deepEqual(switchesOf(st), V378_DEFAULT_SWITCHES);
  assert.deepEqual(blockingMinors(st, 'T1'), ['SENT'], 'spec still in force');
  assert.doesNotThrow(() => claimAcceptor(st, 'T1', 'accept-T1', NOW), 'acceptance still on: the writer claim is not refused');
  const home = mkHome(t);
  putRaw(home, raw);
  const d = deps(home);
  assert.match(show(d), /earlyGate=on \(default\) · acceptance=on \(default kept from v0.5.378 \(run started before the defaults change\)\) · minorPolicy=spec \(default kept from v0.5.378 \(run started before the defaults change\)\) · verifier=on \(default\) · preNominationChecks=off \(default\) — the run already spawned/);
  assert.equal(switchSourceOf(st, 'earlyGate'), 'default', 'earlyGate is on in both profiles: nothing was kept');
  // the new binary's FIRST WRITE (any writer, here one that patches no ticket) pins the profile on the file, so no later write can flip it …
  assert.equal(set(d, '--harness', 'test/e2e/boot.ts').code, 0);
  assert.equal(stateOf(home).switchDefaults, 'v0.5.378');
  assert.equal(set(d, 'T2', '--status', 'todo').code, 0);
  // … not even one that takes the run back to "nothing spawned" (the signal that decided the profile is gone)
  assert.equal(set(d, 'T1', '--status', 'todo').code, 0);
  assert.equal(firstSpawnSignal(stateOf(home)), null, 'nothing recorded any more');
  assert.deepEqual(switchesOf(stateOf(home)), V378_DEFAULT_SWITCHES, 'still the v0.5.378 defaults');
  assert.deepEqual(blockingMinors(stateOf(home), 'T1'), ['SENT']);
  // the host-side reader (skill render, stamp) reads the same rule
  assert.deepEqual(switchesForRun(home, 'r1'), V378_DEFAULT_SWITCHES);
  assert.equal(switchesStamp('V', switchesForRun(home, 'r1')), 'V+sw:acceptance=on,minorPolicy=spec');
  // an unspawned run, a run with no state, and a state that cannot be read (an install never fails on it) read the new defaults
  assert.deepEqual(switchesForRun(mkHome(t), 'r1'), DEFAULT_SWITCHES);
  const broken = mkHome(t); fs.mkdirSync(path.dirname(stateFile(broken, 'r1')), { recursive: true }); fs.writeFileSync(stateFile(broken, 'r1'), '{not json');
  assert.deepEqual(switchesForRun(broken, 'r1'), DEFAULT_SWITCHES);
  // a v0.5.378 state FROZEN on a set it chose (full set stored) whose tickets no longer show a spawn: still a v0.5.378 run; a chosen value is explicit, an unchanged one is the kept default
  const frozen = parseState({ version: 1, run: 'r1', target: 'master', repo: null, switches: { earlyGate: 'on', acceptance: 'off', minorPolicy: 'spec' }, switchesFrozen: { at: NOW, by: 'first spawn of the run: ticket A is started' }, tickets: {}, updatedAt: NOW, reconciledAt: null });
  assert.equal(firstSpawnSignal(frozen), null);
  assert.equal(defaultsProfileOf(frozen), 'v0.5.378');
  assert.deepEqual(switchesOf(frozen), { earlyGate: 'on', acceptance: 'off', minorPolicy: 'spec', verifier: 'on', preNominationChecks: 'off' });
  assert.deepEqual(SWITCH_NAMES.map((n) => switchSourceOf(frozen, n)), ['default', 'explicit', 'default-kept-v0.5.378', 'default', 'default']);
});

test('#559: a v0.5.378 state that has NOT spawned reads the new defaults; its first spawn (the marker is stamped BEFORE the patch) never turns it into a legacy run; the stored explicit set of a v0.5.378 run is kept as written', (t) => {
  const home = mkHome(t);
  const raw = JSON.parse(JSON.stringify(newState('r1', { now: NOW }))) as Record<string, any>;
  delete raw.switchDefaults; // as v0.5.378 wrote a fresh run
  putRaw(home, raw);
  const d = deps(home);
  assert.equal(defaultsProfileOf(parseState(raw)), 'v0.5.375');
  assert.deepEqual(switchesOf(parseState(raw)), DEFAULT_SWITCHES);
  assert.equal(set(d, 'T1', '--status', 'started', '--branch', 't1').code, 0, 'the first spawn');
  assert.equal(stateOf(home).switchDefaults, 'v0.5.375');
  assert.deepEqual(switchesOf(stateOf(home)), DEFAULT_SWITCHES, 'acceptance off after the spawn');
  // the pure writers stamp first too (a direct caller, no updateState)
  const pure = applyTicketPatch(parseState(raw), 'T1', { status: 'started' }, NOW);
  assert.equal(pure.switchDefaults, 'v0.5.375');
  assert.equal(stampDefaults(pure), pure, 'idempotent');
  // a v0.5.378 state with an explicit full set stored and not spawned: the stored values stay (effective values unchanged), read as explicit
  const stored = parseState({ ...raw, switches: { earlyGate: 'off', acceptance: 'on', minorPolicy: 'spec' } });
  assert.deepEqual(switchesOf(stored), { earlyGate: 'off', acceptance: 'on', minorPolicy: 'spec', verifier: 'on', preNominationChecks: 'off' });
  assert.equal(switchSourceOf(stored, 'acceptance'), 'explicit');
  // the writer claim (acceptance explicitly on) is a spawn too: it stamps first
  const claimed = claimAcceptor(parseState({ ...raw, switches: { acceptance: 'on' }, tickets: { T1: { spec: 's.md' } } }), 'T1', 'accept-T1', NOW);
  assert.equal(claimed.switchDefaults, 'v0.5.375');
  assert.deepEqual(switchesOf(claimed), { earlyGate: 'on', acceptance: 'on', minorPolicy: 'legacy', verifier: 'on', preNominationChecks: 'off' });
});

test('#559 must-FAIL: a switch changed after the first spawn is still refused — on a default run, on a run that kept the v0.5.378 defaults, even to the value it already has', (t) => {
  const d = deps(mkHome(t)); init(d);
  assert.equal(set(d, 'A', '--status', 'started', '--branch', 'a').code, 0);
  for (const v of ['acceptance=on', 'acceptance=off', 'minorPolicy=spec', 'earlyGate=off']) {
    const r = set(d, '--switch', v);
    assert.equal(r.code, 1, v);
    assert.match(r.stderr, /cannot change: the run already spawned \(ticket A is started\)/, v);
  }
  const home = mkHome(t);
  putRaw(home, v378Shaped());
  for (const v of ['acceptance=off', 'acceptance=on', 'minorPolicy=legacy']) {
    const r = set(deps(home), '--switch', v);
    assert.equal(r.code, 1, v);
    assert.match(r.stderr, /cannot change: the run already spawned/, v);
  }
  assert.deepEqual(switchesOf(stateOf(home)), V378_DEFAULT_SWITCHES);
});

test('#559 `state show` labels each switch: default / explicit (even a value equal to the default) / default kept from v0.5.378; `state --help` states the new defaults and the in-flight rule', (t) => {
  const d = deps(mkHome(t)); init(d, 'acceptance=off');
  assert.match(show(d), /earlyGate=on \(default\) · acceptance=off \(explicit\) · minorPolicy=legacy \(default\) · verifier=on \(default\) · preNominationChecks=off \(default\) — not frozen yet/);
  const help = runFanout(['--help'], d).stdout;
  assert.match(help, /earlyGate=on\|off {6}on \(default\)/);
  assert.match(help, /acceptance=on\|off {5}off \(default\): no writer spawned, no frozen test asked; on:/);
  assert.match(help, /minorPolicy=legacy\|refuse\|spec\|demonstrated {3}legacy \(default\)/);
  assert.match(help, /spec: #552/);
  assert.doesNotMatch(help, /on \(default\): --spec spawns|spec \(default\)/, 'the old defaults are gone from the help');
  assert.match(help, /default kept from v0\.5\.378 \(run started before the defaults change\)/);
  assert.match(help, /ALREADY spawned when they changed keeps the old ones/);
});
