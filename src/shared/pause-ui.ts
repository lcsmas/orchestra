// Fleet Pause — the UI half (#257, wave F ledger #281). WIRE shapes + PURE explainers shared by main (src/main/pause-ui.ts builds them)
// and the renderer. No bus, no store, no Electron. The state machine and the roster shapes stay in ./pause-lifecycle.ts (frozen, wave E);
// the Pause/Reprise WORDING is ./pause-douce.ts + ./pause-reprise-view.ts — this file only adds what the UI needs on top.

import type { PauseConfirmVia, PauseMemberRow, PauseMode, PausePhase } from './pause-lifecycle.ts';
import type { RepriseStatusView } from './pause-reprise-view.ts';

/** What a roster member looks like on screen. Derived ONLY from the phase + its roster row ({@link memberUiState}). */
export type PauseUiMemberState =
  | 'pausing' // Pause douce / dure taking it: not confirmed yet
  | 'paused' // confirmed (its accusé, the host seeing it idle, or the trap)
  | 'blocked' // Reprise running, its coordinator has not released it yet
  | 'released' // released, no reprise accusé yet
  | 'resumed'; // released + reprise accusé

export function memberUiState(
  phase: PausePhase,
  row: Pick<PauseMemberRow, 'pauseConfirmedAt' | 'releasedAt' | 'repriseConfirmedAt'>,
): PauseUiMemberState {
  if (phase === 'resuming' || row.releasedAt !== null) {
    if (row.releasedAt === null) return 'blocked';
    return row.repriseConfirmedAt !== null ? 'resumed' : 'released';
  }
  return row.pauseConfirmedAt !== null ? 'paused' : 'pausing';
}

/** A member's Bilan de pause, reduced to what a screen shows (the full row stays in `pause_records` / `orchestra run status`). */
export interface PauseUiBilanLine {
  /** `refs/orchestra/pause/<run>/<ws>/<ms>` — `git diff <head> <ref>` = the uncommitted non-ignored work. null = none taken (say why in `notes`/`error`). */
  snapshotRef: string | null;
  branch: string | null;
  head: string | null;
  dirty: boolean | null;
  changed: { modified: number; added: number; deleted: number } | null;
  /** The snapshot did not finish (a very large untracked tree): NO ref — the pause still interrupted and killed. */
  snapshotIncomplete: 'timeout' | null;
  wasDoing: { turnRunning: boolean; inFlight: string[]; bgTasks: string[]; lastTask: string | null };
  /** `BilanActivity.interrupt` as recorded (never reinterpreted). */
  interrupt: string | null;
  /** The pauser of a CLI pause (process ancestry): its turn was NOT interrupted. Never set for a UI pause (no CLI chain). */
  exempt: boolean;
  /** Commands killed — the trap's `killed_json` KillReport ∪ earlier incomplete attempts ∪ the turn observer's (the SAME merge the Consigne de reprise makes), listed, NEVER re-run; newest 12, `killedCount` is the total. */
  killed: Array<{ cmd: string; cwd: string | null; outcome: string | null }>;
  killedCount: number;
  /** `killed_json`: 'done' = a KillReport; 'pending' = NULL, the trap has not finished for this member (some of its commands may NOT have been killed); 'skipped' = `{skipped}` (a remote member: not applicable). */
  trap: 'done' | 'pending' | 'skipped';
  skipped: string | null;
  /** Tool-tree members still alive after the last round / planned kills the identity re-read REFUSED — the pause did NOT stop them. */
  survivors: Array<{ cmd: string; pid: number; reason: string }>;
  refused: Array<{ cmd: string; pid: number; reason: string }>;
  /** Files the snapshot could not read (everything else is in the ref). */
  warnings: string[];
  /** What the snapshot did NOT capture (too large): that worktree is the ONLY copy of it. `notCapturedCount` is the total (the list keeps the largest 6). */
  notCaptured: Array<{ path: string; bytes: number; files: number | null; reason: 'file-cap' | 'total-cap' | null }>;
  notCapturedCount: number;
  /** "captured despite the cap" notes (git < 2.25 could not exclude them: they ARE in the ref). */
  snapshotNotes: string[];
  /** Checked-out submodules snapshotted in their own repo (a failed one is NOT in any ref). */
  submodules: Array<{ path: string; ref: string | null; dirty: boolean; error: string | null }>;
  notes: string[];
  error: string | null;
}

export interface PauseUiMember {
  wsId: string;
  label: string;
  role: 'coordinator' | 'worker';
  memberRun: string | null;
  ui: PauseUiMemberState;
  confirmVia: PauseConfirmVia | null;
  confirmedAt: number | null;
  releasedAt: number | null;
  releasedBy: string | null;
  repriseConfirmedAt: number | null;
  /** null = the host trap has written no Bilan row for it yet (Pause douce still waiting, or the trap has not reached it). */
  bilan: PauseUiBilanLine | null;
}

/** "N/M en pause" while pausing/paused, "N/M repris" while resuming — the SAME numbers `orchestra bus-status` prints (`pauseRosterSummary`). */
export interface PauseUiProgress {
  kind: 'en-pause' | 'repris';
  done: number;
  total: number;
  /** ws ids not done yet, roster order. */
  missing: string[];
}

/** One pause CARRIER (a run whose own columns hold the pause) with its roster, Bilan and progress. */
export interface PauseUiRun {
  carrierRunId: string;
  /** The coordinator workspace's display name (run id == anchor workspace id for a wave run). */
  carrierLabel: string;
  title: string | null;
  /** `pausePhaseOf`: pausing (douce waiting) → paused → resuming; `active` only for a closed Reprise whose accusés are still tracked. */
  phase: PausePhase;
  mode: PauseMode | null;
  pausedAt: number | null;
  pausedBy: string | null;
  pausedByLabel: string | null;
  /** soft: when the host takes the stragglers (Pause dure). */
  deadlineAt: number | null;
  escalatedAt: number | null;
  /** When the host trap finished (the Bilan is complete). */
  trapAt: number | null;
  resumeStartedAt: number | null;
  /** Written by the host on a usage limit (#256), not by a human. */
  auto: boolean;
  progress: PauseUiProgress;
  /** Reprise: roster members not released yet (still BLOCKED). */
  blocked: string[];
  members: PauseUiMember[];
}

/** A workspace's pause state for a SIDEBAR BADGE — the gate's own answer (live-tree walk), then the roster row. */
export interface PauseUiWorkspaceState {
  wsId: string;
  carrierRunId: string;
  phase: PausePhase;
  ui: PauseUiMemberState;
  role: 'coordinator' | 'worker' | null;
  via: PauseConfirmVia | null;
}

export type PauseUiRefusalCode =
  | 'no-run'
  | 'refused'
  | 'switch-off'
  | 'not-paused'
  | 'not-resuming'
  | 'already-paused'
  | 'already-resuming'
  | 'covered'
  | 'bus-unavailable'
  | 'unknown-workspace'
  | 'write-failed';

/** Can the control be used right now, and if not WHY (so a control is explained before the click, never silently dead). */
export type PauseUiAvailability = { ok: true } | { ok: false; code: PauseUiRefusalCode };

/** The controls of one workspace row, resolved from the run it anchors. `anchored: false` = it coordinates no run (a worker). */
export interface PauseUiControl {
  wsId: string;
  /** The run the row's control acts on (a worker's = its orchestrator's run, where the writer REFUSES it by the hold rule). */
  runId: string;
  anchored: boolean;
  /** The run row's FROZEN `pause` switch (null = no run row). */
  switchOn: boolean | null;
  phase: PausePhase;
  /** A pause on ANOTHER run (an ancestor) governs this one: `run resume` here is `not-paused`, the Reprise starts there. */
  coveredBy: { runId: string; label: string } | null;
  can: { pauseSoft: PauseUiAvailability; pauseHard: PauseUiAvailability; resume: PauseUiAvailability; release: PauseUiAvailability };
}

export interface PauseUiOverview {
  /** false = the bus is not open / a read threw: `error` says why — NEVER an empty overview that looks like "nothing is paused". */
  available: boolean;
  error: string | null;
  at: number;
  /** Host-stamped, strictly increasing per main process: the renderer drops an overview OLDER than the one it holds (a write reply racing a fresher push). Absent on pure-layer results. */
  rev?: number;
  runs: PauseUiRun[];
  /** Per workspace id (non-archived workspaces only), for the sidebar controls. */
  controls: Record<string, PauseUiControl>;
  /** Per workspace id under a pause / Reprise (absent = not paused), for the sidebar badges. */
  byWorkspace: Record<string, PauseUiWorkspaceState>;
}

export function unavailableOverview(error: string, at: number): PauseUiOverview {
  return { available: false, error, at, runs: [], controls: {}, byWorkspace: {} };
}

// ── the explainers (French, like every other Pause string) ─────────────────────────────────────────────────────────────────

export interface PauseUiExplain {
  tone: 'error' | 'warn' | 'info';
  /** One line. */
  title: string;
  /** What happened and what was (not) written. */
  why: string;
  /** Short remedies, one per entry (a button label or a command). */
  fix: string[];
  /** A follow-up the human can take with ONE more explicit gesture (today only: "libérer aussi ces N" after a « tout libérer » left some below). A refusal never carries a button that pauses / resumes
   *  ANOTHER row for the human — it NAMES the run to act on (spec Q5: no shortcut). Absent = text only. */
  actions?: PauseUiExplainAction[];
}

export interface PauseUiExplainAction {
  kind: 'release';
  /** The workspace row the action is attributed to (the writer's actor). */
  wsId: string;
  /** The RESUMING carrier the release targets. */
  carrierRunId: string;
  /** Explicit roster ids (an explicit id releases any member the caller may). */
  ids: string[];
  label: string;
}

export interface ExplainCtx {
  /** Display names (the writer's raw ids stay in the result's `outcome`/`mayBe`). */
  label: (wsId: string) => string;
  runLabel: string;
  /** The run id, when known (named in a CLI remedy). */
  runId?: string;
  /** The workspace row the write was attributed to / the carrier a release targeted — what a follow-up button acts on. */
  actorId?: string;
  carrierRunId?: string;
  /** The message of a writer that THREW (`write-failed`). */
  error?: string;
  actorLabel: string;
  /** `runHoldAuthority(run)` coordinators who MAY act on the run (the run's coordinator, then the ancestors'). */
  mayBe: readonly string[];
  /** The ancestor pause governing this run (explains `not-paused` on a covered run). */
  cover: { runId: string; label: string } | null;
}

const join = (xs: readonly string[]): string => (xs.length ? xs.join(', ') : 'personne');

/** The `setRunPause` outcome (bus-pause.ts) → what to tell the human. `null` = a success (`paused` / `escalated` / `lifted`) — nothing to explain. */
export function explainPauseOutcome(outcome: string, c: ExplainCtx): PauseUiExplain | null {
  switch (outcome) {
    case 'no-run':
      return { tone: 'error', title: `Pas de run sur le bus pour ${c.runLabel}`, why: `${c.runLabel} n'a aucun run enregistré (jamais démarré comme vague, ou le bus l'ignore) : rien à mettre en pause, rien n'a été écrit.`, fix: [] };
    case 'refused':
      return {
        tone: 'error',
        title: `Pause refusée — ${c.actorLabel} n'est pas coordinateur de ${c.runLabel}`,
        why: `La pause se pose sur une vague, pas sur un agent seul : seul son coordinateur (${join(c.mayBe.slice(0, 1).map(c.label))}) ou un coordinateur d'une vague au-dessus (${join(c.mayBe.slice(1).map(c.label))}) la décide. Rien n'a été écrit.`,
        // NAMED, not offered as a button: the second entry pauses a WIDER run (everything under the ancestor), which must be a deliberate click on THAT row
        fix: c.mayBe.map((id, i) => (i === 0 ? `Pour ${c.actorLabel} : mettre en pause sa vague ${c.label(id)} (survol de la ligne ${c.label(id)} → ⏸)` : `Plus large : mettre ${c.label(id)} en pause suspend TOUTE sa vague, ${c.runLabel} comprise`)),
      };
    case 'switch-off':
      return {
        tone: 'error',
        title: 'Pause désactivée sur cette vague',
        why: `Le switch « Pause » était OFF quand ${c.runLabel} a démarré (il est figé au démarrage de la vague) : rien n'a été écrit, aucun agent touché.`,
        fix: ['Réglages › Fleet bus switches › Pause ON, puis une nouvelle vague', 'ou : orchestra run refreeze --run <id> (run de mission)'],
      };
    case 'already-paused':
      return { tone: 'info', title: `${c.runLabel} est déjà en pause`, why: "La pause garde son heure et son auteur d'origine. Si l'hôte l'avait posée sur une limite d'usage, elle devient manuelle : plus de reprise automatique.", fix: [] };
    case 'not-paused':
      return { tone: 'info', title: `${c.runLabel} n'est pas en pause`, why: 'Rien à lever.', fix: [] };
    case 'bus-unavailable':
      return { tone: 'error', title: 'Bus de flotte indisponible', why: "L'état de pause ne peut être ni lu ni écrit — rien n'a été changé. Le bus ne bloque pas le démarrage de l'app ; voir le journal (bus.sqlite).", fix: ["Page Bus", "Journal de l'app"] };
    case 'unknown-workspace':
      return { tone: 'error', title: 'Workspace inconnu', why: "Ce workspace n'existe plus dans le store : rien n'a été écrit.", fix: c.runId ? [`orchestra run resume --run ${c.runId} (CLI : la vague n'a plus de ligne dans la sidebar)`] : [] };
    case 'write-failed':
      return { tone: 'error', title: "Écriture refusée par le bus", why: `${c.error ?? 'erreur inconnue'} — rien n'est garanti écrit : relisez l'état (page Bus) avant de réessayer.`, fix: ['Page Bus', "Journal de l'app"] };
    default:
      return null;
  }
}

/** The `beginReprise` outcome (pause-reprise.ts) → what to tell the human. `null` = `resuming`. */
export function explainResumeOutcome(outcome: string, c: ExplainCtx): PauseUiExplain | null {
  switch (outcome) {
    case 'no-run':
      return explainPauseOutcome('no-run', c);
    case 'refused':
      return {
        tone: 'error',
        title: `Reprise refusée — ${c.actorLabel} n'est pas coordinateur de ${c.runLabel}`,
        why: `Seul le coordinateur de ${c.runLabel} (${join(c.mayBe.slice(0, 1).map(c.label))}) ou d'une vague au-dessus (${join(c.mayBe.slice(1).map(c.label))}) la reprend. Rien n'a été écrit.`,
        fix: c.mayBe.map((id) => `Reprendre depuis ${c.label(id)} (survol de sa ligne → ▶)`),
      };
    case 'not-paused':
      return c.cover
        ? { tone: 'info', title: `${c.cover.label} tient déjà ${c.runLabel} en pause`, why: `${c.runLabel} n'a pas de pause propre : c'est celle de ${c.cover.label}. Reprenez depuis ${c.cover.label}.`, fix: [`Reprendre ${c.cover.label} (survol de sa ligne → ▶)`] }
        : { tone: 'info', title: `${c.runLabel} n'est pas en pause`, why: 'Rien à reprendre.', fix: [] };
    case 'already-resuming':
      return { tone: 'info', title: `La reprise de ${c.runLabel} est déjà en cours`, why: 'Rien n\'est renvoyé : les coordinateurs ont déjà reçu leur Bilan ; libérez les workers bloqués.', fix: ['Libérer les bloqués'] };
    case 'bus-unavailable':
    case 'unknown-workspace':
    case 'write-failed':
      return explainPauseOutcome(outcome, c);
    default:
      return null;
  }
}

/** A `releaseMembers` result (pause-reprise.ts `ReleaseResult`, passed through untouched) → the lines to show. Empty = fully released, nothing to say. */
export function explainReleaseResult(
  r: {
    error: 'no-run' | 'not-paused' | 'not-resuming' | null;
    refused: ReadonlyArray<{ wsId: string; mayBe: string[] }>;
    below: readonly string[];
    unknown: readonly string[];
    already: readonly string[];
  } | null,
  c: ExplainCtx & { all: boolean },
): PauseUiExplain[] {
  if (!r) return [explainPauseOutcome('bus-unavailable', c)!];
  const out: PauseUiExplain[] = [];
  if (r.error === 'no-run') out.push(explainPauseOutcome('no-run', c)!);
  else if (r.error === 'not-paused') out.push({ tone: 'info', title: `${c.runLabel} n'est pas en pause`, why: 'Rien à libérer.', fix: [] });
  else if (r.error === 'not-resuming') out.push({ tone: 'warn', title: `${c.runLabel} est en pause, pas en reprise`, why: 'On libère pendant la Reprise : démarrez-la d\'abord.', fix: [`Reprendre ${c.runLabel}`] });
  if (r.refused.length) {
    out.push({
      tone: 'error',
      title: `${r.refused.length} agent${r.refused.length > 1 ? 's' : ''} d'un autre coordinateur — non libéré${r.refused.length > 1 ? 's' : ''}`,
      why: r.refused.map((x) => `${c.label(x.wsId)} (libérable par ${join(x.mayBe.map(c.label))})`).join(' ; ') + `. ${c.actorLabel} n'a pas l'autorité. Rien n'a été écrit pour eux.`,
      fix: [],
    });
  }
  if (r.below.length) {
    out.push({
      tone: 'warn',
      title: `Tout libérer : ${r.below.length} agent${r.below.length > 1 ? 's' : ''} laissé${r.below.length > 1 ? 's' : ''} à leur coordinateur`,
      why: `${r.below.map(c.label).join(', ')} appartiennent à une vague en dessous de ${c.actorLabel} : « tout libérer » ne libère que les membres de sa propre vague (comme \`orchestra run release --all\`) ; leur coordinateur les libère, ou vous les libérez ici d'un geste de plus.`,
      fix: [],
      ...(c.actorId && c.carrierRunId
        ? { actions: [{ kind: 'release' as const, wsId: c.actorId, carrierRunId: c.carrierRunId, ids: r.below.slice(), label: `Libérer aussi ces ${r.below.length} : ${r.below.slice(0, 3).map(c.label).join(', ')}${r.below.length > 3 ? '…' : ''}` }] }
        : {}),
    });
  }
  if (r.unknown.length) {
    out.push({ tone: 'error', title: `${r.unknown.length} cible${r.unknown.length > 1 ? 's' : ''} hors de la Reprise`, why: `Aucun membre ne correspond à : ${r.unknown.join(', ')}.`, fix: [] });
  }
  if (r.already.length && !c.all) out.push({ tone: 'info', title: 'Déjà libéré', why: r.already.map(c.label).join(', '), fix: [] });
  return out;
}

/** Pre-click availability from what the overview knows (the writer stays the authority; this only decides what to grey out AND explain). */
export function availabilityFor(i: {
  anchored: boolean;
  runKnown: boolean;
  switchOn: boolean | null;
  phase: PausePhase;
  covered: boolean;
}): PauseUiControl['can'] {
  const no = (code: PauseUiRefusalCode): PauseUiAvailability => ({ ok: false, code });
  const ok: PauseUiAvailability = { ok: true };
  if (!i.runKnown) return { pauseSoft: no('no-run'), pauseHard: no('no-run'), resume: no('no-run'), release: no('no-run') };
  // a worker's control is shown (so the click is EXPLAINED, not silently absent): the writer refuses it by the hold rule
  const authority = i.anchored ? ok : no('refused');
  const pausable: PauseUiAvailability = i.switchOn === false ? no('switch-off') : authority;
  const active = i.phase === 'active';
  return {
    pauseSoft: active ? pausable : i.phase === 'resuming' ? pausable : no('already-paused'),
    pauseHard: i.phase === 'active' || i.phase === 'pausing' || i.phase === 'resuming' ? pausable : no('already-paused'),
    resume: i.phase === 'active' ? (i.covered ? no('covered') : no('not-paused')) : i.phase === 'resuming' ? no('already-resuming') : authority,
    release: i.phase === 'resuming' ? authority : no('not-resuming'),
  };
}

// ── write results (what crosses the IPC) ───────────────────────────────────────────────────────────────────────────────────

/** The writers' typed outcomes, passed through untouched (`RunPauseOutcome` ∪ `RepriseOutcome`, compile-checked in src/main/pause-ui.ts) + the two that mean NO writer ran. */
export type PauseUiWriteOutcome =
  | 'paused'
  | 'already-paused'
  | 'escalated'
  | 'lifted'
  | 'not-paused'
  | 'no-run'
  | 'refused'
  | 'switch-off'
  | 'resuming'
  | 'already-resuming'
  | 'bus-unavailable'
  | 'unknown-workspace'
  | 'write-failed';

export interface PauseUiWriteResult {
  /** The writer's outcome, untouched — or 'bus-unavailable' / 'unknown-workspace' when no writer ran. */
  outcome: PauseUiWriteOutcome;
  /** The run the write targeted (null = the workspace is unknown). */
  runId: string | null;
  /** The handle the writer saw (`paused_by` for a pause) — the workspace row the control belongs to. */
  actor: string | null;
  /** `null` = a success (nothing to explain). */
  explain: PauseUiExplain | null;
  /** The ancestor pause that governs this run, when a resume found nothing of its own to lift. */
  cover: { runId: string; label: string } | null;
  /** Resume only: the run's liveness hold was lifted too (`orchestra run resume` does both). */
  holdLifted?: boolean;
  overview: PauseUiOverview;
}

/** `ReleaseResult` (src/main/pause-reprise.ts), field for field (compile-checked in src/main/pause-ui.ts). */
export interface PauseUiReleaseRaw {
  error: 'no-run' | 'not-paused' | 'not-resuming' | null;
  phase: PausePhase | null;
  released: string[];
  already: string[];
  refused: Array<{ wsId: string; mayBe: string[] }>;
  below: string[];
  unknown: string[];
  finished: boolean;
}

export interface PauseUiReleaseResult {
  /** The writer's result, untouched (null = no writer ran). */
  result: PauseUiReleaseRaw | null;
  runId: string | null;
  carrierRunId: string | null;
  actor: string | null;
  explain: PauseUiExplain[];
  overview: PauseUiOverview;
}

export type { RepriseStatusView };
