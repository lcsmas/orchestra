// Issue #88, producer seam: `lastTurnStartAt` must actually be STAMPED on a
// turn start, at the chokepoint both agent paths cross.
//
// ── Why this file is a SOURCE check and not an execution test ───────────────
//
// Measured 2026-08-25, this repo, `node --test --experimental-strip-types`:
// importing src/main/activity.ts fails with ERR_UNSUPPORTED_DIR_IMPORT —
// `import { platform } from './platform'` is an extensionless DIRECTORY import
// that only Vite's resolver handles, and it is reached before any stub could
// intervene. So the producer cannot be executed here at all. The real gate for
// this seam is the E2E drive against the built app (see the ledger); this file
// exists to catch the cheap regression that drive is too slow to run on: the
// stamp being deleted or drifting off the turn-start path.
//
// ── The trap this file is written around ────────────────────────────────────
//
// A check that merely asserts the identifier `lastTurnStartAt` APPEARS in
// activity.ts is worthless: it stays green if the assignment is moved onto a
// turn-END path, if the `turnStart` argument stops being passed, or if the
// field is only mentioned in a comment. #69's own history in this repo records
// exactly that failure mode twice over. So every assertion below pins a
// STRUCTURAL RELATIONSHIP — which case passes the flag, and that the write is
// conditioned on it — over comment-stripped source, and each is paired with a
// positive control proving the slice it examined is the code it names.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const ACTIVITY = path.join(ROOT, 'src', 'main', 'activity.ts');

/** Source with line/block-comment lines stripped, so PROSE about the design
 *  cannot satisfy a check about the CODE. */
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

/** The body of one `case '<name>':` arm inside applyAgentEvent's switch, up to
 *  its `break`. Isolating the arm is what makes the assertions below
 *  falsifiable: a file-wide grep for `setStatus(id, 'running', null, true)`
 *  would be satisfied by the OTHER arm, so deleting the flag from one case
 *  would leave the check green. */
function caseArm(code: string, name: string): string {
  const marker = `case '${name}':`;
  const start = code.indexOf(marker);
  assert.notEqual(start, -1, `case '${name}' not found in activity.ts — was it renamed?`);
  const rest = code.slice(start + marker.length);
  const end = rest.indexOf('break;');
  assert.notEqual(end, -1, `case '${name}' has no break — slice would run past the arm`);
  const body = rest.slice(0, end);
  // POSITIVE CONTROL on the isolation itself: the arm must contain a status
  // call of SOME kind. An empty or mis-sliced string would otherwise pass
  // every "does NOT contain" assertion vacuously.
  //
  // `fireFinished` is accepted alongside `setStatus` because the turn-END arms
  // route through it rather than calling setStatus directly — and it was this
  // control REJECTING the `stop` slice that revealed that, rather than the
  // test quietly asserting nothing about a string it had mis-sliced.
  assert.match(
    body,
    /setStatus\(|fireFinished\(/,
    `isolated '${name}' arm does not look like the real arm`,
  );
  return body;
}

test('both turn-start arms pass turnStart=true to setStatus', () => {
  const code = codeOf(ACTIVITY);
  for (const arm of ['submit', 'pretool']) {
    const body = caseArm(code, arm);
    assert.match(
      body,
      /setStatus\(\s*id,\s*'running',\s*null,\s*true\s*\)/,
      `case '${arm}' must mark the transition as a TURN START (#88) — ` +
        `without the flag the stall badge never clears when work resumes`,
    );
  }
});

test('a turn-END arm does NOT stamp a turn start', () => {
  // The complement, and what makes the test above a rule rather than a
  // coincidence: if `turnStart` were passed everywhere, the stamp would move
  // on every event and the detector could never fire. `stop` is a turn END.
  const code = codeOf(ACTIVITY);
  const body = caseArm(code, 'stop');
  assert.doesNotMatch(
    body,
    /setStatus\([^)]*,\s*true\s*\)/,
    "case 'stop' is a turn END and must not stamp lastTurnStartAt",
  );
});

test('the stamp is CONDITIONED on the turnStart flag, not unconditional', () => {
  // Pins the write's structural relationship to its guard. An unconditional
  // `lastTurnStartAt: Date.now()` inside setStatus would satisfy a presence
  // check while making the field meaningless — it would then track every
  // status transition, i.e. become a second `noteActivity`, which types.ts
  // documents at length as the wrong signal for exactly this reason.
  const code = codeOf(ACTIVITY);
  assert.match(
    code,
    /lastTurnStartAt:\s*turnStart\s*\?\s*Date\.now\(\)\s*:\s*ws\.lastTurnStartAt/,
    'lastTurnStartAt must be written only when turnStart is true, and must ' +
      'otherwise PRESERVE the previous value (never clear it — a cleared ' +
      'value makes the stall age fall back to createdAt, reading as days)',
  );
});

test('setStatus declares the turnStart parameter', () => {
  const code = codeOf(ACTIVITY);
  const start = code.indexOf('async function setStatus(');
  assert.notEqual(start, -1, 'setStatus() not found — was it renamed?');
  // Slice to the END of the parameter list, i.e. the return-type marker that
  // follows it — not to the next `{`, which lands inside the BODY and would
  // make this pass on a `turnStart` mentioned anywhere in the function.
  const end = code.indexOf('): Promise<', start);
  assert.notEqual(end, -1, 'setStatus signature has no return type — slice would be wrong');
  const sig = code.slice(start, end);
  // Positive control: the slice must contain the parameters we know are there.
  assert.match(sig, /status:\s*WorkspaceStatus/, 'the sliced text is not setStatus\'s parameter list');
  assert.match(sig, /turnStart\?:\s*boolean/, 'setStatus must take the #88 turnStart flag');
});
