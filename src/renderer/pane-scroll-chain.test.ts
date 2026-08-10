/** Guard: the flex/grid height chain from `.app` down to `.pane` must stay
 *  height-constrained, or scrollable panes silently stop scrolling.
 *
 *  THE BUG THIS EXISTS FOR (shipped, user-visible): the Diff pane could not be
 *  scrolled at all. Nothing threw, no console error, the diff rendered — it just
 *  had no scrollbar and everything past the first screenful was clipped away.
 *
 *  The mechanism, because it is not guessable from the symptom:
 *    - `.app` is `display: grid; height: 100vh` with ONE implicit row.
 *    - An implicit/`auto` row is sized from its items' content. So if a grid
 *      item's content is taller than the window, the ROW grows past 100vh.
 *      `.app` itself keeps `height: 100vh` and simply overflows, and the
 *      overflow is invisible because `#root` is `overflow: hidden` — which is
 *      why this reads as "content is cut off" rather than "layout exploded".
 *    - `.main` then inherits that oversized height, and each `min-height: 0`
 *      below it (`.pane-row`, `.pane`) faithfully divides up a box that was
 *      already too big. `.diff-scroll` ends with `clientHeight === scrollHeight`
 *      and therefore nothing to scroll.
 *
 *  It stayed hidden for so long because the terminal and structured-agent panes
 *  are `position: absolute; inset: 0` and contribute ZERO intrinsic height. The
 *  Diff pane is the first pane rendered in normal flow with arbitrarily tall
 *  content, so it was the first to inflate the row.
 *
 *  Measured in Chrome (same engine as Electron) with the real rule set, 2000
 *  diff rows in an 813px viewport:
 *    before  .main = 36088px, .diff-scroll clientHeight === scrollHeight (36000)
 *    after   .main =   813px, clientHeight 725 vs scrollHeight 36000 → scrolls
 *  Removing EITHER declaration asserted below reproduces the 36088px number.
 *  (`overflow: hidden` on `.pane` was also tried and does NOT fix it — overflow
 *  does not change a box's intrinsic contribution to grid track sizing. Do not
 *  "simplify" the fix into that.)
 *
 *  KNOWN LIMIT, so a pass is not over-read: this greps declarations out of the
 *  stylesheet text. It proves the fix is still WRITTEN, not that the app still
 *  LAYS OUT correctly — a later rule that wins the cascade, or a new unbounded
 *  ancestor between `.app` and `.pane`, would slip past it. A real browser
 *  drive (the `verify` skill) remains the oracle. This catches the failure we
 *  actually expect: someone tidying "redundant" `min-height: 0` declarations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const CSS = path.join(repoRoot, 'src/renderer/styles.css');

/** Body of the FIRST `<selector> { ... }` block. `[^}]*` cannot run past the
 *  rule's closing brace, so a match never spills into the next rule. */
function ruleBody(css: string, selector: string): string {
  const re = new RegExp(String.raw`(?:^|\n)${selector.replace('.', '\\.')} \{([^}]*)\}`);
  const m = re.exec(css);
  assert.ok(
    m,
    `Could not find the \`${selector} { ... }\` rule in ${CSS}. If it was ` +
      `renamed or restructured, update this guard — do not delete it.`,
  );
  return m[1];
}

/** Declaration-boundary anchored, so `min-height` cannot be matched by a probe
 *  for `height` (the substring is right there — the same trap that
 *  diff-row-height.test.ts documents for `line-height`). */
function hasDecl(body: string, prop: string, value: string): boolean {
  return new RegExp(String.raw`(?:^|[;{])\s*${prop}:\s*${value}\s*(?:;|$)`, 'm').test(body);
}

test('.main declares min-height: 0 — without it the Diff pane cannot scroll', () => {
  const body = ruleBody(readFileSync(CSS, 'utf8'), '.main');
  assert.ok(
    hasDecl(body, 'min-height', '0'),
    `\`.main\` lost its \`min-height: 0\`.\n` +
      `It is a grid item of \`.app\`; without this its automatic minimum size is ` +
      `its CONTENT's height, so a tall in-flow pane inflates the grid row past ` +
      `100vh and every scroll container inside it gets clientHeight === ` +
      `scrollHeight. Symptom: the Diff pane renders but will not scroll.\n` +
      `\`.sidebar\` (the sibling grid item) carries the same declaration for the ` +
      `same reason — it is not redundant on either.`,
  );
});

test('.app pins its row track — an auto row is sized by content, not the viewport', () => {
  const body = ruleBody(readFileSync(CSS, 'utf8'), '.app');
  assert.ok(
    hasDecl(body, 'grid-template-rows', 'minmax\\(0, ?1fr\\)'),
    `\`.app\` lost \`grid-template-rows: minmax(0, 1fr)\`.\n` +
      `With no explicit row track the single implicit row is \`auto\`, i.e. sized ` +
      `from its items' content, so any pane taller than the window grows the row ` +
      `past \`height: 100vh\` and breaks every descendant's percentage/flex ` +
      `height. This is the belt to \`.main { min-height: 0 }\`'s braces: it holds ` +
      `even for a future grid item that forgets its own min-height.`,
  );
});

test('.pane-row and .pane still carry min-height: 0 (the rest of the chain)', () => {
  const css = readFileSync(CSS, 'utf8');
  for (const selector of ['.pane-row', '.pane']) {
    assert.ok(
      hasDecl(ruleBody(css, selector), 'min-height', '0'),
      `\`${selector}\` lost its \`min-height: 0\`. A flex item's default ` +
        `\`min-height: auto\` refuses to shrink below its content, which breaks ` +
        `the height chain feeding \`.diff-scroll\` even when \`.main\` is correct.`,
    );
  }
});

test('the extractors read the right declarations (guards the guard)', () => {
  // A guard nobody has watched fail is indistinguishable from one that CANNOT.
  const css = `\n.thing {\n  min-width: 0;\n  height: 100vh;\n}\n.other { min-height: 0; }\n`;

  // The rule body is scoped to its own braces and does not spill into `.other`.
  const body = ruleBody(css, '.thing');
  assert.ok(!body.includes('min-height'), 'rule body must not spill past its closing brace');

  // The substring trap: a probe for `height` must not match `min-width`/`min-height`,
  // and must not match the WRONG value.
  assert.ok(hasDecl(body, 'height', '100vh'), '`height: 100vh` must be found');
  assert.ok(!hasDecl(body, 'min-height', '0'), '`min-width: 0` must not satisfy `min-height: 0`');
  assert.ok(hasDecl(ruleBody(css, '.other'), 'min-height', '0'));

  // A single-line rule (the form `.main` and `.pane` are actually written in)
  // must parse — an earlier version anchored on newlines and silently missed it.
  assert.ok(hasDecl(ruleBody(css, '.other'), 'min-height', '0'), 'single-line rules must parse');

  // Drift is actually detectable — the assertions above can fail.
  assert.ok(!hasDecl('min-height: 4px;', 'min-height', '0'));
});
