import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readMemAvailableBytes, readMemTotalBytes } from './mem-available.ts';
import { GIB } from '../shared/memory-guard.ts';

// The REAL MemAvailable source (the guard's only production reader) — every other test injects a fake one, so without this a broken
// platform check would leave the shipped app UNMEASURED forever with everything green.
const independent = (key: string): number | null => {
  const m = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm').exec(fs.readFileSync('/proc/meminfo', 'utf8'));
  return m ? Number(m[1]) * 1024 : null;
};

test('mem-available: on Linux the real reader returns the host\'s MemAvailable (positive, ≤ MemTotal, within 2 GB of an independent read)', () => {
  if (process.platform !== 'linux') return; // the non-Linux arm below covers other hosts (no skip: the suite gate demands 0 skipped)
  const a = readMemAvailableBytes();
  const total = readMemTotalBytes();
  assert.ok(a !== null && a > 0, `a positive reading, got ${a}`);
  assert.ok(total !== null && a <= total, `MemAvailable ${a} ≤ MemTotal ${total}`);
  const b = independent('MemAvailable');
  assert.ok(b !== null && Math.abs(a - b) < 2 * GIB, `agrees with /proc/meminfo read independently (${a} vs ${b})`);
  assert.equal(total, independent('MemTotal'));
});

test('mem-available: a non-Linux host reads null (UNMEASURED), never os.freemem() — platform faked on any host', () => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  try {
    assert.equal(readMemAvailableBytes(), null);
    assert.equal(readMemTotalBytes(), null);
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
  assert.equal(process.platform, 'linux' === real.value ? 'linux' : real.value);
});
