// Render smoke entry: mounts every A3 component against a mock RenderMessage of
// each type and asserts (via react-dom/server renderToString) that nothing
// throws and that the Edit/Write diffs carry the real old→new content. Bundled +
// run by run-smoke.mjs. NOT part of the node:test suite (that runner can't do
// JSX). Exits non-zero on any failure.
import React from 'react';
import { renderToString } from 'react-dom/server';
import type { RenderMessage } from '../../../../shared/types';
import { AgentMessage } from '../AgentMessage';
import { ThinkingIndicator } from '../ThinkingIndicator';

let failures = 0;
const check = (label: string, fn: () => string, assertHtml?: (html: string) => void) => {
  try {
    const html = fn();
    if (assertHtml) assertHtml(html);
    console.log(`  ok   ${label}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${label}: ${(e as Error).message}`);
  }
};

const msg = (m: Partial<RenderMessage>): RenderMessage => ({
  id: m.id ?? 'x',
  role: m.role ?? 'assistant',
  ...m,
});

// 1. Assistant markdown bubble (with code fence + inline formatting).
check('assistant markdown bubble', () =>
  renderToString(
    <AgentMessage
      message={msg({
        role: 'assistant',
        text: '# Hi\n\nSome **bold** and `code` and a [link](https://x).\n\n```ts\nconst x = 1;\n```\n\n- a\n- b',
      })}
    />
  )
);

// 2. Streaming (not done) bubble — cursor path.
check('streaming bubble shows cursor', () =>
  renderToString(<AgentMessage message={msg({ role: 'assistant', text: 'partial', done: false })} />)
);

// 3. Thinking indicator (spinner, no text).
check(
  'thinking indicator is a spinner not text',
  () => renderToString(<ThinkingIndicator />),
  (html) => {
    if (!html.includes('av-thinking-dot')) throw new Error('no spinner dots');
  }
);

// 4. User + system + error bubbles.
check('user bubble', () => renderToString(<AgentMessage message={msg({ role: 'user', text: 'do the thing' })} />));
check('system bubble', () => renderToString(<AgentMessage message={msg({ role: 'system', text: 'session init' })} />));
check('error bubble', () => renderToString(<AgentMessage message={msg({ role: 'error', text: 'boom' })} />));

// 5. Edit tool card — real old→new diff from input.
check(
  'Edit tool card renders real old→new diff',
  () =>
    renderToString(
      <AgentMessage
        message={msg({
          id: 'toolu_1',
          role: 'tool',
          toolUse: {
            toolUseId: 'toolu_1',
            name: 'Edit',
            inputJson: '',
            input: { file_path: '/a/b.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' },
          },
          toolResult: { content: 'File updated', isError: false },
          done: true,
        })}
      />
    ),
  (html) => {
    if (!html.includes('const a = 1;')) throw new Error('missing old content');
    if (!html.includes('const a = 2;')) throw new Error('missing new content');
  }
);

// 6. Write tool card — new-only diff from content.
check(
  'Write tool card renders new content',
  () =>
    renderToString(
      <AgentMessage
        message={msg({
          id: 'toolu_2',
          role: 'tool',
          toolUse: {
            toolUseId: 'toolu_2',
            name: 'Write',
            inputJson: '',
            input: { file_path: '/new.ts', content: 'export const y = 42;' },
          },
          toolResult: { content: 'File created', isError: false },
          done: true,
        })}
      />
    ),
  (html) => {
    if (!html.includes('export const y = 42;')) throw new Error('missing written content');
  }
);

// 7. Bash tool card — command + output, error styling.
check('Bash tool card (ok)', () =>
  renderToString(
    <AgentMessage
      message={msg({
        id: 't3',
        role: 'tool',
        toolUse: { toolUseId: 't3', name: 'Bash', inputJson: '', input: { command: 'ls -la', description: 'list' } },
        toolResult: { content: 'file1\nfile2', isError: false },
        done: true,
      })}
    />
  )
);
check('Bash tool card (error)', () =>
  renderToString(
    <AgentMessage
      message={msg({
        id: 't3e',
        role: 'tool',
        toolUse: { toolUseId: 't3e', name: 'Bash', inputJson: '', input: { command: 'false' } },
        toolResult: { content: 'exit 1', isError: true },
        done: true,
      })}
    />
  )
);

// 8. Read / Grep / Glob summary cards.
for (const name of ['Read', 'Grep', 'Glob']) {
  check(`${name} summary card`, () =>
    renderToString(
      <AgentMessage
        message={msg({
          id: `t-${name}`,
          role: 'tool',
          toolUse: {
            toolUseId: `t-${name}`,
            name,
            inputJson: '',
            input: name === 'Read' ? { file_path: '/x.ts' } : { pattern: 'foo' },
          },
          toolResult: { content: 'line1\nline2\nline3', isError: false },
          done: true,
        })}
      />
    )
  );
}

// 9. TodoWrite checklist.
check(
  'TodoWrite checklist',
  () =>
    renderToString(
      <AgentMessage
        message={msg({
          id: 't-todo',
          role: 'tool',
          toolUse: {
            toolUseId: 't-todo',
            name: 'TodoWrite',
            inputJson: '',
            input: {
              todos: [
                { content: 'done thing', status: 'completed' },
                { content: 'active thing', status: 'in_progress', activeForm: 'Doing it' },
                { content: 'later thing', status: 'pending' },
              ],
            },
          },
          done: true,
        })}
      />
    ),
  (html) => {
    if (!html.includes('done thing')) throw new Error('todo content missing');
  }
);

// 10. Task nested subagent card.
check('Task subagent card', () =>
  renderToString(
    <AgentMessage
      message={msg({
        id: 't-task',
        role: 'tool',
        toolUse: {
          toolUseId: 't-task',
          name: 'Task',
          inputJson: '',
          input: { subagent_type: 'Explore', description: 'find refs', prompt: 'search the tree' },
        },
        toolResult: { content: 'found 3 files', isError: false },
        done: true,
      })}
    />
  )
);

// 11. Unknown tool → generic JSON body.
check(
  'unknown tool generic card',
  () =>
    renderToString(
      <AgentMessage
        message={msg({
          id: 't-unk',
          role: 'tool',
          toolUse: { toolUseId: 't-unk', name: 'MysteryTool', inputJson: '', input: { foo: 'bar', n: 3 } },
          toolResult: { content: 'ok', isError: false },
          done: true,
        })}
      />
    ),
  (html) => {
    if (!html.includes('MysteryTool')) throw new Error('tool name missing');
  }
);

// 12. Pending tool (no result yet) — must not crash.
check('pending tool card (no result)', () =>
  renderToString(
    <AgentMessage
      message={msg({
        id: 't-pend',
        role: 'tool',
        toolUse: { toolUseId: 't-pend', name: 'Bash', inputJson: '{"command":"sleep 1"}', input: { command: 'sleep 1' } },
        done: false,
      })}
    />
  )
);

console.log(failures === 0 ? '\nALL SMOKE CHECKS PASSED' : `\n${failures} SMOKE CHECK(S) FAILED`);
if (failures > 0) process.exit(1);
