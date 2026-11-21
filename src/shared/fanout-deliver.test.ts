import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMergeFailure,
  combinedSuiteCommand,
  detectPackageManager,
  suiteCommandFor,
  decideDelivery,
  isUserStep,
  normaliseRollupItem,
  parseActionsJobUrl,
  parseReviewVerdict,
  type DecideInput,
  type DeliverCheck,
} from './fanout-deliver.ts';

const H = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const ok = (name = 'ci', steps: number | null = 5): DeliverCheck => ({ name, state: 'success', steps });
const input = (o: Partial<DecideInput> = {}): DecideInput => ({
  pr: { state: 'OPEN', baseRefName: 'bench/x', headRefOid: H, mergeable: 'MERGEABLE' },
  checks: [ok()],
  into: 'bench/x',
  verifiedHead: H,
  waitedMs: 0,
  noChecksGraceMs: 120_000,
  stable: true,
  ...o,
});
const verdict = (o: Record<string, unknown> = {}) => ({ round: 1, blocking: 0, major: 0, minor: 2, head: H, ...o });

test('green at the verified head merges, bound to that head', () => {
  assert.deepEqual(decideDelivery(input()), { action: 'merge', head: H });
});

test('MUST-FAIL: a green run with 0 steps is not green', () => {
  const d = decideDelivery(input({ checks: [ok('ci', 0)] }));
  assert.equal(d.action, 'refuse');
  assert.equal((d as { reason: string }).reason, 'zero-steps');
});

test('MUST-FAIL: ONE zero-step green among healthy greens still refuses', () => {
  const d = decideDelivery(input({ checks: [ok('build', 9), ok('test', 0)] }));
  assert.equal((d as { reason: string }).reason, 'zero-steps');
  assert.match((d as { detail: string }).detail, /test/);
});

test('MUST-FAIL: 0 checks waits inside the grace, refuses after it', () => {
  assert.equal(decideDelivery(input({ checks: [], waitedMs: 1000 })).action, 'wait');
  const d = decideDelivery(input({ checks: [], waitedMs: 120_000 }));
  assert.equal(d.action, 'refuse');
  assert.equal((d as { reason: string }).reason, 'no-checks');
});

test('MUST-FAIL: only skipped/neutral checks is not green', () => {
  const d = decideDelivery(input({ checks: [{ name: 'a', state: 'neutral', steps: null }] }));
  assert.equal((d as { reason: string }).reason, 'zero-steps');
});

test('MUST-FAIL: a moved head refuses (PR head != verified head)', () => {
  const d = decideDelivery(input({ pr: { state: 'OPEN', baseRefName: 'bench/x', headRefOid: H2, mergeable: 'MERGEABLE' } }));
  assert.equal((d as { reason: string }).reason, 'head-moved');
});

test('MUST-FAIL: MAJOR or BLOCKING in the verdict refuses, even when CI is green', () => {
  for (const v of [verdict({ major: 1 }), verdict({ blocking: 1 })]) {
    const p = parseReviewVerdict(JSON.stringify(v));
    assert.ok(p.ok);
    const d = decideDelivery(input({ verdict: p.ok ? p.verdict : undefined }));
    assert.equal((d as { reason: string }).reason, 'review-blocking');
  }
});

test('MINOR > 0 does not refuse; a verdict reviewing another head does', () => {
  const p = parseReviewVerdict(JSON.stringify(verdict({ minor: 9 })));
  assert.equal(decideDelivery(input({ verdict: p.ok ? p.verdict : undefined })).action, 'merge');
  const q = parseReviewVerdict(JSON.stringify(verdict({ head: H2 })));
  assert.equal((decideDelivery(input({ verdict: q.ok ? q.verdict : undefined })) as { reason: string }).reason, 'verdict-head-mismatch');
});

test('MUST-FAIL: an unstable check set (first sighting) waits, never merges', () => {
  assert.equal(decideDelivery(input({ stable: false })).action, 'wait');
});

test('MUST-FAIL: a --require-check not yet registered waits, then refuses after the grace', () => {
  assert.equal(decideDelivery(input({ requiredChecks: ['ci/real'], waitedMs: 1000 })).action, 'wait');
  assert.equal((decideDelivery(input({ requiredChecks: ['ci/real'], waitedMs: 200_000 })) as { reason: string }).reason, 'no-checks');
  assert.equal(decideDelivery(input({ requiredChecks: ['ci'] })).action, 'merge');
});

test('isUserStep: runner bookkeeping steps are not work', () => {
  assert.equal(isUserStep('Set up job'), false);
  assert.equal(isUserStep('Complete job'), false);
  assert.equal(isUserStep('Post Run actions/checkout@v4'), false);
  assert.equal(isUserStep('Run tests'), true);
});

test('MUST-FAIL: a REQUIRED check that was skipped/neutral refuses even beside a green check', () => {
  const d = decideDelivery(input({ checks: [{ name: 'test', state: 'neutral', steps: null }, ok('lint', 3)], requiredChecks: ['test'] }));
  assert.equal((d as { reason: string }).reason, 'zero-steps');
  assert.match((d as { detail: string }).detail, /test/);
});

test('MUST-FAIL: external status alone (steps null) is not green without --require-check; with it, it is', () => {
  const checks: DeliverCheck[] = [{ name: 'ci', state: 'neutral', steps: null }, { name: 'codecov', state: 'success', steps: null }];
  assert.equal((decideDelivery(input({ checks })) as { reason: string }).reason, 'zero-steps');
  assert.equal(decideDelivery(input({ checks: [{ name: 'circleci', state: 'success', steps: null }], requiredChecks: ['circleci'] })).action, 'merge');
});

test('MUST-FAIL: already merged + MAJOR in the verdict is refused, not exit-0 green', () => {
  const pr = { state: 'MERGED' as const, baseRefName: 'bench/x', headRefOid: H, mergeable: 'UNKNOWN' };
  const d = decideDelivery(input({ pr, verdict: { round: 1, blocking: 0, major: 1, minor: 0, head: H } }));
  assert.equal((d as { reason: string }).reason, 'review-blocking');
});

test('red CI refuses, pending waits, wrong base / closed / conflict refuse', () => {
  assert.equal((decideDelivery(input({ checks: [ok(), { name: 'lint', state: 'failure', steps: null }] })) as { reason: string }).reason, 'ci-red');
  assert.equal(decideDelivery(input({ checks: [ok(), { name: 'slow', state: 'pending', steps: null }] })).action, 'wait');
  assert.equal((decideDelivery(input({ into: 'other' })) as { reason: string }).reason, 'wrong-base');
  assert.equal((decideDelivery(input({ pr: { state: 'CLOSED', baseRefName: 'bench/x', headRefOid: H, mergeable: 'UNKNOWN' } })) as { reason: string }).reason, 'pr-closed');
  assert.equal((decideDelivery(input({ pr: { state: 'OPEN', baseRefName: 'bench/x', headRefOid: H, mergeable: 'CONFLICTING' } })) as { reason: string }).reason, 'merge-conflict');
});

test('already merged: only AT the verified head', () => {
  const merged = (h: string) => ({ state: 'MERGED' as const, baseRefName: 'bench/x', headRefOid: h, mergeable: 'UNKNOWN' });
  assert.equal(decideDelivery(input({ pr: merged(H) })).action, 'already-merged');
  assert.equal((decideDelivery(input({ pr: merged(H2) })) as { reason: string }).reason, 'head-moved');
});

test('verdict parse is strict (a missing field is an error, never 0)', () => {
  assert.equal(parseReviewVerdict('not json').ok, false);
  assert.equal(parseReviewVerdict(JSON.stringify({ round: 1, blocking: 0, minor: 0, head: H })).ok, false); // no "major"
  assert.equal(parseReviewVerdict(JSON.stringify(verdict({ major: '0' }))).ok, false);
  assert.equal(parseReviewVerdict(JSON.stringify(verdict({ head: 'abc' }))).ok, false);
  assert.equal(parseReviewVerdict('[]').ok, false);
  assert.equal(parseReviewVerdict(JSON.stringify(verdict())).ok, true);
});

test('rollup normalisation: CheckRun / StatusContext', () => {
  const steps = () => 7;
  assert.deepEqual(normaliseRollupItem({ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'u' }, steps), { name: 'ci', state: 'success', steps: 7 });
  assert.equal(normaliseRollupItem({ __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS' }, steps).state, 'pending');
  assert.equal(normaliseRollupItem({ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SKIPPED' }, steps).state, 'neutral');
  assert.equal(normaliseRollupItem({ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'CANCELLED' }, steps).state, 'failure');
  assert.equal(normaliseRollupItem({ __typename: 'StatusContext', context: 'x', state: 'SUCCESS' }, steps).state, 'success');
  assert.equal(normaliseRollupItem({ __typename: 'StatusContext', context: 'x', state: 'ERROR' }, steps).state, 'failure');
});

test('actions url parse, merge-failure classification, suite command', () => {
  assert.deepEqual(parseActionsJobUrl('https://github.com/o/r/actions/runs/12/job/34'), { run: '12', job: '34' });
  assert.equal(parseActionsJobUrl('https://ci.example/build/1'), null);
  assert.equal(classifyMergeFailure('X Pull request is not mergeable: the head branch was modified. Review and try the merge again.'), 'head-moved');
  assert.equal(classifyMergeFailure('unknown flag: --match-head-commit'), 'other');
  assert.equal(classifyMergeFailure('GraphQL: Required status check is expected'), 'other');
  assert.equal(combinedSuiteCommand('bench/x'), 'git fetch origin bench/x && git checkout --detach origin/bench/x && git rev-list --count HEAD..origin/bench/x && npm test');
  assert.equal(combinedSuiteCommand('m', 'pnpm run test'), 'git fetch origin m && git checkout --detach origin/m && git rev-list --count HEAD..origin/m && pnpm run test');
  assert.throws(() => combinedSuiteCommand('x; rm -rf /'));
});

test('#487 detectPackageManager: packageManager field wins over the lockfile; lockfiles map to their manager; nothing → null', () => {
  assert.deepEqual(detectPackageManager(null, ['package.json', 'pnpm-lock.yaml']), { pm: 'pnpm', source: 'lockfile' });
  assert.deepEqual(detectPackageManager(null, ['yarn.lock']), { pm: 'yarn', source: 'lockfile' });
  assert.deepEqual(detectPackageManager(null, ['package-lock.json']), { pm: 'npm', source: 'lockfile' });
  assert.deepEqual(detectPackageManager(null, ['bun.lockb']), { pm: 'bun', source: 'lockfile' });
  assert.deepEqual(detectPackageManager('{"packageManager":"yarn@4.1.0"}', ['pnpm-lock.yaml']), { pm: 'yarn', source: 'packageManager' });
  assert.deepEqual(detectPackageManager('{"packageManager":"pnpm@9.1.0+sha512.abc"}', []), { pm: 'pnpm', source: 'packageManager' });
  assert.deepEqual(detectPackageManager('{"packageManager":"cargo@1"}', ['package-lock.json']), { pm: 'npm', source: 'lockfile' });
  assert.deepEqual(detectPackageManager('not json', ['yarn.lock']), { pm: 'yarn', source: 'lockfile' });
  assert.equal(detectPackageManager('{"name":"x"}', ['package.json', 'README.md']), null);
  assert.deepEqual(['pnpm', 'yarn', 'npm', 'bun', null].map((m) => suiteCommandFor(m as never)), ['pnpm run test', 'yarn test', 'npm test', 'bun run test', 'npm test']);
});

// ---- #495 decideGate / workflowRunsOnPr ---------------------------------------------------------------------------------------------
import { decideGate, workflowRunsOnPr, type DeliverCheck } from './fanout-deliver.ts';

const PR_WF = 'name: ci\non:\n  pull_request:\n    branches: [main]\njobs:\n  t:\n    runs-on: ubuntu-latest\n';
const PUSH_WF = 'name: release\non:\n  push:\n    tags: [v*]\n  workflow_dispatch:\njobs: {}\n';
const GH: DeliverCheck = { name: 'ci', state: 'success', steps: 5 };
const HEAD = 'a'.repeat(40);
const OLD = 'c'.repeat(40);

test('workflowRunsOnPr: map, list and scalar forms are PR CI; push/dispatch-only and a commented trigger are not', () => {
  assert.equal(workflowRunsOnPr(PR_WF), true);
  assert.equal(workflowRunsOnPr('on: [push, pull_request]\n'), true);
  assert.equal(workflowRunsOnPr('on: pull_request\n'), true);
  assert.equal(workflowRunsOnPr('on:\n  pull_request_target:\n'), true);
  assert.equal(workflowRunsOnPr(PUSH_WF), false);
  assert.equal(workflowRunsOnPr('on:\n  push:\n  # pull_request:\njobs:\n  a:\n    if: github.event_name == \'pull_request\'\n'), false);
});

test('decideGate must-PASS: PR CI + green on the verified head ⇒ the full suite is the CI\'s, the checklist waits on it', () => {
  const g = decideGate({ workflows: [PR_WF], pr: { headRefOid: HEAD }, head: HEAD, checks: [GH] });
  assert.equal(g.repoCi, 'pr-workflows');
  assert.equal(g.fullSuite, 'ci');
  assert.equal(g.ciGreenOnHead, true);
  assert.ok(g.checklist.skip.some((s) => /full test suite/.test(s)));
  assert.equal(g.checklist.run.length, 0);
  assert.ok(g.checklist.keep.some((k) => /mutants/.test(k)) && g.checklist.keep.some((k) => /entry-point/.test(k)));
});

test('decideGate must-FAIL: no PR CI ⇒ the full suite STAYS on the verifier', () => {
  const g = decideGate({ workflows: [PUSH_WF], pr: { headRefOid: HEAD }, head: HEAD, checks: [] });
  assert.equal(g.repoCi, 'none');
  assert.equal(g.fullSuite, 'verifier');
  assert.equal(g.ciGreenOnHead, false);
  assert.ok(g.checklist.run.some((s) => /full test suite/.test(s)));
  assert.equal(g.checklist.skip.length, 0);
  // no workflows dir at all
  assert.equal(decideGate({ workflows: [], pr: null, head: HEAD, checks: [] }).fullSuite, 'verifier');
});

test('decideGate must-FAIL: the PR head moved ⇒ the CI-green of the OLD head is not accepted', () => {
  const g = decideGate({ workflows: [PR_WF], pr: { headRefOid: OLD }, head: HEAD, checks: [GH] });
  assert.equal(g.ci, 'green');
  assert.equal(g.headMatches, false);
  assert.equal(g.ciGreenOnHead, false);
  assert.match(g.detail, /another head is not accepted/);
});

test('decideGate: pending / red / zero-step / no-PR CI is never green-on-head; unreadable workflows fail closed to the verifier', () => {
  const at = (checks: DeliverCheck[], pr: { headRefOid: string } | null = { headRefOid: HEAD }) => decideGate({ workflows: [PR_WF], pr, head: HEAD, checks });
  assert.equal(at([{ ...GH, state: 'pending', steps: null }]).ciGreenOnHead, false);
  assert.equal(at([{ ...GH, state: 'failure', steps: null }]).ci, 'red');
  assert.equal(at([{ ...GH, steps: 0 }]).ci, 'zero-steps');
  assert.equal(at([]).ciGreenOnHead, false);
  assert.equal(at([GH], null).ci, 'no-pr');
  assert.equal(at([GH], null).ciGreenOnHead, false);
  const unknown = decideGate({ workflows: null, pr: { headRefOid: HEAD }, head: HEAD, checks: [] });
  assert.equal(unknown.fullSuite, 'verifier');
  assert.equal(unknown.repoCi, 'unknown');
  // workflows unreadable BUT a check ran on the PR head ⇒ CI exists
  assert.equal(decideGate({ workflows: null, pr: { headRefOid: HEAD }, head: HEAD, checks: [GH] }).fullSuite, 'ci');
});
