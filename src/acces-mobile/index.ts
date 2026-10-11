// orchestra-acces-mobile — the Accès mobile server process (#334, ADR 0006). Spawned and supervised by main
// (src/main/acces-mobile-host.ts) with an allowlisted env; dies with it: main holds our stdin pipe, and its end ⇒ exit, so no
// orphan keeps listening after an app crash. Prints `listening <port>` once bound; exits non-zero on any bind failure.

import fs from 'node:fs';
import { createAccesMobileServer, socketUpstream } from './server.ts';

function fail(msg: string): never {
  process.stderr.write(`acces-mobile: ${msg}\n`);
  process.exit(2);
}

const port = Number(process.env.ACCES_MOBILE_PORT);
const allowedLogin = process.env.ACCES_MOBILE_LOGIN ?? '';
const tokenFile = process.env.ACCES_MOBILE_TOKEN_FILE ?? '';
const sock = process.env.ORCHESTRA_SOCK ?? '';
if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('bad ACCES_MOBILE_PORT');
if (!allowedLogin) fail('no ACCES_MOBILE_LOGIN');
if (!tokenFile) fail('no ACCES_MOBILE_TOKEN_FILE');
if (!sock) fail('no ORCHESTRA_SOCK');

const server = createAccesMobileServer({
  allowedLogin,
  readToken: () => fs.readFileSync(tokenFile, 'utf8'),
  upstream: socketUpstream(sock),
  log: (line) => process.stderr.write(`acces-mobile: ${line}\n`),
});
server.on('error', (e: NodeJS.ErrnoException) => fail(`listen failed: ${e.code ?? e.message}`));
// 127.0.0.1 ONLY — never 0.0.0.0, never the tailnet address (ADR 0006).
server.listen(port, '127.0.0.1', () => process.stdout.write(`listening ${port}\n`));

process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
process.stdin.resume();
process.on('SIGTERM', () => process.exit(0));
