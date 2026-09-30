import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_BUDGETS,
  SUBJECT_MARKERS,
  WEAK_CONTAINMENT_ENV,
  judgeSessionBudget,
  formatRequestSummary,
  summarizeWindow,
  judgeContainmentProof,
  type ContainmentProof,
  egressUpTo,
  sessionBudgetTerminator,
  startupRetryAllowance,
  STARTUP_CUT_MARGIN_MS,
  STARTUP_RETRY_MS,
  STARTUP_SPAN_MAX_MS,
  type RequestCounts,
  type SessionBudgetReport,
} from './session-budget.ts';

const HAIKU = 'claude-haiku-4-5-20251001';
const HOST = 'api.anthropic.com:443';
/** A request window: `main` tool-carrying model calls, tool-less `side` calls by model, count_tokens, other routes, refused egress. */
const counts = (main: number, count_tokens: number, other = 0, side: Record<string, number> = {}, egress: Record<string, number> = {}): RequestCounts => {
  const sideN = Object.values(side).reduce((a, b) => a + b, 0);
  return { model: main + sideN, main, side, count_tokens, other, otherPaths: other ? { 'GET /x': other } : {}, egress, total: main + sideN + count_tokens + other };
};
/** What the healthy PRODUCTION-config session measures before its first reply (see SESSION_BUDGETS). */
const preOk = () => counts(1, 0, 0, { [HAIKU]: 1 }, { [HOST]: 5 });
const census = (mcp: number, cli = 1, keeper = 1) => ({ total: mcp + cli + keeper, zombies: 0, rssKB: 1, byKind: { cli, keeper, mcp, hook: 0, other: 0 } });

/** A report of a healthy, fully-mounted heavy session (the shape session-runner.mjs emits). */
function good(over: Partial<SessionBudgetReport> = {}): SessionBudgetReport {
  return {
    schema: 1, arm: 't', cli: { version: '2.1.284', path: '/x/claude' },
    fixture: { skills: 60, memoryFiles: 50, mcpServers: 4, toolsPerServer: 15, claudeMdKB: 48 },
    containment: 'netns+pidns',
    timing: { timeToFirstReplyMs: 1400, fakeModelLatencyMs: 500, setupMs: 380, firstReplyAbsMs: 1780, turnEndAbsMs: 1900, mainRequestStartAbsMs: 1200, startupEgressSpanMs: 700 },
    containmentProof: { connect4: 'ENETUNREACH', connect6: 'ENETUNREACH', interfaces: ['lo'], nonLoopbackRoutes: 0 },
    startupEgress: { [HOST]: 3 },
    envParity: { source: '/proc/4242/environ at the first reply', trafficKnobsSet: [] },
    requests: { beforeFirstReply: preOk(), afterFirstReply: counts(0, 57, 0, {}, { [HOST]: 3 }), total: counts(1, 57, 0, { [HAIKU]: 1 }, { [HOST]: 8 }) },
    processes: { atFirstReply: census(4), atEnd: census(4), survivorsAfterTeardown: 0 },
    egress: [],
    subject: { firstModelRequestTools: 91, firstModelRequestBytes: 400000, markersSeen: [...SUBJECT_MARKERS], mcpServersConnected: 4, toolsAtInit: 91 },
    ...over,
  };
}

test('the budget numbers are pinned as LITERALS (a silent loosening must fail here)', () => {
  assert.deepEqual(
    { ...SESSION_BUDGETS.beforeFirstReply },
    { modelRequests: 1, sideModelRequests: { [HAIKU]: 1 }, countTokensRequests: 0, otherRequests: 0, startupEgressAttempts: { [HOST]: 3 } },
  );
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
  // 5 budget lines (main, haiku side call, count_tokens, other, egress host) + containment, containmentProven, productionEnv, egress visible, startup not stalled, clock, runCompleted, keeper, cli,
  // firstReply, mcpConnected, mcpChildren, tools + 4 markers
  assert.equal(j.verdicts.filter((v) => v.kind === 'budget').length, 5);
  assert.equal(j.verdicts.filter((v) => v.kind === 'instrument').length, 17);
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
  assert.match(broken[0].message, /model=2 count_tokens=57 other=0 \| main=1 side=\{claude-haiku-4-5-20251001:1\} egress=\{api\.anthropic\.com:443:5\}/);
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

test('a run whose subject never mounted is VOID, never a pass (a vacuous 0 must not go green)', () => {
  const cases: Array<[string, Partial<SessionBudgetReport>, RegExp]> = [
    ['no first reply', { timing: { timeToFirstReplyMs: null, fakeModelLatencyMs: 500 } }, /instrument\.firstReplyObserved/],
    ['mcp not connected', { subject: { ...good().subject, mcpServersConnected: 1 } }, /instrument\.mcpServersConnected/],
    ['mcp children absent', { processes: { atFirstReply: census(0), atEnd: census(0), survivorsAfterTeardown: 0 } }, /instrument\.mcpChildProcesses/],
    ['tools missing', { subject: { ...good().subject, firstModelRequestTools: 10 } }, /instrument\.modelRequestCarriesTools/],
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
  assert.match(lines[0], /before first reply: model=2 count_tokens=0 other=0 \| main=1 side=\{claude-haiku-4-5-20251001:1\} egress=\{api\.anthropic\.com:443:5\}/);
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


test('containment is PROVEN by the in-run canary, not trusted by name: ENETUNREACH v4+v6, interfaces=[lo], no non-lo route — anything else is VOID', () => {
  const good: ContainmentProof = { connect4: 'ENETUNREACH', connect6: 'ENETUNREACH', interfaces: ['lo'], nonLoopbackRoutes: 0 };
  assert.equal(judgeContainmentProof(good, false).ok, true);
  const bad: Array<[string, ContainmentProof | undefined]> = [
    ['v4 connect times out (a routed namespace swallows the SYN)', { ...good, connect4: 'TIMEOUT' }],
    ['v6 connect times out', { ...good, connect6: 'TIMEOUT' }],
    ['a connect that succeeds', { ...good, connect4: 'CONNECTED' }],
    ['a host interface is visible', { ...good, interfaces: ['lo', 'wlp1s0f0'] }],
    ['no loopback at all', { ...good, interfaces: [] }],
    ['a route leaves lo', { ...good, nonLoopbackRoutes: 46 }],
    ['no canary result', undefined],
  ];
  for (const [name, proof] of bad) {
    const v = judgeContainmentProof(proof, false);
    assert.equal(v.ok, false, name);
    assert.equal(v.kind, 'instrument', name);
    assert.match(v.message, /INSTRUMENT VOID instrument\.containmentProven: the namespace is not proven routeless — want connect=ENETUNREACH/, name);
  }
  // the message names what was SEEN (and abbreviates a long interface list)
  const host = judgeContainmentProof({ connect4: 'TIMEOUT', connect6: 'TIMEOUT', interfaces: ['a', 'b', 'c', 'd', 'e', 'f'], nonLoopbackRoutes: 46 }, false);
  assert.match(host.message, /connect\(192\.0\.2\.1:443\)=TIMEOUT connect\(\[2001:db8::1\]:443\)=TIMEOUT interfaces=\[a,b,c,d,…\+2\] non-lo routes=46/);
  // the explicit opt-out proves nothing and says so
  const opt = judgeContainmentProof({ ...good, connect4: 'TIMEOUT' }, true);
  assert.equal(opt.ok, true);
  assert.match(opt.message, /NOT proven — weak containment explicitly allowed/);
});

test('a whole report whose namespace is unproven (or whose canary result is missing) is VOID even when every budget holds', () => {
  const lie = judgeSessionBudget(good({ containment: 'netns+pidns', containmentProof: { connect4: 'TIMEOUT', connect6: 'TIMEOUT', interfaces: ['lo', 'eth0'], nonLoopbackRoutes: 3 } }));
  assert.equal(lie.void, true);
  assert.equal(lie.ok, false);
  assert.equal(lie.verdicts.filter((v) => v.kind === 'budget' && !v.ok).length, 0, 'the counts are fine — only the instrument sees the lie');
  assert.equal(judgeSessionBudget(good({ containmentProof: undefined })).void, true);
});
