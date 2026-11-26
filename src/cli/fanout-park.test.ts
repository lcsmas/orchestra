// #603 (ledger #613 FROZEN NAMES v1) — the CLI face of parked / rounds / choices / pause: `state set` flags, `state show`, `fanout closeout`, `fanout resume`. In-process (argv + deps in, {code,stdout,stderr} out).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runFanout, type FanoutDeps, type RunResult, type Runner } from './fanout-state.ts';
import { runCloseout } from './fanout-closeout.ts';

const NOW = '2026-11-25T10:00:00.000Z';
const FP = crypto.createHash('sha256').update('situation').digest('hex');
const offline: Runner = () => ({ code: 1, stdout: '', stderr: 'offline' });

function world(t: { after: (fn: () => void) => void }) {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanout-park-cli-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const deps: FanoutDeps = { env: { ORCHESTRA_HOME: home }, cwd: home, runner: offline, now: () => NOW, readStdin: () => '' };
  const set = (...a: string[]): RunResult => runFanout(['state', 'set', '--run', 'r1', ...a], deps);
  const show = (): string => runFanout(['state', 'show', '--run', 'r1'], deps).stdout;
  assert.equal(runFanout(['state', 'init', '--run', 'r1'], deps).code, 0);
  // A ← B ← C, D alone
  for (const [id, args] of [['A', ['--status', 'started', '--branch', 'a']], ['B', ['--depends-on', 'A', '--frozen-interface', 'x', '--status', 'started', '--branch', 'b']], ['C', ['--depends-on', 'B', '--frozen-interface', 'x', '--status', 'started', '--branch', 'c']], ['D', ['--status', 'started', '--branch', 'd']]] as const) {
    const r = set(id, ...args);
    assert.equal(r.code, 0, r.stderr);
  }
  const state = (): any => JSON.parse(runFanout(['state', 'show', '--run', 'r1', '--json'], deps).stdout);
  return { home, deps, set, show, state };
}

test('--park <cause> --park-reason <text> parks the ticket AND its dependents; show and closeout print each with its cause and reason', (t) => {
  const w = world(t);
  const r = w.set('A', '--park', 'situation', '--park-reason', 'the same two findings on the same tree');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^A: parked .* parked=situation: the same two findings on the same tree parked-with-it=B,C\n$/);
  const s = w.state();
  assert.deepEqual(['A', 'B', 'C', 'D'].map((id) => s.tickets[id].status), ['parked', 'parked', 'parked', 'started']);
  assert.deepEqual(s.tickets.B.parked, { cause: 'upstream', reason: 'blocked by A', at: NOW, blockedBy: 'A' });
  const show = w.show();
  assert.match(show, /^A\s+parked\s+none/m);
  assert.match(show, /parked \(#603\): 3 ticket\(s\) set aside, never counted merged/);
  assert.match(show, /A {2}situation {2}the same two findings on the same tree/);
  assert.match(show, /B {2}upstream ← A {2}blocked by A/);
  const c = runCloseout(['--run', 'r1'], w.deps);
  assert.equal(c.code, 0, c.stderr);
  assert.match(c.stdout, /A {2}situation {2}the same two findings on the same tree/);
  assert.match(c.stdout, /C {2}upstream ← A {2}blocked by A/);
  const j = JSON.parse(runCloseout(['--run', 'r1', '--json'], w.deps).stdout);
  assert.deepEqual(j.parked.map((p: { ticket: string }) => p.ticket), ['A', 'B', 'C']);
  assert.equal(j.pause, null);
});

test('--status parked works with --park + --park-reason, and the dependents follow', (t) => {
  const w = world(t);
  const r = w.set('B', '--status', 'parked', '--park', 'ci', '--park-reason', 'the same check failed after its fix');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(['A', 'B', 'C', 'D'].map((id) => w.state().tickets[id].status), ['started', 'parked', 'parked', 'started']);
});

test('MUST-FAIL: every refusal exits 2 and starts with its frozen name', (t) => {
  const w = world(t);
  const refuse = (r: RunResult, name: string): void => { assert.equal(r.code, 2, `${name}: ${r.stdout}${r.stderr}`); assert.ok(r.stderr.startsWith(`[${name}]`), `${name}: ${r.stderr}`); };
  refuse(w.set('A', '--park', 'ci'), 'park-no-reason');
  refuse(w.set('A', '--park', 'ci', '--park-reason', '   '), 'park-no-reason');
  refuse(w.set('A', '--status', 'parked'), 'park-no-reason');
  refuse(w.set('A', '--json', '{"status":"parked"}'), 'park-no-reason');
  refuse(w.set('A', '--park', 'whatever', '--park-reason', 'x'), 'park-bad-cause');
  refuse(w.set('A', '--park', 'upstream', '--park-reason', 'x'), 'park-bad-cause');
  refuse(w.set('ghost', '--park', 'ci', '--park-reason', 'x'), 'park-unknown-ticket');
  assert.equal(w.set('D', '--status', 'merged').code, 0);
  refuse(w.set('D', '--park', 'ci', '--park-reason', 'x'), 'park-merged');
  refuse(w.set('--pause', ''), 'pause-no-reason');
  refuse(w.set('--choice-json', '{"ticket":"A","question":"","rule":"reversible-default","answer":"a"}'), 'choice-bad');
  refuse(w.set('--choice-json', '{"ticket":"A","question":"q","rule":"nope","answer":"a"}'), 'choice-bad');
  refuse(w.set('--choice-json', 'not json'), 'choice-bad');
  assert.equal(w.set('A', '--park-reason', 'x').code, 1, '--park-reason alone is a usage error');
  assert.equal(w.state().tickets.A.status, 'started', 'a refusal writes nothing');
});

test('--unpark releases the ticket and the dependents it held; --status on a parked ticket is refused until then', (t) => {
  const w = world(t);
  w.set('A', '--park', 'question', '--park-reason', 'NO SAFE OPTION: contradictory spec');
  const refused = w.set('B', '--status', 'started');
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /is parked .* --unpark/);
  const r = w.set('B', '--unpark');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unpark A/);
  const ok = w.set('A', '--unpark');
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /released=B,C/);
  assert.deepEqual(['A', 'B', 'C'].map((id) => w.state().tickets[id].status), ['started', 'started', 'started']);
  assert.match(w.set('A', '--unpark').stderr, /is not parked/);
  assert.equal(w.set('A', '--unpark', '--status', 'started').code, 1, '--unpark takes no other flag');
});

test('--round-fingerprint prints repeat=false the first time and repeat=true on the same situation again', (t) => {
  const w = world(t);
  const a = w.set('A', '--round-fingerprint', FP);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(a.stdout, 'repeat=false\n');
  const b = w.set('A', '--round-fingerprint', FP);
  assert.equal(b.stdout, 'repeat=true\n');
  assert.match(b.stderr, /round 2 recorded — the SAME situation/);
  assert.equal(w.set('A', '--round-fingerprint', crypto.createHash('sha256').update('other').digest('hex')).stdout, 'repeat=false\n');
  assert.deepEqual(w.state().tickets.A.rounds.map((r: { n: number }) => r.n), [1, 2, 3]);
  assert.match(w.show(), /situations seen \(#603\): A 3 round\(s\) \(SAME situation twice\)/);
  // must-FAIL arms
  assert.equal(w.set('A', '--round-fingerprint', 'NOT-HEX').code, 1);
  assert.equal(w.set('ghost', '--round-fingerprint', FP).code, 1);
  assert.equal(w.set('A', '--round-fingerprint', FP, '--status', 'started').code, 1, 'ticket-level alone');
  assert.equal(w.state().tickets.A.rounds.length, 3, 'a refusal records no round');
});

test('--choice-json records a choice; show and closeout list it (question + answer); stdin form works', (t) => {
  const w = world(t);
  const r = w.set('--choice-json', JSON.stringify({ ticket: 'B', question: 'rename the column?', rule: 'reversible-default', answer: 'keep the old name' }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /choice 1 recorded \(reversible-default, B\)/);
  const viaStdin = runFanout(['state', 'set', '--run', 'r1', '--choice-json', '-'], { ...w.deps, readStdin: () => JSON.stringify({ ticket: 'C', question: 'drop it?', rule: 'no-safe-option', answer: 'parked' }) });
  assert.equal(viaStdin.code, 0, viaStdin.stderr);
  assert.match(w.show(), /choices taken by agents \(#603\): 2\n {2}1\. B {2}reversible-default {2}Q: rename the column\? {2}→ keep the old name/);
  assert.match(runCloseout(['--run', 'r1'], w.deps).stdout, /2\. C {2}no-safe-option {2}Q: drop it\?/);
  assert.equal(JSON.parse(runCloseout(['--run', 'r1', '--json'], w.deps).stdout).choices.length, 2);
  assert.equal(w.set('A', '--choice-json', '{}').code, 1, 'run-level: no ticket');
});

test('--pause / --resume-run: the run says why it stopped; show and closeout print it; resume lifts it', (t) => {
  const w = world(t);
  const r = w.set('--pause', 'lint is red on 2 pull requests', '--pause-check', 'lint', '--pause-prs', '11,12');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /paused: lint is red on 2 pull requests \(check lint\) on PR #11, #12/);
  assert.deepEqual(w.state().pause, { at: NOW, reason: 'lint is red on 2 pull requests', check: 'lint', prs: [11, 12] });
  assert.match(w.show(), /run PAUSED \(#603\): lint is red on 2 pull requests — check lint red on PR #11, PR #12/);
  assert.match(runCloseout(['--run', 'r1'], w.deps).stdout, /run PAUSED \(#603\)/);
  assert.equal(w.set('--resume-run').stdout, 'resumed: the pause is lifted\n');
  assert.equal(w.state().pause, undefined);
  assert.equal(w.set('--resume-run').stdout, 'not paused: nothing to lift\n');
  assert.doesNotMatch(w.show(), /PAUSED/);
  // must-FAIL arms: run-level alone
  assert.equal(w.set('A', '--pause', 'x').code, 1);
  assert.equal(w.set('--pause', 'x', '--resume-run').code, 1);
  assert.equal(w.set('--pause', 'x', '--head', 'abcdef12').code, 1);
  assert.equal(w.set('--pause', 'x', '--pause-prs', 'a,b').code, 1);
});

test('a ticket set aside gets no acceptance-test writer: with acceptance on and a --spec, parking asks the host for no spawn (control: the same ticket unparked does)', (t) => {
  const w = world(t);
  const spec = path.join(w.home, 'spec.md');
  fs.writeFileSync(spec, 'The endpoint answers 400 on an empty body.\n');
  const on = runFanout(['state', 'init', '--run', 'acc', '--switch', 'acceptance=on'], w.deps);
  assert.equal(on.code, 0, on.stderr);
  const setAcc = (...a: string[]): RunResult => runFanout(['state', 'set', '--run', 'acc', ...a], w.deps);
  assert.ok(setAcc('X', '--status', 'started', '--branch', 'x', '--spec', spec).hostCalls?.length, 'control: a spec on a live ticket asks the host for its writer');
  const parked = setAcc('X', '--park', 'question', '--park-reason', 'NO SAFE OPTION: contradictory spec');
  assert.equal(parked.code, 0, parked.stderr);
  assert.equal(parked.hostCalls, undefined, 'a parked ticket gets no writer');
  assert.doesNotMatch(parked.stderr, /fanout deliver. will refuse it/, 'nor the "no spec" notice');
});

test('resume classifies a parked ticket as parked and never as merged — even when git says its branch tip is contained in the target', (t) => {
  const w = world(t);
  w.set('A', '--park', 'ci', '--park-reason', 'same failure after its fix');
  // every branch exists and its tip is an ancestor of origin/master: for a STARTED ticket that is trivially true (cut from the tip), for a PARKED one it must not read as a merge either
  const contained: Runner = (cmd, args) => (cmd === 'git' && args[0] === 'ls-remote' ? { code: 0, stdout: `${'c'.repeat(40)}\trefs/heads/x\n`, stderr: '' } : cmd === 'git' && args[0] === 'merge-base' ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'n/a' });
  const r = runFanout(['resume', '--run', 'r1', '--no-fetch', '--no-write', '--json'], { ...w.deps, runner: contained });
  const j = JSON.parse(r.stdout);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(['A', 'B', 'C', 'D'].map((id) => j.tickets[id].class), ['parked', 'parked', 'parked', 'in-progress']);
  assert.deepEqual(j.writeBack, [], 'nothing is written back as merged');
  assert.match(runFanout(['resume', '--run', 'r1', '--no-fetch', '--no-write'], { ...w.deps, runner: contained }).stdout, /3\/5 classify .*parked=3/);
});

test('a run that parks nothing prints nothing new: show, closeout (text and json) are free of the #603 sections', (t) => {
  const w = world(t);
  assert.doesNotMatch(w.show(), /#603/);
  assert.doesNotMatch(runCloseout(['--run', 'r1'], w.deps).stdout, /#603/);
  const j = JSON.parse(runCloseout(['--run', 'r1', '--json'], w.deps).stdout);
  for (const k of ['parked', 'choices', 'pause', 'situations']) assert.ok(!(k in j), k);
});

test('help: `fanout park-help` names the flags, the status and every refusal; the main usage stays byte-identical (pinned by fanout-seat-records)', () => {
  const d = { env: {}, cwd: '/', runner: offline, now: () => NOW, readStdin: () => '' };
  const help = runFanout(['park-help'], d).stdout;
  for (const f of ['--park question|situation|ci', '--park-reason', '--unpark', '--round-fingerprint', '--pause', '--pause-check', '--pause-prs', '--resume-run', '--choice-json', 'repeat=true', 'parked']) assert.ok(help.includes(f), f);
  for (const n of ['park-no-reason', 'park-bad-cause', 'park-merged', 'park-dropped', 'park-unknown-ticket', 'pause-no-reason', 'choice-bad']) assert.ok(help.includes(`[${n}]`), n);
  assert.ok(!runFanout(['--help'], d).stdout.includes('--park'), 'the default usage does not move (#587 golden hash)');
});

// ── the built CLI (dist-electron/cli.js), the way a person / the loop reaches it ───────────────────────────────────────────
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist-electron', 'cli.js');
test('BUILT CLI: park → show → closeout → unpark through `orchestra fanout`', { skip: fs.existsSync(CLI) ? false : 'dist-electron/cli.js absent (pretest builds it)' }, (t) => {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanout-park-built-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: '', ORCHESTRA_RUN_ID: '' };
  const run = (...a: string[]) => spawnSync(process.execPath, [CLI, 'fanout', ...a], { env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(run('state', 'init', '--run', 'rb').status, 0);
  assert.equal(run('state', 'set', 'A', '--run', 'rb', '--status', 'started', '--branch', 'a').status, 0);
  assert.equal(run('state', 'set', 'B', '--run', 'rb', '--depends-on', 'A', '--frozen-interface', 'x', '--status', 'started', '--branch', 'b').status, 0);
  const bad = run('state', 'set', 'A', '--run', 'rb', '--park', 'ci');
  assert.equal(bad.status, 2);
  assert.ok(bad.stderr.startsWith('[park-no-reason]'), bad.stderr);
  assert.equal(run('state', 'set', 'A', '--run', 'rb', '--park', 'ci', '--park-reason', 'red twice').status, 0);
  assert.match(run('state', 'show', '--run', 'rb').stdout, /B {2}upstream ← A {2}blocked by A/);
  assert.match(run('closeout', '--run', 'rb').stdout, /A {2}ci {2}red twice/);
  assert.equal(run('state', 'set', 'A', '--run', 'rb', '--round-fingerprint', FP).stdout, 'repeat=false\n');
  assert.equal(run('state', 'set', 'A', '--run', 'rb', '--round-fingerprint', FP).stdout, 'repeat=true\n');
  assert.equal(run('state', 'set', 'A', '--run', 'rb', '--unpark').status, 0);
  assert.doesNotMatch(run('state', 'show', '--run', 'rb').stdout, /parked \(#603\)/);
});
