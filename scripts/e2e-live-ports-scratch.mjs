#!/usr/bin/env node
// #614 — ONE REAL PR-HOST EXERCISE of the live ports, on a SCRATCH repository (never lcsmas/orchestra, never a bench): the start-check probe (empty branch → PR → checks → close → branch deleted), a PR whose CI is red once (a flaky job)
// → the red check named with its log extract → ONE re-run of the red job (its job id CHANGES) → green → the merge, through the shipped `deliver` with a recorded approval, as a MERGE COMMIT (two parents) — and, on a second PR, the head that moved
// after the approval is refused. Scratch HOME, scratch clone. LOCAL_ONLY (needs `gh` auth + network): .github/ci-rigs.json.
//   ORCHESTRA_SCRATCH_REPO=owner/scratch-… node --experimental-strip-types scripts/e2e-live-ports-scratch.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.ORCHESTRA_SCRATCH_REPO ?? '';
if (!/^[\w.-]+\/[\w.-]*scratch[\w.-]*$/i.test(REPO) || /\/orchestra$/i.test(REPO)) { console.error('set ORCHESTRA_SCRATCH_REPO=<owner>/<name containing "scratch"> — this rig never runs on a repository that is not an explicit scratch one'); process.exit(1); }
const mod = (f) => import(path.join(ROOT, f));
const { createLiveGit } = await mod('src/shared/fanout-loop-live-git.ts');
const { createLiveForge } = await mod('src/shared/fanout-loop-live-forge.ts');
const { mergeThroughDeliver } = await mod('src/cli/fanout-run-live.ts');
const st = await mod('src/shared/fanout-state.ts');
const rv = await mod('src/shared/fanout-review.ts');
const rec = await mod('src/shared/fanout-record.ts');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'live-ports-home-'));
const work = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'live-ports-clone-')), 'repo');
const exec = (cmd, args, cwd = work) => { const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } }); return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; };
const sh = (cmd, args, cwd = work) => { const r = exec(cmd, args, cwd); if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr.trim()}`); return r.stdout.trim(); };
const g = (...a) => sh('git', ['-c', 'user.name=scratch', '-c', 'user.email=scratch@localhost', ...a]);
const gh = async (args) => exec('gh', args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`); };
async function until(what, fn, ms = 360_000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(8_000); } }

fs.mkdirSync(path.dirname(work), { recursive: true });
sh('gh', ['repo', 'clone', REPO, work], os.tmpdir());
if (exec('git', ['rev-parse', '--verify', 'origin/main']).code !== 0) { // an empty scratch repository: seed it with the CI
  g('checkout', '-q', '-b', 'main');
  fs.mkdirSync(path.join(work, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(work, '.github/workflows/ci.yml'), `name: ci
on: { pull_request: {}, push: { branches: [main] } }
jobs:
  build: { runs-on: ubuntu-latest, steps: [ { run: echo build } ] }
  lint: { runs-on: ubuntu-latest, steps: [ { run: echo lint } ] }
  test:
    runs-on: ubuntu-latest
    steps:
      - run: |
          if [ "\${{ github.run_attempt }}" = "1" ] && [ "\${{ contains(github.head_ref, 'flaky') }}" = "true" ]; then echo "FAIL flaky test: expected 1 to equal 2"; exit 1; fi
          echo ok
`);
  g('add', '.'); g('commit', '-q', '-m', 'scratch ci'); g('push', '-q', 'origin', 'main');
}
g('fetch', '-q', 'origin');
g('checkout', '-q', '-B', 'main', 'origin/main');

const git = createLiveGit({ git: async (args) => exec('git', ['-c', 'user.name=scratch', '-c', 'user.email=scratch@localhost', ...args]) });
const forge = createLiveForge({ gh, repo: REPO, deliver: undefined });
const tag = Date.now().toString(36);

// 1 ── the start-check probe: an empty PR, its checks awaited, closed, the branch deleted
const probe = `orchestra-start-check-${tag}`;
const e = await git.emptyBranch(probe, 'main');
check('emptyBranch: pushed, the same tree as main', (await git.tree(e.head)) === (await git.tree(await git.head('main'))), `${e.head}`);
check('emptyBranch: idempotent', (await git.emptyBranch(probe, 'main')).head === e.head);
const pp = await forge.openPr({ branch: probe, base: 'main', title: `[orchestra] start check ${tag} — empty, do not merge` });
check('openPr: idempotent per branch', (await forge.openPr({ branch: probe, base: 'main', title: 'again' })).n === pp.n);
const probeChecks = await until('probe checks', async () => { const c = await forge.checks(pp.n, e.head); return c.length >= 3 && c.every((x) => x.status !== 'pending') ? c : null; });
check('checks: three jobs, all green, each with a job id and a finish time', probeChecks.every((c) => c.status === 'green' && c.jobId && c.at), JSON.stringify(probeChecks));
await forge.close(pp.n);
await git.deleteBranch(probe);
check('close + deleteBranch: the PR is closed and the branch gone', (await forge.prState(pp.n)).state === 'closed' && (await git.head(probe)) === null);

// 2 ── a PR whose CI is red once (flaky): named + extract → one re-run → job id changed → green → merged through deliver as a merge commit
const flaky = `flaky-${tag}`;
g('checkout', '-q', '-b', flaky, 'main'); fs.writeFileSync(path.join(work, `${flaky}.txt`), 'x\n'); g('add', '.'); g('commit', '-q', '-m', flaky); g('push', '-q', 'origin', flaky);
const head = g('rev-parse', 'HEAD');
const pr = await forge.openPr({ branch: flaky, base: 'main', title: `T1: ${flaky}` });
const red = await until('red check', async () => { const c = await forge.checks(pr.n, head); return c.length >= 3 && c.every((x) => x.status !== 'pending') ? c : null; });
const bad = red.filter((c) => c.status === 'red');
check('checks: the flaky job is the ONE red check, named, with the log extract', bad.length === 1 && bad[0].name === 'test' && /FAIL flaky/.test(bad[0].logExtract ?? ''), JSON.stringify(red));
await forge.rerun(pr.n, ['test']);
const after = await until('re-run', async () => { const c = await forge.checks(pr.n, head); const t = c.find((x) => x.name === 'test'); return t && t.status !== 'pending' && t.jobId !== bad[0].jobId && c.every((x) => x.status !== 'pending') ? c : null; });
check('rerun: the red job re-ran green and its job id CHANGED', after.every((c) => c.status === 'green') && after.find((c) => c.name === 'test').jobId !== bad[0].jobId, `${bad[0].jobId} → ${after.find((c) => c.name === 'test')?.jobId}`);

// the recorded approval + the run state `deliver` reads (scratch home), then the merge THROUGH deliver
const runOf = (id) => `scratch-run-${id}`; // one ticket per run: the plan of a run is frozen at its first nomination
const treeOf = sh('gh', ['api', `repos/${REPO}/commits/${head}`, '--jq', '.commit.tree.sha']);
const NOW = new Date().toISOString();
const seed = (id, branch, h, n, tree) => st.updateState(st.stateFile(home, runOf(id)), (cur) => {
  let s = cur ?? st.setPlan(st.newState(runOf(id), { target: 'main', repo: REPO, switches: { seatRecords: 'on', minorPolicy: 'demonstrated', verifier: 'off' }, now: NOW }), [id], 'declare', NOW);
  s = st.applyTicketPatch(s, id, { dependsOn: [], spec: 's', branch, head: h, pr: n, status: 'nominated' }, NOW, { tree });
  s = rv.settleReviewer(rv.claimReviewer(s, id, { kind: 'spawn', name: rv.reviewerName(id, 1), head: h, base: null, text: 'brief', now: NOW }), id, { id: `ws-rev-${id}` }, NOW);
  return rec.recordReview(s, id, { head: h, verdict: 'approve', input: { findings: {}, fixed: [] }, callerId: `ws-rev-${id}`, callerVouched: true, tree, now: NOW });
});
seed('T1', flaky, head, pr.n, treeOf);
const via = (id) => createLiveForge({ gh, repo: REPO, deliver: mergeThroughDeliver({ home, run: runOf(id), log: (l) => console.log(`  deliver: ${l}`) }) });
const viaDeliver = via('T1');
const merged = await viaDeliver.merge(pr.n, head, 'merge');
check('merge through deliver: ok', merged.ok === true, JSON.stringify(merged));
const mc = JSON.parse(sh('gh', ['pr', 'view', String(pr.n), '--repo', REPO, '--json', 'state,mergeCommit'])) ;
const parents = JSON.parse(sh('gh', ['api', `repos/${REPO}/commits/${mc.mergeCommit.oid}`, '--jq', '.parents | length']));
check('merge: the PR reads merged and its commit is a MERGE COMMIT (two parents)', (await forge.prState(pr.n)).state === 'merged' && parents === 2, `parents=${parents}`);

// 3 ── the head moved after the approval: refused, nothing merged
const moved = `moved-${tag}`;
g('checkout', '-q', '-b', moved, 'origin/main'); fs.writeFileSync(path.join(work, `${moved}.txt`), '1\n'); g('add', '.'); g('commit', '-q', '-m', moved); g('push', '-q', 'origin', moved);
const h1 = g('rev-parse', 'HEAD');
const pr2 = await forge.openPr({ branch: moved, base: 'main', title: `T2: ${moved}` });
await until('moved CI', async () => { const c = await forge.checks(pr2.n, h1); return c.length >= 3 && c.every((x) => x.status === 'green') ? c : null; });
seed('T2', moved, h1, pr2.n, sh('gh', ['api', `repos/${REPO}/commits/${h1}`, '--jq', '.commit.tree.sha']));
fs.writeFileSync(path.join(work, `${moved}.txt`), '2\n'); g('commit', '-q', '-am', 'moves'); g('push', '-q', 'origin', moved);
const refused = await via('T2').merge(pr2.n, h1, 'merge');
check('merge: a head that moved after the approval is refused (nothing merged)', refused.ok === false && (await forge.prState(pr2.n)).state === 'open', JSON.stringify(refused));
await forge.close(pr2.n);
sh('git', ['push', '-q', 'origin', '--delete', moved, flaky]);

fs.rmSync(home, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} arms passed`);
process.exit(failed.length ? 1 : 0);
