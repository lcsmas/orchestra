// #406 — swayWindowVisible against a FAKE sway socket (the real i3-ipc framing, no compositor): displayed / not displayed / unknown / garbage / silent.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { swayWindowVisible } from './sway-ipc.ts';
import { GET_TREE, ipcFrame, parseIpcReply } from '../shared/sway-tree.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sway-ipc-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const tree = { nodes: [{ nodes: [{ nodes: [{ pid: 111, visible: true, nodes: [] }] }, { nodes: [{ pid: 222, visible: false, nodes: [] }] }] }] };

function fakeSway(name: string, behave: (c: net.Socket, request: Buffer) => void): string {
  const sock = path.join(dir, name);
  const srv = net.createServer((c) => c.once('data', (d) => behave(c, d)));
  srv.listen(sock);
  after(() => srv.close());
  return sock;
}

test('swayWindowVisible: asks get_tree and reads the window of the pid (split replies included)', async () => {
  const sock = fakeSway('ok', (c, req) => {
    const r = parseIpcReply(req);
    assert.ok(r && r !== 'incomplete' && r.type === GET_TREE, 'a get_tree request');
    const reply = ipcFrame(GET_TREE, JSON.stringify(tree));
    c.write(reply.subarray(0, 20)); // split mid-payload
    setTimeout(() => c.write(reply.subarray(20)), 20);
  });
  assert.equal(await swayWindowVisible(111, sock), true, 'displayed');
  assert.equal(await swayWindowVisible(222, sock), false, 'on a workspace that is not shown');
  assert.equal(await swayWindowVisible(333, sock), null, 'not in the tree: unknown, never "hidden"');
});

test('swayWindowVisible: anything that is not a clean answer is "unknown" (null), never "hidden"', async () => {
  assert.equal(await swayWindowVisible(111, undefined), null, 'no SWAYSOCK');
  assert.equal(await swayWindowVisible(111, path.join(dir, 'nobody-listens')), null, 'no such socket');
  assert.equal(await swayWindowVisible(111, fakeSway('garbage', (c) => c.write('this is not i3-ipc at all'))), null, 'not i3-ipc');
  assert.equal(await swayWindowVisible(111, fakeSway('badjson', (c) => c.write(ipcFrame(GET_TREE, '{nope')))), null, 'bad payload');
  const t0 = Date.now();
  assert.equal(await swayWindowVisible(111, fakeSway('silent', () => undefined), 150), null, 'a compositor that never answers');
  assert.ok(Date.now() - t0 < 600, 'bounded');
});
