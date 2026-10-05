// Fleet Pause — the PURE view derivations the UI components share (#257, wave F ledger #281): words, tones, countdowns, headlines, Bilan summaries. No React, no bus.
// The numbers are the SAME ones `orchestra bus-status` prints (`PauseUiProgress` ← `pauseRosterSummary`); the wording reuses ./pause-douce.ts (`pausePhaseWord`).

import { pausePhaseWord } from './pause-douce.ts';
import type { PauseUiBilanLine, PauseUiMember, PauseUiMemberState, PauseUiRun } from './pause-ui.ts';

/** A member's badge word (the mockups' vocabulary: "en pause" / "finit…" / "bloqué" / "libéré" / "repris"). */
export const PAUSE_STATE_WORD: Record<PauseUiMemberState, string> = {
  pausing: 'finit…',
  paused: 'en pause',
  blocked: 'bloqué',
  released: 'libéré',
  resumed: 'repris',
};

/** The colour family of a state: amber = still being taken, blue = held, green = back. */
export type PauseTone = 'pausing' | 'paused' | 'resumed';
export function stateTone(ui: PauseUiMemberState): PauseTone {
  return ui === 'pausing' ? 'pausing' : ui === 'paused' || ui === 'blocked' ? 'paused' : 'resumed';
}

/** `m:ss` left until `deadlineAt` (clamped at 0:00). */
export function countdown(deadlineAt: number, now: number): string {
  const s = Math.max(0, Math.round((deadlineAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "il y a 8 min" / "il y a <1 min". */
export function agoText(since: number, now: number): string {
  const m = Math.floor(Math.max(0, now - since) / 60_000);
  return m < 1 ? "il y a <1 min" : `il y a ${m} min`;
}

export interface PauseHeadline {
  tone: PauseTone;
  /** "Pause douce en cours" / "Pause dure" / "Pause douce → dure (escaladée)" / "Reprise en cours" / "Reprise : accusés en attente". */
  title: string;
  /** "5/7 en pause" / "3/7 repris". */
  count: string;
  /** The line under the title: who, when, and (douce waiting) when the host takes the stragglers. */
  sub: string;
  /** 0..1 */
  fraction: number;
}

/** The one-glance summary of a run's pause (sidebar strip/card header, Bus page header). `label` renders ws ids. */
export function runHeadline(run: PauseUiRun, now: number): PauseHeadline {
  const { done, total } = run.progress;
  const fraction = total > 0 ? Math.min(1, done / total) : 0;
  const count = run.progress.kind === 'repris' ? `${done}/${total} repris` : `${done}/${total} en pause`;
  if (run.phase === 'active') {
    return { tone: 'resumed', title: 'Reprise : accusés en attente', count, sub: run.progress.missing.length ? `${run.progress.missing.length} accusé${run.progress.missing.length > 1 ? 's' : ''} manquant${run.progress.missing.length > 1 ? 's' : ''}` : 'tous les accusés sont reçus', fraction };
  }
  const by = run.auto ? 'posée par l\'hôte (limite d\'usage)' : run.pausedByLabel ? `posée par ${run.pausedByLabel}` : 'posée';
  const when = run.pausedAt !== null ? ` ${agoText(run.pausedAt, now)}` : '';
  if (run.phase === 'pausing') {
    const dl = run.deadlineAt !== null ? ` · Pause dure dans ${countdown(run.deadlineAt, now)} pour les retardataires` : '';
    return { tone: 'pausing', title: pausePhaseWord('pausing', run.mode), count, sub: `${by}${when}${dl}`, fraction };
  }
  if (run.phase === 'resuming') {
    const released = run.members.filter((m) => m.releasedAt !== null).length;
    return { tone: 'resumed', title: pausePhaseWord('resuming', run.mode), count, sub: `${released}/${total} libérés · ${run.blocked.length} bloqué${run.blocked.length > 1 ? 's' : ''}`, fraction };
  }
  return { tone: 'paused', title: pausePhaseWord('paused', run.mode), count, sub: `${by}${when}`, fraction: 1 };
}

/** What the Bilan line says about the worktree: "propre" · "3 modifiés · 1 ajouté" · "pas encore de Bilan". */
export function treeText(b: PauseUiBilanLine | null): string {
  if (!b) return 'pas encore de Bilan';
  if (b.snapshotIncomplete === 'timeout') return 'snapshot incomplet (trop volumineux)';
  if (b.dirty === false) return 'arbre propre';
  const c = b.changed;
  if (!c) return b.dirty ? 'modifié' : '—';
  const parts = [c.modified ? `${c.modified} modifié${c.modified > 1 ? 's' : ''}` : '', c.added ? `${c.added} ajouté${c.added > 1 ? 's' : ''}` : '', c.deleted ? `${c.deleted} supprimé${c.deleted > 1 ? 's' : ''}` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'modifié';
}

/** "2 outils tués" · "aucun outil tué" · "pauseur exempté" (a CLI pause only). */
export function killedText(b: PauseUiBilanLine | null): string {
  if (!b) return '';
  if (b.exempt) return 'pauseur exempté';
  return b.killedCount === 0 ? 'aucun outil tué' : `${b.killedCount} outil${b.killedCount > 1 ? 's' : ''} tué${b.killedCount > 1 ? 's' : ''}`;
}

/** What the member was doing when the pause landed: the in-flight command / background task, else "au repos". */
export function wasDoingText(b: PauseUiBilanLine | null): string {
  if (!b) return '—';
  const d = b.wasDoing;
  if (d.inFlight.length) return d.inFlight[0];
  if (d.bgTasks.length) return d.bgTasks[0];
  return d.turnRunning ? 'un tour en cours' : 'au repos';
}

/** Roster members grouped under the run they belong to, coordinators first (the Bus page's Bilan groups). */
export function groupByMemberRun(members: readonly PauseUiMember[]): Array<{ runId: string | null; members: PauseUiMember[] }> {
  const order: Array<string | null> = [];
  const by = new Map<string | null, PauseUiMember[]>();
  for (const m of members) {
    if (!by.has(m.memberRun)) { by.set(m.memberRun, []); order.push(m.memberRun); }
    by.get(m.memberRun)!.push(m);
  }
  return order.map((runId) => ({ runId, members: by.get(runId)!.slice().sort((a, b) => Number(b.role === 'coordinator') - Number(a.role === 'coordinator')) }));
}

/** The ids "Libérer les N bloqués" sends — EXPLICIT (an explicit id releases any member the caller may; `'all'` is the acting row's own run only and would leave a nested wave's workers `below`). */
export function releasableIds(run: PauseUiRun): string[] {
  return run.members.filter((m) => m.ui === 'blocked').map((m) => m.wsId);
}
