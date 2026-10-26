import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideSpawnProfile } from './spawn-profile.ts';
import type { BrowserProfile } from './types.ts';

const STAGING: BrowserProfile = { id: 'bp-0123456789ab', name: 'Staging admin', createdAt: 1 };
const PROD: BrowserProfile = { id: 'bp-fedcba987654', name: 'Prod', createdAt: 2 };
const profiles = [STAGING, PROD];
const holder = { browserProfileId: STAGING.id };

function decide(over: Partial<Parameters<typeof decideSpawnProfile>[0]> = {}) {
  return decideSpawnProfile({ requested: STAGING.id, detached: false, caller: holder, callerVouched: true, profiles, deleting: [], ...over });
}

test('holds: the caller holds the requested profile (by id) → honoured, the id to write on the new record', () => {
  const d = decide();
  assert.equal(d.kind, 'honoured');
  assert.equal(d.kind === 'honoured' && d.profileId, STAGING.id);
});

test('holds: by NAME, case-insensitive and trimmed, resolves to the held id', () => {
  const d = decide({ requested: '  staging ADMIN ' });
  assert.equal(d.kind, 'honoured');
  assert.equal(d.kind === 'honoured' && d.profileId, STAGING.id);
});

test('does not hold: the caller holds ANOTHER profile → refused not-held, and the other profile is not named', () => {
  const d = decide({ requested: PROD.id });
  assert.equal(d.kind, 'refused');
  assert.equal(d.kind === 'refused' && d.reason, 'not-held');
  assert.ok(d.kind === 'refused' && d.message.includes('Staging admin'), 'names the profile the caller DOES hold');
  assert.ok(d.kind === 'refused' && !d.message.includes(PROD.name), 'does not name the profile it does not hold');
});

test('does not hold: a refusal about an existing profile and about a made-up one read the same (no existence oracle)', () => {
  const real = decide({ requested: PROD.id });
  const byName = decide({ requested: 'prod' });
  const madeUp = decide({ requested: 'nope' });
  for (const d of [real, byName, madeUp]) assert.equal(d.kind === 'refused' && d.reason, 'not-held');
  // the only part that varies is the echo of what the CALLER typed — never a lookup in the human's other profiles
  assert.ok(real.kind === 'refused' && !real.message.includes(PROD.name));
  assert.ok(byName.kind === 'refused' && !byName.message.includes(PROD.id) && !byName.message.includes(PROD.name), 'asking for another profile BY NAME reveals neither its id nor its stored name');
  assert.ok(madeUp.kind === 'refused' && !/bp-/.test(madeUp.message), 'a made-up request leaks no profile id at all');
});

test('does not hold: the caller has no profile → refused holds-none', () => {
  const d = decide({ caller: {} });
  assert.equal(d.kind === 'refused' && d.reason, 'holds-none');
});

test('dangling id: the caller records a profile that was deleted → holds nothing → refused holds-none', () => {
  const d = decide({ caller: { browserProfileId: 'bp-aaaaaaaaaaaa' } });
  assert.equal(d.kind === 'refused' && d.reason, 'holds-none');
  // even asking for the dangling id itself is refused: a deleted profile cannot be passed on
  assert.equal(decide({ caller: { browserProfileId: 'bp-aaaaaaaaaaaa' }, requested: 'bp-aaaaaaaaaaaa' }).kind, 'refused');
});

test('none: no --profile → none (navigation éphémère), whatever the caller holds', () => {
  assert.deepEqual(decide({ requested: undefined }), { kind: 'none' });
  assert.deepEqual(decide({ requested: undefined, caller: undefined, callerVouched: false }), { kind: 'none' });
});

test('detached: a parentless worker gets no profile even from a caller that holds it (fails closed)', () => {
  const d = decide({ detached: true });
  assert.equal(d.kind === 'refused' && d.reason, 'detached');
  assert.ok(d.kind === 'refused' && /navigation éphémère/.test(d.message) && /nested/.test(d.message));
  assert.deepEqual(decide({ detached: true, requested: undefined }), { kind: 'none' }, 'no --profile: nothing to refuse');
});

test('deleting: a profile whose deletion is in flight is not passed on (its carriers were already scanned); another profile deleting does not matter', () => {
  const d = decide({ deleting: [STAGING.id] });
  assert.equal(d.kind === 'refused' && d.reason, 'deleting');
  assert.ok(d.kind === 'refused' && /being deleted/.test(d.message) && /navigation éphémère/.test(d.message));
  assert.equal(decide({ deleting: [PROD.id] }).kind, 'honoured', 'the one the caller holds is not the one being deleted');
  assert.equal(decide({ deleting: [STAGING.id], requested: undefined }).kind, 'none', 'no --profile: nothing to refuse');
  // a deleting profile the caller does NOT hold reads as not-held, never as "deleting" (no oracle on the human's other profiles)
  const other = decide({ requested: PROD.id, deleting: [PROD.id] });
  assert.equal(other.kind === 'refused' && other.reason, 'not-held');
});

test('no caller: an unknown/absent spawning workspace cannot pass a profile', () => {
  const d = decide({ caller: undefined });
  assert.equal(d.kind === 'refused' && d.reason, 'no-caller');
});

test('unvouched: the host cannot vouch for the session → refused even though the caller holds the profile', () => {
  const d = decide({ callerVouched: false });
  assert.equal(d.kind === 'refused' && d.reason, 'unvouched');
});

test('blank value is refused, never read as "none" or as a match', () => {
  for (const requested of ['', '   ']) {
    const d = decide({ requested });
    assert.equal(d.kind === 'refused' && d.reason, 'not-held');
  }
});

test('every refusal says the worker starts in navigation éphémère; an honoured pass does not', () => {
  const refusals = [
    decide({ caller: undefined }),
    decide({ callerVouched: false }),
    decide({ caller: {} }),
    decide({ requested: PROD.id }),
    decide({ detached: true }),
    decide({ deleting: [STAGING.id] }),
  ];
  for (const d of refusals) assert.ok(d.kind === 'refused' && /navigation éphémère/.test(d.message), JSON.stringify(d));
  const ok = decide();
  assert.ok(ok.kind === 'honoured' && !/éphémère/.test(ok.message));
});

test('a long made-up value is truncated in the echo', () => {
  const d = decide({ requested: 'x'.repeat(500) });
  assert.ok(d.kind === 'refused' && d.message.length < 400);
});
