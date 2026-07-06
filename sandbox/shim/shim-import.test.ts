/**
 * Tests for the sandbox-side import (provisioning) flow. validateImportMeta is
 * pure; runImport is exercised for real against a throwaway git repo + bundle +
 * overlay tar in a temp dir — the same artifacts the host builds, minus the
 * HTTP hop (the handler around it is a thin stream-to-file shell).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateImportMeta, runImport, isProvisioned, readImportRecord } from './shim-import.ts';

// ─── validateImportMeta ──────────────────────────────────────────────────────

test('accepts a minimal valid meta', () => {
  assert.equal(validateImportMeta({ session: 'ws1', branch: 'main' }), null);
});

test('accepts optional originUrl and baseBranch', () => {
  assert.equal(
    validateImportMeta({
      session: 'ws1',
      branch: 'feat/x',
      baseBranch: 'main',
      originUrl: 'https://example.com/r.git',
    }),
    null,
  );
});

test('rejects non-objects and missing fields', () => {
  assert.match(validateImportMeta(null) ?? '', /not an object/);
  assert.match(validateImportMeta('x') ?? '', /not an object/);
  assert.match(validateImportMeta({ branch: 'main' }) ?? '', /session/);
  assert.match(validateImportMeta({ session: 'ws1' }) ?? '', /branch/);
  assert.match(validateImportMeta({ session: 'ws1', branch: '' }) ?? '', /branch/);
});

test('rejects a branch that looks like a git option', () => {
  assert.match(validateImportMeta({ session: 'ws1', branch: '--force' }) ?? '', /invalid/);
});

test('rejects wrongly-typed optionals', () => {
  assert.match(
    validateImportMeta({ session: 'ws1', branch: 'main', originUrl: 5 }) ?? '',
    /originUrl/,
  );
  assert.match(
    validateImportMeta({ session: 'ws1', branch: 'main', baseBranch: 5 }) ?? '',
    /baseBranch/,
  );
});

// ─── runImport (real git, temp dirs) ─────────────────────────────────────────

function sh(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();
}

/** Build a source repo with a feature branch, a bundle of it, and a payload
 *  tarball with an overlay file — the host-side artifacts, hand-rolled. */
function makePayload(root: string, opts?: { originUrl?: string }): string {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  sh('git', ['init', '-b', 'main'], repo);
  sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'base'], repo);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'committed\n');
  sh('git', ['add', '.'], repo);
  sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'add tracked'], repo);
  sh('git', ['branch', 'feature'], repo);

  const stage = path.join(root, 'stage');
  fs.mkdirSync(path.join(stage, 'worktree', '.orchestra'), { recursive: true });
  sh('git', ['bundle', 'create', path.join(stage, 'repo.bundle'), '--all'], repo);
  fs.writeFileSync(path.join(stage, 'worktree', 'untracked.txt'), 'overlay\n');
  fs.writeFileSync(path.join(stage, 'worktree', '.orchestra', 'hook.sh'), '#!/bin/sh\n');
  fs.writeFileSync(
    path.join(stage, 'meta.json'),
    JSON.stringify({ session: 'ws1', branch: 'feature', baseBranch: 'main', ...opts }),
  );

  const tgz = path.join(root, 'payload.tgz');
  sh('tar', ['-czf', tgz, '-C', stage, 'meta.json', 'repo.bundle', 'worktree']);
  return tgz;
}

test('runImport provisions a checkout with branch, overlay, and origin', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-import-test-'));
  try {
    const tgz = makePayload(root, { originUrl: 'https://example.com/repo.git' });
    const wsDir = path.join(root, 'workspace');
    assert.equal(isProvisioned(wsDir), false);

    const result = await runImport(tgz, wsDir);
    assert.equal(result.branch, 'feature');
    assert.match(result.head, /^[0-9a-f]{40}$/);

    assert.equal(isProvisioned(wsDir), true);
    assert.equal(sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], wsDir), 'feature');
    assert.equal(sh('git', ['remote', 'get-url', 'origin'], wsDir), 'https://example.com/repo.git');
    // Tracked content from the bundle, overlay content from the tar.
    assert.equal(fs.readFileSync(path.join(wsDir, 'tracked.txt'), 'utf8'), 'committed\n');
    assert.equal(fs.readFileSync(path.join(wsDir, 'untracked.txt'), 'utf8'), 'overlay\n');
    assert.ok(fs.existsSync(path.join(wsDir, '.orchestra', 'hook.sh')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runImport without originUrl drops the bundle-path origin', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-import-test-'));
  try {
    const tgz = makePayload(root);
    const wsDir = path.join(root, 'workspace');
    await runImport(tgz, wsDir);
    assert.throws(() => sh('git', ['remote', 'get-url', 'origin'], wsDir));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failed import leaves the workspace dir empty for retry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-import-test-'));
  try {
    // Payload whose meta names a branch the bundle doesn't have.
    const tgz = makePayload(root);
    const stage = path.join(root, 'stage');
    fs.writeFileSync(
      path.join(stage, 'meta.json'),
      JSON.stringify({ session: 'ws1', branch: 'no-such-branch' }),
    );
    sh('tar', ['-czf', tgz, '-C', stage, 'meta.json', 'repo.bundle', 'worktree']);

    const wsDir = path.join(root, 'workspace');
    await assert.rejects(runImport(tgz, wsDir));
    assert.equal(isProvisioned(wsDir), false);
    assert.deepEqual(fs.readdirSync(wsDir), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('claude-config is seeded into the home dir with clamped credentials', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-import-test-'));
  try {
    const tgz = makePayload(root);
    // Add a claude-config entry to the staged payload and re-tar.
    const stage = path.join(root, 'stage');
    const cfg = path.join(stage, 'claude-config');
    fs.mkdirSync(path.join(cfg, 'skills', 'my-skill'), { recursive: true });
    fs.writeFileSync(path.join(cfg, '.credentials.json'), '{"oauth":"secret"}');
    fs.writeFileSync(path.join(cfg, '.claude.json'), '{"mcpServers":{"linear":{}}}');
    fs.writeFileSync(path.join(cfg, 'settings.json'), '{"model":"opus"}');
    fs.writeFileSync(path.join(cfg, 'skills', 'my-skill', 'SKILL.md'), '# skill\n');
    sh('tar', ['-czf', tgz, '-C', stage, 'meta.json', 'repo.bundle', 'worktree', 'claude-config']);

    const home = path.join(root, 'home');
    await runImport(tgz, path.join(root, 'workspace'), { claudeHome: home });

    // Everything lands in ~/.claude; .claude.json ALSO at ~/.claude.json (the
    // default-location state file carrying user-scope MCP servers).
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), '{"model":"opus"}');
    assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), '{"mcpServers":{"linear":{}}}');
    assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'my-skill', 'SKILL.md')));
    const creds = path.join(home, '.claude', '.credentials.json');
    assert.equal(fs.readFileSync(creds, 'utf8'), '{"oauth":"secret"}');
    assert.equal(fs.statSync(creds).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a payload without claude-config leaves the home dir untouched', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-import-test-'));
  try {
    const tgz = makePayload(root);
    const home = path.join(root, 'home');
    await runImport(tgz, path.join(root, 'workspace'), { claudeHome: home });
    assert.equal(fs.existsSync(path.join(home, '.claude')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a successful import persists the record for idempotent retries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-import-test-'));
  try {
    const tgz = makePayload(root);
    const metaPath = path.join(root, 'state', 'import-meta.json');
    assert.equal(readImportRecord(metaPath), null);

    const result = await runImport(tgz, path.join(root, 'workspace'), { metaPath });
    const record = readImportRecord(metaPath);
    assert.deepEqual(record, { session: 'ws1', branch: 'feature', head: result.head });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a payload missing the bundle is rejected with a clear error', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-import-test-'));
  try {
    const stage = path.join(root, 'stage');
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, 'meta.json'), JSON.stringify({ session: 'w', branch: 'b' }));
    const tgz = path.join(root, 'payload.tgz');
    sh('tar', ['-czf', tgz, '-C', stage, 'meta.json']);
    await assert.rejects(runImport(tgz, path.join(root, 'workspace')), /repo\.bundle/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
