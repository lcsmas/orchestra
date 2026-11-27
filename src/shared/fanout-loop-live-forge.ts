// #614 (spec #601, ledger #613) — the LIVE ForgePort of the Boucle: the pull-request host through `gh` (argv, never a shell), behind an injected runner.
// A MERGE never goes around the shipped `deliver`: production wires `deliver` here, so every refusal of that verb (review verdict, CI, upstream order, acceptance, follow-up) is the loop's refusal. The bare `gh pr merge` below is
// only the fallback of a rig that has no run state; the CLI (src/cli/fanout-run-live.ts) never uses it.
import type { ForgeCheck, ForgePort } from './fanout-loop-ports.ts';
import type { ExecResult } from './fanout-loop-live-git.ts';
import { FanoutStateError } from './fanout-state.ts';
import { classifyMergeFailure, isMergeConflict, isUserStep, normaliseRollupItem, parseActionsJobUrl, type RollupItem } from './fanout-deliver.ts';

export type Gh = (args: string[]) => Promise<ExecResult>;
export interface MergeAnswer { ok: boolean; reason?: string; detail?: string }

export interface LiveForgeDeps {
  gh: Gh;
  /** `owner/name`; absent = the repository of the working directory. */
  repo?: string;
  /** The merge, through the shipped `deliver` (production). `reason` = deliver's refusal reason (`head-moved`, `ci-red`, `record-missing`, …). */
  deliver?: (i: { n: number; head: string; method: 'merge' | 'squash' | 'rebase' }) => Promise<MergeAnswer>;
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

export class ForgeGhError extends FanoutStateError {}

export function createLiveForge(deps: LiveForgeDeps): ForgePort & { /** the red-check runs a re-run would touch (rig/diagnostics) */ failedRuns(n: number, names: string[]): Promise<string[]> } {
  const repoArgs = deps.repo ? ['--repo', deps.repo] : [];
  const gh = async (args: string[]): Promise<string> => {
    const r = await deps.gh(args);
    if (r.code !== 0) throw new ForgeGhError(`gh ${args.slice(0, 2).join(' ')} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    return r.stdout;
  };
  const json = async <T>(args: string[]): Promise<T> => { const o = await gh(args); try { return JSON.parse(o) as T; } catch { throw new ForgeGhError(`gh ${args.slice(0, 2).join(' ')}: not JSON: ${o.slice(0, 120)}`); } };
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

  /** Review 614 BLOCKING-1: a green Actions job carries the count of USER steps that succeeded (`gh run view --json jobs`): the loop's `decideDelivery` refuses a green that proves nothing ran. An external status has no steps to count (undefined: refused too).
   *  The jobs of a run are read ONCE (the promise is shared by the N jobs asked at once); a job the cached list does not hold (a re-run made new jobs of the same run) re-reads it. */
  type JobRow = { databaseId?: number; steps?: Array<{ name?: string; conclusion?: string }> };
  const runJobs = new Map<string, Promise<JobRow[]>>();
  const jobsOf = (run: string, fresh = false): Promise<JobRow[]> => {
    const have = runJobs.get(run);
    if (have && !fresh) return have;
    const p = json<{ jobs?: JobRow[] }>(['run', 'view', run, '--json', 'jobs', ...repoArgs]).then((x) => x.jobs ?? []);
    runJobs.set(run, p);
    p.catch(() => { if (runJobs.get(run) === p) runJobs.delete(run); }); // a failure is not cached
    return p;
  };
  async function stepsOf(r: Row): Promise<number | undefined> {
    if (normaliseRollupItem(r, () => null).state !== 'success') return undefined;
    const j = parseActionsJobUrl(r.detailsUrl ?? r.targetUrl);
    if (!j || j.job === null) return undefined; // a check linked to a whole run (no job): its steps cannot be told — refused, never summed over the run's jobs
    const count = (jobs: JobRow[]): number | null => { const mine = jobs.filter((x) => String(x.databaseId) === j.job); return mine.length ? mine.reduce((a2, x) => a2 + (x.steps ?? []).filter((st) => (st.conclusion ?? '').toLowerCase() === 'success' && isUserStep(st.name)).length, 0) : null; };
    let n = count(await jobsOf(j.run));
    if (!n) n = count(await jobsOf(j.run, true)); // unknown job (a re-run made it) or 0 steps (the cached list was read while it was still running): read again once
    if (n === null) throw new ForgeGhError(`gh run view ${j.run}: job ${j.job} not found`); // fail closed: never "no steps to worry about"
    return n;
  }

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
        throw new ForgeGhError(`gh pr create failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      }
      const m = /\/pull\/(\d+)\s*$/.exec(r.stdout.trim());
      if (!m) throw new ForgeGhError(`gh pr create: no pull request number in ${JSON.stringify(r.stdout.trim().slice(0, 120))}`);
      return { n: Number(m[1]) };
    },

    async prState(n) {
      const read = () => json<{ state: string; headRefOid: string; mergeable?: string }>(['pr', 'view', String(n), '--json', 'state,headRefOid,mergeable', ...repoArgs]);
      let v = await read();
      if (v.state === 'OPEN' && (v.mergeable ?? 'UNKNOWN') === 'UNKNOWN') v = await read(); // GitHub computes mergeability lazily: ask once more (the loop reads again next pass)
      const state = PR_STATES[v.state];
      if (!state) throw new ForgeGhError(`gh pr view ${n}: unknown state ${JSON.stringify(v.state)}`);
      return { state, head: v.headRefOid, mergeable: v.mergeable === 'MERGEABLE' || v.mergeable === 'CONFLICTING' ? v.mergeable : 'UNKNOWN' };
    },

    async checks(n, head) {
      const rows = (await rowsOf(n, head)).filter((r) => normaliseRollupItem(r, () => null).state !== 'neutral'); // a skipped / neutral job is neither green nor red: `deliver` ignores it, so does the loop
      return Promise.all(rows.map(async (r): Promise<ForgeCheck> => {
        const status = statusOf(r);
        const jobId = jobIdOf(r);
        const at = r.completedAt && !r.completedAt.startsWith('0001') ? r.completedAt : undefined;
        const extract = status === 'red' ? await logExtract(r) : undefined;
        const steps = status === 'green' ? await stepsOf(r) : undefined;
        return { name: nameOf(r), status, ...(jobId ? { jobId } : {}), ...(steps !== undefined ? { steps } : {}), ...(extract ? { logExtract: extract } : {}), ...(at ? { at } : {}) };
      }));
    },

    async rerun(n, names) {
      const runs = await failedRuns(n, names);
      if (!runs.length) throw new ForgeGhError(`no re-runnable Actions job behind ${names.join(', ') || '(no check)'} on #${n} (an external status has no run to re-run)`);
      // GitHub re-runs a run only once it is COMPLETED: the red job's siblings may still be going — wait for them (bounded), never re-run into a refusal that would end the loop
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      for (let waited = 0; ; waited += 15_000) {
        const v = await view(n);
        const inRed = (r: Row): boolean => { const j = parseActionsJobUrl(r.detailsUrl ?? r.targetUrl); return !!j && runs.includes(j.run); }; // only the red run's own jobs: a required external status stuck EXPECTED is not a sibling
        if (!(v.statusCheckRollup ?? []).some((r) => inRed(r) && statusOf(r) === 'pending')) break;
        if (waited >= (deps.rerunWaitMs ?? 20 * 60_000)) throw new ForgeGhError(`#${n}: the Actions run is still in progress after ${Math.round(waited / 60_000)} min — it cannot be re-run yet`);
        await sleep(15_000);
      }
      for (const run of runs) await gh(['run', 'rerun', run, '--failed', ...repoArgs]); // the red jobs only
    },

    async merge(n, matchHead, method) {
      if (deps.deliver) return deps.deliver({ n, head: matchHead, method });
      if (!deps.bareMerge) throw new ForgeGhError('the live forge has no `deliver` wired: a merge is never done around it (rigs pass bareMerge: true)');
      const r = await deps.gh(['pr', 'merge', String(n), `--${method}`, '--match-head-commit', matchHead, ...repoArgs]);
      if (r.code === 0) return { ok: true };
      return { ok: false, reason: classifyMergeFailure(r.stderr) === 'head-moved' ? 'head-moved' : isMergeConflict(r.stderr) ? 'merge-conflict' : 'gh-failed', detail: r.stderr.trim().slice(0, 300) };
    },

    async close(n) {
      const v = await json<{ state: string }>(['pr', 'view', String(n), '--json', 'state', ...repoArgs]);
      if (v.state !== 'OPEN') return; // closing a merged / closed PR is a no-op, never an error
      await gh(['pr', 'close', String(n), ...repoArgs]);
    },
  };
}
