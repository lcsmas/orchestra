// Profils navigateur (#400): the SERVICE's orchestration over fake effects — what create / rename / delete / attach do
// to the profile list, the workspace records, the panels and the partition storage, and in WHICH ORDER (a delete that
// clears storage before the old views are gone, or forgets the profile before the clear succeeded, loses sign-ins
// the human believes are erased). Mutants that must redden this file: scripts/mutate-browser-profiles.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserProfilesService, type BrowserProfilesDeps } from './browser-profiles.ts';
import type { BrowserPanelState, BrowserProfile } from '../shared/types.ts';

const A = 'bp-aaaaaaaaaaaa';
const B = 'bp-bbbbbbbbbbbb';

function rig(init?: { profiles?: BrowserProfile[]; workspaces?: Array<{ id: string; browserProfileId?: string }>; clearFails?: boolean; latency?: boolean; openOn?: string[]; settleTimesOut?: boolean }) {
  const tick = () => (init?.latency ? new Promise<void>((r) => setTimeout(r, 5)) : Promise.resolve());
  const calls: string[] = [];
  const onProfile = new Set(init?.openOn ?? []); // workspaces whose open panel runs on a profile (a re-profile moves it off)
  let profiles: BrowserProfile[] = init?.profiles ?? [];
  const workspaces = (init?.workspaces ?? []).map((w) => ({ ...w }));
  let n = 0;
  const stateOf = (wsId: string, profileId?: string): BrowserPanelState => ({
    wsId, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, tabs: [], activeTabId: '',
    ...(profileId ? { profileId } : {}),
  });
  const deps: BrowserProfilesDeps = {
    getProfiles: () => profiles,
    setProfiles: async (next) => {
      calls.push(`setProfiles:${next.map((p) => p.id).join(',')}`);
      await tick(); // a real write takes time: an unserialized second operation would read the list in this gap
      profiles = next;
    },
    workspaces: () => workspaces,
    setWorkspaceProfile: async (wsId, profileId) => {
      calls.push(`record:${wsId}=${profileId ?? '-'}`);
      const w = workspaces.find((x) => x.id === wsId)!;
      if (profileId === undefined) delete w.browserProfileId;
      else w.browserProfileId = profileId;
    },
    reprofilePanel: (wsId, profileId) => {
      calls.push(`reprofile:${wsId}=${profileId ?? '-'}`);
      if (profileId === undefined) onProfile.delete(wsId);
      return stateOf(wsId, profileId);
    },
    clearEphemeral: async (wsId) => {
      calls.push(`ephemeral:${wsId}`);
    },
    openPanelsOn: () => [...onProfile],
    settleViews: async () => {
      calls.push('settle');
      return !init?.settleTimesOut;
    },
    stopSignIns: (id) => void calls.push(`stop:${id}`),
    clearStorage: async (id) => {
      calls.push(`clear:${id}`);
      await tick();
      if (init?.clearFails) throw new Error('disk on fire');
    },
    mintId: () => `bp-${String(++n).padStart(12, '0')}`,
    now: () => 1000,
  };
  return { svc: createBrowserProfilesService(deps), calls, workspaces, profiles: () => profiles };
}

const P = (id: string, name: string): BrowserProfile => ({ id, name, createdAt: 1 });

test('create: validates the name, mints an id, stores it; duplicate / empty refused with nothing written', async () => {
  const r = rig({ profiles: [P(A, 'Staging')] });
  const ok = await r.svc.create('  Prod admin ');
  assert.equal(ok.ok, true);
  assert.deepEqual(r.profiles().map((p) => p.name), ['Staging', 'Prod admin']);
  assert.equal((ok as { profile: BrowserProfile }).profile.id, 'bp-000000000001');
  assert.equal((ok as { profile: BrowserProfile }).profile.createdAt, 1000);
  for (const [name, reason] of [['staging', 'duplicate'], ['  ', 'empty'], ['x'.repeat(41), 'too-long']] as const) {
    const before = r.calls.length;
    const bad = await r.svc.create(name);
    assert.equal(bad.ok, false);
    assert.equal((bad as { reason: string }).reason, reason);
    assert.equal(r.calls.length, before, `${reason}: nothing written`);
  }
});

test('create: an id that is already taken is re-minted, never reused', async () => {
  const r = rig({ profiles: [P('bp-000000000001', 'Taken')] });
  const ok = await r.svc.create('Fresh');
  assert.equal((ok as { profile: BrowserProfile }).profile.id, 'bp-000000000002');
});

test('rename: keeps the id and the partition, refuses a clash with ANOTHER profile, unknown id refused', async () => {
  const r = rig({ profiles: [P(A, 'Staging'), P(B, 'Prod')] });
  assert.equal((await r.svc.rename(A, 'STAGING')).ok, true, 're-casing its own name is fine');
  assert.deepEqual(r.profiles().find((p) => p.id === A), { id: A, name: 'STAGING', createdAt: 1 });
  const clash = await r.svc.rename(A, 'prod');
  assert.equal((clash as { reason: string }).reason, 'duplicate');
  assert.equal(r.profiles().find((p) => p.id === A)!.name, 'STAGING', 'unchanged after a refusal');
  assert.equal(((await r.svc.rename('bp-cccccccccccc', 'X')) as { reason: string }).reason, 'unknown-profile');
  assert.equal(r.calls.some((c) => c.startsWith('reprofile') || c.startsWith('clear')), false, 'a rename never touches a panel or storage');
});

test('attach: records the id on the workspace THEN rebuilds its panel on that profile; returns the new state', async () => {
  const r = rig({ profiles: [P(A, 'Staging')], workspaces: [{ id: 'w1' }] });
  const res = await r.svc.assign('w1', A);
  assert.equal(res.ok, true);
  assert.deepEqual(r.calls, [`record:w1=${A}`, `reprofile:w1=${A}`]);
  assert.equal((res as { state: BrowserPanelState }).state.profileId, A);
  assert.equal(r.workspaces[0].browserProfileId, A);
});

test('attach: switching and detaching; the same profile again rebuilds nothing new (reprofilePanel is told the same id)', async () => {
  const r = rig({ profiles: [P(A, 'Staging'), P(B, 'Prod')], workspaces: [{ id: 'w1', browserProfileId: A }] });
  assert.equal((await r.svc.assign('w1', B)).ok, true);
  assert.equal(r.workspaces[0].browserProfileId, B);
  assert.equal((await r.svc.assign('w1', null)).ok, true);
  assert.equal(r.workspaces[0].browserProfileId, undefined, 'detach clears the record');
  assert.equal(r.calls.at(-1), 'reprofile:w1=-');
  r.calls.length = 0;
  assert.equal((await r.svc.assign('w1', null)).ok, true);
  assert.deepEqual(r.calls, ['reprofile:w1=-'], 'already detached: no record write');
});

test('F9: leaving a profile for navigation éphémère first CLEARS the workspace\'s old ephemeral session (sign-ins made before the attach must not resurface); attach / switch / an already-ephemeral detach never clear it', async () => {
  const r = rig({ profiles: [P(A, 'Staging'), P(B, 'Prod')], workspaces: [{ id: 'w1' }, { id: 'w2', browserProfileId: A }] });
  await r.svc.assign('w1', A);   // ephemeral → profile: the ephemeral session is left alone (it may still be on screen until the rebuild)
  await r.svc.assign('w1', B);   // profile → profile
  assert.equal(r.calls.some((c) => c.startsWith('ephemeral:')), false, 'no clear on attach / switch');
  r.calls.length = 0;
  await r.svc.assign('w1', null); // profile → ephemeral: cleared BEFORE the panel is rebuilt on it
  assert.deepEqual(r.calls, ['ephemeral:w1', 'record:w1=-', 'reprofile:w1=-']);
  r.calls.length = 0;
  await r.svc.assign('w1', null); // already ephemeral: nothing to clear (that session may be IN USE)
  assert.deepEqual(r.calls, ['reprofile:w1=-']);
});

test('attach: an unknown profile or workspace is refused and NOTHING moves', async () => {
  const r = rig({ profiles: [P(A, 'Staging')], workspaces: [{ id: 'w1' }] });
  const bad = await r.svc.assign('w1', 'bp-eeeeeeeeeeee');
  assert.equal((bad as { reason: string }).reason, 'unknown-profile');
  const noWs = await r.svc.assign('ghost', A);
  assert.equal((noWs as { reason: string }).reason, 'unknown-workspace');
  assert.deepEqual(r.calls, []);
});

test('attach: when the panel cannot move, the record is rolled back and the error surfaces', async () => {
  const r = rig({ profiles: [P(A, 'Staging')], workspaces: [{ id: 'w1' }] });
  const deps2: BrowserProfilesDeps = {
    getProfiles: () => r.profiles(),
    setProfiles: async () => {},
    workspaces: () => r.workspaces,
    setWorkspaceProfile: async (wsId, id) => {
      r.calls.push(`record:${wsId}=${id ?? '-'}`);
      if (id === undefined) delete r.workspaces[0].browserProfileId;
      else r.workspaces[0].browserProfileId = id;
    },
    reprofilePanel: () => {
      throw new Error('main window not ready');
    },
    clearEphemeral: async () => {},
    openPanelsOn: () => [],
    settleViews: async () => true,
    stopSignIns: () => {},
    clearStorage: async () => {},
    mintId: () => A,
    now: () => 0,
  };
  const svc = createBrowserProfilesService(deps2);
  await assert.rejects(() => svc.assign('w1', A), /main window not ready/);
  assert.equal(r.workspaces[0].browserProfileId, undefined, 'record restored');
  assert.deepEqual(r.calls, [`record:w1=${A}`, 'record:w1=-']);
});

test('delete: detaches every carrier, reloads ephemeral, clears storage, THEN forgets the profile — in that order', async () => {
  const r = rig({
    profiles: [P(A, 'Staging'), P(B, 'Prod')],
    workspaces: [{ id: 'w1', browserProfileId: A }, { id: 'w2' }, { id: 'w3', browserProfileId: B }, { id: 'w4', browserProfileId: A }],
  });
  const res = await r.svc.remove(A);
  assert.equal(res.ok, true);
  assert.deepEqual(r.calls, [
    'record:w1=-', 'ephemeral:w1', 'reprofile:w1=-',
    'record:w4=-', 'ephemeral:w4', 'reprofile:w4=-',
    'settle',
    `stop:${A}`,
    `clear:${A}`,
    `setProfiles:${B}`,
  ]);
  assert.deepEqual(r.workspaces.map((w) => w.browserProfileId), [undefined, undefined, B, undefined], 'w3 keeps ITS profile');
  assert.deepEqual(r.profiles().map((p) => p.id), [B]);
});

test('delete: a failed storage clear KEEPS the profile (retryable) and says so; the carriers are already ephemeral', async () => {
  const r = rig({ profiles: [P(A, 'Staging')], workspaces: [{ id: 'w1', browserProfileId: A }], clearFails: true });
  const res = await r.svc.remove(A);
  assert.equal(res.ok, false);
  assert.equal((res as { reason: string }).reason, 'storage');
  assert.match((res as { message: string }).message, /disk on fire/);
  assert.deepEqual(r.profiles().map((p) => p.id), [A], 'profile still on record');
  assert.equal(r.workspaces[0].browserProfileId, undefined);
  assert.equal(r.calls.some((c) => c.startsWith('setProfiles')), false);
});

test('delete: unknown profile refused with nothing touched; a profile nobody carries still clears its storage', async () => {
  const r = rig({ profiles: [P(A, 'Staging')], workspaces: [{ id: 'w1' }] });
  assert.equal(((await r.svc.remove('bp-eeeeeeeeeeee')) as { reason: string }).reason, 'unknown-profile');
  assert.deepEqual(r.calls, []);
  assert.equal((await r.svc.remove(A)).ok, true);
  assert.deepEqual(r.calls, ['settle', `stop:${A}`, `clear:${A}`, 'setProfiles:']);
});

test('delete: an OPEN panel still on the profile though its record says otherwise is moved off it too, before the wipe', async () => {
  const r = rig({ profiles: [P(A, 'Staging')], workspaces: [{ id: 'w1' }, { id: 'w2', browserProfileId: A }], openOn: ['w1', 'w2'] });
  await r.svc.remove(A);
  // w2 is a recorded carrier (record cleared + moved); w1's record is clean but its views still run on A (a half-failed earlier move): moved, nothing recorded
  assert.deepEqual(r.calls, ['record:w2=-', 'ephemeral:w2', 'reprofile:w2=-', 'ephemeral:w1', 'reprofile:w1=-', 'settle', `stop:${A}`, `clear:${A}`, 'setProfiles:']);
});

test('delete: views still closing after the wait ⇒ the profile is KEPT, nothing wiped, the delete can be retried (carriers are already ephemeral)', async () => {
  const r = rig({ profiles: [P(A, 'Staging')], workspaces: [{ id: 'w1', browserProfileId: A }], settleTimesOut: true });
  const res = await r.svc.remove(A);
  assert.equal(res.ok, false);
  assert.equal((res as { reason: string }).reason, 'storage');
  assert.match((res as { message: string }).message, /still closing/);
  assert.equal(r.calls.some((c) => c.startsWith('clear:') || c.startsWith('stop:') || c.startsWith('setProfiles')), false, 'no wipe, no stop, profile kept');
  assert.deepEqual(r.profiles().map((p) => p.id), [A]);
});

test('operations are serialized: create + delete fired together never interleave their read-modify-writes', async () => {
  const r = rig({ profiles: [P(A, 'Staging')], latency: true });
  const [c, d] = await Promise.all([r.svc.create('New'), r.svc.remove(A)]);
  assert.equal(c.ok && d.ok, true);
  assert.deepEqual(r.profiles().map((p) => p.name), ['New'], 'both applied, neither lost');
  const r2 = rig({ profiles: [], latency: true });
  const [x, y] = await Promise.all([r2.svc.create('One'), r2.svc.create('Two')]);
  assert.equal(x.ok && y.ok, true);
  assert.deepEqual(r2.profiles().map((p) => p.name), ['One', 'Two'], 'two creates in a row both land');
});
