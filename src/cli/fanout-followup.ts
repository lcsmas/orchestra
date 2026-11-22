// #514 — the follow-up rule at `fanout gate` / `fanout deliver`: a candidate on an already-merged ticket proceeds only if it names a BLOCKING|MAJOR
// finding of that ticket it fixes. The rule is `followUpRefusal` (src/shared/fanout-state.ts); this file reads the state the way the acceptance reader does.
import os from 'node:os';
import path from 'node:path';
import { FanoutStateError, followUpRefusal, readState, resolveFanoutRun, stateFile, type FollowUpRefusal } from '../shared/fanout-state.ts';

export type FollowUpAnswer = { consulted: boolean; known: boolean; refusal: FollowUpRefusal | null };
export type FollowUpReader = (o: { ticket: string; run?: string; head: string; branch?: string; headTree?: string | null }) => FollowUpAnswer;

/** consulted:false = no state at all (no --run, none at the caller's own run / inherited run). `lenient` (the gate WITHOUT --run): an unknown ticket is `known:false`, not an error; deliver (the merge
 *  authority) and the gate with --run fail closed (throw ⇒ exit 1) on a missing state / unknown ticket / unreadable state. */
export function followUpFromState(opts: { ticket: string; run?: string; head: string; branch?: string; headTree?: string | null; lenient?: boolean }, env: NodeJS.ProcessEnv = process.env): FollowUpAnswer {
  const { run, inherited } = resolveFanoutRun(opts.run, env);
  if (!run) return { consulted: false, known: false, refusal: null };
  const home = env.ORCHESTRA_HOME && env.ORCHESTRA_HOME.trim() ? env.ORCHESTRA_HOME : path.join(os.homedir(), '.orchestra');
  let sawState = false;
  const runs = opts.run || !inherited ? [run] : [run, inherited]; // an explicit --run reads that run only; a verifier falls back to the run it inherits
  for (const r of runs) {
    const state = readState(stateFile(home, r));
    if (!state) continue;
    sawState = true;
    if (state.tickets[opts.ticket]) return { consulted: true, known: true, refusal: followUpRefusal(state, opts.ticket, opts.head, opts.branch, opts.headTree) };
  }
  if (!sawState) {
    if (opts.run && !opts.lenient) throw new FanoutStateError(`no fanout state for --run ${opts.run}: a wrong run id would skip the follow-up rule`);
    return { consulted: false, known: false, refusal: null };
  }
  if (opts.lenient) return { consulted: true, known: false, refusal: null };
  throw new FanoutStateError(`ticket ${opts.ticket} is not in the fanout state of run ${run}${inherited && !opts.run ? ` or ${inherited}` : ''}: a mistyped --ticket would skip the follow-up rule`);
}

/** The rule, then — only when it says `followup-undeclared` — once more with the git tree of the candidate head (#512: same tree on another sha = same content). Unreadable tree ⇒ the sha verdict stands. */
export async function askFollowUp(read: FollowUpReader, o: { ticket: string; run?: string; head: string; branch?: string }, readTree: (sha: string) => Promise<string | null>): Promise<FollowUpAnswer> {
  const first = read(o);
  if (first.refusal?.reason !== 'followup-undeclared') return first;
  const headTree = await readTree(o.head).catch(() => null);
  return headTree ? read({ ...o, headTree }) : first;
}
