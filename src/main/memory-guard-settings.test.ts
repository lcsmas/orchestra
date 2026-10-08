import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __rebuildMemoryGuardForTests, getMemoryGuardSnapshot, setMemoryGuardSettingsReader } from './memory-guard.ts';
import { memoryGuardView, setMemoryGuardSettings, type MemoryGuardSettingsStore } from './memory-guard-settings.ts';
import { DEFAULT_MEMORY_GUARD_SETTINGS, GIB, normalizeMemoryGuardSettings, type MemoryGuardSettings } from '../shared/memory-guard.ts';

/** A MemTotal roomy enough for every threshold these tests choose, so none depends on the machine running them. */
const ROOMY = 64 * GIB;

/** A store cell + a real guard on a fake source: the REAL write path (validate → persist → re-sample now) is what runs. */
function rig(memGb: number) {
  const cell = { value: { ...DEFAULT_MEMORY_GUARD_SETTINGS } as MemoryGuardSettings, writes: 0 };
  const store: MemoryGuardSettingsStore = {
    getMemoryGuardSettings: () => normalizeMemoryGuardSettings(cell.value),
    setMemoryGuardSettings: async (next) => {
      cell.writes += 1;
      cell.value = next;
    },
  };
  let mem: number | null = memGb * GIB;
  setMemoryGuardSettingsReader(() => store.getMemoryGuardSettings());
  const g = __rebuildMemoryGuardForTests({ schedule: () => ({}), cancel: () => {}, info: () => {}, warn: () => {} }, () => mem);
  g.start();
  return { cell, store, setMem: (n: number) => { mem = n * GIB; }, setMemNull: () => { mem = null; }, stop: () => { g.stop(); __rebuildMemoryGuardForTests(); setMemoryGuardSettingsReader(() => DEFAULT_MEMORY_GUARD_SETTINGS); } };
}

test('a valid change is persisted AND applied at once (no restart, no timer)', async () => {
  const r = rig(8);
  try {
    assert.equal(getMemoryGuardSnapshot().admission, 'open');
    const res = await setMemoryGuardSettings({ admissionGb: 10, criticalGb: 4 }, r.store, ROOMY);
    assert.equal(res.ok, true);
    assert.deepEqual(r.cell.value, { admissionGb: 10, criticalGb: 4, admissionEnabled: true, capSoftGb: 3, capHardGb: 6 });
    assert.equal(getMemoryGuardSnapshot().admission, 'held', 'the new threshold decided at once');
    assert.equal(res.view.snapshot.admissionBytes, 10 * GIB);
    assert.equal(res.view.settings.admissionGb, 10);
  } finally {
    r.stop();
  }
});

test('an invalid pair is refused, writes nothing and leaves the guard untouched', async () => {
  const r = rig(8);
  try {
    const res = await setMemoryGuardSettings({ criticalGb: 9 }, r.store, ROOMY);
    assert.equal(res.ok, false);
    assert.match(res.ok ? '' : res.error, /must be below/);
    assert.equal(r.cell.writes, 0);
    assert.deepEqual(getMemoryGuardSnapshot().admissionBytes, 6 * GIB);
    assert.equal(getMemoryGuardSnapshot().admission, 'open');
  } finally {
    r.stop();
  }
});

test('memoryGuardView is FRESH: after a fall 8→4 GB the view shows held and the SAME reading — never "4.0 GB" beside a green open chip', () => {
  const r = rig(8);
  try {
    assert.equal(getMemoryGuardSnapshot().admission, 'open');
    r.setMem(4); // no timer fired: the cached snapshot would still say open
    assert.equal(getMemoryGuardSnapshot().admission, 'open', 'control: the cached snapshot IS stale at this point');
    const v = memoryGuardView(DEFAULT_MEMORY_GUARD_SETTINGS);
    assert.equal(v.snapshot.admission, 'held');
    assert.equal(v.liveAvailBytes, 4 * GIB, 'the live figure is the snapshot\'s own reading (from the injected source)');
    assert.equal(v.liveAvailBytes, v.snapshot.availBytes);
  } finally {
    r.stop();
  }
});

test('memoryGuardView: an unreadable meter shows no live figure (null), never the last good one', () => {
  const r = rig(8);
  try {
    r.setMemNull();
    const v = memoryGuardView(DEFAULT_MEMORY_GUARD_SETTINGS);
    assert.equal(v.snapshot.measured, false);
    assert.equal(v.liveAvailBytes, null);
  } finally {
    r.stop();
  }
});

test('toggle_keeps_custom_thresholds: flipping the toggle with NON-default stored thresholds leaves them alone', async () => {
  const r = rig(12);
  try {
    r.cell.value = { admissionGb: 10, criticalGb: 4, admissionEnabled: true, capSoftGb: 3, capHardGb: 6 };
    const res = await setMemoryGuardSettings({ admissionEnabled: false }, r.store, ROOMY);
    assert.equal(res.ok, true);
    assert.deepEqual(r.cell.value, { admissionGb: 10, criticalGb: 4, admissionEnabled: false, capSoftGb: 3, capHardGb: 6 });
    assert.deepEqual([res.view.settings.admissionGb, res.view.settings.criticalGb], [10, 4]);
    assert.equal(res.view.snapshot.admissionBytes, 10 * GIB);
    const again = await setMemoryGuardSettings({ admissionGb: 12 }, r.store, ROOMY);
    assert.equal(again.ok, true);
    assert.deepEqual(r.cell.value, { admissionGb: 12, criticalGb: 4, admissionEnabled: false, capSoftGb: 3, capHardGb: 6 }, 'the OFF toggle and the custom critical survive a threshold edit');
  } finally {
    r.stop();
  }
});

test('a patch that is null / not an object is {ok:false}, never a throw', async () => {
  const r = rig(8);
  try {
    const res = await setMemoryGuardSettings(null as unknown as Partial<MemoryGuardSettings>, r.store, ROOMY);
    assert.deepEqual([res.ok, r.cell.writes], [false, 0]);
  } finally {
    r.stop();
  }
});

test('an Admission threshold whose reopen point is at/above this machine\'s memory is refused and writes nothing (MemTotal injected: host-independent)', async () => {
  const r = rig(8);
  try {
    const res = await setMemoryGuardSettings({ admissionGb: 31, criticalGb: 3 }, r.store, 32 * GIB);
    assert.equal(res.ok, false);
    assert.match(res.ok ? '' : res.error, /reopen margin must be below this machine's memory \(32\.0 GB\)/);
    assert.equal(r.cell.writes, 0);
    const fine = await setMemoryGuardSettings({ admissionGb: 30, criticalGb: 3 }, r.store, 32 * GIB);
    assert.equal(fine.ok, true, '30 + 1 < 32 is reachable');
  } finally {
    r.stop();
  }
});

test('a save that FAILS still applies the value live and says so (ok:false, "applied now, but could not be saved")', async () => {
  const r = rig(8);
  try {
    const failing: MemoryGuardSettingsStore = {
      getMemoryGuardSettings: r.store.getMemoryGuardSettings,
      setMemoryGuardSettings: async (next) => {
        r.cell.value = next; // the real store sets its in-memory copy before the write that fails
        throw new Error('ENOSPC');
      },
    };
    const res = await setMemoryGuardSettings({ admissionGb: 10, criticalGb: 4 }, failing, ROOMY);
    assert.equal(res.ok, false);
    assert.match(res.ok ? '' : res.error, /applied now, but could not be saved \(ENOSPC\)/);
    assert.equal(getMemoryGuardSnapshot().admission, 'held', 'the new threshold is live and decided at once');
    assert.equal(res.view.settings.admissionGb, 10);
  } finally {
    r.stop();
  }
});

test('the toggle alone is a valid patch and shows in the snapshot', async () => {
  const r = rig(5);
  try {
    assert.equal(getMemoryGuardSnapshot().admissionEnabled, true);
    const res = await setMemoryGuardSettings({ admissionEnabled: false }, r.store, ROOMY);
    assert.equal(res.ok, true);
    assert.equal(getMemoryGuardSnapshot().admissionEnabled, false);
    assert.equal(getMemoryGuardSnapshot().admission, 'held', 'it still measures + decides; only the consumers stop holding');
  } finally {
    r.stop();
  }
});

test('the view carries settings + snapshot + a live reading slot', () => {
  const v = memoryGuardView({ ...DEFAULT_MEMORY_GUARD_SETTINGS });
  assert.equal(v.settings.admissionGb, 6);
  assert.ok('measured' in v.snapshot);
  assert.ok(v.liveAvailBytes === null || v.liveAvailBytes > 0);
});
