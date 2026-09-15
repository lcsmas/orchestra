#!/usr/bin/env node
// T116.4, second half: `orchestra bus-status` PRINTS the divergence counters.
//
// ══ WHAT THIS DRIVES, AND WHAT IT DELIBERATELY DOES NOT ═════════════════════
//
// It drives the REAL BUILT CLI BUNDLE (`dist-electron/cli.js`) — the artifact a
// user runs — over a REAL unix socket, via the ORCHESTRA_SOCK seam. What is
// faked is only the far side of the socket: a tiny server that replies with the
// shape `src/main/hooks-server.ts`'s `/busStatus` route returns. Standing up a
// whole Electron app to assert a table's text would test Electron, not the verb.
//
// So the claim this rig supports is narrow and stated as such: THE VERB parses
// the frozen contract shape and prints those exact numbers, and it says so when
// the bus is down. That the MAIN PROCESS produces that shape is asserted
// separately, by src/main/bus-mirror.test.ts against a real database.
//
// ── Both arms, and a must-FAIL ──────────────────────────────────────────────
//   A1  counters present            -> the table carries every number
//   A2  bus unavailable             -> prints UNAVAILABLE, not a silent zero row
//   A3  no mechanisms               -> a distinct message, not an empty table
//   A4  MUST-FAIL control           -> served the WRONG numbers, the assertions
//                                      must go red. Without this arm, A1 would
//                                      pass on a verb that printed constants.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist-electron', 'cli.js');
if (!fs.existsSync(CLI)) {
  console.error(`missing ${CLI} — run: pnpm run build:cli`);
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-status-116-'));
const sock = path.join(dir, 'orchestra.sock');
let reply = {};

let lastRequestBody = null;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url !== '/busStatus') {
      res.writeHead(404).end('{}');
      return;
    }
    try {
      lastRequestBody = JSON.parse(body || '{}');
    } catch {
      lastRequestBody = {};
    }
    // #134 — the REAL /busStatus handler echoes the CLI's requested runId as
    // `displayRunId` and returns that run's frozen/live flags. The fake server
    // mirrors that behaviour when the reply asks it to (via `echoDisplayRunId`),
    // so the rig exercises the contract the CLI actually consumes.
    const payload = { ...reply };
    if (reply.echoDisplayRunId && lastRequestBody && typeof lastRequestBody.runId === 'string') {
      payload.displayRunId = lastRequestBody.runId;
    }
    delete payload.echoDisplayRunId;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});

/**
 * Run the built CLI and resolve its stdout.
 *
 * ASYNC ON PURPOSE, and this is the trap that cost a debugging round: the fake
 * socket server runs IN THIS PROCESS, so a synchronous `execFileSync` blocks the
 * event loop and the server can never accept the connection the child is already
 * making. The child then waits forever on a socket nobody is reading, and the
 * observable is a plain timeout — indistinguishable from "the CLI verb hangs",
 * which is a defect in the code under test rather than in the rig. Verified with
 * a raw net server: the CLI sends a complete, correct POST /busStatus in both
 * cases.
 */
function run(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, 'bus-status'], {
      env: { ...process.env, ORCHESTRA_SOCK: sock, ...extraEnv },
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error('the CLI did not exit within 15s'));
    }, 15_000);
    // Await `close`, not `exit`: the buffers are only guaranteed flushed at
    // close, and reading them a tick early yields an empty string that reads as
    // "the verb printed nothing".
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`CLI exited ${code}: ${err}`));
      else resolve(out);
    });
  });
}

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

await new Promise((r) => server.listen(sock, r));

try {
  // ── A1 — the numbers actually reach stdout ────────────────────────────────
  console.log('A1 counters present');
  reply = {
    ok: true,
    // #134 — `runId` here is the MAIN process's mirror id (host-…). The CLI must
    // NOT print it; it prints the WAVE run it resolved (echoed as displayRunId).
    runId: 'host-should-not-print',
    echoDisplayRunId: true,
    busAvailable: true,
    frozenFlags: JSON.stringify({ delivery: true, wake: false, askGate: false, liveness: false, fencing: false, capability: false, receipts: false }),
    liveFlags: JSON.stringify({ delivery: true, wake: true, askGate: false, liveness: false, fencing: false, capability: false, receipts: false }),
    counters: [
      { mechanism: 'peer-message', missed: 7, duplicate: 3, lostWake: 11 },
      { mechanism: 'inbox-file', missed: 0, duplicate: 0, lostWake: 0 },
    ],
  };
  let out = await run({ ORCHESTRA_RUN_ID: 'wave-alpha' });
  // G8 — the CLI prints the WAVE run id it resolved, never the host mirror id.
  check('prints the WAVE run id', /run:\s*wave-alpha/.test(out), out);
  check('does NOT print the host mirror id', !out.includes('host-should-not-print'), out);
  // #134 — frozen vs live flag table: delivery frozen ON, wake frozen OFF but
  // live ON (the freeze holds against a mid-wave flip).
  const drow = out.split('\n').find((l) => /(^|\s)delivery(\s|$)/.test(l)) ?? '';
  check('delivery row shows frozen ON + live ON', /ON/.test(drow) && !/OFF/.test(drow), drow);
  const wrow = out.split('\n').find((l) => /(^|\s)wake(\s|$)/.test(l)) ?? '';
  check('wake row shows frozen OFF, live ON (freeze visible)', /OFF/.test(wrow) && /ON/.test(wrow), wrow);
  check('ask_gate printed as the WIRE name', /ask_gate/.test(out), out);
  check('prints bus: available', /bus:\s*available/.test(out), out);
  check('prints the mechanism', out.includes('peer-message'), out);
  // Each number asserted INDIVIDUALLY. A single "contains 7" would pass on a
  // verb that printed one column and dropped the rest.
  const row = out.split('\n').find((l) => l.includes('peer-message')) ?? '';
  check('missed 7 in the peer-message row', /\b7\b/.test(row), row);
  check('duplicate 3 in the peer-message row', /\b3\b/.test(row), row);
  check('lost-wake 11 in the peer-message row', /\b11\b/.test(row), row);
  check('the ZERO mechanism is still printed', out.includes('inbox-file'), out);
  const zrow = out.split('\n').find((l) => l.includes('inbox-file')) ?? '';
  check('and shows explicit zeros', (zrow.match(/\b0\b/g) ?? []).length >= 3, zrow);
  check('column headers present', /missed/.test(out) && /lost-wake/.test(out), out);

  // ── A2 — bus down is SAID, not implied by zeros ───────────────────────────
  console.log('A2 bus unavailable');
  reply = {
    ok: true,
    runId: 'run-beta',
    busAvailable: false,
    counters: [{ mechanism: 'peer-message', missed: 4, duplicate: 0, lostWake: 0 }],
  };
  out = await run();
  check('prints UNAVAILABLE', /bus:\s*UNAVAILABLE/.test(out), out);
  check('does NOT claim available', !/bus:\s*available/.test(out), out);
  check('still prints the counters', out.includes('peer-message') && /\b4\b/.test(out), out);

  // ── A3 — no mechanisms is distinct from an empty table ────────────────────
  console.log('A3 no mechanisms');
  reply = { ok: true, runId: 'run-gamma', busAvailable: true, counters: [] };
  out = await run();
  check('says so explicitly', /No mechanisms mirroring/.test(out), out);

  // ── A4 — MUST-FAIL control ────────────────────────────────────────────────
  // Serve numbers that do NOT match what A1 asserted. Every A1 number check
  // must now be false. If any stays true, that check was reading a constant the
  // verb prints regardless of input, and A1 proved nothing.
  console.log('A4 must-FAIL control (wrong numbers served)');
  reply = {
    ok: true,
    runId: 'host-delta',
    echoDisplayRunId: true,
    busAvailable: true,
    counters: [{ mechanism: 'peer-message', missed: 999, duplicate: 888, lostWake: 777 }],
  };
  out = await run({ ORCHESTRA_RUN_ID: 'wave-delta' });
  const crow = out.split('\n').find((l) => l.includes('peer-message')) ?? '';
  check('control: 7 is GONE', !/\b7\b/.test(crow.replace(/777/g, '')), crow);
  check('control: 11 is GONE', !/\b11\b/.test(crow), crow);
  check('control: A1 wave-alpha is GONE', !out.includes('wave-alpha'), out);
  check('control: the served 999 IS present', /999/.test(crow), crow);

  // ── A5 (#134 G8) — the run id printed is the CLI's WAVE run, never host- ────
  // must-FAIL against host-: even when the server's own runId is a host- id, the
  // CLI prints the wave run it resolved. Asserting the host- id is ABSENT is the
  // disproof of the reproduced defect (bus-status printing the per-boot host run).
  console.log('A5 G8: prints the wave run id, never host-');
  reply = { ok: true, runId: 'host-abc123', echoDisplayRunId: true, busAvailable: true, counters: [] };
  out = await run({ ORCHESTRA_RUN_ID: 'lead-anchor-42' });
  check('prints the wave run id', /run:\s*lead-anchor-42/.test(out), out);
  check('the host- id never appears', !/host-abc123/.test(out), out);
} finally {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS — bus-status prints the frozen contract' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
