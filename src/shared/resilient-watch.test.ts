import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createResilientWatcher,
  describeWatchError,
  plainWatchError,
  WATCH_BACKOFF_MS,
  WATCH_HEALTH_MS,
  type ResilientWatchDeps,
  type ResilientWatchSpec,
  type WatcherSnapshot,
} from './resilient-watch.ts';

// #330 (wave H, ledger #329) — the resilient directory watcher, driven with an injected watch primitive and a FAKE CLOCK. What these arms assert is what an operator or a subsystem OBSERVES: the state a snapshot
// reports, whether the change callback fires, whether the catch-up pass runs, what the log says once. Never the number of timers.

const err = (code: string, message = `${code}: boom`): NodeJS.ErrnoException => Object.assign(new Error(message), { code });

interface FakeWatch {
  dir: string;
  closed: boolean;
  emit(event: string, filename: string | null): void;
  die(e: unknown): void;
}

function rig(opts: { inodes?: Map<string, number | null>; failArms?: Array<NodeJS.ErrnoException | null> } = {}) {
  let clock = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const watches: FakeWatch[] = [];
  const failArms = [...(opts.failArms ?? [])]; // consumed one per arm attempt; null / exhausted = succeed
  const logs: Array<{ level: 'warn' | 'info'; message: string }> = [];
  const transitions: WatcherSnapshot[] = [];
  const calls = { changes: [] as Array<string | null>, recover: 0, armed: [] as boolean[], armAttempts: 0, mkdirp: [] as string[] };

  const deps: ResilientWatchDeps = {
    watch(dir, onEvent, onError) {
      calls.armAttempts++;
      const next = failArms.shift();
      if (next) throw next;
      const w: FakeWatch = { dir, closed: false, emit: onEvent, die: onError };
      const origClose = () => {
        w.closed = true;
      };
      watches.push(w);
      return { close: origClose };
    },
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: clock + ms, fn });
      return id;
    },
    clearTimer(h) {
      timers.delete(h as number);
    },
    now: () => clock,
    mkdirp: (d) => void calls.mkdirp.push(d),
    inodeOf: opts.inodes ? (d) => (opts.inodes!.has(d) ? opts.inodes!.get(d)! : null) : undefined,
    warn: (message) => void logs.push({ level: 'warn', message }),
    info: (message) => void logs.push({ level: 'info', message }),
  };
  /** Advance the fake clock by `ms`, firing every timer that comes due (in order, including ones a fired timer schedules inside the window). */
  const advance = (ms: number): void => {
    const end = clock + ms;
    for (;;) {
      let pick: [number, { at: number; fn: () => void }] | undefined;
      for (const e of timers) if (e[1].at <= end && (!pick || e[1].at < pick[1].at)) pick = e;
      if (!pick) break;
      timers.delete(pick[0]);
      clock = Math.max(clock, pick[1].at);
      pick[1].fn();
    }
    clock = end;
  };
  const spec = (over: Partial<ResilientWatchSpec> = {}): ResilientWatchSpec => ({
    name: 'bus-wake',
    label: 'Réveils',
    dir: '/bus',
    fallback: '60 s sweep',
    onChange: (f) => void calls.changes.push(f),
    onRecover: () => void calls.recover++,
    onArmed: ({ recovered }) => void calls.armed.push(recovered),
    onTransition: (s) => void transitions.push(s),
    ...over,
  });
  return { deps, spec, advance, watches, timers, logs, transitions, calls, now: () => clock };
}

test('healthy arm: stays ok, no retry, no log, no catch-up (positive control)', () => {
  const r = rig();
  const w = createResilientWatcher(r.spec(), r.deps);
  w.start();
  assert.equal(w.snapshot().state, 'ok');
  assert.equal(w.snapshot().lastError, null);
  assert.equal(r.calls.armAttempts, 1);
  r.advance(10 * 60_000);
  assert.equal(r.calls.armAttempts, 1, 'a healthy watch is never re-armed');
  assert.deepEqual(r.logs, []);
  assert.equal(r.calls.recover, 0, 'the catch-up pass is for RECOVERY only, never the first arm');
  assert.deepEqual(r.calls.armed, [false]);
  assert.deepEqual(r.transitions, [], 'no transition on a healthy boot');
});

test('events reach onChange; the filter drops what the site does not care about (null filename passes)', () => {
  const r = rig();
  const w = createResilientWatcher(r.spec({ filter: (f) => f === null || f === 'bus.sqlite-wal' }), r.deps);
  w.start();
  r.watches[0].emit('change', 'bus.sqlite-wal');
  r.watches[0].emit('change', 'other.txt');
  r.watches[0].emit('rename', null);
  assert.deepEqual(r.calls.changes, ['bus.sqlite-wal', null]);
});

for (const code of ['EMFILE', 'ENOSPC', 'ENOENT']) {
  test(`${code} at arm → degraded with the error, retried on a BOUNDED backoff, recovered, catch-up once`, () => {
    const r = rig({ failArms: [err(code), err(code), err(code)] });
    const w = createResilientWatcher(r.spec(), r.deps);
    w.start();
    let s = w.snapshot();
    assert.equal(s.state, 'degraded');
    assert.equal(s.lastError?.code, code);
    assert.equal(s.fallback, '60 s sweep');
    assert.equal(r.calls.armAttempts, 1);
    r.advance(WATCH_BACKOFF_MS[0] - 1);
    assert.equal(r.calls.armAttempts, 1, 'first retry not before the first backoff step');
    r.advance(1);
    assert.equal(r.calls.armAttempts, 2, 'first retry at 1 s');
    r.advance(WATCH_BACKOFF_MS[1]);
    assert.equal(r.calls.armAttempts, 3, 'second retry 2 s later');
    assert.equal(w.snapshot().state, 'degraded');
    r.advance(WATCH_BACKOFF_MS[2]);
    assert.equal(r.calls.armAttempts, 4, 'third retry 5 s later — succeeds');
    s = w.snapshot();
    assert.equal(s.state, 'ok');
    assert.equal(s.lastError, null);
    assert.equal(s.attempts, 0);
    assert.equal(s.recoveries, 1);
    assert.equal(r.calls.recover, 1, 'ONE catch-up pass on recovery');
    assert.deepEqual(r.calls.armed, [true]);
    // and the recovered watch really delivers
    r.watches[0].emit('change', 'x');
    assert.deepEqual(r.calls.changes, ['x']);
  });
}

test('backoff is capped: a long outage retries every 60 s, never faster, never stops', () => {
  const r = rig({ failArms: Array.from({ length: 40 }, () => err('EMFILE')) });
  const w = createResilientWatcher(r.spec(), r.deps);
  w.start();
  // walk through the whole schedule once
  for (const step of WATCH_BACKOFF_MS) r.advance(step);
  const afterSchedule = r.calls.armAttempts;
  assert.equal(afterSchedule, 1 + WATCH_BACKOFF_MS.length);
  const cap = WATCH_BACKOFF_MS[WATCH_BACKOFF_MS.length - 1];
  assert.equal(cap, 60_000);
  r.advance(cap * 5);
  assert.equal(r.calls.armAttempts, afterSchedule + 5, 'one attempt per cap interval, forever');
  r.advance(cap - 1);
  assert.equal(r.calls.armAttempts, afterSchedule + 5, 'no attempt inside the interval');
  assert.equal(w.snapshot().state, 'degraded');
});

test('first retry lands within a few seconds (story 15)', () => {
  assert.ok(WATCH_BACKOFF_MS[0] <= 5_000);
  assert.ok(WATCH_BACKOFF_MS[WATCH_BACKOFF_MS.length - 1] <= 60_000);
  assert.deepEqual([...WATCH_BACKOFF_MS].sort((a, b) => a - b), [...WATCH_BACKOFF_MS], 'non-decreasing');
});

test('mid-life error event → degraded → re-armed on a NEW watch, old one closed, catch-up runs', () => {
  const r = rig();
  const w = createResilientWatcher(r.spec(), r.deps);
  w.start();
  r.watches[0].die(err('EMFILE'));
  assert.equal(w.snapshot().state, 'degraded');
  assert.equal(r.watches[0].closed, true, 'the dead watch is closed, not leaked');
  r.advance(WATCH_BACKOFF_MS[0]);
  assert.equal(w.snapshot().state, 'ok');
  assert.equal(r.watches.length, 2);
  assert.equal(r.calls.recover, 1);
  r.watches[1].emit('change', 'after');
  assert.deepEqual(r.calls.changes, ['after']);
});

test('a stale watch (closed, replaced) cannot act: late events and late errors are ignored', () => {
  const r = rig();
  const w = createResilientWatcher(r.spec(), r.deps);
  w.start();
  const old = r.watches[0];
  old.die(err('EMFILE'));
  r.advance(WATCH_BACKOFF_MS[0]);
  assert.equal(w.snapshot().state, 'ok');
  old.emit('change', 'ghost');
  old.die(err('EMFILE', 'late error from the closed watch'));
  assert.deepEqual(r.calls.changes, [], 'a closed watch does not call onChange');
  assert.equal(w.snapshot().state, 'ok', 'a closed watch cannot degrade the new one');
});

test('stop() cancels pending retries: nothing re-arms afterwards', () => {
  const r = rig({ failArms: [err('EMFILE'), err('EMFILE')] });
  const w = createResilientWatcher(r.spec(), r.deps);
  w.start();
  assert.equal(r.timers.size, 1, 'a retry is pending');
  w.stop();
  assert.equal(r.timers.size, 0);
  r.advance(10 * 60_000);
  assert.equal(r.calls.armAttempts, 1);
  assert.equal(r.watches.length, 0);
  assert.equal(r.calls.recover, 0);
});

test('stop() closes the live watch and the health timer; start() after stop() is a no-op; stop() twice is fine', () => {
  const r = rig({ inodes: new Map([['/bus', 7]]) });
  const w = createResilientWatcher(r.spec(), r.deps);
  w.start();
  assert.equal(r.timers.size, 1, 'the health check is scheduled');
  w.stop();
  assert.equal(r.watches[0].closed, true);
  assert.equal(r.timers.size, 0);
  w.stop();
  w.start();
  assert.equal(r.watches.length, 1);
  r.watches[0].emit('change', 'late');
  assert.deepEqual(r.calls.changes, []);
});

test('stop() during a degradation notifies a transition so the registry can drop it', () => {
  const r = rig({ failArms: [err('EMFILE')] });
  const w = createResilientWatcher(r.spec(), r.deps);
  w.start();
  const before = r.transitions.length;
  w.stop();
  assert.equal(r.transitions.length, before + 1);
});

test('logging is edge-triggered: ONE warn on degrade (naming the system limit), ONE info on recovery, none for failed retries', () => {
  const r = rig({ failArms: Array.from({ length: 5 }, () => err('EMFILE')) });
  const w = createResilientWatcher(r.spec(), r.deps);
  w.start();
  for (const step of WATCH_BACKOFF_MS.slice(0, 4)) r.advance(step);
  assert.equal(w.snapshot().state, 'degraded', 'still down after four failed retries');
  assert.deepEqual(
    r.logs.map((l) => l.level),
    ['warn'],
    'five failed arms, one line',
  );
  assert.match(r.logs[0].message, /system watch limit reached \(EMFILE\)/);
  assert.match(r.logs[0].message, /bus-wake/);
  assert.match(r.logs[0].message, /60 s sweep/);
  r.advance(WATCH_BACKOFF_MS[4]);
  assert.equal(w.snapshot().state, 'ok');
  assert.deepEqual(
    r.logs.map((l) => l.level),
    ['warn', 'info'],
  );
  assert.match(r.logs[1].message, /RECOVERED/);
  // a second degradation logs a second warn (edge-triggered, not once-per-process)
  r.watches[0].die(err('ENOSPC'));
  assert.deepEqual(
    r.logs.map((l) => l.level),
    ['warn', 'info', 'warn'],
  );
  assert.match(r.logs[2].message, /system watch limit reached \(ENOSPC\)/);
});

test('a non-limit error is NOT called a system limit', () => {
  const r = rig({ failArms: [err('ENOENT')] });
  createResilientWatcher(r.spec(), r.deps).start();
  assert.doesNotMatch(r.logs[0].message, /system watch limit/);
  assert.match(r.logs[0].message, /directory missing \(ENOENT\)/);
});

test('transitions: ok→degraded and degraded→ok only (never a repeat), with the snapshot the registry reads', () => {
  const r = rig({ failArms: [err('EMFILE'), err('EMFILE')] });
  const w = createResilientWatcher(r.spec(), r.deps);
  w.start();
  const t0 = r.now();
  r.advance(WATCH_BACKOFF_MS[0]); // second failure — still degraded, no new transition
  assert.equal(r.transitions.length, 1);
  assert.equal(r.transitions[0].state, 'degraded');
  assert.equal(r.transitions[0].since, t0);
  assert.equal(r.transitions[0].lastError?.code, 'EMFILE');
  r.advance(WATCH_BACKOFF_MS[1]);
  assert.deepEqual(
    r.transitions.map((t) => t.state),
    ['degraded', 'ok'],
  );
  assert.equal(r.transitions[1].since, r.now(), '`since` restarts at the recovery');
  assert.equal(r.transitions[1].recoveries, 1);
});

test('`since` is stable across failed retries (it is the start of the degradation)', () => {
  const r = rig({ failArms: [err('EMFILE'), err('EMFILE'), err('EMFILE')] });
  const w = createResilientWatcher(r.spec(), r.deps);
  w.start();
  const since = w.snapshot().since;
  r.advance(WATCH_BACKOFF_MS[0] + WATCH_BACKOFF_MS[1]);
  assert.equal(w.snapshot().state, 'degraded');
  assert.equal(w.snapshot().since, since);
  assert.equal(w.snapshot().attempts, 3);
});

test('ensureDir: the directory is created before EVERY arm attempt (a deleted dir is recreated on retry)', () => {
  const r = rig({ failArms: [err('ENOENT')] });
  createResilientWatcher(r.spec({ ensureDir: true }), r.deps).start();
  r.advance(WATCH_BACKOFF_MS[0]);
  assert.deepEqual(r.calls.mkdirp, ['/bus', '/bus']);
});

test('a throwing catch-up / onArmed / transition listener cannot break the watcher', () => {
  const r = rig({ failArms: [err('EMFILE')] });
  const w = createResilientWatcher(
    r.spec({
      onRecover: () => {
        throw new Error('catch-up blew up');
      },
      onArmed: () => {
        throw new Error('armed blew up');
      },
      onTransition: () => {
        throw new Error('listener blew up');
      },
    }),
    r.deps,
  );
  w.start();
  r.advance(WATCH_BACKOFF_MS[0]);
  assert.equal(w.snapshot().state, 'ok');
  assert.ok(r.logs.some((l) => /catch-up pass failed/.test(l.message)));
});

test('silent detach: the directory replaced under a live watch (new inode) is caught by the health check and re-armed', () => {
  const inodes = new Map<string, number | null>([['/bus', 11]]);
  const r = rig({ inodes });
  const w = createResilientWatcher(r.spec(), r.deps);
  w.start();
  r.advance(WATCH_HEALTH_MS); // same inode: nothing happens
  assert.equal(w.snapshot().state, 'ok');
  assert.equal(r.calls.armAttempts, 1);
  inodes.set('/bus', 22); // deleted + recreated: the inotify watch is dead and never said so
  r.advance(WATCH_HEALTH_MS);
  assert.equal(w.snapshot().state, 'degraded');
  assert.equal(w.snapshot().lastError?.code, 'ESTALE');
  assert.equal(r.watches[0].closed, true);
  r.advance(WATCH_BACKOFF_MS[0]);
  assert.equal(w.snapshot().state, 'ok');
  assert.equal(r.watches.length, 2);
  assert.equal(r.calls.recover, 1, 'whatever was written into the new directory is caught up');
  // the re-armed watch is checked against the NEW inode: no loop
  r.advance(WATCH_HEALTH_MS * 3);
  assert.equal(w.snapshot().state, 'ok');
  assert.equal(r.calls.armAttempts, 2);
});

test('silent detach: the watched directory vanishing is degraded (ENOENT), then recovered when it is back', () => {
  const inodes = new Map<string, number | null>([['/bus', 11]]);
  const r = rig({ inodes });
  const w = createResilientWatcher(r.spec(), r.deps);
  w.start();
  inodes.delete('/bus');
  r.advance(WATCH_HEALTH_MS);
  assert.equal(w.snapshot().state, 'degraded');
  assert.equal(w.snapshot().lastError?.code, 'ENOENT');
  inodes.set('/bus', 12);
  r.advance(WATCH_BACKOFF_MS[0]);
  assert.equal(w.snapshot().state, 'ok');
});

test('no inodeOf dep → no health timer (sites without a directory identity pay nothing)', () => {
  const r = rig();
  createResilientWatcher(r.spec(), r.deps).start();
  assert.equal(r.timers.size, 0);
});

test('describeWatchError / plainWatchError', () => {
  assert.deepEqual(describeWatchError(err('EMFILE', 'EMFILE: too many open files, watch')), { code: 'EMFILE', message: 'EMFILE: too many open files, watch' });
  assert.deepEqual(describeWatchError('plain string'), { code: null, message: 'plain string' });
  assert.deepEqual(describeWatchError(undefined), { code: null, message: 'undefined' });
  assert.equal(plainWatchError({ code: 'ENOSPC', message: 'x' }), 'system watch limit reached (ENOSPC)');
  assert.equal(plainWatchError({ code: null, message: 'weird' }), 'weird');
  assert.equal(plainWatchError({ code: 'EACCES', message: 'denied' }), 'denied (EACCES)');
});

test('the persistent option is forwarded to the primitive only when the site set it', () => {
  const seen: Array<unknown> = [];
  const r = rig();
  const base = r.deps.watch;
  const deps: ResilientWatchDeps = {
    ...r.deps,
    watch: (dir, onEvent, onError, opts) => {
      seen.push(opts);
      return base(dir, onEvent, onError, opts);
    },
  };
  createResilientWatcher(r.spec(), deps).start();
  createResilientWatcher(r.spec({ name: 'login', persistent: false }), deps).start();
  assert.deepEqual(seen, [undefined, { persistent: false }]);
});
