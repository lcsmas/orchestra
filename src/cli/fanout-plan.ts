// #604 (ledger #613 FROZEN v1) — `orchestra fanout plan`: the plan step of the Boucle.
//   plan --tickets <id,id,…> [--run <id>] [--print] [--timeout <min>]   the COORDINATOR: spawns the single-use plan agent (host op), returns when a plan is accepted
//   plan submit <file|-> --run <id>                                       the PLAN AGENT: checks the plan, answers synchronously with the reasons
// Exits as the other fanout verbs: 0 accepted · 2 refused (`[plan-…]` first; `[plan-refused-twice]` = the run does not start) · 1 usage / could not run.
import fs from 'node:fs';
import { TICKET_ID } from '../shared/fanout-plan.ts';
import { FanoutStateError, SeatRefusal, assertRunId, newState, readState, seatRecordsOn, stateFile, updateState } from '../shared/fanout-state.ts';
import type { Exec } from '../shared/fanout-loop-live-git.ts';
import { realExec, resolveRunTarget } from './fanout-run-live.ts';
import { submitPlan, submitText } from '../shared/fanout-plan-host.ts';
import { renderPlanBrief } from '../shared/fanout-plan-brief.ts';
import { homeOf, parseArgs, runOf, type FanoutDeps, type RunResult } from './fanout-state.ts';

export const PLAN_USAGE = `usage: orchestra fanout plan --tickets <id,id,…> [--run <id>] [--repo <owner/name>] [--print] [--timeout <min>]
       orchestra fanout plan submit <file|-> --run <id>
  A fresh run needs no \`state init\` (#626): the state is created with the switches \`fanout run\` uses (seatRecords=on, minorPolicy=demonstrated, verifier=off; --repo <owner/name> optional, the target = origin/HEAD, else the GitHub default branch).
  seatRecords=on, coordinator only: spawns ONE single-use agent (explo-plan-<run8>, explorer role) whose brief is rendered by code from the ticket ids (no flag takes text), and returns when its plan is accepted:
  prints {"plan":"accepted","hash","attempts","tickets"} (exit 0). --print renders the brief and spawns nothing. --timeout (default 45, minutes) = how long to wait for the plan.
  The plan agent submits with \`plan submit\`: the CLI checks the file and answers at once. The plan file holds exactly {version, tickets[{id,title,spec,specText,dependsOn}], interfaces{<depended-on ticket>: one line per \`exact name\` — kind: <field|column|event|function|route|query|mutation>; shape: <type or payload fields>}, contracts[{id,owner,must,consumers}], noSharedBehaviour["A-B"]}; every dependency pair shares a contract or is declared in noSharedBehaviour.
  Refused (exit 2, [name] …): [plan-free-text] · [plan-bad-json] · [plan-ticket-missing] · [plan-ticket-unknown] · [plan-duplicate-ticket] · [plan-cycle] · [plan-interface-missing] · [plan-interface-no-name] · [plan-interface-no-kind] · [plan-interface-no-shape] · [plan-interface-multi-name] · [plan-contract-missing] · [plan-no-shared-bad] · [plan-bad-dependency]
  — the first refusal gives the agent the reasons and ONE more submission; the second is [plan-refused-twice]: loopPlan is NOT set, the verb exits 2, the run does not start.
  Other refusals: [plan-caller] · [plan-not-requested] · [plan-closed] · [plan-tickets-changed] · [plan-agent-dead] · [plan-after-spawn] · [plan-after-decision] · [plan-bad-ticket-id] · [plan-apply-failed] · [seat-records-off]. After an accepted plan \`state set --run-decision\` is refused [decision-after-plan].`;

export interface PlanLoopOpts {
  /** Real-time pacing (tests hand a fake clock). */
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  pollMs?: number;
  /** How often the host is asked again (a dead agent is replaced once). */
  recheckMs?: number;
  /** #626 — git / gh for the target of a state this verb initialises (default: the real ones, run in `deps.cwd`). */
  exec?: Exec;
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
    const p = parseArgs(args, ['--run', '--tickets', '--timeout', '--repo'], ['--print']);
    if (p.pos.length) throw new FanoutStateError(`unexpected argument ${p.pos[0]} (fanout plan takes --tickets, --run, --print, --timeout; the plan agent uses \`plan submit\`)`);
    const tickets = [...new Set((p.vals['--tickets'] ?? '').split(',').map((t) => t.trim()).filter(Boolean))];
    if (!tickets.length) throw new FanoutStateError(`--tickets <id,id,…> is required\n${PLAN_USAGE}`);
    const badId = tickets.find((t) => !TICKET_ID.test(t));
    if (badId !== undefined) throw new SeatRefusal('plan-bad-ticket-id', `${JSON.stringify(badId.slice(0, 40))} is not a ticket id (letters, digits, . _ # : -, at most 64): the plan agent's brief is rendered from ids, never from text`);
    const r = runOf(p, deps, 'use');
    if (p.bools.has('--print')) return { code: 0, stdout: `${renderPlanBrief(tickets, { run: r.run })}\n`, stderr: r.note };
    const file = stateFile(homeOf(deps.env), r.run);
    let state = readState(file);
    let preNote = r.note;
    if (!state) { // #626: the state `fanout run` would init (seatRecords=on, minorPolicy=demonstrated, verifier=off) — the documented order plan → run starts from nothing
      const c0 = (deps.vouchedCaller ?? '').trim();
      if (!c0 || c0 !== r.run) throw new SeatRefusal('plan-caller', `only the run's coordinator (${r.run}) asks for its plan${c0 ? `, not ${c0}` : ' — the host could not vouch this session (is Orchestra running, and is this the live session of the workspace?)'}`);
      const target = await resolveRunTarget(opts.exec ?? realExec, deps.cwd, p.vals['--repo'] ?? null);
      updateState(file, (cur) => cur ?? newState(r.run, { target, repo: p.vals['--repo'] ?? null, switches: { seatRecords: 'on', minorPolicy: 'demonstrated', verifier: 'off' }, now: deps.now() }));
      state = readState(file)!;
      preNote += `state initialised for run ${r.run} (target ${target}, seatRecords=on, verifier=off)\n`;
    }
    if (!seatRecordsOn(state)) throw new SeatRefusal('seat-records-off', `run ${r.run} has seatRecords=off: the plan step is a seatRecords rule (state init --switch seatRecords=on)`);
    const caller = (deps.vouchedCaller ?? '').trim(); // the HOST-vouched id (index.ts), never the bare env
    if (!caller || caller !== r.run) throw new SeatRefusal('plan-caller', `only the run's coordinator (${r.run}) asks for its plan${caller ? `, not ${caller}` : ' — the host could not vouch this session (is Orchestra running, and is this the live session of the workspace?)'}`);
    const release = async (): Promise<string> => { // #629: the plan agent has nothing left to do — the host archives it (best effort: a refusal is said, never fatal)
      try { const x = await host({ op: 'plan-release', run: r.run, from: caller, key: deps.env.ORCHESTRA_SESSION_KEY?.trim() || undefined }); return x.ok ? (x.released ? `plan agent ${String(x.released)} released\n` : '') : `plan agent not released: ${String(x.error ?? 'the host refused')}\n`; } catch (e) { return `plan agent not released: ${e instanceof Error ? e.message : String(e)}\n`; }
    };
    if (state.loopPlan) return accepted(state, preNote + await release());
    if (state.decisions?.length) throw new SeatRefusal('plan-after-decision', `run ${r.run} already holds ${state.decisions.length} run decision(s): they ride in every brief verbatim — no plan agent is spawned (start from a state with none)`);
    const timeoutMin = p.vals['--timeout'] === undefined ? 45 : Number(p.vals['--timeout']);
    if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) throw new FanoutStateError('--timeout must be a number of minutes > 0');
    const sleep = opts.sleep ?? realSleep, nowMs = opts.nowMs ?? Date.now, pollMs = opts.pollMs ?? 2_000, recheckMs = opts.recheckMs ?? 45_000;
    const ask = async (): Promise<Record<string, unknown>> => {
      const res = await host({ op: 'plan', run: r.run, from: caller, key: deps.env.ORCHESTRA_SESSION_KEY?.trim() || undefined, tickets });
      return res.ok ? res : failFrom(res);
    };
    const first = await ask();
    let note = `${preNote}plan agent ${String(first.name)} ${first.action === 'adopt' ? 'already running' : first.action === 'in-flight' ? 'starting' : first.action === 'accepted' ? '(plan already accepted)' : 'spawned'}${first.id ? ` (${String(first.id)})` : ''}\n`;
    const start = nowMs();
    let lastAsk = start;
    for (;;) {
      const st = readState(file);
      if (st?.loopPlan) return accepted(st, note + await release());
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
