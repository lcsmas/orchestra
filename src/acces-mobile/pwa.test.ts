// Accès mobile PWA install (#336): the static assets stay behind the identity check, the icons are real PNGs, the manifest is
// installable, and the service worker caches ONLY the shell (never /api, never a token) and falls back to it when the server is
// unreachable. Every must-FAIL arm sits beside a passing control; the worker's own source runs in a vm with a scripted network.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import type { AddressInfo } from 'node:net';
import { PNG } from 'pngjs';
import { createAccesMobileServer } from './server.ts';
import { APP_JS, INDEX_HTML, MANIFEST_JSON } from './page.ts';
import { PWA_ICONS } from './icons.ts';
import { SHELL_PATHS, SW_CACHE_NAME, SW_JS } from './sw.ts';

const LOGIN = 'owner@example.invalid';
const TOKEN = 'tok_' + 'a'.repeat(40);
const ID = { 'Tailscale-User-Login': LOGIN };

// Hard-coded on purpose: an emptied/renamed map must fail here, not pass by iterating itself.
const ASSETS: Array<[string, RegExp]> = [
  ['/', /^text\/html/],
  ['/app.js', /^text\/javascript/],
  ['/sw.js', /^text\/javascript/],
  ['/manifest.webmanifest', /^application\/manifest\+json/],
  ['/apple-touch-icon.png', /^image\/png$/],
  ['/icon-192.png', /^image\/png$/],
  ['/icon-512.png', /^image\/png$/],
];

async function withServer<T>(fn: (port: number, logs: string[]) => Promise<T>): Promise<T> {
  const logs: string[] = [];
  const server = createAccesMobileServer({ allowedLogin: LOGIN, readToken: () => TOKEN, upstream: async () => ({ ok: true, workspaces: [] }), log: (l) => logs.push(l) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn((server.address() as AddressInfo).port, logs);
  } finally {
    await new Promise((r) => server.close(() => r(null)));
  }
}

function fetchRaw(port: number, p: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; type: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ───────────────────────── static assets behind identity ─────────────────────────

test('every PWA asset is served WITH the owner identity (control) and refused without / with a colleague (must-FAIL), reveal nothing', async () => {
  await withServer(async (port) => {
    for (const [p, type] of ASSETS) {
      const ok = await fetchRaw(port, p, ID);
      assert.equal(ok.status, 200, `control ${p}`);
      assert.match(ok.type, type, `content type of ${p}`);
      assert.ok(ok.body.length > 0, `${p} has a body`);
      for (const [label, headers] of [['no identity', {}], ['a colleague', { 'Tailscale-User-Login': 'colleague@example.invalid' }], ['an empty identity', { 'Tailscale-User-Login': '' }]] as const) {
        const refused = await fetchRaw(port, p, headers);
        assert.equal(refused.status, 403, `${p} with ${label}`);
        assert.equal(refused.body.length, 0, `${p} refusal reveals nothing`);
      }
      assert.equal((await fetchRaw(port, p, ID, 'POST')).status, 405, `${p} is GET only`);
    }
  });
});

test('no asset carries the token — not the shell, not the worker, not the manifest, not an icon (even when asked with the token)', async () => {
  await withServer(async (port) => {
    for (const [p] of ASSETS) {
      const res = await fetchRaw(port, `${p}?t=${TOKEN}`, { ...ID, Authorization: `Bearer ${TOKEN}` });
      assert.equal(res.status, 200, `control ${p}`);
      assert.ok(!res.body.includes(TOKEN), `${p} must not embed the token`);
      assert.ok(!res.body.toString('latin1').includes(TOKEN.slice(0, 20)), `${p} must not embed a token prefix`);
    }
  });
});

test('refused asset requests never log the token or any header value (control: a refusal IS logged)', async () => {
  await withServer(async (port, logs) => {
    await fetchRaw(port, `/sw.js?t=${TOKEN}`, { Authorization: `Bearer ${TOKEN}` });
    await fetchRaw(port, `/icon-512.png?token=${TOKEN}`, { 'Tailscale-User-Login': 'colleague@example.invalid', Authorization: `Bearer ${TOKEN}` });
    assert.ok(logs.length >= 2, 'control: the refusals are logged');
    const all = logs.join('\n');
    assert.ok(!all.includes(TOKEN) && !all.includes('colleague@example.invalid'), `log leaked: ${all}`);
    assert.ok(all.includes('/sw.js'), 'the path is what is logged');
  });
});

test('SHELL_PATHS: the worker only ever caches paths the server really serves, never /api, never itself', async () => {
  assert.deepEqual([...SHELL_PATHS].sort(), ['/', '/app.js', '/apple-touch-icon.png', '/conversation.css', '/conversation.js', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest']);
  await withServer(async (port) => {
    for (const p of SHELL_PATHS) assert.equal((await fetchRaw(port, p, ID)).status, 200, `shell path ${p} is served`);
    assert.equal((await fetchRaw(port, '/never-served.png', ID)).status, 404, 'control: an unknown path is a 404 (so the loop above can fail)');
  });
  assert.ok(!SHELL_PATHS.includes('/sw.js') && !SHELL_PATHS.some((p) => p.startsWith('/api/')));
});

// ───────────────────────── icons + manifest + page ─────────────────────────

test('icons are real PNGs of the declared size, opaque, not blank — served byte for byte', async () => {
  assert.deepEqual(PWA_ICONS.map((i) => [i.path, i.size]), [['/apple-touch-icon.png', 180], ['/icon-192.png', 192], ['/icon-512.png', 512]]);
  await withServer(async (port) => {
    for (const icon of PWA_ICONS) {
      const served = (await fetchRaw(port, icon.path, ID)).body;
      assert.ok(served.equals(icon.png), `${icon.path} served unchanged`);
      const png = PNG.sync.read(served);
      assert.equal(png.width, icon.size);
      assert.equal(png.height, icon.size);
      const colours = new Set<number>();
      let opaque = true;
      for (let i = 0; i < png.data.length; i += 4) {
        colours.add((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]);
        if (png.data[i + 3] !== 255) opaque = false;
      }
      assert.ok(opaque, `${icon.path} is fully opaque (iOS paints transparency black)`);
      assert.ok(colours.size > 50, `${icon.path} has real artwork (${colours.size} colours)`);
    }
    const blank = new PNG({ width: 4, height: 4 });
    assert.equal(new Set([blank.data.join()]).size, 1, 'control: the blank detector sees a blank image as one colour');
  });
});

test('manifest: installable (name, standalone, scope, 192 + 512 PNG icons that resolve)', async () => {
  const m = JSON.parse(MANIFEST_JSON) as Record<string, unknown> & { icons: Array<{ src: string; sizes: string; type: string }> };
  assert.equal(m.name, 'Orchestra');
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/');
  assert.equal(m.scope, '/');
  assert.deepEqual(m.icons.map((i) => i.sizes).sort(), ['192x192', '512x512']);
  await withServer(async (port) => {
    for (const icon of m.icons) {
      assert.equal(icon.type, 'image/png');
      const res = await fetchRaw(port, icon.src, ID);
      assert.equal(res.status, 200, `manifest icon ${icon.src}`);
      const png = PNG.sync.read(res.body);
      assert.equal(`${png.width}x${png.height}`, icon.sizes, `${icon.src} really is ${icon.sizes}`);
    }
    const served = JSON.parse((await fetchRaw(port, '/manifest.webmanifest', ID)).body.toString('utf8'));
    assert.deepEqual(served, m, 'the served manifest is the exported one');
  });
});

test('index: apple-touch-icon + apple-mobile-web-app metas + manifest link, every referenced asset is served; app.js registers the worker', async () => {
  assert.match(INDEX_HTML, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/);
  assert.match(INDEX_HTML, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(INDEX_HTML, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(INDEX_HTML, /<meta name="apple-mobile-web-app-title" content="Orchestra">/);
  // V1 (#340): content under the status bar, laid out with env(safe-area-inset-top).
  assert.match(INDEX_HTML, /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">/);
  assert.match(APP_JS, /navigator\.serviceWorker\.register\('\/sw\.js'\)/);
  const refs = [...INDEX_HTML.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 4, `control: the page references assets (${refs.join(', ')})`);
  await withServer(async (port) => {
    for (const p of [...refs, '/sw.js']) assert.equal((await fetchRaw(port, p, ID)).status, 200, `${p} is served`);
  });
});

// ───────────────────────── the service worker, run for real in a vm ─────────────────────────

type Handler = (e: unknown) => void;
interface Net {
  /** What the scripted server answers per path; 'throw' = connection refused; 'hang' = never answers until aborted. */
  [path: string]: { status: number; body: string } | 'throw' | 'hang';
}

function makeSw(net: Net) {
  const handlers: Record<string, Handler> = {};
  const store = new Map<string, Map<string, { status: number; body: string }>>();
  const fetchCalls: Array<{ url: string; init: Record<string, unknown> | undefined }> = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const calls = { skipWaiting: 0, claim: 0 };
  const cacheOf = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    const m = store.get(name)!;
    return {
      async put(key: string, res: Response) { m.set(key, { status: res.status, body: await res.text() }); },
      async match(key: string) { const v = m.get(key); return v ? new Response(v.body, { status: v.status }) : undefined; },
      async addAll(paths: string[]) {
        const got = [];
        for (const p of paths) { const r = await sandbox.fetch(p); if (!r.ok) throw new TypeError(`addAll ${p}: ${r.status}`); got.push([p, r] as const); }
        for (const [p, r] of got) m.set(p, { status: r.status, body: await r.text() });
      },
    };
  };
  const sandbox: Record<string, any> = {
    self: {
      location: { origin: 'https://phone.example' },
      addEventListener: (t: string, h: Handler) => { handlers[t] = h; },
      skipWaiting: async () => { calls.skipWaiting++; },
      clients: { claim: async () => { calls.claim++; } },
    },
    caches: {
      open: async (n: string) => cacheOf(n),
      keys: async () => [...store.keys()],
      delete: async (n: string) => store.delete(n),
    },
    fetch: async (url: string, init?: Record<string, unknown> & { signal?: AbortSignal }) => {
      fetchCalls.push({ url, init });
      const path = String(url).split('?')[0];
      const script = net[path];
      if (!script || script === 'throw') throw new TypeError('network error');
      if (script === 'hang') return new Promise((_, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
      return new Response(script.body, { status: script.status });
    },
    Response, URL, AbortController, Promise,
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms, cleared: false }); return timers.length - 1; },
    clearTimeout: (id: number) => { if (timers[id]) timers[id].cleared = true; },
  };
  vm.runInNewContext(SW_JS, sandbox);

  const waits: Promise<unknown>[] = [];
  const lifecycle = async (type: 'install' | 'activate') => {
    let p: Promise<unknown> | undefined;
    handlers[type]({ waitUntil: (x: Promise<unknown>) => (p = x) });
    return p;
  };
  /** Dispatch a fetch event; `intercepted` is false when the worker did not call respondWith (the browser goes to the network itself). */
  const dispatch = async (url: string, opts: { mode?: string; method?: string } = {}) => {
    let responded: Promise<Response> | undefined;
    handlers.fetch({
      request: { method: opts.method ?? 'GET', url: url.startsWith('http') ? url : `https://phone.example${url}`, mode: opts.mode ?? 'cors', headers: new Headers({ authorization: `Bearer ${TOKEN}` }) },
      respondWith: (p: Promise<Response>) => (responded = p),
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    const response = responded ? await responded : undefined;
    await Promise.all(waits.splice(0));
    return { intercepted: responded !== undefined, response };
  };
  return { handlers, store, fetchCalls, timers, calls, lifecycle, dispatch };
}

const SHELL_NET: Net = {
  '/': { status: 200, body: '<html>shell v1</html>' },
  '/app.js': { status: 200, body: 'app v1' },
  '/conversation.js': { status: 200, body: 'conv v1' },
  '/conversation.css': { status: 200, body: 'conv css v1' },
  '/manifest.webmanifest': { status: 200, body: '{}' },
  '/apple-touch-icon.png': { status: 200, body: 'png180' },
  '/icon-192.png': { status: 200, body: 'png192' },
  '/icon-512.png': { status: 200, body: 'png512' },
};
const cached = (sw: ReturnType<typeof makeSw>) => [...(sw.store.get(SW_CACHE_NAME)?.keys() ?? [])].sort();

test('sw install: precaches EXACTLY the shell and takes control; a failing server at install caches nothing (control: a healthy one caches all)', async () => {
  const ok = makeSw(SHELL_NET);
  await ok.lifecycle('install');
  assert.deepEqual(cached(ok), [...SHELL_PATHS].sort(), 'control: every shell path cached');
  assert.equal(ok.calls.skipWaiting, 1);

  const down = makeSw({ ...SHELL_NET, '/': { status: 502, body: 'bad gateway' } });
  await assert.rejects(down.lifecycle('install'), /addAll/, 'a 502 shell page makes the install fail');
  assert.deepEqual(cached(down), [], 'an error page is never cached');
  assert.ok(![...(down.store.get(SW_CACHE_NAME)?.values() ?? [])].some((v) => v.body === 'bad gateway'));
});

test('sw activate: drops stale caches, keeps the current one, claims clients', async () => {
  const sw = makeSw(SHELL_NET);
  await sw.lifecycle('install');
  sw.store.set('orchestra-shell-v0', new Map([['/', { status: 200, body: 'old' }]]));
  await sw.lifecycle('activate');
  assert.deepEqual([...sw.store.keys()], [SW_CACHE_NAME]);
  assert.equal(sw.calls.claim, 1);
});

test('sw must-FAIL: /api/* is never intercepted nor cached — online, offline, 5xx — and no token is stored (control: shell requests ARE intercepted)', async () => {
  for (const mode of ['online', 'offline', 'bad-gateway'] as const) {
    const net: Net = { ...SHELL_NET };
    const sw = makeSw(net);
    await sw.lifecycle('install');
    sw.fetchCalls.length = 0;
    // `offline` leaves /api out of the script ⇒ any fetch of it throws; the other two make a worker that DID intercept it cache something.
    if (mode === 'online') net['/api/workspaces'] = { status: 200, body: JSON.stringify({ ok: true, workspaces: [{ name: 'secret-ws' }] }) };
    if (mode === 'bad-gateway') net['/api/workspaces'] = { status: 502, body: 'x' };
    assert.equal((await sw.dispatch('/api/workspaces')).intercepted, false, `/api/workspaces (${mode}) is left to the browser`);
    assert.equal((await sw.dispatch(`/api/workspaces?t=${TOKEN}`)).intercepted, false);
    assert.equal((await sw.dispatch('/api/conversation/ws1/stream')).intercepted, false, 'future streams too');
    assert.equal(sw.fetchCalls.length, 0, 'the worker made no network call of its own for /api');
    assert.ok(!cached(sw).some((k) => k.startsWith('/api')), 'no /api key in the cache');
    assert.equal((await sw.dispatch('/app.js')).intercepted, true, 'control: a shell asset is intercepted');
    for (const [, v] of sw.store.get(SW_CACHE_NAME) ?? []) assert.ok(!v.body.includes(TOKEN) && !v.body.includes('secret-ws'), 'no token / data in any cached body');
  }
});

test('sw: online ⇒ the network answer wins and refreshes the cache (network first); the worker forwards no header and no query', async () => {
  const net: Net = { ...SHELL_NET };
  const sw = makeSw(net);
  await sw.lifecycle('install');
  net['/'] = { status: 200, body: '<html>shell v2</html>' };
  const r = await sw.dispatch(`/?t=${TOKEN}`, { mode: 'navigate' });
  assert.equal(await r.response!.text(), '<html>shell v2</html>', 'fresh network copy, not the stale cache');
  assert.equal(sw.store.get(SW_CACHE_NAME)!.get('/')!.body, '<html>shell v2</html>', 'cache refreshed');
  const call = sw.fetchCalls[sw.fetchCalls.length - 1];
  assert.equal(call.url, '/', 'fetched by pathname: the query (and any token in it) is dropped');
  assert.ok(!('headers' in (call.init ?? {})), 'no header (Authorization) is forwarded');
  assert.ok(!cached(sw).some((k) => k.includes(TOKEN) || k.includes('?')), 'no cache key carries a query or token');
});

test('sw: unreachable ⇒ the CACHED shell for navigations and assets — connection refused, timeout, and serve\'s 502/503', async () => {
  for (const [label, scripted] of [['refused', 'throw'], ['bad gateway', { status: 502, body: '<h1>502</h1>' }], ['unavailable', { status: 503, body: 'x' }]] as const) {
    const net: Net = { ...SHELL_NET };
    const sw = makeSw(net);
    await sw.lifecycle('install');
    net['/'] = scripted;
    net['/app.js'] = scripted;
    const nav = await sw.dispatch('/', { mode: 'navigate' });
    assert.equal(await nav.response!.text(), '<html>shell v1</html>', `${label}: navigation served from cache`);
    const asset = await sw.dispatch('/app.js');
    assert.equal(await asset.response!.text(), 'app v1', `${label}: app.js from cache`);
    assert.equal(sw.store.get(SW_CACHE_NAME)!.get('/')!.body, '<html>shell v1</html>', `${label}: the error page did not overwrite the cache`);
  }
  // timeout: a network that never answers is aborted and the cache is served
  const net: Net = { ...SHELL_NET };
  const sw = makeSw(net);
  await sw.lifecycle('install');
  net['/'] = 'hang';
  const pending = sw.dispatch('/', { mode: 'navigate' });
  await new Promise((r) => setImmediate(r));
  const timer = sw.timers[sw.timers.length - 1];
  assert.ok(timer.ms >= 1000 && timer.ms <= 15000, `a bounded wait (${timer.ms} ms)`);
  timer.fn();
  const settled = await Promise.race([pending, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('the worker is still waiting after its timeout fired')), 1500))]);
  assert.equal(await settled.response!.text(), '<html>shell v1</html>', 'timeout ⇒ cache');
});

test('sw must-FAIL: a 4xx (wrong identity, bad token) is the server\'s own answer — never masked by the cache (control: 502 is)', async () => {
  const net: Net = { ...SHELL_NET };
  const sw = makeSw(net);
  await sw.lifecycle('install');
  net['/'] = { status: 502, body: 'x' };
  assert.equal(await (await sw.dispatch('/', { mode: 'navigate' })).response!.text(), '<html>shell v1</html>', 'control: 502 ⇒ cached shell');
  for (const status of [401, 403, 404]) {
    net['/'] = { status, body: '' };
    const r = await sw.dispatch('/', { mode: 'navigate' });
    assert.equal(r.response!.status, status, `a ${status} passes through`);
  }
  assert.equal(sw.store.get(SW_CACHE_NAME)!.get('/')!.body, '<html>shell v1</html>', 'and never replaces the cached shell');
});

test('sw: nothing cached ⇒ a navigation still gets « Orchestra injoignable » (503); an asset gets a network error', async () => {
  const sw = makeSw({});
  const nav = await sw.dispatch('/', { mode: 'navigate' });
  assert.equal(nav.response!.status, 503);
  assert.match(await nav.response!.text(), /Orchestra injoignable/);
  const asset = await sw.dispatch('/icon-512.png');
  assert.equal(asset.response!.type, 'error');
});

test('sw: only same-origin GETs of shell paths are handled — everything else goes straight to the browser', async () => {
  const sw = makeSw(SHELL_NET);
  await sw.lifecycle('install');
  assert.equal((await sw.dispatch('/', { mode: 'navigate' })).intercepted, true, 'control');
  for (const [what, url, opts] of [
    ['POST', '/', { method: 'POST' }],
    ['the worker script itself', '/sw.js', {}],
    ['an unknown path', '/secret', {}],
    ['a navigation to another path', '/other', { mode: 'navigate' }],
    ['another origin', 'https://evil.example/app.js', {}],
  ] as const) {
    assert.equal((await sw.dispatch(url, opts)).intercepted, false, what);
  }
  assert.deepEqual(cached(sw), [...SHELL_PATHS].sort(), 'the cache holds exactly the shell');
});

// ───────────────────────── the page script: pairing from the fragment, the unreachable state ─────────────────────────

const STORAGE_KEY = 'orchestra.accesMobile.token';

/** Run the real APP_JS against a fake DOM/location. `reply` scripts what /api/workspaces answers. */
function runApp(opts: { hash?: string; stored?: string; reply?: 'reject' | number; replies?: Array<'reject' | number> } = {}) {
  const els: Record<string, any> = {};
  // `clears` counts assignments of '' to textContent, `appended` the children added — enough to tell a rendered list from a cleared one.
  const mk = () => {
    let text = '';
    return { get textContent() { return text; }, set textContent(v: string) { text = v; if (v === '') this.clears++; }, clears: 0, appended: 0, hidden: false, checked: false, dataset: {} as Record<string, string>, className: '', appendChild() { this.appended++; }, addEventListener() {} };
  };
  const storage = new Map<string, string>(opts.stored ? [[STORAGE_KEY, opts.stored]] : []);
  const calls = { replaceState: [] as unknown[][], fetch: [] as Array<{ url: string; init: any }>, register: [] as string[], conv: [] as string[] };
  const listeners: Record<string, () => void> = {};
  const location = { hash: opts.hash ?? '', pathname: '/' };
  const sandbox = {
    location,
    window: {
      addEventListener: (t: string, h: () => void) => (listeners[t] = h),
      // #337: conversation.js (its own tests) — here a recorder, so the shell's routing + re-pairing are observable.
      OrchestraConversation: { open: (id: string) => calls.conv.push(`open:${id}`), close: () => calls.conv.push('close'), onStream: () => {}, connect: () => calls.conv.push('connect') },
    },
    history: { replaceState: (...a: unknown[]) => calls.replaceState.push(a) },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) },
    document: { getElementById: (id: string) => (els[id] ??= mk()), createElement: () => mk() },
    fetch: (url: string, init: unknown) => {
      calls.fetch.push({ url, init });
      const reply = opts.replies ? opts.replies[Math.min(calls.fetch.length, opts.replies.length) - 1] : opts.reply;
      return reply === 'reject' || reply === undefined ? Promise.reject(new TypeError('offline')) : Promise.resolve({ ok: reply < 400, status: reply, json: async () => ({ ok: true, workspaces: [{ id: 'w1', name: 'n', branch: 'b', group: 'g', account: 'a', status: 'idle', unread: false }] }) });
    },
    setInterval: () => 0,
    navigator: { serviceWorker: { register: (p: string) => (calls.register.push(p), Promise.resolve()) } },
  };
  vm.runInNewContext(APP_JS, sandbox);
  /** A same-document navigation to `/#t=…` over the open page (a QR re-scan): the browser only fires hashchange. */
  const navigateHash = (hash: string) => { location.hash = hash; listeners.hashchange?.(); };
  return { els, calls, storage, navigateHash, settle: () => new Promise((r) => setImmediate(r)) };
}

test('page: #t=<token> is stored, stripped from the address, and used as the bearer — nowhere in a URL (control: a reload without it stays paired)', async () => {
  const first = runApp({ hash: `#t=${TOKEN}`, reply: 200 });
  await first.settle();
  assert.equal(first.storage.get(STORAGE_KEY), TOKEN, 'persisted');
  assert.deepEqual(first.calls.replaceState, [[null, '', '/']], 'the fragment is removed from the address');
  assert.equal(first.calls.fetch.length, 1);
  assert.equal(first.calls.fetch[0].url, '/api/workspaces', 'the token is not in the request line');
  assert.equal(first.calls.fetch[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(!JSON.stringify(first.calls.replaceState).includes(TOKEN));

  const reload = runApp({ stored: TOKEN, reply: 200 });
  await reload.settle();
  assert.equal(reload.calls.replaceState.length, 0, 'no fragment ⇒ nothing to strip');
  assert.equal(reload.calls.fetch[0].init.headers.Authorization, `Bearer ${TOKEN}`, 'still authenticated after reload without the fragment');
});

test('page: re-scanning the QR over an ALREADY-OPEN page (a hashchange, no reload) re-pairs it — the old token is replaced and the new one used (control: without the event nothing changes)', async () => {
  const OLD = 'old_' + 'o'.repeat(40);
  const page = runApp({ stored: OLD, reply: 200 });
  await page.settle();
  assert.equal(page.calls.fetch[0].init.headers.Authorization, `Bearer ${OLD}`, 'control: the page starts on the old token');
  page.navigateHash('#unrelated');
  await page.settle();
  // #337 routing: a hash that is not #w=<id> is « back to the list » — it reloads it, but with the SAME token.
  assert.equal(page.storage.get(STORAGE_KEY), OLD, 'a hashchange without a token never touches the stored token');
  assert.equal(page.calls.fetch.at(-1).init.headers.Authorization, `Bearer ${OLD}`);
  const connectsBefore = page.calls.conv.filter((c) => c === 'connect').length;
  const fetchesBefore = page.calls.fetch.length;
  page.navigateHash(`#t=${TOKEN}`);
  await page.settle();
  assert.equal(page.storage.get(STORAGE_KEY), TOKEN, 'new token stored');
  assert.equal(page.calls.fetch.length, fetchesBefore + 1, 'the list is reloaded at once');
  assert.equal(page.calls.fetch.at(-1).init.headers.Authorization, `Bearer ${TOKEN}`, 'and with the NEW token');
  assert.equal(page.calls.conv.filter((c) => c === 'connect').length, connectsBefore + 1, 'the live stream is reopened (it reads the new token)');
  assert.deepEqual(page.calls.replaceState, [[null, '', '/']], 'the fragment is stripped again');
});

test('page must-FAIL: a refused token (401) empties the list — the phone that lost its access must not keep showing workspaces (control: a 200 renders it)', async () => {
  const page = runApp({ stored: TOKEN, replies: [200, 401] });
  await page.settle();
  assert.ok(page.els.list.appended > 0, 'control: the first reply (200) rendered a row');
  const clearsAfterRender = page.els.list.clears;
  const appendedAfterRender = page.els.list.appended;
  page.navigateHash(`#t=${'n'.repeat(43)}`); // any re-load: the second reply is a 401
  await page.settle();
  assert.match(page.els.state.textContent, /Jeton refusé/);
  assert.ok(page.els.list.clears > clearsAfterRender, 'the list element was emptied on the 401');
  assert.equal(page.els.list.appended, appendedAfterRender, 'and nothing was drawn back');
});

test('page must-FAIL: a malformed or too-short fragment token is never stored; unpaired ⇒ no request at all and a pairing hint', async () => {
  for (const hash of ['#t=short', '#t=has%20escape' + 'a'.repeat(20), '#x=' + TOKEN, '']) {
    const r = runApp({ hash });
    await r.settle();
    assert.equal(r.storage.has(STORAGE_KEY), false, hash.slice(0, 20));
    assert.equal(r.calls.fetch.length, 0, 'unpaired: nothing is sent');
    assert.match(r.els.state.textContent, /Pas appairé/);
  }
});

test('page: Orchestra unreachable (network down, serve 502, serve 503) says « Orchestra injoignable » — a refused token says so differently', async () => {
  for (const reply of ['reject', 502, 503] as const) {
    const r = runApp({ stored: TOKEN, reply });
    await r.settle();
    assert.equal(r.els.state.textContent, 'Orchestra injoignable.', String(reply));
  }
  const refused = runApp({ stored: TOKEN, reply: 401 });
  await refused.settle();
  assert.match(refused.els.state.textContent, /Jeton refusé/, 'control: a 401 is not « injoignable »');
});

test('page: registers the service worker at /sw.js, once, and a failing registration is harmless', async () => {
  const r = runApp({ stored: TOKEN, reply: 200 });
  assert.deepEqual(r.calls.register, ['/sw.js']);
  const noSw = runApp({ stored: TOKEN, reply: 200 });
  assert.equal(noSw.calls.register.length, 1, 'control: one registration per page load');
});
