// The freshest cached usage reading of ONE account (null = the default login) — the ONE read the #74 tick, the queue flusher and the
// fleet-Pause auto trigger (#256) share. Pure cache reads: the pollers own every network call.

import { getAccountUsage } from './account-usage';
import { getLastUsage } from './usage';
import type { UsageReading } from '../shared/pause-auto.ts';

/** Per-account cache for a pinned account, the global (default-login) poller otherwise. Null when that source has nothing yet. */
export function usageForAccount(accountId: string | null): UsageReading | null {
  if (accountId) {
    const status = getAccountUsage(accountId);
    return status ? { fetchedAt: status.fetchedAt, data: status.data } : null;
  }
  const snap = getLastUsage();
  return snap ? { fetchedAt: snap.fetchedAt, data: { fiveHour: snap.fiveHour, sevenDay: snap.sevenDay } } : null;
}
