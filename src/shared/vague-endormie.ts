// Vague endormie (#428, spec #426; terms in CONTEXT.md) — PURE half. A vague (a run and its coordinator) is ASLEEP when it still has unfinished dispatched tasks while nothing can wake
// anyone in it: nobody active, nobody waiting for an answer, no live process of theirs, no Pause — for VAGUE_QUIET_MS. A live process protects it for at most VAGUE_PROCESS_BOUND_MS
// without any agent activity. The coordinator then gets ONE Relance (shared/relance.ts `buildRelance`, the #427 primitive) per asleep EPISODE; the episode ends when a MEMBER resumes.
// The effectful half (roster, census, clock, delivery) is src/main/vague-endormie.ts; the human step (#429: notification, sidebar mark, Settings) is shared/vague-human.ts + that file.

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
  /** When a turn of it last STARTED (a real resume — never moved by a person merely opening the workspace); persisted with the workspace, so it survives a restart. */
  lastTurnStartAt?: number;
  /** Its CLI session still owns a running background task (`run_in_background`): the CLI wakes the session when it ends — a process the census cannot see. */
  backgroundTask: boolean;
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
  /** The coordinator has a live parent. One without (a LEAD, a promoted top-level workspace) is the human's conversation: it NEVER gets the Relance — the vague is still declared and shown (spec #426: « the LEAD gets no turn »). */
  coordinatorHasParent: boolean;
  /** A turn can be started for the coordinator at all (not archived, has a worktree, not a sandbox pause, its start does not keep failing). */
  coordinatorWakeable: boolean;
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
  /** `process`: a Reliquat tree root; `unknown`: the scope could not be read, a process of this owner may be alive; `background-task`: a task its CLI session tracks. */
  kind: 'process' | 'unknown' | 'background-task';
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
      /** `owed`: to be sent now · `done`: sent · `human`: the coordinator has no parent, it never gets one · `not-wakeable`: it cannot be started now (retried when it can). */
      nudge: 'owed' | 'done' | 'no-parent' | 'not-wakeable';
      unfinished: readonly VagueMember[];
      /** The live processes that no longer protect the vague (named in the Relance); only read while the nudge is owed. */
      processes: readonly VagueProcessLine[];
    };

export interface VagueEpisode {
  since: number;
  declaredAt: number;
  /** When the coordinator's Relance went out (`undefined` = owed). */
  nudgedAt?: number;
  /** When the HUMAN was told (#429: the notification fired, the mark is on the coordinator's row): persisted, so a restart neither re-notifies nor loses the mark. Set by the sweep, never by `stepVague`. */
  humanAt?: number;
}

/** What the host remembers of ONE vague between two looks. */
export interface VagueState {
  /** The time the vague last fell quiet (persisted): after a restart every idle clock reads the launch, this keeps the TRUE « since » (it never delays or hastens the declaration). */
  quietHint?: number;
  /** In memory only: no declaration before this instant (a restart's grace: the roster settles before a persisted vague is judged). */
  notBefore?: number;
  /** Some participant of this vague was EVER observed active (persisted): a wave nobody ever touched on this watch stays dormant across restarts, one that was seen is judged even after a restart. */
  everSeen?: boolean;
  /** The last pass at which something legitimately held the vague awake: it floors `since`, so a process that just ended (a Relance of its own owner is on its way) gets its full delay. */
  protectedAt?: number;
  /** The last pass at which something OTHER than a live process held it (a Pause, a member working, an answer awaited): a lapsed process does not hurry the declaration past the delay that follows it. */
  blockedAt?: number;
  episode?: VagueEpisode;
}

const people = (f: VagueFacts): VagueParticipant[] => [f.coordinator, ...f.members];

/** When the vague last moved: a participant that is active / waiting / holds a start is moving NOW; else the latest idle clock. */
export function quietSinceOf(f: VagueFacts, now: number, hint?: number): number {
  let t = -Infinity;
  // a participant the host never observed this run has no real reading (its clock is the launch floor): the persisted hint stands in for it
  for (const p of people(f)) t = Math.max(t, p.active || p.waiting || p.heldStart ? now : p.seenThisRun || hint === undefined ? p.lastActivityAt : hint);
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
  return null;
}

const DORMANT: VagueAwakeWhy = 'dormant';

/** An open episode ends when the work is over, the vague is paused / held, or a MEMBER (never the coordinator's own Relance turn) RESUMES: a turn is running or its prompt waits / a turn STARTED since the declaration — never the idle clock, which a click on the workspace moves. */
export function episodeEnd(f: VagueFacts, ep: VagueEpisode): VagueAwakeWhy | null {
  if (!f.members.some((m) => m.unfinished)) return 'no-task';
  if (f.paused) return 'paused';
  if (f.runHeld) return 'run-held';
  if (f.members.some((m) => m.active || m.waiting || m.heldStart || (m.lastTurnStartAt ?? -Infinity) > ep.declaredAt)) return 'resumed';
  return null;
}

function nudgeOf(f: VagueFacts, ep: VagueEpisode): 'owed' | 'done' | 'no-parent' | 'not-wakeable' {
  if (ep.nudgedAt !== undefined) return 'done'; // a Relance that WAS sent stays reported as sent, whatever happens to the coordinator's parent afterwards
  if (!f.coordinatorHasParent) return 'no-parent';
  return f.coordinatorWakeable ? 'owed' : 'not-wakeable';
}

export function processLines(f: VagueFacts, c: VagueCensus): VagueProcessLine[] {
  const out: VagueProcessLine[] = [];
  for (const p of people(f)) {
    const got = c.get(p.wsId);
    if (got === 'unknown') out.push({ owner: p.label, kind: 'unknown', cmd: null, pid: null });
    else if (got) for (const r of rootsOf(got)) out.push({ owner: p.label, kind: 'process', cmd: r.cmd || r.comm, pid: r.pid });
    if (p.backgroundTask) out.push({ owner: p.label, kind: 'background-task', cmd: null, pid: null });
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
  const seen = people(f).some((p) => p.seenThisRun);
  const everSeen = prev?.everSeen === true || seen;
  const r = stepInner(prev, f, census, now, bounds, everSeen);
  return everSeen && !r.state.everSeen ? { state: { ...r.state, everSeen }, verdict: r.verdict } : r;
}

function stepInner(
  prev: VagueState | undefined,
  f: VagueFacts,
  census: () => VagueCensus,
  now: number,
  bounds: VagueBounds,
  everSeen: boolean,
): { state: VagueState; verdict: VagueVerdict } {
  const ep = prev?.episode;
  if (ep) {
    const end = episodeEnd(f, ep);
    if (!end) {
      const nudge = nudgeOf(f, ep);
      return {
        state: { ...prev, episode: ep },
        verdict: { kind: 'asleep', since: ep.since, declared: false, nudge, unfinished: f.members.filter((m) => m.unfinished), processes: nudge === 'owed' ? processLines(f, census()) : [] },
      };
    }
    return { state: { protectedAt: now, blockedAt: now }, verdict: { kind: 'awake', why: end } };
  }
  const block = blockerOf(f);
  if (block) return { state: { protectedAt: now, blockedAt: now }, verdict: { kind: 'awake', why: block } };
  if (!everSeen) return { state: {}, verdict: { kind: 'awake', why: DORMANT } };

  const quietSince = quietSinceOf(f, now, prev?.quietHint);
  const procs = processLines(f, census());
  let since: number;
  if (procs.length > 0) {
    const lapse = quietSince + bounds.processMs;
    if (now < lapse) return { state: { ...prev, protectedAt: now, quietHint: quietSince }, verdict: { kind: 'awake', why: 'process', dueAt: lapse } };
    // the bound lapsed: asleep AT the lapse — unless something else held the vague meanwhile (a Pause just lifted): that restarts the delay
    const floor = Math.max((prev?.blockedAt ?? -Infinity) + bounds.quietMs, prev?.notBefore ?? -Infinity);
    if (now < floor) return { state: { ...prev, quietHint: quietSince }, verdict: { kind: 'awake', why: 'quiet', dueAt: floor } };
    since = Math.max(lapse, prev?.blockedAt ?? -Infinity);
  } else {
    since = Math.max(quietSince, prev?.protectedAt ?? -Infinity);
    const due = Math.max(since + bounds.quietMs, prev?.notBefore ?? -Infinity);
    if (now < due) return { state: { ...prev, quietHint: quietSince }, verdict: { kind: 'awake', why: 'quiet', dueAt: due } };
  }
  const episode: VagueEpisode = { since, declaredAt: now };
  return {
    state: { ...prev, episode, quietHint: undefined },
    verdict: { kind: 'asleep', since, declared: true, nudge: nudgeOf(f, episode), unfinished: f.members.filter((m) => m.unfinished), processes: procs },
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
    `Orchestra (the host) is resuming you: your vague has been asleep since ${clock(since)} UTC — ${n} unfinished task${n === 1 ? '' : 's'}, no member active, nobody waiting for an answer, ${processes.length > 0 ? `and what is still alive below has had no agent activity around it for over ${spoken(processMs)} (it no longer counts as a reason to wait)` : 'no live process, no background task, no Pause'}. Nothing will wake anyone on its own.`,
    'Unfinished:',
    ...list(unfinished.map((m) => `${oneLine(m.label)} — ${task(m.task)} — last activity ${clock(m.lastActivityAt)} UTC`)),
    ...(rest.length > 0 ? ['Others (nothing owed):', ...list(rest.map((m) => `${oneLine(m.label)} — last activity ${clock(m.lastActivityAt)} UTC`))] : []),
    `You: last activity ${clock(f.coordinator.lastActivityAt)} UTC.`,
    ...(processes.length > 0
      ? ['Processes still alive:', ...list(processes.map((p) => (p.kind === 'background-task' ? `a background task of ${oneLine(p.owner)}, tracked by its session` : p.cmd === null ? `a process of ${oneLine(p.owner)} could not be read` : `\`${oneLine(p.cmd)}\` (pid ${p.pid}, ${oneLine(p.owner)})`)))]
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
  /** When the coordinator's Relance went out; null = not (yet) sent. */
  nudgedAt: number | null;
  /** `sent` · `owed` (not delivered yet, retried with a capped back-off) · `no-parent` (the coordinator is the human's conversation — or an OPS whose parent is archived / deleted — it never gets one) · `not-wakeable`. */
  relance: 'sent' | 'owed' | 'no-parent' | 'not-wakeable';
  unfinished: { wsId: string; label: string }[];
  /** Every other workspace of the vague (#429: the sidebar dims their rows while the mark is up). */
  memberIds: string[];
  /** When the human was told (#429); null = not yet. */
  humanAt: number | null;
  /** The Relancer can nudge this coordinator NOW (#429): it has a live parent and can be started (read from this pass's facts — `relance: 'sent'` alone says what happened, not what can). */
  canNudge: boolean;
}

const ago = (ms: number): string => {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
};

/** One line per asleep vague — « vague endormie » since when, what remains, whether its coordinator was told. No line when nothing sleeps (the output of a healthy fleet is unchanged). */
export function formatAsleepVaguesLines(views: readonly AsleepVagueView[], now: number, thisRunId?: string): string[] {
  return views.map((v) => {
    const names = v.unfinished.slice(0, 5).map((u) => oneLine(u.label)).join(', ') + (v.unfinished.length > 5 ? `, … +${v.unfinished.length - 5}` : '');
    const told =
      v.relance === 'no-parent' ? 'coordinator has no parent (human-facing): no Relance sent'
      : v.relance === 'not-wakeable' ? 'coordinator cannot be started now: NOT told'
      : v.nudgedAt === null ? 'coordinator NOT told yet (Relance owed)'
      : `coordinator relanced at ${clock(v.nudgedAt)} UTC`;
    return `vague endormie: ${oneLine(v.coordinator)}${v.runId === thisRunId ? ' (this run)' : ''} — asleep since ${new Date(v.since).toISOString().slice(0, 19)}Z (${ago(now - v.since)} ago), ${v.unfinished.length} unfinished task${v.unfinished.length === 1 ? '' : 's'} (${names}); ${told}`;
  });
}
