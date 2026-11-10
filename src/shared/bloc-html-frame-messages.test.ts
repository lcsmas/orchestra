// #417 — the frame's three messages (height / Escape / pointer), executed against a fake frame: the document's script, not its text, is pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildBlocDocument, BLOC_ESCAPE_FIELD, BLOC_HEIGHT_TAG, BLOC_HOVER_FIELD } from './bloc-html-document.ts';

/** Run the reporter `<script>` of a built document against a minimal frame and return what it posted + the listeners it registered. */
function runReporter() {
  const html = buildBlocDocument({ source: '<p>x</p>', tokens: {} });
  const js = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
  const posted: unknown[] = []; // JSON-normalised below: vm objects carry another realm's prototypes
  const winL: Record<string, Array<(e: unknown) => void>> = {}, rootL: Record<string, Array<() => void>> = {};
  const root = { getBoundingClientRect: () => ({ height: 123.2 }), addEventListener: (t: string, f: () => void) => { (rootL[t] ??= []).push(f); } };
  const sandbox = {
    document: { documentElement: root }, parent: { postMessage: (m: unknown) => posted.push(JSON.parse(JSON.stringify(m))) },
    ResizeObserver: class { observe() {} }, addEventListener: (t: string, f: (e: unknown) => void) => { (winL[t] ??= []).push(f); },
  };
  vm.runInNewContext(js, sandbox);
  return { posted, winL, rootL };
}

test('the frame reports its height, an Escape press and the pointer entering/leaving — each tagged', () => {
  const { posted, winL, rootL } = runReporter();
  assert.deepEqual(posted, [{ [BLOC_HEIGHT_TAG]: 1, h: 124 }], 'height at once');
  winL.keydown.forEach((f) => f({ key: 'a' }));
  assert.equal(posted.length, 1, 'another key is not reported');
  winL.keydown.forEach((f) => f({ key: 'Escape' }));
  assert.deepEqual(posted[1], { [BLOC_HEIGHT_TAG]: 1, [BLOC_ESCAPE_FIELD]: 1 });
  rootL.mouseenter.forEach((f) => f());
  rootL.mouseleave.forEach((f) => f());
  assert.deepEqual(posted.slice(2), [{ [BLOC_HEIGHT_TAG]: 1, [BLOC_HOVER_FIELD]: 1 }, { [BLOC_HEIGHT_TAG]: 1, [BLOC_HOVER_FIELD]: 0 }]);
});

test('the Escape listener is a CAPTURE listener on the window (a bloc handler cannot starve it)', () => {
  const html = buildBlocDocument({ source: '', tokens: {} });
  assert.match(html, /addEventListener\('keydown',function\(e\)\{if\(e\.key==='Escape'\)parent\.postMessage\([^)]*\)\},true\)/);
});
