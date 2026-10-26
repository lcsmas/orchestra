// #401 — the profile service's `deleting()`: which profiles have a delete RUNNING. A spawn that hands a worker its spawner's profile asks it at the
// record build (spawn-profile-gate.ts), because the delete scanned its carriers when it started. Real service over fake effects (the rig of
// browser-profiles.test.ts is not exported, so a minimal one lives here). Mutants: scripts/spawn-profile-mutants.mjs (D*).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserProfilesService, type BrowserProfilesDeps } from './browser-profiles.ts';
import { deletingProfiles, setDeletingProfilesProbe } from './spawn-profile-gate.ts';
import type { BrowserProfile } from '../shared/types.ts';

const A = 'bp-aaaaaaaaaaaa';
const B = 'bp-bbbbbbbbbbbb';
const P = (id: string, name: string): BrowserProfile => ({ id, name, createdAt: 1 });

function rig(opts: { clearFails?: boolean; settleOk?: boolean } = {}) {
  let profiles = [P(A, 'Staging'), P(B, 'Prod')];
  const workspaces: Array<{ id: string; browserProfileId?: string }> = [{ id: 'ws-1', browserProfileId: A }];
  let releaseSettle: () => void = () => {};
  const held = new Promise<void>((r) => (releaseSettle = r));
  const seenWhileRunning: string[][] = [];
  const deps: BrowserProfilesDeps = {
    getProfiles: () => profiles,
    setProfiles: async (next) => void (profiles = next),
    workspaces: () => workspaces,
    setWorkspaceProfile: async (wsId, id) => { const w = workspaces.find((x) => x.id === wsId)!; if (id === undefined) delete w.browserProfileId; else w.browserProfileId = id; },
    reprofilePanel: (wsId) => ({ wsId, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, tabs: [], activeTabId: '' }),
    clearEphemeral: async () => {},
    openPanelsOn: () => [],
    settleViews: async () => { seenWhileRunning.push(svc.deleting()); await held; return opts.settleOk ?? true; }, // the delete is HELD here until released
    stopSignIns: () => {},
    clearStorage: async () => { if (opts.clearFails) throw new Error('disk on fire'); },
    mintId: () => 'bp-000000000001',
    now: () => 1,
  };
  const svc = createBrowserProfilesService(deps);
  return { svc, workspaces, release: () => releaseSettle(), seenWhileRunning, profiles: () => profiles };
}

test('deleting(): empty at rest; names the profile for exactly the run of its delete; empty again after', async () => {
  const r = rig();
  assert.deepEqual(r.svc.deleting(), []);
  const del = r.svc.remove(A);
  await new Promise((res) => setTimeout(res, 20)); // let the delete reach its held step
  assert.deepEqual(r.svc.deleting(), [A], 'mid-delete (held in settleViews)');
  assert.deepEqual(r.seenWhileRunning, [[A]], 'control: the delete really was running when the flag was read');
  r.release();
  assert.equal((await del).ok, true);
  assert.deepEqual(r.svc.deleting(), [], 'cleared once the profile is gone');
  assert.deepEqual(r.profiles().map((p) => p.id), [B]);
});

test('deleting(): cleared when the delete is REFUSED (views still closing) or its storage clear THROWS — the profile stays and a spawn may hand it on again', async () => {
  for (const opts of [{ settleOk: false }, { clearFails: true }]) {
    const r = rig(opts);
    const del = r.svc.remove(A);
    await new Promise((res) => setTimeout(res, 20));
    assert.deepEqual(r.svc.deleting(), [A]);
    r.release();
    const res = await del;
    assert.equal(res.ok, false);
    assert.deepEqual(r.svc.deleting(), [], JSON.stringify(opts));
    assert.deepEqual(r.profiles().map((p) => p.id), [A, B], 'kept');
  }
});

test('deleting(): an unknown profile id refuses and leaves nothing flagged; a second delete of the same id runs after the first (serial) and flags it again', async () => {
  const r = rig();
  assert.equal((await r.svc.remove('bp-cccccccccccc')).ok, false);
  assert.deepEqual(r.svc.deleting(), []);
  const first = r.svc.remove(A);
  const second = r.svc.remove(A);
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(r.svc.deleting(), [A]);
  r.release();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, false, 'already gone');
  assert.deepEqual(r.svc.deleting(), []);
});

test('the gate: no probe installed (headless harness) → nothing is deleting; the host-installed probe is read live; uninstalling restores the empty answer', async () => {
  setDeletingProfilesProbe(null);
  assert.deepEqual(deletingProfiles(), []);
  const r = rig();
  setDeletingProfilesProbe(() => r.svc.deleting());
  assert.deepEqual(deletingProfiles(), []);
  const del = r.svc.remove(A);
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(deletingProfiles(), [A], 'read through the probe at call time, not cached');
  r.release();
  await del;
  assert.deepEqual(deletingProfiles(), []);
  setDeletingProfilesProbe(null);
});
