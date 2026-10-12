// Accès mobile server — the LAUNCH route (#375/#376): the same arms as /api/send (identity, token, body), plus the rolling 10/min cap,
// the in-flight write bound it shares with send/answer, and a double submit through the REAL launcher.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAccesMobileServer, MAX_WRITES_IN_FLIGHT, type Upstream } from './server.ts';
import { createMobileLauncher } from '../main/acces-mobile-launch.ts';
import { MOBILE_LAUNCH_PER_WINDOW, MOBILE_LAUNCH_TIMEOUT_MS, MOBILE_LAUNCH_WINDOW_MS } from '../shared/acces-mobile-launch.ts';
import { MOBILE_SEND_MAX_BODY } from '../shared/acces-mobile-conversation.ts';

const LOGIN = 'lucas.mas@mobile.club';
const TOKEN = 'tok_' + 'a'.repeat(40);
const ID = { 'Tailscale-User-Login': LOGIN };
const AUTH = { ...ID, Authorization: `Bearer ${TOKEN}` };
const JSONH = { ...AUTH, 'Content-Type': 'application/json' };
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** BOUNDED wait: a mutant that stops a request reaching main must FAIL this suite fast, never hang it (a hang is reported SURVIVED). */
async function waitUntil(fn: () => boolean, what: string, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`waitUntil timed out: ${what}`);
    await sleepMs(10);
  }
}
const rid = (n: number) => `request-id-${String(n).padStart(8, '0')}`;
const REPO = '/home/u/orchestra';
const launchBody = (n: number, extra: Record<string, unknown> = {}) => JSON.stringify({ repoPath: REPO, prompt: 'fix the typo', requestId: rid(n), ...extra });

function call(port: number, method: string, p: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      res.on('error', () => resolve({ status: res.statusCode ?? -1, body: '' }));
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on('error', (e) => ((e as NodeJS.ErrnoException).code === 'EPIPE' || (e as NodeJS.ErrnoException).code === 'ECONNRESET' ? resolve({ status: -1, body: '' }) : reject(e)));
    req.end(body);
  });
}
const postLaunch = (port: number, headers: Record<string, string>, body: string) => call(port, 'POST', '/api/launch', headers, body);

interface Rig {
  port: number;
  calls: { route: string; body: Record<string, unknown>; timeoutMs?: number }[];
  logs: string[];
  clock: { t: number };
  close: () => Promise<void>;
}
async function rig(opts: { upstream?: Upstream; allowedLogin?: string } = {}): Promise<Rig> {
  const calls: Rig['calls'] = [];
  const logs: string[] = [];
  const clock = { t: 1_000_000 };
  const server = createAccesMobileServer({
    allowedLogin: opts.allowedLogin ?? LOGIN,
    readToken: () => TOKEN,
    upstream: opts.upstream ?? (async (route, body, timeoutMs) => (calls.push({ route, body, timeoutMs }), { ok: true, id: 'ws-1' })),
    log: (l) => logs.push(l),
    now: () => clock.t,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    calls,
    logs,
    clock,
    close: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

test('launch: relayed to main as exactly {repoPath, prompt, requestId} with a long timeout; the answer comes back', { timeout: 15_000 }, async () => {
  const r = await rig();
  try {
    const res = await postLaunch(r.port, JSONH, launchBody(1, { prompt: '  fix the typo \n', model: 'opus', branch: 'x', accountId: 'a', parentId: 'p', attachments: [], kind: 'orchestrator' }));
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true, id: 'ws-1' });
    assert.deepEqual(r.calls, [{ route: '/mobile/launch', body: { repoPath: REPO, prompt: 'fix the typo', requestId: rid(1) }, timeoutMs: MOBILE_LAUNCH_TIMEOUT_MS }]);
    assert.ok(MOBILE_LAUNCH_TIMEOUT_MS >= 45_000, 'a worktree + a cold first turn take longer than a send');
  } finally {
    await r.close();
  }
});

test('must-FAIL: no identity ⇒ 403, wrong/colleague identity ⇒ 403, no allowed login configured ⇒ 403 — main never reached (control: the owner launches)', { timeout: 15_000 }, async () => {
  const r = await rig();
  try {
    assert.equal((await postLaunch(r.port, JSONH, launchBody(1))).status, 200, 'control');
    const noId = await postLaunch(r.port, { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, launchBody(2));
    assert.equal(noId.status, 403, 'no Tailscale identity');
    assert.equal((await postLaunch(r.port, { 'Tailscale-User-Login': 'colleague@mobile.club', Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, launchBody(3))).status, 403, 'a colleague WITH the token');
    assert.equal((await postLaunch(r.port, { 'Tailscale-User-Login': '', Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, launchBody(4))).status, 403, 'empty identity');
    assert.equal(r.calls.length, 1, 'only the control reached main');
  } finally {
    await r.close();
  }
  const open = await rig({ allowedLogin: '' });
  try {
    assert.equal((await postLaunch(open.port, JSONH, launchBody(5))).status, 403, 'fail closed without an allowed login');
    assert.equal(open.calls.length, 0);
  } finally {
    await open.close();
  }
});

test('must-FAIL: no token ⇒ 401, bad token ⇒ 401, the token in the query string ⇒ 401 — main never reached', { timeout: 15_000 }, async () => {
  const r = await rig();
  try {
    assert.equal((await postLaunch(r.port, JSONH, launchBody(1))).status, 200, 'control');
    assert.equal((await postLaunch(r.port, { ...ID, 'Content-Type': 'application/json' }, launchBody(2))).status, 401, 'no token');
    assert.equal((await postLaunch(r.port, { ...ID, Authorization: `Bearer ${'b'.repeat(44)}`, 'Content-Type': 'application/json' }, launchBody(3))).status, 401, 'wrong token');
    assert.equal((await postLaunch(r.port, { ...ID, Authorization: `Bearer ${TOKEN}x`, 'Content-Type': 'application/json' }, launchBody(4))).status, 401, 'prefix of the token is not the token');
    const viaQuery = await call(r.port, 'POST', `/api/launch?t=${TOKEN}&token=${TOKEN}`, { ...ID, 'Content-Type': 'application/json' }, launchBody(5));
    assert.equal(viaQuery.status, 401, 'a query-string token is ignored');
    assert.equal(r.calls.length, 1);
  } finally {
    await r.close();
  }
});

test('launch: POST only with a JSON body ≤ 128 KB; a GET is not a launch; a refused body never reaches main', { timeout: 15_000 }, async () => {
  const r = await rig();
  try {
    assert.equal((await postLaunch(r.port, JSONH, launchBody(1))).status, 200, 'control');
    assert.equal((await call(r.port, 'GET', '/api/launch', AUTH)).status, 404, 'GET is not a launch');
    assert.equal((await call(r.port, 'PUT', '/api/launch', JSONH, launchBody(2))).status, 405);
    assert.equal((await postLaunch(r.port, { ...AUTH, 'Content-Type': 'text/plain' }, launchBody(3))).status, 415, 'not JSON');
    assert.equal((await postLaunch(r.port, JSONH, 'not json')).status, 400);
    assert.equal((await postLaunch(r.port, JSONH, '[]')).status, 400, 'an array is not a launch');
    const big = await postLaunch(r.port, JSONH, JSON.stringify({ repoPath: REPO, prompt: 'x'.repeat(MOBILE_SEND_MAX_BODY), requestId: rid(4) }));
    assert.equal(big.status, 413, 'the 128 KB body cap (the attachment cap is /api/send only)');
    assert.equal(r.calls.length, 1);
  } finally {
    await r.close();
  }
});

test('must-FAIL: an empty / blank prompt, a missing repo path or a missing/odd request id ⇒ 400 and nothing is relayed', { timeout: 15_000 }, async () => {
  const r = await rig();
  try {
    assert.equal((await postLaunch(r.port, JSONH, launchBody(1))).status, 200, 'control');
    const bad = [
      { repoPath: REPO, prompt: '', requestId: rid(2) },
      { repoPath: REPO, prompt: '   \n', requestId: rid(3) },
      { repoPath: REPO, requestId: rid(4) },
      { prompt: 'x', requestId: rid(5) },
      { repoPath: '', prompt: 'x', requestId: rid(6) },
      { repoPath: REPO, prompt: 'x' },
      { repoPath: REPO, prompt: 'x', requestId: 'short' },
      { repoPath: REPO, prompt: 'x', requestId: 'has spaces and symbols !!!!!!' },
      { repoPath: REPO, prompt: 7, requestId: rid(7) },
    ];
    for (const b of bad) assert.equal((await postLaunch(r.port, JSONH, JSON.stringify(b))).status, 400, JSON.stringify(b));
    assert.equal(r.calls.length, 1, 'only the control reached main');
  } finally {
    await r.close();
  }
});

test('#376 must-FAIL: the 11th launch inside a minute ⇒ 429, nothing reaches main, ONE rate-limited log line; a slot frees as the window rolls', { timeout: 20_000 }, async () => {
  const r = await rig();
  try {
    for (let i = 1; i <= MOBILE_LAUNCH_PER_WINDOW; i++) {
      assert.equal((await postLaunch(r.port, JSONH, launchBody(i))).status, 200, `launch ${i}`);
      r.clock.t += 1000;
    }
    assert.equal(r.calls.length, MOBILE_LAUNCH_PER_WINDOW);
    const eleventh = await postLaunch(r.port, JSONH, launchBody(11));
    assert.equal(eleventh.status, 429);
    assert.equal(eleventh.body, '', 'a bare refusal');
    assert.equal(r.calls.length, MOBILE_LAUNCH_PER_WINDOW, 'the 11th never reached main (nothing is created)');
    assert.deepEqual(r.logs.filter((l) => /launch-rate/.test(l)), ['refused 429 launch-rate POST /api/launch'], 'one log line, no header value, no prompt');
    // a refused request still answers the OTHER routes: reads and sends are not launches
    assert.equal((await call(r.port, 'GET', '/api/workspaces', AUTH)).status, 200, 'reads are not capped by launches');
    assert.equal((await call(r.port, 'POST', '/api/send?id=w1', JSONH, '{"text":"hi"}')).status, 200, 'a send is not a launch');
    // rolling: the first launch was at t0, the clock is now t0+10s ⇒ jump to t0+60s ⇒ exactly one slot
    r.clock.t = 1_000_000 + MOBILE_LAUNCH_WINDOW_MS;
    assert.equal((await postLaunch(r.port, JSONH, launchBody(12))).status, 200, 'the oldest aged out');
    assert.equal((await postLaunch(r.port, JSONH, launchBody(13))).status, 429, 'and only one slot');
  } finally {
    await r.close();
  }
});

test('#376: a launch the server refuses BEFORE relaying (400, 401, 403) does not spend the minute\'s budget', { timeout: 20_000 }, async () => {
  const r = await rig();
  try {
    for (let i = 0; i < 25; i++) {
      assert.equal((await postLaunch(r.port, JSONH, JSON.stringify({ repoPath: REPO, prompt: '', requestId: rid(i) }))).status, 400);
      assert.equal((await postLaunch(r.port, { ...ID, 'Content-Type': 'application/json' }, launchBody(i))).status, 401);
    }
    for (let i = 1; i <= MOBILE_LAUNCH_PER_WINDOW; i++) assert.equal((await postLaunch(r.port, JSONH, launchBody(100 + i))).status, 200, `launch ${i} after 50 refusals`);
    assert.equal((await postLaunch(r.port, JSONH, launchBody(200))).status, 429);
  } finally {
    await r.close();
  }
});

test('launch counts in the in-flight write bound shared with send/answer: at most MAX_WRITES_IN_FLIGHT wait on main; a refusal there spends no launch budget', { timeout: 20_000 }, async () => {
  const releases: (() => void)[] = [];
  let reached = 0;
  const r = await rig({
    upstream: (route) => {
      if (route === '/mobile/launch' || route === '/mobile/send') {
        reached++;
        return new Promise((res) => releases.push(() => res({ ok: true, id: 'ws-1' })));
      }
      return Promise.resolve({ ok: true });
    },
  });
  try {
    // two sends + two launches fill the bound: the counter is SHARED
    const held = [
      call(r.port, 'POST', '/api/send?id=w1', JSONH, '{"text":"a"}'),
      call(r.port, 'POST', '/api/send?id=w1', JSONH, '{"text":"b"}'),
      postLaunch(r.port, JSONH, launchBody(1)),
      postLaunch(r.port, JSONH, launchBody(2)),
    ];
    await waitUntil(() => reached >= MAX_WRITES_IN_FLIGHT, 'four writes reached main');
    const extra = await Promise.race([postLaunch(r.port, JSONH, launchBody(3)), sleepMs(2000).then(() => ({ status: 'queued instead of refused' }))]);
    assert.equal(extra.status, 429, 'a launch past the bound is refused, not queued');
    assert.equal(reached, MAX_WRITES_IN_FLIGHT, 'it never reached main');
    assert.deepEqual(r.logs.filter((l) => /too-many-writes/.test(l)), ['refused 429 too-many-writes POST /api/launch']);
    const sendExtra = await call(r.port, 'POST', '/api/send?id=w1', JSONH, '{"text":"c"}');
    assert.equal(sendExtra.status, 429, 'and a send past the bound is refused by the launches holding slots');
    releases.splice(0).forEach((f) => f());
    for (const h of held) assert.equal((await h).status, 200);
    // the 429-by-bound launches spent no budget: 2 held launches + 10 more would be 12 if they counted; only 2 were admitted
    for (let i = 0; i < MOBILE_LAUNCH_PER_WINDOW - 2; i++) {
      const p = postLaunch(r.port, JSONH, launchBody(300 + i));
      await waitUntil(() => reached >= MAX_WRITES_IN_FLIGHT + i + 1, `launch ${i + 3} reached main`);
      releases.splice(0).forEach((f) => f());
      assert.equal((await p).status, 200, `launch ${i + 3}`);
    }
    const last = await Promise.race([postLaunch(r.port, JSONH, launchBody(400)), sleepMs(1500).then(() => ({ status: 'admitted: waiting on main' }))]);
    assert.equal(last.status, 429, 'the 11th ADMITTED launch');
  } finally {
    releases.splice(0).forEach((f) => f());
    await r.close();
  }
});

test('repos: GET /api/repos relays /mobile/repos behind identity + token (control + refusals)', { timeout: 15_000 }, async () => {
  const r = await rig({
    upstream: async (route) => (route === '/mobile/repos' ? { ok: true, repos: [{ path: REPO, name: 'orchestra', account: 'perso' }] } : { ok: true }),
  });
  try {
    const ok = await call(r.port, 'GET', '/api/repos', AUTH);
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { ok: true, repos: [{ path: REPO, name: 'orchestra', account: 'perso' }] });
    assert.equal((await call(r.port, 'GET', '/api/repos', ID)).status, 401, 'no token');
    assert.equal((await call(r.port, 'GET', '/api/repos', { 'Tailscale-User-Login': 'colleague@mobile.club', Authorization: `Bearer ${TOKEN}` })).status, 403, 'colleague');
    assert.equal((await call(r.port, 'POST', '/api/repos', JSONH, '{}')).status, 405, 'not a write route');
  } finally {
    await r.close();
  }
});

test('#376 must-FAIL, through the REAL launcher: a double tap (two POSTs, same request id, the first still creating) makes ONE workspace and both responses carry its id', { timeout: 20_000 }, async () => {
  const releases: (() => void)[] = [];
  const release = () => releases.splice(0).forEach((f) => f());
  const spawned: string[] = [];
  const launcher = createMobileLauncher({
    repos: () => [{ path: REPO }],
    spawn: async ({ task }) => {
      const n = spawned.push(task);
      await new Promise<void>((res) => releases.push(res));
      return { ok: true, id: `ws-${n}`, branch: 'quiet-fox' };
    },
  });
  const r = await rig({ upstream: async (route, body) => (route === '/mobile/launch' ? launcher.launch(body) : { ok: true }) });
  try {
    const a = postLaunch(r.port, JSONH, launchBody(1));
    const b = postLaunch(r.port, JSONH, launchBody(1));
    await waitUntil(() => spawned.length >= 1, 'the first creation started');
    await sleepMs(150); // the second request has had every chance to start a second creation
    assert.equal(spawned.length, 1, 'one creation for two taps');
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual([ra.status, rb.status], [200, 200]);
    assert.deepEqual(JSON.parse(ra.body), { ok: true, id: 'ws-1', branch: 'quiet-fox' });
    assert.deepEqual(JSON.parse(rb.body), JSON.parse(ra.body), 'both responses carry the one id');
    // control: a different request id is a different launch
    const c = postLaunch(r.port, JSONH, launchBody(2));
    await waitUntil(() => spawned.length >= 2, 'the second launch started');
    release();
    assert.deepEqual(JSON.parse((await c).body).id, 'ws-2');
  } finally {
    release();
    await r.close();
  }
});

test('must-FAIL, through the REAL launcher: an unregistered repo is refused with nothing created (control: a registered one is)', { timeout: 15_000 }, async () => {
  const spawned: string[] = [];
  const launcher = createMobileLauncher({ repos: () => [{ path: REPO }], spawn: async ({ repoPath }) => (spawned.push(repoPath), { ok: true, id: 'ws-1' }) });
  const r = await rig({ upstream: async (route, body) => (route === '/mobile/launch' ? launcher.launch(body) : { ok: true }) });
  try {
    assert.equal(JSON.parse((await postLaunch(r.port, JSONH, launchBody(1))).body).ok, true, 'control');
    const out = await postLaunch(r.port, JSONH, JSON.stringify({ repoPath: '/etc', prompt: 'x', requestId: rid(2) }));
    assert.deepEqual(JSON.parse(out.body), { ok: false, code: 'unknown-repo', error: 'unknown repo' });
    assert.deepEqual(spawned, [REPO], 'nothing was created for /etc');
  } finally {
    await r.close();
  }
});

test('the launch screen assets are behind the identity check like every shell asset, and carry no token (control: the owner gets them)', { timeout: 15_000 }, async () => {
  const r = await rig();
  try {
    for (const p of ['/launch.js', '/launch.css']) {
      const ok = await call(r.port, 'GET', p, ID);
      assert.equal(ok.status, 200, `control: ${p}`);
      assert.ok(ok.body.length > 500 && !ok.body.includes(TOKEN) && !ok.body.includes(LOGIN), 'a real asset with no secret in it');
      assert.equal((await call(r.port, 'GET', p, {})).status, 403, `${p}: no identity`);
      assert.equal((await call(r.port, 'GET', p, { 'Tailscale-User-Login': 'colleague@mobile.club' })).status, 403, `${p}: a colleague`);
    }
    assert.match((await call(r.port, 'GET', '/', ID)).body, /id="newBtn"[^>]*aria-label="Nouveau workspace"[\s\S]*id="launch"[\s\S]*<script src="\/launch\.js"><\/script>[\s\S]*<script src="\/app\.js">/, 'the shell carries the « + », the launch root and loads launch.js before app.js');
  } finally {
    await r.close();
  }
});
