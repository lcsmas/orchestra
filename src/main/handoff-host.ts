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
import { clearBusRunStale, reportAdmissionFailure, resolveWaveRunId } from './workspaces';
import { pauseRefusal } from './pause-gate';
import { sdkPauseActivity, sdkRestart } from './agent-sdk';
import { sdkDeliver } from './sdk-delivery';
import { deliverRelance } from './relance-host.ts';
import { clearOwed, listOwed, readOwed, writeOwed } from './handoff-owed.ts';
import { setTurnEndListener } from './handoff-seam.ts';
import { createHandoffController, type HandoffReply } from './handoff-controller.ts';
import { sandboxPausedMessage } from '../shared/sandbox-pause.ts';
import { HANDOFF_ERRORS, parseHandoffBound, resolveHandoffBound } from '../shared/handoff.ts';
import { workspaceRole, roleSpec, type RoleConfig } from '../shared/fleet-roles.ts';
import { loadRoleConfig } from './fleet-roles-config.ts';

export type { HandoffReply };

const OWED_ROOT = (): string => path.join(orchestraHome(), 'handoff');
const RETRY_MS = 60_000;
const MAX_RETRIES = 5;

/** Workspaces whose opening is being delivered / held right now (a sweep must not start a second delivery). */
const active = new Set<string>();
const retries = new Map<string, number>();

const stillOwed = (id: string): boolean => readOwed(OWED_ROOT(), id) !== null && !!store.getWorkspace(id) && !store.getWorkspace(id)?.archived;

/** The opening turn, behind Admission. The OWED MARKER on disk (handoff-owed.ts) is the truth: a held start is kept while owed — NOT "while asleep" (admission's default:
 *  peer mail that starts the vierge session first would make the release drop the summary; it then lands as the next turn of the live session) — and a failed one is retried
 *  (bounded) and re-delivered at app start. Cleared only once delivered. */
async function deliverOpening(id: string, text: string, fromRetry = false): Promise<'sent' | 'held' | 'failed'> {
  if (!fromRetry && active.has(id)) return 'held';
  active.add(id);
  const r = await deliverRelance(
    id, text, 'handoff',
    async () => {
      const again = await deliverOpening(id, text, true);
      if (again === 'failed') reportAdmissionFailure(id, 'handoff: the held opening turn could not be delivered — it stays owed (summary under <ORCHESTRA_HOME>/handoff/' + id + '/)');
    },
    { stillOwed: () => stillOwed(id) },
  );
  if (r === 'held') return r;
  active.delete(id);
  if (r === 'sent') {
    clearOwed(OWED_ROOT(), id);
    retries.delete(id);
  } else {
    const n = (retries.get(id) ?? 0) + 1;
    retries.set(id, n);
    if (n <= MAX_RETRIES) setTimeout(() => void resumeOwed(id), RETRY_MS).unref?.();
    else log.warn(`handoff: opening of ${id} still undelivered after ${MAX_RETRIES} retries — left owed (app start retries)`);
  }
  return r;
}

/** Re-deliver one workspace's owed opening (a retry timer, or the app-start sweep). */
async function resumeOwed(id: string): Promise<void> {
  const rec = readOwed(OWED_ROOT(), id);
  if (!rec || !stillOwed(id) || active.has(id)) return;
  log.info(`handoff: re-delivering the owed opening of ${id} (accepted ${new Date(rec.at).toISOString()})`);
  await deliverOpening(id, rec.opening);
}

/** App start: every opening still owed (an app quit between the clear and the delivery, or a start that kept failing). */
export function resumeOwedOpenings(): void {
  for (const { wsId } of listOwed(OWED_ROOT())) void resumeOwed(wsId).catch((e) => log.warn(`handoff: owed opening of ${wsId} failed`, e));
}

let warnedRoleFile = '';
/** #478: the role's bound from the workspace's spawn name (`ws.branch`, the role sentinel's source) + fleet-roles.json, re-read each turn end. A file that does not parse ⇒ built-in table + ONE warning per message. */
function roleBoundOf(id: string): number {
  const ws = store.getWorkspace(id);
  const role = ws ? workspaceRole(ws) : null; // #489: the role frozen at spawn, not the current name
  if (!role) return 0;
  let cfg: RoleConfig | undefined;
  try {
    cfg = loadRoleConfig();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg !== warnedRoleFile) log.warn(`handoff: ${msg} — using the built-in role bounds`);
    warnedRoleFile = msg;
  }
  return roleSpec(role, cfg).handoffBoundTurns;
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
  turnInFlight: (id) => sdkPauseActivity(id)?.turnRunning ?? false,
  owe: (id, opening, file, at) => writeOwed(OWED_ROOT(), id, { opening, file, at }),
  settle: (id) => clearOwed(OWED_ROOT(), id),
  saveSummary: (id, summary) => {
    const dir = path.join(orchestraHome(), 'handoff', id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
    fs.writeFileSync(file, summary.endsWith('\n') ? summary : `${summary}\n`, { mode: 0o600 });
    return file;
  },
  bound: (id) => resolveHandoffBound(process.env, roleBoundOf(id)).bound,
  endContext: async (id) => {
    await sdkRestart(id, { fresh: true, trigger: 'cli' });
    await clearBusRunStale(id); // like `orchestra restart`: the relaunch re-reads the run, so a stale-run block (#142) is resolved by it
  },
  sendNotice: async (id, text) => {
    await sdkDeliver(id, text);
  },
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
setTimeout(resumeOwedOpenings, 30_000).unref?.(); // after the store and the bus are up
