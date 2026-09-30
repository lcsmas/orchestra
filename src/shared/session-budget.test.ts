import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_BUDGETS,
  SUBJECT_MARKERS,
  judgeSessionBudget,
  formatRequestSummary,
  type SessionBudgetReport,
} from './session-budget.ts';

const counts = (model: number, count_tokens: number, other = 0) => ({ model, count_tokens, other, total: model + count_tokens + other });
const census = (mcp: number) => ({ total: mcp + 2, zombies: 0, rssKB: 1, byKind: { cli: 1, keeper: 1, mcp, hook: 0, other: 0 } });

/** A report of a healthy, fully-mounted heavy session (the shape session-runner.mjs emits). */
function good(over: Partial<SessionBudgetReport> = {}): SessionBudgetReport {
  return {
    schema: 1, arm: 't', cli: { version: '2.1.284', path: '/x/claude' },
    fixture: { skills: 60, memoryFiles: 50, mcpServers: 4, toolsPerServer: 15, claudeMdKB: 48 },
    containment: 'netns+pidns',
    timing: { timeToFirstReplyMs: 1400, fakeModelLatencyMs: 500 },
    requests: { beforeFirstReply: counts(1, 0), afterFirstReply: counts(0, 57), total: counts(1, 57) },
    processes: { atFirstReply: census(4), atEnd: census(4), survivorsAfterTeardown: 0 },
    egress: [],
    subject: { firstModelRequestTools: 91, firstModelRequestBytes: 400000, markersSeen: [...SUBJECT_MARKERS], mcpServersConnected: 4, toolsAtInit: 91 },
    ...over,
  };
}

test('the budget numbers are pinned as LITERALS (a silent loosening must fail here)', () => {
  assert.deepEqual({ ...SESSION_BUDGETS.beforeFirstReply }, { modelRequests: 1, countTokensRequests: 0, otherRequests: 0 });
  assert.ok(Object.isFrozen(SESSION_BUDGETS) && Object.isFrozen(SESSION_BUDGETS.beforeFirstReply));
  assert.deepEqual([...SUBJECT_MARKERS], ['claude_md', 'rule_last', 'skill_last', 'mcp_tool_last']);
});

test('a healthy session passes every budget and every instrument check', () => {
  const j = judgeSessionBudget(good());
  assert.equal(j.ok, true);
  assert.equal(j.void, false);
  assert.ok(j.verdicts.every((v) => v.ok), j.verdicts.filter((v) => !v.ok).map((v) => v.message).join('\n'));
  // 3 budgets + firstReply + mcpConnected + mcpChildren + tools + 4 markers
  assert.equal(j.verdicts.filter((v) => v.kind === 'budget').length, 3);
  assert.equal(j.verdicts.filter((v) => v.kind === 'instrument').length, 8);
});

test('a boot-time context read (count_tokens burst before the first reply) breaks the budget NAMING it and the counts', () => {
  const j = judgeSessionBudget(good({ requests: { beforeFirstReply: counts(1, 57), afterFirstReply: counts(0, 3), total: counts(1, 60) } }));
  assert.equal(j.ok, false);
  assert.equal(j.void, false, 'a broken budget is a FAIL, not a VOID');
  const broken = j.verdicts.filter((v) => !v.ok);
  assert.equal(broken.length, 1);
  assert.equal(broken[0].id, 'session.beforeFirstReply.countTokensRequests');
  assert.equal(broken[0].actual, 57);
  assert.match(broken[0].message, /BUDGET BROKEN session\.beforeFirstReply\.countTokensRequests: allowed at most 0, saw 57/);
  assert.match(broken[0].message, /model=1 count_tokens=57 other=0/);
});

test('exactly one model request: zero AND two both break it', () => {
  for (const n of [0, 2]) {
    const j = judgeSessionBudget(good({ requests: { beforeFirstReply: counts(n, 0), afterFirstReply: counts(0, 0), total: counts(n, 0) } }));
    const v = j.verdicts.find((x) => x.id === 'session.beforeFirstReply.modelRequests')!;
    assert.equal(v.ok, false, `model=${n}`);
    assert.match(v.message, new RegExp(`BUDGET BROKEN .*allowed exactly 1, saw ${n}`));
  }
});

test('any other route before the first reply breaks otherRequests (a CLI upgrade adding a startup call is seen, not absorbed)', () => {
  const j = judgeSessionBudget(good({ requests: { beforeFirstReply: counts(1, 0, 1), afterFirstReply: counts(0, 0), total: counts(1, 0, 1) } }));
  const v = j.verdicts.find((x) => x.id === 'session.beforeFirstReply.otherRequests')!;
  assert.equal(v.ok, false);
  assert.match(v.message, /saw 1 — .*other=1/);
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

test('the printed request summary carries all three windows by type', () => {
  const lines = formatRequestSummary(good());
  assert.equal(lines.length, 3);
  assert.match(lines[0], /before first reply: model=1 count_tokens=0 other=0/);
  assert.match(lines[1], /after first reply: +model=0 count_tokens=57 other=0/);
});
