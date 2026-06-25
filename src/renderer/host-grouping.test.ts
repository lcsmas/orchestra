import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostKeyOf, hostLabel, groupByHost } from './host-grouping.ts';

const local = (id: string) => ({ id, host: undefined });
const localExplicit = (id: string) => ({ id, host: { kind: 'local' } as const });
const sandbox = (id: string, endpoint: string) => ({ id, host: { kind: 'sandbox' as const, endpoint } });

// ─── hostKeyOf ───────────────────────────────────────────────────────────────

test('hostKeyOf: absent or explicit-local both map to "local"', () => {
  assert.equal(hostKeyOf(local('a')), 'local');
  assert.equal(hostKeyOf(localExplicit('a')), 'local');
});

test('hostKeyOf: sandbox keys include the endpoint so two sandboxes are distinct', () => {
  assert.equal(hostKeyOf(sandbox('a', 'ws://h1:8787')), 'sandbox:ws://h1:8787');
  assert.notEqual(hostKeyOf(sandbox('a', 'ws://h1:8787')), hostKeyOf(sandbox('b', 'ws://h2:8787')));
});

// ─── hostLabel ───────────────────────────────────────────────────────────────

test('hostLabel: local reads as "This machine"', () => {
  assert.equal(hostLabel('local'), 'This machine');
});

test('hostLabel: sandbox shows host:port from the ws URL', () => {
  assert.equal(hostLabel('sandbox:ws://homeserver.local:8787'), 'homeserver.local:8787');
  assert.equal(hostLabel('sandbox:wss://vps.example.com'), 'vps.example.com');
});

test('hostLabel: a non-URL endpoint falls back to the raw string', () => {
  assert.equal(hostLabel('sandbox:not a url'), 'not a url');
});

// ─── groupByHost ─────────────────────────────────────────────────────────────

test('groupByHost: all-local returns null (flat rendering, no node headers)', () => {
  assert.equal(groupByHost([local('a'), localExplicit('b')]), null);
  assert.equal(groupByHost([]), null);
});

test('groupByHost: mixed groups local first, then sandbox nodes in first-seen order', () => {
  const items = [
    sandbox('s1', 'ws://h2:8787'),
    local('l1'),
    sandbox('s2', 'ws://h1:8787'),
    local('l2'),
    sandbox('s3', 'ws://h2:8787'),
  ];
  const groups = groupByHost(items);
  assert.ok(groups, 'should group when a sandbox is present');
  // local is first
  assert.equal(groups[0].key, 'local');
  assert.deepEqual(groups[0].items.map((w) => w.id), ['l1', 'l2']);
  // sandbox nodes follow in first-seen order: h2 (from s1) before h1 (from s2)
  assert.equal(groups[1].key, 'sandbox:ws://h2:8787');
  assert.deepEqual(groups[1].items.map((w) => w.id), ['s1', 's3']);
  assert.equal(groups[2].key, 'sandbox:ws://h1:8787');
  assert.deepEqual(groups[2].items.map((w) => w.id), ['s2']);
});

test('groupByHost: order within a node is preserved (drag order untouched)', () => {
  const items = [sandbox('z', 'ws://h:1'), local('b'), local('a'), local('c')];
  const groups = groupByHost(items)!;
  const localGroup = groups.find((g) => g.key === 'local')!;
  assert.deepEqual(localGroup.items.map((w) => w.id), ['b', 'a', 'c']);
});

test('groupByHost: a repo that is entirely sandbox (no local) still groups', () => {
  const groups = groupByHost([sandbox('s1', 'ws://h:1'), sandbox('s2', 'ws://h:1')]);
  assert.ok(groups);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'sandbox:ws://h:1');
  assert.equal(groups[0].items.length, 2);
});
