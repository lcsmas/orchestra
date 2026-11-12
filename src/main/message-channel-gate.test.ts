// #441 — the OLD channel is CLOSED: `orchestra message` WITHOUT `--emergency` is refused for EVERY target (a parent, a
// child, a sibling, an unrelated agent, a plain parent, a dangling-parent agent) and prints the equivalent `orchestra send`;
// `--emergency` is unchanged. (Rewrites the P4 #169 / #221 / #434 pins: the delivery-ON gate and its plain-target exemptions are gone.)
//
// THREE layers, on purpose:
//  1. PURE decision (`decideMessageChannel`, src/shared) — the truth table, driven directly.
//  2. The REAL WRAPPER BODY (`dispatchMessageRequest` in workspaces.ts) extracted and evaluated over a REAL topology and a REAL
//     SQLite bus + the REAL mirror (workspaces.ts cannot import under `node --test`: the same extract-and-eval technique
//     bus-mirror.test.ts uses, with the source-binding guard). The built-CLI + real-hooks-server drive is scripts/e2e-old-channel-closed.mjs.
//  3. The BROADCAST body (`--to` / `--children`) with the REAL gate per target.
//
// MUTATION PROOF: `runWrapper` can DISABLE the gate (`gated: false`) to stand in for the pre-#441 build — every refusal arm asserts the
// outcome FLIPS (refused → delivered). scripts/old-channel-closed-mutants.mjs removes each guard IN PLACE and requires a named red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openBus, type BusDb } from './bus.ts';
import { startRun } from './bus-runs.ts';
import { nearestOrchestratorId } from './wave-run-id.ts';
import { DEFAULT_BUS_SWITCHES } from '../shared/bus-switches.ts';
import { deliverToTargets, normalizeExplicitTargets } from '../shared/broadcast-targets.ts';
import {
  decideMessageChannel,
  equivalentSendCommand,
  messageChannelRefusal,
  shellQuote,
} from '../shared/message-channel-gate.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACES = path.join(HERE, 'workspaces.ts');

// ─── 1. PURE decision ────────────────────────────────────────────────────────

test('#441 decideMessageChannel — WITHOUT --emergency: REFUSE for any target, naming the equivalent `orchestra send`', () => {
  for (const to of ['ws-parent', 'ws-child', 'ws-sibling', 'ws-stranger', 'no-such-id']) {
    const d = decideMessageChannel({ emergency: false, to, text: 'hello there' });
    assert.equal(d.allow, false, `${to} must be refused`);
    if (d.allow === false) {
      assert.ok(d.error.includes(`orchestra send --type status --to ${to} 'hello there'`), d.error);
      assert.match(d.error, /--emergency/, 'the one escape is named');
      assert.ok(!/delivery|legacy/i.test(d.error), 'no switch / legacy wording in the refusal');
    }
  }
});

test('#441 decideMessageChannel — --emergency = ALLOW (the escape is unchanged), whatever the target', () => {
  for (const to of ['ws-parent', 'ws-child', 'ws-stranger']) {
    assert.deepEqual(decideMessageChannel({ emergency: true, to, text: 'wake up' }), { allow: true });
  }
});

test('#441 the equivalent command is paste-safe: single quotes escaped, the full text kept, on the first line of the refusal', () => {
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  const text = "don't $(rm -rf /) `x` \"q\" ; & | done";
  const cmd = equivalentSendCommand('ws-1', text);
  assert.equal(cmd, `orchestra send --type status --to ws-1 ${shellQuote(text)}`);
  assert.equal(cmd.includes('\n'), false);
  assert.equal(messageChannelRefusal('ws-1', text).split('\n')[0].includes(cmd), true, 'the command is on the first line of the refusal');
  assert.equal(equivalentSendCommand('my agent', 'hi'), "orchestra send --type status --to 'my agent' 'hi'", 'an id with a space is quoted too');
  // round trip through a real shell: the quoted text comes back byte-exact
  assert.equal(execFileSync('sh', ['-c', `printf %s ${shellQuote(text)}`], { encoding: 'utf8' }), text);
});

// ─── 2. The REAL wrapper body ────────────────────────────────────────────────

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
    // the destructured parameter annotation (includes `emergency?: boolean`)
    .replace(/input:\s*\{[\s\S]*?\},?\s*\)/, 'input)')
    .replace(/\):\s*Promise<[^>]*>\s*\{/, ') {')
    .replace(/\b(const|let)\s+(\w+):\s*[A-Za-z_$][\w$<>.|'\s[\]]*=/g, '$1 $2 =')
    // a bare declaration with no initializer: `let targets: string[];`
    .replace(/\b(let|const)\s+(\w+):\s*[A-Za-z_$][\w$<>.|'\s[\]]*;/g, '$1 $2;');
  assert.ok(!/:\s*Promise</.test(out), 'stripWrapperTypes left a return annotation — stale');
  assert.ok(
    !/\b(let|const)\s+\w+\s*:/.test(out),
    'stripWrapperTypes left a declaration annotation — stale',
  );
  return out;
}

// SOURCE BINDING: the gate this rig asserts on must actually be in the wrapper, ahead of the delivery.
test('#441 SOURCE BINDING — the wrapper gates before delivery and reads NO delivery switch / plain-anchor exemption', () => {
  const wrapper = extract('export async function dispatchMessageRequest');
  assert.match(wrapper, /decideMessageChannel\(/, 'the wrapper must call the pure gate');
  const iGate = wrapper.indexOf('decideMessageChannel(');
  const iDispatch = wrapper.indexOf('dispatchMessageRequestUnmirrored(');
  assert.ok(iGate !== -1 && iGate < iDispatch, 'the gate must run BEFORE the old channel delivers');
  assert.ok(!/busSwitch\(/.test(wrapper), "no frozen switch is read to decide (the 'delivery' switch is gone)");
  assert.ok(!/isPlainOwnAnchor|plainAnchor|senderHasBusRoute|mirrorWouldWake/.test(wrapper), 'no plain-target exemption survives (#221/#434 retired)');
  assert.ok(!/getRelatedRunIds\(/.test(wrapper), 'no sender-route probe');
  assert.ok(!/mirrorDispatch/.test(wrapper), '#441-fu: no mirror — an --emergency poke files nothing on the bus');
  assert.ok(!/MESSAGE_MAX_CHARS|\.slice\(/.test(wrapper), '#441-fu: the refusal echo is never capped (the delivery body caps for the session)');
  // falsifier of the binding regexes: a body that merely names the gate does not satisfy the ordering check
  assert.throws(() => assert.match('/* decideMessageChannel */', /dispatchMessageRequestUnmirrored\(/));
});

interface TopoNode {
  id: string;
  branch: string;
  archived: boolean;
  parentId?: string;
  ownsRun?: boolean;
  kind?: string;
}
const node = (id: string, over: Partial<TopoNode> = {}): TopoNode => ({
  id, branch: `${id}-branch`, archived: false, ...over,
});

interface WrapperResult {
  result: { ok: boolean; error?: string; delivery?: string; branch?: string };
  delivered: boolean;
}

const TEXT = 'coordinate the wave';

/**
 * Run the REAL `dispatchMessageRequest` wrapper body over a REAL topology and a real bus (the REAL mirror files the row).
 * `gated: false` swaps the pure gate for an always-allow stub (the pre-#441 build): the SAME rig measures the fixed and the unfixed wrapper.
 */
async function runWrapper(opts: {
  db: BusDb;
  nodes: Record<string, TopoNode>;
  from?: string;
  to?: string;
  text?: string;
  emergency: boolean;
  gated: boolean;
}): Promise<WrapperResult> {
  const body = extract('export async function dispatchMessageRequest');
  let delivered = false;
  const scope = {
    decideMessageChannel: opts.gated ? decideMessageChannel : (_i: unknown) => ({ allow: true as const }),
    // Delivery: record that the OLD channel actually ran, and return a success.
    dispatchMessageRequestUnmirrored: async (_i: unknown) => {
      delivered = true;
      return { ok: true, delivery: 'live', branch: 'target-branch' };
    },
  };
  const fn = new Function(
    ...Object.keys(scope),
    `${stripWrapperTypes(body)}\nreturn dispatchMessageRequest;`,
  )(...Object.values(scope));
  const result = await fn({
    from: opts.from,
    to: opts.to ?? 'ws-target',
    text: opts.text ?? TEXT,
    ...(opts.emergency ? { emergency: true } : {}),
  });
  return { result, delivered };
}

function tmpBus(t: { after: (fn: () => void) => void }): BusDb {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'msg-gate-441-'));
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

const messageRows = (db: BusDb) =>
  db.prepare("SELECT run_id, sender, recipient, kind FROM messages ORDER BY sequence").all() as Array<{ run_id: string; sender: string; recipient: string | null; kind: string }>;

/** Every pair a sender can be in with the target — the refusal must hold for ALL of them (a parent, a child, a sibling, an unrelated agent …). */
const PAIRS: Record<string, { nodes: Record<string, TopoNode>; from: string | undefined }> = {
  'to its PARENT (an orchestrator)': {
    from: 'ws-sender',
    nodes: { 'ws-target': node('ws-target', { kind: 'orchestrator', ownsRun: true }), 'ws-sender': node('ws-sender', { parentId: 'ws-target' }) },
  },
  'to its CHILD': {
    from: 'ws-sender',
    nodes: { 'ws-sender': node('ws-sender', { kind: 'orchestrator', ownsRun: true }), 'ws-target': node('ws-target', { parentId: 'ws-sender' }) },
  },
  'to a SIBLING': {
    from: 'ws-sender',
    nodes: {
      'ws-parent': node('ws-parent', { kind: 'orchestrator', ownsRun: true }),
      'ws-target': node('ws-target', { parentId: 'ws-parent' }),
      'ws-sender': node('ws-sender', { parentId: 'ws-parent' }),
    },
  },
  'to an UNRELATED agent (two top-level plain workspaces)': {
    from: 'ws-sender',
    nodes: { 'ws-target': node('ws-target'), 'ws-sender': node('ws-sender') },
  },
  'to a PLAIN parent that owns a run (the #221/#434 exemption)': {
    from: 'ws-sender',
    nodes: { 'ws-target': node('ws-target', { ownsRun: true }), 'ws-sender': node('ws-sender', { parentId: 'ws-target' }) },
  },
  'to a plain agent whose parent was DELETED (dangling parent)': {
    from: undefined,
    nodes: { 'ws-target': node('ws-target', { parentId: 'gone' }) },
  },
  'from a caller with NO workspace id (a plain shell)': {
    from: undefined,
    nodes: { 'ws-target': node('ws-target') },
  },
};

for (const [label, pair] of Object.entries(PAIRS)) {
  test(`#441 \`message\` ${label}: REFUSED with the equivalent send (never delivered, never mirrored); the guard-removed twin DELIVERS`, async (t) => {
    const db = tmpBus(t);
    startRun(db, { id: 'ws-target', kind: 'mission', coordinator: 'ws-target' }, DEFAULT_BUS_SWITCHES);
    const refused = await runWrapper({ db, nodes: pair.nodes, from: pair.from, emergency: false, gated: true });
    assert.equal(refused.result.ok, false, 'the old channel is closed for this pair');
    assert.equal(refused.delivered, false, 'a refused send must NOT reach the old channel');
    assert.ok(
      (refused.result.error ?? '').includes(`orchestra send --type status --to ws-target '${TEXT}'`),
      `the refusal prints the equivalent command: ${refused.result.error}`,
    );
    assert.deepEqual(messageRows(db), [], 'a refused send is not mirrored onto the bus');
    // MUTANT arm: with the guard removed the SAME send is delivered (the pre-#441 behaviour)
    const open = await runWrapper({ db, nodes: pair.nodes, from: pair.from, emergency: false, gated: false });
    assert.equal(open.result.ok, true);
    assert.equal(open.delivered, true, 'pre-#441 build: the message went through the old channel');
  });
}

test('#441 `message --emergency` is UNCHANGED for every pair: delivered into the session, and NOTHING is filed on the bus (no dispatch row in anyone\'s run)', async (t) => {
  for (const [label, pair] of Object.entries(PAIRS)) {
    const db = tmpBus(t);
    startRun(db, { id: 'ws-target', kind: 'mission', coordinator: 'ws-target' }, DEFAULT_BUS_SWITCHES);
    const r = await runWrapper({ db, nodes: pair.nodes, from: pair.from, emergency: true, gated: true });
    assert.equal(r.result.ok, true, `${label}: --emergency delivers`);
    assert.equal(r.delivered, true, `${label}: it reaches the session`);
    assert.deepEqual(messageRows(db), [], `${label}: the poke is not mirrored as a bus row (a stranger's emergency must not become a dispatch, #436)`);
  }
});

test('#441-fu the refusal echo never truncates: a 9000-char text is printed whole in the equivalent command', async (t) => {
  const db = tmpBus(t);
  const long = `${'x'.repeat(4500)} ${'y'.repeat(4499)}`;
  const r = await runWrapper({ db, nodes: PAIRS['to a SIBLING'].nodes, from: 'ws-sender', emergency: false, gated: true, text: `  ${long}  ` });
  assert.equal(r.result.ok, false);
  assert.ok((r.result.error ?? '').includes(`orchestra send --type status --to ws-target '${long}'`), 'the full text, trimmed, inside the command');
  assert.ok(long.length > 8000);
});

test('#221 R4a — /resolveHandle carries each workspace wave run: member → its orchestrator, plain child → itself, archived excluded', () => {
  // The REAL handler body from workspaces.ts. MUTANT `runId: w.id` → the member reads as its own anchor.
  const body = extract('export function dispatchResolveHandleRequest')
    .replace(/^export\s+/, '')
    .replace(/function dispatchResolveHandleRequest\(\): \{[\s\S]*?\n\} \{/, 'function dispatchResolveHandleRequest() {');
  assert.ok(!/:\s*\{\s*ok:/.test(body), 'return annotation stripped');
  const nodes: Record<string, TopoNode & { name: string }> = {
    o: { ...node('o', { ownsRun: true }), name: 'orch' },
    m: { ...node('m', { parentId: 'o' }), name: 'member' },
    c: { ...node('c'), name: 'child' },
    a: { ...node('a', { archived: true }), name: 'gone' },
  };
  const fn = new Function(
    'store',
    'resolveWaveRunId',
    `${body}\nreturn dispatchResolveHandleRequest;`,
  )(
    { workspaces: Object.values(nodes) },
    (ws: TopoNode) => nearestOrchestratorId(ws, (id: string) => nodes[id]),
  );
  const res = fn() as { ok: boolean; workspaces: { id: string; name: string; runId: string }[] };
  assert.equal(res.ok, true);
  assert.deepEqual(
    res.workspaces.map((w) => [w.id, w.runId]),
    [['o', 'o'], ['m', 'o'], ['c', 'c']],
    'orchestrator → itself, member → its orchestrator, plain child → itself; archived dropped',
  );
});

// ─── 3. The BROADCAST is gated too; only --emergency bypasses ──────────────────────
//
// A broadcast is NOT a bypass by virtue of its shape: `dispatchBroadcastMessageRequest` threads the caller's EXPLICIT emergency flag per
// target. This drives the REAL broadcast body with a stub `dispatchMessageRequest` that applies the REAL `decideMessageChannel` with the
// per-target emergency it received, so refusal/delivery is genuine end-to-end, not asserted on a recorded flag.
async function runBroadcast(opts: {
  targets: string[];
  emergency: boolean;
}): Promise<{
  results: Array<{ id: string; ok: boolean; error?: string }>;
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
    dispatchMessageRequest: async (i: { to: string; text: string; emergency?: boolean }) => {
      emergencySeen.push(i.emergency);
      const gate = decideMessageChannel({ emergency: i.emergency === true, to: i.to, text: i.text });
      if (!gate.allow) return { ok: false, error: gate.error };
      return { ok: true, delivery: 'live', branch: 'br' };
    },
  };
  const fn = new Function(
    ...Object.keys(scope),
    `${stripWrapperTypes(body)}\nreturn dispatchBroadcastMessageRequest;`,
  )(...Object.values(scope));
  const result = await fn({
    from: 'ops',
    to: opts.targets,
    text: 'coordination text',
    ...(opts.emergency ? { emergency: true } : {}),
  });
  return { results: result.results ?? [], emergencySeen };
}

test('#441 broadcast ARM(a) — --to WITHOUT --emergency: REFUSED per target, each naming ITS OWN equivalent send', async () => {
  const { results, emergencySeen } = await runBroadcast({ targets: ['a', 'b', 'c'], emergency: false });
  assert.deepEqual(emergencySeen, [false, false, false], 'no --emergency threaded');
  assert.equal(results.length, 3, 'every target attempted');
  assert.ok(results.every((r) => !r.ok), 'every target refused');
  for (const r of results) {
    assert.ok((r.error ?? '').includes(`orchestra send --type status --to ${r.id} 'coordination text'`), `${r.id}: ${r.error}`);
  }
});

test('#441 broadcast ARM(b) — --emergency --to: DELIVERS to all (the #86 group-stop is unchanged)', async () => {
  const { results, emergencySeen } = await runBroadcast({ targets: ['a', 'b', 'c'], emergency: true });
  assert.deepEqual(emergencySeen, [true, true, true], '--emergency threaded per target');
  assert.ok(results.every((r) => r.ok), 'the group-stop lands on every target');
});
