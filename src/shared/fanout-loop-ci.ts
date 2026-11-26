// #607 (spec #601 decisions 8 + 9) — the loop's CI step and its optional start check. Pure over the frozen ports of ledger #613:
// every effect goes through `ctx.deps` (forge / fleet / git) and `ctx.update` (the atomic state write); nothing is kept in memory
// between two passes (decision 12): what a pass must remember lives in `TicketState.ci` (`CiRecord`).
//
// stepCi, per open pull request, once its checks have settled:
//   red ─ first time on this head ─ ONE re-run of the red jobs (recorded BEFORE the call: at most once) ─ green → listed flaky
//   red again ─ the author gets the check name + the log extract (once per head) ─ the same failure after its fix → ticket parked (cause `ci`)
//   the same check red on ≥2 pull requests of the run → the run pauses (`pauseRun`), NO message to an author, no re-run.
import crypto from 'node:crypto';
import { parkTicket, pausedOf, pauseRun, resumeRun, situationFingerprint, type CiRecord, type FanoutState, type TicketState } from './fanout-state.ts';
import type { FleetPort, ForgeCheck, ForgePort, GitPort } from './fanout-loop-ports.ts';

type CheckInfo = ForgeCheck;
type CiState = FanoutState;
type CiTicket = TicketState;

export interface CiOptions {
  /** `--start-check` (decision 9). Off by default. */
  startCheck?: boolean;
  /** Start check: give up when its checks are still pending after this long (default 30 min). */
  startCheckTimeoutMs?: number;
  /** Start check: no check at all after this long = "missing check" (default 2 min). */
  startCheckMissingMs?: number;
  /** Start check polling interval (default 15 s). */
  pollMs?: number;
  /** A re-run's red check whose `jobId` is unchanged is the OLD run; with no job id, wait this long after the re-run before trusting a red (default 60 s, #655: a check with no job id is still re-run). */
  rerunSettleMs?: number;
  /** A re-run whose red is STILL the old run after this long is given up (it is NOT retried: one re-run per ticket): the red then counts as "red again" (default 10 min). */
  rerunExpireMs?: number;
}
/** Branch ops the start check needs and the frozen `GitPort` does not have (reversible default of #607, posted to the ledger's interface log). */
export interface StartProbeGit {
  /** Create `branch` from `base` with ONE empty commit, push it; idempotent (an existing branch answers its head). */
  emptyBranch(branch: string, base: string): Promise<{ head: string }>;
  /** Delete the branch on the remote and locally; a missing branch is fine. */
  deleteBranch(branch: string): Promise<void>;
}
/** The slice of `LoopDeps` these steps read. */
export interface CiDeps {
  run: string;
  now(): string;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  fleet: Pick<FleetPort, 'wake' | 'live'>;
  forge: ForgePort;
  git: GitPort & Partial<StartProbeGit>;
  options: CiOptions;
}
/** What a step receives (frozen by #607 — ledger interface log): the deps, the state read at the pass start, and the atomic read-modify-write of the state file. */
export interface CiCtx {
  deps: CiDeps;
  state: CiState;
  update(mutate: (s: CiState) => CiState): CiState;
}

export const CI_LOG_MAX = 1500;
/** #655 — a check the forge gives no job id for is still re-run once; its red is trusted only this long after the re-run. */
export const NO_JOB_SETTLE_MS = 60_000;
const settleOf = (o: CiOptions): number => o.rerunSettleMs ?? NO_JOB_SETTLE_MS;
/** #655 — the wait between two re-runs of a paused run's red checks: 2, 5, 10, 20 min, then every 20 min. */
export const PAUSE_BACKOFF_MS = [2, 5, 10, 20].map((m) => m * 60_000);
export const pauseBackoffMs = (tries: number): number => PAUSE_BACKOFF_MS[Math.min(tries, PAUSE_BACKOFF_MS.length - 1)];
export interface CiResult { paused: boolean; reran: string[]; told: string[]; parked: string[]; flaky: string[] }

const OPEN_STATUSES = new Set(['started', 'nominated', 'gated']);
const ciTicketIds = (s: CiState): string[] => Object.keys(s.tickets).sort().filter((id) => { const t = s.tickets[id]; return t.pr !== null && t.head !== null && OPEN_STATUSES.has(t.status) && !t.parked; });

/** `green` = ≥1 check and all green; `red` = a red; `pending` otherwise (no checks yet, or one still running). */
export function ciStatus(checks: CheckInfo[]): 'green' | 'pending' | 'red' {
  if (checks.some((c) => c.status === 'red')) return 'red';
  if (checks.length === 0 || checks.some((c) => c.status === 'pending')) return 'pending';
  return 'green';
}

const freshRecord = (t: CiTicket, head: string): CiRecord => ({ head, rerun: null, told: null, reruns: t.ci?.reruns ?? 0, seen: t.ci?.seen ?? [], tells: t.ci?.tells ?? {}, flaky: t.ci?.flaky ?? [], env: [] });
/** What makes two reds "the same failure": the check name + its log tail with the numbers / hashes (timings, ports, line numbers, shas) erased. */
export function failureSignature(c: CheckInfo): string {
  const tail = (c.logExtract ?? '').slice(-600).replace(/[0-9a-f]{7,}/gi, 'H').replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim();
  return `ci:${c.name}:${tail ? crypto.createHash('sha256').update(tail).digest('hex').slice(0, 12) : '-'}`;
}
/** Told this many times about the same set of checks and still red: parked whatever the logs say (a noisy log must not loop the run). */
export const CI_TELLS_MAX = 2;
const recordOf = (t: CiTicket, head: string): CiRecord => (t.ci && t.ci.head === head ? t.ci : freshRecord(t, head));
const withCi = (s: CiState, id: string, f: (r: CiRecord) => CiRecord, now: string): CiState => {
  const t = s.tickets[id];
  return { ...s, tickets: { ...s.tickets, [id]: { ...t, ci: f(recordOf(t, t.head as string)), updatedAt: now } } };
};
const uniq = (xs: string[]): string[] => [...new Set(xs)];
/** A red the human already looked at when resuming: the SAME run (same job id; with no job id, until the re-run happens). A fresh red after the re-run counts again. */
const acknowledged = (rc: CiRecord, c: CheckInfo, now: string, settleMs: number): boolean => rc.env.some((e) => e.name === c.name && (c.jobId ? e.job === c.jobId : e.job === null && (rc.rerun === null || Date.parse(now) - Date.parse(rc.rerun.at) < settleMs)));

/** A red that is still the OLD run: the re-run was made on this head, the check shows the same job id (no id: the settle time has not passed) and the re-run is not given up. */
const staleRed = (rc: CiRecord, c: CheckInfo, deps: CiDeps): boolean => {
  if (c.status !== 'red' || rc.rerun === null) return false;
  const expired = Date.parse(deps.now()) - Date.parse(rc.rerun.at) >= (deps.options.rerunExpireMs ?? 600_000);
  return !expired && ((c.jobId !== undefined && rc.rerun.jobs[c.name] === c.jobId) || (!c.jobId && Date.parse(deps.now()) - Date.parse(rc.rerun.at) < settleOf(deps.options)));
};

/** #655 — a ticket that merges while its re-run is still unjudged (the checks turned green between the CI read and the merge) was flaky all the same: listed for EVERY ticket where a re-run went green. */
export function flakyAtMerge(state: CiState, id: string, now: string): CiState {
  const rc = state.tickets[id]?.ci;
  if (!rc || rc.rerun === null) return state;
  const names = rc.rerun.names.filter((n) => !rc.env.some((e) => e.name === n) && !rc.flaky.includes(n));
  return { ...state, tickets: { ...state.tickets, [id]: { ...state.tickets[id], ci: { ...rc, flaky: uniq([...rc.flaky, ...names]), rerun: null }, updatedAt: now } } };
}

/** The author's message: rendered by code, check name + log extract, nothing else to read. */
export function renderCiMessage(pr: number, head: string, reds: CheckInfo[], noRerun = false): string {
  const blocks = reds.map((c) => `Check: ${c.name}${c.logExtract ? `\n\`\`\`\n${c.logExtract.slice(-CI_LOG_MAX)}\n\`\`\`` : '\n(no log extract available — read the check on the pull request)'}`);
  return [`CI is red on your pull request #${pr} (head ${head.slice(0, 8)})${noRerun ? ' (no automatic re-run: the forge gave no job id to tell a new run from the old one)' : ' after one automatic re-run'}.`, ...blocks, 'Fix it on your branch and push; do not wait for anyone. If the same check is still red after your fix, your ticket is set aside.'].join('\n');
}

export async function stepCi(ctx: CiCtx): Promise<CiResult> {
  const { deps } = ctx;
  let state = ctx.state;
  const res: CiResult = { paused: false, reran: [], told: [], parked: [], flaky: [] };
  if (pausedOf(state)) { res.paused = true; return res; }

  // 1. read every open PR's checks once; a forge error skips THAT ticket for this pass (the next pass retries).
  const rows: Array<{ id: string; pr: number; head: string; checks: CheckInfo[] }> = [];
  for (const id of ciTicketIds(state)) {
    const t = state.tickets[id];
    try { rows.push({ id, pr: t.pr as number, head: t.head as string, checks: await deps.forge.checks(t.pr as number, t.head as string) }); }
    catch (e) { deps.log(`ci: ${id} #${t.pr}: checks unreadable (${(e as Error).message}) — next pass`); }
  }
  // a new head (the author pushed) starts a fresh record, keeping `reruns`, `seen`, `tells` + `flaky`.
  if (rows.some((r) => state.tickets[r.id].ci?.head !== r.head)) {
    state = ctx.update((s) => rows.reduce((acc, r) => (acc.tickets[r.id]?.ci?.head === r.head ? acc : withCi(acc, r.id, (x) => x, deps.now())), s));
  }
  const rec = (id: string, head: string): CiRecord => recordOf(state.tickets[id], head);

  // 2. the environment: the same check red on ≥2 pull requests → pause, before ANY re-run or message (an author must not chase a fault that is not theirs).
  const checksOf = new Map(rows.map((r) => [r.id, r.checks]));
  /** While a transitive upstream is neither merged nor settled green, a dependent's red is not its own (a connected stack carries the upstream's fault; a not-yet-connected one lacks its code): no pause count, no re-run spent, no author message. */
  const carried = (id: string): boolean => {
    const seen = new Set<string>();
    const walk = (x: string): boolean => (state.tickets[x]?.dependsOn ?? []).some((u) => {
      if (seen.has(u)) return false;
      seen.add(u);
      const c = checksOf.get(u);
      return (state.tickets[u]?.status !== 'merged' && !(c && ciStatus(c) === 'green')) || walk(u);
    });
    return walk(id);
  };
  const byCheck = new Map<string, Array<{ id: string; pr: number }>>();
  for (const r of rows) {
    const rc0 = rec(r.id, r.head);
    // #655: a red is judged only after its ONE re-run — a first red (or the old run still showing) is never the environment yet
    const judged = (c: CheckInfo): boolean => (rc0.rerun !== null && !staleRed(rc0, c, deps)) || (!c.jobId && settleOf(deps.options) === 0);
    for (const c of r.checks) if (c.status === 'red' && judged(c) && !acknowledged(rc0, c, deps.now(), settleOf(deps.options)) && !carried(r.id)) byCheck.set(c.name, [...(byCheck.get(c.name) ?? []), { id: r.id, pr: r.pr }]);
  }
  const shared = [...byCheck.entries()].filter(([, v]) => v.length >= 2).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  if (shared.length > 0) {
    const [name, hit] = shared[0];
    const prs = hit.map((h) => h.pr).sort((a, b) => a - b);
    const reason = `check "${name}" is red on ${prs.map((n) => `#${n}`).join(', ')}${shared.length > 1 ? ` (also: ${shared.slice(1).map(([n]) => `"${n}"`).join(', ')})` : ''} — red again after its re-run: the environment, not a ticket; no author was told, the run waits and re-runs`;
    state = ctx.update((s) => {
      let n = pauseRun(s, { reason, check: name, prs, auto: { tries: 0, nextAt: new Date(Date.parse(deps.now()) + pauseBackoffMs(0)).toISOString() } }, deps.now());
      // the mark goes to EVERY ticket red on a blamed check — a dependent whose red is only carried too (it never counted toward the pause): whatever turns green later is the environment, not a flaky test
      for (const [cn] of shared) for (const r of rows) {
        const c = r.checks.find((x) => x.status === 'red' && x.name === cn);
        if (!c) continue;
        n = withCi(n, r.id, (x) => ({ ...x, env: [...x.env.filter((e) => e.name !== cn), { name: cn, job: c.jobId ?? null, reran: false }] }), deps.now());
      }
      return n;
    });
    deps.log(`ci: PAUSE — ${reason}`);
    res.paused = true;
    return res;
  }

  // 3. each settled ticket.
  for (const r of rows) {
    const id = r.id;
    const t = state.tickets[id];
    const rc = rec(id, r.head);
    const stale = (c: CheckInfo): boolean => staleRed(rc, c, deps);
    const pending = r.checks.length === 0 || r.checks.some((c) => c.status === 'pending' || stale(c));
    if (pending) continue;
    const reds = r.checks.filter((c) => c.status === 'red');
    // a settled ticket forgets the environment marks of checks that are no longer red
    if (rc.env.some((e) => !reds.some((c) => c.name === e.name))) state = ctx.update((s) => withCi(s, id, (x) => ({ ...x, env: x.env.filter((e) => reds.some((c) => c.name === e.name)) }), deps.now()));

    if (reds.length === 0) { // green: what a re-run turned green was flaky (unless the environment was blamed for it)
      const flaky = (rc.rerun?.names ?? []).filter((n) => !rc.env.some((e) => e.name === n) && !rc.flaky.includes(n));
      // a green closes the episode: what the author was told no longer counts against a later red on another head
      if (flaky.length > 0 || rc.rerun !== null || rc.seen.length > 0 || Object.keys(rc.tells).length > 0) state = ctx.update((s) => withCi(s, id, (x) => ({ ...x, flaky: uniq([...x.flaky, ...flaky]), rerun: null, seen: [], tells: {} }), deps.now())); // the re-run is judged once
      if (flaky.length > 0) { res.flaky.push(...flaky.map((n) => `${id}:${n}`)); deps.log(`ci: ${id} #${r.pr}: ${flaky.join(', ')} green on the re-run — flaky`); }
      continue;
    }
    if (rc.told) continue; // the author has the red of THIS head; waiting for a fix
    if (carried(id)) { deps.log(`ci: ${id} #${r.pr}: red on ${reds.map((c) => c.name).join(', ')} while an upstream is not merged nor settled green — not its own, waiting`); continue; }
    const own = reds;

    const names = own.map((c) => c.name).sort();
    // The ONE automatic re-run of the TICKET (#655: a red is rerun before any verdict; never again, whatever the head) — recorded first, so a crash can never re-run twice.
    // Without a job id on every red a new run cannot be told from the old one: no re-run path (bounded), the author is told straight away.
    const canTell = own.every((c) => c.jobId) || settleOf(deps.options) > 0;
    // An environment red (marked at a pause) gets ONE more re-run once the run resumed — it never counts against the ticket's own re-run — so a ticket never sits on it without a next step.
    const envOpen = own.filter((c) => rc.env.some((e) => e.name === c.name && !e.reran));
    if (envOpen.length > 0) {
      const en = envOpen.map((c) => c.name).sort();
      const mark = (done: boolean) => (s0: CiState) => withCi(s0, id, (x) => ({ ...x, env: x.env.map((e) => (en.includes(e.name) ? { ...e, reran: done } : e)), ...(done && canTell ? { rerun: { at: deps.now(), names: en, jobs: Object.fromEntries(envOpen.filter((c) => c.jobId).map((c) => [c.name, c.jobId as string])) } } : {}) }), deps.now());
      state = ctx.update(mark(true));
      if (canTell) {
        try { await deps.forge.rerun(r.pr, en); res.reran.push(id); deps.log(`ci: ${id} #${r.pr}: environment re-run ${en.join(', ')}`); }
        catch (e) { deps.log(`ci: ${id} #${r.pr}: environment re-run failed (${(e as Error).message}) — retried next pass`); state = ctx.update(mark(false)); }
        continue;
      }
    }
    const envSpent = own.some((c) => rc.env.some((e) => e.name === c.name && e.reran));
    if (rc.reruns === 0 && canTell && !envSpent) {
      const jobs: Record<string, string> = {};
      for (const c of own) if (c.jobId) jobs[c.name] = c.jobId;
      state = ctx.update((s) => withCi(s, id, (x) => ({ ...x, reruns: x.reruns + 1, rerun: { at: deps.now(), names, jobs } }), deps.now()));
      try { await deps.forge.rerun(r.pr, names); res.reran.push(id); deps.log(`ci: ${id} #${r.pr}: re-run ${names.join(', ')}`); }
      catch (e) { deps.log(`ci: ${id} #${r.pr}: re-run failed (${(e as Error).message}) — retried next pass`); state = ctx.update((s) => withCi(s, id, (x) => ({ ...x, reruns: x.reruns - 1, rerun: null }), deps.now())); }
      continue;
    }
    if (rc.reruns === 0) deps.log(`ci: ${id} #${r.pr}: no job id from the forge — no automatic re-run, the author is told`);
    // the environment (a check the run blamed at its pause) is waited out, not told
    const tellReds = own;

    // red again (after the re-run, or after an earlier fix): same failure as the one the author was told → park; else tell.
    const tellNames = tellReds.map((c) => c.name).sort();
    const fp = situationFingerprint({ openFindings: tellReds.map(failureSignature), tree: 'ci' });
    const key = tellNames.join(',');
    if (rc.seen.includes(fp) || (rc.tells[key] ?? 0) >= CI_TELLS_MAX) {
      const reason = `CI: ${tellNames.join(', ')} still red after the author's fix (the same failure twice)`;
      state = ctx.update((s) => parkTicket(s, id, { cause: 'ci', reason }, deps.now()));
      res.parked.push(id);
      deps.log(`ci: ${id} #${r.pr}: parked — ${reason}`);
      continue;
    }
    if (!t.implementer) { deps.log(`ci: ${id} #${r.pr}: red on ${tellNames.join(', ')} and no recorded author to tell`); continue; }
    try { await deps.fleet.wake(t.implementer, renderCiMessage(r.pr, r.head, tellReds, rc.reruns === 0)); }
    catch (e) { deps.log(`ci: ${id} #${r.pr}: author not reachable (${(e as Error).message}) — next pass`); continue; }
    state = ctx.update((s) => withCi(s, id, (x) => ({ ...x, told: { at: deps.now(), names: tellNames }, seen: uniq([...x.seen, fp]), tells: { ...x.tells, [key]: (x.tells[key] ?? 0) + 1 } }), deps.now()));
    res.told.push(id);
    deps.log(`ci: ${id} #${r.pr}: author told — ${tellNames.join(', ')}`);
  }
  res.paused = !!pausedOf(state);
  return res;
}

// ── #655: a pause never ends the run ───────────────────────────────────────────────────────────────────────────
export interface PauseWatchResult { lifted: boolean; reran: number[]; waitedMs: number }
/**
 * An automatic (environment) pause keeps the loop alive: no order to authors; at each due time (2, 5, 10, 20 min, then every 20) the red
 * checks the pause blamed are re-run; the first green one lifts the pause by itself, and the wait goes to `state.waited` (the report says how long).
 * A pause set by hand has no `auto` record: nothing here touches it (exit 4, `--resume-run`).
 */
export async function stepPauseWatch(ctx: CiCtx): Promise<PauseWatchResult> {
  const { deps } = ctx;
  const out: PauseWatchResult = { lifted: false, reran: [], waitedMs: 0 };
  const pause = pausedOf(ctx.state);
  if (!pause?.auto) return out;
  const auto = pause.auto;
  const mine = (c: CheckInfo): boolean => pause.check === null || c.name === pause.check;
  const rows: Array<{ id: string; pr: number; checks: CheckInfo[] }> = [];
  for (const id of ciTicketIds(ctx.state)) {
    const t = ctx.state.tickets[id];
    if (pause.prs.length && !pause.prs.includes(t.pr as number)) continue;
    try { rows.push({ id, pr: t.pr as number, checks: (await deps.forge.checks(t.pr as number, t.head as string)).filter(mine) }); }
    catch (e) { deps.log(`pause: #${t.pr} checks unreadable (${(e as Error).message}) — next pass`); }
  }
  const now = deps.now();
  const waitedMs = Date.parse(now) - Date.parse(pause.at);
  if (rows.some((r) => r.checks.some((c) => c.status === 'green'))) { // the first green re-run: the environment is back
    ctx.update((s) => {
      const p = pausedOf(s);
      if (!p?.auto) return s;
      const lifted = resumeRun(s, now);
      return { ...lifted, waited: [...(lifted.waited ?? []), { at: p.at, until: now, ms: waitedMs, check: p.check, prs: p.prs, reruns: p.auto.tries }] };
    });
    deps.log(`pause: lifted by itself after ${Math.round(waitedMs / 60_000)} min and ${auto.tries} re-run(s) — check ${pause.check ?? '(any)'} is green`);
    return { lifted: true, reran: [], waitedMs };
  }
  if (Date.parse(now) < Date.parse(auto.nextAt)) return out;
  if (rows.some((r) => r.checks.some((c) => c.status === 'pending'))) return out; // a re-run is going: its result is read next pass
  const tries = auto.tries + 1;
  const nextAt = new Date(Date.parse(now) + pauseBackoffMs(tries)).toISOString();
  ctx.update((s) => { const p = pausedOf(s); return p?.auto ? { ...s, pause: { ...p, auto: { tries, nextAt } }, updatedAt: now } : s; }); // recorded BEFORE the calls
  for (const r of rows) {
    const reds = r.checks.filter((c) => c.status === 'red').map((c) => c.name).sort();
    if (!reds.length) continue;
    try { await deps.forge.rerun(r.pr, reds); out.reran.push(r.pr); deps.log(`pause: #${r.pr} re-run ${reds.join(', ')} (try ${tries}, next in ${Math.round(pauseBackoffMs(tries) / 60_000)} min)`); }
    catch (e) { deps.log(`pause: #${r.pr} re-run failed (${(e as Error).message}) — next try in ${Math.round(pauseBackoffMs(tries) / 60_000)} min`); }
  }
  out.waitedMs = waitedMs;
  return out;
}

// ── decision 9: the optional start check ───────────────────────────────────────────────────────────────────────
export type StartCheckCode = 'start-check-red' | 'start-check-missing' | 'start-check-timeout' | 'start-check-unsupported';
export type StartCheckResult = { ok: true; skipped?: 'off' | 'already-started'; /** #654: red, then green on the one re-run */ flaky?: string[] } | { ok: false; code: StartCheckCode; detail: string; checks: string[] };

/** The probe branch of a run (one per run: a restarted loop adopts it, never opens a second). */
export const startCheckBranch = (run: string): string => `orchestra-start-check-${run.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 8) || 'run'}`;

/**
 * Off by default. On: an EMPTY pull request into the target, its checks awaited, then closed + its branch deleted (whatever the outcome).
 * A red or MISSING check refuses the start (the loop exits 2 `[run-<code>]`, nothing was launched). Skipped once a ticket has started.
 */
export async function stepStartCheck(ctx: CiCtx): Promise<StartCheckResult> {
  const { deps } = ctx;
  if (!deps.options.startCheck) return { ok: true, skipped: 'off' };
  if (Object.values(ctx.state.tickets).some((t) => t.status !== 'todo' || t.start !== undefined)) return { ok: true, skipped: 'already-started' };
  const { emptyBranch, deleteBranch } = deps.git;
  if (!emptyBranch || !deleteBranch) return { ok: false, code: 'start-check-unsupported', detail: 'the git port cannot create + delete the probe branch (GitPort.emptyBranch / deleteBranch)', checks: [] };
  const branch = startCheckBranch(deps.run);
  const base = ctx.state.target;
  const poll = deps.options.pollMs ?? 15_000;
  const timeout = deps.options.startCheckTimeoutMs ?? 30 * 60_000;
  const missingAfter = deps.options.startCheckMissingMs ?? 120_000;
  let pr: number | null = null;
  try {
    const { head } = await emptyBranch.call(deps.git, branch, base);
    pr = (await deps.forge.openPr({ branch, base, title: `start-check: empty pull request of run ${deps.run} — do not merge` })).n;
    deps.log(`start-check: #${pr} (${branch} → ${base}) opened, waiting for its checks`);
    let waited = 0;
    let lastError: string | null = null;
    // #654: a red is re-run ONCE before it refuses the start; the old run still showing is waited out (same job id; no id: the settle time)
    let rerun: { names: string[]; at: number; jobs: Record<string, string> } | null = null;
    for (;;) {
      let checks: CheckInfo[] = [];
      try { checks = await deps.forge.checks(pr, head); lastError = null; } catch (e) { lastError = (e as Error).message; deps.log(`start-check: checks unreadable (${lastError})`); }
      const red = checks.filter((c) => c.status === 'red');
      const stale = (c: CheckInfo): boolean => rerun !== null && waited - rerun.at < (deps.options.rerunExpireMs ?? 600_000) && ((c.jobId !== undefined && rerun.jobs[c.name] === c.jobId) || (!c.jobId && waited - rerun.at < settleOf(deps.options)));
      if (red.length > 0 && red.every(stale)) { await deps.sleep(poll); waited += poll; continue; }
      if (red.length > 0 && rerun === null) {
        const names = red.map((c) => c.name).sort();
        const jobs: Record<string, string> = {};
        for (const c of red) if (c.jobId) jobs[c.name] = c.jobId;
        rerun = { names, at: waited, jobs };
        try { await deps.forge.rerun(pr, names); deps.log(`start-check: #${pr} red on ${names.join(', ')} — re-run once before any verdict`); await deps.sleep(poll); waited += poll; continue; }
        catch (e) { deps.log(`start-check: re-run failed (${(e as Error).message}) — the red stands`); }
      }
      if (red.length > 0) return { ok: false, code: 'start-check-red', detail: `check ${red.map((c) => `"${c.name}"`).join(', ')} is red on the empty pull request #${pr} into ${base}${red[0].logExtract ? `\n${red[0].logExtract.slice(-500)}` : ''}`, checks: red.map((c) => c.name) };
      if (checks.length > 0 && checks.every((c) => c.status === 'green')) return rerun ? { ok: true, flaky: rerun.names } : { ok: true };
      if (checks.length === 0 && waited >= missingAfter) return { ok: false, code: 'start-check-missing', detail: `no check ran on the empty pull request #${pr} into ${base} after ${Math.round(waited / 1000)} s${lastError ? ` — the forge could not be read: ${lastError}` : ''}`, checks: [] };
      if (waited >= timeout) return { ok: false, code: 'start-check-timeout', detail: `checks still pending on #${pr} after ${Math.round(waited / 1000)} s: ${checks.filter((c) => c.status === 'pending').map((c) => c.name).join(', ')}${lastError ? ` — last forge error: ${lastError}` : ''}`, checks: checks.filter((c) => c.status === 'pending').map((c) => c.name) };
      await deps.sleep(poll);
      waited += poll;
    }
  } finally { // the PR and its branch are removed whatever happened (a kill mid-check leaves them: the next start adopts the same branch)
    if (pr !== null) { try { await deps.forge.close(pr); } catch (e) { deps.log(`start-check: closing #${pr} failed (${(e as Error).message})`); } }
    try { await deleteBranch.call(deps.git, branch); } catch (e) { deps.log(`start-check: deleting ${branch} failed (${(e as Error).message})`); }
  }
}
