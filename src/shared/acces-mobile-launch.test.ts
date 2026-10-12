// Accès mobile launch (#375/#376): the pure parts — the repo list the phone offers, the request's shape, the rolling-minute cap.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MOBILE_LAUNCH_MAX_PATH,
  MOBILE_LAUNCH_MAX_PROMPT,
  MOBILE_LAUNCH_PER_WINDOW,
  MOBILE_LAUNCH_WINDOW_MS,
  createLaunchLimiter,
  parseMobileLaunch,
  projectMobileRepos,
} from './acces-mobile-launch.ts';
import type { Account } from './accounts.ts';
import type { RepoEntry } from './types.ts';

const RID = 'req-0123456789abcdef'; // 20 chars
const ok = { repoPath: '/home/u/repo', prompt: 'fix the typo', requestId: RID };

test('parseMobileLaunch: a well-formed launch passes, the prompt is trimmed, extra keys never travel', () => {
  const r = parseMobileLaunch({ ...ok, prompt: '  fix the typo \n', model: 'opus', branch: 'x', accountId: 'a', parentId: 'p', attachments: [] });
  assert.deepEqual(r, { ok: true, launch: ok }, 'only {repoPath, prompt, requestId}: no model / branch / Compte / parent / attachments from the phone (D1)');
});

test('parseMobileLaunch: the prompt is REQUIRED — empty, blank, non-string and over-long are refused', () => {
  assert.equal(parseMobileLaunch(ok).ok, true, 'control');
  for (const prompt of ['', '   ', '\n\t', undefined, null, 42, ['x'], 'x'.repeat(MOBILE_LAUNCH_MAX_PROMPT + 1)]) {
    assert.equal(parseMobileLaunch({ ...ok, prompt }).ok, false, `prompt ${JSON.stringify(prompt)?.slice(0, 20)}`);
  }
  assert.equal(parseMobileLaunch({ ...ok, prompt: 'x'.repeat(MOBILE_LAUNCH_MAX_PROMPT) }).ok, true, 'the bound itself is allowed');
});

test('parseMobileLaunch: repoPath must be a non-empty bounded string without NUL', () => {
  for (const repoPath of ['', undefined, null, 7, ['/a'], '/a\0b', '/' + 'a'.repeat(MOBILE_LAUNCH_MAX_PATH)]) {
    assert.equal(parseMobileLaunch({ ...ok, repoPath }).ok, false, `repoPath ${JSON.stringify(repoPath)?.slice(0, 20)}`);
  }
});

test('parseMobileLaunch: the request id is required and URL-safe (a double submit needs one)', () => {
  assert.equal(parseMobileLaunch({ ...ok, requestId: crypto.randomUUID() }).ok, true, 'a UUID passes');
  for (const requestId of [undefined, '', 'short', 'x'.repeat(65), 'has space 0123456789abcdef', 'a/b0123456789abcdef', 12345678901234567890]) {
    assert.equal(parseMobileLaunch({ ...ok, requestId }).ok, false, `requestId ${String(requestId).slice(0, 20)}`);
  }
});

test('parseMobileLaunch: not an object ⇒ refused', () => {
  for (const raw of [null, undefined, 'x', 3, [], [ok]]) assert.equal(parseMobileLaunch(raw).ok, false);
});

test('projectMobileRepos: every registered repo, every Compte, sorted by name; the Compte is the repo\'s own, a dangling one reads « default »', () => {
  const accounts: Account[] = [
    { id: 'a1', label: 'perso', configDir: '/c/a1' } as Account,
    { id: 'a2', label: 'mc', configDir: '/c/a2' } as Account,
  ];
  const repos: RepoEntry[] = [
    { path: '/r/zeta', name: 'zeta', defaultBranch: 'main', accountId: 'a2' },
    { path: '/r/alpha', name: 'alpha', defaultBranch: 'main', accountId: 'a1' },
    { path: '/r/beta', name: 'beta', defaultBranch: 'main', accountId: 'gone' },
    { path: '/r/gamma', name: 'gamma', defaultBranch: 'main' },
  ];
  const rows = projectMobileRepos(repos, accounts);
  assert.deepEqual(rows.map((r) => [r.name, r.path, r.account]), [
    ['alpha', '/r/alpha', 'perso'],
    ['beta', '/r/beta', 'default'],
    ['gamma', '/r/gamma', 'default'],
    ['zeta', '/r/zeta', 'mc'],
  ]);
  assert.deepEqual(projectMobileRepos([], accounts), []);
});

test('createLaunchLimiter: the 11th launch inside a rolling minute is refused; a slot frees exactly when the oldest ages out', () => {
  let t = 1000;
  const lim = createLaunchLimiter(() => t);
  for (let i = 0; i < MOBILE_LAUNCH_PER_WINDOW; i++) {
    assert.equal(lim.take(), true, `launch ${i + 1}`);
    t += 1000; // one per second: the first ages out 60 s after t=1000
  }
  assert.equal(lim.take(), false, 'the 11th within the minute');
  t = 1000 + MOBILE_LAUNCH_WINDOW_MS - 1;
  assert.equal(lim.take(), false, 'still 10 inside the window (the oldest is 59.999 s old)');
  t = 1000 + MOBILE_LAUNCH_WINDOW_MS;
  assert.equal(lim.take(), true, 'the oldest left the window ⇒ one slot (rolling, not a fixed minute)');
  assert.equal(lim.take(), false, 'and only one');
});

test('createLaunchLimiter: a refused attempt records nothing — hammering never extends the lock-out', () => {
  let t = 0;
  const lim = createLaunchLimiter(() => t);
  for (let i = 0; i < MOBILE_LAUNCH_PER_WINDOW; i++) assert.equal(lim.take(), true);
  for (let i = 0; i < 500; i++) {
    t += 100; // 50 s of hammering
    assert.equal(lim.take(), false);
  }
  t = MOBILE_LAUNCH_WINDOW_MS;
  assert.equal(lim.take(), true, 'the 10 real launches aged out at 60 s; the 500 refusals did not push it back');
});

test('createLaunchLimiter: custom bounds are honoured (the constants are the defaults, not hard-wired)', () => {
  let t = 0;
  const lim = createLaunchLimiter(() => t, 2, 10);
  assert.deepEqual([lim.take(), lim.take(), lim.take()], [true, true, false]);
  t = 10;
  assert.equal(lim.take(), true);
});

// ---- what the launch form says (injected into the phone page) ----
import { mobileLaunchFailure, mobileLaunchRequestId } from './acces-mobile-launch.ts';

test('mobileLaunchFailure: each failure says what really happened — only a refusal main decided claims « aucun workspace »; a lost reply says it may have happened', () => {
  const t = (status: number | null, body?: unknown) => mobileLaunchFailure(status, body);
  assert.match(t(null).text, /peut-être créé.*même envoi ne crée qu’un seul workspace/, 'network down: the launch may have happened — a retry is safe');
  for (const status of [500, 502, 503, 504]) assert.match(t(status).text, /injoignable.*peut-être créé.*même envoi/, `${status}: a hop in front of main failing says nothing about whether main created the workspace`);
  assert.deepEqual(t(401), { text: 'Jeton refusé : re-scanne le QR code.', repair: true });
  assert.match(t(429).text, /10 par minute.*Aucun workspace n’a été créé/);
  assert.match(t(400).text, /Refusé \(400\).*Aucun workspace/);
  assert.match(t(200, { ok: false, code: 'unknown-repo' }).text, /Dépôt inconnu.*aucun workspace n’a été créé/);
  assert.match(t(200, { ok: false, code: 'create-failed', error: 'fatal: not a git repository' }).text, /Création impossible : fatal: not a git repository\. Aucun workspace n’a été créé\./);
  assert.match(t(200, { ok: false, code: 'request-reused' }).text, /autre contenu/);
  assert.match(t(200, { ok: false }).text, /Échec du lancement/, 'an unknown refusal is still an error, never a success');
});

test('mobileLaunchFailure: an agent that did not start offers the workspace that EXISTS; the raw detail is clipped; a missing id offers nothing', () => {
  const r = mobileLaunchFailure(200, { ok: false, code: 'start-failed', id: 'ws-9', error: 'no auth' });
  assert.equal(r.open, 'ws-9');
  assert.match(r.text, /L’agent n’a pas démarré : no auth\. Le workspace existe sur le bureau/);
  assert.equal(mobileLaunchFailure(200, { ok: false, code: 'start-failed', error: 'x' }).open, undefined, 'no id ⇒ nothing to open');
  const long = mobileLaunchFailure(200, { ok: false, code: 'create-failed', error: 'e'.repeat(500) }).text;
  assert.ok(long.length < 330 && long.includes('…'), 'clipped');
  assert.equal(mobileLaunchFailure(200, null).text, 'Échec du lancement.', 'a body that is not JSON');
});

test('mobileLaunchRequestId: 32 hex chars from 16 bytes, accepted by the server\'s shape check, injectable via toString', () => {
  const id = mobileLaunchRequestId(Uint8Array.from({ length: 16 }, (_, i) => i * 17));
  assert.equal(id, '00112233445566778899aabbccddeeff');
  assert.equal(parseMobileLaunch({ ...ok, requestId: id }).ok, true);
  assert.notEqual(mobileLaunchRequestId(new Uint8Array(16)), mobileLaunchRequestId(new Uint8Array(16).fill(1)));
  // self-contained: the source that reaches the phone page works with nothing else in scope (indirect eval = global scope only)
  const injected = (0, eval)(`(${mobileLaunchRequestId.toString()})`) as typeof mobileLaunchRequestId;
  assert.equal(injected(Uint8Array.from({ length: 16 }, (_, i) => i)), '000102030405060708090a0b0c0d0e0f');
  const injectedFailure = (0, eval)(`(${mobileLaunchFailure.toString()})`) as typeof mobileLaunchFailure;
  assert.deepEqual(injectedFailure(429, null), mobileLaunchFailure(429, null), 'the failure wording is self-contained too');
});
