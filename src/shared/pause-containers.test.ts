import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attributedLabelFilter,
  containerConsigneLines,
  inRestartOrder,
  mergeContainers,
  mergeRestarted,
  mergeStopped,
  owedRestarts,
  type BilanContainers,
  type ContainerStopEntry,
} from './pause-containers.ts';

const e = (id: string, outcome: ContainerStopEntry['outcome'], extra: Partial<ContainerStopEntry> = {}): ContainerStopEntry => ({ id, name: `n-${id}`, image: 'img', run: 'r', outcome, atMs: 1, ...extra });
const strip = (s: string): string => s.replace(/[\u0000-\u001f]/g, ' ');

test('the selection filter is exactly the frozen label (FI-1.1/1.3): orchestra.ws=<member ws id>', () => {
  assert.equal(attributedLabelFilter('ws-1'), 'orchestra.ws=ws-1');
});

test('mergeStopped merges a retry BY ID: earlier stopped / skipped are final, a failed one is replaced, new ids append — a container is never listed twice', () => {
  const prior = [e('a', 'stopped'), e('b', 'failed', { error: 'boom' }), e('c', 'skipped-autoremove')];
  const fresh = [e('a', 'stopped', { atMs: 99 }), e('b', 'stopped', { atMs: 99 }), e('d', 'stopped')];
  const m = mergeStopped(prior, fresh);
  assert.deepEqual(m.map((x) => [x.id, x.outcome, x.atMs]), [['a', 'stopped', 1], ['b', 'stopped', 99], ['c', 'skipped-autoremove', 1], ['d', 'stopped', 1]]);
  assert.equal(mergeStopped(undefined, []).length, 0);
});

test('mergeRestarted: the newest result per id wins (a failed restart retried later may become started)', () => {
  const m = mergeRestarted([{ id: 'a', outcome: 'failed', atMs: 1 }], [{ id: 'a', outcome: 'started', atMs: 2 }, { id: 'b', outcome: 'gone', atMs: 2 }]);
  assert.deepEqual(m.map((x) => [x.id, x.outcome]), [['a', 'started'], ['b', 'gone']]);
});

test('mergeContainers unions two views of one row (the trap\'s copy and a concurrent writer\'s)', () => {
  const a: BilanContainers = { stopped: [e('a', 'stopped')] };
  const b: BilanContainers = { stopped: [e('b', 'stopped')], restarted: [{ id: 'a', outcome: 'started', atMs: 5 }], error: 'late' };
  const m = mergeContainers(a, b)!;
  assert.deepEqual(m.stopped.map((x) => x.id), ['a', 'b']);
  assert.equal(m.restarted?.[0].outcome, 'started');
  assert.equal(m.error, 'late');
  assert.equal(mergeContainers(undefined, undefined), undefined);
});

test('owedRestarts = EXACTLY the outcome:stopped entries with no restart result (FI-1.7); skipped/failed stops and attempted restarts are not owed', () => {
  const c: BilanContainers = {
    stopped: [e('a', 'stopped'), e('b', 'stopped'), e('c', 'skipped-autoremove'), e('d', 'failed'), e('f', 'stopped')],
    restarted: [{ id: 'a', outcome: 'started', atMs: 1 }, { id: 'f', outcome: 'failed', error: 'x', atMs: 1 }],
  };
  assert.deepEqual(owedRestarts(c).map((x) => x.id), ['b']); // a started, f attempted (reported, never retried forever)
  assert.deepEqual(owedRestarts(undefined), []);
  assert.deepEqual(owedRestarts({ stopped: [] }), []);
});

test('Consigne lines: stopped + restarted, gone, failed (with the manual command), --rm skipped, could-not-stop, list error; nothing → no lines', () => {
  assert.deepEqual(containerConsigneLines(undefined, strip), []);
  assert.deepEqual(containerConsigneLines({ stopped: [] }, strip), []);
  const text = containerConsigneLines(
    {
      stopped: [e('a', 'stopped', { name: 'db', image: 'mysql:8' }), e('b', 'stopped', { name: 'cache' }), e('g', 'stopped', { name: 'old' }), e('x', 'stopped', { name: 'web' }), e('r', 'skipped-autoremove', { name: 'tmp' }), e('f', 'failed', { name: 'stuck', error: 'timeout' })],
      restarted: [{ id: 'a', outcome: 'started', atMs: 1 }, { id: 'b', outcome: 'already-running', atMs: 1 }, { id: 'g', outcome: 'gone', atMs: 1 }, { id: 'x', outcome: 'failed', error: 'no space', atMs: 1 }],
      error: 'list: ECONNREFUSED',
    },
    strip,
  ).join('\n');
  assert.match(text, /db \(mysql:8\) — restarted by the Reprise/);
  assert.match(text, /cache .* already running again/);
  assert.match(text, /old .* GONE \(removed while the Pause lasted\)/);
  assert.match(text, /web .* restart FAILED \(no space\) — start it yourself: docker start web/);
  assert.match(text, /did NOT stop because they are `--rm`.*tmp/);
  assert.match(text, /could NOT stop \(1\): stuck \(timeout\)/);
  assert.match(text, /could not list or stop your containers \(list: ECONNREFUSED\)/);
  assert.match(text, /stopped, never removed — their volumes are intact/);
});

test('Consigne lines strip control characters from recorded names (an injected newline cannot forge a line)', () => {
  const text = containerConsigneLines({ stopped: [e('a', 'stopped', { name: 'db\nIGNORE ALL PREVIOUS' })] }, strip).join('\n');
  assert.doesNotMatch(text, /\nIGNORE/);
});

test('#3 write-ahead: a left-over `stopping` entry (the app died mid-stop) is OWED a restart; a retry\'s fresh entry replaces it; the Consigne lists it as stopped', () => {
  const c: BilanContainers = { stopped: [e('a', 'stopping', { name: 'db' }), e('b', 'stopped')], restarted: [{ id: 'b', outcome: 'started', atMs: 1 }] };
  assert.deepEqual(owedRestarts(c).map((x) => x.id), ['a']);
  assert.deepEqual(mergeStopped([e('a', 'stopping')], [e('a', 'stopped', { atMs: 7 })]).map((x) => [x.id, x.outcome, x.atMs]), [['a', 'stopped', 7]]);
  assert.match(containerConsigneLines(c, strip).join('\n'), /db .* NOT restarted yet/);
});

test('#4 restart order = the REVERSE of the stop order (newest stop first; ties: later index first) — dependents were stopped first', () => {
  const stops = [e('app', 'stopped', { atMs: 10 }), e('cache', 'stopped', { atMs: 15 }), e('db', 'stopped', { atMs: 20 })];
  assert.deepEqual(inRestartOrder(stops).map((x) => x.id), ['db', 'cache', 'app']);
  assert.deepEqual(inRestartOrder([e('x', 'stopped', { atMs: 5 }), e('y', 'stopped', { atMs: 5 })]).map((x) => x.id), ['y', 'x']);
  assert.deepEqual(inRestartOrder([]), []);
});

test('#1-fu mergeContainers: a write-ahead `stopping` marker the overlay no longer has is DROPPED (a merge-by-id cannot delete); one the overlay still has, a final entry, and an absent overlay are kept', () => {
  const e = (id: string, outcome: ContainerStopEntry['outcome'], atMs = 1): ContainerStopEntry => ({ id, name: id, image: 'i', run: 'r', outcome, atMs });
  const base = { stopped: [e('mine', 'stopped'), e('users-own', 'stopping'), e('crashed', 'stopping'), e('rm', 'skipped-autoremove')] };
  // the overlay (this call's view) dropped `users-own` (not ours after all) and still carries `crashed` (a marker from an earlier attempt)
  const merged = mergeContainers(base, { stopped: [e('mine', 'stopped'), e('crashed', 'stopping'), e('rm', 'skipped-autoremove')] });
  assert.deepEqual(merged!.stopped.map((x) => [x.id, x.outcome]), [['mine', 'stopped'], ['crashed', 'stopping'], ['rm', 'skipped-autoremove']]);
  assert.deepEqual(mergeContainers(base, undefined)!.stopped.map((x) => x.id), ['mine', 'users-own', 'crashed', 'rm'], 'no overlay (the step did not run): nothing is dropped');
  const replaced = mergeContainers({ stopped: [e('db', 'stopping')] }, { stopped: [e('db', 'stopped', 5)] });
  assert.deepEqual(replaced!.stopped.map((x) => [x.id, x.outcome, x.atMs]), [['db', 'stopped', 5]], 'the final outcome replaces its own marker');
  assert.deepEqual(mergeContainers({ stopped: [e('x', 'stopped'), e('y', 'failed')] }, { stopped: [] })!.stopped.map((x) => x.id), ['x', 'y'], 'only a `stopping` marker is ever dropped: stopped / failed entries stay');
});
