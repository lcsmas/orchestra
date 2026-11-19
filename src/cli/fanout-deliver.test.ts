import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliver, parseDeliverArgs, runFanout, type DeliverDeps, type DeliverOpts, type GhResult } from './fanout-deliver.ts';

const H = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const RUN_URL = 'https://github.com/o/r/actions/runs/900/job/901';

type Check = Record<string, unknown>;
const green = (url = RUN_URL): Check => ({ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: url });
const pending = (): Check => ({ __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS', conclusion: '', detailsUrl: RUN_URL });

interface FakeOpts {
  /** One snapshot per `pr view` call (the last repeats). */
  views: { state?: string; base?: string; head?: string; mergeable?: string; checks: Check[] }[];
  existing?: { number: number; url: string; state: string }[];
  steps?: number;
  /** The head GitHub holds at MERGE time (a push after the last view). Default: the last view's head. */
  headAtMerge?: string;
  runViewFails?: boolean;
  mergeStderr?: string;
}

/** A fake `gh`: records every argv, answers like gh does, and — like GitHub — refuses a merge whose --match-head-commit != the head it holds. */
function fakeGh(o: FakeOpts) {
  const calls: string[][] = [];
  let viewN = 0;
  let merged = false;
  const gh = async (args: string[]): Promise<GhResult> => {
    calls.push(args);
    const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: '' });
    const [a, b] = args;
    if (a === 'pr' && b === 'list') return ok(JSON.stringify(o.existing ?? []));
    if (a === 'pr' && b === 'create') return ok('https://github.com/o/r/pull/42\n');
    if (a === 'pr' && b === 'view') {
      if (args.includes('state,mergeCommit')) return ok(JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'c'.repeat(40) } }));
      const v = o.views[Math.min(viewN++, o.views.length - 1)];
      return ok(JSON.stringify({ state: v.state ?? 'OPEN', baseRefName: v.base ?? 'bench/x', headRefOid: v.head ?? H, mergeable: v.mergeable ?? 'MERGEABLE', statusCheckRollup: v.checks }));
    }
    if (a === 'run' && b === 'view') {
      if (o.runViewFails) return { code: 1, stdout: '', stderr: 'HTTP 500' };
      // Like a real job: runner bookkeeping steps always exist; `o.steps` = steps the WORKFLOW ran.
      const steps = [
        { name: 'Set up job', conclusion: 'success' },
        ...Array.from({ length: o.steps ?? 6 }, (_, k) => ({ name: `Run step ${k}`, conclusion: 'success' })),
        { name: 'Post Run actions/checkout', conclusion: 'success' },
        { name: 'Complete job', conclusion: 'success' },
      ];
      return ok(JSON.stringify({ jobs: [{ databaseId: 901, steps }] }));
    }
    if (a === 'pr' && b === 'merge') {
      const want = args[args.indexOf('--match-head-commit') + 1];
      const held = o.headAtMerge ?? o.views[o.views.length - 1].head ?? H;
      if (o.mergeStderr) return { code: 1, stdout: '', stderr: o.mergeStderr };
      if (want !== held) return { code: 1, stdout: '', stderr: 'Pull request is not mergeable: the head branch was modified. Review and try the merge again.' };
      merged = true;
      return ok('');
    }
    return { code: 1, stdout: '', stderr: `unexpected gh call: ${args.join(' ')}` };
  };
  return { gh, calls, merges: () => calls.filter((c) => c[0] === 'pr' && c[1] === 'merge'), wasMerged: () => merged };
}

const opts = (o: Partial<DeliverOpts> = {}): DeliverOpts => ({
  branch: 'impl-x', into: 'bench/x', ticket: 'T-1', verifiedHead: H, strategy: 'merge',
  timeoutMs: 600_000, intervalMs: 10_000, noChecksGraceMs: 30_000, requireChecks: [], ...o,
});
function deps(gh: DeliverDeps['gh'], files: Record<string, string> = {}) {
  let t = 0;
  const logs: string[] = [];
  const d: DeliverDeps = {
    gh,
    sleep: async (ms) => { t += ms; },
    now: () => t,
    readFile: (p) => { if (p in files) return files[p]; throw new Error(`ENOENT ${p}`); },
    log: (s) => logs.push(s),
  };
  return { d, logs };
}
const verdictFile = (o: Record<string, unknown> = {}) => JSON.stringify({ round: 1, blocking: 0, major: 0, minor: 1, head: H, ...o });

test('green: opens the PR, merges ONCE with --match-head-commit <verified head>, exit 0, prints the suite command', async () => {
  const f = fakeGh({ views: [{ checks: [green()] }] });
  const { d } = deps(f.gh, { v: verdictFile() });
  const r = await deliver(opts({ reviewVerdict: 'v', verifiedHead: undefined }), d);
  assert.equal(r.exit, 0);
  assert.equal(r.result.verdict, 'merged');
  assert.equal(r.result.pr, 42);
  assert.equal(r.result.reviewGated, true);
  assert.equal(r.result.mergeCommit, 'c'.repeat(40));
  assert.match(r.result.combinedSuite ?? '', /^git fetch origin bench\/x && git checkout --detach origin\/bench\/x/);
  assert.equal(f.merges().length, 1);
  assert.deepEqual(f.merges()[0], ['pr', 'merge', '42', '--merge', '--match-head-commit', H]);
  assert.ok(f.calls.some((c) => c[1] === 'create'), 'opened a PR when none existed');
});

test('reuses an existing open PR instead of opening a second one', async () => {
  const f = fakeGh({ views: [{ checks: [green()] }], existing: [{ number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' }] });
  const r = await deliver(opts(), deps(f.gh).d);
  assert.equal(r.result.pr, 7);
  assert.equal(f.calls.filter((c) => c[1] === 'create').length, 0);
});

test('waits through pending checks, then merges (and never merges while pending)', async () => {
  const f = fakeGh({ views: [{ checks: [pending()] }, { checks: [pending()] }, { checks: [green()] }] });
  const r = await deliver(opts(), deps(f.gh).d);
  assert.equal(r.exit, 0);
  assert.equal(f.calls.filter((c) => c[0] === 'pr' && c[1] === 'view' && !c.includes('state,mergeCommit')).length, 3);
});

test('MUST-FAIL: a green check with 0 steps is refused, exit 2, NO merge call', async () => {
  const f = fakeGh({ views: [{ checks: [green()] }], steps: 0 });
  const r = await deliver(opts(), deps(f.gh).d);
  assert.equal(r.exit, 2);
  assert.equal(r.result.reason, 'zero-steps');
  assert.equal(f.merges().length, 0);
});

test('MUST-FAIL: a job that ran only runner bookkeeping steps (workflow steps all skipped) is zero-steps, no merge', async () => {
  const f = fakeGh({ views: [{ checks: [green()] }], steps: 0 });
  const r = await deliver(opts(), deps(f.gh).d);
  assert.equal(r.result.reason, 'zero-steps');
  assert.equal(f.merges().length, 0);
});

test('MUST-FAIL: a fast status registered first, the real CI later → the first poll never merges; a late check set is awaited', async () => {
  const cla: Check = { __typename: 'StatusContext', context: 'cla', state: 'SUCCESS' };
  const f = fakeGh({ views: [{ checks: [cla] }, { checks: [cla, pending()] }, { checks: [cla, green()] }, { checks: [cla, green()] }] });
  const r = await deliver(opts(), deps(f.gh).d);
  assert.equal(r.exit, 0);
  assert.equal(f.calls.filter((c) => c[0] === 'pr' && c[1] === 'view' && !c.includes('state,mergeCommit')).length, 3); // [cla] → [cla,pending] → [cla,green] (same names as the previous poll)
  // and a single success check seen once is not enough: two identical polls are
  const g = fakeGh({ views: [{ checks: [green()] }] });
  await deliver(opts(), deps(g.gh).d);
  assert.equal(g.calls.filter((c) => c[0] === 'pr' && c[1] === 'view' && !c.includes('state,mergeCommit')).length, 2);
});

test('MUST-FAIL: --require-check that never registers is refused, no merge', async () => {
  const f = fakeGh({ views: [{ checks: [green()] }] });
  const r = await deliver(opts({ requireChecks: ['ci/real'], noChecksGraceMs: 25_000 }), deps(f.gh).d);
  assert.equal(r.exit, 2);
  assert.equal(r.result.reason, 'no-checks');
  assert.equal(f.merges().length, 0);
});

test('a stale MERGED PR from an earlier round does not shadow a new PR', async () => {
  const f = fakeGh({ views: [{ checks: [green()] }], existing: [{ number: 5, url: 'https://github.com/o/r/pull/5', state: 'MERGED', headRefOid: H2 } as never] });
  const r = await deliver(opts(), deps(f.gh).d);
  assert.equal(r.result.pr, 42);
  assert.equal(r.exit, 0);
});

test('MUST-FAIL: 0 checks beyond the grace is refused; inside the grace it keeps waiting', async () => {
  const f = fakeGh({ views: [{ checks: [] }] });
  const r = await deliver(opts({ noChecksGraceMs: 25_000 }), deps(f.gh).d);
  assert.equal(r.exit, 2);
  assert.equal(r.result.reason, 'no-checks');
  assert.ok(f.calls.filter((c) => c[0] === 'pr' && c[1] === 'view').length >= 3, 'it waited the grace out first');
  assert.equal(f.merges().length, 0);
});

test('MUST-FAIL: the head moved before the check → refused, no merge', async () => {
  const f = fakeGh({ views: [{ head: H2, checks: [green()] }] });
  const r = await deliver(opts(), deps(f.gh).d);
  assert.equal(r.exit, 2);
  assert.equal(r.result.reason, 'head-moved');
  assert.equal(f.merges().length, 0);
});

test('MUST-FAIL: the head moves BETWEEN the check and the merge → the single merge call is refused by gh (check-then-act closed), exit 2', async () => {
  const f = fakeGh({ views: [{ checks: [green()] }], headAtMerge: H2 });
  const r = await deliver(opts(), deps(f.gh).d);
  assert.equal(r.exit, 2);
  assert.equal(r.result.reason, 'head-moved');
  assert.equal(f.merges().length, 1);
  assert.equal(f.wasMerged(), false, 'nothing was merged');
});

test('MUST-FAIL: MAJOR (or BLOCKING) in the verdict → refused, exit 2, no merge, CI never consulted for a merge', async () => {
  for (const bad of [{ major: 1 }, { blocking: 2 }]) {
    const f = fakeGh({ views: [{ checks: [green()] }] });
    const r = await deliver(opts({ reviewVerdict: 'v' }), deps(f.gh, { v: verdictFile(bad) }).d);
    assert.equal(r.exit, 2);
    assert.equal(r.result.reason, 'review-blocking');
    assert.equal(f.merges().length, 0);
  }
});

test('MUST-FAIL: --verified-head disagreeing with the verdict head is refused before any gh call', async () => {
  const f = fakeGh({ views: [{ checks: [green()] }] });
  const r = await deliver(opts({ reviewVerdict: 'v', verifiedHead: H }), deps(f.gh, { v: verdictFile({ head: H2 }) }).d);
  assert.equal(r.exit, 2);
  assert.equal(r.result.reason, 'verdict-head-mismatch');
  assert.equal(f.calls.length, 0);
});

test('red CI → refused (2); wrong base → refused (2)', async () => {
  const red: Check = { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: RUN_URL };
  assert.equal((await deliver(opts(), deps(fakeGh({ views: [{ checks: [red] }] }).gh).d)).result.reason, 'ci-red');
  assert.equal((await deliver(opts(), deps(fakeGh({ views: [{ base: 'master', checks: [green()] }] }).gh).d)).result.reason, 'wrong-base');
});

test('COULD-NOT-CHECK (exit 1, never 2): gh failing, unreadable steps, bad/unreadable verdict, no verified head, timeout, non-head merge failure', async () => {
  const unchecked = async (r: Promise<{ exit: number; result: { verdict: string; reason?: string } }>, reason: string) => {
    const x = await r;
    assert.equal(x.exit, 1, reason);
    assert.equal(x.result.verdict, 'unchecked');
    assert.equal(x.result.reason, reason);
  };
  await unchecked(deliver(opts(), deps(async () => ({ code: 1, stdout: '', stderr: 'gh: command not found' })).d), 'gh-failed');
  await unchecked(deliver(opts(), deps(fakeGh({ views: [{ checks: [green()] }], runViewFails: true }).gh).d), 'gh-failed');
  await unchecked(deliver(opts({ reviewVerdict: 'v' }), deps(fakeGh({ views: [{ checks: [green()] }] }).gh, { v: '{"round":1}' }).d), 'bad-verdict');
  await unchecked(deliver(opts({ reviewVerdict: 'missing' }), deps(fakeGh({ views: [{ checks: [green()] }] }).gh).d), 'bad-verdict');
  await unchecked(deliver(opts({ verifiedHead: undefined }), deps(fakeGh({ views: [{ checks: [green()] }] }).gh).d), 'no-verified-head');
  await unchecked(deliver(opts({ timeoutMs: 25_000 }), deps(fakeGh({ views: [{ checks: [pending()] }] }).gh).d), 'timeout');
  await unchecked(deliver(opts(), deps(fakeGh({ views: [{ checks: [green()] }], mergeStderr: 'GraphQL: Required status check is expected' }).gh).d), 'merge-failed');
});

test('already merged at the verified head → exit 0, no merge call', async () => {
  const f = fakeGh({ views: [{ state: 'MERGED', checks: [] }], existing: [{ number: 5, url: 'https://github.com/o/r/pull/5', state: 'MERGED', headRefOid: H } as never] });
  const r = await deliver(opts(), deps(f.gh).d);
  assert.equal(r.exit, 0);
  assert.equal(r.result.verdict, 'already-merged');
  assert.equal(f.merges().length, 0);
});

test('argv: strict parse; shell/gh-option lookalike refs and unknown flags are usage errors', () => {
  const base = ['--branch', 'impl-x', '--into', 'bench/x', '--ticket', 'T-1'];
  assert.equal(parseDeliverArgs(base).ok, true);
  assert.equal(parseDeliverArgs(['--into', 'bench/x', '--ticket', 'T-1']).ok, false);
  assert.equal(parseDeliverArgs([...base, '--bogus', '1']).ok, false);
  assert.equal(parseDeliverArgs(['--branch', '--delete-branch', '--into', 'b', '--ticket', 't']).ok, false);
  assert.equal(parseDeliverArgs(['--branch', 'a;rm', '--into', 'b', '--ticket', 't']).ok, false);
  assert.equal(parseDeliverArgs([...base, '--verified-head', 'abc']).ok, false);
  assert.equal(parseDeliverArgs([...base, '--strategy', 'yolo']).ok, false);
  assert.equal(parseDeliverArgs([...base, '--interval', '0']).ok, false);
  assert.equal(parseDeliverArgs([...base, '--timeout', '']).ok, false);
  const rq = parseDeliverArgs([...base, '--require-check', 'a', '--require-check', 'b']);
  assert.deepEqual(rq.ok && rq.opts.requireChecks, ['a', 'b']);
});

test('runFanout: usage errors are exit 1 with no stdout; deliver prints ONE JSON line', async () => {
  assert.equal((await runFanout([])).exit, 1);
  assert.equal((await runFanout(['nope'])).exit, 1);
  assert.equal((await runFanout(['deliver'])).exit, 1);
  const f = fakeGh({ views: [{ checks: [green()] }] });
  const r = await runFanout(['deliver', '--branch', 'impl-x', '--into', 'bench/x', '--ticket', 'T-1', '--verified-head', H], deps(f.gh).d);
  assert.equal(r.exit, 0);
  assert.equal(r.stdout?.trim().split('\n').length, 1);
  assert.equal(JSON.parse(r.stdout as string).verdict, 'merged');
});
