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
import {
  describeRewindPreview,
  previousRewindId,
  rewindPrefillText,
} from './rewind-util.ts';
import type { RenderMessage } from '../../../shared/types.ts';
import {
  MODEL_CHOICES,
  choiceCovers,
  describeLiveModel,
  versionedLabel,
  effectiveModel,
  modelChoicesFrom,
} from './model-util.ts';
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
  assert.ok(values.includes('claude-opus-5'));
  // Canonical aliases only — never date-suffixed (e.g. not claude-haiku-4-5-20251001).
  for (const v of values) {
    assert.ok(!/-\d{8}$/.test(v), `${v} should not carry a date suffix`);
  }
});

test('describeLiveModel maps a known base to its card label', () => {
  assert.deepEqual(describeLiveModel('claude-opus-5'), {
    label: 'Opus 5',
    description: 'Highly capable — deep work',
  });
});

test('describeLiveModel resolves a [1m]-suffixed id to its plain model label', () => {
  // The account default resolves to `claude-opus-5[1m]`, which is NOT a menu
  // entry verbatim — it must still read as the model, with NO context noise.
  const d = describeLiveModel('claude-opus-5[1m]');
  assert.equal(d.label, 'Opus 5');
  assert.equal(d.description, 'Highly capable — deep work');
});

test('describeLiveModel handles a [200k] suffix and unknown bases', () => {
  assert.equal(describeLiveModel('claude-haiku-4-5[200k]').label, 'Haiku 4.5');
  // Unknown id with no suffix falls back to the id itself.
  const unknown = describeLiveModel('claude-mystery-9');
  assert.equal(unknown.label, 'claude-mystery-9');
  assert.equal(unknown.description, 'Account default model');
  // Unknown base but a recognizable suffix still surfaces the context note.
  assert.equal(describeLiveModel('claude-mystery-9[1m]').description, '1M context');
});

test('modelChoicesFrom prefers the live runtime list and falls back to the static one', () => {
  // No live list yet (fresh app run, no session) → static fallback.
  assert.deepEqual(modelChoicesFrom(undefined), MODEL_CHOICES);
  assert.deepEqual(modelChoicesFrom([]), MODEL_CHOICES);
  // Live list wins verbatim — including models this build has never heard of,
  // which is the point of fetching dynamically (no release needed for new models).
  const live = [
    { value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus 5', description: 'New!' },
    { value: 'claude-haiku-4-5', displayName: 'Haiku 4.5', description: 'Fast' },
  ];
  const choices = modelChoicesFrom(live);
  assert.deepEqual(
    choices.map((c) => c.label),
    ['Opus 5', 'Haiku 4.5'],
  );
  assert.equal(choices[0].resolvedModel, 'claude-opus-5');
});

test('choiceCovers matches value, resolved id, static aliases, and [1m] suffixes', () => {
  const aliasRow = {
    value: 'opus',
    resolvedModel: 'claude-opus-5',
    label: 'Opus 5',
    description: '',
  };
  // Direct value and resolved-id matches, with and without a context suffix.
  assert.ok(choiceCovers(aliasRow, 'opus'));
  assert.ok(choiceCovers(aliasRow, 'claude-opus-5'));
  assert.ok(choiceCovers(aliasRow, 'claude-opus-5[1m]'));
  assert.ok(choiceCovers(aliasRow, 'opus[1m]'));
  // Static card (no resolvedModel) still covers the alias via MODEL_ALIASES.
  const staticRow = { value: 'claude-opus-5', label: 'Opus 5', description: '' };
  assert.ok(choiceCovers(staticRow, 'opus'));
  assert.ok(choiceCovers(staticRow, 'claude-opus-5[1m]'));
  // Non-matches stay non-matches.
  assert.ok(!choiceCovers(aliasRow, 'claude-sonnet-5'));
  assert.ok(!choiceCovers(aliasRow, ''));
});

test('versionedLabel renders the VERSIONED name with no context noise', () => {
  // Exact rows from supportedModels() on Claude Code 2.1.220. The runtime's
  // displayName is the bare family ("Opus", "Fable") or carries a context
  // parenthetical ("Opus (1M context)") — the user wants "Opus 5" / "Fable 5".
  assert.equal(
    versionedLabel({ value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)', description: 'Opus 5 with 1M context · Best for everyday, complex tasks' }),
    'Opus 5',
  );
  assert.equal(
    versionedLabel({ value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5', displayName: 'Fable', description: 'Fable 5 · Most capable for your hardest and longest-running tasks' }),
    'Fable 5',
  );
  assert.equal(
    versionedLabel({ value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks' }),
    'Sonnet 5',
  );
  // Dotted version, and a date-suffixed resolvedModel that must not leak.
  assert.equal(
    versionedLabel({ value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' }),
    'Haiku 4.5',
  );
  // Fallback chain: no usable description → derive from resolvedModel.
  assert.equal(
    versionedLabel({ value: 'opus', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)', description: '' }),
    'Opus 5',
  );
  // Neither description nor resolvedModel usable → displayName minus the
  // context parenthetical (never empty, never "(1M context)").
  assert.equal(
    versionedLabel({ value: 'x', displayName: 'Mystery (1M context)', description: '' }),
    'Mystery',
  );
});

test('modelChoicesFrom labels cards by version and keeps the default row verbatim', () => {
  const cards = modelChoicesFrom([
    { value: 'default', resolvedModel: 'claude-opus-5[1m]', displayName: 'Default (recommended)', description: 'Opus 5 with 1M context · Best for everyday, complex tasks' },
    { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)', description: 'Opus 5 with 1M context · Best for everyday, complex tasks' },
    { value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5', displayName: 'Fable', description: 'Fable 5 · Most capable for your hardest and longest-running tasks' },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks' },
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
  ]);
  assert.deepEqual(
    cards.map((c) => c.label),
    ['Default (recommended)', 'Opus 5', 'Fable 5', 'Sonnet 5', 'Haiku 4.5'],
  );
  // No label may carry context noise.
  for (const c of cards) assert.ok(!/context/i.test(c.label), `${c.label} must not mention context`);
});

test('describeLiveModel keeps the context size OUT of the label', () => {
  const live = modelChoicesFrom([
    { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)', description: 'Opus 5 with 1M context · Best' },
  ]);
  // Previously appended "· 1M context" to the trigger label.
  assert.equal(describeLiveModel('claude-opus-5[1m]', live).label, 'Opus 5');
  assert.equal(describeLiveModel('opus[1m]', live).label, 'Opus 5');
  // Static fallback list too.
  assert.equal(describeLiveModel('opus[1m]').label, 'Opus 5');
  assert.equal(describeLiveModel('claude-haiku-4-5[200k]').label, 'Haiku 4.5');
});

test('choiceCovers strips the context suffix on BOTH sides (v0.5.165 regression)', () => {
  // The REAL live rows from supportedModels() on Claude Code 2.1.220: every
  // Opus row resolves to `claude-opus-5[1m]` (WITH the suffix), while an
  // explicit ws.model pin is the bare `claude-opus-5` (WITHOUT it). Normalizing
  // only the incoming model — not the card's resolvedModel — meant nothing
  // covered it, so AgentControls prepended a redundant "Account default model"
  // card and checkmarked that instead of the real "Opus (1M context)" row.
  const live = modelChoicesFrom([
    { value: 'default', resolvedModel: 'claude-opus-5[1m]', displayName: 'Default (recommended)', description: '' },
    { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)', description: '' },
    { value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5', displayName: 'Fable', description: '' },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: '' },
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: '' },
  ]);
  const covering = (model: string) =>
    live.filter((c) => choiceCovers(c, model)).map((c) => c.label);

  // The bug: a suffix-free explicit id was covered by NOTHING.
  assert.deepEqual(covering('claude-opus-5'), ['Default (recommended)', 'Opus 5']);
  // Suffix-carrying and alias forms keep working.
  assert.deepEqual(covering('claude-opus-5[1m]'), ['Default (recommended)', 'Opus 5']);
  assert.deepEqual(covering('opus[1m]'), ['Default (recommended)', 'Opus 5']);
  assert.deepEqual(covering('opus'), ['Default (recommended)', 'Opus 5']);
  // A card whose resolved id has NO suffix still matches a suffixed request.
  assert.deepEqual(covering('claude-fable-5[1m]'), ['Fable 5']);
  assert.deepEqual(covering('claude-sonnet-5'), ['Sonnet 5']);
  // The Haiku card's own `value` is the alias `haiku`, which normalizes to
  // claude-haiku-4-5 — so the bare id IS correctly covered by it (its
  // resolvedModel is the date-suffixed snapshot, which is a different key).
  assert.deepEqual(covering('haiku'), ['Haiku 4.5']);
  assert.deepEqual(covering('claude-haiku-4-5'), ['Haiku 4.5']);
  // Cross-family and unknown models must NOT match anything.
  assert.deepEqual(covering('claude-opus-4-8'), []);
  assert.deepEqual(covering('some-future-model'), []);
});

test('describeLiveModel matches a live row whose resolvedModel carries a suffix', () => {
  const live = modelChoicesFrom([
    { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)', description: 'Best for everyday' },
  ]);
  // Suffix-free id against a suffixed resolvedModel — previously fell through
  // to the raw string.
  assert.deepEqual(describeLiveModel('claude-opus-5', live), {
    label: 'Opus 5',
    description: 'Best for everyday',
  });
});

test('describeLiveModel uses a live choices list when given one', () => {
  const live = [
    { value: 'opus', resolvedModel: 'claude-opus-5', label: 'Opus 5', description: 'New!' },
  ];
  // Matches via resolvedModel; the label stays the plain model name.
  assert.deepEqual(describeLiveModel('claude-opus-5[1m]', live), {
    label: 'Opus 5',
    description: 'New!',
  });
});

test('describeLiveModel resolves Claude Code short aliases', () => {
  // settings.json stores the DEFAULT as an alias (e.g. `opus[1m]`), not a full id.
  assert.deepEqual(describeLiveModel('opus[1m]'), {
    label: 'Opus 5',
    description: 'Highly capable — deep work',
  });
  assert.equal(describeLiveModel('sonnet').label, 'Sonnet 5');
  assert.equal(describeLiveModel('haiku').label, 'Haiku 4.5');
  assert.equal(describeLiveModel('fable').label, 'Fable 5');
  // Case-insensitive on the alias.
  assert.equal(describeLiveModel('OPUS').label, 'Opus 5');
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
  const inited = { sessionId: 'sess-1', model: 'claude-opus-5[1m]' };
  // Live model wins over both ws choice and default.
  assert.equal(effectiveModel(inited, 'claude-fable-5', 'opus[1m]'), 'claude-opus-5[1m]');
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

// ─── rewind helpers ──────────────────────────────────────────────────────────

test('describeRewindPreview states what changes on disk', () => {
  assert.match(describeRewindPreview(null), /Checking/);
  // A session predating file checkpointing: lead with what WILL happen (the
  // conversation still rewinds), not with an error the user can't act on.
  assert.match(
    describeRewindPreview({ canRewind: false, error: 'No file checkpoint found for this message.' }),
    /left as they are/,
  );
  assert.equal(describeRewindPreview({ canRewind: true, filesChanged: [] }), 'No file changes to undo.');
  assert.equal(
    describeRewindPreview({ canRewind: true, filesChanged: ['a.ts'], insertions: 3, deletions: 1 }),
    'Restores 1 file (+3/−1).',
  );
  assert.equal(
    describeRewindPreview({ canRewind: true, filesChanged: ['a.ts', 'b.ts'], insertions: 12, deletions: 40 }),
    'Restores 2 files (+12/−40).',
  );
  // Missing counts must read as 0, never "undefined".
  assert.equal(
    describeRewindPreview({ canRewind: true, filesChanged: ['a.ts'] }),
    'Restores 1 file (+0/−0).',
  );
});

/** A transcript row, minimal — only the fields the rewind helpers read. */
function row(id: string, rewindId?: string, text?: string): RenderMessage {
  return { id, role: rewindId ? 'user' : 'assistant', ...(rewindId ? { rewindId } : {}), ...(text ? { text } : {}) };
}

test('previousRewindId cuts at the PREDECESSOR, not the target', () => {
  // resumeSessionAt keeps the message it targets, so undoing u2 must cut at u1
  // — targeting u2 would leave the very turn being undone in the session.
  const msgs = [row('m1', 'u1', 'first'), row('m2'), row('m3', 'u2', 'second'), row('m4')];
  assert.equal(previousRewindId(msgs, 'u2'), 'u1');
});

test('previousRewindId returns undefined for the FIRST turn (fresh session)', () => {
  // Nothing to keep ⇒ the caller must start a new session rather than resume.
  const msgs = [row('m1', 'u1', 'first'), row('m2'), row('m3', 'u2', 'second')];
  assert.equal(previousRewindId(msgs, 'u1'), undefined);
  // An id that isn't in the transcript is likewise a no-op.
  assert.equal(previousRewindId(msgs, 'nope'), undefined);
});

test('previousRewindId skips rows with no rewind id', () => {
  // Assistant/tool rows and externally-originated turns carry no id and are not
  // valid cut points — the walk must pass over them to the nearest real target.
  const msgs = [
    row('m1', 'u1', 'first'),
    row('m2'),
    row('m3'), // e.g. a tool row
    row('m4', undefined, 'remote turn, no id'),
    row('m5', 'u2', 'second'),
  ];
  assert.equal(previousRewindId(msgs, 'u2'), 'u1');
});

test('rewindPrefillText returns the undone message text for edit-and-retry', () => {
  const msgs = [row('m1', 'u1', 'first'), row('m2', 'u2', 'second')];
  assert.equal(rewindPrefillText(msgs, 'u2'), 'second');
  // An image-only turn (no text) and an unknown id both yield empty, never
  // undefined — the composer would render the string "undefined".
  assert.equal(rewindPrefillText([row('m3', 'u3')], 'u3'), '');
  assert.equal(rewindPrefillText(msgs, 'nope'), '');
});
