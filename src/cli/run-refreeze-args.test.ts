import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ISSUE #156 — `orchestra run refreeze [--run <id>]`, the CLI arg-parse +
// outcome-rendering contract. Drives the BUILT bundle against a stub /runRefreeze
// socket and asserts (a) which runId the CLI resolves and POSTs, and (b) that each
// typed outcome renders the right way — a `refrozen` prints the flags and exits 0,
// every refusal exits non-zero with a diagnosable message (no stack trace).
//
// Drive the BUILT bundle, not the source: index.ts's auto-run block is guarded on
// `typeof require !== 'undefined'`, so running the source as raw ESM leaves main()
// uncalled and every command exits 0 having done nothing (sibling
// broadcast-message.test.ts / restart-args.test.ts document this).

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'dist-electron', 'cli.js');
const BUILT = existsSync(CLI);
const needsBuild = {
  skip: BUILT ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`',
};

interface Captured {
  runId?: string;
}
interface StubOutcome {
  code: number;
  stdout: string;
  stderr: string;
  seen: Captured[];
}

// Server in a CHILD process for the same reason restart-args.test.ts documents:
// execFileSync would block the loop the server needs to accept. The reply is a
// function body over `body`, so each test injects the outcome it wants back.
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
const dir = mkdtempSync(path.join(os.tmpdir(), 'orch-refreeze-'));
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

// The refrozen reply echoes the runId and returns a serialized all-mechanisms-OFF
// set with delivery+wake ON, so the printed table is deterministic.
const REFROZEN = `return {
  ok: true, outcome: 'refrozen', runId: body.runId,
  frozenFlags: JSON.stringify({ delivery: true, wake: true, askGate: false, liveness: false, fencing: false, capability: false, receipts: false }),
};`;

test('run refreeze --run <id>: POSTs that run id, prints the frozen table, exits 0', needsBuild, () => {
  const r = driveCli(['run', 'refreeze', '--run', 'mission-x'], REFROZEN);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.seen.length, 1, 'exactly one socket call');
  assert.equal(r.seen[0].runId, 'mission-x', 'the --run value is what the verb POSTs');
  assert.match(r.stdout, /Re-froze mission run mission-x/);
  // The printed table pins the flip the operator just made.
  assert.match(r.stdout, /delivery\s+ON/);
  assert.match(r.stdout, /wake\s+ON/);
  assert.match(r.stdout, /ask_gate\s+OFF/);
});

test('run refreeze (no --run): resolves $ORCHESTRA_RUN_ID', needsBuild, () => {
  const r = driveCli(['run', 'refreeze'], REFROZEN, { runIdEnv: 'my-mission' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.seen[0].runId, 'my-mission', 'defaults to $ORCHESTRA_RUN_ID');
});

test('run refreeze (no --run, no env): resolves the DEFAULT_RUN_ID, not empty', needsBuild, () => {
  const r = driveCli(['run', 'refreeze'], REFROZEN, { runIdEnv: null });
  assert.equal(r.code, 0, r.stderr);
  // Whatever the default is, the CLI must send a NON-empty run id — a blank runId
  // would refuse server-side ('missing runId'), so pin that it is populated.
  assert.ok(r.seen[0].runId && r.seen[0].runId.length > 0, 'a non-empty default run id is sent');
});

test('outcome not-mission → non-zero exit, diagnosable, NO stack trace', needsBuild, () => {
  const r = driveCli(
    ['run', 'refreeze', '--run', 'ops-vague'],
    `return { ok: true, outcome: 'not-mission', runId: body.runId };`,
  );
  assert.notEqual(r.code, 0, 'a refused refreeze exits non-zero');
  assert.match(r.stderr, /not a MISSION/);
  assert.doesNotMatch(r.stderr, /\n\s+at\s/, 'no stack frames');
});

test('outcome live-child → non-zero exit, names the reason', needsBuild, () => {
  const r = driveCli(
    ['run', 'refreeze', '--run', 'mission-busy'],
    `return { ok: true, outcome: 'live-child', runId: body.runId };`,
  );
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /live child mid-turn/);
  assert.doesNotMatch(r.stderr, /\n\s+at\s/);
});

test('outcome no-run → non-zero exit, says nothing to refreeze', needsBuild, () => {
  const r = driveCli(
    ['run', 'refreeze', '--run', 'ghost'],
    `return { ok: true, outcome: 'no-run', runId: body.runId };`,
  );
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no run row for ghost/);
});

test('outcome no-flags → non-zero exit, names the #134 F1 no-late-insert state', needsBuild, () => {
  const r = driveCli(
    ['run', 'refreeze', '--run', 'mission-bare'],
    `return { ok: true, outcome: 'no-flags', runId: body.runId };`,
  );
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no frozen-flags row/);
});

test('server ok:false (bus unavailable) surfaces the error, non-zero, no stack', needsBuild, () => {
  const r = driveCli(
    ['run', 'refreeze', '--run', 'mission-x'],
    `return { ok: false, error: 'bus is unavailable — cannot refreeze (no run row without a bus)' };`,
  );
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /bus is unavailable/);
  assert.doesNotMatch(r.stderr, /\n\s+at\s/);
});

test('bad subcommand: `orchestra run bogus` fails with usage, no socket call', needsBuild, () => {
  const r = driveCli(['run', 'bogus'], REFROZEN);
  assert.notEqual(r.code, 0);
  assert.equal(r.seen.length, 0, 'must not POST for an unknown subcommand');
  assert.match(r.stderr, /usage: orchestra run refreeze/);
});
