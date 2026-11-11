// Vague endormie (#428, spec #426) — the effectful half: a level-triggered sweep that reads each vague's facts, folds them through the pure `stepVague` (shared/vague-endormie.ts) and, on the
// FIRST pass of an asleep episode, hands the COORDINATOR one Relance (shared/relance.ts `buildRelance`, the #427 primitive) through the same delivery a Réveil / a member's Relance takes — so a
// coordinator in Veille is brought back, Admission holds the start under low memory, a Pause refuses it. It does not touch the bus and acks nothing. A coordinator WITHOUT a parent (the human's conversation) is never sent one: the vague is still declared and shown. What survives a restart (`deps.persist`): per run `everSeen` + the open episode.
//
// Everything it reads is injected (roster, census, clock, delivery): `vague-endormie-host.ts` wires the store, the kernel-scope census and `sdkStartAndDeliver`; node --test and the
// session-budget rig drive this file as it ships. Not started ⇒ no coordinator ever gets a turn from it (the control arm of the rig). Nothing of the human step (#429) is here.

import { log } from './logger.ts';
import { RELANCE_RETRY_MS, type RelanceDelivery } from './relance.ts';
import type { RelanceCensus } from '../shared/relance.ts';
import { buildVagueAsleepRelance, DEFAULT_VAGUE_BOUNDS, stepVague, type AsleepVagueView, type VagueBounds, type VagueCensus, type VagueEpisode, type VagueFacts, type VagueState } from '../shared/vague-endormie.ts';

/** How often the sweep looks. The delay is minutes; the census is read only for a vague with nothing else holding it awake. */
export const VAGUE_SWEEP_MS = 30_000;
/** One delivery (a session start) may take this long before the sweep moves on; its result is still applied when it lands. */
export const VAGUE_DELIVER_WAIT_MS = 20_000;
/** Failed deliveries of ONE episode's Relance before the host stops trying (back-off: RELANCE_RETRY_MS × attempts). The asleep state stays visible in bus-status. */
export const VAGUE_MAX_ATTEMPTS = 5;

/** What survives a restart, per run: was it ever observed active, and its open episode (with whether / when the coordinator was told). */
export type PersistedVagues = Record<string, { everSeen?: boolean; episode?: VagueEpisode }>;
export interface VagueStore {
  /** Throws or returns garbage ⇒ the sweep starts from nothing (and says so). */
  load(): PersistedVagues;
  save(all: PersistedVagues): void;
}

export interface VagueDeps {
  now(): number;
  /** Every vague that has at least one dispatched member, as the facts read it (the host fills them; the sweep never reads the store). */
  vagues(): VagueFacts[];
  /** ONE vague read fresh — right before its coordinator is told. Absent = the snapshot is used. */
  vague?(runId: string): VagueFacts | undefined;
  /** One workspace's Reliquats (kernel scope). A throw reads as UNKNOWN. */
  census(wsId: string): RelanceCensus;
  /** Start / resume the coordinator's session and deliver `text` as its next turn (`held` = Admission holds the start: nothing is lost, the host retries). */
  deliver(coordinatorId: string, text: string): Promise<RelanceDelivery>;
  /** The delays, read per pass (#429 turns the quiet delay into a setting). Absent = the spec's 10 min / 1 h. */
  bounds?(): Partial<VagueBounds>;
  /** Persistence across a restart (absent = memory only). */
  persist?: VagueStore;
  deliverWaitMs?: number;
}

export interface VagueCounters {
  /** Episodes declared. */
  declared: number;
  /** Coordinators told (one per episode). */
  nudged: number;
  failed: number;
  held: number;
  /** Episodes ended (a member resumed, the work finished, a Pause). */
  ended: number;
}
const counters: VagueCounters = { declared: 0, nudged: 0, failed: 0, held: 0, ended: 0 };
export const vagueCounters = (): VagueCounters => ({ ...counters });

const states = new Map<string, VagueState>();
const views = new Map<string, AsleepVagueView>();
const retryAt = new Map<string, number>();
const heldLogged = new Set<string>();
const attempts = new Map<string, number>();
const gaveUp = new Set<string>();
let loaded = false;
let lastSaved = '';
/** Runs whose delivery is still pending past the wait: not touched again until it lands (a second turn for the same episode would be a duplicate). */
const slow = new Set<string>();
let lastSweepError = '';
let sweeping = false;
let current: Promise<string[]> | null = null;

/** The vagues asleep right now (an open episode), oldest first. */
export function asleepVagues(): AsleepVagueView[] {
  return [...views.values()].sort((a, b) => a.since - b.since);
}

/** One pass over every vague. Never throws; an overlapping call returns at once. Returns the coordinators told this pass (what the fleet OBSERVES: a turn started or not). */
export async function sweepVagues(deps: VagueDeps): Promise<string[]> {
  if (sweeping) return [];
  sweeping = true;
  current = runSweep(deps);
  try {
    return await current;
  } finally {
    sweeping = false;
    current = null;
  }
}

async function runSweep(deps: VagueDeps): Promise<string[]> {
  const told: string[] = [];
  try {
    const now = deps.now();
    const bounds: VagueBounds = { ...DEFAULT_VAGUE_BOUNDS, ...(deps.bounds?.() ?? {}) };
    loadPersisted(deps);
    const all = deps.vagues();
    const live = new Set(all.map((f) => f.runId));
    for (const id of [...states.keys()]) {
      if (live.has(id)) continue;
      states.delete(id);
      views.delete(id);
      retryAt.delete(id);
      heldLogged.delete(id);
      attempts.delete(id);
      gaveUp.delete(id);
    }
    for (const f of all) {
      try {
        if (slow.has(f.runId)) continue; // its delivery has not landed yet
        const census = (): VagueCensus => {
          const m = new Map<string, RelanceCensus>();
          for (const p of [f.coordinator, ...f.members]) {
            try {
              m.set(p.wsId, deps.census(p.wsId));
            } catch (e) {
              log.warn(`vague-endormie: census of ${p.wsId} failed — treated as unknown`, e);
              m.set(p.wsId, 'unknown');
            }
          }
          return m;
        };
        const prev = states.get(f.runId);
        const { state, verdict } = stepVague(prev, f, census, now, bounds);
        states.set(f.runId, state);
        if (verdict.kind === 'awake') {
          if (prev?.episode) {
            counters.ended++;
            views.delete(f.runId);
            retryAt.delete(f.runId);
            heldLogged.delete(f.runId);
            attempts.delete(f.runId);
            gaveUp.delete(f.runId);
            log.info(`vague-endormie: ${f.runId} is awake again (${verdict.why}) — the asleep episode since ${new Date(prev.episode.since).toISOString()} is over`);
          }
          continue;
        }
        const view: AsleepVagueView = {
          runId: f.runId,
          coordinatorId: f.coordinator.wsId,
          coordinator: f.coordinator.label,
          since: verdict.since,
          declaredAt: state.episode?.declaredAt ?? now,
          nudgedAt: state.episode?.nudgedAt ?? null,
          relance: verdict.nudge === 'human' ? 'human' : verdict.nudge === 'not-wakeable' ? 'not-wakeable' : gaveUp.has(f.runId) ? 'gave-up' : state.episode?.nudgedAt !== undefined ? 'sent' : 'owed',
          unfinished: verdict.unfinished.map((m) => ({ wsId: m.wsId, label: m.label })),
        };
        views.set(f.runId, view);
        if (verdict.declared) {
          counters.declared++;
          log.info(`vague-endormie: ${f.runId} is ASLEEP since ${new Date(verdict.since).toISOString()} — ${verdict.unfinished.length} unfinished task(s), ${verdict.processes.length} live process(es); coordinator ${f.coordinator.wsId} to be told`);
        }
        if (verdict.nudge !== 'owed' || gaveUp.has(f.runId) || (retryAt.get(f.runId) ?? 0) > now) continue;
        // Judge the coordinator on FRESH state right before it is told: a turn it started since the pass's snapshot makes the Relance pointless (it is reading the world).
        const fresh = deps.vague?.(f.runId) ?? f;
        if (fresh.coordinator.active || fresh.coordinator.waiting || fresh.paused || fresh.runHeld || !fresh.coordinatorWakeable || !fresh.coordinatorHasParent) continue;
        const text = buildVagueAsleepRelance(fresh, verdict.since, verdict.unfinished, verdict.processes, bounds.processMs);
        // Mark BEFORE the await (a second pass cannot send it again); undone below if the turn did not go out.
        const episode = state.episode!;
        states.set(f.runId, { ...state, episode: { ...episode, nudgedAt: now } });
        save(deps); // at most once across a crash: what was marked is not sent again
        const delivery: Promise<RelanceDelivery> = (async () => deps.deliver(f.coordinator.wsId, text))().catch((e: unknown) => {
          log.warn(`vague-endormie: delivery to ${f.coordinator.wsId} threw`, e);
          return 'failed' as const;
        });
        const settle = (result: RelanceDelivery): void => {
          const cur = states.get(f.runId);
          if (result === 'sent') {
            counters.nudged++;
            attempts.delete(f.runId);
            heldLogged.delete(f.runId);
            told.push(f.coordinator.wsId);
            const v = views.get(f.runId);
            if (v) views.set(f.runId, { ...v, nudgedAt: now });
            log.info(`vague-endormie: coordinator ${f.coordinator.wsId} relanced — vague ${f.runId} asleep since ${new Date(verdict.since).toISOString()}`);
            return;
          }
          // the turn did not go out: owed again (unless the episode is over meanwhile)
          if (cur?.episode) states.set(f.runId, { ...cur, episode: { ...cur.episode, nudgedAt: undefined } });
          if (result === 'held') {
            counters.held++;
            if (!heldLogged.has(f.runId)) {
              heldLogged.add(f.runId);
              log.info(`vague-endormie: the Relance of ${f.coordinator.wsId} is HELD for memory (Admission); delivered when memory recovers, nothing is lost`);
            }
          } else {
            counters.failed++;
            const n = (attempts.get(f.runId) ?? 0) + 1;
            attempts.set(f.runId, n);
            if (n >= VAGUE_MAX_ATTEMPTS) {
              gaveUp.add(f.runId);
              const v = views.get(f.runId);
              if (v) views.set(f.runId, { ...v, relance: 'gave-up' });
              log.warn(`vague-endormie: could not deliver the Relance to ${f.coordinator.wsId} after ${n} attempts — giving up on this episode (still shown in bus-status)`);
            } else {
              retryAt.set(f.runId, deps.now() + RELANCE_RETRY_MS * n);
              log.warn(`vague-endormie: could not deliver the Relance to ${f.coordinator.wsId}; retrying in ${(RELANCE_RETRY_MS * n) / 1000}s`);
            }
          }
        };
        const waitMs = deps.deliverWaitMs ?? VAGUE_DELIVER_WAIT_MS;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const first = await Promise.race([delivery, new Promise<'slow'>((r) => { timer = setTimeout(() => r('slow'), waitMs); })]);
        clearTimeout(timer);
        if (first === 'slow') {
          slow.add(f.runId);
          log.warn(`vague-endormie: delivery to ${f.coordinator.wsId} still pending after ${waitMs / 1000}s — moving on`);
          void delivery.then((res) => {
            slow.delete(f.runId);
            settle(res);
          });
          continue;
        }
        settle(first);
      } catch (e) {
        log.warn(`vague-endormie: vague ${f.runId} failed`, e);
      }
    }
    save(deps);
    lastSweepError = '';
  } catch (e) {
    // an unreadable bus fails EVERY pass: say it once per distinct cause, not every 30 s
    const msg = String((e as Error)?.message ?? e);
    if (msg !== lastSweepError) log.warn('vague-endormie: sweep failed — no verdict this pass', e);
    lastSweepError = msg;
  }
  return told;
}

function loadPersisted(deps: VagueDeps): void {
  if (loaded) return;
  loaded = true;
  if (!deps.persist) return;
  try {
    const got = deps.persist.load();
    for (const [runId, p] of Object.entries(got ?? {})) {
      if (!p || typeof p !== 'object') continue;
      const ep = p.episode;
      const okEp = ep && typeof ep.since === 'number' && typeof ep.declaredAt === 'number' && (ep.nudgedAt === undefined || typeof ep.nudgedAt === 'number');
      states.set(runId, { ...(p.everSeen === true ? { everSeen: true } : {}), ...(okEp ? { episode: { since: ep.since, declaredAt: ep.declaredAt, ...(ep.nudgedAt !== undefined ? { nudgedAt: ep.nudgedAt } : {}) } } : {}) });
    }
    lastSaved = JSON.stringify(snapshot());
  } catch (e) {
    log.warn('vague-endormie: persisted state unreadable — starting from nothing', e);
  }
}

function snapshot(): PersistedVagues {
  const out: PersistedVagues = {};
  for (const [runId, st] of states) if (st.everSeen || st.episode) out[runId] = { ...(st.everSeen ? { everSeen: true } : {}), ...(st.episode ? { episode: st.episode } : {}) };
  return out;
}

function save(deps: VagueDeps): void {
  if (!deps.persist) return;
  const snap = snapshot();
  const text = JSON.stringify(snap);
  if (text === lastSaved) return;
  try {
    deps.persist.save(snap);
    lastSaved = text;
  } catch (e) {
    log.warn('vague-endormie: could not persist the state', e);
  }
}

/** A pass that is guaranteed to run: waits for the one in flight, then sweeps. The Admission release re-enters here and must not be dropped. */
export async function sweepVaguesNow(deps: VagueDeps): Promise<string[]> {
  while (sweeping) await (current ?? Promise.resolve([])).catch(() => []).then(() => new Promise<void>((r) => setImmediate(r)));
  return sweepVagues(deps);
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startVagueEndormie(deps: VagueDeps, everyMs: number = VAGUE_SWEEP_MS): void {
  if (timer) return;
  timer = setInterval(() => void sweepVagues(deps), everyMs);
  timer.unref?.();
  void sweepVagues(deps);
}

export function stopVagueEndormie(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function __resetVagueEndormieForTests(): void {
  stopVagueEndormie();
  states.clear();
  views.clear();
  retryAt.clear();
  heldLogged.clear();
  attempts.clear();
  gaveUp.clear();
  loaded = false;
  lastSaved = '';
  slow.clear();
  lastSweepError = '';
  sweeping = false;
  current = null;
  counters.declared = counters.nudged = counters.failed = counters.held = counters.ended = 0;
}
