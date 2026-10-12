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
  /** How long an EMPTY history waits before it is re-read (#375). */
  emptyRetryMs?: number;
}

/** At most this many folded conversations in memory (LRU), each dropped after IDLE_MS without a read while no stream is open. */
export const MAX_CACHED = 6;
const IDLE_MS = 10 * 60_000;
/** A change announcement per conversation at most this often (text deltas arrive per token). */
const ANNOUNCE_MS = 400;
/** #375: a workspace opened on the phone right after it was launched can be read BEFORE its transcript is on disk (a fast first turn is over
 *  before the CLI wrote its file): the empty history was cached for good and nothing refreshed it. An empty history is now re-read every
 *  EMPTY_RETRY_MS, at most EMPTY_RETRY_MAX times — each time with a CHANGED version, since the phone ignores an announcement of the version it has. */
const EMPTY_RETRY_MS = 1000;
export const EMPTY_RETRY_MAX = 5;

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
  /** #375: the empty-history heal — attempts so far and the pending timer. `suspect` = the history was EMPTY at the last read (the CLI had
   *  not written its transcript yet): the live fold may lack its head (events emitted before the feed was armed). A suspect entry is
   *  re-read from disk at the next turn end, a re-read may only GROW the conversation (the disk can lag behind the live fold), and an
   *  empty one is re-read on a short bounded timer. */
  emptyRetries: number;
  emptyTimer: NodeJS.Timeout | null;
  suspect: boolean;
}

export type MobileFeed = ReturnType<typeof createMobileFeed>;

export function createMobileFeed(deps: FeedDeps) {
const now = deps.now ?? Date.now;
const cache = new Map<string, Entry>();
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
    const e = cache.get(wsId);
    if (!e) return;
    if (e.loading) {
      e.missedWhileLoading = true;
      return;
    }
    e.session = foldEvent(e.session, event);
    e.version++;
    if (event.type === 'turn-end' && (e.missedWhileLoading || e.suspect)) e.reloadPending = true;
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
  if (e?.emptyTimer) clearTimeout(e.emptyTimer);
  cache.delete(id);
}

function sweep(): void {
  if (!listeners.size) {
    const t = now();
    for (const [id, e] of cache) if (t - e.lastRead > IDLE_MS) drop(id);
  }
  disarmIfIdle();
}

/** A suspect entry is re-read soon (#375): the phone is told to read again after a short wait, bounded by EMPTY_RETRY_MAX. */
function scheduleEmptyHeal(id: string, e: Entry): void {
  if (e.emptyTimer || e.emptyRetries >= EMPTY_RETRY_MAX) return;
  e.emptyTimer = setTimeout(() => {
    e.emptyTimer = null;
    e.emptyRetries++;
    // nothing left to heal: trusted now, or live events filled the session and no re-read is owed (a turn end sets reloadPending)
    if (!e.suspect || (e.session.messages.length > 0 && !e.reloadPending)) return;
    e.version++; // a CHANGED version: the phone only refetches on a version it does not have
    announce(id, e);
  }, deps.emptyRetryMs ?? EMPTY_RETRY_MS);
  e.emptyTimer.unref?.();
}

async function load(id: string, e: Entry): Promise<void> {
  e.missedWhileLoading = false; // misses DURING this read count; earlier ones are covered by it
  let next: AgentSession;
  try {
    const events = await deps.loadHistory(id);
    next = foldEvents(emptySession(id), events);
  } catch (err) {
    deps.warn?.(`history for ${id} could not be read — the phone shows live events only`, err);
    next = emptySession(id);
  }
  // #375: a re-read of a SUSPECT entry may only grow the conversation. The disk can lag behind the live fold (the CLI flushes its transcript
  // after the events were emitted): replacing a longer live fold by a shorter read dropped the user line (rig conv/live-turn). Rejected ⇒
  // still suspect, retried on the bounded timer.
  const lagging = e.suspect && next.messages.length < e.session.messages.length;
  if (!lagging) e.session = next;
  e.version++;
  e.reloadPending = lagging && e.emptyRetries < EMPTY_RETRY_MAX;
  e.suspect = lagging || e.session.messages.length === 0;
  if (e.suspect) scheduleEmptyHeal(id, e);
  else e.emptyRetries = 0;
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
    e = { session: emptySession(id), version: 0, lastRead: now(), loading: null, missedWhileLoading: false, reloadPending: false, announceTimer: null, emptyRetries: 0, emptyTimer: null, suspect: false };
    cache.set(id, e);
    const entry = e;
    entry.loading = load(id, entry).finally(() => {
      entry.loading = null;
    });
  } else if (!e.loading && !running(id, e) && (e.reloadPending || (e.suspect && e.session.messages.length === 0 && e.emptyRetries < EMPTY_RETRY_MAX))) {
    const entry = e;
    entry.loading = load(id, entry).finally(() => {
      entry.loading = null;
    });
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
function mobileFeedState(): { cached: string[]; listeners: number; tapped: boolean } {
  return { cached: [...cache.keys()], listeners: listeners.size, tapped: !!untap };
}

return { getMobileConversation, subscribeMobileFeed, mobileFeedState, sweep };
}
