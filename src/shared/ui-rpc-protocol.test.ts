import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAME_HEADER_BYTES,
  MAX_FRAME_BYTES,
  TAG_PTY_DATA,
  TAG_PTY_WRITE,
  UiRpcFrameDecoder,
  WIRE_EVENT_CHANNELS,
  encodeJsonFrame,
  encodePtyDataFrame,
  encodePtyWriteFrame,
  encodeUiRpcFrame,
  isUiRpcJsonFrame,
  wireEventChannel,
  type PtyDataFrame,
  type PtyWriteFrame,
  type UiRpcJsonFrame,
} from './ui-rpc-protocol.ts';

test('JSON frame round-trips through encode + decode', () => {
  const dec = new UiRpcFrameDecoder();
  const frame: UiRpcJsonFrame = {
    t: 'req',
    id: 7,
    method: 'listWorkspaces',
    params: [],
  };
  const frames = dec.push(encodeJsonFrame(frame));
  assert.deepEqual(frames, [frame]);
  assert.equal(dec.pending, 0);
});

test('every JSON frame type round-trips and passes the guard', () => {
  const all: UiRpcJsonFrame[] = [
    { t: 'hello', proto: 1, appVersion: '0.5.84', clientKind: 'test', focused: false },
    { t: 'helloOk', proto: 1, appVersion: '0.5.84', backendKind: 'daemon' },
    { t: 'req', id: 1, method: 'app:info', params: [] },
    { t: 'res', id: 1, ok: true, result: { version: '0.5.84' } },
    { t: 'res', id: 2, ok: false, error: { message: 'boom', name: 'Error' } },
    { t: 'event', channel: 'workspaceUpdate', args: [{ id: 'ws1' }] },
    { t: 'focus', focused: true },
    { t: 'ping' },
    { t: 'pong' },
  ];
  const dec = new UiRpcFrameDecoder();
  const wire = Buffer.concat(all.map((f) => encodeJsonFrame(f)));
  const frames = dec.push(wire);
  assert.deepEqual(frames, all);
  for (const f of frames) assert.ok(isUiRpcJsonFrame(f), `guard accepts ${JSON.stringify(f)}`);
});

test('ptyData binary frame round-trips with raw bytes preserved', () => {
  const dec = new UiRpcFrameDecoder();
  // Bytes deliberately include \x00, \x1b and invalid-UTF8 sequences — the
  // whole point of the binary frame is that these survive untouched.
  const data = Buffer.from([0x00, 0x1b, 0x5b, 0x32, 0x4a, 0xff, 0xfe, 0x7b]);
  const frames = dec.push(encodePtyDataFrame('ws-1:run', data));
  assert.equal(frames.length, 1);
  const f = frames[0] as PtyDataFrame;
  assert.equal(f.t, 'ptyData');
  assert.equal(f.id, 'ws-1:run');
  assert.deepEqual(f.data, data);
});

test('ptyWrite binary frame round-trips (string input)', () => {
  const dec = new UiRpcFrameDecoder();
  const frames = dec.push(encodePtyWriteFrame('account-login:acc1', 'ls -la\r'));
  const f = frames[0] as PtyWriteFrame;
  assert.equal(f.t, 'ptyWrite');
  assert.equal(f.id, 'account-login:acc1');
  assert.equal(f.data.toString('utf8'), 'ls -la\r');
});

test('encodeUiRpcFrame dispatches on the discriminant', () => {
  const dec = new UiRpcFrameDecoder();
  const wire = Buffer.concat([
    encodeUiRpcFrame({ t: 'ping' }),
    encodeUiRpcFrame({ t: 'ptyData', id: 'a', data: Buffer.from('x') }),
    encodeUiRpcFrame({ t: 'ptyWrite', id: 'b', data: Buffer.from('y') }),
  ]);
  const frames = dec.push(wire);
  assert.deepEqual(
    frames.map((f) => f.t),
    ['ping', 'ptyData', 'ptyWrite'],
  );
});

test('frames split across arbitrary chunk boundaries reassemble in order', () => {
  const wire = Buffer.concat([
    encodeJsonFrame({ t: 'ping' }),
    encodePtyDataFrame('ws-long-id-with-unicode-⑦', Buffer.from('hello world')),
    encodeJsonFrame({ t: 'event', channel: 'agentTool', args: ['ws1', 'Bash'] }),
  ]);
  // Feed one byte at a time — the cruelest chunking.
  const dec = new UiRpcFrameDecoder();
  const out: string[] = [];
  for (let i = 0; i < wire.length; i++) {
    for (const f of dec.push(wire.subarray(i, i + 1))) out.push(f.t);
  }
  assert.deepEqual(out, ['ping', 'ptyData', 'event']);
  assert.equal(dec.pending, 0);
});

test('pending reports buffered bytes of an incomplete frame', () => {
  const dec = new UiRpcFrameDecoder();
  const wire = encodeJsonFrame({ t: 'pong' });
  dec.push(wire.subarray(0, FRAME_HEADER_BYTES + 1));
  assert.equal(dec.pending, FRAME_HEADER_BYTES + 1);
  const frames = dec.push(wire.subarray(FRAME_HEADER_BYTES + 1));
  assert.deepEqual(frames, [{ t: 'pong' }]);
  assert.equal(dec.pending, 0);
});

test('oversized declared length is rejected before allocation', () => {
  const dec = new UiRpcFrameDecoder();
  const evil = Buffer.alloc(FRAME_HEADER_BYTES);
  evil.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
  assert.throws(() => dec.push(evil), /exceeds cap/);
});

test('encode refuses an over-cap frame', () => {
  const big = Buffer.alloc(MAX_FRAME_BYTES + 1);
  assert.throws(() => encodePtyDataFrame('x', big), /too large/);
});

test('unknown discriminator byte tears the stream down', () => {
  const dec = new UiRpcFrameDecoder();
  const payload = Buffer.from([0x09, 0x01, 0x02]);
  const wire = Buffer.alloc(FRAME_HEADER_BYTES + payload.length);
  wire.writeUInt32BE(payload.length, 0);
  payload.copy(wire, FRAME_HEADER_BYTES);
  assert.throws(() => dec.push(wire), /unknown discriminator/);
});

test('truncated binary layout (idLen past payload) throws', () => {
  const dec = new UiRpcFrameDecoder();
  const payload = Buffer.alloc(6);
  payload.writeUInt8(TAG_PTY_DATA, 0);
  payload.writeUInt32BE(1000, 1); // idLen far beyond the payload
  const wire = Buffer.alloc(FRAME_HEADER_BYTES + payload.length);
  wire.writeUInt32BE(payload.length, 0);
  payload.copy(wire, FRAME_HEADER_BYTES);
  assert.throws(() => dec.push(wire), /truncated/);
});

test('invalid JSON payload throws', () => {
  const dec = new UiRpcFrameDecoder();
  const payload = Buffer.from('{not json', 'utf8');
  const wire = Buffer.alloc(FRAME_HEADER_BYTES + payload.length);
  wire.writeUInt32BE(payload.length, 0);
  payload.copy(wire, FRAME_HEADER_BYTES);
  assert.throws(() => dec.push(wire), /not valid JSON/);
});

test('isUiRpcJsonFrame rejects unknown/missing discriminants', () => {
  assert.equal(isUiRpcJsonFrame({ t: 'spawn' }), false);
  assert.equal(isUiRpcJsonFrame({}), false);
  assert.equal(isUiRpcJsonFrame(null), false);
  assert.equal(isUiRpcJsonFrame('ping'), false);
  assert.equal(isUiRpcJsonFrame({ t: 'ping' }), true);
});

test('wire event channel table: names are on-prefix-free camelCase and unique', () => {
  const wires = Object.values(WIRE_EVENT_CHANNELS);
  assert.equal(new Set(wires).size, wires.length, 'wire names are unique');
  for (const w of wires) {
    assert.match(w, /^[a-z][a-zA-Z]*$/, `${w} is bare camelCase`);
    assert.ok(!w.startsWith('on'), `${w} carries no on prefix`);
  }
  // Spot-check the spec's own example plus the two M1 additions.
  assert.equal(wireEventChannel('workspace:update'), 'workspaceUpdate');
  assert.equal(wireEventChannel('ui:notify'), 'uiNotify');
  assert.equal(wireEventChannel('accounts:loginUrl'), 'accountsLoginUrl');
  // pty:data must NOT be a JSON event channel — it rides binary frames.
  assert.equal(wireEventChannel('pty:data'), null);
  // TAG constants stay distinct from JSON's leading '{'.
  assert.notEqual(TAG_PTY_DATA, 0x7b);
  assert.notEqual(TAG_PTY_WRITE, 0x7b);
});
