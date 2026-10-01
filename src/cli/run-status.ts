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
  /** The newest pause with Bilan rows in this run's scope — readable after the lift. Omitted ⇒ none. */
  latestPauseBilan?: (db: BusDb, runId: string) => { carrierRunId: string; pausedAt: number; rows: BilanRow[] } | null;
}

export interface RunStatus {
  runId: string;
  runExists: boolean;
  /** The pause governing this run (its own or an ancestor's), or null. */
  pause: RunPauseInfo | null;
  /** True when the pause is carried by an ANCESTOR run (`orchestra run resume --run <pause.runId>` lifts it). */
  inherited: boolean;
  bilan: BilanRow[];
  /** Set only when NOT paused: the most recent (lifted) pause whose Bilan is still in `pause_records`. */
  lastPause: { carrierRunId: string; pausedAt: number } | null;
}

export function gatherRunStatus(db: BusDb, runId: string, deps: RunStatusDeps): RunStatus {
  const runExists = deps.runExists(db, runId);
  const pause = deps.activePauseFor(db, runId);
  const last = pause ? null : (deps.latestPauseBilan?.(db, runId) ?? null);
  return {
    runId,
    runExists,
    pause,
    inherited: pause !== null && pause.runId !== runId,
    bilan: pause ? deps.listBilanForRun(db, pause.runId, runId, pause.pausedAt) : (last?.rows ?? []),
    lastPause: last ? { carrierRunId: last.carrierRunId, pausedAt: last.pausedAt } : null,
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

interface KilledShape {
  killed?: Array<{ pid: number; cmd: string; signal: string; outcome: string; via?: string; cwd?: string | null; evidence?: string }>;
  cli?: { pid: number; startTicks: number };
  survivors?: Array<{ pid: number; cmd: string; reason: string }>;
  refused?: Array<{ pid: number; cmd: string; reason: string }>;
  spared?: Array<{ pid: number; cmd: string }>;
  skipped?: string;
}

/** Control characters (ESC, CR, NL, NUL…) in ANY recorded string (argv, cwd, paths, errors, notes) must never reach the coordinator's terminal nor forge a line (review F11). */
function c(s: unknown): string {
  // C0/DEL/C1, plus the Unicode line/paragraph separators and bidi overrides/isolates (U+2028/2029, U+202A-202E, U+2066-2069) that forge or reorder a line (round-3 F8)
  return String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ');
}

/** Sizes: one decimal under 10 MB (a small file reads "0.0 MB" never "0 MB"), whole MB above. */
function mb(bytes: number): string {
  const m = bytes / 1048576;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)} MB`;
}

function short(s: string, n = 90): string {
  const clean = c(s);
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean;
}

/** Human-readable rendering (the `--json` path prints `RunStatus` verbatim). */
export function renderRunStatus(st: RunStatus): string {
  const out: string[] = [];
  if (!st.runExists) out.push(`Run ${st.runId}: no row in the bus 'runs' table (unknown run, or this workspace anchors none).`);
  if (!st.pause) {
    out.push(`Run ${st.runId}: not paused.`);
    if (st.lastPause) {
      out.push(`Last pause (LIFTED): carried by run ${st.lastPause.carrierRunId}, since ${iso(st.lastPause.pausedAt)}. Its Bilan de pause (kept after the lift):`);
      renderRows(st.bilan, out);
    }
    return `${out.join('\n')}\n`;
  }
  const p = st.pause;
  out.push(
    `Run ${st.runId}: PAUSED (${p.mode ?? 'hard'}) since ${iso(p.pausedAt)} by ${c(p.pausedBy ?? 'unknown')}` +
      (st.inherited ? ` — carried by ancestor run ${p.runId}; lift it with: orchestra run resume --run ${p.runId}` : `; lift with: orchestra run resume --run ${p.runId}`),
  );
  out.push(
    p.trapAt !== null
      ? `Host trap: DONE at ${iso(p.trapAt)}.`
      : `Host trap: NOT FINISHED — the app has not (fully) reacted yet (it runs when Orchestra is up; a pause that landed while it was closed is completed at the next launch).`,
  );
  out.push(`Bilan de pause (${st.bilan.length} member${st.bilan.length === 1 ? '' : 's'}):`);
  renderRows(st.bilan, out);
  out.push(
    'Reprise: `orchestra run resume` only lifts the pause — nothing restarts on its own. Re-dispatch each member from its Bilan; killed commands are listed, never re-run automatically.',
  );
  return `${out.join('\n')}\n`;
}

function renderRows(rows: BilanRow[], out: string[]): void {
  for (const r of rows) {
    const a = r.activity;
    const dirtyTxt =
      r.dirty === null ? 'unknown' : r.dirty ? `yes${a?.changed ? ` (${a.changed.modified} modified, ${a.changed.added} added, ${a.changed.deleted} deleted)` : ''}` : 'no';
    out.push(`  • ${c(r.wsId)}${a?.branch ? ` [${c(a.branch)}]` : ''} — dirty tree: ${dirtyTxt}`);
    if (r.snapshotRef) out.push(`      snapshot: ${c(r.snapshotRef)}   (git diff ${a?.head ? c(a.head).slice(0, 9) : 'HEAD'} ${c(r.snapshotRef)} shows the uncommitted non-ignored work)`);
    if (a?.snapshotWarnings?.length) out.push(`      NOT captured (unreadable): ${c(a.snapshotWarnings.join(' | ')).slice(0, 300)}`);
    if (a?.skippedLarge?.length) out.push(`      not captured (too large): ${a.skippedLarge.slice(0, 20).map((f) => `${c(f.path)} (${mb(Number(f.bytes))}${f.reason === 'total-cap' ? ', total size cap' : ''})`).join(', ')}${a.skippedLarge.length > 20 ? `; +${a.skippedLarge.length - 20} more` : ''}`);
    for (const s of a?.submodules ?? []) out.push(`      submodule ${c(s.path)}: ${s.error ? `snapshot failed (${c(s.error)})` : `${s.dirty ? 'dirty, ' : ''}ref ${c(s.ref)}`}`);
    if (a) {
      const doing: string[] = [];
      if (a.surface === 'none') doing.push('no live session');
      else doing.push(a.turnRunning ? 'turn running' : 'idle');
      for (const t of a.inFlightTools ?? []) doing.push(`in-flight ${c(t.tool ?? '?')}${t.sinceMs !== null ? ` ${Math.round(t.sinceMs / 1000)}s` : ''}`);
      for (const b of a.bgTasks ?? []) doing.push(`background ${b.type ?? 'task'} "${short(b.description, 50)}" (${c(b.status)})`);
      out.push(`      was doing: ${doing.join(' · ')}`);
      if (a.lastTask) out.push(`      task: ${short(a.lastTask, 120)}`);
      if (a.interrupt) out.push(`      interrupt: ${c(a.interrupt)}`);
    }
    const k = r.killed as KilledShape | null;
    if (k) {
      if (k.skipped) out.push(`      killed: nothing — ${c(k.skipped)}`);
      else {
        const killed = k.killed ?? [];
        out.push(
          `      killed: ${killed.length} tool process(es)${killed.length ? ' — ' + killed.slice(0, 6).map((x) => `${short(x.cmd, 60)} (pid ${c(x.pid)})`).join('; ') + (killed.length > 6 ? `; +${killed.length - 6} more` : '') : ''}`,
        );
        // D11: an ORPHAN (left the CLI's tree) is killed only with provenance — list each with its cwd and the reason that matched.
        for (const o of killed.filter((x) => x.via === 'env' || x.via === 'session')) {
          out.push(`      orphan killed (left the CLI's tree, via ${c(o.via)}): ${short(o.cmd, 70)} pid ${c(o.pid)} cwd ${c(o.cwd ?? '?')} — ${c(o.evidence ?? '')}`);
        }
        if (k.survivors?.length) out.push(`      STILL ALIVE: ${k.survivors.map((x) => `${short(x.cmd, 60)} (pid ${c(x.pid)}: ${c(x.reason)})`).join('; ')}`);
        if (k.refused?.length) out.push(`      refused (identity not provable): ${k.refused.map((x) => `pid ${c(x.pid)}: ${c(x.reason)}`).join('; ')}`);
        if (k.spared?.length) out.push(`      left running (not tool processes): ${k.spared.map((x) => short(x.cmd, 50)).join('; ')}`);
      }
    } else out.push('      killed: (trap not finished for this member)');
    if (a?.observerKilled?.length) out.push(`      killed by the turn observer (CLI-started turn while paused): ${a.observerKilled.slice(0, 6).map((x) => `${short(x.cmd, 60)} (pid ${c(x.pid)})`).join("; ")}${a.observerKilled.length > 6 ? `; +${a.observerKilled.length - 6} more` : ''}`);
    for (const o of (a?.observerKilled ?? []).filter((x) => x.via === 'env' || x.via === 'session')) {
      out.push(`      orphan killed by the turn observer (via ${c(o.via)}): ${short(o.cmd, 70)} pid ${c(o.pid)} cwd ${c(o.cwd ?? '?')} — ${c(o.evidence ?? '')}`);
    }
    if (a?.earlierKilled?.length) out.push(`      killed by EARLIER incomplete attempt(s) of the trap: ${a.earlierKilled.slice(0, 6).map((x) => `${short(x.cmd, 60)} (pid ${c(x.pid)})`).join('; ')}${a.earlierKilled.length > 6 ? `; +${a.earlierKilled.length - 6} more` : ''}`);
    for (const n of a?.notes ?? []) out.push(`      note: ${c(n)}`);
    if (r.error) out.push(`      error: ${c(r.error)}`);
  }
}
