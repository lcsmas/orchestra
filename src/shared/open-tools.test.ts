import test from 'node:test';
import assert from 'node:assert/strict';
import { applyToolEvent, mergeInFlight, OPEN_TOOLS_CAP, type OpenTool } from './open-tools.ts';

const use = (id: string, name = 'Bash', input: unknown = { command: `cmd ${id}` }) => ({ type: 'tool-use', toolUseId: id, name, input });

test('open tools: tool-use opens a call with its summarised input and returns the summary', () => {
  const open = new Map<string, OpenTool>();
  assert.equal(applyToolEvent(open, use('t1', 'Bash', { command: 'npm test' }), 1000), 'npm test');
  assert.deepEqual([...open], [['t1', { tool: 'Bash', input: 'npm test', startedAt: 1000 }]]);
  assert.equal(applyToolEvent(open, use('t2', 'Read', { file_path: '/a' }), 2000), 'file_path=/a');
  assert.equal(applyToolEvent(open, use('t3', 'Agent', {}), 2500), null, 'nothing to say about an empty input');
  assert.equal(open.get('t3')?.input, null);
  assert.equal(open.size, 3);
});

test('open tools: tool-result closes ONLY its own call; an unknown id is a no-op', () => {
  const open = new Map<string, OpenTool>();
  applyToolEvent(open, use('a'));
  applyToolEvent(open, use('b'));
  assert.equal(applyToolEvent(open, { type: 'tool-result', toolUseId: 'a' }), null);
  assert.deepEqual([...open.keys()], ['b']);
  applyToolEvent(open, { type: 'tool-result', toolUseId: 'zzz' });
  assert.deepEqual([...open.keys()], ['b']);
});

test('open tools: turn-end clears every open call; other events change nothing', () => {
  const open = new Map<string, OpenTool>();
  applyToolEvent(open, use('a'));
  applyToolEvent(open, use('b'));
  applyToolEvent(open, { type: 'text', toolUseId: 'a' });
  assert.equal(open.size, 2, 'an unrelated event');
  applyToolEvent(open, { type: 'turn-end' });
  assert.equal(open.size, 0);
});

test('open tools: bounded at OPEN_TOOLS_CAP — the OLDEST entries are dropped, the newest stay', () => {
  const open = new Map<string, OpenTool>();
  for (let i = 0; i < OPEN_TOOLS_CAP + 25; i++) applyToolEvent(open, use(`t${i}`));
  assert.equal(open.size, OPEN_TOOLS_CAP);
  assert.equal(open.has('t0'), false);
  assert.equal(open.has('t24'), false);
  assert.equal(open.has('t25'), true);
  assert.equal(open.has(`t${OPEN_TOOLS_CAP + 24}`), true);
});

test('mergeInFlight: a live SDK session is AUTHORITATIVE — a stranded hook entry and an id-less duplicate never appear', () => {
  const sdk = [{ tool: 'Bash', toolUseId: 's1', input: 'npm test' }];
  const hook = [
    { tool: 'Bash', toolUseId: 's1', input: null },
    { tool: 'Bash', toolUseId: 'stranded', input: null }, // its tool_result hook was dropped
    { tool: 'Bash', toolUseId: null, input: null }, // id-less duplicate
  ];
  assert.deepEqual(mergeInFlight(sdk, hook), sdk);
  assert.deepEqual(mergeInFlight([], hook), [], 'a live session with NOTHING open means nothing is in flight, whatever the hook tracker still holds');
});

test('mergeInFlight: with NO SDK session (null) the hook-fed tracker is the only source', () => {
  const hook = [{ tool: 'Bash', toolUseId: 'h1', input: 'sleep 9' }];
  assert.deepEqual(mergeInFlight(null, hook), hook);
  assert.deepEqual(mergeInFlight(null, []), []);
});
