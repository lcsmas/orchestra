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

const directive = (name: string) => (BLOC_HTML_POLICY.split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' ')) ?? '').split(/\s+/).slice(1);

test('policy v2: inline script/style + https: (script, style, img, font, fetch/XHR, wss:) + data:/blob:; plain http: and frames, forms, base refused', () => {
  assert.deepEqual(directive('default-src'), ["'none'"]);
  assert.deepEqual(directive('script-src'), ["'unsafe-inline'", 'https:', 'blob:']);
  assert.deepEqual(directive('style-src'), ["'unsafe-inline'", 'https:']);
  assert.deepEqual(directive('img-src'), ['https:', 'data:', 'blob:']);
  assert.deepEqual(directive('font-src'), ['https:', 'data:']);
  assert.deepEqual(directive('connect-src'), ['https:', 'wss:', 'data:', 'blob:']);
  assert.deepEqual(directive('base-uri'), ["'none'"]);
  assert.deepEqual(directive('form-action'), ["'none'"]);
  assert.doesNotMatch(BLOC_HTML_POLICY, /(^|[\s;])(http:|ws:|\*)/, 'no plain http:/ws: and no wildcard anywhere');
  assert.doesNotMatch(BLOC_HTML_POLICY, /frame-src|child-src|'unsafe-eval'|worker-src|object-src/, 'no frames / eval / objects (default-src none); a blob: worker runs under script-src, same policy (worker-src falls back to it)');
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

test('#416 navigation shim: opt-in, after the policy and the reporter, in <head>; absent by default (the phone page does not ask for it)', async () => {
  const { BLOC_NAVIGATION_SHIM } = await import('./bloc-html-document.ts');
  assert.ok(!doc('<p>x</p>').includes('window.open'), 'default document has no shim');
  const d = buildBlocDocument({ source: '<p>x</p>', tokens: TOKENS, navigationShim: true });
  assert.ok(d.includes(BLOC_NAVIGATION_SHIM) && d.indexOf('Content-Security-Policy') < d.indexOf('window.open') && d.indexOf('window.open') < d.indexOf('<body>'));
  assert.match(BLOC_NAVIGATION_SHIM, /a\[href\]/);
  assert.match(BLOC_NAVIGATION_SHIM, /location\.href=a\.href/);
  assert.match(BLOC_NAVIGATION_SHIM, /window\.open=function/);
});

test('#416 navigation shim behaviour (vm): a _blank link click and window.open(url) navigate the frame; _self, #anchor and a bare link do not', async () => {
  const vm = await import('node:vm');
  const { BLOC_NAVIGATION_SHIM } = await import('./bloc-html-document.ts');
  const src = BLOC_NAVIGATION_SHIM.replace(/^<script>/, '').replace(/<\/script>$/, '');
  const run = (a: { target?: string; href: string } | null) => {
    let handler: ((e: unknown) => void) | undefined; const nav: string[] = []; let prevented = false;
    const location = { set href(v: string) { nav.push(v); }, get href() { return ''; } };
    const window: Record<string, unknown> = {};
    const document = { addEventListener: (_t: string, h: (e: unknown) => void) => { handler = h; } };
    vm.runInNewContext(src, { document, location, window, String });
    const link = a && { target: a.target ?? '', href: a.href, getAttribute: () => a.href };
    handler!({ target: { closest: () => link }, preventDefault: () => { prevented = true; } });
    return { nav, prevented, window };
  };
  assert.deepEqual(run({ target: '_blank', href: 'https://x.example/a' }).nav, ['https://x.example/a']);
  assert.ok(run({ target: '_top', href: 'https://x.example/a' }).prevented);
  assert.deepEqual(run({ target: '_self', href: 'https://x.example/a' }).nav, []);
  assert.deepEqual(run({ href: 'https://x.example/a' }).nav, [], 'a plain link navigates natively (guard sees it)');
  assert.deepEqual(run({ target: '_blank', href: '#top' }).nav, []);
  const r = run(null); const wo = r.window.open as (u?: unknown) => unknown;
  assert.equal(typeof wo, 'function');
  assert.equal(wo('https://y.example/w'), null); assert.deepEqual(r.nav, ['https://y.example/w'], 'window.open(url) navigates the frame');
  assert.equal(wo(), null); assert.equal(r.nav.length, 1, 'window.open() with no url does nothing');
});
