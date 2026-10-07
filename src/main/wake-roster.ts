// The bus wake sweep's per-workspace roster entry (#117), lifted out of index.ts so the REAL predicate
// can be driven by a rig (index.ts cannot load under node --test). Wired: index.ts `setWakeRoster`.

import type { Workspace } from '../shared/types';
import type { WakeableReader } from './bus-wake.ts';
import { sdkSessionLive } from './sdk-delivery';
import { isRunning } from './pty';
import { canOrchestrate } from '../shared/types';
import { sandboxPausedMessage } from '../shared/sandbox-pause.ts';
import { startKeepsFailing } from '../shared/opening-task.ts';
import { pauseRefusal } from './pause-gate.ts';
import { resolveWaveRunId } from './workspaces';

export function wakeRosterEntry(ws: Workspace): WakeableReader {
  return {
    reader: ws.id,
    // An archived workspace's session is a frozen leftover; waking it would
    // resurrect a workspace the human retired. `ws.archived` is the flag the
    // #90 watchdog gates on too (session-watchdog.ts:233).
    // #226: a paused sandbox agent cannot be woken — not-wakeable, or the sweep re-fires (60 s + every WAL write) at a start that always refuses.
    // #252 fleet PAUSE (ledger #261 row 14): a paused run's reader is not-wakeable, or the sweep re-fires at a start that always refuses.
    wakeable:
      !ws.archived &&
      !!ws.worktreePath &&
      sandboxPausedMessage(ws) === null &&
      pauseRefusal(ws, 'auto') === null &&
      !startKeepsFailing(ws, sdkSessionLive(ws.id)),
    // #134 — the WAVE run this reader belongs to (its tree anchor), the SAME
    // id `$ORCHESTRA_RUN_ID` plumbs into the member's CLI, so the host looks
    // for a reader's pending mail in the run the CLI actually wrote it to. Was
    // hardcoded `'default'` (the CLI's pre-#134 fallback), which — now that
    // members send under their wave run id — would have the sweep read an
    // empty `default` run and never wake anyone. A root anchor resolves to
    // itself; a member resolves to its anchor (walkToRootId).
    runId: resolveWaveRunId(ws),
    // #287 Admission: what the sweep needs to decide whether a due réveil is an automatic START of a SLEEPING FLEET member (held under low memory).
    fleetMember: !!ws.parentId,
    sleeping: !isRunning(ws.id) && !sdkSessionLive(ws.id),
    coordinator: canOrchestrate(ws),
  };
}
