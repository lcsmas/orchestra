import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchChecksFromRuns, type WorkflowRunLite } from './ci-state.ts';

let n = 0;
function run(over: Partial<WorkflowRunLite>): WorkflowRunLite {
  n += 1;
  return {
    branch: 'feat',
    sha: 'sha-1',
    status: 'completed',
    conclusion: 'success',
    name: `wf-${n}`,
    url: `https://x/${n}`,
    id: n,
    ...over,
  };
}

test('single failing run → fail with run pointers', () => {
  const m = branchChecksFromRuns([run({ conclusion: 'failure', id: 42 })]);
  const c = m.get('feat');
  assert.equal(c?.state, 'fail');
  assert.equal(c?.runId, 42);
});

test('sibling workflows on the same sha aggregate — one failure tints the branch', () => {
  const m = branchChecksFromRuns([
    run({ conclusion: 'success' }),
    run({ conclusion: 'failure' }),
  ]);
  assert.equal(m.get('feat')?.state, 'fail');
});

test('a failure on an OLDER sha is history — newest green sha wins', () => {
  const m = branchChecksFromRuns([
    run({ sha: 'new', conclusion: 'success' }),
    run({ sha: 'old', conclusion: 'failure' }),
  ]);
  assert.equal(m.get('feat')?.state, 'pass');
});

test('in-progress beats pass, fail beats in-progress', () => {
  const running = branchChecksFromRuns([
    run({ status: 'in_progress', conclusion: null }),
    run({ conclusion: 'success' }),
  ]);
  assert.equal(running.get('feat')?.state, 'running');
  const failing = branchChecksFromRuns([
    run({ status: 'in_progress', conclusion: null }),
    run({ conclusion: 'failure' }),
  ]);
  assert.equal(failing.get('feat')?.state, 'fail');
});

test('cancelled/skipped/neutral map to none, not fail', () => {
  const m = branchChecksFromRuns([
    run({ conclusion: 'cancelled' }),
    run({ conclusion: 'skipped' }),
  ]);
  assert.equal(m.get('feat')?.state, 'none');
});

test('null branch entries are skipped; branches keyed independently', () => {
  const m = branchChecksFromRuns([
    run({ branch: null }),
    run({ branch: 'a', conclusion: 'failure' }),
    run({ branch: 'b', conclusion: 'success' }),
  ]);
  assert.equal(m.size, 2);
  assert.equal(m.get('a')?.state, 'fail');
  assert.equal(m.get('b')?.state, 'pass');
});
