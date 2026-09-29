import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EFFORT_LEVELS,
  MODEL_DEFAULT_EFFORT,
  effortForNewWorkspace,
  normalizeEffortDefaults,
} from './effort-defaults.ts';

const D = { workspace: 'xhigh', spawned: 'low' } as const;

test('levels are the five SDK stops, lowest first', () => {
  assert.deepEqual([...EFFORT_LEVELS], ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('normalize: absent/invalid store values fall back to "model default" (pins nothing)', () => {
  assert.deepEqual(normalizeEffortDefaults(undefined), { workspace: 'default', spawned: 'default' });
  assert.deepEqual(
    normalizeEffortDefaults({ workspace: 'ultra' as never, spawned: 'max' }),
    { workspace: 'default', spawned: 'max' },
  );
  // A partial patch keeps the other kind's stored value once merged by the caller.
  assert.equal(normalizeEffortDefaults({ ...D, spawned: 'medium' }).workspace, 'xhigh');
});

test('a new workspace takes the effort of ITS kind', () => {
  assert.equal(effortForNewWorkspace(D, 'workspace'), 'xhigh');
  assert.equal(effortForNewWorkspace(D, 'spawned'), 'low');
});

test('"model default" leaves the workspace unpinned (undefined, never the marker string)', () => {
  const none = { workspace: MODEL_DEFAULT_EFFORT, spawned: 'max' } as const;
  assert.equal(effortForNewWorkspace(none, 'workspace'), undefined);
  assert.equal(effortForNewWorkspace(none, 'spawned'), 'max');
});
