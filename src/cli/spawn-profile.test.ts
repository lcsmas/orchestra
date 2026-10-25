import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `orchestra spawn --profile <id|name>` (#401): the BUILT CLI against a stub socket — what it sends (the request + the session key, never a claim of
// what the caller holds), what it refuses before the socket, and how a refused pass is shown. The decision itself is shared/spawn-profile.test.ts.

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'dist-electron', 'cli.js');
const BUILT = existsSync(CLI);
const needsBuild = { skip: BUILT ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`' };

interface Outcome {
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
const [cliPath, argsJson, replySrc, sessionKey] = argv;
const args = JSON.parse(argsJson);
const reply = new Function('body', replySrc);
const dir = mkdtempSync(path.join(os.tmpdir(), 'orch-spawnprofile-'));
const sock = path.join(dir, 's.sock');
const seen = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    seen.push({ route: req.url, ...body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply(body)));
  });
});
await new Promise((r) => server.listen(sock, r));
const env = { ...process.env, ORCHESTRA_SOCK: sock, ORCHESTRA_WS_ID: 'caller-1' };
delete env.ORCHESTRA_WS_ID_IDENTITY;
if (sessionKey) env.ORCHESTRA_SESSION_KEY = sessionKey; else delete env.ORCHESTRA_SESSION_KEY;
execFile(process.execPath, [cliPath, ...args], { encoding: 'utf8', env, timeout: 15000 }, (err, stdout, stderr) => {
  server.closeAllConnections();
  server.close(() => {
    rmSync(dir, { recursive: true, force: true });
    process.stdout.write('__ENVELOPE__' + JSON.stringify({ code: err ? (err.code ?? -1) : 0, stdout, stderr, seen }));
    process.exit(0);
  });
});
`;

function driveCli(args: string[], replySrc: string, sessionKey = ''): Outcome {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', RUNNER, '--', '--ARGS--', CLI, JSON.stringify(args), replySrc, sessionKey], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  const marker = out.indexOf('__ENVELOPE__');
  assert.notEqual(marker, -1, `stub runner produced no envelope:\n${out}`);
  return JSON.parse(out.slice(marker + '__ENVELOPE__'.length)) as Outcome;
}

const SPAWN = ['spawn', '--name', 'impl-profile-check', '--task', 'do a thing'];
const OK = "return { ok: true, id: 'ws-new', branch: 'b-new' };";

test('spawn --profile P: POSTs profile=P and the session key; nothing about what the caller holds', needsBuild, () => {
  const r = driveCli([...SPAWN, '--profile', 'Staging admin'], OK, 'k-live');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.seen.length, 1);
  assert.equal(r.seen[0].route, '/spawn');
  assert.equal(r.seen[0].profile, 'Staging admin');
  assert.equal(r.seen[0].key, 'k-live');
  assert.equal(r.seen[0].from, 'caller-1');
  for (const k of Object.keys(r.seen[0])) assert.ok(!/holds|browserProfile|profileId/i.test(k), `the CLI must not claim a holding: ${k}`);
});

test('spawn --profile with no session key in the env: sends the request without a key (the host then cannot vouch)', needsBuild, () => {
  const r = driveCli([...SPAWN, '--profile', 'bp-0123456789ab'], OK, '');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.seen[0].profile, 'bp-0123456789ab');
  assert.equal('key' in r.seen[0], false);
});

test('spawn WITHOUT --profile: sends neither profile nor key, even with a session key in the env', needsBuild, () => {
  const r = driveCli(SPAWN, OK, 'k-live');
  assert.equal(r.code, 0, r.stderr);
  assert.equal('profile' in r.seen[0], false);
  assert.equal('key' in r.seen[0], false);
});

test('spawn --profile with no value, or whose value is the next option: refused before the socket, nothing created', needsBuild, () => {
  for (const argv of [[...SPAWN, '--profile'], [...SPAWN, '--profile', '--detached']]) {
    const r = driveCli(argv, OK, 'k');
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--profile needs a value/);
    assert.match(r.stderr, /Nothing was created/);
    assert.equal(r.seen.length, 0, 'no request reached the host');
  }
});

test('a refused pass: the worker is still created (rc 0, Spawned line) and the reason is a warning on stderr', needsBuild, () => {
  const r = driveCli(
    [...SPAWN, '--profile', 'prod'],
    "return { ok: true, id: 'ws-new', branch: 'b-new', profile: { applied: false, message: '--profile not applied: you hold no profil navigateur. The worker starts in navigation éphémère.' } };",
    'k',
  );
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'Spawned ws-new on branch b-new\n');
  assert.equal(r.stderr, 'warning: --profile not applied: you hold no profil navigateur. The worker starts in navigation éphémère.\n');
});

test('an honoured pass is confirmed on stdout, no warning', needsBuild, () => {
  const r = driveCli([...SPAWN, '--profile', 'bp-0123456789ab'], "return { ok: true, id: 'ws-new', branch: 'b-new', profile: { applied: true, message: 'Profile “Staging admin” passed.' } };", 'k');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'Spawned ws-new on branch b-new\nProfile “Staging admin” passed.\n');
  assert.equal(r.stderr, '');
});

test('--profile sent but the app answers no decision (an app that predates it): the worker is created and the silence is warned about', needsBuild, () => {
  const r = driveCli([...SPAWN, '--profile', 'bp-0123456789ab'], OK, 'k');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'Spawned ws-new on branch b-new\n');
  assert.match(r.stderr, /^warning: --profile not applied: this Orchestra did not report a profile decision/);
  // and no profile asked → no such warning (nothing to be silent about)
  assert.equal(driveCli(SPAWN, OK, 'k').stderr, '');
});

test('a kept child (start failed, ok:false + id) still reports what became of its profile, then fails with the start error', needsBuild, () => {
  const kept = "return { ok: false, id: 'ws-kept', branch: 'b-kept', error: 'the agent failed to start: boom', profile: { applied: true, message: 'Profile “Staging admin” passed.' } };";
  const r = driveCli([...SPAWN, '--profile', 'bp-0123456789ab'], kept, 'k');
  assert.notEqual(r.code, 0);
  assert.match(r.stdout, /Profile “Staging admin” passed\./);
  assert.match(r.stderr, /the agent failed to start: boom/);
  // a refusal with NO workspace at all (ok:false, no id) says nothing about a profile
  const none = driveCli([...SPAWN, '--profile', 'x'], "return { ok: false, error: 'unknown repoPath' };", 'k');
  assert.notEqual(none.code, 0);
  assert.doesNotMatch(none.stderr + none.stdout, /profile/i);
});

test('usage text and the spawn help name --profile', needsBuild, () => {
  const bare = driveCli(['spawn'], OK);
  assert.notEqual(bare.code, 0);
  assert.match(bare.stderr, /\[--profile <id\|name>\]/);
  const help = execFileSync(process.execPath, [CLI, 'help', 'spawn'], { encoding: 'utf8' });
  assert.match(help, /--profile <id\|name>/);
  assert.match(help, /navigation éphémère/);
});

test('whoami prints the held profile (the value spawn --profile accepts), or ephemeral', needsBuild, () => {
  const held = driveCli(['whoami'], "return { ok: true, id: 'caller-1', name: 'n', branch: 'b', kind: 'worktree', orchestrator: false, parentId: null, repoPath: '/r', baseBranch: 'main', linkedPrUrls: [], linkedLinearKey: null, browserProfile: { id: 'bp-0123456789ab', name: 'Staging admin' } };");
  assert.match(held.stdout, /^browser {2,}Staging admin \(bp-0123456789ab\)$/m);
  const none = driveCli(['whoami'], "return { ok: true, id: 'caller-1', name: 'n', branch: 'b', kind: 'worktree', orchestrator: false, parentId: null, repoPath: '/r', baseBranch: 'main', linkedPrUrls: [], linkedLinearKey: null, browserProfile: null };");
  assert.match(none.stdout, /^browser {2,}ephemeral$/m);
  // an app older than #401 answers no field: still ephemeral, no crash
  const old = driveCli(['whoami'], "return { ok: true, id: 'caller-1', name: 'n', branch: 'b', kind: 'worktree', parentId: null, repoPath: '/r', baseBranch: 'main', linkedPrUrls: [], linkedLinearKey: null };");
  assert.match(old.stdout, /^browser {2,}ephemeral$/m);
});
