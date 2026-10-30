#!/usr/bin/env node
// Accès mobile 413 rig (#408): the REAL createAccesMobileServer, a client that KEEPS PUSHING an over-cap body, N runs; each run must READ the 413.
// Usage: node --experimental-strip-types scripts/acces-mobile-413-rig.mjs --src <root holding src/acces-mobile/server.ts> [--runs 500] [--client raw|http|hostile|both] [--topology same|split] [--arm <label>]
// One JSON line per flavor {arm, client, topology, runs, read413, minus1, other, errCodes}; exit 1 if any run did not read the 413 / a hostile run held the socket past its bound.
// `hostile` = a sender that never stops pushing: the server must close it within the linger bound after ≤ drain-bytes + kernel buffers (skipped on a tree without the bounds).
import net from 'node:net';
import http from 'node:http';
import { fork } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const SRC = path.resolve(arg('src', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
const RUNS = Number(arg('runs', '500'));
const CLIENT = arg('client', 'both');
const TOPOLOGY = arg('topology', 'same');
const ARM = arg('arm', 'fixed');
const HOSTILE_RUNS = Number(arg('hostile-runs', '3'));
const HOSTILE_LINGER_MS = 1500;
const KERNEL_SLACK = 24 * 1_048_576; // client send buffer + loopback + server receive buffer, generously
const LOGIN = 'lucas.mas@mobile.club';
const TOKEN = 'tok_' + 'a'.repeat(40);

const srcUrl = (rel) => pathToFileURL(path.join(SRC, rel)).href;
const { createAccesMobileServer } = await import(srcUrl('src/acces-mobile/server.ts'));
const { MOBILE_SEND_MAX_BODY, MOBILE_ATTACH_MAX_BODY } = await import(srcUrl('src/shared/acces-mobile-conversation.ts'));
const drainMod = await import(srcUrl('src/shared/acces-mobile-refusal-drain.ts')).catch(() => null);

const serverOpts = () => ({ allowedLogin: LOGIN, readToken: () => TOKEN, upstream: async () => ({ ok: true }), log: () => {}, refusedLingerMaxMs: HOSTILE_LINGER_MS });

async function startServer() {
  if (TOPOLOGY === 'split') {
    const child = fork(fileURLToPath(import.meta.url), ['--serve', '--src', SRC], { execArgv: ['--experimental-strip-types', '--no-warnings'] });
    const port = await new Promise((res, rej) => { child.once('message', (m) => res(m.port)); child.once('error', rej); });
    return { port, stop: () => { child.send('stop'); } };
  }
  const server = createAccesMobileServer(serverOpts());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, stop: () => { server.closeAllConnections(); server.close(); } };
}

const ANSWER = '/api/answer?id=w1&request=r1'; // the plain 128 KB cap (/api/send and /api/launch take the 20 MB attachment cap)
const HEAD = (p, len) => `POST ${p} HTTP/1.1\r\nHost: x\r\nTailscale-User-Login: ${LOGIN}\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${len}\r\n\r\n`;

/** A raw-socket sender: headers, then the body in 64 KB writes honouring backpressure. "Reads the 413" = a 413 status line parsed from a data event
 *  before the socket is torn down; it settles (and hangs up, like any client that got its answer) the instant it has it. `hold` keeps pushing after the 413 (the hostile sender). */
function rawRun(port, p, bodyLen, hold = false) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    const t0 = Date.now();
    let got = '', status = 0, err = '', settled = false, sent = 0;
    const chunk = Buffer.alloc(65536, 0x41);
    const settle = () => { if (settled) return; settled = true; clearTimeout(t); s.destroy(); resolve({ status: status || -1, err, sent, ms: Date.now() - t0 }); };
    const t = setTimeout(() => { err = err || 'TIMEOUT'; settle(); }, hold ? 30000 : 15000);
    s.on('data', (d) => {
      got += d.toString('latin1');
      if (!status) { const m = /^HTTP\/1\.[01] (\d{3})/.exec(got); if (m) status = Number(m[1]); }
      if (status && !hold) settle();
    });
    s.on('error', (e) => { err = e.code ?? String(e); });
    s.on('close', settle);
    s.on('connect', async () => {
      s.write(HEAD(p, bodyLen));
      while (sent < bodyLen && !s.destroyed) {
        const n = Math.min(chunk.length, bodyLen - sent);
        sent += n;
        if (!s.write(n === chunk.length ? chunk : chunk.subarray(0, n))) await new Promise((r) => { const f = () => { s.off('drain', f); s.off('close', f); r(); }; s.once('drain', f); s.once('close', f); });
      }
      if (status && !hold) settle();
    });
  });
}

/** The client of server-launch.test.ts `call()` verbatim (http.request, whole body in end()): -1 on EPIPE/ECONNRESET. */
function httpRun(port, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Tailscale-User-Login': LOGIN, Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, agent: false }, (res) => {
      res.on('error', () => resolve({ status: res.statusCode ?? -1, err: '' }));
      res.on('data', () => {});
      res.on('end', () => resolve({ status: res.statusCode ?? 0, err: '' }));
    });
    req.on('error', (e) => (e.code === 'EPIPE' || e.code === 'ECONNRESET' ? resolve({ status: -1, err: e.code }) : reject(e)));
    req.end(body);
  });
}

const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };

async function main() {
  const srv = await startServer();
  // shapes: (a) the plain cap, 20× it (> 8× past the 413); (b) /api/launch at 1.4× the attachment cap — the shape of the flaky test.
  const smallLen = 20 * MOBILE_SEND_MAX_BODY;
  const smallBody = Buffer.alloc(smallLen, 0x41);
  const launchBody = Buffer.alloc(Math.ceil(MOBILE_ATTACH_MAX_BODY * 1.4), 0x41);
  const flavors = [];
  if (CLIENT === 'raw' || CLIENT === 'both') flavors.push(['raw', RUNS, () => rawRun(srv.port, ANSWER, smallLen)], ['raw-launch', RUNS, () => rawRun(srv.port, '/api/launch', launchBody.length)]);
  if (CLIENT === 'http' || CLIENT === 'both') flavors.push(['http', RUNS, () => httpRun(srv.port, ANSWER, smallBody)], ['http-launch', RUNS, () => httpRun(srv.port, '/api/launch', launchBody)]);
  let dirty = false;
  for (const [name, runs, run] of flavors) {
    const tally = { arm: ARM, client: name, topology: TOPOLOGY, runs, read413: 0, minus1: 0, other: 0, errCodes: {} };
    for (let i = 0; i < runs; i++) {
      const r = await run();
      if (r.status === 413) tally.read413++;
      else if (r.status === -1) { tally.minus1++; bump(tally.errCodes, r.err || 'none'); } else { tally.other++; bump(tally.errCodes, `status${r.status}`); }
    }
    if (tally.read413 !== runs) dirty = true;
    console.log(JSON.stringify(tally));
  }
  if (CLIENT === 'hostile' || CLIENT === 'both') {
    if (!drainMod) console.log(JSON.stringify({ arm: ARM, client: 'hostile', topology: TOPOLOGY, skipped: 'no refusal-drain bounds in this tree' }));
    else {
      // a sender that never stops: 50× the attachment cap offered; the server must hang up within the linger bound having taken ≤ drain bytes + kernel buffers past the 413.
      const tally = { arm: ARM, client: 'hostile', topology: TOPOLOGY, runs: HOSTILE_RUNS, read413: 0, held: 0, unbounded: 0, maxMs: 0, maxSent: 0 };
      for (let i = 0; i < HOSTILE_RUNS; i++) {
        const r = await rawRun(srv.port, ANSWER, 50 * MOBILE_ATTACH_MAX_BODY, true);
        if (r.status === 413) tally.read413++;
        if (r.ms > HOSTILE_LINGER_MS + 1500) tally.held++;
        if (r.sent > MOBILE_SEND_MAX_BODY + drainMod.REFUSED_DRAIN_MAX_BYTES + KERNEL_SLACK) tally.unbounded++;
        tally.maxMs = Math.max(tally.maxMs, r.ms);
        tally.maxSent = Math.max(tally.maxSent, r.sent);
      }
      if (tally.read413 !== HOSTILE_RUNS || tally.held || tally.unbounded) dirty = true;
      console.log(JSON.stringify(tally));
    }
  }
  srv.stop();
  console.error(dirty ? `DIRTY arm=${ARM} topology=${TOPOLOGY}` : `CLEAN arm=${ARM} topology=${TOPOLOGY}: every run read the 413`);
  process.exit(dirty ? 1 : 0);
}

if (process.argv.includes('--serve')) {
  const server = createAccesMobileServer(serverOpts());
  server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
  process.on('message', (m) => { if (m === 'stop') process.exit(0); });
} else {
  await main();
}
