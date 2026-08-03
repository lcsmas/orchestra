import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRequestHistory, dedupeHistoryAgainstLive } from './history-backfill.ts';

// The OLD gate, kept verbatim as a control. Every test below that documents the
// bug asserts the old gate gets it WRONG and the new one gets it RIGHT — so the
// suite would fail if someone reverted the fix (mutation-tested by construction).
function oldGate(s: { requestedThisMount: boolean; messageCount: number }): boolean {
  return !s.requestedThisMount && s.messageCount === 0;
}

const base = {
  requestedThisMount: false,
  alreadyBackfilled: false,
  messageCount: 0,
  cleared: false,
};

test('fresh pane on a session with history on disk: requests backfill', () => {
  assert.equal(shouldRequestHistory(base), true);
  assert.equal(oldGate(base), true); // old gate agreed here — not the bug case
});

test('does not re-request while a request is already in flight this mount', () => {
  assert.equal(shouldRequestHistory({ ...base, requestedThisMount: true }), false);
});

test('does not re-request a session already backfilled', () => {
  assert.equal(
    shouldRequestHistory({ ...base, alreadyBackfilled: true, messageCount: 412 }),
    false,
  );
});

test('a cleared session (/clear) never backfills', () => {
  assert.equal(shouldRequestHistory({ ...base, cleared: true }), false);
});

// ── THE REGRESSION THIS FIX EXISTS FOR ──────────────────────────────────────
// Reproduces the reported "some transcript disappeared": a pane is evicted by
// the LRU cap, a background turn folds a few messages into the store while it
// is unmounted, and the user reopens the workspace.
test('REGRESSION: remount after events folded while unmounted still backfills', () => {
  const evictedThenGotBackgroundTurn = {
    ...base,
    alreadyBackfilled: false, // never backfilled: the pane was gone
    messageCount: 3, // 3 orphan messages from a background turn
  };

  // The old gate saw 3 messages and concluded history was present, rendering
  // those 3 as the whole conversation — the disappearing transcript.
  assert.equal(oldGate(evictedThenGotBackgroundTurn), false);

  // The new gate keys on `alreadyBackfilled`, so the history is still fetched.
  assert.equal(shouldRequestHistory(evictedThenGotBackgroundTurn), true);
});

test('REGRESSION: history is prepended to live messages, never dropped', () => {
  // The orphan messages folded in while unmounted are NEWER than everything on
  // disk, so history must land before them rather than being discarded.
  const { prepend, overlap } = dedupeHistoryAgainstLive({
    liveIds: ['m-401', 'm-402', 'm-403'],
    historyIds: ['m-001', 'm-002', 'm-003'],
  });
  assert.deepEqual(prepend, ['m-001', 'm-002', 'm-003']);
  assert.equal(overlap, 0);
});

test('overlapping ids are not duplicated when history re-reads folded lines', () => {
  // A live turn that was ALSO flushed to disk appears in both lists; the
  // on-disk copy must not render a second time.
  const { prepend, overlap } = dedupeHistoryAgainstLive({
    liveIds: ['m-002', 'm-003'],
    historyIds: ['m-001', 'm-002', 'm-003'],
  });
  assert.deepEqual(prepend, ['m-001']);
  assert.equal(overlap, 2);
});
