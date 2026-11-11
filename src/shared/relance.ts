// Relance (#427, spec #426; term in CONTEXT.md) — PURE half. A Relance is ONE host-triggered session turn that CARRIES ITS REASON: unlike a Réveil it says
// why, unlike an Avis de tâche it comes from the host and not the CLI. #427 is its first trigger (a member's Reliquats ended); the next ticket reuses
// `buildRelance` / `isRelance` for the asleep vague. The effectful half (census, clock, delivery, Admission) is src/main/relance.ts.
//
// What an « end » is: the disappearance of a Reliquat TREE ROOT (a Reliquat whose parent is not itself a Reliquat of the member — the detached script, the
// server, the rig browser). A chain's own children (the test runner it spawns, a browser's renderers) come and go all the time; they are never an event.

/** Ends this close together are ONE Relance (counted from the first of the group). */
export const RELANCE_GROUP_MS = 15_000;

/**
 * A root counts as a Reliquat worth an event only once the host has SEEN it this long. Stopping a session orphans its children (MCP servers, a tool child): they read `reliquat` for
 * a few seconds and die — an « end » that is nobody's task finishing, and one that would start the member the Veille just stopped. A detached script / server / rig browser lives far longer.
 */
export const RELANCE_MIN_AGE_MS = 20_000;

export const RELANCE_PREFIX = '[orchestra] Relance';

/** Ends kept while a member stays active for hours: the newest are kept (a Relance lists at most 10 anyway). */
const MAX_PENDING_ENDS = 50;

/** A process of the member's kernel scope with the role `reliquat`. Identity = (pid, startTicks): a recycled pid is another process. */
export interface RelanceProc {
  pid: number;
  ppid: number;
  startTicks: number;
  comm: string;
  cmd: string;
}

/** `'unknown'` = the scope could not be read: UNKNOWN is not NONE. */
export type RelanceCensus = readonly RelanceProc[] | 'unknown';

export const procKey = (p: Pick<RelanceProc, 'pid' | 'startTicks'>): string => `${p.pid}:${p.startTicks}`;

/** The tree roots of a census: processes whose parent is not in it. */
export function rootsOf(procs: readonly RelanceProc[]): RelanceProc[] {
  const pids = new Set(procs.map((p) => p.pid));
  return procs.filter((p) => !pids.has(p.ppid));
}

export interface RelanceEnd {
  proc: RelanceProc;
  /** When the host SAW it gone (ms) — within one sweep of the real end. */
  at: number;
}

/** What the host knows of ONE member's Reliquats between two looks. */
export interface RelanceTrack {
  /** The roots seen alive at the last readable census. */
  roots: ReadonlyMap<string, RelanceProc>;
  /** When each process of the census was FIRST seen (ms): its age is how long the host has known it, whatever its place in the tree. */
  seen: ReadonlyMap<string, number>;
  /** Ends seen and not yet announced, oldest first. */
  pending: readonly RelanceEnd[];
}

/**
 * Fold one census into the track. A root of the previous look (seen for at least `RELANCE_MIN_AGE_MS`) that is no longer in the census AT ALL (a root that stopped being a root because its parent joined
 * the scope is still alive) has ended — unless the HOST stopped it (`stoppedByHost`: Veille, Pause, scope stop: they tell the member their own way, and a Relance
 * on top would wake it out of the Veille it was just put in). An unreadable census changes nothing; the first census is a baseline.
 */
export function observeReliquats(
  prev: RelanceTrack | undefined,
  census: RelanceCensus,
  now: number,
  stoppedByHost: (key: string) => boolean,
): RelanceTrack {
  if (census === 'unknown') return prev ?? { roots: new Map(), seen: new Map(), pending: [] };
  const alive = new Set(census.map(procKey));
  const roots = new Map(rootsOf(census).map((p) => [procKey(p), p] as const));
  // age follows the PROCESS, not its root status: a server alive for an hour whose launcher just exited becomes a root, and keeps its hour
  const seen = new Map(census.map((p) => [procKey(p), prev?.seen.get(procKey(p)) ?? now] as const));
  const ended: RelanceEnd[] = [];
  for (const [k, proc] of prev?.roots ?? []) {
    if (alive.has(k) || stoppedByHost(k)) continue;
    if (now - (prev?.seen.get(k) ?? now) < RELANCE_MIN_AGE_MS) continue; // too short-lived to be anyone's task (see RELANCE_MIN_AGE_MS)
    ended.push({ proc, at: now });
  }
  return { roots, seen, pending: [...(prev?.pending ?? []), ...ended].slice(-MAX_PENDING_ENDS) };
}

/** The member as the host sees it right now — everything `decideRelance` needs, read by the effectful half. */
export interface RelanceMember {
  wsId: string;
  /** Has a coordinator (a parent): a workspace the human drives directly is out of scope. */
  hasCoordinator: boolean;
  /** Has a dispatched task (the liveness sweep's population). */
  hasTask: boolean;
  /** Its task is finished AND released (`worker_done`, not re-tasked). */
  released: boolean;
  /** Its run (or an ancestor) is Paused. */
  paused: boolean;
  /** Can a turn be started for it at all (not archived, has a worktree, not a sandbox pause, its start does not keep failing). */
  wakeable: boolean;
  /** A turn is running, a prompt is queued, or it waits for an answer: a Relance now would only pile behind it. */
  active: boolean;
}

export type RelanceDropWhy = 'no-coordinator' | 'no-task' | 'released' | 'nothing-ended';

export type RelanceVerdict =
  | { kind: 'fire'; ended: readonly RelanceEnd[]; running: readonly RelanceProc[] }
  | { kind: 'wait'; why: 'grouping' | 'active' | 'paused' | 'not-wakeable'; keep: readonly RelanceEnd[] }
  | { kind: 'drop'; why: RelanceDropWhy; keep: readonly RelanceEnd[] };

/**
 * Should this member be relanced NOW for the ends the track holds? Only what is PERMANENT drops the ends (no coordinator, no task, released: a Relance is never owed for them).
 * Everything transient WAITS and keeps them: `active`, a Pause (the Reprise resumes the member — its script still ended), a member that cannot be woken yet (no worktree, a start that keeps failing), the grouping window.
 * There is NO acknowledgement by activity: a member that kept working while its script ended and then ended its turn « waiting for the rig » never saw the end (a turn's own
 * last event is always later than an end inside it), so the ends seen during a turn are announced once it is idle — the text lets the member say « already handled ».
 */
export function decideRelance(m: RelanceMember, track: RelanceTrack, now: number): RelanceVerdict {
  if (track.pending.length === 0) return { kind: 'drop', why: 'nothing-ended', keep: [] };
  if (!m.hasCoordinator) return { kind: 'drop', why: 'no-coordinator', keep: [] };
  if (!m.hasTask) return { kind: 'drop', why: 'no-task', keep: [] };
  if (m.released) return { kind: 'drop', why: 'released', keep: [] };
  if (m.paused) return { kind: 'wait', why: 'paused', keep: track.pending };
  if (!m.wakeable) return { kind: 'wait', why: 'not-wakeable', keep: track.pending };
  if (m.active) return { kind: 'wait', why: 'active', keep: track.pending };
  if (now - track.pending[0].at < RELANCE_GROUP_MS) return { kind: 'wait', why: 'grouping', keep: track.pending };
  return { kind: 'fire', ended: track.pending, running: [...track.roots.values()] };
}

// ─── The turn's text ─────────────────────────────────────────────────────────────────────────────────────────────

const MAX_LISTED = 10;
const MAX_CMD = 160;

/** One line of untrusted text: control characters (incl. newlines and ESC) become spaces, bounded. */
function oneLine(s: string): string {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > MAX_CMD ? `${t.slice(0, MAX_CMD - 1)}…` : t;
}

function list(items: readonly string[]): string[] {
  const shown = items.slice(0, MAX_LISTED).map((l) => `- ${l}`);
  return items.length > MAX_LISTED ? [...shown, `- … and ${items.length - MAX_LISTED} more`] : shown;
}

/** THE Relance primitive: a recognisable header carrying the reason, then the body. Never shaped like a Réveil (`orchestra check …`). */
export function buildRelance(reason: string, body: readonly string[]): string {
  return [`${RELANCE_PREFIX} — ${oneLine(reason)}`, ...body].join('\n');
}

export function isRelance(text: string): boolean {
  return text.startsWith(`${RELANCE_PREFIX} — `);
}

const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 19);

/** Trigger 1: the member's Reliquats ended. Says what ended (and when), what still runs, and what to do with it. */
export function buildReliquatsEndedRelance(ended: readonly RelanceEnd[], running: readonly RelanceProc[]): string {
  const n = ended.length;
  const body = [
    'Orchestra (the host) is resuming you: you are idle with an unfinished task and these detached processes of yours ended:',
    ...list(ended.map((e) => `\`${oneLine(e.proc.cmd || e.proc.comm)}\` (pid ${e.proc.pid}) ended at ${clock(e.at)} UTC`)),
    running.length > 0
      ? 'Still running:'
      : 'No other leftover process of yours is running.',
    ...(running.length > 0 ? list(running.map((p) => `\`${oneLine(p.cmd || p.comm)}\` (pid ${p.pid})`)) : []),
    'Read what they produced and carry on with your task (push, nominate, report). If you already dealt with this, there is nothing to do: end your turn without messaging anyone.',
  ];
  return buildRelance(`${n === 1 ? 'a leftover process of yours' : `${n} leftover processes of yours`} ended`, body);
}
