// The REAL state of Electron's EnableCookieEncryption fuse in the binary this process runs (#407): read from the binary's own fuse wire, never assumed from the build
// config. Electron exposes no API for fuses, so the executable is streamed until the wire sentinel (it sits ~12 % into a ~200 MB binary: ~25 MB, page-cache warm after the
// first read). Fails to 'unknown' (which the warning treats as OFF); cached for the life of the process (a fuse cannot change under a running binary).
import fs from 'node:fs';
import type { CookieFuseState } from '../shared/cookie-fuse-policy.ts';
// one parser for the build step, the rigs and this reader (scripts/lib/fuse-wire.cjs) — imported STATICALLY so the bundler inlines it (scripts/ is not packaged, a runtime require would not resolve)
import fuseWire from '../../scripts/lib/fuse-wire.cjs';

const { SENTINEL, parseFuseWire } = fuseWire as {
  SENTINEL: string;
  parseFuseWire: (b: Buffer) => { ok: boolean; reason?: string; fuses?: Record<string, string> };
};

/** Find the first fuse wire in a stream of chunks (a sentinel may straddle two chunks). */
export async function scanForCookieFuse(chunks: AsyncIterable<Uint8Array>): Promise<CookieFuseState> {
  const needle = Buffer.from(SENTINEL, 'latin1');
  const wireBytes = needle.length + 2 + 32; // sentinel · version · length · up to 32 fuses
  let carry: Buffer = Buffer.alloc(0);
  for await (const chunk of chunks) {
    const buf = Buffer.concat([carry, Buffer.from(chunk)]);
    const at = buf.indexOf(needle);
    if (at >= 0) {
      if (buf.length - at < wireBytes) { carry = buf.subarray(at); continue; } // the wire continues in the next chunk
      return stateOf(buf.subarray(at, at + wireBytes));
    }
    carry = buf.subarray(Math.max(0, buf.length - needle.length + 1));
  }
  return carry.length >= needle.length && carry.indexOf(needle) >= 0 ? stateOf(carry) : 'unknown';
}

function stateOf(window: Buffer): CookieFuseState {
  const w = parseFuseWire(window);
  const s = w.ok ? w.fuses?.EnableCookieEncryption : undefined;
  return s === 'enabled' ? 'enabled' : s === 'disabled' ? 'disabled' : 'unknown';
}

let cached: Promise<CookieFuseState> | null = null;

/** The fuse state of `binary` (default: this process's executable), read once. */
export function readOwnCookieFuse(binary: string = process.execPath): Promise<CookieFuseState> {
  cached ??= scanForCookieFuse(fs.createReadStream(binary, { highWaterMark: 4 * 1024 * 1024 })).catch(() => 'unknown' as const);
  return cached;
}

/** test seam */
export function resetCookieFuseCache(): void {
  cached = null;
}
