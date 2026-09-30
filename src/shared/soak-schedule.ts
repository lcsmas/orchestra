// Load/soak campaign SCHEDULER (C5 #212) — the PURE decision half. src/main/soak-scheduler.ts owns the I/O (timers, git/`claude` probes,
// spawning scripts/session-budget/soak-campaign.mjs, state file, log lines). Runs under `node --experimental-strip-types`.
//
// Contract (ticket #212, ledger #237 D5/D6/D7): run a campaign only when (1) the machine AND the user are idle, (2) the code it exercises or the
// `claude` CLI version changed since the last campaign that RAN, (3) the resource caps hold. Zero tokens (the campaign is fake-API only).
// Fail CLOSED everywhere: an unreadable signal is "do not run".
import { SOAK_BUDGETS } from './session-budget.ts';
import { decideAbort, preflight } from './soak-campaign.ts';

export interface SoakSchedulePolicy {
  /** No campaign in the first minutes after launch — boot is busy and the user is likely about to work. */
  minAppUptimeMs: number;
  /** The user must have been away this long (system idle time when the platform reports it, else the window's last focus). */
  userIdleMs: number;
  /** …and no workspace may have shown agent activity this recently, nor be running/waiting NOW. */
  workspaceQuietMs: number;
  /** A RUNNING campaign yields (aborts) when the user's idle time drops below this, the window is focused, or a workspace starts running. */
  yieldIdleMs: number;
  /** Minimum gap between ATTEMPTS (an aborted/refused/void campaign must not hot-loop). */
  attemptCooldownMs: number;
  /** Minimum gap between COMPLETED campaigns even if the code changes every hour. */
  minIntervalMs: number;
  /** Fewest sessions worth running; below this the machine does not fit a campaign. */
  minSessions: number;
  durationSec: number;
}

export const DEFAULT_SOAK_POLICY: SoakSchedulePolicy = Object.freeze({
  minAppUptimeMs: 10 * 60_000,
  userIdleMs: 15 * 60_000,
  workspaceQuietMs: 10 * 60_000,
  yieldIdleMs: 60_000,
  attemptCooldownMs: 60 * 60_000,
  minIntervalMs: 6 * 3600_000,
  minSessions: 3,
  durationSec: 3600,
});

/** Persisted by main at `<ORCHESTRA_HOME>/soak/state.json`. `lastCompleted` (PASS or FAIL only) is the change gate's key. */
export interface SoakState {
  schema: 1;
  lastCompleted: { codeId: string; cliVersion: string | null; at: number; terminator: 'PASS' | 'FAIL'; reportJson: string } | null;
  lastAttempt: { at: number; outcome: string; detail?: string } | null;
}
export const EMPTY_SOAK_STATE: SoakState = Object.freeze({ schema: 1, lastCompleted: null, lastAttempt: null }) as SoakState;

export interface SoakActivity {
  appUptimeMs: number;
  workspaces: Array<{ id: string; status: string; lastActivityAt?: number }>;
  windowFocused: boolean;
  /** Epoch ms the window last had focus, when tracked. */
  lastFocusedAt?: number;
  /** Seconds since the user's last input (OS-level), or null when the platform cannot say. */
  systemIdleSec: number | null;
}

export type SoakSkip =
  | 'disabled' | 'campaign-running' | 'identity-unreadable' | 'unchanged' | 'app-just-started' | 'user-active' | 'cooldown' | 'min-interval' | 'machine' | 'no-fit';
export type SoakDecision = { run: true; sessions: number; reason: string } | { run: false; skip: SoakSkip; detail: string };

/** Is the user (or an agent doing the user's work) active RIGHT NOW? `why` names the signal. Fail closed on nothing-known: an un-tracked
 *  focus time with no idle reading counts as active. */
export function userActivity(a: SoakActivity, now: number, p: SoakSchedulePolicy, mode: 'start' | 'yield'): { active: boolean; why: string } {
  if (a.windowFocused) return { active: true, why: 'the Orchestra window is focused' };
  const busy = a.workspaces.filter((w) => w.status === 'running' || w.status === 'waiting');
  if (busy.length) return { active: true, why: `${busy.length} workspace(s) ${busy[0].status} (${busy.slice(0, 3).map((w) => w.id.slice(0, 8)).join(', ')})` };
  if (mode === 'yield') {
    if (a.systemIdleSec != null && a.systemIdleSec * 1000 < p.yieldIdleMs) return { active: true, why: `user input ${Math.round(a.systemIdleSec)} s ago` };
    return { active: false, why: 'idle' };
  }
  if (a.systemIdleSec != null) {
    if (a.systemIdleSec * 1000 < p.userIdleMs) return { active: true, why: `user input ${Math.round(a.systemIdleSec / 60)} min ago (< ${Math.round(p.userIdleMs / 60_000)} min idle)` };
  } else if (a.lastFocusedAt == null || now - a.lastFocusedAt < p.userIdleMs) {
    return { active: true, why: 'no OS idle reading and the window was focused too recently (or never seen unfocused)' };
  }
  const recent = a.workspaces.filter((w) => w.lastActivityAt != null && now - (w.lastActivityAt as number) < p.workspaceQuietMs);
  if (recent.length) return { active: true, why: `${recent.length} workspace(s) had agent activity < ${Math.round(p.workspaceQuietMs / 60_000)} min ago` };
  return { active: false, why: 'idle' };
}

/** The largest N ≤ maxSessions whose projected footprint still leaves the RAM floor free (≥ policy.minSessions, else 0). Pure. */
export function fitSessions(memAvailKB: number, load1: number, p: SoakSchedulePolicy, b = SOAK_BUDGETS): number {
  for (let n = b.maxSessions; n >= p.minSessions; n--) {
    const refusals = preflight({ params: { sessions: n, durationSec: p.durationSec, turnIntervalSec: 30, sampleSec: 30, turnDeadlineSec: 60, replyDelayMs: 500 }, memAvailKB, load1 }, b);
    if (!refusals.length) return n;
  }
  return 0;
}

export interface SoakTick {
  now: number;
  enabled: boolean;
  campaignRunning: boolean;
  /** codeId/cliVersion of the checkout + CLI NOW; a null in either (git or `claude` unreadable) skips — the campaign exercises both. */
  current: { codeId: string | null; cliVersion: string | null };
  state: SoakState;
  activity: SoakActivity;
  machine: { memAvailKB: number; load1: number };
}

/** THE decision: run a campaign now, or why not. Order matters only for the reported reason (every gate must hold to run). */
export function decideSoakRun(t: SoakTick, p: SoakSchedulePolicy = DEFAULT_SOAK_POLICY): SoakDecision {
  const skip = (s: SoakSkip, detail: string): SoakDecision => ({ run: false, skip: s, detail });
  if (!t.enabled) return skip('disabled', 'scheduler disabled (config / ORCHESTRA_SOAK=0 / no checkout found)');
  if (t.campaignRunning) return skip('campaign-running', 'a campaign is already running');
  if (t.current.codeId == null || t.current.cliVersion == null) return skip('identity-unreadable', `cannot read the ${t.current.codeId == null ? 'checkout\'s code identity' : '`claude` CLI version'} — not running blind`);
  if (t.activity.appUptimeMs < p.minAppUptimeMs) return skip('app-just-started', `app up ${Math.round(t.activity.appUptimeMs / 60_000)} min < ${Math.round(p.minAppUptimeMs / 60_000)} min`);
  const last = t.state.lastCompleted;
  const changed = last == null ? 'no campaign has completed yet' : last.codeId !== t.current.codeId ? `code changed (${last.codeId} → ${t.current.codeId})` : last.cliVersion !== t.current.cliVersion ? `claude CLI changed (${last.cliVersion ?? '?'} → ${t.current.cliVersion ?? '?'})` : null;
  if (changed == null) return skip('unchanged', `code ${t.current.codeId} and claude ${t.current.cliVersion} are what the last completed campaign ran`);
  if (t.state.lastAttempt && t.now - t.state.lastAttempt.at < p.attemptCooldownMs) return skip('cooldown', `last attempt ${Math.round((t.now - t.state.lastAttempt.at) / 60_000)} min ago (${t.state.lastAttempt.outcome}) < ${Math.round(p.attemptCooldownMs / 60_000)} min`);
  if (last && t.now - last.at < p.minIntervalMs) return skip('min-interval', `last completed campaign ${Math.round((t.now - last.at) / 3600_000 * 10) / 10} h ago < ${Math.round(p.minIntervalMs / 3600_000)} h`);
  const act = userActivity(t.activity, t.now, p, 'start');
  if (act.active) return skip('user-active', act.why);
  const cap = decideAbort(t.machine, { minMemAvailKB: SOAK_BUDGETS.minMemAvailKB, maxLoad1: SOAK_BUDGETS.maxLoad1 });
  if (cap) return skip('machine', cap.detail);
  const n = fitSessions(t.machine.memAvailKB, t.machine.load1, p);
  if (n < p.minSessions) return skip('no-fit', `only ${n} session(s) fit the ${(SOAK_BUDGETS.minMemAvailKB / 1048576).toFixed(0)} GB floor with ${(t.machine.memAvailKB / 1048576).toFixed(1)} GB free (need ≥ ${p.minSessions})`);
  return { run: true, sessions: n, reason: changed };
}

/** While a campaign RUNS: should it yield to the user now? (true ⇒ the scheduler SIGTERMs it; the report says ABORTED.) */
export function shouldYield(a: SoakActivity, now: number, p: SoakSchedulePolicy = DEFAULT_SOAK_POLICY): { yield: boolean; why: string } {
  const r = userActivity(a, now, p, 'yield');
  return { yield: r.active, why: r.why };
}

/** The env the campaign PARENT process gets: an ALLOWLIST (zero tokens — no account credential, no API key, nothing else rides along).
 *  ORCHESTRA_HOME / CLAUDE_CONFIG_DIR are passed ONLY so the campaign's scratch guard refuses them as live dirs; its sessions run under a
 *  scratch HOME/config of their own. `binDirs` = the directories holding the tools the campaign shells out to (`claude` — the CLI it must
 *  exercise — and `pnpm`, which rebuilds the keeper bundle it execs); PATH is those plus the system dirs, nothing inherited. */
export function buildCampaignEnv(base: Record<string, string | undefined>, home: string, binDirs: Array<string | null>): Record<string, string> {
  const env: Record<string, string> = {
    PATH: [...new Set([...binDirs, '/usr/local/bin', '/usr/bin', '/bin'].filter((d): d is string => !!d))].join(':'),
    HOME: home,
    LANG: base.LANG ?? 'C.UTF-8',
    TERM: 'dumb',
  };
  if (base.ORCHESTRA_HOME) env.ORCHESTRA_HOME = base.ORCHESTRA_HOME;
  if (base.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = base.CLAUDE_CONFIG_DIR;
  return env;
}
