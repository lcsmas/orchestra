import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_BUDGETS,
  SUBJECT_MARKERS,
  WEAK_CONTAINMENT_ENV,
  judgeSessionBudget,
  formatRequestSummary,
  summarizeWindow,
  egressUpTo,
  sessionBudgetTerminator,
  startupRetryAllowance,
  slowStartupExercised,
  STARTUP_CUT_MARGIN_MS,
  STARTUP_RETRY_MS,
  STARTUP_SPAN_MAX_MS,
  formatProcessTree,
  type ProcEntry,
  type ProcessCensus,
  type RequestCounts,
  type SessionBudgetReport,
} from './session-budget.ts';

const HAIKU = 'claude-haiku-5-5';
const HOST = 'api.anthropic.com:443';
/** A request window: `main` tool-carrying model calls, tool-less `side` calls by model, count_tokens, other routes, refused egress. */
const counts = (main: number, count_tokens: number, other = 0, side: Record<string, number> = {}, egress: Record<string, number> = {}): RequestCounts => {
  const sideN = Object.values(side).reduce((a, b) => a + b, 0);
  return { model: main + sideN, main, side, count_tokens, other, otherPaths: other ? { 'GET /x': other } : {}, egress, total: main + sideN + count_tokens + other };
};
/** What the healthy PRODUCTION-config session measures before its first reply (see SESSION_BUDGETS). */
const preOk = () => counts(1, 0, 0, { [HAIKU]: 1 }, { [HOST]: 5 });
const MB = 1024;
const row = (pid: number, kind: ProcEntry['kind'], mb: number, cmd: string, swapMB = 0): ProcEntry => ({ pid, ppid: 2, kind, rssKB: mb * MB, swapKB: swapMB * MB, cmd });
/** A census of the MEASURED healthy tree (keeper 53 MB, CLI 265, 51 per MCP server = 522 MB for 4); `extra` rows are added on top, `mbOf` overrides a kind's per-process MB. */
const census = (mcp: number, cli = 1, keeper = 1, extra: ProcEntry[] = [], mbOf: Partial<Record<ProcEntry['kind'], number>> = {}): ProcessCensus => {
  const procs: ProcEntry[] = [
    ...Array.from({ length: keeper }, (_, i) => row(10 + i, 'keeper', mbOf.keeper ?? 53, 'node keeper.js ws-sb /s.sock')),
    ...Array.from({ length: cli }, (_, i) => row(20 + i, 'cli', mbOf.cli ?? 265, 'claude --output-format stream-json')),
    ...Array.from({ length: mcp }, (_, i) => row(30 + i, 'mcp', mbOf.mcp ?? 51, `node fake-mcp-server.mjs --name fixsrv${i + 1}`)),
    ...extra,
  ];
  const byKind = { cli, keeper, mcp, hook: 0, other: 0 };
  for (const p of extra) byKind[p.kind]++;
  return { total: procs.length, zombies: 0, rssKB: procs.reduce((a, p) => a + (p.rssKB ?? 0), 0), swapKB: procs.reduce((a, p) => a + (p.swapKB ?? 0), 0), byKind, procs };
};

/** A report of a healthy, fully-mounted heavy session (the shape session-runner.mjs emits). */
function good(over: Partial<SessionBudgetReport> = {}): SessionBudgetReport {
  return {
    schema: 1, arm: 't', cli: { version: '2.1.284', path: '/x/claude' },
    fixture: { skills: 60, memoryFiles: 50, mcpServers: 4, toolsPerServer: 15, claudeMdKB: 48 },
    containment: 'netns+pidns',
    timing: { timeToFirstReplyMs: 1400, fakeModelLatencyMs: 500, setupMs: 380, firstReplyAbsMs: 1780, turnEndAbsMs: 1900, mainRequestStartAbsMs: 1200, startupEgressSpanMs: 700 },
    startupEgress: { [HOST]: 3 },
    envParity: { source: '/proc/4242/environ at the first reply', trafficKnobsSet: [] },
    requests: { beforeFirstReply: preOk(), afterFirstReply: counts(0, 57, 0, {}, { [HOST]: 3 }), total: counts(1, 57, 0, { [HAIKU]: 1 }, { [HOST]: 8 }) },
    processes: { atFirstReply: census(4), atEnd: census(4), survivorsAfterTeardown: 0 },
    egress: [],
    subject: { firstModelRequestTools: 13, firstModelRequestMcpTools: 60, firstModelRequestBytes: 400000, markersSeen: [...SUBJECT_MARKERS], mcpServersConnected: 4, toolsAtInit: 91, browserMcp: { observed: true, initTools: [], initServers: [], requestNames: [] } },
    ...over,
  };
}

test('the budget numbers are pinned as LITERALS (a silent loosening must fail here)', () => {
  assert.deepEqual(
    { ...SESSION_BUDGETS.beforeFirstReply },
    { modelRequests: 1, sideModelRequests: { [HAIKU]: 1 }, countTokensRequests: 0, otherRequests: 0, startupEgressAttempts: { [HOST]: 3 }, browserMcp: 0 },
  );
  // #210: measured 2026-11-03 (CLI 2.1.310): 6 processes, 520-544 MB for 4 servers — ceilings 1/1/1-per-server/0/0 and 400 + 65 × servers MB
  assert.deepEqual(
    { ...SESSION_BUDGETS.processes, memoryMB: { ...SESSION_BUDGETS.processes.memoryMB } },
    { keeper: 1, cli: 1, mcpPerConfiguredServer: 1, hook: 0, other: 0, memoryMB: { base: 400, perMcpServer: 65 } },
  );
  assert.ok(Object.isFrozen(SESSION_BUDGETS.processes) && Object.isFrozen(SESSION_BUDGETS.processes.memoryMB));
  assert.ok(Object.isFrozen(SESSION_BUDGETS) && Object.isFrozen(SESSION_BUDGETS.beforeFirstReply));
  assert.ok(Object.isFrozen(SESSION_BUDGETS.beforeFirstReply.sideModelRequests) && Object.isFrozen(SESSION_BUDGETS.beforeFirstReply.startupEgressAttempts));
  assert.equal(WEAK_CONTAINMENT_ENV, 'SESSION_BUDGET_ALLOW_WEAK_CONTAINMENT');
  // the startup-egress cut margin and retry allowance are measured facts (see the doc), pinned as literals
  assert.equal(STARTUP_CUT_MARGIN_MS, 150);
  assert.equal(STARTUP_RETRY_MS, 1000);
  assert.equal(STARTUP_SPAN_MAX_MS, 8000);
  assert.deepEqual([...SUBJECT_MARKERS], ['claude_md', 'rule_last', 'skill_last', 'mcp_tool_last']);
});

test('a healthy session passes every budget and every instrument check', () => {
  const j = judgeSessionBudget(good());
  assert.equal(j.ok, true);
  assert.equal(j.void, false);
  assert.ok(j.verdicts.every((v) => v.ok), j.verdicts.filter((v) => !v.ok).map((v) => v.message).join('\n'));
  // 8 budget lines (main, haiku side call, count_tokens, other, egress host, + #399's browser-MCP init tools / init servers / request names)
  // + #210's keeper / cli / mcp / hook / other / memoryMB at the first reply AND settled (12); instrument: containment, productionEnv, egress visible,
  // startup not stalled, clock, runCompleted, keeper, cli, firstReply, mcpConnected, mcpChildren, tools + 4 markers + browserMcpObserved + #210's processCensus / memoryObserved x2
  assert.equal(j.verdicts.filter((v) => v.kind === 'budget').length, 20);
  assert.equal(j.verdicts.filter((v) => v.kind === 'instrument').length, 21);
});

test('a boot-time context read (count_tokens burst before the first reply) breaks the budget NAMING it and the counts', () => {
  const j = judgeSessionBudget(good({ requests: { beforeFirstReply: counts(1, 57, 0, { [HAIKU]: 1 }, { [HOST]: 5 }), afterFirstReply: counts(0, 3), total: counts(1, 60) } }));
  assert.equal(j.ok, false);
  assert.equal(j.void, false, 'a broken budget is a FAIL, not a VOID');
  const broken = j.verdicts.filter((v) => !v.ok);
  assert.equal(broken.length, 1);
  assert.equal(broken[0].id, 'session.beforeFirstReply.countTokensRequests');
  assert.equal(broken[0].actual, 57);
  assert.match(broken[0].message, /BUDGET BROKEN session\.beforeFirstReply\.countTokensRequests: allowed at most 0, saw 57/);
  assert.match(broken[0].message, /model=2 count_tokens=57 other=0 \| main=1 side=\{claude-haiku-5-5:1\} egress=\{api\.anthropic\.com:443:5\}/);
});

test('exactly one MAIN (tool-carrying) model request: zero AND two both break it; a tool-less side call never counts as the main one', () => {
  for (const n of [0, 2]) {
    const j = judgeSessionBudget(good({ requests: { beforeFirstReply: counts(n, 0, 0, { [HAIKU]: 1 }, { [HOST]: 5 }), afterFirstReply: counts(0, 0), total: counts(n, 0) } }));
    const v = j.verdicts.find((x) => x.id === 'session.beforeFirstReply.modelRequests')!;
    assert.equal(v.ok, false, `model=${n}`);
    assert.match(v.message, new RegExp(`BUDGET BROKEN .*allowed exactly 1, saw ${n}`));
  }
});

test('any other route before the first reply breaks otherRequests (a CLI upgrade adding a startup call is seen, not absorbed)', () => {
  const j = judgeSessionBudget(good({ requests: { beforeFirstReply: counts(1, 0, 1, { [HAIKU]: 1 }, { [HOST]: 5 }), afterFirstReply: counts(0, 0), total: counts(1, 0, 1) } }));
  const v = j.verdicts.find((x) => x.id === 'session.beforeFirstReply.otherRequests')!;
  assert.equal(v.ok, false);
  assert.match(v.message, /saw 1 — .*other=1 \|/);
});

test('#399: a session that still loads the browser MCP server breaks its own budget at each of the three places it shows', () => {
  const tools = ['mcp__browser__navigate', 'mcp__browser__click'];
  for (const [k, bm] of [
    ['initTools', { observed: true, initTools: tools, initServers: [], requestNames: [] }],
    ['initServers', { observed: true, initTools: [], initServers: ['browser'], requestNames: [] }],
    ['requestNames', { observed: true, initTools: [], initServers: [], requestNames: tools }],
  ] as const) {
    const j = judgeSessionBudget(good({ subject: { ...good().subject, browserMcp: { ...bm, initTools: [...bm.initTools], initServers: [...bm.initServers], requestNames: [...bm.requestNames] } } }));
    const v = j.verdicts.find((x) => x.id === `session.beforeFirstReply.browserMcp.${k}`)!;
    assert.equal(v.ok, false, k);
    assert.equal(j.ok, false, k);
    assert.equal(j.void, false, `${k}: a broken budget is a FAIL, not a VOID`);
    assert.match(v.message, /BUDGET BROKEN .* allowed at most 0, saw \d+ — .*removed in-process browser MCP server/, k);
  }
  assert.equal(judgeSessionBudget(good()).ok, true, 'the clean report passes (control)');
});

test('a run whose subject never mounted is VOID, never a pass (a vacuous 0 must not go green)', () => {
  const cases: Array<[string, Partial<SessionBudgetReport>, RegExp]> = [
    ['no first reply', { timing: { timeToFirstReplyMs: null, fakeModelLatencyMs: 500 } }, /instrument\.firstReplyObserved/],
    ['mcp not connected', { subject: { ...good().subject, mcpServersConnected: 1 } }, /instrument\.mcpServersConnected/],
    ['browser MCP never observed', { subject: { ...good().subject, browserMcp: undefined } }, /instrument\.browserMcpObserved/],
    ['browser MCP observation without the init event', { subject: { ...good().subject, browserMcp: { observed: false, initTools: [], initServers: [], requestNames: [] } } }, /instrument\.browserMcpObserved/],
    ['mcp children absent', { processes: { atFirstReply: census(0), atEnd: census(0), survivorsAfterTeardown: 0 } }, /instrument\.mcpChildProcesses/],
    ['tools missing', { subject: { ...good().subject, firstModelRequestMcpTools: 59 } }, /instrument\.modelRequestCarriesTools/],
    ...SUBJECT_MARKERS.map((m): [string, Partial<SessionBudgetReport>, RegExp] => [
      `marker ${m} missing`,
      { subject: { ...good().subject, markersSeen: SUBJECT_MARKERS.filter((x) => x !== m) } },
      new RegExp(`instrument\\.modelRequestCarries\\.${m}`),
    ]),
  ];
  for (const [name, over, id] of cases) {
    const j = judgeSessionBudget(good(over));
    assert.equal(j.void, true, name);
    assert.equal(j.ok, false, name);
    assert.ok(j.verdicts.some((v) => !v.ok && id.test(v.id) && /INSTRUMENT VOID/.test(v.message)), `${name}: ${JSON.stringify(j.verdicts.filter((v) => !v.ok).map((v) => v.id))}`);
  }
});

test('a malformed report never throws and never passes', () => {
  const j = judgeSessionBudget({} as unknown as SessionBudgetReport);
  assert.equal(j.ok, false);
  assert.equal(j.void, true);
});

test('the printed request summary carries all three windows by type, plus the startup-egress window', () => {
  const lines = formatRequestSummary(good());
  assert.equal(lines.length, 4);
  assert.match(lines[3], /startup egress \(before the main request started\): \{api\.anthropic\.com:443:3\}/);
  assert.match(lines[0], /before first reply: model=2 count_tokens=0 other=0 \| main=1 side=\{claude-haiku-5-5:1\} egress=\{api\.anthropic\.com:443:5\}/);
  assert.match(lines[1], /after first reply: +model=0 count_tokens=57 other=0 \| main=0 side=\{\} egress=\{api\.anthropic\.com:443:3\}/);
});

test('a NEW startup call breaks a number: an unbudgeted side model, one more haiku call, an unbudgeted egress host, one more attempt', () => {
  const broken = (pre: RequestCounts, startupEgress: Record<string, number> = { [HOST]: 3 }) =>
    judgeSessionBudget(good({ requests: { beforeFirstReply: pre, afterFirstReply: counts(0, 0), total: pre }, startupEgress })).verdicts.filter((v) => !v.ok && v.kind === 'budget');
  // a different side model appears
  let b = broken(counts(1, 0, 0, { [HAIKU]: 1, 'claude-sonnet-x': 1 }));
  assert.deepEqual(b.map((v) => v.id), ['session.beforeFirstReply.sideModelRequests.claude-sonnet-x']);
  assert.match(b[0].message, /BUDGET BROKEN .*allowed at most 0, saw 1/);
  // the haiku call doubles
  b = broken(counts(1, 0, 0, { [HAIKU]: 2 }));
  assert.deepEqual(b.map((v) => v.id), [`session.beforeFirstReply.sideModelRequests.${HAIKU}`]);
  // a new host — from the CLI OR the app process (the proxy sees both)
  b = broken(counts(1, 0, 0, { [HAIKU]: 1 }), { [HOST]: 3, 'telemetry.example.invalid:443': 1 });
  assert.deepEqual(b.map((v) => v.id), ['session.beforeFirstReply.startupEgressAttempts.telemetry.example.invalid:443']);
  assert.match(b[0].message, /allowed at most 0, saw 1 — .*egress attempts \{api\.anthropic\.com:443:3, telemetry\.example\.invalid:443:1\}/);
  // one more attempt at the known host
  b = broken(counts(1, 0, 0, { [HAIKU]: 1 }), { [HOST]: 4 });
  assert.deepEqual(b.map((v) => v.id), [`session.beforeFirstReply.startupEgressAttempts.${HOST}`]);
  assert.match(b[0].message, /allowed at most 3, saw 4/);
  // egress AFTER the main request (printed in the window counts, not budgeted) never breaks the startup budget
  assert.deepEqual(broken(counts(1, 0, 0, { [HAIKU]: 1 }, { [HOST]: 9, 'late.example:443': 2 })), []);
  // FEWER calls than budgeted is not a BUDGET break (ceilings) — the instrument checks are what notice a suppressed run
  assert.deepEqual(broken(counts(1, 0, 0, {}, {}), {}), []);
});

test('the main request is the one carrying tools: a run with only a tool-less call has main=0 and breaks the model budget', () => {
  const j = judgeSessionBudget(good({ requests: { beforeFirstReply: counts(0, 0, 0, { [HAIKU]: 1 }, { [HOST]: 5 }), afterFirstReply: counts(0, 0), total: counts(0, 0) } }));
  const v = j.verdicts.find((x) => x.id === 'session.beforeFirstReply.modelRequests')!;
  assert.equal(v.ok, false);
  assert.equal(v.actual, 0);
});

test('summarizeWindow: main vs side by tools, count_tokens, other routes by name, refused egress by host — windowed by time', () => {
  const reqs = [
    { tMs: 10, type: 'model', model: HAIKU, tools: 0 },
    { tMs: 20, type: 'model', model: 'claude-opus-4-8', tools: 92 },
    { tMs: 30, type: 'other', method: 'GET', path: '/v1/models' },
    { tMs: 40, type: 'count_tokens' },
    { tMs: 90, type: 'count_tokens' },
  ];
  const eg = [{ tMs: 15, target: HOST }, { tMs: 25, target: HOST }, { tMs: 95, target: 'x.example:443' }];
  const pre = summarizeWindow(reqs, eg, -Infinity, 50);
  assert.deepEqual(pre, { model: 2, main: 1, side: { [HAIKU]: 1 }, count_tokens: 1, other: 1, otherPaths: { 'GET /v1/models': 1 }, egress: { [HOST]: 2 }, total: 4 });
  const post = summarizeWindow(reqs, eg, 50, Infinity);
  assert.deepEqual(post, { model: 0, main: 0, side: {}, count_tokens: 1, other: 0, otherPaths: {}, egress: { 'x.example:443': 1 }, total: 1 });
  assert.equal(summarizeWindow(reqs, eg, -Infinity, Infinity).total, 5, 'the two windows partition the run');
});

test('F1: containment weaker than net+pid namespaces is VOID unless explicitly opted out — and the opt-out is printed in the verdict', () => {
  for (const c of ['netns', 'proxy-only'] as const) {
    const j = judgeSessionBudget(good({ containment: c }));
    assert.equal(j.void, true, c);
    assert.equal(j.ok, false, c);
    const v = j.verdicts.find((x) => x.id === 'instrument.containment')!;
    assert.match(v.message, new RegExp(`INSTRUMENT VOID .*containment=${c}.*need netns\\+pidns`));
  }
  const opt = judgeSessionBudget(good({ containment: 'proxy-only', containmentOptOut: true }));
  assert.equal(opt.ok, true, 'explicit opt-out proceeds');
  assert.match(opt.verdicts.find((x) => x.id === 'instrument.containment')!.message, /containment=proxy-only — WEAK, allowed only by the explicit opt-out SESSION_BUDGET_ALLOW_WEAK_CONTAINMENT=1/);
});

test('F4: a run that raised is never a pass, whatever the counts say', () => {
  const j = judgeSessionBudget(good({ error: 'teardown: boom' }));
  assert.equal(j.ok, false);
  assert.equal(j.void, true);
  assert.match(j.verdicts.find((x) => x.id === 'instrument.runCompleted')!.message, /INSTRUMENT VOID .*the run raised: teardown: boom/);
});

test('F6: the real path is asserted — at least one keeper and one cli process at the first reply', () => {
  for (const [name, c] of [['no keeper', census(4, 1, 0)], ['no cli', census(4, 0, 1)]] as const) {
    const j = judgeSessionBudget(good({ processes: { atFirstReply: c, atEnd: c, survivorsAfterTeardown: 0 } }));
    assert.equal(j.void, true, name);
    assert.ok(j.verdicts.some((v) => !v.ok && /instrument\.(keeper|cli)Process/.test(v.id)), name);
  }
});

test('F2: budgets describe PRODUCTION config — a suppressed run (knob set, or no outbound traffic seen, or the clock not started at send) is VOID', () => {
  const j = judgeSessionBudget(good({ envParity: { trafficKnobsSet: ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] } }));
  assert.equal(j.void, true);
  assert.match(j.verdicts.find((v) => v.id === 'instrument.productionEnv')!.message, /INSTRUMENT VOID .*CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC.*lighter session than production/);
  // the same session with NO outbound attempt before the reply (what a suppressing knob produces) — ceilings alone would pass it
  const quiet = judgeSessionBudget(good({ requests: { beforeFirstReply: counts(1, 0), afterFirstReply: counts(0, 0), total: counts(1, 0) }, startupEgress: {} }));
  assert.equal(quiet.void, true);
  assert.ok(quiet.verdicts.some((v) => !v.ok && v.id === 'instrument.nonessentialTrafficVisible'));
  assert.equal(quiet.verdicts.filter((v) => v.kind === 'budget' && !v.ok).length, 0, 'every ceiling still holds — only the instrument sees the suppression');
  // env parity not reported at all is not parity
  assert.equal(judgeSessionBudget(good({ envParity: undefined })).void, true);
  // the clock must start at sdkSend, after runner setup
  const t = judgeSessionBudget(good({ timing: { timeToFirstReplyMs: 1400, fakeModelLatencyMs: 500, setupMs: 0, firstReplyAbsMs: 1400, turnEndAbsMs: 1900, mainRequestStartAbsMs: 1200 } }));
  assert.ok(t.verdicts.some((v) => !v.ok && v.id === 'instrument.clockStartedAtSend'));
});

test('F4 (round 2): time-to-first-reply + setup must equal the first-reply stamp (±2 ms) — an API-start clock that still reports a setup figure is VOID', () => {
  const at = (ttfr: number, setup: number, abs: number) => judgeSessionBudget(good({ timing: { timeToFirstReplyMs: ttfr, fakeModelLatencyMs: 500, setupMs: setup, firstReplyAbsMs: abs, turnEndAbsMs: 2000, mainRequestStartAbsMs: 1200 } }));
  assert.equal(at(1400, 380, 1780).ok, true);
  assert.equal(at(1400, 380, 1782).ok, true, '2 ms of rounding is tolerated');
  // the reviewer's mutant: ttfr measured from API start (= the absolute stamp) while setup is still reported
  const bad = at(1780, 380, 1780);
  assert.equal(bad.void, true);
  assert.match(bad.verdicts.find((v) => v.id === 'instrument.clockStartedAtSend')!.message, /off by 380 ms\) — the clock did not start at sdkSend/);
  assert.equal(at(1400, 380, undefined as unknown as number).void, true, 'a missing stamp is not a pass');
});

test('F1 (round 2): productionEnv judges the env the CLI was HANDED — a knob in its /proc environ is VOID naming it; an unreadable environ is not parity', () => {
  const j = judgeSessionBudget(good({ envParity: { source: '/proc/4242/environ at the first reply', trafficKnobsSet: ['DISABLE_TELEMETRY'] } }));
  assert.equal(j.void, true);
  assert.match(j.verdicts.find((v) => v.id === 'instrument.productionEnv')!.message, /INSTRUMENT VOID .*traffic-suppressing env set: DISABLE_TELEMETRY/);
  const unreadable = judgeSessionBudget(good({ envParity: { source: '/proc/4242/environ at the first reply', trafficKnobsSet: null, error: 'EACCES' } }));
  assert.equal(unreadable.void, true);
});

test('egressUpTo: attempts up to a cut, by host:port', () => {
  const eg = [{ tMs: 10, target: HOST }, { tMs: 20, target: HOST }, { tMs: 30, target: 'x:443' }, { tMs: 40, target: HOST }];
  assert.deepEqual(egressUpTo(eg, 25), { [HOST]: 2 });
  assert.deepEqual(egressUpTo(eg, 40), { [HOST]: 3, 'x:443': 1 });
  assert.deepEqual(egressUpTo(eg, 5), {});
});

test('F6 (round 2): the terminator — PASS only for a FULL run under FULL containment; PARTIAL / PASS-WEAK / FAIL / VOID otherwise', () => {
  const t = sessionBudgetTerminator;
  assert.equal(t({ voided: false, bad: false, partial: false, strongContainment: true }), 'PASS');
  assert.equal(t({ voided: false, bad: false, partial: true, strongContainment: true }), 'PARTIAL', 'a --arm run never prints PASS');
  assert.equal(t({ voided: false, bad: false, partial: false, strongContainment: false }), 'PASS-WEAK');
  assert.equal(t({ voided: false, bad: false, partial: true, strongContainment: false }), 'PARTIAL');
  assert.equal(t({ voided: false, bad: true, partial: true, strongContainment: true }), 'FAIL');
  assert.equal(t({ voided: true, bad: true, partial: true, strongContainment: false }), 'VOID', 'VOID outranks everything');
});

test('a SLOW-but-healthy startup PASSES: the known host gets a retry allowance scaled by startup time; a NEW host never does', () => {
  const at = (span: number | undefined, egress: Record<string, number>) => judgeSessionBudget(good({ startupEgress: egress, timing: { timeToFirstReplyMs: 1400, fakeModelLatencyMs: 500, setupMs: 380, firstReplyAbsMs: 1780, turnEndAbsMs: 1900, mainRequestStartAbsMs: 1200, startupEgressSpanMs: span } }));
  const egressBroken = (j: ReturnType<typeof judgeSessionBudget>) => j.verdicts.filter((v) => !v.ok && v.kind === 'budget' && v.id.includes('startupEgressAttempts')).map((v) => v.id);
  assert.equal(startupRetryAllowance(322), 0);
  assert.equal(startupRetryAllowance(999), 0);
  assert.equal(startupRetryAllowance(2241), 2);
  assert.equal(startupRetryAllowance(undefined), 0);
  // the measured slow-MCP startups (2.2–2.7 s, ONE extra attempt) pass
  assert.equal(at(2241, { [HOST]: 4 }).ok, true);
  assert.equal(at(2705, { [HOST]: 4 }).ok, true);
  // a FAST startup still holds the exact ceiling: 4 attempts in 322 ms is one call too many
  assert.deepEqual(egressBroken(at(322, { [HOST]: 4 })), [`session.beforeFirstReply.startupEgressAttempts.${HOST}`]);
  // the allowance is bounded: 1.5 s allows 1 extra (4), not 2 (5)
  assert.equal(at(1500, { [HOST]: 4 }).ok, true);
  assert.deepEqual(egressBroken(at(1500, { [HOST]: 5 })), [`session.beforeFirstReply.startupEgressAttempts.${HOST}`]);
  // a NEW host is never explained by a retry, however slow startup was
  assert.deepEqual(egressBroken(at(2500, { [HOST]: 3, 'telemetry.example.invalid:443': 1 })), ['session.beforeFirstReply.startupEgressAttempts.telemetry.example.invalid:443']);
  // an absurd startup (> 8 s) is VOID, not a pass and not a budget verdict
  const absurd = at(9000, { [HOST]: 3 });
  assert.equal(absurd.void, true);
  assert.match(absurd.verdicts.find((v) => v.id === 'instrument.startupNotStalled')!.message, /INSTRUMENT VOID .*9000 ms \(> 8000\).*re-run/);
});

test('slow-startup positive control keys on the startup SPAN: must-PASS on the measured slow arms, must-FAIL on a fast startup', () => {
  // measured slow-startup spans: 1444–1503 ms on CLI 2.1.310 (4 attempts) AND 2.1.322 (3 attempts) — both exercise the slow path
  for (const span of [1434, 1444, 1503, 2705]) assert.equal(slowStartupExercised(span).ok, true, `span ${span}`);
  // a fast startup (the 322 ms of a normal arm), no span at all, or just under the allowance threshold: the arm proves nothing
  for (const span of [322, 999, 0, undefined]) { const r = slowStartupExercised(span); assert.equal(r.ok, false, `span ${span}`); assert.match(r.why, /did not delay the main request/); }
});

// ── #210: process count + tree memory of one session ─────────────────────────

const WINDOWS = ['atFirstReply', 'atEnd'] as const;
type Win = (typeof WINDOWS)[number];
/** A healthy report whose census in window `when` is `c` (the other window stays healthy). */
const withCensus = (when: Win, c: ProcessCensus, rest: Partial<SessionBudgetReport> = {}) =>
  good({ processes: { atFirstReply: when === 'atFirstReply' ? c : census(4), atEnd: when === 'atEnd' ? c : census(4), survivorsAfterTeardown: 0 }, ...rest });
const brokenBudgets = (j: ReturnType<typeof judgeSessionBudget>) => j.verdicts.filter((v) => !v.ok && v.kind === 'budget');
/** A 4-server census whose tree weighs exactly `mb` (the healthy one is 522). */
const weighing = (mb: number) => census(4, 1, 1, [], { cli: 265 + (mb - 522) });

test('#210: one process too many of ANY kind breaks exactly that kind\'s budget, in each window, and names the tree', () => {
  const cases: Array<[string, ProcessCensus]> = [
    ['keeper', census(4, 1, 2)],
    ['cli', census(4, 2, 1, [], { cli: 100 })],
    ['mcp', census(5)],
    ['hook', census(4, 1, 1, [row(90, 'hook', 3, 'bash /w/.orchestra/hook.sh')])],
    ['other', census(4, 1, 1, [row(91, 'other', 1, 'sleep 600')])],
  ];
  for (const when of WINDOWS) {
    for (const [kind, c] of cases) {
      const j = judgeSessionBudget(withCensus(when, c));
      const broken = brokenBudgets(j);
      assert.deepEqual(broken.map((v) => v.id), [`session.processes.${when}.${kind}`], `${when} ${kind}`);
      assert.equal(j.ok, false);
      assert.equal(j.void, false, `${kind}: a stray process is a FAIL, not a VOID`);
      assert.equal(broken[0].actual, kind === 'mcp' ? 5 : kind === 'keeper' || kind === 'cli' ? 2 : 1);
      assert.match(broken[0].message, new RegExp(`BUDGET BROKEN session\\.processes\\.${when}\\.${kind}: allowed at most ${kind === 'mcp' ? 4 : kind === 'keeper' || kind === 'cli' ? 1 : 0}, saw \\d+ — ${kind} processes — \\d+ processes, \\d+ MB \\(RSS\\+swap\\) at the ${when === 'atEnd' ? 'settled end' : 'first reply'}`));
      assert.ok((broken[0].tree ?? []).length === c.total, `${kind}: the broken verdict names the WHOLE tree (${c.total} rows), got ${broken[0].tree?.length}`);
    }
  }
  assert.deepEqual(brokenBudgets(judgeSessionBudget(good())), [], 'the healthy tree passes (control)');
});

test('#210: the mcp ceiling is one process per CONFIGURED server (fixture.mcpServers), not a hardcoded 4', () => {
  const two = (c: ProcessCensus) => judgeSessionBudget(good({ fixture: { skills: 60, memoryFiles: 50, mcpServers: 2, toolsPerServer: 15, claudeMdKB: 48 }, subject: { ...good().subject, mcpServersConnected: 2, firstModelRequestMcpTools: 30 }, processes: { atFirstReply: c, atEnd: c, survivorsAfterTeardown: 0 } }));
  assert.deepEqual(brokenBudgets(two(census(2))), []);
  assert.deepEqual(brokenBudgets(two(census(3))).map((v) => v.id), ['session.processes.atFirstReply.mcp', 'session.processes.atEnd.mcp']);
});

test('#210: tree memory (RSS + swap, MB) — AT the ceiling 400 + 65 × configured servers passes, one MB over breaks, in each window', () => {
  assert.equal(SESSION_BUDGETS.processes.memoryMB.base + SESSION_BUDGETS.processes.memoryMB.perMcpServer * 4, 660);
  for (const when of WINDOWS) {
    assert.deepEqual(brokenBudgets(judgeSessionBudget(withCensus(when, weighing(660)))), [], `${when}: 660 MB is within the budget`);
    const j = judgeSessionBudget(withCensus(when, weighing(661)));
    const [v] = brokenBudgets(j);
    assert.deepEqual(brokenBudgets(j).map((x) => x.id), [`session.processes.${when}.memoryMB`]);
    assert.equal(v.actual, 661);
    assert.match(v.message, new RegExp(`BUDGET BROKEN session\\.processes\\.${when}\\.memoryMB: allowed at most 660, saw 661 — MB \\(RSS\\+swap\\) summed over the tree`));
    assert.equal(j.void, false, 'an inflated tree is a FAIL, not a VOID');
    assert.ok((v.tree ?? []).some((l) => /\[20\] cli +404 MB/.test(l)), `the tree names the heavy process: ${JSON.stringify(v.tree)}`);
  }
});

test('#210: MB is rounded to the nearest (660.4 passes, 660.6 breaks) — the verdict and its message use the same figure', () => {
  const frac = (mb: number) => { const c = weighing(660); c.procs![1] = { ...c.procs![1], rssKB: c.procs![1].rssKB! + Math.round((mb - 660) * MB) }; c.rssKB += Math.round((mb - 660) * MB); return c; };
  assert.deepEqual(brokenBudgets(judgeSessionBudget(withCensus('atEnd', frac(660.4)))), []);
  const j = judgeSessionBudget(withCensus('atEnd', frac(660.6)));
  assert.deepEqual(brokenBudgets(j).map((v) => v.id), ['session.processes.atEnd.memoryMB']);
  assert.equal(brokenBudgets(j)[0].actual, 661);
});

test('#210: swapped-out memory counts (a paged-out leak is still a leak), and the ceiling scales with the configured servers', () => {
  const c = census(4);
  c.procs![1] = { ...c.procs![1], swapKB: 140 * MB }; // cli: 265 resident + 140 swapped → 662 MB
  c.swapKB = 140 * MB;
  const j = judgeSessionBudget(withCensus('atEnd', c));
  assert.deepEqual(brokenBudgets(j).map((v) => v.id), ['session.processes.atEnd.memoryMB']);
  assert.equal(brokenBudgets(j)[0].actual, 662);
  // 2 configured servers → ceiling 400 + 130 = 530
  const two = (mb: number) => { const t = census(2, 1, 1, [], { cli: 265 + (mb - 420) }); return judgeSessionBudget(good({ fixture: { skills: 60, memoryFiles: 50, mcpServers: 2, toolsPerServer: 15, claudeMdKB: 48 }, subject: { ...good().subject, mcpServersConnected: 2, firstModelRequestMcpTools: 30 }, processes: { atFirstReply: t, atEnd: t, survivorsAfterTeardown: 0 } })); };
  assert.deepEqual(brokenBudgets(two(530)), []);
  assert.deepEqual(brokenBudgets(two(531)).map((v) => v.id), ['session.processes.atFirstReply.memoryMB', 'session.processes.atEnd.memoryMB']);
});

test('#210: a census that saw nothing, or read no memory, is VOID — a max-budget on a vacuous 0 must not go green', () => {
  const empty: ProcessCensus = { total: 0, zombies: 0, rssKB: 0, swapKB: 0, byKind: { cli: 0, keeper: 0, mcp: 0, hook: 0, other: 0 }, procs: [] };
  const noMem = census(4);
  noMem.procs = noMem.procs!.map((p) => ({ ...p, rssKB: 0 }));
  noMem.rssKB = 0;
  const cases: Array<[string, Win, ProcessCensus | undefined, string]> = [
    ['empty census at the settled end', 'atEnd', empty, 'instrument.processCensus.atEnd'],
    ['no census at the settled end', 'atEnd', undefined, 'instrument.processCensus.atEnd'],
    ['no RSS read at the first reply', 'atFirstReply', noMem, 'instrument.memoryObserved.atFirstReply'],
    ['no RSS read at the settled end', 'atEnd', noMem, 'instrument.memoryObserved.atEnd'],
  ];
  for (const [name, when, c, id] of cases) {
    const j = judgeSessionBudget(withCensus(when, c as ProcessCensus));
    assert.equal(j.void, true, name);
    assert.equal(j.ok, false, name);
    assert.ok(j.verdicts.some((v) => !v.ok && v.id === id && /INSTRUMENT VOID/.test(v.message)), `${name}: ${JSON.stringify(j.verdicts.filter((v) => !v.ok).map((v) => v.id))}`);
  }
});

test('#210: a break in ONE window leaves the other window\'s verdicts green (the two windows are judged separately)', () => {
  const j = judgeSessionBudget(withCensus('atEnd', census(4, 1, 1, [row(91, 'other', 1, 'sleep 600')])));
  assert.deepEqual(brokenBudgets(j).map((v) => v.id), ['session.processes.atEnd.other']);
  assert.ok(j.verdicts.filter((v) => v.id.startsWith('session.processes.atFirstReply.')).every((v) => v.ok));
});

test('#210: formatProcessTree names every process — pid, kind, MB (RSS+swap), short command — children indented under their parent', () => {
  const lines = formatProcessTree([
    { pid: 10, ppid: 2, kind: 'keeper', rssKB: 53 * MB, swapKB: 0, cmd: '/home/u/.orchestra/bin/node-22/bin/node /home/u/.orchestra/bin/keeper.js ws-sb /s.sock' },
    { pid: 20, ppid: 10, kind: 'cli', rssKB: 200 * MB, swapKB: 65 * MB, cmd: '/home/u/.local/share/claude/versions/2.1.310 --output-format stream-json' },
    { pid: 30, ppid: 20, kind: 'mcp', rssKB: 51 * MB, swapKB: 0, cmd: 'node /r/scripts/session-budget/fake-mcp-server.mjs --name fixsrv1' },
  ]);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\[10\] keeper +53 MB +node keeper\.js ws-sb \/s\.sock$/);
  assert.match(lines[1], /^ {2}\[20\] cli +265 MB +2\.1\.310 --output-format stream-json$/);
  assert.match(lines[2], /^ {4}\[30\] mcp +51 MB +node fake-mcp-server\.mjs --name fixsrv1$/);
  assert.deepEqual(formatProcessTree(undefined), []);
});
