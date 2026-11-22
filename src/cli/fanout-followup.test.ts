// #514 — the follow-up rule through `state set`, `gate` and `deliver` (real state file in a scratch ORCHESTRA_HOME, fake gh).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFanout, defaultRunner, type FanoutDeps } from './fanout-state.ts';
import { followUpFromState } from './fanout-followup.ts';
import { gatePr } from './fanout-gate.ts';
import { deliver, type DeliverDeps, type DeliverOpts, type GhResult } from './fanout-deliver.ts';

const H1 = 'a'.repeat(40); // T-1 merged at
const H2 = 'b'.repeat(40); // a further candidate
const NOW = '2026-11-22T10:00:00.000Z';

function world() {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanout-fu-'));
  const env = { ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: 'rig' } as NodeJS.ProcessEnv;
  const deps: FanoutDeps = { env, cwd: home, runner: defaultRunner, now: () => NOW, readStdin: () => '' };
  const set = (...a: string[]) => runFanout(['state', 'set', ...a, '--run', 'rig'], deps);
  assert.equal(runFanout(['state', 'init', '--run', 'rig'], deps).code, 0);
  assert.equal(set('T-1', '--status', 'merged', '--branch', 't1', '--head', H1, '--finding', 'F-MAJ=MAJOR,F-MIN=minor').code, 0);
  return { home, env, deps, set, done: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test('state set: --follow-up-of/--fixes register a follow-up that names a MAJOR; MINOR-only and none are refused with the rule (exit 1)', () => {
  const w = world();
  try {
    const bad1 = w.set('T-1-fu', '--status', 'started', '--branch', 'fu', '--follow-up-of', 'T-1', '--fixes', 'F-MIN');
    const bad2 = w.set('T-1-fu', '--status', 'started', '--branch', 'fu', '--follow-up-of', 'T-1');
    assert.deepEqual([bad1.code, bad2.code], [1, 1]);
    assert.match(bad1.stderr, /only MINOR.*MINOR findings get no action/s);
    assert.match(bad2.stderr, /names no finding/);
    const ok = w.set('T-1-fu', '--status', 'started', '--branch', 'fu', '--follow-up-of', 'T-1', '--fixes', 'F-MAJ');
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /follow-up-of=T-1 fixes=F-MAJ/);
    // the same rule through --json (cannot sneak a MINOR-only follow-up in)
    const j = runFanout(['state', 'set', 'T-1-fu2', '--run', 'rig', '--json', JSON.stringify({ status: 'started', branch: 'fu2', followUpOf: 'T-1', fixes: ['F-MIN'] })], w.deps);
    assert.equal(j.code, 1);
    // a recorded severity is not re-graded
    assert.match(w.set('T-1', '--finding', 'F-MIN=MAJOR').stderr, /already recorded as MINOR/);
    assert.equal(w.set('T-1', '--status', 'nominated', '--head', H2).code, 1); assert.equal(w.set('T-1', '--status', 'nominated', '--head', H1).code, 1); // same head: still the merged ticket itself
  } finally { w.done(); }
});

const gh: DeliverDeps['gh'] = async (args): Promise<GhResult> => {
  if (args[0] === 'api') return { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }; // no workflows
  if (args[0] === 'pr' && args[1] === 'list') return { code: 0, stdout: '[]', stderr: '' };
  return { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
};
const gateDeps = (w: ReturnType<typeof world>, lenient = false) => ({ gh, log: () => {}, sleep: async () => {}, followUp: (o: { ticket: string; run?: string; head: string }) => followUpFromState({ ...o, lenient }, w.env) });
const gateOpts = (ticket: string, head: string) => ({ branch: 'fu', into: 'master', head, requireChecks: [], ticket, run: 'rig', settleMs: 0 });

test('gate: a follow-up naming a MAJOR is answered (exit 0); MINOR-only / none / undeclared candidate on a merged ticket ⇒ exit 2 refused with the reason; a plain ticket is unchanged', async () => {
  const w = world();
  try {
    assert.equal(w.set('FU-ok', '--status', 'started', '--branch', 'fu', '--follow-up-of', 'T-1', '--fixes', 'F-MAJ').code, 0);
    assert.equal(w.set('PLAIN', '--status', 'started', '--branch', 'p').code, 0);
    const ok = await gatePr(gateOpts('FU-ok', H2), gateDeps(w));
    assert.deepEqual([ok.exit, ok.result.verdict], [0, 'gate']);
    const plain = await gatePr(gateOpts('PLAIN', H2), gateDeps(w));
    assert.deepEqual([plain.exit, plain.result.verdict], [0, 'gate']);
    const undeclared = await gatePr(gateOpts('T-1', H2), gateDeps(w));
    assert.deepEqual([undeclared.exit, undeclared.result.verdict, undeclared.result.reason], [2, 'refused', 'followup-undeclared']);
    assert.equal((await gatePr(gateOpts('T-1', H1), gateDeps(w))).exit, 0); // its own merged head: not a follow-up
    // a hand-edited state (bypassing `state set`) is still refused at the gate
    const file = path.join(w.home, 'fanout', 'rig', 'state.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.tickets['FU-ok'].fixes = ['F-MIN'];
    fs.writeFileSync(file, JSON.stringify(raw));
    const minor = await gatePr(gateOpts('FU-ok', H2), gateDeps(w));
    assert.deepEqual([minor.exit, minor.result.reason], [2, 'followup-minor-only']);
    raw.tickets['FU-ok'].fixes = [];
    fs.writeFileSync(file, JSON.stringify(raw));
    assert.equal((await gatePr(gateOpts('FU-ok', H2), gateDeps(w))).result.reason, 'followup-no-finding');
    // unknown ticket: lenient without --run (not checked), exit 1 when strict
    assert.equal((await gatePr({ ...gateOpts('NOPE', H2), run: undefined }, gateDeps(w, true))).exit, 0);
    assert.equal((await gatePr(gateOpts('NOPE', H2), gateDeps(w))).exit, 1);
  } finally { w.done(); }
});

test('deliver: the same rule at the merge authority — refused (exit 2) BEFORE any gh call; a MAJOR-naming follow-up passes the clause', async () => {
  const w = world();
  try {
    assert.equal(w.set('FU-ok', '--status', 'started', '--branch', 'fu', '--follow-up-of', 'T-1', '--fixes', 'F-MAJ').code, 0);
    const calls: string[][] = [];
    const d = (): DeliverDeps => ({ gh: async (a) => { calls.push(a); return { code: 1, stdout: '', stderr: 'boom' }; }, sleep: async () => {}, now: () => 0, readFile: () => '', log: () => {}, followUp: (o) => followUpFromState(o, w.env) });
    const opts = (ticket: string): DeliverOpts => ({ branch: 'fu', into: 'master', ticket, run: 'rig', verifiedHead: H2, noReviewGate: true, strategy: 'merge', timeoutMs: 1000, intervalMs: 10, noChecksGraceMs: 0, requireChecks: [] });
    const undeclared = await deliver(opts('T-1'), d());
    assert.deepEqual([undeclared.exit, undeclared.result.reason], [2, 'followup-undeclared']);
    assert.equal(calls.filter((c) => c[0] !== 'api').length, 0, 'no PR/CI gh call before the refusal (only the one tree read of the candidate head)');
    const file = path.join(w.home, 'fanout', 'rig', 'state.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.tickets['FU-ok'].fixes = ['F-MIN'];
    fs.writeFileSync(file, JSON.stringify(raw));
    assert.equal((await deliver(opts('FU-ok'), d())).result.reason, 'followup-minor-only');
    raw.tickets['FU-ok'].fixes = ['F-MAJ'];
    fs.writeFileSync(file, JSON.stringify(raw));
    const pass = await deliver(opts('FU-ok'), d());
    assert.ok(calls.length > 0 && !String(pass.result.reason).startsWith('followup-'), `passed the clause (reached gh): ${pass.result.reason}`);
    assert.equal((await deliver(opts('T-1'), { ...d(), followUp: undefined })).result.reason, 'gh-failed'); // a deps without the reader: clause not consulted (pre-#514 behaviour)
    assert.equal((await deliver({ ...opts('T-1'), verifiedHead: H1 }, d())).result.reason, 'gh-failed'); // its own merged head = a retry, not a follow-up
  } finally { w.done(); }
});
