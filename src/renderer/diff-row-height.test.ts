/** Guard: DiffPane's `ROW_H` virtualization constant MUST equal `.diff-line`'s
 *  CSS height (and its line-height).
 *
 *  Why a test and not a comment. The windowed list positions rows by multiplying
 *  ROW_H, so if the CSS height drifts, every row past the fold is misplaced by a
 *  growing offset — the list still renders, nothing throws, and a build stays
 *  green. A comment only fires if the person editing styles.css happens to read
 *  it, and a virtualization drive only catches this if it is re-run AFTER the
 *  CSS change. A red test needs neither.
 *
 *  `line-height` is asserted too: a row whose line-height exceeds its height
 *  overflows the fixed slot even when `height` matches, so checking `height`
 *  alone would pass on a visibly broken row.
 *
 *  KNOWN LIMIT, so a pass is not over-read: this compares two literals. If the
 *  row height ever moves to a CSS custom property, a media query, or a second
 *  rule that wins the cascade, both regexes still find their numbers and this
 *  test passes while the RENDERED row is a different height — it would be blind,
 *  not wrong. It is the right guard for the failure we actually expect (someone
 *  edits one number during a styling pass); a real virtualization drive remains
 *  the oracle for rows landing where the math says.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const TSX = path.join(repoRoot, 'src/renderer/components/DiffPane.tsx');
const CSS = path.join(repoRoot, 'src/renderer/styles.css');

/** The `.diff-line` BASE rule only — deliberately not `.diff-line.wrap`, which
 *  sets `height: auto` because wrap is the variable-height mode that turns
 *  virtualization OFF. Matching the wrap rule would assert on the wrong mode
 *  entirely. `[^}]*` cannot run past the rule's closing brace. */
const DIFF_LINE_RULE = /^\.diff-line \{([^}]*)\}/m;

/** Declaration-boundary anchored. Two traps live in this one regex, both found
 *  by the "guards the guard" test below rather than by inspection:
 *
 *  1. A bare /height:\s*(\d+)px/ ALSO matches `line-height` — the substring is
 *     right there — so on a block written line-height-first it silently
 *     extracts the wrong number. Hence the leading boundary.
 *  2. The boundary must be `(?:^|[;{])\s*`, NOT `(?:^|[;{]\s*)`. In the second
 *     form the `\s*` sits inside the alternation, so the `^` branch demands the
 *     property start the line with no indentation — and a declaration written
 *     `\n  line-height: 22px` (start-of-line + two spaces) matches NOTHING.
 *     `height` accidentally still worked there because it follows a `;`, which
 *     is exactly the kind of half-working regex that passes on today's file.
 *
 *  Do not "simplify" either part away. */
const heightDecl = (prop: 'height' | 'line-height') =>
  new RegExp(String.raw`(?:^|[;{])\s*${prop}:\s*(\d+)px`, 'm');

const ROW_H_DECL = /^const ROW_H = (\d+);$/m;

function readRowH(): number {
  const src = readFileSync(TSX, 'utf8');
  const m = ROW_H_DECL.exec(src);
  assert.ok(
    m,
    `Could not find \`const ROW_H = <n>;\` in ${TSX}. If it was renamed or ` +
      `computed, update this guard — do not delete it.`,
  );
  return Number(m[1]);
}

function readDiffLine(prop: 'height' | 'line-height'): number {
  const css = readFileSync(CSS, 'utf8');
  const rule = DIFF_LINE_RULE.exec(css);
  assert.ok(rule, `Could not find the \`.diff-line { ... }\` base rule in ${CSS}.`);
  const m = heightDecl(prop).exec(rule[1]);
  assert.ok(m, `\`.diff-line\` in ${CSS} has no \`${prop}: <n>px\` declaration.`);
  return Number(m[1]);
}

test('ROW_H matches .diff-line height — virtualization would misplace rows otherwise', () => {
  const rowH = readRowH();
  const cssHeight = readDiffLine('height');
  assert.equal(
    cssHeight,
    rowH,
    `Row height drifted:\n` +
      `  ROW_H = ${rowH}   (${TSX})\n` +
      `  .diff-line height = ${cssHeight}px   (${CSS})\n` +
      `These MUST match: DiffPane's windowed list positions rows by multiplying ` +
      `ROW_H, so a mismatch misplaces every row past the fold while the build ` +
      `stays green. Change whichever side is wrong — both live at the paths above.`,
  );
});

test('.diff-line line-height matches ROW_H — a taller line overflows the fixed slot', () => {
  const rowH = readRowH();
  const cssLineHeight = readDiffLine('line-height');
  assert.equal(
    cssLineHeight,
    rowH,
    `Line-height drifted:\n` +
      `  ROW_H = ${rowH}   (${TSX})\n` +
      `  .diff-line line-height = ${cssLineHeight}px   (${CSS})\n` +
      `A line-height above the row's height overflows the fixed ${rowH}px slot ` +
      `even when \`height\` matches, so rows visually collide. Both live at the ` +
      `paths above.`,
  );
});

test('the extractors read the right declarations (guards the guard)', () => {
  // A guard nobody has watched fail is indistinguishable from one that CANNOT.
  // These run the same regexes against synthetic inputs whose answers are known
  // in advance, so a future "simplification" that breaks them fails HERE with a
  // clear reason rather than silently passing the two tests above.

  // 1. The line-height substring trap: `height:` must not match `line-height:`,
  //    including when line-height is written FIRST. This ordering also covers
  //    the INDENTED-first-declaration case that broke an earlier version of the
  //    boundary (`\s*` inside the alternation → no match at all for a property
  //    written `\n  line-height:`); both assertions below fail on that bug.
  const reordered = `.diff-line {\n  line-height: 22px;\n  height: 18px;\n}`;
  const rule = DIFF_LINE_RULE.exec(reordered);
  assert.ok(rule);
  assert.equal(
    Number(heightDecl('height').exec(rule[1])?.[1]),
    18,
    'anchored `height` regex must not capture `line-height`',
  );
  assert.equal(
    Number(heightDecl('line-height').exec(rule[1])?.[1]),
    22,
    'an indented first declaration must still be found (boundary must be `(?:^|[;{])\\s*`)',
  );

  // 2. The base rule is selected, never `.diff-line.wrap` (height: auto).
  const withWrap = `.diff-line {\n  height: 18px;\n  line-height: 18px;\n}\n.diff-line.wrap {\n  height: auto;\n  min-height: 99px;\n}`;
  const baseRule = DIFF_LINE_RULE.exec(withWrap);
  assert.ok(baseRule);
  assert.equal(Number(heightDecl('height').exec(baseRule[1])?.[1]), 18);
  assert.ok(!baseRule[1].includes('min-height: 99px'), 'must not spill into .wrap');

  // 3. Drift is actually detected — the assertion above can fail.
  assert.notEqual(Number(ROW_H_DECL.exec('const ROW_H = 20;')?.[1]), 18);
});
