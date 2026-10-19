import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown } from './mini-markdown.ts';

test('blocks: heading, paragraph (line breaks kept), lists, code fence, quote, hr, table', () => {
  const md = [
    '## Résultat',
    'Première ligne',
    'deuxième ligne',
    '',
    '- un',
    '- **deux**',
    '1. a',
    '2. b',
    '```ts',
    'const x = `y`;',
    '',
    '```',
    '> cité',
    '---',
    '| A | B |',
    '|---|:-:|',
    '| `1` | 2 |',
  ].join('\n');
  const b = parseMarkdown(md);
  assert.deepEqual(b.map((x) => x.t), ['h', 'p', 'ul', 'ol', 'code', 'quote', 'hr', 'table']);
  assert.deepEqual(b[0], { t: 'h', level: 2, spans: [{ t: 'text', text: 'Résultat' }] });
  assert.deepEqual(b[1], { t: 'p', spans: [{ t: 'text', text: 'Première ligne\ndeuxième ligne' }] });
  assert.deepEqual(b[2], { t: 'ul', items: [{ spans: [{ t: 'text', text: 'un' }], sub: [] }, { spans: [{ t: 'b', spans: [{ t: 'text', text: 'deux' }] }], sub: [] }] });
  assert.deepEqual(b[4], { t: 'code', text: 'const x = `y`;\n' }, 'code is verbatim, inline markers untouched');
  const table = b[7];
  assert.ok(table.t === 'table');
  if (table.t === 'table') {
    assert.equal(table.rows.length, 2, 'the separator row is not a row');
    assert.deepEqual(table.rows[1][0], [{ t: 'code', text: '1' }]);
  }
});

test('inline: bold, italic, code, http(s) links only; snake_case is not emphasis', () => {
  const [p] = parseMarkdown('Voir **gras**, *it*, `code`, [doc](https://ex.com/a), [x](javascript:alert(1)) et my_var_name.');
  assert.ok(p.t === 'p');
  if (p.t === 'p') {
    assert.deepEqual(
      p.spans.map((s) => s.t),
      ['text', 'b', 'text', 'i', 'text', 'code', 'text', 'a', 'text'],
    );
    const link = p.spans.find((s) => s.t === 'a');
    assert.deepEqual(link, { t: 'a', text: 'doc', href: 'https://ex.com/a' });
    const tail = p.spans.at(-1);
    assert.equal(tail?.t === 'text' && tail.text, ', [x](javascript:alert(1)) et my_var_name.', 'a non-http link stays plain text');
  }
});

test('an underscore inside a word never opens emphasis, even when a later one could close it', () => {
  assert.deepEqual(parseMarkdown('foo_bar et baz_'), [{ t: 'p', spans: [{ t: 'text', text: 'foo_bar et baz_' }] }]);
  assert.deepEqual(parseMarkdown('_ok_ et x'), [{ t: 'p', spans: [{ t: 'i', spans: [{ t: 'text', text: 'ok' }] }, { t: 'text', text: ' et x' }] }]);
});

test('never markup: HTML in agent text comes back as plain text spans', () => {
  const b = parseMarkdown('<img src=x onerror=alert(1)> **<b>**');
  assert.ok(b[0].t === 'p');
  if (b[0].t === 'p') {
    assert.deepEqual(b[0].spans, [{ t: 'text', text: '<img src=x onerror=alert(1)> ' }, { t: 'b', spans: [{ t: 'text', text: '<b>' }] }]);
  }
});

const txt = (text: string) => ({ t: 'text', text });

test('iPhone 2026-10-19: lists nest by indent, keep their « → » continuation lines, and survive blank lines between items', () => {
  const b = parseMarkdown(['- **point**', '  → pourquoi', '  - sous-point', '  - autre', '- deux', '', '1. a', '', '2. b', '', 'texte', '', '3. c'].join('\n'));
  assert.deepEqual(b.map((x) => x.t), ['ul', 'ol', 'p', 'ol']);
  assert.deepEqual(b[0], {
    t: 'ul',
    items: [
      { spans: [{ t: 'b', spans: [txt('point')] }, txt('\n→ pourquoi')], sub: [{ t: 'ul', items: [{ spans: [txt('sous-point')], sub: [] }, { spans: [txt('autre')], sub: [] }] }] },
      { spans: [txt('deux')], sub: [] },
    ],
  });
  assert.deepEqual(b[1], { t: 'ol', items: [{ spans: [txt('a')], sub: [] }, { spans: [txt('b')], sub: [] }] }, 'one list, numbered 1, 2');
  assert.deepEqual(b[3], { t: 'ol', start: 3, items: [{ spans: [txt('c')], sub: [] }] }, 'a list resumed after a paragraph keeps its number');
  assert.deepEqual(parseMarkdown('- a\n```\ncode\n```').map((x) => x.t), ['ul', 'code'], 'a fence ends the list');
  assert.deepEqual(parseMarkdown('- a\n1. b').map((x) => x.t), ['ul', 'ol'], 'another kind at the same level is another list');
});

test('inline: bold and italic carry their own spans (code / links inside bold); bare http(s) URLs are links', () => {
  assert.deepEqual(parseMarkdown('**voir `x` et [d](https://e.com)**')[0], {
    t: 'p',
    spans: [{ t: 'b', spans: [txt('voir '), { t: 'code', text: 'x' }, txt(' et '), { t: 'a', text: 'd', href: 'https://e.com' }] }],
  });
  const [p] = parseMarkdown('PR https://github.com/o/r/pull/12. et (https://e.com/a_(b)) puis xhttps://no.pe');
  assert.ok(p.t === 'p');
  if (p.t === 'p') {
    assert.deepEqual(p.spans, [
      txt('PR '),
      { t: 'a', text: 'https://github.com/o/r/pull/12', href: 'https://github.com/o/r/pull/12' },
      txt('. et ('),
      { t: 'a', text: 'https://e.com/a_(b)', href: 'https://e.com/a_(b)' },
      txt(') puis xhttps://no.pe'),
    ]);
  }
});

test('an unclosed fence takes the rest; empty input gives no block', () => {
  assert.deepEqual(parseMarkdown('```\nfoo\nbar'), [{ t: 'code', text: 'foo\nbar' }]);
  assert.deepEqual(parseMarkdown(''), []);
});

test('the function is self-contained (it is injected by toString into the phone script)', () => {
  const src = parseMarkdown.toString();
  const injected = new Function(`return (${src})`)() as typeof parseMarkdown;
  const sample = '# t\n- **a** https://e.com\n  - b\n\n2. c';
  assert.deepEqual(injected(sample), parseMarkdown(sample));
});
