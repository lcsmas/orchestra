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
const path = require('node:path');

// ── duplicated policy, parity-tested against src/shared/disk-space.ts ───────
const DISK_FULL_CODE = 'ORCHESTRA_DISK_FULL';
const DISK_FULL_EXIT = 17;
const PRESETS = {
  'build-bundles': { bytes: 64 * 1024 * 1024, op: 'pnpm run build:bundles' },
  'build-package': { bytes: 2 * 1024 * 1024 * 1024, op: 'packaging build (electron-builder)' },
  'e2e-rig': { bytes: 256 * 1024 * 1024, op: 'contained E2E rig' },
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

function nearestExisting(p) {
  let cur = path.resolve(p);
  for (let i = 0; i < 64; i += 1) {
    if (fs.existsSync(cur)) return cur;
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

function main() {
  const preset = arg('--preset');
  const probe = arg('--path') || process.cwd();
  let requiredBytes = arg('--required-bytes') ? Number(arg('--required-bytes')) : null;
  let operation = arg('--op');

  if (preset) {
    const p = PRESETS[preset];
    if (!p) {
      process.stderr.write(`disk-guard: unknown --preset ${preset}\n`);
      return 1;
    }
    if (requiredBytes === null) requiredBytes = p.bytes;
    if (!operation) operation = p.op;
  }
  if (requiredBytes === null || !Number.isFinite(requiredBytes)) {
    process.stderr.write('disk-guard: --required-bytes or --preset is required\n');
    return 1;
  }
  operation = operation || 'operation';

  const real = nearestExisting(probe);
  if (!real) {
    process.stderr.write(`disk-guard: cannot resolve any existing path for ${probe}\n`);
    return 1;
  }
  let st;
  try {
    st = fs.statfsSync(real);
  } catch (e) {
    // An UNMEASURED mount is reported as a failure, not waved through. A guard
    // that returns 0 when its instrument is broken is worse than no guard.
    process.stderr.write(`disk-guard: statfs(${real}) failed: ${e && e.message}\n`);
    return 1;
  }
  const bsize = Number(st.bsize) || 0;
  const freeBytes = Number(st.bavail) * bsize;
  const totalBytes = Number(st.blocks) * bsize;

  if (freeBytes < requiredBytes) {
    process.stderr.write(
      formatDiskFullMessage({
        mount: probe,
        freeBytes,
        requiredBytes,
        totalBytes,
        operation,
      }) + '\n',
    );
    return DISK_FULL_EXIT;
  }
  process.stderr.write(
    `disk-guard OK: ${probe} free ${formatBytesShort(freeBytes)} of ` +
      `${formatBytesShort(totalBytes)}, required ${formatBytesShort(requiredBytes)} ` +
      `for ${operation}\n`,
  );
  return 0;
}

module.exports = { formatDiskFullMessage, formatBytesShort, PRESETS, DISK_FULL_CODE, DISK_FULL_EXIT };

// Only act when RUN, never when required. The parity test in
// src/shared/disk-space.test.ts requires this file to compare its constants
// against the TS source; without this guard that require() would execute
// main(), print a usage error and set process.exitCode = 1, failing the whole
// test FILE while every individual subtest reported ok — a failure with no
// `not ok` subtest to point at it.
if (require.main === module) {
  process.exitCode = main();
}
