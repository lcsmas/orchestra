// Accès mobile server — the LAUNCH route (#375): the same arms as /api/send (identity, token, body), plus the in-flight write bound it
// shares with send/answer, and an unregistered repo through the REAL launcher.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAccesMobileServer, MAX_WRITES_IN_FLIGHT, type Upstream } from './server.ts';
import { createMobileLauncher } from '../main/acces-mobile-launch.ts';
import { MOBILE_LAUNCH_TIMEOUT_MS } from '../shared/acces-mobile-launch.ts';
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
const REPO = '/home/u/orchestra';
const launchBody = (_n: number, extra: Record<string, unknown> = {}) => JSON.stringify({ repoPath: REPO, prompt: 'fix the typo', ...extra });

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
  close: () => Promise<void>;
}
async function rig(opts: { upstream?: Upstream; allowedLogin?: string } = {}): Promise<Rig> {
  const calls: Rig['calls'] = [];
  const logs: string[] = [];
  const server = createAccesMobileServer({
    allowedLogin: opts.allowedLogin ?? LOGIN,
    readToken: () => TOKEN,
    upstream: opts.upstream ?? (async (route, body, timeoutMs) => (calls.push({ route, body, timeoutMs }), { ok: true, id: 'ws-1' })),
    log: (l) => logs.push(l),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    calls,
    logs,
    close: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

test('launch: relayed to main as exactly {repoPath, prompt} with a long timeout; the answer comes back', { timeout: 15_000 }, async () => {
  const r = await rig();
  try {
    const res = await postLaunch(r.port, JSONH, launchBody(1, { prompt: '  fix the typo \n', model: 'opus', branch: 'x', accountId: 'a', parentId: 'p', attachments: [], kind: 'orchestrator', requestId: 'whatever-0123456789' }));
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true, id: 'ws-1' });
    assert.deepEqual(r.calls, [{ route: '/mobile/launch', body: { repoPath: REPO, prompt: 'fix the typo' }, timeoutMs: MOBILE_LAUNCH_TIMEOUT_MS }]);
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
    const big = await postLaunch(r.port, JSONH, JSON.stringify({ repoPath: REPO, prompt: 'x'.repeat(MOBILE_SEND_MAX_BODY) }));
    assert.equal(big.status, 413, 'the 128 KB body cap (the attachment cap is /api/send only)');
    assert.equal(r.calls.length, 1);
  } finally {
    await r.close();
  }
});

test('must-FAIL: an empty / blank prompt or a missing repo path ⇒ 400 and nothing is relayed', { timeout: 15_000 }, async () => {
  const r = await rig();
  try {
    assert.equal((await postLaunch(r.port, JSONH, launchBody(1))).status, 200, 'control');
    const bad = [
      { repoPath: REPO, prompt: '' },
      { repoPath: REPO, prompt: '   \n' },
      { repoPath: REPO },
      { prompt: 'x' },
      { repoPath: '', prompt: 'x' },
      { repoPath: REPO, prompt: 7 },
    ];
    for (const b of bad) assert.equal((await postLaunch(r.port, JSONH, JSON.stringify(b))).status, 400, JSON.stringify(b));
    assert.equal(r.calls.length, 1, 'only the control reached main');
  } finally {
    await r.close();
  }
});

test('launch counts in the in-flight write bound shared with send/answer: at most MAX_WRITES_IN_FLIGHT wait on main; a freed slot is reused', { timeout: 20_000 }, async () => {
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
    const again = postLaunch(r.port, JSONH, launchBody(5));
    await waitUntil(() => reached >= MAX_WRITES_IN_FLIGHT + 1, 'the next launch reached main');
    releases.splice(0).forEach((f) => f());
    assert.equal((await again).status, 200, 'a freed slot is reused');
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

test('must-FAIL, through the REAL launcher: an unregistered repo is refused with nothing created (control: a registered one is)', { timeout: 15_000 }, async () => {
  const spawned: string[] = [];
  const launcher = createMobileLauncher({ repos: () => [{ path: REPO }], spawn: async ({ repoPath }) => (spawned.push(repoPath), { ok: true, id: 'ws-1' }) });
  const r = await rig({ upstream: async (route, body) => (route === '/mobile/launch' ? launcher.launch(body) : { ok: true }) });
  try {
    assert.equal(JSON.parse((await postLaunch(r.port, JSONH, launchBody(1))).body).ok, true, 'control');
    const out = await postLaunch(r.port, JSONH, JSON.stringify({ repoPath: '/etc', prompt: 'x' }));
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
