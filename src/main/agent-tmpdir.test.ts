import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The real module against a scratch base (ORCHESTRA_AGENT_TMP_BASE) instead of /var/tmp. Short on purpose:
// the module refuses a dir longer than AGENT_TMPDIR_MAX_LEN, and os.tmpdir() can be long.
const scratch = fs.mkdtempSync(path.join(fs.existsSync('/var/tmp') ? '/var/tmp' : os.tmpdir(), 'oat-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const base = path.join(scratch, 'b');
process.env.ORCHESTRA_AGENT_TMP_BASE = base;
process.env.ORCHESTRA_HOME = path.join(scratch, 'home');
const { applyAgentTmpEnv, ensureAgentTmpDir, removeAgentTmpDir, sweepAgentTmpDirs } = await import('./agent-tmpdir.ts');
const { agentTmpRoot } = await import('../shared/agent-tmpdir.ts');
const root = agentTmpRoot(process.getuid!(), process.env.ORCHESTRA_HOME, base);
const WS = '0524718f-ac2a-4367-b746-51e57309f371';

beforeEach(() => fs.rmSync(base, { recursive: true, force: true }));
const mode = (p: string) => fs.statSync(p).mode & 0o777;

test('creates a private root and a private per-workspace dir', () => {
  fs.mkdirSync(base);
  const dir = ensureAgentTmpDir(WS);
  assert.equal(dir, path.join(root, '0524718fac2a'));
  assert.equal(mode(root), 0o700);
  assert.equal(mode(dir!), 0o700);
});

test('sets TMPDIR + the marker, and drops a stale inherited marker when unavailable', () => {
  fs.mkdirSync(base);
  const env: Record<string, string> = { TMPDIR: '/tmp', ORCHESTRA_AGENT_TMPDIR: '/var/tmp/orch-x/parent' };
  applyAgentTmpEnv(env, WS);
  assert.equal(env.TMPDIR, path.join(root, '0524718fac2a'));
  assert.equal(env.ORCHESTRA_AGENT_TMPDIR, env.TMPDIR);

  fs.rmSync(base, { recursive: true, force: true }); // base missing ⇒ cannot create the root
  const env2: Record<string, string> = { TMPDIR: '/tmp', ORCHESTRA_AGENT_TMPDIR: '/var/tmp/orch-x/parent' };
  applyAgentTmpEnv(env2, WS);
  assert.equal(env2.TMPDIR, '/tmp');
  assert.equal(env2.ORCHESTRA_AGENT_TMPDIR, undefined);
});

test('refuses a root that is a symlink (pre-planted in the world-writable base)', () => {
  fs.mkdirSync(base);
  const elsewhere = path.join(scratch, 'attacker');
  fs.mkdirSync(elsewhere, { recursive: true, mode: 0o700 });
  fs.symlinkSync(elsewhere, root);
  assert.equal(ensureAgentTmpDir(WS), null);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('refuses a root other users can enter', () => {
  fs.mkdirSync(root, { recursive: true });
  fs.chmodSync(root, 0o755);
  assert.equal(ensureAgentTmpDir(WS), null);
});

test('remove deletes the workspace dir and nothing else', () => {
  fs.mkdirSync(base);
  const a = ensureAgentTmpDir(WS)!;
  const b = ensureAgentTmpDir('ffffffff-0000-0000-0000-000000000000')!;
  fs.writeFileSync(path.join(a, 'big.bin'), 'x');
  removeAgentTmpDir(WS);
  assert.equal(fs.existsSync(a), false);
  assert.equal(fs.existsSync(b), true);
  removeAgentTmpDir('ffffffff-0000-0000-0000-000000000000');
  assert.equal(fs.existsSync(root), false, 'the last removal takes the empty root too');
});

test('under node --test with no explicit base the feature is off (no root per scratch home)', () => {
  delete process.env.ORCHESTRA_AGENT_TMP_BASE;
  try {
    assert.ok(process.env.NODE_TEST_CONTEXT, 'this file runs under node --test');
    const env: Record<string, string> = { TMPDIR: '/tmp' };
    applyAgentTmpEnv(env, WS);
    assert.equal(env.TMPDIR, '/tmp');
  } finally {
    process.env.ORCHESTRA_AGENT_TMP_BASE = base;
  }
});

test('boot sweep removes dirs of unknown workspaces only; an empty store removes nothing', () => {
  fs.mkdirSync(base);
  const a = ensureAgentTmpDir(WS)!;
  const dead = ensureAgentTmpDir('deadbeef-0000-0000-0000-000000000000')!;
  sweepAgentTmpDirs([]);
  assert.equal(fs.existsSync(dead), true);
  sweepAgentTmpDirs([WS]);
  assert.equal(fs.existsSync(a), true);
  assert.equal(fs.existsSync(dead), false);
});

test('a dir too long for Chromium\'s socket is refused and TMPDIR is left alone', () => {
  const long = path.join(scratch, 'x'.repeat(40));
  fs.mkdirSync(long, { recursive: true });
  process.env.ORCHESTRA_AGENT_TMP_BASE = long;
  try {
    const env: Record<string, string> = { TMPDIR: '/tmp' };
    applyAgentTmpEnv(env, WS);
    assert.equal(env.TMPDIR, '/tmp');
    assert.equal(env.ORCHESTRA_AGENT_TMPDIR, undefined);
  } finally {
    process.env.ORCHESTRA_AGENT_TMP_BASE = base;
  }
});
