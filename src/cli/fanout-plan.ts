// #604 (ledger #613 FROZEN v1) — `orchestra fanout plan`: the plan step of the Boucle.
//   plan --tickets <id,id,…> [--run <id>] [--print] [--timeout <min>]   the COORDINATOR: spawns the single-use plan agent (host op), returns when a plan is accepted
//   plan submit <file|-> --run <id>                                       the PLAN AGENT: checks the plan, answers synchronously with the reasons
// Exits as the other fanout verbs: 0 accepted · 2 refused (`[plan-…]` first; `[plan-refused-twice]` = the run does not start) · 1 usage / could not run.
import fs from 'node:fs';
import { TICKET_ID } from '../shared/fanout-plan.ts';
import { FanoutStateError, SeatRefusal, assertRunId, readState, seatRecordsOn, stateFile } from '../shared/fanout-state.ts';
import { submitPlan, submitText } from '../shared/fanout-plan-host.ts';
import { renderPlanBrief } from '../shared/fanout-plan-brief.ts';
import { homeOf, parseArgs, runOf, type FanoutDeps, type RunResult } from './fanout-state.ts';

export const PLAN_USAGE = `usage: orchestra fanout plan --tickets <id,id,…> [--run <id>] [--print] [--timeout <min>]
       orchestra fanout plan submit <file|-> --run <id>
  seatRecords=on, coordinator only: spawns ONE single-use agent (explo-plan-<run8>, explorer role) whose brief is rendered by code from the ticket ids (no flag takes text), and returns when its plan is accepted:
  prints {"plan":"accepted","hash","attempts","tickets"} (exit 0). --print renders the brief and spawns nothing. --timeout (default 45, minutes) = how long to wait for the plan.
  The plan agent submits with \`plan submit\`: the CLI checks the file and answers at once. The plan file holds exactly {version, tickets[{id,title,spec,dependsOn}], interfaces{<depended-on ticket>: text with ≥1 \`exact name\`}}.
  Refused (exit 2, [name] …): [plan-free-text] · [plan-bad-json] · [plan-ticket-missing] · [plan-ticket-unknown] · [plan-duplicate-ticket] · [plan-cycle] · [plan-interface-missing] · [plan-interface-no-name] · [plan-bad-dependency]
  — the first refusal gives the agent the reasons and ONE more submission; the second is [plan-refused-twice]: loopPlan is NOT set, the verb exits 2, the run does not start.
  Other refusals: [plan-caller] · [plan-not-requested] · [plan-closed] · [plan-tickets-changed] · [plan-agent-dead] · [plan-after-spawn] · [plan-after-decision] · [plan-bad-ticket-id] · [plan-apply-failed] · [seat-records-off]. After an accepted plan \`state set --run-decision\` is refused [decision-after-plan].`;

export interface PlanLoopOpts {
  /** Real-time pacing (tests hand a fake clock). */
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  pollMs?: number;
  /** How often the host is asked again (a dead agent is replaced once). */
  recheckMs?: number;
}
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const failFrom = (res: Record<string, unknown>): never => {
  const msg = String(res.error ?? 'the host refused');
  if (msg.startsWith('[')) throw new SeatRefusal(msg.slice(1, msg.indexOf(']')), msg.slice(msg.indexOf(']') + 2));
  throw new FanoutStateError(msg);
};

export async function runPlan(args: string[], deps: FanoutDeps, host: (body: Record<string, unknown>) => Promise<Record<string, unknown>>, opts: PlanLoopOpts = {}): Promise<RunResult> {
  try {
    if (args.includes('--help') || args.includes('-h')) return { code: 0, stdout: `${PLAN_USAGE}\n`, stderr: '' };
    if (args[0] === 'submit') return submit(args.slice(1), deps);
    const p = parseArgs(args, ['--run', '--tickets', '--timeout'], ['--print']);
    if (p.pos.length) throw new FanoutStateError(`unexpected argument ${p.pos[0]} (fanout plan takes --tickets, --run, --print, --timeout; the plan agent uses \`plan submit\`)`);
    const tickets = [...new Set((p.vals['--tickets'] ?? '').split(',').map((t) => t.trim()).filter(Boolean))];
    if (!tickets.length) throw new FanoutStateError(`--tickets <id,id,…> is required\n${PLAN_USAGE}`);
    const badId = tickets.find((t) => !TICKET_ID.test(t));
    if (badId !== undefined) throw new SeatRefusal('plan-bad-ticket-id', `${JSON.stringify(badId.slice(0, 40))} is not a ticket id (letters, digits, . _ # : -, at most 64): the plan agent's brief is rendered from ids, never from text`);
    const r = runOf(p, deps, 'use');
    if (p.bools.has('--print')) return { code: 0, stdout: `${renderPlanBrief(tickets, { run: r.run })}\n`, stderr: r.note };
    const file = stateFile(homeOf(deps.env), r.run);
    const state = readState(file);
    if (!state) throw new FanoutStateError(`no state for run ${r.run} — run \`orchestra fanout state init\` first`);
    if (!seatRecordsOn(state)) throw new SeatRefusal('seat-records-off', `run ${r.run} has seatRecords=off: the plan step is a seatRecords rule (state init --switch seatRecords=on)`);
    const caller = (deps.vouchedCaller ?? '').trim(); // the HOST-vouched id (index.ts), never the bare env
    if (!caller || caller !== r.run) throw new SeatRefusal('plan-caller', `only the run's coordinator (${r.run}) asks for its plan${caller ? `, not ${caller}` : ' — the host could not vouch this session (is Orchestra running, and is this the live session of the workspace?)'}`);
    if (state.loopPlan) return accepted(state, r.note);
    if (state.decisions?.length) throw new SeatRefusal('plan-after-decision', `run ${r.run} already holds ${state.decisions.length} run decision(s): they ride in every brief verbatim — no plan agent is spawned (start from a state with none)`);
    const timeoutMin = p.vals['--timeout'] === undefined ? 45 : Number(p.vals['--timeout']);
    if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) throw new FanoutStateError('--timeout must be a number of minutes > 0');
    const sleep = opts.sleep ?? realSleep, nowMs = opts.nowMs ?? Date.now, pollMs = opts.pollMs ?? 2_000, recheckMs = opts.recheckMs ?? 45_000;
    const ask = async (): Promise<Record<string, unknown>> => {
      const res = await host({ op: 'plan', run: r.run, from: caller, key: deps.env.ORCHESTRA_SESSION_KEY?.trim() || undefined, tickets });
      return res.ok ? res : failFrom(res);
    };
    const first = await ask();
    let note = `${r.note}plan agent ${String(first.name)} ${first.action === 'adopt' ? 'already running' : first.action === 'in-flight' ? 'starting' : first.action === 'accepted' ? '(plan already accepted)' : 'spawned'}${first.id ? ` (${String(first.id)})` : ''}\n`;
    const start = nowMs();
    let lastAsk = start;
    for (;;) {
      const st = readState(file);
      if (st?.loopPlan) return accepted(st, note);
      if (st?.planRefusal) return { code: 2, stdout: '', stderr: `${note}[${st.planRefusal.code}] the plan step ended without a plan (loopPlan not set) — the run does not start: ${st.planRefusal.detail}\n` }; // the state remembers it, whatever happened to the record
      if (nowMs() - start > timeoutMin * 60_000) return { code: 1, stdout: '', stderr: `${note}no accepted plan after ${timeoutMin} min — nothing was recorded (run \`orchestra fanout plan --tickets …\` again: a live agent is adopted, never duplicated)\n` };
      if (nowMs() - lastAsk >= recheckMs) { // a dead plan agent is replaced ONCE; a second death is [plan-agent-dead]
        lastAsk = nowMs();
        const a = await ask();
        if (a.action === 'respawn') note += `the plan agent died: replaced by ${String(a.id)}\n`;
      }
      await sleep(pollMs);
    }
  } catch (e) {
    if (e instanceof SeatRefusal) return { code: 2, stdout: '', stderr: `${e.message}\n` };
    if (e instanceof FanoutStateError) return { code: 1, stdout: '', stderr: `${e.message}\n` };
    throw e;
  }
}

function accepted(state: NonNullable<ReturnType<typeof readState>>, note: string): RunResult {
  const lp = state.loopPlan!;
  return { code: 0, stdout: `${JSON.stringify({ plan: 'accepted', hash: lp.hash, attempts: lp.attempts, tickets: state.plan?.tickets.length ?? 0 })}\n`, stderr: note };
}

function submit(args: string[], deps: FanoutDeps): RunResult {
  const p = parseArgs(args, ['--run'], []);
  if (p.pos.length !== 1) throw new FanoutStateError(`a plan file (or -) is required, and nothing else positional\n${PLAN_USAGE}`);
  const run = p.vals['--run']?.trim();
  if (!run) throw new FanoutStateError('--run <id> is required (the run named in your brief: your own workspace id is not the run)');
  assertRunId(run);
  let text: string;
  try { text = p.pos[0] === '-' ? deps.readStdin() : fs.readFileSync(p.pos[0], 'utf8'); } catch (e) { throw new FanoutStateError(`cannot read the plan file ${p.pos[0]}: ${e instanceof Error ? e.message : String(e)}`); }
  const caller = (deps.vouchedCaller ?? '').trim() || null; // the HOST-vouched id, null = nobody
  const res = submitText(submitPlan({ home: homeOf(deps.env), run, text, caller, now: deps.now() }));
  return res;
}
