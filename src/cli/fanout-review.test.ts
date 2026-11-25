// #588 (I3) — `orchestra fanout review`: the brief rendered by code, the reviewer spawned / woken / replaced by the host, who it is recorded, the caller PROVEN by the host.
// Drives the production path: `state init|set` → `runReview` (CLI half) → `dispatchFanoutAcceptance` op `review` (host half, fake spawn + bus: zero tokens). Mutants of every clause: scripts/e2e-fanout-review-mutants.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFanout, type FanoutDeps, type Runner } from './fanout-state.ts';
import { runReview } from './fanout-review.ts';
import { dispatchFanoutAcceptance, type AcceptanceHostDeps } from '../shared/fanout-acceptance-host.ts';
import { readState, stateFile, parseState, switchesOf, writeStateAtomic, type FanoutState } from '../shared/fanout-state.ts';
import { resolveCaller } from '../shared/fanout-caller.ts';
import { briefHash as commonHash, renderDecisions, renderInterfaces, renderSwitchesLine } from '../shared/fanout-brief-common.ts';
import { assertReviewable, decideReview, renderBriefOf, reviewerName } from '../shared/fanout-review.ts';
import { REVIEWER_RULES, SWITCH_SENTENCES, briefHash } from '../shared/fanout-review-brief.ts';
import type { IdentityResolution } from '../shared/session-identity.ts';

const NOW = '2026-11-25T10:00:00.000Z';
const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const HOST: IdentityResolution = { source: 'host', runId: 'r1', generation: null };
const UNVOUCHED: IdentityResolution = { source: 'env', why: 'no-key' };
const mergeBase: Runner = (cmd, args) => (cmd === 'git' && args[0] === 'merge-base' ? { code: 0, stdout: `${BASE}\n`, stderr: '' } : { code: 1, stdout: '', stderr: 'offline' });

function mkHome(t: { after: (fn: () => void) => void }): string {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'fanout-rv-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
/** `ws` = the workspace id the CLI believes it is (env); `id` = what the host vouched (undefined = nothing). */
const deps = (home: string, ws = 'r1', identity: IdentityResolution | null = HOST, stdin = ''): FanoutDeps => ({ env: { ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: ws }, cwd: home, runner: mergeBase, now: () => NOW, readStdin: () => stdin, identity });
const set = (d: FanoutDeps, ...a: string[]) => runFanout(['state', 'set', '--run', 'r1', ...a], d);
const review = (d: FanoutDeps, ...a: string[]) => runReview(['--run', 'r1', ...a], d);
const load = (home: string): FanoutState => readState(stateFile(home, 'r1'))!;
/** #589: under seatRecords=on the coordinator cannot type a finding (`[finding-source]`) — an open finding of the reviewer is seeded straight into the state file. */
function seedFinding(home: string, ticket: string, id: string, severity: 'BLOCKING' | 'MAJOR' | 'MINOR'): void {
  const s = load(home);
  writeStateAtomic(stateFile(home, 'r1'), { ...s, tickets: { ...s.tickets, [ticket]: { ...s.tickets[ticket], findings: { ...s.tickets[ticket].findings, [id]: { severity } } } } });
}

/** A run with seatRecords=on and ticket T1 started on H1 (a head is all `review` needs) (implementer impl-1); a dependent T2 on T1. */
function mkRun(t: { after: (fn: () => void) => void }, sw = 'seatRecords=on'): { home: string; d: FanoutDeps } {
  const home = mkHome(t);
  const d = deps(home);
  assert.equal(runFanout(['state', 'init', '--run', 'r1', '--switch', sw], d).code, 0);
  fs.writeFileSync(path.join(home, 'spec.txt'), 'T1 must frob the widget.');
  if (sw.includes('seatRecords=on')) { assert.equal(set(d, '--plan', 'T1').code, 0); assert.equal(set(d, 'T1', '--depends-on', 'none').code, 0); } // #587: the plan + the dependencies are declared before the first spawn
  const r = set(d, 'T1', '--status', 'started', '--branch', 'impl-t1', '--head', H1, '--implementer', 'impl-1', '--spec', 'spec.txt');
  assert.equal(r.code, 0, r.stderr);
  return { home, d };
}

interface Host { deps: AcceptanceHostDeps; spawned: Array<{ name: string; task: string; from?: string }>; posted: Array<{ to: string; body: string; sender: string }>; live: Set<string>; failNextSpawn: { v: string | null }; failPost: { v: boolean } }
function mkHost(home: string): Host {
  const h: Host = { spawned: [], posted: [], live: new Set(), failNextSpawn: { v: null }, failPost: { v: false }, deps: undefined as never };
  let n = 0;
  h.deps = {
    home, now: () => NOW,
    isWorkspace: (id) => id === 'r1' || h.live.has(id),
    isLive: (id) => h.live.has(id),
    repoPath: () => undefined,
    spawn: async (i) => {
      await new Promise((r) => setTimeout(r, 5));
      if (h.failNextSpawn.v) { const e = h.failNextSpawn.v; h.failNextSpawn.v = null; return { ok: false, error: e }; }
      const id = `rev-${++n}`;
      h.spawned.push({ name: i.name, task: i.task, ...(i.from ? { from: i.from } : {}) });
      h.live.add(id);
      return { ok: true, id };
    },
    post: (i) => { if (h.failPost.v) throw new Error('bus down'); h.posted.push(i); },
  };
  return h;
}
/** The whole verb: CLI half then the host calls it asked for. */
async function runVerb(d: FanoutDeps, host: Host, ...a: string[]) {
  const r = review(d, ...a);
  const results = [];
  for (const c of r.hostCalls ?? []) results.push(await dispatchFanoutAcceptance(c.body, host.deps));
  return { r, results };
}

// ── off / refusals ───────────────────────────────────────────────────────────────────────────────────────

test('seatRecords=off (the default): `fanout review` is refused [review-off] and says why, nothing is spawned; the state file is byte-identical', async (t) => {
  const { home, d } = mkRun(t, 'seatRecords=off');
  const before = fs.readFileSync(stateFile(home, 'r1'), 'utf8');
  const host = mkHost(home);
  const { r, results } = await runVerb(d, host, 'T1');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^refused: \[review-off\] seatRecords is OFF/);
  assert.equal(results.length, 0);
  assert.equal(host.spawned.length, 0);
  assert.equal(fs.readFileSync(stateFile(home, 'r1'), 'utf8'), before, 'neither refusal wrote anything');
  assert.equal(review(d, 'T1', '--print').code, 2, '--print is refused too: there is no brief under off');
});

test('refusals: [review-no-head] · [review-plan] · unknown ticket; every one STARTS with its bracketed name and exits 2 (1 for a usage / unknown-ticket error)', (t) => {
  const { home, d } = mkRun(t);
  assert.equal(set(d, '--plan-add', 'T9').code, 0);
  assert.equal(set(d, 'T9', '--depends-on', 'none').code, 0);
  assert.equal(set(d, 'T9', '--status', 'started').code, 0);
  const r = review(d, 'T9');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^refused: \[review-no-head\] T9 has no recorded head/);
  assert.equal(review(d, 'T404').code, 1);
  // [review-plan] (I2, #587): a plan ticket absent from the state (`--plan-add` is allowed after the first spawn)
  assert.equal(set(d, '--plan-add', 'T7').code, 0);
  const pr = review(d, 'T1');
  assert.equal(pr.code, 2);
  assert.match(pr.stderr, /^refused: \[review-plan\] the run's plan is incomplete: T7: in the plan but not in the state/);
  assert.equal(review(d, 'T1', '--print').code, 2, '--print is refused too');
  void home;
});

// ── the caller ───────────────────────────────────────────────────────────────────────────────────────────

test('the CALLER is the run\'s coordinator vouched by the HOST: a forged ORCHESTRA_WS_ID (no vouch / host did not answer / the worker\'s own vouch) is [review-caller]', (t) => {
  const { home } = mkRun(t);
  const file = fs.readFileSync(stateFile(home, 'r1'), 'utf8');
  const cases: Array<[string, FanoutDeps, RegExp]> = [
    ['forged id, no vouch', deps(home, 'r1', null), /the host did not vouch for r1: env-asserted \(not asked\)/],
    ['forged id, keyless session', deps(home, 'r1', UNVOUCHED), /env-asserted \(host did not vouch: no-key\)/],
    ['a worker (its own id, vouched)', deps(home, 'impl-1', HOST), /only the run's coordinator \(r1\).*impl-1 \(implementer\)/],
    ['a stranger (vouched)', deps(home, 'someone', HOST), /\(other\)/],
    ['no identity at all', { ...deps(home, ''), env: { ORCHESTRA_HOME: home } }, /unidentified/],
  ];
  for (const [why, d, re] of cases) {
    const r = review(d, 'T1');
    assert.equal(r.code, 2, why);
    assert.match(r.stderr, /^refused: \[review-caller\]/, why);
    assert.match(r.stderr, re, why);
    assert.equal(r.hostCalls, undefined, `${why}: nothing reaches the host`);
  }
  assert.equal(fs.readFileSync(stateFile(home, 'r1'), 'utf8'), file);
  const ok = review(deps(home), 'T1');
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(ok.hostCalls?.[0].body, { op: 'review', run: 'r1', ticket: 'T1', head: H1, base: BASE, from: 'r1', callerId: 'r1', key: '' }, 'the host re-proves the caller: it gets the id and the session key (empty here: no key in this env)');
});

test('resolveCaller: the role comes from the STATE by position, the proof only from the host resolution', (t) => {
  const { home } = mkRun(t);
  const st = load(home);
  assert.deepEqual(resolveCaller(st, { ORCHESTRA_WS_ID: 'r1' }, HOST), { id: 'r1', role: 'coordinator', proof: 'host-vouched' });
  assert.deepEqual(resolveCaller(st, { ORCHESTRA_WS_ID: 'impl-1' }, HOST), { id: 'impl-1', role: 'implementer', proof: 'host-vouched' });
  assert.equal(resolveCaller(st, { ORCHESTRA_WS_ID: 'r1' }).proof, 'env-asserted (not asked)');
  assert.equal(resolveCaller(st, { ORCHESTRA_WS_ID_IDENTITY: 'r1' }, UNVOUCHED).proof, 'env-asserted (host did not vouch: no-key)');
  assert.equal(resolveCaller(st, {}, HOST).proof, 'env-asserted (no workspace identity)', 'a host answer cannot vouch for an id the env does not carry');
  const rv = { ...st, tickets: { ...st.tickets, T1: { ...st.tickets.T1, review: { reviewer: { id: 'rev-9', name: 'review-T1', at: NOW }, head: H1, base: null, briefs: [] } } } };
  assert.equal(resolveCaller(rv, { ORCHESTRA_WS_ID: 'rev-9' }, HOST).role, 'reviewer');
});

// ── no free text ─────────────────────────────────────────────────────────────────────────────────────────

test('NO flag takes free text for the brief: every text-ish flag and a second positional is refused, nothing is rendered or spawned', (t) => {
  const { d } = mkRun(t);
  for (const a of [['--note', 'x'], ['--text', 'x'], ['--brief', 'x'], ['--message', 'x'], ['--prompt', 'x'], ['--task', 'x'], ['--instructions', 'x'], ['--decision', 'x'], ['--run-decision', 'x']]) {
    const r = review(d, 'T1', ...a);
    assert.equal(r.code, 1, a.join(' '));
    assert.match(r.stderr, /unknown flag/, a.join(' '));
    assert.equal(r.hostCalls, undefined);
  }
  assert.equal(review(d, 'T1', 'also this').code, 1);
  assert.equal(review(d).code, 1, 'a ticket is required');
  // the usage names exactly the two flags
  const u = runReview(['--help'], d);
  assert.match(u.stdout, /\[--run <id>\] \[--print\]/);
});

// ── the brief ────────────────────────────────────────────────────────────────────────────────────────────

test('--print: renders without spawning or writing; two renders of the same state are byte-identical; each element is in it (ticket, exact head + base, decisions verbatim, interfaces, switches, rules, how to end)', (t) => {
  const { home, d } = mkRun(t, 'seatRecords=on,minorPolicy=demonstrated');
  assert.equal(set(d, '--run-decision', 'D-one: keep the v2 wire shape\nsecond line').code, 0);
  assert.equal(set(d, '--run-decision', 'D-two: no new flag').code, 0);
  const before = fs.readFileSync(stateFile(home, 'r1'), 'utf8');
  const a = review(d, 'T1', '--print');
  const b = review(d, 'T1', '--print');
  assert.equal(a.code, 0, a.stderr);
  assert.equal(a.stdout, b.stdout, 'two renders are identical');
  assert.equal(a.hostCalls, undefined, '--print spawns nothing');
  assert.equal(fs.readFileSync(stateFile(home, 'r1'), 'utf8'), before, '--print writes nothing');
  const out = a.stdout;
  assert.ok(out.includes('T1 must frob the widget.'), 'the ticket text');
  assert.ok(out.includes(`head: ${H1}`) && out.includes(`base: ${BASE}`), 'the exact head and its base');
  assert.ok(out.includes('1. D-one: keep the v2 wire shape\nsecond line') && out.includes('2. D-two: no new flag'), 'the decisions, numbered, verbatim (the shared renderer)');
  assert.ok(out.includes('seatRecords=on') && out.includes('minorPolicy=demonstrated'), 'the switches');
  assert.ok(out.includes(SWITCH_SENTENCES['minorPolicy=demonstrated']), 'the demonstration rule of #572 under minorPolicy=demonstrated');
  assert.ok(out.includes(REVIEWER_RULES), 'the reviewer\'s rules');
  assert.ok(out.includes('## How to end') && out.includes('worker_done --to r1'), 'how to end');
  assert.match(out, /kind: spawn {2}hash: [0-9a-f]{64}/);
});

test('a switch that is OFF leaves no sentence of its own (must-fail arms: one per sentence), a switch that is on adds exactly its own', (t) => {
  const arms: Array<[string, string, string]> = [ // [switches on, the key of the sentence that must appear, the sw value that turns it off]
    ['acceptance=on', 'acceptance=on', 'acceptance=off'],
    ['minorPolicy=demonstrated', 'minorPolicy=demonstrated', 'minorPolicy=legacy'],
    ['minorPolicy=spec', 'minorPolicy=spec', 'minorPolicy=legacy'],
    ['minorPolicy=refuse', 'minorPolicy=refuse', 'minorPolicy=legacy'],
    ['preNominationChecks=on', 'preNominationChecks=on', 'preNominationChecks=off'],
    ['verifier=off', 'verifier=off', 'verifier=on'],
  ];
  for (const [on, key, off] of arms) {
    const render = (sw: string): string => { const { d } = mkRun(t, `seatRecords=on,${sw}`); return review(d, 'T1', '--print').stdout; };
    const withIt = render(on);
    const without = render(off);
    assert.ok(withIt.includes(SWITCH_SENTENCES[key]), `${on}: its sentence is in the brief`);
    for (const [k, s] of Object.entries(SWITCH_SENTENCES)) {
      if (k !== key) assert.ok(!withIt.includes(s), `${on}: no sentence of another switch (${k})`);
      assert.ok(!without.includes(s), `${off}: no sentence of ${k}`);
    }
  }
});

test('a dependent\'s brief carries the frozen interface of its upstream with the version it follows (STALE when it follows an older one), and its own interface', (t) => {
  const { home, d } = mkRun(t);
  assert.equal(set(d, '--plan-add', 'T2').code, 0);
  assert.equal(set(d, 'T1', '--interface', 'frob(widget): void').code, 0);
  assert.equal(set(d, 'T1', '--interface', 'frob(widget): Promise<void>', '--interface-reason', 'async now').code, 0);
  const r2 = set(d, 'T2', '--depends-on', 'T1', '--follows', 'T1=1', '--status', 'started', '--head', H2, '--branch', 'impl-t2');
  assert.equal(r2.code, 0, r2.stderr);
  const stale = review(d, 'T2', '--print').stdout;
  assert.ok(stale.includes('### T1 — interface v2 (changes: v1→v2: async now)\nfrob(widget): Promise<void>') && stale.includes('- T1: this ticket follows v1 but the current is v2: STALE'), stale);
  assert.equal(set(d, 'T2', '--follows', 'T1=2').code, 0);
  assert.ok(review(d, 'T2', '--print').stdout.includes('- T1: followed v2 = current'));
  const own = review(d, 'T1', '--print').stdout;
  assert.ok(own.includes('### T1 — interface v2 (changes: v1→v2: async now)\nfrob(widget): Promise<void>'), own);
  void home;
});

// ── the host: spawn / same head / new head / dead ────────────────────────────────────────────────────────

test('first call spawns ONE nested `review-` reviewer, records who it is + the brief and its sha256; a second call on the same head spawns nothing', async (t) => {
  const { home, d } = mkRun(t);
  const host = mkHost(home);
  const first = await runVerb(d, host, 'T1');
  assert.equal(first.results[0].ok, true);
  assert.equal(host.spawned.length, 1);
  assert.equal(host.spawned[0].name, 'review-T1', 'the reviewer role prefix');
  assert.equal(host.spawned[0].from, 'r1', 'nested under the coordinator, never detached');
  const rec = load(home).tickets.T1.review!;
  assert.equal(rec.reviewer?.id, 'rev-1');
  assert.equal(rec.head, H1);
  assert.equal(rec.base, BASE);
  assert.equal(rec.briefs.length, 1);
  assert.equal(rec.briefs[0].kind, 'spawn');
  assert.equal(rec.briefs[0].reviewer, 'rev-1');
  assert.equal(rec.briefs[0].text, host.spawned[0].task, 'the stored brief IS what the reviewer was given');
  assert.equal(rec.briefs[0].hash, crypto.createHash('sha256').update(rec.briefs[0].text).digest('hex'));
  assert.equal(rec.briefs[0].hash, briefHash(host.spawned[0].task));
  const second = await runVerb(d, host, 'T1');
  assert.equal(host.spawned.length, 1, 'no second reviewer on the same head');
  assert.equal(host.posted.length, 0, 'and no wake');
  assert.deepEqual({ ok: second.results[0].ok, action: (second.results[0] as { action?: string }).action }, { ok: true, action: 'noop' });
  assert.equal(load(home).tickets.T1.review!.briefs.length, 1, 'nothing recorded either');
});

test('two concurrent calls spawn ONE reviewer (the slot is claimed under the state lock before the spawn)', async (t) => {
  const { home, d } = mkRun(t);
  const host = mkHost(home);
  const call = review(d, 'T1').hostCalls![0].body;
  const rs = await Promise.all([dispatchFanoutAcceptance(call, host.deps), dispatchFanoutAcceptance(call, host.deps)]);
  assert.equal(host.spawned.length, 1);
  assert.equal(rs.filter((r) => r.ok && (r as { action: string }).action === 'spawn').length, 1);
});

test('a NEW head wakes the SAME live reviewer with the delta + its open findings (must-fail: a live reviewer replaced); the brief is the wake brief, recorded', async (t) => {
  const { home, d } = mkRun(t);
  const host = mkHost(home);
  await runVerb(d, host, 'T1');
  seedFinding(home, 'T1', 'F1', 'MAJOR');
  assert.equal(set(d, 'T1', '--head', H2).code, 0);
  const r = await runVerb(d, host, 'T1');
  const res = r.results[0] as { ok: true; action: string; id: string };
  assert.equal(res.action, 'wake');
  assert.equal(res.id, 'rev-1', 'the same reviewer');
  assert.equal(host.spawned.length, 1, 'no new reviewer');
  assert.equal(host.posted.length, 1);
  assert.equal(host.posted[0].to, 'rev-1');
  assert.ok(host.posted[0].body.includes(`${H1.slice(0, 12)}..${H2.slice(0, 12)}`), 'the delta');
  assert.ok(host.posted[0].body.includes('F1 [MAJOR]'), 'its open finding');
  const rec = load(home).tickets.T1.review!;
  assert.equal(rec.head, H2);
  assert.deepEqual(rec.briefs.map((b) => [b.n, b.kind, b.head, b.reviewer]), [[1, 'spawn', H1, 'rev-1'], [2, 'wake', H2, 'rev-1']]);
  assert.equal(rec.briefs[1].text, host.posted[0].body);
});

test('a reviewer that is dead or deleted is REPLACED by a new one that gets the open findings (new name, new brief of kind replace)', async (t) => {
  const { home, d } = mkRun(t);
  const host = mkHost(home);
  await runVerb(d, host, 'T1');
  seedFinding(home, 'T1', 'F1', 'BLOCKING');
  host.live.delete('rev-1');
  const r = await runVerb(d, host, 'T1');
  assert.equal((r.results[0] as { action: string }).action, 'replace');
  assert.equal(host.spawned.length, 2);
  assert.equal(host.spawned[1].name, 'review-T1-r2');
  assert.ok(host.spawned[1].task.includes('You REPLACE the earlier reviewer'));
  assert.ok(host.spawned[1].task.includes('F1 [BLOCKING]'), 'the open finding is in the replacement\'s brief');
  const rec = load(home).tickets.T1.review!;
  assert.equal(rec.reviewer?.id, 'rev-2');
  assert.deepEqual(rec.briefs.map((b) => [b.kind, b.reviewer]), [['spawn', 'rev-1'], ['replace', 'rev-2']]);
  // dead AND the same head: still replaced (a dead reviewer on this head reviews nothing)
  host.live.delete('rev-2');
  assert.equal(((await runVerb(d, host, 'T1')).results[0] as { action: string }).action, 'replace');
});

test('a failed spawn is recorded with its error and retried (one unsent brief, not a pile); a failed wake delivery records NOTHING', async (t) => {
  const { home, d } = mkRun(t);
  const host = mkHost(home);
  host.failNextSpawn.v = 'no capacity';
  const bad = await runVerb(d, host, 'T1');
  assert.equal(bad.results[0].ok, false);
  assert.match((bad.results[0] as { error: string }).error, /could not spawn the reviewer: no capacity/);
  const rec0 = load(home).tickets.T1.review!;
  assert.equal(rec0.reviewer?.error, 'no capacity');
  assert.equal(rec0.reviewer?.id, null);
  assert.equal(((await runVerb(d, host, 'T1')).results[0] as { action: string }).action, 'spawn', 'retryable');
  assert.equal(load(home).tickets.T1.review!.briefs.length, 1, 'the failed attempt\'s brief was replaced, not kept');
  assert.equal(host.spawned[0].name, 'review-T1', 'the retry keeps the first name');
  // wake that cannot be delivered
  assert.equal(set(d, 'T1', '--head', H2).code, 0);
  host.failPost.v = true;
  const w = await runVerb(d, host, 'T1');
  assert.equal(w.results[0].ok, false);
  assert.match((w.results[0] as { error: string }).error, /could not wake review-T1 \(rev-1\): bus down — nothing was recorded/);
  const after = load(home).tickets.T1.review!;
  assert.equal(after.head, H1, 'the head the reviewer was briefed on did not move');
  assert.equal(after.briefs.length, 1);
  host.failPost.v = false;
  assert.equal(((await runVerb(d, host, 'T1')).results[0] as { action: string }).action, 'wake', 'the next call wakes it');
});

test('[review-role]: the recorded reviewer may not be the ticket\'s implementer / verifier / the coordinator — refused by the CLI and by the host, nothing spawned or woken', async (t) => {
  const { home, d } = mkRun(t);
  const host = mkHost(home);
  await runVerb(d, host, 'T1');
  for (const who of ['impl-1', 'r1', 'verif-1']) {
    const file = stateFile(home, 'r1');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.tickets.T1.review.reviewer.id = who;
    raw.tickets.T1.implementer = who === 'impl-1' ? 'impl-1' : 'impl-1';
    raw.tickets.T1.verifier = who === 'verif-1' ? 'verif-1' : null;
    fs.writeFileSync(file, JSON.stringify(raw));
    const r = review(d, 'T1');
    assert.equal(r.code, 2, who);
    assert.match(r.stderr, /^refused: \[review-role\] the reviewer /, who);
    const h = await dispatchFanoutAcceptance({ op: 'review', run: 'r1', ticket: 'T1', head: H1 }, host.deps);
    assert.equal(h.ok, false);
    assert.match((h as { error: string }).error, /\[review-role\]/);
  }
  assert.equal(host.spawned.length, 1);
  assert.equal(host.posted.length, 0);
  // a freshly spawned reviewer whose id turns out to be the implementer's is refused and the slot stays retryable
  const { home: h2, d: d2 } = mkRun(t);
  const host2 = mkHost(h2);
  host2.deps.spawn = async () => ({ ok: true, id: 'impl-1' });
  const r2 = await runVerb(d2, host2, 'T1');
  assert.equal(r2.results[0].ok, false);
  assert.match((r2.results[0] as { error: string }).error, /\[review-role\] the reviewer impl-1 is the ticket's implementer/);
  assert.ok(load(h2).tickets.T1.review!.reviewer?.error);
});

test('the host refuses a stale head (the ticket moved between the CLI call and the host call) and an off run, before spawning', async (t) => {
  const { home, d } = mkRun(t);
  const host = mkHost(home);
  const moved = await dispatchFanoutAcceptance({ op: 'review', run: 'r1', ticket: 'T1', head: H2 }, host.deps);
  assert.equal(moved.ok, false);
  assert.match((moved as { error: string }).error, /the head moved/);
  const off = mkRun(t, 'seatRecords=off');
  const o = await dispatchFanoutAcceptance({ op: 'review', run: 'r1', ticket: 'T1', head: H1 }, mkHost(off.home).deps);
  assert.equal(o.ok, false);
  assert.match((o as { error: string }).error, /\[review-off\]/);
  assert.equal(host.spawned.length, 0);
  void d;
});

// ── decisions ────────────────────────────────────────────────────────────────────────────────────────────

test('the decisions reach every brief verbatim, in order; a later decision shows in the next wake', async (t) => {
  const { home, d } = mkRun(t);
  assert.equal(set(d, '--run-decision', 'ALPHA decision').code, 0);
  const host = mkHost(home);
  await runVerb(d, host, 'T1');
  assert.ok(host.spawned[0].task.includes('1. ALPHA decision'));
  assert.equal(set(d, '--run-decision', 'BETA decision').code, 0);
  assert.equal(set(d, 'T1', '--head', H2).code, 0);
  await runVerb(d, host, 'T1');
  assert.ok(host.posted[0].body.includes('1. ALPHA decision') && host.posted[0].body.includes('2. BETA decision'));
});

// ── the state file ───────────────────────────────────────────────────────────────────────────────────────

test('review + decisions survive every later `state set`; a v1 file without them still loads; a corrupt review is refused by parseState', async (t) => {
  const { home, d } = mkRun(t);
  assert.equal(set(d, '--run-decision', 'keep me').code, 0);
  await runVerb(d, mkHost(home), 'T1');
  const rec = load(home).tickets.T1.review;
  assert.equal(set(d, 'T1', '--verdict', 'pass').code, 0);
  assert.deepEqual(load(home).tickets.T1.review, rec);
  assert.equal(load(home).decisions?.[0].text, 'keep me');
  const raw = JSON.parse(fs.readFileSync(stateFile(home, 'r1'), 'utf8'));
  delete raw.decisions; delete raw.tickets.T1.review;
  const plain = parseState(raw);
  assert.equal(plain.decisions, undefined);
  assert.equal(plain.tickets.T1.review, undefined);
  const bad = JSON.parse(fs.readFileSync(stateFile(home, 'r1'), 'utf8'));
  bad.tickets.T1.review.briefs[0].hash = 'nope';
  assert.throws(() => parseState(bad), /hash must be a sha256 hex/);
  const bad2 = JSON.parse(fs.readFileSync(stateFile(home, 'r1'), 'utf8'));
  bad2.decisions[0].n = 5;
  assert.throws(() => parseState(bad2), /decisions\[0\]\.n must be 1/);
});

test('decideReview + reviewerName (pure): the table of who does what', () => {
  const t = (rv: unknown, head: string | null) => ({ review: rv === undefined ? undefined : { reviewer: rv, head, base: null, briefs: [] } }) as never;
  const live = (id: string) => id === 'L';
  assert.deepEqual(decideReview(t(undefined, null), H1, NOW, live), { action: 'spawn', kind: 'spawn' });
  assert.deepEqual(decideReview(t({ id: null, name: 'n', at: NOW, error: 'x' }, null), H1, NOW, live), { action: 'spawn', kind: 'spawn' });
  assert.equal(decideReview(t({ id: null, name: 'n', at: NOW }, null), H1, NOW, live).action, 'noop', 'a spawn in flight');
  assert.equal(decideReview(t({ id: null, name: 'n', at: '2026-11-25T09:00:00.000Z' }, null), H1, NOW, live).action, 'spawn', 'a stale claim is retaken');
  assert.deepEqual(decideReview(t({ id: 'L', name: 'n', at: NOW }, H1), H1, NOW, live).action, 'noop');
  assert.equal(decideReview(t({ id: 'L', name: 'n', at: NOW }, H1), H1.slice(0, 10), NOW, live).action, 'noop', 'abbreviated sha, same head');
  assert.equal(decideReview(t({ id: 'L', name: 'n', at: NOW }, H1), H2, NOW, live).action, 'wake');
  assert.equal(decideReview(t({ id: 'D', name: 'n', at: NOW }, H1), H1, NOW, live).action, 'replace');
  assert.equal(reviewerName('NMC-360'), 'review-NMC-360');
  assert.equal(reviewerName('T 1/é', 2), 'review-T-1-e-r2');
});

test('index.ts wiring (source pin): `fanout review` and `state set --run-decision` ask the HOST who the caller is and hand the answer to the verb; the dispatch reaches runReview', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, 'index.ts'), 'utf8');
  assert.match(src, /const needsCaller = args\[0\] === 'review' \|\| args\[0\] === 'record' \|\| \(args\[0\] === 'state' && args\[1\] === 'set' && args\.includes\('--run-decision'\)\) \|\| stateSetNeedsHost\(args, process\.env\);/); // #589 adds `record` and the `--decide` ask
  assert.ok(src.includes('if (needsCaller) await settleHostIdentity();'), 'the host is asked before the verb runs');
  assert.ok(src.includes('...(needsCaller ? { identity: hostIdentity } : {})'), 'its answer is handed to the verb');
  assert.ok(src.includes("args[0] === 'review' ? runReview(args.slice(1), fanoutDeps)"), 'the verb is dispatched');
});

test('the HOST re-proves the caller of op review (a member posting straight to the socket): the session key must be the live one of the run\'s coordinator; no key / another workspace\'s key / another id ⇒ [review-caller], nothing spawned', async (t) => {
  const { home, d } = mkRun(t);
  const host = mkHost(home);
  host.deps.verifyCaller = (id, key) => (id === 'r1' && key === 'live-key' ? 'ok' : id === 'impl-1' && key === 'impl-key' ? 'ok' : 'superseded');
  const body = review(d, 'T1').hostCalls![0].body;
  for (const [why, b] of [['no key', { ...body, key: '' }], ['a wrong key', { ...body, key: 'impl-key' }], ['the worker\'s own (valid) key and id', { ...body, callerId: 'impl-1', key: 'impl-key' }], ['no callerId', { ...body, callerId: '', key: 'live-key' }]] as const) {
    const r = await dispatchFanoutAcceptance(b, host.deps);
    assert.equal(r.ok, false, why);
    assert.match((r as { error: string }).error, /^\[review-caller\]/, why);
  }
  assert.equal(host.spawned.length, 0);
  assert.equal((await dispatchFanoutAcceptance({ ...body, key: 'live-key' }, host.deps)).ok, true);
  assert.equal(host.spawned.length, 1);
  // production wiring (source pin): the registry is consulted
  const w = fs.readFileSync(path.join(import.meta.dirname, '..', 'main', 'fanout-acceptance-wiring.ts'), 'utf8');
  assert.ok(w.includes('verifyCaller: (id, key) => sessionKeys().verify(id, key)'));
});

test('a failed REPLACEMENT retried is still a replacement: it carries the open findings (not a "NEW reviewer" brief), keeps the -r2 name, and does not pile briefs', async (t) => {
  const { home, d } = mkRun(t);
  const host = mkHost(home);
  await runVerb(d, host, 'T1');
  seedFinding(home, 'T1', 'F1', 'BLOCKING');
  host.live.delete('rev-1');
  host.failNextSpawn.v = 'no capacity';
  assert.equal((await runVerb(d, host, 'T1')).results[0].ok, false);
  const r = await runVerb(d, host, 'T1');
  assert.equal((r.results[0] as { action: string }).action, 'replace');
  assert.equal(host.spawned[1].name, 'review-T1-r2');
  assert.ok(host.spawned[1].task.includes('You REPLACE the earlier reviewer') && host.spawned[1].task.includes('F1 [BLOCKING]'));
  assert.deepEqual(load(home).tickets.T1.review!.briefs.map((b) => [b.kind, b.reviewer]), [['spawn', 'rev-1'], ['replace', 'rev-2']]);
});

// ── decisions (I3, interface log v3: #588 owns them again) ───────────────────────────────────────────────

test('state set --run-decision: the coordinator\'s words, numbered, by the host-vouched coordinator only; text | file | - ; blank / oversize / extra flag / worker / forged id / seatRecords=off refused', (t) => {
  const { home, d } = mkRun(t);
  assert.equal(set(d, '--run-decision', 'first').code, 0);
  fs.writeFileSync(path.join(home, 'dec.txt'), '  second from a file \n');
  assert.equal(set(d, '--run-decision', path.join(home, 'dec.txt')).code, 0);
  assert.equal(set(deps(home, 'r1', HOST, 'third from stdin\n'), '--run-decision', '-').code, 0);
  assert.deepEqual(load(home).decisions!.map((x) => [x.n, x.text, x.by, x.at]), [[1, 'first', 'r1', NOW], [2, 'second from a file', 'r1', NOW], [3, 'third from stdin', 'r1', NOW]]);
  const refused: Array<[FanoutDeps, string[], RegExp, number]> = [
    [d, ['--run-decision', '   '], /^\[decision-blank\]/, 2],
    [d, ['--run-decision', 'x'.repeat(4001)], /at most 4000 characters/, 1],
    [d, ['T1', '--run-decision', 'x'], /run-level/, 1],
    [d, ['--run-decision', 'x', '--status', 'started'], /run-level/, 1],
    [deps(home, 'impl-1', HOST), ['--run-decision', 'x'], /^\[decision-caller\] only the run's coordinator/, 2],
    [deps(home, 'r1', null), ['--run-decision', 'x'], /^\[decision-caller\] the host did not vouch/, 2],
    [deps(home, 'r1', UNVOUCHED), ['--run-decision', 'x'], /^\[decision-caller\]/, 2],
  ];
  for (const [dd, a, re, code] of refused) { const r = set(dd, ...a); assert.equal(r.code, code, a.join(' ')); assert.match(r.stderr, re, a.join(' ')); }
  assert.equal(load(home).decisions!.length, 3, 'no refused call wrote');
  // without a host answer in the deps (a unit / embedded call) PR A's env-id rule stays: the coordinator's own id passes, a worker's is refused
  const { identity: _i, ...bare } = deps(home);
  assert.equal(set(bare as FanoutDeps, '--run-decision', 'bare ok').code, 0);
  assert.match(set({ ...bare, env: { ...bare.env, ORCHESTRA_WS_ID: 'impl-1' } } as FanoutDeps, '--run-decision', 'x').stderr, /^\[decision-caller\]/);
});

test('fanout-brief-common (PR A\'s ONE renderer both briefs share): decisions verbatim and numbered, the switch line with every switch, the interfaces with their change reasons, the hash — deterministic', (t) => {
  const { home, d } = mkRun(t);
  const st0 = load(home);
  assert.match(renderDecisions(st0), /none recorded/);
  assert.equal(set(d, '--run-decision', 'a\nb').code, 0);
  assert.equal(set(d, '--run-decision', 'c').code, 0);
  assert.equal(renderDecisions(load(home)), 'Decisions of the run (binding, verbatim — recorded by the coordinator):\n1. a\nb\n2. c');
  assert.match(renderSwitchesLine(st0), /seatRecords=on/);
  assert.equal(commonHash('abc'), crypto.createHash('sha256').update('abc').digest('hex'));
  assert.notEqual(commonHash('abc'), commonHash('abd'));
  assert.match(renderInterfaces(st0, ['T1']), /T1: no interface declared/);
});
