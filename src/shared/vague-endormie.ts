// Vague endormie (#428, spec #426; terms in CONTEXT.md) — PURE half. A vague (a run and its coordinator) is ASLEEP when it still has unfinished dispatched tasks while nothing can wake
// anyone in it: nobody active, nobody waiting for an answer, no live process of theirs, no Pause — for VAGUE_QUIET_MS. A live process protects it for at most VAGUE_PROCESS_BOUND_MS
// without any agent activity. The coordinator then gets ONE Relance (shared/relance.ts `buildRelance`, the #427 primitive) per asleep EPISODE; the episode ends when a MEMBER resumes.
// The effectful half (roster, census, clock, delivery) is src/main/vague-endormie.ts; nothing of the human step (#429: notification, sidebar mark, Settings) is here.

import { buildRelance, clock, list, oneLine, rootsOf, type RelanceCensus } from './relance.ts';

/** Nothing can wake anyone for this long ⇒ asleep (the 10-minute delay of the spec; #429 makes it a setting, the sweep reads it per pass through `bounds`). */
export const VAGUE_QUIET_MS = 10 * 60_000;
/** A live process protects a quiet vague for at most this long without any agent activity (the one-hour bound of the spec — a constant). */
export const VAGUE_PROCESS_BOUND_MS = 60 * 60_000;

export interface VagueBounds {
  quietMs: number;
  processMs: number;
}
export const DEFAULT_VAGUE_BOUNDS: VagueBounds = { quietMs: VAGUE_QUIET_MS, processMs: VAGUE_PROCESS_BOUND_MS };

/** One workspace of the vague as the host sees it right now (the coordinator is one too). */
export interface VagueParticipant {
  wsId: string;
  label: string;
  /** A turn is running or a prompt is queued. */
  active: boolean;
  /** Parked on an answer: an app-level needs-input, or the opener of an unanswered ask / unresolved gate. */
  waiting: boolean;
  /** Its start is HELD for memory by Admission: a wake is owed and will happen on its own. */
  heldStart: boolean;
  /** The idle clock (last activity, floored at the app start). */
  lastActivityAt: number;
  /** The host has SEEN activity of this workspace since the app started (the clock above is a real reading, not the app-start floor). */
  seenThisRun: boolean;
}

export interface VagueMember extends VagueParticipant {
  /** The task it was dispatched ('' for a workspace without one). */
  task: string;
  /** Dispatched and not finished (not reported done and released). */
  unfinished: boolean;
}

export interface VagueFacts {
  runId: string;
  coordinator: VagueParticipant;
  members: readonly VagueMember[];
  /** The run (or an ancestor) is Paused. */
  paused: boolean;
  /** The run is on HOLD (`orchestra run hold`: a parked fleet, deliberately silenced). */
  runHeld: boolean;
}

/** Per workspace id, its Reliquats (kernel scope) — `'unknown'` = unreadable (UNKNOWN is not NONE). */
export type VagueCensus = ReadonlyMap<string, RelanceCensus>;

export type VagueAwakeWhy = 'no-task' | 'paused' | 'run-held' | 'member-active' | 'waiting' | 'held-start' | 'dormant' | 'process' | 'quiet' | 'resumed';

export interface VagueProcessLine {
  owner: string;
  /** `null` = the scope could not be read: a process of this owner may be alive. */
  cmd: string | null;
  pid: number | null;
}

export type VagueVerdict =
  | { kind: 'awake'; why: VagueAwakeWhy; /** `quiet`: when it will be declared; `process`: when the process stops protecting it. */ dueAt?: number }
  | {
      kind: 'asleep';
      /** When nothing could wake anyone any more. */
      since: number;
      /** First pass of the episode. */
      declared: boolean;
      /** The coordinator was not told yet. */
      nudge: 'owed' | 'done';
      unfinished: readonly VagueMember[];
      /** The live processes that no longer protect the vague (named in the Relance); only read while the nudge is owed. */
      processes: readonly VagueProcessLine[];
    };

export interface VagueEpisode {
  since: number;
  declaredAt: number;
  /** When the coordinator's Relance went out (`undefined` = owed). */
  nudgedAt?: number;
}

/** What the host remembers of ONE vague between two looks. */
export interface VagueState {
  /** The last pass at which something legitimately held the vague awake: it floors `since`, so a process that just ended (a Relance of its own owner is on its way) gets its full delay. */
  protectedAt?: number;
  /** The last pass at which something OTHER than a live process held it (a Pause, a member working, an answer awaited): a lapsed process does not hurry the declaration past the delay that follows it. */
  blockedAt?: number;
  episode?: VagueEpisode;
}

const people = (f: VagueFacts): VagueParticipant[] => [f.coordinator, ...f.members];

/** When the vague last moved: a participant that is active / waiting / holds a start is moving NOW; else the latest idle clock. */
export function quietSinceOf(f: VagueFacts, now: number): number {
  let t = -Infinity;
  for (const p of people(f)) t = Math.max(t, p.active || p.waiting || p.heldStart ? now : p.lastActivityAt);
  return t;
}

/** The first thing that legitimately holds the vague awake, in a fixed order, or null. Cheap: no census. */
export function blockerOf(f: VagueFacts): VagueAwakeWhy | null {
  if (!f.members.some((m) => m.unfinished)) return 'no-task';
  if (f.paused) return 'paused';
  if (f.runHeld) return 'run-held';
  if (people(f).some((p) => p.active)) return 'member-active';
  if (people(f).some((p) => p.waiting)) return 'waiting';
  if (people(f).some((p) => p.heldStart)) return 'held-start';
  // Nobody of this vague did anything since the app started: an old wave left unarchived (its tasks never released) is not a sleep that happened on this watch — declaring it would
  // re-nudge every such coordinator (a real model turn, a Veille start) at every launch. A person opening one of its workspaces, or any event, brings it into play.
  if (!people(f).some((p) => p.seenThisRun)) return 'dormant';
  return null;
}

/** An open episode ends when the work is over, the vague is paused / held, or a MEMBER (never the coordinator's own Relance turn) resumes. */
function episodeEnd(f: VagueFacts, ep: VagueEpisode): VagueAwakeWhy | null {
  if (!f.members.some((m) => m.unfinished)) return 'no-task';
  if (f.paused) return 'paused';
  if (f.runHeld) return 'run-held';
  if (f.members.some((m) => m.active || m.waiting || m.heldStart || m.lastActivityAt > ep.declaredAt)) return 'resumed';
  return null;
}

function processLines(f: VagueFacts, c: VagueCensus): VagueProcessLine[] {
  const out: VagueProcessLine[] = [];
  for (const p of people(f)) {
    const got = c.get(p.wsId);
    if (got === 'unknown') out.push({ owner: p.label, cmd: null, pid: null });
    else if (got) for (const r of rootsOf(got)) out.push({ owner: p.label, cmd: r.cmd || r.comm, pid: r.pid });
  }
  return out;
}

/**
 * Fold one look at a vague into its state. `census` is read only when the cheap clauses leave the vague a candidate (or while an owed Relance needs its text).
 *   candidate = unfinished tasks · not paused / held · nobody active · nobody waiting · no held start;
 *   live process (or an unreadable scope) ⇒ protected while the vague has been quiet < processMs, asleep the moment that bound lapses (`since` = the lapse);
 *   no process ⇒ asleep once `max(quiet since, last protected)` is quietMs old.
 */
export function stepVague(
  prev: VagueState | undefined,
  f: VagueFacts,
  census: () => VagueCensus,
  now: number,
  bounds: VagueBounds = DEFAULT_VAGUE_BOUNDS,
): { state: VagueState; verdict: VagueVerdict } {
  const ep = prev?.episode;
  if (ep) {
    const end = episodeEnd(f, ep);
    if (!end) {
      const owed = ep.nudgedAt === undefined;
      return {
        state: { ...prev, episode: ep },
        verdict: { kind: 'asleep', since: ep.since, declared: false, nudge: owed ? 'owed' : 'done', unfinished: f.members.filter((m) => m.unfinished), processes: owed ? processLines(f, census()) : [] },
      };
    }
    return { state: { protectedAt: now, blockedAt: now }, verdict: { kind: 'awake', why: end } };
  }
  const block = blockerOf(f);
  if (block) return { state: { protectedAt: now, blockedAt: now }, verdict: { kind: 'awake', why: block } };

  const quietSince = quietSinceOf(f, now);
  const procs = processLines(f, census());
  let since: number;
  if (procs.length > 0) {
    const lapse = quietSince + bounds.processMs;
    if (now < lapse) return { state: { ...prev, protectedAt: now }, verdict: { kind: 'awake', why: 'process', dueAt: lapse } };
    // the bound lapsed: asleep AT the lapse — unless something else held the vague meanwhile (a Pause just lifted): that restarts the delay
    const floor = (prev?.blockedAt ?? -Infinity) + bounds.quietMs;
    if (now < floor) return { state: prev ?? {}, verdict: { kind: 'awake', why: 'quiet', dueAt: floor } };
    since = Math.max(lapse, prev?.blockedAt ?? -Infinity);
  } else {
    since = Math.max(quietSince, prev?.protectedAt ?? -Infinity);
    if (now < since + bounds.quietMs) return { state: prev ?? {}, verdict: { kind: 'awake', why: 'quiet', dueAt: since + bounds.quietMs } };
  }
  const episode: VagueEpisode = { since, declaredAt: now };
  return {
    state: { ...prev, episode },
    verdict: { kind: 'asleep', since, declared: true, nudge: 'owed', unfinished: f.members.filter((m) => m.unfinished), processes: procs },
  };
}

// ─── The coordinator's Relance ───────────────────────────────────────────────────────────────────────────────────

const MAX_TASK = 140;

/** « 45 seconds », « 10 minutes », « 1 hour » — a bound as a person would say it. */
export function spoken(ms: number): string {
  const unit = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (ms < 90_000) return unit(Math.round(ms / 1000), 'second');
  if (ms % 3_600_000 === 0) return unit(ms / 3_600_000, 'hour');
  return unit(Math.round(ms / 60_000), 'minute');
}

/** Trigger 2 of the Relance (#426): the vague is asleep. Says what remains, since when, each member's last activity and the processes still alive — then what to do. */
export function buildVagueAsleepRelance(f: VagueFacts, since: number, unfinished: readonly VagueMember[], processes: readonly VagueProcessLine[], processMs: number = VAGUE_PROCESS_BOUND_MS): string {
  const n = unfinished.length;
  const task = (t: string): string => { const s = oneLine(t); return s.length > MAX_TASK ? `${s.slice(0, MAX_TASK - 1)}…` : s; };
  const ids = new Set(unfinished.map((m) => m.wsId));
  const rest = f.members.filter((m) => !ids.has(m.wsId));
  const body = [
    `Orchestra (the host) is resuming you: your vague has been asleep since ${clock(since)} UTC — ${n} unfinished task${n === 1 ? '' : 's'}, no member active, nobody waiting for an answer, ${processes.length > 0 ? `and the processes below have had no agent activity around them for over ${spoken(processMs)}` : 'no live process, no Pause'}. Nothing will wake anyone on its own.`,
    'Unfinished:',
    ...list(unfinished.map((m) => `${oneLine(m.label)} — ${task(m.task)} — last activity ${clock(m.lastActivityAt)} UTC`)),
    ...(rest.length > 0 ? ['Others (nothing owed):', ...list(rest.map((m) => `${oneLine(m.label)} — last activity ${clock(m.lastActivityAt)} UTC`))] : []),
    `You: last activity ${clock(f.coordinator.lastActivityAt)} UTC.`,
    ...(processes.length > 0
      ? ['Processes still alive:', ...list(processes.map((p) => (p.cmd === null ? `a process of ${oneLine(p.owner)} could not be read` : `\`${oneLine(p.cmd)}\` (pid ${p.pid}, ${oneLine(p.owner)})`)))]
      : []),
    'Restart the work: read each member\'s state, wake or re-task whoever has an unfinished task, or release what is done. You will not be told again while the vague stays asleep.',
  ];
  return buildRelance(`your vague is asleep: ${n} unfinished task${n === 1 ? '' : 's'}, nothing can wake anyone`, body);
}

// ─── `orchestra bus-status` ──────────────────────────────────────────────────────────────────────────────────────

/** What `orchestra bus-status` shows of an asleep vague (the human step of #429 reads the same view). */
export interface AsleepVagueView {
  runId: string;
  coordinatorId: string;
  coordinator: string;
  /** When nothing could wake anyone any more (ms). */
  since: number;
  declaredAt: number;
  /** When the coordinator's Relance went out; null = owed / not delivered yet. */
  nudgedAt: number | null;
  unfinished: { wsId: string; label: string }[];
}

const ago = (ms: number): string => {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
};

/** One line per asleep vague — « vague endormie » since when, what remains, whether its coordinator was told. No line when nothing sleeps (the output of a healthy fleet is unchanged). */
export function formatAsleepVaguesLines(views: readonly AsleepVagueView[], now: number, thisRunId?: string): string[] {
  return views.map((v) => {
    const names = v.unfinished.slice(0, 5).map((u) => oneLine(u.label)).join(', ') + (v.unfinished.length > 5 ? `, … +${v.unfinished.length - 5}` : '');
    const told = v.nudgedAt === null ? 'coordinator NOT told yet (Relance owed)' : `coordinator relanced at ${clock(v.nudgedAt)} UTC`;
    return `vague endormie: ${oneLine(v.coordinator)}${v.runId === thisRunId ? ' (this run)' : ''} — asleep since ${new Date(v.since).toISOString().slice(0, 19)}Z (${ago(now - v.since)} ago), ${v.unfinished.length} unfinished task${v.unfinished.length === 1 ? '' : 's'} (${names}); ${told}`;
  });
}
