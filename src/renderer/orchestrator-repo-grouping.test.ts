import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  repoSectionKeyOf,
  isRepoAssociatedOrchestrator,
  partitionOrchestratorRoots,
} from './orchestrator-repo-grouping.ts';

// A repo-less coordinator: kind 'orchestrator', EMPTY repoPath (it owns no
// checkout — see the repoAssociation docblock for why that must stay empty).
const orch = (id: string, repoAssociation?: string) => ({
  id,
  kind: 'orchestrator' as const,
  repoPath: '',
  repoAssociation,
});
const scratch = (id: string) => ({ id, kind: 'scratch' as const, repoPath: '' });
const git = (id: string, repoPath: string) => ({ id, kind: 'worktree' as const, repoPath });
// Every record predating `kind` is treated as a git worktree.
const legacyGit = (id: string, repoPath: string) => ({ id, kind: undefined, repoPath });

// ─── repoSectionKeyOf ────────────────────────────────────────────────────────

test('repoSectionKeyOf: an UNASSOCIATED orchestrator stays pinned (null)', () => {
  assert.equal(repoSectionKeyOf(orch('a')), null);
});

// THE REGRESSION THIS MODULE EXISTS FOR. Before this feature the sidebar filed
// sections purely on `kind`, so an orchestrator could never land in a repo
// section — this assertion FAILS against that behaviour (it returned null for
// every orchestrator), which is what makes it a real test rather than one that
// passes before and after.
test('repoSectionKeyOf: an ASSOCIATED orchestrator files under its repo', () => {
  assert.equal(repoSectionKeyOf(orch('a', '/home/u/dev/metarepo')), '/home/u/dev/metarepo');
});

test('repoSectionKeyOf: a git workspace still groups by its own repoPath', () => {
  assert.equal(repoSectionKeyOf(git('g', '/home/u/dev/metarepo')), '/home/u/dev/metarepo');
});

test('repoSectionKeyOf: a legacy record with no kind groups by repoPath', () => {
  assert.equal(repoSectionKeyOf(legacyGit('g', '/home/u/dev/repo')), '/home/u/dev/repo');
});

test('repoSectionKeyOf: a plain scratch session is never filed under a repo', () => {
  assert.equal(repoSectionKeyOf(scratch('s')), null);
  // Even if a stray association were somehow persisted on a scratch record, it
  // must not become a second grouping key competing with repoPath.
  assert.equal(
    repoSectionKeyOf({ ...scratch('s'), repoAssociation: '/home/u/dev/metarepo' }),
    null,
  );
});

test('repoSectionKeyOf: an association never overrides a real repoPath on a worktree', () => {
  // A promoted worktree already groups by its own repo; the association field
  // is meaningless there and must be ignored rather than winning.
  assert.equal(
    repoSectionKeyOf({ ...git('g', '/home/u/dev/real'), repoAssociation: '/home/u/dev/other' }),
    '/home/u/dev/real',
  );
});

test('repoSectionKeyOf: blank/whitespace associations are treated as absent', () => {
  assert.equal(repoSectionKeyOf(orch('a', '')), null);
  assert.equal(repoSectionKeyOf(orch('a', '   ')), null);
});

test('repoSectionKeyOf: a padded association is trimmed to a usable key', () => {
  assert.equal(repoSectionKeyOf(orch('a', '  /home/u/dev/metarepo  ')), '/home/u/dev/metarepo');
});

// ─── isRepoAssociatedOrchestrator ────────────────────────────────────────────

test('isRepoAssociatedOrchestrator: only a genuinely associated orchestrator', () => {
  assert.equal(isRepoAssociatedOrchestrator(orch('a', '/repo')), true);
  assert.equal(isRepoAssociatedOrchestrator(orch('a')), false);
  assert.equal(isRepoAssociatedOrchestrator(orch('a', '  ')), false);
  assert.equal(isRepoAssociatedOrchestrator(scratch('s')), false);
  assert.equal(isRepoAssociatedOrchestrator(git('g', '/repo')), false);
});

// ─── partitionOrchestratorRoots ──────────────────────────────────────────────

test('partitionOrchestratorRoots: splits pinned from repo-filed', () => {
  const roots = [orch('a'), orch('b', '/repo1'), orch('c'), orch('d', '/repo2')];
  const { pinned, inRepoSections } = partitionOrchestratorRoots(roots);
  assert.deepEqual(pinned.map((w) => w.id), ['a', 'c']);
  assert.deepEqual(inRepoSections.map((w) => w.id), ['b', 'd']);
});

test('partitionOrchestratorRoots: the two lists are complementary — no row lost or duplicated', () => {
  // The property that makes double-render/vanish structurally impossible.
  const roots = [orch('a'), orch('b', '/repo1'), orch('c'), orch('d', '  '), orch('e', '/repo2')];
  const { pinned, inRepoSections } = partitionOrchestratorRoots(roots);
  assert.equal(pinned.length + inRepoSections.length, roots.length);
  const seen = [...pinned, ...inRepoSections].map((w) => w.id).sort();
  assert.deepEqual(seen, ['a', 'b', 'c', 'd', 'e']);
});

test('partitionOrchestratorRoots: order within each list is preserved', () => {
  const roots = [orch('z', '/r'), orch('y'), orch('x', '/r'), orch('w')];
  const { pinned, inRepoSections } = partitionOrchestratorRoots(roots);
  assert.deepEqual(inRepoSections.map((w) => w.id), ['z', 'x']);
  assert.deepEqual(pinned.map((w) => w.id), ['y', 'w']);
});

test('partitionOrchestratorRoots: empty input yields two empty lists', () => {
  const { pinned, inRepoSections } = partitionOrchestratorRoots([]);
  assert.deepEqual(pinned, []);
  assert.deepEqual(inRepoSections, []);
});
