// Accès mobile launch (#375): the pure parts — the repo list the phone offers, the request's shape, what the form says on a failure.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MOBILE_LAUNCH_MAX_PATH, MOBILE_LAUNCH_MAX_PROMPT, mobileLaunchFailure, parseMobileLaunch, projectMobileRepos } from './acces-mobile-launch.ts';
import type { Account } from './accounts.ts';
import type { RepoEntry } from './types.ts';

const ok = { repoPath: '/home/u/repo', prompt: 'fix the typo' };

test('parseMobileLaunch: a well-formed launch passes, the prompt is trimmed, extra keys never travel', () => {
  const r = parseMobileLaunch({ ...ok, prompt: '  fix the typo \n', model: 'opus', branch: 'x', accountId: 'a', parentId: 'p', attachments: [], kind: 'orchestrator' });
  assert.deepEqual(r, { ok: true, launch: ok }, 'only {repoPath, prompt}: no model / branch / Compte / parent / attachments from the phone (D1)');
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

// ---- what the launch form says (injected into the phone page) ----

test('mobileLaunchFailure: each failure says what really happened — only a refusal main decided claims « aucun workspace »; a lost reply says it may have happened', () => {
  const t = (status: number | null, body?: unknown) => mobileLaunchFailure(status, body);
  assert.match(t(null).text, /peut-être créé.*Vérifie la liste avant de réessayer/, 'network down: the launch may have happened');
  for (const status of [500, 502, 503, 504]) assert.match(t(status).text, /injoignable.*peut-être créé.*Vérifie la liste/, `${status}: a hop in front of main failing says nothing about whether main created the workspace`);
  assert.deepEqual(t(401), { text: 'Jeton refusé : re-scanne le QR code.', repair: true });
  assert.match(t(429).text, /Trop de lancements en cours.*Aucun workspace n’a été créé/);
  assert.match(t(400).text, /Refusé \(400\).*Aucun workspace/);
  assert.match(t(200, { ok: false, code: 'unknown-repo' }).text, /Dépôt inconnu.*aucun workspace n’a été créé/);
  assert.match(t(200, { ok: false, code: 'create-failed', error: 'fatal: not a git repository' }).text, /Création impossible : fatal: not a git repository\. Aucun workspace n’a été créé\./);
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

test('mobileLaunchFailure is self-contained: the source that reaches the phone page works with nothing else in scope', () => {
  const injected = (0, eval)(`(${mobileLaunchFailure.toString()})`) as typeof mobileLaunchFailure;
  assert.deepEqual(injected(429, null), mobileLaunchFailure(429, null));
  assert.deepEqual(injected(200, { ok: false, code: 'start-failed', id: 'w', error: 'e' }), mobileLaunchFailure(200, { ok: false, code: 'start-failed', id: 'w', error: 'e' }));
});
