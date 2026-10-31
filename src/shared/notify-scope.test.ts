import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasLiveParent } from './notify-scope.ts';

const byId = new Map<string, { archived?: boolean }>([['lead', {}], ['old', { archived: true }]]);
const get = (id: string) => byId.get(id);

test('a workspace with a live parent is a child (turn-end stays silent)', () => {
  assert.equal(hasLiveParent({ parentId: 'lead' }, get), true);
});
test('a root, an orphan and an archived parent\'s child all notify like roots', () => {
  assert.equal(hasLiveParent({}, get), false);
  assert.equal(hasLiveParent({ parentId: 'deleted' }, get), false);
  assert.equal(hasLiveParent({ parentId: 'old' }, get), false);
});
