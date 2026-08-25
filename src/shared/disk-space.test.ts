import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  BUILD_BUNDLES_REQUIRED_BYTES,
  BUILD_PACKAGE_REQUIRED_BYTES,
  CRITICAL_FREE_BYTES,
  CRITICAL_FREE_PCT,
  DISK_FULL_CODE,
  DiskFullError,
  E2E_RIG_REQUIRED_BYTES,
  WARN_FREE_BYTES,
  WARN_FREE_PCT,
  checkRequirement,
  classifyVolume,
  formatBytesShort,
  formatDiskFullMessage,
  worstLevel,
  type VolumeStat,
} from './disk-space.ts';

const GiB = 1024 * 1024 * 1024;
const MiB = 1024 * 1024;

function vol(freeBytes: number, totalBytes: number, over: Partial<VolumeStat> = {}): VolumeStat {
  return {
    path: '/tmp',
    label: 'Temp (/tmp)',
    freeBytes,
    totalBytes,
    fsType: null,
    deviceId: 'dev-1',
    ...over,
  };
}

// ── the threshold policy ───────────────────────────────────────────────────
// The ticket's core objection to a bare percentage: 5% of a 16 GiB tmpfs is
// 800 MiB (fine), 5% of a 2 TiB disk is 100 GiB (absurd). So the rule is
// "whichever fires first", and these cases pin BOTH arms firing independently.

test('classifyVolume: healthy volume is ok', () => {
  assert.equal(classifyVolume(vol(15 * GiB, 16 * GiB)), 'ok');
  assert.equal(classifyVolume(vol(466 * GiB, 551 * GiB)), 'ok');
});

test('classifyVolume: the BYTE floor fires on a big disk that is percentage-healthy', () => {
  // 800 MiB free of 2 TiB = 0.04% — but the point here is the byte arm: even
  // if the percentage were healthy, 800 MiB is below WARN_FREE_BYTES (1 GiB).
  // Construct a case where the PERCENTAGE arm is satisfied and only bytes fire:
  // 900 MiB free of 2 GiB total = 44% free (well above WARN_FREE_PCT).
  const v = vol(900 * MiB, 2 * GiB);
  assert.ok((v.freeBytes / v.totalBytes) * 100 > WARN_FREE_PCT, 'percentage arm must be healthy');
  assert.ok(v.freeBytes < WARN_FREE_BYTES, 'byte arm must be breached');
  assert.equal(classifyVolume(v), 'warn');
});

test('classifyVolume: the PERCENTAGE arm fires on a huge disk with many GiB free', () => {
  // 40 GiB free of 2 TiB = 1.95% — far above the 1 GiB byte floor, so only the
  // percentage arm can produce this verdict.
  const v = vol(40 * GiB, 2048 * GiB);
  assert.ok(v.freeBytes > WARN_FREE_BYTES, 'byte arm must be satisfied');
  assert.ok((v.freeBytes / v.totalBytes) * 100 < CRITICAL_FREE_PCT, 'pct arm must be breached');
  assert.equal(classifyVolume(v), 'critical');
});

test('classifyVolume: the byte floors step ok → warn → critical, with the pct arm held healthy', () => {
  // Hold the PERCENTAGE arm satisfied throughout so this pins the BYTE
  // boundaries alone. A 4 GiB total keeps every free value below well above
  // WARN_FREE_PCT (10%): 256 MiB of 4 GiB is 6.25%… which is NOT above 10%.
  // So use a 2 GiB total, where 256 MiB = 12.5% and 1 GiB = 50%.
  const total = 2 * GiB;
  const pct = (free: number) => (free / total) * 100;

  assert.ok(pct(CRITICAL_FREE_BYTES + 1) > CRITICAL_FREE_PCT, 'pct arm healthy at the critical edge');
  assert.equal(classifyVolume(vol(CRITICAL_FREE_BYTES - 1, total)), 'critical');
  assert.equal(classifyVolume(vol(CRITICAL_FREE_BYTES + 1, total)), 'warn');

  assert.ok(pct(WARN_FREE_BYTES + 1) > WARN_FREE_PCT, 'pct arm healthy at the warn edge');
  assert.equal(classifyVolume(vol(WARN_FREE_BYTES - 1, total)), 'warn');
  assert.equal(classifyVolume(vol(WARN_FREE_BYTES + 1, total)), 'ok');
});

test('classifyVolume: the WARN percentage arm fires with many GiB free', () => {
  // G5 arm 2 SURVIVED without this test: deleting `|| pct < WARN_FREE_PCT`
  // from classifyVolume left the suite green. The critical-percentage case was
  // covered; the WARN one was not. 100 GiB free of 2 TiB = 4.9% — far above
  // the 1 GiB byte floor (so the byte arm is satisfied) and above
  // CRITICAL_FREE_PCT (so it is not critical), which leaves the warn
  // percentage arm as the ONLY clause that can produce this verdict.
  const v = vol(100 * GiB, 2048 * GiB);
  assert.ok(v.freeBytes > WARN_FREE_BYTES, 'byte arm must be satisfied');
  const pct = (v.freeBytes / v.totalBytes) * 100;
  assert.ok(pct < WARN_FREE_PCT, `pct ${pct} must breach WARN_FREE_PCT`);
  assert.ok(pct > CRITICAL_FREE_PCT, `pct ${pct} must NOT breach CRITICAL_FREE_PCT`);
  assert.equal(classifyVolume(v), 'warn');
});

test('classifyVolume: critical outranks warn when BOTH arms are breached', () => {
  // 100 MiB of 16 GiB = 0.6%: under the byte floor AND under the pct floor.
  assert.equal(classifyVolume(vol(100 * MiB, 16 * GiB)), 'critical');
});

test('classifyVolume: a zero-total volume does not divide by zero into a false alarm', () => {
  assert.equal(classifyVolume({ freeBytes: 10 * GiB, totalBytes: 0 }), 'ok');
});

test('worstLevel: one critical volume dominates a set of healthy ones', () => {
  const healthy = vol(15 * GiB, 16 * GiB);
  const full = vol(10 * MiB, 16 * GiB, { path: '/tmp' });
  assert.equal(worstLevel([healthy, healthy]), 'ok');
  assert.equal(worstLevel([healthy, vol(900 * MiB, 2 * GiB)]), 'warn');
  assert.equal(worstLevel([healthy, full]), 'critical');
  // The incident shape: home is 466 GiB free, /tmp is at 100%. A guard that
  // averaged, or that only read $HOME, would report 'ok' here.
  assert.equal(worstLevel([vol(466 * GiB, 551 * GiB), vol(0, 16 * GiB)]), 'critical');
});

test('worstLevel: an EMPTY volume set is not silently ok-by-omission', () => {
  // Documented behaviour: no volumes means nothing was measured. The renderer
  // must show "unmeasured", which it keys off volumes.length === 0 — this test
  // pins that worstLevel alone cannot be used to detect that state.
  assert.equal(worstLevel([]), 'ok');
});

// ── the named error ────────────────────────────────────────────────────────
// This is the ticket's promise: NOT a downstream ENOSPC shape, but a named
// error carrying the mount and the numbers.

test('checkRequirement returns null when there is room, and a DiskFullError when there is not', () => {
  const roomy = vol(15 * GiB, 16 * GiB);
  assert.equal(checkRequirement(roomy, BUILD_BUNDLES_REQUIRED_BYTES, 'build'), null);

  const tight = vol(10 * MiB, 16 * GiB);
  const err = checkRequirement(tight, BUILD_BUNDLES_REQUIRED_BYTES, 'pnpm run build:bundles');
  assert.ok(err instanceof DiskFullError);
  assert.equal(err.code, DISK_FULL_CODE);
  assert.equal(err.name, 'DiskFullError');
});

test('the named error carries the MOUNT, the FREE bytes and the REQUIRED bytes', () => {
  // Each of the three is asserted individually: an error missing any one of
  // them cannot be acted on, and a message-shape test that only greps the code
  // would pass on an error carrying none of the numbers.
  const err = checkRequirement(
    vol(10 * MiB, 16 * GiB, { path: '/tmp' }),
    2 * GiB,
    'packaging build',
  )!;
  assert.equal(err.mount, '/tmp');
  assert.equal(err.freeBytes, 10 * MiB);
  assert.equal(err.requiredBytes, 2 * GiB);
  assert.equal(err.totalBytes, 16 * GiB);

  assert.match(err.message, /ORCHESTRA_DISK_FULL/);
  assert.match(err.message, /\/tmp/);
  assert.match(err.message, /free 10\.0 MB/);
  assert.match(err.message, /required 2\.00 GB/);
  assert.match(err.message, /packaging build/);
});

test('the named error is NOT an ENOSPC shape — that is the whole point', () => {
  const err = checkRequirement(vol(0, 16 * GiB), 1 * GiB, 'rig')!;
  assert.doesNotMatch(err.message, /ENOSPC/);
  assert.equal((err as unknown as { errno?: number }).errno, undefined);
  // and it is greppable by a stable code, not by prose
  assert.equal(err.code, 'ORCHESTRA_DISK_FULL');
});

test('the error message states the refusal to delete (the sleeping-owner rule)', () => {
  const msg = formatDiskFullMessage({
    mount: '/tmp',
    freeBytes: 0,
    requiredBytes: GiB,
    totalBytes: 16 * GiB,
    operation: 'rig',
  });
  assert.match(msg, /does NOT auto-delete/);
});

test('formatBytesShort', () => {
  assert.equal(formatBytesShort(512), '512 B');
  assert.equal(formatBytesShort(1024), '1.00 KB');
  assert.equal(formatBytesShort(16 * GiB), '16.0 GB');
  assert.equal(formatBytesShort(2 * GiB), '2.00 GB');
});

// ── source-binding: the .cjs duplicate must not drift ──────────────────────
// scripts/disk-guard.cjs cannot import this TS module (it runs before any
// bundling), so it duplicates the constants and the message format. A
// duplicate nothing checks becomes two different thresholds silently. This
// test is the check.

test('scripts/disk-guard.cjs presets match the TS constants', () => {
  const cjsPath = path.join(process.cwd(), 'scripts', 'disk-guard.cjs');
  assert.ok(fs.existsSync(cjsPath), `expected ${cjsPath} to exist`);
  const guard = createRequire(import.meta.url)(cjsPath) as {
    PRESETS: Record<string, { bytes: number; op: string }>;
    DISK_FULL_CODE: string;
    formatDiskFullMessage: (a: {
      mount: string;
      freeBytes: number;
      requiredBytes: number;
      totalBytes: number;
      operation: string;
    }) => string;
  };
  assert.equal(guard.DISK_FULL_CODE, DISK_FULL_CODE);
  assert.equal(guard.PRESETS['build-bundles'].bytes, BUILD_BUNDLES_REQUIRED_BYTES);
  assert.equal(guard.PRESETS['build-package'].bytes, BUILD_PACKAGE_REQUIRED_BYTES);
  assert.equal(guard.PRESETS['e2e-rig'].bytes, E2E_RIG_REQUIRED_BYTES);
});

test('scripts/disk-guard.cjs produces the SAME message as the TS module', () => {
  const cjsPath = path.join(process.cwd(), 'scripts', 'disk-guard.cjs');
  const guard = createRequire(import.meta.url)(cjsPath) as {
    formatDiskFullMessage: (a: {
      mount: string;
      freeBytes: number;
      requiredBytes: number;
      totalBytes: number;
      operation: string;
    }) => string;
  };
  const args = {
    mount: '/tmp',
    freeBytes: 3 * MiB,
    requiredBytes: 256 * MiB,
    totalBytes: 16 * GiB,
    operation: 'contained E2E rig',
  };
  assert.equal(guard.formatDiskFullMessage(args), formatDiskFullMessage(args));
});

test('the policy constants are ordered sanely (critical is stricter than warn)', () => {
  assert.ok(CRITICAL_FREE_BYTES < WARN_FREE_BYTES);
  assert.ok(CRITICAL_FREE_PCT < WARN_FREE_PCT);
});
