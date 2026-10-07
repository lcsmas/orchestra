import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMISSION_RETRY_MS, ADMISSION_RUN_TIMEOUT_MS, ADMISSION_SETTLE_MS, realAdmissionDeps, __rebuildAdmissionForTests, admissionGate, createAdmission, heldStartFor, listHeldStarts, startAdmission, stopAdmission, type AdmissionDeps, type GateArgs } from './admission.ts';
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

test('kick_during_wind_down_is_not_swallowed: a kick that lands AFTER the running pass sampled "wait" but BEFORE it finished re-runs the pass (the guard reopen edge can arrive exactly then; the next retry may be 10 s away)', async () => {
  const w = world();
  const a = createAdmission(w.deps);
  a.gate(args(w, 'a'));
  const p1 = a.kick(); // the body is queued in a microtask (draining is set)
  await Promise.resolve(); // …it has now run: the pass sampled 4 GB, said "wait", and is winding down (draining still set)
  w.mem = 9; // memory recovers in that window
  const p2 = a.kick(); // single-flight: must NOT be swallowed — it asks the running pass to go round again
  await Promise.all([p1, p2]);
  assert.deepEqual(w.ran, ['a']);
});

test('not_owed_anymore_is_dropped_not_run: a workspace deleted / started by a human AFTER it was queued is dropped at RELEASE time, never run', async () => {
  const w = world();
  const a = createAdmission(w.deps);
  let owed = true;
  a.gate(args(w, 'gone', { stillOwed: () => owed }));
  a.gate(args(w, 'kept')); // the gate's own prune ran while `gone` was still owed — only the release-time check can drop it now
  owed = false;
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
  w.now += 5_000; // time passes: the in-flight answer must carry the ORIGINAL since, not a fresh one (seat 2 B16)
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
  w.timers.splice(w.timers.indexOf(t), 1); // a timer that FIRED is no longer pending (the fake never removed it: `timers.length > 0` was vacuously true — mutant A21 survived on it)
  assert.equal(w.timers.length, 0, 'control: nothing pending while the retry fires');
  t.fn();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.ok(w.warns.some((l) => /release pass threw/.test(l)));
  assert.equal(w.timers.length, 1, 'exactly ONE new retry is armed — not stranded');
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

test('subscribe_then_reconcile: an edge that landed BEFORE startAdmission subscribed is not lost — the boot reconcile releases what is already queued', async () => {
  const w = world();
  setMemoryGuardSettingsReader(() => DEFAULT_MEMORY_GUARD_SETTINGS);
  let mem: number | null = 4;
  const guard = __rebuildMemoryGuardForTests({ schedule: () => ({}), cancel: () => {}, info: () => {}, warn: () => {} }, () => (mem === null ? null : gb(mem)));
  guard.start();
  __rebuildAdmissionForTests({ ...w.deps, sample: () => guard.sampleNow() });
  assert.equal(admissionGate(args(w, 'a')).held, true);
  mem = 9;
  guard.sampleNow(); // admission_reopened is emitted NOW — nobody subscribed yet, the edge is gone
  assert.deepEqual(w.ran, []);
  startAdmission();
  for (let i = 0; i < 20 && w.ran.length < 1; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.ran, ['a'], 'the reconcile kick found memory back and released it');
  stopAdmission();
  guard.stop();
  __rebuildMemoryGuardForTests();
});

test('facade: the process-wide gate + the guard edge that reopens Admission triggers the release', async () => {
  const w = world();
  setMemoryGuardSettingsReader(() => DEFAULT_MEMORY_GUARD_SETTINGS);
  let mem: number | null = 4;
  const guard = __rebuildMemoryGuardForTests({ schedule: () => ({}), cancel: () => {}, info: () => {}, warn: () => {} }, () => (mem === null ? null : gb(mem)));
  guard.start();
  __rebuildAdmissionForTests({ ...w.deps, sample: () => guard.sampleNow() });
  startAdmission();
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); // the boot-reconcile kick finishes (nothing queued yet): from here the guard EDGE is the only thing that can release
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

// ─── G3 review fix round (F1 F2 F3 F4) ──────────────────────────────────────────────────────────────────────────────────────────────

/** The reviewer's scenario: recovery is seen FIRST by the release pass's OWN fresh sample (no explicit guard.sampleNow outside the pass). */
async function ownSampleScenario(nEntries: number) {
  const w = world();
  setMemoryGuardSettingsReader(() => DEFAULT_MEMORY_GUARD_SETTINGS);
  let mem = 4;
  const guard = __rebuildMemoryGuardForTests({ schedule: () => ({}), cancel: () => {}, info: () => {}, warn: () => {} }, () => gb(mem));
  guard.start();
  __rebuildAdmissionForTests({ ...w.deps, sample: () => guard.sampleNow(), sleep: async () => {} });
  startAdmission();
  await new Promise((r) => setImmediate(r));
  let inflight = 0, maxInflight = 0;
  const started: string[] = [];
  const resolvers: Array<() => void> = [];
  for (let i = 1; i <= nEntries; i++) {
    const id = `m${i}`;
    const r = admissionGate(args(w, id, { run: () => { started.push(id); inflight++; maxInflight = Math.max(maxInflight, inflight); return new Promise((res) => resolvers.push(() => { inflight--; res({ ok: true }); })); } }));
    assert.equal(r.held, true);
  }
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(w.timers.length, 1, 'the retry is armed');
  mem = 12; // recovered — but NO guard sample has run: whoever samples next is the first to see it
  w.timers[0].fn(); // the 10 s retry fires: the pass's own sample emits admission_reopened → the subscriber's kick() re-enters
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  const snapshot = { started: [...started], maxInflight };
  while (resolvers.length) { resolvers.shift()!(); for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); }
  const finalStarted = [...started];
  stopAdmission();
  guard.stop();
  __rebuildMemoryGuardForTests();
  return { ...snapshot, finalStarted };
}

test('own_sample_recovery_releases_one_at_a_time: the pass\'s OWN sample is the first to see the recovery → ONE release per fresh reading, never two concurrent passes (F1)', async () => {
  const one = await ownSampleScenario(1);
  assert.deepEqual(one.started, ['m1'], 'control: a single entry is released once');
  const r = await ownSampleScenario(3);
  assert.deepEqual(r.started, ['m1'], 'only the FIRST is started until it settles (it was [m1, m2] with two concurrent passes)');
  assert.equal(r.maxInflight, 1);
  assert.deepEqual(r.finalStarted, ['m1', 'm2', 'm3'], 'and they all go out in order afterwards');
});

test('pause_refused_does_not_block_the_line: a Pause-refused entry at the head keeps its slot but the entries behind it (any run) and newcomers still start (F2)', async () => {
  const w = world();
  const a = createAdmission(w.deps);
  let xPaused = true;
  const xRuns: string[] = [];
  // (a mutant that picks the refused entry again inside the same pass would spin forever: after 6 tries the Pause "lifts" so the test FAILS on the count instead of hanging)
  a.gate(args(w, 'X1', { kind: 'restart', run: async () => { xRuns.push('X1'); if (xRuns.length > 6) xPaused = false; return xPaused ? { ok: false, error: 'run en pause' } : { ok: true }; }, retryLater: () => xPaused }));
  a.gate(args(w, 'Y1'));
  w.mem = 12;
  await a.kick();
  assert.deepEqual(w.ran, ['Y1'], 'Y1 (another run) started although X1 is refused');
  assert.deepEqual(a.list().map((e) => e.wsId), ['X1'], 'X1 kept its slot');
  assert.deepEqual(xRuns, ['X1'], 'tried once in this pass (not in a tight loop)');
  assert.ok(w.timers.some((t) => t.ms === 10_000), 'a retry is armed for it');
  // a brand-new automatic start at 12 GB while the refused one still sits in the queue: it joins the line AND goes out
  assert.deepEqual(a.gate(args(w, 'Z1')).held, true);
  for (let i = 0; i < 20 && !w.ran.includes('Z1'); i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.ran, ['Y1', 'Z1']);
  const triesWhilePaused = xRuns.length; // each pass tries the refused one ONCE (the retry + the newcomer's pass) — never a tight loop
  assert.ok(triesWhilePaused >= 1 && triesWhilePaused <= 3, `tries while paused: ${triesWhilePaused}`);
  xPaused = false;
  await a.kick();
  assert.equal(xRuns.length, triesWhilePaused + 1, 'after the Pause lifts it is released from its own slot, once');
  assert.deepEqual(w.ran, ['Y1', 'Z1'], 'X1\'s run records in xRuns, not in ran');
  assert.deepEqual(a.list(), []);
});

test('pause_refused_coordinator_does_not_block_workers: even a refused COORDINATOR (released first) lets the workers behind it go', async () => {
  const w = world();
  const a = createAdmission(w.deps);
  a.gate(args(w, 'ops-sub', { coordinator: true, run: async () => ({ ok: false, error: 'run en pause' }), retryLater: () => true }));
  a.gate(args(w, 'worker'));
  w.mem = 12;
  await a.kick();
  assert.deepEqual(w.ran, ['worker']);
  assert.deepEqual(a.list().map((e) => e.wsId), ['ops-sub']);
});

test('failed_release_is_reported_to_the_coordinator: a release that FAILS (or times out) tells the coordinator through `report`, once, with the reason (F4)', async () => {
  const w = world();
  const a = createAdmission(w.deps);
  const told: string[] = [];
  a.gate(args(w, 'bad', { run: async () => ({ ok: false, error: 'mid-turn refusal' }), report: (t) => told.push(t) }));
  a.gate(args(w, 'ok1'));
  w.mem = 9;
  await a.kick();
  assert.equal(told.length, 1);
  assert.match(told[0], /the spawn of bad that was HELD for memory since .* was released but did NOT start — mid-turn refusal\. It is not queued any more: retry it with `orchestra restart bad`\./);
  assert.deepEqual(w.ran, ['ok1'], 'the line moved on');
  // a plain success / a Pause-refusal (kept queued) are NOT reported
  const told2: string[] = [];
  w.mem = 4; // held again (a gate at plentiful memory passes straight through — and the checks below would be vacuous)
  a.gate(args(w, 'fine', { report: (t) => told2.push(t) }));
  assert.equal(a.list().length, 1, 'control: `fine` is really queued');
  a.gate(args(w, 'paused', { run: async () => ({ ok: false, error: 'run en pause' }), retryLater: () => true, report: (t) => told2.push(t) }));
  assert.equal(a.list().length, 2, 'control: `paused` is really queued too');
  w.mem = 9;
  await a.kick();
  assert.deepEqual(told2, []);
  assert.deepEqual(a.list().map((e) => e.wsId), ['paused'], '`fine` ran, `paused` kept its slot');
  // a report that throws never breaks the line
  w.mem = 4;
  a.gate(args(w, 'bad2', { run: async () => ({ ok: false, error: 'x' }), report: () => { throw new Error('bus down'); } }));
  a.gate(args(w, 'after'));
  w.mem = 9;
  await a.kick();
  assert.ok(w.ran.includes('after'));
  assert.ok(w.warns.some((l) => /could not report the failed release of bad2/.test(l)));
});

test('timed_out_release_is_reported: a hung start that never settles tells the coordinator too', async () => {
  const w = world();
  const a = createAdmission(w.deps);
  const told: string[] = [];
  a.gate(args(w, 'hung', { run: () => new Promise<void>(() => {}), report: (t) => told.push(t) }));
  w.mem = 9;
  const pass = a.kick();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  w.timers.find((t) => t.ms === 90_000)!.fn();
  await pass;
  assert.equal(told.length, 1);
  assert.match(told[0], /did not settle within 90 s/);
});

test('drop_forgets_a_deleted_workspace: drop() removes it from the list, the marker and the "non-empty line" rule (F4)', () => {
  const w = world();
  const a = createAdmission(w.deps);
  a.gate(args(w, 'gone'));
  a.gate(args(w, 'stays'));
  assert.equal(a.drop('gone'), true);
  assert.equal(a.drop('gone'), false);
  assert.deepEqual(a.list().map((e) => e.wsId), ['stays']);
  assert.equal(a.heldFor('gone'), null);
  a.drop('stays');
  assert.equal(w.timers.length, 0, 'an empty queue disarms the retry');
  w.mem = 12;
  assert.deepEqual(a.gate(args(w, 'new')), { held: false }, 'no phantom line: memory is fine and nobody is queued');
});

test('superseded_entry_is_pruned_by_list_alone: list() prunes on its own (no heldFor first)', () => {
  const w = world();
  const a = createAdmission(w.deps);
  let owed = true;
  a.gate(args(w, 'm1', { stillOwed: () => owed }));
  owed = false;
  assert.deepEqual(a.list(), []);
});

test('superseded_entry_is_pruned_by_gate_alone: the gate prunes on its own — a newcomer never joins a line made only of superseded entries', () => {
  const w = world();
  const a = createAdmission(w.deps);
  let owed = true;
  a.gate(args(w, 'm1', { stillOwed: () => owed }));
  owed = false;
  w.mem = 12;
  assert.deepEqual(a.gate(args(w, 'new')), { held: false }, 'no heldFor / list call before it: the gate itself pruned');
  assert.deepEqual(a.list(), []);
});

test('superseded_entry_is_pruned_at_read_time: a member a person started meanwhile stops showing as held (peers / bus-status) without waiting for a release pass (F4)', () => {
  const w = world();
  const a = createAdmission(w.deps);
  let owed = true;
  a.gate(args(w, 'm1', { stillOwed: () => owed }));
  assert.ok(a.heldFor('m1'));
  owed = false; // a composer start (not through the two gates) made the restart redundant
  assert.equal(a.heldFor('m1'), null);
  assert.deepEqual(a.list(), []);
  assert.ok(w.infos.some((l) => /dropped held spawn of m1 \(no longer wanted\)/.test(l)));
  w.mem = 12;
  assert.deepEqual(a.gate(args(w, 'new')), { held: false }, 'and it no longer makes a newcomer join a line');
});

// ─── seat 2's gap list (c/6041378956): each clause that changed and no test pinned ──────────────────────────────────────────────────

test('B03 in_flight_marker_is_cleared: after a release COMPLETES, a new automatic request for the same workspace is a NEW hold (new since, queued) — never the stale "in flight" answer', async () => {
  const w = world();
  const a = createAdmission(w.deps);
  a.gate(args(w, 'x'));
  w.mem = 9;
  await a.kick();
  assert.deepEqual(w.ran, ['x']);
  w.mem = 4;
  w.now += 60_000;
  const again = a.gate(args(w, 'x'));
  assert.deepEqual(again, { held: true, since: 1_060_000, kind: 'spawn' }, 'since is the NEW hold time');
  assert.deepEqual(a.list().map((e) => e.wsId), ['x'], 'and it is really queued (a stale in-flight marker answered "held" without queueing)');
});

test('B05/B06/B07 the shipped timing constants: retry 10 s, settle 3 s, run bound 90 s — and the real deps use them', () => {
  assert.equal(ADMISSION_RETRY_MS, 10_000);
  assert.equal(ADMISSION_SETTLE_MS, 3_000);
  assert.equal(ADMISSION_RUN_TIMEOUT_MS, 90_000);
  const d = realAdmissionDeps();
  assert.deepEqual([d.retryMs, d.settleMs, d.runTimeoutMs], [10_000, 3_000, 90_000]);
});

test('B08 stopAdmission clears the queue (and the timer) — nothing survives a shutdown', () => {
  const w = world();
  setMemoryGuardSettingsReader(() => DEFAULT_MEMORY_GUARD_SETTINGS);
  __rebuildAdmissionForTests({ ...w.deps });
  assert.equal(admissionGate(args(w, 'a')).held, true);
  assert.equal(listHeldStarts().length, 1);
  stopAdmission();
  assert.deepEqual([listHeldStarts().length, heldStartFor('a')], [0, null]);
  assert.equal(w.timers.length, 0);
});

test('B10 list() carries every field consumers read: wsId, kind, seq, since, coordinator', () => {
  const w = world();
  const a = createAdmission(w.deps);
  a.gate(args(w, 'worker'));
  w.now += 1_000;
  a.gate(args(w, 'sub', { coordinator: true, kind: 'restart' }));
  assert.deepEqual(a.list(), [
    { wsId: 'worker', kind: 'spawn', seq: 1, since: 1_000_000, coordinator: false },
    { wsId: 'sub', kind: 'restart', seq: 2, since: 1_001_000, coordinator: true },
  ]);
});

test('B15 a repeat request refreshes stillOwed: the NEWEST closure decides whether the entry is still wanted', async () => {
  const w = world();
  const a = createAdmission(w.deps);
  a.gate(args(w, 'x', { stillOwed: () => true }));
  a.gate(args(w, 'x', { stillOwed: () => false })); // the newer request says: not wanted any more
  assert.equal(a.heldFor('x'), null, 'the refreshed closure is the one consulted');
  w.mem = 9;
  await a.kick();
  assert.deepEqual(w.ran, []);
});
