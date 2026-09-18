import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bus from '../main/bus.ts';
import { startRun } from '../main/bus-runs.ts';
import { DEFAULT_BUS_SWITCHES } from '../shared/bus-switches.ts';

// ISSUE #155 — `orchestra send` must REFUSE a run_id with no row in `runs`.
//
// THE BUG (canary-4 close-out, ledger #152 F-C4-2b): a send with a typo'd/stale
// `$ORCHESTRA_RUN_ID` (a member's own ws id instead of its wave anchor) landed a
// row under a run that never existed in `runs`. That mail is ORPHANED — the wake
// switch safe-defaults OFF for an unknown run, so the recipient is never woken,
// and the row is invisible to every run-scoped `check`. The v1 schema comment
// (bus.ts MIGRATIONS[1]) predicted this exact "parallel universe of messages no
// reader is checking".
//
// The gate lives in the `send` case of src/cli/index.ts (after openBusForVerb,
// which gives it the db; before verbSend, so no row is ever written on refusal).
// It is DISTINCT from #142's stale-marker pre-send gate (a marker FILE, read
// before any bus opens) — both can be present and neither clobbers the other.
//
// WHY DRIVE THE BUILT CLI, NOT verbSend: the gate is wired in index.ts, not in
// verbSend (the bus-verbs.test.ts unit rig stubs busSwitch and never opens a real
// bus, so it cannot exercise the runs-row existence check). So this file drives
// the BUILT dist-electron/cli.js end-to-end against a REAL bus in an isolated
// ORCHESTRA_HOME + HOME, and reads the messages table back to prove no row landed
// on refusal. index.ts's auto-run block is guarded on `typeof require`, so the
// source cannot be run as raw ESM — the bundle is the only thing that runs main().
//
// NO SKIP UNDER `pnpm run test`: better-sqlite3 in node_modules loads under the
// test runner's system-node ABI (127), so openBus() constructs a real DB here
// with no build/bus-abi/ pin needed. The pretest hook builds the CLI; this file
// self-skips ONLY if that bundle is somehow absent, mirroring the sibling
// broadcast-message.test.ts.
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'dist-electron', 'cli.js');
const BUILT = existsSync(CLI);
const needsBuild = {
  skip: BUILT ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`',
};

interface CliOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

/** Drive the built `orchestra send` in an isolated home. `runId` (when given) is
 *  exported as $ORCHESTRA_RUN_ID; pass `null` to leave it unset (the `default`
 *  fallback). Returns rc + streams; never throws on a non-zero exit. */
function send(home: string, runId: string | null, extraArgs: string[] = []): CliOutcome {
  const env: Record<string, string> = {
    ...process.env,
    ORCHESTRA_HOME: home,
    HOME: home,
    // ORCHESTRA_WS_ID identifies the sender on the bus (--as would too).
    ORCHESTRA_WS_ID: 'tester-155',
  };
  // The test runner inherits THIS workspace's $ORCHESTRA_RUN_ID; a leaked value
  // would silently become the send's run id. Set or delete it explicitly.
  if (runId === null) delete env.ORCHESTRA_RUN_ID;
  else env.ORCHESTRA_RUN_ID = runId;
  try {
    const stdout = execFileSync(
      process.execPath,
      [CLI, 'send', '--type', 'status', ...extraArgs, 'body-155'],
      { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
    );
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** How many `messages` rows exist in the isolated home's bus (0 if no bus yet).
 *  Uses the SHIPPED openBus so the read matches what the CLI wrote. */
function messageCount(home: string): number {
  // busPath() reads $ORCHESTRA_HOME from the CURRENT process env; set it around
  // the call so we read THIS home's bus, not the test runner's.
  const prev = process.env.ORCHESTRA_HOME;
  process.env.ORCHESTRA_HOME = home;
  try {
    const p = bus.busPath();
    if (!existsSync(p)) return 0;
    const db = bus.openBus(p, {});
    try {
      return (db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;
    } finally {
      db.close();
    }
  } finally {
    if (prev === undefined) delete process.env.ORCHESTRA_HOME;
    else process.env.ORCHESTRA_HOME = prev;
  }
}

/** Create a real `runs` row via the SHIPPED startRun, so arm 2's anchor is
 *  schema-correct (never a hand-rolled INSERT that could drift from the DDL). */
function seedRun(home: string, runId: string): void {
  const prev = process.env.ORCHESTRA_HOME;
  process.env.ORCHESTRA_HOME = home;
  try {
    const db = bus.openBus(bus.busPath(), {});
    try {
      startRun(db, { id: runId, kind: 'mission', coordinator: 'ops-155' }, DEFAULT_BUS_SWITCHES);
    } finally {
      db.close();
    }
  } finally {
    if (prev === undefined) delete process.env.ORCHESTRA_HOME;
    else process.env.ORCHESTRA_HOME = prev;
  }
}

function freshHome(t: { after: (fn: () => void) => void }): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'orch-155-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

// A uuid-shaped run id with NO runs row — the F-C4-2b shape (a member's own ws id
// mistaken for its anchor).
const PHANTOM_RUN = '81c70db7-1155-4000-8000-000000000155';

// ── ARM 1: unknown run → REFUSED, remedy named, NO row written ────────────────
// This is the arm that fails on the unfixed build: pre-fix the send is ACCEPTED
// (rc 0) and a row lands under PHANTOM_RUN (mutation-proven: removing the gate in
// index.ts makes rc 0 with 1 orphaned row).
test('send REFUSES a run_id absent from runs, names the remedy, writes NO row', needsBuild, (t) => {
  const home = freshHome(t);
  const r = send(home, PHANTOM_RUN);
  assert.equal(r.code, 1, `unknown run must be refused (rc 1), got ${r.code}: ${r.stderr}`);
  // The refusal must NAME the remedy (issue #155), not just say "no".
  assert.match(r.stderr, /has no row in the bus 'runs' table/, r.stderr);
  assert.match(r.stderr, /ORPHANED/, 'must explain WHY it is refused');
  assert.match(r.stderr, /orchestra restart/, 'must name the restart remedy');
  assert.match(r.stderr, /ORCHESTRA_RUN_ID/, 'must name the stale env as the likely cause');
  assert.match(r.stderr, new RegExp(PHANTOM_RUN), 'must name the offending run id');
  // NOT WRITTEN — the whole point. A refusal that still landed the orphan row
  // would be worse than no gate (the caller believes it failed).
  assert.equal(messageCount(home), 0, 'a refused send must write NO message row');
});

// ── ARM 2: a valid ANCHORED run → unchanged (accepted, row written) ───────────
// The positive control: without it, "refuses unknown runs" would be
// indistinguishable from a send that refuses EVERYTHING.
test('send to a valid anchored run is unchanged (accepted, row written)', needsBuild, (t) => {
  const home = freshHome(t);
  const ANCHOR = 'anchor-run-155';
  seedRun(home, ANCHOR);
  const r = send(home, ANCHOR);
  assert.equal(r.code, 0, `anchored send must succeed, got ${r.code}: ${r.stderr}`);
  assert.match(r.stdout.split('\n')[0], /^\d+$/, 'send prints the sequence on success');
  assert.equal(messageCount(home), 1, 'an accepted send must land exactly one row');
});

// ── The `default` sentinel is EXEMPT (env unset, and explicit --run default) ──
// `default` never gets a runs row (rows are created only at orchestrator anchors,
// #134); it is the documented fallback for a manual / standalone send. Refusing
// it would break every unanchored send — so the gate exempts it by id, not by
// runs-row existence.
test('the default run (env unset) is exempt from the gate', needsBuild, (t) => {
  const home = freshHome(t);
  const r = send(home, null);
  assert.equal(r.code, 0, `default send must succeed, got ${r.code}: ${r.stderr}`);
  assert.equal(messageCount(home), 1, 'default send must land its row');
});

test('an explicit --run default is exempt too', needsBuild, (t) => {
  const home = freshHome(t);
  const r = send(home, 'ignored-env', ['--run', 'default']);
  assert.equal(r.code, 0, `--run default must succeed, got ${r.code}: ${r.stderr}`);
  assert.equal(messageCount(home), 1);
});

// ── ARM 3: the #142 stale-marker refusal STILL fires on its own arm ───────────
// No double-guard clobber. The stale marker is a FILE the admin path writes on a
// `--no-restart` re-parent; the CLI reads it (store-less) and refuses BEFORE
// opening any bus. Even when the run IS anchored (arm-2 shape), the marker wins
// first and prints ITS message (#142), never the #155 one.
test('#142 stale-marker refusal still fires (no #155 clobber), even with a valid run', needsBuild, (t) => {
  const home = freshHome(t);
  const ANCHOR = 'anchor-run-155';
  seedRun(home, ANCHOR);
  // The CLI reads the marker at `<cwd>/.orchestra/bus-run-stale` unless
  // $ORCHESTRA_WORKSPACE_PATH overrides cwd — set that to a temp worktree so this
  // test's own cwd is untouched.
  const wt = mkdtempSync(path.join(os.tmpdir(), 'orch-155-wt-'));
  t.after(() => rmSync(wt, { recursive: true, force: true }));
  const dotDir = path.join(wt, '.orchestra');
  const marker = path.join(dotDir, 'bus-run-stale');
  mkdirSync(dotDir, { recursive: true });
  writeFileSync(
    marker,
    'stale run: re-parented, sends refused until restart\nnew run: anchor-run-155\n',
    'utf8',
  );
  const env: Record<string, string> = {
    ...process.env,
    ORCHESTRA_HOME: home,
    HOME: home,
    ORCHESTRA_WS_ID: 'tester-155',
    ORCHESTRA_RUN_ID: ANCHOR,
    ORCHESTRA_WORKSPACE_PATH: wt,
  };
  let out: CliOutcome;
  try {
    const stdout = execFileSync(
      process.execPath,
      [CLI, 'send', '--type', 'status', 'body-155'],
      { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
    );
    out = { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    out = { code: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
  assert.equal(out.code, 1, `stale marker must refuse, got ${out.code}: ${out.stderr}`);
  // #142's message, NOT #155's — the marker gate runs first and short-circuits.
  assert.match(out.stderr, /stale run/, out.stderr);
  assert.doesNotMatch(
    out.stderr,
    /has no row in the bus 'runs' table/,
    'the #142 marker gate must win first — no #155 double-refusal',
  );
  // And nothing landed despite the run being valid.
  assert.equal(messageCount(home), 0, 'a stale-marker refusal writes no row');
});
