import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freeBranchSlot, MAX_BRANCH_SUFFIX } from './branch-slots.ts';

// The ORIGINAL freeBranchName algorithm (workspaces.ts before the #382 follow-up), kept here as the ORACLE: with no options the extracted
// function must agree with it on every state — rename and the human spawn paths are byte-identical.
function legacy(existingList: string[], desired: string, current: string): string {
  if (!desired) return '';
  const existing = new Set(existingList);
  existing.delete(current);
  if (!existing.has(desired)) return desired;
  for (let n = 2; n < 100; n++) {
    const candidate = `${desired}-${n}`;
    if (!existing.has(candidate)) return candidate;
  }
  return '';
}

test('no options = the previous algorithm, over a sweep of states (free, taken, suffixed, own current, exhausted, empty)', () => {
  const names = ['impl-x', 'impl-x-2', 'impl-x-3', 'main', 'a/b', ''];
  let states = 0;
  for (let mask = 0; mask < 1 << names.length; mask++) {
    const existing = names.filter((_, i) => mask & (1 << i));
    for (const desired of ['impl-x', 'impl-x-2', 'main', 'zzz', '']) {
      for (const current of ['', 'impl-x', 'main', 'other']) {
        assert.equal(freeBranchSlot(existing, desired, current), legacy(existing, desired, current), JSON.stringify({ existing, desired, current }));
        states++;
      }
    }
  }
  assert.ok(states > 1000);
  const full = ['impl-x', ...Array.from({ length: 98 }, (_, i) => `impl-x-${i + 2}`)];
  assert.equal(freeBranchSlot(full, 'impl-x', ''), '');
  assert.equal(legacy(full, 'impl-x', ''), '');
  assert.equal(freeBranchSlot(full.slice(0, -1), 'impl-x', ''), `impl-x-${MAX_BRANCH_SUFFIX}`);
});

test('reserved names (creations in flight) count as taken — parallel same-name picks get DISTINCT slots', () => {
  const reserved = new Set<string>();
  const picks: string[] = [];
  for (let i = 0; i < 4; i++) { const p = freeBranchSlot([], 'impl-race', '', { reserved }); reserved.add(p); picks.push(p); }
  assert.deepEqual(picks, ['impl-race', 'impl-race-2', 'impl-race-3', 'impl-race-4']);
  // control: WITHOUT the reservation every pick is the same (the race)
  assert.deepEqual([0, 1, 2].map(() => freeBranchSlot([], 'impl-race', '')), ['impl-race', 'impl-race', 'impl-race']);
  // a released reservation frees its name again
  reserved.delete('impl-race');
  assert.equal(freeBranchSlot([], 'impl-race', '', { reserved }), 'impl-race');
});

test('avoidFolders: `impl-z` is taken when `impl-z/sub` exists (git cannot hold both); off by default (human paths unchanged)', () => {
  assert.equal(freeBranchSlot(['impl-z/sub'], 'impl-z', '', { avoidFolders: true }), 'impl-z-2');
  assert.equal(freeBranchSlot(['impl-z/sub'], 'impl-z', ''), 'impl-z', 'default: byte-identical to before');
  assert.equal(freeBranchSlot(['impl-z-2/x', 'impl-z/sub'], 'impl-z', '', { avoidFolders: true }), 'impl-z-3', 'a suffixed candidate is checked too');
  assert.equal(freeBranchSlot(['impl-zz/sub'], 'impl-z', '', { avoidFolders: true }), 'impl-z', 'only a REAL folder prefix (`impl-z/`) conflicts, not a longer name');
});

test('the current branch is exempt (a rename to its own name is a no-op), and reserved wins over the exemption only for OTHER names', () => {
  assert.equal(freeBranchSlot(['impl-x'], 'impl-x', 'impl-x'), 'impl-x');
  assert.equal(freeBranchSlot(['impl-x'], 'impl-x', ''), 'impl-x-2');
});
