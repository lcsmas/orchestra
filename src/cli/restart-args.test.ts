import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ISSUE #111 — `orchestra restart <id> [--fresh]`, the CLI arg-parse contract
// (gate T111.1). Drives the BUILT bundle against a stub `/restart` socket and
// asserts what the CLI actually POSTs and how it reports.
//
// The failure mode this excludes: `restart <id>` and `restart <id> --fresh`
// parsing to the SAME request (--fresh silently dropped, or treated as the id).
// So the stub captures the request body and every assertion pins the `fresh`
// field AND the `id` — a CLI that ignored --fresh, or forwarded the literal
// '--fresh' as the id, fails here.
//
// Drive the BUILT bundle, not the source: index.ts's auto-run block is guarded
// on `typeof require !== 'undefined'`, so running the source as raw ESM leaves
// main() uncalled and every command exits 0 having done nothing (sibling
// broadcast-message.test.ts documents this).

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'dist-electron', 'cli.js');
const BUILT = existsSync(CLI);
const needsBuild = {
  skip: BUILT ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`',
};

interface Captured {
  id?: string;
  fresh?: boolean;
}
interface StubOutcome {
  code: number;
  stdout: string;
  stderr: string;
  seen: Captured[];
}

// Server in a CHILD process for the same reason broadcast-message.test.ts
// documents: execFileSync would block the loop the server needs to accept.
const RUNNER = `
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const argv = process.argv.slice(process.argv.indexOf('--ARGS--') + 1);
const [cliPath, argsJson, replySrc, wsId] = argv;
const args = JSON.parse(argsJson);
const reply = new Function('body', replySrc);
const dir = mkdtempSync(path.join(os.tmpdir(), 'orch-restart-'));
const sock = path.join(dir, 's.sock');
const seen = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
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
// selfWorkspaceId reads ORCHESTRA_WS_ID with an ORCHESTRA_WS_ID_IDENTITY
// fallback (resolveSelfWorkspaceId) — a test running INSIDE a real workspace
// inherits the latter, so both must be cleared to exercise the no-self path.
if (wsId) env.ORCHESTRA_WS_ID = wsId;
else { delete env.ORCHESTRA_WS_ID; delete env.ORCHESTRA_WS_ID_IDENTITY; }

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

function driveCli(args: string[], replySrc: string, wsId: string | null = 'caller-1'): StubOutcome {
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', RUNNER, '--', '--ARGS--', CLI, JSON.stringify(args), replySrc, wsId ?? ''],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );
  const marker = out.indexOf('__ENVELOPE__');
  assert.notEqual(marker, -1, `stub runner produced no envelope:\n${out}`);
  return JSON.parse(out.slice(marker + '__ENVELOPE__'.length)) as StubOutcome;
}

const OK = `return { ok: true, mode: 'terminal', fresh: !!body.fresh };`;

test('restart <id>: posts id with fresh=false, exits 0', needsBuild, () => {
  const r = driveCli(['restart', 'ws-target'], OK);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.seen.length, 1);
  assert.equal(r.seen[0].id, 'ws-target');
  assert.equal(r.seen[0].fresh, false);
  assert.match(r.stdout, /conversation preserved/);
});

test('restart <id> --fresh: posts fresh=true (parses DISTINCTLY from the default)', needsBuild, () => {
  const r = driveCli(['restart', 'ws-target', '--fresh'], `return { ok: true, mode: 'structured', fresh: !!body.fresh };`);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.seen[0].id, 'ws-target');
  // The discriminating pin: --fresh must flip the field, and the id must NOT be
  // the literal '--fresh'.
  assert.equal(r.seen[0].fresh, true);
  assert.notEqual(r.seen[0].id, '--fresh');
  assert.match(r.stdout, /fresh \(conversation cleared\)/);
});

test('--fresh before the id is also parsed (flag position-independent)', needsBuild, () => {
  const r = driveCli(['restart', '--fresh', 'ws-target'], OK);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.seen[0].id, 'ws-target');
  assert.equal(r.seen[0].fresh, true);
});

test('no id: defaults to ORCHESTRA_WS_ID (self-restart, like status/link)', needsBuild, () => {
  const r = driveCli(['restart'], OK, 'caller-self');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.seen[0].id, 'caller-self');
  assert.equal(r.seen[0].fresh, false);
});

test('no id and no ORCHESTRA_WS_ID: fails DIAGNOSABLY before any socket call', needsBuild, () => {
  const r = driveCli(['restart'], OK, null);
  assert.notEqual(r.code, 0);
  assert.equal(r.seen.length, 0, 'must not POST when it cannot resolve a target');
  assert.match(r.stderr, /could not determine which workspace to restart/);
});

test('unknown id: server ok:false surfaces the error, non-zero exit, NO stack trace', needsBuild, () => {
  const r = driveCli(
    ['restart', 'ghost'],
    `return { ok: false, error: 'unknown workspace: ' + body.id };`,
  );
  assert.notEqual(r.code, 0, 'a refused restart must exit non-zero');
  assert.match(r.stderr, /unknown workspace: ghost/);
  // Diagnosable, not a stack trace (T111.1): no "at " frames, no "Error:" dump.
  assert.doesNotMatch(r.stderr, /\n\s+at\s/);
});
