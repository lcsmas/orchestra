// #320 — the app-side decision "does this session's keeper start in its own memory scope, and with which limits?". Kept apart from agent-sdk.ts (like
// docker-relay-switch.ts) so a test can drive it against a real scratch bus without the SDK / Electron chain. Pure decision: shared/memory-scope.ts.

import { getBus } from './bus.ts';
import { busSwitch } from './bus-runs.ts';
import { isFleetMember } from '../shared/admission.ts';
import { decideMemoryCap, memoryScopeUnitName, newScopeGen, type MemoryCapDecision, type MemoryCapLaunch } from '../shared/memory-scope.ts';
import { scopePrefix, scopeSupportCached, type ScopeSupport } from './memory-scope.ts';
import { log } from './logger.ts';

export interface MemoryCapSpecArgs {
  wsId: string;
  /** `$ORCHESTRA_RUN_ID` of the session being started (the member's wave run). */
  runId: string | undefined;
  /** The workspace: a FLEET MEMBER has a coordinator (`parentId`, the same test as Admission); a human-created top-level workspace never does. */
  ws: { parentId?: string } | null | undefined;
  remote: boolean;
  /** The Garde mémoire settings, read NOW (at session start): the levels are not frozen, only the switch is. */
  settings: { capSoftGb: number; capHardGb: number };
}

export interface MemoryCapSpecDeps {
  /** The run's FROZEN `memory_cap` switch (default: the bus; down / no row ⇒ false). */
  switchOn(runId: string): boolean;
  support(): ScopeSupport;
  platform: string;
  prefix(): string;
  now(): number;
}

/** The production wiring (exported so a test can drive the REAL bus read, not a stand-in). */
export const realMemoryCapDeps: MemoryCapSpecDeps = {
  switchOn: (runId) => {
    try {
      const db = getBus();
      return !!db && busSwitch(db, runId, 'memory_cap');
    } catch (e) {
      log.warn(`memory cap: could not read the memory_cap switch for ${runId}`, e);
      return false; // a failed read is "no cap", never a failed start
    }
  },
  support: () => scopeSupportCached(),
  platform: process.platform,
  prefix: () => scopePrefix(),
  now: () => Date.now(),
};

/** The decision for one session start, with the reason (the rig and the tests read it). */
export function memoryCapDecisionFor(a: MemoryCapSpecArgs, deps: MemoryCapSpecDeps = realMemoryCapDeps): MemoryCapDecision & { support: ScopeSupport } {
  const runId = a.runId?.trim();
  const switchOn = !!runId && deps.switchOn(runId);
  const support = deps.support();
  return { ...decideMemoryCap({ switchOn, hasCoordinator: isFleetMember(a.ws), remote: a.remote, platform: deps.platform, supported: support.ok, softGb: a.settings.capSoftGb, hardGb: a.settings.capHardGb }), support };
}

/** The scope this session's keeper must be launched in, or undefined (today's launch, byte for byte). Never throws. */
export function memoryCapSpecFor(a: MemoryCapSpecArgs, deps: MemoryCapSpecDeps = realMemoryCapDeps): MemoryCapLaunch | undefined {
  try {
    const d = memoryCapDecisionFor(a, deps);
    if (!d.createScope) {
      // ON for the run but this member cannot be tracked on this host: say so once per start (silence would read as "capped").
      if (d.reason === 'unsupported' && a.runId?.trim() && deps.switchOn(a.runId.trim())) log.warn(`memory-cap[${a.wsId}]: memory_cap is ON for run ${a.runId} but this host cannot scope it (${d.support.ok ? 'unknown' : d.support.reason}) — the member runs uncapped`);
      return undefined;
    }
    const unit = memoryScopeUnitName(deps.prefix(), a.wsId, newScopeGen(deps.now()));
    if (!unit) {
      log.warn(`memory-cap[${a.wsId}]: workspace id cannot be part of a unit name — no scope`);
      return undefined;
    }
    return { unit, limits: d.limits };
  } catch (e) {
    log.warn(`memory-cap[${a.wsId}]: decision failed — the member runs uncapped`, e);
    return undefined;
  }
}
