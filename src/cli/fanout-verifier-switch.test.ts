// #563 — the `verifier` switch (on default | off), frozen at the run's first spawn. Every arm drives the production path: `state init|set|show`, the skill render + installer, `deliver`.
// must-PASS: off renders no verifier role and delivers on review verdict + green CI; on is byte-identical to master. must-FAIL: off + no verdict / open MAJOR / red or missing CI / --no-review-gate / a switch change after the first spawn.
// Mutants of every clause: scripts/e2e-fanout-switches.mjs (verifier arms).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFanout, type FanoutDeps, type Runner } from './fanout-state.ts';
import { deliver, realDeps, verifierSwitchFromState, type DeliverDeps, type DeliverOpts, type GhResult } from './fanout-deliver.ts';
import { DEFAULT_SWITCHES, applyTicketPatch, newState, readState, stateFile, switchesOf, switchesStamp, type Switches } from '../shared/fanout-state.ts';
import { renderSwitchBlocks } from '../shared/fanout-switch-render.ts';
import { renderVerifiedFanoutSkill } from '../shared/verified-fanout-skill.ts';
import { VERIFIED_FANOUT_FILES, VERIFIED_FANOUT_V2_REFERENCES } from '../shared/verified-fanout-files.ts';
import { installVerifiedFanoutSkill } from '../main/verified-fanout-install.ts';

const NOW = '2026-11-24T10:00:00.000Z';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const offline: Runner = () => ({ code: 1, stdout: '', stderr: 'offline' });
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

function mkHome(t: { after: (fn: () => void) => void }): string {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'fanout-ver-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const deps = (home: string): FanoutDeps => ({ env: { ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: 'r1' }, cwd: home, runner: offline, now: () => NOW, readStdin: () => '' });
const init = (d: FanoutDeps, sw?: string) => runFanout(['state', 'init', '--run', 'r1', ...(sw ? ['--switch', sw] : [])], d);
const set = (d: FanoutDeps, ...a: string[]) => runFanout(['state', 'set', '--run', 'r1', ...a], d);
const show = (d: FanoutDeps) => runFanout(['state', 'show', '--run', 'r1'], d).stdout;
function withEnv<T>(home: string, fn: () => T): T {
  const prev = { h: process.env.ORCHESTRA_HOME, w: process.env.ORCHESTRA_WS_ID };
  process.env.ORCHESTRA_HOME = home; process.env.ORCHESTRA_WS_ID = 'r1';
  const restore = (): void => { for (const [k, v] of [['ORCHESTRA_HOME', prev.h], ['ORCHESTRA_WS_ID', prev.w]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  try { const r = fn(); if (r instanceof Promise) return r.finally(restore) as T; restore(); return r; } catch (e) { restore(); throw e; }
}

// ── the switch: default, verbs, freeze ───────────────────────────────────────────────────────────────────

test('verifier: default on in BOTH defaults profiles; `state show` prints it with the default label; off is stored explicit; an unknown value is refused', (t) => {
  assert.equal(switchesOf(undefined).verifier, 'on');
  assert.equal(switchesOf({ switchDefaults: 'v0.5.378' }).verifier, 'on', 'a run that kept the v0.5.378 defaults keeps verifier on');
  const d = deps(mkHome(t));
  init(d);
  assert.match(show(d), /minorPolicy=legacy \(default\) · verifier=on \(default\) · preNominationChecks=off \(default\) — not frozen yet/);
  const r = set(d, '--switch', 'verifier=off');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /verifier=off \(explicit\)/);
  assert.match(show(d), /verifier=off \(explicit\)/);
  assert.deepEqual(readState(stateFile(d.env.ORCHESTRA_HOME!, 'r1'))!.switches, { verifier: 'off' });
  const bad = set(d, '--switch', 'verifier=maybe');
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /switch verifier must be on\|off \(got "maybe"\)/);
  assert.match(init(deps(mkHome(t)), 'verifier=off').stdout, /initialised/);
});

test('verifier must-FAIL: a switch changed after the first spawn is refused — to the other value AND to the same one', (t) => {
  for (const first of ['verifier=off', 'verifier=on']) {
    const d = deps(mkHome(t));
    init(d, first);
    assert.equal(set(d, 'T1', '--status', 'started', '--branch', 't1').code, 0);
    for (const v of ['verifier=on', 'verifier=off']) {
      const r = set(d, '--switch', v);
      assert.equal(r.code, 1, `${first} → ${v}`);
      assert.match(r.stderr, /cannot change: .*first spawn of the run: ticket T1 is started/);
    }
  }
  // a default run (no switch set): the first spawn locks it too
  const d = deps(mkHome(t));
  init(d);
  set(d, 'T1', '--status', 'started', '--branch', 't1');
  assert.equal(set(d, '--switch', 'verifier=off').code, 1);
});

test('verifier=off: no verifier workspace can be recorded (state set --verifier, --json, the pure patch); on records it; clearing is allowed', (t) => {
  const off = deps(mkHome(t));
  init(off, 'verifier=off');
  const r = set(off, 'T1', '--verifier', 'ws-1');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /verifier=off \(#563\).*no verifier workspace is recorded/);
  assert.equal(set(off, 'T1', '--json', '{"verifier":"ws-1"}').code, 1);
  assert.equal(set(off, 'T1', '--implementer', 'ws-9').code, 0, 'an implementer is recorded as usual');
  assert.equal(set(off, 'T1', '--json', '{"verifier":null}').code, 0, 'clearing is no seat');
  const on = deps(mkHome(t));
  init(on);
  assert.equal(set(on, 'T1', '--verifier', 'ws-1').code, 0);
  // the pure transition refuses on its own (a caller that skips the verb still cannot record a seat)
  const st = newState('r1', { now: NOW, switches: { verifier: 'off' } });
  assert.throws(() => applyTicketPatch(st, 'T1', { verifier: 'ws-1' }, NOW), /verifier=off/);
  assert.equal(applyTicketPatch(newState('r1', { now: NOW }), 'T1', { verifier: 'ws-1' }, NOW).tickets.T1.verifier, 'ws-1');
});

test('verifier: the stamp names a non-default switch only (a default run keeps the plain version); a stamp from a partial set never prints undefined', () => {
  assert.equal(switchesStamp('V1', { ...DEFAULT_SWITCHES }), 'V1');
  assert.equal(switchesStamp('V1', { ...DEFAULT_SWITCHES, verifier: 'off' }), 'V1+sw:verifier=off');
  assert.equal(switchesStamp('V1', { earlyGate: 'on', acceptance: 'off', minorPolicy: 'legacy' } as Switches), 'V1');
});

// ── the skill ────────────────────────────────────────────────────────────────────────────────────────────

/** What master rendered (sha256; re-pinned by #568, which changed the verifier-on CI sentence of SKILL.md + verifier-and-review.md only): `on` must be byte-identical. */
const MASTER_DEFAULT = { skill: 'a9073a594a19c8018dfcd34ebf4abbfc2e7c3eca5e28b9899bf398186480950a', refs: {
  'references/acceptance-tests.md': 'f8cdec046e92091d0cc3dc5dd7adcfd8640a8bb505eed68946fe024ce82efdd8',
  'references/budget-and-gates.md': 'f181c77bbc2c5e47b80982ec098cb9e4fb01d5b46cd8b8c66527a261bd97dbe7',
  'references/closeout-and-gates.md': 'f4d7f7a7b0c3013d36590a0364a84128757b0b5346b9fe64b1c1d5a2dcae45c7',
  'references/fleet-bus.md': 'bf6aa4ba306934656d9a88f30bc8b8ab149067e3bc612eeb1e2ba9ab60d2606a',
  'references/lead-ops-tiers.md': '268ff1e15fd4450415e764218ae37cac817f704bb193e2f89b776cce67df766b',
  'references/verifier-and-review.md': '4d5535bf76b2f11f850c0caaf1c11232ab50a5c8d9f942a4ae2f6b7809d57d0c',
} as Record<string, string> };
const MASTER_ALL_ON = { skill: 'f3fd918b3db0af2a0b92f64ca1af84e3a12eb7f5c37340045c0e196ec291078a', verifierAndReview: '249bd05cdd4636b34c5ee0034f647b8d56a6bbfeba5c009b099b03c17b5beff8' };

test('verifier=on must-PASS: the default render and every reference are BYTE-IDENTICAL to master (and so is the all-features-on render)', () => {
  assert.equal(sha(renderVerifiedFanoutSkill({})), MASTER_DEFAULT.skill);
  assert.equal(sha(renderVerifiedFanoutSkill({ verifier: 'on' })), MASTER_DEFAULT.skill);
  assert.equal(sha(renderVerifiedFanoutSkill({ acceptance: 'on', minorPolicy: 'spec', verifier: 'on' })), MASTER_ALL_ON.skill);
  for (const f of VERIFIED_FANOUT_V2_REFERENCES) assert.equal(sha(renderSwitchBlocks(f.content, {})), MASTER_DEFAULT.refs[f.path], f.path);
  assert.equal(sha(renderSwitchBlocks(VERIFIED_FANOUT_V2_REFERENCES.find((f) => f.path === 'references/verifier-and-review.md')!.content, { acceptance: 'on', minorPolicy: 'spec' })), MASTER_ALL_ON.verifierAndReview);
});

/** The word as a ROLE: the reference file's own name (`verifier-and-review.md`) is a path, not a role. */
const roleMentions = (text: string): string[] => text.replace(/verifier-and-review/g, '').split('\n').filter((l) => /verif(?:ier|-)/i.test(l));

test('verifier=off must-PASS: SKILL.md and every v2 reference name no verifier role in ANY switch combination; the reviewer, the CI and the merge rule stay', () => {
  for (const acceptance of ['on', 'off'] as const) for (const earlyGate of ['on', 'off'] as const) for (const minorPolicy of ['legacy', 'refuse', 'spec'] as const) {
    const sw = { verifier: 'off', acceptance, earlyGate, minorPolicy } as const;
    const md = renderVerifiedFanoutSkill(sw);
    assert.deepEqual(roleMentions(md), [], JSON.stringify(sw));
    assert.ok(!md.includes('<!--sw') && !md.includes('<!--/sw'), 'no directive left');
    for (const f of VERIFIED_FANOUT_V2_REFERENCES) assert.deepEqual(roleMentions(renderSwitchBlocks(f.content, sw)), [], `${f.path} ${JSON.stringify(sw)}`);
    assert.match(md, /## 3b\. Adversarial review/);
    assert.match(md, /A review round with 0 BLOCKING/);
    assert.match(md, /--review-verdict/);
    assert.doesNotMatch(md, /## 3\. Spawn the verifier|`verif-`/);
  }
  const off = renderVerifiedFanoutSkill({ verifier: 'off' });
  assert.match(off, /## 3\. No gating seat: the CI and the reviewer/);
  assert.match(off, /--no-review-gate`\s+is refused too/);
  assert.match(off, /Review verdict in and CI green/);
  assert.doesNotMatch(off, /- PASS → apply|is the explicit ungated merge|back to the verifier/);
  assert.match(renderVerifiedFanoutSkill({}), /- PASS → apply/);
  assert.match(renderVerifiedFanoutSkill({}), /is the explicit ungated merge/);
  assert.notEqual(off, renderVerifiedFanoutSkill({}));
});

test('verifier=off: every installed file follows the switch (installer), a flip re-renders once, flipping back restores master\'s bytes', async (t) => {
  const skills = path.join(mkHome(t), 'skills');
  assert.equal(await installVerifiedFanoutSkill(skills, undefined, { verifier: 'off', acceptance: 'on' }), 'written');
  const root = path.join(skills, 'verified-fanout');
  assert.deepEqual(roleMentions(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8')), []);
  for (const f of VERIFIED_FANOUT_V2_REFERENCES) assert.deepEqual(roleMentions(fs.readFileSync(path.join(root, f.path), 'utf8')), [], f.path);
  assert.ok(VERIFIED_FANOUT_FILES.every((f) => fs.existsSync(path.join(root, f.path))), 'the v1 files (frozen, byte-identical to v1) are still installed');
  assert.equal(await installVerifiedFanoutSkill(skills, undefined, {}), 'written');
  assert.equal(sha(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8')), MASTER_DEFAULT.skill, 'back on: the default render of master');
});

// ── deliver: review verdict + green CI is the whole gate ─────────────────────────────────────────────────

type Ci = 'green' | 'red' | 'none';
function rig(ci: Ci = 'green') {
  let merged = false;
  const gh = async (args: string[]): Promise<GhResult> => {
    const [a, b] = args;
    const ok = (s: string): GhResult => ({ code: 0, stdout: s, stderr: '' });
    if (a === 'api') return { code: 1, stdout: '', stderr: 'HTTP 404' };
    if (a === 'pr' && b === 'list') return ok(JSON.stringify([{ number: 7, url: 'https://github.com/o/r/pull/7', state: merged ? 'MERGED' : 'OPEN', headRefOid: A }]));
    if (a === 'pr' && b === 'view') {
      if (args.includes('state,mergeCommit')) return ok(JSON.stringify({ state: merged ? 'MERGED' : 'OPEN', mergeCommit: { oid: 'c'.repeat(40) } }));
      const roll = ci === 'none' ? [] : [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: ci === 'green' ? 'SUCCESS' : 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/900/job/901' }];
      return ok(JSON.stringify({ state: merged ? 'MERGED' : 'OPEN', baseRefName: 'master', headRefOid: A, mergeable: 'MERGEABLE', statusCheckRollup: roll }));
    }
    if (a === 'run' && b === 'view') return ok(JSON.stringify({ jobs: [{ databaseId: 901, steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run tests', conclusion: 'success' }] }] }));
    if (a === 'pr' && b === 'merge') { merged = true; return ok(''); }
    return { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  };
  const dd: DeliverDeps = { ...realDeps(), gh, sleep: async () => {}, now: () => 0, log: () => {} };
  return { dd, merged: () => merged };
}
const verdictFile = (dir: string, v: { blocking?: number; major?: number; head?: string }): string => {
  const f = path.join(dir, `verdict-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify({ round: 1, blocking: v.blocking ?? 0, major: v.major ?? 0, minor: 2, head: v.head ?? A }));
  return f;
};
const dopts = (o: Partial<DeliverOpts> = {}): DeliverOpts => ({ branch: 't1', into: 'master', ticket: 'T1', verifiedHead: A, strategy: 'merge', timeoutMs: 600_000, intervalMs: 10_000, noChecksGraceMs: 0, requireChecks: [], run: 'r1', ...o });
function runOf(t: { after: (fn: () => void) => void }, sw: string | undefined): string {
  const home = mkHome(t);
  const d = deps(home);
  init(d, sw);
  set(d, 'T1', '--status', 'nominated', '--branch', 't1', '--head', A);
  return home;
}

test('verifier=off must-PASS: a reviewer verdict with 0 BLOCKING / 0 MAJOR on the head and a green CI merge — no verifier recorded anywhere', async (t) => {
  const home = runOf(t, 'verifier=off');
  assert.equal(readState(stateFile(home, 'r1'))!.tickets.T1.verifier, null);
  const r = rig('green');
  const out = await withEnv(home, () => deliver(dopts({ reviewVerdict: verdictFile(home, {}) }), r.dd));
  assert.equal(out.exit, 0, JSON.stringify(out.result));
  assert.equal(out.result.verdict, 'merged');
  assert.equal(out.result.reviewGated, true);
  assert.equal(r.merged(), true);
});

test('verifier=off must-FAIL: no review verdict, --no-review-gate, an open MAJOR, an open BLOCKING, a red CI, no CI, a verdict for another tree — each refused, nothing merged', async (t) => {
  const home = runOf(t, 'verifier=off');
  const cases: Array<[string, Partial<DeliverOpts>, Ci, string]> = [
    ['no verdict', {}, 'green', 'no-verdict'],
    ['--no-review-gate', { noReviewGate: true }, 'green', 'no-verdict'],
    ['open MAJOR', { reviewVerdict: verdictFile(home, { major: 1 }) }, 'green', 'review-blocking'],
    ['open BLOCKING', { reviewVerdict: verdictFile(home, { blocking: 1 }) }, 'green', 'review-blocking'],
    ['red CI', { reviewVerdict: verdictFile(home, {}) }, 'red', 'ci-red'],
    ['missing CI', { reviewVerdict: verdictFile(home, {}) }, 'none', 'no-checks'],
    ['verdict of another head', { reviewVerdict: verdictFile(home, { head: B }) }, 'green', 'verdict-head-mismatch'],
  ];
  for (const [name, o, ci, reason] of cases) {
    const r = rig(ci);
    const out = await withEnv(home, () => deliver(dopts(o), r.dd));
    assert.equal(out.exit, 2, `${name}: ${JSON.stringify(out.result)}`);
    assert.equal(out.result.reason, reason, name);
    assert.equal(r.merged(), false, `${name}: nothing merged`);
  }
});

test('verifier=on is unchanged: --no-review-gate still merges ungated (reviewGated:false); the switch is read only when the flag is given', async (t) => {
  const home = runOf(t, undefined);
  const r = rig('green');
  const out = await withEnv(home, () => deliver(dopts({ noReviewGate: true }), r.dd));
  assert.equal(out.exit, 0, JSON.stringify(out.result));
  assert.equal(out.result.reviewGated, false);
  // a deliver that gives a verdict never consults the switch (a state that cannot be read changes nothing for it)
  let consulted = 0;
  const r2 = rig('green');
  const out2 = await withEnv(home, () => deliver(dopts({ reviewVerdict: verdictFile(home, {}) }), { ...r2.dd, verifierSwitch: () => { consulted++; return 'off'; } }));
  assert.equal(out2.exit, 0);
  assert.equal(consulted, 0);
});

test('verifier=off: the switch reader fails closed — an explicit --run with no state, an unknown ticket, an unreadable state ⇒ exit 1 (never an ungated merge); no run at all = not consulted', async (t) => {
  const home = runOf(t, 'verifier=off');
  const r = rig('green');
  const missing = await withEnv(home, () => deliver(dopts({ noReviewGate: true, run: 'nope' }), r.dd));
  assert.equal(missing.exit, 1);
  assert.equal(missing.result.reason, 'bad-state');
  const unknown = await withEnv(home, () => deliver(dopts({ noReviewGate: true, ticket: 'T9' }), r.dd));
  assert.equal(unknown.exit, 1);
  assert.equal(unknown.result.reason, 'bad-state');
  fs.writeFileSync(stateFile(home, 'r1'), '{ not json');
  const bad = await withEnv(home, () => deliver(dopts({ noReviewGate: true }), r.dd));
  assert.equal(bad.exit, 1);
  assert.equal(r.merged(), false);
  assert.equal(withEnv(home, () => verifierSwitchFromState({ ticket: 'T1' }, { ORCHESTRA_HOME: home })), null, 'no run id in the env, none given: no state consulted');
  // the reader on its own (the other state readers would also fail such a deliver: pin THIS one)
  const env = { ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: 'r1' };
  assert.throws(() => verifierSwitchFromState({ ticket: 'T1', run: 'nope' }, env), /no fanout state for --run nope/);
  const home2 = runOf(t, 'verifier=off');
  assert.throws(() => verifierSwitchFromState({ ticket: 'T9', run: 'r1' }, { ORCHESTRA_HOME: home2 }), /ticket T9 is not in the fanout state/);
  assert.equal(verifierSwitchFromState({ ticket: 'T1', run: 'r1' }, { ORCHESTRA_HOME: home2 }), 'off');
  // deliver with ONLY this reader wired: a reader that throws is could-not-check, never an ungated merge
  const r3 = rig('green');
  const lone = await deliver(dopts({ noReviewGate: true }), { ...r3.dd, upstreams: undefined, acceptance: undefined, followUp: undefined, verifierSwitch: () => { throw new Error('state unreadable'); } });
  assert.equal(lone.exit, 1);
  assert.equal(lone.result.reason, 'bad-state');
  assert.equal(r3.merged(), false);
  const loneOff = await deliver(dopts({ noReviewGate: true }), { ...rig('green').dd, upstreams: undefined, acceptance: undefined, followUp: undefined, verifierSwitch: () => 'off' });
  assert.equal(loneOff.exit, 2);
});

test('help: `state --help` and `deliver --help` document the verifier switch', () => {
  const state = fs.readFileSync(new URL('./fanout-state.ts', import.meta.url), 'utf8');
  const dlv = fs.readFileSync(new URL('./fanout-deliver.ts', import.meta.url), 'utf8');
  assert.match(state, /verifier=on\|off\s+on \(default\)/);
  assert.match(dlv, /DELIVER_HELP = `[\s\S]*verifier=off \(#563, \\`state set --switch verifier=off\\`\)[\s\S]*Refuses on:/);
});
