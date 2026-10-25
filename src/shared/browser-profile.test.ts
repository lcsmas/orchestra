import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_PROFILE_NAME_MAX,
  checkProfileName,
  decideAttach,
  decideDelete,
  effectiveProfileId,
  ephemeralPartition,
  isBrowserProfileId,
  isHumanProfileCaller,
  normalizeBrowserProfiles,
  partitionFor,
  profileCreateWarning,
  profilePartition,
} from './browser-profile.ts';
import type { BrowserProfile } from './types.ts';

const A = 'bp-aaaaaaaaaaaa';
const B = 'bp-bbbbbbbbbbbb';
const profiles: BrowserProfile[] = [
  { id: A, name: 'Staging', createdAt: 1 },
  { id: B, name: 'Prod admin', createdAt: 2 },
];

test('isBrowserProfileId: only the minted shape', () => {
  assert.equal(isBrowserProfileId(A), true);
  for (const bad of ['', 'bp-', 'bp-AAAAAAAAAAAA', 'bp-aaaaaaaaaaa', 'bp-aaaaaaaaaaaaa', 'x-aaaaaaaaaaaa', 'bp-aaaaaaaaaaaa/../x', undefined, 7, null]) {
    assert.equal(isBrowserProfileId(bad), false, String(bad));
  }
});

test('normalizeBrowserProfiles: drops malformed + repeated ids, trims names, keeps order', () => {
  const out = normalizeBrowserProfiles([
    { id: A, name: '  Staging  ', createdAt: 5 },
    { id: A, name: 'Dup id', createdAt: 6 },
    { id: 'persist:evil', name: 'Bad id' },
    { id: B, name: '' },
    { id: 'bp-cccccccccccc', name: 'x'.repeat(BROWSER_PROFILE_NAME_MAX + 1) },
    { id: 'bp-dddddddddddd', name: 'No date' },
    null,
    'str',
  ]);
  assert.deepEqual(out, [
    { id: A, name: 'Staging', createdAt: 5 },
    { id: 'bp-dddddddddddd', name: 'No date', createdAt: 0 },
  ]);
  assert.deepEqual(normalizeBrowserProfiles(undefined), []);
  assert.deepEqual(normalizeBrowserProfiles({ 0: 'x' }), []);
});

test('checkProfileName: empty / too long / duplicate (case-insensitive, others only) / ok', () => {
  assert.deepEqual(checkProfileName('  New   one ', profiles), { ok: true, name: 'New one' });
  assert.equal(checkProfileName('   ', profiles).ok, false);
  assert.equal((checkProfileName('', profiles) as { reason: string }).reason, 'empty');
  assert.equal((checkProfileName(undefined, profiles) as { reason: string }).reason, 'empty');
  assert.equal((checkProfileName('x'.repeat(BROWSER_PROFILE_NAME_MAX + 1), profiles) as { reason: string }).reason, 'too-long');
  assert.equal(checkProfileName('x'.repeat(BROWSER_PROFILE_NAME_MAX), profiles).ok, true);
  assert.equal((checkProfileName('staging', profiles) as { reason: string }).reason, 'duplicate');
  // renaming a profile to its own name / another casing of it is fine; to ANOTHER profile's name is not
  assert.equal(checkProfileName('STAGING', profiles, A).ok, true);
  assert.equal((checkProfileName('prod admin', profiles, A) as { reason: string }).reason, 'duplicate');
  // control characters cannot smuggle a second line into a label
  assert.deepEqual(checkProfileName('a\nb\u0000c', profiles), { ok: true, name: 'a b c' });
});

test('partitions: ephemeral has NO persist: prefix, a profile ALWAYS has; the id is never free text', () => {
  assert.equal(ephemeralPartition('ws1'), 'orchestra-browser-ws1');
  assert.equal(profilePartition(A), 'persist:orchestra-profile-bp-aaaaaaaaaaaa');
  assert.equal(partitionFor('ws1', undefined), 'orchestra-browser-ws1');
  assert.equal(partitionFor('ws1', A), 'persist:orchestra-profile-bp-aaaaaaaaaaaa');
  assert.equal(partitionFor('ws1', A), partitionFor('ws2', A), 'two workspaces share a profile partition');
  assert.notEqual(partitionFor('ws1', undefined), partitionFor('ws2', undefined), 'ephemeral stays per workspace');
  assert.throws(() => profilePartition('persist:../../x'), /not a browser profile id/);
  assert.throws(() => partitionFor('ws1', 'whatever'), /not a browser profile id/);
});

test('effectiveProfileId: a dangling id reads as ephemeral, a live one stays', () => {
  assert.equal(effectiveProfileId(A, profiles), A);
  assert.equal(effectiveProfileId('bp-eeeeeeeeeeee', profiles), undefined);
  assert.equal(effectiveProfileId(undefined, profiles), undefined);
  assert.equal(effectiveProfileId(A, []), undefined);
});

test('decideAttach: attach, switch, same (no-op), detach, unknown', () => {
  assert.deepEqual(decideAttach({ profiles, current: undefined, target: A }), { ok: true, profileId: A, changed: true });
  assert.deepEqual(decideAttach({ profiles, current: A, target: B }), { ok: true, profileId: B, changed: true });
  assert.deepEqual(decideAttach({ profiles, current: A, target: A }), { ok: true, profileId: A, changed: false });
  assert.deepEqual(decideAttach({ profiles, current: A, target: null }), { ok: true, profileId: undefined, changed: true });
  assert.deepEqual(decideAttach({ profiles, current: undefined, target: null }), { ok: true, profileId: undefined, changed: false });
  // a recorded-but-deleted profile is already ephemeral: detaching it changes nothing to rebuild
  assert.deepEqual(decideAttach({ profiles, current: 'bp-eeeeeeeeeeee', target: null }), { ok: true, profileId: undefined, changed: false });
  const r = decideAttach({ profiles, current: undefined, target: 'bp-eeeeeeeeeeee' });
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, 'unknown-profile');
});

test('decideDelete: lists exactly the workspaces carrying the profile; unknown is refused', () => {
  const workspaces = [
    { id: 'w1', browserProfileId: A },
    { id: 'w2' },
    { id: 'w3', browserProfileId: B },
    { id: 'w4', browserProfileId: A },
  ];
  assert.deepEqual(decideDelete({ profiles, workspaces, profileId: A }), { ok: true, detach: ['w1', 'w4'] });
  assert.deepEqual(decideDelete({ profiles, workspaces, profileId: B }), { ok: true, detach: ['w3'] });
  assert.deepEqual(decideDelete({ profiles, workspaces: [], profileId: A }), { ok: true, detach: [] });
  assert.equal(decideDelete({ profiles, workspaces, profileId: 'bp-eeeeeeeeeeee' }).ok, false);
});

test('isHumanProfileCaller: only the main window top frame; fail closed on anything unknown', () => {
  assert.equal(isHumanProfileCaller({ senderId: 3, mainId: 3, senderIsMainFrame: true }), true);
  assert.equal(isHumanProfileCaller({ senderId: 7, mainId: 3, senderIsMainFrame: true }), false, 'a panel/other window');
  assert.equal(isHumanProfileCaller({ senderId: 3, mainId: 3, senderIsMainFrame: false }), false, 'a sub-frame of the main window');
  assert.equal(isHumanProfileCaller({ senderId: 3, mainId: null, senderIsMainFrame: true }), false, 'no main window known');
  assert.equal(isHumanProfileCaller({ senderId: undefined, mainId: undefined, senderIsMainFrame: true }), false, 'undefined === undefined must not pass');
  assert.equal(isHumanProfileCaller({ senderId: null, mainId: null, senderIsMainFrame: true }), false);
});

test('profileCreateWarning: only when secret storage is not encrypted (reuses #389)', () => {
  assert.equal(profileCreateWarning(null), null);
  assert.equal(profileCreateWarning({ encrypted: true, backend: 'gnome_libsecret', plaintextEntries: 0, encryptedEntries: 2 }), null);
  const w = profileCreateWarning({ encrypted: false, backend: 'basic_text', plaintextEntries: 1, encryptedEntries: 0 });
  assert.match(w ?? '', /not encrypted/);
  assert.match(profileCreateWarning({ encrypted: false, backend: null, plaintextEntries: 0, encryptedEntries: 3 }) ?? '', /not encrypted/);
});
