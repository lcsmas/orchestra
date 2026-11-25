// #614 (spec #601, ledger #613) — the LIVE ForgePort of the Boucle: the pull-request host through `gh` (argv, never a shell), behind an injected runner.
// A MERGE never goes around the shipped `deliver`: production wires `deliver` here, so every refusal of that verb (review verdict, CI, upstream order, acceptance, follow-up) is the loop's refusal. The bare `gh pr merge` below is
// only the fallback of a rig that has no run state; the CLI (src/cli/fanout-run-live.ts) never uses it.
import type { ForgeCheck, ForgePort } from './fanout-loop-ports.ts';
import type { ExecResult } from './fanout-loop-live-git.ts';
import { FanoutStateError } from './fanout-state.ts';
import { classifyMergeFailure, normaliseRollupItem, parseActionsJobUrl, type RollupItem } from './fanout-deliver.ts';

export type Gh = (args: string[]) => Promise<ExecResult>;
export interface MergeAnswer { ok: boolean; reason?: string; detail?: string }

export interface LiveForgeDeps {
  gh: Gh;
  /** `owner/name`; absent = the repository of the working directory. */
  repo?: string;
  /** The merge, through the shipped `deliver` (production). `reason` = deliver's refusal reason (`head-moved`, `ci-red`, `record-missing`, …). */
  deliver?: (i: { n: number; head: string }) => Promise<MergeAnswer>;
  /** Rigs only: merge with a bare `gh pr merge --merge --match-head-commit` (NO review / CI / upstream gate). Without `deliver` AND without this, `merge` refuses to run. */
  bareMerge?: true;
  /** The branch's current head (the git port's `head`): a MERGED pull request is adopted by `openPr` only when it is THIS head's (a reused branch name with an old merged PR gets a new one). */
  branchHead?: (branch: string) => Promise<string | null>;
  /** Pauses (re-run waits for the run to finish). Default: real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** A re-run needs its Actions run COMPLETED: wait this long for the run's other jobs (default 20 min, polled every 15 s). */
  rerunWaitMs?: number;
  /** Longest log extract kept for a red check (chars). */
  extractChars?: number;
}

type Row = RollupItem & { completedAt?: string; startedAt?: string };
const PR_STATES: Record<string, 'open' | 'merged' | 'closed'> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' };

export class GhError extends FanoutStateError {}

export function createLiveForge(deps: LiveForgeDeps): ForgePort & { /** the red-check runs a re-run would touch (rig/diagnostics) */ failedRuns(n: number, names: string[]): Promise<string[]> } {
  const repoArgs = deps.repo ? ['--repo', deps.repo] : [];
  const gh = async (args: string[]): Promise<string> => {
    const r = await deps.gh(args);
    if (r.code !== 0) throw new GhError(`gh ${args.slice(0, 2).join(' ')} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    return r.stdout;
  };
  const json = async <T>(args: string[]): Promise<T> => { const o = await gh(args); try { return JSON.parse(o) as T; } catch { throw new GhError(`gh ${args.slice(0, 2).join(' ')}: not JSON: ${o.slice(0, 120)}`); } };
  const extractChars = deps.extractChars ?? 2000;

  const view = (n: number): Promise<{ state: string; headRefOid: string; statusCheckRollup?: Row[] }> => json(['pr', 'view', String(n), '--json', 'state,headRefOid,statusCheckRollup', ...repoArgs]);

  async function rowsOf(n: number, head: string): Promise<Row[]> {
    const v = await view(n);
    if (!(v.headRefOid.startsWith(head) || head.startsWith(v.headRefOid))) return []; // the PR moved: these checks belong to another head
    return v.statusCheckRollup ?? [];
  }
  const nameOf = (r: Row): string => r.name ?? r.context ?? 'unnamed-check';
  const statusOf = (r: Row): ForgeCheck['status'] => { const s = normaliseRollupItem(r, () => null).state; return s === 'pending' ? 'pending' : s === 'failure' ? 'red' : 'green'; }; // neutral / skipped = not red
  const jobIdOf = (r: Row): string | undefined => {
    const j = parseActionsJobUrl(r.detailsUrl ?? r.targetUrl);
    if (j?.job) return j.job; // a re-run of a job is a NEW job id
    const stamp = r.startedAt ?? r.completedAt;
    return j ? `${j.run}@${stamp ?? ''}` : stamp ? `${nameOf(r)}@${stamp}` : undefined;
  };

  async function logExtract(r: Row): Promise<string | undefined> {
    const j = parseActionsJobUrl(r.detailsUrl ?? r.targetUrl);
    if (!j) return undefined;
    try {
      const out = await gh(['run', 'view', j.run, ...(j.job ? ['--job', j.job] : []), '--log-failed', ...repoArgs]);
      const text = out.trim();
      return text ? text.slice(-extractChars) : undefined;
    } catch { return undefined; } // an unreadable log never hides the red
  }

  async function failedRuns(n: number, names: string[]): Promise<string[]> {
    const v = await view(n);
    const runs = new Set<string>();
    for (const r of v.statusCheckRollup ?? []) { if (names.includes(nameOf(r)) && statusOf(r) === 'red') { const j = parseActionsJobUrl(r.detailsUrl ?? r.targetUrl); if (j) runs.add(j.run); } }
    return [...runs];
  }

  return {
    failedRuns,
    async openPr({ branch, base, title }) {
      type Row = { number: number; state: string; headRefOid?: string };
      const list = async (): Promise<Row[]> => json(['pr', 'list', '--head', branch, '--base', base, '--state', 'all', '--json', 'number,state,headRefOid', '--limit', '20', ...repoArgs]);
      const tip = deps.branchHead ? await deps.branchHead(branch) : null;
      const pick = (rows: Row[]): number | null => (rows.find((r) => r.state === 'OPEN') ?? rows.find((r) => r.state === 'MERGED' && (!deps.branchHead || (tip !== null && r.headRefOid === tip))))?.number ?? null;
      const have = pick(await list());
      if (have !== null) return { n: have };
      const r = await deps.gh(['pr', 'create', '--head', branch, '--base', base, '--title', title, '--body', `Opened by \`orchestra fanout run\` for branch \`${branch}\`.`, ...repoArgs]);
      if (r.code !== 0) {
        const again = pick(await list()); // lost a race with a second opener: adopt its PR, never open two
        if (again !== null) return { n: again };
        throw new GhError(`gh pr create failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      }
      const m = /\/pull\/(\d+)\s*$/.exec(r.stdout.trim());
      if (!m) throw new GhError(`gh pr create: no pull request number in ${JSON.stringify(r.stdout.trim().slice(0, 120))}`);
      return { n: Number(m[1]) };
    },

    async prState(n) {
      const v = await json<{ state: string; headRefOid: string }>(['pr', 'view', String(n), '--json', 'state,headRefOid', ...repoArgs]);
      const state = PR_STATES[v.state];
      if (!state) throw new GhError(`gh pr view ${n}: unknown state ${JSON.stringify(v.state)}`);
      return { state, head: v.headRefOid };
    },

    async checks(n, head) {
      const rows = await rowsOf(n, head);
      return Promise.all(rows.map(async (r): Promise<ForgeCheck> => {
        const status = statusOf(r);
        const jobId = jobIdOf(r);
        const at = r.completedAt && !r.completedAt.startsWith('0001') ? r.completedAt : undefined;
        const extract = status === 'red' ? await logExtract(r) : undefined;
        return { name: nameOf(r), status, ...(jobId ? { jobId } : {}), ...(extract ? { logExtract: extract } : {}), ...(at ? { at } : {}) };
      }));
    },

    async rerun(n, names) {
      const runs = await failedRuns(n, names);
      if (!runs.length) throw new GhError(`no re-runnable Actions job behind ${names.join(', ') || '(no check)'} on #${n} (an external status has no run to re-run)`);
      // GitHub re-runs a run only once it is COMPLETED: the red job's siblings may still be going — wait for them (bounded), never re-run into a refusal that would end the loop
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      for (let waited = 0; ; waited += 15_000) {
        const v = await view(n);
        if (!(v.statusCheckRollup ?? []).some((r) => statusOf(r) === 'pending')) break;
        if (waited >= (deps.rerunWaitMs ?? 20 * 60_000)) throw new GhError(`#${n}: the Actions run is still in progress after ${Math.round(waited / 60_000)} min — it cannot be re-run yet`);
        await sleep(15_000);
      }
      for (const run of runs) await gh(['run', 'rerun', run, '--failed', ...repoArgs]); // the red jobs only
    },

    async merge(n, matchHead) {
      if (deps.deliver) return deps.deliver({ n, head: matchHead });
      if (!deps.bareMerge) throw new GhError('the live forge has no `deliver` wired: a merge is never done around it (rigs pass bareMerge: true)');
      const r = await deps.gh(['pr', 'merge', String(n), '--merge', '--match-head-commit', matchHead, ...repoArgs]);
      if (r.code === 0) return { ok: true };
      return { ok: false, reason: classifyMergeFailure(r.stderr) === 'head-moved' ? 'head-moved' : 'gh-failed', detail: r.stderr.trim().slice(0, 300) };
    },

    async close(n) {
      const v = await json<{ state: string }>(['pr', 'view', String(n), '--json', 'state', ...repoArgs]);
      if (v.state !== 'OPEN') return; // closing a merged / closed PR is a no-op, never an error
      await gh(['pr', 'close', String(n), ...repoArgs]);
    },
  };
}
