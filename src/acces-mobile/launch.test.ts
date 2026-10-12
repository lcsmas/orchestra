// The phone's launch screen (#375/#376 client side): the REAL LAUNCH_JS run in a vm against a small fake DOM + a scripted network.
// What it pins: a prompt and a repo are required on the phone, one request id per distinct launch (a retry keeps it, an edit changes it),
// a double tap is ONE request, the draft survives a back-swipe, a success opens the conversation, every failure says what happened.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { LAUNCH_JS } from './launch.ts';

const TOKEN = 'tok_' + 'a'.repeat(40);
const KEY = 'orchestra.accesMobile.token';

class El {
  children: El[] = [];
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  className = '';
  hidden = false;
  disabled = false;
  value = '';
  rows = 0;
  placeholder = '';
  type = '';
  private own = '';
  tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  get textContent(): string {
    return this.own + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.children = [];
    this.own = v;
  }
  appendChild(c: El): El {
    this.children.push(c);
    return c;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  addEventListener(t: string, f: (e: unknown) => void): void {
    (this.listeners[t] ??= []).push(f);
  }
  tap(): void {
    if (this.disabled) return;
    for (const f of this.listeners.click ?? []) f({});
  }
  type_(v: string): void {
    this.value = v;
    for (const f of this.listeners.input ?? []) f({});
  }
  all(cls: string, out: El[] = []): El[] {
    if (this.className.split(' ').includes(cls)) out.push(this);
    for (const c of this.children) c.all(cls, out);
    return out;
  }
  one(cls: string): El {
    const r = this.all(cls)[0];
    assert.ok(r, `no .${cls}`);
    return r;
  }
}

type Reply = { status: number; body?: unknown } | 'reject' | 'pending';
const REPOS = { ok: true, repos: [{ path: '/r/alpha', name: 'alpha', account: 'perso' }, { path: '/r/beta', name: 'beta', account: 'mc' }] };

function run(opts: { token?: boolean; replies?: Reply[] } = {}) {
  const root = new El('div');
  root.hidden = true;
  const storage = new Map<string, string>(opts.token === false ? [] : [[KEY, TOKEN]]);
  const location = { hash: '#new' };
  const fetches: { url: string; init: { method?: string; headers: Record<string, string>; body?: string } }[] = [];
  const queue = [...(opts.replies ?? [])];
  const pendings: ((r: { status: number; body?: unknown }) => void)[] = [];
  let uuid = 0;
  const sandbox: Record<string, unknown> = {
    window: { crypto: { randomUUID: () => `request-${++uuid}-0123456789abcdef` } } as Record<string, unknown>,
    document: {
      getElementById: (id: string) => (id === 'launch' ? root : null),
      createElement: (t: string) => new El(t),
      createTextNode: (t: string) => { const e = new El('#text'); e.textContent = t; return e; },
      scrollingElement: { scrollTop: 0 },
    },
    location,
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) },
    fetch: (url: string, init: { headers: Record<string, string> }) => {
      fetches.push({ url, init });
      const next: Reply = url === '/api/repos' && !queue.length ? { status: 200, body: REPOS } : queue.shift() ?? { status: 200, body: REPOS };
      if (next === 'reject') return Promise.reject(new TypeError('offline'));
      const respond = (r: { status: number; body?: unknown }) => ({ status: r.status, ok: r.status < 400, json: async () => r.body });
      if (next === 'pending') return new Promise((res) => pendings.push((r) => res(respond(r))));
      return Promise.resolve(respond(next));
    },
  };
  vm.runInNewContext(LAUNCH_JS, sandbox);
  const api = (sandbox.window as { OrchestraLaunch: { open(): void; close(): void; meta(id: string): unknown } }).OrchestraLaunch;
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  const launches = () => fetches.filter((f) => f.url === '/api/launch');
  return { api, root, location, storage, fetches, launches, settle, pendings };
}

/** Open the screen, pick `repo` (by name) and type `prompt`. */
async function filled(opts: Parameters<typeof run>[0] = {}, repo = 'alpha', prompt = 'fix the typo') {
  const r = run(opts);
  r.api.open();
  await r.settle();
  r.root.all('nf-repo').find((b) => b.textContent.includes(repo))!.tap();
  r.root.one('nf-task').type_(prompt);
  return r;
}
const go = (r: ReturnType<typeof run>) => r.root.one('nf-go');
const err = (r: ReturnType<typeof run>) => r.root.one('nf-err');

test('open: the registered repos (name, path, Compte) are listed with the bearer; « Lancer » stays disabled until a repo AND a prompt are there', async () => {
  const r = run();
  r.api.open();
  await r.settle();
  assert.equal(r.root.hidden, false);
  assert.deepEqual(r.fetches.map((f) => [f.url, f.init.headers.Authorization]), [['/api/repos', `Bearer ${TOKEN}`]], 'the token is in the header, never a URL');
  const cards = r.root.all('nf-repo');
  assert.deepEqual(cards.map((c) => c.dataset.path), ['/r/alpha', '/r/beta']);
  assert.ok(cards[0].textContent.includes('alpha') && cards[0].textContent.includes('/r/alpha') && cards[0].textContent.includes('perso'));
  assert.ok(cards[1].textContent.includes('beta') && cards[1].textContent.includes('mc'));
  assert.equal(go(r).disabled, true, 'nothing picked, nothing typed');
  r.root.one('nf-task').type_('fix the typo');
  assert.equal(go(r).disabled, true, 'a prompt but NO repo: the form cannot start a launch the server would refuse');
  r.root.one('nf-task').type_('');
  cards[0].tap();
  assert.equal(go(r).disabled, true, 'a repo but no prompt');
  r.root.one('nf-task').type_('   \n ');
  assert.equal(go(r).disabled, true, 'a blank prompt is refused on the phone');
  r.root.one('nf-task').type_('fix the typo');
  assert.equal(go(r).disabled, false, 'repo + prompt');
  assert.equal(r.root.all('nf-repo')[0].attrs['aria-checked'], 'true', 'the cards are redrawn on a pick');
  assert.equal(r.root.all('nf-repo')[1].attrs['aria-checked'], 'false');
});

test('open without a token goes back to the list (where the pairing panel is) and asks for nothing', async () => {
  const r = run({ token: false });
  r.api.open();
  await r.settle();
  assert.equal(r.location.hash, '');
  assert.equal(r.fetches.length, 0);
});

test('Lancer: ONE POST with exactly {repoPath, prompt (trimmed), requestId}, JSON + bearer; the button shows the creation', async () => {
  const r = await filled({ replies: [{ status: 200, body: REPOS }, 'pending'] }, 'beta', '  corrige la faute \n');
  go(r).tap();
  assert.equal(go(r).textContent, ' Création…');
  assert.equal(go(r).disabled, true);
  assert.equal(r.root.dataset.state, 'sending');
  assert.equal(r.root.one('nf-task').disabled, true, 'the prompt cannot change under the request');
  const [post] = r.launches();
  assert.equal(post.init.method, 'POST');
  assert.equal(post.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(post.init.headers['Content-Type'], 'application/json');
  const body = JSON.parse(post.init.body!);
  assert.deepEqual(Object.keys(body).sort(), ['prompt', 'repoPath', 'requestId'], 'no model / branch / Compte / parent from the phone');
  assert.deepEqual([body.repoPath, body.prompt], ['/r/beta', 'corrige la faute']);
  assert.match(body.requestId, /^[A-Za-z0-9_-]{16,64}$/);
});

test('must-FAIL: a double tap is ONE request while the first is in flight (control: a later retry is a request)', async () => {
  const r = await filled({ replies: [{ status: 200, body: REPOS }, 'pending'] });
  go(r).tap();
  go(r).tap();
  go(r).tap();
  assert.equal(r.launches().length, 1, 'three taps, one POST');
  r.pendings[0]({ status: 502 });
  await r.settle();
  go(r).tap();
  assert.equal(r.launches().length, 2, 'control: after the failure the next tap sends again');
});

test('a retry of the SAME launch keeps its request id (the server answers with the workspace the first try made); an edit is another launch', async () => {
  const r = await filled({ replies: [{ status: 200, body: REPOS }, 'reject', { status: 502 }, 'reject', 'reject'] });
  go(r).tap(); await r.settle();
  go(r).tap(); await r.settle();
  const [a, b] = r.launches().map((f) => JSON.parse(f.init.body!).requestId);
  assert.equal(a, b, 'same repo + same prompt ⇒ same id');
  r.root.one('nf-task').type_('fix the typo, and add a test');
  go(r).tap(); await r.settle();
  const c = JSON.parse(r.launches()[2].init.body!).requestId;
  assert.notEqual(c, a, 'another prompt ⇒ another id (main refuses a reused id carrying another launch)');
  r.root.all('nf-repo').find((x) => x.textContent.includes('beta'))!.tap();
  go(r).tap(); await r.settle();
  assert.notEqual(JSON.parse(r.launches()[3].init.body!).requestId, c, 'another repo ⇒ another id');
});

test('success: the conversation opens (#w=<id>), the draft is gone, and the screen knows the row it just made', async () => {
  const r = await filled({ replies: [{ status: 200, body: REPOS }, { status: 200, body: { ok: true, id: 'ws-1', branch: 'quiet-fox' } }] }, 'beta');
  go(r).tap(); await r.settle();
  assert.equal(r.location.hash, 'w=ws-1');
  assert.equal(r.root.one('nf-task').value, '', 'the textarea is cleared');
  assert.deepEqual(JSON.parse(JSON.stringify(r.api.meta('ws-1'))), { id: 'ws-1', name: 'quiet-fox', displayName: 'quiet-fox', group: 'beta', branch: 'quiet-fox', account: 'mc' });
  assert.equal(r.api.meta('someone-else'), null);
  r.api.close();
  r.api.open(); await r.settle();
  assert.equal(r.root.one('nf-task').value, '', 'a fresh screen after a launch is empty');
  assert.equal(r.root.all('nf-err')[0].hidden, true);
});

test('a refusal keeps the draft and says what happened — « aucun workspace » only when main refused; the 429 names the cap', async () => {
  const cases: [Reply, RegExp][] = [
    [{ status: 429 }, /10 par minute.*Aucun workspace n’a été créé/],
    [{ status: 200, body: { ok: false, code: 'unknown-repo', error: 'unknown repo' } }, /Dépôt inconnu/],
    [{ status: 200, body: { ok: false, code: 'create-failed', error: 'fatal: boom' } }, /Création impossible : fatal: boom/],
    [{ status: 502 }, /peut-être créé/],
    ['reject', /Réseau coupé.*peut-être créé/],
  ];
  for (const [reply, want] of cases) {
    const r = await filled({ replies: [{ status: 200, body: REPOS }, reply] });
    go(r).tap(); await r.settle();
    assert.match(err(r).textContent, want);
    assert.equal(err(r).hidden, false);
    assert.equal(r.root.dataset.state, 'error');
    assert.equal(r.root.one('nf-task').value, 'fix the typo', 'the draft is kept for a retry');
    assert.equal(go(r).disabled, false, 'and the button is back');
    assert.ok(!r.location.hash.startsWith('w='), 'no conversation opened');
    r.root.one('nf-task').type_('fix the typo!');
    assert.equal(err(r).hidden, true, 'typing clears the error');
  }
});

test('an agent that did not start: the error offers the workspace that EXISTS, a tap opens it with its header, and the draft is GONE (a second tap would duplicate it)', async () => {
  const r = await filled({ replies: [{ status: 200, body: REPOS }, { status: 200, body: { ok: false, code: 'start-failed', id: 'ws-9', branch: 'quiet-fox', error: 'no auth' } }] });
  go(r).tap(); await r.settle();
  assert.match(err(r).textContent, /L’agent n’a pas démarré : no auth.*Le workspace existe sur le bureau/);
  assert.equal(r.root.one('nf-task').value, '', 'the prompt is the workspace\'s task now');
  assert.equal(go(r).disabled, true, 'nothing left to launch: no duplicate from a second tap');
  assert.deepEqual(JSON.parse(JSON.stringify(r.api.meta('ws-9'))), { id: 'ws-9', name: 'quiet-fox', displayName: 'quiet-fox', group: 'alpha', branch: 'quiet-fox', account: 'perso' }, 'the conversation header is known');
  err(r).one('nf-open').tap();
  assert.equal(r.location.hash, 'w=ws-9');
});

test('a refused token on launch sends the phone back to the list (re-pairing), keeping nothing created', async () => {
  const r = await filled({ replies: [{ status: 200, body: REPOS }, { status: 401 }] });
  go(r).tap(); await r.settle();
  assert.equal(r.location.hash, '');
});

test('the draft survives a back-swipe (close + open) — only a launch clears it; the picked repo too', async () => {
  const r = await filled({}, 'beta', 'a long prompt typed with thumbs');
  r.api.close();
  assert.equal(r.root.hidden, true);
  r.api.open(); await r.settle();
  assert.equal(r.root.one('nf-task').value, 'a long prompt typed with thumbs');
  assert.equal(r.root.all('nf-repo').filter((c) => c.className.split(' ').includes('sel')).map((c) => c.dataset.path).join(), '/r/beta');
  assert.equal(go(r).disabled, false);
});

test('the repo list failing is a retryable state, not an empty form that looks usable; an empty registry says so', async () => {
  const bad = run({ replies: ['reject', { status: 200, body: REPOS }] });
  bad.api.open(); await bad.settle();
  assert.equal(bad.root.all('nf-repo').length, 0);
  const retry = bad.root.one('nf-open');
  assert.match(retry.textContent, /Dépôts indisponibles/);
  retry.tap(); await bad.settle();
  assert.equal(bad.root.all('nf-repo').length, 2, 'the retry loaded them');
  const empty = run({ replies: [{ status: 200, body: { ok: true, repos: [] } }] });
  empty.api.open(); await empty.settle();
  assert.match(empty.root.textContent, /Aucun dépôt enregistré/);
  assert.equal(go(empty).disabled, true);
});

test('a single registered repo is preselected; the last repo used is remembered (control: with two and no memory, none is)', async () => {
  const one = run({ replies: [{ status: 200, body: { ok: true, repos: [REPOS.repos[1]] } }] });
  one.api.open(); await one.settle();
  assert.equal(one.root.all('nf-repo')[0].className.includes('sel'), true);
  const none = run();
  none.api.open(); await none.settle();
  assert.equal(none.root.all('nf-repo').some((c) => c.className.split(' ').includes('sel')), false, 'control: two repos, no memory ⇒ the human chooses');
  const mem = run();
  mem.storage.set('orchestra.accesMobile.lastRepo', '/r/beta');
  mem.api.open(); await mem.settle();
  assert.equal(mem.root.all('nf-repo').find((c) => c.className.split(' ').includes('sel'))?.dataset.path, '/r/beta');
});

test('textContent only: a repo named like markup is data, never markup', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const r = run({ replies: [{ status: 200, body: { ok: true, repos: [{ path: '/r/x', name: evil, account: '<b>mc</b>' }] } }] });
  r.api.open(); await r.settle();
  assert.ok(r.root.textContent.includes(evil), 'shown as text');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(LAUNCH_JS), 'the script has no markup sink');
});

// ---- the shell's side: the « + », the #new route, the hand-over to the conversation (page.ts APP_JS) ----
import { APP_JS } from './page.ts';

function runShell(opts: { hash?: string; withLaunch?: boolean } = {}) {
  const els: Record<string, { hidden: boolean; checked: boolean; value: string; textContent: string; className: string; dataset: Record<string, string>; on: Record<string, () => void> }> = {};
  const mk = () => {
    const e = { hidden: false, checked: false, value: '', textContent: '', className: '', dataset: {} as Record<string, string>, on: {} as Record<string, () => void>,
      appendChild() {}, addEventListener(t: string, h: () => void) { e.on[t] = h; }, setAttribute() {}, play: undefined };
    return e;
  };
  const location = { hash: opts.hash ?? '', pathname: '/' };
  const calls: string[] = [];
  const listeners: Record<string, () => void> = {};
  const META = { id: 'ws-1', name: 'quiet-fox', group: 'orchestra-rig', branch: 'quiet-fox', account: 'mc' };
  const sandbox = {
    location,
    window: {
      addEventListener: (t: string, h: () => void) => (listeners[t] = h),
      OrchestraConversation: { open: (id: string, row: unknown) => calls.push(`conv.open:${id}:${JSON.stringify(row)}`), close: () => calls.push('conv.close'), onStream: () => {}, connect: () => {} },
      ...(opts.withLaunch === false ? {} : { OrchestraLaunch: { open: () => calls.push('launch.open'), close: () => calls.push('launch.close'), meta: (id: string) => (id === 'ws-1' ? META : null) } }),
    },
    history: { replaceState: () => {} },
    localStorage: { getItem: () => TOKEN, setItem: () => {} },
    document: { getElementById: (id: string) => (els[id] ??= mk()), createElement: () => mk() },
    fetch: (url: string) => (calls.push(`fetch:${url}`), Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, workspaces: [] }) })),
    setInterval: () => 0,
    navigator: { standalone: false, serviceWorker: { register: () => Promise.resolve() } },
  };
  vm.runInNewContext(APP_JS, sandbox);
  const go = (hash: string) => { location.hash = hash; listeners.hashchange?.(); };
  return { els, calls, location, go, META, settle: () => new Promise((r) => setImmediate(r)) };
}

test('shell: the « + » opens #new; #new shows the launch screen instead of the list; leaving it closes the screen and brings the list back', async () => {
  const s = runShell();
  await s.settle();
  assert.ok(s.calls.includes('fetch:/api/workspaces') && s.els.home.hidden === false, 'control: the list is the home screen');
  s.calls.length = 0;
  s.els.newBtn.on.click();
  assert.equal(s.location.hash, 'new', 'the « + » navigates to #new');
  s.go('#new');
  assert.deepEqual(s.calls.filter((c) => !c.startsWith('fetch:')), ['conv.close', 'launch.open']);
  assert.equal(s.els.home.hidden, true, 'the list is hidden behind the form');
  assert.ok(!s.calls.some((c) => c === 'fetch:/api/workspaces'), 'opening the form does not reload the list');
  s.calls.length = 0;
  s.go('');
  assert.deepEqual(s.calls.filter((c) => !c.startsWith('fetch:')), ['conv.close', 'launch.close']);
  assert.equal(s.els.home.hidden, false);
});

test('shell: right after a launch the conversation opens with the row the launch screen made (the list has not refreshed yet) and the launch screen closes', async () => {
  const s = runShell({ hash: '#new' });
  await s.settle();
  s.calls.length = 0;
  s.go('#w=ws-1');
  assert.deepEqual(s.calls.filter((c) => !c.startsWith('fetch:')), ['launch.close', `conv.open:ws-1:${JSON.stringify(s.META)}`]);
  s.calls.length = 0;
  s.go('#w=ws-2');
  assert.ok(s.calls.some((c) => c === 'conv.open:ws-2:{"name":"ws-2"}'), 'control: any other id falls back to its id as before');
});

test('shell: without launch.js the #new hash is just the list (a stale cached shell never shows a blank screen)', async () => {
  const s = runShell({ hash: '#new', withLaunch: false });
  await s.settle();
  assert.equal(s.els.home.hidden, false);
  assert.ok(s.calls.includes('fetch:/api/workspaces'));
});

test('leaving the screen while a launch is in flight: coming back shows it in flight (never a live button), and the answer lands — a success without hijacking the page, a failure on the form', async () => {
  const ok = await filled({ replies: [{ status: 200, body: REPOS }, 'pending'] });
  go(ok).tap();
  ok.api.close();
  assert.equal(ok.root.hidden, true);
  ok.api.open(); await ok.settle();
  assert.equal(go(ok).disabled, true, 'back on the form: the launch is still running — no second tap');
  assert.equal(go(ok).textContent, ' Création…');
  assert.equal(ok.root.one('nf-task').disabled, true);
  ok.api.close(); // leave again, then the answer arrives while away
  ok.location.hash = '';
  ok.pendings[0]({ status: 200, body: { ok: true, id: 'ws-7', branch: 'calm-owl' } });
  await ok.settle();
  assert.equal(ok.location.hash, '', 'a human who left is not pulled into the conversation');
  assert.equal(ok.launches().length, 1);
  assert.equal(JSON.parse(JSON.stringify(ok.api.meta('ws-7'))).branch, 'calm-owl', 'but the workspace is known (the list shows it)');
  ok.api.open(); await ok.settle();
  assert.equal(ok.root.one('nf-task').value, '', 'the draft went with the launch');
  assert.equal(go(ok).disabled, true);

  const ko = await filled({ replies: [{ status: 200, body: REPOS }, 'pending'] });
  go(ko).tap();
  ko.api.close();
  ko.pendings[0]({ status: 429 });
  await ko.settle();
  ko.api.open(); await ko.settle();
  assert.match(err(ko).textContent, /Trop de lancements \(10 par minute\)/, 'the failure that arrived while away is on the form when the human returns');
  assert.equal(go(ko).disabled, false, 'and the button is live again, the prompt kept');
  assert.equal(ko.root.one('nf-task').value, 'fix the typo');
  assert.equal(ko.root.one('nf-task').disabled, false);
});

test('a repo card tapped while a launch is in flight changes nothing (the request is for THIS repo)', async () => {
  const r = await filled({ replies: [{ status: 200, body: REPOS }, 'pending'] }, 'alpha');
  go(r).tap();
  r.root.all('nf-repo').find((c) => c.textContent.includes('beta'))!.tap();
  assert.equal(r.root.all('nf-repo').find((c) => c.className.split(' ').includes('sel'))?.dataset.path, '/r/alpha');
  assert.equal(JSON.parse(r.launches()[0].init.body!).repoPath, '/r/alpha');
});

test('a refused token while loading the repos sends the phone back to the list (re-pairing) instead of « Dépôts indisponibles » forever', async () => {
  const r = run({ replies: [{ status: 401 }] });
  r.api.open(); await r.settle();
  assert.equal(r.location.hash, '');
});
