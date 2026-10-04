// Pause douce (#254, wave E ledger #276 D4) — the PURE half: the order a member reads, the roster line bus-status prints.
// State machine + roster shapes are the frozen interface in ./pause-lifecycle.ts; the bus/host half is src/main/pause-douce.ts.

import { SOFT_PAUSE_DEADLINE_MS, type PauseMemberRow, type PausePhase, type PauseRosterSummary } from './pause-lifecycle.ts';

/** When a Pause douce stops waiting and the host takes the stragglers (`paused_at + 3 min`). */
export function softDeadlineAt(pausedAt: number): number {
  return pausedAt + SOFT_PAUSE_DEADLINE_MS;
}

/** The pause order: the body of the member's `kind='pause'` bus row AND the text its tool-result hook injects. */
export function renderPauseOrder(o: { carrierRunId: string; deadlineAt: number }): string {
  return [
    `[orchestra] PAUSE DOUCE — run ${o.carrierRunId}: no new réveil, turn or spawn will start.`,
    'Finish ONLY the command running now (start no other), commit and push your own work, then run: orchestra run confirm pause',
    `Not confirmed by ${new Date(o.deadlineAt).toISOString()} → the host takes you to Pause dure: your worktree is snapshotted to refs/orchestra/pause/…, running commands are killed (listed in the Bilan, never re-run). Ignore this if the pause was lifted or a later 'reprise' row supersedes it.`,
  ].join('\n');
}

/** `N/M en pause — manquent : a, b` (`repris` while resuming). `label` renders a ws id (the app passes the workspace name). */
export function renderPauseRosterLine(
  s: PauseRosterSummary,
  opts: { label?: (wsId: string) => string } = {},
): string {
  const word = s.phase === 'resuming' ? 'repris' : 'en pause';
  const head = `${s.done}/${s.total} ${word}`;
  if (s.missing.length === 0) return head;
  const label = opts.label ?? ((id: string) => id);
  return `${head} — manquent : ${s.missing.map(label).join(', ')}`;
}

/** The one-line phase word the pause line leads with. */
export function pausePhaseWord(phase: PausePhase, mode: string | null): string {
  if (phase === 'pausing') return 'Pause douce en cours';
  if (phase === 'resuming') return 'Reprise en cours';
  return mode === 'soft' ? 'Pause douce → dure (escaladée)' : 'Pause dure';
}

/** What `bus-status` / `run status` read about the pause governing a run (JSON-safe: it crosses the app socket). */
export interface PauseStatusView {
  carrierRunId: string;
  mode: string | null;
  phase: PausePhase;
  pausedAt: number;
  pausedBy: string | null;
  deadlineAt: number | null;
  escalatedAt: number | null;
  trapAt: number | null;
  summary: PauseRosterSummary;
  rows: PauseMemberRow[];
}

/** The one `pause:` line of `orchestra bus-status`. */
export function renderPauseStatusLine(v: PauseStatusView, opts: { label?: (wsId: string) => string; now?: number } = {}): string {
  const roster =
    v.summary.total === 0
      ? 'aucun membre inscrit (l\'hôte n\'a pas encore réagi — app arrêtée ?)'
      : renderPauseRosterLine(v.summary, opts);
  let tail = '';
  if (v.phase === 'pausing' && v.deadlineAt !== null) {
    const left = opts.now === undefined ? null : Math.max(0, Math.round((v.deadlineAt - opts.now) / 1000));
    tail = ` — Pause dure à ${new Date(v.deadlineAt).toISOString()}${left === null ? '' : ` (dans ${left}s)`} pour les retardataires`;
  }
  return `${pausePhaseWord(v.phase, v.mode)} — ${roster}${tail}`;
}
