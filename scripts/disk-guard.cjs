#!/usr/bin/env node
// Disk-space preflight for builds and E2E rigs (issue #87).
//
// WHY A .cjs AND NOT THE TS MODULE. The shell helpers (scripts/*.sh,
// package.json build steps, electron-builder hooks) run before/outside any
// bundling step, so they cannot import src/shared/disk-space.ts. This file is
// the shell-callable half. Its constants are DUPLICATED from that module on
// purpose, and src/shared/disk-space.test.ts asserts the two copies
// agree — a drifting duplicate that nothing checks is how a threshold silently
// becomes two different thresholds.
//
// It NEVER deletes anything. See the scope limit in src/shared/disk-space.ts.
//
// Usage:
//   node scripts/disk-guard.cjs --path <dir> --required-bytes <n> --op <label>
//   node scripts/disk-guard.cjs --preset build-bundles --path .
//   node scripts/disk-guard.cjs --preset build-package --path .
//   node scripts/disk-guard.cjs --preset e2e-rig --path /tmp
//
// Exit codes:
//   0  enough room (prints one OK line to stderr)
//   1  usage error / could not measure (an UNMEASURED mount is not "fine")
//  17  ORCHESTRA_DISK_FULL — the named failure. Distinct from 1 so a caller
//      can branch on "not enough disk" without parsing text.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ── duplicated policy, parity-tested against src/shared/disk-space.ts ───────
const DISK_FULL_CODE = 'ORCHESTRA_DISK_FULL';
const DISK_FULL_EXIT = 17;
// Each preset names the byte requirement AND the SET of paths that must satisfy
// it. The probe set is the F3 fix: `.` alone is wrong, because esbuild
// (`esbuild/lib/main.js:2096`) and electron-builder's `temp-file`
// (`temp-file/out/main.js:24`, honouring APP_BUILDER_TMP_DIR) stage into
// `os.tmpdir()`, which on this machine is a DIFFERENT DEVICE from the repo
// (cwd dev 45, tmpdir dev 46 — measured 2026-08-25). A full /tmp beside a roomy
// repo disk IS the reported incident, and probing only `.` said OK through it.
//
// 'cwd' and 'tmp' are resolved at call time, not baked in, so the guard follows
// TMPDIR/APP_BUILDER_TMP_DIR wherever the build actually stages.
const PRESETS = {
  'build-bundles': {
    // MEASURED 2026-08-25: peak dist+dist-electron = 5856 KiB = 5.72 MiB
    // (1s sampling, reviewer-counter-measured). ~11x headroom at 64 MiB.
    bytes: 64 * 1024 * 1024,
    op: 'pnpm run build:bundles',
    probes: ['cwd', 'tmp'],
  },
  'build-package': {
    // MEASURED 2026-08-25 (1s sampling, 40 gapless samples, reviewer C3-F1):
    // peak release/ = 2262392 KiB = 2.158 GiB, when the unpacked tree and the
    // AppImage coexist; final after cleanup = 1.215 GiB. The previous 2.000 GiB
    // constant was 161 MiB BELOW that peak — the guard passed and the build
    // then died on ENOSPC, i.e. exactly the failure #87 exists to eliminate.
    // 3 GiB = measured peak + ~39% margin for run-to-run variance, which is
    // itself UNBASELINED (the peak is N=1 on one machine).
    bytes: 3 * 1024 * 1024 * 1024,
    op: 'packaging build (electron-builder)',
    probes: ['cwd', 'tmp'],
  },
  'e2e-rig': {
    // UNBASELINED: largest observed rig dir is 176 KiB, but a rig boots
    // Electron, which writes caches and can dump a core. Conservative floor.
    bytes: 256 * 1024 * 1024,
    op: 'contained E2E rig',
    probes: ['tmp'],
  },
};

function formatBytesShort(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return i === 0 ? `${v} B` : `${v < 10 ? v.toFixed(2) : v.toFixed(1)} ${units[i]}`;
}

function formatDiskFullMessage({ mount, freeBytes, requiredBytes, totalBytes, operation }) {
  const shortfall = Math.max(0, requiredBytes - freeBytes);
  return (
    `${DISK_FULL_CODE}: not enough free space on ${mount} for ${operation} — ` +
    `free ${formatBytesShort(freeBytes)} of ${formatBytesShort(totalBytes)}, ` +
    `required ${formatBytesShort(requiredBytes)} ` +
    `(short by ${formatBytesShort(shortfall)}). ` +
    `Orchestra does NOT auto-delete: another agent's rig may live on this mount. ` +
    `Free space yourself, then retry.`
  );
}

// Walk up to the nearest EXISTING ancestor, so a not-yet-created output dir
// (`release/`) is still checkable. F6 fix: the walk previously ran all the way
// to `/`, so a typo'd or absent path measured the ROOT filesystem and printed a
// confident "disk-guard OK: /nonexistent/xyz free 465 GB" — naming a mount it
// never probed, and directly contradicting this file's own contract that an
// unmeasurable path exits 1 rather than being waved through.
//
// The bound: we only accept an ancestor that is a plausible parent of the
// requested path, i.e. we refuse to fall back to `/` unless `/` was asked for.
// Anything that walks that far means the caller named a path that does not
// belong to any real tree, which is a caller bug worth failing loudly.
function nearestExisting(p) {
  let cur = path.resolve(p);
  const root = path.parse(cur).root;
  for (let i = 0; i < 64; i += 1) {
    if (fs.existsSync(cur)) {
      if (cur === root && path.resolve(p) !== root) return null;
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

/** THE DECISION: is `freeBytes` insufficient for `requiredBytes`?
 *  A named, exported one-liner precisely so a test can assert it. Inverting
 *  this comparison used to survive the whole suite (C3-F2). */
function isShort(freeBytes, requiredBytes) {
  return freeBytes < requiredBytes;
}

/** Measure one path. Returns {ok:false, fatal:true} when it cannot be measured
 *  — never "plenty of room". */
function measure(probe) {
  const real = nearestExisting(probe);
  if (!real) {
    return { fatal: `cannot resolve any existing path for ${probe}` };
  }
  let st;
  try {
    st = fs.statfsSync(real);
  } catch (e) {
    // An UNMEASURED mount is reported as a failure, not waved through. A guard
    // that returns 0 when its instrument is broken is worse than no guard.
    return { fatal: `statfs(${real}) failed: ${e && e.message}` };
  }
  const bsize = Number(st.bsize) || 0;
  return {
    probe,
    measuredAt: real,
    deviceId: (() => {
      try {
        return String(fs.statSync(real).dev);
      } catch {
        return real;
      }
    })(),
    freeBytes: Number(st.bavail) * bsize,
    totalBytes: Number(st.blocks) * bsize,
  };
}

function main() {
  const preset = arg('--preset');
  let requiredBytes = arg('--required-bytes') ? Number(arg('--required-bytes')) : null;
  let operation = arg('--op');
  let probes = null;

  if (preset) {
    const p = PRESETS[preset];
    if (!p) {
      process.stderr.write(`disk-guard: unknown --preset ${preset}\n`);
      return 1;
    }
    if (requiredBytes === null) requiredBytes = p.bytes;
    if (!operation) operation = p.op;
    probes = p.probes;
  }
  if (requiredBytes === null || !Number.isFinite(requiredBytes)) {
    process.stderr.write('disk-guard: --required-bytes or --preset is required\n');
    return 1;
  }
  operation = operation || 'operation';

  // An explicit --path overrides a preset's probe set (single-path mode, which
  // is what the rigs use to aim at one specific mount).
  const explicit = arg('--path');
  let paths;
  if (explicit) {
    paths = [explicit];
  } else if (probes) {
    paths = probes.map((k) => (k === 'tmp' ? os.tmpdir() : process.cwd()));
  } else {
    paths = [process.cwd()];
  }

  // De-duplicate by DEVICE, not by path: where /tmp is not its own mount these
  // collapse to one reading instead of two identical ones.
  const seen = new Set();
  const measured = [];
  for (const p of paths) {
    const m = measure(p);
    if (m.fatal) {
      process.stderr.write(`disk-guard: ${m.fatal}\n`);
      return 1;
    }
    if (seen.has(m.deviceId)) continue;
    seen.add(m.deviceId);
    measured.push(m);
  }

  // EVERY probed filesystem must satisfy the requirement. Reporting the worst
  // one is not enough on its own — the message must name WHICH mount failed,
  // because "not enough space" without the mount is the unactionable shape this
  // ticket exists to eliminate.
  const failed = measured.filter((m) => isShort(m.freeBytes, requiredBytes));
  if (failed.length) {
    for (const m of failed) {
      process.stderr.write(
        formatDiskFullMessage({
          mount: m.probe,
          freeBytes: m.freeBytes,
          requiredBytes,
          totalBytes: m.totalBytes,
          operation,
        }) + '\n',
      );
    }
    return DISK_FULL_EXIT;
  }
  for (const m of measured) {
    process.stderr.write(
      `disk-guard OK: ${m.probe} free ${formatBytesShort(m.freeBytes)} of ` +
        `${formatBytesShort(m.totalBytes)}, required ${formatBytesShort(requiredBytes)} ` +
        `for ${operation}\n`,
    );
  }
  return 0;
}

module.exports = {
  formatDiskFullMessage,
  formatBytesShort,
  PRESETS,
  DISK_FULL_CODE,
  DISK_FULL_EXIT,
  // Exported for testing. C3-F2: inverting the comparison inside main()
  // survived the ENTIRE suite, because the parity test only checked constants
  // and message FORMAT — never the decision. This is the decision, extracted so
  // it can be asserted directly rather than only through a rig nobody runs.
  isShort,
  nearestExisting,
  measure,
};

// Only act when RUN, never when required. The parity test in
// src/shared/disk-space.test.ts requires this file to compare its constants
// against the TS source; without this guard that require() would execute
// main(), print a usage error and set process.exitCode = 1, failing the whole
// test FILE while every individual subtest reported ok — a failure with no
// `not ok` subtest to point at it.
if (require.main === module) {
  process.exitCode = main();
}
