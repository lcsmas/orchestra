import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBus } from './bus.ts';
import { startRun } from './bus-runs.ts';
import { sendGated } from './memory-notice-bus.ts';
import { DEFAULT_BUS_SWITCHES } from '../shared/bus-switches.ts';

// The shipped gate, on a REAL scratch bus: the Plafond mémoire's message follows the run's frozen `liveness` switch, and an unread-mail topology is said, not hidden.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-bus-'));
const db = openBus(path.join(dir, 'bus.sqlite'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

startRun(db, { id: 'run-on', kind: 'vague', coordinator: 'coord' }, { ...DEFAULT_BUS_SWITCHES, liveness: true });
startRun(db, { id: 'run-off', kind: 'vague', coordinator: 'coord' }, { ...DEFAULT_BUS_SWITCHES, liveness: false });
const msg = (runId: string, recipient = 'coord') => ({ runId, sender: 'member', recipient, kind: 'escalation' as const, body: 'x' });
const rows = (runId: string) => db.prepare('SELECT kind, sender, recipient FROM messages WHERE run_id = ?').all(runId) as Array<{ kind: string; sender: string; recipient: string }>;

test('round 2 F6: liveness ON ⇒ the message is written; liveness OFF ⇒ «counted, not fired» and nothing is written', () => {
  const warns: string[] = [];
  const log = { warn: (m: string) => warns.push(m) };
  assert.equal(sendGated(db, msg('run-on'), log), 'sent');
  assert.deepEqual(rows('run-on'), [{ kind: 'escalation', sender: 'member', recipient: 'coord' }]);
  assert.equal(sendGated(db, msg('run-off'), log), 'counted');
  assert.deepEqual(rows('run-off'), [], 'OFF writes nothing');
  assert.deepEqual(warns, [], 'a matching coordinator is not a warning');
});

test('round 2 F6: a run whose coordinator is NOT the recipient (a parent that is not an orchestrator: unread mail) is written but SAID; an unknown run reads as OFF', () => {
  const warns: string[] = [];
  const log = { warn: (m: string) => warns.push(m) };
  assert.equal(sendGated(db, msg('run-on', 'someone-else'), log), 'sent');
  assert.ok(warns.some((w) => /has coordinator coord, not someone-else .* may never be read/.test(w)), warns.join(' | '));
  assert.equal(sendGated(db, msg('no-such-run'), log), 'counted', 'no run row ⇒ no frozen switch ⇒ OFF');
});

test('B03: a liveness switch that CANNOT be read is OFF — «counted», nothing written, and said once (a failed read never fails open into a bus write)', () => {
  const warns: string[] = [];
  const log = { warn: (m: string) => warns.push(m) };
  const before = rows('run-on').length;
  let prepares = 0; // only the FIRST read fails (the switch read): any later statement works, so a gate that fails open would really WRITE and the row count would move
  const broken = new Proxy(db, { get: (t, k) => (k === 'prepare' ? (...a: unknown[]) => { if (prepares++ === 0) throw new Error('SQLITE_BUSY: database is locked'); return (t as never as { prepare: (...x: unknown[]) => unknown }).prepare(...a); } : (t as never)[k as never]) });
  assert.equal(sendGated(broken, msg('run-on'), log), 'counted');
  assert.equal(rows('run-on').length, before, 'nothing written for a run whose switch is ON when the read failed');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /liveness switch read failed for run run-on - treating as OFF/);
});
