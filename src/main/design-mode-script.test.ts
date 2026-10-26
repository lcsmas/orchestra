import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { DESIGN_MODE_SCRIPT, DESIGN_OVERLAY_ID, DESIGN_PICK_GLOBAL } from './design-mode-script.ts';

// The EXACT injected text, run against a minimal fake DOM (no browser). The
// real-browser proof is scripts/e2e-browser-design-source.mjs; this pins the
// clauses cheaply and lets each one be mutated in place (see `run(mutate)`).

type Fake = Record<string, any>;

function fakeDom(stack: (host: Fake) => Fake[]) {
  const listeners: Record<string, Array<(e: any) => void>> = {};
  const mk = (tag: string): Fake => {
    const el: Fake = {
      nodeType: 1, tagName: tag.toUpperCase(), id: '', attrs: {}, parentNode: null, parentElement: null, previousElementSibling: null,
      outerHTML: `<${tag}>`, children: [],
      style: { props: {} as Record<string, [string, string]>, cssText: '', setProperty(k: string, v: string, p: string) { this.props[k] = [v, p]; } },
      getAttribute(k: string) { return this.attrs[k] ?? null; },
      setAttribute(k: string, v: string) { this.attrs[k] = v; },
      appendChild(c: Fake) { c.parentNode = this; this.children.push(c); return c; },
      removeChild(c: Fake) { c.parentNode = null; this.children = this.children.filter((x: Fake) => x !== c); return c; },
      getBoundingClientRect() { return { left: 1, top: 2, width: 30, height: 20, right: 31, bottom: 22 }; },
      showPopover() { this.popoverShown = true; },
      attachShadow(init: { mode: string }) { this.shadowInit = init; this.shadow = mk('#shadow'); return this.shadow; },
    };
    return el;
  };
  const documentElement = mk('html');
  const document: Fake = {
    documentElement, title: 'T', createElement: mk,
    addEventListener(t: string, f: (e: any) => void) { (listeners[t] ??= []).push(f); },
    removeEventListener(t: string, f: (e: any) => void) { listeners[t] = (listeners[t] ?? []).filter((x) => x !== f); },
    elementsFromPoint: () => stack(created.host),
  };
  const created: { host: Fake } = { host: undefined as unknown as Fake };
  const origAppend = documentElement.appendChild.bind(documentElement);
  documentElement.appendChild = (c: Fake) => { created.host = c; return origAppend(c); };
  const window: Fake = { innerWidth: 800, innerHeight: 600 };
  const ctx = vm.createContext({ document, window, location: { href: 'http://fixture/' }, getComputedStyle: () => ({ length: 0, getPropertyValue: () => '' }) });
  return { ctx, document, window, documentElement, created, fire: (t: string, e: any = {}) => (listeners[t] ?? []).slice().forEach((f) => f({ clientX: 5, clientY: 5, preventDefault() {}, stopPropagation() {}, ...e })), listeners };
}

function target(extra: Fake = {}): Fake {
  return { nodeType: 1, tagName: 'BUTTON', id: 'go', previousElementSibling: null, parentElement: null, outerHTML: '<button id="go">Go</button>', classList: { length: 0 },
    getAttribute: () => null, getBoundingClientRect: () => ({ left: 10, top: 20, width: 40, height: 16, right: 50, bottom: 36 }), ...extra };
}

/** Run the (optionally mutated) script; `find` must occur exactly once so a mutant can never be a silent no-op. */
function run(stackOf: (host: Fake) => Fake[], mutate?: [string, string]) {
  let script = DESIGN_MODE_SCRIPT;
  if (mutate) {
    assert.equal(script.split(mutate[0]).length - 1, 1, `mutant find-string must occur once: ${mutate[0]}`);
    script = script.replace(mutate[0], mutate[1]);
  }
  const dom = fakeDom(stackOf);
  assert.equal(vm.runInContext(script, dom.ctx), true);
  return dom;
}

test('the injected script parses and contains the injected React walker', () => {
  assert.doesNotThrow(() => new vm.Script(DESIGN_MODE_SCRIPT));
  assert.ok(DESIGN_MODE_SCRIPT.includes('__reactFiber$') && DESIGN_MODE_SCRIPT.includes('_debugSource'));
  assert.ok(!DESIGN_MODE_SCRIPT.includes('`'), 'no backticks — it is a template literal');
});

test('overlay: host id, CLOSED shadow root, every pinned declaration !important, appended to <html>, top layer', () => {
  const t = target();
  const d = run(() => [t]);
  const host = d.created.host;
  assert.equal(host.id, DESIGN_OVERLAY_ID);
  assert.equal(host.parentNode, d.documentElement);
  assert.equal(host.shadowInit.mode, 'closed');
  const props = host.style.props as Record<string, [string, string]>;
  for (const k of ['all', 'display', 'position', 'inset', 'z-index', 'pointer-events']) assert.equal(props[k]?.[1], 'important', k);
  assert.equal(props['z-index'][0], '2147483647');
  assert.equal(props['pointer-events'][0], 'none');
  assert.equal(host.attrs.popover, 'manual');
  assert.equal(host.popoverShown, true);
  assert.ok(host.shadow.children.length === 2, 'box + label live INSIDE the shadow root, not in the page DOM');
  assert.equal(host.children.length, 0);
});

test('picking: the overlay host is skipped even when the hit-test returns it first', () => {
  const t = target();
  const d = run((host) => [host, t]);
  d.fire('click');
  const pick = d.window[DESIGN_PICK_GLOBAL];
  assert.equal(pick.outerHTML, t.outerHTML, 'the page element is picked, never the overlay');
  assert.equal(d.created.host.parentNode, null, 'a pick tears the overlay down');
});

test('picking: React fiber on the target → component {name,file,line}; no fiber → null', () => {
  const owner = { type: Object.defineProperty(function () {}, 'name', { value: 'Counter' }) };
  const withFiber = target({ ['__reactFiber$q1']: { type: 'button', _debugSource: { fileName: '/app/src/Counter.jsx', lineNumber: 12, columnNumber: 7 }, _debugOwner: owner } });
  const a = run(() => [withFiber]); a.fire('click');
  assert.deepEqual(JSON.parse(JSON.stringify(a.window[DESIGN_PICK_GLOBAL].component)), { name: 'Counter', file: '/app/src/Counter.jsx', line: 12, column: 7, via: 'self' });
  const b = run(() => [target()]); b.fire('click');
  assert.equal(b.window[DESIGN_PICK_GLOBAL].component, null);
});

// Each mutant must turn exactly its clause red — proves the assertions above can FAIL.
test('MUTANT open shadow root → the closed-mode assertion would fail', () => {
  const d = run(() => [target()], ["mode: 'closed'", "mode: 'open'"]);
  assert.equal(d.created.host.shadowInit.mode, 'open');
});
test('MUTANT non-important host style → the !important assertion would fail', () => {
  const d = run(() => [target()], ["el.style.setProperty(d[0], d[1], 'important')", 'el.style.setProperty(d[0], d[1], "")']);
  assert.notEqual(d.created.host.style.props['display'][1], 'important');
});
test('MUTANT hit() no longer skips the host → the overlay IS picked', () => {
  const t = target();
  const d = run((host) => [host, t], ['if (all[i] !== host)', 'if (true)']);
  d.fire('click');
  assert.notEqual(d.window[DESIGN_PICK_GLOBAL].outerHTML, t.outerHTML);
});
test('MUTANT walker dropped from the pick → component is gone', () => {
  const t = target({ ['__reactFiber$q1']: { type: 'button', _debugSource: { fileName: '/a.jsx', lineNumber: 1 } } });
  const d = run(() => [t], ['component: reactSource(el)', 'component: null']);
  d.fire('click');
  assert.equal(d.window[DESIGN_PICK_GLOBAL].component, null);
});
