import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  availabilityFor,
  explainPauseOutcome,
  explainReleaseResult,
  explainResumeOutcome,
  memberUiState,
  type ExplainCtx,
} from './pause-ui.ts';

const label = (id: string): string => ({ L: 'fleet-lead', O: 'wave-ops', w: 'worker' } as Record<string, string>)[id] ?? id;
const ctx: ExplainCtx = { label, runLabel: 'wave-ops', actorLabel: 'worker', mayBe: ['O', 'L'], cover: null };

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
  assert.match(worker.title, /worker n'est pas coordinateur de wave-ops/);
  assert.match(worker.why, /wave-ops\)/);
  assert.match(worker.why, /fleet-lead\)/);
  assert.match(worker.why, /Rien n'a été écrit/);
  assert.deepEqual(worker.fix, ['Pour worker : mettre en pause sa vague wave-ops (survol de la ligne wave-ops → ⏸)', 'Plus large : mettre fleet-lead en pause suspend TOUTE sa vague, wave-ops comprise']);
  assert.equal(worker.actions, undefined, 'the run to pause is NAMED, never offered as a button (spec Q5: no shortcut — the wider run must be a deliberate click on ITS row)');
  assert.match(explainPauseOutcome('switch-off', ctx)!.why, /figé au démarrage de la vague/);
  assert.match(explainPauseOutcome('no-run', ctx)!.title, /Pas de run/);
  assert.equal(explainPauseOutcome('already-paused', ctx)!.tone, 'info');
  assert.match(explainPauseOutcome('already-paused', ctx)!.why, /devient manuelle/, 'it does NOT claim "unchanged": a repeat takes over a host-written pause');
  assert.match(explainPauseOutcome('write-failed', { ...ctx, error: 'SQLITE_BUSY' })!.why, /SQLITE_BUSY — rien n'est garanti écrit/);
  assert.deepEqual(explainPauseOutcome('unknown-workspace', { ...ctx, runId: 'abc' })!.fix, ['orchestra run resume --run abc (CLI : la vague n\'a plus de ligne dans la sidebar)']);
  assert.match(explainPauseOutcome('bus-unavailable', ctx)!.why, /ni lu ni écrit/);
  assert.equal(explainPauseOutcome('???', ctx), null, 'an outcome the UI does not know is not invented');
});

test('explainResumeOutcome: refused names who may; not-paused on a COVERED run names the ancestor; already-resuming is informational', () => {
  assert.equal(explainResumeOutcome('resuming', ctx), null);
  assert.match(explainResumeOutcome('refused', ctx)!.title, /Reprise refusée/);
  const covered = explainResumeOutcome('not-paused', { ...ctx, cover: { runId: 'L', label: 'fleet-lead' } })!;
  assert.equal(covered.tone, 'info');
  assert.match(covered.title, /fleet-lead tient déjà wave-ops en pause/);
  assert.deepEqual(covered.fix, ['Reprendre fleet-lead (survol de sa ligne → ▶)']);
  assert.equal(covered.actions, undefined, 'named, not a button');
  assert.equal(explainResumeOutcome('refused', ctx)!.actions, undefined);
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
  assert.deepEqual(availabilityFor({ anchored: false, runKnown: true, switchOn: true, phase: 'active', covered: false }).pauseHard, { ok: false, code: 'refused' });
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
