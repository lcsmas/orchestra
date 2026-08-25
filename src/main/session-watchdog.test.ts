import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Tests that DRIVE `src/main/session-watchdog.ts` itself (review R4).
//
// ── Why this file exists, stated plainly ────────────────────────────────────
//
// The pure-policy tests in `src/shared/session-wedge.test.ts` are good and they
// were STRUCTURALLY INCAPABLE of catching any of the three defects review found
// in this feature (R1: the recycle path consulted no progress evidence; R2: the
// wake delivered a message the hook then re-delivered; the R2 residual: step 4's
// snapshot was taken before the drain landed). All three lived in the MODULE —
// in how it composes `sdkStop`, `sdkWake`, `readInbox` and `releaseInboxBlock`
// against a real file and a real session — and none of them were reachable from
// a function that takes a plain object and returns a verdict.
//
// A 293-line module that performs a DESTRUCTIVE act (`sdkStop` calls
// `session.q.interrupt()`) with no test that imports it is the gap. This closes
// it.
//
// ── Why it runs the module in a SUBPROCESS ──────────────────────────────────
//
// `session-watchdog.ts` transitively pulls in `./platform`, `./store` and
// `agent-sdk.ts`, which need Electron plus a module-resolution hook for the
// `./platform` DIRECTORY import and the extensionless relative imports. The
// repo already ships that hook (`scripts/.r2-register.mjs`) and already drives
// the real modules through it (`scripts/e2e-r2-repro.mjs`). Importing this
// module bare under `node --test` fails with ERR_MODULE_NOT_FOUND — verified,
// which is exactly why the naive version of this test could not exist. So the
// rig runs as a child process and this file asserts on its JSON verdict.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const RIG = path.join(REPO, 'scripts', 'e2e-session-wedge-redelivery.mjs');
const REGISTER = path.join(REPO, 'scripts', '.r2-register.mjs');

function runArm(arm: string): Record<string, unknown> {
  const out = execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--import', REGISTER, RIG, arm],
    {
      encoding: 'utf8',
      timeout: 120_000,
      cwd: REPO,
      env: { ...process.env, WEDGE_HOME: `/tmp/wedge90-unit-${arm}-${process.pid}` },
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  const line = out.trim().split('\n').filter(Boolean).pop();
  // An EMPTY result must never read as a pass. A rig that crashed prints
  // nothing, and `JSON.parse(undefined)` throwing here is the intended loud
  // failure rather than a silent green.
  assert.ok(line, `arm ${arm} produced no output — the rig did not run`);
  return JSON.parse(line) as Record<string, unknown>;
}

test('the rig and its register hook actually exist', () => {
  // Guards the whole file: if either path moves, every test below would
  // otherwise fail with an opaque spawn error rather than naming the cause.
  assert.ok(fs.existsSync(RIG), `${RIG} missing`);
  assert.ok(fs.existsSync(REGISTER), `${REGISTER} missing`);
});

test('recycleSession delivers every parked message EXACTLY ONCE', () => {
  // Drives the real `recycleSession` against a real inbox file on disk, with
  // the real `releaseInboxBlock`. This is the R2 promise.
  const r = runArm('exactly_once') as {
    ok: boolean;
    counts: Record<string, number>;
    duplicates: string[];
    remainingAfter: number;
  };
  assert.deepEqual(r.duplicates, [], 'no message may be delivered twice');
  assert.deepEqual(
    r.counts,
    { 'PARKED-ALPHA': 1, 'PARKED-BRAVO': 1, 'PARKED-CHARLIE': 1 },
    'each parked message exactly once',
  );
  assert.equal(r.remainingAfter, 0, 'the inbox is empty once all three are delivered');
  assert.equal(r.ok, true);
});

test('NEGATIVE ARM: when no turn starts, NOTHING is removed from the inbox', () => {
  // The instrument audit. Without this, "remainingAfter: 0" above could not be
  // distinguished from a rig that simply deletes the file — and the whole
  // exactly-once claim would rest on an unaudited zero.
  const r = runArm('control_nodeliver') as {
    ok: boolean;
    counts: Record<string, number>;
    remainingAfter: number;
  };
  assert.equal(r.remainingAfter, 3, 'every block survives an unconfirmed delivery');
  assert.deepEqual(
    r.counts,
    { 'PARKED-ALPHA': 0, 'PARKED-BRAVO': 0, 'PARKED-CHARLIE': 0 },
    'nothing is delivered when the session never starts a turn',
  );
  assert.equal(r.ok, true);
});

test('R2 RESIDUAL: a hook drain racing the release loop still delivers once', () => {
  // The defect review found on the FIRST fix: the wake turn's UserPromptSubmit
  // hook drains the inbox asynchronously, and step 4's `for…of readInbox()`
  // took ONE snapshot before that drain landed — so a block the hook was about
  // to show the agent was ALSO released. Measured 3/3 deterministic before the
  // fix (PARKED-ALPHA delivered twice, remaining 0); this arm reproduces that
  // race and now observes the DUPLICATE directly rather than inferring it.
  const r = runArm('hook_drain_race') as {
    ok: boolean;
    counts: Record<string, number>;
    duplicates: string[];
  };
  assert.deepEqual(
    r.duplicates,
    [],
    'the hook drain and the release loop must not both deliver the same block',
  );
  assert.deepEqual(r.counts, {
    'PARKED-ALPHA': 1,
    'PARKED-BRAVO': 1,
    'PARKED-CHARLIE': 1,
  });
  assert.equal(r.ok, true);
});

// ── SOURCE-BINDING GUARDS ───────────────────────────────────────────────────
//
// The subprocess arms above prove BEHAVIOUR. These pin the two structural
// properties that behaviour depends on, so a refactor that quietly reintroduces
// a reviewed defect fails here with a NAME rather than as a flaky race. Both
// strip comments first: prose about the old design must not satisfy a check
// about the code.

function sourceOf(file: string): string {
  return fs
    .readFileSync(path.join(REPO, 'src', 'main', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

test('R2 guard: the wake prompt carries NO parked message content', () => {
  const src = sourceOf('session-watchdog.ts');
  // The reviewed defect was `sdkWake(wsId, parked[0].text)` — waking with a
  // parked body delivers it while its block stays on disk for the hook to
  // re-deliver.
  assert.match(src, /sdkWake\(wsId,\s*WAKE_PROMPT\)/, 'wake must use the neutral prompt');
  assert.doesNotMatch(src, /sdkWake\([^)]*parked\[/, 'wake must not carry a parked body');
  // Positive control: the isolation worked and we are reading real code.
  assert.match(src, /releaseInboxBlock/, 'control: the release path is present in this file');
});

test('R2-residual guard: the inbox is re-read INSIDE the release loop', () => {
  const src = sourceOf('session-watchdog.ts');
  // `for (const block of readInbox(wsId))` evaluates its iterable ONCE, so the
  // snapshot predates the wake turn's hook drain and a block gets delivered
  // twice (measured 3/3 before the fix). The loop must read per iteration.
  assert.doesNotMatch(
    src,
    /for\s*\(\s*const\s+\w+\s+of\s+readInbox\(/,
    'a for…of over readInbox() takes ONE snapshot — that is the residual defect',
  );
  assert.match(src, /INBOX_DRAIN_GRACE_MS/, 'the drain must be given a chance to land first');
});

test('R1 guard: the recycle decision is fed live progress evidence', () => {
  const src = sourceOf('session-watchdog.ts');
  // R1: the destructive path must not rely on #88's `status` guard alone.
  assert.match(
    src,
    /lastStreamAt:\s*progress\?\.lastStreamAt/,
    'decideSessionRecycle must receive the live stream stamp',
  );
});
