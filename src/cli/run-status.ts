// `orchestra run status [--run <id>] [--json]` (#252 D1b) — what a coordinator reads after a
// Pause dure: is the run paused (by whom, since when, which carrier), has the host trap finished,
// and the Bilan de pause of every member (what it was doing, snapshot ref, dirty tree, commands
// killed, errors). Store-less like the other bus verbs: it reads the bus directly.

import type { BusDb } from '../main/bus.ts';
import type { RunPauseInfo } from '../main/bus-pause.ts';
import type { BilanRow } from '../main/bus-pause-records.ts';
import { renderPauseStatusLine, type PauseStatusView } from '../shared/pause-douce.ts';
import { actorText } from '../shared/pause-lifecycle.ts';
import { pauseLineCoversReprise, renderRepriseStatus, type RepriseStatusView } from '../shared/pause-reprise-view.ts';
import type { AutoHeld } from '../shared/pause-auto.ts';
import { owedRestarts } from '../shared/pause-containers.ts';

/** The bus reads this verb needs, injected (production passes the real modules — dynamic import in index.ts). */
export interface RunStatusDeps {
  getRunPause: (db: BusDb, runId: string) => RunPauseInfo | null;
  activePauseFor: (db: BusDb, runId: string) => RunPauseInfo | null;
  listBilanForRun: (db: BusDb, carrierRunId: string, runId: string, pausedAt: number) => BilanRow[];
  runExists: (db: BusDb, runId: string) => boolean;
  /** The newest pause with Bilan rows in this run's scope — readable after the lift. Omitted ⇒ none. */
  latestPauseBilan?: (db: BusDb, runId: string) => { carrierRunId: string; pausedAt: number; rows: BilanRow[] } | null;
  /** #254: the carrier's phase + roster ("N/M en pause — manquent : …"). Omitted ⇒ none. */
  pauseStatus?: (db: BusDb, carrierRunId: string) => PauseStatusView | null;
  /** #255: the pause that still GATES this run once the nearer carrier has released its coordinator (release-aware — the gate's own read). Omitted ⇒ not asked. */
  gatePauseFor?: (db: BusDb, runId: string) => RunPauseInfo | null;
  /** #255: the open Reprise (resuming, or active with accusés still missing) — "N/M repris — manquent : …". Omitted ⇒ none. */
  repriseView?: (db: BusDb, runId: string) => RepriseStatusView | null;
  /** #256: the HELD auto-Reprise of the carrier (`pause_auto.held`) — "quota is back but the Reprise could not wake …". Omitted ⇒ none. */
  autoHeld?: (db: BusDb, carrierRunId: string) => AutoHeld | null;
}

export interface RunStatus {
  runId: string;
  runExists: boolean;
  /** The pause governing this run (its own or an ancestor's), or null. */
  pause: RunPauseInfo | null;
  /** #254: the pause's phase + roster — present only while paused (and only when the caller wired `pauseStatus`), so the older JSON shape is unchanged. */
  roster?: PauseStatusView;
  /** True when the pause is carried by an ANCESTOR run (`orchestra run resume --run <pause.runId>` lifts it). */
  inherited: boolean;
  bilan: BilanRow[];
  /** Set only when NOT paused: the most recent (lifted) pause whose Bilan is still in `pause_records`. */
  lastPause: { carrierRunId: string; pausedAt: number } | null;
  /** The open Reprise of this run's carrier, or null. */
  reprise: RepriseStatusView | null;
  /** An ANCESTOR run's pause that still gates this run although its nearer carrier is RESUMING (null otherwise). */
  stillPausedBy: RunPauseInfo | null;
  /** #256: present only while the carrier's auto-Reprise is HELD (older JSON shape unchanged otherwise). */
  autoHeld?: AutoHeld;
}

export function gatherRunStatus(db: BusDb, runId: string, deps: RunStatusDeps): RunStatus {
  const runExists = deps.runExists(db, runId);
  const pause = deps.activePauseFor(db, runId);
  const last = pause ? null : (deps.latestPauseBilan?.(db, runId) ?? null);
  return {
    runId,
    runExists,
    pause,
    ...(pause && deps.pauseStatus ? { roster: deps.pauseStatus(db, pause.runId) ?? undefined } : {}),
    inherited: pause !== null && pause.runId !== runId,
    bilan: pause ? deps.listBilanForRun(db, pause.runId, runId, pause.pausedAt) : (last?.rows ?? []),
    lastPause: last ? { carrierRunId: last.carrierRunId, pausedAt: last.pausedAt } : null,
    reprise: deps.repriseView?.(db, runId) ?? null,
    ...(() => {
      const held = pause && deps.autoHeld ? deps.autoHeld(db, pause.runId) : null;
      return held ? { autoHeld: held } : {};
    })(),
    stillPausedBy: (() => {
      if (!pause?.resumeStartedAt || !deps.gatePauseFor) return null;
      const g = deps.gatePauseFor(db, runId);
      return g && g.runId !== pause.runId ? g : null;
    })(),
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
  /** #282: tool roots that were background tasks, asked to stop THROUGH THE CLI before any signal (`ok:false` = the signal path ended it). */
  stopTask?: Array<{ taskId: string; pid: number; cmd: string; ok: boolean; note?: string }>;
}

/** Control characters (ESC, CR, NL, NUL…) in ANY recorded string (argv, cwd, paths, errors, notes) must never reach the coordinator's terminal nor forge a line (review F11). */
function c(s: unknown): string {
  // C0/DEL/C1, plus the Unicode line/paragraph separators and bidi overrides/isolates (U+2028/2029, U+202A-202E, U+2066-2069) that forge or reorder a line (round-3 F8)
  // + zero-width / invisible formatting (U+200B-200D, 2060-2064, FEFF, 00AD, 180E) and the TAG block (U+E0000-E007F): invisible text from a hostile file name or cmdline (round-3 F5b)
  return String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu, ' ');
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
    if (st.reprise) out.push(...renderRepriseStatus(st.reprise));
    if (st.lastPause) {
      out.push(`Last pause (LIFTED): carried by run ${st.lastPause.carrierRunId}, since ${iso(st.lastPause.pausedAt)}. Its Bilan de pause (kept after the lift):`);
      renderRows(st.bilan, out);
    }
    return `${out.join('\n')}\n`;
  }
  const p = st.pause;
  out.push(
    p.resumeStartedAt
      ? // #255: the carrier is RESUMING — still a carried pause (workers blocked), but it is being lifted: say so, never "lift it with resume" again
        `Run ${st.runId}: RESUMING — the ${p.mode ?? 'hard'} pause of ${iso(p.pausedAt)} (by ${c(actorText(p.pausedBy) ?? 'unknown')}) is being lifted by the Reprise` +
        (st.inherited ? `, carried by ancestor run ${p.runId}` : '')
      : `Run ${st.runId}: PAUSED (${p.mode ?? 'hard'}) since ${iso(p.pausedAt)} by ${c(actorText(p.pausedBy) ?? 'unknown')}` +
        (st.inherited ? ` — carried by ancestor run ${p.runId}; lift it with: orchestra run resume --run ${p.runId}` : `; lift with: orchestra run resume --run ${p.runId}`),
  );
  if (st.stillPausedBy) out.push(`Still PAUSED by run ${st.stillPausedBy.runId} (an ancestor) — its members stay blocked until that one resumes too: orchestra run resume --run ${st.stillPausedBy.runId}`);
  if (st.roster) {
    out.push(`Pause: ${renderPauseStatusLine(st.roster, { label: c, now: Date.now() })}`);
    // the per-member lines read "pas encore confirmé" = the PAUSE accusé: meaningless once the Reprise began (the Reprise view below lists who is released / accused)
    if (st.roster.phase !== 'resuming') {
      for (const r of st.roster.rows) {
        out.push(
          `  • ${c(r.wsId)} [${r.role}] — ${r.pauseConfirmedAt !== null ? `en pause (${r.pauseConfirmVia ?? '?'}) ${iso(r.pauseConfirmedAt)}` : 'pas encore confirmé'}`,
        );
      }
    }
  }
  out.push(
    p.trapAt !== null
      ? `Host trap: DONE at ${iso(p.trapAt)}.`
      : p.resumeStartedAt
        ? `Host trap: not owed any more — the Reprise began before it finished (nothing is interrupted or killed after that).`
        : p.mode === 'soft' && p.escalatedAt == null
          ? `Host trap: NOT OWED YET — Pause douce still waiting for its members (the host takes over when all confirmed or at ${p.deadlineAt ? iso(p.deadlineAt) : 'the 3-min deadline'}).`
        : `Host trap: NOT FINISHED — the app has not (fully) reacted yet (it runs when Orchestra is up; a pause that landed while it was closed is completed at the next launch).`,
  );
  if (st.autoHeld) {
    out.push(
      `Auto-Reprise: HELD since ${iso(st.autoHeld.at)} — the usage quota is back, but the Reprise could not wake ${st.autoHeld.addressees.map((a) => c(a)).join(', ')} (a run with its frozen \`wake\` switch OFF: nobody would receive its \`reprise\` row); ` +
        `told ${st.autoHeld.to === 'human' ? 'the human (decision gate)' : c(st.autoHeld.to)}. Detach that run (the next tick Reprises) or lift by hand: orchestra run resume --run ${p.runId}`,
    );
  }
  if (p.resumeStartedAt) {
    // #292: while the Pause's stopped containers are still owed a restart the coordinators are PARKED (the host restarts them first)
    const owedN = st.bilan.reduce((n, r) => n + (r.activity?.containers ? owedRestarts(r.activity.containers).length : 0), 0);
    out.push(
      owedN > 0
        ? `Reprise: RESUMING since ${iso(p.resumeStartedAt)} — the host is restarting ${owedN} container(s) the Pause stopped (it must be running); the coordinators are released right after, every other member stays BLOCKED until its coordinator runs \`orchestra run release\`.`
        : `Reprise: RESUMING since ${iso(p.resumeStartedAt)} — coordinators are released; every other member stays BLOCKED until its coordinator runs \`orchestra run release\`.`,
    );
  }
  if (st.reprise) out.push(...renderRepriseStatus(st.reprise, { countShownAbove: pauseLineCoversReprise(st.reprise, st.roster) }));
  out.push(`Bilan de pause (${st.bilan.length} member${st.bilan.length === 1 ? '' : 's'}):`);
  renderRows(st.bilan, out);
  out.push(
    p.resumeStartedAt
      ? 'Reprise in progress: killed commands are listed, never re-run automatically; containers the Pause stopped are restarted by the host BEFORE the coordinators are released; each member receives its Consigne de reprise when its coordinator releases it.'
      : 'Reprise: `orchestra run resume` starts it — nothing restarts on its own: only the coordinators are released (each gets the Bilan of its wave); workers stay blocked until their coordinator runs `orchestra run release`, which sends each its Consigne de reprise. Killed commands are listed, never re-run automatically.',
  );
  return `${out.join('\n')}\n`;
}

function renderRows(rows: BilanRow[], out: string[]): void {
  for (const r of rows) {
    const a = r.activity;
    const dirtyTxt =
      r.dirty === null ? 'unknown' : r.dirty ? `yes${a?.changed ? ` (${a.changed.modified} modified, ${a.changed.added} added, ${a.changed.deleted} deleted)` : ''}` : 'no';
    out.push(`  • ${c(r.wsId)}${a?.branch ? ` [${c(a.branch)}]` : ''} — dirty tree: ${dirtyTxt}`);
    if (a?.snapshotIncomplete) out.push(`      snapshot: INCOMPLETE (${c(a.snapshotIncomplete)}) — no ref was written; the interrupt and the kills still ran`);
    if (r.snapshotRef) out.push(`      snapshot: ${c(r.snapshotRef)}   (git diff ${a?.head ? c(a.head).slice(0, 9) : 'HEAD'} ${c(r.snapshotRef)} shows the uncommitted non-ignored work)`);
    if (a?.snapshotWarnings?.length) out.push(`      NOT captured (unreadable): ${c(a.snapshotWarnings.join(' | ')).slice(0, 300)}`);
    if (a?.skippedLarge?.length) out.push(`      not captured (too large): ${a.skippedLarge.slice(0, 20).map((f) => `${c(f.path)} (${mb(Number(f.bytes))}${f.files !== undefined ? `, ${c(f.files)} files` : ''}${f.reason === 'total-cap' ? ', total size cap' : ''})`).join(', ')}${(a.skippedLargeCount ?? a.skippedLarge.length) > Math.min(20, a.skippedLarge.length) ? `; +${(a.skippedLargeCount ?? a.skippedLarge.length) - Math.min(20, a.skippedLarge.length)} more` : ''}`);
    for (const n of a?.snapshotNotes ?? []) out.push(`      captured despite the cap: ${c(n)}`);
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
        // #282: a background task the CLI ended itself starts no task-notification turn; one ended by signal (a failed stop_task) may — say which, never silently
        const stopOk = (k.stopTask ?? []).filter((x) => x.ok), stopBad = (k.stopTask ?? []).filter((x) => !x.ok);
        if (stopOk.length) out.push(`      background task(s) ended through the CLI (stop_task — no task-notification turn): ${stopOk.slice(0, 6).map((x) => `${c(x.taskId)} (${short(x.cmd, 50)})`).join('; ')}${stopOk.length > 6 ? `; +${stopOk.length - 6} more` : ''}`);
        if (stopBad.length) out.push(`      stop_task FAILED (ended by signal instead — the CLI may have started a task-notification turn): ${stopBad.slice(0, 6).map((x) => `${c(x.taskId)} (${short(x.cmd, 50)}${x.note ? `: ${short(x.note, 60)}` : ''})`).join('; ')}`);
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
    if (a?.containers) {
      // #292: the attributed containers the Pause dure stopped (never removed) and what the Reprise did with them
      const ct = a.containers;
      const rs = new Map((ct.restarted ?? []).map((x) => [x.id, x]));
      const stopped = ct.stopped.filter((x) => x.outcome === 'stopped' || x.outcome === 'stopping'); // `stopping` = the app died mid-stop: the Reprise restarts it too
      if (stopped.length) {
        out.push(`      containers stopped by the Pause (${stopped.length}; stopped, never removed): ${stopped.slice(0, 8).map((x) => {
          const y = rs.get(x.id);
          return `${short(x.name || x.id, 40)} (${short(x.image, 40)}) → ${!y ? 'not restarted yet' : y.outcome === 'failed' ? `restart FAILED${y.error ? `: ${short(y.error, 60)}` : ''}` : y.outcome === 'gone' ? 'gone (removed meanwhile, skipped)' : y.outcome === 'already-running' ? 'already running' : 'restarted'}`;
        }).join('; ')}${stopped.length > 8 ? `; +${stopped.length - 8} more` : ''}`);
      }
      const skipped = ct.stopped.filter((x) => x.outcome === 'skipped-autoremove');
      if (skipped.length) out.push(`      containers NOT stopped (--rm: a stop would delete them): ${skipped.slice(0, 8).map((x) => short(x.name || x.id, 40)).join('; ')}`);
      const failedStops = ct.stopped.filter((x) => x.outcome === 'failed');
      if (failedStops.length) out.push(`      containers the Pause could NOT stop: ${failedStops.slice(0, 8).map((x) => `${short(x.name || x.id, 40)}${x.error ? ` (${short(x.error, 60)})` : ''}`).join('; ')}`);
      if (ct.error) out.push(`      containers: ${c(ct.error)}`);
    }
    for (const n of a?.notes ?? []) out.push(`      note: ${c(n)}`);
    if (r.error) out.push(`      error: ${c(r.error)}`);
  }
}
