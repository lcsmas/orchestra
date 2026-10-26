// The in-page walker against REAL React 18.2 (the fixture page's own inlined UMD dev bytes) over a minimal fake DOM in a
// node vm — no browser. It pins what hand-built fiber graphs cannot: WHICH alternate React considers current after
// re-renders and after a component BAILS OUT (memo), the two shapes a page edited under HMR produces (reviewer F1/F1b, #403).
// Each must-FAIL arm swaps ONE clause of the walker text and has to read a wrong line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { reactSourceInPage } from './design-source.ts';

class El {
  nodeType = 1; tagName: string; nodeName: string; namespaceURI = 'http://www.w3.org/1999/xhtml';
  childNodes: any[] = []; parentNode: any = null; attrs: Record<string, string> = {}; style: any = {}; ownerDocument: any;
  constructor(tag: string, doc: any) { this.tagName = tag.toUpperCase(); this.nodeName = this.tagName; this.ownerDocument = doc; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling() { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) + 1] ?? null : null; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  appendChild(c: any) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  insertBefore(c: any, ref: any) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; const i = ref ? this.childNodes.indexOf(ref) : -1; if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c); return c; }
  removeChild(c: any) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
  removeAttribute(k: string) { delete this.attrs[k]; }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener() {}
  removeEventListener() {}
  set textContent(t: string) { this.childNodes = []; if (t !== '') { const tn: any = new Txt(String(t), this.ownerDocument); tn.parentNode = this; this.childNodes.push(tn); } }
  get textContent() { return this.childNodes.map((c) => c.textContent ?? c.nodeValue).join(''); }
}
class Txt {
  nodeType = 3; nodeName = '#text'; nodeValue: string; parentNode: any = null; ownerDocument: any;
  constructor(t: string, doc: any) { this.nodeValue = t; this.ownerDocument = doc; }
  get textContent() { return this.nodeValue; }
  get nextSibling() { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) + 1] ?? null : null; }
  get parentElement() { return this.parentNode; }
}

const PAGE = new URL('../../scripts/fixtures/browser-site/pages/design-react18.html', import.meta.url);
const SCRIPTS = [...fs.readFileSync(PAGE, 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

function boot() {
  const document: any = { nodeType: 9, nodeName: '#document', activeElement: null, addEventListener() {}, removeEventListener() {} };
  document.createElement = (t: string) => new El(t, document);
  document.createTextNode = (t: string) => new Txt(t, document);
  document.body = new El('body', document);
  document.documentElement = new El('html', document);
  const win: any = { document, addEventListener() {}, removeEventListener() {}, HTMLIFrameElement: class {}, event: undefined };
  const ctx: any = { window: win, document, navigator: { userAgent: 'node' }, console, setTimeout, clearTimeout, setImmediate, clearImmediate, queueMicrotask, performance, MessageChannel: undefined };
  ctx.self = ctx; ctx.globalThis = ctx; win.window = win;
  vm.createContext(ctx);
  vm.runInContext(SCRIPTS[0], ctx); // react.development.js
  vm.runInContext(SCRIPTS[1], ctx); // react-dom.development.js
  const container: any = new El('div', document);
  document.body.appendChild(container);
  return { ctx, React: ctx.React, ReactDOM: ctx.ReactDOM, container };
}

const WALKER = reactSourceInPage.toString();
// ONE clause per mutant, applied to the exact text injected into the page; find must occur exactly once.
const FRESH_START = 'var freshest = function';
const FRESH_END = 'fiber = freshest(fiber);';
function walkerText(mutant?: 'cached-fiber' | 'return-chain-rule'): string {
  if (!mutant) return `(${WALKER})`;
  const i = WALKER.indexOf(FRESH_START), j = WALKER.indexOf(FRESH_END);
  assert.ok(i > 0 && j > i && WALKER.indexOf(FRESH_START, i + 1) < 0, 'mutant anchor must occur exactly once');
  const body = mutant === 'cached-fiber'
    ? 'var freshest = function (f) { return f; };\n    '
    : // the pre-F1b rule: "the alternate whose .return chain ends at the HostRoot that is root.current"
      `var freshest = function (f) {
        if (!f || !f.alternate) return f;
        var inCur = function (x) { var r = x; for (var k = 0; r.return && k < 5000; k++) r = r.return; return !!r.stateNode && r.stateNode.current === r; };
        if (inCur(f)) return f;
        if (inCur(f.alternate)) return f.alternate;
        return f;
      };
    `;
  return `(${WALKER.slice(0, i)}${body}${WALKER.slice(j)})`;
}

type Kind = 'self' | 'owner';
/** Mount + an edit/bailout plan; returns the line each pick reported vs the truth. */
function run(kind: Kind, plan: string[], mutant?: 'cached-fiber' | 'return-chain-rule', memo = true) {
  const { ctx, React, ReactDOM, container } = boot();
  const root = ReactDOM.createRoot(container);
  const pick = vm.runInContext(walkerText(mutant), ctx);
  let line = 10, useLine = 40, tick = 0, d = 0;
  const Dyn = (props: any) => React.createElement('div', { id: 'w' },
    kind === 'self'
      ? React.createElement('button', { id: 'b', 'data-d': props.d, __source: { fileName: '/p/src/Dyn.jsx', lineNumber: line } }, 'x')
      : React.createElement('em', { id: 'b', 'data-d': props.d }, 'x')); // no JSX source of its own → the owner's use-site
  const Inner = memo ? React.memo(Dyn) : Dyn;
  const Wrapper = (props: any) => React.createElement('section', { 'data-t': props.t },
    React.createElement(Inner, { d: props.d, __source: { fileName: '/p/src/Wrapper.jsx', lineNumber: useLine } }));
  const App = (props: any) => React.createElement(Wrapper, { t: props.t, d: props.d });
  const render = () => ReactDOM.flushSync(() => root.render(React.createElement(App, { t: ++tick, d })));
  const node = () => container.childNodes[0].childNodes[0].childNodes[0]; // section > div > button|em
  const want = () => (kind === 'self' ? line : useLine);
  const steps: Array<{ op: string; got: any; want: number }> = [];
  const step = (op: string) => { const r = pick(node()); steps.push({ op, got: r ? r.line : null, want: want() }); return r; };
  render(); const first = step('mount');
  for (const op of plan) {
    if (op === 'E') { line += 2; useLine += 3; d++; render(); } else { render(); } // E = Dyn re-renders with a moved line; B = only an ancestor re-renders (memo bails out)
    step(op);
  }
  return { steps, wrong: steps.filter((s) => s.got !== s.want), first };
}

const EDITS_ONLY = ['E', 'E', 'E', 'E', 'E'];
const WITH_BAILOUT = ['E', 'B', 'E', 'B', 'B', 'E', 'E', 'B', 'E', 'B', 'B', 'B', 'E', 'B'];

test('real React 18.2 — the fixture UMD is a DEV build whose host fibers carry _debugSource (the control for everything below)', () => {
  const { ctx, React, ReactDOM, container } = boot();
  ReactDOM.createRoot(container);
  ReactDOM.flushSync(() => ReactDOM.createRoot(container).render(React.createElement('button', { id: 'x', __source: { fileName: '/p/a.jsx', lineNumber: 7 } }, 'x')));
  const el = container.childNodes[0];
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))!;
  assert.ok(key, 'DOM node carries a __reactFiber$ key');
  assert.equal(el[key]._debugSource.lineNumber, 7);
  assert.equal(vm.runInContext(walkerText(), ctx)(el).line, 7);
});

for (const kind of ['self', 'owner'] as const) {
  test(`real React 18.2 [${kind}] — repeated edit re-renders: every pick reports the CURRENT line`, () => {
    const { steps, wrong } = run(kind, EDITS_ONLY, undefined, false);
    assert.equal(wrong.length, 0, JSON.stringify(steps));
  });
  test(`real React 18.2 [${kind}] — edits interleaved with memo BAILOUTS: every pick reports the CURRENT line (F1b)`, () => {
    const { steps, wrong } = run(kind, WITH_BAILOUT);
    assert.equal(wrong.length, 0, JSON.stringify(steps));
  });
}

test('real React 18.2 — the owner path names the component that supplied the use-site, not the host', () => {
  const { first } = run('owner', []);
  assert.equal(first.via, 'owner');
  assert.equal(first.file, '/p/src/Wrapper.jsx');
  assert.equal(first.name, 'Dyn');
});

// must-FAIL arms: the same plans with ONE clause of the walker swapped
test('MUTANT cached first-mount fiber → the edit-only plan reads a STALE line (F1)', () => {
  const { wrong } = run('self', EDITS_ONLY, 'cached-fiber', false);
  assert.ok(wrong.length >= 2, `expected stale reads, got ${wrong.length}`);
});
test('MUTANT ".return chain ends at root.current" (pre-F1b rule) → fine on edits only, WRONG once a memo bails out (F1b)', () => {
  const plain = run('self', EDITS_ONLY, 'return-chain-rule', false);
  assert.equal(plain.wrong.length, 0, 'the old rule passes the plan the rig arm exercises: ' + JSON.stringify(plain.steps));
  // measured: the owner path happens to survive the old rule (the owner fiber sits on a re-rendered branch); the HOST path does not
  const bail = run('self', WITH_BAILOUT, 'return-chain-rule');
  assert.ok(bail.wrong.length >= 1, `expected the old rule to misread after a bailout: ${JSON.stringify(bail.steps)}`);
});
