import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeKeeperFrame,
  parseKeeperFrame,
  createLineSplitter,
  classifyStdoutLine,
  createKeeperState,
  DEFAULT_KEEPER_POLICY,
  type KeeperFrame,
} from './keeper-protocol.ts';

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

test('encode/parse round-trips every frame shape', () => {
  const frames: KeeperFrame[] = [
    { t: 'hello', wsId: 'ws-1' },
    { t: 'spawn', command: '/bin/claude', args: ['--flag'], cwd: '/tmp/x', env: { A: '1', B: undefined } },
    { t: 'stdin', b64: Buffer.from('{"type":"user"}\n').toString('base64') },
    { t: 'stdinEnd' },
    { t: 'kill', signal: 'SIGKILL' },
    { t: 'helloAck', wsId: 'ws-1', running: true, pid: 42, startedAt: 123 },
    { t: 'stdout', b64: 'aGk=' },
    { t: 'exit', code: 0, signal: null },
    { t: 'err', msg: 'boom' },
  ];
  for (const f of frames) {
    const line = encodeKeeperFrame(f);
    assert.ok(line.endsWith('\n'), 'frame ends with newline');
    const back = parseKeeperFrame(line.trimEnd());
    assert.deepEqual(back, JSON.parse(JSON.stringify(f)), `round-trip ${f.t}`);
  }
});

test('parseKeeperFrame rejects garbage without throwing', () => {
  assert.equal(parseKeeperFrame('not json'), null);
  assert.equal(parseKeeperFrame('42'), null);
  assert.equal(parseKeeperFrame('null'), null);
  assert.equal(parseKeeperFrame('{"noT":"here"}'), null);
  assert.equal(parseKeeperFrame('{"t":7}'), null);
});

test('line splitter handles split and merged chunks', () => {
  const lines: string[] = [];
  const push = createLineSplitter((l) => lines.push(l));
  push('{"a":1}\n{"b"');
  assert.deepEqual(lines, ['{"a":1}']);
  push(':2}\n');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  push(Buffer.from('{"c":3}\n{"d":4}\n'));
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}', '{"d":4}']);
});

test('line splitter skips blank lines and keeps partials buffered', () => {
  const lines: string[] = [];
  const push = createLineSplitter((l) => lines.push(l));
  push('\n\n  \nhalf');
  assert.deepEqual(lines, []);
  push('-line\n');
  assert.deepEqual(lines, ['half-line']);
});

// ---------------------------------------------------------------------------
// Stdout classification (shapes mirror real stream-json lines)
// ---------------------------------------------------------------------------

test('classifyStdoutLine maps stream-json types', () => {
  assert.equal(classifyStdoutLine('{"type":"result","subtype":"success"}'), 'result');
  assert.equal(classifyStdoutLine('{"type":"assistant","message":{}}'), 'activity');
  assert.equal(classifyStdoutLine('{"type":"user","message":{}}'), 'activity');
  assert.equal(classifyStdoutLine('{"type":"stream_event","event":{}}'), 'activity');
  assert.equal(classifyStdoutLine('{"type":"tool_progress"}'), 'activity');
  // system lines are neutral: attach emits system/init on an idle CLI and must
  // not flip it to "turn in flight" (that would defeat the linger entirely).
  assert.equal(classifyStdoutLine('{"type":"system","subtype":"init"}'), 'neutral');
  assert.equal(classifyStdoutLine('{"type":"system","subtype":"thinking_tokens"}'), 'neutral');
  assert.equal(classifyStdoutLine('not json at all'), 'neutral');
});

// ---------------------------------------------------------------------------
// Shutdown policy
// ---------------------------------------------------------------------------

const POLICY = { lingerMs: 1000, wedgeMs: 5000, initGraceMs: 200 };

test('attached keeper never shuts down', () => {
  const st = createKeeperState(POLICY, 0);
  st.onAttach();
  st.onStdoutLine('{"type":"result"}', 10);
  assert.equal(st.shouldShutdown(1_000_000), false);
});

test('detached after result → linger fires at lingerMs', () => {
  const st = createKeeperState(POLICY, 0);
  st.onAttach();
  st.onStdoutLine('{"type":"assistant"}', 10);
  st.onStdoutLine('{"type":"result"}', 20);
  st.onDetach(100);
  assert.equal(st.shouldShutdown(1099), false);
  assert.equal(st.shouldShutdown(1100), true);
});

test('detached mid-turn → linger does NOT fire; wedge does', () => {
  const st = createKeeperState(POLICY, 0);
  st.onAttach();
  st.onStdoutLine('{"type":"assistant"}', 10); // turn open
  st.onDetach(100);
  assert.equal(st.shouldShutdown(2000), false, 'past linger but turn in flight');
  assert.equal(st.shouldShutdown(5099), false);
  assert.equal(st.shouldShutdown(5100), true, 'wedge backstop');
});

test('stdout while detached resets the wedge clock (working turn is not wedged)', () => {
  const st = createKeeperState(POLICY, 0);
  st.onAttach();
  st.onStdoutLine('{"type":"assistant"}', 10);
  st.onDetach(100);
  st.onStdoutLine('{"type":"system","subtype":"thinking_tokens"}', 4000); // sign of life
  assert.equal(st.shouldShutdown(5100), false, 'wedge measured from last stdout');
  assert.equal(st.shouldShutdown(9000), true);
});

test('turn completing while detached switches wedge → linger', () => {
  const st = createKeeperState(POLICY, 0);
  st.onAttach();
  st.onStdoutLine('{"type":"assistant"}', 10);
  st.onDetach(100);
  st.onStdoutLine('{"type":"result"}', 3000); // finished while nobody watched
  assert.equal(st.shouldShutdown(3999), false);
  assert.equal(st.shouldShutdown(4000), true, 'linger from the result line');
});

test('reattach cancels pending shutdown clocks', () => {
  const st = createKeeperState(POLICY, 0);
  st.onAttach();
  st.onStdoutLine('{"type":"result"}', 10);
  st.onDetach(100);
  st.onAttach(); // user came back
  assert.equal(st.shouldShutdown(10_000), false);
});

test('fresh spawn with no activity ever → INIT GRACE applies (fast kill)', () => {
  // A client death during session init orphans the MCP/init handshake and
  // wedges the CLI (reproduced from a real quit-right-after-send) — a
  // never-started session must die fast, not linger.
  const st = createKeeperState(POLICY, 0);
  st.onSpawn(0);
  st.onAttach();
  st.onStdoutLine('{"type":"system","subtype":"init"}', 20); // system lines ≠ started
  st.onDetach(50);
  assert.equal(st.snapshot().everStarted, false);
  assert.equal(st.shouldShutdown(249), false);
  assert.equal(st.shouldShutdown(250), true, 'initGrace from detach');
});

test('everStarted latches on first activity and switches to linger/wedge rules', () => {
  const st = createKeeperState(POLICY, 0);
  st.onSpawn(0);
  st.onAttach();
  st.onStdoutLine('{"type":"assistant"}', 10);
  assert.equal(st.snapshot().everStarted, true);
  st.onStdoutLine('{"type":"result"}', 20);
  st.onDetach(100);
  assert.equal(st.shouldShutdown(400), false, 'past initGrace but session ran — linger applies');
  assert.equal(st.shouldShutdown(1100), true, 'linger');
});

test('shouldShutdown latches once true', () => {
  const st = createKeeperState(POLICY, 0);
  st.onDetach(0);
  assert.equal(st.shouldShutdown(1000), true);
  st.onAttach(); // too late — shutdown already began
  assert.equal(st.shouldShutdown(1001), true);
});

test('default policy has sane magnitudes', () => {
  assert.equal(DEFAULT_KEEPER_POLICY.lingerMs, 15 * 60 * 1000);
  assert.equal(DEFAULT_KEEPER_POLICY.wedgeMs, 2 * 60 * 60 * 1000);
  assert.equal(DEFAULT_KEEPER_POLICY.initGraceMs, 10 * 1000);
  assert.ok(DEFAULT_KEEPER_POLICY.wedgeMs > DEFAULT_KEEPER_POLICY.lingerMs);
  assert.ok(DEFAULT_KEEPER_POLICY.lingerMs > DEFAULT_KEEPER_POLICY.initGraceMs);
});
