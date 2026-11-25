// #568 — the PR CI's rig list can never silently lose a rig: every package.json test:*/canary:* script and every standalone scripts/e2e-*.{mjs,sh}
// is in .github/ci-rigs.json as RUNS_IN_CI or LOCAL_ONLY + reason. Each guard has a must-FAIL arm; the log parsers + the "no silent green" judge are pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignGroups, judgeArm, tapFails, judge, parseRigCounts, parseTapSummary, readRigFile, requiredRigIds, tapSkips, validateRigs, type RigFile } from './ci-rigs.ts';

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
  assert.match(wf, /cancel-in-progress: true/);
  assert.match(wf, /scripts\/ci\/rigs\.mjs matrix/);
  assert.match(wf, /run-group\.mjs/);
  assert.match(wf, /fail-fast: false/);
});

test('ci.yml: the suite step is continue-on-error with a verdict step behind it; the gate therefore needs `--require-check suite` (a derived suite check is refused)', async () => {
  const { suiteJobsOf, workflowRunsOnPr } = await import('./fanout-deliver.ts');
  const wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.equal(workflowRunsOnPr(wf, 'master'), true);
  assert.deepEqual(suiteJobsOf(wf), [], 'a continue-on-error suite step is not derivable — if this ever derives, drop the --require-check advice');
  assert.match(wf, /id: suite\n\s+continue-on-error: true\n\s+run: pnpm run test > /);
  assert.match(wf, /if: always\(\)\n\s+run: node [^\n]*run-job\.mjs suite /);
  assert.match(wf, /SUITE_OUTCOME: \$\{\{ steps\.suite\.outcome \}\}/);
  // the suite check a pin names is the job's name
  assert.match(wf, /^  suite:\n/m);
  // without continue-on-error the plain step IS derived (the property the pin replaces)
  assert.deepEqual(suiteJobsOf(wf.replace('        continue-on-error: true\n', '')), ['suite']);
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
