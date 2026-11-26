// #607 — stepCi + stepStartCheck against HAND-MADE ports (no loop yet: #605). Each rule has a must-pass and a must-fail arm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTicketPatch, newState, parseState, type FanoutState } from './fanout-state.ts';
import { renderCiMessage, startCheckBranch, stepCi, stepStartCheck, type CiCtx, type CiOptions } from './fanout-loop-ci.ts';
import { pausedOf, resumeRun } from './fanout-state.ts';
import type { ForgeCheck as CheckInfo } from './fanout-loop-ports.ts';
type CiState = FanoutState;

const T = '2026-11-25T10:00:00.000Z';
const sha = (c: string): string => c.repeat(40);

type Script = Record<number, CheckInfo[]>; // PR → the checks the forge answers NOW (a test mutates it between passes)
function world(opts: { tickets?: Array<{ id: string; pr: number; head: string; deps?: string[]; implementer?: string | null }>; options?: CiOptions } = {}) {
  let s = newState('run1', { now: T }) as unknown as CiState;
  for (const t of opts.tickets ?? [{ id: 'A', pr: 1, head: sha('a') }]) {
    s = applyTicketPatch(s as unknown as FanoutState, t.id, { status: 'started', branch: `b-${t.id}`, pr: t.pr, head: t.head, ...(t.deps ? { dependsOn: t.deps, frozenInterface: 'x' } : {}), implementer: t.implementer === undefined ? `ws-${t.id}` : t.implementer }, T) as unknown as CiState;
  }
  const w = {
    state: s,
    script: {} as Script,
    reruns: [] as Array<{ n: number; names: string[] }>,
    wakes: [] as Array<{ ws: string; text: string }>,
    logs: [] as string[],
    failRerun: false,
    clock: Date.parse(T),
    ctx(): CiCtx {
      return {
        state: w.state,
        update: (m) => (w.state = m(w.state)),
        deps: {
          run: 'run1', now: () => new Date(w.clock).toISOString(), sleep: async () => {}, log: (l) => w.logs.push(l),
          fleet: { live: () => true, wake: async (ws, text) => { w.wakes.push({ ws, text }); } },
          forge: {
            openPr: async () => ({ n: 99 }), prState: async () => ({ state: 'open', head: sha('a') }),
            checks: async (n) => w.script[n] ?? [],
            rerun: async (n, names) => { if (w.failRerun) throw new Error('boom'); w.reruns.push({ n, names }); },
            merge: async () => ({ ok: true }), close: async () => {},
          },
          git: { head: async () => null, tree: async () => null, isMerged: async () => false },
          options: opts.options ?? {},
        },
      };
    },
    pass: () => stepCi(w.ctx()),
    /** the author pushed a fix: a new head on the ticket */
    push(id: string, head: string) { w.state = { ...w.state, tickets: { ...w.state.tickets, [id]: { ...w.state.tickets[id], head } } }; },
  };
  return w;
}
const red = (name: string, extra: Partial<CheckInfo> = {}): CheckInfo => ({ name, status: 'red', jobId: `${name}-1`, logExtract: `FAIL ${name}`, ...extra });
const green = (name: string): CheckInfo => ({ name, status: 'green' });
const pend = (name: string): CheckInfo => ({ name, status: 'pending' });

// ── re-run, flaky ───────────────────────────────────────────────────────────────────────────────────────────────
test('red → ONE automatic re-run of the red jobs only, no message to the author yet', async () => {
  const w = world();
  w.script[1] = [red('unit'), green('lint')];
  const r = await w.pass();
  assert.deepEqual(w.reruns, [{ n: 1, names: ['unit'] }]);
  assert.deepEqual(r.reran, ['A']);
  assert.equal(w.wakes.length, 0);
  await w.pass(); // CI has not restarted yet (same job id): nothing new
  assert.equal(w.reruns.length, 1, 'MUST-FAIL guard: the re-run happens once per head');
  assert.equal(w.wakes.length, 0, 'a stale red (same job id) is not "red again"');
});

test('the re-run goes green → listed flaky, the author is never told, the ticket stays open', async () => {
  const w = world();
  w.script[1] = [red('unit'), green('lint')];
  await w.pass();
  w.script[1] = [green('unit'), green('lint')];
  const r = await w.pass();
  assert.deepEqual(w.state.tickets.A.ci?.flaky, ['unit']);
  assert.deepEqual(r.flaky, ['A:unit']);
  assert.equal(w.wakes.length, 0);
  assert.equal(w.state.tickets.A.status, 'started');
});

test('MUST-FAIL: a check that never failed is not flaky; a green first run records nothing', async () => {
  const w = world();
  w.script[1] = [green('unit')];
  await w.pass();
  assert.equal(w.state.tickets.A.ci?.flaky.length ?? 0, 0);
  assert.equal(w.reruns.length, 0);
});

test('pending checks are waited for: no re-run, no message', async () => {
  const w = world();
  w.script[1] = [red('unit'), pend('e2e')];
  await w.pass();
  assert.equal(w.reruns.length, 0);
  w.script[1] = [];
  await w.pass();
  assert.equal(w.reruns.length, 0, 'no check yet = pending, not green and not red');
});

// ── the author ──────────────────────────────────────────────────────────────────────────────────────────────────
test('red again after the re-run → the author gets the check NAME and the LOG extract, once per head', async () => {
  const w = world();
  w.script[1] = [red('unit', { logExtract: 'AssertionError: expected 3 got 4 at orders.test.ts:12' })];
  await w.pass();
  w.script[1] = [red('unit', { jobId: 'unit-2', logExtract: 'AssertionError: expected 3 got 4 at orders.test.ts:12' })];
  const r = await w.pass();
  assert.deepEqual(r.told, ['A']);
  assert.equal(w.wakes.length, 1);
  assert.equal(w.wakes[0].ws, 'ws-A');
  assert.match(w.wakes[0].text, /Check: unit/);
  assert.match(w.wakes[0].text, /expected 3 got 4 at orders\.test\.ts:12/);
  await w.pass();
  await w.pass();
  assert.equal(w.wakes.length, 1, 'MUST-FAIL guard: waiting for the fix does not re-send the message');
  assert.equal(w.reruns.length, 1, 'and does not re-run again');
  assert.equal(w.state.tickets.A.status, 'started');
});

test('an author that cannot be woken is retried next pass (nothing recorded)', async () => {
  const w = world();
  w.script[1] = [red('unit')];
  await w.pass();
  w.script[1] = [red('unit', { jobId: 'unit-2' })];
  const ctx = w.ctx();
  ctx.deps.fleet.wake = async () => { throw new Error('gone'); };
  await stepCi(ctx);
  assert.equal(w.state.tickets.A.ci?.told, null);
  await w.pass();
  assert.equal(w.wakes.length, 1);
});

test('the same failure after the author\'s fix → ticket parked (cause ci), dependents parked, nobody woken again', async () => {
  const w = world({ tickets: [{ id: 'A', pr: 1, head: sha('a') }, { id: 'B', pr: 2, head: sha('b'), deps: ['A'] }, { id: 'C', pr: 3, head: sha('c'), deps: ['B'] }, { id: 'D', pr: 4, head: sha('d') }] });
  w.script[1] = [red('unit')];
  await w.pass();
  w.script[1] = [red('unit', { jobId: 'unit-2' })];
  await w.pass();
  assert.equal(w.wakes.length, 1);
  w.push('A', sha('1')); // the fix
  w.script[1] = [red('unit', { jobId: 'unit-3' })];
  const r = await w.pass();
  assert.deepEqual(r.parked, ['A']);
  assert.equal(w.state.tickets.A.status, 'parked');
  assert.equal(w.state.tickets.A.parked?.cause, 'ci');
  assert.match(w.state.tickets.A.parked?.reason ?? '', /unit/);
  assert.equal(w.state.tickets.B.parked?.blockedBy, 'A');
  assert.equal(w.state.tickets.C.status, 'parked');
  assert.equal(w.state.tickets.D.status, 'started', 'an unrelated ticket goes on');
  assert.equal(w.wakes.length, 1, 'parked, not told again');
  assert.equal(w.reruns.length, 1, 'no second re-run after a fix');
});

test('a DIFFERENT failure after the fix is a new message, not a park', async () => {
  const w = world();
  w.script[1] = [red('unit')];
  await w.pass();
  w.script[1] = [red('unit', { jobId: 'unit-2' })];
  await w.pass();
  w.push('A', sha('1'));
  w.script[1] = [red('lint')];
  await w.pass();
  assert.equal(w.state.tickets.A.status, 'started');
  assert.equal(w.wakes.length, 2);
  assert.match(w.wakes[1].text, /Check: lint/);
});

test('the fix turns it green → no park, the record keeps nothing to wait on', async () => {
  const w = world();
  w.script[1] = [red('unit')];
  await w.pass();
  w.script[1] = [red('unit', { jobId: 'unit-2' })];
  await w.pass();
  w.push('A', sha('1'));
  w.script[1] = [green('unit')];
  await w.pass();
  assert.equal(w.state.tickets.A.status, 'started');
  assert.equal(w.state.tickets.A.ci?.flaky.length, 0, 'a real fix is not flaky');
});

// ── the environment pause ───────────────────────────────────────────────────────────────────────────────────────
const two = (options?: CiOptions): ReturnType<typeof world> => world({ options, tickets: [{ id: 'A', pr: 1, head: sha('a') }, { id: 'B', pr: 2, head: sha('b') }, { id: 'C', pr: 3, head: sha('c') }] });

test('the same check red on two pull requests → the run pauses: no message, no re-run, the reason names check + PRs', async () => {
  const w = two();
  w.script[1] = [red('build'), green('lint')];
  w.script[2] = [red('build')];
  w.script[3] = [green('build')];
  const r = await w.pass();
  assert.equal(r.paused, true);
  const p = pausedOf(w.state);
  assert.equal(p?.check, 'build');
  assert.deepEqual(p?.prs, [1, 2]);
  assert.match(p?.reason ?? '', /build/);
  assert.equal(w.wakes.length, 0, 'no message to an author');
  assert.equal(w.reruns.length, 0);
  const again = await w.pass(); // a paused run does nothing
  assert.equal(again.paused, true);
  assert.equal(w.reruns.length + w.wakes.length, 0);
});

test('MUST-FAIL: one pull request red on a check is NOT the environment (the run goes through the re-run path)', async () => {
  const w = two();
  w.script[1] = [red('build')];
  w.script[2] = [green('build')];
  w.script[3] = [red('lint')];
  const r = await w.pass();
  assert.equal(r.paused, false);
  assert.equal(pausedOf(w.state), null);
  assert.deepEqual(w.reruns.map((x) => x.n).sort(), [1, 3]);
});

test('two DIFFERENT checks red on different pull requests are not the environment', async () => {
  const w = two();
  w.script[1] = [red('build')];
  w.script[2] = [red('lint')];
  assert.equal((await w.pass()).paused, false);
});

test('resume: the paused PRs are re-run once (the human fixed the environment), green is not flaky, a second environment red pauses again', async () => {
  const w = two();
  w.script[1] = [red('build')];
  w.script[2] = [red('build')];
  await w.pass();
  w.state = resumeRun(w.state, T);
  const r = await w.pass(); // checks still show the stale reds, same job ids
  assert.equal(r.paused, false, 'the acknowledged red is not counted again');
  assert.deepEqual(w.reruns.map((x) => x.n).sort(), [1, 2]);
  w.script[1] = [green('build')];
  w.script[2] = [green('build')];
  await w.pass();
  assert.equal(w.state.tickets.A.ci?.flaky.length, 0);
  assert.equal(w.state.tickets.B.ci?.flaky.length, 0);
  assert.equal(w.wakes.length, 0);
});

test('a resumed run whose environment is STILL red pauses AGAIN after the re-run — no author is ever told', async () => {
  const w = two();
  w.script[1] = [red('build')];
  w.script[2] = [red('build')];
  await w.pass();
  w.state = resumeRun(w.state, T);
  await w.pass(); // re-run (the stale reds were acknowledged)
  assert.equal(w.reruns.length, 2);
  w.script[1] = [red('build', { jobId: 'build-2' })];
  w.script[2] = [red('build', { jobId: 'build-2' })];
  const r = await w.pass();
  assert.equal(r.paused, true);
  assert.equal(pausedOf(w.state)?.check, 'build');
  assert.equal(w.wakes.length, 0);
});

test('resume with NO job ids (rerunSettleMs set): the acknowledged red is skipped until the re-run, a stale red inside the settle window is not counted, a fresh one pauses again', async () => {
  const w = two({ rerunSettleMs: 1000 });
  w.script[1] = [red('build', { jobId: undefined })];
  w.script[2] = [red('build', { jobId: undefined })];
  await w.pass();
  w.state = resumeRun(w.state, T);
  assert.equal((await w.pass()).paused, false);
  assert.equal(w.reruns.length, 2);
  assert.equal((await w.pass()).paused, false, 'inside the settle window the old red is the old run');
  w.clock += 2000;
  assert.equal((await w.pass()).paused, true);
  assert.equal(w.wakes.length, 0);
});

// ── pre-review findings (MAJOR 1-3, MINOR 1) ────────────────────────────────────────────────────────────────────
test('a DIFFERENT failure of the same check name after the fix is told, not parked (the log is part of the identity)', async () => {
  const w = world();
  w.script[1] = [red('test', { logExtract: 'FAIL a.test.ts expected 3 got 4' })];
  await w.pass();
  w.script[1] = [red('test', { jobId: 'test-2', logExtract: 'FAIL a.test.ts expected 3 got 4' })];
  await w.pass();
  w.push('A', sha('1'));
  w.script[1] = [red('test', { jobId: 'test-3', logExtract: 'TypeError: b is undefined at b.test.ts:9' })];
  await w.pass();
  assert.equal(w.state.tickets.A.status, 'started');
  assert.equal(w.wakes.length, 2);
});

test('the same failure with only its numbers changed (timings, line numbers, shas) IS the same failure → parked', async () => {
  const w = world();
  w.script[1] = [red('test', { logExtract: 'FAIL a.test.ts:12 expected 3 got 4 (118 ms) at 3f2a9c1' })];
  await w.pass();
  w.script[1] = [red('test', { jobId: 'test-2', logExtract: 'FAIL a.test.ts:12 expected 3 got 4 (118 ms) at 3f2a9c1' })];
  await w.pass();
  w.push('A', sha('1'));
  w.script[1] = [red('test', { jobId: 'test-3', logExtract: 'FAIL a.test.ts:15 expected 3 got 4 (97 ms) at 9b8c7d6' })];
  await w.pass();
  assert.equal(w.state.tickets.A.status, 'parked');
});

test('backstop: a noisy log cannot loop the run — told twice for the same checks, the third red parks', async () => {
  const w = world();
  w.script[1] = [red('test', { logExtract: 'noise one' })];
  await w.pass();
  w.script[1] = [red('test', { jobId: 'j2', logExtract: 'noise two' })];
  await w.pass(); // told 1
  w.push('A', sha('1'));
  w.script[1] = [red('test', { jobId: 'j3', logExtract: 'noise three' })];
  await w.pass(); // told 2
  w.push('A', sha('2'));
  w.script[1] = [red('test', { jobId: 'j4', logExtract: 'noise four' })];
  await w.pass();
  assert.equal(w.wakes.length, 2);
  assert.equal(w.state.tickets.A.status, 'parked');
});

test('a green in between closes the episode: a later red on another head is told afresh, not parked — and NOT re-run (one re-run per ticket in total)', async () => {
  const w = world();
  w.script[1] = [red('test')];
  await w.pass();
  w.script[1] = [red('test', { jobId: 'j2' })];
  await w.pass(); // told
  w.push('A', sha('1'));
  w.script[1] = [green('test')];
  await w.pass(); // fix works
  w.push('A', sha('2')); // review feedback
  w.script[1] = [red('test', { jobId: 'j3' })];
  await w.pass();
  assert.equal(w.state.tickets.A.status, 'started');
  assert.equal(w.reruns.length, 1, 'MUST-FAIL guard: a second episode gets no second re-run');
  assert.equal(w.wakes.length, 2);
});

test('a re-run that never reached the forge (same red run) is given up after the expiry: the author is told, NOT re-run again', async () => {
  const w = world({ options: { rerunExpireMs: 60_000 } });
  w.script[1] = [red('unit')];
  await w.pass();
  assert.equal(w.reruns.length, 1);
  await w.pass();
  assert.equal(w.wakes.length, 0, 'before the expiry: still waiting');
  w.clock += 61_000;
  await w.pass();
  assert.equal(w.reruns.length, 1, 'bounded: one re-run per ticket');
  assert.equal(w.wakes.length, 1);
});

// ── review r1 @c1fa4c01 (ledger #613 comment 7173156742) ───────────────────────────────────────────────────────
test('MAJOR 1: A\'s re-run (in flight when B went red) finishes red AFTER the resume → nobody is told, B is re-run, the run pauses again once B is red again', async () => {
  const w = two();
  w.script[1] = [red('unit', { jobId: 'A1' })];
  await w.pass(); // A re-run
  w.script[2] = [red('unit', { jobId: 'B1' })];
  assert.equal((await w.pass()).paused, true);
  w.state = resumeRun(w.state, T);
  w.script[1] = [red('unit', { jobId: 'A2' })]; // A's re-run result
  const r = await w.pass();
  assert.equal(r.paused, false);
  assert.equal(w.wakes.length, 0, 'the environment is not told to an author');
  assert.deepEqual(w.reruns.map((x) => x.n), [1, 1, 2], 'A (its re-run was spent) and B each get ONE environment re-run');
  w.script[1] = [red('unit', { jobId: 'A3' })];
  w.script[2] = [red('unit', { jobId: 'B2' })];
  assert.equal((await w.pass()).paused, true);
  assert.equal(w.wakes.length, 0);
});

test('MAJOR 1: the environment mark is forgotten once the check is green (a later red on that check is a normal red)', async () => {
  const w = two();
  w.script[1] = [red('unit')];
  w.script[2] = [red('unit')];
  await w.pass();
  w.state = resumeRun(w.state, T);
  await w.pass(); // both re-run
  w.script[1] = [green('unit')];
  w.script[2] = [green('unit')];
  await w.pass();
  assert.equal(w.state.tickets.A.ci?.env.length, 0);
  w.push('A', sha('1'));
  w.script[1] = [red('unit', { jobId: 'n1' })];
  await w.pass();
  assert.equal(w.reruns.length, 3, 'its own re-run was never spent (the environment one does not count): a normal red gets it');
  w.script[1] = [red('unit', { jobId: 'n2' })];
  await w.pass();
  assert.equal(w.wakes.length, 1, 'then told: it is no longer the environment');
});

test('MAJOR A: a ticket that spent its re-run BEFORE the pause is not stuck after the resume — environment re-run, then green (4 passes)', async () => {
  const w = two();
  w.script[1] = [red('unit', { jobId: 'A1' })];
  await w.pass(); // A: its one re-run
  w.script[2] = [red('unit', { jobId: 'B1' })];
  assert.equal((await w.pass()).paused, true);
  w.state = resumeRun(w.state, T);
  w.script[1] = [red('unit', { jobId: 'A2' })]; // A's own re-run finished red (the environment was still broken)
  await w.pass(); // A and B: environment re-run
  assert.deepEqual(w.reruns.map((x) => x.n), [1, 1, 2]);
  w.script[1] = [green('unit')]; // the environment was fixed
  w.script[2] = [green('unit')];
  for (let i = 0; i < 4; i++) { w.clock += 20 * 60_000; await w.pass(); }
  assert.equal(w.wakes.length, 0);
  assert.equal(w.state.tickets.A.ci?.env.length, 0);
  assert.equal(w.state.tickets.A.ci?.flaky.length, 0, 'an environment re-run is not flaky');
});

test('MAJOR A: the environment re-run is spent once — if A stays red alone (not two PRs), the author is told, never stuck', async () => {
  const w = two();
  w.script[1] = [red('unit', { jobId: 'A1' })];
  await w.pass();
  w.script[2] = [red('unit', { jobId: 'B1' })];
  await w.pass(); // pause
  w.state = resumeRun(w.state, T);
  w.script[1] = [red('unit', { jobId: 'A2' })];
  await w.pass(); // env re-runs
  w.script[1] = [red('unit', { jobId: 'A3', logExtract: 'FAIL real bug' })];
  w.script[2] = [green('unit')];
  for (let i = 0; i < 4; i++) { w.clock += 20 * 60_000; await w.pass(); }
  assert.equal(w.wakes.length, 1);
  assert.equal(w.wakes[0].ws, 'ws-A');
  assert.equal(w.reruns.length, 3, 'no further re-run');
});

test('an environment re-run stands in for the ticket\'s own: red alone after it, the author is told, no second re-run', async () => {
  const w = two();
  w.script[1] = [red('unit', { jobId: 'A1' })];
  w.script[2] = [red('unit', { jobId: 'B1' })];
  await w.pass(); // pause, nobody re-run yet
  w.state = resumeRun(w.state, T);
  await w.pass(); // environment re-runs
  assert.equal(w.reruns.length, 2);
  w.script[1] = [red('unit', { jobId: 'A2', logExtract: 'FAIL real' })];
  w.script[2] = [green('unit')];
  await w.pass();
  assert.equal(w.reruns.length, 2);
  assert.equal(w.wakes.length, 1);
});

test('m6: B depends on A; A pushed its fix and is still pending (or green but unmerged): B\'s old red is not its own — no re-run spent, nobody told', async () => {
  for (const upstream of [[pend('unit')], [green('unit')]]) {
    const w = world({ tickets: [{ id: 'A', pr: 1, head: sha('a') }, { id: 'B', pr: 2, head: sha('b'), deps: ['A'] }] });
    w.script[1] = upstream;
    w.script[2] = [red('unit')];
    await w.pass();
    assert.equal(w.reruns.filter((x) => x.n === 2).length, upstream[0].status === 'green' ? 1 : 0, 'pending upstream: held; green upstream: B red is its own again');
    assert.equal(w.wakes.length, 0);
  }
});

test('m6: once the upstream is MERGED a dependent\'s red is its own again', async () => {
  const w = world({ tickets: [{ id: 'A', pr: 1, head: sha('a') }, { id: 'B', pr: 2, head: sha('b'), deps: ['A'] }] });
  w.state = { ...w.state, tickets: { ...w.state.tickets, A: { ...w.state.tickets.A, status: 'merged' } } };
  w.script[2] = [red('unit')];
  await w.pass();
  assert.deepEqual(w.reruns.map((x) => x.n), [2]);
});

const stack = (): ReturnType<typeof world> => world({ tickets: [{ id: 'A', pr: 1, head: sha('a') }, { id: 'B', pr: 2, head: sha('b'), deps: ['A'] }, { id: 'C', pr: 3, head: sha('c'), deps: ['B'] }] });

test('MAJOR 2: a stack A→B→C with the same red on all three is A\'s fault — no pause; only A is re-run, then told; B and C wait', async () => {
  const w = stack();
  for (const n of [1, 2, 3]) w.script[n] = [red('unit')];
  const r = await w.pass();
  assert.equal(r.paused, false);
  assert.deepEqual(w.reruns.map((x) => x.n), [1]);
  w.script[1] = [red('unit', { jobId: 'u2' })];
  await w.pass();
  assert.deepEqual(w.wakes.map((x) => x.ws), ['ws-A']);
});

test('MAJOR 2 MUST-FAIL: the same check red on two UNRELATED pull requests of a stack still pauses', async () => {
  const w = world({ tickets: [{ id: 'A', pr: 1, head: sha('a') }, { id: 'B', pr: 2, head: sha('b'), deps: ['A'] }, { id: 'D', pr: 4, head: sha('d') }] });
  w.script[1] = [green('unit')];
  w.script[2] = [red('unit')]; // B red, its upstream A green: its own fault
  w.script[4] = [red('unit')];
  assert.equal((await w.pass()).paused, true);
});

test('m1: no job id from the forge → no re-run path (bounded): the author is told at once, the message says why', async () => {
  const w = world();
  w.script[1] = [red('unit', { jobId: undefined })];
  await w.pass();
  assert.equal(w.reruns.length, 0);
  assert.equal(w.wakes.length, 1);
  assert.match(w.wakes[0].text, /no automatic re-run/);
  await w.pass();
  await w.pass();
  assert.equal(w.reruns.length + w.wakes.length, 1);
});

test('m3: one re-run per TICKET in total — a second episode on a later head is not re-run', async () => {
  const w = world();
  w.script[1] = [red('a')];
  await w.pass();
  w.script[1] = [green('a')];
  await w.pass(); // flaky
  w.push('A', sha('1'));
  w.script[1] = [red('b')];
  await w.pass();
  assert.equal(w.reruns.length, 1);
  assert.equal(w.wakes.length, 1);
});

test('m5: the same log tail on ANOTHER check is not "the same failure"', async () => {
  const w = world();
  const tail = 'Process completed with exit code 1.';
  w.script[1] = [red('unit', { logExtract: tail })];
  await w.pass();
  w.script[1] = [red('unit', { jobId: 'u2', logExtract: tail })];
  await w.pass();
  w.push('A', sha('1'));
  w.script[1] = [red('lint', { jobId: 'l1', logExtract: tail })];
  await w.pass();
  assert.equal(w.state.tickets.A.status, 'started');
  assert.equal(w.wakes.length, 2);
});

// ── disposable ──────────────────────────────────────────────────────────────────────────────────────────────────
test('killed and started again: a fresh pass over the persisted state neither re-runs nor re-tells', async () => {
  const w = world();
  w.script[1] = [red('unit')];
  await w.pass();
  w.state = JSON.parse(JSON.stringify(w.state)); // a fresh process: only what the state keeps (parse of `rounds` arrives with #603)
  w.script[1] = [red('unit', { jobId: 'unit-2' })];
  await w.pass();
  w.state = JSON.parse(JSON.stringify(w.state));
  await w.pass();
  assert.equal(w.reruns.length, 1);
  assert.equal(w.wakes.length, 1);
});

test('a re-run the forge refused is retried (not counted as the one re-run)', async () => {
  const w = world();
  w.script[1] = [red('unit')];
  w.failRerun = true;
  await w.pass();
  assert.equal(w.state.tickets.A.ci?.rerun, null);
  w.failRerun = false;
  await w.pass();
  assert.equal(w.reruns.length, 1);
});

test('a checks() error skips the ticket for this pass only', async () => {
  const w = two();
  w.script[2] = [red('lint')];
  const ctx = w.ctx();
  const orig = ctx.deps.forge.checks;
  ctx.deps.forge.checks = async (n, h) => { if (n === 1) throw new Error('rate limited'); return orig(n, h); };
  await stepCi(ctx);
  assert.deepEqual(w.reruns.map((x) => x.n), [2]);
});

test('merged / parked / not-yet-open tickets are not read', async () => {
  const w = world({ tickets: [{ id: 'A', pr: 1, head: sha('a') }, { id: 'B', pr: 2, head: sha('b') }] });
  w.state = { ...w.state, tickets: { ...w.state.tickets, A: { ...w.state.tickets.A, status: 'parked' }, B: { ...w.state.tickets.B, pr: null } } };
  w.script[1] = [red('x')];
  await w.pass();
  assert.equal(w.reruns.length, 0);
});

test('the ci record round-trips the state file and refuses an unknown key', () => {
  let s = newState('r', { now: T });
  s = applyTicketPatch(s, 'A', { status: 'started', branch: 'a', head: sha('a'), pr: 1 }, T);
  const raw = JSON.parse(JSON.stringify(s));
  raw.tickets.A.ci = { head: sha('a'), rerun: { at: T, names: ['unit'], jobs: { unit: 'j1' } }, told: null, reruns: 1, seen: [], tells: { unit: 1 }, flaky: ['x'], env: [{ name: 'build', job: null }] };
  assert.deepEqual(parseState(raw).tickets.A.ci?.flaky, ['x']);
  raw.tickets.A.ci.extra = 1;
  assert.throws(() => parseState(raw), /unknown field "extra"/);
});

test('the author message names the check and carries the log tail', () => {
  const m = renderCiMessage(7, sha('a'), [red('unit', { logExtract: 'x'.repeat(5000) + 'TAIL' })]);
  assert.match(m, /#7/);
  assert.match(m, /TAIL/);
  assert.ok(m.length < 2000);
});

// ── the start check ─────────────────────────────────────────────────────────────────────────────────────────────
function probe(options: CiOptions, answers: CheckInfo[][]) {
  const w = world({ tickets: [{ id: 'A', pr: 1, head: sha('a') }], options });
  w.state = { ...w.state, tickets: { A: { ...w.state.tickets.A, status: 'todo', pr: null, head: null } } };
  const calls = { branches: [] as string[], closed: [] as number[], deleted: [] as string[], opened: [] as Array<{ branch: string; base: string }>, polls: 0, slept: 0 };
  const ctx = w.ctx();
  ctx.deps.git = { ...ctx.deps.git, emptyBranch: async (b) => { calls.branches.push(b); return { head: sha('e') }; }, deleteBranch: async (b) => { calls.deleted.push(b); } };
  ctx.deps.forge.openPr = async (i) => { calls.opened.push({ branch: i.branch, base: i.base }); return { n: 50 }; };
  ctx.deps.forge.close = async (n) => { calls.closed.push(n); };
  ctx.deps.forge.checks = async () => answers[Math.min(calls.polls++, answers.length - 1)];
  ctx.deps.sleep = async () => { calls.slept++; };
  return { ctx, calls };
}

test('start check OFF by default: nothing is opened', async () => {
  const { ctx, calls } = probe({}, [[red('ci')]]);
  assert.deepEqual(await stepStartCheck(ctx), { ok: true, skipped: 'off' });
  assert.equal(calls.opened.length + calls.branches.length, 0);
});

test('start check ON, green: one empty PR into the target, awaited, then closed and its branch deleted', async () => {
  const { ctx, calls } = probe({ startCheck: true, pollMs: 10 }, [[pend('ci')], [green('ci'), green('lint')]]);
  const r = await stepStartCheck(ctx);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(calls.opened, [{ branch: startCheckBranch('run1'), base: 'master' }]);
  assert.deepEqual(calls.closed, [50]);
  assert.deepEqual(calls.deleted, [startCheckBranch('run1')]);
  assert.equal(calls.slept, 1, 'it waited for the pending check');
});

test('start check: a RED check refuses the start, the PR and its branch are removed', async () => {
  const { ctx, calls } = probe({ startCheck: true }, [[red('ci', { logExtract: 'docker: command not found' })]]);
  const r = await stepStartCheck(ctx);
  assert.equal(r.ok, false);
  if (!r.ok) { assert.equal(r.code, 'start-check-red'); assert.deepEqual(r.checks, ['ci']); assert.match(r.detail, /docker: command not found/); }
  assert.deepEqual(calls.closed, [50]);
  assert.deepEqual(calls.deleted, [startCheckBranch('run1')]);
});

test('start check: a MISSING check (none after the grace) refuses the start; before the grace it keeps waiting', async () => {
  const { ctx, calls } = probe({ startCheck: true, pollMs: 60_000, startCheckMissingMs: 120_000 }, [[]]);
  const r = await stepStartCheck(ctx);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'start-check-missing');
  assert.equal(calls.slept, 2, 'MUST-FAIL guard: an empty list is not an instant refusal');
  assert.deepEqual(calls.closed, [50]);
  assert.deepEqual(calls.deleted, [startCheckBranch('run1')]);
});

test('start check: checks that never settle time out and refuse (cleaned)', async () => {
  const { ctx, calls } = probe({ startCheck: true, pollMs: 1000, startCheckTimeoutMs: 3000 }, [[pend('ci')]]);
  const r = await stepStartCheck(ctx);
  assert.equal(r.ok === false && r.code, 'start-check-timeout');
  assert.deepEqual(calls.closed, [50]);
});

test('start check is cleaned up when the forge throws, and the error is not swallowed', async () => {
  const { ctx, calls } = probe({ startCheck: true }, [[green('ci')]]);
  ctx.deps.forge.openPr = async () => { throw new Error('forge down'); };
  await assert.rejects(stepStartCheck(ctx), /forge down/);
  assert.deepEqual(calls.deleted, [startCheckBranch('run1')], 'the branch it created is removed');
});

test('start check is skipped once a ticket started (a restarted loop does not probe again); refused when the git port cannot probe', async () => {
  const { ctx } = probe({ startCheck: true }, [[red('ci')]]);
  ctx.state = { ...ctx.state, tickets: { A: { ...ctx.state.tickets.A, status: 'started' } } };
  assert.deepEqual(await stepStartCheck(ctx), { ok: true, skipped: 'already-started' });
  const q = probe({ startCheck: true }, [[green('ci')]]);
  q.ctx.deps.git = { head: async () => null, tree: async () => null, isMerged: async () => false };
  const r = await stepStartCheck(q.ctx);
  assert.equal(r.ok === false && r.code, 'start-check-unsupported');
});

test('m2: a forge outage on every poll is reported as such in the refusal detail', async () => {
  const { ctx } = probe({ startCheck: true, pollMs: 60_000, startCheckMissingMs: 120_000 }, [[]]);
  ctx.deps.forge.checks = async () => { throw new Error('HTTP 502 bad gateway'); };
  const r = await stepStartCheck(ctx);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.detail, /502 bad gateway/);
});

// ── stack C connect review (607 c2) ─────────────────────────────────────────────────────────────────────────────
test('c2: a dependent whose red was only CARRIED at the pause is not reported flaky once the environment is fixed (the mark goes to every ticket red on the blamed check)', async () => {
  const w = world({ tickets: [{ id: 'A', pr: 1, head: sha('a') }, { id: 'B', pr: 2, head: sha('b'), deps: ['A'] }, { id: 'C', pr: 3, head: sha('c') }] });
  w.script[1] = [red('unit', { jobId: 'A1' })];
  w.script[2] = [red('unit', { jobId: 'B1' })];
  w.script[3] = [red('unit', { jobId: 'C1' })];
  assert.equal((await w.pass()).paused, true, 'A and C: the environment (B is carried, not counted)');
  w.state = resumeRun(w.state, T);
  w.script[1] = [green('unit')];
  w.script[3] = [green('unit')];
  await w.pass(); // A merges? no: it is green and settled; B's red is no longer carried
  w.script[2] = [green('unit')];
  await w.pass();
  assert.deepEqual(w.state.tickets.B.ci?.flaky ?? [], [], 'the environment fault is not a flaky test');
  assert.equal(w.state.tickets.B.ci?.reruns, 0, 'its own re-run was never spent (an environment re-run does not count)');
});
