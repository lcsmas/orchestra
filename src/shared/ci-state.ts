import type { ChecksForBranch } from './types';

// Pure reduction of a GitHub Actions runs feed (newest-first) into a per-branch
// CI verdict. Lives in src/shared so it is node-testable without Electron.

/** The slice of a workflow-run object the reduction needs (from
 * `repos/{owner}/{repo}/actions/runs`, via gh's --jq reshape). */
export interface WorkflowRunLite {
  /** `head_branch` — null/'' for odd events (fork PRs), skipped. */
  branch: string | null;
  /** `head_sha` — groups sibling workflows of one push. */
  sha: string;
  /** `status`: queued | in_progress | completed | waiting | pending | requested */
  status: string;
  /** `conclusion` when completed: success | failure | cancelled | … else null */
  conclusion: string | null;
  /** Workflow name (badge tooltip). */
  name: string;
  /** `html_url` of the run. */
  url: string;
  /** Run id — lets "fix broken checks" point the agent at `gh run view`. */
  id: number;
}

const FAIL = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);
const RUNNING = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

/** Reduce a newest-first runs feed to one verdict per branch.
 *
 * Only runs on the branch's NEWEST head sha count — one push commonly starts
 * several workflows (build/test/lint), and those siblings aggregate (any fail
 * → fail, else any running → running, else any success → pass), while runs on
 * older shas are history and must not tint the current state. `cancelled`,
 * `skipped` and `neutral` conclusions deliberately map to none — a run the
 * user aborted is not a red branch. */
export function branchChecksFromRuns(runs: WorkflowRunLite[]): Map<string, ChecksForBranch> {
  const byBranch = new Map<string, WorkflowRunLite[]>();
  for (const r of runs) {
    if (!r.branch) continue;
    const list = byBranch.get(r.branch);
    if (!list) byBranch.set(r.branch, [r]);
    else if (list[0].sha === r.sha) list.push(r);
    // else: an older sha for a branch we've already seen — ignore.
  }
  const out = new Map<string, ChecksForBranch>();
  for (const [branch, list] of byBranch) {
    const failing = list.find((r) => r.conclusion !== null && FAIL.has(r.conclusion));
    const running = list.find((r) => RUNNING.has(r.status));
    const success = list.find((r) => r.conclusion === 'success');
    const pick = failing ?? running ?? success;
    out.set(branch, {
      state: failing ? 'fail' : running ? 'running' : success ? 'pass' : 'none',
      ...(pick ? { name: pick.name, url: pick.url, runId: pick.id } : {}),
    });
  }
  return out;
}
