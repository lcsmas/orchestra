// Re-run the session budget suite when the installed `claude` changes (#211) — the I/O half. Pure half (record,
// decision, outcome, notice): src/shared/cli-budget-rerun.ts. Design + gates: docs/codebase-map/session-budget.md.
//
// A 10-min main-process poll stats the `claude` on PATH (a `claude update` re-points a symlink), probes
// `--version` only when it moved, and — when that version is not the last BUDGETED one — runs the suite ONCE in
// the background: a child process tree at nice 19 against a local FAKE API (zero tokens), bounded by a hard kill,
// cancelled at quit, never two at once (in-process flag + `suite` lock), never while a load campaign holds the
// `campaign` lock or the machine is saturated (D7). A pass is silent; a broken budget = one log line + one OS
// notice naming the budget and the CLI version (D5). The record survives restarts: the same version never re-triggers.
//
// Everything platform-shaped is INJECTED (`CliBudgetDeps`; production wiring: ./cli-budget-runner.ts), so this
// file imports only node builtins + ../shared — the unit tests and the rig drive THIS module, real fs and locks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseCliVersion } from '../shared/cli-runtime.ts';
import { liveOwner, realLockDeps, tryAcquire, type LockDeps } from '../shared/budget-lock.ts';
import {
  CLI_BUDGET_RERUN,
  budgetNotice,
  classifySuiteRun,
  decideRerun,
  parseRecord,
  type BudgetNotice,
  type Decision,
  type RerunRecord,
  type SkipReason,
  type SuiteRun,
} from '../shared/cli-budget-rerun.ts';

export interface CliBudgetDeps {
  /** `<ORCHESTRA_HOME>` — the record and the locks live under `<home>/session-budget/`. */
  home: string;
  now(): number;
  /** The installed CLI version a NEW session would spawn (`2.1.284`), or null. */
  probeVersion(): Promise<string | null>;
  /** Run the suite once; MUST honour `signal` (kill the tree) and `killAfterMs` (hard bound). */
  runSuite(o: { signal: AbortSignal; killAfterMs: number; turnTimeoutMs: number; nice: number }): Promise<SuiteRun>;
  supported: boolean;
  runnerAvailable(): boolean;
  /** bwrap net+pid namespace available (memoize: it cannot change while the app runs). */
  containmentOk(): boolean;
  resources(): { availableRamMB: number | null; load1: number | null };
  notify(n: BudgetNotice): void;
  log: { info(msg: string): void; warn(msg: string): void };
  locks?: LockDeps;
  /** Hard bound on a run, enforced HERE too (default `CLI_BUDGET_RERUN.runTimeoutMs`): a runner that ignores its own
   *  `killAfterMs` must not hold the single-flight slot (and the suite lock) forever. Tests shrink it. */
  runBoundMs?: number;
}

export type CheckResult =
  | { action: 'skip'; reason: SkipReason }
  | { action: 'ran'; status: 'pass' | 'broken' | 'void' | 'error' | 'cancelled'; version: string | null; notified: boolean };

export function recordPath(home: string): string {
  return path.join(home, 'session-budget', 'cli-version-record.json');
}

export function readRecord(home: string): RerunRecord | null {
  try {
    return parseRecord(fs.readFileSync(recordPath(home), 'utf8'));
  } catch {
    return null;
  }
}

/** Atomic (tmp + rename): a crash mid-write must never leave a half record that reads as "no record" and re-runs. */
function writeRecord(home: string, r: RerunRecord | null): void {
  const file = recordPath(home);
  if (r === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** The backstop fires this long after the bound handed to the runner. */
const BOUND_GRACE_MS = 15_000;

/** The run in flight, with what a CANCEL must undo synchronously (a quit may not wait for the async tail). */
let inFlight: { cancel(): void } | null = null;
/** One log line per (reason, version): a 10-min poll must not repeat "runner missing" forever. */
const skipLogged = new Set<string>();

/**
 * One poll: probe → decide → (maybe) run → record → (maybe) notify. Exported for tests and the rig, which drive
 * it with real fs/locks and either a fake or the real runner. Never throws.
 */
export async function checkCliBudgetOnce(d: CliBudgetDeps): Promise<CheckResult> {
  const locks = d.locks ?? realLockDeps;
  try {
    const version = await d.probeVersion();
    const record = readRecord(d.home);
    const suiteOwner = liveOwner(d.home, 'suite', locks);
    const res = d.resources();
    const decision: Decision = decideRerun({
      version,
      record,
      now: d.now(),
      inFlight: inFlight !== null,
      suiteHeldByOther: !!suiteOwner && suiteOwner.pid !== locks.pid,
      campaignLive: !!liveOwner(d.home, 'campaign', locks),
      supported: d.supported,
      runnerAvailable: d.runnerAvailable(),
      containmentOk: d.containmentOk(),
      availableRamMB: res.availableRamMB,
      load1: res.load1,
    });
    if (decision.action === 'skip') {
      const key = `${decision.reason}@${version ?? '-'}`;
      if (decision.reason !== 'same-version' && !skipLogged.has(key)) {
        skipLogged.add(key);
        d.log.info(`cli-budget: not running the suite for claude ${version ?? '(none)'}: ${decision.reason}`);
      }
      return { action: 'skip', reason: decision.reason };
    }
    return await runOnce(d, locks, version as string, record, decision.attempt);
  } catch (e) {
    d.log.warn(`cli-budget: check failed: ${e instanceof Error ? e.message : String(e)}`);
    return { action: 'skip', reason: 'check-failed' };
  }
}

async function runOnce(d: CliBudgetDeps, locks: LockDeps, version: string, prev: RerunRecord | null, attempt: number): Promise<CheckResult> {
  const lock = tryAcquire(d.home, 'suite', 'cli-version-rerun', locks);
  if (!lock.ok) return { action: 'skip', reason: 'other-run-live' };
  const ctl = new AbortController();
  let cancelled = false;
  let restored = false;
  const restore = () => {
    // A cancel (quit) is not the version's fault: give back the attempt and free the lock, synchronously.
    if (restored) return;
    restored = true;
    writeRecord(d.home, prev);
    lock.release();
  };
  inFlight = {
    cancel() {
      cancelled = true;
      ctl.abort();
      restore();
    },
  };
  const startedAt = d.now();
  // Write-ahead: a crash mid-run leaves `running` (counted, backed off) instead of an unbounded re-run loop.
  writeRecord(d.home, { schema: 1, version, status: 'running', attempts: attempt, startedAt, finishedAt: null, broken: [], pid: locks.pid });
  d.log.info(`cli-budget: claude ${version} differs from the last budgeted ${prev?.version ?? '(none)'} — running the session budget suite once (fake API, zero tokens, nice ${CLI_BUDGET_RERUN.nice})`);
  const bound = d.runBoundMs ?? CLI_BUDGET_RERUN.runTimeoutMs;
  let run: SuiteRun;
  let boundTimer: NodeJS.Timeout | undefined;
  try {
    run = await Promise.race([
      d.runSuite({ signal: ctl.signal, killAfterMs: bound, turnTimeoutMs: CLI_BUDGET_RERUN.turnTimeoutMs, nice: CLI_BUDGET_RERUN.nice }),
      // The runner gets `bound` to kill its own tree; this backstop fires 15 s later and kills it via the signal.
      new Promise<SuiteRun>((resolve) => {
        boundTimer = setTimeout(() => {
          ctl.abort();
          resolve({ result: null, timedOut: true });
        }, bound + BOUND_GRACE_MS);
        boundTimer.unref?.();
      }),
    ]);
  } catch (e) {
    run = { result: { error: e instanceof Error ? e.message : String(e) } };
  } finally {
    clearTimeout(boundTimer);
    inFlight = null;
  }
  const out = classifySuiteRun(run);
  const measured = out.version ?? version;
  if (out.status === 'cancelled' || cancelled) {
    restore();
    d.log.info(`cli-budget: suite for claude ${version} cancelled (app quitting); it runs again next start`);
    return { action: 'ran', status: 'cancelled', version, notified: false };
  }
  lock.release();
  writeRecord(d.home, {
    schema: 1,
    version: measured,
    status: out.status,
    attempts: measured === version ? attempt : 1,
    startedAt,
    finishedAt: d.now(),
    broken: out.broken,
    ...(out.note ? { note: out.note } : {}),
  });
  let notified = false;
  if (out.status === 'broken') {
    const notice = budgetNotice(measured, out.broken);
    d.log.warn(`cli-budget: BUDGET BROKEN on claude ${measured}: ${out.broken.map((b) => b.message).join(' | ')}`);
    d.notify(notice);
    notified = true;
  } else if (out.status === 'pass') {
    d.log.info(`cli-budget: claude ${measured} is within every session budget`);
  } else {
    d.log.warn(`cli-budget: the suite measured nothing for claude ${version} (${out.status}: ${out.note}) — attempt ${attempt}/${CLI_BUDGET_RERUN.maxAttempts}`);
  }
  return { action: 'ran', status: out.status, version: measured, notified };
}

let startTimer: NodeJS.Timeout | null = null;
let pollTimer: NodeJS.Timeout | null = null;

/** Arm the watcher: first check after `startupDelayMs`, then every `pollMs`. Idempotent; timers never keep the app alive. */
export function startCliBudgetRerun(d: CliBudgetDeps, opts: { startupDelayMs?: number; pollMs?: number } = {}): void {
  if (startTimer || pollTimer) return;
  const tick = () => void checkCliBudgetOnce(d);
  startTimer = setTimeout(() => {
    startTimer = null;
    tick();
    pollTimer = setInterval(tick, opts.pollMs ?? CLI_BUDGET_RERUN.pollMs);
    pollTimer.unref?.();
  }, opts.startupDelayMs ?? CLI_BUDGET_RERUN.startupDelayMs);
  startTimer.unref?.();
  d.log.info(`cli-budget: watching the installed claude (first check in ${(opts.startupDelayMs ?? CLI_BUDGET_RERUN.startupDelayMs) / 1000}s, then every ${(opts.pollMs ?? CLI_BUDGET_RERUN.pollMs) / 60000} min)`);
}

/** Disarm and CANCEL an in-flight run (its process tree is killed; the record keeps the previous state). */
export function stopCliBudgetRerun(): void {
  if (startTimer) clearTimeout(startTimer);
  if (pollTimer) clearInterval(pollTimer);
  startTimer = null;
  pollTimer = null;
  cancelCliBudgetRerun();
}

/** Cancel just the in-flight run (tests, and anything that must free the machine now). */
export function cancelCliBudgetRerun(): void {
  inFlight?.cancel();
}

export function isCliBudgetRunning(): boolean {
  return inFlight !== null;
}

/** Test seam: forget the once-per-reason skip log and any in-flight handle. */
export function __resetCliBudgetRerunForTest(): void {
  stopCliBudgetRerun();
  skipLogged.clear();
  inFlight = null;
}

// ─── default probes (shared by the production wiring and the rig) ──────────────────────────────────────────────

/** First executable `claude` on `env.PATH` (the same lookup a session's spawn uses — see ./claude-binary.ts). */
export type ResolveClaude = (env: Record<string, string | undefined>) => string | null;

const versionMemo = new Map<string, Promise<string | null>>();

/** `claude --version` of the binary `resolve` finds, memoized on realpath+mtime so the poll is a stat until a
 *  `claude update` moves it; a failed probe is not memoized. */
export function makeVersionProbe(resolve: ResolveClaude, env: () => Record<string, string | undefined> = () => process.env): () => Promise<string | null> {
  return async () => {
    const bin = resolve(env());
    if (!bin) return null;
    let key: string;
    let real: string;
    try {
      real = fs.realpathSync(bin);
      key = `${real}\0${fs.statSync(real).mtimeMs}`;
    } catch {
      return null;
    }
    let p = versionMemo.get(key);
    if (!p) {
      p = new Promise<string | null>((resolveP) => {
        let out = '';
        const child = spawn(real, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
        const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
        child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
        child.on('error', () => {
          clearTimeout(timer);
          resolveP(null);
        });
        child.on('close', () => {
          clearTimeout(timer);
          resolveP(parseCliVersion(out));
        });
      });
      versionMemo.set(key, p);
    }
    const v = await p;
    if (!v) versionMemo.delete(key);
    return v;
  };
}

/** MemAvailable (MB) from /proc/meminfo and the 1-min load, or null when unreadable. */
export function sampleResources(): { availableRamMB: number | null; load1: number | null } {
  let availableRamMB: number | null = null;
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) availableRamMB = Math.round(Number(m[1]) / 1024);
  } catch {
    /* non-Linux */
  }
  const l = os.loadavg()[0];
  return { availableRamMB, load1: Number.isFinite(l) ? l : null };
}
