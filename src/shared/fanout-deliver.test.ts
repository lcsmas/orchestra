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
