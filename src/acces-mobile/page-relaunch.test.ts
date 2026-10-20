// « Relancer Orchestra » from the phone (Lucas 2026-10-20): the REAL APP_JS in a vm against page-dom.ts's DOM + a scripted network and
// clock. Pins: confirm before anything is sent, ONE request per confirmation, « relancé » only once a NEW app (another startedAt)
// answers — never on a stream blip —, every refusal says the app still runs, a lost reply waits, 2 min without an answer says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { APP_JS } from './page.ts';
import { El, first } from './page-dom.ts';

const TOKEN = 't'.repeat(43);
type Reply = { status: number; body?: unknown } | 'reject';

function run(opts: { update?: { version: string | null } } = {}) {
  const els: Record<string, El> = {};
  const get = (id: string): El => (els[id] ??= new El());
  let app = { version: '0.5.347', startedAt: 1000 };
  let listUp = true;
  const relaunchReplies: Reply[] = [];
  const posts: { url: string; method?: string; auth?: string }[] = [];
  let clock = 50_000;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; every?: number; f: () => void }>();
  let stream: ((m: unknown) => void) | null = null;
  const reply = (r: Reply) => (r === 'reject' ? Promise.reject(new Error('net')) : Promise.resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body }));
  const sandbox = {
    location: { hash: '', pathname: '/' },
    window: { addEventListener: () => {}, OrchestraConversation: { open: () => {}, close: () => {}, onStream: (h: (m: unknown) => void) => { stream = h; }, connect: () => {} } },
    history: { replaceState: () => {} },
    localStorage: { getItem: () => TOKEN, setItem: () => {} },
    document: { getElementById: get, createElement: (tag: string) => new El(tag), createTextNode: (t: string) => { const e = new El('#text'); e.textContent = t; return e; } },
    fetch: (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
      if (url === '/api/relaunch') {
        posts.push({ url, method: init.method, auth: init.headers?.Authorization });
        return reply(relaunchReplies.shift() ?? { status: 200, body: { ok: true } });
      }
      if (!listUp) return Promise.reject(new Error('down'));
      return reply({ status: 200, body: { ok: true, workspaces: [], app, ...(opts.update ? { appUpdate: opts.update } : {}) } });
    },
    Date: { now: () => clock },
    setInterval: (f: () => void, ms: number) => { const id = nextTimer++; timers.set(id, { at: clock + ms, every: ms, f }); return id; },
    clearInterval: (id: number) => timers.delete(id),
    setTimeout: (f: () => void, ms: number) => { const id = nextTimer++; timers.set(id, { at: clock + ms, f }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    navigator: { standalone: false, serviceWorker: { register: () => Promise.resolve() } },
  };
  vm.runInNewContext(APP_JS, sandbox);
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
  /** Advance the clock, firing every due timer (intervals re-armed). */
  const advance = async (ms: number) => {
    const end = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, t] = due;
      clock = t.at;
      if (t.every) t.at += t.every; else timers.delete(id);
      t.f();
      await settle();
    }
    clock = end;
  };
  const panel = () => ({ state: get('relaunch').dataset.state, hidden: get('relaunch').hidden, msg: get('rlMsg').textContent, go: !get('rlGo').hidden, cancel: get('rlCancel').hidden ? null : get('rlCancel').textContent });
  return {
    els, get, posts, relaunchReplies, settle, advance, panel,
    tap: async (id: string) => { get(id).click(); await settle(); },
    newApp: (version: string, startedAt: number) => { app = { version, startedAt }; },
    setListUp: (up: boolean) => { listUp = up; },
    stream: async (m: unknown) => { stream?.(m); await settle(); },
  };
}

test('relaunch: the ↻ only opens a confirmation — nothing is sent; « Annuler » closes it', async () => {
  const p = run();
  await p.settle();
  assert.equal(p.panel().hidden, true, 'closed at boot');
  await p.tap('relaunchBtn');
  assert.equal(p.panel().state, 'confirm');
  assert.match(p.panel().msg, /^Relancer Orchestra \? .*les agents continuent\. Si elle ne redémarre pas, seul l’ordinateur pourra la relancer\.$/);
  assert.equal(p.posts.length, 0, 'opening is not relaunching');
  await p.tap('rlCancel');
  assert.deepEqual([p.panel().state, p.panel().hidden, p.posts.length], ['idle', true, 0]);
});

test('relaunch: « Relancer » sends ONE authenticated POST (a double tap too), waits, and says « relancé » only once a NEW app answers', async () => {
  const p = run();
  await p.settle();
  await p.tap('relaunchBtn');
  p.get('rlGo').click(); p.get('rlGo').click();
  await p.settle();
  assert.deepEqual(p.posts, [{ url: '/api/relaunch', method: 'POST', auth: `Bearer ${TOKEN}` }], 'one request, bearer token, POST');
  assert.equal(p.panel().state, 'wait');
  assert.match(p.panel().msg, /Orchestra redémarre… Le téléphone se reconnecte tout seul\./);
  // the old app still answers (its quit is 500 ms away), then the stream drops and comes back on the SAME app (a blip): still waiting
  await p.advance(3000);
  await p.stream({ t: 'down' });
  await p.stream({ t: 'resume' });
  assert.equal(p.panel().state, 'wait', 'the same startedAt is not a relaunch');
  // down while it restarts, then the new app answers
  p.setListUp(false);
  await p.advance(9000);
  assert.equal(p.panel().state, 'wait');
  p.setListUp(true); p.newApp('0.5.348', 99_000);
  await p.advance(3000);
  assert.equal(p.panel().state, 'done');
  assert.equal(p.panel().msg, 'Orchestra relancé (v0.5.348).');
  await p.advance(8000);
  assert.deepEqual([p.panel().state, p.panel().hidden], ['idle', true], 'the note goes away by itself');
  assert.equal(p.posts.length, 1, 'waiting never re-sends');
});

test('relaunch: a refusal from main says why and that Orchestra still runs; « Réessayer » sends again', async () => {
  const p = run();
  await p.settle();
  p.relaunchReplies.push({ status: 200, body: { ok: false, code: 'no-installed-app', error: 'pas d’app installée à relancer (build de développement)' } });
  await p.tap('relaunchBtn');
  await p.tap('rlGo');
  assert.equal(p.panel().state, 'error');
  assert.equal(p.panel().msg, 'Relance impossible : pas d’app installée à relancer (build de développement). Orchestra tourne toujours.');
  assert.equal(p.get('rlGo').textContent, 'Réessayer');
  await p.tap('rlGo');
  assert.equal(p.posts.length, 2);
  assert.equal(p.panel().state, 'wait', 'control: the retry was accepted');
});

test('relaunch: 429 / 4xx are refusals; a 502 or a lost reply WAITS (the quit may have cut the answer); 401 ⇒ the pairing', async () => {
  for (const [r, state, msg] of [
    [{ status: 429 }, 'error', /Trop de demandes/],
    [{ status: 400 }, 'error', /Relance refusée \(400\) : rien n’a été relancé\./],
    [{ status: 502 }, 'wait', /^Réponse perdue : Orchestra redémarre peut-être\./],
    ['reject', 'wait', /^Réponse perdue/],
  ] as const) {
    const p = run();
    await p.settle();
    p.relaunchReplies.push(r as Reply);
    await p.tap('relaunchBtn');
    await p.tap('rlGo');
    assert.equal(p.panel().state, state, JSON.stringify(r));
    assert.match(p.panel().msg, msg);
  }
  const p = run();
  await p.settle();
  p.relaunchReplies.push({ status: 401 });
  await p.tap('relaunchBtn');
  await p.tap('rlGo');
  assert.equal(p.panel().state, 'idle');
});

test('relaunch: no new app for 2 min ⇒ it says the relaunch may have failed, keeps waiting, and still ends when the app comes back', async () => {
  const p = run();
  await p.settle();
  await p.tap('relaunchBtn');
  await p.tap('rlGo');
  p.setListUp(false);
  await p.advance(118_000);
  assert.equal(p.panel().state, 'wait', 'control: not yet');
  await p.advance(6000);
  assert.equal(p.panel().state, 'late');
  assert.match(p.panel().msg, /la relance a peut-être échoué\. Vérifie sur l’ordinateur/);
  await p.tap('relaunchBtn');
  assert.equal(p.panel().state, 'late', 'the ↻ cannot start a second relaunch while one is awaited');
  p.setListUp(true); p.newApp('0.5.347', 200_000);
  await p.advance(3000);
  assert.equal(p.panel().state, 'done');
});

test('relaunch: a newer install ⇒ the banner carries « Relancer », which opens the SAME confirmation naming the version', async () => {
  const p = run({ update: { version: '0.5.999' } });
  await p.settle();
  const banner = p.get('appUpdate');
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /^Nouvelle version d’Orchestra installée \(v0\.5\.999\)\.Relancer$/);
  const go = first(banner, (e) => e.tag === 'button' && e.has('upd-go'))!;
  go.click();
  await p.settle();
  assert.equal(p.panel().state, 'confirm');
  assert.match(p.panel().msg, /^Relancer Orchestra en v0\.5\.999 \?/);
  assert.equal(p.posts.length, 0);
  const quiet = run();
  await quiet.settle();
  assert.equal(quiet.get('appUpdate').hidden, true, 'control: no install, no banner');
});
