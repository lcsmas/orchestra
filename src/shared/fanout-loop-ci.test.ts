// #607 — stepCi + stepStartCheck against HAND-MADE ports (no loop yet: #605). Each rule has a must-pass and a must-fail arm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTicketPatch, newState, parseState, type FanoutState } from './fanout-state.ts';
import { renderCiMessage, startCheckBranch, stepCi, stepStartCheck, type CiCtx, type CiOptions } from './fanout-loop-ci.ts';
import { pausedOf, resumeRun, type CheckInfo, type CiState } from './fanout-loop-ci-stubs.ts';

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
const two = (): ReturnType<typeof world> => world({ tickets: [{ id: 'A', pr: 1, head: sha('a') }, { id: 'B', pr: 2, head: sha('b') }, { id: 'C', pr: 3, head: sha('c') }] });

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
  w.state = resumeRun(w.state);
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
  w.state = resumeRun(w.state);
  await w.pass(); // re-run (the stale reds were acknowledged)
  assert.equal(w.reruns.length, 2);
  w.script[1] = [red('build', { jobId: 'build-2' })];
  w.script[2] = [red('build', { jobId: 'build-2' })];
  const r = await w.pass();
  assert.equal(r.paused, true);
  assert.equal(pausedOf(w.state)?.check, 'build');
  assert.equal(w.wakes.length, 0);
});

test('resume with NO job ids: the acknowledged red is skipped until the re-run is recorded, then it counts again', async () => {
  const w = two();
  w.script[1] = [red('build', { jobId: undefined })];
  w.script[2] = [red('build', { jobId: undefined })];
  await w.pass();
  w.state = resumeRun(w.state);
  assert.equal((await w.pass()).paused, false);
  assert.equal(w.reruns.length, 2);
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

test('a green in between closes the episode: a later red on another head is re-run and told afresh, not parked', async () => {
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
  assert.equal(w.reruns.length, 2, 'the flaky red of the new episode gets its own re-run');
});

test('a re-run that never reached the forge (same red run, nothing pending) is retried after the expiry, not waited on forever', async () => {
  const w = world({ options: { rerunExpireMs: 60_000 } });
  w.script[1] = [red('unit')];
  await w.pass();
  assert.equal(w.reruns.length, 1);
  w.reruns.length = 0; // pretend the call was lost
  await w.pass();
  assert.equal(w.reruns.length, 0, 'before the expiry: still waiting');
  w.clock += 61_000;
  await w.pass(); // expiry: record cleared
  await w.pass();
  assert.equal(w.reruns.length, 1);
  assert.equal(w.wakes.length, 0);
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
  raw.tickets.A.ci = { head: sha('a'), rerun: { at: T, names: ['unit'], jobs: { unit: 'j1' } }, told: null, everTold: false, seen: [], tells: { unit: 1 }, flaky: ['x'], env: [{ name: 'build', job: null }] };
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
