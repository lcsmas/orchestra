import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatePr, parseGateArgs, runGate } from './fanout-gate.ts';
import type { GhResult } from './fanout-deliver.ts';

const H = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const RUN = 'https://github.com/o/r/actions/runs/900/job/901';
const PR_WF = 'on:\n  pull_request:\njobs:\n  ci:\n    steps:\n      - run: pnpm test\n';

interface Fake {
  /** Workflow files of the target: name → content; null = the contents API fails (500); undefined dir = 404. */
  workflows?: Record<string, string> | null | 'none';
  pr?: { number: number; head: string } | null;
  checks?: Record<string, unknown>[];
  steps?: number;
}
function fake(o: Fake) {
  const calls: string[][] = [];
  const gh = async (args: string[]): Promise<GhResult> => {
    calls.push(args);
    const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: '' });
    const [a, b] = args;
    if (a === 'api') {
      if (o.workflows === null) return { code: 1, stdout: '', stderr: 'HTTP 500' };
      if (o.workflows === 'none' || o.workflows === undefined) return { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
      const last = args[args.length - 1];
      const m = /workflows\/([^?]+)\?/.exec(last);
      if (m) return ok(o.workflows[decodeURIComponent(m[1])] ?? '');
      return ok(JSON.stringify(Object.keys(o.workflows).map((name) => ({ name, type: 'file' }))));
    }
    if (a === 'pr' && b === 'list') return ok(JSON.stringify(o.pr ? [{ number: o.pr.number, headRefOid: o.pr.head }] : []));
    if (a === 'pr' && b === 'view') return ok(JSON.stringify({ state: 'OPEN', baseRefName: 'main', headRefOid: o.pr!.head, mergeable: 'MERGEABLE', statusCheckRollup: o.checks ?? [] }));
    if (a === 'run' && b === 'view') {
      const n = o.steps ?? 4;
      return ok(JSON.stringify({ jobs: [{ databaseId: 901, steps: [{ name: 'Set up job', conclusion: 'success' }, ...Array.from({ length: n }, (_, k) => ({ name: `s${k}`, conclusion: 'success' }))] }] }));
    }
    return { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  };
  return { gh, calls };
}
const green = { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: RUN };
const opts = { branch: 'feat', into: 'main', head: H, requireChecks: [] as string[] };
const run = async (f: Fake, head = H) => {
  const x = fake(f);
  const r = await gatePr({ ...opts, head }, { gh: x.gh, log: () => {}, sleep: async () => {} });
  return { ...r, calls: x.calls };
};

test('gate must-PASS: repo with PR CI, green on the verified head ⇒ fullSuite ci, ciGreenOnHead, exit 0', async () => {
  const r = await run({ workflows: { 'ci.yml': PR_WF }, pr: { number: 7, head: H }, checks: [green] });
  assert.equal(r.exit, 0);
  assert.equal(r.result.verdict, 'gate');
  assert.equal(r.result.fullSuite, 'ci');
  assert.equal(r.result.ciGreenOnHead, true);
  assert.equal(r.result.pr, 7);
  assert.ok(r.result.checklist!.skip.length > 0 && r.result.checklist!.run.length === 0);
});

test('gate must-FAIL: no PR CI (no workflows dir / push-only workflows) ⇒ the full suite stays on the verifier', async () => {
  for (const workflows of ['none', { 'release.yml': 'on:\n  push:\njobs: {}\n' }] as const) {
    const r = await run({ workflows, pr: { number: 7, head: H }, checks: [] });
    assert.equal(r.result.fullSuite, 'verifier', JSON.stringify(workflows));
    assert.equal(r.result.ciGreenOnHead, false);
    assert.ok(r.result.checklist!.run.some((s) => /full test suite/.test(s)));
  }
});

test('gate must-FAIL: the PR head moved past the verified head ⇒ the old head\'s CI-green is not accepted', async () => {
  const r = await run({ workflows: { 'ci.yml': PR_WF }, pr: { number: 7, head: H2 }, checks: [green] });
  assert.equal(r.result.ci, 'green');
  assert.equal(r.result.headMatches, false);
  assert.equal(r.result.ciGreenOnHead, false);
});

test('gate: a green check with 0 workflow steps, a pending check and an unreadable workflow listing are never "CI green"', async () => {
  const zero = await run({ workflows: { 'ci.yml': PR_WF }, pr: { number: 7, head: H }, checks: [green], steps: 0 });
  assert.equal(zero.result.ciGreenOnHead, false);
  assert.equal(zero.result.ci, 'zero-steps');
  const pend = await run({ workflows: { 'ci.yml': PR_WF }, pr: { number: 7, head: H }, checks: [{ ...green, status: 'IN_PROGRESS', conclusion: '' }] });
  assert.equal(pend.result.ci, 'pending');
  assert.equal(pend.result.ciGreenOnHead, false);
  const unreadable = await run({ workflows: null, pr: { number: 7, head: H }, checks: [] });
  assert.equal(unreadable.result.fullSuite, 'verifier');
});

test('gate is READ-ONLY: no gh call outside api / pr list|view / run view', async () => {
  const r = await run({ workflows: { 'ci.yml': PR_WF }, pr: { number: 7, head: H }, checks: [green] });
  for (const c of r.calls) assert.ok(c[0] === 'api' || (c[0] === 'pr' && ['list', 'view'].includes(c[1])) || (c[0] === 'run' && c[1] === 'view'), c.join(' '));
});

test('gate: could-not-check is exit 1, not a verdict (gh failing on the PR list)', async () => {
  const gh = async (a: string[]): Promise<GhResult> => (a[0] === 'api' ? { code: 1, stdout: '', stderr: '404' } : { code: 1, stdout: '', stderr: 'HTTP 502' });
  const r = await gatePr(opts, { gh, log: () => {}, sleep: async () => {} });
  assert.equal(r.exit, 1);
  assert.equal(r.result.verdict, 'unchecked');
  assert.equal(r.result.fullSuite, undefined);
});

test('gate argv: --head must be a full sha, unknown flags and unsafe refs are usage errors', async () => {
  assert.equal(parseGateArgs(['--branch', 'f', '--into', 'main', '--head', 'abc']).ok, false);
  assert.equal(parseGateArgs(['--branch', 'f', '--into', 'main']).ok, false);
  assert.equal(parseGateArgs(['--branch', 'f', '--into', 'main', '--head', H, '--bogus', 'x']).ok, false);
  assert.equal(parseGateArgs(['--branch', '-x', '--into', 'main', '--head', H]).ok, false);
  assert.equal(parseGateArgs(['--branch', 'f', '--into', 'main', '--head', H]).ok, true);
  assert.equal((await runGate(['--branch', 'f'])).exit, 1);
});

test('review #495 MAJOR 1 through the CLI: a check that registers between the two reads ⇒ not green (fast lint, slow suite)', async () => {
  const x = fake({ workflows: { 'ci.yml': PR_WF }, pr: { number: 7, head: H }, checks: [] });
  let views = 0;
  const lint = { ...green, name: 'lint', detailsUrl: RUN };
  const slow = { ...green, name: 'test', detailsUrl: RUN };
  const gh = async (a: string[]): Promise<GhResult> => {
    if (a[0] === 'pr' && a[1] === 'view') {
      const checks = views++ === 0 ? [lint] : [lint, slow];
      return { code: 0, stdout: JSON.stringify({ state: 'OPEN', baseRefName: 'main', headRefOid: H, mergeable: 'MERGEABLE', statusCheckRollup: checks }), stderr: '' };
    }
    return x.gh(a);
  };
  const r = await gatePr(opts, { gh, log: () => {}, sleep: async () => {} });
  assert.equal(r.result.ciGreenOnHead, false);
  assert.equal(r.result.ci, 'pending');
  assert.deepEqual(r.result.ciChecks, ['lint', 'test'], 'the check names are listed so the verifier can see what CI covers');
});

test('review #495 MAJOR 2 through the CLI: a pull_request workflow filtered to another branch ⇒ the suite stays on the verifier', async () => {
  const r = await run({ workflows: { 'ci.yml': 'on:\n  pull_request:\n    branches: [release]\njobs: {}\n' }, pr: { number: 7, head: H }, checks: [green] });
  assert.equal(r.result.fullSuite, 'verifier');
  assert.equal(r.result.repoCi, 'none');
});

test('review A MAJOR through the CLI: lint-only PR CI green on the head ⇒ the suite stays on the verifier; --require-check pins the suite check', async () => {
  const LINT_WF = 'on:\n  pull_request:\njobs:\n  lint:\n    steps:\n      - run: pnpm run lint\n';
  const r = await run({ workflows: { 'ci.yml': LINT_WF }, pr: { number: 7, head: H }, checks: [{ ...green, name: 'lint' }] });
  assert.equal(r.result.fullSuite, 'verifier');
  assert.equal(r.result.ciGreenOnHead, false);
  const x = fake({ workflows: { 'ci.yml': LINT_WF }, pr: { number: 7, head: H }, checks: [{ ...green, name: 'unit' }] });
  const pinned = await gatePr({ ...opts, requireChecks: ['unit'] }, { gh: x.gh, log: () => {}, sleep: async () => {} });
  assert.equal(pinned.result.fullSuite, 'ci');
  assert.equal(pinned.result.ciGreenOnHead, true);
  assert.deepEqual(pinned.result.suiteChecks, ['unit']);
  assert.equal(pinned.result.suiteSource, 'pinned');
});
