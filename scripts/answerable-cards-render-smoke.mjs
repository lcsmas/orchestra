// Render smoke-test for the #21 answerable cards (user dialogs + MCP
// elicitations).
//
// WHY THIS EXISTS — the same coverage hole the context-gauge smoke closes:
// `node --test --experimental-strip-types` strips types but does NOT transform
// JSX, so the unit suite can prove the fold queues an event and still say
// NOTHING about whether a card ever reaches the screen. Those are two different
// claims, and #21's whole point is that the user can SEE and ANSWER these — a
// session that blocks silently is exactly the bug. So this bundles the REAL
// components with esbuild and renders them to static HTML.
//
// It also pins the two contract invariants that are easy to regress silently:
//   • the reply SHAPES (a dialog answers UserDialogResult, an elicitation
//     answers ElicitResult) — a wrong shape leaves the callback parked forever
//     and looks identical to "no bug" in tsc and the unit tests;
//   • the accept/dismiss ASYMMETRY — dismissing must never accept.
//
// SELECTOR CONTRACT: assertions key on CLASS, `data-*`, or rendered TEXT —
// never on tag or DOM position — so restyling cannot break them.
//
// Run: node scripts/answerable-cards-render-smoke.mjs

import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
// Resolve the esbuild vite already ships rather than adding a dependency just
// for this harness. pnpm's layout means it may live under node_modules/vite OR
// only in the .pnpm store, so try both before giving up.
function loadEsbuild() {
  const roots = [
    process.cwd() + '/node_modules/vite',
    process.cwd() + '/node_modules',
    process.cwd(),
  ];
  for (const paths of roots) {
    try {
      return require_(require_.resolve('esbuild', { paths: [paths] }));
    } catch {
      /* try the next root */
    }
  }
  const store = require_('node:fs')
    .globSync?.(process.cwd() + '/node_modules/.pnpm/esbuild@*/node_modules/esbuild') ?? [];
  if (store.length) return require_(store[0]);
  throw new Error('esbuild not resolvable — run `pnpm install` first');
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
const outfile = path.join(repoRoot, 'node_modules', '.cache', 'answerable-cards-smoke.mjs');

const agentDir = path.join(repoRoot, 'src/renderer/components/agent');
const entry = `
import { UserDialogCard } from ${JSON.stringify(path.join(agentDir, 'UserDialogCard.tsx'))};
import { ElicitationCard } from ${JSON.stringify(path.join(agentDir, 'ElicitationCard.tsx'))};
export { UserDialogCard, ElicitationCard };
`;
const entryFile = path.join(repoRoot, 'node_modules', '.cache', 'answerable-cards-entry.tsx');
fs.mkdirSync(path.dirname(entryFile), { recursive: true });
fs.writeFileSync(entryFile, entry);

await build({
  entryPoints: [entryFile],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  // React stays external so the components use the SAME instance this harness
  // renders with; a second copy breaks renderToString.
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

globalThis.self = globalThis;
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };

const { UserDialogCard, ElicitationCard } = await import(`${outfile}?t=${Date.now()}`);

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const base = { seq: 1, at: 1, sessionId: 'S' };

// ── UserDialogCard ───────────────────────────────────────────────────────────

console.log('UserDialogCard renders a dialog with payload options:');
const dlg = {
  ...base,
  type: 'user-dialog-request',
  requestId: 'req-d',
  dialogKind: 'refusal_fallback_prompt',
  payload: { title: 'Continue anyway?', message: 'Claude declined this request.', options: ['Retry', 'Skip'] },
  toolUseId: null,
};
let dlgHtml = renderToString(React.createElement(UserDialogCard, { request: dlg, onReply: () => {} }));
check('renders the payload title', dlgHtml.includes('Continue anyway?'));
check('renders the payload message', dlgHtml.includes('Claude declined this request.'));
check('renders a button per payload option', dlgHtml.includes('Retry') && dlgHtml.includes('Skip'));
check('always offers a dismiss', dlgHtml.includes('Dismiss'));
check(
  'tags the card with the dialog kind for styling/E2E',
  dlgHtml.includes('data-dialog-kind="refusal_fallback_prompt"'),
);
check('reuses the permission dialog surface', dlgHtml.includes('av-permission-dialog'));

// The card must render an UNKNOWN payload rather than an empty shell: dialogKind
// is an OPEN union and payload is opaque, so this is the common case for any
// kind added after this code was written.
console.log('UserDialogCard degrades on an unrecognized payload:');
const bareDlg = {
  ...base,
  type: 'user-dialog-request',
  requestId: 'req-d2',
  dialogKind: 'some_future_kind',
  payload: { unknown_field: 'surprise' },
  toolUseId: null,
};
const bareHtml = renderToString(
  React.createElement(UserDialogCard, { request: bareDlg, onReply: () => {} }),
);
check('falls back to a humanized kind as the heading', bareHtml.includes('Some future kind'));
check('shows the raw payload so the choice is informed', bareHtml.includes('unknown_field'));
check('offers a Continue when the payload has no options', bareHtml.includes('Continue'));

// REPLY SHAPES. A wrong shape here leaves the SDK callback parked forever and
// is invisible to tsc (the handler is typed `unknown` at the boundary) — so it
// is asserted on the real rendered handlers.
console.log('UserDialogCard answers with the SDK UserDialogResult shape:');
{
  const replies = [];
  const el = React.createElement(UserDialogCard, { request: dlg, onReply: (r) => replies.push(r) });
  // Walk the rendered element tree for buttons rather than a DOM: this harness
  // renders to a string, so we invoke the handlers through React's own tree.
  const buttons = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === 'button') buttons.push(node);
    const kids = node.props?.children;
    if (kids) walk(kids);
  };
  // Render one level: UserDialogCard is a function component, so call it.
  walk(el.type(el.props));
  const byText = (t) =>
    buttons.find((b) => JSON.stringify(b.props.children).includes(t));

  byText('Retry')?.props.onClick();
  check(
    'an option completes with that option value',
    JSON.stringify(replies[0]) === JSON.stringify({ behavior: 'completed', result: 'Retry' }),
    JSON.stringify(replies[0]),
  );

  byText('Dismiss')?.props.onClick();
  check(
    'dismiss CANCELS (never completes) — the CLI then applies the default',
    JSON.stringify(replies[1]) === JSON.stringify({ behavior: 'cancelled' }),
    JSON.stringify(replies[1]),
  );
}

// ── ElicitationCard ──────────────────────────────────────────────────────────

console.log('ElicitationCard renders a form elicitation:');
const form = {
  ...base,
  type: 'elicitation-request',
  requestId: 'req-e',
  serverName: 'github',
  message: 'Provide your account details',
  mode: 'form',
  requestedSchema: {
    type: 'object',
    properties: {
      handle: { type: 'string', title: 'Handle', description: 'Your GitHub login' },
      notify: { type: 'boolean' },
      plan: { type: 'string', enum: ['free', 'pro'] },
    },
    required: ['handle'],
  },
};
const formHtml = renderToString(
  React.createElement(ElicitationCard, { request: form, onReply: () => {} }),
);
check('names the requesting MCP server', formHtml.includes('github'));
check('renders the message', formHtml.includes('Provide your account details'));
check('renders a labelled input per schema property', formHtml.includes('Handle'));
check('renders the field description', formHtml.includes('Your GitHub login'));
check('renders an enum as a select with its options', formHtml.includes('<select') && formHtml.includes('pro'));
check('renders a boolean as a checkbox', formHtml.includes('type="checkbox"'));
check('tags the mode for styling/E2E', formHtml.includes('data-elicitation-mode="form"'));
// Submit must be gated on required fields — otherwise the user ships an answer
// the server rejects and the card is gone.
check('Submit is DISABLED while a required field is empty', formHtml.includes('disabled'));
check('offers Decline (a considered no, distinct from cancel)', formHtml.includes('Decline'));

console.log('ElicitationCard renders a url elicitation:');
const urlReq = {
  ...base,
  type: 'elicitation-request',
  requestId: 'req-u',
  serverName: 'github',
  message: 'Sign in to continue',
  mode: 'url',
  url: 'https://example.test/oauth/authorize?x=1',
};
const urlHtml = renderToString(
  React.createElement(ElicitationCard, { request: urlReq, onReply: () => {} }),
);
check('renders the auth URL as a link', urlHtml.includes('https://example.test/oauth/authorize'));
check(
  'the link is noreferrer/noopener (keeps the app origin off a third-party page)',
  urlHtml.includes('noreferrer') && urlHtml.includes('noopener'),
);
check('url mode shows Done, not Submit', urlHtml.includes('Done') && !urlHtml.includes('Submit'));
check(
  'url mode has NO form fields to gate on, so Done is enabled',
  !urlHtml.includes('disabled'),
);
check('tags the mode', urlHtml.includes('data-elicitation-mode="url"'));

console.log(
  failures === 0 ? '\nALL RENDER CHECKS PASSED' : `\n${failures} RENDER CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
