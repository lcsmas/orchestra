// Backward chunked file-tail reader — pure node:fs, no Electron (node-testable).
//
// Built for the loop reconcile (main/loop-scan.ts): the deciding
// `ScheduleWakeup` entry can sit far from EOF in a chatty session (observed
// 474 KB from the end of a 3.2 MB transcript — a fixed 256 KiB tail rendered
// the verdict permanently `unknown`, which by design clears nothing, so the
// stale badge could never heal). Instead of one fixed window we read 256 KiB
// chunks from the end until the needle appears, the file is exhausted, or a
// hard cap is hit — the common case (needle near EOF) still costs one small
// read.

import fs from 'node:fs/promises';

/** Per-read chunk. */
export const TAIL_CHUNK_BYTES = 256 * 1024;

/** Hard ceiling per call — transcripts reach 10 MB+; a needle further back
 *  than this is treated as not found (caller sees the capped window). */
export const TAIL_MAX_BYTES = 8 * 1024 * 1024;

/** Read a file's tail backwards in {@link TAIL_CHUNK_BYTES} chunks until
 *  `needle` (ASCII) is inside the accumulated window, the whole file is read,
 *  or {@link TAIL_MAX_BYTES} is reached. Returns the accumulated tail decoded
 *  as UTF-8 (which may or may not contain the needle — the caller's scanner
 *  decides), or null on any fs error.
 *
 *  Decoding happens ONCE over the concatenated buffer: decoding per-chunk
 *  would mangle a multi-byte UTF-8 char split across a chunk boundary into
 *  U+FFFD on both sides, corrupting exactly one JSON line per seam. The
 *  boundary probe likewise overlaps `needle.length` bytes into the
 *  already-read side so a needle straddling a seam still terminates the walk. */
export async function readTailUntil(file: string, needle: string): Promise<string | null> {
  const needleBuf = Buffer.from(needle, 'utf8');
  try {
    const handle = await fs.open(file, 'r');
    try {
      const size = (await handle.stat()).size;
      const floor = Math.max(0, size - TAIL_MAX_BYTES);
      const chunks: Buffer[] = [];
      let start = size;
      while (start > floor) {
        const next = Math.max(floor, start - TAIL_CHUNK_BYTES);
        const buf = Buffer.alloc(start - next);
        await handle.read(buf, 0, buf.length, next);
        chunks.unshift(buf);
        start = next;
        // Probe this chunk plus a needle-length overlap into the previously
        // read (later-in-file) chunk, so a straddling needle is still seen.
        const probe =
          chunks.length > 1
            ? Buffer.concat([chunks[0], chunks[1].subarray(0, needleBuf.length)])
            : chunks[0];
        if (probe.includes(needleBuf)) break;
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
