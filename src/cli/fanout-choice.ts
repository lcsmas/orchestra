// #641 — `orchestra fanout choice <ticket> --question "<q>" --taken "<option>"`: the implementer records, before it pushes, the reversible option it took for a question its spec left open.
// The run keeps it as a decision of that ticket: the reviewer brief lists it, the closing report lists it, `fanout record --on-choice` lets a finding about it stay non-blocking. Rule = `recordImplementerChoice` (src/shared/fanout-record.ts).
import { FanoutStateError, SeatRefusal, readState, stateFile, updateState } from '../shared/fanout-state.ts';
import { isVouched, resolveCaller } from '../shared/fanout-caller.ts';
import { recordImplementerChoice } from '../shared/fanout-record.ts';
import { homeOf, parseArgs, runOf, type FanoutDeps, type RunResult } from './fanout-state.ts';

export const CHOICE_USAGE = `usage: orchestra fanout choice <ticket> --question "<the open question>" --taken "<the reversible option you took>" [--narrows "<verbatim ticket sentence>"] [--run <id>]
         (#641) record, BEFORE you push, a choice your spec left open: the loop's rule is fixed — take the reversible option — so your recorded option IS the run's decision for this ticket.
         EVERY reviewer's brief lists it (all choices of the run, #675); the closing report lists it; a review finding about the choice itself never blocks the merge (a finding that the code does not do what the choice says still does).
         --narrows (#675): when the option you took cuts a sentence of your ticket, quote that sentence VERBATIM (checked as a literal substring of the ticket text: [choice-narrows-not-in-text] [choice-narrows-no-text]). The brief prints it ("Choice n narrows: « … »"; none → "none declared"), and a review finding that quotes that very sentence is NOT exempted by \`--on-choice\`: it keeps its severity.
         Under seatRecords=on only the ticket's own implementer, from its live session (the host vouches), records it ([choice-caller]). Refusals: [choice-unknown-ticket] [choice-closed] [choice-bad] (blank / unprintable / over 2000 characters).
         Exit 0 recorded (prints "choice <n>": cite it with \`fanout record --on-choice <finding>=<n>\`) · 2 refused · 1 usage / unreadable.`;

export function runChoice(args: string[], deps: FanoutDeps): RunResult {
  try { return choice(args, deps); } catch (e) {
    if (e instanceof SeatRefusal) return { code: 2, stdout: '', stderr: `${e.message}\n` };
    if (e instanceof FanoutStateError) return { code: 1, stdout: '', stderr: `${e.message}\n` };
    throw e;
  }
}

function choice(args: string[], deps: FanoutDeps): RunResult {
  if (args[0] === '--help' || args[0] === '-h') return { code: 0, stdout: `${CHOICE_USAGE}\n`, stderr: '' };
  const p = parseArgs(args, ['--run', '--question', '--taken', '--narrows'], []);
  const [ticket, ...extra] = p.pos;
  if (!ticket || extra.length || p.vals['--question'] === undefined || p.vals['--taken'] === undefined) throw new FanoutStateError(CHOICE_USAGE);
  const r = runOf(p, deps, 'use');
  const file = stateFile(homeOf(deps.env), r.run);
  if (!readState(file)) throw new FanoutStateError(`no state at ${file} — pass --run <the coordinator's run id>`);
  let n = 0;
  updateState(file, (s) => {
    if (!s) throw new FanoutStateError(`no state at ${file}`);
    const caller = resolveCaller(s, deps.env, deps.identity); // the host's answer for THIS call, never the env alone (#588)
    const out = recordImplementerChoice(s, ticket, { question: p.vals['--question'], taken: p.vals['--taken'], ...(p.vals['--narrows'] !== undefined ? { narrows: p.vals['--narrows'] } : {}), callerId: caller.id, callerVouched: isVouched(caller), now: deps.now() });
    n = out.choices!.length;
    return out;
  });
  return { code: 0, stdout: `${ticket}: choice ${n} recorded (reversible-default) — cite it with \`orchestra fanout record --on-choice <finding>=${n}\` if a review finding is about it\n`, stderr: r.note };
}
