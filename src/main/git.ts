import { simpleGit } from 'simple-git';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DiffFile, DiffStats } from '../shared/types';

const pexec = promisify(execFile);

export async function detectDefaultBranch(repoPath: string): Promise<string> {
  const git = simpleGit(repoPath);
  try {
    const res = await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD']);
    return res.trim().replace('refs/remotes/origin/', '');
  } catch {
    // Fall through.
  }
  for (const b of ['main', 'master', 'develop']) {
    try {
      await git.revparse(['--verify', b]);
      return b;
    } catch {
      /* next */
    }
  }
  return 'main';
}

export async function isGitRepo(p: string): Promise<boolean> {
  try {
    const git = simpleGit(p);
    await git.revparse(['--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

export async function getRepoName(repoPath: string): Promise<string> {
  return path.basename(repoPath);
}

export async function listBranches(repoPath: string): Promise<string[]> {
  const git = simpleGit(repoPath);
  try {
    const res = await git.branchLocal();
    return res.all.slice().sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export async function switchWorktreeBranch(
  worktreePath: string,
  branch: string,
): Promise<void> {
  const git = simpleGit(worktreePath);
  await git.raw(['switch', branch]);
}

/** Rename the branch checked out in `worktreePath` and move the worktree
 * directory to `newWorktreePath`. Uses `git worktree move` so gitdir refs
 * stay consistent. Returns silently if the branch is already named. */
export async function renameWorktreeBranch(
  worktreePath: string,
  newWorktreePath: string,
  oldBranch: string,
  newBranch: string,
): Promise<void> {
  const wtGit = simpleGit(worktreePath);
  // Rename the branch ref first so `git worktree move` records the right name.
  if (oldBranch !== newBranch) {
    // `branch -m <old> <new>` works from any worktree of the repo.
    await wtGit.raw(['branch', '-m', oldBranch, newBranch]);
  }
  if (worktreePath !== newWorktreePath) {
    // `git worktree move` must be run from a different worktree (usually the
    // main repo). Find the main repo path via `git worktree list`.
    const mainRepo = await findMainRepo(worktreePath);
    const repoGit = simpleGit(mainRepo);
    await repoGit.raw(['worktree', 'move', worktreePath, newWorktreePath]);
  }
}

async function findMainRepo(worktreePath: string): Promise<string> {
  const git = simpleGit(worktreePath);
  const out = await git.raw(['worktree', 'list', '--porcelain']);
  // First `worktree <path>` entry is the main working tree.
  const first = out.split('\n').find((l) => l.startsWith('worktree '));
  if (!first) throw new Error('could not locate main repo for worktree');
  const mainPath = first.slice('worktree '.length).trim();
  if (mainPath === worktreePath) {
    // We are the main worktree — pick any other linked worktree, else error.
    const lines = out.split('\n').filter((l) => l.startsWith('worktree '));
    const other = lines.map((l) => l.slice('worktree '.length).trim()).find((p) => p !== worktreePath);
    if (!other) throw new Error('cannot move the only worktree');
    return other;
  }
  return mainPath;
}

export async function createWorktree(
  repoPath: string,
  branch: string,
  baseBranch: string,
  worktreePath: string,
): Promise<void> {
  const git = simpleGit(repoPath);
  // Create branch from base, then worktree.
  const branches = await git.branchLocal();
  if (!branches.all.includes(branch)) {
    await git.raw(['branch', branch, baseBranch]);
  }
  await git.raw(['worktree', 'add', worktreePath, branch]);
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  const git = simpleGit(repoPath);
  try {
    await git.raw(['worktree', 'remove', '--force', worktreePath]);
  } catch {
    if (existsSync(worktreePath)) await rm(worktreePath, { recursive: true, force: true });
  }
}

export async function getDiff(worktreePath: string, _baseBranch: string): Promise<DiffFile[]> {
  const git = simpleGit(worktreePath);
  // Uncommitted-only diff: compare working tree + index against HEAD, plus
  // untracked files. Anything already committed to the branch does not appear.
  const workingStat = await safeRaw(git, ['diff', '--numstat', 'HEAD']);
  const untracked = await safeRaw(git, ['ls-files', '--others', '--exclude-standard']);

  const fileMap = new Map<string, DiffFile>();

  const parseNumstat = (raw: string) => {
    for (const line of raw.split('\n').filter(Boolean)) {
      const [addsStr, delsStr, file] = line.split('\t');
      if (!file) continue;
      const prev = fileMap.get(file);
      const additions = (prev?.additions ?? 0) + (addsStr === '-' ? 0 : Number(addsStr || 0));
      const deletions = (prev?.deletions ?? 0) + (delsStr === '-' ? 0 : Number(delsStr || 0));
      fileMap.set(file, {
        path: file,
        status: prev?.status ?? 'modified',
        additions,
        deletions,
        oldContent: '',
        newContent: '',
      });
    }
  };

  parseNumstat(workingStat);

  for (const f of untracked.split('\n').filter(Boolean)) {
    fileMap.set(f, {
      path: f,
      status: 'added',
      additions: 0,
      deletions: 0,
      oldContent: '',
      newContent: '',
    });
  }

  const out: DiffFile[] = [];
  for (const f of fileMap.values()) {
    const oldContent = await safeShow(git, `HEAD:${f.path}`);
    const newContent = await safeShow(git, `:${f.path}`); // index
    const workingContent = await readWorking(worktreePath, f.path);
    out.push({
      ...f,
      oldContent: truncate(oldContent),
      newContent: truncate(workingContent || newContent),
      status:
        oldContent && !workingContent && !newContent
          ? 'deleted'
          : !oldContent
            ? 'added'
            : 'modified',
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function getDiffStats(
  worktreePath: string,
  _baseBranch: string,
): Promise<DiffStats> {
  const git = simpleGit(worktreePath);
  const working = await safeRaw(git, ['diff', '--numstat', 'HEAD']);
  const untracked = await safeRaw(git, ['ls-files', '--others', '--exclude-standard']);

  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;

  const parse = (raw: string) => {
    for (const line of raw.split('\n').filter(Boolean)) {
      const [addsStr, delsStr, file] = line.split('\t');
      if (!file) continue;
      files.add(file);
      additions += addsStr === '-' ? 0 : Number(addsStr || 0);
      deletions += delsStr === '-' ? 0 : Number(delsStr || 0);
    }
  };
  parse(working);
  for (const f of untracked.split('\n').filter(Boolean)) files.add(f);

  return { additions, deletions, files: files.size };
}

async function safeRaw(git: ReturnType<typeof simpleGit>, args: string[]): Promise<string> {
  try {
    return await git.raw(args);
  } catch {
    return '';
  }
}

async function safeShow(git: ReturnType<typeof simpleGit>, ref: string): Promise<string> {
  try {
    return await git.raw(['show', ref]);
  } catch {
    return '';
  }
}

async function readWorking(worktreePath: string, file: string): Promise<string> {
  try {
    const { readFile } = await import('node:fs/promises');
    return await readFile(path.join(worktreePath, file), 'utf8');
  } catch {
    return '';
  }
}

function truncate(s: string, max = 300_000): string {
  if (s.length > max) return s.slice(0, max) + '\n\n... (truncated by Orchestra) ...\n';
  return s;
}

export async function commitAll(worktreePath: string, message: string): Promise<void> {
  const git = simpleGit(worktreePath);
  await git.add('.');
  await git.commit(message);
}

export async function pushBranch(worktreePath: string, branch: string): Promise<void> {
  const git = simpleGit(worktreePath);
  await git.push(['-u', 'origin', branch]);
}

export async function createPullRequest(
  worktreePath: string,
  title: string,
  body: string,
  baseBranch: string,
): Promise<string> {
  const { stdout } = await pexec(
    'gh',
    ['pr', 'create', '--title', title, '--body', body, '--base', baseBranch],
    { cwd: worktreePath },
  );
  const url = stdout.trim().split('\n').pop() ?? '';
  return url;
}

export async function findPullRequest(
  worktreePath: string,
  branch: string,
): Promise<import('../shared/types').PRsForBranch> {
  try {
    const { stdout } = await pexec(
      'gh',
      [
        'pr',
        'list',
        '--head',
        branch,
        '--state',
        'all',
        '--json',
        'url,number,state,title',
        '--limit',
        '50',
      ],
      { cwd: worktreePath },
    );
    const all = JSON.parse(stdout.trim() || '[]') as Array<{
      url: string;
      number: number;
      state: 'OPEN' | 'CLOSED' | 'MERGED';
      title: string;
    }>;
    // gh returns newest-first.
    const open = all.find((p) => p.state === 'OPEN') ?? null;
    const latest = all[0] ?? null;
    const mergedCount = all.filter((p) => p.state === 'MERGED').length;
    return { all, open, latest, mergedCount };
  } catch {
    return { all: [], open: null, latest: null, mergedCount: 0 };
  }
}
