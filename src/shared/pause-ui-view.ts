// Fleet Pause — the PURE view derivations the UI components share (#257, wave F ledger #281): words, tones, countdowns, headlines, Bilan summaries. No React, no bus.
// The numbers are the SAME ones `orchestra bus-status` prints (`PauseUiProgress` ← `pauseRosterSummary`); the wording reuses ./pause-douce.ts (`pausePhaseWord`).

import { pausePhaseWord } from './pause-douce.ts';
import type { PauseUiBilanLine, PauseUiControl, PauseUiMember, PauseUiMemberState, PauseUiOverview, PauseUiRun, PauseUiWorkspaceState } from './pause-ui.ts';

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
  // an EMPTY roster is "the host has not reacted yet" (it enrols within a sweep; the CLI says the same) — never "0/0 en pause" next to a full bar
  const count = total === 0 && run.phase !== 'active' ? "en attente de l'hôte" : run.progress.kind === 'repris' ? `${done}/${total} repris` : `${done}/${total} en pause`;
  if (run.phase === 'active') {
    return { tone: 'resumed', title: 'Reprise : accusés en attente', count, sub: run.progress.missing.length ? `${run.progress.missing.length} accusé${run.progress.missing.length > 1 ? 's' : ''} manquant${run.progress.missing.length > 1 ? 's' : ''}` : 'tous les accusés sont reçus', fraction };
  }
  // an AUTO pause says who wrote it (« l'hôte (limite d'usage) » / « l'hôte (mémoire) », the host's own label); the usage-limit wording is only the fallback when no label is known (#290: it used to be hard-coded for EVERY auto pause)
  const by = run.auto ? (run.pausedByLabel ? `posée par ${run.pausedByLabel}` : 'posée par l\'hôte (limite d\'usage)') : run.pausedByLabel ? `posée par ${run.pausedByLabel}` : 'posée';
  const when = run.pausedAt !== null ? ` ${agoText(run.pausedAt, now)}` : '';
  if (run.phase === 'pausing') {
    const dl = run.deadlineAt !== null ? ` · Pause dure dans ${countdown(run.deadlineAt, now)} pour les retardataires` : '';
    return { tone: 'pausing', title: pausePhaseWord('pausing', run.mode), count, sub: `${by}${when}${dl}`, fraction };
  }
  if (run.phase === 'resuming') {
    const released = run.members.filter((m) => m.releasedAt !== null).length;
    return { tone: 'resumed', title: pausePhaseWord('resuming', run.mode), count, sub: `${released}/${total} libérés · ${run.blocked.length} bloqué${run.blocked.length > 1 ? 's' : ''}`, fraction };
  }
  return { tone: 'paused', title: pausePhaseWord('paused', run.mode), count, sub: `${by}${when}`, fraction };
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

/** "2 outils tués" · "aucun outil tué" · "trap en cours" (killed_json NULL) · "non applicable" (a remote member) · "pauseur exempté" (a CLI pause only) — plus "⚠ N encore vivant" when a tool survived the last round. */
export function killedText(b: PauseUiBilanLine | null): string {
  if (!b) return '';
  if (b.exempt) return 'pauseur exempté';
  if (b.trap === 'pending') return 'trap en cours';
  if (b.trap === 'skipped') return 'non applicable';
  const base = b.killedCount === 0 ? 'aucun outil tué' : `${b.killedCount} outil${b.killedCount > 1 ? 's' : ''} tué${b.killedCount > 1 ? 's' : ''}`;
  const n = b.survivors.length;
  return n > 0 ? `${base} · ⚠ ${n} encore vivant${n > 1 ? 's' : ''}` : base;
}

/** "3,0 Go" / "800 Mo" / "4,2 Mo" — French decimals, one under 10 of the unit. */
export function sizeText(bytes: number): string {
  const mo = bytes / 1048576;
  const f = (n: number) => (n < 10 ? n.toFixed(1) : String(Math.round(n))).replace('.', ',');
  return mo >= 1024 ? `${f(mo / 1024)} Go` : `${f(mo)} Mo`;
}

/** Everything in a Bilan row that needs a human's eyes, worst first — shown under the row, never dropped (an error, a survivor, an unconfirmed interrupt, an incomplete snapshot, unreadable files, a trap still owed). */
export function bilanAttention(b: PauseUiBilanLine | null): Array<{ tone: 'error' | 'warn' | 'info'; text: string }> {
  if (!b) return [];
  const out: Array<{ tone: 'error' | 'warn' | 'info'; text: string }> = [];
  // a workspace with no git worktree (a scratch session, an ORCHESTRATOR) cannot be snapshotted — the trap records "not a git repository" for every such member on every pause: expected, not an alarm
  if (b.error && b.snapshotRef === null && /not a git repository/i.test(b.error)) out.push({ tone: 'info', text: "pas un dépôt git : rien n'a pu être snapshotté (workspace scratch / orchestrateur, sans worktree)" });
  else if (b.error) out.push({ tone: 'error', text: `erreur : ${b.error}` });
  for (const x of b.survivors) out.push({ tone: 'error', text: `encore vivant après la pause : ${x.cmd} (pid ${x.pid}) — ${x.reason}` });
  if (b.trap === 'pending') out.push({ tone: 'warn', text: "le trap n'est pas terminé pour cet agent : certaines de ses commandes peuvent ne pas avoir été tuées" });
  for (const x of b.refused) out.push({ tone: 'warn', text: `non tué (identité non prouvée) : ${x.cmd} — ${x.reason}` });
  if (b.snapshotIncomplete) out.push({ tone: 'warn', text: 'snapshot incomplet (trop volumineux) : aucune ref — son worktree est la seule copie du travail non commité' });
  // what the snapshot did NOT capture — the worktree is the ONLY copy of it (the same facts `orchestra run status` prints: "not captured (too large)", "submodule …: snapshot failed")
  if (b.notCapturedCount > 0) {
    const shown = b.notCaptured.map((f) => `${f.path} (${sizeText(f.bytes)}${f.files !== null ? `, ${f.files} fichiers` : ''}${f.reason === 'total-cap' ? ', plafond total' : ''})`).join(', ');
    out.push({ tone: 'warn', text: `NON capturé dans le snapshot (trop volumineux, ${b.notCapturedCount}) : ${shown}${b.notCapturedCount > b.notCaptured.length ? `, +${b.notCapturedCount - b.notCaptured.length} autres` : ''} — son worktree en est la seule copie` });
  }
  for (const m of b.submodules) {
    if (m.error) out.push({ tone: 'warn', text: `submodule ${m.path} : snapshot échoué (${m.error}) — absent de toute ref` });
    else out.push({ tone: 'info', text: `submodule ${m.path} : ${m.dirty ? 'modifié, ' : ''}ref ${m.ref ?? '—'}` });
  }
  for (const n of b.snapshotNotes) out.push({ tone: 'info', text: `capturé malgré le plafond : ${n}` });
  for (const w of b.warnings) out.push({ tone: 'warn', text: `absent du snapshot (illisible) : ${w}` });
  if (b.interrupt === 'unresponsive' || b.interrupt === 'failed') out.push({ tone: 'warn', text: `interruption non confirmée (${b.interrupt}) : son tour a pu continuer` });
  if (b.trap === 'skipped' && b.skipped) out.push({ tone: 'info', text: `non applicable : ${b.skipped}` });
  for (const n of b.notes.slice(-3)) out.push({ tone: 'info', text: n });
  return out;
}

/** A roster member with NO Bilan row: 'absent' once the trap ran (every member should have one) or when a trap that was OWED never finished (`trapOwed`: a dure, or an escalated douce — a failed trap leaves members
 *  without a Bilan); 'pending' while it is still coming (a douce waiting, a dure in progress); 'none' when no trap was ever owed (a douce cancelled before it escalated — nothing interrupted, no alarm, R2-2) or the
 *  Reprise is closed (the pause columns are cleared: nothing left to tell the two apart). */
export function noBilanState(run: Pick<PauseUiRun, 'phase' | 'trapAt' | 'mode' | 'escalatedAt'>): 'pending' | 'absent' | 'none' {
  if (run.trapAt !== null) return 'absent';
  if (run.phase === 'pausing' || run.phase === 'paused') return 'pending';
  if (run.phase === 'active') return 'none';
  return run.mode !== 'soft' || run.escalatedAt !== null ? 'absent' : 'none';
}

/** Everything a Bilan row needs a human's eyes on — a member WITHOUT a Bilan (past the trap) included: nothing was snapshotted or killed for it, its worktree is the only copy. */
export function memberAttention(b: PauseUiBilanLine | null, run: Pick<PauseUiRun, 'phase' | 'trapAt' | 'mode' | 'escalatedAt'>): Array<{ tone: 'error' | 'warn' | 'info'; text: string }> {
  if (b) return bilanAttention(b);
  return noBilanState(run) === 'absent' ? [{ tone: 'warn', text: "aucun Bilan pour cet agent : rien n'a été snapshotté ni tué à la pause — son worktree est la seule copie du travail non commité" }] : [];
}

/** The overview the renderer should hold: `next`, unless it is OLDER than `cur` (host-stamped `rev` on both) — a write reply racing a fresher push, a boot read racing the first push. */
export function newerOverview(cur: PauseUiOverview | null, next: PauseUiOverview): PauseUiOverview {
  return cur !== null && cur.rev !== undefined && next.rev !== undefined && next.rev < cur.rev ? cur : next;
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

/** What « tout libérer » (`orchestra run release --all`) covers for the carrier's own row, and what it leaves `below`: the blocked WORKERS of the carrier's own run are its own; a blocked member of a run
 *  BELOW (another coordinator's wave) is not — the writer returns it as `below` and the UI offers a second, explicit gesture. */
export function releaseScope(run: PauseUiRun): { own: string[]; below: string[] } {
  const own: string[] = [];
  const below: string[] = [];
  for (const m of run.members) {
    if (m.ui !== 'blocked') continue;
    if (m.role === 'worker' && m.memberRun !== null && m.memberRun !== run.carrierRunId) below.push(m.wsId);
    else own.push(m.wsId);
  }
  return { own, below };
}

/** The « Libérer tout » button's label, honest about its scope (never counts the workers it will NOT release). */
export function releaseLabel(sc: { own: readonly string[]; below: readonly string[] }): string {
  const n = sc.own.length;
  const m = sc.below.length;
  if (n === 0) return `Libérer… (${m} plus bas, à part)`;
  return `Libérer ${n} bloqué${n > 1 ? 's' : ''}${m > 0 ? ` (+${m} plus bas, à part)` : ''}`;
}

/** EVERY blocked member, as explicit ids — what a per-member « Libérer » and the second gesture (« libérer aussi ces N ») send (an explicit id releases any member the caller may). */
export function releasableIds(run: PauseUiRun): string[] {
  return run.members.filter((m) => m.ui === 'blocked').map((m) => m.wsId);
}

// ── selectors over the overview (the store slice) ─────────────────────────────────────────────────────


/** The badge state of a workspace (null = not under a pause / Reprise, or the overview is not loaded). */
export function pauseStateOf(o: PauseUiOverview | null | undefined, wsId: string): PauseUiWorkspaceState | null {
  return o?.byWorkspace[wsId] ?? null;
}

/** The control of an ORCHESTRATOR row (null for a worker row, an unloaded overview, or a bus that is down). */
export function controlOf(o: PauseUiOverview | null | undefined, wsId: string): PauseUiControl | null {
  return o?.controls[wsId] ?? null;
}

/** The pause carrier a row's control is about: the run it anchors (its own pause, its Reprise, or a closed Reprise still collecting accusés). null = nothing to show. */
export function runOfControl(o: PauseUiOverview | null | undefined, ctl: PauseUiControl | null): PauseUiRun | null {
  if (!o || !ctl) return null;
  return o.runs.find((r) => r.carrierRunId === ctl.runId) ?? null;
}

/** The run whose pause COVERS this row (an ancestor's) — what a "covered" row points the human to. */
export function coveringRun(o: PauseUiOverview | null | undefined, ctl: PauseUiControl | null): PauseUiRun | null {
  if (!o || !ctl?.coveredBy) return null;
  return o.runs.find((r) => r.carrierRunId === ctl.coveredBy!.runId) ?? null;
}

// ── sidebar row parts ─────────────────────────────────────────────────────────────────────────────────

/** The orchestrator row's note line while its run holds a pause / Reprise (mockup A2–A4): "Pause douce · 5/7 · dure dans 1:50" · "En pause · 7/7 · depuis 8 min" · "Reprise · 3/7 repris · 3 bloqués". */
export function rowNoteText(run: PauseUiRun, now: number): { tone: PauseTone; text: string; fraction: number } {
  const { done, total } = run.progress;
  const fraction = total > 0 ? Math.min(1, done / total) : 0;
  if (total === 0 && run.phase !== 'active') {
    const word = run.phase === 'resuming' ? 'Reprise' : run.mode === 'soft' && run.phase === 'pausing' ? 'Pause douce' : 'Pause dure';
    return { tone: run.phase === 'resuming' ? 'resumed' : run.phase === 'pausing' ? 'pausing' : 'paused', text: `${word} · en attente de l'hôte`, fraction: 0 };
  }
  if (run.phase === 'pausing') {
    const left = run.deadlineAt !== null ? ` · dure dans ${countdown(run.deadlineAt, now)}` : '';
    return { tone: 'pausing', text: `Pause douce · ${done}/${total}${left}`, fraction };
  }
  if (run.phase === 'resuming') {
    return { tone: 'resumed', text: `Reprise · ${done}/${total} repris · ${run.blocked.length} bloqué${run.blocked.length > 1 ? 's' : ''}`, fraction };
  }
  const since = run.pausedAt !== null ? ` · ${agoText(run.pausedAt, now).replace('il y a ', 'depuis ')}` : '';
  return { tone: 'paused', text: `En pause${run.mode === 'soft' ? ' (douce → dure)' : ''} · ${done}/${total}${since}`, fraction };
}

/** How many agents a pause on `wsId` concerns: itself + every descendant on the live `parentId` tree (what the menu says before the click). */
export function agentsUnder(wsId: string, workspaces: ReadonlyArray<{ id: string; parentId?: string; archived?: boolean }>): number {
  const kids = new Map<string, string[]>();
  for (const w of workspaces) if (!w.archived && w.parentId) kids.set(w.parentId, [...(kids.get(w.parentId) ?? []), w.id]);
  const seen = new Set<string>([wsId]);
  const queue = [wsId];
  while (queue.length) for (const k of kids.get(queue.shift()!) ?? []) if (!seen.has(k)) { seen.add(k); queue.push(k); }
  return seen.size;
}

/** ` pause-dim` for a workspace that is HELD (pausing / paused / blocked) — not one that is released / back (it runs again, its name reads normal). */
export function pauseDimClass(o: PauseUiOverview | null | undefined, wsId: string): string {
  const st = pauseStateOf(o, wsId);
  return st && (st.ui === 'pausing' || st.ui === 'paused' || st.ui === 'blocked') ? ' pause-dim' : '';
}
