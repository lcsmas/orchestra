// Free-space policy: the pure half of the disk-space guard (issue #87).
//
// WHY THIS FILE EXISTS. `/tmp` on the dev machine is a SEPARATE 16 GiB tmpfs,
// not part of `$HOME`'s 551 GiB filesystem. During wave 6 it reached 100% and a
// verifier died on ENOSPC before writing a byte — the failure was
// indistinguishable from "the feature under test does not trigger", so it was
// investigated as a code defect. Nothing in the app or the scripts had any
// notion of free space at all (there was no `statfs`, no `df`, no threshold
// anywhere in src/ or scripts/ before this change).
//
// This module owns the DECISION (how much is too little, and what the failure
// is called). The platform I/O — `statfs(2)` — lives in src/main/disk-space.ts
// so this stays dependency-free and unit-testable under the plain node runner.
//
// SCOPE LIMIT, deliberate and permanent: this guard NEVER deletes anything.
// A "safe" cleanup of `/tmp/e2e-*` destroys a sibling agent's live rig (the
// sleeping-owner rule). It warns, it names, it refuses — that is all.

/** Free/total space for one filesystem, as measured by `statfs(2)`.
 *  `mount` is the path we probed, not the kernel's mount point: two probed
 *  paths on the same device are reported once, keyed by `deviceId`. */
export interface VolumeStat {
  /** The path that was probed (e.g. `/tmp`, `~/.orchestra`). */
  path: string;
  /** Human label for the UI ("Orchestra data", "Temp (/tmp)"). */
  label: string;
  /** Bytes available to an unprivileged writer (statfs `bavail`, NOT `bfree` —
   *  `bfree` includes the root-reserved blocks an agent process cannot use). */
  freeBytes: number;
  /** Total bytes in the filesystem (statfs `blocks`). */
  totalBytes: number;
  /** Identity of the underlying filesystem, for de-duplicating probes that
   *  land on the same device (`/tmp` and `$HOME` are the same device on a
   *  machine without a tmpfs). */
  deviceId: string;
}

/** Severity of one volume's free space against the policy below. */
export type DiskLevel = 'ok' | 'warn' | 'critical';

/**
 * THE THRESHOLD, AND ITS RIG.
 *
 * A pure percentage is wrong at both ends: 5% of a 16 GiB tmpfs is 800 MiB
 * (plenty for a rig), and 5% of a 2 TiB disk is 100 GiB (absurdly early). A
 * pure byte floor is wrong too — a 1 GiB floor on a 16 GiB tmpfs never warns
 * until it is at 94%. So the policy is the MORE CONSERVATIVE of the two: warn
 * when free space is below the byte floor OR below the percentage, whichever
 * fires first.
 *
 * The byte floors are measured, not guessed. Measured 2026-08-25 on this
 * machine, in this worktree:
 *
 *   `pnpm run build:bundles` (RC=0) → dist/ 5204 KiB + dist-electron/ 648 KiB
 *      = ~5.7 MiB of emitted bundles.
 *      Command: `du -sk dist dist-electron` immediately after the build.
 *   A full `pnpm run build` additionally runs electron-builder. Its PEAK
 *      `release/` size was later sampled directly (1 s interval, 40 gapless
 *      samples, reviewer C3-F1): 2262392 KiB = 2.158 GiB, when the unpacked
 *      tree and the AppImage coexist; it settles to 1.215 GiB afterwards.
 *      DISPROVED EN ROUTE: this comment originally reasoned from the 1.32 GiB
 *      FINAL size to "hence 2 GiB", and that inference landed 161 MiB UNDER
 *      the real peak — the guard would have passed and the build then died on
 *      ENOSPC. "Peak exceeds final" was correct; the arithmetic guess after it
 *      was not. Sampling the build is the only thing that settled it.
 *   E2E rigs: `scripts/e2e-contained-rig.sh` creates `/tmp/e2e64c-$$` and
 *      DELIBERATELY leaves it for inspection (see its teardown). Measured
 *      2026-08-25: 56 such directories already resident in /tmp, largest
 *      176 KiB (`du -sk /tmp/e2e64c-*  | sort -rn | head`). Individually
 *      trivial, unbounded in aggregate — this is the slow-fill mechanism
 *      behind the incident, and the reason the guard must warn rather than
 *      wait for a single large writer.
 *
 * The WARN_BYTES floor of 1 GiB is therefore NOT a measured requirement of any
 * single operation — it is a conservative headroom figure chosen so that the
 * warning arrives with room to spare before a packaging build's requirement. It is
 * declared UNBASELINED as "the amount of slack a developer needs": nothing was
 * measured that says 1 GiB specifically. What IS measured is the requirement
 * each caller passes to `requireFreeSpace()` (see BUILD_* below).
 */
export const WARN_FREE_BYTES = 1024 * 1024 * 1024; // 1 GiB — UNBASELINED headroom, see above
export const CRITICAL_FREE_BYTES = 256 * 1024 * 1024; // 256 MiB
export const WARN_FREE_PCT = 10;
export const CRITICAL_FREE_PCT = 3;

/** A volume must be at least this many times the warn floor before the BYTE
 *  arm is applied to it at all (see classifyVolume). At 2x, the smallest
 *  volume the floor governs is 2 GiB, where reserving 1 GiB is a coherent
 *  request. Below that the percentage arm decides alone.
 *  UNBASELINED: 2 is a judgement, not a measurement — it is the smallest
 *  multiple for which "warn at 1 GiB free" is not immediately self-defeating. */
export const SMALL_VOLUME_FACTOR = 2;

/** Measured requirement for `pnpm run build:bundles`: ~5.7 MiB emitted
 *  (2026-08-25, `du -sk dist dist-electron`). Rounded up an order of magnitude
 *  to 64 MiB to cover vite's temp files and sourcemaps, which were not
 *  measured separately. */
export const BUILD_BUNDLES_REQUIRED_BYTES = 64 * 1024 * 1024;

/** Requirement for a full packaging build.
 *
 *  MEASURED 2026-08-25 (1s sampling, 40 gapless samples, reviewer C3-F1):
 *  peak `release/` = 2262392 KiB = **2.158 GiB**, reached when the unpacked
 *  app tree and the finished AppImage coexist; the directory then drops to
 *  1.215 GiB after electron-builder cleans up.
 *
 *  The previous value was 2 GiB, derived from the 1.32 GiB FINAL size plus
 *  "unmeasured staging headroom". That guess landed **161 MiB BELOW the real
 *  peak**, so a machine with ~2.05 GiB free passed the guard and then died on
 *  ENOSPC during packaging — precisely the failure this ticket exists to
 *  eliminate. The instinct (peak > final) was right; the number was not, and
 *  only sampling the build found it.
 *
 *  3 GiB = measured peak + ~39% margin. That MARGIN is UNBASELINED: the peak
 *  is N=1 on one machine (aarch64 Fedora asahi), so run-to-run variance is
 *  unknown and the margin is a judgement, not a measurement. */
export const BUILD_PACKAGE_REQUIRED_BYTES = 3 * 1024 * 1024 * 1024;

/** Requirement for one contained E2E rig. Largest observed rig dir was
 *  176 KiB (2026-08-25), but a rig boots Electron, which writes caches and can
 *  dump a core; 256 MiB is a conservative floor and is declared UNBASELINED
 *  against any single measured rig peak. */
export const E2E_RIG_REQUIRED_BYTES = 256 * 1024 * 1024;

/** Classify one volume against the policy. `warn` fires when EITHER the byte
 *  floor or the percentage is breached — whichever is more conservative for
 *  this filesystem's size. */
export function classifyVolume(v: Pick<VolumeStat, 'freeBytes' | 'totalBytes'>): DiskLevel {
  const pct = v.totalBytes > 0 ? (v.freeBytes / v.totalBytes) * 100 : 100;

  // The byte floor only makes sense on a volume big enough for it to be a
  // meaningful reserve. C3-F5: without this, ANY filesystem smaller than
  // WARN_FREE_BYTES could never read 'ok' — a 100 MiB tmpfs at 0% used
  // classified 'critical', and since worstLevel() takes the max, one such
  // mount would pin the Resources page to a permanent "critically low" badge.
  // A warning that is always on is a warning nobody reads, which is a worse
  // failure than the one this guard exists to prevent.
  //
  // The module comment already named the symmetric error (a 1 GiB floor on a
  // 16 GiB tmpfs never warns until 94%); this is the other end of it. On a
  // volume too small for the floor, the PERCENTAGE arm alone decides — which
  // is the arm that is meaningful at that scale.
  const floorApplies = v.totalBytes >= WARN_FREE_BYTES * SMALL_VOLUME_FACTOR;

  if ((floorApplies && v.freeBytes < CRITICAL_FREE_BYTES) || pct < CRITICAL_FREE_PCT) {
    return 'critical';
  }
  if ((floorApplies && v.freeBytes < WARN_FREE_BYTES) || pct < WARN_FREE_PCT) return 'warn';
  return 'ok';
}

/** The worst level across a set of volumes — what the Resources tile shows. */
export function worstLevel(volumes: Array<Pick<VolumeStat, 'freeBytes' | 'totalBytes'>>): DiskLevel {
  let worst: DiskLevel = 'ok';
  for (const v of volumes) {
    const l = classifyVolume(v);
    if (l === 'critical') return 'critical';
    if (l === 'warn') worst = 'warn';
  }
  return worst;
}

/** Bytes → short human string. Duplicated deliberately from the renderer's
 *  `formatBytes` so this module stays importable from scripts and main
 *  without dragging in a .tsx. */
export function formatBytesShort(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return i === 0 ? `${v} B` : `${v < 10 ? v.toFixed(2) : v.toFixed(1)} ${units[i]}`;
}

/** The name every caller greps for. `Error: ENOSPC` reappearing downstream is
 *  precisely the failure this ticket exists to eliminate, so the guard's error
 *  carries its own stable code AND the three numbers needed to act on it. */
export const DISK_FULL_CODE = 'ORCHESTRA_DISK_FULL';

export class DiskFullError extends Error {
  /** Stable, greppable — assert on THIS, never on the message text. */
  readonly code = DISK_FULL_CODE;
  readonly mount: string;
  readonly freeBytes: number;
  readonly requiredBytes: number;
  readonly totalBytes: number;

  constructor(args: {
    mount: string;
    freeBytes: number;
    requiredBytes: number;
    totalBytes: number;
    operation: string;
  }) {
    super(formatDiskFullMessage(args));
    this.name = 'DiskFullError';
    this.mount = args.mount;
    this.freeBytes = args.freeBytes;
    this.requiredBytes = args.requiredBytes;
    this.totalBytes = args.totalBytes;
  }
}

/** The single message shape, shared by the TS error and the shell guard, so a
 *  log line from either is recognisable by the same grep. Carries the mount,
 *  the free bytes and the required bytes — a message missing any of the three
 *  cannot be acted on. */
export function formatDiskFullMessage(args: {
  mount: string;
  freeBytes: number;
  requiredBytes: number;
  totalBytes: number;
  operation: string;
}): string {
  const shortfall = Math.max(0, args.requiredBytes - args.freeBytes);
  return (
    `${DISK_FULL_CODE}: not enough free space on ${args.mount} for ${args.operation} — ` +
    `free ${formatBytesShort(args.freeBytes)} of ${formatBytesShort(args.totalBytes)}, ` +
    `required ${formatBytesShort(args.requiredBytes)} ` +
    `(short by ${formatBytesShort(shortfall)}). ` +
    `Orchestra does NOT auto-delete: another agent's rig may live on this mount. ` +
    `Free space yourself, then retry.`
  );
}

/** Decide whether a volume satisfies a requirement. Pure — the caller does the
 *  statfs and the throwing. Returns null when there is enough room. */
export function checkRequirement(
  v: VolumeStat,
  requiredBytes: number,
  operation: string,
): DiskFullError | null {
  if (v.freeBytes >= requiredBytes) return null;
  return new DiskFullError({
    mount: v.path,
    freeBytes: v.freeBytes,
    requiredBytes,
    totalBytes: v.totalBytes,
    operation,
  });
}
