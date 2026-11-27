// #680 — cross-ticket contracts: written in the plan, rendered in the briefs of the owner, the consumers and their reviewers, answered by every approve (`record --json contracts`), listed in the closing report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FanoutDeps, Runner } from './fanout-state.ts';
import { runRecord } from './fanout-record.ts';
import type { IdentityResolution } from '../shared/session-identity.ts';
import { applyTicketPatch, newState, readState, setPlan, stateFile, writeStateAtomic, type FanoutState } from '../shared/fanout-state.ts';
import { briefInputOf, renderBriefOf } from '../shared/fanout-review.ts';
import { buildReport, renderReport } from '../shared/fanout-report.ts';
import { renderReviewerBrief } from '../shared/fanout-review-brief.ts';
import { renderImplementerBrief } from '../shared/fanout-implementer-brief.ts';
import { countsThrough } from '../shared/fanout-record.ts';
import { renderContracts } from '../shared/fanout-contracts.ts';


const NOW = '2026-11-27T10:00:00.000Z';
const A = 'a'.repeat(40);
const offline: Runner = () => ({ code: 1, stdout: '', stderr: 'offline' });
const HOST: IdentityResolution = { source: 'host', runId: 'r1', generation: null };
const mkHome = (t: { after: (fn: () => void) => void }): string => {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'fanout-complete-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const depsOf = (home: string, who: string, stdin = ''): FanoutDeps => ({ env: { ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: who }, cwd: home, runner: offline, now: () => NOW, readStdin: () => stdin, identity: HOST });
const brief = { n: 1, kind: 'spawn' as const, head: A, base: null, hash: '1'.repeat(64), text: 'brief', reviewer: 'rev1', at: NOW };

const MUST = 'every path that sets the state dispatches ParcelReturned through one function';

/** run r1, seatRecords=on; contract c1: T1 OWNS it, T2 CONSUMES it (no dependency edge between them); T3 is part of none. T1 (impl1, reviewer rev1), T2 (impl2, reviewer rev2 — `rec2`). */
function seed(home: string, o: { contracts?: boolean } = {}): void {
  let s = newState('r1', { now: NOW, switches: { seatRecords: 'on' } as never });
  s = setPlan(s, ['T1', 'T2', 'T3'], 'declare', NOW);
  for (const id of ['T1', 'T2', 'T3']) s = applyTicketPatch(s, id, { dependsOn: [] }, NOW);
  s = applyTicketPatch(s, 'T1', { status: 'nominated', branch: 't1', head: A, implementer: 'impl1' }, NOW);
  s = applyTicketPatch(s, 'T2', { status: 'nominated', branch: 't2', head: A, implementer: 'impl2' }, NOW);
  s = applyTicketPatch(s, 'T3', { implementer: 'impl3' }, NOW);
  const rv = (id: string, name: string) => ({ reviewer: { id, name, at: NOW }, head: A, base: null, briefs: [{ ...brief, reviewer: id }] });
  s = { ...s, ...(o.contracts === false ? {} : { contracts: [{ id: 'c1', owner: 'T1', must: MUST, consumers: ['T2'] }] }), tickets: { ...s.tickets, T1: { ...s.tickets.T1, review: rv('rev1', 'review-T1') }, T2: { ...s.tickets.T2, review: rv('rev2', 'review-T2') } } };
  writeStateAtomic(stateFile(home, 'r1'), s);
}
const load = (home: string): FanoutState => readState(stateFile(home, 'r1'))!;
const rec = (home: string, ticket: string, verdict: string, json: unknown) =>
  runRecord([ticket, '--run', 'r1', '--head', A, '--verdict', verdict, '--json', '-'], depsOf(home, ticket === 'T1' ? 'rev1' : 'rev2', JSON.stringify(json)));
const brief1 = (home: string, ticket = 'T1'): string => renderBriefOf(load(home), ticket, { kind: 'spawn', head: A, base: null }).text;

// ── 2. rendered in the briefs of the owner, the consumers and their reviewers ───────────────────────────────────
test('rule 2: `## Contracts of the run` in the review brief of the owner AND of the consumer (their part named), in the implementer brief of both, next to the frozen interfaces — and in nobody else\'s', (t) => {
  const home = mkHome(t); seed(home);
  const s = load(home);
  assert.match(brief1(home, 'T1'), /## Frozen interfaces[\s\S]*## Contracts of the run\nContracts of the run[^\n]*\n- c1: T1 MUST — every path that sets the state dispatches ParcelReturned through one function \(consumers: T2\) — T1 is the OWNER/);
  assert.match(brief1(home, 'T2'), /- c1: T1 MUST — [^\n]*\(consumers: T2\) — T2 is a CONSUMER: it relies on it/);
  assert.match(brief1(home, 'T1'), /"contracts":\{"c1":"met\|unmet"\}/);
  assert.match(renderImplementerBrief({ state: s, ticket: 'T1' }), /## Contracts of the run\nContracts of the run[^\n]*\n- c1:[^\n]*the OWNER/);
  assert.match(renderImplementerBrief({ state: s, ticket: 'T2' }), /## Contracts of the run[\s\S]*a CONSUMER/);
  for (const text of [renderBriefOf(s, 'T3', { kind: 'spawn', head: A, base: null }).text, renderImplementerBrief({ state: s, ticket: 'T3' })]) assert.doesNotMatch(text, /Contracts of the run|"contracts"/);
});

test('rule 2 default path: no contract ⇒ nothing printed — the renderers are byte-identical to a state with none', (t) => {
  const home = mkHome(t); seed(home, { contracts: false });
  const s = load(home);
  assert.equal(renderContracts(s, 'T1'), '');
  assert.doesNotMatch(brief1(home), /Contracts of the run|"contracts"/);
  assert.doesNotMatch(renderImplementerBrief({ state: s, ticket: 'T1' }), /Contracts of the run/);
  const i = briefInputOf(s, 'T1', { kind: 'spawn', head: A, base: null });
  const { contractsText: _t, contractIds: _i, ...bare } = i;
  assert.equal(renderReviewerBrief(i), renderReviewerBrief(bare));
  assert.equal(buildReport(s).contracts, undefined);
  assert.doesNotMatch(renderReport(buildReport(s)), /contracts of the plan/);
});

// ── 3. an approve answers every contract the ticket is part of ───────────────────────────────────────────────────
test('rule 3: approve is refused without an answer for EVERY contract of the ticket ([contracts-missing]); an unknown id [contracts-unknown]; a ticket in none needs nothing', (t) => {
  const home = mkHome(t); seed(home);
  const none = rec(home, 'T1', 'approve', { findings: {} });
  assert.equal(none.code, 2); assert.match(none.stderr, /^\[contracts-missing\] approve without an answer for contract c1: add "contracts":\{"c1":"met\|unmet"\}/);
  assert.match(none.stderr, /c1: every path that sets the state/, 'the contract\'s sentence is in the refusal');
  const unk = rec(home, 'T1', 'approve', { contracts: { c1: 'met', c9: 'met' } });
  assert.equal(unk.code, 2); assert.match(unk.stderr, /^\[contracts-unknown\].*names c9/);
  const bad = rec(home, 'T1', 'approve', { contracts: { c1: 'maybe' } });
  assert.equal(bad.code, 2); assert.match(bad.stderr, /^\[record-json\]/);
  assert.equal(load(home).tickets.T1.reviews, undefined, 'a refusal records nothing');
  const ok = rec(home, 'T1', 'approve', { contracts: { c1: 'met' } });
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(load(home).tickets.T1.reviews![0].contracts, { c1: 'met' });
});

test('rule 3: a CONSUMER\'s met needs its evidence line ([contracts-evidence-missing]); the owner\'s does not', (t) => {
  const home = mkHome(t); seed(home);
  const noEv = rec(home, 'T2', 'approve', { contracts: { c1: 'met' } });
  assert.equal(noEv.code, 2); assert.match(noEv.stderr, /^\[contracts-evidence-missing\] contract c1: T2 is a CONSUMER/);
  const stray = rec(home, 'T1', 'approve', { contracts: { c1: 'met' }, contractEvidence: { c9: 'x.ts:1' } });
  assert.equal(stray.code, 2); assert.match(stray.stderr, /^\[contracts-unknown\]/);
  const ok = rec(home, 'T2', 'approve', { contracts: { c1: 'met' }, contractEvidence: { c1: 'src/parcel.service.ts:1827' } });
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(load(home).tickets.T2.reviews![0].contractEvidence, { c1: 'src/parcel.service.ts:1827' });
  assert.equal(rec(home, 'T1', 'approve', { contracts: { c1: 'met' } }).code, 0, 'the owner records met with no evidence line');
});

test('rule 3: `unmet` is a BLOCKING finding contract-<id> — approve is refused, changes-requested records it open; a clashing finding id is refused', (t) => {
  const home = mkHome(t); seed(home);
  const ap = rec(home, 'T1', 'approve', { contracts: { c1: 'unmet' } });
  assert.equal(ap.code, 2); assert.match(ap.stderr, /^\[approve-open-finding\].*contract-c1 BLOCKING/);
  const cr = rec(home, 'T1', 'changes-requested', { contracts: { c1: 'unmet' } });
  assert.equal(cr.code, 0, cr.stderr);
  const t1 = load(home).tickets.T1;
  assert.equal(t1.findings['contract-c1'].severity, 'BLOCKING');
  assert.match(t1.findings['contract-c1'].text!, /contract c1 is unmet on this head: T1 must — every path that sets the state/);
  assert.deepEqual(countsThrough(t1, 1).open, ['contract-c1']);
  const home2 = mkHome(t); seed(home2);
  const clash = rec(home2, 'T1', 'changes-requested', { contracts: { c1: 'unmet' }, findings: { 'contract-c1': { severity: 'MAJOR', evidence: 'argued', text: 'mine' } } });
  assert.equal(clash.code, 2); assert.match(clash.stderr, /^\[contracts-finding-clash\]/);
  const home3 = mkHome(t); seed(home3);
  const t3 = runRecord(['T3', '--run', 'r1', '--head', A, '--verdict', 'approve', '--json', '-'], depsOf(home3, 'rev3', JSON.stringify({ findings: {} })));
  assert.doesNotMatch(t3.stderr, /contracts-/, 'a ticket in no contract is never asked for one');
});

// ── 4. the closing report ────────────────────────────────────────────────────────────────────────────────────────
test('rule 4: the closing report lists the contracts with the last verdict of each party (no verdict says so)', (t) => {
  const home = mkHome(t); seed(home);
  assert.equal(rec(home, 'T1', 'changes-requested', { contracts: { c1: 'unmet' } }).code, 0);
  const mid = buildReport(load(home)).contracts!;
  assert.deepEqual(mid, [{ id: 'c1', owner: 'T1', must: MUST, owned: 'unmet', consumers: [{ ticket: 'T2', answer: null }] }]);
  assert.match(renderReport(buildReport(load(home))), /contracts of the plan \(1\)[^\n]*\n  c1: T1 \[unmet\] must every path[^\n]* — consumers: T2 \[no verdict\]/);
});
