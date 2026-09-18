// Node-only inbox WRITER. Lives in src/main/ — never src/shared/ — because the
// renderer imports inbox-blocks.ts for value exports (StructuredView pulls in
// resolveInboxReDerive), so a `node:fs/promises` import there is bundled into
// the renderer and throws `require is not defined` at load, blanking the window
// (shipped in 0.5.275, caught post-release). Parsing/framing stays platform-free
// in shared; only the write side is here.

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/** Per-inbox-file serialization chain (issue #93).
 *
 *  WHY. `queueInbox` used a bare `await appendFile(path, block)`. `appendFile`
 *  opens with `O_APPEND`, but O_APPEND atomicity is per `write(2)` syscall, NOT
 *  per `appendFile` call — Node splits a large buffer into kernel-sized chunks,
 *  so two `appendFile`s racing on the SAME path interleave their chunks and
 *  SPLICE one block inside another. No bytes are lost, but the delimiter grammar
 *  breaks and `parseInboxBlocks` OVER-COUNTS (measured on btrfs: 10 concurrent
 *  512 KB writers → 17-19 parsed blocks; latent today only because the sole
 *  caller truncates to MESSAGE_MAX_CHARS=8000, and 512 B-256 KB stay intact).
 *
 *  Every inbox writer is in ONE process (the main process; the shell hook only
 *  `cat`s + `rm`s, the tray writes synchronously with `writeFileSync`), so the
 *  fix is an in-process async mutex keyed by the resolved file path — no `flock`
 *  dependency, deterministic, and it makes one `appendFile` complete before the
 *  next on that path begins. Same defect class as the events-spool tear
 *  (#28/#37), same remedy: one writer at a time. */
const inboxAppendChains = new Map<string, Promise<unknown>>();

/** Append one already-framed block to `filePath`, serialized against every other
 *  append to the SAME path so concurrent large writes cannot splice (issue #93).
 *  `mkdir` of the parent runs inside the chain too, so the directory is present
 *  before the write without racing sibling appends. Rejects on write failure;
 *  the caller (`queueInbox`) maps that to `false`. */
export async function appendInboxBlock(filePath: string, block: string): Promise<void> {
  const key = path.resolve(filePath);
  const prior = inboxAppendChains.get(key) ?? Promise.resolve();
  // Chain even past a rejection so one failed append never wedges the path.
  const next = prior.catch(() => {}).then(async () => {
    await mkdir(path.dirname(key), { recursive: true });
    await appendFile(key, block, 'utf8');
  });
  inboxAppendChains.set(key, next);
  try {
    await next;
  } finally {
    // Drop the chain entry once we are its tail, so the map does not grow
    // unboundedly across a long-lived process.
    if (inboxAppendChains.get(key) === next) inboxAppendChains.delete(key);
  }
}
