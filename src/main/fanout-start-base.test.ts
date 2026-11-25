// #599 — `fanout start` with the REAL worktree chokepoint (createWorktree, scratch git repos): a run whose target branch lives in another repository than the agents' worktrees starts every ticket in one
// call (on master the first call was `started []`, 3 of 3 `fatal: not a valid object name: bench/<run>`); a same-repo run is cut from its target; a missing same-repo target is refused once, before any worktree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorktree, refResolves } from './git.ts';
import { newState, writeStateAtomic, stateFile, applyTicketPatch, type FanoutState } from '../shared/fanout-state.ts';
import { startRun, type StartDeps } from '../shared/fanout-start.ts';

const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const NOW = '2026-11-25T10:00:00.000Z';

function scratch(t: { after: (fn: () => void) => void }): { root: string; repo: string; home: string } {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'fanout-base-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'metarepo'), home = path.join(root, 'home');
  fs.mkdirSync(home);
  git(root, 'init', '-q', '-b', 'master', repo);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't']]) git(repo, 'config', k, v);
  fs.writeFileSync(path.join(repo, 'a'), '1'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
  return { root, repo, home };
}

/** The planned state (A, B, C) written to disk. */
function writePlan(home: string, init: { target: string; repo: string | null }): void {
  let s: FanoutState = newState('r1', { ...init, switches: { seatRecords: 'on' }, now: NOW });
  s = { ...s, plan: { tickets: ['A', 'B', 'C'], declaredAt: NOW } } as FanoutState;
  for (const id of ['A', 'B', 'C']) s = applyTicketPatch(s, id, { spec: `ledger §${id}`, dependsOn: [] }, NOW);
  writeStateAtomic(stateFile(home, 'r1'), s);
}

/** deps = production's shape: worktree base = `input.baseBranch || repo.defaultBranch` (workspaces.ts createWorkspace), the real git for the branch + worktree, the real ref check. */
function deps(root: string, home: string, repo: string, slug: string): StartDeps {
  let n = 0;
  return {
    home, now: () => NOW, implementerLive: () => false,
    repoPath: () => repo,
    worktreeRepo: () => ({ remote: slug, defaultBranch: 'master' }),
    refExists: ({ repoPath, ref }) => refResolves(repoPath!, ref),
    spawn: async (i) => {
      try {
        const branch = i.name, wt = path.join(root, `wt-${++n}`);
        await createWorktree(i.repoPath!, branch, i.baseBranch || 'master', wt);
        return { ok: true, id: `ws-${n}`, branch };
      } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    },
  };
}

test('#599 cross-repo run (target bench/run-7 of another repo): one call starts all three, each worktree cut from the repo default branch', async (t) => {
  const { root, repo, home } = scratch(t);
  writePlan(home, { target: 'bench/run-7', repo: 'mobile-club/workspace' });
  const r = await startRun('r1', 'r1', deps(root, home, repo, 'git@github.com:mobile-club/metarepo.git'));
  assert.deepEqual(r.failed, [], 'no "not a valid object name"');
  assert.deepEqual(r.started.map((s) => s.ticket), ['A', 'B', 'C']);
  for (const [i] of r.started.entries()) assert.equal(git(path.join(root, `wt-${i + 1}`), 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'master'));
  assert.equal(git(repo, 'branch', '--list', 'bench/run-7'), '', 'no branch was invented in the worktree repo');
});

test('#599 same-repo run: the worktree is cut from the run target (not the default branch); the target is a ref of this repo', async (t) => {
  const { root, repo, home } = scratch(t);
  git(repo, 'checkout', '-q', '-b', 'feat/x'); fs.writeFileSync(path.join(repo, 'b'), '2'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'x'); git(repo, 'checkout', '-q', 'master');
  writePlan(home, { target: 'feat/x', repo: 'mobile-club/metarepo' });
  const d = deps(root, home, repo, 'https://github.com/mobile-club/metarepo');
  const r = await startRun('r1', 'r1', d);
  assert.deepEqual(r.failed, []); assert.equal(r.started.length, 3);
  assert.equal(git(path.join(root, 'wt-1'), 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'feat/x'));
  assert.notEqual(git(repo, 'rev-parse', 'feat/x'), git(repo, 'rev-parse', 'master'));
});

test('#599 must-FAIL: a same-repo target that does not exist is refused ONCE naming it, before any worktree or branch exists', async (t) => {
  const { root, repo, home } = scratch(t);
  writePlan(home, { target: 'feat/gone', repo: 'mobile-club/metarepo' });
  await assert.rejects(() => startRun('r1', 'r1', deps(root, home, repo, 'https://github.com/mobile-club/metarepo')), (e: Error) => /\[start-base-missing\].*feat\/gone/.test(e.message));
  assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1, 'no worktree');
  assert.equal(git(repo, 'branch', '--list', 'impl-*'), '', 'no branch');
});
