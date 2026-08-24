import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  scopeSessionsToWorktree,
  chooseSession,
  type SessionCandidate,
} from './session-discovery.ts';

const WT = '/home/u/.orchestra/worktrees/repo-mine-1111';
const SIBLING = '/home/u/.orchestra/worktrees/repo-other-2222';

const s = (id: string, lastModified?: number, cwd?: string): SessionCandidate => ({
  sessionId: id,
  lastModified,
  cwd,
});

describe('scopeSessionsToWorktree', () => {
  test('does NOT filter on cwd — a promoted workspace keeps its history', () => {
    // Regression, measured on the real home: a workspace promoted from a
    // scratch dir to a git worktree has transcripts whose recorded `cwd` is the
    // OLD scratch path, while the files live in the NEW worktree's transcript
    // dir. A `cwd === worktreePath` filter silently discarded that workspace's
    // only session — its entire history. Scoping is done by the caller's
    // `dir` + `includeWorktrees:false`, not here.
    const promoted = s('promoted', 5, '/home/u/.orchestra/scratch/orchestrator-clever-spark-3677');
    const out = scopeSessionsToWorktree([promoted], WT);
    assert.deepEqual(
      out.map((x) => x.sessionId),
      ['promoted'],
    );
  });

  test('keeps sessions with no cwd', () => {
    const out = scopeSessionsToWorktree([s('nocwd', 1)], WT);
    assert.deepEqual(
      out.map((x) => x.sessionId),
      ['nocwd'],
    );
  });

  test('keeps every session it is handed, in recency order', () => {
    // The caller has already scoped the query; this function must not second-
    // guess it by dropping rows.
    const out = scopeSessionsToWorktree([s('a', 1, WT), s('b', 2, SIBLING), s('c', 3)], WT);
    assert.equal(out.length, 3);
  });

  test('orders newest-first by lastModified', () => {
    const out = scopeSessionsToWorktree([s('old', 100, WT), s('new', 900, WT), s('mid', 500, WT)], WT);
    assert.deepEqual(
      out.map((x) => x.sessionId),
      ['new', 'mid', 'old'],
    );
  });

  test('ordering does not depend on input order (guards a no-op sort)', () => {
    // A sort keyed on a field that does not exist on the payload (`mtime`) is a
    // no-op that still passes whenever the input arrives pre-sorted. Feeding
    // REVERSED input is what makes such a sort fail.
    const asc = [s('old', 1, WT), s('mid', 2, WT), s('new', 3, WT)];
    assert.deepEqual(
      scopeSessionsToWorktree(asc, WT).map((x) => x.sessionId),
      ['new', 'mid', 'old'],
    );
  });

  test('treats a missing lastModified as oldest, never as newest', () => {
    const out = scopeSessionsToWorktree([s('undated', undefined, WT), s('dated', 5, WT)], WT);
    assert.equal(out[0].sessionId, 'dated');
  });

  test('does not mutate its input', () => {
    const input = [s('a', 1, WT), s('b', 2, WT)];
    scopeSessionsToWorktree(input, WT);
    assert.deepEqual(
      input.map((x) => x.sessionId),
      ['a', 'b'],
    );
  });
});

describe('chooseSession — the three states of sdkSessionId', () => {
  const candidates = [s('newest-on-disk', 9, WT), s('older', 1, WT)];

  test("'' (cleared) shows nothing AND disables the newest-session fallback", () => {
    // The regression this guards: /clear then reopen re-materialized the
    // conversation the user had just cleared.
    assert.deepEqual(chooseSession('', candidates), { kind: 'cleared' });
  });

  test('undefined (terminal-only workspace) falls back to the newest session', () => {
    assert.deepEqual(chooseSession(undefined, candidates), {
      kind: 'newest',
      sessionId: 'newest-on-disk',
    });
  });

  test("'' and undefined are NOT interchangeable", () => {
    // Collapsing them into one falsy check is the specific bug the signature
    // exists to prevent, so assert the two disagree rather than only that each
    // is individually right.
    assert.notDeepEqual(chooseSession('', candidates), chooseSession(undefined, candidates));
  });

  test('a persisted uuid resumes exactly that session', () => {
    assert.deepEqual(chooseSession('abc-123', candidates, () => true), {
      kind: 'persisted',
      sessionId: 'abc-123',
    });
  });

  test('a persisted id whose transcript is gone falls back to the newest', () => {
    assert.deepEqual(
      chooseSession('vanished', candidates, (id) => id !== 'vanished'),
      { kind: 'newest', sessionId: 'newest-on-disk' },
    );
  });

  test('cleared beats even a resumable-looking empty id', () => {
    assert.deepEqual(chooseSession('', candidates, () => true), { kind: 'cleared' });
  });

  test('no candidates and no persisted id → none', () => {
    assert.deepEqual(chooseSession(undefined, []), { kind: 'none' });
  });

  test('skips unresumable candidates when falling back', () => {
    assert.deepEqual(
      chooseSession(undefined, candidates, (id) => id === 'older'),
      { kind: 'newest', sessionId: 'older' },
    );
  });
});
