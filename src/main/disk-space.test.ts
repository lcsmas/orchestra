import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  STATFS_TIMEOUT_MS,
  nearestExisting,
  sampleVolumes,
  statVolume,
  statVolumeFor,
} from './disk-space.ts';

// These drive the REAL statfs against REAL mounts on this machine, because the
// bug class here is not arithmetic — it is reading the wrong field or the wrong
// mount, and a hand-built fixture would just re-encode whichever choice I made.

test('statVolume reports bavail, NOT bfree', async () => {
  // WHY THIS TEST EXISTS: G5 mutation arm 3 (`st.bavail` → `st.bfree`) SURVIVED
  // the whole suite — it typechecks, and nothing asserted which field is read.
  // `bfree` includes root-reserved blocks an unprivileged agent cannot write
  // into, so it over-reports headroom (on a default ext4, by ~5% of total).
  // `df --output=avail` reports bavail, so it is an INDEPENDENT instrument for
  // the same quantity.
  const probe = process.cwd();
  const v = await statVolume(probe, 'test');
  assert.ok(v, 'statVolume returned null on the repo cwd');

  const raw = fs.statfsSync(probe);
  const bsize = Number(raw.bsize);
  const bavailBytes = Number(raw.bavail) * bsize;
  const bfreeBytes = Number(raw.bfree) * bsize;
  assert.equal(v.freeBytes, bavailBytes, 'freeBytes must equal bavail * bsize');

  // The assertion above is only meaningful where the two DIFFER — on a
  // filesystem with no reservation they are equal and the test is vacuous. Say
  // so out loud rather than reporting a silent pass.
  if (bfreeBytes === bavailBytes) {
    console.log(
      '    (note: bfree === bavail on this filesystem — the discriminating half of this test is vacuous here)',
    );
  } else {
    assert.notEqual(v.freeBytes, bfreeBytes, 'freeBytes must NOT be bfree');
  }

  // Cross-check against df, a completely separate implementation. Allow drift:
  // ~26 sibling agents write to this disk continuously, so an exact match would
  // be flaky for reasons unrelated to the field choice. 5% is far tighter than
  // the ~5% root reservation the mutant would introduce on a full-ish disk, but
  // to keep this robust we assert on the RATIO rather than absolute bytes.
  const dfOut = execFileSync('df', ['-B1', '--output=avail', probe], { encoding: 'utf8' });
  const dfAvail = Number(dfOut.trim().split('\n').pop());
  assert.ok(Number.isFinite(dfAvail) && dfAvail > 0, `df gave no usable number: ${dfOut}`);
  const drift = Math.abs(v.freeBytes - dfAvail) / dfAvail;
  assert.ok(drift < 0.05, `statVolume ${v.freeBytes} vs df ${dfAvail} — drift ${drift}`);
});

test('statVolume returns null for a path that cannot be measured', async () => {
  // An unmeasurable mount must be reported as UNMEASURED (null), never as
  // "plenty of room" — a guard that waves through when its instrument breaks
  // is worse than no guard.
  assert.equal(await statVolume('/definitely/not/a/real/path/xyz', 'x'), null);
});

test('nearestExisting walks up to a real ancestor', () => {
  const deep = path.join(process.cwd(), 'release', 'does', 'not', 'exist', 'yet');
  const real = nearestExisting(deep);
  assert.ok(real, 'expected some existing ancestor');
  assert.ok(fs.existsSync(real), `${real} should exist`);
  assert.ok(deep.startsWith(real), `${real} should be an ancestor of ${deep}`);
  // The point: a build output dir that does not exist YET is still checkable.
  assert.equal(nearestExisting(process.cwd()), process.cwd());
});

test('statVolumeFor reports the path the CALLER asked about, not the ancestor', async () => {
  // The mount name in an error message has to be the thing the caller cares
  // about; measuring an ancestor is an implementation detail.
  const notYet = path.join(process.cwd(), 'release-not-created-yet');
  const v = await statVolumeFor(notYet, 'Build output');
  assert.ok(v, 'expected a measurement via the ancestor');
  assert.equal(v.path, notYet);
  assert.ok(v.totalBytes > 0);
});

test('sampleVolumes de-duplicates by device, never by path', async () => {
  const vols = await sampleVolumes();
  assert.ok(vols.length >= 1, 'expected at least one measurable volume');

  const devices = vols.map((v) => v.deviceId);
  assert.equal(
    new Set(devices).size,
    devices.length,
    `two rows share a device id — de-dup failed: ${JSON.stringify(vols.map((v) => [v.path, v.deviceId]))}`,
  );

  for (const v of vols) {
    assert.ok(v.totalBytes > 0, `${v.path} reported totalBytes=0`);
    assert.ok(v.freeBytes >= 0 && v.freeBytes <= v.totalBytes, `${v.path} free out of range`);
    assert.ok(v.label.length > 0, `${v.path} has no label`);
  }
});

test('statVolume: a HUNG mount is reported UNMEASURED within the timeout, not blocking (issue #96)', async () => {
  // #96: the statfs is async and raced against STATFS_TIMEOUT_MS so a hung
  // network mount can neither freeze the main thread nor stall the tick
  // forever. Model the hang BY HAND: patch fs.promises.statfs to never settle
  // for one target path. The shipped code must (a) abandon it after the
  // timeout and return null = UNMEASURED (never "plenty"), and (b) not have
  // blocked the event loop — proven by a heartbeat counter that keeps ticking.
  const target = process.cwd();
  const realStatfs = fs.promises.statfs;
  let beats = 0;
  const hb = setInterval(() => {
    beats += 1;
  }, 10);
  // Keep the loop alive: the shipped watchdog timer is .unref()'d so it must
  // not, on its own, hold a bare test process open.
  const keepAlive = setInterval(() => {}, 50);
  try {
    (fs.promises as { statfs: unknown }).statfs = ((p: string, ...rest: unknown[]) => {
      if (String(p) === target) return new Promise(() => {}); // never resolves
      return (realStatfs as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.promises.statfs;

    const t0 = Date.now();
    const v = await statVolume(target, 'hung');
    const elapsed = Date.now() - t0;

    assert.equal(v, null, 'a hung mount must be reported null (UNMEASURED), never a volume');
    // Abandoned at ~the timeout, not hanging forever and not returning early.
    assert.ok(
      elapsed >= STATFS_TIMEOUT_MS - 50 && elapsed < STATFS_TIMEOUT_MS + 500,
      `expected abandon near ${STATFS_TIMEOUT_MS}ms, got ${elapsed}ms`,
    );
    // The discriminating observable: on the OLD sync code this window froze the
    // loop (0 beats). Async keeps it free — require a healthy count.
    assert.ok(beats > 20, `event loop was starved during the hung statfs: only ${beats} beats`);
  } finally {
    clearInterval(hb);
    clearInterval(keepAlive);
    (fs.promises as { statfs: unknown }).statfs = realStatfs;
  }
});

test('sampleVolumes covers the tmp filesystem, which is the one that filled', async () => {
  // The incident: /tmp is a SEPARATE tmpfs and it hit 100% while $HOME had
  // hundreds of GiB free. A guard reading only $HOME's filesystem would have
  // missed it entirely, so this pins that tmp is actually probed.
  const vols = await sampleVolumes();
  const tmp = os.tmpdir();
  const tmpDev = String(fs.statSync(tmp).dev);
  assert.ok(
    vols.some((v) => v.deviceId === tmpDev),
    `no sampled volume covers ${tmp} (device ${tmpDev}) — got ${JSON.stringify(
      vols.map((v) => [v.path, v.deviceId]),
    )}`,
  );
});
