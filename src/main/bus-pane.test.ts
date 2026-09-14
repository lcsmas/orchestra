// #118 — the pane's READ-ONLY boundary (T118.4) and its bus-unavailable state
// (T118.5), ledger #123.
//
// These run under `node --test --experimental-strip-types`, which cannot load
// `electron`. The source-text arms below check the ENUMERATION and the
// unavailable-snapshot SHAPE. But a source-text `assert.match` is NOT an
// execution — reviewer 7c372e9a (F3) showed that a `throw` on the first line of
// `registerBusPaneIpc` or `busSnapshot` left the whole suite green, because no
// arm here CALLED either function. So the block at the bottom bundles the REAL
// pane module to CJS (electron external), injects an `ipcMain` STUB into
// require.cache, and INVOKES both functions in-process. Those arms turn red on
// the throw mutants; the source-text arms are kept as a cheap belt.
//
// The full end-to-end behaviour under REAL Electron (real ipcMain, a real
// getBus() === null, a seeded bus) is scripts/verify-bus-pane.mjs, wired into
// `pnpm run test:bus-pane` (F3: it refuses with RC=3 when RIG_WAYLAND is unset,
// like test:cli-pipe, so an orchestrator cannot read its refusal as a pass).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, globSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { unavailableSnapshot, type BusSnapshot } from '../shared/bus-view.ts';
import { DEFAULT_BUS_SWITCHES } from '../shared/bus-switches.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const paneSrc = readFileSync(path.join(here, 'bus-pane.ts'), 'utf8');
const repoRoot = path.resolve(here, '..', '..');

// ─── T118.4 — read-only, by ENUMERATION not by presence check ───────────────

/**
 * Parse the BUS_PANE_IPC_CHANNELS table out of the source. Deliberately source
 * text and not an import: importing bus-pane.ts pulls in `electron`, which this
 * runner cannot load. Parsing the literal keeps the enumeration honest — a
 * channel added to the table is seen here, and a channel registered WITHOUT
 * being in the table fails the cross-check below.
 */
function enumeratedChannels(): { channel: string; writes: boolean }[] {
  const block = paneSrc.slice(
    paneSrc.indexOf('BUS_PANE_IPC_CHANNELS'),
    paneSrc.indexOf('/** Open a short-lived READ-ONLY view'),
  );
  const out: { channel: string; writes: boolean }[] = [];
  const re = /\{\s*channel:\s*'([^']+)',\s*writes:\s*(true|false)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) out.push({ channel: m[1], writes: m[2] === 'true' });
  return out;
}

/** Every channel actually registered by registerBusPaneIpc(). */
function registeredChannels(): string[] {
  const body = paneSrc.slice(paneSrc.indexOf('export function registerBusPaneIpc'));
  return [...body.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]);
}

test('T118.4 — the enumeration is non-empty and every entry is a READ', () => {
  const chans = enumeratedChannels();
  // Carry-forward 4: a positive control that the parser can SEE entries. An
  // empty list would make "every entry is a read" vacuously true — the exact
  // shape of an unaudited instrument reporting a tidy zero.
  assert.ok(chans.length >= 3, `expected the pane's channels, parsed ${chans.length}`);
  const writers = chans.filter((c) => c.writes);
  assert.deepEqual(writers, [], `read-only in v1, but these write: ${JSON.stringify(writers)}`);
});

test('T118.4 — the parser CAN see a write entry (the must-FAIL control)', () => {
  // Proves the assertion above has discriminating power: fed a table entry that
  // declares a write, the same regex reports it. Without this, "no writers" is
  // a claim about the regex, not about the code.
  const fake = "{ channel: 'bus:resolveGate', writes: true, what: 'v2' }";
  const m = /\{\s*channel:\s*'([^']+)',\s*writes:\s*(true|false)/.exec(fake);
  assert.ok(m);
  assert.equal(m[1], 'bus:resolveGate');
  assert.equal(m[2], 'true');
});

test('T118.4 — every REGISTERED channel is in the enumeration, and vice versa', () => {
  // The failure this catches: a handler registered directly with ipcMain.handle
  // that never appears in the table the ticket asks to enumerate. A presence
  // check on the table alone would never see it.
  const enumerated = enumeratedChannels().map((c) => c.channel).sort();
  const registered = registeredChannels().sort();
  assert.ok(registered.length >= 3, `parsed ${registered.length} registrations`);
  assert.deepEqual(registered, enumerated);
});

test('T118.4 — registerBusPaneIpc refuses a write channel', () => {
  // The guard is code, not a comment: the registrar throws on a `writes: true`
  // entry. Assert the refusal exists in the source (the behavioural arm runs
  // under Electron in scripts/verify-bus-pane.mjs).
  const body = paneSrc.slice(paneSrc.indexOf('export function registerBusPaneIpc'));
  assert.match(body, /writers\.length/);
  assert.match(body, /throw new Error\(/);
  assert.match(body, /READ-ONLY in v1/);
});

test('T118.4 — no write-shaped SQL anywhere in the pane module', () => {
  // Belt to the enumeration's braces, scoped to the subject so it can actually
  // fail: the pane assembles a projection, so an INSERT/UPDATE/DELETE/DROP in
  // this file is a boundary violation regardless of which channel reaches it.
  // CREATE TABLE IF NOT EXISTS is excluded by construction — it lives in
  // bus-runs.ts, not here; if that changes this assertion should be revisited,
  // not silently widened.
  //
  // SCOPED TO SQL, NOT TO PROSE. The first version of this check was
  // case-insensitive and matched the word "drop" inside an explanatory comment
  // — a regex as unspecific as its claim, which would have gone red on honest
  // code and green on a lowercase `db.prepare('insert …')`. It now requires
  // UPPERCASE SQL followed by its object keyword, which is how every statement
  // in this codebase is written, and the must-FAIL control below pins that.
  const WRITE_SQL = /\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|DROP\s+(TABLE|INDEX)|ALTER\s+TABLE)/g;
  const offenders = [...paneSrc.matchAll(WRITE_SQL)].map((m) => m[0]);
  assert.deepEqual(offenders, [], `pane module must not write: ${offenders.join(', ')}`);
  // Two controls in the SAME command (carry-forward 4). The must-FAIL one: the
  // regex DOES catch real write SQL. The must-PASS one: it does NOT fire on the
  // English word that broke the first version.
  assert.ok(new RegExp(WRITE_SQL.source).test("db.prepare('INSERT INTO messages')"));
  assert.ok(new RegExp(WRITE_SQL.source).test('DELETE FROM deliveries'));
  assert.ok(!new RegExp(WRITE_SQL.source).test('senders alone would drop that row'));
});

// ─── T118.5 — the bus-unavailable state ─────────────────────────────────────

test('T118.5 — unavailable is DISTINGUISHABLE from an empty-but-healthy bus', () => {
  const down = unavailableSnapshot('/tmp/bus.sqlite', 'ENOENT', { ...DEFAULT_BUS_SWITCHES });
  const quiet: BusSnapshot = {
    available: true,
    error: null,
    path: '/tmp/bus.sqlite',
    liveSwitches: { ...DEFAULT_BUS_SWITCHES },
    runs: [],
    selectedRunId: null,
    messages: [],
    gates: [],
    members: [],
    counters: [],
  };
  // THE claim: the two must not be confusable. Their message/run/gate lists are
  // identically empty — if `available` did not exist, these would be the same
  // object, and the pane could not tell a dead bus from a quiet one. That is
  // the disproof T118.5 names.
  assert.deepEqual(down.messages, quiet.messages);
  assert.deepEqual(down.runs, quiet.runs);
  assert.notEqual(down.available, quiet.available);
  assert.notDeepEqual(down, quiet);
});

test('T118.5 — the unavailable snapshot carries a diagnosable reason and path', () => {
  const down = unavailableSnapshot('/x/bus.sqlite', 'NODE_MODULE_VERSION mismatch', {
    ...DEFAULT_BUS_SWITCHES,
  });
  assert.equal(down.available, false);
  assert.equal(down.path, '/x/bus.sqlite');
  assert.match(down.error ?? '', /NODE_MODULE_VERSION/);
});

test('T118.5 — busSnapshot() is written never to throw on a missing bus', () => {
  // The source-level assertion that the null-bus branch RETURNS rather than
  // throwing. (The behavioural arm — a real getBus() === null over real IPC —
  // is scripts/verify-bus-pane.mjs, which runs under Electron.)
  const body = paneSrc.slice(
    paneSrc.indexOf('export function busSnapshot'),
    paneSrc.indexOf('export function registerBusPaneIpc'),
  );
  assert.match(body, /if \(!d\) \{\s*\n\s*return unavailableSnapshot\(/);
  // And the catch-all: a throwing query becomes the same state, not a crash.
  assert.match(body, /catch \(e\) \{[\s\S]*return unavailableSnapshot\(/);
});

test('counters: an ABSENT source yields [], and the pane says so rather than showing 0', () => {
  // Carry-forward 4 at the UI boundary: "#116 has not landed" and "zero
  // divergence" are the same empty array on the wire. The renderer must not
  // render zeros for the first. Assert the component's empty branch says it.
  const paneTsx = readFileSync(
    path.join(here, '..', 'renderer', 'components', 'BusPane.tsx'),
    'utf8',
  );
  assert.match(paneTsx, /NOT the same as zero divergence/);
});

// ─── F3 — IN-PROCESS execution of the two functions, not source text ─────────
//
// The source-text arms above (T118.4 "refuses a write channel", T118.5
// "written never to throw") are BLIND to a `throw` on the first line of the
// function — the mutant leaves them green. These arms CALL the real functions.
//
// bus-pane.ts imports `ipcMain` from 'electron' at module scope, which the
// strip-types runner cannot load. So bundle the real module to CJS with
// electron EXTERNAL, then inject an ipcMain stub into require.cache before the
// bundle requires it — the same runtime seam scripts/verify-bus-pane.mjs uses,
// but in-process and without a compositor.

interface PaneStubModule {
  busSnapshot: (runId?: string | null) => BusSnapshot;
  registerBusPaneIpc: () => void;
  BUS_PANE_IPC_CHANNELS: { channel: string; writes: boolean; what: string }[];
  getBus: () => unknown;
  initPlatform: (p: unknown) => void;
}

interface StubIpcMain {
  handle(ch: string, fn: (...a: unknown[]) => unknown): void;
  removeHandler(ch: string): void;
  _handled: string[];
}

/**
 * Bundle the REAL bus-pane module to CJS and load it with a stubbed `ipcMain`.
 * Returns the module plus the stub so an arm can read which channels registered.
 * Throws (fails the arm, never skips) if esbuild is not resolvable — a skip here
 * would be a false green on the very execution F3 requires.
 */
function loadPaneWithStub(tmp: string): { m: PaneStubModule; ipcMain: StubIpcMain; bundle: string } {
  const require_ = createRequire(path.join(repoRoot, 'package.json'));
  let esbuild: { buildSync: (o: unknown) => void };
  try {
    esbuild = require_('esbuild');
  } catch {
    const store = globSync(
      path.join(repoRoot, 'node_modules/.pnpm/esbuild@*/node_modules/esbuild'),
    );
    if (!store.length) {
      throw new Error('F3 arm: esbuild not resolvable — run `pnpm install` (a skip would be a false green)');
    }
    esbuild = require_(store[0]);
  }
  const entry = path.join(tmp, 'entry.ts');
  writeFileSync(
    entry,
    `export { busSnapshot, registerBusPaneIpc, BUS_PANE_IPC_CHANNELS } from ${JSON.stringify(path.join(repoRoot, 'src/main/bus-pane.ts'))};\n` +
      `export { getBus } from ${JSON.stringify(path.join(repoRoot, 'src/main/bus.ts'))};\n` +
      `export { initPlatform } from ${JSON.stringify(path.join(repoRoot, 'src/main/platform/index.ts'))};\n`,
  );
  // The bundle MUST live under the repo's node_modules so its `require('electron')`
  // resolves (to be overridden in require.cache). A /tmp bundle cannot resolve the
  // bare `electron` specifier at all — MODULE_NOT_FOUND before the stub can apply.
  const cacheDir = path.join(repoRoot, 'node_modules', '.cache');
  mkdirSync(cacheDir, { recursive: true });
  const bundle = path.join(cacheDir, `bus-pane-inproc-${path.basename(tmp)}.cjs`);
  esbuild.buildSync({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['electron', 'better-sqlite3', 'node-pty'],
    logLevel: 'silent',
  });
  const req = createRequire(bundle);
  const ipcMain: StubIpcMain = {
    _handled: [],
    handle(ch) {
      this._handled.push(ch);
    },
    removeHandler() {},
  };
  const eid = req.resolve('electron');
  req.cache[eid] = {
    id: eid,
    filename: eid,
    loaded: true,
    exports: { ipcMain },
  } as unknown as NodeModule;
  const m = req(bundle) as PaneStubModule;
  m.initPlatform({
    kind: 'rig',
    broadcast() {},
    broadcastPtyData() {},
    canBroadcast: () => false,
    isFocused: () => false,
    getUserDataDir: () => tmp,
  });
  return { m, ipcMain, bundle };
}

test('T118.5 (F3) — busSnapshot() EXECUTES and RETURNS the unavailable state with the bus down', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'bus-pane-inproc-'));
  let bundle = '';
  try {
    const loaded = loadPaneWithStub(tmp);
    bundle = loaded.bundle;
    const { m } = loaded;
    // Precondition: no bus is open, so getBus() is null. This is the branch the
    // throw-first-line mutant would replace — the arm below CALLS busSnapshot,
    // so a throw there fails this test rather than passing a source-text match.
    assert.equal(m.getBus(), null, 'precondition: the bus is not open in this rig');
    const down = m.busSnapshot(null);
    assert.equal(down.available, false, 'a missing bus must RETURN available:false, not throw');
    assert.equal(typeof down.error, 'string');
    assert.ok((down.error ?? '').length > 10, 'the unavailable state carries a diagnosable reason');
    assert.ok(String(down.path).endsWith('bus.sqlite'), 'and the bus path');
    assert.deepEqual(down.runs, []);
    assert.deepEqual(down.messages, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    if (bundle) rmSync(bundle, { force: true });
  }
});

test('T118.4 (F3) — registerBusPaneIpc() EXECUTES: registers the reads and REFUSES a write', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'bus-pane-inproc-'));
  let bundle = '';
  try {
    const loaded = loadPaneWithStub(tmp);
    bundle = loaded.bundle;
    const { m, ipcMain } = loaded;
    // Calling the real function (a throw on its first line fails HERE).
    m.registerBusPaneIpc();
    const enumerated = m.BUS_PANE_IPC_CHANNELS.map((c) => c.channel).sort();
    assert.ok(enumerated.length >= 3, 'the enumeration is non-empty');
    assert.deepEqual(
      ipcMain._handled.slice().sort(),
      enumerated,
      'registers exactly the enumerated channels, through the real ipcMain seam',
    );
    // The MUST-FAIL control: inject a write entry and require the refusal. This
    // proves the guard EXECUTES — a source-text match on `throw new Error` never
    // could. Restore the table afterwards so a later arm sees a clean list.
    m.BUS_PANE_IPC_CHANNELS.push({ channel: 'bus:resolveGate', writes: true, what: 'v2 write' });
    assert.throws(
      () => m.registerBusPaneIpc(),
      /READ-ONLY in v1/,
      'the registrar must refuse a writes:true channel at runtime',
    );
    m.BUS_PANE_IPC_CHANNELS.pop();
    // And the refused channel was NOT registered on the stub.
    assert.ok(!ipcMain._handled.includes('bus:resolveGate'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    if (bundle) rmSync(bundle, { force: true });
  }
});
