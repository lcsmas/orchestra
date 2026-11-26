// #605 (spec #601, ledger #613) — `orchestra fanout run`: the Boucle. Leads a vague from its plan to its closing report (src/shared/fanout-loop.ts); `--scenario` swaps in the dummy fleet (src/shared/fanout-loop-dummy.ts).
// Exit codes (FROZEN): 0 every ticket merged · 3 the run ended with ≥1 parked ticket · 4 paused (lift it with `orchestra fanout state set --run <id> --resume-run`, then run again) · 2 refusal ([run-…]) · 1 could not run.
import fs from 'node:fs';
import { FanoutStateError, SeatRefusal, assertRunId, stateFile, readState } from '../shared/fanout-state.ts';
import type { LoopOptions } from '../shared/fanout-loop.ts';
import { parseScenario, runDummyLoop } from '../shared/fanout-loop-dummy.ts';
import type { Plan } from '../shared/fanout-plan.ts';
import { homeOf, parseArgs, type FanoutDeps, type RunResult } from './fanout-state.ts';
import type { Host } from '../shared/fanout-loop-live-fleet.ts';
import { runLive } from './fanout-run-live.ts';

export const RUN_USAGE = `usage: orchestra fanout run [--run <id>] [--tickets a,b,c | --plan <plan.json>] [--scenario <scenario.json>] [--start-check] [--minor-policy <legacy|refuse|spec|demonstrated>]
  Leads the vague from its plan to its closing report: starts EVERY implementer at once on the frozen interfaces, reads the run's mail (the only reader), connects a dependent to its upstream when the upstream's reviewer
  approved it, opens the pull requests, wakes the reviewers, and merges — recorded approval on the head + green CI on the head + upstreams merged, in READINESS order — until every ticket is merged or parked.
  seatRecords=on, verifier=off, minorPolicy=demonstrated (the loop's default; \`state init\` is done for its own run when none exists). The loop never types a verdict and never waits for a person: a parked ticket parks its dependents.
  An agent's question gets the fixed answer ("take the reversible option, record it under ## Choices in your PR body, continue") and is listed in the report; a first line "NO SAFE OPTION: <reason>" parks the ticket.
  Prints the closing report as JSON on stdout (merged, parked {ticket,cause,reason}, choices, findingsLeft, flaky, costPerTicket, paused) and a text summary on stderr.
  Exit: 0 every ticket merged · 3 the run ended with at least one parked ticket · 4 paused (lift it with \`orchestra fanout state set --run <id> --resume-run\`, then run again) · 2 refusal ([run-…]) · 1 could not run.
  --scenario <file> runs the DUMMY fleet (scripted agents, git, PR host and CI on a virtual clock) and judges its event log; refused unless ORCHESTRA_FANOUT_DUMMY=1 ([run-scenario-gated]).
  Without --scenario it runs on the LIVE ports as the run's coordinator (a no-agent workspace, #612: \`orchestra spawn --no-agent --run-command "orchestra fanout run …"\`): fleet = the shipped verbs (fanout start|review, check, ack, send) + the host,
  forge = gh (the merge goes through the shipped \`fanout deliver\`, so its refusals are the loop's), git = git. Refused [run-caller] unless the host vouches the caller as the run's coordinator.`;

const runReportText = (r: { merged: string[]; parked: Array<{ ticket: string; cause: string; reason: string }>; choices: unknown[] }): string =>
  `merged ${r.merged.length}${r.merged.length ? ` (${r.merged.join(', ')})` : ''} · parked ${r.parked.length}${r.parked.map((p) => ` ${p.ticket} [${p.cause}] ${p.reason}`).join(';')} · choices ${r.choices.length}\n`;

export async function runFanoutRun(args: string[], deps: FanoutDeps, host?: Host): Promise<RunResult> {
  try {
    if (args.includes('--help') || args.includes('-h')) return { code: 0, stdout: `${RUN_USAGE}\n`, stderr: '' };
    const p = parseArgs(args, ['--run', '--tickets', '--plan', '--scenario', '--minor-policy'], ['--start-check']);
    if (p.pos.length) throw new FanoutStateError(`unexpected argument ${p.pos[0]} (fanout run takes only flags; orchestra fanout run --help)`);
    if (p.vals['--tickets'] !== undefined && p.vals['--plan'] !== undefined) throw new SeatRefusal('run-plan-ambiguous', 'pass --tickets OR --plan, not both');
    const minor = p.vals['--minor-policy'] ?? 'demonstrated';
    if (!['legacy', 'refuse', 'spec', 'demonstrated'].includes(minor)) throw new SeatRefusal('run-minor-policy', `--minor-policy must be legacy|refuse|spec|demonstrated (got ${JSON.stringify(minor)})`);
    let plan: Plan | null = null;
    if (p.vals['--plan'] !== undefined) {
      try { plan = JSON.parse(fs.readFileSync(p.vals['--plan'], 'utf8')) as Plan; } catch (e) { throw new SeatRefusal('run-plan-bad-json', `${p.vals['--plan']}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    const tickets = p.vals['--tickets'] ? p.vals['--tickets'].split(',').map((x) => x.trim()).filter(Boolean) : null;
    const options: Partial<LoopOptions> = { minorPolicy: minor as LoopOptions['minorPolicy'], startCheck: p.bools.has('--start-check'), ...(plan ? { plan } : {}), ...(tickets ? { tickets } : {}) };

    if (p.vals['--scenario'] === undefined) { // #614: the loop on the LIVE ports, as the run's coordinator (a no-agent workspace, #612) — every effect through a shipped verb or the host
      if (!host) throw new FanoutStateError('[run-live-ports] the host route is not reachable from here (fanout run needs the running app)');
      const caller = (deps.vouchedCaller ?? '').trim();
      const run = assertRunId(p.vals['--run'] ?? caller);
      if (!caller || caller !== run) throw new SeatRefusal('run-caller', `only the run's coordinator (${run}) leads it${caller ? `, not ${caller}` : ' — the host could not vouch this session (is Orchestra running, and is this the live session of the workspace? an ORCHESTRA_WS_ID in the env is not proof)'}`);
      const log: string[] = [];
      const result = await runLive({ home: homeOf(deps.env), run, caller, env: deps.env, cwd: deps.cwd, options, host, log: (l) => { log.push(l); process.stderr.write(`${l}\n`); } });
      const out = { exit: result.exit, passes: result.passes, ...(result.reason ? { reason: result.reason } : {}), report: result.report };
      return { code: result.exit, stdout: `${JSON.stringify(out)}\n`, stderr: runReportText(result.report) };
    }
    if (deps.env.ORCHESTRA_FANOUT_DUMMY !== '1') throw new SeatRefusal('run-scenario-gated', '--scenario swaps in the dummy fleet and is refused unless ORCHESTRA_FANOUT_DUMMY=1: it never touches a real workspace, branch or pull request');
    let scenario;
    try { scenario = parseScenario(JSON.parse(fs.readFileSync(p.vals['--scenario'], 'utf8'))); } catch (e) { if (e instanceof FanoutStateError) throw new SeatRefusal('run-scenario-bad', e.message); throw new SeatRefusal('run-scenario-bad', `${p.vals['--scenario']}: ${e instanceof Error ? e.message : String(e)}`); }
    const run = assertRunId(p.vals['--run'] ?? scenario.run ?? 'dummy-run');
    const home = homeOf(deps.env);
    if (readState(stateFile(home, run))) throw new SeatRefusal('run-dummy-state-exists', `run ${run} already has a state under ${home}: the dummy world is rebuilt from the scenario, so it needs a fresh run (--run <other id>)`);
    const d = await runDummyLoop({ home, run, scenario, options });
    const { result } = d;
    const out = { exit: result.exit, passes: result.passes, ...(result.reason ? { reason: result.reason } : {}), report: result.report, dummy: { run, events: d.world.events.length, violations: d.violations } };
    return { code: result.exit, stdout: `${JSON.stringify(out)}\n`, stderr: `${d.log.join('\n')}\n${runReportText(result.report)}${d.violations.length ? `JUDGE: ${d.violations.length} violation(s): ${d.violations.map((v) => v.rule).join(', ')}\n` : 'JUDGE: clean\n'}` };
  } catch (e) {
    if (e instanceof SeatRefusal) return { code: 2, stdout: '', stderr: `${e.message}\n` };
    if (e instanceof FanoutStateError) return { code: 1, stdout: '', stderr: `${e.message}\n` };
    throw e;
  }
}
