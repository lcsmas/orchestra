import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __rebuildAdmissionForTests, admissionGate, createAdmission, heldStartFor, listHeldStarts, startAdmission, stopAdmission, type AdmissionDeps, type GateArgs } from './admission.ts';
import { __rebuildMemoryGuardForTests, setMemoryGuardSettingsReader } from './memory-guard.ts';
import { DEFAULT_MEMORY_GUARD_SETTINGS, GIB, type MemoryGuardSnapshot } from '../shared/memory-guard.ts';

const gb = (n: number) => n * GIB;

/** A world: the memory the fake guard reports (set per test), a hand-fired timer, a recorded clock, the log, and the starts that RAN. */
function world() {
  const w = {
    mem: 4 as number | null,           // GB; null = unreadable
    enabled: true,
    sampleThrows: false,
    samples: 0,
    now: 1_000_000,
    sleeps: [] as number[],
    timers: [] as Array<{ fn: () => void; ms: number }>,
    infos: [] as string[],
    warns: [] as string[],
    ran: [] as string[],
    deps: null as unknown as AdmissionDeps,
    /** A snapshot the way the real guard would report it for `w.mem` (held below 6, release room above 7). */
    snap(): MemoryGuardSnapshot {
      const avail = w.mem === null ? null : gb(w.mem);
      const measured = w.mem !== null;
      return {
        sampled: true, measured, availBytes: avail, readAt: 1, admission: measured && (w.mem as number) < 6 ? 'held' : 'open', admissionEnabled: w.enabled,
        pause: 'none', episode: 1, pauseCycle: 0, mayReleaseOneStart: measured && (w.mem as number) > 7, heldSince: null, pauseSince: null,
        admissionBytes: gb(6), criticalBytes: gb(3), releaseMarginBytes: gb(1), sampleIntervalMs: 10_000,
      };
    },
  };
  w.deps = {
    sample: () => { w.samples += 1; if (w.sampleThrows) { w.sampleThrows = false; throw new Error('guard hiccup'); } return w.snap(); },
    now: () => w.now,
    schedule: (fn, ms) => { const t = { fn, ms }; w.timers.push(t); return t; },
    cancel: (h) => { const i = w.timers.indexOf(h as { fn: () => void; ms: number }); if (i >= 0) w.timers.splice(i, 1); },
    sleep: async (ms) => { w.sleeps.push(ms); },
    retryMs: 10_000,
    settleMs: 3_000,
    runTimeoutMs: 90_000,
    info: (m) => w.infos.push(m),
    warn: (m) => w.warns.push(m),
  };
  return w;
}
const member = { parentId: 'ops' };
function args(w: ReturnType<typeof world>, wsId: string, over: Partial<GateArgs> = {}): GateArgs {
  return { wsId, ws: member, origin: 'auto', kind: 'spawn', coordinator: false, stillOwed: () => true, run: async () => { w.ran.push(wsId); }, ...over };
}

// ── positive control: the instrument can see a HOLD and a PASS ──
test('baseline: an auto start of a fleet member under 4 GB is held and nothing runs; at 12 GB with an empty line it passes', () => {
  const w = world();
  const a = createAdmission(w.deps);
  const held = a.gate(args(w, 'm1'));
  assert.deepEqual(held, { held: true, since: 1_000_000, kind: 'spawn' });
  assert.deepEqual(w.ran, []);
  assert.deepEqual(a.heldFor('m1'), { kind: 'spawn', since: 1_000_000 });
  w.mem = 12;
  const b = createAdmission(w.deps);
  assert.deepEqual(b.gate(args(w, 'm2')), { held: false });
});

test('human_and_non_member_pass_while_held: never queued', () => {
  const w = world();
  const a = createAdmission(w.deps);
  assert.deepEqual(a.gate(args(w, 'm1', { origin: 'human' })), { held: false });
  assert.deepEqual(a.gate(args(w, 'top', { ws: {} })), { held: false });
  assert.deepEqual(a.list(), []);
});

test('toggle_off_passes: the global toggle OFF holds nothing', () => {
  const w = world();
  w.enabled = false;
  assert.deepEqual(createAdmission(w.deps).gate(args(w, 'm1')), { held: false });
});

test('held_is_logged_with_memavailable', () => {
  const w = world();
  createAdmission(w.deps).gate(args(w, 'm1'));
  assert.match(w.warns[0], /HELD spawn of m1 — MemAvailable 4\.00 GB, Admission held; 1 held start\(s\)/);
});

test('release_order: coordinators first, then arrival order, ONE at a time, a FRESH sample before each release', async () => {
  const w = world();
  const a = createAdmission(w.deps);
  // each run takes "a while": a later one must not start until the earlier one settled (one at a time)
  let inFlight = 0, maxInFlight = 0;
  const slow = (id: string) => async () => { inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); await Promise.resolve(); await Promise.resolve(); w.ran.push(id); inFlight -= 1; };
  a.gate(args(w, 'worker-a', { run: slow('worker-a') }));
  a.gate(args(w, 'worker-b', { run: slow('worker-b') }));
  a.gate(args(w, 'sub-ops', { coordinator: true, run: slow('sub-ops') }));
  assert.deepEqual(w.ran, []);
  w.mem = 9;
  const before = w.samples;
  await a.kick();
  assert.deepEqual(w.ran, ['sub-ops', 'worker-a', 'worker-b']);
  assert.equal(maxInFlight, 1, 'one at a time');
  assert.ok(w.samples - before >= 3, `a fresh sample before EACH release (got ${w.samples - before})`);
  assert.deepEqual(w.sleeps, [3000, 3000], 'a settle pause between two releases (none after the last)');
  assert.deepEqual(a.list(), []);
  assert.ok(w.infos.some((l) => /RELEASED spawn of sub-ops \(coordinator\)/.test(l) && /MemAvailable 9\.00 GB/.test(l)));
});

test('dip_stops_release: memory falls back between two releases → the rest stay queued; the retry timer finishes the job after recovery', async () => {
  const w = world();
  const a = createAdmission(w.deps);
  const dipAfter = (id: string) => async () => { w.ran.push(id); if (id === 'a') w.mem = 6.8; }; // the first release eats the margin
  a.gate(args(w, 'a', { run: dipAfter('a') }));
  a.gate(args(w, 'b', { run: dipAfter('b') }));
  a.gate(args(w, 'c', { run: dipAfter('c') }));
  w.mem = 9;
  await a.kick();
  assert.deepEqual(w.ran, ['a'], 'b and c did NOT go out');
  assert.deepEqual(a.list().map((e) => e.wsId), ['b', 'c']);
  assert.ok(w.timers.some((t) => t.ms === 10_000), 'a retry is armed');
  assert.ok(w.infos.some((l) => /release waits \(memory\) — MemAvailable 6\.80 GB; 2 held start\(s\) stay queued/.test(l)));
  w.mem = 9;
  const t = w.timers[w.timers.length - 1];
  t.fn();
  await a.kick();
  assert.deepEqual(w.ran, ['a', 'b', 'c']);
  assert.deepEqual(a.list(), []);
});

test('waiting_is_logged_once_per_reason (no log spam on every retry)', async () => {
  const w = world();
  const a = createAdmission(w.deps);
  a.gate(args(w, 'a'));
  w.mem = 6.5;
  for (let i = 0; i < 4; i++) await a.kick();
  assert.equal(w.infos.filter((l) => /release waits \(memory\)/.test(l)).length, 1);
});

test('unmeasured_releases_nothing: a dead meter never releases a start (even a stale-true flag)', async () => {
  const w = world();
  const a = createAdmission(w.deps);
  a.gate(args(w, 'a'));
  w.mem = null;
  await a.kick();
  assert.deepEqual(w.ran, []);
  assert.ok(w.infos.some((l) => /release waits \(unmeasured\)/.test(l)));
});

test('newcomer_joins_the_line: memory is fine but earlier starts are still queued → the newcomer is queued BEHIND them, not run first; a human still passes', async () => {
  const w = world();
  const a = createAdmission(w.deps);
  a.gate(args(w, 'old'));
  w.mem = 6.5; // Admission open (hysteresis) but NO room to release: the old one still waits
  assert.deepEqual(a.gate(args(w, 'new')), { held: true, since: 1_000_000, kind: 'spawn' });
  assert.deepEqual(a.gate(args(w, 'old2', { origin: 'human' })), { held: false });
  assert.deepEqual(a.list().map((e) => e.wsId), ['old', 'new']);
  w.mem = 9;
  await a.kick();
  assert.deepEqual(w.ran, ['old', 'new']);
});

test('repeat_request_keeps_the_original_slot: a 2nd gate for the same workspace refreshes the action but keeps since + arrival', async () => {
  const w = world();
  const a = createAdmission(w.deps);
  const first = a.gate(args(w, 'a'));
  w.now += 5_000;
  a.gate(args(w, 'b'));
  w.now += 5_000;
  const again = a.gate(args(w, 'a', { kind: 'restart', run: async () => { w.ran.push('a:newest-request'); } }));
  assert.equal(again.held && again.since, first.held && first.since);
  assert.deepEqual(a.list().map((e) => [e.wsId, e.seq]), [['a', 1], ['b', 2]]);
  w.mem = 9;
  await a.kick();
  assert.deepEqual(w.ran, ['a:newest-request', 'b'], 'the NEWEST request is what runs, from the ORIGINAL arrival slot');
});

test('newcomer_triggers_the_release_when_memory_is_back: memory recovered but no guard edge came (no kick yet) → the next gate joins the line AND the line goes out, in order', async () => {
  const w = world();
  const a = createAdmission(w.deps);
  a.gate(args(w, 'old'));
  w.mem = 9; // recovered, but nothing kicked the queue
  assert.equal(a.gate(args(w, 'new')).held, true);
  for (let i = 0; i < 50 && w.ran.length < 2; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.ran, ['old', 'new']);
});

test('kick_during_wind_down_is_not_swallowed: a kick that lands while a pass is finishing re-runs the pass (the guard reopen edge can arrive exactly then)', async () => {
  const w = world();
  const a = createAdmission(w.deps);
  a.gate(args(w, 'a'));
  const p1 = a.kick(); // pass #1 samples 4 GB → waits
  w.mem = 9; // memory recovers while pass #1 is winding down
  const p2 = a.kick(); // single-flight returns pass #1's promise — it must still re-run
  await Promise.all([p1, p2]);
  assert.deepEqual(w.ran, ['a']);
});

test('not_owed_anymore_is_dropped_not_run: a workspace deleted / started by a human while held', async () => {
  const w = world();
  const a = createAdmission(w.deps);
  a.gate(args(w, 'gone', { stillOwed: () => false }));
  a.gate(args(w, 'kept'));
  w.mem = 9;
  await a.kick();
  assert.deepEqual(w.ran, ['kept']);
  assert.ok(w.infos.some((l) => /dropped held spawn of gone \(no longer wanted\)/.test(l)));
});

test('a throwing release is logged and the line moves on', async () => {
  const w = world();
  const a = createAdmission(w.deps);
  a.gate(args(w, 'boom', { run: async () => { throw new Error('start failed'); } }));
  a.gate(args(w, 'next'));
  w.mem = 9;
  await a.kick();
  assert.deepEqual(w.ran, ['next']);
  assert.ok(w.warns.some((l) => /released spawn of boom FAILED: start failed/.test(l)));
});

test('toggle_off_releases_the_queue_at_once (holds nothing) — even with no memory room', async () => {
  const w = world();
  const a = createAdmission(w.deps);
  a.gate(args(w, 'a'));
  w.enabled = false;
  await a.kick();
  assert.deepEqual(w.ran, ['a']);
});

test('stop clears the queue and the timer', () => {
  const w = world();
  const a = createAdmission(w.deps);
  a.gate(args(w, 'a'));
  assert.ok(w.timers.length > 0);
  a.stop();
  assert.deepEqual([a.list().length, w.timers.length], [0, 0]);
});

test('run_failure_is_logged_not_silent: a release whose start FAILS says so (with its reason) — never "RELEASED" and nothing else', async () => {
  const w = world();
  const a = createAdmission(w.deps);
  a.gate(args(w, 'bad', { run: async () => ({ ok: false, error: 'the agent failed to start: no credentials' }) }));
  w.mem = 9;
  await a.kick();
  assert.ok(w.warns.some((l) => /released spawn of bad FAILED: the agent failed to start: no credentials/.test(l)));
  assert.deepEqual(a.list(), [], 'a plain start failure is not retried by the queue (the start path reports it on the workspace)');
});

test('refused_while_paused_keeps_its_slot: a release refused by a fleet Pause stays queued in the SAME slot and goes out once the Pause lifts', async () => {
  const w = world();
  const a = createAdmission(w.deps);
  let paused = true;
  const attempts: string[] = [];
  a.gate(args(w, 'm1', { run: async () => { attempts.push('m1'); return paused ? { ok: false, error: 'run en pause' } : { ok: true }; }, retryLater: () => paused }));
  const before = a.list()[0];
  w.mem = 9;
  await a.kick();
  assert.deepEqual(attempts, ['m1'], 'tried once');
  assert.deepEqual(a.list().map((e) => [e.wsId, e.seq, e.since]), [[before.wsId, before.seq, before.since]], 'still queued, same slot');
  assert.ok(w.infos.some((l) => /was refused for now \(run en pause\) — kept queued/.test(l)));
  assert.ok(w.timers.length > 0, 'the retry is armed');
  paused = false;
  await a.kick();
  assert.deepEqual(attempts, ['m1', 'm1']);
  assert.deepEqual(a.list(), []);
});

test('hung_release_does_not_block_the_line: a start that never settles is abandoned after runTimeoutMs and the next goes out', async () => {
  const w = world();
  const a = createAdmission(w.deps);
  a.gate(args(w, 'hung', { run: () => new Promise<void>(() => {}) }));
  a.gate(args(w, 'next'));
  w.mem = 9;
  const pass = a.kick();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  const timer = w.timers.find((t) => t.ms === 90_000);
  assert.ok(timer, 'the bound is armed on the running release');
  timer.fn();
  await Promise.race([pass, new Promise((_, rej) => setTimeout(() => rej(new Error('the line is still blocked by the hung release')), 1500))]);
  assert.deepEqual(w.ran, ['next']);
  assert.ok(w.warns.some((l) => /released spawn of hung did not settle within 90 s — the line moves on/.test(l)));
});

test('repeat_auto_request_during_release_is_not_a_duplicate: a release is running for X → another automatic request for X is answered "held", never started twice', async () => {
  const w = world();
  const a = createAdmission(w.deps);
  let finish: () => void = () => {};
  a.gate(args(w, 'x', { run: () => new Promise<void>((r) => { w.ran.push('x'); finish = r; }) }));
  w.mem = 9;
  const pass = a.kick();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(w.ran, ['x'], 'the release is running');
  const again = a.gate(args(w, 'x', { run: async () => { w.ran.push('x-again'); } }));
  assert.deepEqual(again, { held: true, since: 1_000_000, kind: 'spawn' });
  finish();
  await pass;
  assert.deepEqual(w.ran, ['x'], 'no second start');
  assert.deepEqual(a.list(), []);
});

test('human_start_drops_the_held_entry: a person starting the held member itself supersedes it — peers / bus-status must not keep saying held', () => {
  const w = world();
  const a = createAdmission(w.deps);
  a.gate(args(w, 'm1'));
  a.gate(args(w, 'm2'));
  assert.deepEqual(a.gate(args(w, 'm1', { origin: 'human' })), { held: false });
  assert.deepEqual(a.list().map((e) => e.wsId), ['m2']);
  assert.equal(a.heldFor('m1'), null);
  assert.ok(w.infos.some((l) => /dropped held spawn of m1: a human started it/.test(l)));
});

test('retry_rearms_after_a_throwing_pass: the spent retry handle is cleared when it fires, so a pass that throws (the guard read blows up) still re-arms — the queue is never stranded', async () => {
  const w = world();
  const a = createAdmission(w.deps);
  a.gate(args(w, 'a'));
  w.mem = 9;
  const t = w.timers[w.timers.length - 1];
  assert.ok(t, 'armed by the hold');
  w.sampleThrows = true; // the NEXT sample (inside the retry's pass) throws
  t.fn();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.ok(w.warns.some((l) => /release pass threw/.test(l)));
  assert.ok(w.timers.length > 0, 'a new retry is armed — not stranded');
  assert.deepEqual(a.list().map((e) => e.wsId), ['a'], 'the entry was not lost');
  await a.kick();
  assert.deepEqual(w.ran, ['a']);
});

test('throwing_still_owed_is_treated_as_owed: a store hiccup while checking never loses a held start', async () => {
  const w = world();
  const a = createAdmission(w.deps);
  a.gate(args(w, 'a', { stillOwed: () => { throw new Error('store hiccup'); } }));
  w.mem = 9;
  await a.kick();
  assert.deepEqual(w.ran, ['a']);
  assert.ok(w.warns.some((l) => /stillOwed of held spawn of a threw — treated as still owed/.test(l)));
});

test('facade: the process-wide gate + the guard edge that reopens Admission triggers the release', async () => {
  const w = world();
  setMemoryGuardSettingsReader(() => DEFAULT_MEMORY_GUARD_SETTINGS);
  let mem: number | null = 4;
  const guard = __rebuildMemoryGuardForTests({ schedule: () => ({}), cancel: () => {}, info: () => {}, warn: () => {} }, () => (mem === null ? null : gb(mem)));
  guard.start();
  __rebuildAdmissionForTests({ ...w.deps, sample: () => guard.sampleNow() });
  startAdmission();
  assert.equal(admissionGate(args(w, 'a')).held, true);
  assert.deepEqual(heldStartFor('a'), { kind: 'spawn', since: 1_000_000 });
  assert.equal(listHeldStarts().length, 1);
  mem = 9; // recovery: the next sample crosses 7 GB → admission_reopened → the subscriber kicks
  guard.sampleNow();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.ran, ['a']);
  assert.equal(heldStartFor('a'), null);
  stopAdmission();
  guard.stop();
  __rebuildMemoryGuardForTests();
});
