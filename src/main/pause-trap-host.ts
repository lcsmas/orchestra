// Production wiring of the fleet-Pause host trap (#252 D1b): binds the injected TrapDeps of
// src/main/pause-trap.ts to the real store, structured sessions, keepers, PTYs and /proc.
// Kept apart from pause-trap.ts so that file (and its tests) never import Electron-coupled modules.

import path from 'node:path';
import { store } from './store';
import { nearestOrchestratorId } from './wave-run-id';
import { getBus } from './bus';
import { pausedCarrierForWorkspace } from './bus-pause';
import { setLiveTreeSource } from './pause-reprise';
import { sdkAttachIfDetached, sdkHumanTurnInFlight, sdkInterruptForPause, sdkPauseActivity, sdkStopTaskForPause } from './agent-sdk';
import { keeperPidState, keeperSocketPath, probeKeeper, readTrackedKeeperPid } from './keeper-client';
import { getPtyPid, isRunning as isPtyRunning, writePty } from './pty';
import { getInFlightTools } from './hibernation-activity';
import { snapshotWorktree } from './pause-snapshot';
import { pauseOrderFiles } from './pause-douce';
import { keeperActivityUnknown } from '../shared/pause-douce';
import { getEventsDir } from './events-spool';
import { killToolTrees, realKillDeps, stopWithin } from './pause-kill';
import { killReliquats } from './pause-reliquats';
import { stopBrowserReliquatsOf } from './resource-monitor';
import { memberScopeDeps } from './pause-reliquats-scope';
import { liveChainIncludes, onTurnStart, type InterruptOutcome, type MemberActivity, type TrapDeps, type TrapMember } from './pause-trap';
import { log } from './logger';
import { mergeInFlight } from '../shared/open-tools';
import type { Workspace } from '../shared/types';
import { createDockerApi, dockerApiForMember } from './docker-api.ts';

/** Claude Code's interrupt key in the terminal UI. */
const PTY_INTERRUPT = '\x1b';
const SETTLE_MS = 400;
const INTERRUPT_TIMEOUT_MS = 10_000;
/** One `stop_task` control request (#282): a hung CLI must not stall the trap — a timeout falls back to the signal kill. */
const STOP_TASK_TIMEOUT_MS = 5_000;

/** The live `parentId` chain, self first (bounded by a seen-set; a dangling parent ends it). */
function liveChain(ws: Workspace): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur: Workspace | undefined = ws;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(cur.id);
    cur = cur.parentId ? store.getWorkspace(cur.parentId) : undefined;
  }
  return out;
}

function toMember(ws: Workspace): TrapMember {
  return {
    chain: liveChain(ws),
    wsId: ws.id,
    runId: nearestOrchestratorId(ws, (id) => store.getWorkspace(id)),
    worktreePath: ws.worktreePath || null,
    remote: ws.host?.kind === 'sandbox',
    status: ws.status ?? null,
    lastTask: ws.lastTask ?? null,
  };
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t!);
  }
}

/** #254: where a member's pause order waits for its tool-result hook — a sibling of the events dir (the hook derives the same path from $ORCHESTRA_EVENTS_DIR). */
export function pauseOrdersDir(): string {
  return path.join(path.dirname(getEventsDir()), 'pause-orders');
}

export function buildPauseTrapDeps(): TrapDeps {
  const kill = realKillDeps();
  const appDocker = createDockerApi();
  // #255 (review M3): the Reprise's coordinators / member runs / release authority come from the SAME live workspace tree the gate and the trap walk — not the write-once `runs.parent_run_id`.
  setLiveTreeSource(() => ({ get: (id) => store.getWorkspace(id), ids: () => store.workspaces.filter((w) => !w.archived).map((w) => w.id) }));
  return {
    getBus,
    pauseOrders: pauseOrderFiles(pauseOrdersDir()),
    // #292: the APP's own Docker client — the REAL socket resolved like the relay's upstream, never a relay; a Pause dure stops each member's attributed containers, the Reprise restarts them
    containers: appDocker,
    containersFor: (wsId) => dockerApiForMember(keeperSocketPath(wsId), appDocker),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    settleMs: SETTLE_MS,
    members: (runIds, carrierRunId) => {
      const set = new Set(runIds);
      const lookup = (id: string) => store.getWorkspace(id);
      return store.workspaces
        .filter((w) => !w.archived && !!w.worktreePath)
        .map(toMember)
        .filter((m) => {
          const c = liveChainIncludes(m.wsId, carrierRunId, lookup);
          return c.includes || (c.dangling && set.has(m.runId));
        });
    },
    activityOf: async (m): Promise<MemberActivity> => {
      const sdk = sdkPauseActivity(m.wsId);
      const probe = sdk ? null : await probeKeeper(m.wsId).catch(() => null);
      const ptyLive = isPtyRunning(m.wsId);
      const surface: MemberActivity['surface'] = sdk || probe?.running ? 'sdk' : ptyLive ? 'pty' : 'none';
      const now = Date.now();
      // UNKNOWN is not NONE (#254): no session, no PTY and no probe answer — but a tracked keeper process IS alive (busy/stopped): its turn may well be running
      const trackedKeeperPid = !sdk && !probe && !ptyLive ? readTrackedKeeperPid(m.wsId) : null;
      const keeperUnknown = keeperActivityUnknown({
        hasSession: !!sdk,
        probeAnswered: !!probe,
        ptyLive,
        trackedKeeperPid,
        keeperPidState: trackedKeeperPid !== null ? keeperPidState(trackedKeeperPid, m.wsId) : null,
      });
      return {
        surface,
        ...(keeperUnknown ? { unknown: true } : {}),
        turnRunning: sdk ? sdk.turnRunning : probe?.running ? probe.turnInFlight === true : ptyLive && m.status === 'running',
        // a live SDK session's own open tool_use blocks are AUTHORITATIVE (hook-independent); the hook-fed liveness tracker only when there is none (terminal agent, surviving keeper)
        inFlightTools: mergeInFlight(
          sdk ? sdk.openTools.map((t) => ({ tool: t.tool, toolUseId: t.toolUseId, sinceMs: t.sinceMs, input: t.input })) : null,
          getInFlightTools(m.wsId).map((t) => ({ tool: t.tool, toolUseId: t.toolUseId, sinceMs: now - t.startedAt, input: t.detail ?? null })),
        ),
        bgTasks: (sdk?.bgTasks ?? []).map((b) => ({ id: b.id, type: b.taskType, description: b.description, status: b.status })),
      };
    },
    interrupt: async (m): Promise<InterruptOutcome> => {
      // Structured session (live, or a detached keeper mid-turn) first; else the agent PTY.
      const sdk = await withTimeout(sdkInterruptForPause(m.wsId), INTERRUPT_TIMEOUT_MS, 'sdk interrupt');
      if (sdk !== 'idle' && sdk !== 'no-session') return sdk;
      if (isPtyRunning(m.wsId)) {
        if (m.status !== 'running') return 'idle';
        writePty(m.wsId, PTY_INTERRUPT);
        return 'interrupted';
      }
      return sdk;
    },
    cliOf: async (m) => {
      // Structured: keeper → CLI. The keeper's identity is argv-verified; the CLI must be ITS child.
      const probe = await probeKeeper(m.wsId).catch(() => null);
      if (!probe) {
        // UNKNOWN is not NONE (review F4): a tracked keeper that is alive but did not answer (busy/stopped) must not read as "no keeper".
        const kp = readTrackedKeeperPid(m.wsId);
        const ks = kp === null ? 'gone' : keeperPidState(kp, m.wsId);
        // 'unknown' (alive, argv unreadable) is UNKNOWN, not "no keeper": never skip the kill on it (pre-review M8)
        if (kp !== null && (ks === 'keeper' || ks === 'unknown')) return { error: `keeper ${kp} is alive (${ks}) but did not answer the probe (busy/unresponsive)` };
      }
      if (probe?.running && probe.pid) {
        const keeperPid = readTrackedKeeperPid(m.wsId);
        if (keeperPid === null || keeperPidState(keeperPid, m.wsId) !== 'keeper') return { error: 'keeper identity unverifiable (pid file / argv)' };
        const cli = kill.read(probe.pid);
        if (cli === 'gone' || cli === 'unreadable') return { error: `cli ${probe.pid} ${cli}` };
        if (cli.ppid !== keeperPid) return { error: `cli ${probe.pid} is not a child of keeper ${keeperPid}` };
        return { cli: { pid: cli.pid, startTicks: cli.startTicks }, keeperPid };
      }
      // Agent PTY: the pty child IS the CLI.
      const ptyPid = isPtyRunning(m.wsId) ? getPtyPid(m.wsId) : undefined;
      if (ptyPid) {
        const cli = kill.read(ptyPid);
        if (cli === 'gone' || cli === 'unreadable') return { error: `pty ${ptyPid} ${cli}` };
        return { cli: { pid: cli.pid, startTicks: cli.startTicks }, keeperPid: null };
      }
      return null;
    },
    // The gate's own decision (live workspace tree, frozen switch on the carrier) — the observer and the gate cannot disagree.
    carrierFor: (m) => {
      const db = getBus();
      const ws = store.getWorkspace(m.wsId);
      return db && ws ? pausedCarrierForWorkspace(db, ws, (id) => store.getWorkspace(id)) : null;
    },
    // Attach only a keeper whose CLI is alive, has run a turn and is not shutting down: sdkAttachIfDetached KILLS a never-started
    // (init-wedged) keeper, and D4 forbids this trap ever killing a keeper.
    arm: async (m) => {
      if (sdkPauseActivity(m.wsId) !== null) return;
      const probe = await probeKeeper(m.wsId).catch(() => null);
      if (!probe?.running || probe.everStarted === false || probe.shuttingDown === true) return;
      await sdkAttachIfDetached(m.wsId);
    },
    humanTurnInFlight: (m) => sdkHumanTurnInFlight(m.wsId),
    snapshot: snapshotWorktree,
    killTrees: (cli, keeperPid, opts) => killToolTrees(cli, keeperPid, kill, opts),
    // #325 (ledger #329 FI-1 v1): the member's Reliquats — processes of its kernel scope outside its session's tree — after the tool trees. null = no tracked scope (switch OFF, human, unsupported host): today's behaviour.
    killReliquats: (m, opts) => killReliquats(m.wsId, memberScopeDeps(m.wsId), kill, opts),
    // #331: the bridge — the member's orphaned headless browsers (scope or not), through the resource monitor's own bridge (one tracker: the Resources counter counts the Pause too)
    killBrowserReliquats: (m, opts) => stopBrowserReliquatsOf(m.wsId, { ...(opts.stillPaused ? { stillWanted: opts.stillPaused } : {}), ...(opts.onProgress ? { onProgress: opts.onProgress } : {}), ...(opts.humanWindows ? { humanWindows: opts.humanWindows } : {}), ...(opts.ignoreWindow === false ? { ignoreWindow: false } : {}) }),
    stopTask: (m, taskId) => stopWithin(STOP_TASK_TIMEOUT_MS, sdkStopTaskForPause(m.wsId, taskId)),
    storeReady: () => store.loadedFromDisk,
  };
}

/** The turn-start observer the app registers with activity.ts (rows 29/30). Structured sessions
 *  only: a PTY agent's human keystrokes also fire `submit`, and cannot be told from a cron turn. */
export function makeTurnStartObserver(deps: TrapDeps): (wsId: string) => void {
  return (wsId) => {
    if (sdkPauseActivity(wsId) === null) return; // no live structured session ⇒ nothing the trap can own
    if (isPtyRunning(wsId)) return; // a Raw terminal is attached: its human keystrokes fire `submit` too and cannot be told from a cron turn (D9, row 12)
    const ws = store.getWorkspace(wsId);
    if (!ws || ws.archived) return;
    void onTurnStart(deps, toMember(ws)).catch((e) => log.warn('pause-trap: turn-start observer failed', e));
  };
}
