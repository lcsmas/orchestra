import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `orchestra spawn --effort <level>` must reach /spawn as `effort` (fleet policy:
// OPS at high, workers at xhigh). Drives the BUILT bundle against a stub socket
// (same pattern and reasons as run-refreeze-args.test.ts).

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
  seen: { effort?: string; model?: string; task?: string }[];
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
const dir = mkdtempSync(path.join(os.tmpdir(), 'orch-spawneffort-'));
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

const OK = "return { ok: true, id: 'ws-new', branch: 'b-new' };";

test('spawn --effort high: POSTs effort=high beside the model', needsBuild, () => {
  const r = driveCli(['spawn', '--task', 'do a thing', '--model', 'opus', '--effort', 'high'], OK);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.seen.length, 1);
  assert.equal(r.seen[0].effort, 'high');
  assert.equal(r.seen[0].model, 'opus');
});

test('spawn without --effort: sends no effort (the Settings default applies)', needsBuild, () => {
  const r = driveCli(['spawn', '--task', 'do a thing'], OK);
  assert.equal(r.code, 0, r.stderr);
  assert.equal('effort' in r.seen[0], false);
});
