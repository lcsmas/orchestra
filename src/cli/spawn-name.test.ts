import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAME_CONVENTION } from '../shared/naming-policy.ts';

// #382 — `orchestra spawn --name`: drives the BUILT cli.js (a source-only test would pass on a stale bundle).
//  · REFUSALS (no name / unknown rôle / rôle without an object): rc 1, the convention restated, "Nothing was created",
//    and the CLI never reached the socket — asserted twice: against a DEAD socket (the refusal text wins over a connect
//    error) and against a recording stub (zero requests). Prior art: body-unknown-flag.test.ts, spawn-effort.test.ts.
//  · ACCEPTANCE: a valid name is sent as `name`, and the FINAL branch the app answers (collision-suffixed) is printed.
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'dist-electron', 'cli.js');
const needsBuild = { skip: existsSync(CLI) ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`' };

function freshHome(t: { after: (fn: () => void) => void }): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'orch-spawnname-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

/** Run the built CLI in an isolated home against `sock` (never the live socket). */
function cli(home: string, sock: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const env: Record<string, string> = { ...process.env, ORCHESTRA_HOME: home, HOME: home, ORCHESTRA_SOCK: sock, ORCHESTRA_WS_ID: 'caller-1' };
  delete env.ORCHESTRA_RUN_ID;
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** Same, but against a recording stub socket that answers `reply`; returns every body the CLI POSTed. */
const STUB_RUNNER = `
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
const [cliPath, argsJson, replyJson, home] = process.argv.slice(process.argv.indexOf('--ARGS--') + 1);
const dir = mkdtempSync(path.join(os.tmpdir(), 'orch-spawnname-stub-'));
const sock = path.join(dir, 's.sock');
const seen = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    seen.push({ url: req.url, body: JSON.parse(raw || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(replyJson);
  });
});
await new Promise((r) => server.listen(sock, r));
const env = { ...process.env, ORCHESTRA_SOCK: sock, ORCHESTRA_HOME: home, HOME: home, ORCHESTRA_WS_ID: 'caller-1' };
delete env.ORCHESTRA_RUN_ID;
execFile(process.execPath, [cliPath, ...JSON.parse(argsJson)], { encoding: 'utf8', env, timeout: 15000 }, (err, stdout, stderr) => {
  server.closeAllConnections();
  server.close(() => {
    rmSync(dir, { recursive: true, force: true });
    process.stdout.write('__ENVELOPE__' + JSON.stringify({ code: err ? (err.code ?? -1) : 0, stdout, stderr, seen }));
    process.exit(0);
  });
});
`;

function viaStub(home: string, args: string[], reply: object): { code: number; stdout: string; stderr: string; seen: { url: string; body: Record<string, unknown> }[] } {
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', STUB_RUNNER, '--', '--ARGS--', CLI, JSON.stringify(args), JSON.stringify(reply), home],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );
  const i = out.indexOf('__ENVELOPE__');
  assert.notEqual(i, -1, `stub runner produced no envelope:\n${out}`);
  return JSON.parse(out.slice(i + '__ENVELOPE__'.length));
}

const REFUSED: Array<[string, string[]]> = [
  ['no --name', ['spawn', '--task', 'do a thing']],
  ['--name with no value', ['spawn', '--task', 'do a thing', '--name']],
  ['an unknown rôle', ['spawn', '--name', 'fix-checkout-typo', '--task', 'do a thing']],
  ['a rôle with no object', ['spawn', '--name', 'impl-', '--task', 'do a thing']],
  ['a rôle that is only a prefix of a word', ['spawn', '--name', 'implement-x', '--task', 'do a thing']],
];

for (const [label, args] of REFUSED) {
  test(`spawn refused — ${label}: rc 1, convention restated, nothing created, dead socket never reached`, needsBuild, (t) => {
    const home = freshHome(t);
    const r = cli(home, path.join(home, 'dead.sock'), args);
    assert.equal(r.code, 1, r.stderr);
    assert.ok(r.stderr.includes(NAME_CONVENTION), r.stderr);
    assert.match(r.stderr, /Nothing was created/);
    assert.doesNotMatch(r.stderr, /could not reach Orchestra socket/); // refused BEFORE the socket
    assert.equal(r.stdout, '');
  });

  test(`spawn refused — ${label}: zero requests reach a live socket`, needsBuild, (t) => {
    const home = freshHome(t);
    const r = viaStub(home, args, { ok: true, id: 'ws-new', branch: 'b-new' });
    assert.equal(r.code, 1, r.stderr);
    assert.deepEqual(r.seen, []);
    assert.doesNotMatch(r.stdout, /Spawned/);
  });
}

test('positive control: a VALID name does reach the (dead) socket — the dead-socket arm can tell "refused" from "reached"', needsBuild, (t) => {
  const home = freshHome(t);
  const r = cli(home, path.join(home, 'dead.sock'), ['spawn', '--name', 'impl-x-1', '--task', 'do a thing']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /could not reach Orchestra socket/);
  assert.doesNotMatch(r.stderr, /Nothing was created/);
});

test('a valid name is sent as `name`; the FINAL (collision-suffixed) branch the app answers is what is printed', needsBuild, (t) => {
  const home = freshHome(t);
  const r = viaStub(home, ['spawn', '--name', '  impl-politique-nommage-381 ', '--task', 'do a thing', '--detached'], {
    ok: true,
    id: 'ws-new',
    branch: 'impl-politique-nommage-381-2',
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.seen.length, 1);
  assert.equal(r.seen[0].url, '/spawn');
  assert.equal(r.seen[0].body.name, 'impl-politique-nommage-381'); // sanitised/trimmed by the shared check
  assert.equal(r.seen[0].body.detached, true);
  assert.equal(r.stdout, 'Spawned ws-new on branch impl-politique-nommage-381-2\n');
});

test('an app that refuses (old CLI shape reaching the route) has its error printed verbatim, rc 1, no Spawned line', needsBuild, (t) => {
  const home = freshHome(t);
  const error = `refusing to spawn: a spawn needs a name (--name): none given — expected ${NAME_CONVENTION}. Nothing was created.`;
  const r = viaStub(home, ['spawn', '--name', 'impl-x-1', '--task', 'do a thing'], { ok: false, error });
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes(error), r.stderr);
  assert.doesNotMatch(r.stdout, /Spawned/);
});
