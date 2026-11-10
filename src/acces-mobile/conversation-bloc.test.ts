// #421 — the phone page renders a bloc HTML: the REAL CONVERSATION_JS in a vm against a fake DOM that COUNTS what a browser would reload
// (an iframe removed from the tree is a reloaded iframe). Every must-FAIL arm sits beside a passing control.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { CONVERSATION_JS } from './conversation.ts';
import { splitReply } from '../shared/reply-segments.ts';
import { BLOC_MAX_HEIGHT_PX } from '../shared/bloc-html-document.ts';

class El {
  tag: string;
  className = '';
  children: El[] = [];
  parent: El | null = null;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  hidden = false;
  disabled = false;
  value = '';
  type = '';
  own = '';
  on: Record<string, ((e: unknown) => void)[]> = {};
  contentWindow: object | undefined;
  loads = 0; // src assignments = navigations
  detaches = 0; // times this node (or an ancestor) was taken out of the tree — a browser reloads an iframe each time
  private _src = '';
  blocRec: unknown;
  constructor(tag = 'div') {
    this.tag = tag;
    if (tag === 'iframe') this.contentWindow = {};
  }
  get src(): string { return this._src; }
  set src(v: string) { this._src = v; this.loads++; }
  get textContent(): string { return this.own + this.children.map((c) => c.textContent).join(''); }
  set textContent(v: string) {
    for (const c of this.children) { c.parent = null; c.markDetached(); }
    this.children = [];
    this.own = String(v);
  }
  markDetached(): void { this.detaches++; this.children.forEach((c) => c.markDetached()); }
  get firstChild(): El | null { return this.children[0] ?? null; }
  get nextSibling(): El | null { const p = this.parent; return p ? p.children[p.children.indexOf(this) + 1] ?? null : null; }
  private take(c: El): El[] {
    if (c.tag === '#frag') { const k = [...c.children]; c.children = []; k.forEach((x) => (x.parent = null)); return k; }
    if (c.parent) c.parent.removeChild(c);
    return [c];
  }
  appendChild(c: El): El { for (const k of this.take(c)) { k.parent = this; this.children.push(k); } return c; }
  insertBefore(c: El, ref: El | null): El {
    const ks = this.take(c);
    const i = ref ? this.children.indexOf(ref) : -1;
    for (const k of ks) { k.parent = this; if (i < 0) this.children.push(k); else this.children.splice(this.children.indexOf(ref!), 0, k); }
    return c;
  }
  removeChild(c: El): El {
    const i = this.children.indexOf(c);
    if (i >= 0) { this.children.splice(i, 1); c.parent = null; c.markDetached(); }
    return c;
  }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  addEventListener(t: string, h: (e: unknown) => void): void { (this.on[t] ??= []).push(h); }
  dispatchEvent(e: { type: string }): void { (this.on[e.type] ?? []).forEach((h) => h(e)); }
  click(): void { if (!this.disabled) this.dispatchEvent({ type: 'click' }); }
  focus(): void {}
  has(c: string): boolean { return this.className.split(/\s+/).includes(c); }
  all(pred: (e: El) => boolean, out: El[] = []): El[] { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
  querySelector(sel: string): El | null { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel: string): El[] { const cls = sel.startsWith('.') ? sel.slice(1) : null; return this.all((e) => (cls ? e.has(cls) : e.tag === sel)); }
  get scrollHeight(): number { return 100; }
}

const TOKEN = 't'.repeat(43);
const PATH = (n: number): string => '/bloc/' + String(n).padStart(32, 'x');
const SRC = '<div id="c">chart</div><script>document.getElementById("c").textContent="ran"</script>';
const FENCE = (title: string, src = SRC): string => '```html-render title="' + title + '"\n' + src + '\n```\n';
type Line = Record<string, unknown>;
const conv = (lines: Line[], v = 1, extra: Record<string, unknown> = {}) => ({ ok: true, id: 'w1', version: v, running: false, truncated: 0, lines, asks: [], ...extra });
const A = (id: string, text: string, streaming = false): Line => ({ id, kind: 'assistant', text, streaming });

interface Mint { body: { source: string }; headers: Record<string, string>; answer: (status: number, body: unknown) => void; fail: () => void }

function run(first: ReturnType<typeof conv>, opts: { io?: boolean; script?: (s: string) => string } = {}) {
  const root = new El();
  const mints: Mint[] = [];
  const made = { n: 0 }; // iframes ever created
  const other: string[] = [];
  const msgHandlers: ((e: unknown) => void)[] = [];
  const timers: { fn: () => void; ms: number; done: boolean }[] = [];
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let projection = first;
  const observed = new Set<El>();
  const ioFire: ((es: unknown[]) => void)[] = [];
  const doc = { hidden: false };
  const scroller = { scrollTop: 0, scrollHeight: 100, clientHeight: 100 };
  const sandbox: Record<string, unknown> = {
    window: { addEventListener: (t: string, h: (e: unknown) => void) => t === 'message' && msgHandlers.push(h) } as Record<string, unknown>,
    document: {
      getElementById: (n: string) => (n === 'conv' ? root : new El()),
      createElement: (t: string) => { if (t === 'iframe') made.n++; return new El(t); },
      createTextNode: (t: string) => { const e = new El('#text'); e.textContent = t; return e; },
      createDocumentFragment: () => new El('#frag'),
      addEventListener() {},
      scrollingElement: scroller,
      get hidden() { return doc.hidden; },
    },
    localStorage: { getItem: () => TOKEN, setItem() {} },
    location: { hash: '#w=w1' },
    Event: class { type: string; constructor(t: string) { this.type = t; } },
    setTimeout: (fn: () => void, ms = 0) => { if (ms >= 5000) { timers.push({ fn, ms, done: false }); return timers.length; } setImmediate(fn); return 0; },
    clearTimeout: (id: number) => { if (timers[id - 1]) timers[id - 1].done = true; },
    setInterval: () => 0,
    clearInterval() {},
    AbortController, TextDecoder, TextEncoder, Date, Math, Set, Object, JSON, Number, isFinite, Promise,
    fetch: (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
      if (url === '/api/stream') {
        return Promise.resolve({ ok: true, status: 200, body: { getReader: () => ({ read: () => new Promise((res) => { const go = () => (queue.length ? res({ done: false, value: new TextEncoder().encode(queue.shift()!) }) : (wake = go)); go(); }) }) } });
      }
      if (url.startsWith('/api/conversation')) return Promise.resolve({ ok: true, status: 200, json: async () => projection });
      if (url.startsWith('/api/seen')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      if (url === '/api/bloc') {
        return new Promise((res, rej) => mints.push({ body: JSON.parse(init.body ?? '{}'), headers: init.headers ?? {}, answer: (status, body) => res({ ok: status >= 200 && status < 300, status, json: async () => body }), fail: () => rej(new TypeError('Load failed')) }));
      }
      other.push(url);
      return new Promise(() => {});
    },
  };
  if (opts.io) {
    sandbox.IntersectionObserver = class {
      constructor(cb: (es: unknown[]) => void) { ioFire.push(cb); }
      observe(e: El) { observed.add(e); }
      unobserve(e: El) { observed.delete(e); }
    };
  }
  vm.runInNewContext(opts.script ? opts.script(CONVERSATION_JS) : CONVERSATION_JS, sandbox);
  const api = (sandbox.window as { OrchestraConversation: { open(id: string, row: unknown, n: number, below?: number): void; connect(): void; close(): void } }).OrchestraConversation;
  api.open('w1', { name: 'w1' }, 0, 0);
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  const q = (cls: string) => root.querySelector('.' + cls);
  const qa = (cls: string) => root.querySelectorAll('.' + cls);
  const frames = () => root.querySelectorAll('iframe');
  return {
    root, mints, other, settle, made, setHidden: (v: boolean) => (doc.hidden = v), q, qa, frames, api, timers, observed,
    setProjection: (c: ReturnType<typeof conv>) => (projection = c),
    /** a stream announcement of version v (what main sends when the fold changed) */
    announce: async (v: number) => { queue.push(`data: {"t":"conv","id":"w1","v":${v}}\n\n`); wake?.(); wake = null; await settle(); },
    startStream: () => api.connect(),
    /** the frame posts a message to its parent: `source` = the window it came from */
    post: (data: unknown, source: unknown) => msgHandlers.forEach((h) => h({ data, source })),
    intersect: (e: El) => ioFire.forEach((cb) => cb([{ isIntersecting: true, target: e }])),
    scroller,
  };
}

/** A page with one reply [prose, bloc, prose], the bloc's id minted and its frame mounted. */
async function withFrame(extra: Parameters<typeof run>[1] = {}) {
  const p = run(conv([A('a1', 'avant\n\n' + FENCE('Courbe') + '\naprès')]), extra);
  await p.settle();
  p.mints[0].answer(200, { ok: true, id: 'x', path: PATH(1), ttlMs: 1 });
  await p.settle();
  return p;
}

test('control: prose · bloc · prose — the bloc takes its place between the sentences, one id minted for its source with the token, framed sandboxed from /bloc/<id>', async () => {
  const p = run(conv([A('a1', 'avant\n\n' + FENCE('Courbe') + '\naprès')]));
  await p.settle();
  const row = p.q('assistant')!;
  assert.deepEqual(row.children.map((c) => (c.has('bloc') ? 'bloc' : c.tag)), ['p', 'bloc', 'p'], 'in the order the model wrote it');
  assert.equal(p.mints.length, 1, 'one id asked');
  assert.equal(p.mints[0].body.source, SRC, 'for the bloc\'s source — the fence lines are not part of it');
  assert.equal(p.mints[0].headers.Authorization, `Bearer ${TOKEN}`, 'on the authenticated API');
  assert.equal(p.frames().length, 0, 'no frame before the id arrives');
  assert.equal(p.q('bloc')!.textContent, 'Courbe', 'the placeholder carries the title');
  p.mints[0].answer(200, { ok: true, id: 'x', path: PATH(1), ttlMs: 300000 });
  await p.settle();
  const [f] = p.frames();
  assert.equal(f.src, PATH(1));
  assert.equal(f.attrs.sandbox, 'allow-scripts', 'scripts, and NOTHING else: no allow-same-origin, no top navigation, no popups');
  assert.equal(f.attrs.title, 'Courbe', 'announced by its title');
  assert.equal(f.attrs.referrerpolicy, 'no-referrer');
  assert.equal(p.q('bloc')!.dataset.state, 'frame');
});

test('height: taken ONLY from the frame this page created, clamped (control: its own report is applied)', async () => {
  const p = await withFrame();
  const [f] = p.frames();
  p.post({ __blocHtml: 1, h: 999 }, {}); // another window
  p.post({ __blocHtml: 1, h: 999 }, undefined);
  assert.equal(f.style.height, undefined, 'a stranger sets nothing');
  p.post({ __blocHtml: 1, h: 240 }, f.contentWindow);
  assert.equal(f.style.height, '240px', 'control: its own report');
  assert.equal(p.q('bloc')!.dataset.state, 'ready');
  assert.equal(p.q('bloc-t'), null, 'the placeholder is gone once it renders');
  for (const bad of [{ other: 1, h: 5 }, { __blocHtml: 1, h: '9' }, { __blocHtml: 1, h: NaN }, { __blocHtml: 1, h: Infinity }, '__blocHtml', null, { __blocHtml: 2, h: 5 }]) p.post(bad, f.contentWindow);
  assert.equal(f.style.height, '240px', 'a malformed report changes nothing');
  p.post({ __blocHtml: 1, h: 1e9 }, f.contentWindow);
  assert.equal(f.style.height, BLOC_MAX_HEIGHT_PX + 'px', 'clamped above');
  p.post({ __blocHtml: 1, h: -50 }, f.contentWindow);
  assert.equal(f.style.height, '24px', 'clamped below');
});

test('a re-render (new text, a stream announcement, a rewind panel) never reloads a mounted frame — and the same arm FAILS when the rows are rebuilt', async () => {
  const drive = async (script?: (s: string) => string) => {
    const lines = (tail: string, v: number) => conv([{ id: 'u1', kind: 'user', text: 'go', rewindId: 'r1' }, A('a1', 'avant\n\n' + FENCE('Courbe') + '\naprès' + tail, true)], v);
    const p = run(lines('', 1), { script });
    p.startStream();
    await p.settle();
    p.mints[0].answer(200, { ok: true, id: 'x', path: PATH(1) });
    await p.settle();
    const [f] = p.frames();
    p.post({ __blocHtml: 1, h: 200 }, f.contentWindow);
    for (let v = 2; v <= 4; v++) { p.setProjection(lines(' encore '.repeat(v), v)); await p.announce(v); }
    p.q('msg-rw')!.click(); // a re-render with no refetch
    await p.settle();
    return { p, f };
  };
  const fixed = await drive();
  assert.equal(fixed.p.frames().length, 1);
  assert.equal(fixed.p.frames()[0], fixed.f, 'the very same element');
  assert.equal(fixed.f.detaches, 0, 'never taken out of the tree');
  assert.equal(fixed.f.loads, 1, 'navigated once');
  assert.equal(fixed.p.mints.length, 1, 'no second id');
  assert.ok(fixed.p.q('assistant')!.textContent.includes('encore'), 'control: the prose around it DID update');
  assert.equal(fixed.f.style.height, '200px', 'and it kept its height');
  // the unfixed arm: the list rebuilt wholesale on every render
  const mutate = (s: string) => {
    const m = s.replace('if (Object.keys(blocRowUsed).length) reconcile(list, out);', 'if (false) reconcile(list, out);');
    assert.notEqual(m, s, 'the mutant string is live in the script');
    return m;
  };
  const unfixed = await drive(mutate);
  assert.ok(unfixed.f.detaches >= 1, 'the instrument can say FAIL: a wholesale rebuild takes the frame out of the tree (a browser reloads it)');
});

test('a bloc still being written is a placeholder with its title, no id asked; it renders when the fence closes; a reply that ENDED unclosed is code', async () => {
  const open = '```html-render title="Tableau"\n<p>half';
  const p = run(conv([A('a1', 'voici\n' + open, true)]));
  p.startStream();
  await p.settle();
  assert.equal(p.q('bloc')!.dataset.state, 'pending');
  assert.equal(p.q('bloc')!.textContent, 'Tableau');
  assert.equal(p.mints.length, 0, 'nothing minted for half a bloc');
  assert.equal(p.frames().length, 0);
  p.setProjection(conv([A('a1', 'voici\n' + FENCE('Tableau', '<p>whole</p>'), true)], 2));
  await p.announce(2);
  assert.equal(p.mints.length, 1, 'closed ⇒ ONE id');
  assert.equal(p.mints[0].body.source, '<p>whole</p>');
  const q = run(conv([A('a1', 'voici\n' + open, false)])); // the reply is finished: no fence will ever close
  await q.settle();
  assert.equal(q.mints.length, 0);
  assert.equal(q.q('bloc')!.dataset.state, 'code', 'a finished reply with an open fence keeps its content, as code');
  assert.ok(q.q('bloc')!.textContent.includes('<p>half'));
});

test('setting off (blocHtml:false from main): every bloc is a code block, nothing minted, nothing framed (control: the same reply with the setting on / absent mints)', async () => {
  const lines = [A('a1', 'avant\n\n' + FENCE('Courbe') + '\naprès')];
  for (const extra of [{}, { blocHtml: true }]) {
    const on = run(conv(lines, 1, extra));
    await on.settle();
    assert.equal(on.mints.length, 1, `control ${JSON.stringify(extra)}`);
  }
  const off = run(conv(lines, 1, { blocHtml: false }));
  await off.settle();
  assert.equal(off.mints.length, 0);
  assert.equal(off.frames().length, 0);
  const code = off.q('bloc-code')!;
  assert.ok(code, 'a code block stands in');
  assert.ok(code.querySelector('pre'), 'drawn as code');
  assert.ok(code.textContent.includes('document.getElementById("c")'), 'the source is all there');
  assert.equal(off.q('assistant')!.textContent.includes('avant') && off.q('assistant')!.textContent.includes('après'), true);
  // flipped while a frame is mounted: the next projection says off ⇒ the frame goes
  const live = await withFrame();
  assert.equal(live.frames().length, 1);
  live.setProjection(conv(lines, 2, { blocHtml: false }));
  live.startStream();
  await live.announce(2);
  assert.equal(live.frames().length, 0, 'off ⇒ no model HTML left running on the page');
  assert.ok(live.q('bloc-code'));
});

test('only an agent reply holds a bloc: ` ```html ` stays code, a bloc quoted in a longer fence stays code, user / notice lines are text (control: html-render renders)', async () => {
  const p = run(
    conv([
      { id: 'u1', kind: 'user', text: FENCE('Mine') },
      A('a1', '```html\n<b>sample</b>\n```\n'),
      A('a2', '````md\n' + FENCE('Quoted') + '````\n'),
      { id: 'n1', kind: 'notice', text: FENCE('Notice'), error: false },
      A('a3', FENCE('Real')),
    ]),
  );
  await p.settle();
  assert.equal(p.mints.length, 1, 'ONE bloc on the page');
  assert.equal(p.mints[0].body.source, SRC);
  assert.equal(p.qa('bloc').length, 1);
  assert.equal(p.q('bloc')!.textContent, 'Real');
  assert.equal(p.q('user')!.textContent, FENCE('Mine'), 'the human\'s own message is text, byte for byte');
  assert.equal(p.q('notice')!.textContent, FENCE('Notice'));
  assert.ok(p.root.querySelectorAll('pre').some((x) => x.textContent === '<b>sample</b>'), 'the html sample is a code block');
});

test('a failure is a code block, never a loss: refused / failed mint, a path that is not OUR route, a frame that never reports (control: a good id frames)', async () => {
  const scenario = async (react: (p: Awaited<ReturnType<typeof withFrame>> | ReturnType<typeof run>) => Promise<void> | void) => {
    const p = run(conv([A('a1', FENCE('Courbe'))]));
    await p.settle();
    await react(p);
    await p.settle();
    return p;
  };
  const ok = await scenario((p) => p.mints[0].answer(200, { ok: true, id: 'x', path: PATH(1) }));
  assert.equal(ok.frames().length, 1, 'control');
  const refused = await scenario((p) => p.mints[0].answer(200, { ok: false }));
  assert.equal(refused.frames().length, 0);
  assert.equal(refused.q('bloc')!.dataset.state, 'code');
  for (const status of [401, 429, 502]) {
    const p = await scenario((x) => x.mints[0].answer(status, {}));
    assert.equal(p.q('bloc')!.dataset.state, 'code', `HTTP ${status}`);
  }
  const lost = await scenario((p) => p.mints[0].fail());
  assert.equal(lost.q('bloc')!.dataset.state, 'code', 'network lost');
  for (const path of ['https://evil.example/x', '//evil.example/x', '/api/workspaces', '/bloc/../api/workspaces', '/bloc/short', PATH(1) + '/x', 'javascript:alert(1)', 42]) {
    const p = await scenario((x) => x.mints[0].answer(200, { ok: true, id: 'x', path }));
    assert.equal(p.frames().length, 0, `never framed: ${String(path)}`);
    assert.equal(p.q('bloc')!.dataset.state, 'code');
  }
  const silent = await scenario((p) => p.mints[0].answer(200, { ok: true, id: 'x', path: PATH(1) }));
  assert.equal(silent.q('bloc')!.dataset.state, 'frame', 'control: waiting for the first height');
  const t = silent.timers.find((x) => !x.done)!;
  assert.ok(t, 'a report deadline is armed');
  t.fn();
  assert.equal(silent.q('bloc')!.dataset.state, 'code', 'no report in time ⇒ code (a refused route draws an empty frame the page cannot see)');
  assert.equal(silent.frames().length, 0);
  const reported = await withFrame();
  reported.post({ __blocHtml: 1, h: 100 }, reported.frames()[0].contentWindow);
  assert.ok(reported.timers.every((x) => x.done), 'a report disarms the deadline');
});

test('the id is asked when the bloc nears the screen, not before (control: without IntersectionObserver it is asked at once)', async () => {
  const p = run(conv([A('a1', FENCE('Courbe')), A('a2', FENCE('Autre', '<p>2</p>'))]), { io: true });
  await p.settle();
  assert.equal(p.mints.length, 0, 'nothing minted while off-screen');
  assert.equal(p.observed.size, 2);
  const [h1] = [...p.observed];
  p.intersect(h1);
  await p.settle();
  assert.equal(p.mints.length, 1);
  assert.equal(p.observed.size, 1, 'observed once, then released');
  assert.equal(run(conv([A('a1', FENCE('Courbe'))])).mints.length, 0, 'sanity: a fresh page asks only after its first fetch');
});

test('leaving the conversation drops every frame and id; the old conversation\'s late id never frames into the next (control: before leaving it framed)', async () => {
  const p = run(conv([A('a1', FENCE('Courbe'))]));
  await p.settle();
  p.api.close();
  p.mints[0].answer(200, { ok: true, id: 'x', path: PATH(1) });
  await p.settle();
  assert.equal(p.frames().length, 0, 'a late answer frames nothing');
  assert.equal(p.made.n, 0, 'not even an iframe is created for a conversation that was left');
  const live = await withFrame();
  assert.equal(live.frames().length, 1, 'control');
  live.api.close();
  assert.equal(live.frames().length, 0);
});

test('a bloc near the bottom keeps the reader at the bottom as it grows; one far above does not drag them', async () => {
  const p = await withFrame();
  p.scroller.scrollHeight = 5000; p.scroller.scrollTop = 4900; p.scroller.clientHeight = 100; // near the end
  p.post({ __blocHtml: 1, h: 300 }, p.frames()[0].contentWindow);
  assert.equal(p.scroller.scrollTop, 5000, 'followed to the bottom');
  const q = await withFrame();
  q.scroller.scrollHeight = 5000; q.scroller.scrollTop = 100; q.scroller.clientHeight = 100; // reading far above
  q.post({ __blocHtml: 1, h: 300 }, q.frames()[0].contentWindow);
  assert.equal(q.scroller.scrollTop, 100, 'left where they were');
});

test('FI-1 is injected as ONE self-contained function: the copy the page runs agrees with the module on every fixture (goes red if it stops being self-contained)', () => {
  const copy = vm.runInNewContext(`(${splitReply.toString()})`, { TextEncoder }) as typeof splitReply; // no module scope, no helpers
  const fixtures = [
    '', 'plain', FENCE('T'), 'a\n' + FENCE('T') + 'b', '```html-render\n<p>open', '```html\n<p>x</p>\n```\n', '````md\n' + FENCE('Q') + '````\n',
    FENCE('One') + FENCE('Two', '<i>2</i>'), '```html-render title=""\n<p>x</p>\n```', '~~~html-render title="Tilde"\n<p>t</p>\n~~~\n', 'x'.repeat(300_000),
    '```html-render title="Big"\n' + 'y'.repeat(300_000) + '\n```\n',
  ];
  for (const f of fixtures) assert.equal(JSON.stringify(copy(f)), JSON.stringify(splitReply(f)), JSON.stringify(f.slice(0, 40))); // JSON: arrays of another realm
  const r = splitReply('a\n' + FENCE('T') + 'b');
  assert.equal(r.map((s) => (s.kind === 'prose' ? s.text : s.raw)).join(''), 'a\n' + FENCE('T') + 'b', 'control: the round trip holds');
});

test('opening another conversation over a mounted one drops its frames and ids (no close() between), and a late id frames nothing (control: the same page framed before)', async () => {
  const p = run(conv([A('a1', FENCE('Courbe'))]));
  await p.settle();
  p.api.open('w2', { name: 'w2' }, 0, 0); // the router's #w=A → #w=B: open() without close()
  p.mints[0].answer(200, { ok: true, id: 'x', path: PATH(1) });
  await p.settle();
  assert.equal(p.made.n, 0, 'the first conversation\'s late id creates no iframe');
  const live = await withFrame();
  assert.equal(live.made.n, 1, 'control: without leaving, the id does frame');
});

test('the 8 s report deadline runs only while the page is visible: a backgrounded page (frame load suspended) keeps its frame; back in view, no report ⇒ code (control: visible ⇒ code at once)', async () => {
  const visible = await withFrame();
  visible.timers.find((x) => !x.done)!.fn();
  assert.equal(visible.q('bloc')!.dataset.state, 'code', 'control: a visible page gives up');
  const p = await withFrame();
  p.setHidden(true);
  const armedBefore = p.timers.length;
  p.timers.find((x) => !x.done)!.fn();
  assert.equal(p.q('bloc')!.dataset.state, 'frame', 'hidden: still waiting');
  assert.equal(p.frames().length, 1);
  assert.equal(p.timers.length, armedBefore + 1, 'the deadline is re-armed, not dropped');
  const again = [p.timers.at(-1)!];
  p.setHidden(false);
  again[0].fn();
  assert.equal(p.q('bloc')!.dataset.state, 'code', 'visible again and still no report ⇒ code');
  p.post({ __blocHtml: 1, h: 90 }, undefined); // late messages after the fallback are ignored
  assert.equal(p.frames().length, 0);
});
