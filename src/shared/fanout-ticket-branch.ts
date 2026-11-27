// #683 — the loop owns the ticket branch name: it creates `impl-<ticket>` in the TARGET repo (from the target tip) before the implementer starts, the brief says how to check it out,
// and a `branch-gone` ticket whose branch exists under a separator twin (`impl/X` for `impl-X`) adopts it. Pure of Electron: `gh` is an injected runner.
import type { ExecResult } from './fanout-loop-live-git.ts';

export type GhRun = (args: string[]) => Promise<ExecResult>;

/** Two branch names that differ only by their separators (`/`, `-`, `_`) are the same name said twice. */
export const separatorKey = (b: string): string => b.replace(/[/_-]+/g, '-');

/** The remote branch that is `branch` under another separator (null = none, or `branch` itself exists). Several twins ⇒ the lexicographically first (deterministic). */
export function separatorTwin(branch: string, remoteBranches: readonly string[]): string | null {
  if (remoteBranches.includes(branch)) return null;
  const k = separatorKey(branch);
  return [...remoteBranches].filter((b) => separatorKey(b) === k).sort()[0] ?? null;
}

/** The exact commands the implementer runs in its clone of the target repo. */
export function ticketBranchCheckout(branch: string): string {
  return `git fetch origin ${branch} && git checkout -B ${branch} origin/${branch}`;
}

/** The brief's section: pure of any state, so the brief is byte-identical whether the loop created the branch now or found it already there. */
export function renderTicketBranchSection(i: { branch: string; targetRepo: string; target: string }): string[] {
  return [
    `Ticket branch: \`${i.branch}\` already exists on ${i.targetRepo}, cut by the loop from the tip of ${i.target}. In your clone of ${i.targetRepo} run exactly: \`${ticketBranchCheckout(i.branch)}\``,
    `You never create a branch there and you push to \`${i.branch}\` only: a push to any other name (\`impl/…\`, \`impl_…\`) is refused and the loop does not see it.`,
  ];
}

const SAFE_BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/** Create `branch` on `repo` from the tip of `target` unless it exists (idempotent: an existing branch is left as it is). Errors are thrown with gh's words. */
export async function ensureTicketBranch(i: { repo: string; target: string; branch: string; gh: GhRun }): Promise<{ created: boolean; head: string }> {
  if (!SAFE_BRANCH.test(i.branch) || !SAFE_BRANCH.test(i.target) || !/^[\w.-]+\/[\w.-]+$/.test(i.repo)) throw new Error(`ensureTicketBranch: refusing ${JSON.stringify({ repo: i.repo, target: i.target, branch: i.branch })}`);
  const sha = (r: ExecResult): string | null => { const s = r.stdout.trim(); return r.code === 0 && /^[0-9a-f]{40,64}$/.test(s) ? s : null; };
  const have = sha(await i.gh(['api', `repos/${i.repo}/git/ref/heads/${i.branch}`, '--jq', '.object.sha']));
  if (have) return { created: false, head: have };
  const tip = await i.gh(['api', `repos/${i.repo}/git/ref/heads/${i.target}`, '--jq', '.object.sha']);
  const base = sha(tip);
  if (!base) throw new Error(`cannot read the tip of ${i.repo}@${i.target}: ${(tip.stderr || tip.stdout).trim().slice(0, 200)}`);
  const made = await i.gh(['api', '-X', 'POST', `repos/${i.repo}/git/refs`, '-f', `ref=refs/heads/${i.branch}`, '-f', `sha=${base}`]);
  if (made.code !== 0) {
    const again = sha(await i.gh(['api', `repos/${i.repo}/git/ref/heads/${i.branch}`, '--jq', '.object.sha'])); // a concurrent creator won the race: adopt
    if (again) return { created: false, head: again };
    throw new Error(`cannot create ${i.branch} on ${i.repo}: ${(made.stderr || made.stdout).trim().slice(0, 200)}`);
  }
  return { created: true, head: base };
}
