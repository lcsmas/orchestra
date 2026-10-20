// The phone's `/` skills menu: the REAL CONVERSATION_JS in a vm, every /api/skills request held until the test answers it.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { CONVERSATION_JS } from './conversation.ts';

class El {
  className = '';
  dataset: Record<string, string> = {};
  children: El[] = [];
  hidden = false;
  value = '';
  type = '';
  disabled = false;
  focused = 0;
  style: Record<string, string> = {};
  on: Record<string, ((e: unknown) => void)[]> = {};
  private own = '';
  tag: string;
  constructor(tag = 'div') { this.tag = tag; }
  get textContent(): string { return this.own + this.children.map((c) => c.textContent).join(''); }
  set textContent(v: string) { this.own = String(v); this.children = []; }
  appendChild(c: El): El { this.children.push(c); return c; }
  setAttribute(): void {}
  addEventListener(t: string, h: (e: unknown) => void): void { (this.on[t] ??= []).push(h); }
  dispatchEvent(e: { type: string }): void { (this.on[e.type] ?? []).forEach((h) => h(e)); }
  click(): void { this.dispatchEvent({ type: 'click' }); }
  focus(): void { this.focused++; }
  has(c: string): boolean { return this.className.split(/\s+/).includes(c); }
  all(cls: string, out: El[] = []): El[] { for (const c of this.children) { if (c.has(cls)) out.push(c); c.all(cls, out); } return out; }
  querySelector(sel: string): El | null { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel: string): El[] {
    const walk = (e: El, out: El[]): El[] => { for (const c of e.children) { if (sel.startsWith('.') ? c.has(sel.slice(1)) : c.tag === sel) out.push(c); walk(c, out); } return out; };
    return walk(this, []);
  }
  get scrollHeight(): number { return 100; }
}

const TOKEN = 't'.repeat(43);
const SKILLS = { ok: true, items: [
  { name: 'ship', description: 'Ship the branch', source: 'project' },
  { name: 'slack:standup', description: 'Standup', source: 'plugin' },
  { name: 'compact', description: 'Compact the conversation to free context', source: 'builtin' },
  { name: 'mobile-club-env-db', description: '', source: 'user' },
] };

function run() {
  const root = new El();
  const held: { url: string; auth: string; answer: (body: unknown) => void }[] = [];
  const sandbox: Record<string, unknown> = {
    window: {},
    document: {
      getElementById: (n: string) => (n === 'conv' ? root : new El()),
      createElement: (t: string) => new El(t),
      createTextNode: (t: string) => { const e = new El('#text'); e.textContent = t; return e; },
      createDocumentFragment: () => new El('#frag'),
      addEventListener() {},
      scrollingElement: { scrollTop: 0, scrollHeight: 100, clientHeight: 100 },
      hidden: false,
    },
    localStorage: { getItem: () => TOKEN, setItem() {} },
    location: { hash: '' },
    Event: class { type: string; constructor(t: string) { this.type = t; } },
    setTimeout: (f: () => void) => setImmediate(f),
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    AbortController,
    TextDecoder,
    Date,
    Math,
    fetch: (url: string, init: { headers?: Record<string, string> } = {}) => {
      if (url.startsWith('/api/skills')) return new Promise((res) => held.push({ url, auth: init.headers?.Authorization ?? '', answer: (b) => res({ ok: true, status: 200, json: async () => b }) }));
      if (url.startsWith('/api/conversation')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, id: 'w1', version: 1, running: false, truncated: 0, lines: [], asks: [] }) });
      if (url === '/api/stream') return new Promise(() => {});
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
    },
  };
  vm.runInNewContext(CONVERSATION_JS, sandbox);
  (sandbox.window as { OrchestraConversation: { open(id: string, row: unknown, n: number): void } }).OrchestraConversation.open('w1', { name: 'w1' }, 0);
  const ta = root.all('conv-input')[0];
  const ac = root.all('conv-ac')[0];
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  const type = (v: string) => { ta.value = v; ta.dispatchEvent({ type: 'input' }); };
  const names = () => (ac.hidden ? [] : ac.all('ac-row').map((r) => r.dataset.name));
  return { root, ta, ac, held, settle, type, names };
}

test('skills menu: « / » fetches the list with the token, rows filter as you type, a tap fills « /<name> » and closes', async () => {
  const p = run();
  await p.settle();
  assert.ok(p.ac, 'the menu element exists');
  p.type('hello');
  assert.equal(p.held.length, 0, 'must-FAIL: plain text never asks for skills');
  assert.equal(p.ac.hidden, true);
  p.type('/');
  assert.equal(p.held.length, 1);
  assert.deepEqual([p.held[0].url, p.held[0].auth], ['/api/skills?id=w1', `Bearer ${TOKEN}`]);
  p.held[0].answer(SKILLS);
  await p.settle();
  assert.deepEqual(p.names(), ['compact', 'mobile-club-env-db', 'ship', 'slack:standup']);
  p.type('/s');
  assert.deepEqual(p.names(), ['ship', 'slack:standup']);
  p.type('/c');
  assert.deepEqual(p.names(), ['compact', 'mobile-club-env-db', 'slack:standup'], 'prefix matches first, then substring');
  p.type('/slack:');
  assert.deepEqual(p.names(), ['slack:standup'], 'a plugin name keeps the menu open');
  assert.equal(p.held.length, 1, 'no refetch while the menu stays open');
  const row = p.ac.all('ac-row')[0];
  assert.equal(row.textContent, '/slack:standupStandup');
  row.click();
  assert.equal(p.ta.value, '/slack:standup ');
  assert.equal(p.ac.hidden, true, 'the menu closes once a command is chosen');
  assert.ok(p.ta.focused >= 1, 'the keyboard stays up');
  assert.ok(p.root.all('conv-send')[0].has('on'), 'the send button is armed');
  p.type('/zzz');
  assert.equal(p.held.length, 2, 'reopening the menu re-fetches (a skill added since shows)');
  assert.equal(p.ac.hidden, true, 'no match: nothing shown');
});

test('skills menu must-FAIL: an older, slower answer never replaces the newer list; a failed fetch shows nothing', async () => {
  const p = run();
  await p.settle();
  p.type('/');
  p.type('');
  p.type('/');
  assert.equal(p.held.length, 2);
  p.held[1].answer({ ok: true, items: [{ name: 'new-skill', description: '', source: 'user' }] });
  await p.settle();
  p.held[0].answer(SKILLS);
  await p.settle();
  assert.deepEqual(p.names(), ['new-skill'], 'the stale answer is dropped');
  const q = run();
  await q.settle();
  q.type('/');
  q.held[0].answer({ ok: false, error: 'unknown workspace' });
  await q.settle();
  assert.equal(q.ac.hidden, true);
});
