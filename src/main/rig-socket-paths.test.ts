import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { mkHomeScratch } from '../shared/home-scratch.ts';
import { parseSsStrict, socketInode, socketPaths } from '../shared/keyring-rig-world.ts';

// #389 — the fd → inode → `ss` → path chain on REAL kernel output (not a fixture): a unix listener and a connected client in this very process,
// resolved by the same code the keyring rig uses to see which socket path an app's fds reach. Nothing outside the scratch dir is connected to.

const scratch = mkHomeScratch('rig-socket-paths-');
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const ownSocketInodes = (): number[] =>
  fs.readdirSync('/proc/self/fd').map((f) => { try { return socketInode(fs.readlinkSync(`/proc/self/fd/${f}`)); } catch { return null; } }).filter((i): i is number => i !== null);

test('real kernel output: the listener resolves to its own path, and a CLIENT end (`*`) resolves to the path of the listener it is connected to', async () => {
  const sock = path.join(scratch, 'listen.sock');
  const before = new Set(ownSocketInodes());
  const server = net.createServer((c) => c.on('data', () => {})).listen(sock);
  await new Promise((r) => server.once('listening', r));
  const client = net.connect(sock);
  await new Promise((r) => client.once('connect', r));
  await new Promise((r) => setTimeout(r, 50));
  try {
    const mine = ownSocketInodes().filter((i) => !before.has(i));
    assert.ok(mine.length >= 3, `listener + client + accepted end: ${mine.length} new socket fds`);
    const ss = spawnSync('ss', ['-xnaeH'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(ss.status, 0, `ss: ${ss.stderr}`);
    const { rows, unparsed } = parseSsStrict(ss.stdout);
    assert.ok(rows.length > 0, 'ss produced rows');
    assert.deepEqual(unparsed, [], 'EVERY row of the real, host-wide `ss -xnaeH` output parses (the rig aborts on one that does not: a vanished row is a connection it cannot see)');
    assert.deepEqual(socketPaths(mine, rows), [sock], 'every new fd of this process reaches exactly the listener path');
    // the client end alone — the shape of "an app connected to a keyring/bus socket": its fd link is only `socket:[N]`
    const clientIno = rows.find((r) => r.localPath === null && r.peerIno !== 0 && rows.some((p) => p.localIno === r.peerIno && p.localPath === sock) && mine.includes(r.localIno))?.localIno;
    assert.ok(clientIno, 'a path-less client end exists among the new fds');
    assert.deepEqual(socketPaths([clientIno as number], rows), [sock], 'resolved through its peer end');
    assert.deepEqual(socketPaths([], rows), []);
  } finally {
    client.destroy();
    server.close();
  }
});
