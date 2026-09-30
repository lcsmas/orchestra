// Pure half of the CLI-version budget re-run (#211): decision table, record parsing, outcome classification, notice.
// Numbers are pinned as LITERALS — a constant asserted against itself shrinks with the bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLI_BUDGET_RERUN,
  budgetNotice,
  classifySuiteRun,
  decideRerun,
  isBudgeted,
  parseRecord,
  type DecideInput,
  type RerunRecord,
} from './cli-budget-rerun.ts';
import { judgeSessionBudget, type SessionBudgetReport } from './session-budget.ts';
import { healthyReport } from './cli-budget-test-report.ts';

const NOW = 1_800_000_000_000;
const rec = (o: Partial<RerunRecord> = {}): RerunRecord => ({ schema: 1, version: '2.1.284', status: 'pass', attempts: 1, startedAt: NOW - 1000, finishedAt: NOW - 500, broken: [], ...o });
const base = (o: Partial<DecideInput> = {}): DecideInput => ({
  version: '2.1.290', record: rec(), now: NOW, inFlight: false, suiteHeldByOther: false, campaignLive: false,
  supported: true, runnerAvailable: true, containmentOk: true, availableRamMB: 8000, load1: 3, ...o,
});

test('bounds are the literals the ticket and D7 name', () => {
  assert.equal(CLI_BUDGET_RERUN.startupDelayMs, 90_000);
  assert.equal(CLI_BUDGET_RERUN.pollMs, 600_000);
  assert.equal(CLI_BUDGET_RERUN.runTimeoutMs, 150_000);
  assert.equal(CLI_BUDGET_RERUN.turnTimeoutMs, 60_000);
  assert.equal(CLI_BUDGET_RERUN.maxAttempts, 3);
  assert.equal(CLI_BUDGET_RERUN.retryAfterMs, 21_600_000);
  assert.equal(CLI_BUDGET_RERUN.minAvailableRamMB, 2048);
  assert.equal(CLI_BUDGET_RERUN.maxLoad1, 20);
  assert.equal(CLI_BUDGET_RERUN.nice, 19);
  assert.ok(Object.isFrozen(CLI_BUDGET_RERUN));
});

test('decide: a version different from the last budgeted one runs (attempt 1); the same version never does', () => {
  assert.deepEqual(decideRerun(base()), { action: 'run', attempt: 1 });
  assert.deepEqual(decideRerun(base({ record: null })), { action: 'run', attempt: 1 }, 'no record = first ever run');
  assert.deepEqual(decideRerun(base({ version: '2.1.284' })), { action: 'skip', reason: 'same-version' });
  assert.deepEqual(decideRerun(base({ version: '2.1.284', record: rec({ status: 'broken' }) })), { action: 'skip', reason: 'same-version' }, 'a BROKEN verdict is final too — no re-notify loop');
  // a rollback to an older version is "different from the last budgeted one"
  assert.deepEqual(decideRerun(base({ version: '2.1.280' })), { action: 'run', attempt: 1 });
});

test('decide: same-version wins over every machine condition (a budgeted version never re-triggers)', () => {
  const held = base({ version: '2.1.284', campaignLive: true, availableRamMB: 1, load1: 99, inFlight: true, suiteHeldByOther: true, runnerAvailable: false });
  assert.deepEqual(decideRerun(held), { action: 'skip', reason: 'same-version' });
});

test('decide: deferrals consume nothing and each names its reason', () => {
  assert.deepEqual(decideRerun(base({ supported: false })), { action: 'skip', reason: 'unsupported' });
  assert.deepEqual(decideRerun(base({ version: null })), { action: 'skip', reason: 'no-cli' });
  assert.deepEqual(decideRerun(base({ inFlight: true })), { action: 'skip', reason: 'in-flight' });
  assert.deepEqual(decideRerun(base({ runnerAvailable: false })), { action: 'skip', reason: 'runner-missing' });
  assert.deepEqual(decideRerun(base({ containmentOk: false })), { action: 'skip', reason: 'no-containment' }, 'D6: no network namespace ⇒ no unattended run');
  assert.deepEqual(decideRerun(base({ suiteHeldByOther: true })), { action: 'skip', reason: 'other-run-live' });
  assert.deepEqual(decideRerun(base({ campaignLive: true })), { action: 'skip', reason: 'campaign' });
  assert.deepEqual(decideRerun(base({ availableRamMB: 2047 })), { action: 'skip', reason: 'ram' });
  assert.deepEqual(decideRerun(base({ availableRamMB: 2048 })), { action: 'run', attempt: 1 }, 'boundary: exactly the minimum runs');
  assert.deepEqual(decideRerun(base({ load1: 20.01 })), { action: 'skip', reason: 'load' });
  assert.deepEqual(decideRerun(base({ load1: 20 })), { action: 'run', attempt: 1 }, 'boundary: exactly D7 max load runs');
});

test('decide: an UNMEASURED machine does not silently disable the alarm', () => {
  assert.deepEqual(decideRerun(base({ availableRamMB: null, load1: null })), { action: 'run', attempt: 1 });
});

test('decide: void/error are retried — bounded (3 launches) and spaced (6 h), per version', () => {
  const void1 = rec({ version: '2.1.290', status: 'void', attempts: 1, startedAt: NOW - 3_600_000 });
  assert.deepEqual(decideRerun(base({ record: void1 })), { action: 'skip', reason: 'retry-backoff' });
  const later = { ...void1, startedAt: NOW - 21_600_001 };
  assert.deepEqual(decideRerun(base({ record: later })), { action: 'run', attempt: 2 });
  assert.deepEqual(decideRerun(base({ record: { ...later, attempts: 2 } })), { action: 'run', attempt: 3 });
  assert.deepEqual(decideRerun(base({ record: { ...later, attempts: 3 } })), { action: 'skip', reason: 'attempts-exhausted' });
  // a NEW version resets the counter even after an exhausted old one
  assert.deepEqual(decideRerun(base({ version: '2.1.291', record: { ...later, attempts: 3 } })), { action: 'run', attempt: 1 });
  // a crash left `running`: counted + backed off like any unmeasured launch
  assert.deepEqual(decideRerun(base({ record: rec({ version: '2.1.290', status: 'running', attempts: 1, startedAt: NOW - 60_000 }) })), { action: 'skip', reason: 'retry-backoff' });
});

test('isBudgeted: only pass/broken of THAT version', () => {
  assert.equal(isBudgeted(rec(), '2.1.284'), true);
  assert.equal(isBudgeted(rec({ status: 'broken' }), '2.1.284'), true);
  for (const status of ['running', 'void', 'error'] as const) assert.equal(isBudgeted(rec({ status }), '2.1.284'), false, status);
  assert.equal(isBudgeted(rec(), '2.1.285'), false);
  assert.equal(isBudgeted(null, '2.1.284'), false);
});

test('parseRecord: round-trips, and anything malformed reads as no record', () => {
  const r = rec({ status: 'broken', broken: [{ id: 'session.beforeFirstReply.countTokensRequests', message: 'BUDGET BROKEN x' }], note: 'n', pid: 7 });
  assert.deepEqual(parseRecord(JSON.stringify(r)), r);
  for (const bad of ['', '{', 'null', '[]', '{"schema":2}', JSON.stringify({ ...r, schema: 2 }), JSON.stringify({ ...r, version: '' }), JSON.stringify({ ...r, status: 'weird' })]) {
    assert.equal(parseRecord(bad), null, JSON.stringify(bad));
  }
});

// ── outcome classification, over REAL judge output ─────────────────────────────────────────────────────────────

const report = healthyReport;
const run = (r: SessionBudgetReport & { error?: string }) => ({ result: { report: r, judgement: judgeSessionBudget(r) } });

test('classify: pass, and the version is the one the RUN reported', () => {
  const out = classifySuiteRun(run(report()));
  assert.deepEqual(out, { status: 'pass', version: '2.1.290', broken: [], note: '' });
});

test('classify: a broken budget names the budget id and its message', () => {
  const out = classifySuiteRun(run(report({ count: 57 })));
  assert.equal(out.status, 'broken');
  assert.equal(out.version, '2.1.290');
  assert.deepEqual(out.broken.map((b) => b.id), ['session.beforeFirstReply.countTokensRequests']);
  assert.match(out.broken[0].message, /allowed at most 0, saw 57/);
  const two = classifySuiteRun(run(report({ count: 3, mainModel: 2 })));
  assert.deepEqual(two.status === 'broken' && two.broken.map((b) => b.id), ['session.beforeFirstReply.modelRequests', 'session.beforeFirstReply.countTokensRequests']);
});

test('classify: a run that RAISED is VOID via the judge (single source) — never a pass, never a notice, even with a budget broken', () => {
  const both = classifySuiteRun(run(report({ count: 5, error: 'teardown: boom' })));
  assert.equal(both.status, 'void');
  assert.deepEqual(both.broken, []);
  assert.match(both.note, /INSTRUMENT VOID instrument\.runCompleted/);
  const dirty = classifySuiteRun(run(report({ error: 'teardown: boom' })));
  assert.equal(dirty.status, 'void');
  assert.match(dirty.note, /teardown: boom/);
});

test('classify: a slow-but-healthy startup PASSES (one extra refused retry per 1000 ms of startup on a known host) — no false alarm', () => {
  assert.equal(classifySuiteRun(run(report({ startupAttempts: 4, startupSpanMs: 1500 }))).status, 'pass', '3 + floor(1500/1000) = 4 allowed');
  assert.equal(classifySuiteRun(run(report({ startupAttempts: 3, startupSpanMs: 400 }))).status, 'pass');
});

test('classify: a startup stalled past 8 s is VOID (not comparable) — never a false "budget broken" (the 6-attempt run of #211 took 12.8 s)', () => {
  const stalled = classifySuiteRun(run(report({ startupAttempts: 6, startupSpanMs: 12_800 })));
  assert.equal(stalled.status, 'void');
  assert.deepEqual(stalled.broken, []);
  assert.match(stalled.note, /instrument\.startupNotStalled/);
});

test('classify: attempts beyond the retry allowance are broken, naming the host budget', () => {
  const out = classifySuiteRun(run(report({ startupAttempts: 5, startupSpanMs: 1500 })));
  assert.equal(out.status, 'broken');
  assert.deepEqual(out.broken.map((b) => b.id), ['session.beforeFirstReply.startupEgressAttempts.api.anthropic.com:443']);
});

test('classify: VOID (the subject never mounted) is never a pass and never a broken budget', () => {
  const out = classifySuiteRun(run(report({ mcp: 0, firstReply: null })));
  assert.equal(out.status, 'void');
  assert.match(out.note, /INSTRUMENT VOID/);
  assert.deepEqual(classifySuiteRun({ result: { void: true, error: 'no `claude` CLI on PATH' } }), { status: 'void', version: null, broken: [], note: 'no `claude` CLI on PATH' });
});

test('classify: errors, timeouts and cancels', () => {
  assert.equal(classifySuiteRun({ result: null }).status, 'error');
  assert.equal(classifySuiteRun({ result: { error: 'no result line (rc=2): x' } }).status, 'error');
  const t = classifySuiteRun({ result: null, timedOut: true });
  assert.equal(t.status, 'error');
  assert.match(t.note, /run bound and was killed/);
  assert.equal(classifySuiteRun({ result: null, cancelled: true }).status, 'cancelled');
  assert.equal(classifySuiteRun({ result: { report: report({ count: 9 }), judgement: judgeSessionBudget(report({ count: 9 })) }, cancelled: true }).status, 'cancelled', 'cancel wins');
});

test('notice: names the CLI version and the budget id; caps the list', () => {
  const b = [{ id: 'session.beforeFirstReply.countTokensRequests', message: 'BUDGET BROKEN session.beforeFirstReply.countTokensRequests: allowed at most 0, saw 57 — x' }];
  const n = budgetNotice('2.1.290', b);
  assert.equal(n.title, 'Claude Code 2.1.290 broke a session budget');
  assert.match(n.body, /session\.beforeFirstReply\.countTokensRequests: allowed at most 0, saw 57/);
  assert.match(n.body, /claude 2\.1\.290/);
  assert.doesNotMatch(n.body, /BUDGET BROKEN/, 'the marker is noise in a toast');
  const many = budgetNotice('2.1.290', Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, message: `BUDGET BROKEN b${i}: m` })));
  assert.match(many.body, /\(\+2 more\)/);
  assert.doesNotMatch(many.body, /b3/);
});
