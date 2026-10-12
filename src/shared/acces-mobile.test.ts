import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ACCES_MOBILE_SETTINGS,
  normalizeAccesMobileSettings,
  patchAccesMobileSettings,
  projectMobileWorkspaces,
  sameLogin,
  tailscaleServeCommand,
  accesMobileSocketPath, pairingTokenFrom } from './acces-mobile.ts';
import type { Account } from './accounts.ts';
import type { RepoEntry, Workspace } from './types.ts';

const ws = (over: Partial<Workspace>): Workspace =>
  ({ id: 'id', name: 'n', repoPath: '/r/orchestra', branch: 'b', baseBranch: 'master', worktreePath: '/w', createdAt: 0, status: 'idle', agent: 'claude', ...over }) as Workspace;
const repos = [
  { path: '/r/orchestra', name: 'orchestra', defaultBranch: 'master', accountId: 'mc' },
  { path: '/r/perso', name: 'perso', defaultBranch: 'main', accountId: 'perso' },
] as RepoEntry[];
const accounts = [
  { id: 'mc', label: 'mc', configDir: '~/.claude-mc' },
  { id: 'perso', label: 'perso', configDir: '~/.claude' },
] as Account[];

test('settings: default is OFF and fail-closed (no login)', () => {
  assert.deepEqual(normalizeAccesMobileSettings(undefined), DEFAULT_ACCES_MOBILE_SETTINGS);
  assert.equal(DEFAULT_ACCES_MOBILE_SETTINGS.enabled, false);
  assert.equal(DEFAULT_ACCES_MOBILE_SETTINGS.allowedLogin, '');
  assert.equal(normalizeAccesMobileSettings({ enabled: 'yes' as unknown as boolean }).enabled, false, 'only a literal true enables');
  assert.equal(normalizeAccesMobileSettings({ servePort: 80 }).servePort, DEFAULT_ACCES_MOBILE_SETTINGS.servePort, 'privileged port refused');
  assert.equal('port' in normalizeAccesMobileSettings({ port: 47823 } as never), false, 'a pre-review store with a TCP port normalizes it away');
});

test('settings patch: enabling without a login is refused; invalid values write nothing', () => {
  const cur = DEFAULT_ACCES_MOBILE_SETTINGS;
  assert.equal(patchAccesMobileSettings(cur, { enabled: true }).ok, false);
  const on = patchAccesMobileSettings(cur, { enabled: true, allowedLogin: ' lucas.mas@mobile.club ' });
  assert.ok(on.ok);
  if (on.ok) assert.equal(on.settings.allowedLogin, 'lucas.mas@mobile.club');
  assert.equal(patchAccesMobileSettings(cur, { servePort: 99999 }).ok, false);
  assert.equal(patchAccesMobileSettings(cur, { allowedLogin: 'not a login' }).ok, false);
  const off = patchAccesMobileSettings({ ...cur, enabled: true, allowedLogin: 'a@b' }, { enabled: false, allowedLogin: '' });
  assert.ok(off.ok, 'turning off while clearing the login is fine');
});

test('serve command targets the Unix socket, never a TCP port', () => {
  const sock = accesMobileSocketPath('/run/user/1000/', 'abcdef012345');
  assert.equal(sock, '/run/user/1000/orchestra-acces-mobile-abcdef012345.sock');
  assert.equal(tailscaleServeCommand(sock, 8445), 'sudo tailscale serve --bg --https=8445 unix:/run/user/1000/orchestra-acces-mobile-abcdef012345.sock');
});

test('sameLogin: exact modulo case/space, never empty', () => {
  assert.equal(sameLogin('Lucas.Mas@mobile.club', 'lucas.mas@mobile.club'), true);
  assert.equal(sameLogin('lucas.mas@mobile.club.evil', 'lucas.mas@mobile.club'), false);
  assert.equal(sameLogin('', ''), false);
  assert.equal(sameLogin(undefined, 'a@b'), false);
});

test('list: every account, archived dropped, en attente then non lu first', () => {
  const rows = projectMobileWorkspaces(
    [
      ws({ id: 'a', name: 'zeta', status: 'running' }),
      ws({ id: 'b', name: 'alpha', status: 'idle', autoUnread: true, repoPath: '/r/perso' }),
      ws({ id: 'c', name: 'mid', status: 'waiting', accountId: 'perso' }),
      ws({ id: 'd', name: 'gone', archived: true, status: 'waiting' }),
      ws({ id: 'e', name: 'coord', repoPath: '', status: 'idle' }),
      ws({ id: 'f', name: 'dangling', status: 'idle', accountId: 'deleted-account', repoPath: '/r/unknown' }),
    ],
    repos,
    accounts,
  );
  assert.deepEqual(rows.map((r) => r.id), ['c', 'b', 'a', 'e', 'f'], 'attention, then group (orchestra < Orchestrators), then name');
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.c.account, 'perso', 'pinned account wins over the repo account');
  assert.equal(by.a.account, 'mc', 'unpinned ⇒ the repo account');
  assert.equal(by.b.unread, true);
  assert.equal(by.e.group, 'Orchestrators');
  assert.equal(by.f.account, 'default', 'dangling pin ⇒ default login');
  assert.equal(by.a.group, 'orchestra');
});

test('a fleet worker carries its coordinator (parentId) only when that parent is listed', () => {
  const rows = projectMobileWorkspaces(
    [
      ws({ id: 'coord', name: 'coord', repoPath: '', kind: 'orchestrator' }),
      ws({ id: 'w1', name: 'w1', parentId: 'coord' }),
      ws({ id: 'w2', name: 'w2', parentId: 'gone' }),
      ws({ id: 'w3', name: 'w3', parentId: 'arch' }),
      ws({ id: 'arch', name: 'arch', archived: true }),
    ],
    repos,
    accounts,
  );
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.w1.parentId, 'coord');
  assert.equal(by.w2.parentId, undefined, 'a dangling parent is not a fold');
  assert.equal(by.w3.parentId, undefined, 'an archived parent is not listed, so not a fold');
  assert.equal(by.coord.parentId, undefined);
});

test('pairingTokenFrom: a pairing URL or a bare token, nothing else; the toString-injected copy agrees', () => {
  const T = 'abcdefghijklmnopqrstuvwxyz_-0123456789ABCDEFG';
  const cases: [string, string | null][] = [
    [`https://box.tail0000.ts.net:8445/#t=${T}`, T],
    [`  https://box.tail0000.ts.net:8445/#t=${T}\n`, T],
    [`#t=${T}`, T],
    [T, T],
    [`https://box/#t=${T}&x=1`, T],
    ['https://box.tail0000.ts.net:8445/', null],
    [`https://box/?t=${T}`, null],
    ['#t=short', null],
    [`https://box/#t=${T}!`, null],
    ['', null],
  ];
  const injected = new Function(`return (${pairingTokenFrom.toString()})`)() as typeof pairingTokenFrom;
  for (const [input, want] of cases) {
    assert.equal(pairingTokenFrom(input), want, input);
    assert.equal(injected(input), want, `injected: ${input}`);
  }
});
