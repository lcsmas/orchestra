// #588 (I3) — `orchestra fanout review <ticket> [--run <id>] [--print]`: the reviewer's brief is rendered by CODE from the run state, the reviewer is spawned (or the live one woken with the delta) by the HOST
// (same call path as `acceptance spawn`), and who it is gets recorded. NO flag takes free text for the brief: the coordinator's words are the run's decisions (`state set --run-decision`).
// Exits as the other fanout verbs: 0 ok · 2 refused (`[review-…]` first) · 1 usage / could-not-check.
import { resolveCaller } from '../shared/fanout-caller.ts';
import { ReviewRefusal, assertReviewable, stackedBase, assertReviewCaller, assertReviewerRole, decideReview, renderBriefOf } from '../shared/fanout-review.ts';
import { FanoutStateError, stateFile } from '../shared/fanout-state.ts';
import { homeOf, loadOrFail, parseArgs, runOf, type FanoutDeps, type RunResult } from './fanout-state.ts';

export const REVIEW_USAGE = 'usage: orchestra fanout review <ticket> [--run <id>] [--print]   (--print renders the brief without spawning; no flag takes text — put your words in `state set --run-decision`)';

/** The base of `head`: its merge-base with `origin/<target>` (null = not computable here — the brief says so). */
function baseOf(deps: FanoutDeps, target: string, head: string): string | null {
  const r = deps.runner('git', ['merge-base', `origin/${target}`, head], deps.cwd);
  const sha = r.code === 0 ? r.stdout.trim().split('\n')[0] : '';
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

export function runReview(args: string[], deps: FanoutDeps): RunResult {
  try {
    if (args[0] === '--help' || args[0] === '-h') return { code: 0, stdout: `${REVIEW_USAGE}\n`, stderr: '' };
    const p = parseArgs(args, ['--run'], ['--print']);
    if (p.pos.length !== 1) throw new FanoutStateError(`a ticket id is required (and nothing else positional)\n${REVIEW_USAGE}`);
    const ticket = p.pos[0];
    const r = runOf(p, deps, 'use');
    const state = loadOrFail(stateFile(homeOf(deps.env), r.run));
    const t = assertReviewable(state, ticket); // [review-off] · [review-no-head] · [review-plan]
    const print = p.bools.has('--print');
    const caller = resolveCaller(state, deps.env, deps.identity);
    if (!print) assertReviewCaller(state, caller); // [review-caller]: the coordinator, vouched by the host
    assertReviewerRole(state, t, t.review?.reviewer?.id ?? null); // [review-role]
    const head = t.head!;
    const base = stackedBase(state, ticket) ?? baseOf(deps, state.target, head);
    if (print) {
      // what a call would send: assumes a recorded reviewer is still live (only the host knows); nothing is spawned, nothing is written
      const act = decideReview(t, head, deps.now(), () => true);
      const kind = act.action === 'noop' ? 'wake' : act.kind;
      const b = renderBriefOf(state, ticket, { kind, head, base });
      return { code: 0, stdout: `${b.text}\n--\nkind: ${kind}${act.action === 'noop' ? ` (a call would do nothing: ${act.why})` : ''}  hash: ${b.hash}\n`, stderr: r.note };
    }
    return { code: 0, stdout: `${ticket}: asking Orchestra for its reviewer (head ${head.slice(0, 12)})\n`, stderr: r.note, hostCalls: [{ route: '/fanoutAcceptance', body: { op: 'review', run: r.run, ticket, head, ...(base ? { base } : {}), from: caller.id ?? '', callerId: caller.id ?? '', key: (deps.env.ORCHESTRA_SESSION_KEY ?? '').trim() } }] };
  } catch (e) {
    if (e instanceof ReviewRefusal) return { code: 2, stdout: '', stderr: `refused: ${e.message}\n` };
    if (e instanceof FanoutStateError) return { code: 1, stdout: '', stderr: `${e.message}\n` };
    throw e;
  }
}
