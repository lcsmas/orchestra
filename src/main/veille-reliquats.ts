// Veille and Reliquats — the per-member verdict (#326, wave H ledger #329; OPS ruling R10; FI-1 v1.3/v1.4). Electron-free and port-injected: node --test drives the real logic over a fake port.
// The sweeper (hibernation.ts) asks `judgeVeille` once per member that is otherwise past the NORMAL Veille threshold:
//   - no port registered (a rig / a test that does not wire Reliquats)  → today's Veille, byte for byte;
//   - a member WITHOUT a coordinator (not a fleet member)                → today's Veille, byte for byte, no census (OPS ruling R11, #326-fu m4: the Reliquat wait is for the fleet);
//   - the census cannot say (`unknown`)                                  → NO Veille this pass (R11, #326-fu m3: UNKNOWN is not NONE — same direction as a stop that could not look; nothing is killed on a guess);
//   - no live Reliquat                                                   → today's Veille at the normal threshold;
//   - live Reliquats, idle shorter than the Reliquat delay               → NO Veille this pass (fast Veille is not delayed: shouldHibernate);
//   - live Reliquats and the delay is over                               → STOP them (`port.stop`: killReliquats / #331 browsers, identity re-read at signal time, fail closed),
//                                                                          tell the member at its next turn (`port.tell`), then Veille. A stop that could not look (`unknown`) defers the Veille.

import { shouldHibernate, type HibernationSignals } from '../shared/hibernation.ts';
import { isFleetMember } from '../shared/admission.ts';
import { veilleHasNews, veilleReliquatNotice } from '../shared/veille-reliquats.ts';
import type { ReliquatReport } from '../shared/pause-reliquats.ts';
import type { Workspace } from '../shared/types.ts';

export interface VeilleReliquatPort {
  /** Live Reliquats of the member NOW (its scope's `reliquat` roles; with no tracked scope, #331's orphaned headless browsers). `'unknown'` = it could not look. */
  census(wsId: string): Promise<number | 'unknown'>;
  /** Stop them. Null = nothing to report (no tracked scope / nothing found). A report with `unknown` / `error` / `aborted` = the stop could not be completed safely.
   *  `ctx.stillWanted()` is re-checked before every signal round: false (the member woke / is being deleted meanwhile) ⇒ the remaining signals are NOT sent. Processes born after the stop BEGAN are the member's new work and are spared. */
  stop(wsId: string, ctx?: { stillWanted(): boolean; stillWantedAfterSignal?(): boolean }): Promise<ReliquatReport | null>;
  /** Queue `text` for the member's next turn WITHOUT waking it (its inbox). False = it could not be queued. */
  tell(wsId: string, text: string): Promise<boolean>;
}

/** Members whose census was UNKNOWN: when it was last said in the log (a stuck keeper under a held Admission is re-judged on EVERY guard sample, ~10 s: one line per member per 5 min, not one per sample). */
const unknownLogged = new Map<string, number>();
const UNKNOWN_LOG_EVERY_MS = 5 * 60_000;
export function __resetVeilleLogGate(): void {
  unknownLogged.clear();
}

export interface JudgeDeps {
  port: VeilleReliquatPort | null;
  /** The Consigne's control-character strip: a command line comes from any process of the member and must never forge a line in its prompt. */
  strip: (s: unknown) => string;
  /** The sweep's « this member is still the one we are putting in Veille » (no wake / delete since the verdict began). Absent = always. */
  stillWanted?: () => boolean;
  /** The member judged AGAIN on FRESH state (status, pending prompts, the activity stamp, the pane, the hold…) with `liveReliquats` Reliquats still to wait for — true = it would still be put in Veille NOW (#326-fu m1). Asked before the first
   *  signal and before every signal round: a prompt handed to an already-live session bumps no wake epoch but stamps activity, and must keep the Reliquats alive. Absent = always. */
  stillEligible?: (liveReliquats: number) => boolean;
  /** Same question once the FIRST signal went out (#326-fu F2, R10): the Admission hold falling because the TERM freed the RAM must not cancel the SIGKILL escalation or the rest of the list — the hold stays what it was when the stop began; a wake / delete / fresh activity still ends it. Absent = `stillEligible`. */
  stillEligibleAfterSignal?: (liveReliquats: number) => boolean;
  info(msg: string): void;
  warn(msg: string, err?: unknown): void;
}

export type VeilleVerdict =
  | { hibernate: false; why: 'not-eligible' }
  /** Past the threshold, but the census could not count the Reliquats (R11): retried at the next sweep. */
  | { hibernate: false; why: 'reliquat-census-unknown' }
  /** Live Reliquats and the Reliquat delay is not over. */
  | { hibernate: false; why: 'reliquat-delay'; liveReliquats: number; waitMs: number }
  /** The stop could not look / complete: retried at the next sweep. */
  | { hibernate: false; why: 'reliquat-stop-incomplete'; liveReliquats: number; detail: string }
  | { hibernate: true; liveReliquats: number; stopped: boolean; report: ReliquatReport | null; told: boolean; fast: boolean };

type Base = Omit<HibernationSignals, 'liveReliquats'>;

export async function judgeVeille(ws: Workspace, signals: Base, deps: JudgeDeps): Promise<VeilleVerdict> {
  // 1. past the NORMAL threshold with every other guard satisfied? (liveReliquats 0 = today's rule) — only those members cost a census
  if (!shouldHibernate(ws, { ...signals, liveReliquats: 0 })) return { hibernate: false, why: 'not-eligible' };
  if (!deps.port || !isFleetMember(ws)) return { hibernate: true, liveReliquats: 0, stopped: false, report: null, told: false, fast: false };

  // 2. the census
  let live: number | 'unknown';
  try {
    live = await deps.port.census(ws.id);
  } catch (e) {
    deps.warn(`veille: Reliquat census of ${ws.name} (${ws.id}) threw — read as UNKNOWN: the Veille is deferred`, e);
    live = 'unknown';
  }
  if (live === 'unknown') {
    const last = unknownLogged.get(ws.id);
    if (last === undefined || signals.now - last >= UNKNOWN_LOG_EVERY_MS) {
      unknownLogged.set(ws.id, signals.now);
      deps.info(`veille: ${ws.name} (${ws.id}) — Reliquats could not be counted; Veille deferred to the next sweep (UNKNOWN is not NONE; nothing is stopped on a guess; said again after 5 min)`);
    }
    return { hibernate: false, why: 'reliquat-census-unknown' };
  }
  unknownLogged.delete(ws.id);
  if (live === 0) return { hibernate: true, liveReliquats: 0, stopped: false, report: null, told: false, fast: false };

  // 3. live Reliquats: the delay applies (not to fast Veille)
  if (!shouldHibernate(ws, { ...signals, liveReliquats: live })) {
    // the wait the rule is applying: the delay minus the SMALLER of the two idle times (a wall-clock jump must not read « <1m to go »)
    const idleNow = Math.min(signals.now - (signals.lastActivityAt ?? signals.now), Number.isFinite(signals.monotonicIdleMs) ? signals.monotonicIdleMs : 0);
    const waitMs = Math.max(0, (signals.reliquatDelayMs || 0) - idleNow);
    return { hibernate: false, why: 'reliquat-delay', liveReliquats: live, waitMs };
  }
  const fast = signals.admissionHeld && !shouldHibernate(ws, { ...signals, admissionHeld: false, liveReliquats: live });
  const idleMs = Math.min(signals.now - (signals.lastActivityAt ?? signals.now), signals.monotonicIdleMs);   // the figure the wait was judged on: the smaller of the two clocks

  // 4. stop them (identity re-read at signal time, fail closed — inside the port), then tell the member. The member is judged AGAIN on fresh state first (m1: the census awaited, and a prompt delivered to a live session
  //    bumps no wake epoch), and the same question is asked before every signal round: a member that was woken meanwhile keeps its Reliquats.
  const wanted = (): boolean => (deps.stillWanted?.() ?? true) && (deps.stillEligible?.(live) ?? true);
  const wantedAfterSignal = (): boolean => (deps.stillWanted?.() ?? true) && (deps.stillEligibleAfterSignal ?? deps.stillEligible)?.(live) !== false;
  if (!wanted()) {
    deps.info(`veille: ${ws.name} (${ws.id}) is no longer eligible (woken, a prompt, a status change) — its Reliquats are NOT stopped`);
    return { hibernate: false, why: 'not-eligible' };
  }
  let report: ReliquatReport | null;
  try {
    report = await deps.port.stop(ws.id, { stillWanted: wanted, stillWantedAfterSignal: wantedAfterSignal });
  } catch (e) {
    deps.warn(`veille: stopping the Reliquats of ${ws.name} (${ws.id}) threw`, e);
    return { hibernate: false, why: 'reliquat-stop-incomplete', liveReliquats: live, detail: e instanceof Error ? e.message : String(e) };
  }
  // A scope-less member's browser pass answers `null` both for « nothing to stop » and for « stopped by the wake check before it began »: a member no longer wanted is NOT « stopped » — the Veille waits.
  if (report === null && !wanted()) {
    deps.info(`veille: ${ws.name} (${ws.id}) is no longer eligible after its Reliquat stop returned nothing — the Veille is deferred`);
    return { hibernate: false, why: 'not-eligible' };
  }
  if (report && (report.unknown || report.error || report.aborted)) {
    // UNKNOWN is not NONE: the scope could not be read / the identity could not be proven / the member woke mid-stop — the Veille waits for the next sweep. What WAS stopped (if anything) is still told.
    const detail = String(report.unknown ?? report.error ?? `stop aborted (${report.aborted})`);
    let told = false;
    if (veilleHasNews(report)) told = await tellOnce(ws, report, { fast, idleMs }, deps);
    deps.info(`veille: ${ws.name} (${ws.id}) — Reliquat stop incomplete (${detail}); Veille retried at the next sweep${told ? ' (the member was told what WAS stopped)' : ''}`);
    return { hibernate: false, why: 'reliquat-stop-incomplete', liveReliquats: live, detail };
  }
  const told = veilleHasNews(report) ? await tellOnce(ws, report, { fast, idleMs }, deps) : false;
  return { hibernate: true, liveReliquats: live, stopped: true, report, told, fast };
}

async function tellOnce(ws: Workspace, report: ReliquatReport, ctx: { fast: boolean; idleMs: number }, deps: JudgeDeps): Promise<boolean> {
  const text = veilleReliquatNotice(report, ctx, deps.strip);
  if (!text || !deps.port) return false;
  try {
    const ok = await deps.port.tell(ws.id, text);
    if (!ok) deps.warn(`veille: the Reliquat notice of ${ws.name} (${ws.id}) could not be queued — the member is not told`);
    return ok;
  } catch (e) {
    deps.warn(`veille: the Reliquat notice of ${ws.name} (${ws.id}) threw`, e);
    return false;
  }
}
