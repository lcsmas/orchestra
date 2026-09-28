// #176 D7 boot-throttle WIRING check (source-level).
//
// ── Why this is a SOURCE check, not an execution test ────────────────────────
// agent-sdk.ts is un-importable under `node --test --experimental-strip-types`:
// it reaches `import { ... } from './platform'` (an extensionless DIRECTORY
// import only Vite resolves) before any stub could intervene — verified in this
// repo (ERR_MODULE_NOT_FOUND), same trap turn-start-stamp.test.ts documents. So
// the promptStream/consume seam cannot be driven here; the pure mechanism is
// exercised in boot-throttle.test.ts, and the LIVE gate is the driven build.
// This file catches the cheap regression that drive is too slow for: the acquire
// drifting off the opening-turn path, or a release being deleted (which would
// leak a slot and wedge every later boot — a silent, permanent throttle stall).
//
// Every assertion pins a STRUCTURAL relationship (which condition gates the
// acquire; that BOTH releases exist), over comment-stripped source, each with a
// positive control proving the slice is the code it names.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SDK = path.join(ROOT, 'src', 'main', 'agent-sdk.ts');

/** Source with comment-only lines stripped, so PROSE cannot satisfy a check
 *  about CODE. */
function codeOf(file: string): string {
  const raw = fs.readFileSync(file, 'utf8');
  const stripped = raw
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
  assert.ok(stripped.length > 5_000, `comment-stripping ${path.basename(file)} returned too little`);
  return stripped;
}

/** Body of a named function up to a rough brace-balanced end — enough to isolate
 *  a seam so a file-wide grep can't satisfy an arm-local assertion. */
function fnSlice(code: string, signature: string): string {
  const start = code.indexOf(signature);
  assert.notEqual(start, -1, `${signature} not found in agent-sdk.ts — was it renamed?`);
  // take a generous window; the assertions below are about presence/ordering
  // within the function, not exact boundaries.
  return code.slice(start, start + 2500);
}

test('the throttle is imported from the pure shared module (not re-implemented in main)', () => {
  const code = codeOf(SDK);
  assert.match(
    code,
    /import\s*\{[^}]*BootThrottle[^}]*resolveBootThrottleK[^}]*\}\s*from\s*'\.\.\/shared\/boot-throttle\.ts'/,
    'BootThrottle + resolveBootThrottleK must come from ../shared/boot-throttle.ts',
  );
  // singleton sized from env, so K is configurable via ORCHESTRA_BOOT_THROTTLE_K
  assert.match(
    code,
    /new BootThrottle\(resolveBootThrottleK\(process\.env\)\)/,
    'the singleton must size K from resolveBootThrottleK(process.env)',
  );
});

test('acquire is GATED on the opening turn (firstMessageSeen === false) and on not already holding a slot', () => {
  const code = codeOf(SDK);
  // The gate condition and the acquire must be adjacent, in promptStream.
  assert.match(
    code,
    /if\s*\(\s*!session\.firstMessageSeen\s*&&\s*!session\.bootSlot\s*\)\s*\{\s*session\.bootSlot\s*=\s*await bootThrottle\.acquire\(\)/,
    'acquire must be gated on !firstMessageSeen && !bootSlot — a STARTED session must never queue',
  );
  // POSITIVE CONTROL: the acquire sits in promptStream, before the turn gate is
  // armed (so a queued boot has not yet armed its boot-stall clock as "started").
  const stream = fnSlice(code, 'function* promptStream');
  assert.ok(
    stream.includes('bootThrottle.acquire()'),
    'the acquire must live inside promptStream (the opening-turn dispatch path)',
  );
  const acqAt = stream.indexOf('bootThrottle.acquire()');
  const gateAt = stream.indexOf('session.turnGate = res');
  assert.ok(acqAt !== -1 && gateAt !== -1 && acqAt < gateAt, 'acquire must precede arming the turn gate');
});

test('a boot parked on acquire that loses its session releases the slot and bails (no leak, no dead drive)', () => {
  const stream = fnSlice(codeOf(SDK), 'function* promptStream');
  // after acquire, re-check the session is still current/not stopping, else free.
  assert.match(
    stream,
    /session\.bootSlot\s*=\s*await bootThrottle\.acquire\(\)[\s\S]{0,400}?sessions\.get\(session\.wsId\)\s*!==\s*session\s*\|\|\s*session\.stopping[\s\S]{0,120}?releaseBootSlot\(session\)/,
    'after a parked acquire, a torn-down session must releaseBootSlot and return',
  );
});

test('the slot is released on FIRST PROOF OF LIFE (primary) — in the same block that sets firstMessageSeen', () => {
  const code = codeOf(SDK);
  assert.match(
    code,
    /session\.firstMessageSeen\s*=\s*true;\s*clearBootStall\(session\);\s*releaseBootSlot\(session\)/,
    'proof-of-life must set firstMessageSeen, clear the stall, and release the boot slot together',
  );
});

test('the slot is released on TEARDOWN/FAIL (fallback) — in consume()'+"'s finally, beside clearBootStall", () => {
  const code = codeOf(SDK);
  // In the finally: clearBootStall then releaseBootSlot. Two distinct releases
  // (proof-of-life + finally) both reachable; the slot's release is idempotent so
  // this can't double-free.
  assert.match(
    code,
    /\}\s*finally\s*\{\s*clearBootStall\(session\);\s*[\s\S]{0,400}?releaseBootSlot\(session\)/,
    "consume()'s finally must releaseBootSlot so a FAILED boot frees its slot",
  );
});

test('releaseBootSlot is idempotent and nulls the field (so the two release sites are safe together)', () => {
  const code = codeOf(SDK);
  const rel = fnSlice(code, 'function releaseBootSlot');
  assert.match(rel, /session\.bootSlot\.release\(\)/, 'must call the slot release');
  assert.match(rel, /session\.bootSlot\s*=\s*undefined/, 'must null the field so a second call is a no-op');
});
