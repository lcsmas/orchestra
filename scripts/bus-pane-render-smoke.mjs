// Render smoke-test for the read-only fleet-bus pane — #118, ledger #123 T118.1.
//
// WHY THIS EXISTS — `node --test --experimental-strip-types` strips types but
// does NOT transform JSX, so the unit suite can prove the freeze and the
// read-only enumeration are correct and still say nothing about whether a
// seeded run ever reaches the SCREEN. Those are two different claims.
//
// THE DISPROOF T118.1 NAMES: "a smoke that passes on an empty DB too". So this
// script does not merely mount the component. It SEEDS a real SQLite bus with
// specific, unusual values (a nested mission→wave tree, messages out of insert
// order, an outstanding lot, an open gate and a resolved one, divergence
// counters) and asserts THOSE LITERAL VALUES appear in the HTML — and then runs
// the SAME assertions against an EMPTY bus and requires every one of them to
// FAIL. If the empty arm passed, the seeded arm would prove nothing.
//
// SELECTOR CONTRACT: assertions key on CLASS, `data-*`, or rendered TEXT —
// never on tag or DOM position — so restyling cannot break them.

import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
function loadEsbuild() {
  try {
    return require_('esbuild');
  } catch {
    const store =
      require_('node:fs').globSync?.(
        process.cwd() + '/node_modules/.pnpm/esbuild@*/node_modules/esbuild',
      ) ?? [];
    if (store.length) return require_(store[0]);
    throw new Error('esbuild not resolvable — run `pnpm install` first');
  }
}
const { build } = process.env.ORCHESTRA_ESBUILD
  ? require_(process.env.ORCHESTRA_ESBUILD)
  : loadEsbuild();

import { renderToString } from 'react-dom/server';
import React from 'react';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(repoRoot, 'node_modules', '.cache', 'bus-pane-smoke.mjs');
const entryFile = path.join(repoRoot, 'node_modules', '.cache', 'bus-pane-entry.tsx');

fs.mkdirSync(path.dirname(entryFile), { recursive: true });
fs.writeFileSync(
  entryFile,
  `
import { BusPaneView } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/components/BusPane.tsx'))};
export { BusPaneView };
`,
);

await build({
  entryPoints: [entryFile],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

globalThis.self = globalThis;
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };

const { BusPaneView } = await import(`${outfile}?t=${Date.now()}`);

// React's SSR inserts `<!-- -->` separators between adjacent interpolated
// values; strip them before matching on prose (see queue-tray-render-smoke).
const text = (html) => html.replace(/<!-- -->/g, '');

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

// ─── Seed a REAL bus, through the real modules ──────────────────────────────
//
// Not a hand-written snapshot object: the point of T118.1 is that values which
// went INTO SQLite come back OUT on screen. A hand-built fixture would skip
// every layer the ticket is about.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-pane-smoke-'));
process.env.ORCHESTRA_HOME = tmp;

const busMod = path.join(repoRoot, 'src/main/bus.ts');
const runsMod = path.join(repoRoot, 'src/main/bus-runs.ts');
const viewOut = path.join(repoRoot, 'node_modules', '.cache', 'bus-pane-seed.mjs');
const seedEntry = path.join(repoRoot, 'node_modules', '.cache', 'bus-pane-seed-entry.ts');
fs.writeFileSync(
  seedEntry,
  `
export { openBus, send, check, openGate, resolveGate } from ${JSON.stringify(busMod)};
export { startRun, listRuns } from ${JSON.stringify(runsMod)};
`,
);
await build({
  entryPoints: [seedEntry],
  outfile: viewOut,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['better-sqlite3', 'electron', 'node:*'],
  logLevel: 'silent',
});
const bus = await import(`${viewOut}?t=${Date.now()}`);

const dbFile = path.join(tmp, 'bus.sqlite');
const db = bus.openBus(dbFile);

// Values chosen to be UNMISTAKABLE — a generic "test"/"hello" could plausibly
// appear in the component's own markup and make the assertion vacuous.
const RUN_MISSION = 'mission-zeta-7731';
const RUN_WAVE = 'vague-b-4412';
const COORD = 'ops-handle-91x';
const BODY_A = 'seeded-body-alpha-55913';
const BODY_B = 'seeded-body-beta-77024';
const THREAD = 'thread-kappa-3120';
const GATE_Q = 'seeded-gate-question-8890';
const GATE_RULING = 'seeded-ruling-2277';
const READER = 'reader-handle-6620';

bus.startRun(
  db,
  { id: RUN_MISSION, kind: 'mission', coordinator: COORD, title: 'Seeded mission 7731' },
  { delivery: true, wake: false, askGate: true, liveness: false },
);
bus.startRun(
  db,
  {
    id: RUN_WAVE,
    kind: 'vague',
    coordinator: COORD,
    parentRunId: RUN_MISSION,
    title: 'Seeded wave 4412',
  },
  { delivery: false, wake: true, askGate: false, liveness: true },
);

const s1 = bus.send(db, {
  runId: RUN_WAVE,
  sender: READER,
  kind: 'status',
  body: BODY_A,
  threadId: THREAD,
});
const s2 = bus.send(db, {
  runId: RUN_WAVE,
  sender: 'other-handle-4401',
  kind: 'escalation',
  body: BODY_B,
  recipient: READER,
});
// An outstanding lot for READER — the pending-lot column the ticket asks for.
bus.check(db, RUN_WAVE, READER);
const openId = bus.openGate(db, RUN_WAVE, COORD, GATE_Q);
const resolvedId = bus.openGate(db, RUN_WAVE, COORD, 'seeded-resolved-question-3344');
bus.resolveGate(db, resolvedId, 'lead-handle-11', GATE_RULING);

// The pane's snapshot is assembled in main (bus-pane.ts imports electron, which
// this runner cannot load), so build the same projection here from the same DB
// and the same shared types. The main-side assembly is gated separately by
// src/main/bus-pane.test.ts and scripts/verify-bus-pane.mjs under Electron.
const runs = bus.listRuns(db).map((r) => ({
  id: r.id,
  kind: r.kind,
  coordinator: r.coordinator,
  parentRunId: r.parent_run_id,
  title: r.title,
  createdAt: r.created_at,
  closedAt: r.closed_at,
  flags: r.flags,
}));
const messages = db
  .prepare('SELECT * FROM messages WHERE run_id=? ORDER BY sequence')
  .all(RUN_WAVE)
  .map((m) => ({
    sequence: m.sequence,
    runId: m.run_id,
    threadId: m.thread_id,
    sender: m.sender,
    recipient: m.recipient,
    kind: m.kind,
    body: m.body,
    createdAt: m.created_at,
  }));
const gates = db
  .prepare('SELECT * FROM decision_gates WHERE run_id=? ORDER BY opened_at, id')
  .all(RUN_WAVE)
  .map((g) => ({
    id: g.id,
    runId: g.run_id,
    askedBy: g.asked_by,
    question: g.question,
    openedAt: g.opened_at,
    resolution: g.resolution,
    resolvedBy: g.resolved_by,
    resolvedAt: g.resolved_at,
  }));
const lot = db
  .prepare('SELECT * FROM deliveries WHERE run_id=? AND acked_at IS NULL')
  .get(RUN_WAVE);
const members = [
  {
    handle: READER,
    phase: 'status',
    lastSeenAt: Date.now(),
    pendingLotId: lot?.id ?? null,
    pendingCount: 2,
  },
  {
    handle: 'other-handle-4401',
    phase: 'escalation',
    lastSeenAt: Date.now(),
    pendingLotId: null,
    pendingCount: 0,
  },
];
const counters = [
  { mechanism: 'delivery', missed: 41, duplicate: 7, lostWake: 0 },
  { mechanism: 'wake', missed: 0, duplicate: 0, lostWake: 13 },
];

const SEEDED = {
  available: true,
  error: null,
  path: dbFile,
  liveSwitches: { delivery: true, wake: false, askGate: false, liveness: true },
  runs,
  selectedRunId: RUN_WAVE,
  messages,
  gates,
  members,
  counters,
  countersBusAvailable: true,
};

const EMPTY = {
  available: true,
  error: null,
  path: dbFile,
  liveSwitches: { delivery: false, wake: false, askGate: false, liveness: false },
  runs: [],
  selectedRunId: null,
  messages: [],
  gates: [],
  members: [],
  counters: [],
  countersBusAvailable: null,
};

const render = (snapshot) =>
  text(renderToString(React.createElement(BusPaneView, { snapshot, onSelectRun: () => {} })));

const seededHtml = render(SEEDED);
const emptyHtml = render(EMPTY);

// ─── The assertions, each run against BOTH arms ─────────────────────────────
//
// `mustDiscriminate` is the whole design: the predicate must hold on the seeded
// HTML and FAIL on the empty one. An assertion that passes on both is reported
// as a VACUOUS assertion and fails the script — that is T118.1's named disproof
// enforced mechanically, rather than a promise in a comment.

const vacuous = [];
const mustDiscriminate = (label, predicate) => {
  const onSeeded = predicate(seededHtml);
  const onEmpty = predicate(emptyHtml);
  check(`seeded: ${label}`, onSeeded, 'not present in the seeded render');
  if (onSeeded && onEmpty) {
    vacuous.push(label);
    failures++;
    console.log(`  FAIL vacuous: ${label} — also true on an EMPTY bus, so it proves nothing`);
  } else if (onSeeded) {
    console.log(`  ok   discriminates: ${label} (absent on an empty bus)`);
  }
};

console.log('\nT118.1 — seeded run renders (and every assertion discriminates):');
mustDiscriminate('mission run id', (h) => h.includes(RUN_MISSION));
mustDiscriminate('nested wave run id', (h) => h.includes(RUN_WAVE));
mustDiscriminate('run coordinator', (h) => h.includes(COORD));
mustDiscriminate('message body A', (h) => h.includes(BODY_A));
mustDiscriminate('message body B', (h) => h.includes(BODY_B));
mustDiscriminate('thread id', (h) => h.includes(THREAD));
mustDiscriminate('message kind escalation', (h) => h.includes('data-kind="escalation"'));
mustDiscriminate('total order — sequence attrs', (h) => h.includes(`data-sequence="${s1}"`) && h.includes(`data-sequence="${s2}"`));
mustDiscriminate('open gate question', (h) => h.includes(GATE_Q));
mustDiscriminate('open gate marked open', (h) => h.includes('data-gate-state="open"'));
mustDiscriminate('resolved gate ruling', (h) => h.includes(GATE_RULING));
mustDiscriminate('resolved gate marked resolved', (h) => h.includes('data-gate-state="resolved"'));
mustDiscriminate('member handle', (h) => h.includes(READER));
mustDiscriminate('member phase', (h) => h.includes('escalation'));
mustDiscriminate('pending lot rendered', (h) => /lot \d+ · 2 pending/.test(h));
mustDiscriminate('divergence counter missed=41', (h) => h.includes('>41<'));
mustDiscriminate('divergence counter lostWake=13', (h) => h.includes('>13<'));
// SCOPED TO THE COUNTER ROW. The unscoped form — `data-mechanism="delivery"`
// alone — was VACUOUS and the detector above caught it: the live-switch summary
// emits the same attribute on every render, so it was true on an empty bus too.
// Key on the counter row's own class instead.
mustDiscriminate('counter mechanism attr', (h) =>
  /class="bus-counter"[^>]*data-mechanism="delivery"/.test(h),
);

// The FROZEN flags, rendered per run. This is the visible half of T118.2: the
// two seeded runs disagree, and both disagreements must be on screen.
console.log('\nT118.2 (visible half) — each run shows its OWN frozen flags:');
check(
  'mission shows delivery=ON',
  seededHtml.includes('delivery=ON'),
  'the mission was frozen with delivery ON',
);
check(
  'wave shows wake=ON',
  seededHtml.includes('wake=ON'),
  'the wave was frozen with wake ON',
);
check(
  'wave shows delivery=OFF (the OPPOSITE string, not silence)',
  seededHtml.includes('delivery=OFF'),
  'an OFF flag must print its own state',
);
check(
  'a frozen-state attribute is emitted for every mechanism',
  ['delivery', 'wake', 'askGate', 'liveness'].every((m) =>
    seededHtml.includes(`data-mechanism="${m}"`),
  ),
);
// And the run flags are NOT the live switches: liveSwitches has wake=false while
// the wave run's frozen copy has wake=true. If the pane rendered live values
// here, this would be the assertion that caught it.
check(
  'run flags differ from live switches in this fixture',
  SEEDED.liveSwitches.wake === false && runs.find((r) => r.id === RUN_WAVE).flags.wake === true,
  'the fixture must make the two distinguishable, or the check above is vacuous',
);
check(
  'the frozen wake=ON is what reaches the screen',
  seededHtml.includes('data-frozen-state="ON"'),
);

// ─── T118.5 — the bus-unavailable state ─────────────────────────────────────
console.log('\nT118.5 — bus unavailable renders a loud, distinct state:');
const downHtml = render({
  ...EMPTY,
  available: false,
  error: 'NODE_MODULE_VERSION 130 vs 127',
});
check('renders the unavailable marker', downHtml.includes('data-bus-state="unavailable"'));
check('names it in prose', /Fleet bus unavailable/.test(downHtml));
check('carries the DB path', downHtml.includes(dbFile));
check('carries the underlying error', downHtml.includes('NODE_MODULE_VERSION 130 vs 127'));
check('uses role=alert so it is not a silent empty region', downHtml.includes('role="alert"'));
// THE discriminator T118.5 names: it must not look like a quiet bus.
check(
  'the empty-but-healthy render does NOT claim unavailable',
  !emptyHtml.includes('data-bus-state="unavailable"') &&
    emptyHtml.includes('data-bus-state="available"'),
  'an empty bus must not render the unavailable state',
);
check(
  'unavailable and empty-healthy renders DIFFER',
  downHtml !== emptyHtml,
  'if these were identical the pane could not distinguish a dead bus from a quiet one',
);
check(
  'the unavailable render does NOT show the "no messages yet" empty state',
  !downHtml.includes('data-bus-empty="messages"'),
  'a down bus must not be indistinguishable from an empty run',
);

// The counters' honest-empty state (carry-forward 4 at the UI boundary).
// THREE distinct counter states, because two of them are all-zeros-shaped and
// only the flag tells them apart (#116's ask, and it is right):
//   null  — no source answered. NOT "zero divergence".
//   true  — the mirror answered, bus was up. A zero here is a real measurement.
//   false — the mirror answered, bus was DOWN. Counters are still populated
//           (they live in main memory), and every mechanism read OFF for the run.
console.log('\nCounters — the three states are mutually distinguishable:');
check(
  'no source: says so explicitly',
  emptyHtml.includes('NOT the same as zero divergence') &&
    emptyHtml.includes('data-counters-source="absent"'),
);
check(
  'seeded (source present, bus up): does NOT show the absent-source message',
  !seededHtml.includes('NOT the same as zero divergence'),
);

const measuredZero = render({
  ...EMPTY,
  counters: [],
  countersBusAvailable: true,
});
check(
  'measured zero: labelled a MEASURED zero, not a missing instrument',
  measuredZero.includes('measured zero, not a missing instrument') &&
    measuredZero.includes('data-counters-source="present"'),
);
check(
  'measured zero and no-source render DIFFERENTLY',
  measuredZero !== emptyHtml,
  'if these were identical the pane could not tell an unlanded mirror from a clean run',
);

const busDown = render({ ...SEEDED, countersBusAvailable: false });
check(
  'bus-down counters: carry the degraded banner',
  busDown.includes('data-counters-bus="unavailable"') &&
    /bus was UNAVAILABLE while these were counted/.test(busDown),
);
check(
  'bus-down counters still SHOW the numbers (they live in main memory)',
  busDown.includes('>41<') && busDown.includes('>13<'),
  'a bus outage must not blank the counters — that is what it exists to record',
);
check(
  'bus-up seeded render does NOT carry the degraded banner',
  !seededHtml.includes('data-counters-bus="unavailable"'),
);
check(
  'bus-down and bus-up renders DIFFER',
  busDown !== seededHtml,
);

try {
  db.close();
} catch {
  /* already closed */
}
fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
if (vacuous.length) {
  console.log(`VACUOUS ASSERTIONS (passed on an empty bus too): ${vacuous.join(', ')}`);
}
if (failures) {
  console.log(`bus-pane-render-smoke: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('bus-pane-render-smoke: all checks passed');
