// P4 (#169) — the OLD channel refuses fleet coordination on a bus (delivery-ON)
// run, keeps delivery-OFF + `--emergency` escapes.
//
// TWO LAYERS, on purpose:
//  1. PURE decision (`decideMessageChannel`, src/shared) — the four-cell truth
//     table, driven directly.
//  2. The REAL WRAPPER BODY (`dispatchMessageRequest` in workspaces.ts) extracted
//     and evaluated against a REAL SQLite bus + the REAL `busSwitch`/`startRun`,
//     so the arms prove the SHIPPED wiring resolves the switch and gates on it —
//     not a hand-model of it (the #116 rig header's lesson: a model fails in the
//     passing direction). `workspaces.ts` cannot import under `node --test`
//     (Electron seam), so this is the same extract-and-eval technique
//     bus-mirror.test.ts uses, with the same source-binding guard.
//
// MUTATION PROOF: `runWrapper` can DISABLE the gate (`gated: false`) to stand in
// for the pre-#169 build. Every gating arm asserts the outcome FLIPS between
// gated/ungated — the refusal arm DELIVERS when ungated (the pre-fix behaviour
// the ticket names), so a green arm on the unfixed wrapper is impossible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBus, type BusDb } from './bus.ts';
import { startRun, busSwitch } from './bus-runs.ts';
import { DEFAULT_BUS_SWITCHES } from '../shared/bus-switches.ts';
import { deliverToTargets, normalizeExplicitTargets } from '../shared/broadcast-targets.ts';
import {
  decideMessageChannel,
  MESSAGE_CHANNEL_REFUSAL,
} from '../shared/message-channel-gate.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACES = path.join(HERE, 'workspaces.ts');

// ─── 1. PURE decision — the four-cell truth table ──────────────────────────

test('#169 decideMessageChannel — delivery ON + not emergency = REFUSE naming send', () => {
  const d = decideMessageChannel({ targetDeliveryOn: true, emergency: false });
  assert.equal(d.allow, false);
  if (d.allow === false) {
    // The literal the ticket promises: the refusal must NAME the bus verb.
    assert.match(d.error, /orchestra send/);
    assert.equal(d.error, MESSAGE_CHANNEL_REFUSAL);
  }
});

test('#169 decideMessageChannel — delivery ON + emergency = ALLOW (the escape survives)', () => {
  assert.deepEqual(decideMessageChannel({ targetDeliveryOn: true, emergency: true }), {
    allow: true,
  });
});

test('#169 decideMessageChannel — delivery OFF = ALLOW regardless of emergency (legacy/bloc2)', () => {
  assert.deepEqual(decideMessageChannel({ targetDeliveryOn: false, emergency: false }), {
    allow: true,
  });
  assert.deepEqual(decideMessageChannel({ targetDeliveryOn: false, emergency: true }), {
    allow: true,
  });
});

test('#169 decideMessageChannel — the refusal error names the emergency escape too', () => {
  const d = decideMessageChannel({ targetDeliveryOn: true, emergency: false });
  assert.equal(d.allow, false);
  if (d.allow === false) assert.match(d.error, /--emergency/);
});

// ─── 2. The REAL wrapper body against a REAL bus ───────────────────────────

/** Extract one top-level function body from workspaces.ts, anchored to a line
 *  start with a selector-drift guard (same contract as bus-mirror.test.ts). */
function extract(name: string): string {
  const code = fs.readFileSync(WORKSPACES, 'utf8');
  const start = code.indexOf(`\n${name}`) + 1;
  assert.notEqual(start, 0, `${name} not found at a line start in workspaces.ts — renamed?`);
  const rest = code.slice(start);
  const end = rest.indexOf('\n}\n');
  assert.notEqual(end, -1, `${name} has no closing brace at column 0`);
  const captured = rest.slice(0, end + 2);
  assert.ok(
    captured.startsWith(name),
    `SELECTOR DRIFT: asked for ${name}, captured "${captured.slice(0, 60)}"`,
  );
  return captured;
}

/** Narrow type-strip so `new Function` compiles the wrapper. Anchored to the
 *  wrapper's own annotations, and asserts what it removed (a silent sweep fails
 *  in the passing direction). */
function stripWrapperTypes(body: string): string {
  const out = body
    // `new Function` compiles a bare declaration, never a module export.
    .replace(/^export\s+/, '')
    // the destructured parameter annotation (now includes `emergency?: boolean`)
    .replace(/input:\s*\{[\s\S]*?\},?\s*\)/, 'input)')
    .replace(/\):\s*Promise<[^>]*>\s*\{/, ') {')
    .replace(/\b(const|let)\s+(\w+):\s*[A-Za-z_$][\w$<>.|'\s[\]]*=/g, '$1 $2 =')
    // a bare declaration with no initializer: `let targets: string[];`
    .replace(/\b(let|const)\s+(\w+):\s*[A-Za-z_$][\w$<>.|'\s[\]]*;/g, '$1 $2;');
  assert.ok(!/:\s*Promise</.test(out), 'stripWrapperTypes left a return annotation — stale');
  // No leftover `let x: T` / `const x: T` type annotations survived the strip.
  assert.ok(
    !/\b(let|const)\s+\w+\s*:/.test(out),
    'stripWrapperTypes left a declaration annotation — stale',
  );
  return out;
}

// SOURCE BINDING: the gate this rig asserts on must actually be in the wrapper.
test('#169 SOURCE BINDING — the wrapper resolves the switch and gates before delivery', () => {
  const wrapper = extract('export async function dispatchMessageRequest');
  assert.match(wrapper, /decideMessageChannel\(/, 'the wrapper must call the pure gate');
  assert.match(wrapper, /busSwitch\(db, resolveWaveRunId\(targetForGate\), 'delivery'\)/);
  // The gate must run BEFORE the delivery call, or a refused send would deliver.
  const iGate = wrapper.indexOf('decideMessageChannel(');
  const iDispatch = wrapper.indexOf('await dispatchMessageRequestUnmirrored');
  assert.ok(iGate < iDispatch, 'the gate must run BEFORE the old channel delivers');
  // And its falsifier: a body that merely names the gate without the guard must
  // NOT satisfy the switch-resolution assertion.
  assert.throws(() =>
    assert.match('/* decideMessageChannel */', /busSwitch\(db, resolveWaveRunId/),
  );
});

interface WrapperResult {
  result: { ok: boolean; error?: string; delivery?: string; branch?: string };
  delivered: boolean;
}

/**
 * Run the REAL `dispatchMessageRequest` wrapper body against a real bus.
 *
 * `gated` selects the shipped guard (true) or a pre-#169 stand-in (false): when
 * false the pure gate is replaced by an always-allow stub, so the SAME rig
 * measures both the fixed and the unfixed wrapper — the mutation proof.
 */
async function runWrapper(opts: {
  db: BusDb;
  targetRunId: string;
  targetExists: boolean;
  emergency: boolean;
  gated: boolean;
}): Promise<WrapperResult> {
  const body = extract('export async function dispatchMessageRequest');
  let delivered = false;

  const target = opts.targetExists
    ? { id: 'ws-target', branch: 'target-branch', archived: false }
    : undefined;

  const scope = {
    MESSAGE_MAX_CHARS: 8000,
    getBus: () => opts.db,
    busSwitch, // the REAL frozen-flag read
    resolveWaveRunId: (_ws: unknown) => opts.targetRunId,
    store: { getWorkspace: (_id: string) => target },
    decideMessageChannel: opts.gated
      ? decideMessageChannel
      : (_i: unknown) => ({ allow: true as const }), // pre-#169: no gate
    // Delivery: record that the OLD channel actually ran, and return a success.
    dispatchMessageRequestUnmirrored: async (_i: unknown) => {
      delivered = true;
      return { ok: true, delivery: 'live', branch: 'target-branch' };
    },
    // The mirror is read-only w.r.t. delivery and irrelevant to the gate.
    mirrorDispatch: () => {},
    // Present only so the wrapper's `resolveWaveRunId(recipientWs)` mirror line
    // (post-delivery) type-checks; harmless.
  };

  const fn = new Function(
    ...Object.keys(scope),
    `${stripWrapperTypes(body)}\nreturn dispatchMessageRequest;`,
  )(...Object.values(scope));

  const result = await fn({
    from: 'ws-sender',
    to: 'ws-target',
    text: 'coordinate the wave',
    ...(opts.emergency ? { emergency: true } : {}),
  });
  return { result, delivered };
}

function tmpBus(t: { after: (fn: () => void) => void }): BusDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-gate-169-'));
  const db = openBus(path.join(dir, 'bus.sqlite'));
  t.after(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

function seedRun(db: BusDb, id: string, deliveryOn: boolean): void {
  startRun(db, { id, kind: 'mission', coordinator: id }, {
    ...DEFAULT_BUS_SWITCHES,
    delivery: deliveryOn,
  });
  // Prove the fixture: the frozen flag reads back the way the arm assumes.
  assert.equal(busSwitch(db, id, 'delivery'), deliveryOn, 'seedRun fixture wrong');
}

// ARM 1 — fleet message to an anchored delivery-ON recipient is REFUSED naming
// `orchestra send`, and (mutation) the SAME message DELIVERS on the unfixed wrapper.
test('#169 ARM 1 — delivery-ON target: REFUSED (gated), DELIVERED (ungated)', async (t) => {
  const db = tmpBus(t);
  seedRun(db, 'run-on', true);

  const gated = await runWrapper({
    db,
    targetRunId: 'run-on',
    targetExists: true,
    emergency: false,
    gated: true,
  });
  assert.equal(gated.result.ok, false, 'shipped wrapper must refuse');
  assert.equal(gated.delivered, false, 'refused send must NOT reach the old channel');
  assert.match(gated.result.error ?? '', /orchestra send/, 'refusal must name the bus verb');

  // MUTATION: the pre-#169 wrapper (no gate) delivers the same message.
  const ungated = await runWrapper({
    db,
    targetRunId: 'run-on',
    targetExists: true,
    emergency: false,
    gated: false,
  });
  assert.equal(ungated.result.ok, true, 'pre-fix wrapper delivered (dual-channel)');
  assert.equal(ungated.delivered, true, 'pre-fix wrapper reached the old channel');
});

// ARM 2a — the --emergency escape STILL delivers even on a delivery-ON run.
test('#169 ARM 2a — --emergency on a delivery-ON target STILL delivers', async (t) => {
  const db = tmpBus(t);
  seedRun(db, 'run-on', true);
  const r = await runWrapper({
    db,
    targetRunId: 'run-on',
    targetExists: true,
    emergency: true,
    gated: true,
  });
  assert.equal(r.result.ok, true, 'the emergency escape must survive');
  assert.equal(r.delivered, true, 'emergency send must reach the old channel');
});

// ARM 2b — the delivery-OFF (bloc2 legacy) path STILL delivers, no emergency needed.
test('#169 ARM 2b — delivery-OFF target STILL delivers (legacy mission)', async (t) => {
  const db = tmpBus(t);
  seedRun(db, 'run-off', false);
  const r = await runWrapper({
    db,
    targetRunId: 'run-off',
    targetExists: true,
    emergency: false,
    gated: true,
  });
  assert.equal(r.result.ok, true, 'a delivery-OFF run must not be refused');
  assert.equal(r.delivered, true);
});

// ARM 2c — a target with NO run row at all reads delivery OFF (busSwitch contract)
// and is NEVER refused (plain standalone workspace).
test('#169 ARM 2c — target with no run row is NEVER refused', async (t) => {
  const db = tmpBus(t);
  // deliberately do NOT seedRun — the run id is unknown to the bus.
  const r = await runWrapper({
    db,
    targetRunId: 'run-absent',
    targetExists: true,
    emergency: false,
    gated: true,
  });
  assert.equal(busSwitch(db, 'run-absent', 'delivery'), false, 'unknown run reads OFF');
  assert.equal(r.result.ok, true, 'no run row → not refused');
  assert.equal(r.delivered, true);
});

// ─── 3. F1 — the #86 emergency-halt BROADCAST bypasses the gate ────────────
//
// A broadcast IS the out-of-band group-stop. It routes through the SAME gated
// single-target `dispatchMessageRequest`, so on a delivery-ON fleet it would be
// refused for EVERY target unless it carries `emergency: true`. This drives the
// REAL `dispatchBroadcastMessageRequest` body with a stub `dispatchMessageRequest`
// that records the `emergency` flag it received per target — the pre-fix build
// (no `emergency: true` in the call) records `undefined` and reddens the arm.
async function runBroadcast(targets: string[]): Promise<{
  result: { ok: boolean; results?: Array<{ id: string; ok: boolean }> };
  emergencySeen: Array<boolean | undefined>;
}> {
  const body = extract('export async function dispatchBroadcastMessageRequest');
  const emergencySeen: Array<boolean | undefined> = [];
  const scope = {
    normalizeExplicitTargets,
    deliverToTargets,
    resolveDirectChildTargets: () => [] as string[],
    store: { workspaces: [] as unknown[] },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    // Record the emergency flag each per-target call carries; report success so
    // the arm measures the FLAG, not a delivery outcome.
    dispatchMessageRequest: async (i: { emergency?: boolean }) => {
      emergencySeen.push(i.emergency);
      return { ok: true, delivery: 'live', branch: 'br' };
    },
  };
  const fn = new Function(
    ...Object.keys(scope),
    `${stripWrapperTypes(body)}\nreturn dispatchBroadcastMessageRequest;`,
  )(...Object.values(scope));
  const result = await fn({ from: 'ops', to: targets, text: 'HALT everything now' });
  return { result, emergencySeen };
}

test('#169 F1 — a broadcast halt carries emergency:true to EVERY target', async () => {
  const { result, emergencySeen } = await runBroadcast(['a', 'b', 'c']);
  assert.equal(result.ok, true);
  assert.equal(emergencySeen.length, 3, 'every target attempted');
  assert.deepEqual(
    emergencySeen,
    [true, true, true],
    'the broadcast MUST bypass the gate per target (pre-fix: [undefined,undefined,undefined] → refused on a delivery-ON fleet)',
  );
});
