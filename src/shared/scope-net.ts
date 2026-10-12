// #343 (wave H follow-up, ledger #329; epic #319; ADR 0005) — the scope's BACKSTOP, PURE half. A member scope has two leaves: `k` (keeper + CLI, no limit) and `w` (the tools, the hard level), and the
// scope itself carries a backstop `MemoryMax` = hard + room. If keeper + CLI outgrow the room a full `w` leaves them, the OOM episode is the SCOPE's and the kernel can take the keeper or the CLI.
// The keeper's watch reads `w`, so it sees none of it — and when the keeper is the victim nothing in the member survives to say so. The kernel's own log line does: it names the cgroup that hit its limit
// and the victim's. This module classifies those lines and builds the record the host reports (the impure half is src/main/scope-net.ts). Nothing here touches the OS.

import { SCOPE_LEAF_KEEPER, type KernelOomKill, type MemKillRecord, type MemNetVictim } from './memory-scope.ts';

const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const parentBase = (p: string): string => base(p.slice(0, Math.max(0, p.lastIndexOf('/'))));

/** A kernel kill at the member scope's backstop: the cgroup that hit its limit was the scope (or its keeper leaf), the victim lived in a leaf. */
export interface NetKill {
  atMs: number;
  pid: number;
  comm: string;
  /** Where the victim lived — always the keeper leaf (a tool killed by the scope's episode is the keeper's record, `MemKillRecord.scopeLevel`). */
  leaf: 'k';
  /** Which cgroup hit its limit: the scope's own (`scope`, the backstop) or its keeper leaf (`k`, only when someone limited it). */
  oomLevel: 'scope' | 'k';
}

/**
 * The kernel lines that are a BACKSTOP kill of `unit` whose victim is the SESSION SIDE — a process of the keeper leaf `k` (the keeper, the CLI, a helper) — oldest first, not older than `sinceMs`. A line counts when the cgroup that
 * hit its limit is the scope itself or its keeper leaf, never the tool leaf `w` (that is the Plafond mémoire doing its job, reported by the keeper). A TOOL killed by the scope's episode (victim in `w`) belongs to the keeper's
 * watch, which counts the tool leaf's kills and tags the record `scopeLevel` from the same line — reporting it here too would tell it twice (review M2). A victim in the scope ROOT is a flat scope (pre-#332 layout) or the
 * keeper before it moved into `k`: that is the hard level of an old shape, so it is NOT listed. Another member's scope, a global OOM and a host slice never match: the basename is compared whole.
 */
export function netKillsForUnit(lines: readonly KernelOomKill[], unit: string, sinceMs: number): NetKill[] {
  const out: NetKill[] = [];
  for (const l of lines) {
    if (l.atMs < sinceMs) continue;
    const oomLevel: NetKill['oomLevel'] | null = base(l.oomMemcg) === unit ? 'scope' : base(l.oomMemcg) === SCOPE_LEAF_KEEPER && parentBase(l.oomMemcg) === unit ? 'k' : null;
    if (oomLevel === null) continue;
    if (!(parentBase(l.taskMemcg) === unit && base(l.taskMemcg) === SCOPE_LEAF_KEEPER)) continue; // a victim in `w` is the KEEPER's (its watch counts the tool leaf's kills); in the scope ROOT it is the flat shape
    out.push({ atMs: l.atMs, pid: l.pid, comm: l.comm, leaf: 'k', oomLevel });
  }
  return out.sort((a, b) => a.atMs - b.atMs || a.pid - b.pid);
}

/** The identity of one kernel line, for « reported once ». A pid alone recycles; a time alone collides. */
export const netKillKey = (k: Pick<NetKill, 'atMs' | 'pid'>): string => `${k.atMs}:${k.pid}`;

export interface NetScopeFacts {
  unit: string;
  hardBytes: number | null;
  backstopBytes: number | null;
}

/**
 * ONE record for the kills of a check, or null when there are none. `seq` = the first kill's kernel time in ms — deterministic, so the same line reported twice (a replay after a crash) is the same notice
 * identity `(unit, seq)` and stores once; it can never collide with a keeper's small per-unit counter. `at` is the kernel time, so the row lands where it happened. Other victims ride in `candidates`.
 * `sessionEnded` is what the REPORTER knows (the CLI exited by a signal, or the keeper vanished); it is not inferred from the victims.
 */
export function netRecordOf(kills: readonly NetKill[], facts: NetScopeFacts, sessionEnded: boolean): MemKillRecord | null {
  if (kills.length === 0) return null;
  const sorted = [...kills].sort((a, b) => a.atMs - b.atMs || a.pid - b.pid);
  const first = sorted[0];
  const victims: MemNetVictim[] = sorted.map((k) => ({ pid: k.pid, comm: k.comm, leaf: k.leaf }));
  return {
    kind: 'kill',
    source: 'kernel',
    seq: first.atMs,
    at: first.atMs,
    level: 'net',
    command: first.comm,
    pid: first.pid,
    rssBytes: null,
    candidates: sorted.slice(1, 6).map((k) => `${k.comm} (pid ${k.pid})`),
    unit: facts.unit,
    hardBytes: facts.hardBytes,
    net: { backstopBytes: facts.backstopBytes, sessionEnded, victims },
  };
}

// The keeper leaf's margin (« how close is k to the room ») lives in keeper-room.ts (dependency-free: the member view and the CLI import it without the cgroup contract).
export { ROOM_WARN_FRACTION, keeperRoomOf, type KeeperRoom, type KeeperRoomInput } from './keeper-room.ts';
