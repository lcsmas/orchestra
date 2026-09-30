// #214 field alarms — PURE half. Real debug-log excerpts (scripts/fixtures/session-debug-logs/) drive the
// parser; every arm names the clause it pins. The driven half (real engine + real sampleTick + real CLI logs)
// is scripts/e2e-field-budget-alarms.mjs (wrapped by src/main/field-budget-alarms.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AlarmLedger,
  SESSION_BUDGET_ALARM_PREFIX,
  countStdioMcpServers,
  feedStartWindow,
  formatBudgetAlarm,
  newStartWindow,
  pushTreeSample,
  rssSlopeBytesPerMin,
  startWindowBreaches,
  maxTreeProcesses,
  treeBreaches,
  type StartWindow,
  type TreeSample,
} from './session-budget-alarms.ts';
import { SESSION_BUDGETS, judgeSessionBudget, type SessionBudgetReport } from './session-budget.ts';
import { parseSessionDebugLogName, sessionDebugLogName } from './session-debug-log.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, '..', '..', 'scripts', 'fixtures', 'session-debug-logs');
const fixture = (n: string): string => fs.readFileSync(path.join(FIX, n), 'utf8');

const feed = (text: string): StartWindow => {
  const w = newStartWindow();
  feedStartWindow(w, text);
  return w;
};
const ids = (w: StartWindow, b = SESSION_BUDGETS): string[] => startWindowBreaches(w, b).map((v) => v.id);

const T0 = Date.parse('2026-09-30T03:00:00.000Z');
const HAIKU = 'claude-haiku-4-5-20251001';
const line = (offMs: number, rest: string): string => `${new Date(T0 + offMs).toISOString()} ${rest}`;
const disp = (offMs: number, model: string): string => line(offMs, `[DEBUG] [API:timing] dispatching to firstParty model=${model}`);
/** A `/v1/messages` call = its dispatch line (model) + its REQUEST line; `id` may be omitted like on API-key CLIs. */
const req = (offMs: number, id: string | null, source: string, model = 'claude-opus-5-5', p = '/v1/messages'): string =>
  (p === '/v1/messages' ? `${disp(offMs, model)}\n` : '') + line(offMs, `[DEBUG] [API REQUEST] ${p}${id ? ` x-client-request-id=${id}` : ''} source=${source}`);
const fb = (offMs: number, elapsed: number): string => line(offMs, `[DEBUG] [API:timing] first byte after ${elapsed}ms`);

// ── requests per session start (from the debug log) ─────────────────────────

test('real normal start: title (haiku) + opening turn leave in the SAME ms, answered in the other order → main=1, side haiku=1, window closed, silent', () => {
  const w = feed(fixture('real-title-and-opening-turn.txt'));
  assert.equal(w.counts.main, 1);
  assert.deepEqual(w.counts.side, { [HAIKU]: 1 });
  assert.equal(w.counts.model, 2);
  assert.equal(w.counts.count_tokens + w.counts.other, 0);
  assert.equal(w.closed, true);
  assert.deepEqual(ids(w), []);
});

test('real post-#176 start with ONE count_tokens before the first reply → exactly the count_tokens budget, measured 1', () => {
  const w = feed(fixture('real-one-count-tokens-before-reply.txt'));
  assert.equal(w.counts.main, 1);
  assert.equal(w.counts.count_tokens, 1);
  const b = startWindowBreaches(w);
  assert.deepEqual(b.map((v) => v.id), ['session.beforeFirstReply.countTokensRequests']);
  assert.equal(b[0].actual, 1);
  assert.equal(b[0].limit, 'at most 0');
});

test('real #176 fan-out: 52 count_tokens before the first reply → count_tokens budget, measured 52 (the large shape)', () => {
  const w = feed(fixture('real-count-tokens-burst.txt'));
  assert.equal(w.counts.count_tokens, 52);
  assert.equal(w.counts.main, 1);
  assert.equal(w.closed, true);
  const b = startWindowBreaches(w);
  assert.deepEqual(b.map((v) => v.id), ['session.beforeFirstReply.countTokensRequests']);
  assert.match(b[0].message, /allowed at most 0, saw 52/);
});

test('real CLI vs the fake API (the suite\'s own session, no x-client-request-id): silent though ~57 count_tokens follow the reply', () => {
  const text = fixture('real-cli-fake-api-normal.txt');
  const after = text.split('\n').filter((l) => l.includes('/count_tokens')).length;
  assert.ok(after >= 50, `fixture premise: the turn-end gauge refresh count_tokens are in the file (${after})`);
  const w = feed(text);
  assert.equal(w.counts.main, 1);
  assert.deepEqual(Object.keys(w.counts.side), [HAIKU], 'the CLI\'s own title call is the one budgeted side call');
  assert.equal(w.counts.count_tokens, 0);
  assert.equal(w.closed, true);
  assert.deepEqual(ids(w), []);
});

test('real CLI vs the fake API: the boot-context-read session counts EXACTLY the count_tokens sent before the first reply', () => {
  const text = fixture('real-cli-fake-api-boot-context-read.txt').split('\n');
  const firstByte = text.findIndex((l) => l.includes('first byte after'));
  const oracle = text.slice(0, firstByte).filter((l) => l.includes('/count_tokens')).length; // independent of the parser
  assert.ok(oracle >= 50, `fixture premise: the #176 burst is before the first reply (${oracle})`);
  const w = feed(text.join('\n'));
  assert.equal(w.counts.count_tokens, oracle);
  assert.equal(w.counts.main, 1);
  const b = startWindowBreaches(w);
  assert.deepEqual(b.map((v) => v.id), ['session.beforeFirstReply.countTokensRequests']);
  assert.equal(b[0].actual, oracle);
});

test('window is monotone and shuts at the first reply: later turns are never counted', () => {
  const w = feed(fixture('real-title-and-opening-turn.txt')); // the file carries another turn after the first reply
  assert.equal(w.counts.main, 1);
  const before = JSON.stringify(w.counts);
  feedStartWindow(w, req(999_000, 'late-1', 'sdk') + '\n' + req(999_001, 'late-2', 'sdk', undefined, '/v1/messages/count_tokens') + '\n');
  assert.equal(JSON.stringify(w.counts), before);
});

test('a model call that ended in `API error` is un-counted, so a retry after a 429 is not a second request', () => {
  const w = feed(fixture('real-errored-opening-request.txt'));
  assert.equal(w.counts.main, 0);
  assert.equal(w.counts.model, 0);
  assert.equal(w.closed, false);
  assert.deepEqual(ids(w), []);
  // the retry (a new id) answers: still ONE main request, window closes
  feedStartWindow(w, `${req(1000, 'retry-1', 'sdk')}\n${fb(1500, 500)}\n`);
  assert.equal(w.counts.main, 1);
  assert.equal(w.closed, true);
  assert.deepEqual(ids(w), []);
});

test('an errored SIDE call is un-counted too (its model entry is removed, not left at 0)', () => {
  const w = feed(`${req(0, 't1', 'generate_session_title', HAIKU)}\n${line(300, '[ERROR] API error x-client-request-id=t1 (give this)')}\n`);
  assert.deepEqual(w.counts.side, {});
  assert.equal(w.counts.model, 0);
});

test('two main (user-turn) requests before any reply → modelRequests budget (control: the must-fire arm)', () => {
  const w = feed(`${req(0, 'a', 'sdk')}\n${req(100, 'b', 'sdk')}\n`);
  const b = startWindowBreaches(w);
  assert.deepEqual(b.map((v) => v.id), ['session.beforeFirstReply.modelRequests']);
  assert.equal(b[0].actual, 2);
  assert.match(b[0].message, /window still open/);
});

test('a SECOND haiku side call before the reply breaks sideModelRequests; a side call on an UNLISTED model is allowed 0', () => {
  const two = feed(`${req(0, 't1', 'generate_session_title', HAIKU)}\n${req(5, 'x1', 'quota_probe', HAIKU)}\n${req(9, 'm', 'sdk')}\n`);
  const b = startWindowBreaches(two);
  assert.deepEqual(b.map((v) => v.id), [`session.beforeFirstReply.sideModelRequests.${HAIKU}`]);
  assert.equal(b[0].actual, 2);
  const other = feed(`${req(0, 't1', 'some_new_startup_probe', 'claude-sonnet-5-5')}\n`);
  assert.deepEqual(ids(other), ['session.beforeFirstReply.sideModelRequests.claude-sonnet-5-5']);
});

test('a non-messages route is `other` and trips otherRequests', () => {
  const w = feed(`${req(0, 'a', 'sdk')}\n${req(50, 'b', 'models', undefined, '/v1/models')}\n`);
  assert.deepEqual([w.counts.main, w.counts.other], [1, 1]);
  assert.deepEqual(ids(w), ['session.beforeFirstReply.otherRequests']);
});

test('the session-title side query alone (haiku, within its budget of 1) is silent; no main request yet', () => {
  const w = feed(`${req(0, 't', 'generate_session_title', HAIKU)}\n`);
  assert.deepEqual(w.counts.side, { [HAIKU]: 1 });
  assert.equal(w.counts.main, 0);
  assert.deepEqual(ids(w), []);
});

test('one request id is one request (a duplicated line does not double-count)', () => {
  const w = feed(`${req(0, 'same', 'sdk')}\n${req(1, 'same', 'sdk')}\n`);
  assert.equal(w.counts.main, 1);
});

test('an id-less log (API-key auth): every request line counts once, models still pair in order', () => {
  const w = feed(`${req(0, null, 'generate_session_title', HAIKU)}\n${req(2, null, 'sdk', 'claude-opus-4-8')}\n${fb(500, 500)}\n${fb(520, 518)}\n`);
  assert.deepEqual([w.counts.main, w.counts.side[HAIKU], w.closed], [1, 1, true]);
});

test('incremental feeding (any line batching) equals whole-file feeding', () => {
  const text = fixture('real-count-tokens-burst.txt');
  const whole = feed(text);
  const lines = text.split('\n').filter(Boolean);
  for (const step of [1, 3, 7, 55]) {
    const w = newStartWindow();
    for (let i = 0; i < lines.length; i += step) feedStartWindow(w, lines.slice(i, i + step).join('\n') + '\n');
    assert.deepEqual(w.counts, whole.counts, `step ${step}`);
    assert.equal(w.closed, whole.closed, `step ${step}`);
  }
});

// ── budgets come from the single source ─────────────────────────────────────

test('request budgets are READ from the budgets object, not copied: a loosened budget silences the same log', () => {
  const w = feed(fixture('real-one-count-tokens-before-reply.txt'));
  assert.deepEqual(ids(w), ['session.beforeFirstReply.countTokensRequests']);
  const loose = { ...SESSION_BUDGETS, beforeFirstReply: { ...SESSION_BUDGETS.beforeFirstReply, countTokensRequests: 1 } };
  assert.deepEqual(ids(w, loose), []);
  const tight = { ...SESSION_BUDGETS, beforeFirstReply: { ...SESSION_BUDGETS.beforeFirstReply, modelRequests: 0 } };
  assert.deepEqual(ids(feed(fixture('real-title-and-opening-turn.txt')), tight), ['session.beforeFirstReply.modelRequests']);
  const noSide = { ...SESSION_BUDGETS, beforeFirstReply: { ...SESSION_BUDGETS.beforeFirstReply, sideModelRequests: {} } };
  assert.deepEqual(ids(feed(fixture('real-title-and-opening-turn.txt')), noSide), [`session.beforeFirstReply.sideModelRequests.${HAIKU}`]);
});

test('alarm verdict ids are the suite\'s ids: judgeSessionBudget names the same budgets for the same counts', () => {
  for (const f of ['real-count-tokens-burst.txt', 'real-one-count-tokens-before-reply.txt', 'real-title-and-opening-turn.txt']) {
    const c = feed(fixture(f)).counts;
    const report = { requests: { beforeFirstReply: c, afterFirstReply: c, total: c } } as unknown as SessionBudgetReport;
    const suite = judgeSessionBudget(report).verdicts.filter((v) => v.kind === 'budget' && v.id.startsWith('session.beforeFirstReply.') && !v.ok).map((v) => v.id);
    assert.deepEqual(ids(feed(fixture(f))), suite, f);
  }
  const two = feed(`${req(0, 't1', 'generate_session_title', HAIKU)}\n${req(5, 'x1', 'quota_probe', HAIKU)}\n${req(9, 'm', 'sdk')}\n`).counts;
  const rep = { requests: { beforeFirstReply: two, afterFirstReply: two, total: two } } as unknown as SessionBudgetReport;
  assert.deepEqual(judgeSessionBudget(rep).verdicts.filter((v) => v.kind === 'budget' && !v.ok && v.id.startsWith('session.beforeFirstReply.')).map((v) => v.id), [`session.beforeFirstReply.sideModelRequests.${HAIKU}`]);
});

test('neither alarm module restates a budget number (import, never copy)', () => {
  for (const f of ['src/shared/session-budget-alarms.ts', 'src/main/session-budget-alarms.ts']) {
    const src = fs.readFileSync(path.join(HERE, '..', '..', f), 'utf8');
    assert.doesNotMatch(src, /1024 \* 1024 \* 1024/, `${f}: a RSS limit literal`);
    assert.doesNotMatch(src, /\b(?:8|30) \* 1024 \* 1024/, `${f}: a slope limit literal`);
    assert.doesNotMatch(src, /(?:settledSamples|slopeMinSamples|maxIdleRssSlopeBytesPerMin|mcpPerConfiguredServer|perMcpServer)\s*[:=]\s*\d/, `${f}: a budget assignment`);
  }
  const shared = fs.readFileSync(path.join(HERE, 'session-budget-alarms.ts'), 'utf8');
  assert.match(shared, /from '\.\/session-budget\.ts'/);
  assert.match(shared, /p\.keeper \+ p\.cli \+ p\.mcpPerConfiguredServer \* mcpStdio \+ p\.hook \+ p\.other/, 'limits are derived from `processes`');
});

// ── session tree (from the resource-monitor samples) ─────────────────────────

const F = SESSION_BUDGETS.field;
const P = SESSION_BUDGETS.processes;
const MIN = 60_000;
const MIB = 1024 * 1024;
const sample = (i: number, over: Partial<TreeSample> = {}, startAt = T0, every = MIN): TreeSample => ({
  at: startAt + i * every, procCount: 2, rssBytes: 200 * MIB, status: 'idle', background: false, ...over,
});
const series = (n: number, f: (i: number) => Partial<TreeSample> = () => ({}), startAt = T0, every = MIN): TreeSample[] => {
  let h: TreeSample[] = [];
  for (let i = 0; i < n; i++) h = pushTreeSample(h, sample(i, f(i), startAt, every));
  return h;
};
const treeIds = (h: TreeSample[], n: number | null, b = SESSION_BUDGETS): string[] => treeBreaches(h, n, b).map((v) => v.id);
const limit1 = { maxProcesses: maxTreeProcesses(1) }; // keeper + cli + 1 stdio MCP server: what `processes` allows, DERIVED

test('maxTreeProcesses is `processes` derived for n servers: keeper + cli + n·mcp + hook + other', () => {
  assert.equal(maxTreeProcesses(0), P.keeper + P.cli + P.hook + P.other);
  assert.equal(maxTreeProcesses(3), P.keeper + P.cli + 3 * P.mcpPerConfiguredServer + P.hook + P.other);
  const other = { ...SESSION_BUDGETS, processes: { ...P, keeper: 2, hook: 4 } };
  assert.equal(maxTreeProcesses(2, other), 2 + P.cli + 2 * P.mcpPerConfiguredServer + 4 + P.other);
});

test('the derived process limit IS the one the suite enforces: judgeSessionBudget agrees on both sides of it', () => {
  for (const n of [0, 1, 4]) {
    const limit = maxTreeProcesses(n);
    const verdictOf = (total: number) => {
      const census = { total, zombies: 0, rssKB: 0, byKind: { cli: 1, keeper: 1, mcp: n, hook: 0, other: Math.max(0, total - 2 - n) } };
      const report = { fixture: { mcpServers: n }, processes: { atFirstReply: census, atEnd: census } } as unknown as SessionBudgetReport;
      return judgeSessionBudget(report).verdicts.find((v) => v.id === 'session.processes.atEnd.total')!;
    };
    assert.equal(verdictOf(limit).ok, true, `n=${n}: at the limit`);
    assert.equal(verdictOf(limit + 1).ok, false, `n=${n}: one over`);
  }
});

test('countStdioMcpServers counts STDIO servers only (an http server has no child process) — real connect lines', () => {
  const text = fixture('real-mcp-connect.txt');
  const oracle = new Set(text.split('\n').filter((l) => l.includes('transport: stdio)')).map((l) => l.slice(l.indexOf('MCP server "') + 12, l.indexOf('": Successfully')))).size;
  assert.equal(oracle, 1);
  assert.equal(countStdioMcpServers(text), oracle);
  assert.equal(countStdioMcpServers(text + text), oracle, 'a reconnect of the same server is not a second server');
  assert.equal(countStdioMcpServers('nothing here'), 0);
});

test('processes: only SETTLED samples count, and only when sustained settledSamples in a row and strictly over the limit', () => {
  const over = () => ({ procCount: limit1.maxProcesses + 5 });
  assert.deepEqual(treeIds(series(F.settledSamples - 1, over), 1), [], 'one short of sustained');
  const b = treeBreaches(series(F.settledSamples, over), 1);
  assert.deepEqual(b.map((v) => v.id), ['session.processes.atEnd.total']);
  assert.equal(b[0].actual, limit1.maxProcesses + 5);
  assert.equal(b[0].limit, `at most ${limit1.maxProcesses}`);
  assert.match(b[0].message, /settled \(idle, no background work\) for 15 consecutive samples .* 1 stdio MCP server/);
  assert.deepEqual(treeIds(series(F.settledSamples, () => ({ procCount: limit1.maxProcesses })), 1), [], 'exactly at the limit is within budget');
  const touching = series(F.settledSamples, (i) => ({ procCount: i === F.settledSamples - 1 ? limit1.maxProcesses + 1 : limit1.maxProcesses }));
  assert.deepEqual(treeIds(touching, 1), [], 'a streak that only TOUCHES the limit and then crosses it is not sustained');
  const running = series(F.settledSamples + 3, (i) => ({ ...over(), status: i === F.settledSamples - 1 ? 'running' : 'idle' }));
  assert.deepEqual(treeIds(running, 1), [], 'a running sample inside the trailing run ends the settled streak');
  const bg = series(F.settledSamples + 3, (i) => ({ ...over(), background: i === F.settledSamples + 1 }));
  assert.deepEqual(treeIds(bg, 1), [], 'live background work inside the trailing run ends the settled streak');
  assert.deepEqual(treeIds(series(F.settledSamples, () => ({ ...over(), status: 'running' })), 1), [], 'a RUNNING session is never judged on processes');
  assert.deepEqual(treeIds(series(F.settledSamples, () => ({ ...over(), status: null })), 1), [], 'an unknown status is not idle');
  assert.deepEqual(treeIds(series(F.settledSamples, () => ({ ...over(), background: true })), 1), [], 'idle with live background work is work, not a leak');
});

test('processes: the limit follows the server count; an UNKNOWN server count is not judged (never a guessed limit)', () => {
  const at = (n: number) => series(F.settledSamples, () => ({ procCount: maxTreeProcesses(n) + 1 }));
  assert.deepEqual(treeIds(at(3), 3), ['session.processes.atEnd.total']);
  assert.deepEqual(treeIds(at(3), 4), [], 'the same tree is fine when 4 servers are configured');
  assert.deepEqual(treeIds(series(F.settledSamples, () => ({ procCount: 500 })), null), [], 'n unknown ⇒ process count unjudged');
});

test('tree MEMORY level is deliberately not judged in the field (fixture-calibrated base; growth is the slope\'s job)', () => {
  const fat = series(F.settledSamples + 5, () => ({ procCount: limit1.maxProcesses, rssBytes: 4000 * MIB }));
  assert.deepEqual(treeIds(fat, 1), [], 'a settled skeleton tree at 4 GB, flat, is not a breach');
  assert.deepEqual(treeIds(fat, 1).filter((x) => x.includes('memory')), []);
});

test('slope: a SETTLED leak-shaped ramp breaches; half the rate, few samples, short history, a late spike, running, background or a broken run do not', () => {
  const n = Math.ceil(F.slopeWindowMs / MIN) + 1; // 31 samples ≈ 30 min
  const limitMB = F.maxIdleRssSlopeBytesPerMin / MIB;
  const ramp = (mbPerMin: number, extra: Partial<TreeSample> = {}) => (i: number) => ({ rssBytes: 100 * MIB + i * mbPerMin * MIB, ...extra });
  const isSlope = (h: TreeSample[]) => treeIds(h, null).filter((x) => x.includes('Slope'));
  const b = treeBreaches(series(n, ramp(2 * limitMB)), null);
  const slope = b.find((v) => v.id === 'session.field.settledRssSlopeBytesPerMin');
  assert.ok(slope, 'a steep settled ramp must breach');
  assert.ok(Math.abs((slope.actual as number) - 2 * limitMB * MIB) < 1024, 'the measured slope equals the ramp rate');
  assert.deepEqual(isSlope(series(n, ramp(limitMB / 2))), [], 'half-rate ramp');
  assert.deepEqual(isSlope(series(F.slopeMinSamples - 1, ramp(2 * limitMB))), [], 'too few samples for a trend');
  // Isolate each guard: count and span are separate (a 90 s cadence spans the window with too few samples).
  assert.deepEqual(isSlope(series(F.slopeMinSamples - 1, (i) => ({ rssBytes: 100 * MIB + i * 3 * limitMB * MIB }), T0, 90_000)), [], 'span long enough but too few samples');
  assert.equal(isSlope(series(F.slopeMinSamples, (i) => ({ rssBytes: 100 * MIB + i * 3 * limitMB * MIB }), T0, 90_000)).length, 1, 'control: one more sample at the same cadence gives a verdict');
  assert.deepEqual(isSlope(series(25, (i) => ({ rssBytes: 100 * MIB + i * 12 * limitMB * MIB }), T0, 30_000)), [], 'plenty of samples but only 12 min of history');
  assert.deepEqual(isSlope(series(n, (i) => ({ rssBytes: (i === n - 1 ? 900 : 200) * MIB }))), [], 'one late spike on a flat history is not a leak');
  assert.deepEqual(isSlope(series(n, ramp(2 * limitMB, { status: 'running' }))), [], 'a running session grows legitimately');
  assert.deepEqual(isSlope(series(n, ramp(2 * limitMB, { background: true }))), [], 'live background work grows legitimately');
  assert.deepEqual(isSlope(series(n, (i) => ({ ...ramp(2 * limitMB)(i), status: i === n - 8 ? 'running' : 'idle' }))), [], 'a running sample resets the settled run (only 7 settled samples left)');
  assert.equal(rssSlopeBytesPerMin([{ at: T0, rssBytes: 1 }]), null);
});

test('tree budgets are READ from the budgets object, not copied', () => {
  const h = series(F.settledSamples, () => ({ procCount: limit1.maxProcesses + 1 }));
  assert.deepEqual(treeIds(h, 1), ['session.processes.atEnd.total']);
  const looser = { ...SESSION_BUDGETS, processes: { ...P, other: 3 } };
  assert.deepEqual(treeIds(h, 1, looser), [], 'a loosened `processes` budget silences the same history');
  const quick = { ...SESSION_BUDGETS, field: { ...F, settledSamples: 2 } };
  assert.deepEqual(treeIds(series(2, () => ({ procCount: limit1.maxProcesses + 1 })), 1, quick), ['session.processes.atEnd.total']);
  const tightSlope = { ...SESSION_BUDGETS, field: { ...F, maxIdleRssSlopeBytesPerMin: 1 * MIB } };
  const mild = series(Math.ceil(F.slopeWindowMs / MIN) + 1, (i) => ({ rssBytes: 100 * MIB + i * 3 * MIB }));
  assert.deepEqual(treeIds(mild, null), []);
  assert.deepEqual(treeIds(mild, null, tightSlope), ['session.field.settledRssSlopeBytesPerMin']);
});

// ── one alarm per breach ─────────────────────────────────────────────────────

test('AlarmLedger: fires on the false→true edge only, re-arms when the breach clears, owners are independent', () => {
  const l = new AlarmLedger();
  assert.deepEqual(l.transition('s1', ['a']), ['a']);
  assert.deepEqual(l.transition('s1', ['a']), [], 'still breached: no second alarm');
  assert.deepEqual(l.transition('s1', ['a', 'b']), ['b'], 'a second budget breaking is its own alarm');
  assert.deepEqual(l.transition('s2', ['a']), ['a'], 'another session alarms independently');
  assert.deepEqual(l.transition('s1', []), [], 'cleared');
  assert.deepEqual(l.transition('s1', ['a']), ['a'], 're-armed: a NEW breach alarms again');
  l.forget('s2');
  assert.deepEqual(l.owners(), ['s1']);
});

test('alarm line: ONE stable prefix, names the session, the budget and the measured value', () => {
  const w = feed(fixture('real-count-tokens-burst.txt'));
  const [v] = startWindowBreaches(w);
  const text = formatBudgetAlarm({ session: 'ws-42', label: 'merry-koala', verdict: v, source: 'debug log x.log' });
  assert.ok(text.startsWith(`${SESSION_BUDGET_ALARM_PREFIX} session ws-42 (merry-koala) — `));
  assert.ok(text.includes('session.beforeFirstReply.countTokensRequests'));
  assert.match(text, /saw 52/);
  assert.equal(SESSION_BUDGET_ALARM_PREFIX, 'session-budget-alarm:');
  assert.ok(!formatBudgetAlarm({ session: 'ws-42', label: null, verdict: v, source: 's' }).includes('('));
});

test('parseSessionDebugLogName inverts sessionDebugLogName and refuses strangers', () => {
  const at = Date.parse('2026-09-29T22:48:33.409Z');
  assert.deepEqual(parseSessionDebugLogName(sessionDebugLogName('0209de33-38b6-4122-9dec-2f8a19125b54', at)), { wsId: '0209de33-38b6-4122-9dec-2f8a19125b54', spawnedAtMs: at });
  assert.equal(parseSessionDebugLogName('notes.txt'), null);
  assert.equal(parseSessionDebugLogName('ws__yesterday.log'), null);
  assert.equal(parseSessionDebugLogName('ws__2026-13-45T99-99-99-999Z.log'), null);
});
