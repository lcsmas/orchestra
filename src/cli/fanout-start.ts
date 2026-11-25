// #587 PR B (ledger #591 I6) — `orchestra fanout start [--run <id>]`: launch the implementer of every plan ticket that has none live, brief rendered by code (src/shared/fanout-start.ts is the
// host half). NO flag takes free text. The CLI refuses what it can see (switch off, not the coordinator, plan incomplete) BEFORE asking the host, which checks the same again.
import { FanoutStateError, SeatRefusal, readState, stateFile } from '../shared/fanout-state.ts';
import { startRefusal, type StartResult } from '../shared/fanout-start.ts';
import { homeOf, parseArgs, runOf, type FanoutDeps, type RunResult } from './fanout-state.ts';

export const START_USAGE = `usage: orchestra fanout start [--run <id>]
  seatRecords=on, coordinator only: launches ONE implementer per plan ticket that has no live one (a dead one is respawned on its branch), each with a brief rendered by code
  (ticket, its interfaces with versions, branch base, the run's decisions, the rules). No flag takes free text: what you must say goes in \`state set --run-decision\`.
  Prints {"started":[{ticket,ws,branch}],"respawned":[…],"waiting":[{ticket,why}],"skipped":[{ticket,reason}],"failed":[{ticket,error}]}; a start held by Admission is listed in "waiting" (exit 0: call again later
  for the rest, a ticket with a live implementer is never started twice). Refused (exit 2, message [name] …): [start-off] · [start-caller] · [plan-incomplete]; "failed" non-empty = exit 2 too.`;

export async function runStart(args: string[], deps: FanoutDeps, host: (body: Record<string, unknown>) => Promise<Record<string, unknown>>): Promise<RunResult> {
  try {
    if (args.includes('--help') || args.includes('-h')) return { code: 0, stdout: `${START_USAGE}\n`, stderr: '' };
    const p = parseArgs(args, ['--run'], []);
    if (p.pos.length) throw new FanoutStateError(`unexpected argument ${p.pos[0]} (fanout start takes only --run)`);
    const r = runOf(p, deps, 'write');
    const state = readState(stateFile(homeOf(deps.env), r.run));
    if (!state) throw new FanoutStateError(`no state for run ${r.run} — run \`orchestra fanout state init\` first`);
    const caller = (deps.vouchedCaller ?? '').trim(); // the HOST-vouched id (index.ts), never the bare env
    const refusal = startRefusal(state, r.run, caller);
    if (refusal) throw refusal;
    const res = await host({ op: 'start', run: r.run, from: caller, key: deps.env.ORCHESTRA_SESSION_KEY?.trim() || undefined });
    if (!res.ok) {
      const msg = String(res.error ?? 'the host refused');
      if (msg.startsWith('[')) throw new SeatRefusal(msg.slice(1, msg.indexOf(']')), msg.slice(msg.indexOf(']') + 2));
      throw new FanoutStateError(msg);
    }
    const result = res.result as StartResult;
    const bad = result.failed.length > 0;
    return { code: bad ? 2 : 0, stdout: `${JSON.stringify(result)}\n`, stderr: `${r.note}${bad ? `${result.failed.length} ticket(s) did not start: ${result.failed.map((f) => `${f.ticket} (${f.error})`).join('; ')}\n` : ''}` };
  } catch (e) {
    if (e instanceof SeatRefusal) return { code: 2, stdout: '', stderr: `${e.message}\n` };
    if (e instanceof FanoutStateError) return { code: 1, stdout: '', stderr: `${e.message}\n` };
    throw e;
  }
}
