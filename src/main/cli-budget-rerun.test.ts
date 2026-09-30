// The REAL controller of the CLI-version budget re-run (#211) — real record file, real lock files, real timers —
// with a fake runner (no CLI here: the real-CLI + real-runner drive is scripts/e2e-cli-version-budget.mjs).
// Arms map to the ticket: version change → exactly one run · same version → zero · broken → one notice naming the
// budget + version · pass → silent · the run never holds anything past its bound.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  __resetCliBudgetRerunForTest,
  cancelCliBudgetRerun,
  checkCliBudgetOnce,
  isCliBudgetRunning,
  readRecord,
  recordPath,
  startCliBudgetRerun,
  stopCliBudgetRerun,
  type CliBudgetDeps,
} from './cli-budget-rerun.ts';
import { lockPath, procStartTicks, tryAcquire } from '../shared/budget-lock.ts';
import { judgeSessionBudget } from '../shared/session-budget.ts';
import { healthyReport } from '../shared/cli-budget-test-report.ts';
import type { RerunRecord, SuiteRun } from '../shared/cli-budget-rerun.ts';

const homes: string[] = [];
after(() => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }); });
function home(): string {
  const base = path.join(os.homedir(), '.cache', 'cli-budget-test');
  fs.mkdirSync(base, { recursive: true });
  const h = fs.mkdtempSync(path.join(base, 'h-'));
  homes.push(h);
  return h;
}

const report = (version: string, o: { count?: number } = {}) => healthyReport({ version, count: o.count });
const passRun = (v: string): SuiteRun => ({ result: { report: report(v), judgement: judgeSessionBudget(report(v)) } });
const brokenRun = (v: string, n = 57): SuiteRun => ({ result: { report: report(v, { count: n }), judgement: judgeSessionBudget(report(v, { count: n })) } });

interface Rig {
  deps: CliBudgetDeps;
  home: string;
  runs: number;
  notices: { title: string; body: string }[];
  logs: string[];
  setVersion(v: string | null): void;
  setNext(fn: (o: { signal: AbortSignal; killAfterMs: number; turnTimeoutMs: number; nice: number }) => Promise<SuiteRun>): void;
  clock: { t: number };
  res: { availableRamMB: number | null; load1: number | null };
}

function rig(o: { version?: string | null } = {}): Rig {
  let version: string | null = o.version === undefined ? '2.1.290' : o.version;
  const r = {} as Rig;
  let next: Parameters<Rig['setNext']>[0] = async () => passRun(version ?? '0.0.0');
  Object.assign(r, {
    home: home(), runs: 0, notices: [], logs: [], clock: { t: 1_800_000_000_000 }, res: { availableRamMB: 8000, load1: 2 },
    setVersion: (v: string | null) => { version = v; },
    setNext: (fn: typeof next) => { next = fn; },
  });
  r.deps = {
    home: r.home,
    now: () => r.clock.t,
    probeVersion: async () => version,
    runSuite: async (a) => { r.runs++; return next(a); },
    supported: true,
    runnerAvailable: () => true,
    containmentOk: () => true,
    resources: () => r.res,
    notify: (n) => r.notices.push(n),
    log: { info: (m) => r.logs.push(`I ${m}`), warn: (m) => r.logs.push(`W ${m}`) },
    runBoundMs: 150_000,
  };
  return r;
}

beforeEach(() => __resetCliBudgetRerunForTest());

test('version change → exactly one run; pass is SILENT and recorded; the same version never re-triggers', async () => {
  const r = rig({ version: '2.1.290' });
  const a = await checkCliBudgetOnce(r.deps);
  assert.deepEqual(a, { action: 'ran', status: 'pass', version: '2.1.290', notified: false });
  assert.equal(r.runs, 1);
  assert.deepEqual(r.notices, [], 'a pass is silent');
  const rec = readRecord(r.home) as RerunRecord;
  assert.equal(rec.version, '2.1.290');
  assert.equal(rec.status, 'pass');
  assert.equal(rec.attempts, 1);
  for (let i = 0; i < 3; i++) assert.deepEqual(await checkCliBudgetOnce(r.deps), { action: 'skip', reason: 'same-version' });
  assert.equal(r.runs, 1, 'zero re-runs for the same version');
  assert.match(r.logs.join('\n'), /claude 2\.1\.290 is within every session budget/);
});

test('the record is DURABLE: a fresh module state (an app restart) with the same home runs nothing for the same version', async () => {
  const r = rig();
  await checkCliBudgetOnce(r.deps);
  assert.equal(r.runs, 1);
  __resetCliBudgetRerunForTest(); // = a new process
  assert.deepEqual(await checkCliBudgetOnce(r.deps), { action: 'skip', reason: 'same-version' });
  assert.equal(r.runs, 1);
  r.setVersion('2.1.291'); // `claude update`
  assert.equal((await checkCliBudgetOnce(r.deps)).action, 'ran');
  assert.equal(r.runs, 2, 'a new version = exactly one more');
  assert.equal(readRecord(r.home)?.version, '2.1.291');
});

test('a broken budget → exactly ONE notice naming the budget AND the CLI version, one WARN line; never re-notified', async () => {
  const r = rig({ version: '2.1.300' });
  r.setNext(async () => brokenRun('2.1.300', 57));
  const a = await checkCliBudgetOnce(r.deps);
  assert.deepEqual(a, { action: 'ran', status: 'broken', version: '2.1.300', notified: true });
  assert.equal(r.notices.length, 1);
  assert.equal(r.notices[0].title, 'Claude Code 2.1.300 broke a session budget');
  assert.match(r.notices[0].body, /session\.beforeFirstReply\.countTokensRequests: allowed at most 0, saw 57/);
  assert.match(r.notices[0].body, /claude 2\.1\.300/);
  assert.ok(r.logs.some((l) => l.startsWith('W ') && /BUDGET BROKEN on claude 2\.1\.300: .*countTokensRequests/.test(l)), 'a WARN log line carries it too');
  const rec = readRecord(r.home) as RerunRecord;
  assert.equal(rec.status, 'broken');
  assert.deepEqual(rec.broken.map((b) => b.id), ['session.beforeFirstReply.countTokensRequests']);
  for (let i = 0; i < 3; i++) await checkCliBudgetOnce(r.deps);
  assert.equal(r.runs, 1);
  assert.equal(r.notices.length, 1, 'the same broken version is not announced again');
});

test('void measured nothing: no notice, not budgeted; retried after the backoff, at most 3 launches per version', async () => {
  const r = rig({ version: '2.1.310' });
  r.setNext(async () => ({ result: { void: true, error: 'no `claude` CLI on PATH' } }));
  assert.equal((await checkCliBudgetOnce(r.deps)).action, 'ran');
  assert.equal(r.notices.length, 0, 'a run that measured nothing must not announce a broken budget');
  assert.equal(readRecord(r.home)?.status, 'void');
  assert.deepEqual(await checkCliBudgetOnce(r.deps), { action: 'skip', reason: 'retry-backoff' });
  r.clock.t += 6 * 3_600_000 + 1;
  assert.equal((await checkCliBudgetOnce(r.deps)).action, 'ran');
  assert.equal(readRecord(r.home)?.attempts, 2);
  r.clock.t += 6 * 3_600_000 + 1;
  assert.equal((await checkCliBudgetOnce(r.deps)).action, 'ran');
  assert.equal(readRecord(r.home)?.attempts, 3);
  r.clock.t += 6 * 3_600_000 + 1;
  assert.deepEqual(await checkCliBudgetOnce(r.deps), { action: 'skip', reason: 'attempts-exhausted' });
  assert.equal(r.runs, 3);
  assert.equal(r.notices.length, 0);
});

test('a runner that THROWS is an error outcome (recorded, no notice, no crash)', async () => {
  const r = rig();
  r.setNext(async () => { throw new Error('spawn EACCES'); });
  const a = await checkCliBudgetOnce(r.deps);
  assert.equal(a.action === 'ran' && a.status, 'error');
  assert.match(readRecord(r.home)?.note ?? '', /spawn EACCES/);
  assert.equal(r.notices.length, 0);
  assert.equal(isCliBudgetRunning(), false);
});

test('single-flight: two concurrent checks for a new version launch ONE run', async () => {
  const r = rig();
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  r.setNext(async () => { await gate; return passRun('2.1.290'); });
  const [a, b] = [checkCliBudgetOnce(r.deps), checkCliBudgetOnce(r.deps)];
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(isCliBudgetRunning(), true);
  release();
  const out = await Promise.all([a, b]);
  assert.equal(r.runs, 1);
  assert.deepEqual(out.map((o) => o.action).sort(), ['ran', 'skip']);
  assert.equal((out.find((o) => o.action === 'skip') as { reason: string }).reason, 'in-flight');
});

test('never while a load campaign holds the campaign lock — deferred, consumed nothing; runs once it is gone', async () => {
  const r = rig();
  const camp = tryAcquire(r.home, 'campaign', 'soak-test');
  assert.ok(camp.ok);
  assert.deepEqual(await checkCliBudgetOnce(r.deps), { action: 'skip', reason: 'campaign' });
  assert.equal(r.runs, 0);
  assert.equal(readRecord(r.home), null, 'a deferral writes no record');
  camp.ok && camp.release();
  assert.equal((await checkCliBudgetOnce(r.deps)).action, 'ran');
  assert.equal(r.runs, 1);
});

test('a STALE campaign lock (dead owner) does not block', async () => {
  const r = rig();
  fs.mkdirSync(path.dirname(lockPath(r.home, 'campaign')), { recursive: true });
  fs.writeFileSync(lockPath(r.home, 'campaign'), JSON.stringify({ pid: 2 ** 22 + 4242, startTicks: 7, kind: 'crashed-soak', startedAt: 1 }));
  assert.equal((await checkCliBudgetOnce(r.deps)).action, 'ran');
});

test('never two at once ACROSS processes: a live suite lock owned by another process defers', async () => {
  const r = rig();
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    fs.mkdirSync(path.dirname(lockPath(r.home, 'suite')), { recursive: true });
    fs.writeFileSync(lockPath(r.home, 'suite'), JSON.stringify({ pid: child.pid, startTicks: procStartTicks(child.pid as number), kind: 'other-run', startedAt: 1 }));
    assert.deepEqual(await checkCliBudgetOnce(r.deps), { action: 'skip', reason: 'other-run-live' });
    assert.equal(r.runs, 0);
  } finally {
    child.kill('SIGKILL');
  }
});

test('the suite lock is HELD during the run and FREED after it (pass, broken and error alike)', async () => {
  for (const mk of [() => passRun('2.1.290'), () => brokenRun('2.1.290'), (): SuiteRun => ({ result: null })]) {
    __resetCliBudgetRerunForTest();
    const r = rig();
    let heldDuring = false;
    r.setNext(async () => { heldDuring = fs.existsSync(lockPath(r.home, 'suite')); return mk(); });
    await checkCliBudgetOnce(r.deps);
    assert.equal(heldDuring, true);
    assert.equal(fs.existsSync(lockPath(r.home, 'suite')), false);
  }
});

test('a saturated machine defers (RAM / load, D7) and consumes nothing', async () => {
  const r = rig();
  r.res.availableRamMB = 1500;
  assert.deepEqual(await checkCliBudgetOnce(r.deps), { action: 'skip', reason: 'ram' });
  r.res.availableRamMB = 8000;
  r.res.load1 = 25;
  assert.deepEqual(await checkCliBudgetOnce(r.deps), { action: 'skip', reason: 'load' });
  assert.equal(r.runs, 0);
  assert.equal(readRecord(r.home), null);
  r.res.load1 = 4;
  assert.equal((await checkCliBudgetOnce(r.deps)).action, 'ran');
});

test('no runner / no claude / unsupported host: skip with a reason, ONE log line per reason (not one per poll)', async () => {
  const r = rig();
  r.deps.runnerAvailable = () => false;
  for (let i = 0; i < 4; i++) assert.deepEqual(await checkCliBudgetOnce(r.deps), { action: 'skip', reason: 'runner-missing' });
  assert.equal(r.logs.filter((l) => /runner-missing/.test(l)).length, 1);
  r.setVersion(null);
  assert.deepEqual(await checkCliBudgetOnce(r.deps), { action: 'skip', reason: 'no-cli' });
  r.deps.supported = false;
  assert.deepEqual(await checkCliBudgetOnce(r.deps), { action: 'skip', reason: 'unsupported' });
  assert.equal(r.runs, 0);
});

test('CANCEL (quit): the run is aborted, the attempt is GIVEN BACK, the lock is freed, nothing is announced; it runs next start', async () => {
  const r = rig();
  const prior: RerunRecord = { schema: 1, version: '2.1.280', status: 'pass', attempts: 1, startedAt: 1, finishedAt: 2, broken: [] };
  fs.mkdirSync(path.dirname(recordPath(r.home)), { recursive: true });
  fs.writeFileSync(recordPath(r.home), JSON.stringify(prior));
  let aborted = false;
  r.setNext(({ signal }) => new Promise<SuiteRun>((resolve) => {
    signal.addEventListener('abort', () => { aborted = true; resolve({ result: null, cancelled: true }); });
  }));
  const pending = checkCliBudgetOnce(r.deps);
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(readRecord(r.home)?.status, 'running', 'write-ahead while running');
  stopCliBudgetRerun(); // what index.ts shutdownSubsystems() calls
  // restored SYNCHRONOUSLY — a quit does not wait for the async tail
  assert.deepEqual(readRecord(r.home), prior);
  assert.equal(fs.existsSync(lockPath(r.home, 'suite')), false);
  const out = await pending;
  assert.equal(aborted, true);
  assert.deepEqual(out, { action: 'ran', status: 'cancelled', version: '2.1.290', notified: false });
  assert.equal(r.notices.length, 0);
  r.setNext(async () => passRun('2.1.290'));
  assert.equal((await checkCliBudgetOnce(r.deps)).action, 'ran', 'next start runs it');
  assert.equal(readRecord(r.home)?.attempts, 1, 'the cancelled launch was not consumed');
});

test('a cancel is ALSO an outcome when the runner ignores the signal and returns a normal result', async () => {
  const r = rig();
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  r.setNext(async () => { await gate; return brokenRun('2.1.290'); });
  const pending = checkCliBudgetOnce(r.deps);
  await new Promise((res) => setTimeout(res, 20));
  cancelCliBudgetRerun();
  release();
  const out = await pending;
  assert.equal(out.action === 'ran' && out.status, 'cancelled');
  assert.equal(r.notices.length, 0, 'a cancelled run announces nothing even if its late result was broken');
  assert.equal(readRecord(r.home), null);
});

test('BOUNDED: a runner that never returns is cut at its bound (+ grace) — error recorded, single-flight slot and lock freed', { timeout: 5000 }, async (t) => {
  const r = rig();
  r.deps.runBoundMs = 1; // + the 15 s grace is the production backstop; shrink via fake timers instead
  const realSetTimeout = globalThis.setTimeout;
  // Fire only the module's backstop (15 s + bound) immediately; leave every other timer real.
  (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => realSetTimeout(fn, ms === 15_001 ? 5 : ms, ...rest)) as typeof setTimeout;
  let aborted = false;
  r.setNext(({ signal }) => new Promise<SuiteRun>(() => { signal.addEventListener('abort', () => { aborted = true; }); }));
  const keepAlive = setInterval(() => {}, 1000); // the module's backstop is unref'd (it must not hold the app open)
  // t.after also runs when the test TIMES OUT (a mutant without the backstop): a named red, not a hung runner.
  t.after(() => { clearInterval(keepAlive); globalThis.setTimeout = realSetTimeout; });
  try {
    const out = await checkCliBudgetOnce(r.deps);
    assert.equal(out.action === 'ran' && out.status, 'error');
    assert.match(readRecord(r.home)?.note ?? '', /bound and was killed/);
    assert.equal(aborted, true, 'the backstop kills the runner\'s tree through the signal');
    assert.equal(isCliBudgetRunning(), false);
    assert.equal(fs.existsSync(lockPath(r.home, 'suite')), false);
    assert.equal(readRecord(r.home)?.attempts, 1, 'a hang IS consumed (else it hangs every poll)');
  } finally {
    clearInterval(keepAlive);
    globalThis.setTimeout = realSetTimeout;
  }
});

test('a crash mid-run leaves `running`: counted and backed off (no re-run on every boot), then retried', async () => {
  const r = rig();
  fs.mkdirSync(path.dirname(recordPath(r.home)), { recursive: true });
  const crashed: RerunRecord = { schema: 1, version: '2.1.290', status: 'running', attempts: 1, startedAt: r.clock.t - 60_000, finishedAt: null, broken: [], pid: 2 ** 22 + 9 };
  fs.writeFileSync(recordPath(r.home), JSON.stringify(crashed));
  assert.deepEqual(await checkCliBudgetOnce(r.deps), { action: 'skip', reason: 'retry-backoff' });
  r.clock.t += 7 * 3_600_000;
  assert.equal((await checkCliBudgetOnce(r.deps)).action, 'ran');
  assert.equal(readRecord(r.home)?.attempts, 2);
});

test('an update landing MID-RUN: the run\'s own reported version is what gets budgeted, and the next poll runs the newer one', async () => {
  const r = rig({ version: '2.1.290' });
  r.setNext(async () => passRun('2.1.295')); // the probe said .290, the binary the run used was already .295
  await checkCliBudgetOnce(r.deps);
  assert.equal(readRecord(r.home)?.version, '2.1.295');
  r.setVersion('2.1.295');
  assert.deepEqual(await checkCliBudgetOnce(r.deps), { action: 'skip', reason: 'same-version' });
  assert.equal(r.runs, 1);
});

test('the runner is handed low priority + a hard bound + a cancellable signal', async () => {
  const r = rig();
  let seen: { nice: number; killAfterMs: number; turnTimeoutMs: number; hasSignal: boolean } | null = null;
  r.setNext(async (a) => { seen = { nice: a.nice, killAfterMs: a.killAfterMs, turnTimeoutMs: a.turnTimeoutMs, hasSignal: a.signal instanceof AbortSignal }; return passRun('2.1.290'); });
  await checkCliBudgetOnce(r.deps);
  assert.deepEqual(seen, { nice: 19, killAfterMs: 150_000, turnTimeoutMs: 60_000, hasSignal: true });
});

test('a corrupt record file reads as none (one run rewrites it) — never a crash, never a loop', async () => {
  const r = rig();
  fs.mkdirSync(path.dirname(recordPath(r.home)), { recursive: true });
  fs.writeFileSync(recordPath(r.home), '{"schema":1,"vers');
  assert.equal((await checkCliBudgetOnce(r.deps)).action, 'ran');
  assert.equal(readRecord(r.home)?.status, 'pass');
  assert.deepEqual(await checkCliBudgetOnce(r.deps), { action: 'skip', reason: 'same-version' });
});

test('the scheduler: first check after the startup delay, then each poll; a flipped version runs once more; stop clears the timers', async () => {
  const r = rig({ version: '2.1.290' });
  startCliBudgetRerun(r.deps, { startupDelayMs: 40, pollMs: 40 });
  assert.equal(r.runs, 0, 'nothing at start: the delay protects session restore');
  await new Promise((res) => setTimeout(res, 120));
  assert.equal(r.runs, 1, 'several polls, one run (same version)');
  r.setVersion('2.1.291');
  await new Promise((res) => setTimeout(res, 120));
  assert.equal(r.runs, 2);
  stopCliBudgetRerun();
  r.setVersion('2.1.292');
  await new Promise((res) => setTimeout(res, 120));
  assert.equal(r.runs, 2, 'stopped: no more polls');
});
