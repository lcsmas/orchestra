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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VolumeStat } from '../shared/disk-space.ts';

/** statfs one path. Returns null when the path does not exist or statfs fails
 *  (a non-Linux platform without statfs support, a vanished dir, …) — a null
 *  volume is reported as "unmeasured", never as "plenty of room". */
export function statVolume(probePath: string, label: string): VolumeStat | null {
  let st: fs.StatsFs;
  try {
    st = fs.statfsSync(probePath);
  } catch {
    return null;
  }
  let deviceId = probePath;
  try {
    deviceId = String(fs.statSync(probePath).dev);
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
 *  parent is on the same filesystem anyway. */
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
export function statVolumeFor(probePath: string, label: string): VolumeStat | null {
  const real = nearestExisting(probePath);
  if (!real) return null;
  const v = statVolume(real, label);
  if (!v) return null;
  // Report the path the CALLER asked about — that is the actionable mount
  // name in an error message — while the measurement came from `real`.
  return { ...v, path: probePath };
}

/** The volumes the Resources page shows. De-duplicated by device so a machine
 *  where /tmp is not a separate mount reports one row, not two identical ones
 *  under different names. */
export function sampleVolumes(): VolumeStat[] {
  const tmpDir = os.tmpdir();
  const candidates: Array<[string, string]> = [
    [path.join(os.homedir(), '.orchestra'), 'Orchestra data'],
    [tmpDir, `Temp (${tmpDir})`],
    [process.cwd(), 'Repo / build output'],
  ];
  const out: VolumeStat[] = [];
  const seen = new Set<string>();
  for (const [p, label] of candidates) {
    const v = statVolumeFor(p, label);
    if (!v) continue;
    if (seen.has(v.deviceId)) continue;
    seen.add(v.deviceId);
    out.push(v);
  }
  return out;
}
