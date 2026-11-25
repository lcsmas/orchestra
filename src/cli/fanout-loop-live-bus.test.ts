// #614 — the live FleetPort's mail protocol against the REAL bus (src/main/bus.ts on a real SQLite file) and the REAL `verbCheck` / `verbAck`: the shapes the port parses are the shapes the verbs print, a plain
// `check` never acks (a killed loop re-reads its lot), the ack of the previous pass is what moves the cursor, and a bus `question` is the loop's `ask`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as bus from '../main/bus.ts';
import * as busRuns from '../main/bus-runs.ts';
import { withReceipt } from '../main/bus-receipts.ts';
import { verbAck, verbCheck, type BusVerbCtx } from './bus-verbs.ts';
import { createLiveFleet, type Cli } from '../shared/fanout-loop-live-fleet.ts';

const RUN = 'run-live';
function setup(t: { after: (fn: () => void) => void }): { cli: Cli; post: (kind: 'status' | 'question' | 'worker_done', sender: string, body: string) => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-bus-'));
  const db = bus.openBus(path.join(dir, 'bus.sqlite'));
  t.after(() => { try { db.close(); } catch { /* closed */ } fs.rmSync(dir, { recursive: true, force: true }); });
  const ctx = (out: string[], fails: string[]): BusVerbCtx => ({
    db,
    bus: { send: bus.send, check: bus.check, ack: bus.ack, openGate: bus.openGate, resolveGate: bus.resolveGate, getGate: bus.getGate, sendGateResolutionRewake: bus.sendGateResolutionRewake, openGatesForRecipient: bus.openGatesForRecipient, openGatesForRecipientInRuns: bus.openGatesForRecipientInRuns, getRelatedRunIds: busRuns.getRelatedRunIds, getRun: busRuns.getRun, fencedWrite: bus.fencedWrite, mintCapability: bus.mintCapability, verifyCapability: bus.verifyCapability, rotateCapabilityForRecipient: bus.rotateCapabilityForRecipient, withReceipt, busSwitch: () => false },
    id: { runId: RUN, handle: RUN },
    out: (s) => out.push(s),
    fail: ((m: string) => { fails.push(m); throw new Error(m); }) as BusVerbCtx['fail'],
    generation: null, fencingOn: false,
  });
  const cli: Cli = async (args) => {
    const out: string[] = [], fails: string[] = [];
    try {
      if (args[0] === 'check') verbCheck(ctx(out, fails), { ackPrevious: false, markdown: false, limit: Number(args[args.indexOf('--limit') + 1]) });
      else if (args[0] === 'ack') verbAck(ctx(out, fails), args[1]);
      else return { code: 1, stdout: '', stderr: `unsupported ${args.join(' ')}` };
      return { code: 0, stdout: out.join(''), stderr: '' };
    } catch (e) { return { code: 1, stdout: '', stderr: fails[0] ?? String(e) }; }
  };
  return { cli, post: (kind, sender, body) => { bus.send(db, { runId: RUN, sender, recipient: RUN, kind, body }); } };
}
const fleetOn = (cli: Cli) => createLiveFleet({ run: RUN, caller: RUN, cli, host: async () => ({ ok: true, live: [] }), readState: () => null });

test('real bus: a question arrives as `ask`, in order, once; the lot is acked when the NEXT pass starts', async (t) => {
  const b = setup(t);
  const f = await fleetOn(b.cli);
  b.post('question', 'ws-a', 'NO SAFE OPTION: the spec contradicts itself');
  b.post('status', 'ws-b', 'nominated');
  const m1 = await f.mail();
  assert.deepEqual(m1.map((m) => [m.kind, m.sender, m.body]), [['ask', 'ws-a', 'NO SAFE OPTION: the spec contradicts itself'], ['status', 'ws-b', 'nominated']]);
  assert.ok(m1[0].seq < m1[1].seq);
  assert.deepEqual(await f.mail(), [], 'the previous lot was acked at the start of this pass, nothing new');
});

test('real bus: a loop killed after reading the lot reads it AGAIN (never lost); an acked one is not replayed', async (t) => {
  const b = setup(t);
  b.post('question', 'ws-a', 'which name?');
  const first = await fleetOn(b.cli);
  assert.equal((await first.mail()).length, 1);
  // killed here: no ack. A new loop on the same bus:
  const second = await fleetOn(b.cli);
  assert.deepEqual((await second.mail()).map((m) => m.body), ['which name?'], 'replayed');
  await second.close(); // the pass finished: acked
  const third = await fleetOn(b.cli);
  assert.deepEqual(await third.mail(), [], 'acked: gone');
});

test('real bus: MUST-FAIL control — a reader that acks on read (`check` then `ack` at once) loses the lot of a loop killed mid-pass', async (t) => {
  const b = setup(t);
  b.post('question', 'ws-a', 'which name?');
  const raw = JSON.parse((await b.cli(['check', '--limit', '10'])).stdout) as { lot: number };
  await b.cli(['ack', String(raw.lot)]); // the broken protocol: ack before the work is done
  const after = await fleetOn(b.cli); // the restarted loop
  assert.deepEqual(await after.mail(), [], 'the question is gone — exactly what the live port must not do');
});
