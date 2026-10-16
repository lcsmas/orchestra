// #379 / ADR 0008 — the HOST half: the session-key registry (hash at rest, 0600, atomic, superseding) and the
// `/identity` service (current run + generation, only for the live session's key). Real fs in a scratch dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSessionKeyRegistry,
  hashSessionKey,
  mintSessionKey,
  resolveSessionIdentity,
  type RegistryFs,
} from './session-identity.ts';

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-379-reg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'nested', 'session-keys.json');
}

test('mintSessionKey: 256-bit hex, never repeats', () => {
  const a = mintSessionKey();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, mintSessionKey());
});

test('register → verify ok; a NEW key for the same workspace supersedes the old one (the #128 fence)', (t) => {
  const reg = createSessionKeyRegistry(scratch(t));
  const k1 = mintSessionKey();
  const k2 = mintSessionKey();
  reg.register('ws-1', k1);
  assert.equal(reg.verify('ws-1', k1), 'ok');
  reg.register('ws-1', k2);
  assert.equal(reg.verify('ws-1', k2), 'ok');
  assert.equal(reg.verify('ws-1', k1), 'superseded', 'the replaced session\'s key stops matching');
  assert.equal(reg.verify('ws-1', ''), 'superseded');
  assert.equal(reg.verify('ws-1', 'x'.repeat(10_000)), 'superseded');
});

test('a key never opens ANOTHER workspace: it is superseded where an entry exists, unregistered where none does', (t) => {
  const reg = createSessionKeyRegistry(scratch(t));
  const k1 = mintSessionKey();
  reg.register('ws-1', k1);
  reg.register('ws-2', mintSessionKey());
  assert.equal(reg.verify('ws-2', k1), 'superseded');
  assert.equal(reg.verify('ws-3', k1), 'unregistered');
  assert.equal(reg.has('ws-1'), true);
  assert.equal(reg.has('ws-3'), false);
});

test('at rest: only the SHA-256, never the key; the file is 0600; a restart (new registry on the same file) still vouches for the live key', (t) => {
  const file = scratch(t);
  const k = mintSessionKey();
  createSessionKeyRegistry(file).register('ws-1', k);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes(k), 'the key itself is never written');
  assert.ok(text.includes(hashSessionKey(k)), 'its hash is');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['session-keys.json'], 'no tmp file is left behind');
  const reloaded = createSessionKeyRegistry(file);
  assert.equal(reloaded.verify('ws-1', k), 'ok', 'a keeper-surviving CLI keeps its identity across an app restart');
  assert.equal(reloaded.verify('ws-1', mintSessionKey()), 'superseded');
});

test('forget drops the entry (and persists it); has() follows', (t) => {
  const file = scratch(t);
  const reg = createSessionKeyRegistry(file);
  const k = mintSessionKey();
  reg.register('ws-1', k);
  reg.forget('ws-1');
  assert.equal(reg.has('ws-1'), false);
  assert.equal(reg.verify('ws-1', k), 'unregistered');
  assert.equal(createSessionKeyRegistry(file).has('ws-1'), false);
  reg.forget('never-there'); // no throw
});

test('a failed write throws and changes NOTHING (the previous live key still vouches)', (t) => {
  const file = scratch(t);
  let failing = false;
  const flaky: RegistryFs = {
    ...fs,
    writeFileSync: (f, d, o) => {
      if (failing) throw new Error('ENOSPC');
      fs.writeFileSync(f, d, o);
    },
  };
  const reg = createSessionKeyRegistry(file, { fs: flaky });
  const k1 = mintSessionKey();
  reg.register('ws-1', k1);
  failing = true;
  assert.throws(() => reg.register('ws-1', mintSessionKey()), /ENOSPC/);
  assert.equal(reg.verify('ws-1', k1), 'ok', 'the failed registration did not supersede the live key');
});

test('a missing / corrupt / foreign file loads EMPTY (every keyed CLI then falls back) — and says so for the corrupt ones', (t) => {
  const warns: string[] = [];
  const warn = (m: string): void => void warns.push(m);
  const file = scratch(t);
  assert.equal(createSessionKeyRegistry(file, { warn }).has('ws-1'), false);
  assert.deepEqual(warns, [], 'a missing file is normal (first run) — no warning');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  assert.equal(createSessionKeyRegistry(file, { warn }).has('ws-1'), false);
  fs.writeFileSync(file, JSON.stringify({ version: 2, sessions: {} }));
  assert.equal(createSessionKeyRegistry(file, { warn }).has('ws-1'), false);
  assert.equal(warns.length, 2);
  fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: { a: { hash: 'nothex', issuedAt: 1 }, b: { hash: hashSessionKey('k'), issuedAt: 1 } } }));
  const partial = createSessionKeyRegistry(file, { warn });
  assert.equal(partial.has('a'), false, 'a malformed hash entry is dropped');
  assert.equal(partial.verify('b', 'k'), 'ok');
});

// ── the service ──────────────────────────────────────────────────────────────

function service(t: { after: (fn: () => void) => void }) {
  const reg = createSessionKeyRegistry(scratch(t));
  const runs = new Map<string, string>([['ws-1', 'run-NEW']]);
  const gens = new Map<string, number>([['run-NEW', 2]]);
  const deps = {
    registry: reg,
    runIdFor: (id: string) => runs.get(id) ?? null,
    generationOf: (r: string) => gens.get(r) ?? 0,
  };
  return { reg, runs, gens, deps };
}

test('service: the live key gets the workspace\'s CURRENT run + generation — read per call, so a re-anchor shows at once', (t) => {
  const { reg, runs, gens, deps } = service(t);
  const k = mintSessionKey();
  reg.register('ws-1', k);
  assert.deepEqual(resolveSessionIdentity({ id: 'ws-1', key: k }, deps), { ok: true, runId: 'run-NEW', generation: 2 });
  runs.set('ws-1', 'run-OWN'); // a promotion
  gens.set('run-OWN', 0);
  assert.deepEqual(resolveSessionIdentity({ id: 'ws-1', key: k }, deps), { ok: true, runId: 'run-OWN', generation: null });
});

test('service: a replaced session is REFUSED (superseded) after a restart; the new key is answered', (t) => {
  const { reg, deps } = service(t);
  const old = mintSessionKey();
  const fresh = mintSessionKey();
  reg.register('ws-1', old);
  reg.register('ws-1', fresh);
  const refused = resolveSessionIdentity({ id: 'ws-1', key: old }, deps);
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.code, 'superseded');
  assert.equal(resolveSessionIdentity({ id: 'ws-1', key: fresh }, deps).ok, true);
});

test('service: no entry / unknown workspace / missing fields → unregistered (the CLI falls back); nothing leaks the key or the hash', (t) => {
  const { reg, deps } = service(t);
  const k = mintSessionKey();
  const replies = [
    resolveSessionIdentity({ id: 'ws-1', key: k }, deps), // no entry yet
    resolveSessionIdentity({ id: '', key: k }, deps),
    resolveSessionIdentity({ id: 'ws-1' }, deps),
    resolveSessionIdentity({ key: k }, deps),
    resolveSessionIdentity({ id: 42, key: k }, deps),
  ];
  for (const r of replies) assert.equal(r.ok === false && r.code, 'unregistered');
  reg.register('ghost', k); // an entry for a workspace that is gone from the store
  assert.equal(resolveSessionIdentity({ id: 'ghost', key: k }, deps).ok, false);
  reg.register('ws-1', k);
  const all = JSON.stringify([...replies, resolveSessionIdentity({ id: 'ws-1', key: mintSessionKey() }, deps), resolveSessionIdentity({ id: 'ws-1', key: k }, deps)]);
  assert.ok(!all.includes(k), 'no reply carries the key');
  assert.ok(!all.includes(hashSessionKey(k)), 'nor its hash');
});

test('MINOR-4 service: a generation read that FAILS cannot vouch (unregistered → the CLI keeps its baked generation) — never an unfenced answer', (t) => {
  const { reg, deps } = service(t);
  const k = mintSessionKey();
  reg.register('ws-1', k);
  const r = resolveSessionIdentity({ id: 'ws-1', key: k }, { ...deps, generationOf: () => { throw new Error('bus down'); } });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'unregistered');
  assert.ok(!JSON.stringify(r).includes(k));
});

test('MINOR-2 the registry reads OWN properties only: `constructor` / `__proto__` / `toString` are not workspaces', (t) => {
  const reg = createSessionKeyRegistry(scratch(t));
  const k = mintSessionKey();
  reg.register('ws-1', k);
  for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(reg.has(id), false, id);
    assert.equal(reg.verify(id, k), 'unregistered', id); // master of the bug: verify('constructor', k) threw a TypeError
    reg.forget(id); // no throw, no effect
  }
  assert.equal(reg.verify('ws-1', k), 'ok');
  const { deps } = service(t);
  const r = resolveSessionIdentity({ id: 'constructor', key: k }, { ...deps, registry: reg });
  assert.equal(r.ok === false && r.code, 'unregistered');
});
