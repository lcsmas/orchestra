// The host's memory page size — /proc/<pid>/stat reports RSS in PAGES, so `rss * 4096` reads 4x LOW on a 16 KB-page
// host (Asahi/aarch64; found by the #214 field alarms). Primary source: AT_PAGESZ in /proc/self/auxv (the kernel's own
// answer for this process); fallback: `KernelPageSize` at the head of /proc/self/smaps. Only a power of two in
// [4 KiB, 64 KiB] is accepted. Only a SUCCESSFUL read is cached: a transient failure must not latch 4096 for the whole
// run (review F2) — it returns the fallback, warns once, and tries again on the next call.
import fs from 'node:fs';
import os from 'node:os';
import {
  FALLBACK_PAGE_SIZE_BYTES,
  parseAuxvPageSize,
  parseKernelPageSize,
} from '../shared/resources.ts';

/** The two kernel surfaces, injectable so a test/rig can feed any page size on any host. Each returns null on failure. */
export interface PageSizeSources {
  auxv(): Uint8Array | null;
  /** The first ~8 KiB of /proc/self/smaps as text. */
  smaps(): string | null;
}

export const realPageSizeSources: PageSizeSources = {
  auxv: () => {
    try {
      return fs.readFileSync('/proc/self/auxv');
    } catch {
      return null;
    }
  },
  smaps: () => {
    let fd: number | null = null;
    try {
      fd = fs.openSync('/proc/self/smaps', 'r');
      const buf = Buffer.alloc(8192); // the first VMA block carries KernelPageSize; no need to read every mapping
      return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0));
    } catch {
      return null;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  },
};

/** auxv → smaps; null when neither yields a plausible page size. */
export function readPageSize(src: PageSizeSources): number | null {
  const is64 = process.arch !== 'ia32' && process.arch !== 'arm';
  const auxv = src.auxv();
  if (auxv) {
    const v = parseAuxvPageSize(auxv, is64 ? 8 : 4, os.endianness() === 'LE');
    if (v !== null) return v;
  }
  const smaps = src.smaps();
  return smaps === null ? null : parseKernelPageSize(smaps);
}

let cached: number | null = null;
let warned = false;
let warn: (message: string) => void = () => {};

/** Where the once-only fallback warning goes (the monitor points it at its logger; unset = silent, e.g. in tests). */
export function onPageSizeFallback(fn: (message: string) => void): void {
  warn = fn;
}

export function hostPageSize(src: PageSizeSources = realPageSizeSources): number {
  if (cached !== null) return cached;
  if (process.platform !== 'linux') return FALLBACK_PAGE_SIZE_BYTES; // no /proc: callers on this path read `ps` KiB anyway
  const bytes = readPageSize(src);
  if (bytes === null) {
    if (!warned) {
      warned = true;
      warn(`resources: cannot read the host page size (auxv + smaps) — RSS assumes ${FALLBACK_PAGE_SIZE_BYTES} B pages and may read low; retrying each sample`);
    }
    return FALLBACK_PAGE_SIZE_BYTES;
  }
  cached = bytes;
  return bytes;
}

/** Test seam. */
export const __resetHostPageSizeForTest = (): void => {
  cached = null;
  warned = false;
  warn = () => {};
};
