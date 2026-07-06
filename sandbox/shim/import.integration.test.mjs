/**
 * End-to-end integration test for the shim's /import provisioning route.
 *
 * Boots the real compiled shim (dist/shim.js) with a temp workspace dir, then
 * plays the HOST's side for real: builds a source repo, stages the exact
 * payload src/main/sandbox-import.ts ships (git bundle --all + meta.json +
 * worktree/ overlay, tar-gzipped), POSTs it over plain HTTP to the same port
 * the WS server rides, and asserts:
 *
 *   1. GET /healthz reports provisioned:false before, true after
 *   2. POST /import provisions a checkout: right branch, origin repointed,
 *      overlay (untracked file + .orchestra hook dir) laid on top
 *   3. a second POST /import is refused with 409 (one container, one workspace)
 *   4. an unknown route 404s
 *
 * Run with: node sandbox/shim/import.integration.test.mjs   (needs `npm install`
 * + `npm run build` first). Exits 0 on success, non-zero with a message.
 */

import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIM = path.join(here, 'dist', 'shim.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-import-it-'));
const EVENTS_DIR = path.join(tmp, 'events');
const SOCK = path.join(tmp, 'hooks.sock');
const WORKSPACE = path.join(tmp, 'workspace');
const PORT = 8798;
fs.mkdirSync(EVENTS_DIR, { recursive: true });

const log = (...a) => console.log('[it]', ...a);
let shim;

function fail(msg, err) {
  console.error('FAIL:', msg, err ?? '');
  cleanup();
  process.exit(1);
}

function cleanup() {
  try { shim?.kill('SIGKILL'); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();
}

/** GET/POST helper returning {status, body(json)}. */
function request(method, route, filePath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: route, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    if (filePath) fs.createReadStream(filePath).pipe(req);
    else req.end();
  });
}

function waitFor(pred, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const tick = async () => {
      if (await pred()) return resolve();
      if (Number(process.hrtime.bigint() - start) / 1e6 > timeoutMs) {
        return reject(new Error(`timeout waiting for: ${label}`));
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

// ── build the host-side payload, exactly as sandbox-import.ts stages it ──────

function stagePayload() {
  const repo = path.join(tmp, 'source-repo');
  fs.mkdirSync(repo, { recursive: true });
  sh('git', ['init', '-b', 'main'], repo);
  fs.writeFileSync(path.join(repo, 'app.txt'), 'v1\n');
  sh('git', ['add', '.'], repo);
  sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'base'], repo);
  sh('git', ['branch', 'feat/import-it'], repo);

  const stage = path.join(tmp, 'stage');
  fs.mkdirSync(path.join(stage, 'worktree', '.orchestra'), { recursive: true });
  sh('git', ['bundle', 'create', path.join(stage, 'repo.bundle'), '--all'], repo);
  fs.writeFileSync(path.join(stage, 'worktree', 'notes.md'), 'uncommitted overlay\n');
  fs.writeFileSync(path.join(stage, 'worktree', '.orchestra', 'orchestra-hook.sh'), '#!/bin/sh\n');
  // The login/config seed the host packs (account creds + MCP + settings).
  fs.mkdirSync(path.join(stage, 'claude-config'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'claude-config', '.credentials.json'), '{"oauth":"it-secret"}');
  fs.writeFileSync(path.join(stage, 'claude-config', '.claude.json'), '{"mcpServers":{"it":{}}}');
  fs.writeFileSync(
    path.join(stage, 'meta.json'),
    JSON.stringify({
      session: 'ws-import-it',
      branch: 'feat/import-it',
      baseBranch: 'main',
      originUrl: 'https://example.com/source.git',
    }),
  );
  const tgz = path.join(tmp, 'payload.tgz');
  sh('tar', ['-czf', tgz, '-C', stage, 'meta.json', 'repo.bundle', 'worktree', 'claude-config']);
  return tgz;
}

// ── run ──────────────────────────────────────────────────────────────────────

async function main() {
  shim = spawn(process.execPath, [SHIM], {
    env: {
      ...process.env,
      ORCHESTRA_SHIM_PORT: String(PORT),
      ORCHESTRA_EVENTS_DIR: EVENTS_DIR,
      ORCHESTRA_SOCK: SOCK,
      ORCHESTRA_WORKSPACE_DIR: WORKSPACE,
      ORCHESTRA_CLAUDE_HOME: path.join(tmp, 'home'),
      ORCHESTRA_IMPORT_META: path.join(tmp, 'state', 'import-meta.json'),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  shim.on('exit', (code) => {
    if (code !== null && code !== 0) fail(`shim exited early with ${code}`);
  });

  await waitFor(
    () => request('GET', '/healthz').then(() => true, () => false),
    5000,
    'shim HTTP up',
  );

  // 1. healthz before: not provisioned
  let health = await request('GET', '/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.body.provisioned, false);
  log('✓ healthz reports unprovisioned before import');

  // 4. unknown route 404s (checked early, cheap)
  const notFound = await request('GET', '/nope');
  assert.equal(notFound.status, 404);
  log('✓ unknown route 404s');

  // 2. import provisions the checkout
  const tgz = stagePayload();
  const imp = await request('POST', '/import', tgz);
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.equal(imp.body.ok, true);
  assert.equal(imp.body.branch, 'feat/import-it');
  assert.match(imp.body.head, /^[0-9a-f]{40}$/);

  assert.equal(sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], WORKSPACE), 'feat/import-it');
  assert.equal(sh('git', ['remote', 'get-url', 'origin'], WORKSPACE), 'https://example.com/source.git');
  assert.equal(fs.readFileSync(path.join(WORKSPACE, 'app.txt'), 'utf8'), 'v1\n');
  assert.equal(fs.readFileSync(path.join(WORKSPACE, 'notes.md'), 'utf8'), 'uncommitted overlay\n');
  assert.ok(fs.existsSync(path.join(WORKSPACE, '.orchestra', 'orchestra-hook.sh')));
  log('✓ import provisioned checkout + overlay + origin');

  // Claude login/config seeded into the (overridden) home dir.
  const home = path.join(tmp, 'home');
  assert.equal(
    fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8'),
    '{"oauth":"it-secret"}',
  );
  assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), '{"mcpServers":{"it":{}}}');
  log('✓ claude-config seeded (~/.claude + ~/.claude.json)');

  health = await request('GET', '/healthz');
  assert.equal(health.body.provisioned, true);
  log('✓ healthz reports provisioned after import');

  // 3a. retry of the SAME workspace (lost-response case) replays success
  const retry = await request('POST', '/import', tgz, { 'x-orchestra-session': 'ws-import-it' });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.ok, true);
  assert.equal(retry.body.alreadyProvisioned, true);
  assert.equal(retry.body.head, imp.body.head);
  log('✓ same-workspace retry replays recorded success (idempotent)');

  // 3b. a RIVAL import (different/absent session) is refused
  const rival = await request('POST', '/import', tgz, { 'x-orchestra-session': 'ws-other' });
  assert.equal(rival.status, 409);
  const anonymous = await request('POST', '/import', tgz);
  assert.equal(anonymous.status, 409);
  log('✓ rival import refused with 409');

  log('ALL IMPORT INTEGRATION CHECKS PASSED');
  cleanup();
  process.exit(0);
}

main().catch((e) => fail('unexpected error', e));
