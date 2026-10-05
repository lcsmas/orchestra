// Fleet PAUSE auto (#256) — the HOST binding: the real store, usage pollers, activity observer and bus bound to `PauseAutoDeps`
// (src/main/pause-auto.ts holds the logic, Electron-free). Mirror of pause-gate.ts ↔ bus-pause.ts.

import { store } from './store.ts';
import { getBus } from './bus.ts';
import { beginReprise } from './bus-pause.ts';
import { log } from './logger.ts';
import { clearStopReason, setUsageLimitStopObserver } from './activity.ts';
import { refreshAccountsNow } from './account-usage.ts';
import { refreshUsageNow } from './usage.ts';
import { usageForAccount } from './usage-reading.ts';
import { REPRISE_STREAK_WINDOW_MS } from '../shared/pause-auto.ts';
import {
  afterAccountChange,
  autoPauseOnLimit,
  clearRepriseDeliveredMarkers,
  evaluateAutoPaused,
  type AccountChangeResult,
  type AutoEvalEntry,
  type PauseAutoDeps,
} from './pause-auto.ts';

/** A non-forcing poller nudge is throttled per account (a reset time that stays in the past must not hammer the usage endpoint). */
const NUDGE_MS = 120_000;
const lastNudge = new Map<string, number>();
/** wsId → when its pinned account last changed (migration / re-login) this app run — readings older than it were taken for the OLD account. */
const accountChanged = new Map<string, number>();
/** runId → when the host auto-Reprised it (the flap guard's streak; forgotten by a restart). */
const reprises = new Map<string, number[]>();
/** Highest `messages.sequence` already scanned for `reprise` rows (see `clearRepriseDeliveredMarkers`). */
let repriseSeq = 0;

const realDeps: PauseAutoDeps = {
  getBus,
  getWorkspace: (id) => store.getWorkspace(id),
  knownAccountIds: () => new Set(store.accounts.map((a) => a.id)),
  readingFor: usageForAccount,
  accountChangedAt: (wsId) => accountChanged.get(wsId) ?? null,
  noteAccountChanged: (wsId, at) => void accountChanged.set(wsId, at),
  forceRefresh: async (ids) => {
    const named = ids.filter((id): id is string => id !== null);
    const jobs: Array<Promise<void>> = [];
    if (named.length > 0) jobs.push(refreshAccountsNow({ force: named }));
    if (ids.includes(null)) jobs.push(refreshUsageNow());
    await Promise.all(jobs);
  },
  requestRefresh: (ids) => {
    const now = Date.now();
    const due = ids.filter((id) => now - (lastNudge.get(id ?? '') ?? 0) >= NUDGE_MS);
    if (due.length === 0) return;
    for (const id of due) lastNudge.set(id ?? '', now);
    void refreshAccountsNow().catch(() => undefined); // the default login's own poller refreshes every 60 s — no extra poll
  },
  beginReprise,
  repriseStreak: (runId, now) => {
    const kept = (reprises.get(runId) ?? []).filter((t) => now - t < REPRISE_STREAK_WINDOW_MS);
    reprises.set(runId, kept);
    return kept.length;
  },
  noteReprise: (runId, now) => void reprises.set(runId, [...(reprises.get(runId) ?? []), now]),
  resetStreak: (runId) => void reprises.delete(runId),
  limitMarkedWorkspaces: () =>
    store.workspaces.filter((w) => !w.archived && w.lastStopReason === 'usage_limit').map((w) => ({ id: w.id, markedAt: w.lastStopReasonAt ?? 0 })),
  clearLimitMarker: (wsId) => clearStopReason(wsId),
  repriseCursor: { get: () => repriseSeq, set: (seq) => void (repriseSeq = seq) },
  storeReady: () => store.loadedFromDisk,
  now: () => Date.now(),
  log: { info: (m) => log.info(m), warn: (m, e) => log.warn(m, e) },
};

/** Real-deps accessor for rigs. */
export function pauseAutoDeps(): PauseAutoDeps {
  return realDeps;
}

/** Register the limit-stop observer (called by `startPromptQueueFlusher`, #74's tick). */
export function startPauseAuto(): void {
  setUsageLimitStopObserver((wsId) => {
    try {
      autoPauseOnLimit(realDeps, wsId);
    } catch (e) {
      log.warn(`pause-auto: auto-pause for ${wsId} failed`, e);
    }
  });
}

export function stopPauseAuto(): void {
  setUsageLimitStopObserver(null);
  lastNudge.clear();
  accountChanged.clear();
  reprises.clear();
  repriseSeq = 0;
}

// Coalesce: the tick and an account-change hook may both evaluate; a Reprise must start ONCE.
let inflight: Promise<AutoEvalEntry[]> | null = null;

/** One evaluation of every auto-paused run (cheap: one indexed-less SELECT when none). Called from #74's tick. */
export function evaluatePausedRuns(): Promise<AutoEvalEntry[]> {
  inflight ??= evaluateAutoPaused(realDeps)
    .then(async (entries) => {
      // after the Reprises of this tick: a member just sent its Reprise row loses its #74 marker BEFORE #74's candidates are read (same tick, after this returns)
      await clearRepriseDeliveredMarkers(realDeps).catch((e) => log.warn('pause-auto: marker clearing failed', e));
      return entries;
    })
    .catch((e) => {
      log.warn('pause-auto: evaluation failed', e);
      return [] as AutoEvalEntry[];
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** A workspace was migrated to another account (workspaces.ts `dispatchMigrateAccountRequest`, after the re-pin). */
export function pauseAutoOnMigrate(wsId: string): Promise<AccountChangeResult> {
  return afterAccountChange(realDeps, { kind: 'migrate', wsId }).catch((e) => {
    log.warn(`pause-auto: account-change handling failed for ${wsId}`, e);
    return { runs: [], forced: [], evaluated: [] };
  });
}

/** An account was (re-)logged in (api-handlers.ts login watcher). */
export function pauseAutoOnLogin(accountId: string): Promise<AccountChangeResult> {
  return afterAccountChange(realDeps, { kind: 'login', accountId }).catch((e) => {
    log.warn(`pause-auto: login handling failed for ${accountId}`, e);
    return { runs: [], forced: [], evaluated: [] };
  });
}
