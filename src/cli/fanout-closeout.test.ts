// #553 — `orchestra fanout closeout`: the default makes no tracker call and writes nothing; --file is opt-in, deduped, never fatal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFanout, type FanoutDeps, type Runner } from './fanout-state.ts';
import { runCloseout } from './fanout-closeout.ts';

const NOW = '2026-11-23T10:00:00.000Z';
const REP = { input: 'POST /x with []', happens: '500 instead of 400', where: 'src/api/x.ts:42', proof: 'curl -i → 500' };

function world(runner?: Runner) {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanout-closeout-'));
  const calls: string[] = [];
  const fake: Runner = runner ?? ((cmd, args) => { calls.push(`${cmd} ${args.join(' ')}`); return { code: 0, stdout: '[]', stderr: '' }; });
  const deps: FanoutDeps = { env: { ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: 'rig' } as NodeJS.ProcessEnv, cwd: home, runner: (c, a, w, e) => { calls.push(`${c} ${a.join(' ')}`); return fake(c, a, w, e); }, now: () => NOW, readStdin: () => '' };
  assert.equal(runFanout(['state', 'init', '--run', 'rig', '--repo', 'o/r'], deps).code, 0);
  const rec = (ticket: string, findings: unknown) => runFanout(['state', 'set', ticket, '--run', 'rig', '--status', 'started', '--json', JSON.stringify({ findings })], deps);
  return { home, deps, calls, rec, done: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test('default: one text per measured MINOR, NO tracker call, state untouched', () => {
  const w = world();
  try {
    assert.equal(w.rec('T-1', { 'F-1': { severity: 'MINOR', evidence: 'measured', report: REP }, 'F-A': { severity: 'MINOR', evidence: 'argued' }, 'F-P': { severity: 'MINOR', evidence: 'measured', kind: 'process' } }).code, 0);
    const file = path.join(w.home, 'fanout', 'rig', 'state.json');
    const before = fs.readFileSync(file, 'utf8');
    w.calls.length = 0;
    const r = runCloseout(['--run', 'rig'], w.deps);
    assert.equal(r.code, 0, r.stderr);
    assert.equal((r.stdout.match(/^--- ticket text /gm) ?? []).length, 1);
    assert.match(r.stdout, /1 argued MINOR \(declared\), 0 MINOR with no evidence recorded, 1 process finding/);
    assert.deepEqual(w.calls, [], 'the default close-out must not call git or gh');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally { w.done(); }
});

test('--file: one create per text, deduped on a re-run, a failing tracker never changes the exit code', () => {
  const issues: Array<{ n: number; body: string }> = [];
  let fail = false;
  const w = world((cmd, args) => {
    if (fail) return { code: 1, stdout: '', stderr: 'boom' };
    assert.equal(cmd, 'gh');
    if (args[1] === 'list') { const q = args[args.indexOf('--search') + 1].replace(/ in:body$/, ''); return { code: 0, stdout: JSON.stringify(issues.filter((i) => i.body.includes(q)).map((i) => ({ number: i.n }))), stderr: '' }; }
    if (args[1] === 'create') { issues.push({ n: 900 + issues.length, body: args[args.indexOf('--body') + 1] }); return { code: 0, stdout: `https://x/issues/${899 + issues.length}\n`, stderr: '' }; }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  });
  try {
    w.rec('T-1', { 'F-1': { severity: 'MINOR', evidence: 'measured', report: REP }, 'F-2': { severity: 'MINOR', evidence: 'measured', report: { ...REP, input: 'other' } } });
    const a = runCloseout(['--run', 'rig', '--file'], w.deps);
    assert.equal(a.code, 0); assert.equal(issues.length, 2);
    assert.ok(w.calls.some((c) => c.includes('-R o/r')), 'the state\'s repo is passed to gh');
    const b = runCloseout(['--run', 'rig', '--file'], w.deps);
    assert.equal(b.code, 0); assert.equal(issues.length, 2); assert.match(b.stderr, /already filed/);
    fail = true;
    issues.length = 0;
    const c = runCloseout(['--run', 'rig', '--file'], w.deps);
    assert.equal(c.code, 0); assert.match(c.stderr, /NOT filed/); assert.equal((c.stdout.match(/^--- ticket text /gm) ?? []).length, 2);
  } finally { w.done(); }
});

test('refusals: --repo without --file, an unknown flag, no state → exit 1', () => {
  const w = world();
  try {
    assert.equal(runCloseout(['--run', 'rig', '--repo', 'o/r'], w.deps).code, 1);
    assert.equal(runCloseout(['--run', 'rig', '--nope'], w.deps).code, 1);
    assert.equal(runCloseout(['--run', 'ghost'], w.deps).code, 1);
  } finally { w.done(); }
});
