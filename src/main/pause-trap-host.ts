// Production wiring of the fleet-Pause host trap (#252 D1b): binds the injected TrapDeps of
// src/main/pause-trap.ts to the real store, structured sessions, keepers, PTYs and /proc.
// Kept apart from pause-trap.ts so that file (and its tests) never import Electron-coupled modules.

import { store } from './store';
import { nearestOrchestratorId } from './wave-run-id';
import { getBus } from './bus';
import { sdkInterruptForPause, sdkPauseActivity } from './agent-sdk';
import { keeperPidState, probeKeeper, readTrackedKeeperPid } from './keeper-client';
import { getPtyPid, isRunning as isPtyRunning, writePty } from './pty';
import { getInFlightTools } from './hibernation-activity';
import { snapshotWorktree } from './pause-snapshot';
import { killToolTrees, realKillDeps } from './pause-kill';
import { liveChainIncludes, onTurnStart, type InterruptOutcome, type MemberActivity, type TrapDeps, type TrapMember } from './pause-trap';
import { log } from './logger';
import type { Workspace } from '../shared/types';

/** Claude Code's interrupt key in the terminal UI. */
const PTY_INTERRUPT = '\x1b';
const SETTLE_MS = 400;
const INTERRUPT_TIMEOUT_MS = 10_000;

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

export function buildPauseTrapDeps(): TrapDeps {
  const kill = realKillDeps();
  return {
    getBus,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    settleMs: SETTLE_MS,
    members: (runIds, carrierRunId) => {
      const set = new Set(runIds);
      const lookup = (id: string) => store.getWorkspace(id);
      return store.workspaces
        .filter((w) => !w.archived && !!w.worktreePath)
        .map(toMember)
        .filter((m) => set.has(m.runId) || liveChainIncludes(m.wsId, carrierRunId, lookup));
    },
    activityOf: async (m): Promise<MemberActivity> => {
      const sdk = sdkPauseActivity(m.wsId);
      const probe = sdk ? null : await probeKeeper(m.wsId).catch(() => null);
      const ptyLive = isPtyRunning(m.wsId);
      const surface: MemberActivity['surface'] = sdk || probe?.running ? 'sdk' : ptyLive ? 'pty' : 'none';
      const now = Date.now();
      return {
        surface,
        turnRunning: sdk ? sdk.turnRunning : probe?.running ? probe.turnInFlight === true : ptyLive && m.status === 'running',
        inFlightTools: getInFlightTools(m.wsId).map((t) => ({ tool: t.tool, toolUseId: t.toolUseId, sinceMs: now - t.startedAt })),
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
    snapshot: snapshotWorktree,
    killTrees: (cli, keeperPid) => killToolTrees(cli, keeperPid, kill),
  };
}

/** The turn-start observer the app registers with activity.ts (rows 29/30). Structured sessions
 *  only: a PTY agent's human keystrokes also fire `submit`, and cannot be told from a cron turn. */
export function makeTurnStartObserver(deps: TrapDeps): (wsId: string) => void {
  return (wsId) => {
    if (sdkPauseActivity(wsId) === null) return; // no live structured session ⇒ nothing the trap can own
    const ws = store.getWorkspace(wsId);
    if (!ws || ws.archived) return;
    void onTurnStart(deps, toMember(ws)).catch((e) => log.warn('pause-trap: turn-start observer failed', e));
  };
}
