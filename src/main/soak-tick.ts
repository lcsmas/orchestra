// The soak scheduler's TICK — the decision + bookkeeping half of src/main/soak-scheduler.ts, kept free of Electron/platform/store imports so
// `node --test` can drive the REAL `soakTick` over fake deps (src/main/soak-tick.test.ts). Pure decision: src/shared/soak-schedule.ts.
import {
  decideSoakRun,
  DEFAULT_SOAK_POLICY,
  EMPTY_SOAK_STATE,
  shouldYield,
  type SoakActivity,
  type SoakDecision,
  type SoakState,
} from '../shared/soak-schedule.ts';

export interface SoakRunResult {
  terminator: string;
  reportJson: string | null;
  /** Ids of the broken BUDGET verdicts (empty unless FAIL). */
  failing: string[];
  detail: string;
}

/** Everything the tick touches outside its own module state, injectable so a test drives the REAL `soakTick` over fakes. */
export interface SoakDeps {
  now(): number;
  resolveRepo(): string | null;
  enabled(): boolean;
  readState(): SoakState;
  writeState(s: SoakState): void;
  identity(repo: string): Promise<{ codeId: string | null; cliVersion: string | null }>;
  activity(): SoakActivity;
  machine(): { memAvailKB: number; load1: number };
  /** Start a campaign; `done` settles when it has ended, `yieldNow` asks it to stop (SIGTERM → graceful, ABORTED report). */
  launch(o: { repo: string; sessions: number }): { done: Promise<SoakRunResult>; yieldNow(reason: string): void };
  log: { info(m: string): void; warn(m: string): void; debug(m: string): void };
}

let running: { yieldNow(reason: string): void; startedAt: number } | null = null;

/** App quit: ask a running campaign to stop (its own parent-death watch covers a hard kill). No-op when none runs. */
export function yieldRunningSoak(reason: string): void {
  running?.yieldNow(reason);
}

/** Test seam: is a campaign considered running? */
export const isSoakRunning = (): boolean => running !== null;

/** One scheduler tick. Returns the decision (for tests / logs); at most ONE campaign runs at a time. */
export async function soakTick(deps: SoakDeps): Promise<SoakDecision> {
  const now = deps.now();
  const activity = deps.activity();
  if (running) {
    const y = shouldYield(activity, now, DEFAULT_SOAK_POLICY);
    if (y.yield) {
      deps.log.info(`campaign yields to the user: ${y.why}`);
      running.yieldNow(y.why);
    }
    return { run: false, skip: 'campaign-running', detail: y.yield ? `yielding: ${y.why}` : 'running' };
  }
  const repo = deps.resolveRepo();
  const enabled = deps.enabled() && repo != null;
  const identity = enabled ? await deps.identity(repo as string) : { codeId: null, cliVersion: null };
  const state = deps.readState();
  const decision = decideSoakRun({ now, enabled, campaignRunning: false, current: identity, state, activity, machine: deps.machine() }, DEFAULT_SOAK_POLICY);
  if (!decision.run) {
    deps.log.debug(`skip ${decision.skip}: ${decision.detail}`);
    return decision;
  }
  deps.log.info(`starting a ${decision.sessions}-session campaign (${DEFAULT_SOAK_POLICY.durationSec / 60} min, fake API, zero tokens) — ${decision.reason}`);
  deps.writeState({ ...state, lastAttempt: { at: now, outcome: 'started', detail: `${decision.sessions} sessions; ${decision.reason}` } });
  const handle = deps.launch({ repo: repo as string, sessions: decision.sessions });
  running = { yieldNow: handle.yieldNow, startedAt: now };
  void handle.done
    .then((res) => finishRun(deps, res, identity, decision.sessions))
    .catch((e) => {
      deps.log.warn(`campaign runner failed to report: ${e instanceof Error ? e.message : String(e)}`);
      deps.writeState({ ...deps.readState(), lastAttempt: { at: deps.now(), outcome: 'broke', detail: String(e).slice(0, 200) } });
    })
    .finally(() => {
      running = null;
    });
  return decision;
}

/** Record the outcome. Only PASS/FAIL advance the change gate (the campaign RAN to its end); VOID/ABORTED/BROKE are attempts. */
function finishRun(deps: SoakDeps, res: SoakRunResult, identity: { codeId: string | null; cliVersion: string | null }, sessions: number): void {
  const state = deps.readState();
  const at = deps.now();
  if ((res.terminator === 'PASS' || res.terminator === 'FAIL') && identity.codeId) {
    deps.writeState({ ...state, lastAttempt: { at, outcome: res.terminator.toLowerCase(), detail: res.detail }, lastCompleted: { codeId: identity.codeId, cliVersion: identity.cliVersion, at, terminator: res.terminator, reportJson: res.reportJson ?? '' } });
  } else {
    deps.writeState({ ...state, lastAttempt: { at, outcome: res.terminator.toLowerCase(), detail: res.detail } });
  }
  if (res.terminator === 'FAIL') {
    deps.log.warn(`campaign BREACH — ${res.failing.length} budget(s) broken (${res.failing.slice(0, 6).join(', ')}${res.failing.length > 6 ? ', …' : ''}) with ${sessions} sessions — report ${res.reportJson ?? '(none)'}`);
  } else {
    deps.log.info(`campaign ${res.terminator} — ${res.detail}${res.reportJson ? ` — report ${res.reportJson}` : ''}`);
  }
}

export { EMPTY_SOAK_STATE };
