// #332 (Q9): the keeper builds the member scope's two leaves — `k` (the keeper itself and, by inheritance, its CLI: no limit of their own) and `w` (the TOOL COMMANDS, which move themselves in through the tool wrapper; it carries the member's HARD level) — inside the
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

export interface PlacementProbe {
  ok: boolean;
  /** Did the wrapper RUN (its command produced output)? false = it could not be executed at all: a prefix that cannot run would make EVERY Bash tool call fail. */
  ran: boolean;
  /** What the probe saw: the cgroup path the wrapped command reported, or why it could not. */
  saw: string;
}

/**
 * RUNTIME proof that the tool wrapper really puts a command into the work leaf: run the wrapper once on `cat /proc/self/cgroup` with the leaf in its environment and read where the command found itself.
 * `run` = spawn + capture (injected). A wrapper that is stale, not executable, or cannot write the leaf's cgroup.procs (an unwritable cgroupfs) would otherwise leave EVERY tool in `k`, `w` empty and the cap
 * nothing while the state read `active`. Proves the wrapper and the leaf, not that the CLI honours the prefix (that is `scripts/memory-cap/real-cli-prefix.mjs`, which asserts the placement of the real CLI's tools).
 */
export function probeToolPlacement(a: { wrapper: string; workDir: string; cgroupRoot: string; parseCgroup: (text: string) => string | null; run: (wrapper: string, args: string[], env: Record<string, string>) => string | null }): PlacementProbe {
  const out = a.run(a.wrapper, ['cat /proc/self/cgroup'], { PATH: '/usr/local/bin:/usr/bin:/bin', SHELL: '/bin/bash', ORCHESTRA_MEMCAP_WORK_LEAF: a.workDir });
  if (out === null) return { ok: false, ran: false, saw: 'the wrapper did not run' };
  const cg = a.parseCgroup(out);
  if (cg === null) return { ok: false, ran: true, saw: `no cgroup v2 line in ${JSON.stringify(out.slice(0, 80))}` };
  const where = path.join(a.cgroupRoot, cg);
  return { ok: where === a.workDir, ran: true, saw: where };
}

/** Probe up to `1 + retries` times and stop at the first success (a single failed spawn under host pressure must not decide a member's whole life). `attempts` = how many probes ran. */
export function probeWithRetry(probe: () => PlacementProbe, retries = 1): PlacementProbe & { attempts: number } {
  let r = probe();
  let attempts = 1;
  while (!r.ok && attempts <= retries) {
    r = probe();
    attempts += 1;
  }
  return { ...r, attempts };
}

/**
 * The CPU time ever charged to the work leaf (`usage_usec` in its cpu.stat): it only grows and every process that runs in the leaf, however short, adds to it. cpu.stat FLUSHES the rstat tree on read; `memory.stat`'s
 * `pgfault` does NOT (measured on kernel 6.19, 10 cpus: 5 tiny commands left it unmoved in 12 of 25 reads, cpu.stat 0 of 75). null = unreadable.
 */
export function readLeafCpuUsec(readStat: () => string | null): number | null {
  const text = readStat();
  if (text === null) return null;
  const m = /^usage_usec (\d+)$/m.exec(text);
  return m ? Number(m[1]) : null;
}

export interface PlacementTripwire {
  /** One line of the CLI's stdout (stream-json). */
  onLine(line: string): void;
  tripped(): boolean;
}

/** The Bash tool_use ids announced by an assistant line, and the number of Bash tool RESULTS a user line carries. Only Bash goes through the shell prefix: Read / Edit / Grep / MCP-tool results say nothing about the work leaf. */
function bashEvents(line: string, bashIds: Set<string>): number {
  let n = 0;
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return 0;
  }
  const obj = o as { type?: string; message?: { content?: unknown }; tool_result?: unknown; tool_result_meta?: unknown };
  if (obj.tool_result && typeof obj.tool_result === 'object') return 1; // the stand-in CLI's shape: every tool it runs is a shell command
  // A result the CLI marks `non_execution_kind` (user-rejected / interrupted / cancelled) came back WITHOUT the command having run: it says nothing about the work leaf
  const notRun = new Set<string>();
  if (Array.isArray(obj.tool_result_meta)) for (const m of obj.tool_result_meta as Array<{ id?: unknown; non_execution_kind?: unknown }>) if (m && typeof m.id === 'string' && m.non_execution_kind) notRun.add(m.id);
  const content = Array.isArray(obj.message?.content) ? (obj.message?.content as Array<{ type?: string; id?: string; name?: string; tool_use_id?: string }>) : [];
  for (const b of content) {
    if (b?.type === 'tool_use' && b.name === 'Bash' && typeof b.id === 'string') {
      bashIds.add(b.id);
      if (bashIds.size > 400) bashIds.delete(bashIds.values().next().value as string);
    } else if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string' && bashIds.has(b.tool_use_id)) {
      bashIds.delete(b.tool_use_id);
      if (!notRun.has(b.tool_use_id)) n += 1;
    }
  }
  return n;
}

/**
 * Runtime tripwire for what the start-time probe cannot prove (it injects the leaf into the wrapper's env itself): after `after` BASH tool results have come back from the CLI, the work leaf's CPU-time counter must have
 * moved past its post-probe baseline — if not, NO shell command ever ran in the work leaf (a CLI that drops the env, a version that no longer calls the prefix, a read-only cgroup.procs...) and the cap is nothing while the
 * state reads `active`. Only Bash results count (a session that has only Read / Edit / Grep'd so far has run nothing through the prefix). Default `after` = 5: a few permission-denied commands run nothing. Fires `onTrip` ONCE.
 * An unreadable counter never trips (unknown is not a verdict); it re-checks at later results, up to `giveUpAfter`, then says so through `onGiveUp`. The counter is leaf-wide: MCP servers and hooks also run through the prefix,
 * so one that landed in the leaf can hide a Bash that did not (a false NEGATIVE — the wire stays quiet; never a false trip).
 */
export function createPlacementTripwire(a: { baseline: number; readCounter: () => number | null; onTrip: (toolResults: number) => void; onGiveUp?: (toolResults: number) => void; after?: number; giveUpAfter?: number }): PlacementTripwire {
  const after = a.after ?? 5;
  const giveUp = a.giveUpAfter ?? 40;
  const bashIds = new Set<string>();
  let results = 0;
  let done = false;
  let tripped = false;
  return {
    onLine(line) {
      if (done || !(line.includes('"tool_use"') || line.includes('"tool_result"'))) return;
      const n = bashEvents(line, bashIds);
      if (n === 0) return;
      results += n;
      if (results < after) return;
      const now = a.readCounter();
      if (now === null) {
        if (results >= giveUp) {
          done = true;
          a.onGiveUp?.(results); // said once: a tripwire that disarms itself must not do it silently
        }
        return;
      }
      done = true;
      if (now <= a.baseline) {
        tripped = true;
        a.onTrip(results);
      }
    },
    tripped: () => tripped,
  };
}
