// Interrupt + rewind from the phone: the REAL CONVERSATION_JS in a vm, a scripted network (every request recorded and answered by
// the test), a fake DOM that keeps its children. Each must-FAIL arm sits beside its control.

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
  dispatchEvent(e: { type: string }): void {
    (this.on[e.type] ?? []).forEach((h) => h(e));
  }
  click(): void {
    if (!this.disabled) this.dispatchEvent({ type: 'click' });
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
  get scrollHeight(): number {
    return 100;
  }
}

const TOKEN = 't'.repeat(43);
type Line = Record<string, unknown>;
const conv = (running: boolean, lines: Line[], v = 1) => ({ ok: true, id: 'w1', version: v, running, truncated: 0, lines, asks: [] });
const USER = (id: string, text: string, rewindId?: string): Line => ({ id, kind: 'user', text, ...(rewindId ? { rewindId } : {}) });
const ANSWER = (id: string): Line => ({ id, kind: 'assistant', text: 'ok', streaming: false });

interface Req { url: string; method: string; auth: string; answer: (status: number, body: unknown) => void; fail: () => void }

function run(first: ReturnType<typeof conv>) {
  const root = new El();
  const reqs: Req[] = [];
  let projection = first;
  const sandbox: Record<string, unknown> = {
    window: {} as Record<string, unknown>,
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
    Event: class {
      type: string;
      constructor(t: string) {
        this.type = t;
      }
    },
    setTimeout: (f: () => void) => setImmediate(f),
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    AbortController,
    TextDecoder,
    Date,
    Math,
    fetch: (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
      if (url === '/api/stream') return new Promise(() => {});
      if (url.startsWith('/api/conversation')) return Promise.resolve({ ok: true, status: 200, json: async () => projection });
      if (url.startsWith('/api/seen')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      return new Promise((res, rej) =>
        reqs.push({
          url,
          method: init.method ?? 'GET',
          auth: init.headers?.Authorization ?? '',
          answer: (status, body) => res({ ok: status >= 200 && status < 300, status, json: async () => body }),
          fail: () => rej(new TypeError('Load failed')),
        }),
      );
    },
  };
  vm.runInNewContext(CONVERSATION_JS, sandbox);
  const api = (sandbox.window as { OrchestraConversation: { open(id: string, row: unknown, n: number): void } }).OrchestraConversation;
  api.open('w1', { name: 'w1' }, 0);
  const settle = async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  };
  const q = (cls: string) => root.querySelector('.' + cls);
  const qa = (cls: string) => root.querySelectorAll('.' + cls);
  return {
    root,
    reqs,
    settle,
    q,
    qa,
    /** the next projection the phone reads (as if main's fold changed) — a refetch is what a stream announcement causes */
    setProjection: (c: ReturnType<typeof conv>) => (projection = c),
  };
}

test('interrupt: the stop button shows only while a turn runs; a tap POSTs /api/interrupt with the token; the bar goes when the turn ends', async () => {
  const p = run(conv(true, [USER('u1', 'go', 'r1'), ANSWER('a1')]));
  await p.settle();
  const bar = p.q('conv-running')!;
  assert.equal(bar.hidden, false, 'running: the bar is shown');
  const stop = p.q('conv-stop')!;
  assert.equal(stop.textContent, '■ Arrêter');
  stop.click();
  assert.equal(p.reqs.length, 1);
  assert.deepEqual([p.reqs[0].url, p.reqs[0].method, p.reqs[0].auth], ['/api/interrupt?id=w1', 'POST', `Bearer ${TOKEN}`]);
  assert.equal(stop.disabled, true, 'no second tap while the first is in flight');
  stop.click();
  assert.equal(p.reqs.length, 1, 'a double tap sends one interrupt');
  p.setProjection(conv(false, [USER('u1', 'go', 'r1'), ANSWER('a1')], 2));
  p.reqs[0].answer(200, { ok: true });
  await p.settle();
  assert.equal(bar.hidden, true, 'the turn ended: no bar');
  assert.equal(stop.disabled, false, 'ready for the next turn');
});

test('interrupt must-FAIL: a refusal or a lost network is said, and the button comes back (control: success says nothing)', async () => {
  for (const [how, said] of [
    ['refused', 'unknown or archived workspace'],
    ['401', 'Jeton refusé.'],
    ['offline', 'Réseau coupé : l’arrêt n’est peut-être pas parti.'],
  ] as const) {
    const p = run(conv(true, [USER('u1', 'go')]));
    await p.settle();
    p.q('conv-stop')!.click();
    if (how === 'refused') p.reqs[0].answer(200, { ok: false, error: said });
    else if (how === '401') p.reqs[0].answer(401, null);
    else p.reqs[0].fail();
    await p.settle();
    assert.equal(p.q('conv-stop-msg')!.textContent, said, how);
    assert.equal(p.q('conv-stop')!.disabled, false, `${how}: the button is usable again`);
    assert.equal(p.q('conv-running')!.hidden, false, `${how}: still running`);
    p.q('conv-stop')!.click();
    assert.equal(p.reqs.length, 2, `${how}: a second tap sends a second interrupt`);
  }
});

test('rewind: offered on a user turn with a target, never mid-turn nor on a turn without one', async () => {
  const lines = [USER('u1', 'first', 'r1'), ANSWER('a1'), USER('u2', 'from a peer'), ANSWER('a2'), USER('u3', 'third', 'r3')];
  const idle = run(conv(false, lines));
  await idle.settle();
  assert.deepEqual(idle.qa('msg-rw').map((b) => b.dataset.rewind), ['r1', 'r3'], 'one ↺ per rewindable turn');
  const busy = run(conv(true, lines));
  await busy.settle();
  assert.equal(busy.qa('msg-rw').length, 0, 'mid-turn: no rewind (main refuses it too)');
});

test('rewind: tap ⇒ a confirmation with the files preview; confirm ⇒ POST /api/rewind, the undone prompt back in the field', async () => {
  const p = run(conv(false, [USER('u1', 'first', 'r1'), ANSWER('a1'), USER('u2', 'redo this', 'r2'), ANSWER('a2')]));
  await p.settle();
  p.qa('msg-rw')[1].click();
  assert.deepEqual([p.reqs[0].url, p.reqs[0].method, p.reqs[0].auth], ['/api/rewind-preview?id=w1&rewind=r2', 'POST', `Bearer ${TOKEN}`]);
  const pop = () => p.q('rw-pop')!;
  assert.equal(pop().dataset.rewind, 'r2');
  assert.equal(p.q('rw-files')!.textContent, 'Vérification des fichiers…');
  p.reqs[0].answer(200, { ok: true, preview: { canRewind: true, filesChanged: ['a.ts', 'b.ts'], insertions: 3, deletions: 1 } });
  await p.settle();
  assert.equal(p.q('rw-files')!.textContent, 'Restaure 2 fichiers (+3/−1).');
  assert.deepEqual(p.qa('msg-rw').map((b) => b.dataset.rewind), ['r1'], 'the opened turn shows its panel instead of its button');
  p.q('rw-go')!.click();
  assert.deepEqual([p.reqs[1].url, p.reqs[1].method], ['/api/rewind?id=w1&rewind=r2', 'POST']);
  assert.equal(p.q('rw-go')!.disabled, true, 'busy: no second confirm');
  p.q('rw-go')!.click();
  assert.equal(p.reqs.length, 2, 'a double tap sends one rewind');
  p.setProjection(conv(false, [USER('u1', 'first', 'r1'), ANSWER('a1')], 3));
  p.reqs[1].answer(200, { ok: true, text: 'redo this' });
  await p.settle();
  assert.equal(p.q('conv-input')!.value, 'redo this', 'edit-and-retry: the text is back in the field');
  assert.equal(p.q('rw-pop'), null, 'panel closed');
  assert.equal(p.q('rw-note')!.textContent, 'Conversation rembobinée.');
  assert.deepEqual(p.qa('msg').map((m) => m.dataset.id), ['u1', 'a1'], 'the refetched conversation ends before the undone turn');
});

test('rewind: a partial rewind says the files stayed; a typed draft is never overwritten', async () => {
  const p = run(conv(false, [USER('u1', 'first', 'r1')]));
  await p.settle();
  p.q('conv-input')!.value = 'my draft';
  p.q('msg-rw')!.click();
  p.reqs[0].answer(200, { ok: true, preview: { canRewind: false } });
  await p.settle();
  assert.equal(p.q('rw-files')!.textContent, 'Les fichiers resteront tels quels (pas d’instantané pour ce message).');
  p.q('rw-go')!.click();
  p.reqs[1].answer(200, { ok: true, text: 'first', filesError: 'No file checkpoint found' });
  await p.settle();
  assert.equal(p.q('conv-input')!.value, 'my draft');
  assert.equal(p.q('rw-note')!.textContent, 'Conversation rembobinée. Fichiers laissés tels quels — No file checkpoint found');
});

test('rewind must-FAIL: a refusal keeps the panel open with the reason (control: Annuler closes it, nothing sent)', async () => {
  const p = run(conv(false, [USER('u1', 'first', 'r1')]));
  await p.settle();
  p.q('msg-rw')!.click();
  p.reqs[0].answer(200, { ok: true, preview: { canRewind: true, filesChanged: [] } });
  await p.settle();
  assert.equal(p.q('rw-files')!.textContent, 'Aucun fichier à restaurer.');
  p.q('rw-cancel')!.click();
  assert.equal(p.q('rw-pop'), null, 'control: cancelled');
  assert.equal(p.reqs.length, 1, 'cancel sends nothing');
  p.q('msg-rw')!.click();
  p.reqs[1].answer(200, { ok: true, preview: { canRewind: true, filesChanged: [] } });
  await p.settle();
  p.q('rw-go')!.click();
  p.reqs[2].answer(200, { ok: false, error: 'L’agent travaille : arrête-le avant de revenir en arrière.' });
  await p.settle();
  assert.equal(p.q('rw-pop')!.dataset.state, 'error');
  assert.equal(p.q('rw-err')!.textContent, 'L’agent travaille : arrête-le avant de revenir en arrière.');
  assert.equal(p.q('rw-go')!.disabled, false, 'retry possible');
  assert.equal(p.q('conv-input')!.value, '', 'nothing put back in the field');
});
