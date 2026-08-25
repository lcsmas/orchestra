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
  SMALL_VOLUME_FACTOR,
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


// ── C3-F5: a small volume must be able to read `ok` ────────────────────────
// Before the fix, ANY filesystem smaller than WARN_FREE_BYTES could never
// classify `ok` — a 100 MiB tmpfs at 0% used read `critical`. worstLevel()
// takes the max, so one such mount pins the whole page to a permanent
// "critically low" badge, and a warning that is always on is worse than none.

test('classifyVolume: a small but EMPTY volume reads ok, not critical', () => {
  assert.equal(classifyVolume(vol(100 * MiB, 100 * MiB)), 'ok', '100% free 100 MiB tmpfs');
  assert.equal(classifyVolume(vol(512 * MiB, 512 * MiB)), 'ok', '100% free 512 MiB tmpfs');
  assert.equal(classifyVolume(vol(64 * MiB, 64 * MiB)), 'ok', "100% free container /tmp");
});

test('classifyVolume: a small volume still warns on PERCENTAGE when actually full', () => {
  // The floor is skipped for small volumes, so the percentage arm must still
  // do its job — otherwise the F5 fix would have created a blind spot.
  // NB the boundaries: CRITICAL_FREE_PCT is 3 and WARN_FREE_PCT is 10, so 4%
  // is WARN, not critical — my first version of this test asserted 'critical'
  // at 4% and failed. Pinning the values with the percentage stated.
  assert.equal(classifyVolume(vol(2 * MiB, 100 * MiB)), 'critical', '2% free < CRITICAL_FREE_PCT 3');
  assert.equal(classifyVolume(vol(4 * MiB, 100 * MiB)), 'warn', '4% free: >3 critical, <10 warn');
  assert.equal(classifyVolume(vol(8 * MiB, 100 * MiB)), 'warn', '8% free < WARN_FREE_PCT 10');
  assert.equal(classifyVolume(vol(50 * MiB, 100 * MiB)), 'ok', '50% free');
});

test('classifyVolume: the byte floor STILL applies above the small-volume cutoff', () => {
  // Guard against over-correcting F5 into "the floor never fires".
  const total = WARN_FREE_BYTES * SMALL_VOLUME_FACTOR; // exactly at the cutoff
  const v = vol(WARN_FREE_BYTES - 1, total);
  assert.ok((v.freeBytes / v.totalBytes) * 100 > WARN_FREE_PCT, 'pct arm healthy');
  assert.equal(classifyVolume(v), 'warn', 'the byte arm must still fire at the cutoff');
});

test('worstLevel: a small empty mount does NOT pin the page to critical', () => {
  // The F5 consequence, asserted at the level the UI actually consumes.
  const healthy = vol(465 * GiB, 550 * GiB);
  const smallEmptyBoot = vol(100 * MiB, 100 * MiB);
  assert.equal(worstLevel([healthy, smallEmptyBoot]), 'ok');
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

test('scripts/disk-guard.cjs DECISION: isShort is a real comparison, not a constant', () => {
  // C3-F2: inverting `freeBytes < requiredBytes` inside disk-guard.cjs SURVIVED
  // the entire suite — the parity test below checks constants and message
  // FORMAT, and never touched the decision. That is the same shape as the
  // bavail/bfree survivor, one layer down: a second implementation defended
  // only by a comment. These assert the decision itself, both directions, so
  // an inversion cannot pass.
  const guard = createRequire(import.meta.url)(
    path.join(process.cwd(), 'scripts', 'disk-guard.cjs'),
  ) as { isShort: (free: number, req: number) => boolean };

  assert.equal(guard.isShort(0, 1), true, 'no space at all is short');
  assert.equal(guard.isShort(63 * MiB, 64 * MiB), true, 'just under is short');
  assert.equal(guard.isShort(64 * MiB, 64 * MiB), false, 'exactly enough is NOT short');
  assert.equal(guard.isShort(65 * MiB, 64 * MiB), false, 'over is NOT short');
  assert.equal(guard.isShort(465 * GiB, 64 * MiB), false, 'a healthy machine is NOT short');
});

test('scripts/disk-guard.cjs agrees with the TS checkRequirement on the same inputs', () => {
  // Cross-implementation parity on the DECISION, so the two halves cannot
  // diverge silently the way the constants could have.
  const guard = createRequire(import.meta.url)(
    path.join(process.cwd(), 'scripts', 'disk-guard.cjs'),
  ) as { isShort: (free: number, req: number) => boolean };

  const cases: Array<[number, number]> = [
    [0, 1],
    [63 * MiB, 64 * MiB],
    [64 * MiB, 64 * MiB],
    [2 * GiB, 3 * GiB],
    [465 * GiB, 3 * GiB],
  ];
  for (const [free, req] of cases) {
    const tsSaysShort = checkRequirement(vol(free, 550 * GiB), req, 'x') !== null;
    assert.equal(
      guard.isShort(free, req),
      tsSaysShort,
      `disagreement at free=${free} required=${req}`,
    );
  }
});

test('scripts/disk-guard.cjs presets carry a PROBE SET covering the tmp filesystem', () => {
  // C3-F3: the build presets used to probe only `.`, while esbuild and
  // electron-builder stage into os.tmpdir() — a DIFFERENT device here. A full
  // /tmp beside a roomy repo disk is literally the reported incident, and the
  // guard said OK through it.
  const guard = createRequire(import.meta.url)(
    path.join(process.cwd(), 'scripts', 'disk-guard.cjs'),
  ) as { PRESETS: Record<string, { bytes: number; op: string; probes: string[] }> };

  for (const name of ['build-bundles', 'build-package']) {
    const probes = guard.PRESETS[name].probes;
    assert.ok(Array.isArray(probes), `${name} has no probe set`);
    assert.ok(probes.includes('tmp'), `${name} must probe the tmp filesystem`);
    assert.ok(probes.includes('cwd'), `${name} must probe the repo/output filesystem`);
  }
  assert.ok(guard.PRESETS['e2e-rig'].probes.includes('tmp'), 'the rig preset must probe tmp');
});

test('scripts/disk-guard.cjs nearestExisting refuses to fall back to the root fs', () => {
  // C3-F6: the walk used to run all the way to `/`, so an absent path measured
  // the ROOT filesystem and printed "OK: /nonexistent/xyz free 465 GB" —
  // naming a mount it never probed, contradicting the file's own contract.
  const guard = createRequire(import.meta.url)(
    path.join(process.cwd(), 'scripts', 'disk-guard.cjs'),
  ) as { nearestExisting: (p: string) => string | null };

  assert.equal(guard.nearestExisting('/nonexistent/xyz'), null);
  // ...but a genuinely-not-yet-created subdir of a real tree still resolves.
  const notYet = path.join(process.cwd(), 'release-not-created-yet');
  assert.equal(guard.nearestExisting(notYet), process.cwd());
});

test('CI guards the packaging step, which does not inherit the `build` script guard', () => {
  // C3-F4: `.github/workflows/release.yml` calls `pnpm exec electron-builder`
  // DIRECTLY (deliberately — see the argv comment there about `--publish
  // never`), so it never runs `pnpm run build` and therefore never picked up
  // the `build-package` preset. CI was unguarded at the single step with the
  // largest requirement. A workflow file is not covered by any other gate
  // here, so this test is the only thing that notices if the line is dropped.
  const wf = path.join(process.cwd(), '.github', 'workflows', 'release.yml');
  assert.ok(fs.existsSync(wf), `expected ${wf}`);
  const text = fs.readFileSync(wf, 'utf8');

  // Positive control: the file really is the one we think it is.
  assert.match(text, /electron-builder --publish never/, 'control: CI packaging step not found');

  const guardLine = /disk-guard\.cjs --preset build-package/;
  assert.match(text, guardLine, 'CI must run the build-package preflight');

  // ...and it must come BEFORE the packaging command, or it guards nothing.
  const gi = text.search(guardLine);
  const ei = text.search(/pnpm exec electron-builder --publish never/);
  assert.ok(gi >= 0 && ei >= 0 && gi < ei, `guard at ${gi} must precede electron-builder at ${ei}`);
});
