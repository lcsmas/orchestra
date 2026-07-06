import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSpoolChunk,
  routeFromUrl,
  maxBodyBytesFor,
  isForwarded,
  FORWARDED_ROUTES,
  DriveBroker,
} from './shim-core.ts';

// ─── parseSpoolChunk ─────────────────────────────────────────────────────────

test('parses complete lines into events', () => {
  const chunk =
    '{"event":"submit"}\n{"event":"pretool","tool":"Bash"}\n{"event":"posttool","tool":"Bash"}\n';
  const r = parseSpoolChunk('', chunk);
  assert.deepEqual(r.events, [
    { event: 'submit' },
    { event: 'pretool', tool: 'Bash' },
    { event: 'posttool', tool: 'Bash' },
  ]);
  assert.equal(r.leftover, '');
  assert.equal(r.truncate, false);
});

test('empty tool becomes undefined (no tool key)', () => {
  const r = parseSpoolChunk('', '{"event":"pretool","tool":""}\n');
  assert.deepEqual(r.events, [{ event: 'pretool' }]);
  assert.equal('tool' in r.events[0], false);
});

test('a trailing partial line is carried forward, not emitted', () => {
  const r = parseSpoolChunk('', '{"event":"submit"}\n{"event":"pre');
  assert.deepEqual(r.events, [{ event: 'submit' }]);
  assert.equal(r.leftover, '{"event":"pre');
  assert.equal(r.truncate, false);
});

test('a carried partial line is completed by the next chunk', () => {
  const first = parseSpoolChunk('', '{"event":"pre');
  assert.deepEqual(first.events, []);
  assert.equal(first.leftover, '{"event":"pre');
  const second = parseSpoolChunk(first.leftover, 'tool","tool":"Read"}\n');
  assert.deepEqual(second.events, [{ event: 'pretool', tool: 'Read' }]);
  assert.equal(second.leftover, '');
});

test('corrupt and non-event lines are skipped, not fatal', () => {
  const chunk = 'not json\n{"tool":"Bash"}\n{"event":42}\n{"event":"stop"}\n';
  const r = parseSpoolChunk('', chunk);
  // only the well-formed string-event line survives
  assert.deepEqual(r.events, [{ event: 'stop' }]);
});

test('truncate is signalled at a turn boundary with no buffered partial', () => {
  const r = parseSpoolChunk('', '{"event":"submit"}\n{"event":"stop"}\n');
  assert.equal(r.truncate, true);
});

test('notify also triggers truncate', () => {
  const r = parseSpoolChunk('', '{"event":"notify"}\n');
  assert.equal(r.truncate, true);
});

test('no truncate when a terminal line is followed by more activity', () => {
  const r = parseSpoolChunk('', '{"event":"stop"}\n{"event":"submit"}\n');
  assert.equal(r.truncate, false);
});

test('no truncate when a partial line is still buffered after a terminal', () => {
  const r = parseSpoolChunk('', '{"event":"stop"}\n{"event":"sub');
  assert.equal(r.truncate, false);
  assert.equal(r.leftover, '{"event":"sub');
});

// ─── route helpers ───────────────────────────────────────────────────────────

test('routeFromUrl strips the leading slash', () => {
  assert.equal(routeFromUrl('/spawn'), 'spawn');
  assert.equal(routeFromUrl('/message'), 'message');
  assert.equal(routeFromUrl(undefined), '');
  assert.equal(routeFromUrl('peers'), 'peers');
});

test('the five control-plane routes are forwarded; others are not', () => {
  for (const r of ['rename', 'spawn', 'peers', 'read', 'message']) {
    assert.equal(isForwarded(r), true, `${r} should forward`);
  }
  assert.equal(isForwarded('event'), false);
  assert.equal(isForwarded(''), false);
  assert.equal(FORWARDED_ROUTES.size, 5);
});

test('body caps match hooks-server.ts (1 MiB for spawn/message, 4 KiB otherwise)', () => {
  assert.equal(maxBodyBytesFor('spawn'), 1_048_576);
  assert.equal(maxBodyBytesFor('message'), 1_048_576);
  assert.equal(maxBodyBytesFor('rename'), 4096);
  assert.equal(maxBodyBytesFor('peers'), 4096);
  assert.equal(maxBodyBytesFor('event'), 4096);
});

// ─── DriveBroker (P4 item C) ─────────────────────────────────────────────────

test('first client to hello wins the drive; attach alone grants nothing', () => {
  const b = new DriveBroker<string>();
  b.attach('a');
  b.attach('b');
  assert.equal(b.hasDriver, false);
  assert.equal(b.isDriver('a'), false);

  assert.equal(b.hello('a', 'machine-a', 'Desktop'), true);
  assert.equal(b.isDriver('a'), true);
  assert.equal(b.hello('b', 'machine-b', 'Laptop'), false); // a still drives
  assert.equal(b.isDriver('b'), false);
});

test('takeControl transfers the drive explicitly', () => {
  const b = new DriveBroker<string>();
  b.attach('a');
  b.attach('b');
  b.hello('a', 'machine-a', 'Desktop');
  b.hello('b', 'machine-b', 'Laptop');

  assert.equal(b.takeControl('b'), true);
  assert.equal(b.isDriver('b'), true);
  assert.equal(b.isDriver('a'), false);
  assert.equal(b.takeControl('b'), false); // already driving — no change
  assert.equal(b.takeControl('nobody'), false); // unknown connection
});

test('a reconnect bearing the driver clientId resumes the drive', () => {
  const b = new DriveBroker<string>();
  b.attach('a1');
  b.hello('a1', 'machine-a', 'Desktop');
  b.attach('b');
  b.hello('b', 'machine-b', 'Laptop');

  // Same machine dials again on a fresh socket (old one not yet closed).
  b.attach('a2');
  assert.equal(b.hello('a2', 'machine-a', 'Desktop'), true);
  assert.equal(b.isDriver('a2'), true);
  assert.equal(b.isDriver('a1'), false);
});

test('driver detach promotes the longest-attached identified client', () => {
  const b = new DriveBroker<string>();
  b.attach('a');
  b.attach('anon'); // never says hello — not eligible
  b.attach('b');
  b.attach('c');
  b.hello('a', 'ma', 'A');
  b.hello('c', 'mc', 'C');
  b.hello('b', 'mb', 'B'); // hello order ≠ attach order; attach order wins

  assert.equal(b.detach('a'), true);
  assert.equal(b.isDriver('b'), true); // attached before c, identified

  assert.equal(b.detach('b'), true);
  assert.equal(b.isDriver('c'), true);

  assert.equal(b.detach('c'), true);
  assert.equal(b.hasDriver, false); // only the anonymous client remains
});

test('observer detach changes nothing', () => {
  const b = new DriveBroker<string>();
  b.attach('a');
  b.attach('b');
  b.hello('a', 'ma', 'A');
  b.hello('b', 'mb', 'B');
  assert.equal(b.detach('b'), false);
  assert.equal(b.isDriver('a'), true);
});

test('adoptIfVacant grandfathers a lone legacy client, never steals', () => {
  const b = new DriveBroker<string>();
  b.attach('legacy');
  assert.equal(b.adoptIfVacant('legacy'), true); // vacant → adopt
  assert.equal(b.isDriver('legacy'), true);

  b.attach('other');
  assert.equal(b.adoptIfVacant('other'), false); // occupied → no steal
});

test('stateFor computes isDriver per recipient and names the driver', () => {
  const b = new DriveBroker<string>();
  b.attach('a');
  b.attach('b');
  b.hello('a', 'machine-a', 'Desktop');
  b.hello('b', 'machine-b', 'Laptop');

  assert.deepEqual(b.stateFor('a'), {
    t: 'control',
    driverId: 'machine-a',
    driverName: 'Desktop',
    isDriver: true,
  });
  assert.deepEqual(b.stateFor('b'), {
    t: 'control',
    driverId: 'machine-a',
    driverName: 'Desktop',
    isDriver: false,
  });

  b.detach('a');
  b.detach('b');
  const empty = new DriveBroker<string>();
  empty.attach('x');
  assert.deepEqual(empty.stateFor('x'), {
    t: 'control',
    driverId: null,
    driverName: null,
    isDriver: false,
  });
});

test('an anonymous driver (adopted legacy) reports null ids but isDriver true', () => {
  const b = new DriveBroker<string>();
  b.attach('legacy');
  b.adoptIfVacant('legacy');
  assert.deepEqual(b.stateFor('legacy'), {
    t: 'control',
    driverId: null,
    driverName: null,
    isDriver: true,
  });
});
