import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isBusWakeMessage,
  busWakeRuns,
  busWakeCommands,
  toolCommand,
  isCheckInvocation,
  isAckInvocation,
  ackLotId,
  parseCheckOutput,
  toolResultText,
  deliveryPreview,
  foldDelivery,
} from './bus-rows.ts';
import { buildWakeOrder, WAKE_ORDER_HEADER } from './bus-wake.ts';
import type { CheckOutput } from '../cli/bus-verbs.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

function wakeText(runs: string[]): string {
  return buildWakeOrder(runs);
}

const SAMPLE_CHECK: CheckOutput = {
  run: 'wave-g-canary',
  reader: 'ops-g',
  lot: 312,
  replay: false,
  from: 41,
  to: 43,
  count: 2,
  messages: [
    {
      sequence: 42,
      kind: 'status',
      sender: 'impl-144',
      recipient: 'ops-g',
      thread_id: null,
      body: 'G1–G6 green, branch pushed, nominating\nsecond line',
      created_at: 1_700_000_000,
    },
    {
      sequence: 43,
      kind: 'ask',
      sender: 'impl-142',
      recipient: 'ops-g',
      thread_id: null,
      body: 'restart path: keep --no-restart refusal wording?',
      created_at: 1_700_000_001,
    },
  ],
  gates: [],
};

function checkCard(output: unknown, command = 'orchestra check --run wave-g-canary'): {
  role: 'tool';
  toolUse: { name: 'Bash'; input: { command: string } };
  toolResult: { content: string; isError: boolean };
} {
  return {
    role: 'tool',
    toolUse: { name: 'Bash', input: { command } },
    toolResult: { content: JSON.stringify(output), isError: false },
  };
}

// ── WAKE detection (G3) ───────────────────────────────────────────────────────

test('isBusWakeMessage: a real wake order is a wake row (marker-keyed)', () => {
  const m = { role: 'user', text: wakeText(['wave-g-canary', 'lead-ancestor']) };
  assert.equal(isBusWakeMessage(m), true);
  assert.deepEqual(busWakeRuns(m), ['lead-ancestor', 'wave-g-canary']); // sorted by buildWakeOrder
  assert.deepEqual(busWakeCommands(m), [
    'orchestra check --run lead-ancestor',
    'orchestra check --run wave-g-canary',
  ]);
});

test('G3 must-FAIL: a plain human turn containing "lot pending" is NOT a wake row', () => {
  const m = {
    role: 'user',
    text: 'is there a lot pending on the canary run? just checking before I step away',
  };
  assert.equal(isBusWakeMessage(m), false);
  assert.deepEqual(busWakeRuns(m), []);
  assert.deepEqual(busWakeCommands(m), []);
});

test('G3 must-FAIL: the header ALONE (no run line) is not a wake — the claim needs the command', () => {
  // Feed a text that MENTIONS the marker header without the ordered command
  // (carry-forward #2: a marker assertion as specific as the claim it certifies).
  assert.equal(isBusWakeMessage({ role: 'user', text: WAKE_ORDER_HEADER }), false);
  assert.equal(
    isBusWakeMessage({ role: 'user', text: `${WAKE_ORDER_HEADER}\nsome prose, not a command` }),
    false,
  );
});

test('isBusWakeMessage: a wake body must not be a peer/RC delivery (origin excludes)', () => {
  const m = {
    role: 'user',
    text: wakeText(['r1']),
    origin: 'peer: fix-login-race',
  };
  assert.equal(isBusWakeMessage(m), false);
});

test('isBusWakeMessage: only user role', () => {
  assert.equal(isBusWakeMessage({ role: 'assistant', text: wakeText(['r1']) }), false);
  assert.equal(isBusWakeMessage({ role: 'tool', text: wakeText(['r1']) }), false);
});

// ── DELIVERY detection (G4) ───────────────────────────────────────────────────

test('toolCommand: reads the finalized Bash command', () => {
  assert.equal(
    toolCommand({ role: 'tool', toolUse: { name: 'Bash', input: { command: 'orchestra check' } } }),
    'orchestra check',
  );
});

test('toolCommand: falls back to the streaming JSON buffer', () => {
  const m = {
    role: 'tool' as const,
    toolUse: { name: 'Bash', inputJson: '{"command":"orchestra check --run r1"' },
  };
  assert.equal(toolCommand(m), 'orchestra check --run r1');
});

test('toolCommand: non-Bash / non-tool returns empty', () => {
  assert.equal(toolCommand({ role: 'tool', toolUse: { name: 'Read', input: { file_path: 'x' } } }), '');
  assert.equal(toolCommand({ role: 'assistant' }), '');
});

test('isCheckInvocation: matches the check verb, with or without a path prefix', () => {
  assert.equal(isCheckInvocation(checkCard(SAMPLE_CHECK)), true);
  assert.equal(isCheckInvocation(checkCard(SAMPLE_CHECK, '/opt/bin/orchestra check --markdown')), true);
  assert.equal(isCheckInvocation(checkCard(SAMPLE_CHECK, 'orchestra check --run r1 --ack-previous')), true);
});

test('G4 must-FAIL: a non-bus Bash card is NOT a delivery, even if its output is JSON-ish', () => {
  // A different command whose stdout happens to be a JSON object that even
  // carries a `run`/`reader`-looking blob — must NOT fold as a delivery, because
  // detection keys on the CLI invocation, never body text.
  const impostor = {
    role: 'tool' as const,
    toolUse: { name: 'Bash', input: { command: 'cat some-lot.json' } },
    toolResult: { content: JSON.stringify(SAMPLE_CHECK), isError: false },
  };
  assert.equal(isCheckInvocation(impostor), false);
  assert.equal(parseCheckOutput(impostor), null);
});

test('isCheckInvocation must-FAIL: a look-alike binary and checkpoint verb do not match', () => {
  assert.equal(isCheckInvocation(checkCard(SAMPLE_CHECK, 'my-orchestra check')), false);
  assert.equal(isCheckInvocation(checkCard(SAMPLE_CHECK, 'orchestra checkpoint')), false);
  assert.equal(isCheckInvocation(checkCard(SAMPLE_CHECK, 'echo orchestra is checking')), false);
});

test('parseCheckOutput: a real check output parses to the contract', () => {
  const out = parseCheckOutput(checkCard(SAMPLE_CHECK));
  assert.ok(out);
  assert.equal(out.run, 'wave-g-canary');
  assert.equal(out.lot, 312);
  assert.equal(out.messages.length, 2);
});

test('parseCheckOutput: an errored check result does not fold', () => {
  const m = {
    role: 'tool' as const,
    toolUse: { name: 'Bash', input: { command: 'orchestra check' } },
    toolResult: { content: 'orchestra check: not registered', isError: true },
  };
  assert.equal(parseCheckOutput(m), null);
});

test('parseCheckOutput must-FAIL: an arbitrary JSON blob from a check card is refused (shape guard)', () => {
  // The command IS a check, but the output is not the published shape — must not
  // fold (positive control: SAMPLE_CHECK does fold, above).
  assert.equal(parseCheckOutput(checkCard({ hello: 'world', run: 5 })), null);
  assert.equal(parseCheckOutput(checkCard({ run: 'r', reader: 'x' })), null); // missing messages/count/gates
});

test('toolResultText: flattens string and block-array content', () => {
  assert.equal(toolResultText('plain'), 'plain');
  assert.equal(toolResultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab');
  assert.equal(toolResultText(undefined), '');
});

test('parseCheckOutput: handles block-array result content (SDK shape)', () => {
  const m = {
    role: 'tool' as const,
    toolUse: { name: 'Bash', input: { command: 'orchestra check' } },
    toolResult: { content: [{ type: 'text', text: JSON.stringify(SAMPLE_CHECK) }], isError: false },
  };
  const out = parseCheckOutput(m);
  assert.ok(out);
  assert.equal(out.lot, 312);
});

// ── ACK detection + badge flip (G4) ───────────────────────────────────────────

test('isAckInvocation + ackLotId: reads the lot id', () => {
  const ack = checkCard(SAMPLE_CHECK, 'orchestra ack 312');
  assert.equal(isAckInvocation(ack), true);
  assert.equal(ackLotId(ack), 312);
});

test('ackLotId: skips flags, reads the positional integer', () => {
  assert.equal(ackLotId(checkCard(SAMPLE_CHECK, 'orchestra ack 45 --request-id abc')), 45);
  assert.equal(ackLotId(checkCard(SAMPLE_CHECK, '/x/orchestra ack 7')), 7);
});

test('ackLotId: a check invocation is not an ack', () => {
  assert.equal(ackLotId(checkCard(SAMPLE_CHECK)), null);
  assert.equal(isAckInvocation(checkCard(SAMPLE_CHECK)), false);
});

test('ackLotId must-FAIL: a non-integer / zero ack arg yields null', () => {
  assert.equal(ackLotId(checkCard(SAMPLE_CHECK, 'orchestra ack notanumber')), null);
  assert.equal(ackLotId(checkCard(SAMPLE_CHECK, 'orchestra ack 0')), null);
});

// ── FOLD: delivery model + acked flip (G4) ────────────────────────────────────

test('foldDelivery: PENDING when no matching ack, ACKED when the lot is acked', () => {
  const pending = foldDelivery(SAMPLE_CHECK, new Set());
  assert.equal(pending.acked, false);
  assert.equal(pending.lot, 312);
  assert.equal(pending.count, 2);
  assert.equal(pending.messages[0].sender, 'impl-144');
  assert.equal(pending.messages[0].recipient, 'ops-g');
  assert.equal(pending.messages[0].kind, 'status');
  // preview is the first non-empty line, not the whole multi-line body
  assert.equal(pending.messages[0].preview, 'G1–G6 green, branch pushed, nominating');

  const acked = foldDelivery(SAMPLE_CHECK, new Set([312]));
  assert.equal(acked.acked, true);
});

test('foldDelivery: an empty lot (lot=null) is never acked', () => {
  const empty: CheckOutput = { ...SAMPLE_CHECK, lot: null, count: 0, messages: [] };
  assert.equal(foldDelivery(empty, new Set([312])).acked, false);
  assert.equal(foldDelivery(empty, new Set()).acked, false);
});

test('deliveryPreview: first non-empty line, capped', () => {
  assert.equal(deliveryPreview('\n\nfirst real line\nsecond'), 'first real line');
  assert.equal(deliveryPreview(''), '');
  const long = 'x'.repeat(200);
  const p = deliveryPreview(long, 40);
  assert.equal(p.length, 40);
  assert.ok(p.endsWith('…'));
});
