// #676 — `orchestra fanout open-point <ticket> --about <other ticket> --text "<the point>"`: a point your ticket leaves OPEN about ANOTHER ticket, written as run state instead of a prose line nobody reads.
// It blocks BOTH tickets (`gate` / `deliver` / the loop: [open-point-unsettled]) until it settles. `--decide <n>=<reason>` closes one by a recorded decision (the loop's fixed rule, or the coordinator's). Rules = src/shared/fanout-open-point.ts.
import { FanoutStateError, SeatRefusal, readState, seatRecordsOn, stateFile, updateState } from '../shared/fanout-state.ts';
import { isVouched, resolveCaller } from '../shared/fanout-caller.ts';
import { decideOpenPoint, recordOpenPoint } from '../shared/fanout-open-point.ts';
import { assertDecideCaller } from '../shared/fanout-record.ts';
import { homeOf, parseArgs, runOf, type FanoutDeps, type RunResult } from './fanout-state.ts';

export const OPEN_POINT_USAGE = `usage: orchestra fanout open-point <ticket> --about <other ticket> --text "<the point>" [--run <id>]
       orchestra fanout open-point --decide <n>=<reason> [--run <id>]
         (#676) a point your ticket leaves open ABOUT another ticket — something that ticket must do for yours to be complete. Write it HERE, never in prose: the loop reads it, orders the other ticket's implementer (or, when that
         ticket is already merged, opens a follow-up ticket for it), and \`gate\` / \`deliver\` refuse BOTH tickets ([open-point-unsettled]) until it settles: the reviewer of the other ticket approves a NEW head with the point listed
         in \`fanout record\` "addressed", or it is decided (--decide, listed in the closing report; the coordinator's, or the loop's fixed rule after two unanswered orders).
         Under seatRecords=on only <ticket>'s own implementer or recorded reviewer, from its live session (the host vouches), raises it; --decide is the run's coordinator's. The same point twice keeps one number.
         Refusals: [open-point-unknown-ticket] [open-point-self] [open-point-closed] [open-point-bad] [open-point-caller] · --decide: [open-point-unknown] [open-point-reason-blank] [decide-caller].
         Exit 0 recorded (prints "open point <n>") · 2 refused · 1 usage / unreadable.`;

export function runOpenPoint(args: string[], deps: FanoutDeps): RunResult {
  try { return openPoint(args, deps); } catch (e) {
    if (e instanceof SeatRefusal) return { code: 2, stdout: '', stderr: `${e.message}\n` };
    if (e instanceof FanoutStateError) return { code: 1, stdout: '', stderr: `${e.message}\n` };
    throw e;
  }
}

function openPoint(args: string[], deps: FanoutDeps): RunResult {
  if (args[0] === '--help' || args[0] === '-h') return { code: 0, stdout: `${OPEN_POINT_USAGE}\n`, stderr: '' };
  const p = parseArgs(args, ['--run', '--about', '--text', '--decide'], []);
  const [ticket, ...extra] = p.pos;
  const r = runOf(p, deps, 'use');
  const file = stateFile(homeOf(deps.env), r.run);
  if (!readState(file)) throw new FanoutStateError(`no state at ${file} — pass --run <the coordinator's run id>`);
  if (p.vals['--decide'] !== undefined) {
    if (ticket || extra.length || p.vals['--about'] !== undefined || p.vals['--text'] !== undefined) throw new FanoutStateError(OPEN_POINT_USAGE);
    const m = /^([1-9][0-9]*)=([\s\S]+)$/.exec(p.vals['--decide']);
    if (!m) throw new FanoutStateError('--decide expects <n>=<reason> (the reason is written in the closing report)');
    let by = '';
    updateState(file, (s) => {
      if (!s) throw new FanoutStateError(`no state at ${file}`);
      const caller = resolveCaller(s, deps.env, deps.identity);
      if (seatRecordsOn(s)) assertDecideCaller(s, caller); // the coordinator's, proven by the host (as `state set --decide`)
      by = caller.id ?? 'unidentified';
      return decideOpenPoint(s, Number(m[1]), { by, text: m[2], now: deps.now() });
    });
    return { code: 0, stdout: `open point ${m[1]}: decided — listed in the closing report\n`, stderr: r.note };
  }
  if (!ticket || extra.length || p.vals['--about'] === undefined || p.vals['--text'] === undefined) throw new FanoutStateError(OPEN_POINT_USAGE);
  let n = 0;
  let fresh = true;
  updateState(file, (s) => {
    if (!s) throw new FanoutStateError(`no state at ${file}`);
    const caller = resolveCaller(s, deps.env, deps.identity); // the host's answer for THIS call, never the env alone (#588)
    const out = recordOpenPoint(s, ticket, { about: p.vals['--about'], text: p.vals['--text'], callerId: caller.id, callerVouched: isVouched(caller), now: deps.now() });
    n = out.point.id;
    fresh = out.fresh;
    return out.state;
  });
  return { code: 0, stdout: `${ticket}: open point ${n} ${fresh ? 'recorded' : 'already recorded'} about ${p.vals['--about']} — ${ticket} and ${p.vals['--about']} are blocked until it settles\n`, stderr: r.note };
}
