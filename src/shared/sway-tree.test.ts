// #406 — the sway "is the window displayed?" signal: the tree walk and the i3-ipc framing, without a compositor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GET_TREE, IPC_MAGIC, ipcFrame, parseIpcReply, windowVisibleInTree, type SwayNode } from './sway-tree.ts';

const win = (pid: number, visible: boolean): SwayNode => ({ pid, visible, nodes: [], floating_nodes: [] });
const tree = (shown: SwayNode[], away: SwayNode[], floating: SwayNode[] = []): SwayNode => ({ nodes: [{ nodes: [{ nodes: shown }, { nodes: away }], floating_nodes: floating }] });

test('windowVisibleInTree: the leaf owned by the pid says whether its workspace is displayed', () => {
  assert.equal(windowVisibleInTree(tree([win(10, true)], [win(20, false)]), 10), true);
  assert.equal(windowVisibleInTree(tree([win(10, true)], [win(20, false)]), 20), false, 'a window on a workspace that is not shown');
  assert.equal(windowVisibleInTree(tree([], [], [win(30, true)]), 30), true, 'a floating window');
  assert.equal(windowVisibleInTree(tree([win(10, true)], []), 99), null, 'no such window: unknown, never "hidden"');
});

test('windowVisibleInTree: a container that merely carries the pid is not the window', () => {
  const t: SwayNode = { nodes: [{ pid: 10, visible: true, nodes: [win(11, false)] }] };
  assert.equal(windowVisibleInTree(t, 10), null);
  assert.equal(windowVisibleInTree(t, 11), false);
});

test('i3-ipc framing: a request frame and a (possibly split) reply round-trip', () => {
  const f = ipcFrame(GET_TREE);
  assert.equal(f.length, 14);
  assert.equal(f.toString('latin1', 0, 6), IPC_MAGIC);
  assert.equal(f.readUInt32LE(6), 0);
  assert.equal(f.readUInt32LE(10), GET_TREE);
  const reply = Buffer.concat([ipcFrame(GET_TREE, '{"a":1}')]); // same layout as a reply
  assert.equal(parseIpcReply(reply.subarray(0, 10)), 'incomplete', 'header not complete');
  assert.equal(parseIpcReply(reply.subarray(0, 16)), 'incomplete', 'payload not complete');
  const done = parseIpcReply(reply);
  assert.ok(done && done !== 'incomplete');
  assert.equal((done as { payload: string }).payload, '{"a":1}');
  assert.equal(parseIpcReply(Buffer.from('not-sway-at-all!!')), null, 'not i3-ipc');
});
