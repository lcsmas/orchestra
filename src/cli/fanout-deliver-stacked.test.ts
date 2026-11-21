// #506 — a dependent is gated on its upstream's verified candidate and merged only AFTER it, on the content it was gated against.
// REAL git on a scratch bare origin, a stateful fake GitHub on top of it (PR heads read from the origin refs, merges done with real git:
// --merge / --rebase, the latter REWRITING the upstream's shas on the target), and the production state reader (`upstreamsFromState`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deliver, upstreamsFromState, type DeliverDeps, type DeliverOpts, type GhResult } from './fanout-deliver.ts';
import { applyTicketPatch, newState, stateFile, writeStateAtomic, type FanoutState } from '../shared/fanout-state.ts';

const NOW = '2026-11-21T10:00:00.000Z';
const RUN_URL = 'https://github.com/o/r/actions/runs/900/job/901';
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

interface Pr { number: number; branch: string; base: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; head?: string; mergeCommit?: string }

function rig(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'stacked-506-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const home = path.join(root, 'home');
  const sh = (cwd: string) => (...a: string[]): string => execFileSync('git', a, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  fs.mkdirSync(origin);
  sh(origin)('init', '--bare', '-q', '-b', 'master');
  sh(root)('clone', '-q', origin, work);
  const g = sh(work);
  const commit = (file: string, text: string, msg: string): string => { fs.writeFileSync(path.join(work, file), text); g('add', file); g('commit', '-q', '-m', msg); return g('rev-parse', 'HEAD'); };
  commit('base.txt', 'base\n', 'root');
  g('push', '-q', 'origin', 'master');
  const prs: Pr[] = [];
  const calls: string[][] = [];
  const tip = (branch: string): string => sh(origin)('rev-parse', `refs/heads/${branch}`);
  const view = (p: Pr) => ({ number: p.number, url: `https://github.com/o/r/pull/${p.number}`, state: p.state, baseRefName: p.base, headRefOid: p.state === 'OPEN' ? tip(p.branch) : p.head!, mergeCommit: p.mergeCommit ? { oid: p.mergeCommit } : null });
  const ok = (o: unknown): GhResult => ({ code: 0, stdout: typeof o === 'string' ? o : JSON.stringify(o), stderr: '' });
  const gh = async (args: string[]): Promise<GhResult> => {
    calls.push(args);
    const [a, b] = args;
    const val = (f: string) => args[args.indexOf(f) + 1];
    if (a === 'api') {
      const url = args[1];
      let m = /\/commits\/([0-9a-f]+)$/.exec(url);
      if (m) { try { return ok({ sha: sh(origin)('rev-parse', m[1]), commit: { tree: { sha: sh(origin)('rev-parse', `${m[1]}^{tree}`) } } }); } catch { return { code: 1, stdout: '', stderr: 'HTTP 404' }; } }
      m = /\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(url);
      if (m) {
        try { execFileSync('git', ['merge-base', '--is-ancestor', m[1], m[2]], { cwd: origin, env: GIT_ENV, stdio: 'ignore' }); return ok({ status: sh(origin)('rev-parse', m[1]) === sh(origin)('rev-parse', m[2]) ? 'identical' : 'ahead' }); } catch { return ok({ status: 'diverged' }); }
      }
      return { code: 1, stdout: '', stderr: 'HTTP 404' };
    }
    if (a === 'pr' && b === 'list') {
      const head = val('--head'), base = val('--base');
      return ok(prs.filter((p) => p.branch === head && p.base === base).map(view));
    }
    if (a === 'pr' && b === 'create') {
      const p: Pr = { number: 100 + prs.length, branch: val('--head'), base: val('--base'), state: 'OPEN' };
      prs.push(p);
      return ok(`https://github.com/o/r/pull/${p.number}\n`);
    }
    if (a === 'pr' && b === 'view') {
      const p = prs.find((x) => String(x.number) === args[2]);
      if (!p) return { code: 1, stdout: '', stderr: 'not found' };
      if (args.includes('state,mergeCommit')) return ok({ state: p.state, mergeCommit: p.mergeCommit ? { oid: p.mergeCommit } : null });
      const v = view(p);
      if (args.includes('number,state,baseRefName,headRefOid,mergeCommit')) return ok(v);
      return ok({ state: p.state, baseRefName: p.base, headRefOid: v.headRefOid, mergeable: 'MERGEABLE', statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: RUN_URL }] });
    }
    if (a === 'run' && b === 'view') return ok({ jobs: [{ databaseId: 901, steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run tests', conclusion: 'success' }, { name: 'Complete job', conclusion: 'success' }] }] });
    if (a === 'pr' && b === 'merge') {
      const p = prs.find((x) => String(x.number) === args[2])!;
      const want = args[args.indexOf('--match-head-commit') + 1];
      if (want !== tip(p.branch)) return { code: 1, stdout: '', stderr: 'Pull request is not mergeable: the head branch was modified. Review and try the merge again.' };
      // real merge on the target, like GitHub: --rebase REPLAYS the PR's commits (dropping patch-identical ones) and rewrites shas.
      g('fetch', '-q', 'origin');
      g('checkout', '-q', '-B', 'scratch', `origin/${p.base}`);
      if (args.includes('--rebase')) { g('checkout', '-q', '-B', 'replay', `origin/${p.branch}`); g('rebase', '-q', `origin/${p.base}`); g('push', '-q', 'origin', `replay:${p.base}`); }
      else { g('merge', '-q', '--no-ff', '-m', `merge ${p.branch}`, `origin/${p.branch}`); g('push', '-q', 'origin', `scratch:${p.base}`); }
      p.head = want;
      p.state = 'MERGED';
      p.mergeCommit = tip(p.base);
      return ok('');
    }
    return { code: 1, stdout: '', stderr: `unexpected gh call: ${args.join(' ')}` };
  };
  const push = (branch: string): void => { g('push', '-q', '-f', 'origin', `HEAD:refs/heads/${branch}`); };
  /** a branch from `from` (a ref / sha) with one commit; returns its head. */
  const branchWith = (name: string, from: string, file: string, text: string): string => {
    g('checkout', '-q', '-B', name, from);
    const h = commit(file, text, `${name}: ${file}`);
    push(name);
    return h;
  };
  const merges = () => calls.filter((c) => c[0] === 'pr' && c[1] === 'merge');
  const created = () => calls.filter((c) => c[0] === 'pr' && c[1] === 'create');
  const mkdeps = (envExtra: Record<string, string> = {}): DeliverDeps => ({
    gh, sleep: async () => {}, now: () => 0, readFile: () => { throw new Error('no file'); }, log: () => {},
    upstreams: (o) => upstreamsFromState(o, { ORCHESTRA_HOME: home, ...envExtra }),
  });
  const writeState = (s: FanoutState): void => writeStateAtomic(stateFile(home, 'r1'), s);
  return { g, commit, push, branchWith, gh, prs, calls, merges, created, mkdeps, writeState, home, origin, sh: sh(origin), tip };
}

const opts = (branch: string, ticket: string, head: string, o: Partial<DeliverOpts> = {}): DeliverOpts => ({
  branch, into: 'master', ticket, verifiedHead: head, noReviewGate: true, strategy: 'merge', timeoutMs: 600_000, intervalMs: 10_000, noChecksGraceMs: 30_000, requireChecks: [], run: 'r1', ...o,
});

/** UP nominated→gated (PASS) at `upHead`; DEP nominated early on it → gated (PASS) at `depHead`, builtOn = `builtOn`. */
function stateFor(upHead: string, depHead: string, builtOn: string = upHead, extra: Record<string, unknown> = {}): FanoutState {
  let s = newState('r1', { now: NOW });
  s = applyTicketPatch(s, 'UP', { branch: 'up', head: upHead, status: 'gated', verdict: 'pass' }, NOW);
  s = applyTicketPatch(s, 'DEP', { dependsOn: ['UP'], branch: 'dep', head: depHead, builtOn: { UP: builtOn }, status: 'gated', verdict: 'pass', ...extra }, NOW);
  return s;
}

for (const strategy of ['merge', 'rebase'] as const) {
  test(`#506 must-PASS (--${strategy}): upstream PASS → dependent nominated + gated early → both deliver in order, both contents on the target`, async (t) => {
    const r = rig(t);
    const U = r.branchWith('up', 'master', 'up.txt', 'u1\n');
    const D = r.branchWith('dep', 'up', 'dep.txt', 'd1\n'); // stacked on the upstream's candidate head
    r.g('checkout', '-q', 'master'); r.commit('hotfix.txt', 'h\n', 'master moved meanwhile'); r.g('push', '-q', 'origin', 'master'); // so a rebase-merge must REWRITE shas
    r.writeState(stateFor(U, D)); // the state layer admitted DEP's gating while UP was still unmerged (fanout-state.test.ts)
    const first = await deliver(opts('up', 'UP', U, { strategy }), r.mkdeps());
    assert.deepEqual([first.exit, first.result.verdict], [0, 'merged'], JSON.stringify(first.result));
    const second = await deliver(opts('dep', 'DEP', D, { strategy }), r.mkdeps());
    assert.deepEqual([second.exit, second.result.verdict], [0, 'merged'], JSON.stringify(second.result));
    assert.equal(r.merges().length, 2);
    r.g('fetch', '-q', 'origin');
    const files = r.sh('ls-tree', '--name-only', 'refs/heads/master').split('\n');
    assert.ok(files.includes('up.txt') && files.includes('dep.txt'), `target holds both: ${files.join(',')}`);
    if (strategy === 'rebase') assert.notEqual(r.tip('master'), D, 'a rebase-merge rewrote the shas (the case this arm exists for)');
  });
}

test('#506 must-FAIL: the dependent delivered BEFORE its upstream is refused upstream-not-merged (exit 2) — no PR opened, no merge call', async (t) => {
  const r = rig(t);
  const U = r.branchWith('up', 'master', 'up.txt', 'u1\n');
  const D = r.branchWith('dep', 'up', 'dep.txt', 'd1\n');
  r.writeState(stateFor(U, D));
  const out = await deliver(opts('dep', 'DEP', D), r.mkdeps());
  assert.deepEqual([out.exit, out.result.verdict, out.result.reason], [2, 'refused', 'upstream-not-merged'], JSON.stringify(out.result));
  assert.equal(r.merges().length, 0);
  assert.equal(r.created().length, 0, 'nothing was opened for an out-of-order dependent');
});

test('#506 must-FAIL: upstream FIX ROUND after the dependent\'s PASS → the upstream merges at its new head → the dependent\'s deliver is refused upstream-changed, no merge', async (t) => {
  const r = rig(t);
  const U1 = r.branchWith('up', 'master', 'up.txt', 'u1\n');
  const D = r.branchWith('dep', 'up', 'dep.txt', 'd1\n'); // gated on U1
  r.writeState(stateFor(U1, D));
  r.g('checkout', '-q', 'up');
  const U2 = r.commit('up.txt', 'u1 fixed\n', 'fix round');
  r.push('up');
  const up = await deliver(opts('up', 'UP', U2), r.mkdeps());
  assert.equal(up.result.verdict, 'merged', JSON.stringify(up.result));
  const before = r.merges().length;
  const out = await deliver(opts('dep', 'DEP', D), r.mkdeps());
  assert.deepEqual([out.exit, out.result.verdict, out.result.reason], [2, 'refused', 'upstream-changed'], JSON.stringify(out.result));
  assert.match(out.result.detail ?? '', /verdict is void/);
  assert.equal(r.merges().length, before, 'the stale PASS never merges');
  // positive control, same rig: the dependent re-gated on a head built on U2 + builtOn re-recorded merges
  r.g('checkout', '-q', '-B', 'dep', 'origin/master');
  const D2 = r.commit('dep.txt', 'd1\n', 'dep rebased on the merged upstream');
  r.push('dep');
  r.writeState(stateFor(U2, D2, U2));
  const again = await deliver(opts('dep', 'DEP', D2), r.mkdeps());
  assert.equal(again.result.verdict, 'merged', JSON.stringify(again.result));
});

test('#506 content, not shas: the upstream merged at a DIFFERENT sha with the SAME tree (amend/rebase) is accepted; a different tree is refused', async (t) => {
  const r = rig(t);
  const U1 = r.branchWith('up', 'master', 'up.txt', 'u1\n');
  const D = r.branchWith('dep', 'up', 'dep.txt', 'd1\n');
  r.writeState(stateFor(U1, D));
  r.g('checkout', '-q', 'up');
  r.g('commit', '-q', '--amend', '-m', 'reworded only'); // same tree, new sha
  r.push('up');
  const U1b = r.tip('up');
  assert.notEqual(U1b, U1);
  assert.equal(r.sh('rev-parse', `${U1b}^{tree}`), r.sh('rev-parse', `${U1}^{tree}`));
  assert.equal((await deliver(opts('up', 'UP', U1b), r.mkdeps())).result.verdict, 'merged');
  const ok = await deliver(opts('dep', 'DEP', D), r.mkdeps());
  assert.equal(ok.result.verdict, 'merged', `same tree ⇒ same content: ${JSON.stringify(ok.result)}`);
});

test('#506 must-FAIL: the dependent\'s verified head does not sit on the upstream (rebuilt on the old master) → refused upstream-changed; one rebased onto the merged target is accepted', async (t) => {
  const r = rig(t);
  const U = r.branchWith('up', 'master', 'up.txt', 'u1\n');
  const D = r.branchWith('dep', 'up', 'dep.txt', 'd1\n');
  r.writeState(stateFor(U, D));
  assert.equal((await deliver(opts('up', 'UP', U), r.mkdeps())).result.verdict, 'merged');
  const Dold = r.branchWith('dep', 'refs/remotes/origin/master~1', 'dep.txt', 'd1\n'); // cut from master BEFORE the upstream merged: neither U nor its merge
  r.writeState(stateFor(U, Dold));
  const bad = await deliver(opts('dep', 'DEP', Dold), r.mkdeps());
  assert.deepEqual([bad.exit, bad.result.reason], [2, 'upstream-changed'], JSON.stringify(bad.result));
  assert.match(bad.result.detail ?? '', /does not sit on upstream UP/);
  assert.equal(r.merges().length, 1);
  const Dnew = r.branchWith('dep', 'origin/master', 'dep.txt', 'd1\n'); // rebased onto the merged target: contains the upstream's merge commit
  r.writeState(stateFor(U, Dnew));
  const good = await deliver(opts('dep', 'DEP', Dnew), r.mkdeps());
  assert.equal(good.result.verdict, 'merged', JSON.stringify(good.result));
});

test('#506 R1 fail closed: wrong --run / mistyped --ticket / no state at all are NOT a silent merge — exit 1 or a visible upstreamsChecked:false; mergedAccepted skipped; unreadable state is could-not-check', async (t) => {
  const r = rig(t);
  const U = r.branchWith('up', 'master', 'up.txt', 'u1\n');
  const D = r.branchWith('dep', 'up', 'dep.txt', 'd1\n');
  r.writeState(stateFor(U, D)); // UP is NOT merged: a dependent delivered now must never merge
  const typoRun = await deliver(opts('dep', 'DEP', D, { run: 'r-typo' }), r.mkdeps());
  assert.deepEqual([typoRun.exit, typoRun.result.verdict, typoRun.result.reason], [1, 'unchecked', 'bad-state'], JSON.stringify(typoRun.result));
  const typoTicket = await deliver(opts('dep', 'DEP-typo', D), r.mkdeps());
  assert.deepEqual([typoTicket.exit, typoTicket.result.reason], [1, 'bad-state'], JSON.stringify(typoTicket.result));
  assert.match(typoTicket.result.detail ?? '', /mistyped --ticket/);
  assert.equal(r.merges().length, 0, 'neither typo merged the out-of-order dependent');
  // no --run and nothing at the caller's own run (OPS vs LEAD run): legacy store-less, but VISIBLE
  const own = await deliver(opts('dep', 'DEP', D, { run: undefined }), r.mkdeps({ ORCHESTRA_WS_ID: 'some-other-workspace' }));
  assert.deepEqual([own.result.verdict, own.result.upstreamsChecked], ['merged', false], 'the JSON says the rule was NOT checked');
  // a state that names the ticket reports upstreamsChecked:true
  const r1 = rig(t);
  const U1 = r1.branchWith('up', 'master', 'up.txt', 'u1\n');
  const D1 = r1.branchWith('dep', 'up', 'dep.txt', 'd1\n');
  r1.writeState(stateFor(U1, D1));
  assert.equal((await deliver(opts('up', 'UP', U1), r1.mkdeps())).result.upstreamsChecked, true);
  // mergedAccepted on the upstream: nothing checked for it
  const r3 = rig(t);
  const U3 = r3.branchWith('up', 'master', 'up.txt', 'u1\n');
  const D3 = r3.branchWith('dep', 'up', 'dep.txt', 'd1\n');
  let s = stateFor(U3, D3);
  s = applyTicketPatch(s, 'UP', { status: 'merged', mergedAccepted: 'landed in the stacked base' }, NOW);
  r3.writeState(s);
  assert.equal((await deliver(opts('dep', 'DEP', D3), r3.mkdeps())).result.verdict, 'merged', 'the explicit human override is honoured');
  // unreadable state ⇒ could-not-check (exit 1), never "no upstreams"
  const r4 = rig(t);
  const D4 = r4.branchWith('dep', 'master', 'dep.txt', 'd1\n');
  fs.mkdirSync(path.dirname(stateFile(r4.home, 'r1')), { recursive: true });
  fs.writeFileSync(stateFile(r4.home, 'r1'), '{not json');
  const bad = await deliver(opts('dep', 'DEP', D4), r4.mkdeps());
  assert.deepEqual([bad.exit, bad.result.verdict, bad.result.reason], [1, 'unchecked', 'bad-state'], JSON.stringify(bad.result));
  assert.equal(r4.merges().length, 0);
});

test('#506 R3: a recorded upstream PR that is not merged into the target is THE answer — an older merged PR of a reused branch name never stands in for it', async (t) => {
  const r = rig(t);
  const U = r.branchWith('up', 'master', 'up.txt', 'u1\n');
  const D = r.branchWith('dep', 'up', 'dep.txt', 'd1\n');
  r.prs.push({ number: 5, branch: 'up', base: 'master', state: 'MERGED', head: 'f'.repeat(40) });
  r.prs.push({ number: 9, branch: 'up', base: 'other-base', state: 'OPEN' }); // recorded PR: not on the target, so absent from `pr list --base master`
  let s = stateFor(U, D);
  s = applyTicketPatch(s, 'UP', { pr: 9 }, NOW);
  r.writeState(s);
  const out = await deliver(opts('dep', 'DEP', D), r.mkdeps());
  assert.deepEqual([out.exit, out.result.reason], [2, 'upstream-not-merged'], JSON.stringify(out.result));
  assert.equal(r.merges().length, 0);
});

test('#506: an upstream whose merge cannot be read (gh fails) is could-not-check (exit 1), never merged and never "no upstream"', async (t) => {
  const r = rig(t);
  const U = r.branchWith('up', 'master', 'up.txt', 'u1\n');
  const D = r.branchWith('dep', 'up', 'dep.txt', 'd1\n');
  r.writeState(stateFor(U, D));
  assert.equal((await deliver(opts('up', 'UP', U), r.mkdeps())).result.verdict, 'merged');
  const failing: DeliverDeps = { ...r.mkdeps(), gh: async (a) => (a[0] === 'api' && /compare/.test(a[1]) ? { code: 1, stdout: '', stderr: 'HTTP 502' } : r.gh(a)) };
  const out = await deliver(opts('dep', 'DEP', D), failing);
  assert.deepEqual([out.exit, out.result.verdict, out.result.reason], [1, 'unchecked', 'gh-failed'], JSON.stringify(out.result));
});

test('#506 rebase-merge rewrote the upstream\'s shas: a dependent rebuilt on the merged target sits on the upstream\'s MERGE COMMIT (its built-on sha is not an ancestor); one cut before the merge is refused', async (t) => {
  const r = rig(t);
  const U = r.branchWith('up', 'master', 'up.txt', 'u1\n');
  r.g('checkout', '-q', 'master'); r.commit('hotfix.txt', 'h\n', 'master moved'); r.g('push', '-q', 'origin', 'master');
  const Dold = r.branchWith('dep', 'up', 'dep.txt', 'd1\n');
  r.writeState(stateFor(U, Dold));
  const up = await deliver(opts('up', 'UP', U, { strategy: 'rebase' }), r.mkdeps());
  assert.equal(up.result.verdict, 'merged', JSON.stringify(up.result));
  const merged = r.tip('master');
  assert.notEqual(merged, U, 'the target holds a REWRITTEN upstream commit');
  const Dnew = r.branchWith('dep', 'origin/master', 'dep.txt', 'd1\n'); // rebuilt on the merged target: contains the rewritten commit, NOT the built-on sha
  r.g('fetch', '-q', 'origin');
  assert.throws(() => r.sh('merge-base', '--is-ancestor', U, Dnew), 'built-on sha is not an ancestor of the rebuilt head');
  r.writeState(stateFor(U, Dnew));
  const good = await deliver(opts('dep', 'DEP', Dnew, { strategy: 'rebase' }), r.mkdeps());
  assert.equal(good.result.verdict, 'merged', JSON.stringify(good.result));
  const r2 = rig(t);
  const U2 = r2.branchWith('up', 'master', 'up.txt', 'u1\n');
  r2.g('checkout', '-q', 'master'); r2.commit('hotfix.txt', 'h\n', 'master moved'); r2.g('push', '-q', 'origin', 'master');
  const Dcut = r2.branchWith('dep', 'refs/remotes/origin/master', 'dep.txt', 'd1\n'); // cut before the upstream merged
  r2.writeState(stateFor(U2, Dcut));
  assert.equal((await deliver(opts('up', 'UP', U2, { strategy: 'rebase' }), r2.mkdeps())).result.verdict, 'merged');
  const bad = await deliver(opts('dep', 'DEP', Dcut, { strategy: 'rebase' }), r2.mkdeps());
  assert.deepEqual([bad.exit, bad.result.reason], [2, 'upstream-changed'], JSON.stringify(bad.result));
});

test('#506 review: upstream fix round, merged; dependent rebuilt on the merged target but builtOn still the old head → merges (the head contains the merge commit)', async (t) => {
  const r = rig(t);
  const U1 = r.branchWith('up', 'master', 'up.txt', 'u1\n');
  const D = r.branchWith('dep', 'up', 'dep.txt', 'd1\n');
  r.writeState(stateFor(U1, D));
  r.g('checkout', '-q', 'up');
  const U2 = r.commit('up.txt', 'u1 fixed\n', 'fix round');
  r.push('up');
  assert.equal((await deliver(opts('up', 'UP', U2), r.mkdeps())).result.verdict, 'merged');
  const stale = await deliver(opts('dep', 'DEP', D), r.mkdeps());
  assert.equal(stale.result.reason, 'upstream-changed');
  const D2 = r.branchWith('dep', 'origin/master', 'dep.txt', 'd1\n'); // re-gated on the merged target; builtOn left at U1
  const st = stateFor(U2, D2, U2);
  r.writeState({ ...st, tickets: { ...st.tickets, DEP: { ...st.tickets.DEP, builtOn: { UP: U1 } } } }); // stale builtOn: what a re-gate without re-recording leaves
  const out = await deliver(opts('dep', 'DEP', D2), r.mkdeps());
  assert.equal(out.result.verdict, 'merged', JSON.stringify(out.result));
});

test('#506 review: the upstream PR is picked by its recorded number, not by an older merged PR of the same branch name', async (t) => {
  const r = rig(t);
  const U = r.branchWith('up', 'master', 'up.txt', 'u1\n');
  const D = r.branchWith('dep', 'up', 'dep.txt', 'd1\n');
  r.prs.push({ number: 5, branch: 'up', base: 'master', state: 'MERGED', head: 'f'.repeat(40) }); // an old merged PR of a reused branch name
  r.prs.push({ number: 9, branch: 'up', base: 'master', state: 'OPEN' });
  let s = stateFor(U, D);
  s = applyTicketPatch(s, 'UP', { pr: 9 }, NOW);
  r.writeState(s);
  const out = await deliver(opts('dep', 'DEP', D), r.mkdeps());
  assert.deepEqual([out.exit, out.result.reason], [2, 'upstream-not-merged'], JSON.stringify(out.result));
});
