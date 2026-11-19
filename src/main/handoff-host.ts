// #466 — `orchestra handoff` + the bound nudge: production wiring of handoff-controller.ts (logic: src/shared/handoff.ts).
// `/handoff {id,key,summary}` validates the summary, refuses a caller outside an OPEN run, saves the summary, and SCHEDULES the handoff: the
// caller's own turn is still running (it is inside the tool call), so the host ends the context AT THE TURN END (handoff-seam.ts), with nothing
// queued behind it — `sdkRestart({fresh})` (restart --fresh's path: coordinator generation bumped, session cleared, worktree/branch/commits
// untouched) — then delivers the summary as the fresh session's opening turn through the Relance's delivery (Admission-held under low memory).
// The nudge: the first turn end at/past ORCHESTRA_HANDOFF_BOUND_TURNS sends the member ONE turn telling it to hand off. Never an auto-kill.
// Not importable under plain node --test (store / platform seam): handoff-wiring.test.ts pins it by source; the logic runs in handoff-controller.test.ts.

import fs from 'node:fs';
import path from 'node:path';
import { store } from './store';
import { log } from './logger';
import { getBus } from './bus.ts';
import { getRun } from './bus-runs.ts';
import { orchestraHome } from './platform/index.ts';
import { sessionKeys } from './session-identity-host.ts';
import { reportAdmissionFailure, resolveWaveRunId } from './workspaces';
import { pauseRefusal } from './pause-gate';
import { sdkRestart } from './agent-sdk';
import { sdkDeliver } from './sdk-delivery';
import { deliverRelance } from './relance-host.ts';
import { setTurnEndListener } from './handoff-seam.ts';
import { createHandoffController, type HandoffReply } from './handoff-controller.ts';
import { sandboxPausedMessage } from '../shared/sandbox-pause.ts';
import { HANDOFF_ERRORS, parseHandoffBound } from '../shared/handoff.ts';

export type { HandoffReply };

/** Openings still owed (context ended, summary not yet delivered). A held start is kept while owed — NOT "while asleep" (admission's default): peer mail that starts the
 *  vierge session first must not make the release drop the summary; it then lands as the next turn of the live session. In memory: an app quit while held loses the owing
 *  (the summary stays under <ORCHESTRA_HOME>/handoff/<ws>/). */
const owed = new Set<string>();

/** The opening turn, behind Admission: a HELD start re-enters here when released — a failure THEN is reported from the retry (the first call's goes through the controller). */
async function deliverOpening(id: string, text: string): Promise<'sent' | 'held' | 'failed'> {
  owed.add(id);
  const r = await deliverRelance(
    id, text, 'handoff',
    async () => {
      const again = await deliverOpening(id, text);
      if (again === 'failed') reportAdmissionFailure(id, 'handoff: the context was ended but the held opening turn could not be delivered — the summary is saved under <ORCHESTRA_HOME>/handoff/' + id + '/');
    },
    { stillOwed: () => owed.has(id) && !!store.getWorkspace(id) && !store.getWorkspace(id)?.archived },
  );
  if (r !== 'held') owed.delete(id);
  return r;
}

const controller = createHandoffController({
  now: () => Date.now(),
  vouched: (id, key) => sessionKeys().verify(id, key) === 'ok',
  workspaceLive: (id) => {
    const ws = store.getWorkspace(id);
    return !!ws && !ws.archived;
  },
  runRefusal: (id) => {
    const ws = store.getWorkspace(id);
    if (!ws) return HANDOFF_ERRORS.outsideRun(id);
    const db = getBus();
    if (!db) return HANDOFF_ERRORS.unavailable('the fleet bus is not available');
    const runId = resolveWaveRunId(ws);
    const run = getRun(db, runId);
    if (!run) return HANDOFF_ERRORS.outsideRun(id);
    return run.closed_at != null ? HANDOFF_ERRORS.closedRun(runId) : null;
  },
  blocked: (id) => {
    const ws = store.getWorkspace(id);
    return ws ? (sandboxPausedMessage(ws) ?? pauseRefusal(ws, 'auto')) : null;
  },
  sessionOf: (id) => store.getWorkspace(id)?.sdkSessionId || undefined,
  saveSummary: (id, summary) => {
    const dir = path.join(orchestraHome(), 'handoff', id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
    fs.writeFileSync(file, summary.endsWith('\n') ? summary : `${summary}\n`, { mode: 0o600 });
    return file;
  },
  bound: () => parseHandoffBound(process.env).bound,
  endContext: (id) => sdkRestart(id, { fresh: true, trigger: 'cli' }),
  deliverOpening,
  sendNudge: async (id, text) => {
    await sdkDeliver(id, text);
  },
  report: (id, text) => reportAdmissionFailure(id, text),
  log,
});

export function dispatchHandoffRequest(msg: Record<string, unknown>): HandoffReply {
  return controller.dispatch(msg);
}

const boot = parseHandoffBound(process.env);
if (boot.invalid) log.warn(`handoff: ${boot.invalid}`);
setTurnEndListener((info) => void controller.onTurnEnd(info));
