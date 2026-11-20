import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginFailureHint, resolveChildAccount } from './spawn-account.ts';

const accounts = [
  { id: 'vf2', label: 'VF Two' },
  { id: 'other', label: 'Other' },
];
const ok = (accountId: string | undefined, source: string) => ({ ok: true, accountId, source });

test('inherit: no explicit → the caller\'s account, even over the repo\'s', () => {
  assert.deepEqual(resolveChildAccount({ callerAccountId: 'vf2', accounts }), ok('vf2', 'caller'));
  assert.deepEqual(resolveChildAccount({ callerAccountId: 'vf2', repoAccountId: 'other', accounts }), ok('vf2', 'caller'));
});

test('override: explicit id or label wins over the caller and the repo', () => {
  assert.deepEqual(resolveChildAccount({ explicit: 'other', callerAccountId: 'vf2', repoAccountId: 'vf2', accounts }), ok('other', 'explicit'));
  assert.deepEqual(resolveChildAccount({ explicit: ' vf two ', callerAccountId: 'other', accounts }), ok('vf2', 'explicit'));
});

test('override: `default` = the default login, unless an account is itself named default', () => {
  assert.deepEqual(resolveChildAccount({ explicit: 'default', callerAccountId: 'vf2', accounts }), ok(undefined, 'explicit-default'));
  assert.deepEqual(resolveChildAccount({ explicit: 'default', accounts: [{ id: 'default', label: 'x' }] }), ok('default', 'explicit'));
});

test('the `default` keyword beats an account whose LABEL is "Default"; an account id `default` still wins', () => {
  assert.deepEqual(resolveChildAccount({ explicit: 'default', accounts: [{ id: 'a1', label: 'Default' }] }), ok(undefined, 'explicit-default'));
});

test('caller on the default login → the repo\'s account, else the default login (today\'s behaviour)', () => {
  assert.deepEqual(resolveChildAccount({ callerAccountId: undefined, repoAccountId: 'other', accounts }), ok('other', 'repo'));
  assert.deepEqual(resolveChildAccount({ callerAccountId: '', accounts }), ok(undefined, 'default'));
  assert.deepEqual(resolveChildAccount({ accounts }), ok(undefined, 'default'));
});

test('caller account deleted (dangling pin) → falls through, never pins a missing account', () => {
  assert.deepEqual(resolveChildAccount({ callerAccountId: 'gone', repoAccountId: 'other', accounts }), ok('other', 'repo'));
  assert.deepEqual(resolveChildAccount({ callerAccountId: 'gone', accounts }), ok(undefined, 'default'));
});

test('unknown / ambiguous explicit account is refused, naming the value and the fix command', () => {
  const r = resolveChildAccount({ explicit: 'nope', callerAccountId: 'vf2', accounts });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /unknown account: "nope".*vf2, other.*orchestra accounts/);
  const amb = resolveChildAccount({ explicit: 'twin', accounts: [{ id: 'a', label: 'Twin' }, { id: 'b', label: 'twin' }] });
  assert.equal(amb.ok, false);
  assert.match((amb as { error: string }).error, /ambiguous account/);
  assert.equal(resolveChildAccount({ explicit: 'x', accounts: [] }).ok, false); // no accounts configured: only `default` is valid
});

test('loginFailureHint: only a login failure, one line with the exact fix command', () => {
  const h = loginFailureHint({ reason: 'Not logged in · Please run /login', workspaceId: 'ws-1', accountId: undefined, accounts });
  assert.match(h, /default login/);
  assert.match(h, /`orchestra migrate-account ws-1 <account>`/);
  assert.doesNotMatch(h, /restart/); // the kept-child message already says how to restart: ONE restart advice
  assert.equal(h.includes('\n'), false);
  assert.match(loginFailureHint({ reason: 'Please run /login', workspaceId: 'w', accountId: 'vf2', accounts }), /VF Two/);
  assert.equal(loginFailureHint({ reason: 'rate limited', workspaceId: 'w', accounts }), '');
});
