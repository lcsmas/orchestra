// `orchestra run status [--run <id>] [--json]` (#252 D1b) — what a coordinator reads after a
// Pause dure: is the run paused (by whom, since when, which carrier), has the host trap finished,
// and the Bilan de pause of every member (what it was doing, snapshot ref, dirty tree, commands
// killed, errors). Store-less like the other bus verbs: it reads the bus directly.

import type { BusDb } from '../main/bus.ts';
import type { RunPauseInfo } from '../main/bus-pause.ts';
import type { BilanRow } from '../main/bus-pause-records.ts';

/** The bus reads this verb needs, injected (production passes the real modules — dynamic import in index.ts). */
export interface RunStatusDeps {
  getRunPause: (db: BusDb, runId: string) => RunPauseInfo | null;
  activePauseFor: (db: BusDb, runId: string) => RunPauseInfo | null;
  listBilanForRun: (db: BusDb, carrierRunId: string, runId: string, pausedAt: number) => BilanRow[];
  runExists: (db: BusDb, runId: string) => boolean;
}

export interface RunStatus {
  runId: string;
  runExists: boolean;
  /** The pause governing this run (its own or an ancestor's), or null. */
  pause: RunPauseInfo | null;
  /** True when the pause is carried by an ANCESTOR run (`orchestra run resume --run <pause.runId>` lifts it). */
  inherited: boolean;
  bilan: BilanRow[];
}

export function gatherRunStatus(db: BusDb, runId: string, deps: RunStatusDeps): RunStatus {
  const runExists = deps.runExists(db, runId);
  const pause = deps.activePauseFor(db, runId);
  return {
    runId,
    runExists,
    pause,
    inherited: pause !== null && pause.runId !== runId,
    bilan: pause ? deps.listBilanForRun(db, pause.runId, runId, pause.pausedAt) : [],
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

interface KilledShape {
  killed?: Array<{ pid: number; cmd: string; signal: string; outcome: string }>;
  survivors?: Array<{ pid: number; cmd: string; reason: string }>;
  refused?: Array<{ pid: number; cmd: string; reason: string }>;
  spared?: Array<{ pid: number; cmd: string }>;
  skipped?: string;
}

function short(s: string, n = 90): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Human-readable rendering (the `--json` path prints `RunStatus` verbatim). */
export function renderRunStatus(st: RunStatus): string {
  const out: string[] = [];
  if (!st.runExists) out.push(`Run ${st.runId}: no row in the bus 'runs' table (unknown run, or this workspace anchors none).`);
  if (!st.pause) {
    out.push(`Run ${st.runId}: not paused.`);
    return `${out.join('\n')}\n`;
  }
  const p = st.pause;
  out.push(
    `Run ${st.runId}: PAUSED (${p.mode ?? 'hard'}) since ${iso(p.pausedAt)} by ${p.pausedBy ?? 'unknown'}` +
      (st.inherited ? ` — carried by ancestor run ${p.runId}; lift it with: orchestra run resume --run ${p.runId}` : `; lift with: orchestra run resume --run ${p.runId}`),
  );
  out.push(
    p.trapAt !== null
      ? `Host trap: DONE at ${iso(p.trapAt)}.`
      : `Host trap: NOT FINISHED — the app has not (fully) reacted yet (it runs when Orchestra is up; a pause that landed while it was closed is completed at the next launch).`,
  );
  out.push(`Bilan de pause (${st.bilan.length} member${st.bilan.length === 1 ? '' : 's'}):`);
  for (const r of st.bilan) {
    const a = r.activity;
    const dirtyTxt =
      r.dirty === null ? 'unknown' : r.dirty ? `yes${a?.changed ? ` (${a.changed.modified} modified, ${a.changed.added} added, ${a.changed.deleted} deleted)` : ''}` : 'no';
    out.push(`  • ${r.wsId}${a?.branch ? ` [${a.branch}]` : ''} — dirty tree: ${dirtyTxt}`);
    if (r.snapshotRef) out.push(`      snapshot: ${r.snapshotRef}   (git diff ${a?.head ? a.head.slice(0, 9) : 'HEAD'} ${r.snapshotRef} shows the uncommitted work)`);
    if (a?.skippedLarge?.length) out.push(`      not captured (too large): ${a.skippedLarge.map((f) => `${f.path} (${Math.round(f.bytes / 1048576)} MB)`).join(', ')}`);
    for (const s of a?.submodules ?? []) out.push(`      submodule ${s.path}: ${s.error ? `snapshot failed (${s.error})` : `${s.dirty ? 'dirty, ' : ''}ref ${s.ref}`}`);
    if (a) {
      const doing: string[] = [];
      if (a.surface === 'none') doing.push('no live session');
      else doing.push(a.turnRunning ? 'turn running' : 'idle');
      for (const t of a.inFlightTools ?? []) doing.push(`in-flight ${t.tool ?? '?'}${t.sinceMs !== null ? ` ${Math.round(t.sinceMs / 1000)}s` : ''}`);
      for (const b of a.bgTasks ?? []) doing.push(`background ${b.type ?? 'task'} "${short(b.description, 50)}" (${b.status})`);
      out.push(`      was doing: ${doing.join(' · ')}`);
      if (a.lastTask) out.push(`      task: ${short(a.lastTask, 120)}`);
      if (a.interrupt) out.push(`      interrupt: ${a.interrupt}`);
    }
    const k = r.killed as KilledShape | null;
    if (k) {
      if (k.skipped) out.push(`      killed: nothing — ${k.skipped}`);
      else {
        const killed = k.killed ?? [];
        out.push(
          `      killed: ${killed.length} tool process(es)${killed.length ? ' — ' + killed.slice(0, 6).map((x) => `${short(x.cmd, 60)} (pid ${x.pid})`).join('; ') + (killed.length > 6 ? `; +${killed.length - 6} more` : '') : ''}`,
        );
        if (k.survivors?.length) out.push(`      STILL ALIVE: ${k.survivors.map((x) => `${short(x.cmd, 60)} (pid ${x.pid}: ${x.reason})`).join('; ')}`);
        if (k.refused?.length) out.push(`      refused (identity not provable): ${k.refused.map((x) => `pid ${x.pid}: ${x.reason}`).join('; ')}`);
        if (k.spared?.length) out.push(`      left running (not tool processes): ${k.spared.map((x) => short(x.cmd, 50)).join('; ')}`);
      }
    } else out.push('      killed: (trap not finished for this member)');
    for (const n of a?.notes ?? []) out.push(`      note: ${n}`);
    if (r.error) out.push(`      error: ${r.error}`);
  }
  out.push(
    'Reprise: `orchestra run resume` only lifts the pause — nothing restarts on its own. Re-dispatch each member from its Bilan; killed commands are listed, never re-run automatically.',
  );
  return `${out.join('\n')}\n`;
}
