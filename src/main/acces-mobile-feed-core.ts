// Accès mobile feed (#337): main's live view for the phone. Keeps a folded AgentSession for each workspace the phone has opened
// (history from the workspace's own transcript — account-aware via sdkHistory — then every live AgentEvent folded by the SAME
// fold the desktop uses), and announces changes to the server process over a long-lived `/mobile/stream` response.
// Costs nothing while nobody watches: the broadcast tap is armed only while a conversation is cached or a stream is open.

// The CORE: no Electron, no store — the history loader and the broadcast tap are injected (acces-mobile-feed.ts binds the real
// ones), so node --test drives the fold / reload / LRU / arm-disarm logic directly.

import { emptySession, foldEvent, foldEvents } from '../shared/agent-events.ts';
import { projectConversation, type PhoneConversation } from '../shared/acces-mobile-conversation.ts';
import type { AgentAnswerableEvent, AgentEvent, AgentSession } from '../shared/types.ts';

export interface FeedDeps {
  loadHistory: (id: string) => Promise<AgentEvent[]>;
  onBroadcast: (tap: (channel: string, args: unknown[]) => void) => () => void;
  warn?: (msg: string, err?: unknown) => void;
  announceMs?: number;
  pingMs?: number;
  /** The AUTHORITATIVE « waiting on the human » list (agent-sdk's parked answerables), or null when no live session. A fold
   *  cannot be the source: a question asked before the phone opened is in no history, and an answer from another surface is
   *  only an event if someone emitted it (#337 review M1). */
  liveAsks?: (id: string) => AgentAnswerableEvent[] | null;
  /** Mid-turn right now (the store's status) — the history fold always ends with a synthetic turn end (#337 review M2). */
  isRunning?: (id: string) => boolean;
  now?: () => number;
  /** Pace of the re-reads of a suspect history (#375). */
  healMs?: number;
  /** A transcript read that started less than this after the workspace's last agent event may predate it (#375). */
  lagMs?: number;
}

/** At most this many folded conversations in memory (LRU), each dropped after IDLE_MS without a read while no stream is open. */
export const MAX_CACHED = 6;
const IDLE_MS = 10 * 60_000;
/** A change announcement per conversation at most this often (text deltas arrive per token). */
const ANNOUNCE_MS = 400;
/** #375: a history read that is EMPTY or started within LAG_MS of the workspace's last agent event may predate the CLI's own flush: it is suspect
 *  and re-read (first after HEAL_MS, then once past the quiet window; at most HEAL_RETRY_MAX times) until a read starts after LAG_MS of quiet. */
const HEAL_MS = 1000;
export const HEAL_RETRY_MAX = 5;
const LAG_MS = 5000;
/** Last-event times kept for workspaces the phone has not opened (a launch's answer is over before its conversation is first read). */
const MAX_ACTIVITY = 256;

export type FeedMessage = { t: 'conv'; id: string; v: number } | { t: 'workspaces' } | { t: 'ping' };

interface Entry {
  session: AgentSession;
  version: number;
  lastRead: number;
  loading: Promise<void> | null;
  /** An event arrived while the history was loading (not folded: it may or may not be in what the read returns). */
  missedWhileLoading: boolean;
  /** Set at the turn end that follows a miss: the next read re-folds from the (now complete) transcript. Only then — a reload
   *  for every turn would replace the live fold with a disk read that can lag behind it. */
  reloadPending: boolean;
  announceTimer: NodeJS.Timeout | null;
  /** #375 heal: `suspect` = the last read was empty or hot (see LAG_MS); it is re-read on `healTimer` and at each turn end, `healReads` bounded. */
  healReads: number;
  /** Heal reads skipped because the store still says « running » (its status can lag the turn-end event): each re-arms the timer, bounded. */
  healSkips: number;
  healTimer: NodeJS.Timeout | null;
  suspect: boolean;
}

export type MobileFeed = ReturnType<typeof createMobileFeed>;

export function createMobileFeed(deps: FeedDeps) {
const now = deps.now ?? Date.now;
const cache = new Map<string, Entry>();
const lastEventAt = new Map<string, number>(); // insertion order = recency
const listeners = new Set<(m: FeedMessage) => void>();
let untap: (() => void) | null = null;
let sweepTimer: NodeJS.Timeout | null = null;

function emit(m: FeedMessage): void {
  for (const l of listeners) {
    try {
      l(m);
    } catch {
      /* a dead listener is removed by its own close handler */
    }
  }
}

function announce(id: string, e: Entry): void {
  if (e.announceTimer) return;
  e.announceTimer = setTimeout(() => {
    e.announceTimer = null;
    emit({ t: 'conv', id, v: e.version });
  }, deps.announceMs ?? ANNOUNCE_MS);
}

function onTap(channel: string, args: unknown[]): void {
  if (channel === 'agent:event') {
    const [wsId, event] = args as [string, AgentEvent];
    lastEventAt.delete(wsId);
    lastEventAt.set(wsId, now());
    if (lastEventAt.size > MAX_ACTIVITY) lastEventAt.delete(lastEventAt.keys().next().value as string);
    const e = cache.get(wsId);
    if (!e) return;
    if (e.loading) {
      e.missedWhileLoading = true;
      return;
    }
    e.session = foldEvent(e.session, event);
    e.version++;
    if (event.type === 'turn-end' && (e.missedWhileLoading || e.suspect)) {
      e.reloadPending = true;
      e.healReads = 0; // the budget is per turn
      e.healSkips = 0;
      if (e.suspect) scheduleHeal(wsId, e);
    }
    announce(wsId, e);
  } else if (channel === 'workspace:update' || channel === 'workspace:removed' || channel === 'workspaces:removed' || channel === 'workspace:added') {
    if (listeners.size) emit({ t: 'workspaces' });
  }
}

function arm(): void {
  if (!untap) untap = deps.onBroadcast(onTap);
  if (!sweepTimer) {
    sweepTimer = setInterval(sweep, 60_000);
    sweepTimer.unref?.();
  }
}

function disarmIfIdle(): void {
  if (cache.size || listeners.size) return;
  untap?.();
  untap = null;
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

function drop(id: string): void {
  const e = cache.get(id);
  if (e?.announceTimer) clearTimeout(e.announceTimer);
  if (e?.healTimer) clearTimeout(e.healTimer);
  cache.delete(id);
}

function sweep(): void {
  if (!listeners.size) {
    const t = now();
    for (const [id, e] of cache) if (t - e.lastRead > IDLE_MS) drop(id);
  }
  disarmIfIdle();
}

/** A suspect entry is re-read soon (#375): the first retry after HEAL_MS, the next once a read would be past LAG_MS of quiet. */
function scheduleHeal(id: string, e: Entry): void {
  if (e.healTimer || e.healReads >= HEAL_RETRY_MAX) return;
  const last = lastEventAt.get(id);
  const trustIn = last === undefined ? 0 : last + (deps.lagMs ?? LAG_MS) + 100 - now();
  const delay = e.healReads === 0 ? (deps.healMs ?? HEAL_MS) : Math.max(deps.healMs ?? HEAL_MS, trustIn);
  e.healTimer = setTimeout(() => {
    e.healTimer = null;
    if (!e.suspect) return;
    e.reloadPending = true;
    e.version++; // a CHANGED version: the phone only refetches on a version it does not have
    announce(id, e);
  }, delay);
  e.healTimer.unref?.();
}

async function load(id: string, e: Entry): Promise<void> {
  e.missedWhileLoading = false; // misses DURING this read count; earlier ones are covered by it
  const startedAt = now();
  let next: AgentSession;
  try {
    const events = await deps.loadHistory(id);
    next = foldEvents(emptySession(id), events);
  } catch (err) {
    deps.warn?.(`history for ${id} could not be read — the phone shows live events only`, err);
    next = emptySession(id);
  }
  // HOT = an agent event of this workspace came less than LAG_MS before the read started (or during it): the CLI flushes its transcript
  // after emitting, so the read may lack the tail. The conversation only GROWS through a heal; an equal-length read counts only when not hot.
  const last = lastEventAt.get(id);
  const hot = last !== undefined && last > startedAt - (deps.lagMs ?? LAG_MS);
  const have = e.session.messages.length;
  const install = have === 0 || next.messages.length > have || (!hot && next.messages.length === have);
  if (install) e.session = next;
  e.version++;
  e.reloadPending = false;
  if (e.missedWhileLoading) e.healReads = 0; // lost events are not lag: the follow-up read is owed whatever the budget says (before it is scheduled)
  // an EMPTY read of a non-empty conversation (the read failed, or the file is mid-rewrite) says nothing: it never earns the trust
  e.suspect = hot || e.session.messages.length === 0 || (next.messages.length === 0 && have > 0);
  if (e.suspect) scheduleHeal(id, e);
  else {
    e.healReads = 0;
    e.healSkips = 0;
  }
  // Events arrived WHILE we read (#337 review M3: possibly the turn end itself): the read may predate them. Re-fold from disk at
  // the next read once the turn is over, and tell the phone something changed.
  if (e.missedWhileLoading) {
    e.reloadPending = true;
    announce(id, e);
  }
}

/** The phone's conversation for one workspace: folded once from its transcript, then kept live. */
async function getMobileConversation(id: string): Promise<PhoneConversation> {
  arm();
  let e = cache.get(id);
  if (!e) {
    if (cache.size >= MAX_CACHED) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].lastRead - b[1].lastRead)[0];
      if (oldest) drop(oldest[0]);
    }
    e = { session: emptySession(id), version: 0, lastRead: now(), loading: null, missedWhileLoading: false, reloadPending: false, announceTimer: null, healReads: 0, healSkips: 0, healTimer: null, suspect: false };
    cache.set(id, e);
    const entry = e;
    entry.loading = load(id, entry).finally(() => {
      entry.loading = null;
    });
  } else if (!e.loading && e.reloadPending && e.healReads < HEAL_RETRY_MAX) {
    if (running(id, e)) {
      if (e.healSkips++ < HEAL_RETRY_MAX) scheduleHeal(id, e); // nothing is re-read mid-turn; the status may lag the turn end, so ask again soon
    } else {
      const entry = e;
      entry.healReads++;
      entry.loading = load(id, entry).finally(() => {
        entry.loading = null;
      });
    }
  }
  e.lastRead = now();
  if (e.loading) await e.loading;
  const live = deps.liveAsks?.(id);
  const view: AgentSession = {
    ...e.session,
    running: running(id, e),
    ...(live ? { pendingAnswerables: live, pendingPermissions: [] } : {}),
  };
  return projectConversation(id, view, e.version);
}

function running(id: string, e: Entry): boolean {
  return deps.isRunning ? deps.isRunning(id) : e.session.running;
}

/** Subscribe to change announcements; returns the unsubscribe. A `ping` every 25 s keeps idle proxies from cutting the stream. */
function subscribeMobileFeed(listener: (m: FeedMessage) => void): () => void {
  arm();
  listeners.add(listener);
  const ping = setInterval(() => listener({ t: 'ping' }), deps.pingMs ?? 25_000);
  ping.unref?.();
  return () => {
    clearInterval(ping);
    listeners.delete(listener);
    disarmIfIdle();
  };
}

/** Test/diagnostic view. */
function mobileFeedState(): { cached: string[]; listeners: number; tapped: boolean; activity: number } {
  return { cached: [...cache.keys()], listeners: listeners.size, tapped: !!untap, activity: lastEventAt.size };
}

return { getMobileConversation, subscribeMobileFeed, mobileFeedState, sweep };
}
