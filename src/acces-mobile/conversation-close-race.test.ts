// Found by the #375 iPhone rig (a phone-launched workspace stayed blank): conversation.js `fetchConv` schedules its fetch on a timer and reads
// `current` when the timer FIRES. A conversation closed in between (the human tapped back) made that fetch go out for `id=null`; its answer
// passed the `id !== current` guard (null === null), threw on the emptied `.conv-state`, the `.catch` threw on the same element, and
// `inflight = false` was never reached — every later refresh returned early, so the NEXT conversation opened stayed empty until a reload.
// The REAL CONVERSATION_JS in a vm, a scripted network, a fake DOM that keeps its children.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { CONVERSATION_JS } from './conversation.ts';

class El {
  tag: string;
  className = '';
  dataset: Record<string, string> = {};
  children: El[] = [];
  hidden = false;
  value = '';
  type = '';
  disabled = false;
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  on: Record<string, ((e: unknown) => void)[]> = {};
  private own = '';
  constructor(tag = 'div') {
    this.tag = tag;
  }
  get textContent(): string {
    return this.own + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.own = String(v);
    this.children = [];
  }
  appendChild(c: El): El {
    this.children.push(c);
    return c;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  addEventListener(t: string, h: (e: unknown) => void): void {
    (this.on[t] ??= []).push(h);
  }
  has(c: string): boolean {
    return this.className.split(/\s+/).includes(c);
  }
  all(pred: (e: El) => boolean, out: El[] = []): El[] {
    for (const c of this.children) {
      if (pred(c)) out.push(c);
      c.all(pred, out);
    }
    return out;
  }
  querySelector(sel: string): El | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  querySelectorAll(sel: string): El[] {
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    return this.all((e) => (cls ? e.has(cls) : e.tag === sel));
  }
  focus(): void {}
  get scrollHeight(): number {
    return 100;
  }
  get scrollTop(): number {
    return 0;
  }
  set scrollTop(_v: number) {}
  get clientHeight(): number {
    return 100;
  }
}

const TOKEN = 't'.repeat(43);
const PROJECTION = (id: string) => ({ ok: true, id, version: 1, running: false, truncated: 0, lines: [{ id: 'u1', kind: 'user', text: `hello from ${id}` }], asks: [] });

function run() {
  const root = new El();
  const fetches: string[] = [];
  const errors: string[] = [];
  const held: { settle: (how: 'ok' | 'fail') => void }[] = [];
  let hold = false;
  const win: Record<string, unknown> = {};
  const sandbox: Record<string, unknown> = {
    window: win,
    document: {
      getElementById: (n: string) => (n === 'conv' ? root : new El()),
      createElement: (t: string) => new El(t),
      createTextNode: (t: string) => {
        const e = new El('#text');
        e.textContent = t;
        return e;
      },
      createDocumentFragment: () => new El('#frag'),
      addEventListener() {},
      scrollingElement: { scrollTop: 0, scrollHeight: 100, clientHeight: 100 },
      hidden: false,
    },
    localStorage: { getItem: () => TOKEN, setItem() {} },
    location: { hash: '' },
    navigator: {},
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    AbortController,
    TextDecoder,
    Uint8Array,
    Date,
    Math,
    console,
    fetch: (url: string) => {
      fetches.push(url);
      const body = url.startsWith('/api/conversation') ? PROJECTION(new URL(url, 'http://x').searchParams.get('id') ?? 'null') : url === '/api/stream' ? null : { ok: true };
      if (url === '/api/stream') return new Promise(() => {});
      if (hold && url.startsWith('/api/conversation')) {
        return new Promise((res, rej) => held.push({ settle: (how) => (how === 'ok' ? res({ ok: true, status: 200, json: async () => body, body: null }) : rej(new TypeError('offline'))) }));
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => body, body: null });
    },
  };
  win.window = win;
  vm.createContext(sandbox);
  vm.runInContext(CONVERSATION_JS, sandbox);
  const conv = win.OrchestraConversation as { open(id: string, row: unknown, n: number): void; close(): void };
  const onUnhandled = (e: unknown) => errors.push(String(e));
  process.on('unhandledRejection', onUnhandled);
  return { conv, root, fetches, errors, held, hold: (v: boolean) => (hold = v), stop: () => process.off('unhandledRejection', onUnhandled) };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const userLines = (root: El) => root.all((e) => e.dataset.kind === 'user').map((e) => e.textContent);

test('control: opening a conversation draws its lines (the harness can say PASS)', async () => {
  const fx = run();
  try {
    fx.conv.open('ws-a', { name: 'a' }, 0);
    await sleep(80);
    assert.deepEqual(userLines(fx.root), ['hello from ws-a']);
  } finally {
    fx.stop();
  }
});

test('must-FAIL on the unfixed script: leaving a conversation before its refresh timer fires must not poison the NEXT conversation', async () => {
  const fx = run();
  try {
    fx.conv.open('ws-a', { name: 'a' }, 0); // schedules a refresh (a timer)
    fx.conv.close(); //                        the human goes back BEFORE the timer fires
    await sleep(60); //                        the stale timer fires now
    assert.ok(!fx.fetches.some((u) => u.includes('id=null')), `a refresh for a closed conversation went out: ${fx.fetches.join(' ')}`);
    assert.deepEqual(fx.errors, [], 'no unhandled rejection from the stale refresh');
    fx.conv.open('ws-b', { name: 'b' }, 0); //  and opens another one
    await sleep(1200); //                       (the refresh throttle is 1 s)
    assert.deepEqual(userLines(fx.root), ['hello from ws-b'], 'the next conversation is drawn, not left blank by a stuck in-flight flag');
  } finally {
    fx.stop();
  }
});

test('close() then open() of the SAME id draws a fresh screen (no stale draw, no error)', async () => {
  const fx = run();
  try {
    fx.conv.open('ws-a', { name: 'a' }, 0);
    await sleep(80);
    fx.conv.close();
    fx.conv.open('ws-a', { name: 'a' }, 0); // same id again: a fresh screen, a fresh refresh
    await sleep(1200);
    assert.deepEqual(userLines(fx.root), ['hello from ws-a']);
    assert.deepEqual(fx.errors, []);
  } finally {
    fx.stop();
  }
});

test('must-FAIL on the unfixed script: a refresh that FAILS after the human went back (offline phone) must not stick the in-flight flag', async () => {
  const fx = run();
  try {
    fx.hold(true);
    fx.conv.open('ws-a', { name: 'a' }, 0);
    await sleep(40); //                       the refresh timer fired: the fetch is pending
    assert.equal(fx.held.length, 1, 'control: the refresh is in flight');
    fx.conv.close(); //                       back — the screen is emptied
    fx.held[0].settle('fail'); //             …and only then the network answers: an error
    await sleep(40);
    assert.deepEqual(fx.errors, [], 'the failure handler did not throw on the emptied screen');
    fx.hold(false);
    fx.conv.open('ws-b', { name: 'b' }, 0);
    await sleep(1200);
    assert.deepEqual(userLines(fx.root), ['hello from ws-b'], 'the next conversation is drawn');
  } finally {
    fx.stop();
  }
});

test('a LATE SUCCESS for a conversation the human already left is dropped — it never draws into the next one (the stale-id guard)', async () => {
  const fx = run();
  try {
    fx.hold(true);
    fx.conv.open('ws-a', { name: 'a' }, 0);
    await sleep(40);
    assert.equal(fx.held.length, 1, 'control: A\'s refresh is in flight');
    fx.conv.close();
    fx.conv.open('ws-b', { name: 'b' }, 0); // B is on screen, still empty (its own refresh is queued behind A's)
    fx.held[0].settle('ok'); //                A answers now
    await sleep(40);
    assert.deepEqual(userLines(fx.root), [], 'A\'s lines were NOT drawn into B');
    assert.deepEqual(fx.errors, []);
    fx.hold(false);
    await sleep(1200);
    assert.deepEqual(userLines(fx.root), ['hello from ws-b'], 'B then draws its own');
  } finally {
    fx.stop();
  }
});

test('a LATE FAILURE for the conversation the human left does not paint « injoignable » onto the next one', async () => {
  const fx = run();
  try {
    fx.hold(true);
    fx.conv.open('ws-a', { name: 'a' }, 0);
    await sleep(40);
    fx.conv.close();
    fx.conv.open('ws-b', { name: 'b' }, 0);
    fx.held[0].settle('fail'); // A's request fails after B is on screen
    await sleep(40);
    assert.equal(fx.root.querySelector('.conv-state')?.textContent, '', 'B\'s state line stays clean');
    fx.hold(false);
  } finally {
    fx.stop();
  }
});

test('an abandoned refresh neither moves the throttle clock nor leaves a queued refresh behind: the next conversation paints at once, with ONE request', async () => {
  const fx = run();
  try {
    fx.conv.open('ws-a', { name: 'a' }, 0); // a timer is pending
    fx.conv.open('ws-a', { name: 'a' }, 0); // a second refresh is asked for while the first waits (it queues: `again`)
    fx.conv.close(); //                        back before it fires
    await sleep(30); //                        the stale timer fires and fetches nothing
    const t0 = Date.now();
    fx.conv.open('ws-b', { name: 'b' }, 0);
    await sleep(120); //                       well under the 1 s throttle
    assert.deepEqual(userLines(fx.root), ['hello from ws-b'], `painted at once (${Date.now() - t0} ms), not after the throttle window`);
    await sleep(1200); //                      a queued refresh left behind by the abandoned one would fire by now
    assert.equal(fx.fetches.filter((u) => u.startsWith('/api/conversation') && u.includes('id=ws-b')).length, 1, 'one conversation request for B, not two');
  } finally {
    fx.stop();
  }
});
