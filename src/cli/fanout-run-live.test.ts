// #614 — the live MERGE is the shipped `deliver`: its refusals are the loop's (no verdict recorded, CI red or still running, the head moved) and nothing merges around them; with a recorded approval and a green CI the same call
// merges, with a MERGE COMMIT. Driven on the fake `gh` (the real `deliver` code, the real run state, the real recorded-verdict reader).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeThroughDeliver } from './fanout-run-live.ts';
import { createLiveForge } from '../shared/fanout-loop-live-forge.ts';
import { FakeForge } from '../shared/fanout-loop-live-fake-gh.ts';
import { claimReviewer, settleReviewer, reviewerName } from '../shared/fanout-review.ts';
import { recordReview } from '../shared/fanout-record.ts';
import { applyTicketPatch, newState, readState, setPlan, stateFile, updateState } from '../shared/fanout-state.ts';
import type { DeliverDeps } from './fanout-deliver.ts';

const NOW = '2026-01-01T00:00:00.000Z';
const RUN = 'run-live';
const sha40 = (): string => crypto.randomBytes(20).toString('hex');

async function rig(o: { approve: boolean; ci?: string[] }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'live-deliver-'));
  const fake = new FakeForge();
  if (o.ci) fake.script.set('T1', o.ci);
  const head = fake.push('T1', sha40());
  const forgeBare = createLiveForge({ gh: fake.gh });
  const { n } = await forgeBare.openPr({ branch: 'T1', base: 'main', title: 'T1: x' });
  const tree = fake.treeOf(head);
  updateState(stateFile(home, RUN), () => {
    let s = newState(RUN, { target: 'main', repo: null, switches: { seatRecords: 'on', minorPolicy: 'demonstrated', verifier: 'off' }, now: NOW });
    s = setPlan(s, ['T1'], 'declare', NOW);
    s = applyTicketPatch(s, 'T1', { dependsOn: [], spec: 's', branch: 'T1', head, pr: n, status: 'nominated' }, NOW, { tree });
    if (o.approve) {
      s = settleReviewer(claimReviewer(s, 'T1', { kind: 'spawn', name: reviewerName('T1', 1), head, base: null, text: 'brief', now: NOW }), 'T1', { id: 'ws-rev' }, NOW);
      s = recordReview(s, 'T1', { head, verdict: 'approve', input: { findings: {}, fixed: [] }, callerId: 'ws-rev', callerVouched: true, tree, now: NOW });
    }
    return s;
  });
  const logs: string[] = [];
  const deps: Partial<DeliverDeps> = { gh: fake.gh, sleep: async (ms) => { fake.advance(ms); }, now: () => fake.clock, log: (l) => logs.push(l)};
  const deliver = mergeThroughDeliver({ home, run: RUN, log: (l) => logs.push(l), deps });
  const forge = createLiveForge({ gh: fake.gh, deliver });
  const merges = (): number => fake.calls.filter((c) => c[0] === 'pr' && c[1] === 'merge').length;
  return { fake, forge, head, n, merges, logs, home };
}

test('deliver is the merge: a recorded approval + a green CI on the head merges, with a MERGE COMMIT', async () => {
  const r = await rig({ approve: true });
  r.fake.advance(300_000); // the CI is done
  assert.deepEqual(await r.forge.merge(r.n, r.head), { ok: true });
  assert.equal((await r.forge.prState(r.n)).state, 'merged');
  const call = r.fake.calls.find((c) => c[0] === 'pr' && c[1] === 'merge')!;
  assert.ok(call.includes('--merge') && !call.includes('--squash') && !call.includes('--rebase'), call.join(' '));
  assert.ok(call.includes('--match-head-commit') && call.includes(r.head));
});
test('MUST-FAIL: no recorded verdict → deliver refuses, gh merges nothing (the loop cannot bypass the review gate)', async () => {
  const r = await rig({ approve: false });
  r.fake.advance(300_000);
  const a = await r.forge.merge(r.n, r.head);
  assert.deepEqual([a.ok, a.reason], [false, 'record-missing'], JSON.stringify(a));
  assert.equal(r.merges(), 0, 'no `gh pr merge` was issued');
  assert.equal((await r.forge.prState(r.n)).state, 'open');
});
test('MUST-FAIL: a red CI on the head → deliver refuses (a recorded approval does not buy a merge on a red check)', async () => {
  const r = await rig({ approve: true, ci: ['red:test'] });
  r.fake.advance(300_000);
  const a = await r.forge.merge(r.n, r.head);
  assert.deepEqual([a.ok, a.reason], [false, 'ci-red'], JSON.stringify(a));
  assert.equal(r.merges(), 0);
});
test('MUST-FAIL: the head moved after the approval → refused, nothing merged', async () => {
  const r = await rig({ approve: true });
  r.fake.advance(300_000);
  r.fake.push('T1', sha40());
  const a = await r.forge.merge(r.n, r.head);
  assert.deepEqual([a.ok, a.reason], [false, 'head-moved'], JSON.stringify(a));
  assert.equal(r.merges(), 0);
});
test('MUST-FAIL control: the bare fallback (no deliver wired) merges a ticket with NO verdict — which is why production never takes it', async () => {
  const r = await rig({ approve: false });
  r.fake.advance(300_000);
  const bare = createLiveForge({ gh: r.fake.gh });
  assert.deepEqual(await bare.merge(r.n, r.head), { ok: true });
});
