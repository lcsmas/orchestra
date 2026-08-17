import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isScratchLike, canOrchestrate, type Workspace } from './types.ts';

/** The five workspace shapes the kind/capability split has to keep apart, plus
 * two defensive ones. `isScratchLike` answers "owns no git checkout?" and
 * `canOrchestrate` answers "may children nest under me?" — they are orthogonal,
 * and every bug this file guards against came from conflating them. */
const shapes = {
  scratch: { kind: 'scratch', repoPath: '' },
  orchestratorRepoLess: { kind: 'orchestrator', repoPath: '' },
  orchestratorRepoOwning: { kind: 'orchestrator', repoPath: '/r' },
  worktree: { kind: 'worktree', repoPath: '/r' },
  promotedWorktree: { kind: 'worktree', repoPath: '/r', canOrchestrate: true },
  /** Pre-`kind` records: absent kind means git worktree. */
  legacy: { repoPath: '/r' },
  /** Defensive: a scratch record that somehow carries a repoPath. */
  scratchStrayRepo: { kind: 'scratch', repoPath: '/r' },
} satisfies Record<string, Pick<Workspace, 'kind' | 'repoPath' | 'canOrchestrate'>>;

describe('isScratchLike', () => {
  it('is true for the repo-less kinds', () => {
    assert.equal(isScratchLike(shapes.scratch), true);
    assert.equal(isScratchLike(shapes.orchestratorRepoLess), true);
  });

  it('is FALSE for an orchestrator that has adopted a repo', () => {
    // The whole point of the change: such a workspace owns a real worktree, so
    // teardown must `git worktree remove` it, rename must run `git branch -m`,
    // and the diff/merge/PR UI must appear.
    assert.equal(isScratchLike(shapes.orchestratorRepoOwning), false);
  });

  it('is false for git worktrees, promoted or not, and for legacy records', () => {
    assert.equal(isScratchLike(shapes.worktree), false);
    assert.equal(isScratchLike(shapes.promotedWorktree), false);
    assert.equal(isScratchLike(shapes.legacy), false);
  });

  // Locks the CONJUNCTIVE form. A plain `return !ws.repoPath` would make this
  // false, arming `git worktree remove` on a record that only ever owned a
  // plain directory. If this fails, the predicate was "simplified" — don't.
  it('keeps a scratch record scratch-like even with a stray repoPath', () => {
    assert.equal(isScratchLike(shapes.scratchStrayRepo), true);
  });
});

describe('canOrchestrate', () => {
  it('is true for both routes to the tree role', () => {
    assert.equal(canOrchestrate(shapes.orchestratorRepoLess), true);
    assert.equal(canOrchestrate(shapes.orchestratorRepoOwning), true);
    assert.equal(canOrchestrate(shapes.promotedWorktree), true);
  });

  it('is false for non-coordinators', () => {
    assert.equal(canOrchestrate(shapes.scratch), false);
    assert.equal(canOrchestrate(shapes.worktree), false);
  });
});

describe('the two predicates are orthogonal', () => {
  // The docblock on `canOrchestrate` claims these answer different questions.
  // Assert it: they diverge on exactly the two shapes that own a repo AND
  // coordinate. Conflating them is what makes a coordinator lose its diff tab
  // or leak its worktree on delete.
  it('diverges on exactly the repo-owning coordinators', () => {
    const diverging = Object.entries(shapes)
      .filter(([, ws]) => canOrchestrate(ws) && !isScratchLike(ws))
      .map(([name]) => name)
      .sort();
    assert.deepEqual(diverging, ['orchestratorRepoOwning', 'promotedWorktree']);
  });
});
