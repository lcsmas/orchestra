import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeReply } from './reply-segments.ts';

const bloc = (title: string | null, body = '<div>SRC</div>', close = true) =>
  '```html-render' + (title === null ? '' : ` title="${title}"`) + '\n' + body + '\n' + (close ? '```\n' : '');

test('closed bloc → its title, never its source', () => {
  const s = summarizeReply(`Voici :\n${bloc('Comparatif')}Fin.`);
  assert.equal(s, 'Voici :\nComparatif\nFin.');
  assert.ok(!s.includes('SRC') && !s.includes('```'));
});
test('bloc still being written → its title', () => {
  const s = summarizeReply(`Voici :\n${bloc('Tableau', '<div>SRC', false)}`);
  assert.equal(s.trim(), 'Voici :\nTableau');
  assert.ok(!s.includes('SRC'));
});
test('no title → « Bloc HTML »', () => {
  assert.equal(summarizeReply(bloc(null)).trim(), 'Bloc HTML');
  assert.equal(summarizeReply(bloc('')).trim(), 'Bloc HTML');
});
test('a reply made only of a bloc is non-empty (closed and open)', () => {
  assert.notEqual(summarizeReply(bloc('X')).trim(), '');
  assert.notEqual(summarizeReply('```html-render').trim(), '');
});
test('plain html fence and a quoted html-render fence stay as they are (not blocs)', () => {
  const html = '```html\n<b>x</b>\n```\n';
  assert.equal(summarizeReply(html), html);
  const quoted = '````md\n' + bloc('Q') + '````\n';
  assert.equal(summarizeReply(quoted), quoted);
});
test('too large bloc shows the title, not the source', () => {
  const s = summarizeReply(bloc('Gros', 'x'.repeat(300 * 1024)));
  assert.equal(s.trim(), 'Gros');
});
test('prose without a bloc is returned unchanged', () => {
  assert.equal(summarizeReply('a\n\nb'), 'a\n\nb');
  assert.equal(summarizeReply(''), '');
});

// Review #420 MINOR 2: a title holding a line separator other than \n made the fence prose, so the summary emitted the source.
for (const [name, sep] of [['U+2028', ' '], ['U+2029', ' '], ['lone CR', '\r']] as const) {
  test(`title with ${name} still summarises as a bloc — never the source`, () => {
    const s = summarizeReply('```html-render title="a' + sep + 'b"\n<div>SRC</div>\n```');
    assert.ok(!s.includes('SRC') && !s.includes('```'), JSON.stringify(s));
    assert.ok(s.startsWith('a') && s.endsWith('b'), JSON.stringify(s));
  });
  test(`escaped quote then ${name} in a title`, () => {
    const s = summarizeReply('```html-render title="a\\"' + sep + 'b"\n<div>SRC</div>\n```');
    assert.ok(!s.includes('SRC') && !s.includes('```'), JSON.stringify(s));
  });
}
test('a backslash right before a line separator in a title is not an escape that breaks the bloc', () => {
  for (const sep of [' ', ' ', '\r']) {
    const s = summarizeReply('```html-render title="a\\' + sep + 'b"\n<div>SRC</div>\n```');
    assert.ok(!s.includes('SRC') && !s.includes('```'), JSON.stringify(s));
    assert.ok(s.startsWith('a') && s.endsWith('b'), 'the title survives: ' + JSON.stringify(s));
  }
});
