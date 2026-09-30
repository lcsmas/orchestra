import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  hostPageSize,
  onPageSizeFallback,
  readPageSize,
  realPageSizeSources,
  __resetHostPageSizeForTest,
  type PageSizeSources,
} from './host-page-size.ts';
import { FALLBACK_PAGE_SIZE_BYTES, isPlausiblePageSize, parseAuxvPageSize, parseKernelPageSize, parseProcIdentity, parseProcStatLine } from '../shared/resources.ts';

// #214 finding: `rssPages * 4096` read RSS 4x low on this 16 KB-page host (Asahi/aarch64).

const STAT = '4242 (claude) S 1 4242 4242 0 -1 4194560 100 0 0 0 30 12 0 0 20 0 5 0 987654 500000000 15000 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0';
const LINUX = { skip: process.platform !== 'linux' };

/** A raw auxv image of (type, value) pairs, `entryBytes` wide. */
function auxv(pairs: Array<[number, number]>, entryBytes: 4 | 8, le: boolean): Uint8Array {
  const b = Buffer.alloc(pairs.length * 2 * entryBytes);
  pairs.forEach(([t, v], i) => {
    const o = i * 2 * entryBytes;
    if (entryBytes === 8) {
      le ? b.writeBigUInt64LE(BigInt(t), o) : b.writeBigUInt64BE(BigInt(t), o);
      le ? b.writeBigUInt64LE(BigInt(v), o + 8) : b.writeBigUInt64BE(BigInt(v), o + 8);
    } else {
      le ? b.writeUInt32LE(t, o) : b.writeUInt32BE(t, o);
      le ? b.writeUInt32LE(v, o + 4) : b.writeUInt32BE(v, o + 4);
    }
  });
  return b;
}
const SMAPS = (kb: number) => `00400000-00452000 r-xp 00000000 fd:01 1234 /usr/bin/node\nSize:                328 kB\nKernelPageSize:  ${String(kb).padStart(6)} kB\nMMUPageSize:          16 kB\n`;

/** Counting sources: every read is observable, so a cache (or its absence) is too. */
function sources(a: () => Uint8Array | null, s: () => string | null) {
  const c = { auxv: 0, smaps: 0 };
  const src: PageSizeSources = { auxv: () => { c.auxv++; return a(); }, smaps: () => { c.smaps++; return s(); } };
  return { src, c };
}

test('parseProcStatLine: RSS = stat pages × the page size it is GIVEN (a 16 KB host reads 4× low with a hardcoded 4096)', () => {
  assert.equal(parseProcStatLine(STAT, 16384)?.memBytes, 15000 * 16384);
  assert.equal(parseProcStatLine(STAT, 4096)?.memBytes, 15000 * 4096);
});

test('parseProcIdentity keeps pid/ppid/comm/start-time and reports NO memory (an identity-only reader cannot read RSS 4× low)', () => {
  const p = parseProcIdentity(STAT)!;
  assert.deepEqual([p.pid, p.ppid, p.comm, p.startTicks], [4242, 1, 'claude', 987654]);
  assert.equal(p.memBytes, 0);
});

test('isPlausiblePageSize: a power of two in [4 KiB, 64 KiB] only', () => {
  for (const ok of [4096, 8192, 16384, 32768, 65536]) assert.equal(isPlausiblePageSize(ok), true, String(ok));
  for (const bad of [0, 1024, 2048, 12288, 65537, 131072, 2 * 1024 * 1024, NaN, 4096.5]) assert.equal(isPlausiblePageSize(bad), false, String(bad));
});

test('parseKernelPageSize: first VMA block; refuses hugetlb, non-powers-of-two and absent fields', () => {
  assert.equal(parseKernelPageSize(SMAPS(16)), 16384);
  assert.equal(parseKernelPageSize(SMAPS(4)), 4096);
  assert.equal(parseKernelPageSize(SMAPS(64)), 65536);
  assert.equal(parseKernelPageSize(SMAPS(2048)), null, 'a 2 MB hugetlb first VMA is refused, never ×512');
  assert.equal(parseKernelPageSize(SMAPS(12)), null);
  assert.equal(parseKernelPageSize('nothing here\n'), null);
});

test('parseAuxvPageSize: AT_PAGESZ on 64-bit LE/BE and 32-bit; absent, implausible, AT_NULL-first and truncated are null', () => {
  const others: Array<[number, number]> = [[33, 0x7ffd0000], [16, 0xbfebfbff]];
  assert.equal(parseAuxvPageSize(auxv([...others, [6, 16384], [0, 0]], 8, true), 8, true), 16384);
  assert.equal(parseAuxvPageSize(auxv([...others, [6, 65536], [0, 0]], 8, false), 8, false), 65536);
  assert.equal(parseAuxvPageSize(auxv([...others, [6, 4096], [0, 0]], 4, true), 4, true), 4096);
  assert.equal(parseAuxvPageSize(auxv([...others, [0, 0]], 8, true), 8, true), null, 'no AT_PAGESZ');
  assert.equal(parseAuxvPageSize(auxv([[0, 0], [6, 16384]], 8, true), 8, true), null, 'AT_NULL ends the vector');
  assert.equal(parseAuxvPageSize(auxv([...others, [6, 2 * 1024 * 1024], [0, 0]], 8, true), 8, true), null, 'implausible value');
  assert.equal(parseAuxvPageSize(auxv([...others, [6, 16384]], 8, true).subarray(0, 40), 8, true), null, 'truncated mid-entry');
  assert.equal(parseAuxvPageSize(new Uint8Array(0), 8, true), null);
});

test('readPageSize: AT_PAGESZ wins over smaps; smaps only when auxv yields nothing plausible; both bad ⇒ null', () => {
  const le = os.endianness() === 'LE';
  const eb: 4 | 8 = process.arch === 'ia32' || process.arch === 'arm' ? 4 : 8;
  const good = auxv([[6, 16384], [0, 0]], eb, le);
  const bad = auxv([[6, 3 * 4096], [0, 0]], eb, le);
  const a = sources(() => good, () => SMAPS(4));
  assert.equal(readPageSize(a.src), 16384, 'auxv says 16384, smaps says 4 kB: the kernel-authoritative auxv wins');
  assert.equal(a.c.smaps, 0, 'smaps is not even read when auxv answers');
  assert.equal(readPageSize(sources(() => null, () => SMAPS(16)).src), 16384, 'no auxv → smaps');
  assert.equal(readPageSize(sources(() => bad, () => SMAPS(16)).src), 16384, 'implausible auxv → smaps');
  assert.equal(readPageSize(sources(() => bad, () => SMAPS(2048)).src), null, 'both implausible');
  assert.equal(readPageSize(sources(() => null, () => null).src), null);
});

test('hostPageSize feeds 16 KB from the injected kernel surfaces on ANY host, and caches only a SUCCESSFUL read', LINUX, () => {
  __resetHostPageSizeForTest();
  const s = sources(() => null, () => SMAPS(16));
  assert.equal(hostPageSize(s.src), 16384);
  assert.equal(hostPageSize(s.src), 16384);
  assert.deepEqual(s.c, { auxv: 1, smaps: 1 }, 'the second call is served from the cache: no further read');
});

test('a transient failure does not latch the fallback: it returns 4096, warns ONCE, and recovers on the next call (review F2)', LINUX, () => {
  __resetHostPageSizeForTest();
  const warns: string[] = [];
  onPageSizeFallback((m) => warns.push(m));
  let ok = false;
  const s = sources(() => null, () => (ok ? SMAPS(16) : null));
  assert.equal(hostPageSize(s.src), FALLBACK_PAGE_SIZE_BYTES);
  assert.equal(hostPageSize(s.src), FALLBACK_PAGE_SIZE_BYTES);
  assert.equal(hostPageSize(s.src), FALLBACK_PAGE_SIZE_BYTES);
  assert.equal(warns.length, 1, 'three failing calls, ONE warning');
  assert.match(warns[0], /cannot read the host page size/);
  ok = true;
  assert.equal(hostPageSize(s.src), 16384, 'smaps readable again ⇒ the real page size, not a latched 4096');
  assert.equal(hostPageSize(s.src), 16384);
  assert.equal(warns.length, 1);
  __resetHostPageSizeForTest();
});

test('real sources: hostPageSize() equals the kernel\'s own answer (getconf PAGESIZE)', LINUX, () => {
  __resetHostPageSizeForTest();
  const oracle = Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }).trim());
  assert.equal(hostPageSize(), oracle);
  assert.equal(readPageSize({ auxv: realPageSizeSources.auxv, smaps: () => null }), oracle, 'auxv alone answers');
  assert.equal(readPageSize({ auxv: () => null, smaps: realPageSizeSources.smaps }), oracle, 'smaps alone answers');
});

test('a live /proc read of THIS process agrees with VmRSS once the host page size is used', LINUX, () => {
  __resetHostPageSizeForTest();
  const vmRssKB = Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync('/proc/self/status', 'utf8'))![1]);
  const ratio = parseProcStatLine(fs.readFileSync('/proc/self/stat', 'utf8'), hostPageSize())!.memBytes / (vmRssKB * 1024);
  assert.ok(ratio > 0.8 && ratio < 1.25, `within 25% of VmRSS (ratio ${ratio.toFixed(3)})`);
});
