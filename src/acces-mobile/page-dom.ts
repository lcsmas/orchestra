// Test-only DOM for the phone page's scripts (APP_JS / CONVERSATION_JS run in a `vm`): a minimal element that KEEPS its children, so
// the rows, titles, chips and folds the page draws can be read back. (pwa.test.ts's fake DOM only counts appends.) Not imported by
// any shipped code — a helper, not a test file, so importing it never re-registers a suite.
import vm from 'node:vm';
import { APP_JS } from './page.ts';

const TOKEN = 't'.repeat(43);

export class El {
  tag: string;
  className = '';
  dataset: Record<string, string> = {};
  children: El[] = [];
  hidden = false;
  checked = false;
  value = '';
  on: Record<string, () => void> = {};
  private own = '';
  constructor(tag = 'div') { this.tag = tag; }
  get textContent(): string { return this.own + this.children.map((c) => c.textContent).join(''); }
  set textContent(v: string) { this.own = String(v); this.children = []; }
  appendChild(c: El): El { this.children.push(c); return c; }
  addEventListener(t: string, h: () => void): void { this.on[t] = h; }
  setAttribute(name: string, v: string): void { this.attrs[name] = v; }
  attrs: Record<string, string> = {};
  click(): void { this.on.click?.(); }
  has(cls: string): boolean { return this.className.split(/\s+/).includes(cls); }
}
export const all = (root: El, pred: (e: El) => boolean, out: El[] = []): El[] => { for (const c of root.children) { if (pred(c)) out.push(c); all(c, pred, out); } return out; };
export const first = (root: El, pred: (e: El) => boolean): El | undefined => all(root, pred)[0];

export interface Row {
  id: string; name: string; displayName?: string; branch: string; group: string; account: string; status: string; unread: boolean; at: number;
  parentId?: string; preview?: { kind: string; text: string };
}
export const row = (id: string, over: Partial<Row> = {}): Row => ({ id, name: id, displayName: id, branch: `b-${id}`, group: 'orchestra', account: 'mc', status: 'idle', unread: false, at: 0, ...over });

/** Run the real page against `rows` (what /api/workspaces answers) and return the DOM it drew, plus a way to tap and re-render. */
export async function drawList(rows: Row[]) {
  const els: Record<string, El> = {};
  const get = (id: string): El => (els[id] ??= new El());
  const sandbox = {
    location: { hash: '', pathname: '/' },
    window: {
      addEventListener: () => {},
      OrchestraConversation: { open: () => {}, close: () => {}, onStream: () => {}, connect: () => {} },
    },
    history: { replaceState: () => {} },
    localStorage: { getItem: () => TOKEN, setItem: () => {} },
    document: { getElementById: get, createElement: (tag: string) => new El(tag) },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, workspaces: rows }) }),
    setInterval: () => 0,
    navigator: { standalone: false, serviceWorker: { register: () => Promise.resolve() } },
  };
  vm.runInNewContext(APP_JS, sandbox);
  const settle = () => new Promise((r) => setImmediate(r));
  await settle();
  const list = get('list');
  return {
    list,
    els,
    settle,
    rows: () => all(list, (e) => e.tag === 'li' && e.dataset.id !== undefined),
    row: (id: string) => first(list, (e) => e.tag === 'li' && e.dataset.id === id),
    fold: (id: string) => first(list, (e) => e.tag === 'li' && e.dataset.fold === id),
    title: (li: El) => first(li, (e) => e.tag === 'b')?.textContent,
    chip: (li: El, cls: string) => first(li, (e) => e.tag === 'span' && e.has(cls))?.textContent,
    headings: () => all(list, (e) => e.tag === 'h2').map((h) => h.dataset.group),
    needsMe: () => { get('needsMe').checked = true; get('needsMe').on.change?.(); },
  };
}

/** Run the real CONVERSATION_JS and open a conversation from a list row (what a tap does): returns the `#conv` element it draws. */
export function openConversation(conversationJs: string, id: string, listRow: Row | undefined, othersWaiting = 0): El {
  const root = new El();
  const sandbox: Record<string, unknown> = {
    window: {} as Record<string, unknown>,
    document: { addEventListener() {}, getElementById: (n: string) => (n === 'conv' ? root : new El()), createElement: (tag: string) => new El(tag), createTextNode: (t: string) => { const e = new El('#text'); e.textContent = t; return e; }, hidden: false },
    localStorage: { getItem: () => TOKEN, setItem() {} },
    location: { hash: '' },
    AbortController,
    TextDecoder,
    Date,
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0, // the first conversation fetch is deferred ≥ 0 ms: never fired here
    clearTimeout() {},
    fetch: () => new Promise(() => {}), // pending: nothing answers
  };
  vm.runInNewContext(conversationJs, sandbox);
  (sandbox.window as { OrchestraConversation: { open(id: string, row: unknown, n: number): void } }).OrchestraConversation.open(id, listRow, othersWaiting);
  return root;
}
