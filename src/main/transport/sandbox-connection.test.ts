import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  SandboxConnection,
  EXIT_CONNECTION_LOST,
  applyRemoteAgentEvent,
  type ApplyAgentEvent,
  type SandboxSocket,
} from './sandbox-connection.ts';
import { createRemoteTransport } from './remote.ts';
import {
  encodeFrame,
  FrameDecoder,
  type Frame,
  type ClientFrame,
  type SandboxFrame,
} from '../../shared/sandbox-protocol.ts';
// The REAL #127 in-flight-tool tracker (platform-free — the hibernation module
// has no Electron dep, so it imports under the strip-types runner where
// activity.ts / sandbox-manager.ts cannot; see ERR_UNSUPPORTED_DIR_IMPORT).
import {
  noteToolStart,
  noteToolEnd,
  getInFlightTools,
  forgetHibernationActivity,
} from '../hibernation-activity.ts';

// ─── A fake socket that records what the connection sends and lets a test
//     inject inbound bytes, mirroring the ws message/close/error surface. ─────

class FakeSocket implements SandboxSocket {
  readyState = 1; // OPEN
  sent: Frame[] = [];
  private listeners: { message: Array<(d: Buffer) => void>; close: Array<() => void>; error: Array<(e: Error) => void> } = {
    message: [],
    close: [],
    error: [],
  };
  private readonly decoder = new FrameDecoder();

  send(data: Uint8Array): void {
    // Decode what the connection wrote so tests assert on frames, not bytes.
    for (const f of this.decoder.push(Buffer.from(data))) this.sent.push(f);
  }
  close(): void {
    this.readyState = 3; // CLOSED
    for (const l of this.listeners.close) l();
  }
  on(event: 'message' | 'close' | 'error', listener: never): void {
    (this.listeners[event] as Array<typeof listener>).push(listener);
  }
  /** Test helper: deliver an inbound frame from the (fake) sandbox. */
  inbound(frame: SandboxFrame): void {
    const buf = encodeFrame(frame);
    for (const l of this.listeners.message) l(buf);
  }
  /** Test helper: deliver raw bytes (for split/garbled-frame tests). */
  inboundRaw(buf: Buffer): void {
    for (const l of this.listeners.message) l(buf);
  }
  emitError(err: Error): void {
    for (const l of this.listeners.error) l(err);
  }
}

const lastSent = (s: FakeSocket): ClientFrame => s.sent[s.sent.length - 1] as ClientFrame;

// ─── RemoteTransport ↔ SandboxConnection round-trips ────────────────────────

test('spawn sends a spawn frame with the session id and options', async () => {
  const sock = new FakeSocket();
  const conn = new SandboxConnection(sock);
  await createRemoteTransport(conn, 'ws-1', {
    command: 'claude',
    args: ['--dangerously-skip-permissions'],
    cwd: '/workspace',
    env: { TERM: 'xterm-256color' },
    cols: 80,
    rows: 24,
  });
  assert.deepEqual(sock.sent, [
    {
      t: 'spawn',
      session: 'ws-1',
      command: 'claude',
      args: ['--dangerously-skip-permissions'],
      cwd: '/workspace',
      env: { TERM: 'xterm-256color' },
      cols: 80,
      rows: 24,
    },
  ]);
});

test('data frames for a session reach that transport, and only that one', async () => {
  const sock = new FakeSocket();
  const conn = new SandboxConnection(sock);
  const opts = { command: 'claude', args: [], cwd: '/workspace', env: {}, cols: 80, rows: 24 };
  const a = await createRemoteTransport(conn, 'ws-a', opts);
  const b = await createRemoteTransport(conn, 'ws-b', opts);

  const aData: string[] = [];
  const bData: string[] = [];
  a.onData((d) => aData.push(d));
  b.onData((d) => bData.push(d));

  sock.inbound({ t: 'data', session: 'ws-a', data: 'hello' });
  sock.inbound({ t: 'data', session: 'ws-b', data: 'world' });
  sock.inbound({ t: 'data', session: 'ws-a', data: '!' });

  assert.deepEqual(aData, ['hello', '!']);
  assert.deepEqual(bData, ['world']);
});

test('write/resize/kill emit the right per-session frames', async () => {
  const sock = new FakeSocket();
  const conn = new SandboxConnection(sock);
  const t = await createRemoteTransport(conn, 'ws-1', {
    command: 'claude', args: [], cwd: '/workspace', env: {}, cols: 80, rows: 24,
  });
  t.write('ls\n');
  assert.deepEqual(lastSent(sock), { t: 'write', session: 'ws-1', data: 'ls\n' });
  t.resize(120, 40);
  assert.deepEqual(lastSent(sock), { t: 'resize', session: 'ws-1', cols: 120, rows: 40 });
  t.kill();
  assert.deepEqual(lastSent(sock), { t: 'kill', session: 'ws-1' });
});

test('exit fires exactly once and detaches the session', async () => {
  const sock = new FakeSocket();
  const conn = new SandboxConnection(sock);
  const t = await createRemoteTransport(conn, 'ws-1', {
    command: 'claude', args: [], cwd: '/workspace', env: {}, cols: 80, rows: 24,
  });
  let exits = 0;
  let code = NaN;
  t.onExit((e) => { exits++; code = e.exitCode; });

  sock.inbound({ t: 'exit', session: 'ws-1', exitCode: 0 });
  // A duplicate / late exit for the same id must not re-fire.
  sock.inbound({ t: 'exit', session: 'ws-1', exitCode: 0 });
  assert.equal(exits, 1);
  assert.equal(code, 0);

  // After exit, writes are dropped (no new frame past the spawn).
  const before = sock.sent.length;
  t.write('ignored');
  assert.equal(sock.sent.length, before);
});

test('data after exit does not reach the transport', async () => {
  const sock = new FakeSocket();
  const conn = new SandboxConnection(sock);
  const t = await createRemoteTransport(conn, 'ws-1', {
    command: 'claude', args: [], cwd: '/workspace', env: {}, cols: 80, rows: 24,
  });
  const data: string[] = [];
  t.onData((d) => data.push(d));
  sock.inbound({ t: 'data', session: 'ws-1', data: 'before' });
  sock.inbound({ t: 'exit', session: 'ws-1', exitCode: 0 });
  sock.inbound({ t: 'data', session: 'ws-1', data: 'after' });
  assert.deepEqual(data, ['before']);
});

// ─── event / rpc handlers ────────────────────────────────────────────────────

test('event frames are handed to onEvent with tool normalized', () => {
  const sock = new FakeSocket();
  const seen: Array<[string, string, string | undefined]> = [];
  const conn = new SandboxConnection(sock, {
    onEvent: (s, e, tool) => seen.push([s, e, tool]),
  });
  conn.registerSession('ws-1', { handleData() {}, handleExit() {} });
  sock.inbound({ t: 'event', session: 'ws-1', event: 'pretool', tool: 'Bash' });
  sock.inbound({ t: 'event', session: 'ws-1', event: 'stop' });
  assert.deepEqual(seen, [
    ['ws-1', 'pretool', 'Bash'],
    ['ws-1', 'stop', undefined],
  ]);
});

test('#132: an event frame carrying a wire toolUseId hands it to onEvent (4th arg)', () => {
  // The wire-side half of #132: the sandbox EventFrame now carries toolUseId, and
  // the connection must surface it as onEvent's 4th argument so the host tracker
  // keys a remote posttool by id. A frame WITHOUT the field yields undefined
  // (old shim → id-less FIFO, unchanged).
  // MUTANT: drop `f.toolUseId` from the onEvent call in sandbox-connection.ts →
  //   the id-bearing row's 4th element becomes undefined → this goes RED.
  const sock = new FakeSocket();
  const seen: Array<[string, string, string | undefined, string | undefined]> = [];
  const conn = new SandboxConnection(sock, {
    onEvent: (s, e, tool, toolUseId) => seen.push([s, e, tool, toolUseId]),
  });
  conn.registerSession('ws-1', { handleData() {}, handleExit() {} });
  sock.inbound({
    t: 'event',
    session: 'ws-1',
    event: 'posttool',
    tool: 'mcp__browser__click',
    toolUseId: 'toolu_fast',
  });
  sock.inbound({ t: 'event', session: 'ws-1', event: 'posttool', tool: 'Bash' }); // no id
  assert.deepEqual(seen, [
    ['ws-1', 'posttool', 'mcp__browser__click', 'toolu_fast'],
    ['ws-1', 'posttool', 'Bash', undefined],
  ]);
});

// ─── #132 end-to-end: real EventFrame → SandboxConnection → applyRemoteAgentEvent
//     → REAL #127 tracker. This is the arm the per-hop tests (parseSpoolChunk,
//     onEvent 4th-arg) cannot be: it drives the wire delivery THROUGH the bridge
//     that maps toolUseId onto applyAgentEvent's 7th slot and asserts the tracker
//     outcome — so it FAILS on any master where the wire drops the id, unlike a
//     tracker-only test that would pass byte-identically on master.
//
//     `applyAgentEvent` itself (activity.ts) cannot be imported here — it pulls in
//     `./platform` (ERR_UNSUPPORTED_DIR_IMPORT). We inject an `apply` that mirrors
//     EXACTLY activity.ts's pretool/posttool arms (`case 'pretool': noteToolStart(
//     id, tool??null, toolUseId??null)`; `case 'posttool': noteToolEnd(id,
//     toolUseId??null, tool??null)` — activity.ts:1008/1036), forwarding to the
//     REAL tracker. The mapping under test — wire toolUseId → slot 7 → the
//     tracker's id key — is production code (`applyRemoteAgentEvent`), shared with
//     sandbox-manager, not re-implemented here. ────────────────────────────────

const E2E_WS = 'ws-e2e-132';

/** An `apply` that mirrors activity.ts's pretool/posttool arms onto the REAL
 *  #127 tracker. Only these two arms touch the in-flight list, so a faithful
 *  copy of just them exercises the exact attribution path. */
const trackerApply: ApplyAgentEvent = (session, event, tool, _t, _s, _c, toolUseId) => {
  if (event === 'pretool') noteToolStart(session, tool ?? null, toolUseId ?? null);
  else if (event === 'posttool') noteToolEnd(session, toolUseId ?? null, tool ?? null);
};

test('#132 E2E: two DISTINCT wire toolUseIds (same tool) → the HUNG oldest call SURVIVES through the real bridge+tracker', () => {
  // Drive real EventFrames carrying distinct wire toolUseIds through a real
  // SandboxConnection whose onEvent is wired EXACTLY as sandbox-manager wires it
  // (via applyRemoteAgentEvent), into the real tracker. End the FAST call BY ITS
  // WIRE ID → the hung oldest must remain. On any build where the wire drops the
  // id (master, or a wire mutation), both frames arrive id-less → the tracker's
  // name-only FIFO removes the oldest (hung) → this arm goes RED. THIS is what
  // proves #132's WIRE (not #127's tracker) delivers the id.
  forgetHibernationActivity(E2E_WS);
  const sock = new FakeSocket();
  const conn = new SandboxConnection(sock, {
    onEvent: (session, event, tool, toolUseId) =>
      applyRemoteAgentEvent(trackerApply, session, event, tool, toolUseId),
  });
  conn.registerSession(E2E_WS, { handleData() {}, handleExit() {} });

  // Two parallel same-tool calls; the OLDER hangs. Distinct wire ids on the frame.
  sock.inbound({
    t: 'event', session: E2E_WS, event: 'pretool',
    tool: 'mcp__browser__click', toolUseId: 'toolu_hung',
  });
  sock.inbound({
    t: 'event', session: E2E_WS, event: 'pretool',
    tool: 'mcp__browser__click', toolUseId: 'toolu_fast',
  });
  assert.equal(getInFlightTools(E2E_WS).length, 2, 'both parallel calls tracked');
  // The FAST call returns — its posttool carries its own wire id.
  sock.inbound({
    t: 'event', session: E2E_WS, event: 'posttool',
    tool: 'mcp__browser__click', toolUseId: 'toolu_fast',
  });

  const left = getInFlightTools(E2E_WS);
  assert.equal(left.length, 1, 'exactly one same-tool call remains');
  assert.equal(left[0].toolUseId, 'toolu_hung', 'the HUNG (oldest) call survives — the wire delivered the id');
  forgetHibernationActivity(E2E_WS);
});

test('#132 E2E must-FAIL control: id STRIPPED from the wire frames → OLD masking returns (survivor = fast) through the SAME path', () => {
  // Same scenario, SAME real bridge+tracker path, but the wire frames carry NO
  // toolUseId (simulating master / a dropped-id wire). Both calls are id-less →
  // the posttool's name-only FIFO removes the OLDEST (hung) → the fast sibling
  // survives, reproducing the mis-attribution #132 fixes. This is the load-bearing
  // control: if it still attributed correctly, the wire id would not be doing the
  // work.
  forgetHibernationActivity(E2E_WS);
  const sock = new FakeSocket();
  const conn = new SandboxConnection(sock, {
    onEvent: (session, event, tool, toolUseId) =>
      applyRemoteAgentEvent(trackerApply, session, event, tool, toolUseId),
  });
  conn.registerSession(E2E_WS, { handleData() {}, handleExit() {} });

  sock.inbound({ t: 'event', session: E2E_WS, event: 'pretool', tool: 'mcp__browser__click' }); // hung, id-less
  sock.inbound({ t: 'event', session: E2E_WS, event: 'pretool', tool: 'mcp__browser__click' }); // fast, id-less
  sock.inbound({ t: 'event', session: E2E_WS, event: 'posttool', tool: 'mcp__browser__click' }); // id-less → FIFO

  const left = getInFlightTools(E2E_WS);
  assert.equal(left.length, 1, 'one same-tool call remains');
  assert.equal(left[0].toolUseId, null, 'survivor is the id-less fast call — hung oldest MASKED (old behaviour)');
  forgetHibernationActivity(E2E_WS);
});

test('#132 E2E fidelity pin: activity.ts pretool/posttool arms match the injected trackerApply', () => {
  // The E2E above injects a `trackerApply` that mirrors activity.ts's pretool/
  // posttool arms (which cannot be imported here — ERR_UNSUPPORTED_DIR_IMPORT).
  // This pin fails LOUDLY if those arms drift from the mirror, so the E2E can
  // never quietly test a stale copy: it slices each arm from activity.ts source
  // and asserts it still calls the tracker with toolUseId the way trackerApply
  // does. (Same source-pin approach as turn-start-stamp.test.ts.)
  const src = readFileSync(path.join(process.cwd(), 'src', 'main', 'activity.ts'), 'utf8');
  const arm = (name: string): string => {
    const start = src.indexOf(`case '${name}':`);
    assert.notEqual(start, -1, `case '${name}' not found in activity.ts — was it renamed?`);
    const end = src.indexOf('break;', start);
    assert.notEqual(end, -1, `case '${name}' has no break`);
    return src.slice(start, end);
  };
  const pre = arm('pretool');
  assert.match(
    pre,
    /noteToolStart\(\s*id,\s*tool \?\? null,\s*toolUseId \?\? null\s*\)/,
    'pretool arm must call noteToolStart(id, tool??null, toolUseId??null) — trackerApply mirrors this',
  );
  const post = arm('posttool');
  assert.match(
    post,
    /noteToolEnd\(\s*id,\s*toolUseId \?\? null,\s*tool \?\? null\s*\)/,
    'posttool arm must call noteToolEnd(id, toolUseId??null, tool??null) — trackerApply mirrors this',
  );
});

test('rpc is dispatched and its reply is sent back as an rpcReply with the same id', () => {
  const sock = new FakeSocket();
  const conn = new SandboxConnection(sock, {
    onRpc: (route, _payload, reply) => {
      assert.equal(route, 'peers');
      reply({ ok: true, peers: [] });
    },
  });
  sock.inbound({ t: 'rpc', id: 7, route: 'peers', payload: { from: 'ws-1' } });
  assert.deepEqual(lastSent(sock), { t: 'rpcReply', id: 7, payload: { ok: true, peers: [] } });
});

test('rpc with no handler is answered with ok:false so the agent does not hang', () => {
  const sock = new FakeSocket();
  const conn = new SandboxConnection(sock); // no onRpc
  sock.inbound({ t: 'rpc', id: 3, route: 'rename', payload: { id: 'ws-1', branch: 'x' } });
  const reply = lastSent(sock);
  assert.equal(reply.t, 'rpcReply');
  assert.equal((reply as { id: number }).id, 3);
  assert.equal((reply as { payload: { ok: boolean } }).payload.ok, false);
});

test('control frames are handed to onControl (ownership broadcasts)', () => {
  const sock = new FakeSocket();
  const seen: Array<{ driverId: string | null; isDriver: boolean }> = [];
  const conn = new SandboxConnection(sock, {
    onControl: (s) => seen.push({ driverId: s.driverId, isDriver: s.isDriver }),
  });
  sock.inbound({ t: 'control', driverId: 'machine-a', driverName: 'Desktop', isDriver: true });
  sock.inbound({ t: 'control', driverId: 'machine-b', driverName: 'Laptop', isDriver: false });
  assert.deepEqual(seen, [
    { driverId: 'machine-a', isDriver: true },
    { driverId: 'machine-b', isDriver: false },
  ]);
  assert.equal(conn.isClosed, false);
});

test('hello and takeControl ride send() as client frames', () => {
  const sock = new FakeSocket();
  const conn = new SandboxConnection(sock);
  conn.send({ t: 'hello', clientId: 'machine-a', name: 'Desktop' });
  conn.send({ t: 'takeControl' });
  assert.deepEqual(sock.sent, [
    { t: 'hello', clientId: 'machine-a', name: 'Desktop' },
    { t: 'takeControl' },
  ]);
});

// ─── connection lifecycle ────────────────────────────────────────────────────

test('socket close synthesizes a connection-lost exit for live sessions', async () => {
  const sock = new FakeSocket();
  let closed = false;
  const conn = new SandboxConnection(sock, { onClose: () => { closed = true; } });
  const t = await createRemoteTransport(conn, 'ws-1', {
    command: 'claude', args: [], cwd: '/workspace', env: {}, cols: 80, rows: 24,
  });
  let code = NaN;
  t.onExit((e) => { code = e.exitCode; });
  sock.close();
  assert.equal(code, EXIT_CONNECTION_LOST);
  assert.equal(closed, true);
  assert.equal(conn.isClosed, true);
});

// ─── disconnect / reconnect lifecycle (P4 item D) ────────────────────────────

const OPTS = { command: 'claude', args: [], cwd: '/workspace', env: {}, cols: 80, rows: 24 };

test('an unexpected drop with onDisconnect retains sessions instead of tearing down', async () => {
  const sock = new FakeSocket();
  let disconnects = 0;
  let closed = false;
  const conn = new SandboxConnection(sock, {
    onDisconnect: () => disconnects++,
    onClose: () => {
      closed = true;
    },
  });
  const t = await createRemoteTransport(conn, 'ws-1', OPTS);
  let exited = false;
  t.onExit(() => {
    exited = true;
  });

  sock.close(); // remote drop, not conn.close()

  assert.equal(disconnects, 1);
  assert.equal(exited, false, 'session must be held, not unwound');
  assert.equal(closed, false);
  assert.equal(conn.isClosed, false);
  assert.equal(conn.isDisconnected, true);
  assert.equal(conn.sessionCount, 1);
});

test('sends are dropped while disconnected', async () => {
  const sock = new FakeSocket();
  const conn = new SandboxConnection(sock, { onDisconnect: () => {} });
  const t = await createRemoteTransport(conn, 'ws-1', OPTS);
  sock.close();
  const before = sock.sent.length;
  t.write('lost to the void');
  assert.equal(sock.sent.length, before);
});

test('attachSocket resumes the SAME transports on a fresh socket', async () => {
  const sock1 = new FakeSocket();
  const conn = new SandboxConnection(sock1, { onDisconnect: () => {} });
  const t = await createRemoteTransport(conn, 'ws-1', OPTS);
  const data: string[] = [];
  t.onData((d) => data.push(d));

  sock1.inbound({ t: 'data', session: 'ws-1', data: 'before-drop' });
  sock1.close();

  const sock2 = new FakeSocket();
  conn.attachSocket(sock2);
  assert.equal(conn.isDisconnected, false);

  // Inbound resumes to the transport created before the drop…
  sock2.inbound({ t: 'data', session: 'ws-1', data: 'after-reattach' });
  assert.deepEqual(data, ['before-drop', 'after-reattach']);

  // …and outbound rides the new socket.
  t.write('hello again');
  assert.deepEqual(lastSent(sock2), { t: 'write', session: 'ws-1', data: 'hello again' });
  assert.equal(sock1.sent.length, 1); // still just the original spawn
});

test('late events from the replaced socket are ignored', async () => {
  const sock1 = new FakeSocket();
  const conn = new SandboxConnection(sock1, { onDisconnect: () => {} });
  const t = await createRemoteTransport(conn, 'ws-1', OPTS);
  const data: string[] = [];
  let exited = false;
  t.onData((d) => data.push(d));
  t.onExit(() => {
    exited = true;
  });

  sock1.close();
  conn.attachSocket(new FakeSocket());

  // A zombie delivery from the old socket must not reach the session, and a
  // second close from it must not disconnect the fresh stream.
  sock1.inbound({ t: 'data', session: 'ws-1', data: 'zombie' });
  sock1.close();

  assert.deepEqual(data, []);
  assert.equal(exited, false);
  assert.equal(conn.isDisconnected, false);
  assert.equal(conn.isClosed, false);
});

test('abandon unwinds held sessions with EXIT_CONNECTION_LOST and closes', async () => {
  const sock = new FakeSocket();
  let closed = false;
  const conn = new SandboxConnection(sock, {
    onDisconnect: () => {},
    onClose: () => {
      closed = true;
    },
  });
  const t = await createRemoteTransport(conn, 'ws-1', OPTS);
  let code = NaN;
  t.onExit((e) => {
    code = e.exitCode;
  });

  sock.close();
  conn.abandon();

  assert.equal(code, EXIT_CONNECTION_LOST);
  assert.equal(closed, true);
  assert.equal(conn.isClosed, true);
  assert.throws(() => conn.attachSocket(new FakeSocket()), /closed/);
});

test('a deliberate close tears down even when onDisconnect is wired', async () => {
  const sock = new FakeSocket();
  let disconnects = 0;
  let closed = false;
  const conn = new SandboxConnection(sock, {
    onDisconnect: () => disconnects++,
    onClose: () => {
      closed = true;
    },
  });
  const t = await createRemoteTransport(conn, 'ws-1', OPTS);
  let code = NaN;
  t.onExit((e) => {
    code = e.exitCode;
  });

  conn.close(1000, 'app shutdown');

  assert.equal(disconnects, 0, 'deliberate close must never look like an outage');
  assert.equal(code, EXIT_CONNECTION_LOST);
  assert.equal(closed, true);
});

test('close while disconnected tears down without a socket close event', async () => {
  const sock = new FakeSocket();
  let closed = false;
  const conn = new SandboxConnection(sock, {
    onDisconnect: () => {},
    onClose: () => {
      closed = true;
    },
  });
  await createRemoteTransport(conn, 'ws-1', OPTS);
  sock.close(); // now disconnected; the dead socket will emit nothing more
  conn.close(1000, 'app shutdown');
  assert.equal(closed, true);
  assert.equal(conn.isClosed, true);
});

test('notifySessions pushes host text into every live terminal', async () => {
  const sock = new FakeSocket();
  const conn = new SandboxConnection(sock, { onDisconnect: () => {} });
  const a = await createRemoteTransport(conn, 'ws-a', OPTS);
  const b = await createRemoteTransport(conn, 'ws-b', OPTS);
  const aData: string[] = [];
  const bData: string[] = [];
  a.onData((d) => aData.push(d));
  b.onData((d) => bData.push(d));

  conn.notifySessions('[banner]');
  assert.deepEqual(aData, ['[banner]']);
  assert.deepEqual(bData, ['[banner]']);
});

test('a partial frame from the old socket does not corrupt the new stream', async () => {
  const sock1 = new FakeSocket();
  const conn = new SandboxConnection(sock1, { onDisconnect: () => {} });
  const t = await createRemoteTransport(conn, 'ws-1', OPTS);
  const data: string[] = [];
  t.onData((d) => data.push(d));

  // Half a frame arrives, then the link dies mid-delivery.
  const whole = encodeFrame({ t: 'data', session: 'ws-1', data: 'torn' });
  sock1.inboundRaw(whole.subarray(0, 5));
  sock1.close();

  // Fresh socket: the decoder must start clean, so a complete frame parses.
  const sock2 = new FakeSocket();
  conn.attachSocket(sock2);
  sock2.inbound({ t: 'data', session: 'ws-1', data: 'clean' });
  assert.deepEqual(data, ['clean']);
});

test('a corrupt inbound frame raises onError and tears down the stream', () => {
  const sock = new FakeSocket();
  let err: Error | null = null;
  const conn = new SandboxConnection(sock, { onError: (e) => { err = e; } });
  // A length header claiming more than the cap — decoder throws.
  const bad = Buffer.alloc(4);
  bad.writeUInt32BE(0xffffffff, 0);
  sock.inboundRaw(bad);
  assert.ok(err, 'onError should have fired');
  assert.equal(conn.isClosed, true);
});

test('split inbound frames are reassembled across messages', async () => {
  const sock = new FakeSocket();
  const conn = new SandboxConnection(sock);
  const t = await createRemoteTransport(conn, 'ws-1', {
    command: 'claude', args: [], cwd: '/workspace', env: {}, cols: 80, rows: 24,
  });
  const data: string[] = [];
  t.onData((d) => data.push(d));
  const whole = encodeFrame({ t: 'data', session: 'ws-1', data: 'chunky' });
  sock.inboundRaw(whole.subarray(0, 3)); // partial header
  sock.inboundRaw(whole.subarray(3));    // the rest
  assert.deepEqual(data, ['chunky']);
});
