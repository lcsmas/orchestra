// #328 — the process-wide read of per-member scope memory for the three consumers (the 60 s monitor line, the Resources page's 2 s poll, `/busStatus`). Producer + rules: ./member-memory.ts.
// A SHORT cache (not a standing poller): the page and a CLI polling bus-status must not each re-scan every scope, and a stale reading older than a few seconds is never served.

import { store } from './store';
import { listKeeperRoots } from './keeper-client';
import { memoizeEscaped, realMemberMemoryDeps, sampleMemberMemory } from './member-memory.ts';
import type { MemberMemoryReport } from '../shared/member-memory.ts';

/** Reads younger than this are shared (the page polls every 2 s; bus-status and the page can land in the same second). */
export const MEMBER_MEMORY_TTL_MS = 1_500;

let cache: { at: number; report: MemberMemoryReport } | null = null;

/** `fresh` skips the short cache: the monitor's once-a-minute LINE is a record, not a poll — it must carry the kernel's number as of its own tick (a 1.5 s-old report next to a fresh process table skews the two). */
export function currentMemberMemory(opts: { now?: number; fresh?: boolean } = {}): MemberMemoryReport {
  const now = opts.now ?? Date.now();
  if (!opts.fresh && cache && now - cache.at >= 0 && now - cache.at < MEMBER_MEMORY_TTL_MS) return cache.report;
  const live = listKeeperRoots().map((r) => r.workspaceId);
  const deps = realMemberMemoryDeps({ workspaceIds: () => [...store.workspaces.map((w) => w.id), ...live], liveMemberIds: () => live });
  if (deps.escaped) deps.escaped = memoizeEscaped(deps.escaped, { fresh: opts.fresh, now: () => now }); // FI-1 v1.9's walk is one stat read per host pid: 10 s for the pollers, fresh for the monitor's record
  const report = sampleMemberMemory(deps);
  cache = { at: now, report };
  return report;
}

export const __resetMemberMemoryHostForTests = (): void => {
  cache = null;
};
