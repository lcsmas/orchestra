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
  assert.deepEqual(await r.forge.merge(r.n, r.head, 'merge'), { ok: true });
  assert.equal((await r.forge.prState(r.n)).state, 'merged');
  const call = r.fake.calls.find((c) => c[0] === 'pr' && c[1] === 'merge')!;
  assert.ok(call.includes('--merge') && !call.includes('--squash') && !call.includes('--rebase'), call.join(' '));
  assert.ok(call.includes('--match-head-commit') && call.includes(r.head));
});
test('MUST-FAIL: no recorded verdict → deliver refuses, gh merges nothing (the loop cannot bypass the review gate)', async () => {
  const r = await rig({ approve: false });
  r.fake.advance(300_000);
  const a = await r.forge.merge(r.n, r.head, 'merge');
  assert.deepEqual([a.ok, a.reason], [false, 'record-missing'], JSON.stringify(a));
  assert.equal(r.merges(), 0, 'no `gh pr merge` was issued');
  assert.equal((await r.forge.prState(r.n)).state, 'open');
});
test('MUST-FAIL: a red CI on the head → deliver refuses (a recorded approval does not buy a merge on a red check)', async () => {
  const r = await rig({ approve: true, ci: ['red:test'] });
  r.fake.advance(300_000);
  const a = await r.forge.merge(r.n, r.head, 'merge');
  assert.deepEqual([a.ok, a.reason], [false, 'ci-red'], JSON.stringify(a));
  assert.equal(r.merges(), 0);
});
test('MUST-FAIL: the head moved after the approval → refused, nothing merged', async () => {
  const r = await rig({ approve: true });
  r.fake.advance(300_000);
  r.fake.push('T1', sha40());
  const a = await r.forge.merge(r.n, r.head, 'merge');
  assert.deepEqual([a.ok, a.reason], [false, 'head-moved'], JSON.stringify(a));
  assert.equal(r.merges(), 0);
});
test('MUST-FAIL control: the bare fallback (no deliver wired) merges a ticket with NO verdict — which is why production never takes it', async () => {
  const r = await rig({ approve: false });
  r.fake.advance(300_000);
  const bare = createLiveForge({ gh: r.fake.gh, bareMerge: true });
  assert.deepEqual(await bare.merge(r.n, r.head, 'merge'), { ok: true });
});
test('MUST-FAIL: deliver acted on another pull request of the branch (the tracked one is closed) → refused before deliver can pick it, never reported as this PR\'s merge', async () => {
  const r = await rig({ approve: true });
  r.fake.advance(300_000);
  await r.forge.close(r.n); // the tracked PR #1 is closed …
  const again = (await r.fake.gh(['pr', 'create', '--head', 'T1', '--base', 'main', '--title', 'T1: again'])).stdout; // … and a second one is open on the same branch
  assert.match(again, /\/pull\/2/);
  r.fake.advance(300_000);
  const a = await r.forge.merge(r.n, r.head, 'merge');
  assert.deepEqual([a.ok, a.reason], [false, 'pr-not-open'], JSON.stringify(a));
  assert.equal((await r.fake.gh(['pr', 'view', '2', '--json', 'state'])).stdout.includes('MERGED'), false, 'nothing merged under the loop\'s feet');
});

// ── #628: the forge's merge-conflict reaches the loop as a REASON, whichever way GitHub says it ──
test('#628: a CONFLICTING pull request → deliver refuses `merge-conflict`, nothing is merged (the loop turns it into the SYNC order)', async () => {
  const r = await rig({ approve: true });
  r.fake.advance(300_000);
  r.fake.conflicting.add(r.n);
  const a = await r.forge.merge(r.n, r.head, 'merge');
  assert.deepEqual([a.ok, a.reason], [false, 'merge-conflict'], JSON.stringify(a));
  assert.equal(r.merges(), 0, 'gh merged nothing');
});
test('#628: MERGEABLE at the decision, refused at the merge call ("not mergeable … cannot be cleanly created") → still `merge-conflict`, not an opaque merge-failed', async () => {
  const r = await rig({ approve: true });
  r.fake.advance(300_000);
  r.fake.conflictsAtMerge.add(r.n);
  const a = await r.forge.merge(r.n, r.head, 'merge');
  assert.deepEqual([a.ok, a.reason], [false, 'merge-conflict'], JSON.stringify(a));
});
test('#628: the bare gh fallback classifies a conflict refusal the same way', async () => {
  const fake = new FakeForge();
  const head = fake.push('T1', sha40());
  const forge = createLiveForge({ gh: fake.gh, bareMerge: true });
  const { n } = await forge.openPr({ branch: 'T1', base: 'main', title: 'T1: x' });
  fake.advance(300_000);
  fake.conflicting.add(n);
  const a = await forge.merge(n, head, 'merge');
  assert.deepEqual([a.ok, a.reason], [false, 'merge-conflict'], JSON.stringify(a));
});

// ── #689: the loop reads `mergeable` itself (a CONFLICTING PR has no merge ref → no Actions run → nothing else would say it) ──
test('#689: prState carries GitHub\'s mergeable word: MERGEABLE / CONFLICTING', async () => {
  const r = await rig({ approve: true });
  assert.equal((await r.forge.prState(r.n)).mergeable, 'MERGEABLE');
  r.fake.conflicting.add(r.n);
  assert.equal((await r.forge.prState(r.n)).mergeable, 'CONFLICTING');
});
test('#689: UNKNOWN is read once more at once; still UNKNOWN → reported as UNKNOWN (never a verdict)', async () => {
  const r = await rig({ approve: true });
  r.fake.unknownReads.set(r.n, 1);
  assert.equal((await r.forge.prState(r.n)).mergeable, 'MERGEABLE', 'the second read answered');
  r.fake.unknownReads.set(r.n, 5);
  assert.equal((await r.forge.prState(r.n)).mergeable, 'UNKNOWN');
});

// ── #627: the run target, with a fake exec ──
import { livePlanner, resolveRunTarget } from './fanout-run-live.ts';
import type { Exec } from '../shared/fanout-loop-live-git.ts';
const execOf = (answers: Record<string, { code: number; stdout?: string; stderr?: string }>, calls: string[] = []): Exec => async (cmd, args) => { const k = `${cmd} ${args.join(' ')}`; calls.push(k); const hit = Object.entries(answers).find(([p]) => k.startsWith(p)); return { code: hit?.[1].code ?? 1, stdout: hit?.[1].stdout ?? '', stderr: hit?.[1].stderr ?? 'nope' }; };
test('#627: origin/HEAD present → used, no network call', async () => {
  const calls: string[] = [];
  assert.equal(await resolveRunTarget(execOf({ 'git symbolic-ref': { code: 0, stdout: 'origin/trunk\n' } }, calls), '/x', 'o/r'), 'trunk');
  assert.equal(calls.length, 1);
});
test('#627: no origin/HEAD → the GitHub default branch (`gh repo view <repo> --json defaultBranchRef`)', async () => {
  const calls: string[] = [];
  assert.equal(await resolveRunTarget(execOf({ 'gh repo view': { code: 0, stdout: 'main\n' } }, calls), '/x', 'o/r'), 'main');
  assert.ok(calls.some((c) => c === 'gh repo view o/r --json defaultBranchRef -q .defaultBranchRef.name'), calls.join(' | '));
});
test('#627: no origin/HEAD and no gh → `git ls-remote --symref origin HEAD`', async () => {
  const out = 'ref: refs/heads/develop\tHEAD\n0123456789012345678901234567890123456789\tHEAD\n';
  assert.equal(await resolveRunTarget(execOf({ 'git ls-remote': { code: 0, stdout: out } }), '/x', null), 'develop');
});
test('#627: nothing answers → [run-target], the loop never guesses; a gh answer that is not a branch name is not used', async () => {
  await assert.rejects(resolveRunTarget(execOf({}), '/x', null), /run-target|cannot tell the default branch/);
  await assert.rejects(resolveRunTarget(execOf({ 'gh repo view': { code: 0, stdout: 'not a branch; rm -rf' } }), '/x', null), /cannot tell the default branch/);
});

// ── #625: the live planner drives the shipped `fanout plan` verb ──
test('#625: the live planner re-asks `fanout plan` after its "no accepted plan" exit 1, stops at the accepted plan', async () => {
  const seen: string[][] = [];
  const answers = [{ code: 1, stdout: '', stderr: 'no accepted plan after 45 min — nothing was recorded' }, { code: 0, stdout: '{"plan":"accepted"}', stderr: '' }];
  await livePlanner({ cli: async (a) => { seen.push(a); return answers.shift()!; }, run: 'r1', log: () => {} })(['T1', 'T2']);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], ['fanout', 'plan', '--tickets', 'T1,T2', '--run', 'r1']);
});
test('#625: a plan refusal ([plan-refused-twice], exit 2) ends the run as a refusal; any other failure is not retried for ever', async () => {
  await assert.rejects(livePlanner({ cli: async () => ({ code: 2, stdout: '', stderr: 'plan agent spawned\n[plan-refused-twice] the run does not start' }), run: 'r1', log: () => {} })(['T1']), (e: Error) => e.constructor.name === 'SeatRefusal' && /does not start/.test(e.message));
  let calls = 0;
  await assert.rejects(livePlanner({ cli: async () => { calls++; return { code: 1, stdout: '', stderr: 'host down' }; }, run: 'r1', log: () => {} })(['T1']), /host down/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(livePlanner({ cli: async () => { calls++; return { code: 1, stdout: '', stderr: 'no accepted plan after 45 min' }; }, run: 'r1', log: () => {}, attempts: 3 })(['T1']), /no accepted plan after 3 asks/);
  assert.equal(calls, 3);
});
