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
// on libuv's threadpool and never blocks the main thread. Each probe is raced
// against a short timeout so the CALLER gets a `null` = UNMEASURED result
// promptly (the same "never silently plenty" contract the sync version had)
// instead of awaiting a dead mount forever.
//
// THE THREADPOOL TRAP (#96 review F1, MEASURED). The timeout unblocks the main
// thread, but it does NOT free the libuv work-thread: `fs.promises.statfs` on a
// hard-hung mount holds its pool thread on the `statfs(2)` syscall
// UNINTERRUPTIBLY (libuv cannot cancel fs work already dispatched). Naively
// dispatching a fresh statfs every 2s tick during an outage would therefore
// pile up hung threads — with the default UV_THREADPOOL_SIZE=4 the pool is
// exhausted ~6 s in, starving ALL other async fs I/O in main AND cascading the
// healthy probes to UNMEASURED (measured: a healthy probe times out at ~1001 ms
// under saturation). So statfs/stat are SINGLE-FLIGHT PER PATH: while a probe's
// syscall is still pending from a prior tick, later ticks REUSE that one pending
// promise instead of dispatching another. The ceiling of stuck pool threads is
// then the number of distinct hung mounts (≤ the 3 probes), CONSTANT across an
// outage of any length — no accumulation. It cannot be zero (one dispatch per
// hung mount is unavoidable — libuv has no cancel), so background fs I/O can
// still be degraded during an outage; the guarantee is bounded, not free.
//
// Freshness is unchanged for LIVE mounts — a probe that answers within the
// budget clears its in-flight entry, so the next tick dispatches fresh; no
// cache (#87: a mount filling fast is when a stale reading is most dangerous).
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
 *  abandoned by the CALLER (statfs on a hung mount may never resolve) — the
 *  main thread holds nothing, but the underlying libuv work-thread is NOT freed
 *  (see the threadpool-trap note above); that is what the single-flight guard
 *  below bounds. */
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

// Single-flight per path (the pool-exhaustion guard, #96 F1). Keyed by the
// resolved probe path: while an entry is present a syscall is already in flight
// on the pool for that path, so a later tick joins it rather than dispatching a
// second. The entry is cleared on settle (success OR error), so a recovered
// mount is re-dispatched fresh next tick. Exported for the gate to inspect that
// N ticks against a hung mount produce ONE dispatch, not N.
const statfsInFlight = new Map<string, Promise<fs.StatsFs>>();
const statInFlight = new Map<string, Promise<fs.Stats>>();

function singleFlight<T>(map: Map<string, Promise<T>>, key: string, start: () => Promise<T>): Promise<T> {
  const existing = map.get(key);
  if (existing) return existing;
  const p = start();
  map.set(key, p);
  // Clear on settle so the next tick re-dispatches a fresh syscall (freshness)
  // and a hung entry does not wedge the path forever after recovery.
  p.then(
    () => map.delete(key),
    () => map.delete(key),
  );
  return p;
}

/** Number of statfs syscalls currently pending on the pool (test/diagnostic). */
export function inFlightStatfsCount(): number {
  return statfsInFlight.size;
}

/** Test-only: forget the in-flight entries so a suite that injected a
 *  never-settling stub does not leak a stuck promise into later tests. The real
 *  app never calls this — a live entry always self-clears on settle. */
export function __resetInFlightForTest(): void {
  statfsInFlight.clear();
  statInFlight.clear();
}

/** statfs one path. Returns null when the path does not exist, statfs fails
 *  (a non-Linux platform without statfs support, a vanished dir, …) or the
 *  mount does not answer within `STATFS_TIMEOUT_MS` (a hung network mount) —
 *  a null volume is reported as "unmeasured", never as "plenty of room".
 *  Async + single-flight per path so a hung mount neither blocks the main
 *  event loop nor accumulates pool threads across ticks (#96). */
export async function statVolume(probePath: string, label: string): Promise<VolumeStat | null> {
  let st: fs.StatsFs;
  try {
    st = await withTimeout(
      singleFlight(statfsInFlight, probePath, () => fs.promises.statfs(probePath)),
      STATFS_TIMEOUT_MS,
    );
  } catch {
    return null;
  }
  let deviceId = probePath;
  try {
    const s = await withTimeout(
      singleFlight(statInFlight, probePath, () => fs.promises.stat(probePath)),
      STATFS_TIMEOUT_MS,
    );
    deviceId = String(s.dev);
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
