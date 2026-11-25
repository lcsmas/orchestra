// #614 (spec #601, ledger #613) — the LIVE GitPort of the Boucle: real git behind an injected runner. Local refs win while nothing is pushed, `origin` takes over once it is ahead (a branch the author pushed and a local copy that never moved).
// Every read fails closed: an unreadable ref is `null` / `false`, a git error that is not "unknown object" throws (the loop ends `could not run`, never a guess).
import type { GitPort } from './fanout-loop-ports.ts';

export interface ExecResult { code: number; stdout: string; stderr: string }
/** A process behind a seam (argv, never a shell). Production: `execFile`; tests: a fake or the real binary in a temp repo. */
export type Exec = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<ExecResult>;

export interface LiveGitDeps {
  /** Runs `git` (the first argument is the subcommand). */
  git: (args: string[]) => Promise<ExecResult>;
  remote?: string;
  /** Fetch `origin` before reading a remote ref (default true; a rig with no network turns it off). */
  fetch?: boolean;
}

const SHA = /^[0-9a-f]{40,64}$/;
const SAFE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

export function createLiveGit(deps: LiveGitDeps): GitPort {
  const remote = deps.remote ?? 'origin';
  const out = async (args: string[]): Promise<string | null> => { const r = await deps.git(args); return r.code === 0 ? r.stdout.trim() : null; };
  const verify = async (ref: string): Promise<string | null> => { const o = await out(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); return o && SHA.test(o) ? o : null; };
  const isAncestor = async (a: string, b: string): Promise<boolean> => { const r = await deps.git(['merge-base', '--is-ancestor', a, b]); if (r.code === 0) return true; if (r.code === 1) return false; throw new Error(`git merge-base --is-ancestor failed (exit ${r.code}): ${r.stderr.trim().slice(0, 200)}`); };
  const refresh = async (branch: string): Promise<void> => { if (deps.fetch === false || !SAFE.test(branch)) return; await deps.git(['fetch', '--quiet', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]); }; // best effort: a missing remote branch is not an error

  /** A sha, a local branch or a remote branch → the commit it names. When both a local and a remote branch exist the one that CONTAINS the other wins (the newer); diverged → the remote's (what the forge shows). */
  async function resolve(ref: string): Promise<string | null> {
    if (SHA.test(ref)) return verify(ref);
    if (!SAFE.test(ref)) return null;
    await refresh(ref);
    const local = await verify(`refs/heads/${ref}`);
    const origin = await verify(`refs/remotes/${remote}/${ref}`);
    if (local && origin && local !== origin) return (await isAncestor(origin, local)) ? local : origin;
    return local ?? origin;
  }

  return {
    head: (branch) => resolve(branch),
    async tree(sha) {
      if (!SHA.test(sha) && !SAFE.test(sha)) return null;
      const c = await resolve(sha);
      if (!c) return null;
      const t = await out(['rev-parse', '--verify', '--quiet', `${c}^{tree}`]);
      return t && SHA.test(t) ? t : null;
    },
    async isMerged(branch, base) {
      const a = await resolve(branch);
      const b = await resolve(base);
      if (!a || !b) return false;
      return isAncestor(a, b);
    },
    async emptyBranch(branch, base) {
      if (!SAFE.test(branch)) throw new Error(`refusing a probe branch named ${JSON.stringify(branch)}`);
      const existing = await deps.git(['ls-remote', '--heads', remote, `refs/heads/${branch}`]); // idempotent: a killed start check's branch is adopted
      if (existing.code === 0 && existing.stdout.trim()) { const sha = existing.stdout.trim().split(/\s+/)[0]; if (SHA.test(sha)) return { head: sha }; }
      const b = await resolve(base);
      if (!b) throw new Error(`the base ${base} does not resolve here`);
      const commit = await out(['-c', 'user.name=orchestra', '-c', 'user.email=orchestra@localhost', 'commit-tree', `${b}^{tree}`, '-p', b, '-m', `orchestra start check (${branch}) — empty`]);
      if (!commit || !SHA.test(commit)) throw new Error('git commit-tree produced no commit');
      const push = await deps.git(['push', '--quiet', remote, `${commit}:refs/heads/${branch}`]);
      if (push.code !== 0) throw new Error(`git push of the probe branch failed: ${push.stderr.trim().slice(0, 300)}`);
      return { head: commit };
    },
    async deleteBranch(branch) {
      if (!SAFE.test(branch)) throw new Error(`refusing to delete a branch named ${JSON.stringify(branch)}`);
      const r = await deps.git(['push', '--quiet', remote, '--delete', branch]);
      if (r.code !== 0 && !/remote ref does not exist|unable to delete|not found/i.test(r.stderr)) throw new Error(`git push --delete ${branch} failed: ${r.stderr.trim().slice(0, 300)}`);
      await deps.git(['update-ref', '-d', `refs/heads/${branch}`]); // a local copy, when there is one; a missing one is fine
      await deps.git(['update-ref', '-d', `refs/remotes/${remote}/${branch}`]);
    },
  };
}
