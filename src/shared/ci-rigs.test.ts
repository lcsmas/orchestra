// #568 — the PR CI's rig list can never silently lose a rig: every package.json test:*/canary:* script and every standalone scripts/e2e-*.{mjs,sh}
// is in .github/ci-rigs.json as RUNS_IN_CI or LOCAL_ONLY + reason. Each guard has a must-FAIL arm; the log parsers + the "no silent green" judge are pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignGroups, groupsOf, isPostMergeRig, jobCount, judgeArm, judgeShards, tapFails, judge, MAX_JOBS, parseRigCounts, parseTapSummary, readRigFile, requiredRigIds, suiteShardsOf, tapSkips, validateRigs, type RigFile, type ShardResult } from './ci-rigs.ts';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mk = (rigs: RigFile['rigs']): RigFile => ({ rigs });
const ok = { class: 'RUNS_IN_CI' as const, command: 'x' };

test('the repo: every rig is classified, no stale or duplicate entry (the guard a new rig trips)', () => {
  const { ids } = requiredRigIds(root);
  assert.ok(ids.length > 100, `inventory looks truncated: ${ids.length} rigs`);
  assert.deepEqual(validateRigs(readRigFile(root), ids), []);
});

test('the inventory finds package.json rigs and the standalone e2e entry points', () => {
  const { ids } = requiredRigIds(root);
  assert.ok(ids.includes('test:fanout-open') && ids.includes('canary:pause'));
  assert.ok(ids.some((i) => /^scripts\/e2e-.*\.(mjs|sh)$/.test(i)));
  // a helper reached from a rig is not its own entry: test:hung-cli runs e2e-hung-cli-teardown.sh, which names the .mjs
  assert.ok(!ids.includes('scripts/e2e-hung-cli-teardown.sh'));
});

test('must-FAIL: a rig missing from the data file is reported by name', () => {
  const p = validateRigs(mk([{ id: 'test:a', ...ok }]), ['test:a', 'test:new-rig']);
  assert.equal(p.length, 1);
  assert.match(p[0], /test:new-rig/);
});

test('must-FAIL: LOCAL_ONLY without a reason, empty command, stale and duplicate entries, bad class/regex', () => {
  const p = validateRigs(mk([
    { id: 'test:a', command: 'x', class: 'LOCAL_ONLY' },
    { id: 'test:b', command: ' ', class: 'RUNS_IN_CI' },
    { id: 'test:gone', ...ok },
    { id: 'test:b', ...ok },
    { id: 'test:c', command: 'x', class: 'MAYBE' as never },
    { id: 'test:d', ...ok, passPattern: '(' },
  ]), ['test:a', 'test:b', 'test:c', 'test:d']);
  for (const re of [/test:a: LOCAL_ONLY without a reason/, /test:b: empty command/, /stale entry.*test:gone/, /duplicate entry: test:b/, /test:c: class must be/, /test:d: passPattern is not a valid regex/]) {
    assert.ok(p.some((x) => re.test(x)), `${re} not reported in ${JSON.stringify(p)}`);
  }
});

test('a LOCAL_ONLY rig with a reason is valid', () => {
  assert.deepEqual(validateRigs(mk([{ id: 'test:a', command: 'x', class: 'LOCAL_ONLY', reason: 'needs user systemd' }]), ['test:a']), []);
});

test('TAP summary: counts, last summary wins, absent summary is null (a truncated run is not green)', () => {
  const tap = '# tests 10\n# suites 2\n# pass 8\n# fail 1\n# cancelled 1\n# skipped 0\n# todo 0\n';
  assert.deepEqual(parseTapSummary(tap), { run: 10, pass: 8, fail: 2, skipped: 0, todo: 0, source: 'TAP summary' });
  assert.equal(parseTapSummary('ok 1 - a\nok 2 - b\n'), null);
});

test('TAP skips are named with their reason', () => {
  assert.deepEqual(tapSkips('    ok 3 - needs cli # SKIP dist-electron/cli.js absent\nok 4 - fine\n'), [{ name: 'needs cli', reason: 'dist-electron/cli.js absent' }]);
});

test('rig counts: PASS/FAIL lines, ✓, custom pattern; zero arms is zero', () => {
  assert.deepEqual(parseRigCounts('  PASS  a\n  PASS  b\n  FAIL  c\n').pass, 2);
  assert.equal(parseRigCounts('  PASS  a\n  FAIL  c\n').fail, 1);
  assert.equal(parseRigCounts('✓ one\n✓ two\n').pass, 2);
  assert.equal(parseRigCounts('{"arm":"a","ok":true}\n{"arm":"b","ok":false}\nKILLED  M1\n').pass, 2);
  assert.equal(parseRigCounts('arm A ok\narm B ok\n', { passPattern: ' ok$' }).pass, 2);
  assert.equal(parseRigCounts('nothing useful printed\n').run, 0);
});

test('judge — no silent green: exit 0 with zero arms is red; failed, skipped and non-zero exit are red', () => {
  const c = (run: number, pass: number, fail = 0, skipped = 0) => ({ run, pass, fail, skipped, source: 't' });
  assert.equal(judge(0, c(5, 5)).ok, true);
  assert.equal(judge(0, c(0, 0)).ok, false);
  assert.match(judge(0, c(0, 0)).why, /0 tests/);
  assert.equal(judge(0, { ...c(5, 4, 1), source: 'TAP summary' }).ok, false);
  assert.equal(judge(0, c(5, 4, 1)).ok, true, 'a non-TAP rig prints FAIL for the arms a mutant is meant to break: its exit code decides');
  assert.equal(judge(0, c(5, 4, 0, 1)).ok, false);
  assert.equal(judge(0, c(5, 4, 0, 1), { skippedAllowed: 1 }).ok, true);
  assert.equal(judge(1, c(5, 5)).ok, false);
});

test('ci.yml is read-only, secret-free and fans out through the data file', () => {
  const wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(wf, /^name: CI$/m);
  assert.match(wf, /^permissions:\n  contents: read\n/m);
  assert.ok(!/secrets\.|write-all|contents: write|pull-requests: write/.test(wf), 'a secret or write permission crept into ci.yml');
  // a new PR head cancels the old run; a workflow_dispatch (the #595 full run a release is gated on) is never cancelled by another
  assert.match(wf, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  // #586: pull_request only — a `push` trigger doubles every PR head's run; the concurrency group must still key on the PR so a new head cancels the old
  assert.ok(!/^\s*push:/m.test(wf), 'ci.yml has a push trigger: two runs per PR head (#586)');
  assert.match(wf, /^  pull_request:\n    branches: \[master\]\n/m);
  assert.match(wf, /format\('pr-\{0\}', github\.event\.pull_request\.number\)/);
  assert.match(wf, /format\('dispatch-\{0\}', github\.sha\)/);
  // #595: workflow_dispatch = the FULL run; path selection is on for pull_request ONLY, the ci-full label forces everything, every rig job decides before its install, the summary sees the merge commit's parents
  assert.match(wf, /^  workflow_dispatch:\n/m);
  assert.match(wf, /CI_PATH_SELECTION: \$\{\{ github\.event_name == 'pull_request' && '1' \|\| '0' \}\}/);
  assert.match(wf, /CI_FULL_REASON: .*contains\(github\.event\.pull_request\.labels\.\*\.name, 'ci-full'\)/);
  assert.match(wf, /id: plan\n\s+run: node [^\n]*run-group\.mjs "\$\{\{ matrix\.group \}\}" --plan/);
  assert.match(wf, /if: steps\.plan\.outputs\.run == 'true'/);
  assert.match(wf, /fetch-depth: 2/);
  assert.match(wf, /scripts\/ci\/rigs\.mjs summary/);
  assert.match(wf, /run-group\.mjs/);
  assert.match(wf, /fail-fast: false/);
});

test('ci.yml: the suite shard step is continue-on-error with a verdict step behind it; the gate therefore needs `--require-check suite` (a derived suite check is refused)', async () => {
  const { suiteJobsOf, workflowRunsOnPr } = await import('./fanout-deliver.ts');
  const wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.equal(workflowRunsOnPr(wf, 'master'), true);
  assert.deepEqual(suiteJobsOf(wf), [], 'a continue-on-error suite step is not derivable — if this ever derives, drop the --require-check advice');
  assert.match(wf, /id: suite\n\s+continue-on-error: true\n\s+run: pnpm run suite:shard > /);
  assert.match(wf, /if: always\(\)\n\s+run: node [^\n]*run-job\.mjs suite /);
  assert.match(wf, /SUITE_OUTCOME: \$\{\{ steps\.suite\.outcome \}\}/);
  assert.match(wf, /SUITE_SHARD: \$\{\{ matrix\.shard \}\}\n\s+SUITE_SHARDS: \$\{\{ matrix\.shards \}\}/);
  // package.json: the shard script is node's own sharding over the SAME glob as `test`, preceded by the same build:cli (the 12 CLI tests self-skip without it)
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts['presuite:shard'], pkg.scripts.pretest);
  assert.equal(pkg.scripts['suite:shard'], pkg.scripts.test.replace("--experimental-strip-types 'src", "--experimental-strip-types --test-shard=${SUITE_SHARD}/${SUITE_SHARDS} 'src"));
  // without continue-on-error a plain runner step would be derived as a check named for its job — the property the pin replaces (the job is `tests`, never `suite`)
  assert.ok(!suiteJobsOf(wf.replace('        continue-on-error: true\n', '')).includes('suite'));
});

/** The `jobs:` of ci.yml as `id → block text` (top-level keys at 2-space indent). */
function jobsOf(wf: string): Map<string, string> {
  const out = new Map<string, string>();
  const body = wf.slice(wf.indexOf('\njobs:\n') + 7).split('\n');
  let cur: string | null = null;
  for (const l of body) {
    const m = /^  ([\w-]+):\s*$/.exec(l);
    if (m) { cur = m[1]; out.set(cur, ''); } else if (cur) out.set(cur, out.get(cur) + l + '\n');
  }
  return out;
}

test('#594 ci.yml: static matrices pinned to ci-rigs.json (no inventory job), the check named `suite` is the verdict job over typecheck + every shard + every group, the PR fits the job limit', () => {
  const wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const file = readRigFile(root);
  const jobs = jobsOf(wf);
  assert.deepEqual([...jobs.keys()].sort(), ['rigs', 'suite', 'tests', 'typecheck'], 'an inventory (or any other) job would eat one of the 20');
  const list = (job: string, key: string): number[] => (new RegExp(`\\n\\s+${key}: \\[([\\d, ]+)\\]`).exec(jobs.get(job) as string)?.[1] ?? '').split(',').map((x) => Number(x.trim()));
  const iota = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);
  assert.deepEqual(list('tests', 'shard'), iota(suiteShardsOf(file)), 'ci.yml `tests` matrix shard list != suiteShards of .github/ci-rigs.json (change both)');
  assert.deepEqual(list('tests', 'shards'), [suiteShardsOf(file)], 'ci.yml `shards` != suiteShards of .github/ci-rigs.json');
  assert.deepEqual(list('rigs', 'group'), iota(groupsOf(file)), 'ci.yml `rigs` matrix group list != groups of .github/ci-rigs.json (change both)');
  assert.equal(list('tests', 'shard').length + list('rigs', 'group').length + 1, jobCount(file));
  assert.ok(jobCount(file) <= MAX_JOBS, `${jobCount(file)} jobs per PR`);
  // the `suite` job: its id IS the check name (no `name:`), runs after everything even when a need failed, and needs ALL of them (a skipped/cancelled need is red in the summary)
  const suite = jobs.get('suite') as string;
  assert.ok(!/^\s{4}name:/m.test(suite), 'the suite job must not be renamed: `--require-check suite` pins this exact check name');
  assert.match(suite, /needs: \[typecheck, tests, rigs\]\n\s+if: always\(\)/);
  assert.match(suite, /rigs\.mjs summary/);
  assert.match(suite, /NEEDS_JSON: \$\{\{ toJSON\(needs\) \}\}/);
  // no other job may be named `suite` (a second check of that name would make the pin ambiguous)
  assert.ok(!/^\s{4}name: suite\s*$/m.test(wf));
});

test('#594 ci-rigs.json: suiteShards + groups fit the job limit, rigs are balanced on their measured wall, the largest group is within 8% of the mean', () => {
  const file = readRigFile(root);
  assert.ok(Number.isInteger(file.suiteShards) && (file.suiteShards as number) >= 2, 'the suite is sharded (suiteShards >= 2)');
  assert.ok(jobCount(file) <= MAX_JOBS);
  const groups = assignGroups(file);
  const w = (id: string): number => file.rigs.find((r) => r.id === id)?.wallSec ?? 300;
  const loads = groups.map((g) => g.reduce((n, id) => n + w(id), 0));
  const mean = loads.reduce((a, b) => a + b, 0) / loads.length;
  assert.ok(Math.max(...loads) <= mean * 1.08, `groups unbalanced: ${loads.join(', ')}`);
});

test('must-FAIL: more jobs than the account runs, a bad suiteShards / groups, an empty group are validation problems', () => {
  const r = (id: string, extra: object = {}) => ({ id, command: 'x', class: 'RUNS_IN_CI' as const, ...extra });
  assert.deepEqual(validateRigs({ groups: 17, suiteShards: 2, rigs: [r('a', { group: 1 })].concat(Array.from({ length: 16 }, (_, i) => r(`g${i}`, { group: i + 2 }))) }, ['a', ...Array.from({ length: 16 }, (_, i) => `g${i}`)]), [], '20 concurrent jobs fit (the `suite` verdict runs after them, #623)');
  const many = (g: number, shards: number) => validateRigs({ groups: g, suiteShards: shards, rigs: Array.from({ length: g }, (_, i) => r(`r${i}`, { group: i + 1 })) }, Array.from({ length: g }, (_, i) => `r${i}`));
  assert.ok(many(17, 3).some((p) => /21 jobs/.test(p)), 'typecheck + 3 shards + 17 groups = 21');
  assert.ok(many(18, 2).some((p) => /21 jobs/.test(p)));
  assert.ok(many(3, 0).some((p) => /suiteShards must be an integer >= 1/.test(p)));
  assert.ok(validateRigs({ groups: 2, suiteShards: 1.5, rigs: [r('a', { group: 1 }), r('b', { group: 2 })] }, ['a', 'b']).some((p) => /suiteShards must be/.test(p)));
  assert.ok(validateRigs({ groups: 3, suiteShards: 1, rigs: [r('a', { group: 1 }), r('b', { group: 1 })] }, ['a', 'b']).some((p) => /group\(s\) 3 hold no rig/.test(p)) === false, 'an unassigned group is filled by assignGroups when there are rigs to spare');
  assert.ok(validateRigs({ groups: 3, suiteShards: 1, rigs: [r('a', { group: 1 }), r('b', { group: 2 })] }, ['a', 'b']).some((p) => /group\(s\) 3 hold no rig/.test(p)), 'fewer rigs than groups: a job that runs no rig is red');
});

const shard = (i: number, n: number, run = 100, ok = true, extra: Partial<ShardResult> = {}): ShardResult => ({ name: `suite shard ${i}/${n}`, shard: i, shards: n, ok, counts: { run }, why: ok ? 'ok' : 'command exited 1', ...extra });

test('judgeShards: green only when EVERY shard reported, green, with tests; must-FAIL arms: missing / cancelled, red, 0 tests, duplicate, disagreeing count, out of range', () => {
  const g = judgeShards([shard(1, 2, 60), shard(2, 2, 40)], 2);
  assert.deepEqual({ ok: g.ok, tests: g.tests, problems: g.problems }, { ok: true, tests: 100, problems: [] });
  const miss = judgeShards([shard(1, 2)], 2);
  assert.equal(miss.ok, false); assert.match(miss.problems[0], /shard 2\/2: NO RESULT/);
  assert.equal(judgeShards([], 2).problems.length, 2, 'no result at all: both shards missing');
  const red = judgeShards([shard(1, 2), shard(2, 2, 100, false)], 2);
  assert.equal(red.ok, false); assert.match(red.problems.join(), /shard 2\/2: command exited 1/);
  const zero = judgeShards([shard(1, 2), shard(2, 2, 0)], 2);
  assert.equal(zero.ok, false); assert.match(zero.problems.join(), /ran 0 tests/);
  assert.equal(judgeShards([shard(1, 2), shard(2, 2), shard(2, 2)], 2).ok, false, 'a duplicate');
  const dis = judgeShards([shard(1, 3), shard(2, 3)], 2);
  assert.equal(dis.ok, false); assert.match(dis.problems.join(), /workflow matrix and the file disagree/);
  assert.equal(judgeShards([shard(1, 2), shard(2, 2), shard(3, 2)], 2).ok, false, 'a shard outside 1..N');
  assert.equal(judgeShards([shard(1, 1)], 2).ok, false);
  // the instrument can say green: one shard of one is a green suite
  assert.equal(judgeShards([shard(1, 1, 9)], 1).ok, true);
});

/** Run `rigs.mjs summary` (the `suite` job's command) on a synthetic result dir: every RUNS_IN_CI rig + typecheck + the given suite shard results green. */
function runSummary(shards: ShardResult[], needs: Record<string, { result: string }> = { typecheck: { result: 'success' }, tests: { result: 'success' }, rigs: { result: 'success' } }, dropRig?: string): { status: number | null; out: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci594-'));
  try {
    const file = readRigFile(root);
    const put = (name: string, o: object): void => fs.writeFileSync(path.join(dir, `${name.replace(/[^\w.-]+/g, '_')}.json`), JSON.stringify(o));
    const base = { attempts: 1, armRetries: 0, tolerated: [], wallSec: 1, why: 'ok' };
    put('typecheck', { ...base, name: 'typecheck', ok: true, counts: { run: 1, pass: 1, fail: 0, skipped: 0 } });
    for (const r of file.rigs.filter((x) => x.class === 'RUNS_IN_CI' && x.id !== dropRig)) put(`rig:${r.id}`, { ...base, name: `rig:${r.id}`, id: r.id, ok: true, counts: { run: 1, pass: 1, fail: 0, skipped: 0 } });
    for (const s of shards) put(s.name, { ...base, ...s, counts: { run: s.counts.run, pass: s.counts.run, fail: 0, skipped: 0 } });
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(root, 'scripts/ci/rigs.mjs'), 'summary', dir], { encoding: 'utf8', env: { ...process.env, CI_SKIP_POST_MERGE: '0', CI_ONLY_POST_MERGE: '0', CI_PATH_SELECTION: '0', CI_FULL_REASON: '', NEEDS_JSON: JSON.stringify(needs), GITHUB_STEP_SUMMARY: '' } }); // the PR CI's own env must not leak into this synthetic run
    return { status: r.status, out: r.stdout + r.stderr };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('#594 the `suite` job command (rigs.mjs summary) through the real script: green when every shard is, RED on a missing / cancelled / red / empty shard, a cancelled need, a missing rig', () => {
  const n = suiteShardsOf(readRigFile(root));
  const all = Array.from({ length: n }, (_, i) => shard(i + 1, n, 50));
  const ok = runSummary(all);
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.out, new RegExp(`suite: ${50 * n} tests over ${n} shard\\(s\\), every shard present and green`));
  // each arm below must go red THROUGH the same instrument that just said green
  const missing = runSummary(all.slice(1));
  assert.equal(missing.status, 1); assert.match(missing.out, /suite shard 1\/\d+: NO RESULT/);
  const empty = runSummary(all.map((s, i) => (i === 0 ? shard(1, n, 0) : s)));
  assert.equal(empty.status, 1); assert.match(empty.out, /ran 0 tests/);
  const red = runSummary(all.map((s, i) => (i === 0 ? shard(1, n, 50, false) : s)));
  assert.equal(red.status, 1); assert.match(red.out, /suite RED/);
  const cancelled = runSummary(all, { typecheck: { result: 'success' }, tests: { result: 'cancelled' }, rigs: { result: 'success' } });
  assert.equal(cancelled.status, 1); assert.match(cancelled.out, /needs\.tests\.result = cancelled/);
  const wrongCount = runSummary(all.map((s) => shard(s.shard as number, n + 1, 50)));
  assert.equal(wrongCount.status, 1); assert.match(wrongCount.out, /disagree/);
  const noRig = runSummary(all, undefined, 'test:wiring');
  assert.equal(noRig.status, 1); assert.match(noRig.out, /rig:test:wiring.*NO RESULT/);
});

/** Run `run-job.mjs suite <tap>` as the `tests` job's verdict step does. */
function runShardVerdict(tap: string | null, env: Record<string, string>): { status: number | null; result: { ok: boolean; why: string; shard?: number; shards?: number; counts: { run: number } } | null } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci594v-'));
  try {
    const log = path.join(dir, 'suite.tap');
    if (tap !== null) fs.writeFileSync(log, tap);
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(root, 'scripts/ci/run-job.mjs'), 'suite', log], { encoding: 'utf8', env: { ...process.env, SUITE_SHARD: undefined, SUITE_SHARDS: undefined, CI_RESULT_DIR: dir, GITHUB_STEP_SUMMARY: '', SUITE_OUTCOME: 'success', ...env } as NodeJS.ProcessEnv });
    const f = fs.readdirSync(dir).find((x) => x.endsWith('.json'));
    return { status: r.status, result: f ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : null };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('#594 a suite shard verdict (run-job.mjs suite with SUITE_SHARD/SUITE_SHARDS): carries shard/shards, red on 0 tests / no TAP summary / a shard count that is not the file\'s', () => {
  const n = suiteShardsOf(readRigFile(root));
  const tap = (run: number): string => `# tests ${run}\n# suites 1\n# pass ${run}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
  const ok = runShardVerdict(tap(7), { SUITE_SHARD: '1', SUITE_SHARDS: String(n) });
  assert.equal(ok.status, 0); assert.deepEqual({ shard: ok.result?.shard, shards: ok.result?.shards, ok: ok.result?.ok, run: ok.result?.counts.run }, { shard: 1, shards: n, ok: true, run: 7 });
  const zero = runShardVerdict(tap(0), { SUITE_SHARD: '1', SUITE_SHARDS: String(n) });
  assert.equal(zero.status, 1); assert.match(zero.result?.why ?? '', /0 tests/);
  const trunc = runShardVerdict('ok 1 - a\nok 2 - b\n', { SUITE_SHARD: '1', SUITE_SHARDS: String(n) });
  assert.equal(trunc.status, 1); assert.match(trunc.result?.why ?? '', /no TAP summary/);
  const none = runShardVerdict(null, { SUITE_SHARD: '1', SUITE_SHARDS: String(n) });
  assert.equal(none.status, 1);
  const mismatch = runShardVerdict(tap(7), { SUITE_SHARD: '1', SUITE_SHARDS: String(n + 1) });
  assert.equal(mismatch.status, 1); assert.match(mismatch.result?.why ?? '', /suiteShards/);
  const badOutcome = runShardVerdict(tap(7), { SUITE_SHARD: '1', SUITE_SHARDS: String(n), SUITE_OUTCOME: 'failure' });
  assert.equal(badOutcome.status, 1);
  // an invalid shard is refused before anything is judged
  assert.equal(runShardVerdict(tap(7), { SUITE_SHARD: '3', SUITE_SHARDS: '2' }).status, 2);
  // unsharded (local) use is unchanged: the whole-suite verdict, no shard fields (the `tests` jobs export SUITE_SHARD*, so the helper strips them from the parent env)
  const whole = runShardVerdict(tap(7), {});
  assert.equal(whole.status, 0); assert.equal(whole.result?.shard, undefined);
});

test('rig job slugs (artifact names) are unique', () => {
  const slugs = readRigFile(root).rigs.filter((r) => r.class === 'RUNS_IN_CI').map((r) => r.id.replace(/[^\w.-]+/g, '_'));
  assert.equal(new Set(slugs).size, slugs.length);
});

test('ci-skips.json: every entry has a name + reason, and matches the way node --test prints a skipped test (escaped #)', () => {
  const { skips } = JSON.parse(fs.readFileSync(path.join(root, '.github', 'ci-skips.json'), 'utf8')) as { skips: { name: string; reason: string }[] };
  for (const s of skips) assert.ok(s.name.trim() && s.reason.trim(), JSON.stringify(s));
  const printed = '    ok 2296 - \\#149 the watch survives a WAL inode recycle (unlink + recreate at a new inode) # SKIP recycle arm requires btrfs\nok 6749 - \\#93: appendInboxBlock reads exactly N blocks under concurrent large appends # SKIP scratch fs is ext4\n';
  const got = tapSkips(printed).map((x) => x.name);
  assert.equal(got.length, 2);
  for (const n of got) assert.ok(skips.some((s) => s.name === n), `allow-list does not match the printed name ${n}`);
  // must-FAIL: an unlisted skip is not allowed
  assert.ok(!skips.some((s) => s.name === 'some new skipped test'));
});

test('ci-skips.json knownFail: names match what node --test prints for a failed test, and tapFails reads them (must-FAIL: an unlisted failure is not tolerated)', () => {
  const { knownFail } = JSON.parse(fs.readFileSync(path.join(root, '.github', 'ci-skips.json'), 'utf8')) as { knownFail: { name: string; reason: string }[] };
  assert.equal(knownFail.length, 5);
  for (const k of knownFail) assert.ok(k.reason.trim());
  const log = knownFail.map((k, i) => `not ok ${2691 + i} - ${k.name}\n  ---\n  type: 'test'\n`).join('') + 'not ok 9 - some other test\n';
  const got = tapFails(log);
  assert.equal(got.length, 6);
  assert.ok(knownFail.every((k) => got.includes(k.name)));
  assert.ok(!knownFail.some((k) => k.name === 'some other test'));
});

test('groups: every RUNS_IN_CI rig is in exactly one non-empty group, balanced by measured wall; an out-of-range group is refused', () => {
  const file = readRigFile(root);
  const groups = assignGroups(file);
  const ci = file.rigs.filter((r) => r.class === 'RUNS_IN_CI').map((r) => r.id).sort();
  assert.deepEqual(groups.flat().sort(), ci, 'each rig exactly once');
  assert.ok(groups.every((g) => g.length > 0), 'no empty group (a job that runs no rig is red)');
  const w = (id: string): number => file.rigs.find((r) => r.id === id)?.wallSec ?? 300;
  const loads = groups.map((g) => g.reduce((n, id) => n + w(id), 0));
  assert.ok(Math.max(...loads) <= Math.min(...loads) * 1.35, `unbalanced groups: ${loads.join(', ')}`);
  // new rig without a group: placed on the lightest group; must-FAIL: a group outside 1..N is a validation problem
  const mk = (id: string, extra: object = {}) => ({ id, command: 'x', class: 'RUNS_IN_CI' as const, ...extra });
  const g2 = assignGroups({ groups: 2, rigs: [mk('a', { wallSec: 100 }), mk('b', { wallSec: 90 }), mk('c', { wallSec: 20 })] });
  assert.deepEqual(g2.map((g) => g.length), [1, 2]);
  assert.ok(validateRigs({ groups: 2, rigs: [mk('a', { group: 3 })] }, ['a']).some((p) => /group 3 is outside 1\.\.2/.test(p)));
});

test('each-arm judge (reviewer BLOCKING): exit 0 + "ok":false is RED; VOID is RED; a last ok:true line is green; an expected abort is the only exit-1 pass', () => {
  assert.equal(judgeArm(0, '{"arm":"a","ok":true}\n').ok, true);
  const red = judgeArm(0, 'noise\n{"arm":"a","x":1,"ok":false}\n'); // the shape of e2e-r2-repro / delete-resurrect / spawn-failure: process.exit(0) after printing ok:false
  assert.equal(red.ok, false); assert.match(red.why, /ok":false/);
  assert.equal(judgeArm(0, '{"arm":"a","ok":false}\n{"arm":"a","ok":true}\n').ok, true, 'the LAST verdict line decides');
  assert.equal(judgeArm(0, 'x: VOID — no `claude` CLI on PATH\n').ok, false);
  assert.equal(judgeArm(1, '{"ok":true}\n').ok, false);
  assert.equal(judgeArm(null, '').ok, false);
  assert.equal(judgeArm(1, '{"arm":"hang_selftest","ok":false,"abort":"deadline: the arm hung"}', 'deadline: the arm hung').ok, true);
  assert.equal(judgeArm(0, 'deadline: the arm hung', 'deadline: the arm hung').ok, false, 'an expected abort that exits 0 did not abort');
});

test('a `# todo` test is red (it is neither a pass nor a listed skip)', () => {
  const c = parseTapSummary('# tests 3\n# pass 2\n# fail 0\n# skipped 0\n# todo 1\n');
  assert.equal(c?.todo, 1);
  assert.equal(judge(0, c!).ok, false);
  assert.equal(judge(0, { ...c!, todo: 0 }).ok, true);
});

test('post-merge rigs: every *-mutants / *-mutants-* rig and the role-guard matrices, nothing else (must-FAIL arms on the negatives)', () => {
  for (const id of ['test:fanout-run-mutants', 'test:fanout-run-mutants-2', 'canary:pause-bars-mutants', 'scripts/e2e-browser-tabs-mutants.mjs', 'scripts/e2e-browser-design-proxy-mutants.sh', 'test:role-guard-matrix', 'test:role-guard-matrix-vf2']) assert.equal(isPostMergeRig(id), true, id);
  for (const id of ['test:role-guard-cli', 'test:fanout-run', 'test:mutantsish', 'scripts/e2e-browser-tabs.mjs', 'test:disk-guard']) assert.equal(isPostMergeRig(id), false, id);
  // the repo's own list: the policy selects a real, non-empty subset of the RUNS_IN_CI rigs
  const ci = readRigFile(root).rigs.filter((r) => r.class === 'RUNS_IN_CI').map((r) => r.id);
  const pm = ci.filter(isPostMergeRig);
  assert.ok(pm.length >= 40 && pm.length < ci.length, `${pm.length} post-merge rigs of ${ci.length}`);
});

function runScript(args: string[], env: Record<string, string>) {
  const out = path.join(os.tmpdir(), `pm-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(out, { recursive: true });
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GITHUB_OUTPUT: path.join(out, 'o'), ...env } });
  return { ...r, output: fs.existsSync(path.join(out, 'o')) ? fs.readFileSync(path.join(out, 'o'), 'utf8') : '' };
}

test('run-group --plan: a PR group keeps its non-mutant rigs, ci-mutants only the post-merge ones, a dispatch every rig', () => {
  const file = readRigFile(root);
  const groups = assignGroups(file);
  const mixed = groups.findIndex((g) => g.some(isPostMergeRig) && g.some((id) => !isPostMergeRig(id)));
  assert.ok(mixed >= 0);
  const plan = (g: number, env: Record<string, string>) => runScript(['scripts/ci/run-group.mjs', String(g + 1), '--plan'], env);
  const pr = { CI_PATH_SELECTION: '1', CI_SKIP_POST_MERGE: '1', CI_FULL_REASON: 'the ci-full label forces every rig' };
  // ci-full on a PR still skips them (the brief: on pull_request, skip); the mixed group keeps its non-mutant rigs
  const m = plan(mixed, pr);
  const nonPm = groups[mixed].filter((id) => !isPostMergeRig(id)).length;
  assert.match(m.stdout, new RegExp(`${nonPm} rig\\(s\\) selected`));
  // ci-mutants: only the post-merge ones
  const mu = plan(mixed, { CI_ONLY_POST_MERGE: '1' });
  assert.match(mu.stdout, new RegExp(`${groups[mixed].filter(isPostMergeRig).length} rig\\(s\\) selected`));
  // dispatch: every rig of the group
  const d = plan(mixed, {});
  assert.match(d.stdout, new RegExp(`${groups[mixed].length} rig\\(s\\) selected`));
});

test('summary: a PR lists the post-merge rigs as skipped (not green, not red) and a missing non-mutant rig is still red; ci-mutants needs only the mutant rigs', () => {
  const file = readRigFile(root);
  const ci = file.rigs.filter((r) => r.class === 'RUNS_IN_CI').map((r) => r.id);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-sum-'));
  const res = (name: string, extra: object = {}) => ({ name, ok: true, why: 'ok', counts: { run: 1, pass: 1, fail: 0, skipped: 0 }, wallSec: 1, attempts: 1, armRetries: 0, ...extra });
  const put = (r: { name: string }, f: string) => fs.writeFileSync(path.join(dir, `${f}.json`), JSON.stringify(r));
  put(res('typecheck'), 'tc');
  for (let i = 1; i <= suiteShardsOf(file); i++) put(res(`suite shard ${i}/${suiteShardsOf(file)}`, { shard: i, shards: suiteShardsOf(file), counts: { run: 5, pass: 5, fail: 0, skipped: 0 } }), `s${i}`);
  for (const id of ci.filter((x) => !isPostMergeRig(x))) put(res(`rig:${id}`, { id }), `r_${id.replace(/\W/g, '_')}`);
  const pr = { CI_PATH_SELECTION: '0', CI_SKIP_POST_MERGE: '1', CI_FULL_REASON: 'x', NEEDS_JSON: '{}' };
  const ok = runScript(['scripts/ci/rigs.mjs', 'summary', dir], pr);
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /\| ⏭ \| rig:test:fanout-run-mutants \|.*skipped \(post-merge\)/);
  assert.match(ok.stdout, /post-merge rigs skipped/);
  // must-FAIL: a non-mutant rig with no result is still red (no silent green for the rigs that do run)
  const victim = ci.find((x) => !isPostMergeRig(x)) as string;
  fs.rmSync(path.join(dir, `r_${victim.replace(/\W/g, '_')}.json`));
  assert.equal(runScript(['scripts/ci/rigs.mjs', 'summary', dir], pr).status, 1);
  // ci-mutants.yml mode: nothing but the post-merge rigs expected; none reported ⇒ red, all reported ⇒ green
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-sum2-'));
  const mu = { CI_ONLY_POST_MERGE: '1', NEEDS_JSON: '{}' };
  assert.equal(runScript(['scripts/ci/rigs.mjs', 'summary', dir2], mu).status, 1);
  for (const id of ci.filter(isPostMergeRig)) fs.writeFileSync(path.join(dir2, `${id.replace(/\W/g, '_')}.json`), JSON.stringify(res(`rig:${id}`, { id })));
  assert.equal(runScript(['scripts/ci/rigs.mjs', 'summary', dir2], mu).status, 0);
});

test('ci-mutants.yml: master push + nightly, only post-merge rigs, the same 17 groups as ci.yml, an issue per commit labelled ci-mutants; ci.yml skips them on a PR only', () => {
  const wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci-mutants.yml'), 'utf8');
  const pr = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(wf, /^on:\n  push:\n    branches: \[master\]\n  schedule:\n    - cron:/m);
  assert.ok(!/^\s*pull_request:/m.test(wf), 'a PR must not run the post-merge workflow');
  assert.match(wf, /CI_ONLY_POST_MERGE: '1'/);
  assert.match(wf, /issues: write/);
  assert.match(wf, /gh issue create --title "\$title" --label ci-mutants/);
  assert.match(wf, /gh issue list --label ci-mutants/);
  const iota = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);
  assert.deepEqual((/group: \[([\d, ]+)\]/.exec(wf)?.[1] ?? '').split(',').map((x) => Number(x.trim())), iota(groupsOf(readRigFile(root))), 'ci-mutants.yml group list != groups of .github/ci-rigs.json');
  assert.match(pr, /CI_SKIP_POST_MERGE: \$\{\{ github\.event_name == 'pull_request' && '1' \|\| '0' \}\}/);
  assert.ok(!/CI_ONLY_POST_MERGE/.test(pr));
});
