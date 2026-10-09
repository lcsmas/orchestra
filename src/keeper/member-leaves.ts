// #332 (Q9): the keeper builds the member scope's two leaves — `k` (the keeper itself, no limit of its own) and `w` (the CLI and everything it starts, carrying the member's HARD level) — inside the
// DELEGATED scope it was launched into (`systemd-run --scope -p Delegate=yes`). The keeper moves ITSELF (the scope's own main process, started for exactly this) into `k`; nothing that existed before is moved.
// Why the keeper must not sit in the limited cgroup: see src/shared/memory-scope.ts (leaves). Electron-free; every cgroupfs operation is injected so the order and the failure handling are unit-tested.

import path from 'node:path';
import { SCOPE_LEAF_KEEPER, SCOPE_LEAF_WORK } from '../shared/memory-scope.ts';
import { parseCgroupLimit } from '../shared/memory-scope.ts';

export interface LeafFs {
  /** mkdir of a cgroup directory (creates the cgroup); an existing one is not an error. */
  mkdir(p: string): void;
  write(p: string, text: string): void;
  read(p: string): string;
}

export type LeafResult = { ok: true; keeperDir: string; workDir: string } | { ok: false; step: string; error: string };

/** The kernel rounds a limit to its page size: a read-back within this slack of the asked value is the value. */
export const LEAF_LIMIT_SLACK_BYTES = 64 * 1024;

/**
 * Build the leaves of `scopeDir` and put the member's hard level on the work leaf. Order is the kernel's rule (a cgroup with processes cannot hand controllers to its children): mkdir both leaves,
 * move THIS process into `k` (the scope is then process-free), enable `+memory` for the children, set the work leaf's limit and read it back. `alreadyInKeeperLeaf` = a second call in the same keeper.
 * Fails closed with the step that failed — the caller reports `not-applied` and the member keeps only the scope's backstop limit.
 */
export function buildMemberLeaves(a: { scopeDir: string; hardBytes: number; pid: number; fs: LeafFs; alreadyInKeeperLeaf?: boolean }): LeafResult {
  const keeperDir = path.join(a.scopeDir, SCOPE_LEAF_KEEPER);
  const workDir = path.join(a.scopeDir, SCOPE_LEAF_WORK);
  const step = (name: string, fn: () => void): LeafResult | null => {
    try {
      fn();
      return null;
    } catch (e) {
      return { ok: false, step: name, error: e instanceof Error ? e.message : String(e) };
    }
  };
  const attempts: Array<[string, () => void]> = [
    ['mkdir keeper leaf', () => a.fs.mkdir(keeperDir)],
    ['mkdir work leaf', () => a.fs.mkdir(workDir)],
    ...(a.alreadyInKeeperLeaf ? [] : ([['move the keeper into its leaf', () => a.fs.write(path.join(keeperDir, 'cgroup.procs'), String(a.pid))]] as Array<[string, () => void]>)),
    ['enable the memory controller for the leaves', () => a.fs.write(path.join(a.scopeDir, 'cgroup.subtree_control'), '+memory')],
    ['set the work leaf\'s hard level', () => a.fs.write(path.join(workDir, 'memory.max'), String(a.hardBytes))],
  ];
  for (const [name, fn] of attempts) {
    const failed = step(name, fn);
    if (failed) return failed;
  }
  // no swap escape either: the leaf's own swap limit (best effort — a kernel without swap accounting has no such file; the scope's MemorySwapMax=0 still covers it)
  step('close the work leaf\'s swap escape', () => a.fs.write(path.join(workDir, 'memory.swap.max'), '0'));
  let limit: number | null = null;
  try {
    limit = parseCgroupLimit(a.fs.read(path.join(workDir, 'memory.max')));
  } catch (e) {
    return { ok: false, step: 'read the work leaf\'s limit back', error: e instanceof Error ? e.message : String(e) };
  }
  if (limit === null || limit > a.hardBytes || limit < a.hardBytes - LEAF_LIMIT_SLACK_BYTES) {
    return { ok: false, step: 'read the work leaf\'s limit back', error: `memory.max is ${limit ?? 'max'}, asked ${a.hardBytes}` };
  }
  return { ok: true, keeperDir, workDir };
}

/** argv that starts `command args…` as the work leaf's first process: a fresh `sh` moves ITSELF into the leaf, then execs (same pid). `&&`: a leaf that cannot be entered fails the START loudly, never runs the CLI uncapped. */
export function inWorkLeafArgv(workDir: string, command: string, args: readonly string[]): { command: string; args: string[] } {
  return { command: '/bin/sh', args: ['-c', 'echo $$ > "$1/cgroup.procs" && shift && exec "$@"', 'orchestra-work-leaf', workDir, command, ...args] };
}
