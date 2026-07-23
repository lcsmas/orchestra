// Pure-logic tests for the structured-agent-view components (A3).
//
// The `node --test --experimental-strip-types` runner strips types but does NOT
// transform JSX, so React render tests can't live here (they run via a separate
// esbuild harness — see agent-render-smoke.mjs). What IS testable here — and
// where the real bugs would be — is the markdown parser and the tool-input
// helpers that drive every card. These are exercised against the exact shapes
// the A1 contract's RenderMessage carries.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown } from './markdown-parse.ts';
import {
  resultText,
  inputStr,
  summarizeInput,
  truncate,
  todosFrom,
  describeToolRun,
  aggregateDiff,
  fileBase,
  type ToolLike,
} from './tool-util.ts';
import { MODEL_CHOICES, describeLiveModel, effectiveModel } from './model-util.ts';
import {
  EFFORT_LEVELS,
  EFFORT_LABELS,
  DEFAULT_EFFORT,
  effortIndex,
  effortFraction,
  effortAtFraction,
  stepEffort,
} from './effort-util.ts';

/** Terse ToolLike builder for the run-summary tests. */
function tl(name: string, input: Record<string, unknown> = {}): ToolLike {
  return { name, input };
}

test('parseMarkdown splits fenced code from prose', () => {
  const blocks = parseMarkdown('intro\n\n```ts\nconst x = 1;\n```\n\nafter');
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].kind, 'html');
  assert.equal(blocks[1].kind, 'code');
  assert.equal(blocks[2].kind, 'html');
  if (blocks[1].kind === 'code') {
    assert.equal(blocks[1].lang, 'ts');
    assert.equal(blocks[1].text, 'const x = 1;');
  }
});

test('parseMarkdown handles a still-streaming (unclosed) fence', () => {
  // Mid-stream the closing fence hasn't arrived yet — must not throw and must
  // capture the partial body as a code block.
  const blocks = parseMarkdown('```js\nconst partial =');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'code');
  if (blocks[0].kind === 'code') {
    assert.equal(blocks[0].lang, 'js');
    assert.equal(blocks[0].text, 'const partial =');
  }
});

test('parseMarkdown tolerates empty / whitespace input', () => {
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown('   '), []); // whitespace-only → no blocks
});

test('resultText flattens string and content-block-array results', () => {
  assert.equal(resultText('plain'), 'plain');
  assert.equal(resultText(undefined), '');
  assert.equal(
    resultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]),
    'a\nb'
  );
  // Unknown block shape falls back to JSON, never dropped.
  assert.match(resultText([{ foo: 1 }]), /foo/);
});

test('inputStr reads string fields and guards non-strings', () => {
  assert.equal(inputStr({ file_path: '/a/b.ts' }, 'file_path'), '/a/b.ts');
  assert.equal(inputStr({ n: 5 }, 'n'), '');
  assert.equal(inputStr(undefined, 'x'), '');
});

test('summarizeInput picks the right field per tool', () => {
  assert.equal(summarizeInput('Bash', { command: 'ls -la' }), 'ls -la');
  assert.equal(summarizeInput('Read', { file_path: '/x.ts' }), '/x.ts');
  assert.equal(summarizeInput('Grep', { pattern: 'foo' }), 'foo');
  assert.equal(
    summarizeInput('Task', { subagent_type: 'Explore', description: 'search' }),
    'search'
  );
  // Skill → the skill name off `skill` (the SDK's real field; `args` may ride along).
  assert.equal(summarizeInput('Skill', { skill: 'ship' }), 'ship');
  assert.equal(summarizeInput('Skill', { skill: 'orchestra-spawn', args: 'do X' }), 'orchestra-spawn');
  // Unknown tool → first string arg.
  assert.equal(summarizeInput('Mystery', { a: 1, b: 'hi' }), 'hi');
});

test('truncate collapses whitespace and caps length', () => {
  assert.equal(truncate('a   b\n c'), 'a b c');
  assert.equal(truncate('x'.repeat(200)).length, 120);
  assert.ok(truncate('x'.repeat(200)).endsWith('…'));
});

test('todosFrom parses and defaults a TodoWrite input', () => {
  const todos = todosFrom({
    todos: [
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'in_progress', activeForm: 'Doing B' },
      { content: 'C', status: 'weird' }, // unknown status → pending
      null, // junk → dropped
    ],
  });
  assert.equal(todos.length, 3);
  assert.equal(todos[0].status, 'completed');
  assert.equal(todos[1].activeForm, 'Doing B');
  assert.equal(todos[2].status, 'pending');
  assert.deepEqual(todosFrom(undefined), []);
  assert.deepEqual(todosFrom({ todos: 'not-array' }), []);
});

test('describeToolRun uses claude.ai verb style', () => {
  // All creates → "Created N files"; single create names the file.
  assert.equal(
    describeToolRun([tl('Write', { file_path: 'a.ts' }), tl('Edit', { file_path: 'b.ts' })]),
    'Created 2 files',
  );
  assert.equal(describeToolRun([tl('Write', { file_path: 'src/types.ts' })]), 'Created types.ts');
  // All reads.
  assert.equal(describeToolRun([tl('Read'), tl('Read'), tl('Read')]), 'Read 3 files');
  assert.equal(describeToolRun([tl('Read', { file_path: 'x/y.ts' })]), 'Read y.ts');
  // Bash-only.
  assert.equal(describeToolRun([tl('Bash')]), 'Ran a command');
  assert.equal(describeToolRun([tl('Bash'), tl('Bash')]), 'Ran 2 commands');
  // Bash + one other → the "Ran a command, used a tool" phrasing.
  assert.equal(describeToolRun([tl('Bash'), tl('Read')]), 'Ran a command, used a tool');
  // Skill → "Used a skill <name>" (single, named off `skill`); count when many.
  assert.equal(describeToolRun([tl('Skill', { skill: 'ship' })]), 'Used a skill ship');
  assert.equal(describeToolRun([tl('Skill', {})]), 'Used a skill');
  assert.equal(
    describeToolRun([tl('Skill', { skill: 'ship' }), tl('Skill', { skill: 'verify' })]),
    'Used 2 skills',
  );
  // Mixed / unknown → plain tool count.
  assert.equal(describeToolRun([tl('Read'), tl('Grep'), tl('Task')]), 'Used 3 tools');
  assert.equal(describeToolRun([tl('Mystery')]), 'Used a tool');
  assert.equal(describeToolRun([]), 'Used a tool');
});

test('aggregateDiff sums added/removed lines across Edit/Write only', () => {
  const run = [
    tl('Write', { content: 'a\nb\nc' }), // +3 -0
    tl('Edit', { old_string: 'x\ny', new_string: 'x\ny\nz\nw' }), // +4 -2
    tl('Bash', { command: 'ls' }), // ignored
  ];
  assert.deepEqual(aggregateDiff(run), { added: 7, removed: 2 });
  assert.deepEqual(aggregateDiff([tl('Read')]), { added: 0, removed: 0 });
});

test('fileBase returns the last path segment', () => {
  assert.equal(fileBase('src/a/b.ts'), 'b.ts');
  assert.equal(fileBase('b.ts'), 'b.ts');
  assert.equal(fileBase(''), '');
  assert.equal(fileBase('trailing/'), 'trailing');
});

// --- Model switcher (model-util) --------------------------------------------

test('MODEL_CHOICES offers Fable and uses date-suffix-free aliases', () => {
  const values = MODEL_CHOICES.map((c) => c.value);
  assert.ok(values.includes('claude-fable-5'), 'Fable 5 must be selectable');
  assert.ok(values.includes('claude-opus-4-8'));
  // Canonical aliases only — never date-suffixed (e.g. not claude-haiku-4-5-20251001).
  for (const v of values) {
    assert.ok(!/-\d{8}$/.test(v), `${v} should not carry a date suffix`);
  }
});

test('describeLiveModel maps a known base to its card label', () => {
  assert.deepEqual(describeLiveModel('claude-opus-4-8'), {
    label: 'Opus 4.8',
    description: 'Highly capable — deep work',
  });
});

test('describeLiveModel surfaces a [1m] context suffix as a friendly note', () => {
  // The reported bug: the account default resolves to `claude-opus-4-8[1m]`,
  // which is NOT a menu entry, so it fell through to showing the raw id.
  const d = describeLiveModel('claude-opus-4-8[1m]');
  assert.equal(d.label, 'Opus 4.8 · 1M context');
  assert.equal(d.description, 'Highly capable — deep work');
});

test('describeLiveModel handles a [200k] suffix and unknown bases', () => {
  assert.equal(describeLiveModel('claude-haiku-4-5[200k]').label, 'Haiku 4.5 · 200K context');
  // Unknown id with no suffix falls back to the id itself.
  const unknown = describeLiveModel('claude-mystery-9');
  assert.equal(unknown.label, 'claude-mystery-9');
  assert.equal(unknown.description, 'Account default model');
  // Unknown base but a recognizable suffix still surfaces the context note.
  assert.equal(describeLiveModel('claude-mystery-9[1m]').description, '1M context');
});

test('describeLiveModel resolves Claude Code short aliases', () => {
  // settings.json stores the DEFAULT as an alias (e.g. `opus[1m]`), not a full id.
  assert.deepEqual(describeLiveModel('opus[1m]'), {
    label: 'Opus 4.8 · 1M context',
    description: 'Highly capable — deep work',
  });
  assert.equal(describeLiveModel('sonnet').label, 'Sonnet 5');
  assert.equal(describeLiveModel('haiku').label, 'Haiku 4.5');
  assert.equal(describeLiveModel('fable').label, 'Fable 5');
  // Case-insensitive on the alias.
  assert.equal(describeLiveModel('OPUS').label, 'Opus 4.8');
});

test('effectiveModel: a backfilled (un-inited) session must not mask the ws choice', () => {
  // The 0.5.153 bug: reopened workspace folds history with NO session/init, so
  // the session exists with sessionId '' and model '' — and a freshly-picked
  // ws.model looked like a no-op because '' ??-masked it.
  const backfilled = { sessionId: '', model: '' };
  assert.equal(effectiveModel(backfilled, 'claude-fable-5', 'opus[1m]'), 'claude-fable-5');
  // No ws choice either → account default.
  assert.equal(effectiveModel(backfilled, undefined, 'opus[1m]'), 'opus[1m]');
});

test('effectiveModel: an inited session is the live truth', () => {
  const inited = { sessionId: 'sess-1', model: 'claude-opus-4-8[1m]' };
  // Live model wins over both ws choice and default.
  assert.equal(effectiveModel(inited, 'claude-fable-5', 'opus[1m]'), 'claude-opus-4-8[1m]');
  // Inited but model cleared ('' = session default) → fall to ws, then default.
  const cleared = { sessionId: 'sess-1', model: '' };
  assert.equal(effectiveModel(cleared, 'claude-fable-5', 'opus[1m]'), 'claude-fable-5');
  assert.equal(effectiveModel(cleared, undefined, 'opus[1m]'), 'opus[1m]');
});

test('effectiveModel: no session at all → ws choice, then default, then empty', () => {
  assert.equal(effectiveModel(undefined, 'claude-sonnet-5', 'opus[1m]'), 'claude-sonnet-5');
  assert.equal(effectiveModel(undefined, undefined, 'opus[1m]'), 'opus[1m]');
  assert.equal(effectiveModel(undefined, undefined, ''), '');
});

// ── effort-util (EffortSlider's pure logic) ──────────────────────────────────

test('effort track: index/fraction round-trip across all five stops', () => {
  assert.equal(EFFORT_LEVELS.length, 5);
  for (const level of EFFORT_LEVELS) {
    // Snapping the level's own fraction must return the same level (the
    // click-a-dot path), and every level must carry a label.
    assert.equal(effortAtFraction(effortFraction(level)), level);
    assert.ok(EFFORT_LABELS[level].length > 0);
  }
  assert.equal(effortIndex('low'), 0);
  assert.equal(effortIndex('max'), 4);
});

test('effort defaults: unset/unknown values land on the model default (high)', () => {
  assert.equal(DEFAULT_EFFORT, 'high');
  assert.equal(effortIndex(undefined), 2);
  // A corrupt persisted value can't park the thumb off-track.
  assert.equal(effortIndex('turbo' as never), 2);
  // Degenerate track math (0-width → NaN fraction) degrades to the default.
  assert.equal(effortAtFraction(Number.NaN), 'high');
});

test('effortAtFraction snaps to the nearest stop and clamps overshoot', () => {
  assert.equal(effortAtFraction(0), 'low');
  assert.equal(effortAtFraction(1), 'max');
  // A drag released past either end clamps instead of indexing off the array.
  assert.equal(effortAtFraction(-0.4), 'low');
  assert.equal(effortAtFraction(1.7), 'max');
  // Midpoints round to the nearest stop (0.3 → idx 1.2 → medium; 0.6 → idx 2.4 → high).
  assert.equal(effortAtFraction(0.3), 'medium');
  assert.equal(effortAtFraction(0.6), 'high');
});

test('stepEffort steps one stop and clamps at the track ends', () => {
  assert.equal(stepEffort('high', 1), 'xhigh');
  assert.equal(stepEffort('high', -1), 'medium');
  assert.equal(stepEffort('max', 1), 'max');
  assert.equal(stepEffort('low', -1), 'low');
  // Undefined (no persisted choice) steps from the default.
  assert.equal(stepEffort(undefined, 1), 'xhigh');
});
