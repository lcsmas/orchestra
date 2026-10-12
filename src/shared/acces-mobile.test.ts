import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ACCES_MOBILE_SETTINGS,
  normalizeAccesMobileSettings,
  patchAccesMobileSettings,
  mobileDisplayName,
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

test('displayName (#372): the desktop name without its `<repo basename> · ` / `scratch · ` / `orchestrator · ` prefix; the desktop `name` untouched', () => {
  const dn = (over: Partial<Workspace>) => mobileDisplayName(ws(over));
  assert.equal(dn({ name: 'orchestra · fix-foo', repoPath: '/r/orchestra' }), 'fix-foo', 'repo prefix');
  assert.equal(dn({ name: 'orchestra · fix-foo', repoPath: '/r/orchestra/' }), 'fix-foo', 'a trailing slash on the repo path');
  assert.equal(dn({ name: 'scratch · idea', repoPath: '', kind: 'scratch' }), 'idea', 'scratch prefix');
  assert.equal(dn({ name: 'orchestrator · vague-i', repoPath: '', kind: 'orchestrator' }), 'vague-i', 'orchestrator prefix');
  assert.equal(dn({ name: 'orchestrator · vague-i', repoPath: '/r/orchestra', kind: 'orchestrator' }), 'vague-i', 'an orchestrator that owns a repo keeps the orchestrator prefix, not the repo one');
  assert.equal(dn({ name: 'renamed by hand', repoPath: '/r/orchestra' }), 'renamed by hand', 'no prefix ⇒ shown whole');
  assert.equal(dn({ name: 'perso · fix-foo', repoPath: '/r/orchestra' }), 'perso · fix-foo', "another repo's prefix is not ours to cut");
  assert.equal(dn({ name: 'see orchestra · fix-foo', repoPath: '/r/orchestra' }), 'see orchestra · fix-foo', 'only a LEADING prefix');
  assert.equal(dn({ name: 'orchestra · orchestra · x', repoPath: '/r/orchestra' }), 'orchestra · x', 'one prefix, once');
  assert.equal(dn({ name: 'orchestra · ', repoPath: '/r/orchestra' }), 'orchestra · ', 'nothing left ⇒ shown whole, never an empty title');
  assert.equal(dn({ name: 'orchestra ·fix-foo', repoPath: '/r/orchestra' }), 'orchestra ·fix-foo', 'the prefix is « name · » exactly');
  assert.equal(dn({ name: 'a · b · feat', repoPath: '/r/a · b' }), 'feat', 'a repo whose name contains « · »: the whole repo name goes, not its first segment');
  assert.equal(dn({ name: 'scratch · a · b', repoPath: '/r/scratch · a' }), 'b', 'the repo prefix wins when it is the longer match');
  assert.equal(dn({ name: 'orchestra · fix-foo', repoPath: '/opt/work/src/orchestra' }), 'fix-foo', 'a deep real-world path: the LAST segment is the repo');
  assert.equal(dn({ name: 'scratch · x', repoPath: '/r/orchestra' }), 'x', 'a worktree demoted by hand to a scratch-style name still reads short');
});

test('list: every row carries displayName; `name` stays the desktop one', () => {
  const rows = projectMobileWorkspaces(
    [
      ws({ id: 'a', name: 'orchestra · fix-foo', branch: 'fix-foo' }),
      ws({ id: 'b', name: 'orchestrator · vague-i', repoPath: '', kind: 'orchestrator' }),
      ws({ id: 'c', name: 'perso · q', repoPath: '/r/perso' }),
      ws({ id: 'd', name: 'hand-made', repoPath: '/r/perso' }),
    ],
    repos,
    accounts,
  );
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual(rows.map((r) => [r.id, r.name, r.displayName]).sort(), [
    ['a', 'orchestra · fix-foo', 'fix-foo'],
    ['b', 'orchestrator · vague-i', 'vague-i'],
    ['c', 'perso · q', 'q'],
    ['d', 'hand-made', 'hand-made'],
  ]);
  assert.equal(by.a.group, 'orchestra', 'the repo chip data (En attente rows) is untouched');
});

test('list (#372): inside a section rows are ordered by the title the phone SHOWS (a hand-renamed one is not pushed around by a prefix it does not display)', () => {
  const rows = projectMobileWorkspaces(
    [ws({ id: 'z', name: 'orchestra · z' }), ws({ id: 'h', name: 'handmade' }), ws({ id: 'a', name: 'orchestra · a' })],
    repos,
    accounts,
  );
  assert.deepEqual(rows.map((r) => r.displayName), ['a', 'handmade', 'z']);
});

test('parentId (#373): the nearest LISTED ancestor — archived / unlisted parents are walked through; none listed ⇒ a root', () => {
  const rows = projectMobileWorkspaces(
    [
      ws({ id: 'root', name: 'root', repoPath: '', kind: 'orchestrator' }),
      ws({ id: 'sub', name: 'sub', parentId: 'root' }),
      ws({ id: 'leaf', name: 'leaf', parentId: 'sub' }),
      // an archived middle parent: leaf2 hangs under the grandparent
      ws({ id: 'mid', name: 'mid', archived: true, parentId: 'root' }),
      ws({ id: 'leaf2', name: 'leaf2', parentId: 'mid' }),
      // two archived levels
      ws({ id: 'mid-a', name: 'mid-a', archived: true, parentId: 'sub' }),
      ws({ id: 'mid-b', name: 'mid-b', archived: true, parentId: 'mid-a' }),
      ws({ id: 'leaf3', name: 'leaf3', parentId: 'mid-b' }),
      // every ancestor archived or unknown ⇒ a root
      ws({ id: 'old-root', name: 'old-root', archived: true, parentId: 'gone' }),
      ws({ id: 'orphan', name: 'orphan', parentId: 'old-root' }),
      // a self parent
      ws({ id: 'me', name: 'me', parentId: 'me' }),
    ],
    repos,
    accounts,
  );
  const by = Object.fromEntries(rows.map((r) => [r.id, r.parentId]));
  assert.equal(by.sub, 'root', 'listed parent');
  assert.equal(by.leaf, 'sub', 'a worker of a worker (two levels)');
  assert.equal(by.leaf2, 'root', 'archived middle parent ⇒ the grandparent');
  assert.equal(by.leaf3, 'sub', 'two archived levels ⇒ the nearest listed ancestor above them');
  assert.equal(by.orphan, undefined, 'no listed ancestor ⇒ root');
  assert.equal(by.me, undefined, 'itself is no parent');
  assert.equal(by.root, undefined);
  assert.ok(!rows.some((r) => r.id === 'mid' || r.id === 'old-root'), 'archived rows stay out of the list');
});

test('parentId (#373): a chain that loops back through unlisted rows ends the walk; a loop of LISTED rows is kept for the tree module to break', () => {
  const rows = projectMobileWorkspaces(
    [
      ws({ id: 'a', name: 'a', parentId: 'x' }),
      ws({ id: 'x', name: 'x', archived: true, parentId: 'y' }),
      ws({ id: 'y', name: 'y', archived: true, parentId: 'x' }),
      ws({ id: 'p', name: 'p', parentId: 'q' }),
      ws({ id: 'q', name: 'q', parentId: 'p' }),
      ws({ id: 'a2', name: 'a2', parentId: 'x2' }),
      ws({ id: 'x2', name: 'x2', archived: true, parentId: 'a2' }),
    ],
    repos,
    accounts,
  );
  const by = Object.fromEntries(rows.map((r) => [r.id, r.parentId]));
  assert.equal(by.a, undefined, 'an unlisted loop never reaches a listed row, and never hangs');
  assert.equal(by.a2, undefined, 'a chain that comes back to the row itself through an archived one: the row is no ancestor of itself');
  assert.deepEqual([by.p, by.q], ['q', 'p'], 'both rows are still in the list');
});

/** `ws()` whose `parentId` is a counting getter: every read of it goes through `onRead` (which may throw). */
const counted = (over: Partial<Workspace>, onRead: () => void): Workspace => {
  const w = ws(over);
  const pid = w.parentId;
  Object.defineProperty(w, 'parentId', { get() { onRead(); return pid; }, enumerable: true });
  return w;
};

test('parentId (#373): a long archived chain under many listed rows is walked ONCE — each row\'s parent is read a bounded number of times (a count, not a clock)', () => {
  const N = 600;
  let reads = 0;
  const list: Workspace[] = [counted({ id: 'top', name: 'top', repoPath: '', kind: 'orchestrator' }, () => { reads++; })];
  for (let i = 0; i < N; i++) list.push(counted({ id: `arch${i}`, name: `arch${i}`, archived: true, parentId: i === 0 ? 'top' : `arch${i - 1}` }, () => { reads++; }));
  for (let i = 0; i < N; i++) list.push(counted({ id: `leaf${i}`, name: `leaf${i}`, parentId: `arch${N - 1}` }, () => { reads++; }));
  const rows = projectMobileWorkspaces(list, repos, accounts);
  assert.equal(rows.length, N + 1);
  assert.ok(rows.filter((r) => r.id.startsWith('leaf')).every((r) => r.parentId === 'top'), 'every leaf hangs under the nearest listed ancestor above the archived chain');
  // each row's parent is read once for its own query + once per archived row the walk crosses — memoised, that is ≤ 2 per row; without
  // the memo every leaf re-walks the whole chain (≈ N² = 360 000 reads)
  assert.ok(reads <= 2 * list.length, `${reads} parent reads for ${list.length} rows (≤ ${2 * list.length}): the walk is memoised`);
});

test('parentId (#373): a loop among unlisted rows ends the walk — it never runs away (the parent read THROWS past a bound, so a missing guard is a red test, not a hang)', () => {
  let reads = 0;
  const bounded = () => { if (++reads > 1000) throw new Error('runaway ancestor walk'); };
  const rows = projectMobileWorkspaces(
    [
      counted({ id: 'a', name: 'a', parentId: 'x' }, bounded),
      counted({ id: 'x', name: 'x', archived: true, parentId: 'y' }, bounded),
      counted({ id: 'y', name: 'y', archived: true, parentId: 'x' }, bounded),
      counted({ id: 'b', name: 'b', parentId: 'y' }, bounded), // a second row into the SAME loop: answered from the memo
    ],
    repos,
    accounts,
  );
  assert.deepEqual(rows.map((r) => [r.id, r.parentId]).sort(), [['a', undefined], ['b', undefined]]);
  assert.ok(reads < 20, `${reads} reads: 2 own queries (a, b — archived rows run no query) + the loop's two rows once`);
});

test('parentId (#373): the NEGATIVE answer (« no listed ancestor ») is memoised too — a long archived chain with no listed root, many leaves under its tail', () => {
  const N = 600;
  let reads = 0;
  const list: Workspace[] = [];
  for (let i = 0; i < N; i++) list.push(counted({ id: `arch${i}`, name: `arch${i}`, archived: true, parentId: i === 0 ? 'gone' : `arch${i - 1}` }, () => { reads++; }));
  for (let i = 0; i < N; i++) list.push(counted({ id: `leaf${i}`, name: `leaf${i}`, parentId: `arch${N - 1}` }, () => { reads++; }));
  const rows = projectMobileWorkspaces(list, repos, accounts);
  assert.equal(rows.length, N);
  assert.ok(rows.every((r) => r.parentId === undefined), 'no listed ancestor above the chain: every leaf is a root');
  assert.ok(reads <= 2 * list.length, `${reads} parent reads for ${list.length} rows (≤ ${2 * list.length}): « none » is cached like an answer`);
});
