import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ISSUE #206 — `orchestra bus-status` for a run with NO run row (a standalone
// workspace) must not print its frozen switches as OFF: nothing is frozen yet.
// Drives the BUILT bundle against a stub /busStatus socket (same pattern and
// reasons as run-refreeze-args.test.ts).

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'dist-electron', 'cli.js');
const BUILT = existsSync(CLI);
const needsBuild = {
  skip: BUILT ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`',
};

interface StubOutcome {
  code: number;
  stdout: string;
  stderr: string;
  seen: { runId?: string }[];
}

const RUNNER = `
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const argv = process.argv.slice(process.argv.indexOf('--ARGS--') + 1);
const [cliPath, argsJson, replySrc, wsId, runIdEnv] = argv;
const args = JSON.parse(argsJson);
const reply = new Function('body', replySrc);
const dir = mkdtempSync(path.join(os.tmpdir(), 'orch-busstatus-'));
const sock = path.join(dir, 's.sock');
const seen = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    // The socket protocol wraps the route in { route, ...payload }; capture the
    // payload the verb sent so we can pin the resolved runId.
    seen.push(body);
    let payload;
    try { payload = reply(body); }
    catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'stub reply failed: ' + String(e) }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});
await new Promise((r) => server.listen(sock, r));

const env = { ...process.env, ORCHESTRA_SOCK: sock };
if (wsId) env.ORCHESTRA_WS_ID = wsId;
else { delete env.ORCHESTRA_WS_ID; delete env.ORCHESTRA_WS_ID_IDENTITY; }
if (runIdEnv) env.ORCHESTRA_RUN_ID = runIdEnv;
else delete env.ORCHESTRA_RUN_ID;

execFile(process.execPath, [cliPath, ...args], { encoding: 'utf8', env, timeout: 15000 },
  (err, stdout, stderr) => {
    server.closeAllConnections();
    server.close(() => {
      rmSync(dir, { recursive: true, force: true });
      process.stdout.write('__ENVELOPE__' + JSON.stringify({
        code: err ? (err.code ?? -1) : 0, stdout, stderr, seen,
      }));
      process.exit(0);
    });
  });
`;

function driveCli(
  args: string[],
  replySrc: string,
  opts: { wsId?: string | null; runIdEnv?: string | null } = {},
): StubOutcome {
  const out = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      RUNNER,
      '--',
      '--ARGS--',
      CLI,
      JSON.stringify(args),
      replySrc,
      opts.wsId ?? 'caller-1',
      opts.runIdEnv ?? '',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );
  const marker = out.indexOf('__ENVELOPE__');
  assert.notEqual(marker, -1, `stub runner produced no envelope:\n${out}`);
  return JSON.parse(out.slice(marker + '__ENVELOPE__'.length)) as StubOutcome;
}

const ALL_OFF = JSON.stringify({ delivery: false, wake: false, askGate: false, liveness: false, fencing: false, capability: false, receipts: false });
const ALL_ON = JSON.stringify({ delivery: true, wake: true, askGate: true, liveness: true, fencing: true, capability: true, receipts: true });
const reply = (runExists: string) => `return {
  ok: true, busAvailable: true, counters: [], displayRunId: body.runId,
  ${runExists}
  frozenFlags: ${JSON.stringify(ALL_OFF)}, liveFlags: ${JSON.stringify(ALL_ON)},
};`;

test('bus-status on a run with no run row: says so, frozen column is "—", never OFF', needsBuild, () => {
  const r = driveCli(['bus-status'], reply('runExists: false,'), { runIdEnv: 'standalone-ws' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.seen[0].runId, 'standalone-ws');
  assert.match(r.stdout, /run: standalone-ws — no such run \(standalone/);
  assert.match(r.stdout, /delivery\s+—\s+ON/);
  assert.doesNotMatch(r.stdout, /delivery\s+OFF/, 'a missing run must not read as frozen OFF');
});

test('bus-status on an existing run frozen OFF still prints OFF', needsBuild, () => {
  const r = driveCli(['bus-status'], reply('runExists: true,'), { runIdEnv: 'real-run' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^run: real-run\n/m);
  assert.doesNotMatch(r.stdout, /no such run/);
  assert.match(r.stdout, /delivery\s+OFF\s+ON/);
});

test('bus-status against an older app (no runExists field) keeps the previous rendering', needsBuild, () => {
  const r = driveCli(['bus-status'], reply(''), { runIdEnv: 'old-app-run' });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /no such run/);
  assert.match(r.stdout, /delivery\s+OFF\s+ON/);
});

// ── review-A4 F3: the hold is visible in `bus-status` ───────────────────────

test('bus-status prints a HELD run: since <iso> by <holder> (F3)', needsBuild, () => {
  // MUTANT: the CLI ignores heldAt/heldBy → no `hold:` line → RED.
  const r = driveCli(
    ['bus-status'],
    reply('runExists: true, heldAt: 1700000000000, heldBy: "alice",'),
    { runIdEnv: 'held-run' },
  );
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^hold: HELD since 2023-11-14T22:13:20\.000Z by alice/m);
});

test('bus-status on a held run with an unknown holder says "unknown", and a NOT-held run prints no hold line (F3)', needsBuild, () => {
  // MUTANT: print the hold line unconditionally / print "by null" → RED.
  const unknown = driveCli(
    ['bus-status'],
    reply('runExists: true, heldAt: 1700000000000, heldBy: null,'),
    { runIdEnv: 'held-run' },
  );
  assert.match(unknown.stdout, /^hold: HELD since .* by unknown/m);
  assert.doesNotMatch(unknown.stdout, /by null/);
  const open = driveCli(
    ['bus-status'],
    reply('runExists: true, heldAt: null, heldBy: null,'),
    { runIdEnv: 'open-run' },
  );
  assert.equal(open.code, 0, open.stderr);
  assert.doesNotMatch(open.stdout, /^hold:/m, 'a run that is not held prints no hold line');
});
