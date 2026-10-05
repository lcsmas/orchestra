import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  availabilityFor,
  explainPauseOutcome,
  explainReleaseResult,
  explainResumeOutcome,
  explainWorkerRow,
  memberUiState,
  type ExplainCtx,
} from './pause-ui.ts';
import { actorText, PAUSE_HUMAN_BY } from './pause-lifecycle.ts';

const label = (id: string): string => ({ L: 'fleet-lead', O: 'wave-ops', w: 'worker' } as Record<string, string>)[id] ?? id;
const ctx: ExplainCtx = { label, runLabel: 'wave-ops', runId: 'O', actorLabel: 'worker', mayBe: ['O', 'L'], cover: null };

test('memberUiState: the phase + the roster row decide, nothing else', () => {
  const row = (c: number | null, r: number | null, a: number | null) => ({ pauseConfirmedAt: c, releasedAt: r, repriseConfirmedAt: a });
  assert.equal(memberUiState('pausing', row(null, null, null)), 'pausing');
  assert.equal(memberUiState('pausing', row(5, null, null)), 'paused');
  assert.equal(memberUiState('paused', row(null, null, null)), 'pausing', 'a hard pause whose trap has not taken the member yet');
  assert.equal(memberUiState('paused', row(5, null, null)), 'paused');
  assert.equal(memberUiState('resuming', row(5, null, null)), 'blocked');
  assert.equal(memberUiState('resuming', row(5, 9, null)), 'released');
  assert.equal(memberUiState('resuming', row(5, 9, 11)), 'resumed');
  assert.equal(memberUiState('active', row(5, 9, null)), 'released', 'a closed Reprise (pause columns cleared) still tracks the accusé');
});

test('explainPauseOutcome: a success explains nothing; every refusal names what was (not) written', () => {
  for (const ok of ['paused', 'escalated', 'lifted']) assert.equal(explainPauseOutcome(ok, ctx), null, ok);
  const worker = explainPauseOutcome('refused', ctx)!;
  assert.equal(worker.tone, 'error');
  assert.match(worker.title, /Pause refusée — worker est un agent, pas une vague/);
  assert.match(worker.why, /depuis la ligne de son orchestrateur \(wave-ops\)/);
  assert.doesNotMatch(worker.why, /fleet-lead/, 'the ancestor is NOT named: no wider shortcut (Q5)');
  assert.match(worker.why, /Rien n'a été écrit/);
  assert.deepEqual(worker.fix, []);
  assert.deepEqual(worker.actions, [{ kind: 'goto', wsId: 'O', label: 'Aller à wave-ops' }], 'ONE link to the orchestrator — navigation, never an action that pauses for the human (spec Q5)');
  assert.match(explainPauseOutcome('switch-off', ctx)!.why, /figé au démarrage de la vague/);
  assert.match(explainPauseOutcome('no-run', ctx)!.title, /Pas de run/);
  assert.equal(explainPauseOutcome('already-paused', ctx)!.tone, 'info');
  assert.match(explainPauseOutcome('already-paused', ctx)!.why, /devient manuelle — la vôtre/, 'it does NOT claim "unchanged": a repeat takes over a host-written pause as the HUMAN\'s');
  assert.match(explainPauseOutcome('write-failed', { ...ctx, error: 'SQLITE_BUSY' })!.why, /SQLITE_BUSY — rien n'est garanti écrit/);
  assert.deepEqual(explainPauseOutcome('unknown-workspace', { ...ctx, runId: 'abc' })!.fix, ['orchestra run resume --run abc (CLI : la vague n\'a plus de ligne dans la sidebar)']);
  assert.match(explainPauseOutcome('bus-unavailable', ctx)!.why, /ni lu ni écrit/);
  assert.equal(explainPauseOutcome('???', ctx), null, 'an outcome the UI does not know is not invented');
});

test('explainResumeOutcome: refused links to the orchestrator; not-paused on a COVERED run names the ancestor; already-resuming is informational', () => {
  assert.equal(explainResumeOutcome('resuming', ctx), null);
  assert.match(explainResumeOutcome('refused', ctx)!.title, /Reprise refusée — worker est un agent, pas une vague/);
  assert.deepEqual(explainResumeOutcome('refused', ctx)!.actions, [{ kind: 'goto', wsId: 'O', label: 'Aller à wave-ops' }]);
  assert.equal(explainWorkerRow('release', ctx).title, 'Libération refusée — worker est un agent, pas une vague');
  assert.deepEqual(explainWorkerRow('pause', { ...ctx, mayBe: [], runId: undefined }).actions, undefined, 'no run owner known → text only, no dead link');
  assert.deepEqual(explainWorkerRow('pause', { ...ctx, mayBe: ['R2'], runId: 'O' }).actions, [{ kind: 'goto', wsId: 'O', label: 'Aller à wave-ops' }], 'the link goes to the ROW that owns the run, never to the coordinator handle (a successor / not a row)');
  assert.deepEqual(explainWorkerRow('pause', { ...ctx, mayBe: [] }).actions, [{ kind: 'goto', wsId: 'O', label: 'Aller à wave-ops' }], 'a run with no bus coordinator still links to its row');
  const covered = explainResumeOutcome('not-paused', { ...ctx, cover: { runId: 'L', label: 'fleet-lead' } })!;
  assert.equal(covered.tone, 'info');
  assert.match(covered.title, /fleet-lead tient déjà wave-ops en pause/);
  assert.deepEqual(covered.fix, ['Reprendre fleet-lead (survol de sa ligne → ▶)']);
  assert.equal(covered.actions, undefined, 'named, not a button');
  assert.match(explainResumeOutcome('not-paused', ctx)!.title, /n'est pas en pause/);
  assert.equal(explainResumeOutcome('already-resuming', ctx)!.tone, 'info');
});

test('explainReleaseResult: refused / below / unknown / not-resuming each get their own line; an empty result says nothing', () => {
  const c = { ...ctx, all: true, actorLabel: 'fleet-lead' };
  const base = { error: null, refused: [], below: [], unknown: [], already: [] } as const;
  assert.deepEqual(explainReleaseResult({ ...base }, c), []);
  const below = explainReleaseResult({ ...base, below: ['w'] }, c);
  assert.equal(below.length, 1);
  assert.equal(below[0].tone, 'warn');
  assert.match(below[0].why, /sa propre vague \(comme `orchestra run release --all`\)/);
  assert.equal(below[0].actions, undefined, 'without the acting row / carrier ids there is no second gesture to offer');
  const second = explainReleaseResult({ ...base, below: ['w', 'O'] }, { ...c, actorId: 'L', carrierRunId: 'L' })[0];
  assert.deepEqual(second.actions, [{ kind: 'release', wsId: 'L', carrierRunId: 'L', ids: ['w', 'O'], label: 'Libérer aussi ces 2 : worker, wave-ops' }], 'the explicit SECOND gesture: the below ids, attributed to the carrier row');
  const refused = explainReleaseResult({ ...base, refused: [{ wsId: 'w', mayBe: ['O'] }] }, { ...c, all: false });
  assert.equal(refused[0].tone, 'error');
  assert.match(refused[0].why, /worker \(libérable par wave-ops\)/);
  assert.match(explainReleaseResult({ ...base, error: 'not-resuming' }, c)[0].title, /en pause, pas en reprise/);
  assert.match(explainReleaseResult({ ...base, unknown: ['zzz'] }, c)[0].why, /zzz/);
  assert.match(explainReleaseResult(null, c)[0].title, /Bus de flotte indisponible/);
});

test('availabilityFor: the control is explained BEFORE the click', () => {
  const a = availabilityFor({ anchored: true, runKnown: true, switchOn: true, phase: 'active', covered: false });
  assert.deepEqual(a.pauseSoft, { ok: true });
  assert.deepEqual(a.resume, { ok: false, code: 'not-paused' });
  assert.deepEqual(a.release, { ok: false, code: 'not-resuming' });
  assert.deepEqual(availabilityFor({ anchored: true, runKnown: true, switchOn: false, phase: 'active', covered: false }).pauseSoft, { ok: false, code: 'switch-off' });
  assert.deepEqual(availabilityFor({ anchored: false, runKnown: true, switchOn: true, phase: 'active', covered: false }).pauseHard, { ok: true }, 'a run whose coordinator is someone else is not greyed out: the human is above every coordinator (Q1)');
  assert.deepEqual(availabilityFor({ anchored: true, runKnown: false, switchOn: null, phase: 'active', covered: false }).pauseSoft, { ok: false, code: 'no-run' });
  const pausing = availabilityFor({ anchored: true, runKnown: true, switchOn: true, phase: 'pausing', covered: false });
  assert.deepEqual(pausing.pauseHard, { ok: true }, 'dure over a douce still waiting = escalate');
  assert.deepEqual(pausing.pauseSoft, { ok: false, code: 'already-paused' });
  assert.deepEqual(pausing.resume, { ok: true });
  const resuming = availabilityFor({ anchored: true, runKnown: true, switchOn: true, phase: 'resuming', covered: false });
  assert.deepEqual(resuming.release, { ok: true });
  assert.deepEqual(resuming.resume, { ok: false, code: 'already-resuming' });
  assert.deepEqual(availabilityFor({ anchored: true, runKnown: true, switchOn: true, phase: 'active', covered: true }).resume, { ok: false, code: 'covered' });
});

test('explainResumeOutcome names a lifted liveness HOLD (the CLI verb prints "liveness escalation is re-enabled") — on a covered row, on a plain not-paused row, and never when nothing was lifted (R2-1)', () => {
  const covered = explainResumeOutcome('not-paused', { ...ctx, cover: { runId: 'L', label: 'fleet-lead' }, holdLifted: true })!;
  assert.match(covered.title, /fleet-lead tient déjà wave-ops en pause/, 'the covered explanation is still the covered one');
  assert.match(covered.why, /Le hold de liveness de wave-ops a quand même été levé/);
  assert.match(covered.why, /orchestra run resume/);
  assert.match(covered.why, /ses membres restent suspendus tant que fleet-lead tient la pause/, 'a covered run\'s members are still silenced by the ancestor\'s pause: never "liveness is active again"');
  assert.doesNotMatch(covered.why, /de nouveau active/);
  assert.match(explainResumeOutcome('not-paused', { ...ctx, holdLifted: true })!.why, /^Rien à reprendre\. Le hold de liveness de wave-ops.*l'escalade de liveness est de nouveau active/);
  assert.match(explainResumeOutcome('already-resuming', { ...ctx, holdLifted: true })!.why, /hold de liveness/);
  assert.doesNotMatch(explainResumeOutcome('not-paused', { ...ctx, cover: { runId: 'L', label: 'fleet-lead' } })!.why, /hold/, 'no hold lifted → not a word about it');
  assert.doesNotMatch(explainResumeOutcome('not-paused', { ...ctx, cover: null, holdLifted: false })!.why, /hold/);
  assert.equal(explainResumeOutcome('resuming', { ...ctx, holdLifted: true }), null, 'a successful Reprise has nothing to explain (the hold lift is the verb\'s own effect)');
});

test('actorText: the human reads "a human (from the Orchestra app)" (Consigne, `run status`) / « un humain » (the UI); empty → null; any other handle verbatim (D-pick Q1)', () => {
  assert.equal(PAUSE_HUMAN_BY, 'humain');
  assert.equal(actorText(PAUSE_HUMAN_BY), 'a human (from the Orchestra app)');
  assert.equal(actorText(PAUSE_HUMAN_BY, 'en'), 'a human (from the Orchestra app)');
  assert.equal(actorText(PAUSE_HUMAN_BY, 'fr'), 'un humain');
  assert.equal(actorText('fleet-lead-ws'), 'fleet-lead-ws');
  assert.equal(actorText('host:usage_limit', 'fr'), 'host:usage_limit', 'the host\'s own pauser is untouched');
  assert.equal(actorText(null), null);
  assert.equal(actorText(undefined), null);
  assert.equal(actorText(''), null);
});
