import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #383 — `orchestra rename` must tell the app WHO is asking (`from` = the caller's ORCHESTRA_WS_ID, as `spawn` does):
// rename authority is human > parent > child, decided main-side. An old CLI sends no `from` => unknown caller. Drives the
// BUILT bundle against a stub socket (same pattern and reasons as spawn-effort.test.ts); the refusal text is the app's.

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
  seen: Record<string, unknown>[];
}

const RUNNER = `
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const argv = process.argv.slice(process.argv.indexOf('--ARGS--') + 1);
const [cliPath, argsJson, replySrc, envJson] = argv;
const args = JSON.parse(argsJson);
const reply = new Function('body', replySrc);
const dir = mkdtempSync(path.join(os.tmpdir(), 'orch-renamefrom-'));
const sock = path.join(dir, 's.sock');
const seen = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    seen.push({ __url: req.url, ...body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply(body)));
  });
});
await new Promise((r) => server.listen(sock, r));

const env = { ...process.env, ORCHESTRA_SOCK: sock };
delete env.ORCHESTRA_WS_ID; delete env.ORCHESTRA_WS_ID_IDENTITY; delete env.ORCHESTRA_HOME;
Object.assign(env, JSON.parse(envJson));

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

function driveCli(args: string[], replySrc: string, env: Record<string, string> = {}): StubOutcome {
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', RUNNER, '--', '--ARGS--', CLI, JSON.stringify(args), replySrc, JSON.stringify(env)],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );
  const marker = out.indexOf('__ENVELOPE__');
  assert.notEqual(marker, -1, `stub runner produced no envelope:\n${out}`);
  return JSON.parse(out.slice(marker + '__ENVELOPE__'.length)) as StubOutcome;
}

const OK = "return { ok: true, branch: body.branch };";

test('rename sends the caller identity: from = ORCHESTRA_WS_ID, beside the target id and branch', needsBuild, () => {
  const r = driveCli(['rename', 'child-1', 'impl-better-381'], OK, { ORCHESTRA_WS_ID: 'parent-1' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.seen.length, 1);
  assert.equal(r.seen[0].__url, '/rename');
  assert.equal(r.seen[0].id, 'child-1');
  assert.equal(r.seen[0].branch, 'impl-better-381');
  assert.equal(r.seen[0].from, 'parent-1');
  assert.equal(r.stdout, 'Renamed to impl-better-381\n');
});

test('a self-rename sends from === id (the child asking about itself)', needsBuild, () => {
  const r = driveCli(['rename', 'child-1', 'x-y-z'], OK, { ORCHESTRA_WS_ID: 'child-1' });
  assert.equal(r.seen[0].from, 'child-1');
  assert.equal(r.seen[0].id, 'child-1');
});

test('no ORCHESTRA_WS_ID (a plain shell): no `from` key at all => the app sees an unknown caller', needsBuild, () => {
  const r = driveCli(['rename', 'child-1', 'x-y-z'], OK);
  assert.equal(r.code, 0, r.stderr);
  assert.equal('from' in r.seen[0], false);
});

test('a keeper born before #233 (WS_ID withheld, only the IDENTITY var): from falls back to it', needsBuild, () => {
  const r = driveCli(['rename', 'child-1', 'x-y-z'], OK, { ORCHESTRA_WS_ID_IDENTITY: 'child-1' });
  assert.equal(r.seen[0].from, 'child-1');
});

test('a refusal ("named by your parent") exits non-zero with the app\'s text on stderr and NO Renamed line', needsBuild, () => {
  const text = 'named by your parent (ops-nommage-parent-380) — ask them to run `orchestra rename`';
  const r = driveCli(['rename', 'child-1', 'mine'], `return { ok: false, error: ${JSON.stringify(text)} };`, { ORCHESTRA_WS_ID: 'child-1' });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /named by your parent \(ops-nommage-parent-380\) — ask them to run `orchestra rename`/);
  assert.doesNotMatch(r.stdout, /Renamed/);
});

test('missing arguments are refused before the socket (usage), nothing is sent', needsBuild, () => {
  const r = driveCli(['rename', 'child-1'], OK, { ORCHESTRA_WS_ID: 'child-1' });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /usage: orchestra rename <id> <branch>/);
  assert.equal(r.seen.length, 0);
});
