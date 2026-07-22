import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSdkMessage,
  foldEvent,
  foldEvents,
  emptySession,
  makePermissionRequest,
  makeUserMessage,
  clearPendingPermission,
  shouldAutoApprovePermission,
  sdkEventToStatusEvent,
  ASK_USER_QUESTION,
  type NormalizeContext,
  type SdkMessage,
} from './agent-events.ts';
import type { AgentEvent } from './types.ts';

// A deterministic context: fixed clock, seq from 0.
function ctx(): NormalizeContext {
  return { seq: 0, now: () => 1_000 };
}

// Normalize a list of SDK messages through ONE shared context (as the manager
// does), returning the flat event stream.
function normalizeAll(msgs: SdkMessage[]): AgentEvent[] {
  const c = ctx();
  return msgs.flatMap((m) => normalizeSdkMessage(m, c));
}

// ─── normalize: system/init ──────────────────────────────────────────────────

test('normalize: system/init → session/init with model, cwd, tools, mode', () => {
  const [ev] = normalizeSdkMessage(
    {
      type: 'system',
      subtype: 'init',
      session_id: 'c577867a-5d92-4873',
      model: 'claude-opus-4-8',
      cwd: '/home/lmas/wt',
      permissionMode: 'default',
      tools: ['Bash', 'Write', 'Read'],
    },
    ctx(),
  );
  assert.equal(ev.type, 'session/init');
  assert.deepEqual(ev, {
    type: 'session/init',
    seq: 0,
    at: 1000,
    sessionId: 'c577867a-5d92-4873',
    model: 'claude-opus-4-8',
    cwd: '/home/lmas/wt',
    permissionMode: 'default',
    tools: ['Bash', 'Write', 'Read'],
  });
});

test('normalize: non-init system message is ignored', () => {
  assert.deepEqual(normalizeSdkMessage({ type: 'system', subtype: 'other' }, ctx()), []);
});

test('normalize: unknown permissionMode falls back to default', () => {
  const [ev] = normalizeSdkMessage(
    { type: 'system', subtype: 'init', permissionMode: 'weird' },
    ctx(),
  ) as [Extract<AgentEvent, { type: 'session/init' }>];
  assert.equal(ev.permissionMode, 'default');
});

// ─── normalize: stream_event text_delta (spike a) ────────────────────────────

test('normalize: content_block_delta/text_delta → text-delta with index', () => {
  const evs = normalizeSdkMessage(
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: "I'll do" } },
    },
    ctx(),
  );
  assert.equal(evs.length, 1);
  assert.deepEqual(evs[0], { type: 'text-delta', seq: 0, at: 1000, index: 0, text: "I'll do" });
});

// ─── normalize: input_json_delta (spike b) ───────────────────────────────────

test('normalize: input_json_delta → tool-input-delta on its own index', () => {
  const evs = normalizeSdkMessage(
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"command": "echo hi' },
      },
    },
    ctx(),
  );
  assert.equal(evs.length, 1);
  assert.deepEqual(evs[0], {
    type: 'tool-input-delta',
    seq: 0,
    at: 1000,
    index: 1,
    partialJson: '{"command": "echo hi',
  });
});

// ─── normalize: thinking is a boolean indicator, NOT text (spike b) ──────────

test('normalize: thinking content_block_start → block-start + thinking-start', () => {
  const evs = normalizeSdkMessage(
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } },
    ctx(),
  );
  assert.deepEqual(
    evs.map((e) => e.type),
    ['block-start', 'thinking-start'],
  );
});

test('normalize: thinking_delta (empty text, redacted) produces NO text event', () => {
  const evs = normalizeSdkMessage(
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } },
    },
    ctx(),
  );
  assert.deepEqual(evs, []);
});

test('normalize: text/tool block-start → block-start only', () => {
  const text = normalizeSdkMessage(
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } },
    ctx(),
  );
  assert.deepEqual(text.map((e) => e.type), ['block-start']);
  const tool = normalizeSdkMessage(
    { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use' } } },
    ctx(),
  );
  assert.deepEqual(tool.map((e) => e.type), ['block-start']);
});

test('normalize: content_block_stop → block-stop', () => {
  const evs = normalizeSdkMessage(
    { type: 'stream_event', event: { type: 'content_block_stop', index: 2 } },
    ctx(),
  );
  assert.deepEqual(evs, [{ type: 'block-stop', seq: 0, at: 1000, index: 2 }]);
});

test('normalize: message_delta / message_stop carry nothing to render', () => {
  assert.deepEqual(normalizeSdkMessage({ type: 'stream_event', event: { type: 'message_delta' } }, ctx()), []);
  assert.deepEqual(normalizeSdkMessage({ type: 'stream_event', event: { type: 'message_stop' } }, ctx()), []);
});

// ─── normalize: tool_use carries the full input (spike g) ────────────────────

test('normalize: assistant tool_use block → tool-use with full input', () => {
  const evs = normalizeSdkMessage(
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_01CP3qji1HUiXCr56TP48gqr',
            name: 'Write',
            input: { file_path: '/home/lmas/hello.txt', content: 'hi' },
          },
        ],
      },
    },
    ctx(),
  );
  assert.equal(evs.length, 1);
  assert.deepEqual(evs[0], {
    type: 'tool-use',
    seq: 0,
    at: 1000,
    toolUseId: 'toolu_01CP3qji1HUiXCr56TP48gqr',
    name: 'Write',
    input: { file_path: '/home/lmas/hello.txt', content: 'hi' },
  });
});

test('normalize: assistant text blocks are ignored (already streamed)', () => {
  const evs = normalizeSdkMessage(
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text' }] } },
    ctx(),
  );
  assert.deepEqual(evs, []);
});

// ─── normalize: tool_result (spike g) ────────────────────────────────────────

test('normalize: user tool_result → tool-result correlated by tool_use_id', () => {
  const evs = normalizeSdkMessage(
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_01CP3qji1HUiXCr56TP48gqr',
            content: 'File created successfully at: /home/lmas/hello.txt',
          },
        ],
      },
    },
    ctx(),
  );
  assert.deepEqual(evs[0], {
    type: 'tool-result',
    seq: 0,
    at: 1000,
    toolUseId: 'toolu_01CP3qji1HUiXCr56TP48gqr',
    content: 'File created successfully at: /home/lmas/hello.txt',
    isError: false,
  });
});

test('normalize: denied tool_result carries isError (spike c)', () => {
  const evs = normalizeSdkMessage(
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_0172B77mpbgcyk6bF3jZhzHD',
            content: 'SPIKE: denying this Bash call to prove the deny path.',
            is_error: true,
          },
        ],
      },
    },
    ctx(),
  );
  assert.equal(evs[0].type, 'tool-result');
  assert.equal((evs[0] as Extract<AgentEvent, { type: 'tool-result' }>).isError, true);
});

test('normalize: tool_result content as text-block array collapses to string', () => {
  const evs = normalizeSdkMessage(
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_x',
            content: [
              { type: 'text', text: '1\t' },
              { type: 'text', text: 'hi' },
            ] as unknown as string,
          },
        ],
      },
    },
    ctx(),
  );
  assert.equal((evs[0] as Extract<AgentEvent, { type: 'tool-result' }>).content, '1\thi');
});

// ─── normalize: result / turn-end (spike f) ──────────────────────────────────

test('normalize: successful result → turn-end with cost + usage', () => {
  const evs = normalizeSdkMessage(
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      api_error_status: null,
      duration_ms: 19821,
      num_turns: 5,
      result: 'All three steps are done.',
      stop_reason: 'end_turn',
      session_id: 'c577867a',
      total_cost_usd: 0.6326665,
      usage: {
        input_tokens: 8,
        cache_creation_input_tokens: 54012,
        cache_read_input_tokens: 154733,
        output_tokens: 580,
        service_tier: 'standard',
      },
    },
    ctx(),
  );
  assert.equal(evs.length, 1);
  const te = evs[0] as Extract<AgentEvent, { type: 'turn-end' }>;
  assert.equal(te.type, 'turn-end');
  assert.equal(te.isError, false);
  assert.equal(te.stopReason, 'end_turn');
  assert.equal(te.numTurns, 5);
  assert.equal(te.costUsd, 0.6326665);
  assert.equal(te.durationMs, 19821);
  assert.equal(te.resultText, 'All three steps are done.');
  assert.deepEqual(te.usage, {
    inputTokens: 8,
    outputTokens: 580,
    cacheCreationInputTokens: 54012,
    cacheReadInputTokens: 154733,
    serviceTier: 'standard',
  });
});

test('normalize: interrupted result → interrupted stop reason (spike d)', () => {
  const evs = normalizeSdkMessage(
    {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      num_turns: 1,
      session_id: 's',
    },
    ctx(),
  );
  // is_error → an error event THEN the turn-end.
  assert.deepEqual(evs.map((e) => e.type), ['error', 'turn-end']);
  const te = evs[1] as Extract<AgentEvent, { type: 'turn-end' }>;
  assert.equal(te.stopReason, 'interrupted');
});

test('normalize: transient 500 error result → error event + turn-end (spike note 6)', () => {
  const evs = normalizeSdkMessage(
    {
      type: 'result',
      subtype: 'error',
      is_error: true,
      api_error_status: 500,
      result: 'Overloaded',
      session_id: 's',
    },
    ctx(),
  );
  const err = evs[0] as Extract<AgentEvent, { type: 'error' }>;
  assert.equal(err.type, 'error');
  assert.equal(err.apiErrorStatus, 500);
  assert.equal(err.message, 'Overloaded');
  assert.equal(evs[1].type, 'turn-end');
});

test('normalize: seq is monotonic across a message sequence', () => {
  const evs = normalizeAll([
    { type: 'system', subtype: 'init', session_id: 's', model: 'm' },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'b' } } },
  ]);
  assert.deepEqual(evs.map((e) => e.seq), [0, 1, 2, 3]);
});

test('normalize: malformed messages degrade to empty, never throw', () => {
  assert.deepEqual(normalizeSdkMessage(null as unknown as SdkMessage, ctx()), []);
  assert.deepEqual(normalizeSdkMessage({} as SdkMessage, ctx()), []);
  assert.deepEqual(normalizeSdkMessage({ type: 'assistant' }, ctx()), []);
  assert.deepEqual(normalizeSdkMessage({ type: 'stream_event' }, ctx()), []);
});

// ─── makePermissionRequest ───────────────────────────────────────────────────

test('makePermissionRequest builds a permission-request event', () => {
  const ev = makePermissionRequest(ctx(), 'req-1', 'Bash', { command: 'ls' }, {
    toolUseId: 'toolu_1',
    title: 'Run a command',
  });
  assert.deepEqual(ev, {
    type: 'permission-request',
    seq: 0,
    at: 1000,
    requestId: 'req-1',
    toolUseId: 'toolu_1',
    name: 'Bash',
    input: { command: 'ls' },
    title: 'Run a command',
  });
});

// ─── shouldAutoApprovePermission (bypass never auto-answers AskUserQuestion) ──

test('shouldAutoApprovePermission: bypass auto-approves ordinary tools', () => {
  assert.equal(shouldAutoApprovePermission('bypassPermissions', 'Bash'), true);
  assert.equal(shouldAutoApprovePermission('bypassPermissions', 'Edit'), true);
  assert.equal(shouldAutoApprovePermission('bypassPermissions', 'Write'), true);
});

test('shouldAutoApprovePermission: AskUserQuestion is NEVER auto-approved, even in bypass', () => {
  // The regression guard: auto-approving AskUserQuestion resolves the tool with
  // no `answers`, so the harness returns "The user did not answer the questions"
  // and the prompt appears to close by itself. It must always park for a reply.
  assert.equal(shouldAutoApprovePermission('bypassPermissions', ASK_USER_QUESTION), false);
});

test('shouldAutoApprovePermission: non-bypass modes never auto-approve', () => {
  for (const mode of ['default', 'plan', 'acceptEdits'] as const) {
    assert.equal(shouldAutoApprovePermission(mode, 'Bash'), false);
    assert.equal(shouldAutoApprovePermission(mode, ASK_USER_QUESTION), false);
  }
});

// ─── sdkEventToStatusEvent (SDK-view "idle while working" regression guard) ──
//
// The terminal path's dot is fed by shell lifecycle hooks; the SDK runs turns
// programmatically and never fires them, so the manager must drive status from
// this mapping instead. Ground truth for the bug: a live structured session's
// spool held only `session/startup` while the agent worked → dot stuck `idle`.

const at = (type: string, extra: Record<string, unknown> = {}): AgentEvent =>
  ({ seq: 0, at: 0, type, ...extra }) as unknown as AgentEvent;

test('sdkEventToStatusEvent: a submitted turn → submit (→ running)', () => {
  assert.equal(sdkEventToStatusEvent(at('user-message', { text: 'go' })), 'submit');
});

test('sdkEventToStatusEvent: tool-use → pretool, tool-result → posttool (stay running)', () => {
  assert.equal(sdkEventToStatusEvent(at('tool-use', { name: 'Bash', toolUseId: 't', input: {} })), 'pretool');
  assert.equal(sdkEventToStatusEvent(at('tool-result', { toolUseId: 't' })), 'posttool');
});

test('sdkEventToStatusEvent: a parked permission → notify (→ waiting for the user)', () => {
  assert.equal(sdkEventToStatusEvent(at('permission-request', { requestId: 'r' })), 'notify');
});

test('sdkEventToStatusEvent: turn-end → stop (→ waiting)', () => {
  assert.equal(sdkEventToStatusEvent(at('turn-end', { isError: false })), 'stop');
});

test('sdkEventToStatusEvent: pure-render events do NOT move status (→ null)', () => {
  // These must map to null: firing a spool event for them would thrash the dot.
  for (const type of [
    'session/init',
    'text-delta',
    'thinking-start',
    'tool-input-delta',
    'block-start',
    'block-stop',
    'session/update',
    'session/remote-control',
    'error',
  ]) {
    assert.equal(sdkEventToStatusEvent(at(type)), null, `${type} must not move status`);
  }
});

// ─── fold: streaming text into one message ───────────────────────────────────

test('fold: text deltas at one index coalesce into a single assistant message', () => {
  const evs = normalizeAll([
    { type: 'system', subtype: 'init', session_id: 'S', model: 'm' },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
  ]);
  const s = foldEvents(emptySession('ws1'), evs);
  assert.equal(s.sessionId, 'S');
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].role, 'assistant');
  assert.equal(s.messages[0].text, 'Hello world');
  assert.equal(s.messages[0].done, true);
});

test('fold: session/init sets running true and model', () => {
  const s = foldEvents(
    emptySession('ws1'),
    normalizeAll([{ type: 'system', subtype: 'init', session_id: 'S', model: 'claude-opus-4-8' }]),
  );
  assert.equal(s.running, true);
  assert.equal(s.model, 'claude-opus-4-8');
});

// ─── fold: Remote Control state ──────────────────────────────────────────────

test('fold: session/remote-control replaces the whole remoteControl state', () => {
  const base = emptySession('ws1');
  assert.equal(base.remoteControl, undefined);

  // Enable → active with the shareable URL.
  const enabled = foldEvent(base, {
    type: 'session/remote-control',
    seq: 0,
    at: 0,
    state: { active: true, sessionUrl: 'https://claude.ai/code/abc123', pending: false },
  } as AgentEvent);
  assert.equal(enabled.remoteControl?.active, true);
  assert.equal(enabled.remoteControl?.sessionUrl, 'https://claude.ai/code/abc123');

  // Disable → active:false, URL cleared (full-state replace, not a merge).
  const disabled = foldEvent(enabled, {
    type: 'session/remote-control',
    seq: 1,
    at: 1,
    state: { active: false, pending: false },
  } as AgentEvent);
  assert.equal(disabled.remoteControl?.active, false);
  assert.equal(disabled.remoteControl?.sessionUrl, undefined);
});

test('fold: session/remote-control surfaces an enable error without going active', () => {
  const s = foldEvent(emptySession('ws1'), {
    type: 'session/remote-control',
    seq: 0,
    at: 0,
    state: { active: false, pending: false, error: 'Remote Control is disabled by your organization.' },
  } as AgentEvent);
  assert.equal(s.remoteControl?.active, false);
  assert.equal(s.remoteControl?.error, 'Remote Control is disabled by your organization.');
});

// ─── fold: thinking indicator ────────────────────────────────────────────────

test('fold: thinking block sets and clears the boolean indicator', () => {
  const evs = normalizeAll([
    { type: 'system', subtype: 'init', session_id: 'S' },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } },
  ]);
  let s = foldEvents(emptySession('ws1'), evs);
  const think = s.messages.find((m) => m.index === 0)!;
  assert.equal(think.thinking, true);
  assert.equal(think.text, undefined, 'thinking carries NO text (redacted)');
  // block-stop clears the indicator AND retires the block's index (closed
  // blocks must not absorb next-turn deltas at the same index).
  s = foldEvent(s, normalizeSdkMessage({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }, { seq: 99, now: () => 1 })[0]);
  assert.equal(s.messages[0].thinking, false);
  assert.equal(s.messages[0].index, undefined);
});

// ─── fold: tool_use ↔ tool_result correlation (spike g) ──────────────────────

test('fold: tool input streams then finalizes then result correlates by id', () => {
  const evs = normalizeAll([
    { type: 'system', subtype: 'init', session_id: 'S' },
    { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/a"' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ',"content":"hi"}' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: '/a', content: 'hi' } }],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'File created successfully at: /a' }],
      },
    },
  ]);
  const s = foldEvents(emptySession('ws1'), evs);
  const tool = s.messages.find((m) => m.role === 'tool')!;
  assert.ok(tool, 'a tool message exists');
  assert.equal(tool.toolUse!.toolUseId, 'toolu_1');
  assert.equal(tool.toolUse!.name, 'Write');
  // Streaming JSON assembled:
  assert.equal(tool.toolUse!.inputJson, '{"file_path":"/a","content":"hi"}');
  // Finalized parsed input (the diff source):
  assert.deepEqual(tool.toolUse!.input, { file_path: '/a', content: 'hi' });
  // Correlated result:
  assert.equal(tool.toolResult!.content, 'File created successfully at: /a');
  assert.equal(tool.toolResult!.isError, false);
  assert.equal(tool.done, true);
  // Exactly ONE tool message — no duplicate from the finalize path.
  assert.equal(s.messages.filter((m) => m.role === 'tool').length, 1);
});

test('fold: a tool_result before its tool_use still shows (out-of-order safe)', () => {
  const evs = normalizeAll([
    { type: 'system', subtype: 'init', session_id: 'S' },
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'done' }] },
    },
  ]);
  const s = foldEvents(emptySession('ws1'), evs);
  const tool = s.messages.find((m) => m.toolUse?.toolUseId === 'toolu_9')!;
  assert.equal(tool.toolResult!.content, 'done');
});

// ─── fold: permissions ───────────────────────────────────────────────────────

test('fold: permission-request queues; turn-end clears pending; explicit clear works', () => {
  const c: NormalizeContext = { seq: 0, now: () => 1 };
  const req = makePermissionRequest(c, 'req-1', 'Bash', { command: 'rm -rf /' });
  let s = foldEvent(emptySession('ws1'), req);
  assert.equal(s.pendingPermissions.length, 1);

  // Duplicate requestId does not stack.
  s = foldEvent(s, makePermissionRequest(c, 'req-1', 'Bash', { command: 'rm -rf /' }));
  assert.equal(s.pendingPermissions.length, 1);

  // Explicit clear.
  const cleared = clearPendingPermission(s, 'req-1');
  assert.equal(cleared.pendingPermissions.length, 0);

  // A turn-end also clears any stragglers.
  const te = normalizeSdkMessage(
    { type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 'S', total_cost_usd: 0.1 },
    { seq: 10, now: () => 1 },
  )[0];
  const afterTurn = foldEvent(s, te);
  assert.equal(afterTurn.pendingPermissions.length, 0);
});

// ─── fold: turn-end accumulates cost, flips running off ──────────────────────

test('fold: turn-end sets lastTurn, sums cost, running=false', () => {
  let s = emptySession('ws1');
  s = foldEvent(s, normalizeSdkMessage({ type: 'system', subtype: 'init', session_id: 'S' }, { seq: 0, now: () => 1 })[0]);
  assert.equal(s.running, true);
  const te = normalizeSdkMessage(
    { type: 'result', subtype: 'success', is_error: false, num_turns: 3, session_id: 'S', total_cost_usd: 0.25 },
    { seq: 1, now: () => 1 },
  )[0];
  s = foldEvent(s, te);
  assert.equal(s.running, false);
  assert.equal(s.totalCostUsd, 0.25);
  assert.equal(s.lastTurn!.numTurns, 3);

  // A second turn accumulates.
  const te2 = normalizeSdkMessage(
    { type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 'S', total_cost_usd: 0.1 },
    { seq: 2, now: () => 1 },
  )[0];
  s = foldEvent(s, te2);
  assert.ok(Math.abs(s.totalCostUsd - 0.35) < 1e-9);
});

// ─── fold: error event becomes an error message ──────────────────────────────

test('fold: error result yields an error message bubble', () => {
  const evs = normalizeAll([
    { type: 'system', subtype: 'init', session_id: 'S' },
    { type: 'result', subtype: 'error', is_error: true, api_error_status: 500, result: 'Overloaded', session_id: 'S' },
  ]);
  const s = foldEvents(emptySession('ws1'), evs);
  const err = s.messages.find((m) => m.role === 'error')!;
  assert.equal(err.text, 'Overloaded');
  // The turn-end still landed (running off).
  assert.equal(s.running, false);
});

// ─── fold: lastSeq tracks the max seq seen ───────────────────────────────────

test('fold: lastSeq advances to the highest folded seq', () => {
  const evs = normalizeAll([
    { type: 'system', subtype: 'init', session_id: 'S' },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } },
  ]);
  const s = foldEvents(emptySession('ws1'), evs);
  assert.equal(s.lastSeq, 1);
});

// ─── full realistic sequence (multi-block turn) ──────────────────────────────

test('fold: a full turn — text, tool call with result, turn-end — renders coherently', () => {
  const evs = normalizeAll([
    { type: 'system', subtype: 'init', session_id: 'S', model: 'claude-opus-4-8', tools: ['Bash', 'Write'] },
    // assistant explains (block 0)
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: "I'll write the file." } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    // tool call (block 1)
    { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/a","content":"hi"}' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: '/a', content: 'hi' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 2, session_id: 'S', total_cost_usd: 0.05, result: 'Done.' },
  ]);
  const s = foldEvents(emptySession('ws1'), evs);
  assert.equal(s.model, 'claude-opus-4-8');
  assert.equal(s.running, false);
  // One assistant text message + one tool message.
  const roles = s.messages.map((m) => m.role);
  assert.deepEqual(roles, ['assistant', 'tool']);
  assert.equal(s.messages[0].text, "I'll write the file.");
  assert.equal(s.messages[1].toolUse!.input!.content, 'hi');
  assert.equal(s.messages[1].toolResult!.content, 'ok');
  assert.equal(s.lastTurn!.resultText, 'Done.');
  assert.equal(s.totalCostUsd, 0.05);
});

// ─── fold is a pure function of the event stream (replay determinism) ─────────

test('fold: replaying the same events twice yields deep-equal sessions', () => {
  const evs = normalizeAll([
    { type: 'system', subtype: 'init', session_id: 'S' },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 'S', total_cost_usd: 0.01 },
  ]);
  const a = foldEvents(emptySession('ws1'), evs);
  const b = foldEvents(emptySession('ws1'), evs);
  assert.deepEqual(a, b);
});

// ─── user-message echo (the transcript's only record of a sent prompt) ────────

test('fold: user-message echoes the prompt as a done user bubble and marks running', () => {
  const c = ctx();
  const s = foldEvent(emptySession('ws1'), makeUserMessage(c, 'Fix the login bug'));
  assert.equal(s.messages.length, 1);
  const m = s.messages[0];
  assert.equal(m.role, 'user');
  assert.equal(m.text, 'Fix the login bug');
  assert.equal(m.done, true);
  assert.equal(s.running, true);
});

test('fold: user-message then turn-end orders the transcript prompt-first', () => {
  const c = ctx();
  const evs: AgentEvent[] = [
    makeUserMessage(c, 'hello'),
    ...normalizeSdkMessage(
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } },
      c,
    ),
    ...normalizeSdkMessage(
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi!' } } },
      c,
    ),
    ...normalizeSdkMessage(
      { type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 'S', total_cost_usd: 0 },
      c,
    ),
  ];
  const s = foldEvents(emptySession('ws1'), evs);
  assert.deepEqual(s.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(s.running, false);
});

test('fold: error message is terminal (done: true — no streaming cursor)', () => {
  const evs = normalizeAll([
    { type: 'result', subtype: 'error', is_error: true, api_error_status: 500, result: 'boom', session_id: 'S', num_turns: 1 },
  ]);
  const s = foldEvents(emptySession('ws1'), evs);
  const err = s.messages.find((m) => m.role === 'error')!;
  assert.equal(err.done, true);
});

// ─── session/update reflects a live model/mode switch ────────────────────────

test('fold: session/update overrides the init model without touching messages', () => {
  const c = ctx();
  let s = foldEvents(emptySession('ws1'), normalizeAll([
    { type: 'system', subtype: 'init', session_id: 'S', model: 'claude-opus-4-8' },
  ]));
  s = foldEvent(s, { seq: 5, at: 1, type: 'session/update', model: 'claude-sonnet-5' });
  assert.equal(s.model, 'claude-sonnet-5');
  s = foldEvent(s, { seq: 6, at: 1, type: 'session/update', permissionMode: 'plan' });
  assert.equal(s.permissionMode, 'plan');
  // Model untouched by the mode-only update.
  assert.equal(s.model, 'claude-sonnet-5');
});

// ─── background tasks: normalize ─────────────────────────────────────────────

test('normalize: task_started → task/started event', () => {
  const [ev] = normalizeSdkMessage(
    {
      type: 'system',
      subtype: 'task_started',
      task_id: 't1',
      tool_use_id: 'toolu_1',
      task_type: 'subagent',
      subagent_type: 'general-purpose',
      description: 'Peek at .claude json',
    },
    ctx(),
  );
  assert.deepEqual(ev, {
    type: 'task',
    kind: 'started',
    seq: 0,
    at: 1000,
    taskId: 't1',
    toolUseId: 'toolu_1',
    taskType: 'subagent',
    subagentType: 'general-purpose',
    description: 'Peek at .claude json',
  });
});

test('normalize: task_progress lifts usage/last-tool/summary', () => {
  const [ev] = normalizeSdkMessage(
    {
      type: 'system',
      subtype: 'task_progress',
      task_id: 't1',
      description: 'Peek at .claude json',
      usage: { total_tokens: 60300, tool_uses: 1 },
      last_tool_name: 'Bash',
      summary: 'Reading config',
    },
    ctx(),
  );
  assert.equal(ev.type, 'task');
  assert.equal(ev.kind, 'progress');
  assert.deepEqual(ev.usage, { totalTokens: 60300, toolUses: 1 });
  assert.equal(ev.lastToolName, 'Bash');
  assert.equal(ev.summary, 'Reading config');
});

test('normalize: task_notification carries terminal status + transcript', () => {
  const [ev] = normalizeSdkMessage(
    {
      type: 'system',
      subtype: 'task_notification',
      task_id: 't1',
      status: 'completed',
      usage: { total_tokens: 60300, tool_uses: 1, duration_ms: 11000 },
      output_file: '/tmp/agent-t1.jsonl',
    },
    ctx(),
  );
  assert.equal(ev.kind, 'notification');
  assert.equal(ev.status, 'completed');
  assert.deepEqual(ev.usage, { totalTokens: 60300, toolUses: 1, durationMs: 11000 });
  assert.equal(ev.outputFile, '/tmp/agent-t1.jsonl');
});

test('normalize: task_notification killed → stopped', () => {
  const [ev] = normalizeSdkMessage(
    { type: 'system', subtype: 'task_notification', task_id: 't1', status: 'killed' },
    ctx(),
  );
  assert.equal(ev.status, 'stopped');
});

test('normalize: task_updated patch maps terminal status, ignores running', () => {
  const [running] = normalizeSdkMessage(
    { type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'running' } },
    ctx(),
  );
  assert.equal(running.status, undefined);
  const [failed] = normalizeSdkMessage(
    { type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'failed' } },
    ctx(),
  );
  assert.equal(failed.status, 'failed');
});

test('normalize: background_tasks_changed → live id set', () => {
  const [ev] = normalizeSdkMessage(
    {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [
        { task_id: 't1', task_type: 'subagent', description: 'a' },
        { task_id: 't2', task_type: 'shell', description: 'b' },
      ],
    },
    ctx(),
  );
  assert.equal(ev.kind, 'changed');
  assert.deepEqual(ev.liveIds, ['t1', 't2']);
});

// ─── background tasks: fold ──────────────────────────────────────────────────

function taskEvent(over: Partial<Extract<AgentEvent, { type: 'task' }>>): AgentEvent {
  return { type: 'task', kind: 'started', seq: 0, at: 1000, ...over } as AgentEvent;
}

test('fold: started creates a running card in insertion order', () => {
  let s = emptySession('ws');
  s = foldEvent(s, taskEvent({ kind: 'started', taskId: 't1', description: 'Peek', subagentType: 'gp' }));
  s = foldEvent(s, taskEvent({ seq: 1, kind: 'started', taskId: 't2', description: 'Uptime' }));
  assert.deepEqual(Object.keys(s.tasks), ['t1', 't2']);
  assert.equal(s.tasks.t1.status, 'running');
  assert.equal(s.tasks.t1.description, 'Peek');
  assert.equal(s.tasks.t1.subagentType, 'gp');
  assert.equal(s.tasks.t1.startedAt, 1000);
});

test('fold: progress merges usage without clobbering started fields', () => {
  let s = emptySession('ws');
  s = foldEvent(s, taskEvent({ kind: 'started', taskId: 't1', description: 'Peek', subagentType: 'gp' }));
  s = foldEvent(
    s,
    taskEvent({ seq: 1, kind: 'progress', taskId: 't1', usage: { totalTokens: 100, toolUses: 2 }, lastToolName: 'Bash' }),
  );
  assert.equal(s.tasks.t1.description, 'Peek'); // preserved
  assert.equal(s.tasks.t1.subagentType, 'gp'); // preserved
  assert.deepEqual(s.tasks.t1.usage, { totalTokens: 100, toolUses: 2 });
  assert.equal(s.tasks.t1.lastToolName, 'Bash');
  assert.equal(s.tasks.t1.status, 'running');
});

test('fold: notification finalizes with status/usage/endedAt/transcript', () => {
  let s = emptySession('ws');
  s = foldEvent(s, taskEvent({ kind: 'started', taskId: 't1', description: 'Peek' }));
  s = foldEvent(
    s,
    taskEvent({
      seq: 1,
      at: 12000,
      kind: 'notification',
      taskId: 't1',
      status: 'completed',
      usage: { totalTokens: 60300, toolUses: 1, durationMs: 11000 },
      outputFile: '/tmp/t1.jsonl',
    }),
  );
  assert.equal(s.tasks.t1.status, 'completed');
  assert.equal(s.tasks.t1.endedAt, 12000);
  assert.equal(s.tasks.t1.usage?.durationMs, 11000);
  assert.equal(s.tasks.t1.outputFile, '/tmp/t1.jsonl');
});

test('fold: progress before started backfills (out-of-order tolerance)', () => {
  let s = emptySession('ws');
  s = foldEvent(s, taskEvent({ kind: 'progress', taskId: 't1', usage: { totalTokens: 5, toolUses: 0 } }));
  assert.equal(s.tasks.t1.status, 'running');
  assert.equal(s.tasks.t1.startedAt, 1000);
  s = foldEvent(s, taskEvent({ seq: 1, kind: 'started', taskId: 't1', description: 'Late start' }));
  assert.equal(s.tasks.t1.description, 'Late start');
  assert.deepEqual(s.tasks.t1.usage, { totalTokens: 5, toolUses: 0 });
});

test('fold: changed finalizes a running task missing from the live set (missed bookend)', () => {
  let s = emptySession('ws');
  s = foldEvent(s, taskEvent({ kind: 'started', taskId: 't1', description: 'a' }));
  s = foldEvent(s, taskEvent({ seq: 1, kind: 'started', taskId: 't2', description: 'b' }));
  // Level signal: only t2 is still live → t1's finish bookend was missed.
  s = foldEvent(s, taskEvent({ seq: 2, at: 9000, kind: 'changed', liveIds: ['t2'] }));
  assert.equal(s.tasks.t1.status, 'stopped');
  assert.equal(s.tasks.t1.endedAt, 9000);
  assert.equal(s.tasks.t2.status, 'running');
});

test('fold: changed never resurrects a finished task nor creates one', () => {
  let s = emptySession('ws');
  s = foldEvent(s, taskEvent({ kind: 'started', taskId: 't1', description: 'a' }));
  s = foldEvent(s, taskEvent({ seq: 1, at: 5000, kind: 'notification', taskId: 't1', status: 'completed' }));
  // A later level signal that omits t1 must not reopen it, and an unknown id
  // in liveIds must not spawn a phantom card.
  s = foldEvent(s, taskEvent({ seq: 2, kind: 'changed', liveIds: ['ghost'] }));
  assert.equal(s.tasks.t1.status, 'completed');
  assert.equal(s.tasks.t1.endedAt, 5000);
  assert.equal(s.tasks.ghost, undefined);
});

test('fold: replaying the whole task stream from empty rebuilds the same tasks (purity)', () => {
  const events: AgentEvent[] = [
    taskEvent({ kind: 'started', taskId: 't1', description: 'Peek', subagentType: 'gp' }),
    taskEvent({ seq: 1, kind: 'progress', taskId: 't1', usage: { totalTokens: 100, toolUses: 1 }, lastToolName: 'Bash' }),
    taskEvent({ seq: 2, at: 3000, kind: 'notification', taskId: 't1', status: 'completed', usage: { totalTokens: 200, toolUses: 3, durationMs: 2000 } }),
  ];
  const a = foldEvents(emptySession('ws'), events);
  const b = foldEvents(emptySession('ws'), events);
  assert.deepEqual(a.tasks, b.tasks);
  assert.equal(a.tasks.t1.status, 'completed');
  assert.deepEqual(a.tasks.t1.usage, { totalTokens: 200, toolUses: 3, durationMs: 2000 });
});

test('fold: live turn clock + output-char counter track a turn', () => {
  let s = emptySession('ws');
  // A user prompt starts the turn: clock set, live chars reset.
  s = foldEvent(s, { type: 'user-message', seq: 0, at: 1000, text: 'hi' });
  assert.equal(s.running, true);
  assert.equal(s.turnStartedAt, 1000);
  assert.equal(s.liveOutputChars, 0);

  // Streamed assistant text accumulates the live char count.
  s = foldEvent(s, { type: 'block-start', seq: 1, at: 1100, index: 0, kind: 'text' });
  s = foldEvent(s, { type: 'text-delta', seq: 2, at: 1200, index: 0, text: 'hello' });
  s = foldEvent(s, { type: 'text-delta', seq: 3, at: 1300, index: 0, text: ' world' });
  assert.equal(s.liveOutputChars, 'hello world'.length);

  // Turn-end stops the clock; the live counter is frozen (footer reads lastTurn).
  s = foldEvent(s, {
    type: 'turn-end',
    seq: 4,
    at: 2000,
    isError: false,
    stopReason: 'end_turn',
    numTurns: 1,
    durationMs: 1000,
    costUsd: 0.01,
    usage: null,
    resultText: null,
    sessionId: '',
  });
  assert.equal(s.running, false);
  assert.equal(s.turnStartedAt, undefined);

  // A second prompt resets the char counter and restarts the clock.
  s = foldEvent(s, { type: 'user-message', seq: 5, at: 3000, text: 'again' });
  assert.equal(s.turnStartedAt, 3000);
  assert.equal(s.liveOutputChars, 0);
});
