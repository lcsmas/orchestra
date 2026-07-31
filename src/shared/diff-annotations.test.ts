import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeRevisionPrompt,
  summarizeAnnotations,
  type DiffAnnotation,
} from './diff-annotations.ts';

const ann = (over: Partial<DiffAnnotation> & { id: string }): DiffAnnotation => ({
  path: 'src/a.ts',
  line: 10,
  side: 'new',
  code: 'const x = 1;',
  body: 'Rename this.',
  ...over,
});

test('empty list composes to empty string (callers disable the Send button)', () => {
  assert.equal(composeRevisionPrompt([]), '');
  assert.equal(summarizeAnnotations([]), 'No comments');
});

test('a single annotation anchors file, line and quoted code', () => {
  const out = composeRevisionPrompt([ann({ id: '1', path: 'src/app.ts', line: 42 })]);
  assert.match(out, /### `src\/app\.ts`/);
  assert.match(out, /\*\*line 42\*\*/);
  assert.match(out, /`const x = 1;`/);
  assert.match(out, /Rename this\./);
  // The agent needs to know what to do with the list, not just read it.
  assert.match(out, /Address each one/);
});

test('annotations group by file and sort by line within each file', () => {
  const out = composeRevisionPrompt([
    ann({ id: '1', path: 'b.ts', line: 30 }),
    ann({ id: '2', path: 'a.ts', line: 20 }),
    ann({ id: '3', path: 'b.ts', line: 5 }),
    ann({ id: '4', path: 'a.ts', line: 1 }),
  ]);
  // File order = first appearance, so it matches the pane's own ordering.
  assert.ok(out.indexOf('### `b.ts`') < out.indexOf('### `a.ts`'));
  // Within b.ts, line 5 must precede line 30 (top-down editing).
  const bSection = out.slice(out.indexOf('### `b.ts`'), out.indexOf('### `a.ts`'));
  assert.ok(bSection.indexOf('line 5') < bSection.indexOf('line 30'));
  assert.match(out, /2 file/);
});

test('a comment on a removed line says so instead of citing a phantom new line', () => {
  const out = composeRevisionPrompt([
    ann({ id: '1', side: 'old', line: 7, code: 'oldThing();' }),
  ]);
  assert.match(out, /line 7 \(removed line\)/);
});

test('multi-line markdown bodies stay inside their list item', () => {
  const out = composeRevisionPrompt([
    ann({ id: '1', body: 'First paragraph.\n\nSecond paragraph.\n\n- a bullet' }),
  ]);
  // Every non-empty body line is indented two spaces so the markdown list item
  // does not terminate at the blank line.
  assert.match(out, /\n {2}First paragraph\./);
  assert.match(out, /\n {2}Second paragraph\./);
  assert.match(out, /\n {2}- a bullet/);
  // Blank lines stay blank (indenting them would add trailing whitespace).
  assert.ok(!/\n {2}\n/.test(out), 'blank lines are not indented');
});

test('a very long source line is clipped so it cannot swamp the prompt', () => {
  const long = 'x'.repeat(500);
  const out = composeRevisionPrompt([ann({ id: '1', code: long })]);
  assert.ok(!out.includes(long), 'the raw 500-char line is not embedded');
  assert.match(out, /…/, 'clipping is visible rather than silent');
});

test('an empty code quote is omitted rather than rendering empty backticks', () => {
  const out = composeRevisionPrompt([ann({ id: '1', code: '   ' })]);
  assert.doesNotMatch(out, /``/);
  assert.match(out, /\*\*line 10\*\*/);
});

test('branch and scope orient an agent that receives this cold via a wake', () => {
  const base = composeRevisionPrompt([ann({ id: '1' })], {
    branch: 'feat/x',
    scope: 'base',
  });
  assert.match(base, /`feat\/x`/);
  assert.match(base, /committed changes vs its base/);

  const unc = composeRevisionPrompt([ann({ id: '1' })], { scope: 'uncommitted' });
  assert.match(unc, /current uncommitted changes/);
  assert.doesNotMatch(unc, /committed changes vs its base/);
});

test('counts pluralize correctly in the summary and the header', () => {
  const one = [ann({ id: '1' })];
  assert.equal(summarizeAnnotations(one), '1 comment on 1 file');
  assert.match(composeRevisionPrompt(one), /across 1 file\b/);

  const many = [
    ann({ id: '1', path: 'a.ts' }),
    ann({ id: '2', path: 'b.ts' }),
    ann({ id: '3', path: 'b.ts', line: 99 }),
  ];
  assert.equal(summarizeAnnotations(many), '3 comments on 2 files');
  assert.match(composeRevisionPrompt(many), /across 2 files/);
});

test('backticks in a comment body do not break out of the markdown structure', () => {
  const out = composeRevisionPrompt([
    ann({ id: '1', body: 'Use `Array.from` here, not ```for```.' }),
  ]);
  // The body is indented as-is; the section header must still be intact after it.
  assert.match(out, /Use `Array\.from` here/);
  assert.match(out, /^### `src\/a\.ts`$/m);
});
