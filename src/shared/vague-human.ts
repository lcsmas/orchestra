// Vague endormie, the HUMAN step (#429, spec #426) — PURE half: the two delays as settings, when the human is told, the mark the sidebar draws on the coordinator's row and its words.
// The detection and the coordinator's Relance are #428 (shared/vague-endormie.ts); the effectful half (notification, push, Relancer) is main/vague-endormie.ts + vague-endormie-host.ts.

/** Spec #426: the human is told this long after the coordinator's Relance, if no member resumed. */
export const VAGUE_HUMAN_MS = 15 * 60_000;

/** The two delays of the spec, in minutes, as the human edits them (Settings): asleep after · tell the human after. */
export interface VagueDelays {
  asleepMin: number;
  humanMin: number;
}
export const DEFAULT_VAGUE_DELAYS: VagueDelays = { asleepMin: 10, humanMin: 15 };
export const VAGUE_DELAY_MIN = 1;
export const VAGUE_DELAY_MAX = 24 * 60;

const okMin = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= VAGUE_DELAY_MIN && n <= VAGUE_DELAY_MAX;

/** What the store holds → usable delays: each field falls back to its default on its own (absent, a string, a float, 0, a negative, past the cap). */
export function normalizeVagueDelays(raw: unknown): VagueDelays {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof VagueDelays, unknown>>;
  return { asleepMin: okMin(r.asleepMin) ? r.asleepMin : DEFAULT_VAGUE_DELAYS.asleepMin, humanMin: okMin(r.humanMin) ? r.humanMin : DEFAULT_VAGUE_DELAYS.humanMin };
}

/** The write path's check: null = acceptable. */
export function vagueDelaysError(next: unknown): string | null {
  const r = (next && typeof next === 'object' ? next : {}) as Partial<Record<keyof VagueDelays, unknown>>;
  if (!okMin(r.asleepMin)) return `Le délai avant « endormie » doit être un nombre entier de minutes entre ${VAGUE_DELAY_MIN} et ${VAGUE_DELAY_MAX}.`;
  if (!okMin(r.humanMin)) return `Le délai avant de vous prévenir doit être un nombre entier de minutes entre ${VAGUE_DELAY_MIN} et ${VAGUE_DELAY_MAX}.`;
  return null;
}

export const delaysToMs = (d: VagueDelays): { quietMs: number; humanMs: number } => ({ quietMs: d.asleepMin * 60_000, humanMs: d.humanMin * 60_000 });

/** The slice of an asleep episode the human step reads. */
export interface HumanStepInput {
  declaredAt: number;
  /** When the coordinator's Relance went out (undefined = owed / never). */
  nudgedAt?: number;
  /** When the human was told (the notification fired): once set, the mark stays until the episode ends. */
  humanAt?: number;
}
/** `#428`'s `VagueVerdict.nudge`. */
export type HumanNudge = 'owed' | 'done' | 'no-parent' | 'not-wakeable';

/**
 * Is the human to be told now? A coordinator with NO PARENT never receives the Relance, so there is nothing to wait for: the step starts at the declaration. Otherwise it starts `humanMs` after the Relance;
 * a Relance that cannot go out (owed, or the coordinator cannot be started) leaves the vague just as asleep, so the delay then runs from the declaration. Once told, always due (the mark is persistent: lengthening
 * the delay later must not take it down).
 */
export function humanStepDue(ep: HumanStepInput, nudge: HumanNudge, now: number, humanMs: number): boolean {
  if (ep.humanAt !== undefined) return true;
  if (nudge === 'no-parent') return true;
  const from = nudge === 'done' && ep.nudgedAt !== undefined ? ep.nudgedAt : ep.declaredAt;
  return now >= from + humanMs;
}

// ─── The mark (wire shape: the renderer draws it, the notification words it) ─────────────────────────────────────

/** One asleep vague the human has been told about, as the sidebar draws it on the coordinator's own row. */
export interface VagueMark {
  runId: string;
  coordinatorId: string;
  /** When nothing could wake anyone any more (ms epoch) — « depuis HH:MM ». */
  since: number;
  /** Unfinished dispatched tasks — « N tâche(s) en attente ». */
  pending: number;
  /** Every other workspace of the vague (dimmed); never the coordinator. */
  memberIds: string[];
  /** The Relancer button nudges the coordinator again — false when it cannot be (no parent: its conversation is the human's, nothing is ever sent there; or it cannot be started now). */
  canRelance: boolean;
}

/** What main pushes (`vague:update`) and answers (`vague:marks`): the WHOLE set, a snapshot — it cannot drift. */
export interface VagueMarks {
  /** Strictly increasing per process: the later of two readings wins (a pull answered after a newer push must not roll it back). */
  rev: number;
  marks: VagueMark[];
}
export const newerVagueMarks = (prev: VagueMarks | null | undefined, next: VagueMarks): VagueMarks => (!prev || next.rev >= prev.rev ? next : prev);

/** The mark ON this workspace's row (it is a vague's coordinator), if any. */
export const markOfCoordinator = (m: VagueMarks | null | undefined, wsId: string): VagueMark | undefined => m?.marks.find((x) => x.coordinatorId === wsId);
/** True when this workspace is a member of an asleep vague the human was told about (its row is dimmed). */
export const isDimmedMember = (m: VagueMarks | null | undefined, wsId: string): boolean => !!m?.marks.some((x) => x.memberIds.includes(wsId));
/** The class added to a dimmed member's row (empty otherwise) — the sidebar's one call, like `pauseDimClass`. */
export const vagueDimClass = (m: VagueMarks | null | undefined, wsId: string): string => (isDimmedMember(m, wsId) ? ' vague-dim' : '');

/** The same wire shape, only if it changed: the push carries it only then. */
export const marksKey = (marks: readonly VagueMark[]): string => JSON.stringify(marks);

// ─── Words (French, like the prototype and the Pause UI) ──────────────────────────────────────────────────────────

/** HH:MM in the reader's own time zone. */
export function localHHMM(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export const VAGUE_PILL = '☾ endormie';
export const pendingWords = (n: number): string => `${n} tâche${n > 1 ? 's' : ''} en attente`;
/** « depuis 23:19 · 1 tâche en attente » */
export const markSubLine = (m: Pick<VagueMark, 'since' | 'pending'>): string => `depuis ${localHHMM(m.since)} · ${pendingWords(m.pending)}`;

/** The desktop notification: the title names the vague's coordinator, the body says since when and what remains. */
export function notificationOf(coordinator: string, since: number, pending: number): { title: string; body: string } {
  return { title: 'Vague endormie', body: `${coordinator} dort depuis ${localHHMM(since)} — ${pendingWords(pending)}. Aucun membre n'a repris.` };
}
