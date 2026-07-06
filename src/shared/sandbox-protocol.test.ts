import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeFrame,
  FrameDecoder,
  isFrame,
  FRAME_HEADER_BYTES,
  MAX_FRAME_BYTES,
  type Frame,
  type SpawnFrame,
  type DataFrame,
  type RpcFrame,
  type RpcReplyFrame,
} from './sandbox-protocol.ts';

// ─── round-trip ────────────────────────────────────────────────────────────

test('encode → decode round-trips a frame exactly', () => {
  const spawn: SpawnFrame = {
    t: 'spawn',
    session: 'ws-1',
    command: 'claude',
    args: ['--dangerously-skip-permissions'],
    cwd: '/workspace',
    env: { TERM: 'xterm-256color', ORCHESTRA_WS_ID: 'ws-1' },
    cols: 120,
    rows: 40,
  };
  const dec = new FrameDecoder();
  const frames = dec.push(encodeFrame(spawn));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], spawn);
  assert.equal(dec.pending, 0);
});

test('header is a 4-byte big-endian length of the JSON payload only', () => {
  const frame: DataFrame = { t: 'data', session: 'ws-1', data: 'hi' };
  const buf = encodeFrame(frame);
  const json = Buffer.from(JSON.stringify(frame), 'utf8');
  assert.equal(buf.readUInt32BE(0), json.length);
  assert.equal(buf.length, FRAME_HEADER_BYTES + json.length);
  assert.deepEqual(buf.subarray(FRAME_HEADER_BYTES), json);
});

// ─── streaming: chunk boundaries ─────────────────────────────────────────────

test('decoder extracts multiple frames from one chunk, in order', () => {
  const a: DataFrame = { t: 'data', session: 's', data: 'a' };
  const b: DataFrame = { t: 'data', session: 's', data: 'b' };
  const c: RpcReplyFrame = { t: 'rpcReply', id: 7, payload: { ok: true } };
  const dec = new FrameDecoder();
  const frames = dec.push(Buffer.concat([encodeFrame(a), encodeFrame(b), encodeFrame(c)]));
  assert.deepEqual(frames, [a, b, c]);
});

test('decoder reassembles a frame split across chunks (header split too)', () => {
  const frame: DataFrame = { t: 'data', session: 's', data: 'split me across reads' };
  const whole = encodeFrame(frame);
  const dec = new FrameDecoder();

  // Split mid-header (after 2 of 4 length bytes), then mid-payload.
  assert.deepEqual(dec.push(whole.subarray(0, 2)), []);
  assert.ok(dec.pending === 2);
  assert.deepEqual(dec.push(whole.subarray(2, 6)), []);
  const out = dec.push(whole.subarray(6));
  assert.deepEqual(out, [frame]);
  assert.equal(dec.pending, 0);
});

test('decoder holds a trailing partial frame until the rest arrives', () => {
  const a: DataFrame = { t: 'data', session: 's', data: 'complete' };
  const b: DataFrame = { t: 'data', session: 's', data: 'partial' };
  const ab = Buffer.concat([encodeFrame(a), encodeFrame(b)]);
  const cut = encodeFrame(a).length + 3; // a whole + 3 bytes of b
  const dec = new FrameDecoder();

  const first = dec.push(ab.subarray(0, cut));
  assert.deepEqual(first, [a]);
  assert.ok(dec.pending > 0);

  const second = dec.push(ab.subarray(cut));
  assert.deepEqual(second, [b]);
  assert.equal(dec.pending, 0);
});

test('one byte at a time still decodes', () => {
  const frame: RpcFrame<'message'> = {
    t: 'rpc',
    id: 1,
    route: 'message',
    payload: { from: 'ws-a', to: 'ws-b', text: 'hello' },
  };
  const whole = encodeFrame(frame);
  const dec = new FrameDecoder();
  const collected: Frame[] = [];
  for (const byte of whole) collected.push(...dec.push(Buffer.from([byte])));
  assert.deepEqual(collected, [frame]);
});

// ─── unicode / payload fidelity ──────────────────────────────────────────────

test('multi-byte UTF-8 survives the length-in-bytes framing', () => {
  // 4-byte emoji + combining chars: byte length ≠ JS string .length, so a
  // char-counted header would corrupt this. The header counts bytes.
  const frame: DataFrame = { t: 'data', session: 's', data: '✓ 日本語 🚀 café' };
  const dec = new FrameDecoder();
  const [out] = dec.push(encodeFrame(frame));
  assert.deepEqual(out, frame);
});

// ─── limits ───────────────────────────────────────────────────────────────────

test('encodeFrame rejects an over-cap payload', () => {
  const huge: DataFrame = { t: 'data', session: 's', data: 'x'.repeat(MAX_FRAME_BYTES + 1) };
  assert.throws(() => encodeFrame(huge), /too large/);
});

test('decoder rejects a corrupt over-cap length header without allocating it', () => {
  const bad = Buffer.alloc(FRAME_HEADER_BYTES);
  bad.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
  const dec = new FrameDecoder();
  assert.throws(() => dec.push(bad), /exceeds cap/);
});

test('decoder rejects a non-JSON payload', () => {
  const garbage = Buffer.from('not json', 'utf8');
  const buf = Buffer.allocUnsafe(FRAME_HEADER_BYTES + garbage.length);
  buf.writeUInt32BE(garbage.length, 0);
  garbage.copy(buf, FRAME_HEADER_BYTES);
  const dec = new FrameDecoder();
  assert.throws(() => dec.push(buf), /not valid JSON/);
});

// ─── isFrame discriminant guard ──────────────────────────────────────────────

test('isFrame accepts every known frame type and rejects others', () => {
  assert.ok(isFrame({ t: 'spawn' }));
  assert.ok(isFrame({ t: 'rpcReply' }));
  assert.ok(isFrame({ t: 'hello' }));
  assert.ok(isFrame({ t: 'takeControl' }));
  assert.ok(isFrame({ t: 'control' }));
  assert.equal(isFrame({ t: 'unknown' }), false);
  assert.equal(isFrame({ noT: true }), false);
  assert.equal(isFrame(null), false);
  assert.equal(isFrame('data'), false);
  assert.equal(isFrame(42), false);
});
