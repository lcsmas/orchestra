// #552 — the finding RECORD (every field declared), the spec capture, the specSentence rule, the merge block and the follow-up rule under minorPolicy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyTicketPatch, blockingMinors, findingOf, followUpRefusal, mergeBlockRefusal, newState, parseState, readState, sentenceAccepted, switchesOf, writeStateAtomic, type FanoutState } from './fanout-state.ts';

const T = '2026-11-23T10:00:00.000Z';
const A = 'a'.repeat(40);
const SPEC = 'Write the list in the pull request.\nThe endpoint returns 404 for an unknown id.\nUse   two spaces here.';
const SENT = 'The endpoint returns 404 for an unknown id.';

/** T-1: spec text captured, a started ticket (not merged) with findings recorded through the same path `state set` uses. */
function open552(): FanoutState {
  const s = newState('r', { now: T });
  return applyTicketPatch(s, 'T-1', { status: 'started', branch: 't1', spec: 'spec.md' }, T, { specText: SPEC });
}
const rec = (s: FanoutState, findings: Record<string, unknown>, id = 'T-1') => applyTicketPatch(s, id, { findings }, T);

test('#552 the record: legacy string and normalized form both parse to the record; every field is declared and shape-checked; unknown keys refused', () => {
  assert.deepEqual(findingOf('MINOR', 'f'), { severity: 'MINOR' });
  const full = { severity: 'MINOR', evidence: 'measured', kind: 'process', specSentence: SENT, report: { input: 'i', happens: 'h', where: 'w', proof: 'p' }, decision: { by: 'ws', text: 'ok', at: T }, settled: { how: 'pr-body', at: T, ref: 'PR #9' } };
  assert.deepEqual(findingOf(full, 'f'), full);
  for (const bad of [{ severity: 'SEVERE' }, { severity: 'MINOR', evidence: 'guess' }, { severity: 'MINOR', kind: 'doc' }, { severity: 'MINOR', extra: 1 }, { severity: 'MINOR', report: { input: 'i' } }, { severity: 'MINOR', settled: { how: 'later', at: T, ref: 'x' } }, { severity: 'MINOR', decision: { by: 'a', text: '', at: T } }, 7, null, ['MINOR']]) {
    assert.throws(() => findingOf(bad, 'f'), FanoutStateError_());
  }
});
function FanoutStateError_() { return /must be|expects|unknown|refused|not an acceptable|must/i; }

test('#552 persistence: a severity-only record is WRITTEN as the legacy string (old readers unchanged); a richer record round-trips', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'spec-sent-'));
  try {
    let s = open552();
    s = rec(s, { 'F-A': 'MAJOR', 'F-B': { severity: 'MINOR', specSentence: SENT } });
    const file = path.join(dir, 'state.json');
    writeStateAtomic(file, s);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.tickets['T-1'].findings['F-A'], 'MAJOR');
    assert.deepEqual(raw.tickets['T-1'].findings['F-B'], { severity: 'MINOR', specSentence: SENT });
    assert.equal(raw.tickets['T-1'].specText, SPEC);
    assert.deepEqual(readState(file), s);
    // no captured text ⇒ the key is not written at all (a build older than #552 refuses an unknown field: such a state stays readable by it)
    const bare = applyTicketPatch(newState('r', { now: T }), 'T-2', { status: 'started' }, T);
    writeStateAtomic(file, bare);
    assert.ok(!('specText' in JSON.parse(fs.readFileSync(file, 'utf8')).tickets['T-2']));
    writeStateAtomic(file, s);
    // a state written before #552 (no specText) parses with null
    delete raw.tickets['T-1'].specText;
    assert.equal(parseState(raw).tickets['T-1'].specText, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#552 must-PASS: a specSentence that is a literal substring of the captured spec is accepted', () => {
  const s = rec(open552(), { 'F-1': { severity: 'MINOR', specSentence: SENT } });
  assert.equal(sentenceAccepted(s.tickets['T-1'], s.tickets['T-1'].findings['F-1']), true);
  // verbatim: the double space and the newline of the spec are part of the match
  assert.doesNotThrow(() => rec(open552(), { 'F-2': { severity: 'MINOR', specSentence: 'Use   two spaces here.' } }));
  assert.doesNotThrow(() => rec(open552(), { 'F-3': { severity: 'MINOR', specSentence: 'pull request.\nThe endpoint' } }));
});

test('#552 must-FAIL: a specSentence not in the captured spec / case-folded / re-spaced / empty / whitespace-only / with no captured spec is refused, nothing recorded', () => {
  const s = open552();
  for (const sentence of ['The endpoint returns 500.', SENT.toUpperCase(), 'Use two spaces here.', '', '   ', '\n\t']) {
    assert.throws(() => rec(s, { 'F-1': { severity: 'MINOR', specSentence: sentence } }), /specSentence/, JSON.stringify(sentence));
  }
  assert.throws(() => rec(s, { 'F-1': { severity: 'MINOR', specSentence: ` ${SENT}` } }), /specSentence is not a literal sentence/, 'no trim of the sentence');
  const noText = applyTicketPatch(newState('r', { now: T }), 'T-9', { status: 'started', spec: 'https://x/y' }, T);
  assert.equal(noText.tickets['T-9'].specText, null);
  assert.throws(() => rec(noText, { 'F-1': { severity: 'MINOR', specSentence: SENT } }, 'T-9'), /no spec text was captured/);
  assert.equal(Object.keys(s.tickets['T-1'].findings).length, 0);
});

test('#552 specText is derived, never settable: `state set --json {specText}` is refused; a new spec reference with nothing read is NOT captured', () => {
  assert.throws(() => applyTicketPatch(open552(), 'T-1', { specText: 'forged' }, T), /unknown field "specText"/);
  const re = applyTicketPatch(open552(), 'T-1', { spec: 'other.md' }, T);
  assert.equal(re.tickets['T-1'].specText, null, 'the old spec text is never kept under a new reference');
  const same = applyTicketPatch(open552(), 'T-1', { spec: 'spec.md' }, T);
  assert.equal(same.tickets['T-1'].specText, SPEC, 'the same reference keeps its captured text');
});

test('#552 re-capturing the spec text cannot silently un-block a merge: refused while an accepted unsettled sentence would be lost', () => {
  const s = rec(open552(), { 'F-1': { severity: 'MINOR', specSentence: SENT } });
  assert.throws(() => applyTicketPatch(s, 'T-1', {}, T, { specText: 'a different spec' }), /no longer contains the specSentence of F-1/);
  const settled = applyTicketPatch(s, 'T-1', { settle: { 'F-1': { how: 'fixed', ref: 'abc1234' } } }, T);
  assert.doesNotThrow(() => applyTicketPatch(settled, 'T-1', {}, T, { specText: 'a different spec' }));
});

test('#552 a recorded finding is not rewritten: severity, kind, evidence, specSentence keep their first value; decision/settled only through the verbs', () => {
  const s = rec(open552(), { 'F-1': { severity: 'MINOR', kind: 'code', evidence: 'measured' } });
  assert.throws(() => rec(s, { 'F-1': 'MAJOR' }), /not re-graded/);
  assert.throws(() => rec(s, { 'F-1': { severity: 'MINOR', kind: 'process' } }), /already records kind/);
  assert.throws(() => rec(s, { 'F-1': { severity: 'MINOR', evidence: 'argued' } }), /already records evidence/);
  assert.throws(() => rec(s, { 'F-1': { severity: 'MINOR', settled: { how: 'fixed', at: T, ref: 'x' } } }), /--decide \/ --settle/);
  const withSentence = rec(s, { 'F-1': { severity: 'MINOR', specSentence: SENT } }); // adding a quoted sentence later is allowed (validated)
  assert.equal(withSentence.tickets['T-1'].findings['F-1'].kind, 'code');
  assert.throws(() => rec(withSentence, { 'F-1': { severity: 'MINOR', specSentence: 'Write the list in the pull request.' } }), /already records specSentence/);
});

test('#552 the kind is fixed when the finding is recorded: a code MINOR (kind unset or code) cannot become process later, a process one cannot become code', () => {
  const s = rec(open552(), { 'F-1': { severity: 'MINOR', specSentence: SENT }, 'F-2': { severity: 'MINOR', kind: 'process' } });
  assert.throws(() => rec(s, { 'F-1': { severity: 'MINOR', kind: 'process' } }), /already records kind "code"/);
  assert.throws(() => rec(s, { 'F-2': { severity: 'MINOR', kind: 'code' } }), /already records kind "process"/);
  assert.doesNotThrow(() => rec(s, { 'F-1': { severity: 'MINOR', kind: 'code' } }), 'restating the same kind is idempotent');
});

test('#552 merge block (minorPolicy spec): an unsettled MINOR with an accepted sentence blocks, naming the finding; settled / decided passes; no sentence / not in spec / merged ticket does not block', () => {
  assert.equal(switchesOf(open552()).minorPolicy, 'spec');
  let s = rec(open552(), { 'F-1': { severity: 'MINOR', specSentence: SENT }, 'F-2': 'MINOR', 'F-3': { severity: 'MINOR', evidence: 'argued' } });
  assert.deepEqual(blockingMinors(s, 'T-1'), ['F-1']);
  const r = mergeBlockRefusal(s, 'T-1')!;
  assert.equal(r.reason, 'finding-unsettled');
  assert.match(r.detail, /F-1/);
  assert.doesNotMatch(r.detail, /F-2|F-3/);
  assert.match(r.detail, /not that it is really broken/);
  const fixed = applyTicketPatch(s, 'T-1', { settle: { 'F-1': { how: 'fixed', ref: 'abc1234' } } }, T);
  assert.equal(mergeBlockRefusal(fixed, 'T-1'), null);
  const decided = applyTicketPatch(s, 'T-1', { decide: { 'F-1': { text: 'accepted as is, ledger c/1', by: 'ws-ops' } } }, T);
  assert.equal(mergeBlockRefusal(decided, 'T-1'), null);
  assert.equal(decided.tickets['T-1'].findings['F-1'].decision?.by, 'ws-ops');
  // a hand-edited sentence that is NOT in the spec does not block (the substring is re-checked where it is acted on)
  const forged = structuredClone(s); forged.tickets['T-1'].findings['F-2'] = { severity: 'MINOR', specSentence: 'not in the spec' };
  assert.deepEqual(blockingMinors(forged, 'T-1'), ['F-1']);
  // BLOCKING / MAJOR keep their own (review) path: this block is for MINOR only
  s = rec(s, { 'F-4': { severity: 'MAJOR', specSentence: SENT } });
  assert.deepEqual(blockingMinors(s, 'T-1'), ['F-1']);
  // a merged ticket is not blocked
  const merged = applyTicketPatch(s, 'T-1', { status: 'merged', head: A }, T);
  assert.deepEqual(blockingMinors(merged, 'T-1'), []);
});

test('#552 process finding: blocks until settled by a PR-body edit (never `fixed`), is never a code round (--fixes refused); a code finding cannot be settled as pr-body', () => {
  const s = rec(open552(), { 'P-1': { severity: 'MINOR', kind: 'process', specSentence: 'Write the list in the pull request.' }, 'C-1': { severity: 'MINOR', specSentence: SENT } });
  assert.deepEqual(blockingMinors(s, 'T-1').sort(), ['C-1', 'P-1']);
  assert.throws(() => applyTicketPatch(s, 'T-1', { settle: { 'P-1': { how: 'fixed', ref: 'abc' } } }, T), /process finding: settled by a PR-body edit/);
  assert.throws(() => applyTicketPatch(s, 'T-1', { settle: { 'C-1': { how: 'pr-body', ref: 'PR #3' } } }, T), /code finding: settled by a fix/);
  assert.throws(() => applyTicketPatch(s, 'T-1', { settle: { 'P-1': { how: 'pr-body', ref: '  ' } } }, T), /reference/);
  assert.throws(() => applyTicketPatch(s, 'T-1', { settle: { 'NOPE': { how: 'fixed', ref: 'x' } } }, T), /no such finding/);
  const done = applyTicketPatch(s, 'T-1', { settle: { 'P-1': { how: 'pr-body', ref: 'PR #3 now carries the list' } } }, T);
  assert.deepEqual(blockingMinors(done, 'T-1'), ['C-1']);
  assert.equal(done.tickets['T-1'].findings['P-1'].settled?.how, 'pr-body');
  assert.throws(() => applyTicketPatch(done, 'T-1', { settle: { 'P-1': { how: 'pr-body', ref: 'again' } } }, T), /already settled/);
});

/** T-1 merged with spec text; findings on it; follow-ups declared against it. */
function mergedWith(findings: Record<string, unknown>): FanoutState {
  let s = applyTicketPatch(newState('r', { now: T }), 'T-1', { status: 'started', branch: 't1', spec: 'spec.md' }, T, { specText: SPEC });
  s = rec(s, findings);
  return applyTicketPatch(s, 'T-1', { status: 'merged', head: A }, T);
}
const fuOf = (s: FanoutState, fixes: string[]) => applyTicketPatch(s, 'T-1-fu', { status: 'started', branch: 'fu', followUpOf: 'T-1', fixes }, T);

test('#552 follow-up rule under spec: BLOCKING | MAJOR | MINOR-with-accepted-sentence qualify; a MINOR with no sentence, an argued MINOR, or a sentence NOT in the spec ⇒ followup-minor-only', () => {
  const s = mergedWith({ 'F-S': { severity: 'MINOR', specSentence: SENT }, 'F-M': { severity: 'MINOR', evidence: 'measured' }, 'F-ARG': { severity: 'MINOR', evidence: 'argued' }, 'F-MAJ': 'MAJOR' });
  assert.doesNotThrow(() => fuOf(s, ['F-S']));
  assert.doesNotThrow(() => fuOf(s, ['F-MAJ']));
  assert.throws(() => fuOf(s, ['F-M']), /only MINOR finding\(s\)/);
  assert.throws(() => fuOf(s, ['F-ARG']), /only MINOR finding\(s\)/);
  assert.throws(() => fuOf(s, ['F-M', 'F-ARG']), /MINOR findings get no action/);
  const forged = structuredClone(s); forged.tickets['T-1'].findings['F-M'] = { severity: 'MINOR', specSentence: 'not in the spec' };
  forged.tickets['T-1-fu'] = { ...s.tickets['T-1'], status: 'started', followUpOf: 'T-1', fixes: ['F-M'], findings: {}, mergedHead: null, mergedTree: null, head: null, tree: null };
  assert.equal(followUpRefusal(forged, 'T-1-fu')?.reason, 'followup-minor-only');
  assert.match(followUpRefusal(forged, 'T-1-fu')!.detail, /its specSentence is not in the captured spec/);
});

test('#552 follow-up rule: a process finding never starts a code round — naming it in --fixes is refused, even beside a MAJOR and whatever its severity', () => {
  const s = mergedWith({ 'P-1': { severity: 'MINOR', kind: 'process', specSentence: 'Write the list in the pull request.' }, 'P-2': { severity: 'MAJOR', kind: 'process' }, 'F-MAJ': 'MAJOR' });
  for (const fixes of [['P-1'], ['P-1', 'F-MAJ'], ['P-2']]) assert.throws(() => fuOf(s, fixes), /process finding \(how the work is reported\)/, fixes.join());
  assert.equal(followUpRefusal({ ...s, tickets: { ...s.tickets, 'T-1-fu': { ...s.tickets['T-1'], status: 'started', followUpOf: 'T-1', fixes: ['P-1'], mergedHead: null, mergedTree: null, head: null, tree: null } } }, 'T-1-fu')?.reason, 'followup-process-finding');
});

test('#552 minorPolicy refuse (= #514 as it was): no merge block, a MINOR with an accepted sentence is NOT enough for a follow-up, the refusal says MINOR findings get no action', () => {
  const open = rec(open552(), { 'F-1': { severity: 'MINOR', specSentence: SENT } });
  assert.deepEqual(blockingMinors(open, 'T-1'), ['F-1']);
  const refuse = { ...open, switches: { minorPolicy: 'refuse' } } as FanoutState;
  assert.deepEqual(blockingMinors(refuse, 'T-1'), []);
  assert.equal(mergeBlockRefusal(refuse, 'T-1'), null);
  const s = mergedWith({ 'F-S': { severity: 'MINOR', specSentence: SENT }, 'F-MAJ': 'MAJOR' });
  const fu = (st: FanoutState, fixes: string[]) => ({ ...st, tickets: { ...st.tickets, 'T-1-fu': { ...st.tickets['T-1'], status: 'started' as const, followUpOf: 'T-1', fixes, mergedHead: null, mergedTree: null, head: null, tree: null, findings: {} } } });
  assert.equal(followUpRefusal(fu(s, ['F-S']), 'T-1-fu'), null, 'spec: accepted');
  const r = followUpRefusal(fu({ ...s, switches: { minorPolicy: 'refuse' } } as FanoutState, ['F-S']), 'T-1-fu');
  assert.equal(r?.reason, 'followup-minor-only');
  assert.match(r!.detail, /MINOR findings get no action \(no follow-up PR/);
  assert.doesNotMatch(r!.detail, /specSentence is a literal/, 'the refuse wording is the #514 sentence');
  assert.equal(followUpRefusal(fu({ ...s, switches: { minorPolicy: 'refuse' } } as FanoutState, ['F-MAJ']), 'T-1-fu'), null, 'a MAJOR is enough under refuse');
});

test('#552 D5: fewer than 15 trimmed characters is no sentence (CJK counts characters, a rule line `- - -` is too short); CRLF capture is normalised; a follow-up candidate inherits the base spec text; an ARGUED MINOR with an accepted sentence is a valid --fixes target', () => {
  for (const sentence of ['a', 'endpoint', 'The endpoint']) assert.throws(() => rec(open552(), { 'F-1': { severity: 'MINOR', specSentence: sentence } }), /at least 15 characters/, sentence);
  assert.doesNotThrow(() => rec(open552(), { 'F-1': { severity: 'MINOR', specSentence: 'returns 404 for' } }));
  assert.throws(() => rec(open552(), { 'F-1': { severity: 'MINOR', specSentence: '- - -' } }), /at least 15 characters/);
  const cjk = '出力にはidを表示する必要があります。出力にはidを表示する。';
  const cj = applyTicketPatch(newState('r', { now: T }), 'T-1', { status: 'started', spec: 'spec.md' }, T, { specText: `${cjk}\n` });
  assert.doesNotThrow(() => rec(cj, { 'F-1': { severity: 'MINOR', specSentence: cjk } }), 'a CJK sentence is long enough');
  const crlf = applyTicketPatch(newState('r', { now: T }), 'T-1', { status: 'started', spec: 'spec.md' }, T, { specText: SPEC.replace(/\n/g, '\r\n') });
  assert.equal(crlf.tickets['T-1'].specText, SPEC);
  assert.doesNotThrow(() => rec(crlf, { 'F-1': { severity: 'MINOR', specSentence: 'pull request.\nThe endpoint returns 404' } }));
  // follow-up candidate: no spec of its own → the base's text; it records a sentence MINOR and is blocked by it
  const base = mergedWith({ 'F-MAJ': 'MAJOR' });
  const fuS = applyTicketPatch(base, 'T-1-fu', { status: 'started', branch: 'fu', followUpOf: 'T-1', fixes: ['F-MAJ'], findings: { 'N-1': { severity: 'MINOR', specSentence: SENT } } }, T);
  assert.equal(fuS.tickets['T-1-fu'].specText, null);
  assert.deepEqual(blockingMinors(fuS, 'T-1-fu'), ['N-1']);
  assert.throws(() => applyTicketPatch(base, 'T-5', { status: 'started', findings: { 'N-1': { severity: 'MINOR', specSentence: SENT } } }, T), /no spec text was captured/, 'a plain ticket with no spec of its own does not inherit');
  // D5 pin
  const arg = mergedWith({ 'F-A': { severity: 'MINOR', evidence: 'argued', specSentence: SENT }, 'F-B': { severity: 'MINOR', evidence: 'argued' } });
  assert.doesNotThrow(() => fuOf(arg, ['F-A']));
  assert.throws(() => fuOf(arg, ['F-B']), /only MINOR finding\(s\)/);
});

test('#552 D5 review: inherited sentences cannot be silently un-blocked, the chain inherits, a CRLF sentence is the same sentence', () => {
  const base = mergedWith({ 'F-MAJ': 'MAJOR' });
  const c = applyTicketPatch(base, 'C', { status: 'started', branch: 'c', followUpOf: 'T-1', fixes: ['F-MAJ'], findings: { G: { severity: 'MINOR', specSentence: SENT } } }, T);
  assert.deepEqual(blockingMinors(c, 'C'), ['G']);
  // giving the candidate its OWN, different spec must not drop the inherited sentence unnoticed
  assert.throws(() => applyTicketPatch(c, 'C', { spec: 'own.md' }, T, { specText: 'a different spec of its own' }), /no longer contains the specSentence of G/);
  // …and re-capturing the BASE's text is guarded by the candidates that inherit it
  assert.throws(() => applyTicketPatch(c, 'T-1', {}, T, { specText: 'another text' }), /no longer contains the specSentence of C\/G/);
  // chain: D follows C (merged), C's inherited-sentence MINOR G is a valid target
  const cm = applyTicketPatch(c, 'C', { status: 'merged', head: 'c'.repeat(40) }, T);
  const d = applyTicketPatch(cm, 'D', { status: 'started', branch: 'd', followUpOf: 'C', fixes: ['G'] }, T);
  assert.deepEqual(d.tickets.D.fixes, ['G']);
  assert.doesNotThrow(() => rec(open552(), { 'F-1': { severity: 'MINOR', specSentence: 'pull request.\r\nThe endpoint returns 404' } }), 'a CRLF-quoted sentence is normalised');
});

test('#552 review delta M1: the lost-sentence guard covers EVERY ticket whose chain passes through the change — depth 2, `spec` null, a re-parent', () => {
  const b = mergedWith({ 'F-MAJ': 'MAJOR' });
  const c = applyTicketPatch(b, 'C', { status: 'merged', head: 'c'.repeat(40), branch: 'c', followUpOf: 'T-1', fixes: ['F-MAJ'], findings: { G: 'MAJOR' } }, T);
  const d = applyTicketPatch(c, 'D', { status: 'started', branch: 'd', followUpOf: 'C', fixes: ['G'], findings: { f1: { severity: 'MINOR', specSentence: SENT } } }, T);
  assert.deepEqual(blockingMinors(d, 'D'), ['f1']);
  assert.throws(() => applyTicketPatch(d, 'T-1', {}, T, { specText: 'a text without the sentence' }), /no longer contains the specSentence of D\/f1/, 'B re-capture, two hops up');
  assert.throws(() => applyTicketPatch(d, 'T-1', { spec: null }, T), /no longer contains the specSentence of D\/f1/, 'B --spec null');
  const e = applyTicketPatch(applyTicketPatch(d, 'E', { status: 'started', spec: 'e.md' }, T, { specText: 'E has another text entirely.' }), 'E', { status: 'merged', head: 'e'.repeat(40), branch: 'e' }, T);
  assert.throws(() => applyTicketPatch(e, 'C', { followUpOf: 'E' }, T), /no longer contains the specSentence of D\/f1/, 'C re-parented to E');
  const settled = applyTicketPatch(d, 'D', { settle: { f1: { how: 'fixed', ref: 'abc1234' } } }, T);
  assert.doesNotThrow(() => applyTicketPatch(settled, 'T-1', {}, T, { specText: 'a text without the sentence' }), 'a settled sentence no longer pins the text');
});
