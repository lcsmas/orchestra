// orchestra-acces-mobile — the Accès mobile server process (#334, ADR 0006). Spawned and supervised by main
// (src/main/acces-mobile-host.ts) with an allowlisted env; dies with it: main holds our stdin pipe, and its end ⇒ exit, so no
// orphan keeps listening after an app crash. Prints `listening <socket>` once bound; exits non-zero on any bind failure.
//
// Listens on a UNIX SOCKET created 0600 (umask set BEFORE bind, so no window where it is wider) in a 0700 directory — never a TCP
// port: a free loopback port can be taken by any local process, which then receives the phone's bearer token (#334 review).
// `tailscale serve … unix:<path>` is the only way in from the tailnet; tailscaled runs as root and connects regardless of the mode.

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createAccesMobileServer } from './server.ts';
import { createRpcClient } from '../shared/acces-mobile-rpc.ts';

function fail(msg: string): never {
  process.stderr.write(`acces-mobile: ${msg}\n`);
  process.exit(2);
}

const sockPath = process.env.ACCES_MOBILE_SOCKET ?? '';
const allowedLogin = process.env.ACCES_MOBILE_LOGIN ?? '';
const tokenFile = process.env.ACCES_MOBILE_TOKEN_FILE ?? '';
if (!sockPath || !path.isAbsolute(sockPath)) fail('bad ACCES_MOBILE_SOCKET');
if (Buffer.byteLength(sockPath) > 107) fail('ACCES_MOBILE_SOCKET path too long for a Unix socket');
if (!allowedLogin) fail('no ACCES_MOBILE_LOGIN');
if (!tokenFile) fail('no ACCES_MOBILE_TOKEN_FILE');
// fd 3 = the private channel main handed us at spawn (a socketpair): the ONLY way to main (#338 review M1).
let channel: net.Socket;
try {
  if (!fs.fstatSync(3).isSocket()) fail('fd 3 is not the main channel');
  channel = new net.Socket({ fd: 3, readable: true, writable: true });
} catch {
  fail('no main channel on fd 3');
}
channel.on('error', () => {});
// The channel unusable (main gone, or an over-long line) ⇒ exit: main sees the exit and restarts us; a server that outlived its
// channel would answer 502 forever.
const rpc = createRpcClient(channel, 5000, () => fail('main channel lost'));
// The directory must be ours and closed to everyone else, or another user could pre-create / swap the socket path.
const dir = path.dirname(sockPath);
let st: fs.Stats;
try {
  st = fs.statSync(dir);
} catch {
  fail(`socket directory missing: ${dir}`);
}
if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) fail(`socket directory ${dir} must be owned by this user and mode 0700`);
// A stale socket from a killed predecessor: remove it (only a socket — never a regular file someone put there).
try {
  const old = fs.lstatSync(sockPath);
  if (!old.isSocket()) fail(`${sockPath} exists and is not a socket`);
  fs.unlinkSync(sockPath);
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}

const server = createAccesMobileServer({
  allowedLogin,
  readToken: () => fs.readFileSync(tokenFile, 'utf8'),
  upstream: (route, body, timeoutMs) => rpc.call(route, body, timeoutMs),
  upstreamStream: (route, onMessage, onEnd) => rpc.stream(route, onMessage, onEnd),
  log: (line) => process.stderr.write(`acces-mobile: ${line}\n`),
});
server.on('error', (e: NodeJS.ErrnoException) => fail(`listen failed: ${e.code ?? e.message}`));
/** Inode of the socket WE bound: on exit we unlink the path only if it is still ours. A successor may already have replaced it
 *  (restart / login change without waiting for us), and deleting ITS socket leaves it alive but unreachable (#334 re-review). For
 *  the same reason we never call server.close(): libuv unlinks the bound PATH on close, whatever is there now. */
let bound: string | null = null; // `ino:ctimeNs` — an inode number alone can be reused by the successor's bind
const identity = (st: fs.BigIntStats): string => `${st.ino}:${st.ctimeNs}`;
process.umask(0o177);
server.listen(sockPath, () => {
  try {
    fs.chmodSync(sockPath, 0o600); // belt and braces: umask already made it 0600
    bound = identity(fs.lstatSync(sockPath, { bigint: true }));
  } catch (e) {
    fail(`chmod failed: ${(e as Error).message}`);
  }
  process.stdout.write(`listening ${sockPath}\n`);
});

function exit(code: number): never {
  try {
    if (bound !== null && identity(fs.lstatSync(sockPath, { bigint: true })) === bound) fs.unlinkSync(sockPath);
  } catch {
    /* already gone */
  }
  process.exit(code);
}
process.stdin.on('end', () => exit(0));
process.stdin.on('close', () => exit(0));
process.stdin.resume();
process.on('SIGTERM', () => exit(0));
