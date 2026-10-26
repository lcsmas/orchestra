import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { mkHomeScratch } from '../shared/home-scratch.ts';
import { buildSocketScan, parseProcNetUnix, socketInode, socketPaths, type SocketScan } from '../shared/keyring-rig-world.ts';

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

test('real kernel output, seat-1 F1/F3: sockets bound + connected under names with marker lookalikes (` --- `, ` <-> `, ` --> `, ` <-- `) and shape tokens resolve to their TRUE path — no fabricated pair, nothing silent; a trailing-space name is byte-exact', async () => {
  const dir = path.join(scratch, 'hostile');
  fs.mkdirSync(dir);
  const names = ['p 1 /q 2 --- zz', 'p 1 /q 2 <-> zz', 'q 1 /r 2 --> zz', 'd 5 /e 6 <-- w 7 * 8', 'm 9 /n 10 --- 11 * 12', 'a --- b', 'trail '];
  for (const n of names) {
    const sock = path.join(dir, n);
    fs.mkdirSync(path.dirname(sock), { recursive: true }); // a `/` in the lookalike name is a directory boundary (`p 1 ` / `q 2 --- zz`)
    const { mine, close } = await listenAndConnect(sock);
    try {
      const { scan, unparsed } = realScan();
      assert.deepEqual(unparsed, [], `placed on real kernel output: ${JSON.stringify(n)}`);
      assert.deepEqual(socketPaths(mine, scan), [sock], `every fd of the connection reaches the true, byte-exact path: ${JSON.stringify(n)}`);
      const clientIno = mine.find((i) => !scan.pathByIno.has(i));
      assert.ok(clientIno, `a path-less client end exists: ${JSON.stringify(n)}`);
      assert.deepEqual(socketPaths([clientIno as number], scan), [sock], `the client end resolves through its peer: ${JSON.stringify(n)}`);
      const real = parseProcNetUnix(fs.readFileSync('/proc/net/unix', 'utf8')).inodes;
      const fabricated = [1, 2, 5, 6, 7, 8, 9, 10, 11, 12].filter((t) => !real.has(t) && scan.peerOf.has(t)); // the shape tokens inside the name that are NOT real socket inodes
      assert.deepEqual(fabricated, [], `no pair fabricated from the numbers inside the name: ${JSON.stringify(n)}`);
    } finally { close(); }
  }
});

test('real kernel output, final-run finding: a LISTENING socket with a connection waiting in its backlog (`peers: <inode>` in the row tail) is placed, not reported ambiguous', async () => {
  const sock = path.join(scratch, 'backlog.sock');
  // a listener that never accept()s: the client's connect() sits in the backlog, so ss prints `Recv-Q 1` and `peers: <inode>` for the listener
  const py = spawn('python3', ['-I', '-c', `
import socket, sys, time
s = socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.listen(5)
c = socket.socket(socket.AF_UNIX); c.connect(sys.argv[1])
print('ready', flush=True)
time.sleep(30)
`, sock], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await new Promise<void>((res, rej) => { py.stdout.once('data', () => res()); py.once('error', rej); py.once('exit', () => rej(new Error('python exited early'))); });
    await new Promise((r) => setTimeout(r, 100));
    const ss = spawnSync('ss', ['-xnaeH'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout;
    const row = ss.split('\n').find((l) => l.includes(sock) && /\bLISTEN\b/.test(l)) ?? '';
    assert.match(row, /peers:\s*\d+/, `the listener row carries a peers list: ${row}`);
    const { scan, unparsed } = realScan();
    assert.deepEqual(unparsed, [], 'the backlog row is placed (a peers list after the marker is tail, not a second peer inode)');
    const listenerIno = [...scan.pathByIno].find(([ino, p]) => p === sock && ino !== 0)?.[0];
    assert.ok(listenerIno, 'the listener inode is known');
    assert.ok(scan.peerOf.has(listenerIno as number), 'and its row produced a pair');
  } finally { py.kill('SIGKILL'); }
});
