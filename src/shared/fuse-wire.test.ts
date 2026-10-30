import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { SENTINEL, V1_NAMES, parseFuseWire, cookieFuseOffset, expectCookieFuse } = require('../../scripts/lib/fuse-wire.cjs') as {
  SENTINEL: string;
  V1_NAMES: string[];
  parseFuseWire: (b: Buffer) => { ok: boolean; reason?: string; version?: number; offset?: number; fuses?: Record<string, string> };
  cookieFuseOffset: (b: Buffer) => number;
  expectCookieFuse: (w: unknown, shipped: boolean) => { ok: boolean; message: string };
};

/** A fake "binary": junk, the sentinel, version, length, the state bytes, junk. */
function binary(states: string, { version = 1, lengthByte = states.length, sentinels = 1 }: { version?: number; lengthByte?: number; sentinels?: number } = {}): Buffer {
  const parts: Buffer[] = [Buffer.from('ELF-junk-before-')];
  for (let i = 0; i < sentinels; i++) parts.push(Buffer.from(SENTINEL, 'latin1'), Buffer.from([version, lengthByte]), Buffer.from(states, 'latin1'), Buffer.from('-junk-between-'));
  return Buffer.concat(parts);
}
// stock Electron 33.4.11 as measured on the packaged build: RunAsNode on, cookie encryption OFF, node-options on, cli-inspect on, asar integrity off, only-asar off, v8 snapshot off, file-protocol on
const STOCK_STATES = '10110001';

test('stock wire: EnableCookieEncryption disabled, the others as measured', () => {
  const w = parseFuseWire(binary(STOCK_STATES));
  assert.equal(w.ok, true);
  assert.equal(w.fuses!.EnableCookieEncryption, 'disabled');
  assert.equal(w.fuses!.RunAsNode, 'enabled');
  assert.equal(w.fuses!.EnableNodeCliInspectArguments, 'enabled');
  assert.equal(w.fuses!.EnableEmbeddedAsarIntegrityValidation, 'disabled');
  assert.equal(Object.keys(w.fuses!).length, V1_NAMES.length);
});

test('flipped wire: EnableCookieEncryption enabled, nothing else moves', () => {
  const on = STOCK_STATES.slice(0, 1) + '1' + STOCK_STATES.slice(2);
  const a = parseFuseWire(binary(STOCK_STATES));
  const b = parseFuseWire(binary(on));
  assert.equal(b.fuses!.EnableCookieEncryption, 'enabled');
  for (const n of V1_NAMES) if (n !== 'EnableCookieEncryption') assert.equal(b.fuses![n], a.fuses![n], n);
});

test('cookieFuseOffset points at exactly the state byte that differs between the two builds', () => {
  const off = binary(STOCK_STATES);
  const on = binary(STOCK_STATES.slice(0, 1) + '1' + STOCK_STATES.slice(2));
  const at = cookieFuseOffset(off);
  assert.ok(at > 0);
  assert.equal(off[at], 0x30);
  assert.equal(on[at], 0x31);
  const diff = [...off].map((v, i) => (v !== on[i] ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(diff, [at]);
});

test('removed fuse is reported as removed, not as enabled/disabled', () => {
  const w = parseFuseWire(binary('1r110001'));
  assert.equal(w.fuses!.EnableCookieEncryption, 'removed');
});

test('no sentinel → ok:false (a binary without a wire is never read as "off")', () => {
  const w = parseFuseWire(Buffer.from('just an ELF without the wire'));
  assert.equal(w.ok, false);
  assert.match(w.reason!, /sentinel not found/);
  assert.equal(cookieFuseOffset(Buffer.from('nothing')), -1);
});

test('two sentinels → ok:false (universal binary / copied string: no guessing which wire is live)', () => {
  const w = parseFuseWire(binary(STOCK_STATES, { sentinels: 2 }));
  assert.equal(w.ok, false);
  assert.match(w.reason!, /more than once/);
});

test('unknown version, truncated wire, short wire and a garbage state byte are refused', () => {
  assert.match(parseFuseWire(binary(STOCK_STATES, { version: 2 })).reason!, /unsupported fuse wire version 2/);
  assert.match(parseFuseWire(binary(STOCK_STATES, { lengthByte: 40 })).reason!, /runs past the end/);
  assert.match(parseFuseWire(binary('101', { lengthByte: 3 })).reason!, /fewer than the 8/);
  assert.match(parseFuseWire(binary('1x110001')).reason!, /state byte 0x78/);
  assert.equal(parseFuseWire(Buffer.concat([Buffer.from(SENTINEL, 'latin1')])).ok, false);
});

test('a wire longer than the names this reader knows still parses (a newer Electron adds fuses)', () => {
  const w = parseFuseWire(binary(STOCK_STATES + '1'));
  assert.equal(w.ok, true);
  assert.equal(w.fuses!['fuse#8'], 'enabled');
});

test('expectCookieFuse: the packaged wire must say what the shipped policy assumes (both directions), and an unreadable wire fails closed', () => {
  const off = parseFuseWire(binary(STOCK_STATES));
  const on = parseFuseWire(binary(STOCK_STATES.slice(0, 1) + '1' + STOCK_STATES.slice(2)));
  assert.equal(expectCookieFuse(off, false).ok, true);
  assert.equal(expectCookieFuse(on, true).ok, true);
  const offVsOnPolicy = expectCookieFuse(off, true);
  assert.equal(offVsOnPolicy.ok, false);
  assert.match(offVsOnPolicy.message, /is disabled .* expects enabled/);
  const onVsOffPolicy = expectCookieFuse(on, false);
  assert.equal(onVsOffPolicy.ok, false);
  assert.match(onVsOffPolicy.message, /misstate where cookies sit on disk/);
  assert.equal(expectCookieFuse(parseFuseWire(Buffer.from('no wire')), false).ok, false);
  assert.equal(expectCookieFuse(null, false).ok, false);
  assert.equal(expectCookieFuse(parseFuseWire(binary('1r110001')), false).ok, false, 'a removed fuse is neither disabled nor enabled');
});
