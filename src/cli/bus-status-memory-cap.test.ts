import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #320 + D1 (ledger #329) — `orchestra bus-status` prints the `memory cap:` line (frozen switch + levels, "applies at the next session start") and says a memory Pause
// is IN EFFECT from the runs the BUS reports paused, not from the guard's "due now". Drives the BUILT bundle against a stub /busStatus socket
// (same pattern and reasons as bus-status-no-run.test.ts / run-refreeze-args.test.ts).

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

const GIB = 1024 ** 3;
const MECH = ['delivery', 'wake', 'askGate', 'liveness', 'fencing', 'capability', 'receipts', 'pause', 'dockerRelay', 'memoryCap'];
const flags = (on: string[]) => JSON.stringify(Object.fromEntries(MECH.map((m) => [m, on.includes(m)])));
const snap = (over: Record<string, unknown> = {}) => ({
  sampled: true, measured: true, availBytes: 4.2 * GIB, readAt: 1, admission: 'held', admissionEnabled: true, pause: 'none', episode: 1, pauseCycle: 1, mayReleaseOneStart: false,
  heldSince: Date.UTC(2026, 9, 8, 12, 40), pauseSince: null, admissionBytes: 6 * GIB, criticalBytes: 3 * GIB, releaseMarginBytes: GIB, sampleIntervalMs: 10_000, ...over,
});
const reply = (extra: Record<string, unknown>, frozenOn: string[], runExists = true) => `return ${JSON.stringify({
  ok: true, busAvailable: true, counters: [], runExists, frozenFlags: flags(frozenOn), liveFlags: flags([]), memoryGuard: snap(), ...extra,
})};`.replace('"__RUN__"', 'body.runId');
const cap = { softBytes: 3 * GIB, hardBytes: 6 * GIB, scopes: 2, supported: true };

test('memory cap ON for the run: the line shows the levels, that it applies at the next session start, and the live scope count; the switch table row is ON', needsBuild, () => {
  const r = driveCli(['bus-status'], reply({ memoryCap: cap }, ['memoryCap']), { runIdEnv: 'wave-h' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^memory cap: ON for this run \(frozen\) — hard 6\.0 GB \(kernel kill, no swap\) · soft 3\.0 GB \(warning level, no kernel throttle\); read at each member's next session start, running sessions keep what they started with · 2 member scope\(s\) live$/m);
  assert.match(r.stdout, /memory_cap\s+ON\s+OFF/, 'frozen ON, live OFF — the table row exists under its wire name');
});

test('memory cap OFF for the run (the default): says OFF and that no member scope exists; a run with NO row says nothing is frozen', needsBuild, () => {
  const off = driveCli(['bus-status'], reply({ memoryCap: cap }, []), { runIdEnv: 'wave-h' });
  assert.match(off.stdout, /^memory cap: OFF for this run \(frozen\) — no member scope/m);
  const norun = driveCli(['bus-status'], reply({ memoryCap: cap }, [], false), { runIdEnv: 'standalone' });
  assert.match(norun.stdout, /^memory cap: no run — nothing frozen/m);
});

test('an app that sends no memoryCap (older build): no `memory cap:` line, the rest of the output unchanged', needsBuild, () => {
  const r = driveCli(['bus-status'], reply({}, ['memoryCap']), { runIdEnv: 'wave-h' });
  assert.doesNotMatch(r.stdout, /memory cap:/);
  assert.match(r.stdout, /^memory: 4\.2 GB available/m);
});

test('D1 must-FAIL on master: the guard says "due now: none" but the bus has a run under a memory Pause ⇒ `memory Pause IN EFFECT`, never `memory Pause none`', needsBuild, () => {
  const paused = [{ runId: '36773f53-0000-4000-8000-000000000000', label: 'bloc2-ops', since: Date.UTC(2026, 9, 8, 12, 51), resuming: false }];
  const r = driveCli(['bus-status'], reply({ memoryCap: cap, memoryPausedRuns: paused }, ['memoryCap']), { runIdEnv: 'wave-h' });
  assert.match(r.stdout, /memory Pause IN EFFECT on 1 run\(s\) \(bloc2-ops\) since 2026-10-08T12:51:00\.000Z \(lifts above 6\.0 GB\)/);
  assert.doesNotMatch(r.stdout, /memory Pause none/);
  const none = driveCli(['bus-status'], reply({ memoryCap: cap, memoryPausedRuns: [] }, ['memoryCap']), { runIdEnv: 'wave-h' });
  assert.match(none.stdout, /memory Pause none \(due below 3\.0 GB\)/, 'control: no run paused ⇒ none');
});
