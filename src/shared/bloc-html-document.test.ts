import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBlocDocument, BLOC_HTML_POLICY, BLOC_THEME_KEYS, safeCssValue } from './bloc-html-document.ts';

const TOKENS = { fg: '#eee', muted: '#999', surface: '#111', border: '#333', accent: '#6ea8ff', ok: '#5bd68b', warn: '#ffc857', err: '#ff6b6b', fontSize: '13px', fontFamily: 'Inter, sans-serif' };
const doc = (source: string, tokens = TOKENS) => buildBlocDocument({ source, tokens });

test('the policy <meta> is the FIRST thing in <head>', () => {
  const d = doc('<p>x</p>');
  assert.ok(d.includes('<head><meta http-equiv="Content-Security-Policy" content="'), d.slice(0, 200));
  assert.ok(d.indexOf('Content-Security-Policy') < d.indexOf('<style>'));
  assert.ok(d.indexOf('Content-Security-Policy') < d.indexOf('<script>'));
});

test('order: policy, then theme variables, then the model HTML', () => {
  const d = doc('<p id="model">x</p>');
  const policy = d.indexOf('Content-Security-Policy'), theme = d.indexOf('--bloc-fg'), model = d.indexOf('id="model"');
  assert.ok(policy >= 0 && policy < theme && theme < model);
});

test('the policy allows nothing but inline script/style and data: images; no network, frames, forms, base', () => {
  assert.match(BLOC_HTML_POLICY, /default-src 'none'/);
  assert.match(BLOC_HTML_POLICY, /script-src 'unsafe-inline'/);
  assert.match(BLOC_HTML_POLICY, /style-src 'unsafe-inline'/);
  assert.match(BLOC_HTML_POLICY, /img-src data:/);
  assert.match(BLOC_HTML_POLICY, /form-action 'none'/);
  assert.match(BLOC_HTML_POLICY, /base-uri 'none'/);
  assert.doesNotMatch(BLOC_HTML_POLICY, /connect-src|https?:|\*/);
});

test('NO color-scheme anywhere in the document (it paints the frame opaque)', () => {
  assert.doesNotMatch(doc('<p>x</p>'), /color-scheme/);
  assert.doesNotMatch(doc('<p>x</p>', {} as never), /color-scheme/);
});

test('every theme variable is emitted, transparent background, the app font size', () => {
  const d = doc('');
  for (const k of BLOC_THEME_KEYS) assert.ok(d.includes(`--bloc-${k}:`), k);
  assert.match(d, /--bloc-accent:#6ea8ff;/);
  assert.match(d, /background:transparent/);
  assert.match(d, /font:13px\/1\.55 Inter, sans-serif/);
});

test('a token value that could leave its declaration is replaced by the fallback', () => {
  const d = doc('', { ...TOKENS, fg: 'red;}</style><script>alert(1)</script>', accent: 'url(x){' });
  assert.doesNotMatch(d, /alert\(1\)/);
  assert.match(d, /--bloc-fg:inherit;/);
  assert.equal(safeCssValue('  #fff ', 'x'), '#fff');
  assert.equal(safeCssValue('', 'x'), 'x');
  assert.equal(safeCssValue('a'.repeat(300), 'x'), 'x');
});

test('the model HTML is placed verbatim in <body>; the height reporter lives in <head> (a stray comment/script in the source cannot swallow it)', () => {
  const src = '<!-- unclosed <script>/*';
  const d = doc(src);
  assert.ok(d.includes(`<body>${src}</body>`));
  assert.ok(d.indexOf('ResizeObserver') < d.indexOf('<body>'));
  assert.match(d, /parent\.postMessage\(\{__blocHtml:1,h:/);
});
