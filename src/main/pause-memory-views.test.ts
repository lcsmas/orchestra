// D1 (ledger #329): `orchestra bus-status` must say a memory Pause is IN FORCE from the BUS (the runs actually paused with the memory motive), not from the guard's "due now".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as bus from './bus.ts';
import * as busRuns from './bus-runs.ts';
import { memoryPausedRunViews } from './pause-memory.ts';
import { DEFAULT_BUS_SWITCHES } from '../shared/bus-switches.ts';
import { encodeMemoryPause } from '../shared/pause-memory.ts';
import { encodePauseAuto } from '../shared/pause-auto.ts';
import { GIB, formatMemoryGuardLine, type MemoryGuardSnapshot } from '../shared/memory-guard.ts';

const ROOT = path.join(os.homedir(), '.cache', `pause-memory-views-${process.pid}`);
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
fs.mkdirSync(ROOT, { recursive: true });
const db = bus.openBus(path.join(ROOT, 'b.sqlite'));
for (const id of ['mem', 'resuming', 'manual', 'usage', 'stale', 'none']) busRuns.startRun(db, { id, kind: 'vague', coordinator: id }, { ...DEFAULT_BUS_SWITCHES, pause: true });

const T = 1_800_000_000_000;
const reason = { reason: 'memory' as const, pauseCycle: 1, episode: 1, availBytes: 2 * GIB, thresholdBytes: 3 * GIB };
const pause = (id: string, auto: string | null, o: { at?: number; resume?: number | null } = {}) =>
  db.prepare("UPDATE runs SET paused_at = ?, paused_by = 'host:memory', pause_mode = 'hard', pause_auto = ?, resume_started_at = ? WHERE id = ?").run(o.at ?? T, auto, o.resume ?? null, id);

test('no pause on the bus ⇒ no view', () => assert.deepEqual(memoryPausedRunViews(db), []));

test('a memory Pause (epoch-matched motive) is a view; a Reprise under way is flagged; manual / usage-limit / stale-epoch pauses are NOT memory pauses', () => {
  pause('mem', encodeMemoryPause(reason, T), { at: T });
  pause('resuming', encodeMemoryPause(reason, T + 5), { at: T + 5, resume: T + 99 });
  pause('manual', null);
  pause('usage', encodePauseAuto({ reason: 'usage_limit', wsIds: ['w'], accountIds: ['a'] } as never, T));
  pause('stale', encodeMemoryPause(reason, T - 1_000), { at: T });
  const names: Record<string, string> = { mem: 'bloc2-ops' };
  const v = memoryPausedRunViews(db, (id) => names[id]);
  assert.deepEqual(v.map((x) => x.runId), ['mem', 'resuming']);
  assert.deepEqual(v[0], { runId: 'mem', label: 'bloc2-ops', since: T, resuming: false });
  assert.equal(v[1].resuming, true);
  assert.equal(v[1].label, undefined);
});

test('D1 end to end: the guard says "due now: none" (memory recovered above critical) while the bus has a memory Pause ⇒ the line says IN EFFECT', () => {
  const snap: MemoryGuardSnapshot = {
    sampled: true, measured: true, availBytes: 4.2 * GIB, readAt: 1, admission: 'held', admissionEnabled: true, pause: 'none', episode: 1, pauseCycle: 1, mayReleaseOneStart: false,
    heldSince: 1, pauseSince: null, admissionBytes: 6 * GIB, criticalBytes: 3 * GIB, releaseMarginBytes: GIB, sampleIntervalMs: 10_000,
  };
  const line = formatMemoryGuardLine(snap, memoryPausedRunViews(db));
  assert.match(line, /memory Pause IN EFFECT on 2 run\(s\)/);
  assert.doesNotMatch(line, /memory Pause none/);
});

test('an unreadable bus is an empty list, never a throw (a pause read never breaks bus-status)', () => {
  assert.deepEqual(memoryPausedRunViews(null), []);
  const closed = bus.openBus(path.join(ROOT, 'c.sqlite'));
  closed.close();
  assert.deepEqual(memoryPausedRunViews(closed), []);
});
