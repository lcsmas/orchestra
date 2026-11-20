import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliver, type DeliverDeps, type DeliverOpts, type GhResult } from './fanout-deliver.ts';
import { openPr, parseOpenArgs, runOpenRoute, type OpenOpts } from './fanout-open.ts';

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const RUN_URL = 'https://github.com/o/r/actions/runs/900/job/901';

interface Pr { number: number; url: string; state: string; base: string; head: string }

/** A stateful fake GitHub: PRs + the branch tip. Like GitHub it refuses a merge whose --match-head-commit != the PR head, and CI is green only on heads in `ciGreen`. */
function fakeGithub(init: { prs?: Pr[]; tip?: string; ciGreen?: string[] } = {}) {
  const prs: Pr[] = init.prs ?? [];
  const st = { tip: init.tip ?? H1, ciGreen: new Set(init.ciGreen ?? [H1]) };
  const calls: string[][] = [];
  const gh = async (args: string[]): Promise<GhResult> => {
    calls.push(args);
    const ok = (o: unknown): GhResult => ({ code: 0, stdout: typeof o === 'string' ? o : JSON.stringify(o), stderr: '' });
    const [a, b] = args;
    const val = (f: string) => args[args.indexOf(f) + 1];
    if (a === 'pr' && b === 'list') {
      const base = args.includes('--base') ? val('--base') : undefined;
      return ok(prs.filter((p) => !base || p.base === base).map((p) => ({ number: p.number, url: p.url, state: p.state, baseRefName: p.base, headRefOid: p.head })));
    }
    if (a === 'pr' && b === 'create') {
      const n = 100 + prs.length;
      prs.push({ number: n, url: `https://github.com/o/r/pull/${n}`, state: 'OPEN', base: val('--base'), head: st.tip });
      return ok(`https://github.com/o/r/pull/${n}\n`);
    }
    if (a === 'pr' && b === 'view') {
      const p = prs.find((x) => String(x.number) === args[2]);
      if (!p) return { code: 1, stdout: '', stderr: 'not found' };
      if (p.state === 'OPEN') p.head = st.tip; // a push to the branch moves the open PR's head
      if (args.includes('state,mergeCommit')) return ok({ state: p.state, mergeCommit: { oid: 'c'.repeat(40) } });
      if (args.includes('headRefOid') && !args.includes('state,baseRefName,headRefOid,mergeable,statusCheckRollup')) return ok({ headRefOid: p.head });
      const green = st.ciGreen.has(p.head);
      return ok({
        state: p.state, baseRefName: p.base, headRefOid: p.head, mergeable: 'MERGEABLE',
        statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: green ? 'COMPLETED' : 'IN_PROGRESS', conclusion: green ? 'SUCCESS' : '', detailsUrl: RUN_URL }],
      });
    }
    if (a === 'run' && b === 'view') return ok({ jobs: [{ databaseId: 901, steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run tests', conclusion: 'success' }, { name: 'Complete job', conclusion: 'success' }] }] });
    if (a === 'pr' && b === 'merge') {
      const p = prs.find((x) => String(x.number) === args[2])!;
      if (args[args.indexOf('--match-head-commit') + 1] !== p.head) return { code: 1, stdout: '', stderr: 'Pull request is not mergeable: the head branch was modified. Review and try the merge again.' };
      p.state = 'MERGED';
      return ok('');
    }
    return { code: 1, stdout: '', stderr: `unexpected gh call: ${args.join(' ')}` };
  };
  return { gh, prs, st, calls, merges: () => calls.filter((c) => c[0] === 'pr' && c[1] === 'merge') };
}

const O: OpenOpts = { branch: 'impl-x', into: 'master', ticket: 'T-1' };
const logDeps = (gh: DeliverDeps['gh']) => ({ gh, log: () => {} });

test('open: no PR yet → creates ONE, prints {pr,url,head,reused:false}, exit 0, never merges', async () => {
  const g = fakeGithub();
  const { exit, result } = await openPr(O, logDeps(g.gh));
  assert.equal(exit, 0);
  assert.deepEqual([result.verdict, result.pr, result.url, result.head, result.reused], ['opened', 100, 'https://github.com/o/r/pull/100', H1, false]);
  assert.equal(g.prs.length, 1);
  assert.equal(g.prs[0].base, 'master');
  assert.equal(g.merges().length, 0);
  assert.ok(g.calls.every((c) => c[1] !== 'merge'), 'open never issues a merge');
});

test('open is idempotent: a second call REUSES the open PR (reused:true), creates nothing, same pr/url/head', async () => {
  const g = fakeGithub();
  const first = await openPr(O, logDeps(g.gh));
  const second = await openPr(O, logDeps(g.gh));
  assert.equal(second.exit, 0);
  assert.equal(second.result.reused, true);
  assert.deepEqual([second.result.pr, second.result.url, second.result.head], [first.result.pr, first.result.url, first.result.head]);
  assert.equal(g.prs.length, 1);
  assert.equal(g.calls.filter((c) => c[1] === 'create').length, 1);
});

test('open reuses an open PR created by someone else, reporting ITS head', async () => {
  const g = fakeGithub({ prs: [{ number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', base: 'master', head: H2 }] });
  const { result } = await openPr(O, logDeps(g.gh));
  assert.deepEqual([result.pr, result.head, result.reused], [7, H2, true]);
  assert.equal(g.calls.filter((c) => c[1] === 'create').length, 0);
});

test('MUST-FAIL: an open PR on ANOTHER base is refused wrong-base (exit 2), no second PR created', async () => {
  const g = fakeGithub({ prs: [{ number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', base: 'main', head: H1 }] });
  const { exit, result } = await openPr(O, logDeps(g.gh));
  assert.equal(exit, 2);
  assert.deepEqual([result.verdict, result.reason, result.pr], ['refused', 'wrong-base', 7]);
  assert.equal(g.prs.length, 1);
  assert.equal(g.calls.filter((c) => c[1] === 'create').length, 0);
});

test('MUST-FAIL: a PR closed unmerged (nothing open) is refused pr-closed (exit 2), nothing created', async () => {
  const g = fakeGithub({ prs: [{ number: 7, url: 'https://github.com/o/r/pull/7', state: 'CLOSED', base: 'master', head: H1 }] });
  const { exit, result } = await openPr(O, logDeps(g.gh));
  assert.equal(exit, 2);
  assert.deepEqual([result.verdict, result.reason, result.pr], ['refused', 'pr-closed', 7]);
  assert.equal(g.calls.filter((c) => c[1] === 'create').length, 0);
});

test('an earlier MERGED PR (a previous round) does not block a new open', async () => {
  const g = fakeGithub({ prs: [{ number: 7, url: 'https://github.com/o/r/pull/7', state: 'MERGED', base: 'master', head: H2 }] });
  const { exit, result } = await openPr(O, logDeps(g.gh));
  assert.equal(exit, 0);
  assert.deepEqual([result.pr, result.reused], [101, false]);
});

test('PR selection is newest-first and per base: [#5 closed, #9 open] reuses #9; a CLOSED PR on an OLD base does not block a retarget; the newest PR on THIS base decides closed/merged', async () => {
  const pr = (number: number, state: string, base: string): Pr => ({ number, url: `https://github.com/o/r/pull/${number}`, state, base, head: H1 });
  const a = await openPr(O, logDeps(fakeGithub({ prs: [pr(5, 'CLOSED', 'master'), pr(9, 'OPEN', 'master')] }).gh));
  assert.deepEqual([a.exit, a.result.pr, a.result.reused], [0, 9, true]);
  const b = fakeGithub({ prs: [pr(7, 'CLOSED', 'old-target')] });
  const rb = await openPr(O, logDeps(b.gh));
  assert.deepEqual([rb.exit, rb.result.reused, b.prs.length], [0, false, 2], 'closed on another base ⇒ not pr-closed, a new PR opens (as deliver would)');
  const c = await openPr(O, logDeps(fakeGithub({ prs: [pr(5, 'MERGED', 'master'), pr(9, 'CLOSED', 'master')] }).gh));
  assert.deepEqual([c.exit, c.result.reason, c.result.pr], [2, 'pr-closed', 9], 'newest on this base is the closed one');
  const d = await openPr(O, logDeps(fakeGithub({ prs: [pr(5, 'CLOSED', 'master'), pr(9, 'MERGED', 'master')] }).gh));
  assert.equal(d.exit, 0, 'newest is MERGED ⇒ an earlier closed one does not block');
});

test('open after the PR was already merged: gh pr create fails ⇒ exit 1, and the detail names the merged PR', async () => {
  const g = fakeGithub({ prs: [{ number: 9, url: 'https://github.com/o/r/pull/9', state: 'MERGED', base: 'master', head: H1 }] });
  const r = await openPr(O, logDeps(async (a) => (a[1] === 'create' ? { code: 1, stdout: '', stderr: 'No commits between master and impl-x' } : g.gh(a))));
  assert.equal(r.exit, 1);
  assert.match(r.result.detail ?? '', /No commits between.*PR #9.*already MERGED/);
});

test('could-not-check (exit 1, never 2): gh list failing, gh create printing no url', async () => {
  const bad = await openPr(O, logDeps(async () => ({ code: 1, stdout: '', stderr: 'HTTP 502' })));
  assert.deepEqual([bad.exit, bad.result.verdict, bad.result.reason], [1, 'unchecked', 'gh-failed']);
  const noUrl = await openPr(O, logDeps(async (a) => (a[1] === 'list' ? { code: 0, stdout: '[]', stderr: '' } : { code: 0, stdout: 'created\n', stderr: '' })));
  assert.deepEqual([noUrl.exit, noUrl.result.reason], [1, 'gh-failed']);
  const unsafe = await openPr({ ...O, branch: '--evil' }, logDeps(async () => { throw new Error('no gh call expected'); }));
  assert.deepEqual([unsafe.exit, unsafe.result.reason], [1, 'bad-args']);
});

test('--repo reaches every gh call', async () => {
  const g = fakeGithub();
  await openPr({ ...O, repo: 'o/r' }, logDeps(g.gh));
  assert.ok(g.calls.length >= 3 && g.calls.every((c) => c.slice(-2).join(' ') === '--repo o/r'));
});

// ---- the contract with deliver: open at nomination, then deliver reuses it and merges only at the verified head with CI green on it ----
const dOpts = (o: Partial<DeliverOpts> = {}): DeliverOpts => ({
  branch: 'impl-x', into: 'master', ticket: 'T-1', verifiedHead: H1, noReviewGate: true, strategy: 'merge',
  timeoutMs: 100_000, intervalMs: 10_000, noChecksGraceMs: 30_000, requireChecks: [], ...o,
});
function dDeps(gh: DeliverDeps['gh']): DeliverDeps {
  let t = 0;
  return { gh, sleep: async (ms) => { t += ms; }, now: () => t, readFile: () => '', log: () => {} };
}

test('open at nomination, head UNCHANGED: deliver REUSES the opened PR (no second create) and merges at the verified head', async () => {
  const g = fakeGithub();
  const o = await openPr(O, logDeps(g.gh));
  const d = await deliver(dOpts(), dDeps(g.gh));
  assert.equal(d.exit, 0);
  assert.equal(d.result.verdict, 'merged');
  assert.equal(d.result.pr, o.result.pr);
  assert.equal(g.calls.filter((c) => c[1] === 'create').length, 1, 'deliver did not open a second PR');
  const m = g.merges();
  assert.equal(m.length, 1);
  assert.equal(m[0][m[0].indexOf('--match-head-commit') + 1], H1);
});

test('MUST-FAIL: head pushed AFTER open (CI not yet green on the new head) → deliver refuses head-moved (exit 2), NO merge', async () => {
  const g = fakeGithub();
  await openPr(O, logDeps(g.gh));
  g.st.tip = H2; // the implementer pushed after the gate; CI reruns on H2 (not green yet)
  const d = await deliver(dOpts(), dDeps(g.gh));
  assert.equal(d.exit, 2);
  assert.equal(d.result.reason, 'head-moved');
  assert.equal(g.merges().length, 0);
});

test('MUST-FAIL: head moved and re-verified at the NEW head while CI still runs on it → deliver WAITS (timeout, exit 1), never merges on the old head\'s green', async () => {
  const g = fakeGithub();
  await openPr(O, logDeps(g.gh));
  g.st.tip = H2; // CI green only on H1, none yet on H2
  const d = await deliver(dOpts({ verifiedHead: H2, timeoutMs: 50_000 }), dDeps(g.gh));
  assert.equal(d.exit, 1);
  assert.equal(d.result.reason, 'timeout');
  assert.equal(g.merges().length, 0);
  g.st.ciGreen.add(H2); // CI finishes on the new head → now it merges, at H2
  const d2 = await deliver(dOpts({ verifiedHead: H2 }), dDeps(g.gh));
  assert.equal(d2.result.verdict, 'merged');
  const m = g.merges()[0];
  assert.equal(m[m.indexOf('--match-head-commit') + 1], H2);
});

test('argv: strict parse; merge flags and unsafe refs are usage errors', () => {
  assert.deepEqual(parseOpenArgs(['--branch', 'b', '--into', 'm', '--ticket', 'T']), { ok: true, opts: { branch: 'b', into: 'm', ticket: 'T', repo: undefined } });
  for (const bad of [
    ['--branch', 'b', '--into', 'm'], ['--branch', 'b', '--into', 'm', '--ticket', 'T', '--review-verdict', 'v.json'],
    ['--branch', '--x', '--into', 'm', '--ticket', 'T'], ['--branch', 'b', '--into', 'm;ls', '--ticket', 'T'], ['--branch', 'b', '--into', 'm', '--ticket', 'T', '--repo', 'nope'],
    ['--branch', 'b', '--into', 'm', '--ticket'],
  ]) assert.equal(parseOpenArgs(bad).ok, false, bad.join(' '));
});

test('runOpenRoute: `open` and `deliver --open-only` are the SAME path; plain deliver / state are not routed; usage errors are exit 1 with no stdout', async () => {
  const mk = () => fakeGithub();
  const a = mk(); const b = mk();
  const ra = await runOpenRoute(['open', '--branch', 'impl-x', '--into', 'master', '--ticket', 'T-1'], logDeps(a.gh));
  const rb = await runOpenRoute(['deliver', '--open-only', '--branch', 'impl-x', '--into', 'master', '--ticket', 'T-1'], logDeps(b.gh));
  assert.equal(ra?.exit, 0);
  assert.equal(ra?.stdout, rb?.stdout);
  assert.deepEqual(JSON.parse(ra!.stdout!), { verdict: 'opened', pr: 100, url: 'https://github.com/o/r/pull/100', head: H1, reused: false, ticket: 'T-1', branch: 'impl-x', into: 'master' });
  assert.equal(a.merges().length + b.merges().length, 0);
  assert.equal(await runOpenRoute(['deliver', '--branch', 'b', '--into', 'm', '--ticket', 'T'], logDeps(a.gh)), undefined);
  assert.equal(await runOpenRoute(['state', 'show'], logDeps(a.gh)), undefined);
  const bad = await runOpenRoute(['open', '--branch', 'b'], logDeps(a.gh));
  assert.equal(bad?.exit, 1);
  assert.equal(bad?.stdout, undefined);
  const mixed = await runOpenRoute(['deliver', '--open-only', '--branch', 'b', '--into', 'm', '--ticket', 'T', '--no-review-gate'], logDeps(a.gh));
  assert.equal(mixed?.exit, 1, 'merge flags with --open-only are a usage error, not silently ignored');
});
