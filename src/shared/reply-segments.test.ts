import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitReply,
  BLOC_HTML_LABEL,
  BLOC_HTML_DEFAULT_TITLE,
  BLOC_HTML_MAX_SOURCE_BYTES,
  type ReplySegment,
} from './reply-segments.ts';

const join = (segs: ReplySegment[]) => segs.map((s) => (s.kind === 'prose' ? s.text : s.raw)).join('');
const kinds = (segs: ReplySegment[]) => segs.map((s) => s.kind);
function rt(text: string, opts?: { maxSourceBytes?: number }) {
  const segs = splitReply(text, opts);
  assert.equal(join(segs), text, `round-trip failed for ${JSON.stringify(text)}`);
  return segs;
}

test('frozen constants', () => {
  assert.equal(BLOC_HTML_LABEL, 'html-render');
  assert.equal(BLOC_HTML_DEFAULT_TITLE, 'Bloc HTML');
  assert.equal(typeof BLOC_HTML_MAX_SOURCE_BYTES, 'number');
});

test('empty text → no segments; plain prose → one prose segment', () => {
  assert.deepEqual(splitReply(''), []);
  assert.deepEqual(rt('hello\n\nworld'), [{ kind: 'prose', text: 'hello\n\nworld' }]);
});

test('a closed fence sits between its prose, with title, source and exact raw', () => {
  const t = 'before\n```html-render title="Compare A/B"\n<p>hi</p>\n<b>x</b>\n```\nafter';
  const segs = rt(t);
  assert.deepEqual(segs, [
    { kind: 'prose', text: 'before\n' },
    { kind: 'bloc', title: 'Compare A/B', source: '<p>hi</p>\n<b>x</b>', raw: '```html-render title="Compare A/B"\n<p>hi</p>\n<b>x</b>\n```' },
    { kind: 'prose', text: '\nafter' },
  ]);
});

test('missing / empty / blank title → the default title', () => {
  for (const info of ['html-render', 'html-render title=""', 'html-render title="   "', 'html-render title=bare', "html-render title='single'"]) {
    const s = rt('```' + info + '\n<i>x</i>\n```').find((x) => x.kind === 'bloc');
    assert.ok(s && s.kind === 'bloc', info);
    assert.equal(s.title, BLOC_HTML_DEFAULT_TITLE, info);
  }
});

test('title is read after the label, extra words are ignored, title text is trimmed', () => {
  const s = rt('```html-render foo title="  Chiffres  " bar\n<i>x</i>\n```')[0];
  assert.ok(s.kind === 'bloc');
  assert.equal(s.title, 'Chiffres');
});

test('the label is recognised WHOLE: html, html-renderer, HTML-RENDER, html-render2 are not blocs', () => {
  for (const label of ['html', 'html-renderer', 'HTML-RENDER', 'html-render2', 'xhtml-render', 'html_render']) {
    const t = '```' + label + '\n<p>x</p>\n```';
    assert.deepEqual(rt(t), [{ kind: 'prose', text: t }], label);
  }
});

test('an html-render fence quoted inside a longer fence is prose', () => {
  const t = '````md\n```html-render title="Q"\n<p>quoted</p>\n```\n````\nafter';
  assert.deepEqual(rt(t), [{ kind: 'prose', text: t }]);
});

test('an html-render fence inside a ~~~ fence or an html fence is prose; a closing run of the other char does not close', () => {
  const a = '~~~\n```html-render\n<p>x</p>\n```\n~~~';
  assert.deepEqual(rt(a), [{ kind: 'prose', text: a }]);
  const b = '```html\n```html-render\n<p>x</p>\n```\n';
  // the first ``` closes the html fence at line 2? no: line 2 has an info string, so it does not close; line 4 closes it
  assert.deepEqual(rt(b).map((s) => s.kind), ['prose']);
  const c = '````html-render\nline\n```\nstill inside\n````';
  const s = rt(c);
  assert.deepEqual(kinds(s), ['bloc']);
  assert.equal(s[0].kind === 'bloc' && s[0].source, 'line\n```\nstill inside');
});

test('a ~~~ html-render fence is a bloc and a ``` line does not close it', () => {
  const s = rt('~~~html-render\n<p>x</p>\n```\n~~~');
  assert.deepEqual(kinds(s), ['bloc']);
  assert.equal(s[0].kind === 'bloc' && s[0].source, '<p>x</p>\n```');
});

test('a backtick in the info string means it is not a fence (CommonMark): inline code does not hide a real bloc', () => {
  const t = '```not a fence``` here\n```html-render\n<p>x</p>\n```';
  assert.deepEqual(kinds(rt(t)), ['prose', 'bloc']);
});

test('an open fence at the end of the text is bloc-pending, with the title so far', () => {
  const t = 'intro\n```html-render title="Board"\n<div>half';
  const segs = rt(t);
  assert.deepEqual(segs, [
    { kind: 'prose', text: 'intro\n' },
    { kind: 'bloc-pending', title: 'Board', source: '<div>half', raw: '```html-render title="Board"\n<div>half' },
  ]);
  // just the opening line, with and without its newline
  assert.deepEqual(rt('```html-render title="T"\n').map((s) => s.kind), ['bloc-pending']);
  assert.deepEqual(rt('```html-render title="T"').map((s) => s.kind), ['bloc-pending']);
  assert.equal((rt('```html-render title="T"\n')[0] as { source: string }).source, '');
});

test('the bloc becomes closed exactly when the closing fence line is complete', () => {
  const full = 'x\n```html-render title="T"\n<p>a</p>\n```\ny';
  const upToClose = full.slice(0, full.indexOf('```\ny') + 3);
  assert.equal(rt(upToClose).at(-1)!.kind, 'bloc');
  assert.equal(rt(upToClose.slice(0, -1)).at(-1)!.kind, 'bloc-pending'); // "``" is not a fence yet
});

test('two blocs and prose between, in order; whitespace-only prose is kept for the round-trip', () => {
  const t = '```html-render title="A"\n<a>1</a>\n```\n```html-render title="B"\n<b>2</b>\n```';
  const segs = rt(t);
  assert.deepEqual(kinds(segs), ['bloc', 'prose', 'bloc']);
  assert.equal(segs[1].kind === 'prose' && segs[1].text, '\n');
});

test('an empty bloc body is a bloc with empty source', () => {
  const s = rt('```html-render\n```');
  assert.deepEqual(s, [{ kind: 'bloc', title: BLOC_HTML_DEFAULT_TITLE, source: '', raw: '```html-render\n```' }]);
});

test('an indented fence (≤3 spaces) is a bloc and its content is dedented; 4 spaces is code, not a fence', () => {
  const s = rt('  ```html-render\n  <p>x</p>\n    <i>y</i>\n  ```');
  assert.equal(s[0].kind === 'bloc' && s[0].source, '<p>x</p>\n  <i>y</i>');
  const t = '    ```html-render\n    <p>x</p>\n    ```';
  assert.deepEqual(rt(t), [{ kind: 'prose', text: t }]);
});

test('size cap: a closed bloc over the cap is bloc-refused (too-large); at the cap it is a bloc; pending is never refused', () => {
  const body = 'x'.repeat(100);
  const t = '```html-render title="Big"\n' + body + '\n```';
  assert.equal(rt(t, { maxSourceBytes: 100 })[0].kind, 'bloc');
  const refused = rt(t, { maxSourceBytes: 99 })[0];
  assert.deepEqual(refused, { kind: 'bloc-refused', title: 'Big', source: body, raw: t, reason: 'too-large' });
  assert.equal(rt('```html-render\n' + body, { maxSourceBytes: 10 })[0].kind, 'bloc-pending');
});

test('size cap counts UTF-8 bytes, not UTF-16 units', () => {
  const body = 'é'.repeat(60); // 60 units, 120 bytes
  const t = '```html-render\n' + body + '\n```';
  assert.equal(rt(t, { maxSourceBytes: 119 })[0].kind, 'bloc-refused');
  assert.equal(rt(t, { maxSourceBytes: 120 })[0].kind, 'bloc');
});

test('the default cap applies when no option is given', () => {
  const t = '```html-render\n' + 'x'.repeat(BLOC_HTML_MAX_SOURCE_BYTES + 1) + '\n```';
  assert.equal(rt(t)[0].kind, 'bloc-refused');
});

test('round-trip holds on awkward shapes (CRLF, trailing newlines, lone fences, unicode)', () => {
  const shapes = [
    '```html-render\r\n<p>x</p>\r\n```\r\n',
    'a\n\n```html-render title="é"\n<p>ü</p>\n```\n\n\nb\n',
    '```html-render',
    '```html-render\n```\n```html-render\n',
    '```\n```html-render\n```\n```html-render\nx\n```',
    '\n\n```html-render title="T"\nx\n```\n',
  ];
  for (const t of shapes) rt(t);
});

test('round-trip holds on every prefix of a streaming reply (the typewriter reveals a prefix)', () => {
  const t = 'Voici:\n```html-render title="Cartes"\n<div class="a">1</div>\n<script>let x=1</script>\n```\nFin.\n```js\nlet a\n```\n';
  for (let i = 0; i <= t.length; i++) rt(t.slice(0, i));
});

test('splitReply is SELF-CONTAINED: its source copy, run in a bare vm (the phone page injects splitReply.toString()), agrees with the module', async () => {
  const vm = await import('node:vm');
  const injected = vm.runInNewContext('(' + splitReply.toString().replace(/: ReplySegment\[\]|: \{ maxSourceBytes\?: number \}|: string|: boolean|: number|: Fence \| null|: Fence|: \{[^}]*\} \| null/g, '') + ')', { TextEncoder }) as typeof splitReply;
  const fixtures = [
    '', 'plain prose', 'a\n```html-render title="T"\n<p>x</p>\n```\nb', '```html-render\n<i>x', '````md\n```html-render\n<p>q</p>\n```\n````',
    '  ```html-render\n  <p>x</p>\n  ```', '~~~html-render\n<p>é</p>\n```\n~~~', '```html\n<p>x</p>\n```', '```html-render title="Big"\n' + 'x'.repeat(400) + '\n```',
  ];
  for (const t of fixtures) for (const o of [undefined, { maxSourceBytes: 100 }]) assert.deepEqual(JSON.parse(JSON.stringify(injected(t, o))), JSON.parse(JSON.stringify(splitReply(t, o))), JSON.stringify(t).slice(0, 60));
});

test('the literals inlined in splitReply equal the exported constants', () => {
  const body = splitReply.toString();
  assert.ok(body.includes(`'${BLOC_HTML_LABEL}'`) && body.includes(`'${BLOC_HTML_DEFAULT_TITLE}'`));
  assert.ok(body.includes('256 * 1024') && BLOC_HTML_MAX_SOURCE_BYTES === 256 * 1024);
  assert.doesNotMatch(body, /BLOC_HTML_|openingFence\(.*\) *=>|\bReplySegment\b.*module/);
});

test('CRLF text: a bloc fence is recognised exactly as with LF (review finding)', () => {
  const t = 'a\r\n```html-render title="T"\r\n<b>x</b>\r\n```\r\nb';
  const segs = rt(t);
  assert.deepEqual(kinds(segs), ['prose', 'bloc', 'prose']);
  assert.equal(segs[1].kind === 'bloc' && segs[1].title, 'T');
});
