// Docker relay hold — the PURE half (#321, wave H ledger #329, epic #319; ADR 0004 + 0005; Admission = #286). Impure halves: src/keeper/docker-hold.ts (the gate inside the keeper's relay),
// src/main/docker-hold.ts (the app publishes the Admission state and reads the keepers' hold files).
//
// A container creation/start a fleet member makes THROUGH ITS KEEPER'S RELAY waits while the memory guard holds Admission and proceeds BY ITSELF when memory is back — the same retention semantics as
// Admission, never a refusal. The app (which owns the guard) publishes the EFFECTIVE hold state (`isAdmissionHolding`) in ONE small file; each keeper's relay reads it. A container made around the relay
// (the human's own stacks) never goes through a relay and is never held; a START is held only for a container the relay stamped for THIS workspace.
//
// NO imports of Node modules: shared with the app's CLI bundle.

import { GIB, isAdmissionHolding, type MemoryGuardSnapshot } from './memory-guard.ts';

/** Where the app publishes the state: `<ORCHESTRA_HOME>/admission.state` (a flat file beside `bus.sqlite`; unix paths only — the relay does not exist on win32). */
export function admissionStateFile(home: string): string {
  return `${home.replace(/\/+$/, '')}/admission.state`;
}

/** The file's schema version. A keeper that does not know it never holds. */
export const ADMISSION_STATE_VERSION = 1;
/** An Admission state older than this is NOT authoritative (the app is gone or wedged): the relay lets everything through — a hold must never outlive the thing that decides it. The guard writes at every sample (≤ 60 s). */
export const ADMISSION_STATE_TTL_MS = 5 * 60_000;
/** A keeper's published hold older than this is a dead keeper's leftover (it refreshes at least every 5 s while anything waits). */
export const HOLD_FILE_TTL_MS = 30_000;

// ─── The state the app publishes ────────────────────────────────────────────────────────────────────────────────────

export interface AdmissionState {
  v: typeof ADMISSION_STATE_VERSION;
  /** Epoch ms the app wrote it. */
  ts: number;
  /** The EFFECTIVE hold: `isAdmissionHolding(snapshot)` — toggle ON and the guard holding. The ONLY question this feature asks of the guard (ledger FI-2). */
  held: boolean;
  /** The Admission toggle (Settings). OFF ⇒ the guard only measures: a line already waiting is released AT ONCE (Admission's `planRelease` does the same), whatever a fresh reading says. */
  enabled: boolean;
  /** Epoch ms the CURRENT hold began; null when not held. */
  heldSince: number | null;
  episode: number;
  /** The last good MemAvailable reading (bytes), for the reason text; null when never read. */
  availBytes: number | null;
  /** The thresholds in force (bytes): a release needs a FRESH keeper-side reading above `admissionBytes + releaseMarginBytes`. */
  admissionBytes: number;
  releaseMarginBytes: number;
}

/** The state to publish for a guard snapshot. */
export function admissionStateOf(snap: Pick<MemoryGuardSnapshot, 'admission' | 'admissionEnabled' | 'heldSince' | 'episode' | 'availBytes' | 'admissionBytes' | 'releaseMarginBytes'>, now: number): AdmissionState {
  const held = isAdmissionHolding(snap);
  return {
    v: ADMISSION_STATE_VERSION,
    ts: now,
    held,
    enabled: snap.admissionEnabled,
    heldSince: held ? snap.heldSince : null,
    episode: snap.episode,
    availBytes: snap.availBytes,
    admissionBytes: snap.admissionBytes,
    releaseMarginBytes: snap.releaseMarginBytes,
  };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Parse the published file; null for anything malformed or of another version (a keeper must never crash on, or obey, a file it does not understand). */
export function parseAdmissionState(text: string): AdmissionState | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.v !== ADMISSION_STATE_VERSION || !isNum(o.ts) || typeof o.held !== 'boolean' || typeof o.enabled !== 'boolean' || !isNum(o.episode) || !isNum(o.admissionBytes) || !isNum(o.releaseMarginBytes)) return null;
  if (o.heldSince !== null && !isNum(o.heldSince)) return null;
  if (o.availBytes !== null && !isNum(o.availBytes)) return null;
  return { v: ADMISSION_STATE_VERSION, ts: o.ts, held: o.held, enabled: o.enabled, heldSince: o.heldSince as number | null, episode: o.episode, availBytes: o.availBytes as number | null, admissionBytes: o.admissionBytes, releaseMarginBytes: o.releaseMarginBytes };
}

/** Is the state authoritative at `now`? (a state from the FUTURE by more than the TTL is not either: a clock step must not wedge a hold) */
export function stateIsFresh(s: AdmissionState, now: number, ttlMs = ADMISSION_STATE_TTL_MS): boolean {
  return Math.abs(now - s.ts) <= ttlMs;
}

/** Must a new request wait NOW? Absent / unreadable / stale state = no (fail open: the thing that decides is gone). */
export function holdsNow(s: AdmissionState | null, now: number, ttlMs = ADMISSION_STATE_TTL_MS): boolean {
  return s !== null && stateIsFresh(s, now, ttlMs) && s.held;
}

/** May ONE held request go out now? `availBytes` = a FRESH keeper-side reading. Unreadable (null) = the guard's own word (the state says not held): never wedges a line on a meter that cannot answer. Strict, like `mayReleaseOneStart`. */
export function mayReleaseOne(s: Pick<AdmissionState, 'admissionBytes' | 'releaseMarginBytes'>, availBytes: number | null): boolean {
  if (availBytes === null || !Number.isFinite(availBytes) || availBytes < 0) return true;
  return availBytes > s.admissionBytes + s.releaseMarginBytes;
}

const gb = (b: number): string => `${(b / GIB).toFixed(2)} GB`;
const hhmmss = (ms: number): string => new Date(ms).toISOString().slice(11, 19);

/** WHY a request waits (a member reads this): the reading, the threshold, when the hold began. */
export function holdReason(s: AdmissionState): string {
  const reading = s.availBytes === null ? 'MemAvailable unknown' : `MemAvailable ${gb(s.availBytes)}`;
  const since = s.heldSince !== null ? `, held since ${hhmmss(s.heldSince)}Z` : '';
  return `Admission hold: ${reading} < ${gb(s.admissionBytes)} (reopens above ${gb(s.admissionBytes + s.releaseMarginBytes)}; episode ${s.episode}${since})`;
}

/** Human duration for a wait: 4 s, 2 min 5 s. */
export function fmtWait(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

// ─── Which calls wait ───────────────────────────────────────────────────────────────────────────────────────────────

export type HeldOp = { kind: 'create' } | { kind: 'start'; id: string; prefix: string };

const CREATE = /^\/(?:v\d+(?:\.\d+)*\/)?containers\/create(?:\?|$)/;
const START = /^((?:\/v\d+(?:\.\d+)*)?)\/containers\/([^/?#]+)\/start(?:\?|$)/;

/** `POST /containers/create` and `POST /containers/<id>/start` (docker run / create / start / compose up, client libraries). Anything else — ps, exec, logs, stop, build — never waits. */
export function heldOpOf(method: string | undefined, url: string | undefined): HeldOp | null {
  if (method !== 'POST') return null;
  const u = url ?? '';
  if (CREATE.test(u)) return { kind: 'create' };
  const m = START.exec(u);
  if (!m) return null;
  const id = m[2];
  let decoded = id;
  try {
    decoded = decodeURIComponent(id);
  } catch {
    /* keep the raw id */
  }
  return { kind: 'start', id: decoded, prefix: m[1] };
}

/** Is a START for a container this relay stamped for THIS workspace, and not already running? Only those wait (a container made around the relay is never held; starting a running one starts nothing). */
export function startIsHoldable(inspect: { labels?: Record<string, string> | null; running?: boolean } | null, ws: string, wsLabel: string): boolean {
  if (!inspect) return false; // unknown container / inspect failed: fail open
  if (inspect.running === true) return false;
  return inspect.labels?.[wsLabel] === ws;
}

// ─── The fleet-wide release slot (review M1) ───────────────────────────────────────────────────────────────────────────

/** Admission is ONE line for the whole fleet (`planRelease`): held starts leave one at a time. The relays are one per keeper, so they share ONE release slot — a lease file beside the state file,
 *  taken with an exclusive create. Whoever holds it does the fresh MemAvailable reading, releases ONE call and spends the settle before giving it back. */
export function admissionLeaseFile(stateFile: string): string {
  return /\.state$/.test(stateFile) ? stateFile.replace(/\.state$/, '.lease') : `${stateFile}.lease`;
}

/** A holder that neither released nor renewed within this long is presumed stuck (the settle is ~1.5 s; a dead holder is told apart by its pid, not by waiting this out). */
export const RELEASE_LEASE_TTL_MS = 20_000;

export interface ReleaseLease {
  v: 1;
  /** The keeper's workspace id — who holds the slot, for a human reading the file. */
  owner: string;
  pid: number;
  /** Epoch ms it was taken. */
  ts: number;
}

export function parseLease(text: string | null): ReleaseLease | null {
  if (text === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.v !== 1 || typeof o.owner !== 'string' || !isNum(o.pid) || !isNum(o.ts)) return null;
  return { v: 1, owner: o.owner, pid: o.pid, ts: o.ts };
}

/** May this lease be taken over? Its holder is DEAD (a SIGKILLed keeper must never wedge the fleet's line), or it has been held past the TTL. A lease that cannot be parsed is judged by the file's
 *  age (`ageMs`): a writer may be between its create and its write. */
export function leaseIsStale(l: ReleaseLease | null, ageMs: number, now: number, pidAlive: (pid: number) => boolean, ttlMs = RELEASE_LEASE_TTL_MS): boolean {
  if (l === null) return ageMs > ttlMs;
  return !pidAlive(l.pid) || now - l.ts > ttlMs || l.ts - now > ttlMs;
}

// ─── What the keeper publishes (the member and the app read it) ─────────────────────────────────────────────────────

export interface HoldFile {
  v: 1;
  ts: number;
  /** How many creations / starts wait right now. */
  create: number;
  start: number;
  /** Epoch ms the OLDEST waiting request began to wait. */
  since: number;
  heldSince: number | null;
  episode: number;
  reason: string;
}

export function parseHoldFile(text: string | null): HoldFile | null {
  if (text === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.v !== 1 || !isNum(o.ts) || !isNum(o.create) || !isNum(o.start) || !isNum(o.since) || !isNum(o.episode) || typeof o.reason !== 'string') return null;
  if (o.heldSince !== null && !isNum(o.heldSince)) return null;
  return { v: 1, ts: o.ts, create: o.create, start: o.start, since: o.since, heldSince: o.heldSince as number | null, episode: o.episode, reason: o.reason };
}

/** A hold file still describes something waiting: written recently and not empty. */
export function holdIsLive(h: HoldFile, now: number, ttlMs = HOLD_FILE_TTL_MS): boolean {
  return now - h.ts <= ttlMs && h.create + h.start > 0;
}

/** The sentence a coordinator / `bus-status` shows for one workspace's hold. */
export function describeHold(label: string, h: HoldFile, now: number): string {
  const n = h.create + h.start;
  const ops = [h.create ? `${h.create} create` : '', h.start ? `${h.start} start` : ''].filter(Boolean).join(' + ');
  return `${label}: ${n} docker call(s) waiting (${ops}) for ${fmtWait(now - h.since)} (since ${hhmmss(h.since)}Z) — ${h.reason}`;
}

/** The one bus status a member gets per hold episode. Plain text for an agent: nothing to do, it proceeds by itself. */
export function holdNoticeText(h: HoldFile, now: number): string {
  const n = h.create + h.start;
  return `Orchestra is holding ${n} of your docker call(s) (container create/start through your keeper's relay) for ${fmtWait(now - h.since)}: ${h.reason}. They proceed BY THEMSELVES when memory is back — nothing is refused and nothing needs retrying; do not kill the waiting command (if you must, its create is simply abandoned, never replayed). A client with its OWN short timeout gives up first and its call must be retried: docker-py (the python \`docker\` SDK, compose v1) times out after 60 s by default — give it a longer timeout. While one waits, \`orchestra bus-status\` prints a \`docker holds:\` line with the reason and since when. Containers you create outside the relay are never held.`;
}

/** One workspace's hold as `bus-status` carries it. */
export interface DockerHoldView {
  wsId: string;
  label: string;
  hold: HoldFile;
}

/** The `docker holds:` line of `bus-status`; '' when nothing waits (the output is then byte-identical to before #321). */
export function formatDockerHoldsLine(views: readonly DockerHoldView[], now: number): string {
  const live = views.filter((v) => holdIsLive(v.hold, now));
  if (live.length === 0) return '';
  return `docker holds: ${live.map((v) => describeHold(v.label, v.hold, now)).join(' | ')}`;
}

/** The text a held-then-released create adds to the response's `Warnings` (the docker CLI prints each as `WARNING: …`). */
export function heldWarning(waitedMs: number, reason: string, flushed = false): string {
  const end = flushed ? 'was released because the Admission state is no longer published (the app is gone or the toggle is off)' : 'went through when memory was back';
  return `orchestra: this container call waited ${fmtWait(waitedMs)} under the Admission hold (${reason}) and ${end}`;
}
