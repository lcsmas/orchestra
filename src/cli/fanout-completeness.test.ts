// #675 — the reviewer sees the ticket, its numbered criteria and EVERY choice of the run; a choice that narrows a criterion can be challenged. Every arm drives the production verbs
// (`choice --narrows`, `record` with `criteria` / `--on-choice`) and the renderers (review brief, implementer brief, corrections batch, CONNECT ask).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FanoutDeps, Runner } from './fanout-state.ts';
import { runChoice } from './fanout-choice.ts';
import { runRecord } from './fanout-record.ts';
import type { IdentityResolution } from '../shared/session-identity.ts';
import { applyTicketPatch, newState, readState, setPlan, stateFile, writeStateAtomic, type FanoutState } from '../shared/fanout-state.ts';
import { briefInputOf, renderBriefOf } from '../shared/fanout-review.ts';
import { renderReviewerBrief } from '../shared/fanout-review-brief.ts';
import { renderImplementerBrief } from '../shared/fanout-implementer-brief.ts';
import { renderBatch } from '../shared/fanout-loop-corrections.ts';
import { renderConnectAsk } from '../shared/fanout-loop.ts';
import { renderRunChoices } from '../shared/fanout-brief-common.ts';
import { criteriaLines, quotesCriterion } from '../shared/fanout-criteria.ts';
import { countsThrough } from '../shared/fanout-record.ts';

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

const S1 = 'A later manual trigger gets the same effect as the carrier status.';
const S2 = 'The admin sees the line holding the new device.';
const TEXT_T1 = `Move the device to the supplier.\n\n## Scope\n${S1}\n\n## Acceptance criteria\n- [ ] ${S2}\n- [ ] The RMA is created at the supplier.\n`;

/** run r1, seatRecords=on; T1 (impl1, reviewer rev1) has the ticket text TEXT_T1 (2 numbered criteria); T2 (impl2) has a one-line text with none; T3 has no text at all. */
function seed(home: string, o: { t1Text?: string | null } = {}): void {
  let s = newState('r1', { now: NOW, switches: { seatRecords: 'on', minorPolicy: 'spec' } as never });
  s = setPlan(s, ['T1', 'T2', 'T3'], 'declare', NOW);
  s = applyTicketPatch(s, 'T2', { dependsOn: [], spec: 'spec/T2.md' }, NOW, { specText: 'Just a sentence, no criterion in it.' });
  s = applyTicketPatch(s, 'T3', { dependsOn: [] }, NOW);
  const t1Text = o.t1Text === undefined ? TEXT_T1 : o.t1Text;
  s = applyTicketPatch(s, 'T1', { dependsOn: [], status: 'nominated', branch: 't1', head: A, implementer: 'impl1', ...(t1Text !== null ? { spec: 'spec/T1.md' } : {}) }, NOW, t1Text !== null ? { specText: t1Text } : {});
  s = applyTicketPatch(s, 'T2', { implementer: 'impl2' }, NOW);
  s = applyTicketPatch(s, 'T3', { implementer: 'impl3' }, NOW);
  s = { ...s, tickets: { ...s.tickets, T1: { ...s.tickets.T1, review: { reviewer: { id: 'rev1', name: 'review-T1', at: NOW }, head: A, base: null, briefs: [brief] } } } };
  writeStateAtomic(stateFile(home, 'r1'), s);
}
const load = (home: string): FanoutState => readState(stateFile(home, 'r1'))!;
const choose = (home: string, who: string, ticket: string, q: string, taken: string, narrows?: string) =>
  runChoice([ticket, '--run', 'r1', '--question', q, '--taken', taken, ...(narrows !== undefined ? ['--narrows', narrows] : [])], depsOf(home, who));
const rec = (home: string, verdict: string, json: unknown, extra: string[] = []) =>
  runRecord(['T1', '--run', 'r1', '--head', A, '--verdict', verdict, '--json', '-', ...extra], depsOf(home, 'rev1', JSON.stringify(json)));
const MAJOR = (text: string, specSentence?: string) => ({ severity: 'MAJOR', evidence: 'argued', text, ...(specSentence !== undefined ? { specSentence } : {}) });
const reviewBrief = (home: string): string => renderBriefOf(load(home), 'T1', { kind: 'spawn', head: A, base: null }).text;

// ── 1. every choice of the run, in every brief ─────────────────────────────────────────────────────────────────
test('rule 1: the review brief, the implementer brief, the corrections batch and the CONNECT ask all list every choice of the run (every ticket\'s, with its narrows)', (t) => {
  const home = mkHome(t); seed(home);
  assert.equal(choose(home, 'impl1', 'T1', 'react to the event or the state?', 'the event', S1).code, 0);
  assert.equal(choose(home, 'impl2', 'T2', 'does the mark emit an event?', 'no, state only').code, 0);
  const s = load(home);
  const want = [/1\. \[T1\b[^\]]*\] react to the event or the state\? → TAKEN: the event\n   Choice 1 narrows: « A later manual trigger gets the same effect as the carrier status\. »/, /2\. \[T2\] does the mark emit an event\? → TAKEN: no, state only\n   Choice 2 narrows: none declared/];
  for (const w of want) {
    assert.match(reviewBrief(home), w, 'review brief');
    assert.match(renderImplementerBrief({ state: s, ticket: 'T3' }), w, 'implementer brief (T3 owns none of them)');
    assert.match(renderBatch(s, 'T1', { r: { n: 1, reviewer: 'rev1', head: A, tree: null, verdict: 'changes-requested', findings: [], closed: [], at: NOW }, fix: [] }, 1, false), w, 'corrections batch');
    assert.match(renderConnectAsk({ ticket: 'T1', upstream: 'T2', branch: 't2', head: A, choices: renderRunChoices(s) }), w, 'CONNECT ask');
  }
  assert.match(reviewBrief(home), /## Choices of the run/);
});

test('rule 1 default path: no choice ⇒ no section, byte-identical — every renderer prints exactly what it printed before', (t) => {
  const home = mkHome(t); seed(home, { t1Text: null });
  const s = load(home);
  assert.equal(renderRunChoices(s), '');
  assert.doesNotMatch(reviewBrief(home), /Choices of the run|Acceptance criteria|"criteria"/);
  assert.doesNotMatch(renderImplementerBrief({ state: s, ticket: 'T1' }), /Choices of the run/);
  const i = briefInputOf(s, 'T1', { kind: 'spawn', head: A, base: null });
  const { choicesText: _c, criteria: _k, ...bare } = i;
  assert.equal(renderReviewerBrief(i), renderReviewerBrief(bare), 'an empty choicesText / criteria prints nothing');
  assert.equal(renderConnectAsk({ ticket: 'T1', upstream: 'T2', branch: 't2', head: A }), renderConnectAsk({ ticket: 'T1', upstream: 'T2', branch: 't2', head: A, choices: '' }));
  assert.doesNotMatch(renderConnectAsk({ ticket: 'T1', upstream: 'T2', branch: 't2', head: A }), /Choices of the run/);
});

// ── 2. the ticket text and its numbered criteria ───────────────────────────────────────────────────────────────
test('criteriaLines: checkbox items anywhere + list items under an acceptance-criteria heading, in reading order; nothing else', () => {
  assert.deepEqual(criteriaLines(TEXT_T1), [S2, 'The RMA is created at the supplier.']);
  assert.deepEqual(criteriaLines('- [x] done one\r\n* [ ] second one\n1. [ ] third one'), ['done one', 'second one', 'third one']);
  assert.deepEqual(criteriaLines('## Acceptance criteria\n- one\n- two\n## Notes\n- not a criterion'), ['one', 'two']);
  assert.deepEqual(criteriaLines('Just prose.\n- a plain bullet\n'), []);
  assert.deepEqual(criteriaLines(null), []);
  assert.equal(quotesCriterion(S2, [S2]), true);
  assert.equal(quotesCriterion(S1, [S2]), false);
});

test('rule 2: the review brief renders `## Ticket text` then the numbered `## Acceptance criteria`, and names `criteria` in the record command', (t) => {
  const home = mkHome(t); seed(home);
  const b = reviewBrief(home);
  const iT = b.indexOf('## Ticket text'), iC = b.indexOf('## Acceptance criteria');
  assert.ok(iT >= 0 && iC > iT, 'ticket text, then the criteria');
  assert.match(b, new RegExp(`## Acceptance criteria\\n1\\. ${S2.replace(/\./g, '\\.')}\\n2\\. The RMA is created at the supplier\\.`));
  assert.match(b, /"criteria":\{"1":"met\|unmet",…\}/);
});

test('rule 2: approve is refused without an answer for EVERY numbered criterion ([criteria-missing]); all met ⇒ recorded and stored; the default (no criteria in the text) needs none', (t) => {
  const home = mkHome(t); seed(home);
  const none = rec(home, 'approve', { findings: {} });
  assert.equal(none.code, 2); assert.match(none.stderr, /^\[criteria-missing\] approve without an answer for criterion 1, 2 of 2/);
  const partial = rec(home, 'approve', { criteria: { '1': 'met' } });
  assert.equal(partial.code, 2); assert.match(partial.stderr, /^\[criteria-missing\].*criterion 2 of 2/);
  const unk = rec(home, 'approve', { criteria: { '1': 'met', '2': 'met', '3': 'met' } });
  assert.equal(unk.code, 2); assert.match(unk.stderr, /^\[criteria-unknown\].*names 3/);
  const bad = rec(home, 'approve', { criteria: { '1': 'maybe' } });
  assert.equal(bad.code, 2); assert.match(bad.stderr, /^\[record-json\]/);
  assert.equal(load(home).tickets.T1.reviews, undefined, 'nothing was recorded by a refusal');
  const ok = rec(home, 'approve', { criteria: { '1': 'met', '2': 'met' } });
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(load(home).tickets.T1.reviews![0].criteria, { '1': 'met', '2': 'met' });
  // default path: a ticket whose text has no numbered criterion approves with no `criteria`
  const home2 = mkHome(t); seed(home2, { t1Text: 'No criterion line here, only prose that is long enough.' });
  assert.equal(rec(home2, 'approve', { findings: {} }).code, 0);
  const home3 = mkHome(t); seed(home3, { t1Text: null });
  assert.equal(rec(home3, 'approve', { findings: {} }).code, 0, 'no ticket text at all: nothing to answer');
});

test('rule 2: an `unmet` criterion is a BLOCKING finding — approve is refused, changes-requested records it open', (t) => {
  const home = mkHome(t); seed(home);
  const ap = rec(home, 'approve', { criteria: { '1': 'met', '2': 'unmet' } });
  assert.equal(ap.code, 2); assert.match(ap.stderr, /^\[approve-open-finding\].*criterion-2 BLOCKING/);
  const cr = rec(home, 'changes-requested', { criteria: { '1': 'met', '2': 'unmet' } });
  assert.equal(cr.code, 0, cr.stderr);
  const t1 = load(home).tickets.T1;
  assert.equal(t1.findings['criterion-2'].severity, 'BLOCKING');
  assert.match(t1.findings['criterion-2'].text!, /criterion 2 is unmet on this head: The RMA is created at the supplier\./);
  assert.deepEqual(countsThrough(t1, 1).open, ['criterion-2']);
  const home2 = mkHome(t); seed(home2);
  const clash = rec(home2, 'changes-requested', { criteria: { '2': 'unmet' }, findings: { 'criterion-2': MAJOR('mine') } });
  assert.equal(clash.code, 2); assert.match(clash.stderr, /^\[criteria-finding-clash\]/);
});

// ── 3. a choice declares what it narrows ───────────────────────────────────────────────────────────────────────
test('rule 3: --narrows is stored verbatim, checked against the ticket text ([choice-narrows-not-in-text] / [choice-narrows-no-text]), and rendered "Choice n narrows: « … »"', (t) => {
  const home = mkHome(t); seed(home);
  const miss = choose(home, 'impl1', 'T1', 'q', 'a', 'A sentence that the ticket does not contain at all.');
  assert.equal(miss.code, 2); assert.match(miss.stderr, /^\[choice-narrows-not-in-text\]/);
  const noText = choose(home, 'impl3', 'T3', 'q', 'a', 'Anything long enough to be quoted here.');
  assert.equal(noText.code, 2); assert.match(noText.stderr, /^\[choice-narrows-no-text\]/);
  const folded = choose(home, 'impl1', 'T1', 'q', 'a', S1.toLowerCase());
  assert.equal(folded.code, 2, 'no case-fold: the sentence is literal'); assert.match(folded.stderr, /^\[choice-narrows-not-in-text\]/);
  const short = choose(home, 'impl1', 'T1', 'q', 'a', 'Scope'); // in the text, but under 15 characters: no sentence
  assert.equal(short.code, 1, short.stderr);
  assert.equal(load(home).choices, undefined, 'a refusal records nothing');
  assert.equal(choose(home, 'impl1', 'T1', 'react to the event or the state?', 'the event', S1).code, 0);
  assert.equal(load(home).choices![0].narrows, S1);
  assert.match(reviewBrief(home), /Choice 1 narrows: « A later manual trigger gets the same effect as the carrier status\. »/);
  assert.equal(choose(home, 'impl1', 'T1', 'another', 'taken').code, 0);
  assert.equal(load(home).choices![1].narrows, undefined);
  assert.match(reviewBrief(home), /Choice 2 narrows: none declared/);
});

test('rule 3: --on-choice no longer exempts a finding whose accepted specSentence IS the sentence the choice narrows — it keeps its severity, and a note says so', (t) => {
  const home = mkHome(t); seed(home);
  assert.equal(choose(home, 'impl1', 'T1', 'react to the event or the state?', 'the event', S1).code, 0);
  const ap = rec(home, 'approve', { criteria: { '1': 'met', '2': 'met' }, findings: { F1: MAJOR('the manual trigger gets no effect', S1) } }, ['--on-choice', 'F1=1']);
  assert.equal(ap.code, 2, 'the finding is not exempt: approve is refused'); assert.match(ap.stderr, /^\[approve-open-finding\].*F1 MAJOR/);
  const cr = rec(home, 'changes-requested', { findings: { F1: MAJOR('the manual trigger gets no effect', S1) } }, ['--on-choice', 'F1=1']);
  assert.equal(cr.code, 0, cr.stderr);
  assert.match(cr.stderr, /--on-choice F1=1 NOT applied \(#675\): its specSentence is the sentence choice 1 narrows — F1 keeps its severity \(MAJOR\)/);
  const t1 = load(home).tickets.T1;
  assert.equal(t1.findings.F1.onChoice, undefined);
  assert.deepEqual(countsThrough(t1, 1).open, ['F1'], 'F1 is open and blocks');
});

test('rule 3 controls: a finding about the choice that quotes ANOTHER sentence, or none, is still exempt (#641 unchanged)', (t) => {
  const home = mkHome(t); seed(home);
  assert.equal(choose(home, 'impl1', 'T1', 'react to the event or the state?', 'the event', S1).code, 0);
  const ok = rec(home, 'approve', { criteria: { '1': 'met', '2': 'met' }, findings: { F1: MAJOR('a product choice we would not have made', S2), F2: MAJOR('no quote at all') } }, ['--on-choice', 'F1=1,F2=1']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.doesNotMatch(ok.stderr, /NOT applied/);
  assert.equal(load(home).tickets.T1.findings.F1.onChoice, 1);
  assert.equal(load(home).tickets.T1.findings.F2.onChoice, 1);
});

test('rule 3: a choice that declared NO narrows — a finding that quotes an acceptance criterion line keeps its severity; one that quotes another line of the text, or nothing, stays exempt', (t) => {
  const home = mkHome(t); seed(home);
  assert.equal(choose(home, 'impl1', 'T1', 'the new device: created or must exist?', 'must already exist').code, 0);
  const cr = rec(home, 'changes-requested', { findings: { F1: MAJOR('the line never holds the new device', S2) } }, ['--on-choice', 'F1=1']);
  assert.equal(cr.code, 0, cr.stderr);
  assert.match(cr.stderr, /NOT applied \(#675\): choice 1 declared nothing it narrows and the finding quotes an acceptance criterion/);
  assert.equal(load(home).tickets.T1.findings.F1.onChoice, undefined);
  const home2 = mkHome(t); seed(home2);
  assert.equal(choose(home2, 'impl1', 'T1', 'q', 'a').code, 0);
  const ok = rec(home2, 'approve', { criteria: { '1': 'met', '2': 'met' }, findings: { F1: MAJOR('about the scope sentence, not a criterion', S1), F2: MAJOR('no quote') } }, ['--on-choice', 'F1=1,F2=1']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(load(home2).tickets.T1.findings.F1.onChoice, 1, 'a Scope sentence is not a criterion line');
});
