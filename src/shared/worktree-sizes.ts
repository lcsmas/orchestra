/**
 * Worktree size scanning — the pure parsing half. The scanners themselves
 * (`btrfs filesystem du` / plain `du`, spawned from src/main/workspaces.ts)
 * stay in the main process; this module holds the output→bytes parsers and the
 * wire shape, dependency-free so `node --test` can exercise them without
 * Electron.
 */

/** Result of a worktree size scan, as sent over IPC. */
export interface WorktreeSizes {
  /** Bytes keyed by workspace id. */
  sizes: Record<string, number>;
  /**
   * True when `sizes` are btrfs EXCLUSIVE bytes — what deleting the worktree
   * would actually reclaim (extents shared with other worktrees via reflinks
   * are not counted). False when they are apparent `du` sizes.
   */
  exclusive: boolean;
}

/**
 * Parse `du -k --max-depth=1 <root>` output — "<KiB>\t<absolute path>" lines —
 * into a path → bytes map. Lines without a tab (or with a non-numeric size,
 * e.g. interleaved error text) are skipped; the root's own total line parses
 * fine but is simply never matched to a worktree by the caller.
 */
export function parseDuSizes(out: string): Map<string, number> {
  const byPath = new Map<string, number>();
  for (const line of out.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const kib = Number(line.slice(0, tab));
    if (!Number.isFinite(kib)) continue;
    byPath.set(line.slice(tab + 1), kib * 1024);
  }
  return byPath;
}

// "   <total>   <exclusive>   <set shared>  <path>" — `--raw` makes all three
// numeric columns plain bytes. The header line has no leading digits, so it
// falls out of the match naturally; the path may contain spaces.
const BTRFS_DU_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/;

/**
 * Parse `btrfs filesystem du -s --raw <path…>` output into a path → EXCLUSIVE
 * bytes map. Error lines btrfs interleaves for vanished paths don't match the
 * numeric shape and are skipped, so a partially-failed scan still yields the
 * surviving entries.
 */
export function parseBtrfsDuSizes(out: string): Map<string, number> {
  const byPath = new Map<string, number>();
  for (const line of out.split('\n')) {
    const m = BTRFS_DU_LINE.exec(line);
    if (!m) continue;
    byPath.set(m[4], Number(m[2]));
  }
  return byPath;
}
