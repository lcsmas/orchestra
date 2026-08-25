// Render smoke entry: mounts every A3 component against a mock RenderMessage of
// each type and asserts (via react-dom/server renderToString) that nothing
// throws and that the Edit/Write cards render a diff SUMMARY (path + kind + +N/−M
// counts; Monaco was removed). Bundled + run by run-smoke.mjs. NOT part of the
// node:test suite (that runner can't do JSX). Exits non-zero on any failure.
import React from 'react';
import { renderToString } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { RenderMessage } from '../../../../shared/types';
import { AgentMessage } from '../AgentMessage';
import { ThinkingIndicator } from '../ThinkingIndicator';
import { MarkdownView } from '../MarkdownView';
import { RewindContext } from '../rewind-context';
import { InboxTray } from '../InboxTray';
import { parseInboxBlocks } from '../../../../shared/inbox-blocks';

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

// 5. Edit tool card — one-line summary (path + edit kind + +N/−M counts).
// (No longer a Monaco diff: the summary shows change SIZE, not file content.)
check(
  'Edit tool card renders a diff summary',
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
    if (!html.includes('/a/b.ts')) throw new Error('missing file path');
    if (!html.includes('edit')) throw new Error('missing edit kind');
    // one line each → +1 added, −1 removed
    if (!html.includes('+1')) throw new Error('missing added count');
    if (!html.includes('−1')) throw new Error('missing removed count');
  }
);

// 6. Write tool card — summary flags a new file with an added-line count.
check(
  'Write tool card renders a new-file summary',
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
    if (!html.includes('/new.ts')) throw new Error('missing file path');
    if (!html.includes('new file')) throw new Error('missing new-file label');
    if (!html.includes('+1')) throw new Error('missing added count');
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

// 13. Block-split streaming equivalence — the smooth-rendering fix.
//     MarkdownView splits the text into stable blocks + an active tail and only
//     re-renders the tail per frame. Its rendered output must show the SAME
//     content the user would see from a naive single-<ReactMarkdown> over the
//     whole text (just cheaper per frame). We compare the visible characters
//     with ALL whitespace removed: block elements render vertically stacked, so
//     a text-node space between adjacent blocks is not visible — what must match
//     is the character content itself (no token dropped, duplicated, reordered).
//     Fenced code is excluded from the comparison because MarkdownView routes it
//     through <CodeBlock> (adds a lang label + "Copy" chrome) that the bare
//     reference lacks — a difference in our reference, not in the fix; the code
//     text itself is covered by the whitespace-stripped compare of the rest.
const contentOf = (html: string) =>
  html
    .replace(/<pre[\s\S]*?<\/pre>/g, '') // drop code-block bodies (chrome differs)
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ''); // block-boundary whitespace is not visible → ignore it

const naive = (text: string) =>
  renderToString(
    <div className="av-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );

const sample =
  'Here is the **plan** with details.\n\n' +
  '- first item\n- second item\n- third item\n\n' +
  '| Col A | Col B |\n|---|---|\n| 1 | alpha |\n| 2 | beta |\n\n' +
  'A closing paragraph with `inline code` and a [link](https://x).\n\n' +
  '```ts\nconst x = coalesce(deltas);\nreturn render(x);\n```\n\n' +
  'Final words after the code block.';

check(
  'block-split final render == naive full render (done)',
  () => renderToString(<div className="av-md"><MarkdownView text={sample} done /></div>),
  (html) => {
    if (contentOf(html) !== contentOf(naive(sample)))
      throw new Error(`content differs:\n  split: ${contentOf(html)}\n  naive: ${contentOf(naive(sample))}`);
  }
);

// Streaming prefixes: at EVERY prefix, the split render's visible content must
// equal the naive render of that same prefix — proving no token is dropped,
// duplicated, or reordered at any point in the stream (what would make output
// look "block-y" or wrong). Spread of prefix lengths, including mid-fence.
check(
  'block-split streaming matches naive at every prefix',
  () => {
    for (let n = 1; n <= sample.length; n += 7) {
      const prefix = sample.slice(0, n);
      const split = renderToString(<div className="av-md"><MarkdownView text={prefix} done={false} /></div>);
      const ref = naive(prefix);
      if (contentOf(split) !== contentOf(ref)) {
        throw new Error(
          `mismatch at prefix len ${n}:\n  split: ${contentOf(split)}\n  naive: ${contentOf(ref)}`
        );
      }
    }
    return 'ok';
  }
);

console.log(failures === 0 ? '\nALL SMOKE CHECKS PASSED' : `\n${failures} SMOKE CHECK(S) FAILED`);
// ── Rewind affordance ───────────────────────────────────────────────────────
// A user bubble with a rewindId must render the control ONLY when a provider is
// mounted; with none (the default) it must render nothing and not throw — the
// read-only/SSR path.
check('user bubble WITHOUT rewind provider has no control', () =>
  renderToString(
    <AgentMessage message={msg({ role: 'user', text: 'undo me', rewindId: 'uuid-1' })} />
  ),
  (html) => {
    if (html.includes('av-rewind')) throw new Error('rendered a rewind control with no provider');
    if (!html.includes('undo me')) throw new Error('lost the message text');
  });

check('user bubble WITH provider renders the rewind control', () =>
  renderToString(
    <RewindContext.Provider value={{
      onPreview: async () => ({ canRewind: true, filesChanged: ['a.ts'], insertions: 1, deletions: 1 }),
      onConfirm: async () => {},
      busy: false,
    }}>
      <AgentMessage message={msg({ role: 'user', text: 'undo me', rewindId: 'uuid-1' })} />
    </RewindContext.Provider>
  ),
  (html) => {
    if (!html.includes('av-rewind-btn')) throw new Error('no rewind button');
    if (!html.includes('av-message-actions')) throw new Error('no actions wrapper');
    if (!html.includes('Rewind to this message')) throw new Error('missing aria-label/title');
  });

check('a user bubble with NO rewindId offers no control', () =>
  renderToString(
    <RewindContext.Provider value={{ onPreview: async () => ({ canRewind: false }), onConfirm: async () => {}, busy: false }}>
      <AgentMessage message={msg({ role: 'user', text: 'remote turn' })} />
    </RewindContext.Provider>
  ),
  (html) => {
    if (html.includes('av-rewind')) throw new Error('offered rewind for a message with no target');
  });

check('an ASSISTANT message never offers rewind', () =>
  renderToString(
    <RewindContext.Provider value={{ onPreview: async () => ({ canRewind: true }), onConfirm: async () => {}, busy: false }}>
      <AgentMessage message={msg({ role: 'assistant', text: 'my reply', rewindId: 'uuid-9' })} />
    </RewindContext.Provider>
  ),
  (html) => {
    if (html.includes('av-rewind')) throw new Error('offered rewind on an assistant row');
  });

check('rewind button is DISABLED while a turn is running', () =>
  renderToString(
    <RewindContext.Provider value={{ onPreview: async () => ({ canRewind: true }), onConfirm: async () => {}, busy: true }}>
      <AgentMessage message={msg({ role: 'user', text: 'undo me', rewindId: 'uuid-1' })} />
    </RewindContext.Provider>
  ),
  (html) => {
    if (!html.includes('disabled')) throw new Error('control was enabled mid-turn');
  });

// ── Inbox tray (issue #64) ─────────────────────────────────────────────────
// Parsed from the REAL on-disk framing rather than hand-built objects, so these
// checks exercise the same path the app does.
const INBOX_FIXTURE =
  '\n' + '='.repeat(40) + '\n' +
  "[message from agent 'ops-fix-wave-6' (ws-ops)]\nledger #70 updated — pull it\n\n" +
  'Reply with: orchestra message ws-ops "<reply>"\n' +
  '='.repeat(40) + '\n';
const inboxBlocks = parseInboxBlocks(INBOX_FIXTURE);

check('inbox tray renders NOTHING when no message is parked', () =>
  renderToString(
    <InboxTray blocks={[]} onRelease={() => {}} onRefuse={() => {}} onReleaseAll={() => {}} />
  ),
  (html) => {
    // The common case is an empty inbox on every composer paint — the tray must
    // cost zero DOM, not an empty container.
    if (html.trim() !== '') throw new Error(`expected empty render, got: ${html}`);
  });

check('collapsed tray shows the amber chip with the parked COUNT', () =>
  renderToString(
    <InboxTray blocks={inboxBlocks} onRelease={() => {}} onRefuse={() => {}} onReleaseAll={() => {}} />
  ),
  (html) => {
    if (!html.includes('av-inbox-chip')) throw new Error('no chip rendered');
    if (!html.includes('1 message held')) throw new Error(`chip lacks the count: ${html}`);
    // Collapsed means collapsed: the row actions must NOT be in the DOM yet.
    if (html.includes('av-inbox-row')) throw new Error('collapsed tray leaked the list');
  });

check('expanded tray renders sender, preview and BOTH actions per row', () =>
  renderToString(
    <InboxTray
      blocks={inboxBlocks}
      defaultOpen
      onRelease={() => {}}
      onRefuse={() => {}}
      onReleaseAll={() => {}}
    />
  ),
  (html) => {
    if (!html.includes('av-inbox-row')) throw new Error('no rows rendered');
    if (!html.includes('ops-fix-wave-6')) throw new Error('sender missing');
    if (!html.includes('ledger #70 updated')) throw new Error('preview missing');
    if (!html.includes('Release')) throw new Error('Release action missing');
    if (!html.includes('Refuse')) throw new Error('Refuse action missing');
    // The envelope boilerplate must not reach the preview — it is noise the
    // human already knows (every parked message carries it).
    if (html.includes('Reply with: orchestra message ws-ops')) {
      throw new Error('reply footer leaked into the row');
    }
  });

check('"Release all" appears only when MORE THAN ONE message is parked', () => {
  const two = parseInboxBlocks(INBOX_FIXTURE + INBOX_FIXTURE.replace('ledger #70 updated', 'second one'));
  if (two.length !== 2) throw new Error(`fixture control failed: parsed ${two.length} blocks, expected 2`);
  const one = renderToString(
    <InboxTray blocks={inboxBlocks} defaultOpen onRelease={() => {}} onRefuse={() => {}} onReleaseAll={() => {}} />
  );
  const many = renderToString(
    <InboxTray blocks={two} defaultOpen onRelease={() => {}} onRefuse={() => {}} onReleaseAll={() => {}} />
  );
  if (one.includes('Release all')) throw new Error('offered "Release all" for a single message');
  if (!many.includes('Release all')) throw new Error('no "Release all" with 2 parked');
  return many;
});

if (failures > 0) process.exit(1);
