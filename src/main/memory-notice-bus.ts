// #322: the ONE function that writes the Plafond mémoire's message to the coordinator - the app (index.ts) and the rig both call THIS, so the rig drives the shipped gate.
// The write follows the run's frozen `liveness` switch like the boot-wedge escalation (#197) and the liveness sweep: OFF => "counted, not fired" (the coexistence-safe default).

import { send, type BusDb } from './bus.ts';
import { busSwitch, getRun } from './bus-runs.ts';
import type { BusSendInput } from './memory-notice.ts';

export function sendGated(db: BusDb, m: BusSendInput, log: { warn(msg: string, e?: unknown): void }): 'sent' | 'counted' {
  let on = false;
  try {
    on = busSwitch(db, m.runId, 'liveness');
  } catch (e) {
    log.warn(`memory-notice: liveness switch read failed for run ${m.runId} - treating as OFF`, e);
  }
  if (!on) return 'counted';
  // The coordinator's `check` is own-run only: a run whose coordinator is not the recipient (a parent that is not an orchestrator) is unread mail - said, not hidden.
  const coordinator = getRun(db, m.runId)?.coordinator ?? null;
  if (coordinator !== m.recipient) log.warn(`memory-notice: run ${m.runId} has coordinator ${coordinator ?? '(no run row)'}, not ${m.recipient} - this message may never be read`);
  send(db, m);
  return 'sent';
}
