// Per-session debug-log retention policy (issue #177).
//
// Every spawned SDK session — HEADLESS included — writes a per-session
// debug/stderr capture via the CLI's `--debug-file` surface (the SDK
// `debugFile` option, which the #176 rig used). The capture lives under
// `<ORCHESTRA_HOME>/logs/sessions/`, NOT under the worktree or the keeper dir,
// so it OUTLIVES workspace deletion: a wedged headless session can be
// autopsied after the fleet is cancelled and the workspace is gone.
//
// This is a BLACK BOX, not a log firehose — retention is bounded on three
// axes (age, total bytes, file count). This module is the PURE policy: given a
// directory listing (name + size + mtime) and the caps, decide which files to
// delete. The main-side wiring (`session-debug-log-fs.ts`) reads the real dir,
// calls this, and unlinks. Pure so it is unit-testable without a filesystem.

/** A per-session debug-log file as the sweeper sees it. */
export interface SessionDebugLogFile {
  /** Basename under the sessions dir, e.g. `<wsId>__2026-09-28T09-52-19-123Z.log`. */
  name: string;
  /** Size in bytes. */
  size: number;
  /** Last-modified epoch ms — the retention clock (creation ≈ spawn time). */
  mtimeMs: number;
}

/** Retention caps. All three are enforced; a file is deleted if it violates
 *  ANY of them (too old, OR pushing the dir over the byte/count budget). */
export interface SessionDebugLogRetention {
  /** Delete files older than this many ms. */
  maxAgeMs: number;
  /** Total-bytes budget for the whole sessions dir. */
  maxTotalBytes: number;
  /** Hard cap on the number of retained files. */
  maxFiles: number;
}

/** Defaults: a black box, not a firehose. ~7 days of history, capped at 200 MB
 *  and 500 files — whichever binds first. Sized so a multi-day incident (the
 *  #176 window was days) is still autopsiable while a busy fleet can't fill the
 *  disk. All three are named constants, UNBASELINED (no field measurement of
 *  the steady-state rate yet — revisit if the dir routinely hits a cap). */
export const DEFAULT_SESSION_DEBUG_RETENTION: SessionDebugLogRetention = {
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxTotalBytes: 200 * 1024 * 1024,
  maxFiles: 500,
};

/** The `.log` extension the sessions dir holds. Anything else is left alone —
 *  the sweep must never touch a stray file it didn't create. */
export const SESSION_DEBUG_LOG_EXT = '.log';

/** Build the basename for a session's debug-log file. Keyed on `wsId` (so every
 *  file for a workspace is greppable AFTER the workspace is deleted) plus the
 *  spawn timestamp (so a resume/restart gets its own file — per-boot autopsy
 *  granularity, not one file overwritten on every reattach). The timestamp is
 *  filename-safe (ISO with `:`/`.` → `-`). */
export function sessionDebugLogName(wsId: string, spawnedAtMs: number): string {
  const ts = new Date(spawnedAtMs).toISOString().replace(/[:.]/g, '-');
  // wsId is a workspace id (uuid-ish / kebab); keep it verbatim but strip any
  // path separators defensively so a hostile id can't escape the dir.
  const safeWs = wsId.replace(/[/\\]/g, '_');
  return `${safeWs}__${ts}${SESSION_DEBUG_LOG_EXT}`;
}

/**
 * Decide which files to delete to satisfy the retention caps. Pure.
 *
 * Rules, applied in order (a file marked for deletion by an earlier rule no
 * longer counts toward the later budgets):
 *   1. AGE — anything older than `maxAgeMs` (relative to `nowMs`) is deleted.
 *   2. COUNT — of the survivors, if there are more than `maxFiles`, delete the
 *      OLDEST until at most `maxFiles` remain.
 *   3. BYTES — of the survivors, while the total exceeds `maxTotalBytes`,
 *      delete the OLDEST until under budget.
 *
 * `keepName` is never deleted (the file about to be written this spawn), so it
 * is excluded from eviction UP FRONT — never added to the delete set and never
 * counted as freed by the BYTES loop. Its bytes DO stay in the running total
 * (it is a real file occupying the budget), so the loop deletes *other* oldest
 * files until the on-disk total is under budget with keepName still present.
 *
 * (Restoring keepName only at the END was a latent bug: if keepName had bytes
 * and was among the oldest, the BYTES loop could "free" its bytes to reach
 * budget and then un-delete it, leaving the dir over budget — review-t1-177 F1.)
 *
 * Returns the basenames to unlink (a subset of the input names, never keepName).
 */
export function planSessionDebugLogSweep(
  files: SessionDebugLogFile[],
  retention: SessionDebugLogRetention,
  nowMs: number,
  keepName?: string,
): string[] {
  const toDelete = new Set<string>();
  // keepName is protected from the START: no rule may target it, and the BYTES
  // loop must never subtract its size (see above).
  const evictable = (name: string) => name !== keepName;
  // Oldest first — every rule evicts from the old end.
  const byAge = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs);

  // 1. Age — evict everything past the age cap EXCEPT keepName.
  for (const f of byAge) {
    if (evictable(f.name) && nowMs - f.mtimeMs > retention.maxAgeMs) toDelete.add(f.name);
  }

  // Age-survivors, keepName excluded, oldest-first — the pool the count/byte
  // rules evict from. keepName never appears here.
  const survivors = () => byAge.filter((f) => !toDelete.has(f.name) && evictable(f.name));

  // 2. Count — evict oldest survivors beyond the cap. keepName still counts
  //    toward the file COUNT (it is a retained file), so the budget for OTHER
  //    files shrinks by 1 when keepName is present.
  {
    const live = survivors();
    const keepExists = keepName !== undefined && byAge.some((f) => f.name === keepName && !toDelete.has(f.name));
    const budget = keepExists ? retention.maxFiles - 1 : retention.maxFiles;
    const over = live.length - budget;
    for (let i = 0; i < over; i++) toDelete.add(live[i].name);
  }

  // 3. Bytes — evict oldest survivors until the ON-DISK total is under budget.
  //    Seed `total` with keepName's bytes (it stays on disk) plus every
  //    surviving evictable file; only evictable files are ever subtracted.
  {
    const keepFile = keepName === undefined ? undefined : byAge.find((f) => f.name === keepName && !toDelete.has(f.name));
    let total = (keepFile?.size ?? 0) + survivors().reduce((n, f) => n + f.size, 0);
    for (const f of survivors()) {
      if (total <= retention.maxTotalBytes) break;
      toDelete.add(f.name);
      total -= f.size;
    }
  }

  return [...toDelete];
}
