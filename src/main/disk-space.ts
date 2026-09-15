// Platform I/O for the disk-space guard (issue #87): the first `statfs(2)`
// call in this codebase. The policy (thresholds, error shape) is pure and
// lives in ../shared/disk-space.ts.
//
// WHICH FILESYSTEMS. At minimum two, and they are NOT the same device on this
// machine: `~/.orchestra` (worktrees, scratch, logs, backups, the events
// spool) sits on the 551 GiB home filesystem, while `/tmp` is a SEPARATE
// 16 GiB tmpfs — verified 2026-08-25 with `df -h /tmp $HOME` and
// `findmnt -no TARGET,FSTYPE,SIZE,AVAIL /tmp`. A guard that only read $HOME's
// filesystem would have shown 466 GiB free while /tmp was at 100%, i.e. it
// would have MISSED the incident this ticket exists for. We also probe the
// repo/cwd, because a build writes dist/ and release/ there and it may be on a
// third device.
//
// De-duplication is by st_dev, not by path: on a machine where /tmp is a plain
// directory on the root filesystem, probing both would otherwise double-report
// the same device with two different labels.
//
// ASYNC, OFF THE HOT PATH (issue #96). The Resources page ticks every 2s and
// `sampleResources()` awaits `sampleVolumes()`. A SYNCHRONOUS `fs.statfsSync`
// on the main process blocks the whole event loop for the duration of the
// syscall — negligible (0.007 ms) on a local mount, but UNBOUNDED on a hung
// network mount (NFS/sshfs whose server has gone away), which would freeze the
// entire UI. So every statfs here goes through `fs.promises.statfs`, which runs
// on libuv's threadpool and never blocks the main thread, and each probe is
// raced against a short timeout so one wedged mount cannot stall the tick
// either: a timed-out (or failed) mount is reported as `null` = UNMEASURED, the
// same "never silently plenty" contract the sync version had. Freshness is
// unchanged — still sampled fresh every tick, no cache (#87: a mount filling
// fast is exactly when a stale reading is most dangerous).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VolumeStat } from '../shared/disk-space.ts';

/** Per-mount statfs budget. A local statfs is ~0.007 ms; anything past this is
 *  a hung/degraded mount and we report it UNMEASURED rather than let it stall
 *  the 2s tick. Well under the tick cadence so a slow-but-alive mount that
 *  answers within the budget is still measured fresh. */
export const STATFS_TIMEOUT_MS = 1_000;

/** Reject a promise if it has not settled within `ms`. On timeout the loser is
 *  abandoned (statfs on a hung mount may never resolve) — that is fine, it runs
 *  on the threadpool and holds nothing on the main thread. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`statfs timed out after ${ms}ms`)), ms);
    // Do not keep the process alive just for this watchdog.
    if (typeof timer.unref === 'function') timer.unref();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** statfs one path. Returns null when the path does not exist, statfs fails
 *  (a non-Linux platform without statfs support, a vanished dir, …) or the
 *  mount does not answer within `STATFS_TIMEOUT_MS` (a hung network mount) —
 *  a null volume is reported as "unmeasured", never as "plenty of room".
 *  Async so a hung mount never blocks the main-process event loop (#96). */
export async function statVolume(probePath: string, label: string): Promise<VolumeStat | null> {
  let st: fs.StatsFs;
  try {
    st = await withTimeout(fs.promises.statfs(probePath), STATFS_TIMEOUT_MS);
  } catch {
    return null;
  }
  let deviceId = probePath;
  try {
    deviceId = String((await withTimeout(fs.promises.stat(probePath), STATFS_TIMEOUT_MS)).dev);
  } catch {
    /* keep the path as a fallback identity */
  }
  const bsize = Number(st.bsize) || 0;
  return {
    path: probePath,
    label,
    // `bavail`, not `bfree`: bfree counts root-reserved blocks that an agent
    // process cannot actually write into, so bfree would over-report headroom
    // on a reserved ext4 filesystem by ~5% of total.
    freeBytes: Number(st.bavail) * bsize,
    totalBytes: Number(st.blocks) * bsize,
    deviceId,
  };
}

/** Resolve the nearest existing ancestor of a path — statfs needs a path that
 *  exists, but a build's output dir (`release/`) may not exist yet, and its
 *  parent is on the same filesystem anyway.
 *
 *  Kept SYNCHRONOUS on purpose: `fs.existsSync` is a `lstat`, not `statfs`, and
 *  the hazard #96 fixes is statfs blocking on a hung mount, not lstat. Walking
 *  the ancestor chain touches only path components that already exist locally,
 *  so this does not reintroduce the block. */
export function nearestExisting(p: string): string | null {
  let cur = path.resolve(p);
  for (let i = 0; i < 64; i += 1) {
    if (fs.existsSync(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

/** statfs a path, walking up to its nearest existing ancestor first. */
export async function statVolumeFor(probePath: string, label: string): Promise<VolumeStat | null> {
  const real = nearestExisting(probePath);
  if (!real) return null;
  const v = await statVolume(real, label);
  if (!v) return null;
  // Report the path the CALLER asked about — that is the actionable mount
  // name in an error message — while the measurement came from `real`.
  return { ...v, path: probePath };
}

/** The volumes the Resources page shows. De-duplicated by device so a machine
 *  where /tmp is not a separate mount reports one row, not two identical ones
 *  under different names. The three probes run CONCURRENTLY (independent
 *  syscalls on the threadpool) so a slow mount does not serialize behind the
 *  others; de-dup and ordering are applied after all settle, preserving the
 *  candidate order (~/.orchestra, tmp, cwd). */
export async function sampleVolumes(): Promise<VolumeStat[]> {
  const tmpDir = os.tmpdir();
  const candidates: Array<[string, string]> = [
    [path.join(os.homedir(), '.orchestra'), 'Orchestra data'],
    [tmpDir, `Temp (${tmpDir})`],
    [process.cwd(), 'Repo / build output'],
  ];
  const measured = await Promise.all(candidates.map(([p, label]) => statVolumeFor(p, label)));
  const out: VolumeStat[] = [];
  const seen = new Set<string>();
  for (const v of measured) {
    if (!v) continue;
    if (seen.has(v.deviceId)) continue;
    seen.add(v.deviceId);
    out.push(v);
  }
  return out;
}
