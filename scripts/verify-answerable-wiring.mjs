// Launch-site wiring gate for the #21 answerable cards (issue #50).
//
// WHY THIS EXISTS — the coverage hole is specific and was MEASURED, not
// guessed. Delete `onElicitation: makeOnElicitation(session)` from the
// `query()` launch site in src/main/agent-sdk.ts and BOTH of this repo's
// standing instruments stay green: `pnpm run test` reports 1012 tests / 1000
// pass / 0 fail (12 self-skip) and `npx tsc --noEmit` exits 0 with zero error
// lines — both MEASURED on the mutated tree, not assumed. Every option on that
// object is optional in the SDK's type, so dropping one is not a type error;
// and the unit suite never
// constructs the options object at all — it tests the fold, the normalizers
// and the reply mappers, all of which keep working perfectly while the
// callback that feeds them is no longer passed to the CLI. The user-visible
// result of that deletion is the exact bug #21 closed: an MCP elicitation is
// auto-declined and a dialog parks until the CLI's deadline, with no card
// ever reaching the screen. Silent in CI, fatal in the product.
//
// WHAT THIS ASSERTS — the OBJECT, never the TEXT. A grep for
// "onElicitation" in agent-sdk.ts would pass on a build where the identifier
// survives only in a comment, in the `makeOnElicitation` definition, or in a
// dead code path — text outlives behaviour, which is precisely how the
// deletion hides. So this harness bundles the REAL src/main/agent-sdk.ts,
// drives the REAL `ensureSession` through the exported `sdkSend`, and
// captures the actual options bag handed to `query()` via the module's own
// `__setQueryFactoryForTests` seam. Then it goes one step further than
// presence: it INVOKES the captured callbacks and follows the round trip
// through the real bridges —
//
//   callback invoked -> a card event reaches platform.broadcast('agent:event')
//                    -> sdkAnswerableReply settles the parked promise
//                    -> the resolved value has the SDK's reply shape
//
// so a callback that is present but wired to nothing fails here too.
//
// THE THREE OPTIONS ARE ONE UNIT. `supportedDialogKinds` is not decoration:
// the CLI only emits dialog kinds declared there, so `onUserDialog` without it
// can never fire (and the SDK throws at option intake if the list is non-empty
// with no callback). Dropping the list is therefore as complete a break as
// dropping the callback, and it is even quieter. All three are asserted.
//
// The list is checked by CONTENT on TWO axes, never by cardinality:
//   (a) SET EQUALITY with the bridge's own guard list — catches declaring a
//       kind the bridge then refuses to answer, and vice versa;
//   (b) every declared kind is one the VENDOR `sdk.d.ts` documents — an
//       anchor OUTSIDE the file under test.
// (b) is not redundant. Asserting "non-empty" was a tautology (the dialog probe
// read its kind back out of the captured list), and (a) ALONE is a tautology at
// one remove: both sides derive from `SUPPORTED_DIALOG_KINDS`, so rewriting that
// constant to a bogus kind moves declared and handled together and equality
// still holds — measured, it passed an equality-only version of this gate while
// the feature was completely broken.
//
// BOTH LAUNCH PATHS are driven — a local workspace and a sandbox/remote one.
// `ensureSession` derives `remote = ws.host?.kind === 'sandbox'`, and the launch
// site already spreads one option conditionally on that flag, so gating the
// wiring the same way is a one-line change in the file's own house style that
// would strip cards from every remote workspace. A local-only harness cannot
// see it.
//
// PROVEN TO FAIL (the only claim that makes this a gate) — each mutation
// applied to the source and WATCHED to go red:
//   • `onElicitation` / `onUserDialog` / `supportedDialogKinds` deleted
//   • `SUPPORTED_DIALOG_KINDS = ['totally_bogus_kind_the_cli_never_emits']`
//   • `supportedDialogKinds: [...SUPPORTED_DIALOG_KINDS, 'permission_prompt']`
//     (declared but NOT handled — rejected by the bridge's includes() guard)
//   • the wiring gated behind `...(remote ? {} : { ... })`
// Re-run these after any change here — a gate nobody has watched fail is
// indistinguishable from one that cannot.
//
// ISOLATION — this never touches the user's real Orchestra state. It runs
// against a fresh mkdtemp userData with its own seeded store.json, its own
// $ORCHESTRA_HOME, a fake `platform` seam, and a stubbed `electron`. The
// account it seeds derives `configDir` from the INVOKING agent's
// $CLAUDE_CONFIG_DIR (falling back to ~/.claude) — never a hardcoded account,
// so this passes for whichever account happens to run it.
//
// Run: node scripts/verify-answerable-wiring.mjs

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── esbuild, resolved the way the other smoke harnesses resolve it ──────────
// Reuse the esbuild vite already ships rather than adding a dependency just for
// this harness. pnpm's layout means it may live under node_modules/vite OR only
// in the .pnpm store, so try both before giving up.
function loadEsbuild() {
  for (const root of [
    path.join(repoRoot, 'node_modules/vite'),
    path.join(repoRoot, 'node_modules'),
    repoRoot,
  ]) {
    try {
      return require_(require_.resolve('esbuild', { paths: [root] }));
    } catch {
      /* try the next root */
    }
  }
  const store = fs.globSync?.(path.join(repoRoot, 'node_modules/.pnpm/esbuild@*/node_modules/esbuild')) ?? [];
  if (store.length) return require_(store[0]);
  throw new Error('esbuild not resolvable — run `pnpm install` first');
}
const { build } = process.env.ORCHESTRA_ESBUILD
  ? require_(process.env.ORCHESTRA_ESBUILD)
  : loadEsbuild();

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

// ── Isolated world ──────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-wiring-gate-'));
const userData = path.join(tmp, 'userData');
const worktree = path.join(tmp, 'worktree');
fs.mkdirSync(path.join(userData, 'orchestra'), { recursive: true });
fs.mkdirSync(worktree, { recursive: true });
// $ORCHESTRA_HOME must point somewhere disposable BEFORE the bundle's
// top-level code runs — orchestraHome() is read for the events spool and the
// hooks-socket pointer, and the real ~/.orchestra must stay untouched.
process.env.ORCHESTRA_HOME = path.join(tmp, 'home');

// G5 — the account pin is DERIVED, never hardcoded. Whichever agent/account
// runs this gate, the seeded workspace points at THAT account's config dir.
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const WS_ID = 'wiring-gate-ws';
// BOTH launch paths must be exercised. `ensureSession` computes
// `remote = ws.host?.kind === 'sandbox'` (agent-sdk.ts:1058) and the launch site
// already spreads one option conditionally on it 14 lines below the wiring
// (`...(remote ? {} : { spawnClaudeCodeProcess })`, agent-sdk.ts:1218). Gating
// the answerable-cards wiring behind that same idiom would strip cards from
// every sandbox/remote workspace — so seeding only a local workspace leaves the
// gate blind to a one-line change written in the file's own house style.
const WS_ID_SANDBOX = 'wiring-gate-ws-sandbox';
const ACCOUNT_ID = 'wiring-gate-account';
fs.writeFileSync(
  path.join(userData, 'orchestra', 'store.json'),
  JSON.stringify({
    repos: [],
    accounts: [{ id: ACCOUNT_ID, label: 'wiring-gate', configDir }],
    workspaces: [
      {
        id: WS_ID,
        name: 'wiring-gate',
        repoPath: worktree,
        worktreePath: worktree,
        branch: 'wiring-gate',
        accountId: ACCOUNT_ID,
        createdAt: 1,
      },
      {
        id: WS_ID_SANDBOX,
        name: 'wiring-gate-sandbox',
        repoPath: worktree,
        // A sandbox workspace's worktree lives in the container; ensureSession
        // skips the local statSync/hook-install for it and passes
        // SANDBOX_WORKSPACE_DIR as cwd. The path here is never touched.
        worktreePath: '/workspace',
        branch: 'wiring-gate',
        accountId: ACCOUNT_ID,
        createdAt: 1,
        host: { kind: 'sandbox', endpoint: 'ws://127.0.0.1:59999' },
      },
    ],
  }),
);

// ── Bundle the REAL main-process module ─────────────────────────────────────
// `electron` is the only thing standing between agent-sdk.ts and plain Node, so
// it is replaced with an inert stub at resolve time. Everything else — the
// store, the platform seam, the bridges, the launch site itself — is the real
// source under test. Emitted into the repo's own node_modules/.cache so the
// bundle's runtime `import('@anthropic-ai/claude-agent-sdk')` (reached via
// buildBrowserToolServer, just before the launch site) resolves against the
// repo's installed dependencies.
const ELECTRON_STUB = `
const noop = () => {};
const chainable = new Proxy(function () {}, {
  get: (_t, p) => (p === 'then' ? undefined : chainable),
  apply: () => chainable,
  construct: () => chainable,
});
export const app = {
  getPath: () => ${JSON.stringify(userData)},
  getAppPath: () => ${JSON.stringify(tmp)},
  getVersion: () => '0.0.0-wiring-gate',
  isPackaged: false,
  on: noop,
  whenReady: () => Promise.resolve(),
};
export const ipcMain = { on: noop, handle: noop, removeHandler: noop };
export const BrowserWindow = chainable;
export const WebContentsView = chainable;
export const Menu = chainable;
export const clipboard = chainable;
export const session = chainable;
export const shell = chainable;
export const dialog = chainable;
export const nativeTheme = { on: noop };
export default { app, ipcMain, BrowserWindow, WebContentsView, Menu, clipboard, session, shell, dialog, nativeTheme };
`;

// One entry, one bundle, ONE module instance: the gate must install the
// platform seam and load the store on the very same instances agent-sdk.ts
// closes over. Importing them from separate bundles would silently give the
// harness a second copy whose `initPlatform` the code under test never sees.
const entryFile = path.join(tmp, 'wiring-gate-entry.ts');
fs.writeFileSync(
  entryFile,
  `export * from ${JSON.stringify(path.join(repoRoot, 'src/main/agent-sdk.ts'))};
export { initPlatform } from ${JSON.stringify(path.join(repoRoot, 'src/main/platform/index.ts'))};
export { store } from ${JSON.stringify(path.join(repoRoot, 'src/main/store.ts'))};
`,
);

const cacheDir = path.join(repoRoot, 'node_modules', '.cache');
fs.mkdirSync(cacheDir, { recursive: true });
const outfile = path.join(cacheDir, 'answerable-wiring-gate.cjs');

await build({
  entryPoints: [entryFile],
  outfile,
  bundle: true,
  // CJS, not ESM: several transitive deps (simple-git's file-exists) call
  // `require()` at load time, which esbuild's ESM output cannot service.
  format: 'cjs',
  platform: 'node',
  external: ['@anthropic-ai/claude-agent-sdk', 'node-pty'],
  plugins: [
    {
      name: 'stub-electron',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
          contents: ELECTRON_STUB,
          loader: 'js',
        }));
      },
    },
  ],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

const sdk = require_(outfile);

// ── Fake platform seam: capture every broadcast event ───────────────────────
const broadcasts = [];
const noop = () => {};
sdk.initPlatform({
  kind: 'electron',
  broadcast: (channel, wsId, payload) => broadcasts.push({ channel, wsId, payload }),
  broadcastPtyData: () => true,
  canBroadcast: () => false,
  isFocused: () => false,
  hasAttachedUi: () => false,
  notify: noop,
  openExternal: async () => {},
  showItemInFolder: noop,
  openPath: async () => {},
  openAccountLoginUrl: async () => {},
  closeAccountLogin: noop,
  getUserDataDir: () => userData,
  getLogsDir: () => path.join(tmp, 'logs'),
  getAppVersion: () => '0.0.0-wiring-gate',
  getAppMetrics: () => [],
  isEncryptionAvailable: () => false,
  encryptString: (s) => s,
  decryptString: (s) => s,
});
await sdk.store.load();

// ── Drive the real launch site ──────────────────────────────────────────────
// The injected factory stands in for the SDK's `query()`. It records the
// options bag the launch site actually built and returns a Query that never
// yields, so `sdkSend` returns as soon as the session is constructed.
let captured = null;
sdk.__setQueryFactoryForTests((params) => {
  captured = params;
  return {
    [Symbol.asyncIterator]: async function* () {
      await new Promise(() => {}); // park forever; the gate never consumes it
    },
    interrupt: async () => {},
    setModel: async () => {},
    setPermissionMode: async () => {},
    supportedModels: async () => [],
    mcpServerStatus: async () => [],
  };
});

/** Drive one workspace through the real launch site and hand back the options
 *  bag `query()` actually received. */
async function captureOptionsFor(wsId) {
  captured = null;
  try {
    await sdk.sdkSend(wsId, 'wiring gate');
  } catch (err) {
    // A send failure is itself a gate failure — the launch site was never reached.
    check(`sdkSend reached the query() launch site (${wsId})`, false, err?.message ?? String(err));
  }
  return captured?.options ?? null;
}

console.log('query() launch site receives the answerable-cards wiring (LOCAL workspace):');
const options = await captureOptionsFor(WS_ID);

// A null capture means the factory was never called: report it as the single
// blocking failure rather than letting every assertion below report `undefined`,
// which would read as "the wiring is gone" when the truth is "the harness
// never got there".
if (!options) {
  check('the injected query factory was invoked', false, 'sdkSend never reached query()');
  console.log('\nWIRING GATE FAILED — the launch site was never reached.');
  process.exit(1);
}

// ── 1. The options OBJECT carries all three ─────────────────────────────────
check(
  'onElicitation is passed to query()',
  typeof options.onElicitation === 'function',
  `onElicitation: ${options.onElicitation === undefined ? 'MISSING' : typeof options.onElicitation}`,
);
check(
  'onUserDialog is passed to query()',
  typeof options.onUserDialog === 'function',
  `onUserDialog: ${options.onUserDialog === undefined ? 'MISSING' : typeof options.onUserDialog}`,
);
// `supportedDialogKinds` is asserted by CONTENT, not cardinality. Non-empty is
// NOT enough, and asserting it was a tautology: the old probe below read its
// kind back out of this very list, so ANY non-empty value passed by
// construction — including `['totally_bogus_kind_the_cli_never_emits']`, which
// breaks the feature completely while the gate reports all-green.
//
// The list is a HARD OPT-IN in both directions (agent-sdk.ts:709-726, 746-755):
//   • DECLARED but not HANDLED — the CLI routes that kind here and
//     `makeOnUserDialog`'s `SUPPORTED_DIALOG_KINDS.includes()` guard rejects it,
//     returning null and leaving the dialog unanswered until the CLI's
//     deadline. The repo calls this "worse than not declaring it".
//   • HANDLED but not DECLARED — the CLI FAILS CLOSED and never emits the kind
//     at all, so the callback can never fire.
// Both directions are silent breakage, so the correct assertion is SET EQUALITY
// between what the launch site DECLARES and what the bridge actually HANDLES.
//
// The handled list is module-private, so it is read out of the source text
// rather than imported. That is the one place text is unavoidable — and it is
// safe here because it is not the thing under test: it is the EXPECTATION being
// compared against the captured runtime object. A parse failure is reported as
// its own failure rather than being allowed to yield an empty set that would
// make the comparison vacuous.
const handledKinds = (() => {
  const src = fs.readFileSync(path.join(repoRoot, 'src/main/agent-sdk.ts'), 'utf8');
  const m = src.match(/^const SUPPORTED_DIALOG_KINDS\s*=\s*(\[[^\]]*\])\s*;/m);
  if (!m) return null;
  try {
    return JSON.parse(m[1].replace(/'/g, '"'));
  } catch {
    return null;
  }
})();
check(
  "the bridge's own SUPPORTED_DIALOG_KINDS guard list was readable (expectation source)",
  Array.isArray(handledKinds) && handledKinds.length > 0,
  `parsed: ${JSON.stringify(handledKinds)}`,
);

// ANCHOR THE SET TO SOMETHING OUTSIDE THE FILE UNDER TEST.
//
// Set-equality between DECLARED and HANDLED is necessary but NOT sufficient,
// and on its own it is a tautology at one remove: both sides derive from
// `SUPPORTED_DIALOG_KINDS`, so rewriting that constant to
// `['totally_bogus_kind_the_cli_never_emits']` moves declared AND handled
// together and the comparison stays true — while the CLI, which fails closed on
// kinds it does not recognise, emits nothing and `onUserDialog` can never fire.
// (Measured: that mutation passed an equality-only version of this gate.)
//
// So the expectation is anchored in the VENDOR type declarations, which no
// Orchestra-side change can move: `sdk.d.ts` documents `supportedDialogKinds`
// and names `'refusal_fallback_prompt'` as the dialog kind it fails closed on.
// A kind Orchestra declares that the SDK has never heard of is a kind the CLI
// will never send.
const vendorKinds = (() => {
  const dts = path.join(repoRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts');
  let src;
  try {
    src = fs.readFileSync(dts, 'utf8');
  } catch {
    return null;
  }
  // Scope the scan to the neighbourhood of the `supportedDialogKinds` docs —
  // `*_prompt` identifiers elsewhere in the d.ts (e.g. `mcp_prompt`) are
  // unrelated concepts and would pollute the set.
  const found = new Set();
  for (const m of src.matchAll(/supportedDialogKinds/g)) {
    const window_ = src.slice(Math.max(0, m.index - 1800), m.index + 400);
    for (const k of window_.matchAll(/'([a-z][a-z0-9_]*_prompt)'/g)) found.add(k[1]);
  }
  return found.size > 0 ? [...found] : null;
})();
check(
  'the SDK d.ts named at least one real dialog kind (independent anchor)',
  Array.isArray(vendorKinds) && vendorKinds.length > 0,
  `vendor kinds: ${JSON.stringify(vendorKinds)} — without this the content check below is vacuous`,
);
check(
  'every DECLARED dialog kind is one the SDK actually documents (not an invented kind the CLI never emits)',
  Array.isArray(vendorKinds) &&
    Array.isArray(options.supportedDialogKinds) &&
    options.supportedDialogKinds.length > 0 &&
    options.supportedDialogKinds.every((k) => vendorKinds.includes(k)),
  `declared: ${JSON.stringify(options.supportedDialogKinds)} vs SDK-documented: ${JSON.stringify(vendorKinds)}`,
);
const declaredKinds = options.supportedDialogKinds;
const sameSet =
  Array.isArray(declaredKinds) &&
  Array.isArray(handledKinds) &&
  declaredKinds.length === handledKinds.length &&
  [...declaredKinds].sort().join('\u0000') === [...handledKinds].sort().join('\u0000');
check(
  'supportedDialogKinds DECLARED at the launch site === the kinds the bridge HANDLES',
  sameSet,
  `declared: ${JSON.stringify(declaredKinds)} vs handled: ${JSON.stringify(handledKinds)}`,
);

// ── 2. The callbacks are LIVE-WIRED, not just present ───────────────────────
// Presence is necessary but not sufficient: a callback bound to a stub bridge
// would satisfy every check above and still never surface a card. Invoke them
// for real and follow the round trip.
const eventsOf = (type) =>
  broadcasts.filter((b) => b.channel === 'agent:event' && b.payload?.type === type);

// The round-trip probes below can only run against a callback that is actually
// there. When one is missing the presence check above has ALREADY failed and
// the gate is red — skipping here keeps the verdict legible (a raw TypeError
// stack is a fail nobody can read) without softening it: `failures` is already
// non-zero, so the exit code cannot come back green.
console.log('\ninvoking onElicitation surfaces an answerable card and settles on reply:');
if (typeof options.onElicitation !== 'function') {
  console.log('  ---- skipped: onElicitation is not wired (see the failure above)');
} else {
  const before = eventsOf('elicitation-request').length;
  const ctl = new AbortController();
  const pending = options.onElicitation(
    {
      serverName: 'wiring-gate-server',
      message: 'Gate probe',
      mode: 'form',
      requestedSchema: { type: 'object', properties: { token: { type: 'string' } } },
    },
    { signal: ctl.signal, requestId: 'gate-elicit-1' },
  );
  const emitted = eventsOf('elicitation-request');
  check(
    'emits an elicitation-request card event on agent:event',
    emitted.length === before + 1,
    `saw ${emitted.length - before} new elicitation-request event(s)`,
  );
  const card = emitted[emitted.length - 1];
  check('the card is addressed to this workspace', card?.wsId === WS_ID, `wsId: ${card?.wsId}`);
  check(
    'the card carries the requestId the reply will key on',
    card?.payload?.requestId === 'gate-elicit-1',
    `requestId: ${card?.payload?.requestId}`,
  );

  // The parked promise must be settleable through the REAL reply path — this is
  // what proves the callback is connected to the session's pending map and not
  // to a dead one.
  sdk.sdkAnswerableReply(WS_ID, 'gate-elicit-1', {
    kind: 'elicitation',
    reply: { action: 'accept', content: { token: 'ok' } },
  });
  const settled = await Promise.race([
    pending.then((v) => ({ v })),
    new Promise((r) => setTimeout(() => r(null), 5000)),
  ]);
  check('the parked elicitation settles when the renderer replies', settled !== null, 'timed out after 5s');
  check(
    'it settles with the MCP ElicitResult shape',
    settled?.v?.action === 'accept' && settled?.v?.content?.token === 'ok',
    `resolved: ${JSON.stringify(settled?.v)}`,
  );
}

console.log('\ninvoking onUserDialog surfaces an answerable card and settles on reply:');
if (typeof options.onUserDialog !== 'function' || !handledKinds?.length) {
  console.log('  ---- skipped: onUserDialog is not wired (see the failure above)');
} else {
  // Probe with a kind read from the BRIDGE's guard list, never from the
  // captured options. Taking it from `options.supportedDialogKinds[0]` — the
  // value just read back out of the object under test — made this probe
  // tautological: whatever the launch site declared was, by construction,
  // exactly what got probed, so a bogus declaration sailed through.
  const kind = handledKinds[0];
  const before = eventsOf('user-dialog-request').length;
  const ctl = new AbortController();
  const pending = options.onUserDialog(
    { dialogKind: kind, payload: { title: 'Gate probe', message: 'probe', options: ['Yes'] } },
    { signal: ctl.signal, requestId: 'gate-dialog-1' },
  );
  const emitted = eventsOf('user-dialog-request');
  check(
    'emits a user-dialog-request card event on agent:event',
    emitted.length === before + 1,
    `saw ${emitted.length - before} new user-dialog-request event(s)`,
  );
  check(
    'the card reports the declared dialog kind',
    emitted[emitted.length - 1]?.payload?.dialogKind === kind,
    `dialogKind: ${emitted[emitted.length - 1]?.payload?.dialogKind}`,
  );

  sdk.sdkAnswerableReply(WS_ID, 'gate-dialog-1', {
    kind: 'user-dialog',
    reply: { behavior: 'completed', result: 'Yes' },
  });
  const settled = await Promise.race([
    pending.then((v) => ({ v })),
    new Promise((r) => setTimeout(() => r(null), 5000)),
  ]);
  check('the parked dialog settles when the renderer replies', settled !== null, 'timed out after 5s');
  check(
    'it settles with the SDK UserDialogResult shape',
    settled?.v?.behavior === 'completed' && settled?.v?.result === 'Yes',
    `resolved: ${JSON.stringify(settled?.v)}`,
  );
}

// ── 3. The SANDBOX/REMOTE launch path carries the same wiring ───────────────
// A sandbox workspace takes the `remote === true` branch of ensureSession. The
// launch site conditions one option on exactly that flag already, so gating the
// answerable-cards wiring the same way is a one-line change in the file's own
// idiom that would silently strip cards from every remote workspace. Asserting
// the same three options on this second capture is what makes that visible.
console.log('\nquery() launch site receives the same wiring (SANDBOX/REMOTE workspace):');
const remoteOptions = await captureOptionsFor(WS_ID_SANDBOX);
if (!remoteOptions) {
  check('the sandbox workspace reached query()', false, 'sdkSend never reached query()');
} else {
  // Confirm the arm really is the remote one — otherwise this whole section
  // could be silently re-testing the local path and passing for the wrong
  // reason. `cwd` is SANDBOX_WORKSPACE_DIR ('/workspace') only when
  // `remote === true` (agent-sdk.ts:1143).
  check(
    'the sandbox arm really took the remote branch (cwd is the container path)',
    remoteOptions.cwd === '/workspace',
    `cwd: ${remoteOptions.cwd} (expected /workspace; if this is the local worktree the probe measured the WRONG arm)`,
  );
  check(
    'onElicitation is passed to query() for a sandbox workspace',
    typeof remoteOptions.onElicitation === 'function',
    `onElicitation: ${remoteOptions.onElicitation === undefined ? 'MISSING' : typeof remoteOptions.onElicitation}`,
  );
  check(
    'onUserDialog is passed to query() for a sandbox workspace',
    typeof remoteOptions.onUserDialog === 'function',
    `onUserDialog: ${remoteOptions.onUserDialog === undefined ? 'MISSING' : typeof remoteOptions.onUserDialog}`,
  );
  const remoteSameSet =
    Array.isArray(remoteOptions.supportedDialogKinds) &&
    Array.isArray(handledKinds) &&
    remoteOptions.supportedDialogKinds.length === handledKinds.length &&
    [...remoteOptions.supportedDialogKinds].sort().join('\u0000') ===
      [...handledKinds].sort().join('\u0000');
  check(
    'supportedDialogKinds DECLARED === HANDLED for a sandbox workspace',
    remoteSameSet,
    `declared: ${JSON.stringify(remoteOptions.supportedDialogKinds)} vs handled: ${JSON.stringify(handledKinds)}`,
  );
  check(
    'every DECLARED dialog kind is SDK-documented for a sandbox workspace',
    Array.isArray(vendorKinds) &&
      Array.isArray(remoteOptions.supportedDialogKinds) &&
      remoteOptions.supportedDialogKinds.length > 0 &&
      remoteOptions.supportedDialogKinds.every((k) => vendorKinds.includes(k)),
    `declared: ${JSON.stringify(remoteOptions.supportedDialogKinds)} vs SDK-documented: ${JSON.stringify(vendorKinds)}`,
  );
}

// ── Teardown ────────────────────────────────────────────────────────────────
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* a leftover temp dir is not a gate failure */
}

if (failures > 0) {
  console.log(`\nWIRING GATE FAILED — ${failures} check(s) failed.`);
  console.log(
    'The #21 answerable-cards wiring is missing or inert at the query() launch site\n' +
      '(src/main/agent-sdk.ts). Without it MCP elicitations are auto-declined and user\n' +
      'dialogs park until the CLI deadline, with no card ever reaching the screen.',
  );
  process.exit(1);
}
console.log('\nALL WIRING CHECKS PASSED');
process.exit(0);
