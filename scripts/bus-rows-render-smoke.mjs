// Render smoke-test for bus wake orders + deliveries as first-class rows (#145).
//
// WHY THIS EXISTS — `node --test --experimental-strip-types` strips types but
// does NOT transform JSX, so the unit suite proves the DETECTION/FOLD logic
// (src/shared/bus-rows.test.ts) yet says nothing about whether a wake or a
// delivery ever reaches the SCREEN as its dedicated row. Those are two claims;
// the feature is the second.
//
// It pins, each failing in a different direction:
//   1. WAKE collapsed  — amber bell chip line + run chip, body NOT leaked.
//   2. WAKE expanded   — the exact ordered `orchestra check --run` commands.
//   3. DELIVERY pending — lot view, per-message grid, PENDING badge.
//   4. DELIVERY acked   — SAME lot renders the ACKED badge (the flip).
//   5. DELIVERY empty   — an empty lot shows "no pending", no badge, no body.
//   6. CONTROL (G3/G4 must-FAIL) — a plain human turn saying "lot pending" is a
//      normal bubble, NOT a wake row; and the detection routing keeps them apart.
//
// SELECTOR CONTRACT: assertions key on CLASS, `data-*`, or rendered TEXT — never
// on tag or DOM position — so restyling cannot break them.

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
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(repoRoot, 'node_modules', '.cache', 'bus-rows-smoke.mjs');
const agentDir = path.join(repoRoot, 'src/renderer/components/agent');
const sharedDir = path.join(repoRoot, 'src/shared');

const entry = `
import { WakeRow } from ${JSON.stringify(path.join(agentDir, 'WakeRow.tsx'))};
import { DeliveryRow } from ${JSON.stringify(path.join(agentDir, 'DeliveryRow.tsx'))};
import { MessageBubble } from ${JSON.stringify(path.join(agentDir, 'MessageBubble.tsx'))};
import { isBusWakeMessage, isCheckInvocation, parseCheckOutput, foldDelivery, ackLotId } from ${JSON.stringify(path.join(sharedDir, 'bus-rows.ts'))};
export { WakeRow, DeliveryRow, MessageBubble, isBusWakeMessage, isCheckInvocation, parseCheckOutput, foldDelivery, ackLotId };
`;
const entryFile = path.join(repoRoot, 'node_modules', '.cache', 'bus-rows-entry.tsx');
fs.mkdirSync(path.dirname(entryFile), { recursive: true });
fs.writeFileSync(entryFile, entry);

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

const {
  WakeRow,
  DeliveryRow,
  MessageBubble,
  isBusWakeMessage,
  isCheckInvocation,
  parseCheckOutput,
  foldDelivery,
  ackLotId,
} = await import(`${outfile}?t=${Date.now()}`);

const text = (html) => html.replace(/<!-- -->/g, '');

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

// The exact wake order the host builds (WAKE_ORDER_HEADER + one check line/run).
const WAKE_HEADER = 'lot pending — run the check command(s) below, then ack each lot:';
const wakeText = (runs) =>
  [WAKE_HEADER, ...runs.map((r) => `orchestra check --run ${r}`)].join('\n');
const wakeMsg = (runs) => ({ id: 'w1', role: 'user', text: wakeText(runs), done: true });

const CHECK_OUTPUT = {
  run: 'wave-g-canary',
  reader: 'ops-g',
  lot: 312,
  replay: false,
  from: 41,
  to: 43,
  count: 2,
  messages: [
    { sequence: 42, kind: 'status', sender: 'impl-144', recipient: 'ops-g', thread_id: null, body: 'G1–G6 green, branch pushed\nsecond line', created_at: 1 },
    { sequence: 43, kind: 'ask', sender: 'impl-142', recipient: 'ops-g', thread_id: null, body: 'restart path: keep wording?', created_at: 2 },
  ],
  gates: [],
};

// ── 1. WAKE collapsed ─────────────────────────────────────────────────────────
console.log('Wake row — collapsed by default:');
const wCollapsed = text(renderToString(React.createElement(WakeRow, { message: wakeMsg(['wave-g-canary', 'lead-ancestor']) })));
check('renders a wake container', wCollapsed.includes('data-wake="1"'));
check('is CLOSED by default', wCollapsed.includes('av-closed') && !wCollapsed.includes('av-open'));
check('header reports aria-expanded="false"', wCollapsed.includes('aria-expanded="false"'));
check('labels it a Wake order', wCollapsed.includes('Wake order'));
check('names the run count in a chip', wCollapsed.includes('check 2 runs'));
check('does NOT leak the commands while collapsed', !wCollapsed.includes('orchestra check --run'), 'collapsed wake leaked its commands');
check('renders no expanded body while collapsed', !wCollapsed.includes('data-wake-body'));

// ── 2. WAKE expanded ──────────────────────────────────────────────────────────
console.log('\nWake row — expanded (SSR open branch):');
const wOpen = text(renderToString(React.createElement(WakeRow, { message: wakeMsg(['wave-g-canary', 'lead-ancestor']), defaultOpen: true })));
check('is marked OPEN', wOpen.includes('av-open') && !wOpen.includes('av-closed'));
check('renders the command body', wOpen.includes('data-wake-body="1"'));
check('shows the EXACT ordered check commands', wOpen.includes('orchestra check --run lead-ancestor') && wOpen.includes('orchestra check --run wave-g-canary'));
check('collapsed and expanded genuinely differ', wOpen !== wCollapsed && wOpen.length > wCollapsed.length, 'defaultOpen had no effect');
const wOne = text(renderToString(React.createElement(WakeRow, { message: wakeMsg(['r1']) })));
check('singular chip for one run', wOne.includes('check 1 run') && !wOne.includes('check 1 runs'));

// ── 3. DELIVERY pending ───────────────────────────────────────────────────────
console.log('\nDelivery row — PENDING (no matching ack):');
const dPending = text(renderToString(React.createElement(DeliveryRow, { delivery: foldDelivery(CHECK_OUTPUT, new Set()), defaultOpen: true })));
check('renders a delivery container', dPending.includes('data-delivery="1"'));
check('names the lot', dPending.includes('Lot #312'));
check('names the message count', dPending.includes('2 messages'));
check('renders the run chip', dPending.includes('wave-g-canary'));
check('shows a PENDING badge', dPending.includes('av-pending') && dPending.includes('data-acked="0"'));
check('does NOT show an ACKED badge', !dPending.includes('av-acked'));
check('renders each message route', dPending.includes('impl-144') && dPending.includes('impl-142') && dPending.includes('ops-g'));
check('renders each message kind', dPending.includes('status') && dPending.includes('ask'));
check('previews the first body line only', dPending.includes('G1–G6 green, branch pushed') && !dPending.includes('second line'), 'delivery leaked the full multi-line body');

// ── 4. DELIVERY acked — the badge FLIP ────────────────────────────────────────
console.log('\nDelivery row — ACKED (matching ack collected):');
const dAcked = text(renderToString(React.createElement(DeliveryRow, { delivery: foldDelivery(CHECK_OUTPUT, new Set([312])), defaultOpen: true })));
check('shows an ACKED badge', dAcked.includes('av-acked') && dAcked.includes('data-acked="1"'));
check('does NOT show a PENDING badge', !dAcked.includes('av-pending'));
check('acked and pending markup genuinely differ', dAcked !== dPending, 'the badge did not flip on ack');

// ── 5. DELIVERY empty ─────────────────────────────────────────────────────────
console.log('\nDelivery row — empty lot:');
const EMPTY = { ...CHECK_OUTPUT, lot: null, count: 0, messages: [] };
const dEmpty = text(renderToString(React.createElement(DeliveryRow, { delivery: foldDelivery(EMPTY, new Set([312])) })));
check('shows a "no pending" line', dEmpty.includes('No pending messages'));
check('empty lot carries NO badge', !dEmpty.includes('av-acked') && !dEmpty.includes('av-pending'), 'an empty lot must not be acked/pending');

// ── 6. CONTROL — G3/G4 must-FAIL ──────────────────────────────────────────────
//
// A human turn saying "lot pending" is NOT a wake, and the detection routing
// keeps a wake and a delivery keyed on the MARKER/CLI, never body text. If any
// of these ever regresses to a text match, this is what catches it.
console.log('\nControl (G3/G4 must-FAIL):');
const humanTurn = {
  id: 'h1',
  role: 'user',
  text: 'is there a lot pending on the canary run? just checking before I step away',
  done: true,
};
const htmlHuman = text(renderToString(React.createElement(MessageBubble, { message: humanTurn })));
check('control: renders a normal user bubble', htmlHuman.includes('av-message-user'));
check('control: is NOT a wake row', !htmlHuman.includes('data-wake="1"'));
check('control: routing does NOT classify it as a wake', isBusWakeMessage(humanTurn) === false);
// The header alone (no command line) is not a wake — the marker assertion is as
// specific as the claim it certifies (carry-forward #2).
check('control: the header ALONE is not a wake', isBusWakeMessage({ role: 'user', text: WAKE_HEADER }) === false);
// A real wake IS classified (positive control).
check('positive control: a real wake order IS a wake', isBusWakeMessage(wakeMsg(['r1'])) === true);
// A non-bus Bash card whose OUTPUT looks like a check is NOT a delivery.
const impostor = { role: 'tool', toolUse: { name: 'Bash', input: { command: 'cat lot.json' } }, toolResult: { content: JSON.stringify(CHECK_OUTPUT), isError: false } };
check('control: a non-bus Bash card is NOT a check invocation', isCheckInvocation(impostor) === false);
check('control: and does not parse as a delivery', parseCheckOutput(impostor) === null);
// Positive control: a real check card DOES parse.
const realCard = { role: 'tool', toolUse: { name: 'Bash', input: { command: 'orchestra check --run wave-g-canary' } }, toolResult: { content: JSON.stringify(CHECK_OUTPUT), isError: false } };
check('positive control: a real check card parses', parseCheckOutput(realCard) !== null);
// Ack detection reads the lot id.
check('ack detection reads the lot id', ackLotId({ role: 'tool', toolUse: { name: 'Bash', input: { command: 'orchestra ack 312' } } }) === 312);

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
