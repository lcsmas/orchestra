// Render smoke-test for the queue tray (prompts parked behind an in-flight
// turn).
//
// WHY THIS EXISTS — `node --test --experimental-strip-types` strips types but
// does NOT transform JSX, so the unit suite can prove the FOLD tracks
// `queuedPrompts` and still say nothing about whether the tray ever reaches the
// screen. Those are two different claims, and the whole point of this feature is
// that the user can SEE what is pending and act on it — a queue that exists only
// in the store is the exact bug being fixed.
//
// It also pins the invariant that is easiest to regress silently: the header's
// TURN COUNT. "3 queued" does not tell you whether that runs as one turn or
// three, and the merge affordance is meaningless without it.
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
const outfile = path.join(repoRoot, 'node_modules', '.cache', 'queue-tray-smoke.mjs');
const agentDir = path.join(repoRoot, 'src/renderer/components/agent');

const entry = `
import { QueueTray, turnCount } from ${JSON.stringify(path.join(agentDir, 'QueueTray.tsx'))};
import { MessageBubble } from ${JSON.stringify(path.join(agentDir, 'MessageBubble.tsx'))};
export { QueueTray, turnCount, MessageBubble };
`;
const entryFile = path.join(repoRoot, 'node_modules', '.cache', 'queue-tray-entry.tsx');
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

const { QueueTray, turnCount, MessageBubble } = await import(`${outfile}?t=${Date.now()}`);

// React's SSR inserts `<!-- -->` separators between adjacent interpolated
// values, so `{n} queued` renders as `3<!-- --> queued`. Strip those before
// matching on prose — otherwise a correct component fails a naive assertion
// (which is exactly what happened when this harness was first written).
const text = (html) => html.replace(/<!-- -->/g, '');

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const noop = () => {};
const render = (queued) =>
  renderToString(
    React.createElement(QueueTray, {
      queued,
      onRemove: noop,
      onEdit: noop,
      onMove: noop,
      onCoalesce: noop,
      onMergeAll: noop,
    }),
  );

const q = (id, text, coalesceWithNext = false) => ({ id, text, coalesceWithNext });

// ── Visibility ───────────────────────────────────────────────────────────────

console.log('QueueTray visibility:');
check('renders NOTHING when the queue is empty', render([]) === '');

const three = [q('a', 'first prompt'), q('b', 'second prompt'), q('c', 'third prompt')];
const html3 = render(three);
check('renders every queued prompt', ['first', 'second', 'third'].every((t) => html3.includes(t)));
check('shows the queue depth', text(html3).includes('3 queued'));
check('exposes a labelled region for a11y', html3.includes('aria-label="Queued messages"'));
check(
  'numbers rows so delivery order is unambiguous',
  html3.includes('data-queue-index="0"') && html3.includes('data-queue-index="2"'),
);

// ── The turn count: the load-bearing invariant ───────────────────────────────

console.log('Turn count (what the raw queue length cannot tell you):');
check('3 separate prompts read as 3 turns', text(html3).includes('as 3 turns'));

const merged = [q('a', 'first', true), q('b', 'second', true), q('c', 'third')];
check('a fully merged run reads as 1 turn', text(render(merged)).includes('as 1 turn'));
check('pure function: 3 separate → 3', turnCount(three) === 3);
check('pure function: 3 merged → 1', turnCount(merged) === 1);
check(
  'pure function: a merged PAIR plus a loner → 2',
  turnCount([q('a', 'x', true), q('b', 'y'), q('c', 'z')]) === 2,
);
check('pure function: empty → 0', turnCount([]) === 0);
// A trailing merge mark has nothing to absorb — it must not fabricate a turn.
check(
  'pure function: a mark on the LAST entry does not change the count',
  turnCount([q('a', 'x'), q('b', 'y', true)]) === 2,
);

// ── Affordances ──────────────────────────────────────────────────────────────

console.log('Per-row affordances:');
check('every row offers cancel', (html3.match(/Cancel message/g) ?? []).length === 3);
check('every row offers edit', (html3.match(/Edit message/g) ?? []).length === 3);
check('offers merge-all while more than one turn remains', html3.includes('Merge all into one turn'));
check(
  'HIDES merge-all once everything is already one turn',
  !render(merged).includes('Merge all into one turn'),
);
check(
  'marks a merged row for the fused styling',
  render(merged).includes('av-queue-row-merged'),
);
check(
  'reflects merge state to assistive tech',
  render(merged).includes('aria-pressed="true"'),
);

// ── The transcript bubble must stop claiming it was sent ─────────────────────

console.log('Queued user bubble:');
const bubble = (queued) =>
  renderToString(
    React.createElement(MessageBubble, {
      message: {
        id: 'user:1',
        role: 'user',
        text: 'a parked prompt',
        at: 1,
        done: true,
        ...(queued ? { queued: true } : {}),
      },
    }),
  );
check('a parked bubble is tagged for the pending treatment', bubble(true).includes('data-queued="1"'));
check('a delivered bubble carries no such tag', !bubble(false).includes('data-queued'));

// REGRESSION: MessageBubble is React.memo'd behind an ALLOWLIST comparator.
// `queued` is the only field there that mutates mid-life (it clears when the
// queue drains), and leaving it out of the comparator left the store correct
// while the DOM kept rendering drained prompts as pending — a bug the fold's
// own unit tests are structurally blind to. Assert the comparator SEES it.
const memoCompare = MessageBubble.compare;
const msg = (extra) => ({ id: 'user:1', role: 'user', text: 'x', at: 1, done: true, ...extra });
check(
  'the memo comparator treats a queued change as a re-render',
  typeof memoCompare === 'function' &&
    memoCompare({ message: msg({ queued: true }) }, { message: msg({}) }) === false,
  'MessageBubble.compare ignores `queued` — drained bubbles will not repaint',
);
check(
  'the memo comparator still short-circuits identical messages',
  typeof memoCompare === 'function' &&
    memoCompare({ message: msg({ queued: true }) }, { message: msg({ queued: true }) }) === true,
);

console.log(failures === 0 ? '\nqueue-tray render smoke: PASS' : `\nqueue-tray render smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
