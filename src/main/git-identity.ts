import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Workspace } from '../shared/types';
import { isScratchLike } from '../shared/types.ts';
import { scoped } from './logger.ts';

// #513 — every worktree an agent works in carries the human owner's git author AND committer identity in its OWN
// config (`config.worktree`), so a commit never depends on the process HOME: under a scratch HOME git refuses
// ("Author identity unknown") and the agent improvises one, which later costs an authorship rewrite + re-gate.
// The identity is whatever git resolves for the REPO in the host's own config (global / includeIf / repo-local) — never hardcoded.

const pexec = promisify(execFile);
const glog = scoped('git-identity');

/** Name+email, then the optional author/committer overrides: copied only when the repo resolves them, so a split
 *  committer the human configured survives into the worktree. user.* are mandatory (both or nothing). */
export const IDENTITY_KEYS = ['user.name', 'user.email', 'author.name', 'author.email', 'committer.name', 'committer.email'] as const;

export interface WorktreeIdentityResult {
  /** keys written into the worktree's config by this call */
  applied: string[];
  /** keys the worktree already carried (explicit identity or an earlier call) — never overwritten */
  kept: string[];
  /** set when nothing could be applied */
  skipped?: 'no-identity' | 'not-a-worktree' | 'unsupported-repo' | 'error';
  error?: string;
}

// Inherit the host env (tests point GIT_CONFIG_GLOBAL at a scratch file) minus the vars that would redirect `-C`.
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[k];
  return env;
}

/** `git config --get`: the value, or null when the key is absent (exit 1). Any other failure throws. */
async function getConfig(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await pexec('git', ['-C', cwd, 'config', ...args], { env: gitEnv() });
    const v = stdout.replace(/\r?\n$/, '');
    return v === '' ? null : v;
  } catch (e) {
    if ((e as { code?: number }).code === 1) return null;
    throw e;
  }
}

// Concurrent spawns (and other processes) all want to set the shared flag; git's config.lock makes the losers fail — re-check (someone else may have
// won) and retry with a short backoff instead of failing the spawn.
async function enableWorktreeConfig(repoPath: string): Promise<boolean> {
  if ((await getConfig(repoPath, ['--get', 'extensions.worktreeConfig'])) === 'true') return true;
  // A bare repo / a `core.worktree` must move to config.worktree before the extension is on (git-worktree(1)) — not our job: refuse.
  if ((await getConfig(repoPath, ['--bool', '--get', 'core.bare'])) === 'true') return false;
  if ((await getConfig(repoPath, ['--get', 'core.worktree'])) !== null) return false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await pexec('git', ['-C', repoPath, 'config', 'extensions.worktreeConfig', 'true'], { env: gitEnv() });
      return true;
    } catch (e) {
      if ((await getConfig(repoPath, ['--get', 'extensions.worktreeConfig'])) === 'true') return true; // another process won the race
      if (attempt === 4) throw e;
      await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
    }
  }
  return false;
}

/** Pin the human's identity into `worktreePath`'s own config. Idempotent; a key the worktree already carries is kept, never overwritten.
 *  Never throws — an identity that cannot be applied must not fail a spawn (it is logged and reported). */
export async function ensureWorktreeGitIdentity(repoPath: string, worktreePath: string): Promise<WorktreeIdentityResult> {
  const result: WorktreeIdentityResult = { applied: [], kept: [] };
  try {
    if (!repoPath || !worktreePath || !existsSync(worktreePath)) return { ...result, skipped: 'not-a-worktree' };
    if (path.resolve(realpathSync(repoPath)) === path.resolve(realpathSync(worktreePath))) return { ...result, skipped: 'not-a-worktree' };
    // 1. What git itself resolves for the REPO (host config), not for the worktree path: an `includeIf gitdir:` keyed on the repo's location must still win.
    const wanted: Array<[string, string]> = [];
    for (const key of IDENTITY_KEYS) {
      const v = await getConfig(repoPath, ['--get', key]);
      if (v !== null) wanted.push([key, v]);
    }
    if (!wanted.some(([k]) => k === 'user.name') || !wanted.some(([k]) => k === 'user.email')) return { ...result, skipped: 'no-identity' };
    // 2. Per-worktree config is an opt-in repo extension; flip it once (idempotent) — without it `--worktree` is refused with several worktrees.
    const enabled = await enableWorktreeConfig(repoPath);
    if (!enabled) return { ...result, skipped: 'unsupported-repo' };
    // 3. Per key: keep what the worktree already carries, write the rest.
    for (const [key, value] of wanted) {
      if ((await getConfig(worktreePath, ['--worktree', '--get', key])) !== null) {
        result.kept.push(key);
        continue;
      }
      await pexec('git', ['-C', worktreePath, 'config', '--worktree', key, value], { env: gitEnv() });
      result.applied.push(key);
    }
    return result;
  } catch (e) {
    const msg = (e as Error).message?.split('\n')[0] ?? String(e);
    glog.warn(`could not pin the git identity in ${worktreePath}: ${msg}`);
    return { ...result, skipped: 'error', error: msg };
  }
}

/** The per-workspace entry every lifecycle path calls: only a local git worktree gets an identity (scratch / orchestrator-without-repo have no
 *  git; a sandbox workspace's checkout lives in its container). */
export async function ensureWorkspaceGitIdentity(
  ws: Pick<Workspace, 'kind' | 'repoPath' | 'worktreePath' | 'host'>,
): Promise<WorktreeIdentityResult | null> {
  if (isScratchLike(ws) || !ws.repoPath || ws.host?.kind === 'sandbox') return null;
  return ensureWorktreeGitIdentity(ws.repoPath, ws.worktreePath);
}
