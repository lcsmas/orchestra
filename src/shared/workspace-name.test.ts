import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceDisplayName } from './workspace-name.ts';

describe('workspaceDisplayName', () => {
  // REGRESSION: the scratch rename branch hardcoded `scratch · `, so a
  // repo-less orchestrator's FIRST auto-rename silently relabelled it back to
  // `scratch · …` — undoing what /promote had set. Orchestrators ship
  // `branchManuallySet: false`, so that path fires on the first agent turn.
  it('keeps the coordinator prefix on a repo-less orchestrator', () => {
    assert.equal(
      workspaceDisplayName({ kind: 'orchestrator', repoPath: '' }, 'my-branch'),
      'orchestrator · my-branch',
    );
  });

  // The mirror defect: the git rename branch hardcoded `<repoName> · `, which
  // would strip the coordinator prefix once an orchestrator adopts a repo.
  it('keeps the coordinator prefix on a repo-owning orchestrator', () => {
    assert.equal(
      workspaceDisplayName({ kind: 'orchestrator', repoPath: '/home/u/dev/metarepo' }, 'coord'),
      'orchestrator · coord',
    );
  });

  it('names a plain worktree after its repo', () => {
    assert.equal(
      workspaceDisplayName({ kind: 'worktree', repoPath: '/home/u/dev/metarepo' }, 'feat-x'),
      'metarepo · feat-x',
    );
  });

  it('names a promoted worktree after its repo too (capability is not identity)', () => {
    assert.equal(
      workspaceDisplayName({ kind: 'worktree', repoPath: '/home/u/dev/orchestra' }, 'integ'),
      'orchestra · integ',
    );
  });

  it('names a scratch session scratch', () => {
    assert.equal(
      workspaceDisplayName({ kind: 'scratch', repoPath: '' }, 'idea'),
      'scratch · idea',
    );
  });

  it('treats a legacy (kind-less) record as a worktree', () => {
    assert.equal(
      workspaceDisplayName({ repoPath: '/home/u/dev/repo' }, 'old'),
      'repo · old',
    );
  });

  // Degenerate: a worktree record with no repoPath would make path.basename('')
  // return '', yielding a leading ' · '. Never produce a nameless prefix.
  it('does not emit an empty prefix for a repo-less worktree record', () => {
    assert.equal(workspaceDisplayName({ kind: 'worktree', repoPath: '' }, 'x'), 'scratch · x');
  });

  it('strips a trailing slash from the repo path', () => {
    assert.equal(
      workspaceDisplayName({ kind: 'worktree', repoPath: '/home/u/dev/metarepo/' }, 'b'),
      'metarepo · b',
    );
  });
});
