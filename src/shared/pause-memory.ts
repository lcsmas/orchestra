// Memory PAUSE (#290, epic #284, wave G ledger #295 FI-2 / FI-1.8) — the PURE half: the stored motive and what the guard wants done to the fleet.
// Impure halves: src/main/pause-memory.ts (bus, Electron-free) + src/main/pause-memory-host.ts (store, memory guard, tick).
//
// A memory Pause is a Pause automatique DURE whose `runs.pause_auto` carries `{reason:'memory'}` — NO migration (the column is JSON, epoch-bound like the usage-limit motive).
// A MANUAL pause (pause_auto NULL) and a usage-limit pause are never touched by the guard; a human taking over a memory Pause clears `pause_auto` (bus-pause.ts) and so makes it manual.

import type { AutoHeld } from './pause-auto.ts';

/** `runs.paused_by` of a Pause the memory guard wrote (display only — authority never keys on it). */
export const MEMORY_PAUSE_BY = 'host:memory';

/** What the stored motive says about the Pause (all of it informational: the lift keys on the LEVEL, not on these). */
export interface MemoryPauseReason {
  reason: 'memory';
  /** `GuardState.pauseCycle` of the `pause_due` that imposed it. */
  pauseCycle: number;
  /** `GuardState.episode` (Admission episode) at that moment. */
  episode: number;
  /** MemAvailable (bytes) when it was imposed. */
  availBytes: number;
  /** The critical threshold (bytes) it fell below. */
  thresholdBytes: number;
}

/** Stored `pause_auto` = the reason + `epoch` (= `runs.paused_at` it was written for, so a stale column can never turn a LATER manual pause into a memory one) + the optional hold of its Reprise. */
export interface StoredMemoryPause extends MemoryPauseReason {
  epoch: number;
  held?: AutoHeld;
}

export function encodeMemoryPause(reason: MemoryPauseReason, epoch: number, held: AutoHeld | null = null): string {
  const stored: StoredMemoryPause = {
    reason: 'memory',
    pauseCycle: reason.pauseCycle,
    episode: reason.episode,
    availBytes: reason.availBytes,
    thresholdBytes: reason.thresholdBytes,
    epoch,
    ...(held ? { held: { at: held.at, addressees: [...held.addressees], to: held.to, motive: 'memory' as const } } : {}),
  };
  return JSON.stringify(stored);
}

/** The memory reason of the pause that began at `pausedAt`, or null (not a memory pause / malformed / another epoch). Never throws; fail safe: never lift what we cannot prove we paused. */
export function parseMemoryPause(json: string | null | undefined, pausedAt: number | null): MemoryPauseReason | null {
  if (!json || pausedAt === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.reason !== 'memory' || o.epoch !== pausedAt) return null;
  const n = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  if (!n(o.pauseCycle) || !n(o.episode) || !n(o.availBytes) || !n(o.thresholdBytes)) return null;
  return { reason: 'memory', pauseCycle: o.pauseCycle, episode: o.episode, availBytes: o.availBytes, thresholdBytes: o.thresholdBytes };
}

/** What the guard wants done to the fleet NOW — a LEVEL read, so it is also right after an app restart (the in-memory guard state is gone, the persisted pauses are not). */
export type MemoryPauseWant = 'impose' | 'lift' | 'none';

export interface MemoryPauseWantInput {
  /** `MemoryGuardSnapshot.measured`: false = no usable reading (unknown ≠ plenty ≠ critical). */
  measured: boolean;
  availBytes: number | null;
  /** The guard decided the memory Pause is in effect (it began at a `pause_due`, not yet liftable). */
  pause: 'none' | 'held';
  /** The Admission threshold: the memory Pause lifts only ABOVE it (epic #284 hysteresis). */
  admissionBytes: number;
}

export function memoryPauseWant(i: MemoryPauseWantInput): MemoryPauseWant {
  if (!i.measured || i.availBytes === null) return 'none';
  if (i.pause === 'held') return 'impose';
  return i.availBytes > i.admissionBytes ? 'lift' : 'none';
}

/** Why a memory-paused run is not Reprised yet. */
export type MemoryLiftWait = 'ancestor-paused' | 'trap-pending';

/** A Pause whose host trap never stamps must not freeze the fleet for ever: Reprise anyway after this (same bound as the usage-limit motive). */
export const MEMORY_TRAP_WAIT_MAX_MS = 10 * 60_000;

export interface MemoryLiftInput {
  pausedAt: number;
  /** `runs.pause_trap_at` — the Bilans (the Consigne de reprise's only source) exist once the trap finished. */
  trapAt: number | null;
  /** A run ABOVE this one is still fully paused: a child waits for every ancestor (top-down). */
  ancestorPaused: boolean;
  now: number;
}

/** Reprise a liftable memory Pause iff no ancestor Pause stands and the trap's Bilans exist (or the trap is overdue). */
export function decideMemoryLift(i: MemoryLiftInput): { action: 'reprise' } | { action: 'wait'; why: MemoryLiftWait } {
  if (i.ancestorPaused) return { action: 'wait', why: 'ancestor-paused' };
  if (i.trapAt === null && i.now < i.pausedAt + MEMORY_TRAP_WAIT_MAX_MS) return { action: 'wait', why: 'trap-pending' };
  return { action: 'reprise' };
}
