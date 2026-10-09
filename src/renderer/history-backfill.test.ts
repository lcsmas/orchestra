import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRequestHistory, dedupeHistoryAgainstLive, dropLiveEchoes, mergeHistoryIntoLive } from './history-backfill.ts';
import { foldEvents, emptySession } from '../shared/agent-events.ts';
import { interleaveMemNotices, makeMemNotice, memNoticeEntryOf } from '../shared/mem-notice.ts';
import type { MemKillRecord } from '../shared/memory-scope.ts';

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

// #227 — a start failure is emitted live AND persisted for the backfill (different ids): one failure must render once.
test('dropLiveEchoes (errors): a history error row the live fold already holds (same at+text) is dropped; different ones stay', () => {
  const live = [{ role: 'error', at: 1000, text: "Couldn't start the agent: X" }, { role: 'user', at: 1001, text: 'hi' }];
  const history = [
    { id: 'h1', role: 'error', at: 1000, text: "Couldn't start the agent: X" }, // the echo of the live row
    { id: 'h2', role: 'error', at: 900, text: "Couldn't start the agent: OLDER" }, // an earlier failure the live fold never saw
    { id: 'h3', role: 'error', at: 1000, text: 'a different failure at the same instant' },
    { id: 'h4', role: 'user', at: 1001, text: 'hi' }, // non-error rows are never this helper's business
  ];
  assert.deepEqual(dropLiveEchoes(history, live).map((m) => m.id), ['h2', 'h3', 'h4']);
  assert.deepEqual(dropLiveEchoes(history, []).map((m) => m.id), ['h1', 'h2', 'h3', 'h4'], 'no live rows → nothing to echo');
});

// #322 review F1 — the Plafond mémoire notice is emitted live (`notice:<liveSeq>`) AND rebuilt from `sdkMemNotices` by the backfill (`notice:<HISTORY_SEQ_BASE+n>`): a pane opened after a kill
// in a headless session must show it ONCE. Driven through the REAL fold and the REAL merge the store runs.
const rec: MemKillRecord = { kind: 'kill', source: 'kernel', seq: 1, at: 1_700_000_000_000, level: 'hard', command: 'python hog.py', pid: 4242, rssBytes: 1e8, candidates: [], unit: 'orchestra-ws-x-abc.scope', hardBytes: 6 * 2 ** 30 };

test('review F1: a Plafond mémoire notice seen live and read back off the store renders ONCE after the backfill (different ids, same row)', () => {
  const entry = memNoticeEntryOf(rec);
  const live = foldEvents(emptySession('ws'), [makeMemNotice({ seq: 57 }, entry)] as never);
  const history = foldEvents(emptySession('ws'), interleaveMemNotices([], [entry], { seq: 1_000_000 }) as never);
  assert.notEqual(live.messages[0].id, history.messages[0].id, 'precondition: the ids differ (that is the bug class)');
  const shown = mergeHistoryIntoLive(history.messages, live.messages);
  assert.equal(shown.length, 1, 'one row, not two');
  assert.equal(shown[0].id, live.messages[0].id, 'the live row stays');
});

test('review F1 controls: an EARLIER notice the live fold never saw stays; the same notice with a different text/at stays; a pane that never saw it live shows the history row', () => {
  const e1 = memNoticeEntryOf(rec);
  const e2 = memNoticeEntryOf({ ...rec, seq: 2, at: rec.at + 1000, command: 'make -j8' });
  const live = foldEvents(emptySession('ws'), [makeMemNotice({ seq: 57 }, e2)] as never);
  const history = foldEvents(emptySession('ws'), interleaveMemNotices([], [e1, e2], { seq: 1_000_000 }) as never);
  assert.deepEqual(mergeHistoryIntoLive(history.messages, live.messages).map((m) => m.text), [e1.text, e2.text], 'the older kill is prepended, the live one is not repeated');
  assert.equal(mergeHistoryIntoLive(history.messages, []).length, 2, 'no live rows ⇒ nothing to echo');
  assert.equal(dropLiveEchoes([{ id: 'h', role: 'system', noticeKind: 'info', at: 5, text: 'x' }], [{ role: 'system', noticeKind: 'warning', at: 5, text: 'x' }]).length, 1, 'a different notice KIND is a different row');
  assert.equal(dropLiveEchoes([{ id: 'h', role: 'user', at: 5, text: 'x' }], [{ role: 'user', at: 5, text: 'x' }]).length, 1, 'user/assistant rows are never this helper\'s business');
});

test('H03: a history row the live fold already holds BY ID is not repeated — whatever its kind (the id filter is the first guard, the echo drop the second); older rows are prepended in order', () => {
  const live = [{ id: 'a', role: 'assistant', at: 2, text: 't1' }, { id: 'b', role: 'user', at: 3, text: 't2' }];
  const history = [{ id: 'z', role: 'user', at: 1, text: 'old' }, { id: 'a', role: 'assistant', at: 2, text: 't1' }, { id: 'b', role: 'user', at: 3, text: 't2' }];
  assert.deepEqual(mergeHistoryIntoLive(history, live).map((m) => m.id), ['z', 'a', 'b'], 'no id twice');
  assert.deepEqual(mergeHistoryIntoLive(history, []).map((m) => m.id), ['z', 'a', 'b'], 'control: with no live rows nothing is dropped');
  // the LIVE copy wins (it is the fresher one), and the key is the ID — not the content
  const stale = [{ id: 'a', role: 'assistant', at: 2, text: 'stale history copy' }];
  const fresh = [{ id: 'a', role: 'assistant', at: 2, text: 'fresh live copy' }];
  assert.deepEqual(mergeHistoryIntoLive(stale, fresh).map((m) => m.text), ['fresh live copy'], 'same id: the live row stays, the history copy goes');
  const sameText = mergeHistoryIntoLive([{ id: 'h2', role: 'assistant', at: 2, text: 't1' }], [{ id: 'a', role: 'assistant', at: 2, text: 't1' }]);
  assert.deepEqual(sameText.map((m) => m.id), ['h2', 'a'], 'a different id with identical content is a different row (only notices/errors echo by content)');
});
