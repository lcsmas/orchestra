// Vague endormie (#428, spec #426) — the effectful half: a level-triggered sweep that reads each vague's facts, folds them through the pure `stepVague` (shared/vague-endormie.ts) and, on the
// FIRST pass of an asleep episode, hands the COORDINATOR one Relance (shared/relance.ts `buildRelance`, the #427 primitive) through the same delivery a Réveil / a member's Relance takes — so a
// coordinator in Veille is brought back, Admission holds the start under low memory, a Pause refuses it. It does not touch the bus and acks nothing. A coordinator WITHOUT a parent (the human's conversation) is never sent one: the vague is still declared and shown. What survives a restart (`deps.persist`): per run `everSeen` + the open episode.
//
// Everything it reads is injected (roster, census, clock, delivery): `vague-endormie-host.ts` wires the store, the kernel-scope census and `sdkStartAndDeliver`; node --test and the
// session-budget rig drive this file as it ships. Not started ⇒ no coordinator ever gets a turn from it (the control arm of the rig).
// The HUMAN step (#429, shared/vague-human.ts): once an episode is due (15 min after the Relance, or at the declaration for a parentless coordinator) the sweep fires ONE notification, persists `humanAt`, and publishes the
// marks the sidebar draws; the mark ends with the episode. Relancer (`relanceVagueNow`) nudges the coordinator again — never a coordinator without a parent (nothing is ever sent to the LEAD's conversation).

import { log } from './logger.ts';
import { RELANCE_RETRY_MS, type RelanceDelivery } from './relance.ts';
import type { RelanceCensus } from '../shared/relance.ts';
import { buildVagueAsleepRelance, DEFAULT_VAGUE_BOUNDS, episodeEnd, processLines, stepVague, type AsleepVagueView, type VagueBounds, type VagueCensus, type VagueEpisode, type VagueFacts, type VagueState } from '../shared/vague-endormie.ts';
import { humanStepDue, marksKey, VAGUE_HUMAN_MS, type VagueMark } from '../shared/vague-human.ts';

/** How often the sweep looks. The delay is minutes; the census is read only for a vague with nothing else holding it awake. */
export const VAGUE_SWEEP_MS = 30_000;
/** One delivery (a session start) may take this long before the sweep moves on; its result is still applied when it lands. */
export const VAGUE_DELIVER_WAIT_MS = 20_000;
/** A failed delivery is retried with a doubling back-off (RELANCE_RETRY_MS, ×2, …) capped here — never a terminal state: an outage of minutes must not silence the alarm for good. */
export const VAGUE_MAX_BACKOFF_MS = 10 * 60_000;

/** What survives a restart, per run: was it ever observed active, when it last fell quiet (the true « since »), and its open episode (with whether / when the coordinator was told). */
export type PersistedVagues = Record<string, { everSeen?: boolean; quietHint?: number; episode?: VagueEpisode }>;
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
  /** Start / resume the coordinator's session and deliver `text` as its next turn (`held` = Admission holds the start: nothing is lost, `retry` — absent = a sweep pass — is called when memory recovers). */
  deliver(coordinatorId: string, text: string, retry?: () => Promise<unknown>): Promise<RelanceDelivery>;
  /** The delays, read per pass (#429: the two settings — `quietMs` = asleep after, `humanMs` = tell the human after the Relance; the hour is a constant). Absent = the spec's 10 min / 15 min / 1 h. */
  bounds?(): Partial<VagueBounds> & { humanMs?: number };
  /** The desktop notification (#429), called ONCE per episode when the human step is due (`humanAt` is persisted before the call: at most once across a crash). Absent = no notification. */
  notifyHuman?(n: { coordinatorId: string; coordinator: string; since: number; pending: number }): void;
  /** The marks the sidebar draws, whenever the set CHANGES (a mark appears, an episode ends, the pending count moves). The host stamps and pushes it. */
  onMarks?(marks: VagueMark[]): void;
  /** Persistence across a restart (absent = memory only). */
  persist?: VagueStore;
  /** The roster can be trusted (the store was loaded from disk). Absent = trusted. When it says no, the pass judges nobody and touches nothing — an empty fallback roster would otherwise prune and erase the persisted state. */
  rosterTrusted?(): boolean;
  deliverWaitMs?: number;
}

export interface VagueCounters {
  /** Episodes declared. */
  declared: number;
  /** The human was told (one notification per episode). */
  humanTold: number;
  /** Coordinators told (one per episode). */
  nudged: number;
  failed: number;
  held: number;
  /** Episodes ended (a member resumed, the work finished, a Pause). */
  ended: number;
}
const counters: VagueCounters = { declared: 0, humanTold: 0, nudged: 0, failed: 0, held: 0, ended: 0 };
export const vagueCounters = (): VagueCounters => ({ ...counters });

const states = new Map<string, VagueState>();
const views = new Map<string, AsleepVagueView>();
const retryAt = new Map<string, number>();
const heldLogged = new Set<string>();
const attempts = new Map<string, number>();
let loaded = false;
let untrustedLogged = false;
let lastSaved = '';
/** Runs whose delivery is still pending past the wait: not touched again until it lands (a second turn for the same episode would be a duplicate). */
const slow = new Set<string>();
/** Runs with a Relance delivery in flight, whoever started it (the sweep or the Relancer): ONE per vague, a second turn for the same episode would be a duplicate. */
const inflight = new Set<string>();
let lastSweepError = '';
let sweeping = false;
let current: Promise<string[]> | null = null;

let lastMarksKey = '';

/** The vagues asleep right now (an open episode), oldest first. */
export function asleepVagues(): AsleepVagueView[] {
  return [...views.values()].sort((a, b) => a.since - b.since);
}

/** The marks to draw: the asleep vagues whose human step has fired (`humanAt`), oldest first. The coordinator row carries the mark; the Relancer button exists only where a Relance can go (not to a coordinator without a parent). */
export function asleepMarks(): VagueMark[] {
  return asleepVagues()
    .filter((v) => v.humanAt !== null)
    .map((v) => ({ runId: v.runId, coordinatorId: v.coordinatorId, coordinator: v.coordinator, since: v.since, pending: v.unfinished.length, memberIds: v.memberIds, canRelance: v.canNudge, relancing: inflight.has(v.runId) }));
}

/** Tell the host the marks changed (only when they did). */
function publishMarks(deps: VagueDeps): void {
  const marks = asleepMarks();
  const key = marksKey(marks);
  if (key === lastMarksKey) return;
  lastMarksKey = key;
  try {
    deps.onMarks?.(marks);
  } catch (e) {
    log.warn('vague-endormie: publishing the marks failed', e);
  }
}

/** The episode of `runId` is over (a member resumed, the work finished, a Pause): forget it and its marks. Shared by the normal pass and by a vague frozen on a hung delivery. */
function endEpisode(runId: string, prev: VagueState | undefined, now: number, why: string): void {
  if (!prev?.episode) return;
  states.set(runId, { ...(prev.everSeen ? { everSeen: true } : {}), protectedAt: now, blockedAt: now });
  counters.ended++;
  views.delete(runId);
  retryAt.delete(runId);
  heldLogged.delete(runId);
  attempts.delete(runId);
  log.info(`vague-endormie: ${runId} is awake again (${why}) — the asleep episode since ${new Date(prev.episode.since).toISOString()} is over`);
}

/**
 * The HUMAN step (#429) for one open episode: due ⇒ ONE notification per episode, `humanAt` persisted BEFORE it (at most once across a crash); from then on the mark is up until the episode ends.
 * It only reads the episode and the view — never sends anything to anyone.
 */
function humanStep(deps: VagueDeps, runId: string, nudge: 'owed' | 'done' | 'no-parent' | 'not-wakeable', now: number, humanMs: number): void {
  const st = states.get(runId);
  const view = views.get(runId);
  if (!st?.episode || !view || st.episode.humanAt !== undefined || !humanStepDue(st.episode, nudge, now, humanMs)) return;
  // The notification is the one effect that cannot be taken back, and this pass's snapshot can be old (a delivery earlier in the pass waited up to 20 s): re-read the vague right before it.
  // A member that resumed meanwhile ends the episode on the next pass — the human is not told about a sleep that is already over.
  try {
    const fresh = deps.vague?.(runId);
    if (fresh && episodeEnd(fresh, st.episode)) return;
  } catch (e) {
    log.warn(`vague-endormie: fresh read before telling the human failed for ${runId} — judged on the pass's snapshot`, e);
  }
  states.set(runId, { ...st, episode: { ...st.episode, humanAt: now } });
  views.set(runId, { ...view, humanAt: now });
  save(deps);
  counters.humanTold++;
  log.info(`vague-endormie: the human is told — vague ${runId} (${view.coordinatorId}) asleep since ${new Date(view.since).toISOString()}, ${view.unfinished.length} unfinished task(s)`);
  try {
    deps.notifyHuman?.({ coordinatorId: view.coordinatorId, coordinator: view.coordinator, since: view.since, pending: view.unfinished.length });
  } catch (e) {
    log.warn('vague-endormie: the notification failed (the mark is up anyway)', e);
  }
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
    const { humanMs: humanMsRead, ...boundsRead } = deps.bounds?.() ?? {};
    const bounds: VagueBounds = { ...DEFAULT_VAGUE_BOUNDS, ...boundsRead };
    const humanMs = humanMsRead ?? VAGUE_HUMAN_MS;
    if (deps.rosterTrusted && !deps.rosterTrusted()) {
      if (!untrustedLogged) log.warn('vague-endormie: the store was not loaded from disk — judging nobody and touching no persisted state this pass');
      untrustedLogged = true;
      return told;
    }
    untrustedLogged = false;
    loadPersisted(deps, now, bounds.quietMs);
    const all = deps.vagues();
    const live = new Set(all.map((f) => f.runId));
    for (const id of [...states.keys()]) {
      if (live.has(id)) continue;
      states.delete(id);
      views.delete(id);
      retryAt.delete(id);
      heldLogged.delete(id);
      attempts.delete(id);
    }
    for (const f of all) {
      try {
        if (slow.has(f.runId)) {
          // its delivery has not landed yet: nothing new is declared, but (1) a member that resumed / a finished wave still ends the episode — the mark must not outlive it while a start hangs —
          // and (2) a Relance that hangs leaves the vague asleep: the human step runs on what is already known
          const open = states.get(f.runId)?.episode;
          if (open && episodeEnd(f, open)) {
            endEpisode(f.runId, states.get(f.runId), now, episodeEnd(f, open)!);
            continue;
          }
          const sv = views.get(f.runId);
          if (sv) humanStep(deps, f.runId, sv.relance === 'no-parent' ? 'no-parent' : sv.relance === 'not-wakeable' ? 'not-wakeable' : states.get(f.runId)?.episode?.nudgedAt !== undefined ? 'done' : 'owed', now, humanMs);
          continue;
        }
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
        const stepped = stepVague(prev, f, census, now, bounds);
        const verdict = stepped.verdict;
        let state = stepped.state;
        states.set(f.runId, state);
        if (verdict.kind === 'awake') {
          if (prev?.episode) {
            counters.ended++;
            views.delete(f.runId);
            retryAt.delete(f.runId);
            heldLogged.delete(f.runId);
            attempts.delete(f.runId);
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
          relance: verdict.nudge === 'no-parent' ? 'no-parent' : verdict.nudge === 'not-wakeable' ? 'not-wakeable' : state.episode?.nudgedAt !== undefined ? 'sent' : 'owed',
          unfinished: verdict.unfinished.map((m) => ({ wsId: m.wsId, label: m.label })),
          memberIds: f.members.map((m) => m.wsId),
          humanAt: state.episode?.humanAt ?? null,
          canNudge: f.coordinatorHasParent && f.coordinatorWakeable,
        };
        views.set(f.runId, view);
        humanStep(deps, f.runId, verdict.nudge, now, humanMs); // #429
        state = states.get(f.runId) ?? state; // it may have recorded `humanAt`: the delivery below must not overwrite it
        if (verdict.declared) {
          counters.declared++;
          log.info(`vague-endormie: ${f.runId} is ASLEEP since ${new Date(verdict.since).toISOString()} — ${verdict.unfinished.length} unfinished task(s), ${verdict.processes.length} live process(es); coordinator ${f.coordinator.wsId} to be told`);
        }
        if (verdict.nudge === 'not-wakeable') {
          // wakeability is back ⇒ the next try is at once, whatever the back-off had grown to
          attempts.delete(f.runId);
          retryAt.delete(f.runId);
        }
        if (verdict.nudge !== 'owed' || (retryAt.get(f.runId) ?? 0) > now || inflight.has(f.runId)) continue;
        // Judge the coordinator on FRESH state right before it is told: a turn it started since the pass's snapshot makes the Relance pointless (it is reading the world).
        const fresh = deps.vague?.(f.runId) ?? f;
        if (fresh.coordinator.active || fresh.coordinator.waiting || fresh.paused || fresh.runHeld || !fresh.coordinatorWakeable || !fresh.coordinatorHasParent) continue;
        const text = buildVagueAsleepRelance(fresh, verdict.since, verdict.unfinished, verdict.processes, bounds.processMs);
        // Mark BEFORE the await (a second pass cannot send it again); undone below if the turn did not go out.
        const episode = state.episode!;
        states.set(f.runId, { ...state, episode: { ...episode, nudgedAt: now } });
        save(deps); // at most once across a crash: what was marked is not sent again
        inflight.add(f.runId);
        publishMarks(deps); // the Relancer is disabled while this delivery is in flight
        const delivery: Promise<RelanceDelivery> = (async () => deps.deliver(f.coordinator.wsId, text))()
          .catch((e: unknown) => {
            log.warn(`vague-endormie: delivery to ${f.coordinator.wsId} threw`, e);
            return 'failed' as const;
          })
          .finally(() => {
            inflight.delete(f.runId);
            publishMarks(deps);
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
            const wait = Math.min(RELANCE_RETRY_MS * 2 ** Math.min(n - 1, 10), VAGUE_MAX_BACKOFF_MS);
            retryAt.set(f.runId, deps.now() + wait);
            log.warn(`vague-endormie: could not deliver the Relance to ${f.coordinator.wsId} (attempt ${n}); retrying in ${wait / 1000}s`);
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
    publishMarks(deps);
    lastSweepError = '';
  } catch (e) {
    // an unreadable bus fails EVERY pass: say it once per distinct cause, not every 30 s
    const msg = String((e as Error)?.message ?? e);
    if (msg !== lastSweepError) log.warn('vague-endormie: sweep failed — no verdict this pass', e);
    lastSweepError = msg;
  }
  return told;
}

function loadPersisted(deps: VagueDeps, now: number, quietMs: number): void {
  if (loaded) return;
  loaded = true;
  if (!deps.persist) return;
  try {
    const got = deps.persist.load();
    for (const [runId, p] of Object.entries(got ?? {})) {
      if (!p || typeof p !== 'object') continue;
      const ep = p.episode;
      const okEp = ep && typeof ep.since === 'number' && typeof ep.declaredAt === 'number' && (ep.nudgedAt === undefined || typeof ep.nudgedAt === 'number') && (ep.humanAt === undefined || typeof ep.humanAt === 'number');
      const hint = typeof p.quietHint === 'number' && Number.isFinite(p.quietHint) ? p.quietHint : undefined;
      // a persisted vague is not judged before the launch has settled for one delay (the roster, the keepers, the clocks)
      states.set(runId, { ...(p.everSeen === true ? { everSeen: true } : {}), ...(hint !== undefined ? { quietHint: hint, notBefore: now + quietMs } : {}), ...(okEp ? { episode: { since: ep.since, declaredAt: ep.declaredAt, ...(ep.nudgedAt !== undefined ? { nudgedAt: ep.nudgedAt } : {}), ...(ep.humanAt !== undefined ? { humanAt: ep.humanAt } : {}) } } : {}) });
    }
    lastSaved = JSON.stringify(snapshot());
  } catch (e) {
    log.warn('vague-endormie: persisted state unreadable — starting from nothing', e);
  }
}

function snapshot(): PersistedVagues {
  const out: PersistedVagues = {};
  for (const [runId, st] of states) if (st.everSeen || st.episode) out[runId] = { ...(st.everSeen ? { everSeen: true } : {}), ...(st.quietHint !== undefined && !st.episode ? { quietHint: st.quietHint } : {}), ...(st.episode ? { episode: st.episode } : {}) };
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

/** What the Relancer button answers: `sent` · `held` (Admission holds the start for memory — nothing was sent) · `pending` (the start has not landed within the wait: it may still) · `failed` · `no-parent` (the coordinator is the human's conversation: NOTHING is ever sent there) · `not-wakeable` · `not-asleep` (the episode ended meanwhile). */
export type RelanceNowResult = RelanceDelivery | 'pending' | 'no-parent' | 'not-wakeable' | 'not-asleep';

/**
 * Relancer (#429): the human nudges the coordinator of an asleep vague AGAIN, from its row. Same text and delivery as the automatic Relance, judged on fresh facts; refuses a coordinator without a parent
 * (its conversation is the human's — nothing is sent there, by the spec) and a vague that is no longer asleep. Does not end the episode (only a member resuming does) and does not restart the human delay.
 */
export async function relanceVagueNow(deps: VagueDeps, runId: string): Promise<RelanceNowResult> {
  const view = views.get(runId);
  const st = states.get(runId);
  if (!view || !st?.episode) return 'not-asleep';
  let fresh: VagueFacts | undefined;
  try {
    fresh = deps.vague?.(runId);
  } catch (e) {
    log.warn(`vague-endormie: relancer — facts of ${runId} unreadable`, e);
    return 'failed';
  }
  if (!fresh) return 'not-asleep';
  if (!fresh.coordinatorHasParent) return 'no-parent';
  if (fresh.paused || fresh.runHeld) return 'not-asleep'; // a Pause / a hold is not a sleep: the next pass ends the episode, no turn is pushed into a parked fleet
  if (inflight.has(runId)) return 'pending'; // a Relance of this vague is still in flight (the sweep's or an earlier click): a second turn would be a duplicate
  if (!fresh.coordinatorWakeable) return 'not-wakeable';
  const unfinished = fresh.members.filter((m) => m.unfinished);
  if (unfinished.length === 0) return 'not-asleep';
  const census = (): VagueCensus => {
    const m = new Map<string, RelanceCensus>();
    for (const p of [fresh.coordinator, ...fresh.members]) {
      try {
        m.set(p.wsId, deps.census(p.wsId));
      } catch {
        m.set(p.wsId, 'unknown');
      }
    }
    return m;
  };
  const processMs = { ...DEFAULT_VAGUE_BOUNDS, ...(deps.bounds?.() ?? {}) }.processMs;
  const text = buildVagueAsleepRelance(fresh, view.since, unfinished, processLines(fresh, census()), processMs);
  const declaredAt = st.episode.declaredAt;
  // `held` (Admission, low memory): the Relancer's OWN retry — a sweep pass would see the Relance already sent and deliver nothing, silently dropping the click
  inflight.add(runId);
  publishMarks(deps);
  const delivery: Promise<RelanceDelivery> = (async () => deps.deliver(fresh.coordinator.wsId, text, () => relanceVagueNow(deps, runId)))()
    .catch((e: unknown) => {
      log.warn(`vague-endormie: relancer — delivery to ${fresh.coordinator.wsId} threw`, e);
      return 'failed' as const;
    })
    .finally(() => {
      inflight.delete(runId);
      publishMarks(deps);
    });
  const landed = (result: RelanceDelivery): void => {
    if (result !== 'sent') return;
    log.info(`vague-endormie: coordinator ${fresh.coordinator.wsId} relanced by the human (Relancer) — vague ${runId}`);
    const cur = states.get(runId);
    // an automatic Relance still owed is now moot: this one went out
    // the SAME episode only: a late result must not stamp a newer one (its human delay and its own Relance would be wrong)
    if (cur?.episode && cur.episode.declaredAt === declaredAt && cur.episode.nudgedAt === undefined) {
      states.set(runId, { ...cur, episode: { ...cur.episode, nudgedAt: deps.now() } });
      const v = views.get(runId);
      if (v) views.set(runId, { ...v, nudgedAt: deps.now(), relance: 'sent' });
      save(deps);
      publishMarks(deps);
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const first = await Promise.race([delivery, new Promise<'pending'>((r) => { timer = setTimeout(() => r('pending'), deps.deliverWaitMs ?? VAGUE_DELIVER_WAIT_MS); })]);
  clearTimeout(timer);
  if (first === 'pending') {
    // a start that hangs: the button gets its answer now; the late result is still applied
    void delivery.then(landed);
    return 'pending';
  }
  landed(first);
  return first;
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
  untrustedLogged = false;
  loaded = false;
  lastSaved = '';
  slow.clear();
  inflight.clear();
  lastSweepError = '';
  sweeping = false;
  current = null;
  counters.declared = counters.humanTold = counters.nudged = counters.failed = counters.held = counters.ended = 0;
  lastMarksKey = '';
}
