/**
 * FULL-LOOP integration test: the life of a workspace through the sandbox.
 *
 *   1. a "host" worktree with every file class: committed, modified-uncommitted,
 *      untracked, GITIGNORED (.env — never ships, must survive via trash),
 *      hook dirs
 *   2. import into a real shim (dist/shim.js)         [host → sandbox]
 *   3. "agent work" inside the container workspace: a new commit, a new
 *      uncommitted modification, a new untracked file
 *   4. GET /export                                    [sandbox → host]
 *   5. restore exactly as eject does: force-fetch the bundle branch into the
 *      host repo, recreate a worktree, lay the overlay on top
 *   6. assert file-level fidelity of every class, including that the ignored
 *      .env still exists in the (simulated) trashed original worktree
 *
 * This proves the payload grammar round-trips with zero loss for everything
 * git+overlay carries, and that the loss boundary (ignored files) is exactly
 * covered by the trash-retire fail-safe.
 *
 * Run with: node sandbox/shim/roundtrip.integration.test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-loop-it-'));
const WORKSPACE = path.join(tmp, 'container-workspace');
const PORT = 8796;

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
function git(cwd, args) {
  return sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], cwd);
}

function post(route, filePath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, method: 'POST', path: route, headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      },
    );
    req.on('error', reject);
    fs.createReadStream(filePath).pipe(req);
  });
}
function getToFile(route, dest) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path: route }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`GET ${route} → ${res.statusCode}`));
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}
function waitFor(pred, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const tick = async () => {
      if (await pred()) return resolve();
      if (Number(process.hrtime.bigint() - start) / 1e6 > timeoutMs) {
        return reject(new Error(`timeout: ${label}`));
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function main() {
  // ── 1. the "host" worktree, one file of every class ────────────────────────
  const repo = path.join(tmp, 'host-repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n.orchestra/\n');
  fs.writeFileSync(path.join(repo, 'committed.txt'), 'committed-v1\n');
  fs.writeFileSync(path.join(repo, 'modified.txt'), 'modified-v1\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'base']);
  git(repo, ['checkout', '-b', 'feature']);
  fs.writeFileSync(path.join(repo, 'modified.txt'), 'modified-v2-UNCOMMITTED\n'); // dirty
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked-host\n'); // untracked
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=host-only\n'); // ignored — never ships
  fs.mkdirSync(path.join(repo, '.orchestra'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.orchestra', 'hook.sh'), '#!/bin/sh\n'); // ignored hook dir — ships

  // ── 2. stage + import exactly as the host does ─────────────────────────────
  const stage = path.join(tmp, 'stage');
  fs.mkdirSync(path.join(stage, 'worktree', '.orchestra'), { recursive: true });
  git(repo, ['bundle', 'create', path.join(stage, 'repo.bundle'), '--all']);
  // overlay = untracked (not ignored) + modified + hook dirs
  fs.copyFileSync(path.join(repo, 'modified.txt'), path.join(stage, 'worktree', 'modified.txt'));
  fs.copyFileSync(path.join(repo, 'untracked.txt'), path.join(stage, 'worktree', 'untracked.txt'));
  fs.copyFileSync(path.join(repo, '.orchestra', 'hook.sh'), path.join(stage, 'worktree', '.orchestra', 'hook.sh'));
  fs.writeFileSync(path.join(stage, 'meta.json'), JSON.stringify({ session: 'ws-loop', branch: 'feature' }));
  const payload = path.join(tmp, 'payload.tgz');
  sh('tar', ['-czf', payload, '-C', stage, 'meta.json', 'repo.bundle', 'worktree']);

  shim = spawn(process.execPath, [SHIM], {
    env: {
      ...process.env,
      ORCHESTRA_SHIM_PORT: String(PORT),
      ORCHESTRA_EVENTS_DIR: path.join(tmp, 'events'),
      ORCHESTRA_SOCK: path.join(tmp, 'hooks.sock'),
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
    () => new Promise((r) => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/healthz' }, () => r(true)).on('error', () => r(false));
    }),
    5000,
    'shim up',
  );

  const imp = await post('/import', payload, { 'x-orchestra-session': 'ws-loop' });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.equal(fs.readFileSync(path.join(WORKSPACE, 'modified.txt'), 'utf8'), 'modified-v2-UNCOMMITTED\n');
  assert.equal(fs.existsSync(path.join(WORKSPACE, '.env')), false, 'ignored files must NOT ship');
  log('✓ import: committed + dirty + untracked + hooks arrived; ignored stayed home');

  // Simulate the trash-retire: the original worktree dir keeps living (with
  // its .env) exactly like ~/.orchestra/trash/<name>-<ts> does.
  const trash = path.join(tmp, 'trash', 'host-repo-retired');
  fs.mkdirSync(path.dirname(trash), { recursive: true });
  fs.cpSync(repo, trash, { recursive: true });

  // ── 3. "agent work" inside the container workspace ─────────────────────────
  fs.writeFileSync(path.join(WORKSPACE, 'agent-new.txt'), 'built-in-sandbox\n');
  git(WORKSPACE, ['add', 'agent-new.txt']);
  git(WORKSPACE, ['commit', '-m', 'agent work']);
  fs.appendFileSync(path.join(WORKSPACE, 'modified.txt'), 'agent-dirty-line\n'); // uncommitted
  fs.writeFileSync(path.join(WORKSPACE, 'agent-untracked.txt'), 'agent-scratch\n'); // untracked
  const containerHead = git(WORKSPACE, ['rev-parse', 'HEAD']);
  log('✓ agent work simulated (commit + dirty + untracked)');

  // ── 4. export ───────────────────────────────────────────────────────────────
  const exportTgz = path.join(tmp, 'export.tgz');
  await getToFile('/export', exportTgz);
  const exp = path.join(tmp, 'export-extract');
  fs.mkdirSync(exp, { recursive: true });
  sh('tar', ['-xzf', exportTgz, '-C', exp]);
  const meta = JSON.parse(fs.readFileSync(path.join(exp, 'meta.json'), 'utf8'));
  assert.equal(meta.branch, 'feature');
  assert.equal(meta.head, containerHead);
  assert.equal(meta.session, 'ws-loop');
  log('✓ export meta names the right branch/head/session');

  // ── 5. restore exactly as eject does ───────────────────────────────────────
  git(repo, ['checkout', 'main']); // free the feature branch (host worktree was "retired")
  git(repo, ['fetch', path.join(exp, 'repo.bundle'), '+feature:feature']);
  const restored = path.join(tmp, 'restored');
  git(repo, ['worktree', 'add', restored, 'feature']);
  sh('cp', ['-a', `${path.join(exp, 'worktree')}/.`, `${restored}/`]);

  // ── 6. fidelity assertions, every file class ───────────────────────────────
  assert.equal(git(restored, ['rev-parse', 'HEAD']), containerHead, 'container commit restored');
  assert.equal(fs.readFileSync(path.join(restored, 'agent-new.txt'), 'utf8'), 'built-in-sandbox\n');
  assert.equal(
    fs.readFileSync(path.join(restored, 'modified.txt'), 'utf8'),
    'modified-v2-UNCOMMITTED\nagent-dirty-line\n',
    'uncommitted edits from BOTH sides survive',
  );
  assert.equal(fs.readFileSync(path.join(restored, 'untracked.txt'), 'utf8'), 'untracked-host\n');
  assert.equal(fs.readFileSync(path.join(restored, 'agent-untracked.txt'), 'utf8'), 'agent-scratch\n');
  assert.ok(fs.existsSync(path.join(restored, '.orchestra', 'hook.sh')), 'hooks restored');
  assert.equal(
    fs.readFileSync(path.join(trash, '.env'), 'utf8'),
    'SECRET=host-only\n',
    'ignored file recoverable from trash',
  );
  log('✓ full-loop fidelity: committed, dirty, untracked, hooks, trash-recovery all intact');

  log('ALL ROUND-TRIP INTEGRATION CHECKS PASSED');
  cleanup();
  process.exit(0);
}

main().catch((e) => fail('unexpected error', e));
