// #515 — the pure half of the forced acceptance flow: schema (old state files still load), phase, claim/settle, waive, bypass, wait window, status text, brief.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FanoutStateError, applyTicketPatch, newState, parseState, parseRunArgv } from './fanout-state.ts';
import {
  acceptancePhase, acceptorBrief, acceptorName, bypassInto, claimAcceptor, freezeInto, frozenRecipients, frozenStatusText, openWait, settleAcceptor, waiveInto,
} from './fanout-acceptance.ts';

const NOW = '2026-11-22T10:00:00.000Z';
const H = 'a'.repeat(64);
const withSpec = () => applyTicketPatch(newState('r1', { switches: { acceptance: 'on', minorPolicy: 'spec' }, now: NOW }), 'T1', { spec: 'docs/spec.md#T1', implementer: 'impl-1', verifier: 'verif-1' }, NOW);

test('schema: a state file written BEFORE #515 (no spec/implementer/verifier/accept) still loads, defaults null', () => {
  const s = parseState({ version: 1, run: 'r1', target: 'master', repo: null, updatedAt: NOW, reconciledAt: null, tickets: { T1: { branch: null, pr: null, head: null, verdict: 'none', dependsOn: [], builtOn: {}, frozenInterface: null, mergedAccepted: null, status: 'todo', acceptance: null, updatedAt: NOW } } });
  assert.deepEqual([s.tickets.T1.spec, s.tickets.T1.implementer, s.tickets.T1.verifier, s.tickets.T1.accept], [null, null, null, null]);
  assert.equal(acceptancePhase(s.tickets.T1), 'unspecified');
});

test('schema must-FAIL: unsafe workspace ids, a multi-line spec, an unknown accept key, a non-positive wait bound are refused', () => {
  const base = withSpec();
  for (const patch of [{ implementer: '../x' }, { verifier: 'a b' }, { spec: 'line1\nline2' }, { spec: 'x'.repeat(501) }]) assert.throws(() => applyTicketPatch(base, 'T1', patch, NOW), FanoutStateError, JSON.stringify(patch));
  const bad = (accept: unknown) => () => parseState({ ...JSON.parse(JSON.stringify(base)), tickets: { T1: { ...JSON.parse(JSON.stringify(base.tickets.T1)), accept } } });
  assert.throws(bad({ acceptor: null, wait: null, waived: null, extra: 1 }), /unknown field "extra"/);
  assert.throws(bad({ acceptor: null, wait: { since: NOW, deadline: NOW, boundSec: 0 }, waived: null }), /boundSec must be a positive integer/);
  assert.throws(bad({ acceptor: { id: 'w1', name: 'accept-T1', at: 'not a date' }, wait: null, waived: null }), /ISO date/);
  assert.doesNotThrow(bad({ acceptor: { id: null, name: 'accept-T1', at: NOW, error: 'boom' }, wait: null, waived: null }));
});

test('phase: unspecified (no spec) · pending (spec, nothing frozen) · frozen · waived — frozen wins over waived, waived over pending; unknown ticket = none', () => {
  const s = withSpec();
  assert.equal(acceptancePhase(s.tickets.T1), 'pending');
  assert.equal(acceptancePhase(applyTicketPatch(newState('r1', { switches: { acceptance: 'on', minorPolicy: 'spec' }, now: NOW }), 'T2', { status: 'todo' }, NOW).tickets.T2), 'unspecified');
  assert.equal(acceptancePhase(undefined), 'none');
  const w = waiveInto(s, 'T1', { decision: 'https://github.com/o/r/issues/1#issuecomment-2', reason: 'docs', now: NOW });
  assert.equal(acceptancePhase(w.tickets.T1), 'waived');
  const f = freezeInto(s, 'T1', { files: { 't/a.test.js': H }, run: 'node --test t/a.test.js', source: { branch: 'acceptance/r1', head: 'b'.repeat(40) }, now: NOW });
  assert.equal(acceptancePhase(f.tickets.T1), 'frozen');
});

test('claim/settle: one writer per ticket; a failed spawn is retryable; a frozen / waived / spec-less ticket cannot be claimed', () => {
  const s = withSpec();
  const c = claimAcceptor(s, 'T1', 'accept-T1', NOW);
  assert.deepEqual(c.tickets.T1.accept?.acceptor, { id: null, name: 'accept-T1', at: NOW });
  assert.throws(() => claimAcceptor(c, 'T1', 'accept-T1', NOW), /already spawned/);
  const failed = settleAcceptor(c, 'T1', { error: 'boom' }, NOW);
  assert.equal(failed.tickets.T1.accept?.acceptor?.error, 'boom');
  const again = claimAcceptor(failed, 'T1', 'accept-T1', NOW); // retry after a failure
  assert.equal(again.tickets.T1.accept?.acceptor?.error, undefined);
  assert.equal(settleAcceptor(again, 'T1', { id: 'w1' }, NOW).tickets.T1.accept?.acceptor?.id, 'w1');
  assert.throws(() => claimAcceptor(applyTicketPatch(newState('r1', { switches: { acceptance: 'on', minorPolicy: 'spec' }, now: NOW }), 'T2', { status: 'todo' }, NOW), 'T2', 'accept-T2', NOW), /no spec registered/);
  assert.throws(() => claimAcceptor(waiveInto(s, 'T1', { decision: 'd', reason: 'r', now: NOW }), 'T1', 'accept-T1', NOW), /waived/);
  assert.throws(() => claimAcceptor(freezeInto(s, 'T1', { files: { 't/a.test.js': H }, run: 'node --test t/a.test.js', source: { branch: null, head: 'b'.repeat(40) }, now: NOW }), 'T1', 'accept-T1', NOW), /already frozen/);
});

test('waive: works WITHOUT a spec (a docs ticket); must-FAIL already frozen, already waived, empty reason', () => {
  const s = withSpec();
  const noSpec = applyTicketPatch(newState('r1', { switches: { acceptance: 'on', minorPolicy: 'spec' }, now: NOW }), 'T2', { status: 'todo' }, NOW);
  assert.equal(acceptancePhase(waiveInto(noSpec, 'T2', { decision: 'd', reason: 'r', now: NOW }).tickets.T2), 'waived');
  assert.throws(() => waiveInto(s, 'T1', { decision: 'd', reason: '  ', now: NOW }), /needs --reason/);
  const w = waiveInto(s, 'T1', { decision: 'd', reason: 'r', now: NOW });
  assert.throws(() => waiveInto(w, 'T1', { decision: 'd', reason: 'r', now: NOW }), /already waived/);
  const f = freezeInto(s, 'T1', { files: { 't/a.test.js': H }, run: 'node --test t/a.test.js', source: { branch: null, head: 'b'.repeat(40) }, now: NOW });
  assert.throws(() => waiveInto(f, 'T1', { decision: 'd', reason: 'r', now: NOW }), /nothing to waive/);
});

test('bypassInto: records the recorded escape on a pending ticket; leaves a frozen or already-waived ticket alone', () => {
  const s = withSpec();
  const b = bypassInto(s, 'T1', { head: 'c'.repeat(40), now: NOW });
  assert.equal(b.tickets.T1.accept?.waived?.decision, 'deliver --no-acceptance-gate');
  assert.equal(bypassInto(b, 'T1', { head: 'd'.repeat(40), now: NOW }), b);
});

test('wait window: opened with since/deadline = bound; a still-open window is reused, an expired one replaced; the freeze clears it', () => {
  const s = withSpec();
  const t0 = Date.parse(NOW);
  const a = openWait(s, 'T1', 60, t0);
  assert.deepEqual(a.wait, { since: NOW, deadline: new Date(t0 + 60_000).toISOString(), boundSec: 60 });
  const reuse = openWait(a.state, 'T1', 999, t0 + 30_000);
  assert.deepEqual(reuse.wait, a.wait, 'a concurrent gate keeps the window in force');
  const fresh = openWait(a.state, 'T1', 10, t0 + 61_000);
  assert.equal(fresh.wait.boundSec, 10);
  const f = freezeInto(a.state, 'T1', { files: { 't/a.test.js': H }, run: 'node --test t/a.test.js', source: { branch: null, head: 'b'.repeat(40) }, now: NOW });
  assert.equal(f.tickets.T1.accept?.wait, null);
});

test('brief + status: the brief carries spec + ticket and no implementer-side name; the status names path, command, branch and who is told', () => {
  const brief = acceptorBrief({ run: 'r1', ticket: 'T1', spec: 'docs/spec.md#T1', repo: 'o/r', target: 'master' });
  assert.match(brief, /docs\/spec\.md#T1/);
  assert.match(brief, /acceptance\/r1 of o\/r/);
  assert.match(brief, /do NOT read any implementer branch/);
  const text = frozenStatusText({ run: 'r1', ticket: 'T1', files: ['t/a.test.js', 't/b.test.js'], runCmd: 'node --test t/a.test.js t/b.test.js', branch: 'acceptance/r1', head: 'f'.repeat(40) });
  assert.match(text, /t\/a\.test\.js, t\/b\.test\.js/);
  assert.match(text, /Run: node --test t\/a\.test\.js t\/b\.test\.js\./);
  assert.match(text, /git checkout origin\/acceptance\/r1 -- t\/a\.test\.js t\/b\.test\.js/);
  const t = withSpec().tickets.T1;
  assert.deepEqual(frozenRecipients(t, 'w1'), ['impl-1', 'verif-1']);
  assert.deepEqual(frozenRecipients({ ...t, implementer: 'w1' }, 'w1'), ['verif-1'], 'never the writer itself');
  assert.deepEqual(frozenRecipients({ ...t, implementer: 'x', verifier: 'x' }, null), ['x'], 'de-duplicated');
});

test('acceptorName: letters/digits/._- only, always `accept-` + something', () => {
  assert.equal(acceptorName('T1'), 'accept-T1');
  assert.equal(acceptorName('#515'), 'accept-515');
  assert.equal(acceptorName('///'), 'accept-ticket');
});

test('parseRunArgv: the refusal text no longer advertises a package launcher (removed in #510 fix round 3), and a launcher is still refused', () => {
  assert.throws(() => parseRunArgv('npx vitest t/a.test.js', ['t/a.test.js']), (e: Error) => !/optionally behind/.test(e.message) && /DIRECTLY — no npx \/ pnpm exec \/ yarn exec launcher/.test(e.message));
  assert.throws(() => parseRunArgv('pnpm exec vitest t/a.test.js', ['t/a.test.js']), FanoutStateError);
  assert.deepEqual(parseRunArgv('node --test t/a.test.js', ['t/a.test.js']), ['node', '--test', 't/a.test.js']);
});
