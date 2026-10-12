// Accès mobile (#336): the pairing token file, driven for real — no Electron needed (acces-mobile-token.ts is plain Node). The last test
// is the « Regenerate token » contract end to end: the REAL server, reading the REAL file, refuses the old token at once.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createAccesMobileServer } from '../acces-mobile/server.ts';
import { readTokenIn, tokenFileIn, writeFreshTokenIn } from './acces-mobile-token.ts';

function scratchDir(): string {
  return fs.mkdtempSync(path.join(process.env.E2E_RIG_BASE ?? os.tmpdir(), 'am-token-'));
}
const mode = (p: string) => fs.statSync(p).mode & 0o777;

test('a fresh token is 256 bits of base64url, 0600 in a 0700 dir, and no temp file is left', () => {
  const dir = path.join(scratchDir(), 'acces-mobile');
  try {
    assert.equal(readTokenIn(dir), null, 'control: nothing before the first write');
    const t = writeFreshTokenIn(dir);
    assert.match(t, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(readTokenIn(dir), t);
    assert.equal(mode(tokenFileIn(dir)), 0o600);
    assert.equal(mode(dir), 0o700);
    assert.deepEqual(fs.readdirSync(dir), ['token'], 'the atomic tmp file was renamed away');
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('a pre-existing wide dir is closed to 0700 when the token is written', () => {
  const root = scratchDir();
  const dir = path.join(root, 'acces-mobile');
  try {
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    assert.equal(mode(dir), 0o755, 'control: the dir starts world-readable');
    writeFreshTokenIn(dir);
    assert.equal(mode(dir), 0o700);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('regenerating gives a DIFFERENT token and the file keeps only the new one', () => {
  const root = scratchDir();
  const dir = path.join(root, 'acces-mobile');
  try {
    const a = writeFreshTokenIn(dir);
    const b = writeFreshTokenIn(dir);
    assert.notEqual(a, b);
    assert.equal(readTokenIn(dir), b);
    assert.ok(!fs.readFileSync(tokenFileIn(dir), 'utf8').includes(a), 'the old token is nowhere in the file');
    assert.equal(mode(tokenFileIn(dir)), 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function get(port: number, auth: string | null): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Tailscale-User-Login': 'me@example.invalid' };
    if (auth) headers.Authorization = `Bearer ${auth}`;
    const req = http.request({ host: '127.0.0.1', port, path: '/api/workspaces', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

test('must-FAIL: after a regeneration the old token is refused at once; the new one is accepted (real server, real file)', async () => {
  const root = scratchDir();
  const dir = path.join(root, 'acces-mobile');
  const server = createAccesMobileServer({
    allowedLogin: 'me@example.invalid',
    readToken: () => readTokenIn(dir) ?? '',
    upstream: async () => ({ ok: true, workspaces: [] }),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const old = writeFreshTokenIn(dir);
    assert.equal(await get(port, old), 200, 'control: the first token works');
    assert.equal(await get(port, null), 401, 'control: no token is refused');
    const fresh = writeFreshTokenIn(dir);
    assert.equal(await get(port, old), 401, 'the OLD token is refused at once');
    assert.equal(await get(port, fresh), 200, 'the NEW token is accepted');
  } finally {
    await new Promise((r) => server.close(() => r(null)));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
