// The Veille's Reliquat PORT (#326; verdict: veille-reliquats.ts, wording: shared/veille-reliquats.ts, production wiring: veille-reliquats-host.ts). The census, the stop and the notice reuse the Pause's own pieces —
// nothing here re-derives what a Reliquat is:
//   - scope-tracked member: FI-1 `memberScopes` / `listScopeProcs` through `memberScopeDeps` (pause-reliquats-scope.ts) and `judgeReliquat` (the SAME verdict the kill applies, so a Reliquat the stop
//     would refuse or spare never delays a Veille); stopped by `killReliquats` (identity re-read at signal time, fail closed);
//   - member with NO tracked scope (`memory_cap` OFF, D-Q1): #331's orphaned headless browsers (`countBrowserReliquatsOf` / `stopBrowserReliquatsOf`, the same selection as the monitor's pass);
//   - the notice is queued in the member's INBOX (`inbox/<ws>.txt`): printed at its next SessionStart / UserPromptSubmit WITHOUT waking it (a bus row would wake it straight out of its Veille).
// Electron-free (node --test drives it over a scratch cgroup tree and real stand-in processes): the pieces that need the app — the keeper/CLI identity, the browser pass, the inbox — are
// REQUIRED dependencies, supplied by the host.

import { killReliquats } from './pause-reliquats.ts';
import { memberScopeDeps } from './pause-reliquats-scope.ts';
import { realKillDeps, type KillDeps } from './pause-kill.ts';
import { realScopeEnv, type ScopeEnv } from './memory-scope.ts';
import { emptyReliquatReport, isOwnKeeperProc, judgeReliquat, type ReliquatReport } from '../shared/pause-reliquats.ts';
import type { VeilleReliquatPort } from './veille-reliquats.ts';

/** A process start time is boot time + ticks/CLK_TCK — good to a second or so. Only what began more than this AFTER the stop began is « new work » (a Reliquat born a moment before is still ours to stop). */
const START_CLOCK_SLACK_MS = 2_000;

export interface VeilleReliquatPortDeps {
  /** The member's proven keeper → CLI (Pause's `cliOf`): `{error}` = UNKNOWN, null = no live process. */
  cliOf: (m: { wsId: string }) => Promise<{ error: string } | { cli: { pid: number; startTicks: number }; keeperPid: number | null } | null>;
  /** #331's orphaned headless browsers of a member with NO tracked scope: how many are alive (`'unknown'` = could not look)… */
  countBrowsers: (wsId: string) => Promise<number | 'unknown'>;
  /** …and the pass that stops them (the idle window ignored; a connected client still protects). */
  stopBrowsers: (wsId: string, ctx?: { stillWanted(): boolean; stillWantedAfterSignal?(): boolean }) => Promise<ReliquatReport | null>;
  /** Queue text in the member's inbox; false = could not. */
  tell: (wsId: string, text: string) => Promise<boolean>;
  /** The cgroup tree (a rig points it at a scratch dir; production = the real one). */
  scopeEnv?: ScopeEnv;
  kill?: KillDeps;
}

export function makeVeilleReliquatPort(o: VeilleReliquatPortDeps): VeilleReliquatPort {
  const env = o.scopeEnv ?? realScopeEnv();
  const kill = o.kill ?? realKillDeps();
  const { cliOf, countBrowsers, stopBrowsers } = o;
  return {
    async census(wsId): Promise<number | 'unknown'> {
      const deps = memberScopeDeps(wsId, env);
      let scopes;
      try {
        scopes = deps.scopes(wsId);
      } catch {
        return 'unknown'; // the app.slice could not be listed: UNKNOWN is not « no scope »
      }
      if (scopes.length === 0) return countBrowsers(wsId); // no tracked scope: #331's browsers
      const who = await cliOf({ wsId }).catch(() => ({ error: 'cliOf threw' }) as const);
      if (who && 'error' in who) return 'unknown';
      const protect = { keeperPid: who && 'keeperPid' in who ? who.keeperPid : null, cliPid: who && 'cli' in who ? who.cli.pid : null, selfPid: kill.selfPid };
      let n = 0;
      for (const scope of scopes) {
        const listing = deps.list(scope);
        if (listing === 'gone') continue;
        if (listing === 'unreadable') return 'unknown';
        for (const m of listing) {
          if (m.role !== 'reliquat') continue;
          // FI-1 names the member's keeper only once its pid file is published: until then it, its CLI and its MCP servers all read `reliquat` — the roles are unreliable, so no count (and no kill).
          const f = kill.read(m.pid);
          if (f !== 'gone' && f !== 'unreadable' && isOwnKeeperProc(f, wsId)) return 'unknown';
          // only what the stop would really signal delays the Veille: a spared / refused Reliquat survives it either way
          if (judgeReliquat(m.pid, m.startTicks, scope, listing, protect, kill.read).ok) n++;
        }
      }
      return n;
    },

    async stop(wsId, ctx): Promise<ReliquatReport | null> {
      const deps = memberScopeDeps(wsId, env);
      let scopes;
      try {
        scopes = deps.scopes(wsId);
      } catch (e) {
        return { ...emptyReliquatReport(), unknown: `scope lookup failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      // No tracked scope: a browser is never the member's session, so the keeper / CLI identity is not needed (and an unresponsive keeper must not keep a scope-less member awake for ever)
      if (scopes.length === 0) return stopBrowsers(wsId, ctx);
      const who = await cliOf({ wsId }).catch((e: unknown) => ({ error: `cliOf failed: ${e instanceof Error ? e.message : String(e)}` }) as const);
      if (who && 'error' in who) return { ...emptyReliquatReport(), unknown: who.error }; // UNKNOWN is not NONE: the keeper / CLI to protect could not be proven
      const keeperPid = who && 'keeperPid' in who ? who.keeperPid : null;
      const cliPid = who && 'cli' in who ? who.cli.pid : null;
      // what the member started AFTER this stop began is its new work (it woke): spared, listed; and a wake / delete mid-stop ends the signal rounds
      const startedBeforeMs = kill.now() + START_CLOCK_SLACK_MS;
      const scoped = await killReliquats(wsId, deps, kill, { keeperPid, cliPid, startedBeforeMs, ...(ctx?.stillWanted ? { stillPaused: ctx.stillWanted } : {}), ...(ctx?.stillWantedAfterSignal ? { stillPausedAfterSignal: ctx.stillWantedAfterSignal } : {}) });
      return scoped ?? stopBrowsers(wsId, ctx);
    },

    tell: o.tell,
  };
}
