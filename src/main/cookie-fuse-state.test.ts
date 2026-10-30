import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readOwnCookieFuse, resetCookieFuseCache, scanForCookieFuse } from './cookie-fuse-state.ts';

const { SENTINEL } = createRequire(import.meta.url)('../../scripts/lib/fuse-wire.cjs') as { SENTINEL: string };
const wire = (states: string) => Buffer.concat([Buffer.from(SENTINEL, 'latin1'), Buffer.from([1, states.length]), Buffer.from(states, 'latin1')]);
async function* chunked(buf: Buffer, size: number) { for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size); }
const junk = (n: number) => Buffer.alloc(n, 0x41);

test('finds the wire wherever it sits and however the stream is chunked — including a sentinel or a state byte straddling a chunk boundary', async () => {
  const off = Buffer.concat([junk(1000), wire('10110001'), junk(500)]);
  const on = Buffer.concat([junk(1000), wire('11110001'), junk(500)]);
  for (const size of [1, 7, 33, 64, 1000, 5000]) {
    assert.equal(await scanForCookieFuse(chunked(off, size)), 'disabled', `off, chunk ${size}`);
    assert.equal(await scanForCookieFuse(chunked(on, size)), 'enabled', `on, chunk ${size}`);
  }
});

test('no wire, a truncated wire, or a removed fuse → unknown (the warning treats it as OFF)', async () => {
  assert.equal(await scanForCookieFuse(chunked(junk(5000), 100)), 'unknown');
  assert.equal(await scanForCookieFuse(chunked(Buffer.concat([junk(10), wire('10110001').subarray(0, 40)]), 9)), 'unknown');
  assert.equal(await scanForCookieFuse(chunked(Buffer.concat([junk(10), wire('1r110001')]), 9)), 'unknown');
});

test('readOwnCookieFuse reads a real file, once (cached), and a missing file is unknown', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'cfs-'));
  try {
    const f = path.join(dir, 'bin');
    fs.writeFileSync(f, Buffer.concat([junk(3_000_000), wire('11110001'), junk(100)]));
    resetCookieFuseCache();
    assert.equal(await readOwnCookieFuse(f), 'enabled');
    fs.writeFileSync(f, Buffer.concat([junk(10), wire('10110001')]));
    assert.equal(await readOwnCookieFuse(f), 'enabled', 'cached for the life of the process');
    resetCookieFuseCache();
    assert.equal(await readOwnCookieFuse(path.join(dir, 'missing')), 'unknown');
  } finally { resetCookieFuseCache(); fs.rmSync(dir, { recursive: true, force: true }); }
});
