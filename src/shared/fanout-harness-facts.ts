// #538 — the I/O half of the harness discovery: read the TARGET ref of the repo (never a worktree: an implementer's checkout holds its code). Never throws — null = could not inspect.
import { spawnSync } from 'node:child_process';
import type { RepoFacts } from './fanout-harness.ts';

const MAX_FILES = 50_000;

export function readRepoFacts(repoPath: string | undefined, target: string): RepoFacts | null {
  if (!repoPath || target.startsWith('-')) return null;
  const git = (args: string[]): string | null => {
    const r = spawnSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 5_000 });
    return r.status === 0 ? r.stdout : null;
  };
  for (const ref of [`origin/${target}`, target]) {
    if (git(['rev-parse', '--verify', '-q', `${ref}^{commit}`]) === null) continue;
    const list = git(['ls-tree', '-r', '--name-only', '-z', ref]);
    if (list === null) continue;
    return { files: list.split('\0').filter(Boolean).slice(0, MAX_FILES), packageJson: git(['show', `${ref}:package.json`]) };
  }
  return null;
}
