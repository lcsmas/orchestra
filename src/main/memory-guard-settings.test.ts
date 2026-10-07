import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __rebuildMemoryGuardForTests, getMemoryGuardSnapshot, setMemoryGuardSettingsReader } from './memory-guard.ts';
import { memoryGuardView, setMemoryGuardSettings, type MemoryGuardSettingsStore } from './memory-guard-settings.ts';
import { DEFAULT_MEMORY_GUARD_SETTINGS, GIB, MAX_ADMISSION_GB, normalizeMemoryGuardSettings, type MemoryGuardSettings } from '../shared/memory-guard.ts';

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
  let mem = memGb * GIB;
  setMemoryGuardSettingsReader(() => store.getMemoryGuardSettings());
  const g = __rebuildMemoryGuardForTests({ schedule: () => ({}), cancel: () => {}, info: () => {}, warn: () => {} }, () => mem);
  g.start();
  return { cell, store, setMem: (n: number) => { mem = n * GIB; }, stop: () => { g.stop(); __rebuildMemoryGuardForTests(); setMemoryGuardSettingsReader(() => DEFAULT_MEMORY_GUARD_SETTINGS); } };
}

test('a valid change is persisted AND applied at once (no restart, no timer)', async () => {
  const r = rig(8);
  try {
    assert.equal(getMemoryGuardSnapshot().admission, 'open');
    const res = await setMemoryGuardSettings({ admissionGb: 10, criticalGb: 4 }, r.store);
    assert.equal(res.ok, true);
    assert.deepEqual(r.cell.value, { admissionGb: 10, criticalGb: 4, admissionEnabled: true });
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
    const res = await setMemoryGuardSettings({ criticalGb: 9 }, r.store);
    assert.equal(res.ok, false);
    assert.match(res.ok ? '' : res.error, /must be below/);
    assert.equal(r.cell.writes, 0);
    assert.deepEqual(getMemoryGuardSnapshot().admissionBytes, 6 * GIB);
    assert.equal(getMemoryGuardSnapshot().admission, 'open');
  } finally {
    r.stop();
  }
});

test('a patch that is null / not an object is {ok:false}, never a throw', async () => {
  const r = rig(8);
  try {
    const res = await setMemoryGuardSettings(null as unknown as Partial<MemoryGuardSettings>, r.store);
    assert.deepEqual([res.ok, r.cell.writes], [false, 0]);
  } finally {
    r.stop();
  }
});

test('an Admission threshold at/above this machine\'s memory is refused and writes nothing', async () => {
  const total = memoryGuardView(DEFAULT_MEMORY_GUARD_SETTINGS).totalBytes;
  if (total === null || total / GIB >= MAX_ADMISSION_GB - 1) return; // no readable MemTotal / a host too big for the probe value
  const r = rig(8);
  try {
    const res = await setMemoryGuardSettings({ admissionGb: Math.ceil(total / GIB) + 1, criticalGb: 3 }, r.store);
    assert.equal(res.ok, false);
    assert.match(res.ok ? '' : res.error, /this machine's memory/);
    assert.equal(r.cell.writes, 0);
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
    const res = await setMemoryGuardSettings({ admissionGb: 10, criticalGb: 4 }, failing);
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
    const res = await setMemoryGuardSettings({ admissionEnabled: false }, r.store);
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
