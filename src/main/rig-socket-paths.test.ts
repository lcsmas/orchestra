import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { mkHomeScratch } from '../shared/home-scratch.ts';
import { buildSocketScan, socketInode, socketPaths, type SocketScan } from '../shared/keyring-rig-world.ts';

// #389 — the fd → inode → (/proc/net/unix + ss) → path chain on REAL kernel output (not a fixture): a unix listener and a connected client in this very
// process, resolved by the same code the keyring rig uses to see which socket path an app's fds reach. Nothing outside the scratch dir is connected to.

const scratch = mkHomeScratch('rig-socket-paths-');
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const ownSocketInodes = (): number[] =>
  fs.readdirSync('/proc/self/fd').map((f) => { try { return socketInode(fs.readlinkSync(`/proc/self/fd/${f}`)); } catch { return null; } }).filter((i): i is number => i !== null);

/** Two snapshots of a live host can disagree by a socket that closed in between (the driver retries; so does this). */
function realScan(): { scan: SocketScan; unparsed: string[] } {
  let last = { scan: { pathByIno: new Map(), peerOf: new Map() } as SocketScan, unparsed: ['(never ran)'] };
  for (let i = 0; i < 3; i++) {
    const ss = spawnSync('ss', ['-xnaeH'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(ss.status, 0, `ss: ${ss.stderr}`);
    last = buildSocketScan(fs.readFileSync('/proc/net/unix', 'utf8'), ss.stdout);
    if (last.unparsed.length === 0) break;
  }
  return last;
}

async function listenAndConnect(sock: string): Promise<{ mine: number[]; close: () => void }> {
  const before = new Set(ownSocketInodes());
  const server = net.createServer((c) => c.on('data', () => {})).listen(sock);
  await new Promise((r) => server.once('listening', r));
  const client = net.connect(sock);
  await new Promise((r) => client.once('connect', r));
  await new Promise((r) => setTimeout(r, 50));
  return { mine: ownSocketInodes().filter((i) => !before.has(i)), close: () => { client.destroy(); server.close(); } };
}

test('real kernel output: the listener resolves to its own path, and a CLIENT end (`*`) resolves to the path of the listener it is connected to', async () => {
  const sock = path.join(scratch, 'listen.sock');
  const { mine, close } = await listenAndConnect(sock);
  try {
    assert.ok(mine.length >= 3, `listener + client + accepted end: ${mine.length} new socket fds`);
    const { scan, unparsed } = realScan();
    assert.deepEqual(unparsed, [], 'EVERY row of the real, host-wide `ss -xnaeH` output is placed (the rig aborts on one that is not: a vanished row is a connection it cannot see)');
    assert.ok(scan.peerOf.size > 0, 'ss produced (inode, peer) pairs');
    assert.deepEqual(socketPaths(mine, scan), [sock], 'every new fd of this process reaches exactly the listener path');
    const clientIno = mine.find((i) => !scan.pathByIno.has(i) && scan.pathByIno.has(scan.peerOf.get(i) ?? -1));
    assert.ok(clientIno, 'a path-less client end exists among the new fds');
    assert.deepEqual(socketPaths([clientIno as number], scan), [sock], 'resolved through its peer end');
    assert.deepEqual(socketPaths([], scan), []);
  } finally { close(); }
});

test('real kernel output, round-6 minor: a socket whose path contains spaces AND a digit token (`my 123 sock`) is placed correctly — path from /proc/net/unix, pair from ss', async () => {
  const dir = path.join(scratch, 'sp ace 77');
  fs.mkdirSync(dir);
  const sock = path.join(dir, 'my 123 sock');
  const { mine, close } = await listenAndConnect(sock);
  try {
    const { scan, unparsed } = realScan();
    assert.deepEqual(unparsed, [], 'the spaced / digit-bearing row is placed, not mis-parsed or dropped');
    assert.deepEqual(socketPaths(mine, scan), [sock], 'all three fds of the connection reach the full, byte-exact path');
    const clientIno = mine.find((i) => !scan.pathByIno.has(i));
    assert.ok(clientIno);
    assert.deepEqual(socketPaths([clientIno as number], scan), [sock]);
  } finally { close(); }
});
