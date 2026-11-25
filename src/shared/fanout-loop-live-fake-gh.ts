// #614 — a FAKE `gh` for the live ForgePort's contract test: an in-memory pull-request host speaking the exact subset of `gh` the port uses, answering in the shapes the real binary prints (`statusCheckRollup` CheckRun rows with
// Actions job URLs, `pr create` printing the PR URL, `pr merge --match-head-commit` refusing a moved head). Anything else exits 1 `unsupported`: the instrument never answers a question it was not built for.
// CI is SCRIPTED per branch: one result per CI run ("green" | "red:<check>"), a re-run (`run rerun --failed`) consumes the next one and gives the failed jobs NEW job ids — the property #607 reads.
import crypto from 'node:crypto';
import type { ExecResult } from './fanout-loop-live-git.ts';

export const CHECKS = ['build', 'test', 'lint'];
const EPOCH = Date.parse('2026-01-01T00:00:00Z');

interface Pr { n: number; branch: string; base: string; title: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; mergeParents?: number; mergedHead?: string }
interface Run { /** a job of the run that is still going until `until` while the others are done (a re-run is refused until the whole run is completed) */ sibling?: { name: string; until: number }; id: number; n: number; head: string; startedAt: number; doneAt: number; result: string; attempt: number; jobs: Record<string, string> }

export class FakeForge {
  clock = EPOCH;
  ciMs = 240_000;
  readonly heads = new Map<string, string>();
  readonly script = new Map<string, string[]>();
  readonly prs = new Map<number, Pr>();
  readonly runs: Run[] = [];
  readonly calls: string[][] = [];
  private ids = 1000;
  private served = new Map<string, number>(); // branch → CI runs created so far
  readonly gh = async (args: string[]): Promise<ExecResult> => this.run(args);

  advance(ms: number): void { this.clock += ms; }
  /** The author pushes: the branch head moves, and a CI run starts for it NOW when a pull request is open on the branch. */
  push(branch: string, sha: string): string {
    this.heads.set(branch, sha);
    const pr = [...this.prs.values()].find((p) => p.branch === branch && p.state === 'OPEN');
    if (pr) this.runOf(pr);
    return sha;
  }
  private iso(t: number): string { return new Date(t).toISOString(); }
  private ok(stdout: string): ExecResult { return { code: 0, stdout, stderr: '' }; }
  private no(stderr: string, code = 1): ExecResult { return { code, stdout: '', stderr }; }
  private flag(args: string[], f: string): string | undefined { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; }
  private nextResult(branch: string): string { const k = this.served.get(branch) ?? 0; this.served.set(branch, k + 1); return this.script.get(branch)?.[k] ?? 'green'; }
  private runOf(pr: Pr): Run | undefined {
    const head = this.heads.get(pr.branch);
    const have = [...this.runs].reverse().find((r) => r.n === pr.n && r.head === head);
    if (have || !head) return have;
    const r: Run = { id: this.ids++, n: pr.n, head, startedAt: this.clock, doneAt: this.clock + this.ciMs, result: this.nextResult(pr.branch), attempt: 1, jobs: Object.fromEntries(CHECKS.map((c) => [c, String(this.ids++)])) };
    this.runs.push(r);
    return r;
  }
  /** The git tree this fake reports for a commit (`gh api commits/<sha>`): deterministic, so a test can record the same tree in the run state. */
  treeOf(sha: string): string { return crypto.createHash('sha1').update(`tree:${sha}`).digest('hex'); }
  private field(pr: Pr, k: string): unknown {
    switch (k) {
      case 'state': return pr.state;
      case 'headRefOid': return pr.mergedHead ?? this.heads.get(pr.branch); // a merged PR keeps the head it was merged at
      case 'statusCheckRollup': return this.rollup(pr);
      case 'baseRefName': return pr.base;
      case 'number': return pr.n;
      case 'url': return `https://github.com/o/r/pull/${pr.n}`;
      case 'mergeable': return 'MERGEABLE';
      case 'mergeCommit': return pr.state === 'MERGED' ? { oid: this.treeOf(`merge:${pr.n}`) } : null;
      default: return undefined;
    }
  }
  private rollup(pr: Pr): unknown[] {
    const r = this.runOf(pr);
    if (!r) return [];
    const done = this.clock >= r.doneAt;
    const red = r.result.startsWith('red:') ? r.result.slice(4) : null;
    return CHECKS.map((name) => {
      const finished = done && !(r.sibling && r.sibling.name === name && this.clock < r.sibling.until);
      return {
        __typename: 'CheckRun', name, workflowName: 'ci', status: finished ? 'COMPLETED' : 'IN_PROGRESS', conclusion: finished ? (name === red ? 'FAILURE' : 'SUCCESS') : '',
        detailsUrl: `https://github.com/o/r/actions/runs/${r.id}/job/${r.jobs[name]}`, startedAt: this.iso(r.startedAt), completedAt: finished ? this.iso(r.doneAt) : '0001-01-01T00:00:00Z',
      };
    });
  }

  private async run(args: string[]): Promise<ExecResult> {
    this.calls.push(args);
    const [a, b] = args;
    if (a === 'pr' && b === 'list') {
      const head = this.flag(args, '--head'), base = this.flag(args, '--base');
      const want = (this.flag(args, '--json') ?? '').split(',');
      return this.ok(JSON.stringify([...this.prs.values()].filter((p) => p.branch === head && (!base || p.base === base)).map((p) => Object.fromEntries(want.map((k) => [k, this.field(p, k)])))));
    }
    if (a === 'pr' && b === 'create') {
      const branch = this.flag(args, '--head'), base = this.flag(args, '--base'), title = this.flag(args, '--title');
      if (!branch || !base || !title) return this.no('pr create: missing --head/--base/--title');
      if (!this.heads.has(branch)) return this.no(`pull request create failed: head branch "${branch}" not found`);
      if ([...this.prs.values()].some((p) => p.branch === branch && p.state === 'OPEN')) return this.no(`a pull request for branch "${branch}" into branch "${base}" already exists`);
      const n = this.prs.size + 1;
      const pr: Pr = { n, branch, base, title, state: 'OPEN' };
      this.prs.set(n, pr);
      this.runOf(pr); // the CI starts when the PR opens
      return this.ok(`https://github.com/o/r/pull/${n}\n`);
    }
    if (a === 'pr' && b === 'view') {
      const pr = this.prs.get(Number(args[2]));
      if (!pr) return this.no(`could not resolve to a PullRequest with the number of ${args[2]}`);
      const want = (this.flag(args, '--json') ?? '').split(',');
      return this.ok(JSON.stringify(Object.fromEntries(want.map((k) => [k, this.field(pr, k)]))));
    }
    if (a === 'pr' && b === 'close') {
      const pr = this.prs.get(Number(args[2]));
      if (!pr || pr.state !== 'OPEN') return this.no('pull request is not open');
      pr.state = 'CLOSED';
      return this.ok('');
    }
    if (a === 'pr' && b === 'merge') {
      const pr = this.prs.get(Number(args[2]));
      const sha = this.flag(args, '--match-head-commit');
      if (!pr || pr.state !== 'OPEN') return this.no('pull request is not mergeable: it is not open');
      if (!args.includes('--merge')) return this.no('only --merge is supported by this fake (the loop never squashes or rebases)');
      const head = this.heads.get(pr.branch)!;
      if (sha && !(head.startsWith(sha) || sha.startsWith(head))) return this.no('X Pull request is not mergeable: Head branch was modified. Review and try the merge again.');
      pr.state = 'MERGED';
      pr.mergedHead = head;
      pr.mergeParents = 2; // a merge commit
      return this.ok('');
    }
    if (a === 'api') {
      const m = /\/commits\/([0-9a-f]{7,40})$/.exec(args[1] ?? '');
      return m ? this.ok(JSON.stringify({ commit: { tree: { sha: this.treeOf(m[1]) } } })) : this.no(`fake gh: unsupported api call ${args[1]}`);
    }
    if (a === 'run' && b === 'view') {
      const run = this.runs.find((r) => String(r.id) === args[2]);
      if (!run) return this.no(`run ${args[2]} not found`);
      if (args.includes('jobs')) return this.ok(JSON.stringify({ jobs: CHECKS.map((c) => ({ databaseId: Number(run.jobs[c]), steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run it', conclusion: 'success' }, { name: 'Complete job', conclusion: 'success' }] })) }));
      const job = this.flag(args, '--job');
      const name = CHECKS.find((c) => run.jobs[c] === job) ?? 'test';
      return this.ok(`${name}\tRun tests\tFAIL ${name}: expected 1 to equal 2\n`);
    }
    if (a === 'run' && b === 'rerun') {
      const run = this.runs.find((r) => String(r.id) === args[2]);
      if (!run || !args.includes('--failed')) return this.no('run rerun: unsupported here (only `--failed` of a known run)');
      if (this.clock < run.doneAt || (run.sibling && this.clock < run.sibling.until)) return this.no(`run ${run.id} is still in progress; it cannot be re-run until it has completed`);
      const pr = this.prs.get(run.n)!;
      const red = run.result.startsWith('red:') ? run.result.slice(4) : null;
      const result = this.nextResult(pr.branch);
      run.attempt++;
      run.startedAt = this.clock;
      run.doneAt = this.clock + this.ciMs;
      run.result = result;
      if (red) run.jobs[red] = String(this.ids++); // the re-run job is a NEW job; the green ones keep theirs
      return this.ok('');
    }
    return this.no(`fake gh: unsupported: ${args.join(' ')}`);
  }
}
