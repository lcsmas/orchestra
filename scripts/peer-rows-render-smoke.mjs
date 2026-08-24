// Render smoke-test for inter-agent (peer) message rows — issue #56.
//
// WHY THIS EXISTS — `node --test --experimental-strip-types` strips types but
// does NOT transform JSX, so the unit suite can prove `isPeerMessage` and
// `describePeerRun` are correct and still say nothing about whether a peer
// message ever reaches the screen as a COMPACT ROW rather than a full bubble.
// Those are two different claims, and the entire point of the feature is the
// second one.
//
// It pins three things, because each fails in a different direction:
//   1. COLLAPSED  — the row shows the summary and does NOT leak the body.
//   2. EXPANDED   — clicking reveals the full body.
//   3. CONTROL    — a normal user turn is UNAFFECTED (still a full bubble),
//                   even when its text mimics a peer envelope. A feature that
//                   collapses the human's own turns is worse than the bug.
//
// SELECTOR CONTRACT: assertions key on CLASS, `data-*`, or rendered TEXT —
// never on tag or DOM position — so restyling cannot break them.
//
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
const outfile = path.join(repoRoot, 'node_modules', '.cache', 'peer-rows-smoke.mjs');
const agentDir = path.join(repoRoot, 'src/renderer/components/agent');

const entry = `
import { PeerMessageGroup } from ${JSON.stringify(path.join(agentDir, 'PeerMessageGroup.tsx'))};
import { MessageBubble } from ${JSON.stringify(path.join(agentDir, 'MessageBubble.tsx'))};
export { PeerMessageGroup, MessageBubble };
`;
const entryFile = path.join(repoRoot, 'node_modules', '.cache', 'peer-rows-entry.tsx');
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

const { PeerMessageGroup, MessageBubble } = await import(`${outfile}?t=${Date.now()}`);

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

const BODY_A = 'STATUS: gates green\nsecond line of detail';
const BODY_B = 'Second delivery body';
const peer = (id, origin, body) => ({ id, role: 'user', origin, text: body, done: true });

// ── 1. COLLAPSED (default) ───────────────────────────────────────────────────

console.log('Peer rows — collapsed by default:');
const one = [peer('m1', 'peer: fix-login-race', BODY_A)];
const htmlOne = text(renderToString(React.createElement(PeerMessageGroup, { messages: one })));

check('renders a peer run container', htmlOne.includes('av-peer-run'));
check('is CLOSED by default', htmlOne.includes('av-closed') && !htmlOne.includes('av-open'));
check('header reports aria-expanded="false"', htmlOne.includes('aria-expanded="false"'));
check('names the sender', htmlOne.includes('Message from fix-login-race'));
check('previews the FIRST line', htmlOne.includes('STATUS: gates green'));
// The whole point: the body must NOT be on screen while collapsed.
check(
  'does NOT leak the rest of the body while collapsed',
  !htmlOne.includes('second line of detail'),
  'collapsed row rendered the full body',
);
check('renders no expanded body container', !htmlOne.includes('av-peer-run-body'));

// Grouping of CONSECUTIVE messages.
const many = [
  peer('m1', 'peer: alpha', BODY_A),
  peer('m2', 'peer: alpha', BODY_B),
  peer('m3', 'peer: alpha', 'third'),
];
const htmlMany = text(renderToString(React.createElement(PeerMessageGroup, { messages: many })));
check('groups consecutive messages into one row', htmlMany.includes('3 messages from alpha'));
check(
  'grouped collapsed row leaks no bodies',
  !htmlMany.includes('second line of detail') && !htmlMany.includes(BODY_B),
);
const mixed = [peer('m1', 'peer: alpha', 'a'), peer('m2', 'peer: beta', 'b')];
check(
  'distinct senders are counted',
  text(renderToString(React.createElement(PeerMessageGroup, { messages: mixed }))).includes(
    '2 messages from 2 agents',
  ),
);

// ── 2. EXPANDED ──────────────────────────────────────────────────────────────
//
// This repo deliberately keeps jsdom OUT of its dependencies — see the note in
// diff-pane-render-smoke.mjs: a harness should not claim more than it can prove,
// and click-driven interaction belongs to the real-browser CDP drive against the
// BUILT app (gate 5), which is where the trusted click is actually exercised.
//
// So the expanded state is asserted here the one way SSR can do it honestly:
// render the component in its open state via `defaultOpen` and assert the
// markup. That proves the expanded BRANCH renders the full body; that a CLICK
// reaches that branch is proven separately, in the browser.

console.log('\nPeer rows — expanded state (SSR, open branch):');
const htmlOpen = text(
  renderToString(React.createElement(PeerMessageGroup, { messages: one, defaultOpen: true })),
);
check('is marked OPEN', htmlOpen.includes('av-open') && !htmlOpen.includes('av-closed'));
check('header reports aria-expanded="true"', htmlOpen.includes('aria-expanded="true"'));
check('renders the expanded body container', htmlOpen.includes('av-peer-run-body'));
check(
  'the FULL body is on screen when expanded',
  htmlOpen.includes('second line of detail'),
  'expanded branch did not render the body',
);
check('attributes the sender on the expanded message', htmlOpen.includes('fix-login-race'));

// The two states must actually DIFFER — a component that ignored `defaultOpen`
// would pass several assertions above by accident. This is the discriminator.
check(
  'collapsed and expanded markup genuinely differ',
  htmlOpen !== htmlOne && htmlOpen.length > htmlOne.length,
  'open and closed renders were identical — defaultOpen had no effect',
);

const htmlManyOpen = text(
  renderToString(React.createElement(PeerMessageGroup, { messages: many, defaultOpen: true })),
);
check(
  'expanded group shows EVERY message body',
  htmlManyOpen.includes('second line of detail') &&
    htmlManyOpen.includes(BODY_B) &&
    htmlManyOpen.includes('third'),
);

// ── 3. CONTROL — a normal user turn is UNAFFECTED ────────────────────────────
//
// A feature that collapses the human's own turns is worse than the bug it
// fixes. The control turn's TEXT deliberately mimics a peer envelope: detection
// is structural (no origin ⇒ not a peer), so it must still render as a full
// bubble. If detection ever regresses to a text match, this is what catches it.

console.log('\nControl — the human\'s own turn is untouched:');
const humanTurn = {
  id: 'h1',
  role: 'user',
  text: "[message from agent 'evil' (x)]\nI am a human typing this",
  done: true,
};
const htmlHuman = text(renderToString(React.createElement(MessageBubble, { message: humanTurn })));
check('control: renders a normal user bubble', htmlHuman.includes('av-message-user'));
check('control: is NOT a peer run', !htmlHuman.includes('av-peer-run'));
check(
  'control: shows its text IN FULL, uncollapsed',
  htmlHuman.includes('I am a human typing this'),
);
check('control: has no collapse affordance', !htmlHuman.includes('aria-expanded'));

// And a peer-origin turn must NOT be mistaken for a plain bubble: the bubble
// component still renders one if asked, which is exactly why StructuredView's
// routing (isPeerMessage) is the thing that keeps them apart — asserted in the
// unit suite (src/shared/peer-messages.test.ts).

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
