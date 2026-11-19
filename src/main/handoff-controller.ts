// #466 — the handoff state machine with its collaborators INJECTED (no store, no Electron): schedule on `/handoff`, run at a free turn end,
// nudge once at the bound. handoff-host.ts supplies the real deps; handoff-controller.test.ts drives it with fakes (incl. the must-FAIL arms).

import {
  HANDOFF_ERRORS, HANDOFF_PENDING_TTL_MS, composeDroppedNotice, HandoffTurnCounter, composeNudge, composeOpeningTurn, decideHandoffRun, handoffSummaryError, validateHandoffSummary,
} from '../shared/handoff.ts';
import type { TurnEndInfo } from './handoff-seam.ts';

export type HandoffReply = { ok: true; scheduled: true; file: string; note: string } | { ok: false; error: string };

export interface HandoffDeps {
  now(): number;
  /** The live session key of `id` matches. */
  vouched(id: string, key: string): boolean;
  /** The workspace exists and is not archived. */
  workspaceLive(id: string): boolean;
  /** null = the workspace is in an OPEN run; else the named refusal. */
  runRefusal(id: string): string | null;
  /** A sandbox / fleet-Pause reason the workspace may not be restarted or nudged now, or null. */
  blocked(id: string): string | null;
  /** The SDK session id of the context that is running now (undefined = unknown). A handoff scheduled on one context is DROPPED if another is running at the turn end. */
  sessionOf(id: string): string | undefined;
  /** Persist the summary; returns its path (throws ⇒ refused, nothing scheduled). */
  saveSummary(id: string, summary: string): string;
  /** The bound in turns (0 = off), read at each turn end. */
  bound(): number;
  /** Is a turn of the workspace running RIGHT NOW? false ⇒ nothing will end soon, so an accepted handoff runs at once (not at some unrelated later turn end). */
  turnInFlight(id: string): boolean;
  /** m1: write the owed-opening marker (BEFORE the context is ended). Throws ⇒ nothing is ended. */
  owe(id: string, opening: string, file: string, at: number): void;
  /** m1: drop the marker (the context was not ended after all). Delivered openings are cleared by the host's delivery itself. */
  settle(id: string): void;
  /** End the context (restart --fresh's path + the stale-run clear). Throws on failure ⇒ the old context is kept. */
  endContext(id: string): Promise<void>;
  /** m4: tell the agent something about its own handoff (queued as a turn). */
  sendNotice(id: string, text: string): Promise<void>;
  /** Deliver the opening turn to the fresh session (Admission-aware). */
  deliverOpening(id: string, text: string): Promise<'sent' | 'held' | 'failed'>;
  /** Queue the nudge as the member's next turn. */
  sendNudge(id: string, text: string): Promise<void>;
  report(id: string, text: string): void;
  log: { info(m: string): void; warn(m: string, e?: unknown): void; error(m: string, e?: unknown): void };
}

interface Pending { summary: string; file: string; at: number; session?: string }

export function createHandoffController(deps: HandoffDeps) {
  const pending = new Map<string, Pending>();
  const counter = new HandoffTurnCounter();

  function dispatch(msg: Record<string, unknown>): HandoffReply {
    const id = typeof msg.id === 'string' ? msg.id.trim() : '';
    const key = typeof msg.key === 'string' ? msg.key.trim() : '';
    if (!id || !key || !deps.vouched(id, key)) return { ok: false, error: HANDOFF_ERRORS.unvouched() };
    if (!deps.workspaceLive(id)) return { ok: false, error: HANDOFF_ERRORS.outsideRun(id) };
    const refused = deps.runRefusal(id);
    if (refused) return { ok: false, error: refused };
    const blocked = deps.blocked(id);
    if (blocked) return { ok: false, error: HANDOFF_ERRORS.unavailable(blocked) };
    const verdict = validateHandoffSummary(msg.summary);
    if (!verdict.ok) return { ok: false, error: handoffSummaryError(verdict.problems) };
    const prior = pending.get(id);
    // A pending handoff that can no longer run (expired, or its context is gone) must not block the agent's retry.
    if (prior && deps.now() - prior.at <= HANDOFF_PENDING_TTL_MS && (!prior.session || prior.session === deps.sessionOf(id))) return { ok: false, error: HANDOFF_ERRORS.pending() };
    const summary = String(msg.summary);
    let file: string;
    try {
      file = deps.saveSummary(id, summary);
    } catch (e) {
      return { ok: false, error: HANDOFF_ERRORS.unavailable(`the summary could not be saved: ${e instanceof Error ? e.message : String(e)}`) };
    }
    const entry: Pending = { summary, file, at: deps.now(), session: deps.sessionOf(id) };
    if (!deps.turnInFlight(id)) {
      // No turn is running (a dispatch from a background script after the caller's turn ended): "the next turn end" would be some UNRELATED turn — run now.
      deps.log.info(`handoff: ${id} is idle — running at once (summary ${summary.length} chars, saved ${file})`);
      void run(id, entry).catch((e) => deps.log.error(`handoff: ${id} failed`, e));
      return { ok: true, scheduled: true, file, note: 'handoff running now (no turn is in flight) — the fresh context opens with your summary in a moment.' };
    }
    pending.set(id, entry);
    deps.log.info(`handoff: scheduled for ${id} (summary ${summary.length} chars, saved ${file}) — runs at the turn end`);
    return {
      ok: true, scheduled: true, file,
      note: 'handoff scheduled — end your turn now. The host ends this context at the turn end and opens a fresh one with your summary as its first turn.',
    };
  }

  async function run(id: string, p: Pending): Promise<void> {
    const turns = counter.turnsOf(id);
    const opening = composeOpeningTurn({ summary: p.summary, turns, savedAt: new Date(p.at).toISOString(), file: p.file });
    try {
      deps.owe(id, opening, p.file, p.at); // durable BEFORE the clear: from here the summary survives an app quit / a failed or held start
    } catch (e) {
      deps.log.error(`handoff: the owed marker of ${id} could not be written — nothing was ended`, e);
      deps.report(id, `handoff: not run — the owed-opening marker could not be written (${e instanceof Error ? e.message : String(e)}); context kept, summary saved at ${p.file}`);
      return;
    }
    try {
      await deps.endContext(id);
    } catch (e) {
      deps.settle(id);
      deps.log.error(`handoff: ending the context of ${id} failed — nothing was delivered`, e);
      deps.report(id, `handoff: ending the context failed (${e instanceof Error ? e.message : String(e)}) — still on the old context; summary saved at ${p.file}`);
      return;
    }
    counter.forget(id);
    deps.log.info(`handoff: ${id} context ended after ${turns} turns — delivering the summary as the opening turn`);
    const r = await deps.deliverOpening(id, opening);
    if (r === 'failed') deps.report(id, `handoff: the context was ended but the opening turn could not be delivered — it stays owed and is retried; the summary is saved at ${p.file}`);
  }

  /** A turn of `info.wsId` just ended. Returns the handoff run it started (tests await it), if any. */
  function onTurnEnd(info: TurnEndInfo): Promise<void> | undefined {
    const { wsId } = info;
    const bound = deps.bound();
    const tally = counter.noteTurnEnd(wsId, info.sessionId, bound);
    const p = pending.get(wsId);
    if (p) {
      const live = deps.workspaceLive(wsId);
      const verdict = decideHandoffRun({ queueLen: info.queueLen, paused: deps.blocked(wsId) !== null, ageMs: deps.now() - p.at });
      const otherContext = !!p.session && !!info.sessionId && p.session !== info.sessionId; // /clear, restart --fresh, hibernate+resume under another id…
      if (verdict === 'expired' || !live || otherContext) {
        pending.delete(wsId);
        const why = !live ? 'workspace gone' : otherContext ? 'its context already ended another way' : 'it did not reach a free turn end within 10 minutes';
        deps.log.warn(`handoff: scheduled handoff of ${wsId} dropped (${why}) — context kept`);
        if (live) void deps.sendNotice(wsId, composeDroppedNotice(why)).catch((e) => deps.log.warn(`handoff: drop notice to ${wsId} failed`, e));
        return undefined;
      }
      if (verdict === 'run') {
        pending.delete(wsId);
        return run(wsId, p).catch((e) => deps.log.error(`handoff: ${wsId} failed`, e));
      }
      return undefined; // 'wait': a nudge on top of a scheduled handoff would be noise
    }
    if (!tally.nudge || !deps.workspaceLive(wsId) || deps.blocked(wsId) !== null) return undefined;
    deps.log.info(`handoff: nudging ${wsId} — ${tally.turns} turns, bound ${bound}`);
    // The latch is taken only when the send was ACCEPTED: a failed send leaves the nudge owed for the next turn end.
    void deps.sendNudge(wsId, composeNudge(tally.turns, bound)).then(() => counter.markNudged(wsId)).catch((e) => deps.log.warn(`handoff: nudge to ${wsId} failed`, e));
    return undefined;
  }

  return { dispatch, onTurnEnd, pendingFor: (id: string) => pending.has(id), turnsOf: (id: string) => counter.turnsOf(id) };
}
