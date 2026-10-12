// #373-fu (review R373-1): the tree's LAYOUT contract in CONVERSATION_CSS — one 16 px step per level, an 8-level clamp, a hairline rail at
// every ancestor's glyph, the fold line and the stand-in indented with their coordinator. The numbers are READ from the stylesheet text and
// evaluated (a rule's wording may change; its geometry may not). Real-Chrome counterpart: the rig probe `phone/tree-css-geometry`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONVERSATION_CSS } from './conversation.ts';

/** selector → declarations, for every flat `selector{decls}` rule (comments dropped, whitespace normalised). */
function rules(css: string): Array<{ sel: string[]; decl: Record<string, string> }> {
  const out: Array<{ sel: string[]; decl: Record<string, string> }> = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decl: Record<string, string> = {};
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i > 0) decl[d.slice(0, i).trim()] = d.slice(i + 1).trim().replace(/\s+/g, ' ');
    }
    out.push({ sel: m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')), decl });
  }
  return out;
}
const R = rules(CONVERSATION_CSS);
/** the declarations of the rule(s) whose selector list contains exactly `sel` */
const decl = (sel: string): Record<string, string> => Object.assign({}, ...R.filter((r) => r.sel.includes(sel)).map((r) => r.decl));

const px = (v: string | undefined): number => { const m = /^(-?\d+(?:\.\d+)?)px$/.exec((v ?? '').trim()); assert.ok(m, `a px length, got « ${v} »`); return Number(m![1]); };

/** The indentation the stylesheet gives a row at tree depth `depth`: `--d` = min(depth, clamp), `--ind` = base + d × step. */
function indentAt(depth: number): { d: number; ind: number } {
  const v = decl('.v1 li[data-depth]');
  const clamp = /^min\(var\(--depth\),\s*(\d+)\)$/.exec(v['--d'] ?? '');
  assert.ok(clamp, `--d must clamp --depth: « ${v['--d']} »`);
  const ind = /^calc\((\d+)px \+ var\(--d\)\*(\d+)px\)$/.exec(v['--ind'] ?? '');
  assert.ok(ind, `--ind must be base + --d × step: « ${v['--ind']} »`);
  const d = Math.min(depth, Number(clamp![1]));
  return { d, ind: Number(ind![1]) + d * Number(ind![2]) };
}

test('tree layout (#373): one 16 px step per level, clamped at 8 — a very deep tree keeps its text width', () => {
  assert.deepEqual([0, 1, 2, 3, 8].map((d) => indentAt(d).ind), [20, 36, 52, 68, 148], 'base 20 px + 16 px per level');
  assert.equal(indentAt(9).ind, 148, 'the 9th level stops moving');
  assert.equal(indentAt(40).ind, 148, '… and so does the 40th');
});

test('tree layout (#373): a child row, a fold line and a stand-in are indented with their coordinator', () => {
  assert.equal(decl('.v1 .row.child')['padding-left'], 'var(--ind)', 'a nested row');
  assert.equal(decl('.v1 .fold-owner.stand')['padding-left'], 'var(--ind)', 'a stand-in line');
  const fold = /^8px 20px 8px calc\(var\(--ind,\s*(\d+)px\) \+ (\d+)px\)$/.exec(decl('.v1 .fold')['padding'] ?? '');
  assert.ok(fold, `the fold line's left padding follows --ind: « ${decl('.v1 .fold')['padding']} »`);
  assert.equal(Number(fold![1]), 20, 'a fold outside the tree (no --ind) sits at the root indent');
  // a fold sits under its coordinator's TITLE: the row's indent + the glyph column (22) + the grid gap (12)
  const row = decl('.v1 .row');
  const glyph = px(/^(\d+px) /.exec(row['grid-template-columns'] ?? '')?.[1]);
  const gap = px(row['gap']);
  assert.equal(Number(fold![2]), glyph + gap, 'fold text starts at the coordinator title');
});

test('tree layout (#373): a hairline rail at EVERY ancestor\'s glyph centre, one per level, none past the clamp', () => {
  const sels = ['.v1 .row.child', '.v1 .fold[data-depth]', '.v1 .fold-owner.stand'];
  const first = decl(sels[0]);
  for (const s of sels) assert.deepEqual([decl(s)['background-image'], decl(s)['background-size'], decl(s)['background-position']], [first['background-image'], first['background-size'], first['background-position']], `${s} draws the same rail`);
  const grad = /^repeating-linear-gradient\(to right,\s*transparent 0 (\d+)px,\s*var\(--hair2\) \1px (\d+)px\)$/.exec(first['background-image'] ?? '');
  assert.ok(grad, `a repeating vertical hairline: « ${first['background-image']} »`);
  const [lineAt, period] = [Number(grad![1]), Number(grad![2])];
  assert.equal(period, lineAt + 1, 'a 1 px line at the end of each period');
  assert.equal(first['background-repeat'], 'no-repeat');
  const pos = /^(\d+)px 0$/.exec(first['background-position'] ?? '');
  assert.ok(pos, `background-position « ${first['background-position']} »`);
  const size = /^calc\(var\(--d\)\*(\d+)px\) 100%$/.exec(first['background-size'] ?? '');
  assert.ok(size, `the rail is as wide as --d steps (the CLAMPED depth): « ${first['background-size']} »`);
  assert.equal(Number(size![1]), period, 'one period per level');
  assert.equal(period, indentAt(1).ind - indentAt(0).ind, 'the rail period IS the indentation step');
  const glyph = px(/^(\d+px) /.exec(decl('.v1 .row')['grid-template-columns'] ?? '')?.[1]);
  // the ROOT glyph sits at the row's own left padding — the base the rail and --ind are both measured from — and the stand-in's glyph column is as wide as a row's
  const left = (v: string | undefined): number => px(/^\d+px (\d+px)(?: |$)/.exec(v ?? '')?.[1]);
  assert.equal(left(decl('.v1 .row')['padding']), indentAt(0).ind, 'a root row\'s left padding = the base of --ind');
  assert.equal(left(decl('.v1 .row.small')['padding']), indentAt(0).ind, 'so is a small (compact) row\'s');
  assert.equal(px(decl('.v1 .so-g')['width']), glyph, 'the stand-in\'s glyph column is as wide as a row\'s');
  for (const depth of [1, 2, 3, 8, 12]) {
    const { d } = indentAt(depth);
    const rails = Array.from({ length: d }, (_, k) => Number(pos![1]) + k * period + lineAt); // x of the k-th hairline of the rail
    const centres = Array.from({ length: d }, (_, j) => indentAt(j).ind + glyph / 2); // the glyph centre of the ancestor at level j
    assert.deepEqual(rails, centres, `depth ${depth}: every hairline sits under an ancestor's glyph centre`);
  }
});
