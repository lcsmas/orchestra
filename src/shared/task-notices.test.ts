import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isTaskNoticeMessage,
  parseTaskNotice,
  describeTaskNoticeRun,
  formatDurationMs,
  TASK_NOTICE_ORIGIN,
} from './task-notices.ts';
import { originLabel } from './agent-events.ts';

// Fixtures are real CLI bodies (shapes surveyed over 787 on-disk notices, #273),
// ids shortened.
const env = (inner: string) => `<task-notification>\n${inner}\n</task-notification>`;

const AGENT_DONE = env(
  `<task-id>aec68df2</task-id>
<tool-use-id>toolu_018A</tool-use-id>
<output-file>/tmp/claude-1000/x/tasks/aec68df2.output</output-file>
<status>completed</status>
<summary>Agent "Reply with number 8" finished</summary>
<note>A task-notification fires each time this agent stops with no live background children of its own.</note>
<result>## Report\n\n8 &lt;done&gt;</result>
<usage><subagent_tokens>71027</subagent_tokens><tool_uses>38</tool_uses><duration_ms>252000</duration_ms></usage>`,
);
const AGENT_FAILED = env(
  `<task-id>ab05c21d</task-id>
<status>failed</status>
<summary>Agent "Lens 2: performance/EXPLAIN" failed: Agent terminated early due to an API error: You've hit your session limit</summary>`,
);
const CMD_OK = env(
  `<task-id>bbybguq11</task-id>
<tool-use-id>toolu_01XC</tool-use-id>
<output-file>/tmp/claude-1000/x/tasks/bbybguq11.output</output-file>
<status>completed</status>
<summary>Background command "Wait for final agents" completed (exit code 0)</summary>`,
);
const CMD_FAIL = env(
  `<task-id>b1</task-id>
<status>failed</status>
<summary>Background command "pnpm test" failed with exit code 2</summary>`,
);
const MONITOR_EVENT = env(
  `<task-id>byj63kspa</task-id>
<summary>Monitor event: "lens4 matrix file appears"</summary>
<event>[Monitor timed out — re-arm if needed.]</event>`,
);
const ORPHAN_AGENT = env(
  `<task-id>a4c65768bfc2d6a1c</task-id>
<output-file>/tmp/claude-1000/x/tasks/a4c65768bfc2d6a1c.output</output-file>
<status>stopped</status>
<summary>Background agent "Pre-review commit-lock delta" didn't finish before the previous session ended</summary>
<note>No completion record was found for it in the previous session.</note>`,
);
const ORPHAN_SHELLS = env(
  `<task-id>bjv57wmso</task-id>
<task-id>bwqtbq7xo</task-id>
<task-id>__orphan_summary__:shell</task-id>
<status>stopped</status>
<summary>2 background shell command tasks didn't finish before the previous session ended. Task ids: bjv57wmso, bwqtbq7xo.</summary>
<note>They have been marked stopped.</note>`,
);

test('isTaskNoticeMessage keys on the origin badge originLabel produces, never on text', () => {
  assert.equal(originLabel({ kind: 'task-notification' } as never), TASK_NOTICE_ORIGIN);
  assert.equal(isTaskNoticeMessage({ role: 'user', origin: TASK_NOTICE_ORIGIN }), true);
  // must-FAIL: a human turn pasting the XML has no origin.
  assert.equal(isTaskNoticeMessage({ role: 'user' }), false);
  assert.equal(isTaskNoticeMessage({ role: 'user', origin: 'peer: x' }), false);
  assert.equal(isTaskNoticeMessage({ role: 'assistant', origin: TASK_NOTICE_ORIGIN }), false);
});

test('agent finished: own label, usage meta, decoded result, note kept for the fold', () => {
  const n = parseTaskNotice(AGENT_DONE)!;
  assert.equal(n.kind, 'agent');
  assert.equal(n.tone, 'ok');
  assert.equal(n.label, 'Agent “Reply with number 8” finished');
  assert.deepEqual(n.meta, ['4m 12s', '38 tools']);
  assert.equal(n.result, '## Report\n\n8 <done>');
  assert.match(n.note!, /fires each time/);
  assert.equal(n.outputFile, '/tmp/claude-1000/x/tasks/aec68df2.output');
  assert.deepEqual(n.taskIds, ['aec68df2']);
  assert.equal(n.orphan, false);
});

test('agent failed: fail tone with the reason on the row', () => {
  const n = parseTaskNotice(AGENT_FAILED)!;
  assert.equal(n.tone, 'fail');
  assert.equal(n.label, 'Agent “Lens 2: performance/EXPLAIN” failed');
  assert.match(n.detail!, /session limit/);
  assert.match(n.reason!, /^Agent terminated early/);
});

test('background command: exit 0 is ok, non-zero is a failure', () => {
  const ok = parseTaskNotice(CMD_OK)!;
  assert.deepEqual([ok.kind, ok.tone, ok.label, ok.detail], ['command', 'ok', 'Command “Wait for final agents” finished', 'exit 0']);
  const fail = parseTaskNotice(CMD_FAIL)!;
  assert.deepEqual([fail.tone, fail.label, fail.detail], ['fail', 'Command “pnpm test” failed', 'exit 2']);
  const nonZero = parseTaskNotice(CMD_OK.replace('exit code 0', 'exit code 1: No matches found'))!;
  assert.equal(nonZero.tone, 'fail');
});

test('monitor event: the event IS the row detail', () => {
  const n = parseTaskNotice(MONITOR_EVENT)!;
  assert.deepEqual([n.kind, n.tone, n.label], ['monitor', 'event', 'Monitor “lens4 matrix file appears”']);
  assert.equal(n.detail, '[Monitor timed out — re-arm if needed.]');
});

test('orphans: neutral, flagged, scan markers dropped from task ids', () => {
  const a = parseTaskNotice(ORPHAN_AGENT)!;
  assert.deepEqual([a.tone, a.orphan, a.label, a.detail], ['stopped', true, 'Agent “Pre-review commit-lock delta” interrupted', 'previous session ended']);
  const s = parseTaskNotice(ORPHAN_SHELLS)!;
  assert.equal(s.label, '2 commands interrupted');
  assert.deepEqual(s.taskIds, ['bjv57wmso', 'bwqtbq7xo']);
});

test('killed/stopped forms are neutral, never red', () => {
  for (const sum of [
    'Background command "x" was stopped',
    'Agent "x" was stopped by Claude',
    'Monitor "x" stopped',
    'Task "x" was stopped by the user',
  ]) {
    const n = parseTaskNotice(env(`<task-id>t</task-id><status>killed</status><summary>${sum}</summary>`))!;
    assert.equal(n.tone, 'stopped', sum);
  }
});

test('names are cut to their first line', () => {
  const n = parseTaskNotice(env('<status>completed</status><summary>Background command "echo a\nrc=$?" completed (exit code 0)</summary>'))!;
  assert.equal(n.label, 'Command “echo a” finished');
});

test('unknown summary wording inside a valid envelope: our row, the CLI words', () => {
  const n = parseTaskNotice(env('<status>failed</status><summary>Something new happened</summary>'))!;
  assert.deepEqual([n.kind, n.tone, n.label], ['task', 'fail', 'Something new happened']);
  for (const [status, tone] of [['killed', 'stopped'], ['stopped', 'stopped'], ['completed', 'ok']]) {
    assert.equal(parseTaskNotice(env(`<status>${status}</status><summary>New wording</summary>`))!.tone, tone, status);
  }
  assert.equal(parseTaskNotice(env('<summary>New wording</summary>'))!.tone, 'event');
});

test('must-FAIL: anything but exactly one envelope with a summary keeps the bubble', () => {
  assert.equal(parseTaskNotice(undefined), null);
  assert.equal(parseTaskNotice('hello'), null);
  assert.equal(parseTaskNotice(`see this: ${CMD_OK}`), null);
  assert.equal(parseTaskNotice(`${CMD_OK}\nand more`), null);
  assert.equal(parseTaskNotice(CMD_OK + CMD_FAIL), null);
  assert.equal(parseTaskNotice(env('<status>completed</status>')), null);
});

test('group label keeps the failure count', () => {
  assert.deepEqual(describeTaskNoticeRun([{ tone: 'ok' }, { tone: 'fail' }, { tone: 'event' }]), {
    label: '3 task notices',
    failed: 1,
  });
});

test('formatDurationMs', () => {
  assert.equal(formatDurationMs(589), '1s');
  assert.equal(formatDurationMs(59_400), '59s');
  assert.equal(formatDurationMs(252_000), '4m 12s');
  assert.equal(formatDurationMs(3_720_000), '1h 02m');
});
