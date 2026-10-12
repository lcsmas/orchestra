import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decideAppUpdate, parseVersionSidecar, relaunchArgv, appUpdateTitle, identityKey } from './app-update.ts';

const A = { ino: 10, size: 1000, mtimeMs: 1 };
const B = { ino: 11, size: 2000, mtimeMs: 2 };

test('decide: the same file ⇒ nothing; a replaced file ⇒ « installed », with the version only from a sidecar describing THAT file', () => {
  assert.deepEqual(decideAppUpdate(A, { ...A }, null), { kind: 'none' });
  assert.deepEqual(decideAppUpdate(A, B, null), { kind: 'installed', version: null, key: identityKey(B) });
  assert.deepEqual(decideAppUpdate(A, B, '0.5.331 11 2000\n'), { kind: 'installed', version: '0.5.331', key: identityKey(B) });
  assert.equal((decideAppUpdate(A, B, '0.5.331 10 1000') as { version: string | null }).version, null, 'a sidecar of the OLD file gives no number');
  assert.deepEqual(decideAppUpdate(A, { ...A, mtimeMs: 5 }, null).kind, 'installed', 'rewritten in place (same inode) still counts');
  assert.deepEqual(decideAppUpdate(A, null, null), { kind: 'none' }, 'missing (mid-swap)');
  assert.deepEqual(decideAppUpdate(null, B, null), { kind: 'none' }, 'not launched from an installed file');
});

test('sidecar parsing: `<version> <inode> <size>` only', () => {
  assert.equal(parseVersionSidecar('0.5.331 11 2000', B), '0.5.331');
  assert.equal(parseVersionSidecar('1.2.3-beta.1 11 2000', B), '1.2.3-beta.1');
  for (const bad of ['', 'v0.5.331 11 2000', '0.5.331 11', '0.5.331 11 2000 x', '<b>0.5.331</b> 11 2000', '0.5 11 2000']) assert.equal(parseVersionSidecar(bad, B), null, bad);
  assert.equal(parseVersionSidecar(null, B), null);
});

test('words', () => {
  assert.equal(appUpdateTitle({ kind: 'installed', version: '0.5.331', key: 'k' }), 'Nouvelle version installée (v0.5.331)');
  assert.equal(appUpdateTitle({ kind: 'installed', version: null, key: 'k' }), 'Nouvelle version installée');
  assert.equal(appUpdateTitle({ kind: 'none' }), '');
});

test('release.sh writes a sidecar this parser accepts for the installed file (the exact line, run as release.sh runs it)', () => {
  const line = fs.readFileSync(path.join(import.meta.dirname, '../../scripts/release.sh'), 'utf8').split('\n').find((l) => l.includes("'$INSTALL_PATH.version.tmp'"));
  assert.ok(line, 'control: the sidecar line exists');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-'));
  try {
    const target = path.join(d, 'Orchestra.AppImage');
    fs.writeFileSync(`${target}.tmp`, 'new binary bytes');
    const script = `run() { eval "$*"; }\n${line.trim()}\nmv -f '${target}.tmp' '${target}'\n`;
    execFileSync('bash', ['-c', script], { env: { PATH: process.env.PATH, INSTALL_PATH: target, NEW: '0.5.999' } });
    const st = fs.statSync(target);
    assert.equal(parseVersionSidecar(fs.readFileSync(`${target}.version`, 'utf8'), { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs }), '0.5.999');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('relaunch script: waits until the quitting app is GONE, then execs the installed app (real processes)', { timeout: 20_000 }, async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'relaunch-'));
  try {
    const old = spawn('sleep', ['1.2'], { stdio: 'ignore' });
    const record = path.join(d, 'record');
    const target = path.join(d, 'installed-app');
    fs.writeFileSync(target, `#!/bin/sh\nif kill -0 ${old.pid} 2>/dev/null; then echo "old-alive $*" > '${record}'; else echo "old-gone $*" > '${record}'; fi\n`, { mode: 0o755 });
    const t0 = Date.now();
    const sh = spawn('/bin/sh', relaunchArgv(old.pid!, target), { stdio: 'ignore' });
    await new Promise((r) => sh.on('exit', r));
    const waited = Date.now() - t0;
    assert.equal(fs.readFileSync(record, 'utf8').trim(), 'old-gone', 'the app started only after the old one exited, with no argument');
    assert.ok(waited >= 1000, `it waited (${waited} ms)`);
    // control: with the old pid already gone it starts at once
    const t1 = Date.now();
    const sh2 = spawn('/bin/sh', relaunchArgv(old.pid!, target), { stdio: 'ignore' });
    await new Promise((r) => sh2.on('exit', r));
    assert.ok(Date.now() - t1 < 800, 'no wait when the old app is gone');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
